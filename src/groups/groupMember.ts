import { randomUUID } from 'node:crypto';
import { type ConversationStore, groupConversationId } from '../chat/conversationStore';
import type { Identity } from '../security/identity';
import { type ChatPayload, MAX_CHAT_LENGTH, parseChatPayload } from '../signaling/protocolTypes';
import type { RemotePeer } from '../transport/peerConnection';
import type { ConnectionInfo, PeerManager } from '../transport/peerManager';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import type { GroupMemberInfo, GroupVisibility } from './groupTypes';

export type GroupEndReason = 'closed' | 'removed' | 'host-left';

export interface JoinedGroup {
  groupId: string;
  name: string;
  visibility: GroupVisibility;
  hostId: string;
  members: GroupMemberInfo[];
  ended?: GroupEndReason;
}

export interface Invitation {
  groupId: string;
  groupName: string;
  hostId: string;
  hostName: string;
}

export interface GroupMemberOptions {
  peers: PeerManager;
  store: ConversationStore;
  identity: Identity;
  getSelfName: () => string;
  log: Log;
}

type MemberEvents = {
  changed: [];
  /** An invite arrived over an existing connection and needs an answer. */
  invitation: [Invitation];
  joinDeclined: [{ groupId: string; hostName: string }];
};

const END_MESSAGES: Record<GroupEndReason, string> = {
  closed: 'The host closed this group.',
  removed: 'You were removed from this group.',
  'host-left': 'The host disconnected, so this group has ended.',
};

/**
 * The member side of hosted groups. Everything about a group arrives from its host's
 * connection; group messages from anyone else are ignored.
 */
