import { randomUUID } from 'node:crypto';
import { type ConversationStore, groupConversationId } from '../chat/conversationStore';
import type { Identity } from '../security/identity';
import {
  type ChatPayload,
  type ConnectIntent,
  MAX_CHAT_LENGTH,
  MAX_GROUP_HISTORY,
  MAX_GROUP_MEMBERS,
  parseChatPayload,
  type RelayedMessage,
} from '../signaling/protocolTypes';
import type { RemotePeer } from '../transport/peerConnection';
import type { ConnectionInfo, IntentScreen, PeerManager } from '../transport/peerManager';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import {
  type GroupMemberInfo,
  type GroupVisibility,
  MAX_ADVERTISED_GROUPS,
  MAX_HOSTED_GROUPS,
  newGroupId,
  normalizeGroupName,
} from './groupTypes';

interface HostedGroup {
  groupId: string;
  name: string;
  visibility: GroupVisibility;
  /** Includes the host itself. */
  members: Map<string, GroupMemberInfo>;
  /** Pending invites by peer id; `delivered` once the invitee has actually been told. */
  invites: Map<string, { delivered: boolean }>;
  requests: Map<string, GroupMemberInfo>;
}

export interface HostedGroupView {
  groupId: string;
  name: string;
  visibility: GroupVisibility;
  members: GroupMemberInfo[];
  invited: string[];
  requests: GroupMemberInfo[];
}

export interface JoinRequest {
  groupId: string;
  groupName: string;
  peer: GroupMemberInfo;
}

export interface GroupHostOptions {
  peers: PeerManager;
  store: ConversationStore;
  identity: Identity;
  getSelfName: () => string;
  log: Log;
}

type HostEvents = {
  changed: [];
  publicGroupsChanged: [];
  /** A join request arrived over an existing connection and needs an answer. */
  joinRequest: [JoinRequest];
};

const memberOf = (peer: RemotePeer): GroupMemberInfo => ({
  peerId: peer.peerId,
  name: peer.name,
  fingerprint: peer.fingerprint,
});

/**
 * The hub side of hosted groups. Members connect only to the host; the host checks membership
 * and forwards each message to everyone else, vouching for who sent it.
 */