export class GroupMember extends Emitter<MemberEvents> {
  private readonly groups = new Map<string, JoinedGroup>();
  /** Groups we asked to join (or accepted an invite to), awaiting the host's GROUP_STATE. */
  private readonly pending = new Map<string, { hostId: string }>();
  private readonly invitations = new Map<string, Invitation>();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly opts: GroupMemberOptions) {
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

  joined(): JoinedGroup[] {
    return [...this.groups.values()];
  }

  group(groupId: string): JoinedGroup | undefined {
    return this.groups.get(groupId);
  }

  isPending(groupId: string): boolean {
    return this.pending.has(groupId);
  }

  pendingInvitations(): Invitation[] {
    return [...this.invitations.values()];
  }

  // --- Member actions ------------------------------------------------------------------------

  /** Asks `hostId` to admit us. Connects with a join intent if we are not connected yet. */
  async requestJoin(hostId: string, groupId: string): Promise<void> {
    const existing = this.groups.get(groupId);
    if ((existing && !existing.ended) || this.pending.has(groupId)) return;
    if (existing) this.forget(groupId);
    this.pending.set(groupId, { hostId });
    this.emit('changed');
    if (this.opts.peers.isConnected(hostId)) {
      this.sendTo(hostId, { kind: 'GROUP_JOIN_REQUEST', groupId });
      return;
    }
    try {
      await this.opts.peers.connect(hostId, { kind: 'join', groupId });
    } catch (err) {
      this.pending.delete(groupId);
      this.emit('changed');
      throw err;
    }
  }

  respondInvite(groupId: string, accept: boolean): void {
    const invitation = this.invitations.get(groupId);
    if (!invitation) return;
    this.invitations.delete(groupId);
    if (accept) this.pending.set(groupId, { hostId: invitation.hostId });
    this.sendTo(invitation.hostId, { kind: 'GROUP_INVITE_RESPONSE', groupId, accept });
    this.emit('changed');
  }

  /** Leaves an active group, or just removes an ended one from the list. */
  leave(groupId: string): void {
    const group = this.groups.get(groupId);
    if (group && !group.ended) this.sendTo(group.hostId, { kind: 'GROUP_LEAVE', groupId });
    this.pending.delete(groupId);
    this.forget(groupId);
  }

  send(groupId: string, content: string): boolean {
    const group = this.groups.get(groupId);
    const text = content.trim().slice(0, MAX_CHAT_LENGTH);
    if (!group || group.ended || !text) return false;
    const payload: ChatPayload = { kind: 'TEXT', groupId, messageId: randomUUID(), content: text, timestamp: Date.now() };
    if (!this.sendTo(group.hostId, payload)) return false;
    this.opts.store.append(groupConversationId(groupId), {
      id: payload.messageId,
      kind: 'text',
      senderId: this.opts.identity.peerId,
      senderName: this.opts.getSelfName(),
      content: text,
      timestamp: payload.timestamp,
      fromSelf: true,
    });
    return true;
  }

  setTyping(groupId: string, isTyping: boolean): void {
    const group = this.groups.get(groupId);
    if (group && !group.ended) this.sendTo(group.hostId, { kind: 'TYPING_STATUS', groupId, isTyping });
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.removeAllListeners();
  }

  // --- Connection events ---------------------------------------------------------------------

  private onConnected(peer: RemotePeer, info: ConnectionInfo): void {
    // Accepting the host's invite prompt is the answer to the invite.
    if (info.direction === 'inbound' && info.intent?.kind === 'invite') {
      this.invitations.delete(info.intent.groupId);
      this.pending.set(info.intent.groupId, { hostId: peer.peerId });
      this.emit('changed');
    }
    // Join requests that did not ride on this connection's intent go in-band.
    for (const [groupId, { hostId }] of this.pending) {
      if (hostId !== peer.peerId) continue;
      const carried =
        (info.direction === 'outbound' && info.intent?.kind === 'join' && info.intent.groupId === groupId) ||
        (info.direction === 'inbound' && info.intent?.kind === 'invite' && info.intent.groupId === groupId);
      if (!carried) this.sendTo(peer.peerId, { kind: 'GROUP_JOIN_REQUEST', groupId });
    }
  }

  private onDisconnected(peer: RemotePeer): void {
    let changed = false;
    for (const group of this.groups.values()) {
      if (group.hostId === peer.peerId && !group.ended) {
        this.end(group, 'host-left');
        changed = true;
      }
    }
    for (const [groupId, { hostId }] of this.pending) {
      if (hostId === peer.peerId) changed = this.pending.delete(groupId) || changed;
    }
    for (const [groupId, invitation] of this.invitations) {
      if (invitation.hostId === peer.peerId) changed = this.invitations.delete(groupId) || changed;
    }
    if (changed) this.emit('changed');
  }

  private onPayload(peer: RemotePeer, data: unknown): void {
    const payload = parseChatPayload(data);
    if (!payload) return;
    const selfId = this.opts.identity.peerId;
    const conv = (groupId: string) => groupConversationId(groupId);
    /** The group, but only if `peer` is its host and it is still running. */
    const fromHost = (groupId: string) => {
      const group = this.groups.get(groupId);
      return group && group.hostId === peer.peerId && !group.ended ? group : undefined;
    };

    switch (payload.kind) {
      case 'GROUP_STATE': {
        if (payload.hostId !== peer.peerId) return;
        if (!payload.members.some((m) => m.peerId === selfId)) return;
        const existing = fromHost(payload.groupId);
        const awaited = this.pending.get(payload.groupId)?.hostId === peer.peerId;
        if (!existing && !awaited) return;
        const next: JoinedGroup = {
          groupId: payload.groupId,
          name: payload.name,
          visibility: payload.visibility,
          hostId: payload.hostId,
          members: payload.members,
        };
        if (existing) {
          this.announceMembershipChanges(existing, next);
        } else {
          this.pending.delete(payload.groupId);
          this.invitations.delete(payload.groupId);
          this.opts.store.ensure(conv(payload.groupId));
          this.opts.store.system(conv(payload.groupId), `You joined #${payload.name}, hosted by ${peer.name}`);
          this.opts.log.info(`Joined #${payload.name} hosted by ${peer.name}`);
        }
        this.groups.set(payload.groupId, next);
        this.emit('changed');
        return;
      }
      case 'GROUP_HISTORY': {
        if (!fromHost(payload.groupId)) return;
        for (const m of payload.messages) {
          this.opts.store.append(conv(payload.groupId), {
            id: m.messageId,
            kind: 'text',
            senderId: m.senderId,
            senderName: m.senderName,
            content: m.content,
            timestamp: m.timestamp,
            fromSelf: m.senderId === selfId,
          });
        }
        return;
      }
      case 'GROUP_RELAY': {
        if (!fromHost(payload.groupId) || payload.senderId === selfId) return;
        this.opts.store.append(conv(payload.groupId), {
          id: payload.messageId,
          kind: 'text',
          senderId: payload.senderId,
          senderName: payload.senderName,
          content: payload.content,
          timestamp: payload.timestamp,
          fromSelf: false,
        });
        return;
      }
      case 'GROUP_TYPING': {
        if (!fromHost(payload.groupId) || payload.senderId === selfId) return;
        this.opts.store.setTyping(conv(payload.groupId), payload.senderId, payload.senderName, payload.isTyping);
        return;
      }
      case 'GROUP_INVITE': {
        if (fromHost(payload.groupId) || this.pending.has(payload.groupId)) return;
        const invitation: Invitation = {
          groupId: payload.groupId,
          groupName: payload.groupName,
          hostId: peer.peerId,
          hostName: peer.name,
        };
        const isNew = !this.invitations.has(payload.groupId);
        this.invitations.set(payload.groupId, invitation);
        this.emit('changed');
        if (isNew) this.emit('invitation', invitation);
        return;
      }
      case 'GROUP_REMOVED': {
        const group = fromHost(payload.groupId);
        if (group) {
          this.end(group, payload.reason === 'closed' ? 'closed' : 'removed');
          this.emit('changed');
        } else if (this.pending.get(payload.groupId)?.hostId === peer.peerId) {
          this.pending.delete(payload.groupId);
          this.emit('changed');
          this.emit('joinDeclined', { groupId: payload.groupId, hostName: peer.name });
        }
        return;
      }
      default:
        return;
    }
  }

  // --- Internals -----------------------------------------------------------------------------

  private end(group: JoinedGroup, reason: GroupEndReason): void {
    group.ended = reason;
    const id = groupConversationId(group.groupId);
    this.opts.store.clearTyping(group.hostId);
    this.opts.store.system(id, END_MESSAGES[reason]);
  }

  private announceMembershipChanges(prev: JoinedGroup, next: JoinedGroup): void {
    const selfId = this.opts.identity.peerId;
    const before = new Map(prev.members.map((m) => [m.peerId, m]));
    const after = new Map(next.members.map((m) => [m.peerId, m]));
    const id = groupConversationId(next.groupId);
    for (const [peerId, m] of after) {
      if (peerId !== selfId && !before.has(peerId)) this.opts.store.system(id, `${m.name} joined`);
    }
    for (const [peerId, m] of before) {
      if (peerId !== selfId && !after.has(peerId)) this.opts.store.system(id, `${m.name} left`);
    }
  }

  private forget(groupId: string): void {
    this.groups.delete(groupId);
    this.opts.store.delete(groupConversationId(groupId));
    this.emit('changed');
  }

  private sendTo(peerId: string, payload: ChatPayload): boolean {
    return this.opts.peers.send(peerId, 'lanChat', payload);
  }
}