export class GroupHost extends Emitter<HostEvents> {
  private readonly groups = new Map<string, HostedGroup>();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly opts: GroupHostOptions) {
    super();
    const { peers } = opts;
    this.disposers.push(
      peers.on('connected', (peer, info) => this.onConnected(peer, info)),
      peers.on('disconnected', (peer) => this.onDisconnected(peer)),
      peers.on('channel', (peer, channel, data) => {
        if (channel === 'lanChat') this.onPayload(peer, data);
      }),
    );
  }

  // --- Queries -------------------------------------------------------------------------------

  isHost(groupId: string): boolean {
    return this.groups.has(groupId);
  }

  groupName(groupId: string): string | undefined {
    return this.groups.get(groupId)?.name;
  }

  hosted(): HostedGroupView[] {
    return [...this.groups.values()].map((g) => ({
      groupId: g.groupId,
      name: g.name,
      visibility: g.visibility,
      members: this.memberList(g),
      invited: [...g.invites.keys()],
      requests: [...g.requests.values()],
    }));
  }

  joinRequests(): JoinRequest[] {
    return [...this.groups.values()].flatMap((g) =>
      [...g.requests.values()].map((peer) => ({ groupId: g.groupId, groupName: g.name, peer })),
    );
  }

  publicGroups(): Array<{ groupId: string; name: string }> {
    return [...this.groups.values()]
      .filter((g) => g.visibility === 'public')
      .slice(0, MAX_ADVERTISED_GROUPS)
      .map((g) => ({ groupId: g.groupId, name: g.name }));
  }

  /** Decides an incoming connection that says it wants to join one of our groups. */
  screenJoin(peer: RemotePeer, intent: Extract<ConnectIntent, { kind: 'join' }>): IntentScreen {
    const group = this.groups.get(intent.groupId);
    if (!group || group.members.size >= MAX_GROUP_MEMBERS) return 'reject';
    if (group.members.has(peer.peerId) || group.invites.has(peer.peerId)) return 'accept';
    return group.visibility === 'public' ? 'prompt' : 'reject';
  }

  // --- Host actions --------------------------------------------------------------------------

  create(rawName: string, visibility: GroupVisibility): string {
    const name = normalizeGroupName(rawName);
    if (!name) throw new Error('Give the group a name.');
    if (this.groups.size >= MAX_HOSTED_GROUPS) throw new Error(`You can host at most ${MAX_HOSTED_GROUPS} groups.`);
    if (visibility === 'public' && this.publicGroups().length >= MAX_ADVERTISED_GROUPS) {
      throw new Error(`You can host at most ${MAX_ADVERTISED_GROUPS} public groups. Make this one private.`);
    }
    const groupId = newGroupId();
    const group: HostedGroup = {
      groupId,
      name,
      visibility,
      members: new Map([[this.opts.identity.peerId, this.self()]]),
      invites: new Map(),
      requests: new Map(),
    };
    this.groups.set(groupId, group);
    const conv = groupConversationId(groupId);
    this.opts.store.ensure(conv);
    this.opts.store.system(conv, `You created #${name} (${visibility})`);
    this.opts.log.info(`Created ${visibility} group #${name} (${groupId})`);
    this.emit('changed');
    if (visibility === 'public') this.emit('publicGroupsChanged');
    return groupId;
  }

  close(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    for (const peerId of this.otherMembers(group)) {
      this.sendTo(peerId, { kind: 'GROUP_REMOVED', groupId, reason: 'closed' });
    }
    for (const peerId of group.requests.keys()) {
      this.sendTo(peerId, { kind: 'GROUP_REMOVED', groupId, reason: 'declined' });
    }
    this.groups.delete(groupId);
    this.opts.store.delete(groupConversationId(groupId));
    this.emit('changed');
    if (group.visibility === 'public') this.emit('publicGroupsChanged');
  }

  /** Invites `peerId`. If not connected yet, connects with an invite intent (their prompt). */
  async invite(groupId: string, peerId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error('That group no longer exists.');
    if (group.members.has(peerId)) return;
    if (group.members.size >= MAX_GROUP_MEMBERS) throw new Error(`#${group.name} is full.`);
    group.invites.set(peerId, { delivered: false });
    this.emit('changed');
    if (this.opts.peers.isConnected(peerId)) {
      this.deliverInvite(group, peerId);
      return;
    }
    try {
      await this.opts.peers.connect(peerId, { kind: 'invite', groupId, groupName: group.name });
    } catch (err) {
      group.invites.delete(peerId);
      this.emit('changed');
      throw err;
    }
  }

  respondJoinRequest(groupId: string, peerId: string, accept: boolean): void {
    const group = this.groups.get(groupId);
    const request = group?.requests.get(peerId);
    if (!group || !request) return;
    group.requests.delete(peerId);
    const remote = this.opts.peers.remote(peerId);
    if (accept && remote) this.admit(group, remote);
    else this.sendTo(peerId, { kind: 'GROUP_REMOVED', groupId, reason: 'declined' });
    this.emit('changed');
  }

  remove(groupId: string, peerId: string): void {
    const group = this.groups.get(groupId);
    const member = group?.members.get(peerId);
    if (!group || !member || peerId === this.opts.identity.peerId) return;
    group.members.delete(peerId);
    this.sendTo(peerId, { kind: 'GROUP_REMOVED', groupId, reason: 'removed' });
    this.opts.store.system(groupConversationId(groupId), `You removed ${member.name}`);
    this.broadcastState(group);
    this.emit('changed');
  }

  send(groupId: string, content: string): boolean {
    const group = this.groups.get(groupId);
    const text = content.trim().slice(0, MAX_CHAT_LENGTH);
    if (!group || !text) return false;
    const message: RelayedMessage = {
      senderId: this.opts.identity.peerId,
      senderName: this.opts.getSelfName(),
      messageId: randomUUID(),
      content: text,
      timestamp: Date.now(),
    };
    this.record(group, message, true);
    this.relay(group, { kind: 'GROUP_RELAY', groupId, ...message }, message.senderId);
    return true;
  }

  setTyping(groupId: string, isTyping: boolean): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const self = this.self();
    this.relay(
      group,
      { kind: 'GROUP_TYPING', groupId, senderId: self.peerId, senderName: self.name, isTyping },
      self.peerId,
    );
  }

  /** Closes every hosted group so members are told before the connections go away. */
  dispose(): void {
    for (const groupId of [...this.groups.keys()]) this.close(groupId);
    for (const dispose of this.disposers) dispose();
    this.removeAllListeners();
  }

  // --- Connection events ---------------------------------------------------------------------

  private onConnected(peer: RemotePeer, info: ConnectionInfo): void {
    const { intent, direction } = info;
    // Accepting the connection prompt (theirs or ours) already answered the join or invite.
    if (direction === 'inbound' && intent?.kind === 'join') {
      const group = this.groups.get(intent.groupId);
      if (group) this.admit(group, peer);
    } else if (direction === 'outbound' && intent?.kind === 'invite') {
      const group = this.groups.get(intent.groupId);
      if (group?.invites.has(peer.peerId)) this.admit(group, peer);
    }
    // Invites that could not ride on this connection's intent are sent in-band.
    for (const group of this.groups.values()) {
      const invite = group.invites.get(peer.peerId);
      if (invite && !invite.delivered && !group.members.has(peer.peerId)) this.deliverInvite(group, peer.peerId);
    }
  }

  private onDisconnected(peer: RemotePeer): void {
    let changed = false;
    for (const group of this.groups.values()) {
      if (group.requests.delete(peer.peerId)) changed = true;
      const invite = group.invites.get(peer.peerId);
      if (invite) invite.delivered = false;
      if (group.members.delete(peer.peerId)) {
        this.opts.store.clearTyping(peer.peerId);
        this.opts.store.system(groupConversationId(group.groupId), `${peer.name} left (disconnected)`);
        this.broadcastState(group);
        changed = true;
      }
    }
    if (changed) this.emit('changed');
  }

  private onPayload(peer: RemotePeer, data: unknown): void {
    const payload = parseChatPayload(data);
    if (!payload) return;
    switch (payload.kind) {
      case 'TEXT': {
        const group = payload.groupId ? this.groups.get(payload.groupId) : undefined;
        if (!group || !group.members.has(peer.peerId)) return;
        const message: RelayedMessage = {
          senderId: peer.peerId,
          senderName: peer.name,
          messageId: payload.messageId,
          content: payload.content,
          timestamp: payload.timestamp,
        };
        if (this.record(group, message, false)) {
          this.relay(group, { kind: 'GROUP_RELAY', groupId: group.groupId, ...message }, peer.peerId);
        }
        return;
      }
      case 'TYPING_STATUS': {
        const group = payload.groupId ? this.groups.get(payload.groupId) : undefined;
        if (!group || !group.members.has(peer.peerId)) return;
        this.opts.store.setTyping(groupConversationId(group.groupId), peer.peerId, peer.name, payload.isTyping);
        this.relay(
          group,
          { kind: 'GROUP_TYPING', groupId: group.groupId, senderId: peer.peerId, senderName: peer.name, isTyping: payload.isTyping },
          peer.peerId,
        );
        return;
      }
      case 'GROUP_JOIN_REQUEST':
        this.onJoinRequest(peer, payload.groupId);
        return;
      case 'GROUP_INVITE_RESPONSE': {
        const group = this.groups.get(payload.groupId);
        if (!group || !group.invites.delete(peer.peerId)) return;
        if (payload.accept) this.admit(group, peer);
        else this.opts.store.system(groupConversationId(group.groupId), `${peer.name} declined the invite`);
        this.emit('changed');
        return;
      }
      case 'GROUP_LEAVE': {
        const group = this.groups.get(payload.groupId);
        if (!group || !group.members.delete(peer.peerId)) return;
        this.opts.store.system(groupConversationId(group.groupId), `${peer.name} left`);
        this.broadcastState(group);
        this.emit('changed');
        return;
      }
      default:
        return;
    }
  }

  private onJoinRequest(peer: RemotePeer, groupId: string): void {
    const group = this.groups.get(groupId);
    const decline = () => {
      this.sendTo(peer.peerId, { kind: 'GROUP_REMOVED', groupId, reason: 'declined' });
    };
    if (!group) return decline();
    if (group.members.has(peer.peerId)) {
      this.sendState(group, peer.peerId);
      return;
    }
    if (group.invites.has(peer.peerId)) {
      this.admit(group, peer);
      this.emit('changed');
      return;
    }
    if (group.visibility === 'private' || group.members.size >= MAX_GROUP_MEMBERS) return decline();
    if (group.requests.has(peer.peerId)) return;
    const request = memberOf(peer);
    group.requests.set(peer.peerId, request);
    this.emit('changed');
    this.emit('joinRequest', { groupId, groupName: group.name, peer: request });
  }

  // --- Internals -----------------------------------------------------------------------------

  private admit(group: HostedGroup, peer: RemotePeer): void {
    if (group.members.has(peer.peerId)) {
      this.sendState(group, peer.peerId);
      return;
    }
    group.invites.delete(peer.peerId);
    group.requests.delete(peer.peerId);
    if (group.members.size >= MAX_GROUP_MEMBERS) {
      this.sendTo(peer.peerId, { kind: 'GROUP_REMOVED', groupId: group.groupId, reason: 'declined' });
      return;
    }
    group.members.set(peer.peerId, memberOf(peer));
    this.broadcastState(group);
    const history = this.opts.store.recentText(groupConversationId(group.groupId), MAX_GROUP_HISTORY).map(
      (m): RelayedMessage => ({
        senderId: m.senderId,
        senderName: m.senderName,
        messageId: m.id,
        content: m.content,
        timestamp: m.timestamp,
      }),
    );
    if (history.length > 0) this.sendTo(peer.peerId, { kind: 'GROUP_HISTORY', groupId: group.groupId, messages: history });
    this.opts.store.system(groupConversationId(group.groupId), `${peer.name} joined`);
    this.opts.log.info(`${peer.name} joined #${group.name}`);
    this.emit('changed');
  }

  private deliverInvite(group: HostedGroup, peerId: string): void {
    if (this.sendTo(peerId, { kind: 'GROUP_INVITE', groupId: group.groupId, groupName: group.name })) {
      group.invites.set(peerId, { delivered: true });
    }
  }

  /** Stores a message in the host's own copy of the conversation. False if it was a duplicate. */
  private record(group: HostedGroup, m: RelayedMessage, fromSelf: boolean): boolean {
    return this.opts.store.append(groupConversationId(group.groupId), {
      id: m.messageId,
      kind: 'text',
      senderId: m.senderId,
      senderName: m.senderName,
      content: m.content,
      timestamp: m.timestamp,
      fromSelf,
    });
  }

  private self(): GroupMemberInfo {
    const { identity } = this.opts;
    return { peerId: identity.peerId, name: this.opts.getSelfName(), fingerprint: identity.fingerprint };
  }

  private memberList(group: HostedGroup): GroupMemberInfo[] {
    const self = this.self();
    return [self, ...[...group.members.values()].filter((m) => m.peerId !== self.peerId)];
  }

  private otherMembers(group: HostedGroup): string[] {
    return [...group.members.keys()].filter((id) => id !== this.opts.identity.peerId);
  }

  private stateOf(group: HostedGroup): ChatPayload {
    return {
      kind: 'GROUP_STATE',
      groupId: group.groupId,
      name: group.name,
      visibility: group.visibility,
      hostId: this.opts.identity.peerId,
      members: this.memberList(group),
    };
  }

  private sendState(group: HostedGroup, peerId: string): void {
    this.sendTo(peerId, this.stateOf(group));
  }

  private broadcastState(group: HostedGroup): void {
    const state = this.stateOf(group);
    for (const peerId of this.otherMembers(group)) this.sendTo(peerId, state);
  }

  private relay(group: HostedGroup, payload: ChatPayload, exceptId: string): void {
    for (const peerId of this.otherMembers(group)) {
      if (peerId !== exceptId) this.sendTo(peerId, payload);
    }
  }

  private sendTo(peerId: string, payload: ChatPayload): boolean {
    return this.opts.peers.send(peerId, 'lanChat', payload);
  }
}
