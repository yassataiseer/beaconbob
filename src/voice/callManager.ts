import type { GroupHost } from '../groups/groupHost';
import type { GroupMember } from '../groups/groupMember';
import type { Identity } from '../security/identity';
import type { RemotePeer } from '../transport/peerConnection';
import type { PeerManager } from '../transport/peerManager';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import { MAX_CALL_PARTICIPANTS, parseVoicePayload, type VoicePayload, type VoiceSignal } from './voiceProtocol';

export type CallRef = { scope: 'group'; groupId: string } | { scope: 'dm'; peerId: string };

export interface CallManagerOptions {
  peers: PeerManager;
  groupHost: GroupHost;
  member: GroupMember;
  identity: Identity;
  log: Log;
}

type CallEvents = {
  changed: [];
  /** A WebRTC signal for the companion page, from `from`. */
  signal: [from: string, signal: VoiceSignal];
  /** A connected peer started a DM call with us. */
  incoming: [peerId: string];
};

const sameCall = (a: CallRef | undefined, b: CallRef | undefined) =>
  !!a &&
  !!b &&
  a.scope === b.scope &&
  (a.scope === 'group' ? a.groupId === (b as { groupId: string }).groupId : a.peerId === (b as { peerId: string }).peerId);

/**
 * Who is in which call, and the WebRTC signalling between them. You are in at most one call
 * at a time. A group's call is coordinated by its host: members announce themselves to the
 * host, the host publishes the participant list and forwards signals between members.
 */
export class CallManager extends Emitter<CallEvents> {
  private current: CallRef | undefined;
  /** As a host: participants (including yourself, if joined) of each hosted group's call. */
  private readonly hosted = new Map<string, Set<string>>();
  /** As a member: the participant list the host last published for each group. */
  private readonly groupCalls = new Map<string, string[]>();
  /** Peers who said they are in a DM call with us. */
  private readonly dmRemote = new Set<string>();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly opts: CallManagerOptions) {
    super();
    const { peers } = opts;
    this.disposers.push(
      peers.on('channel', (peer, channel, data) => {
        if (channel === 'lanVoice') this.onPayload(peer, data);
      }),
      peers.on('disconnected', (peer) => this.onDisconnected(peer.peerId)),
      peers.on('connected', (peer) => {
        // Still in a DM call with someone whose connection dropped and came back: say so again.
        if (this.isIn({ scope: 'dm', peerId: peer.peerId })) this.send(peer.peerId, { kind: 'VOICE_JOIN', scope: 'dm' });
      }),
      opts.groupHost.on('changed', () => this.reconcileHosted()),
      opts.member.on('changed', () => this.reconcileJoined()),
    );
  }

  private get selfId(): string {
    return this.opts.identity.peerId;
  }

  // --- Queries -------------------------------------------------------------------------------

  get call(): CallRef | undefined {
    return this.current;
  }

  /** Remote peers in your current call to exchange audio with (confirmed by the coordinator). */
  remoteParticipants(): string[] {
    const call = this.current;
    if (!call) return [];
    if (call.scope === 'dm') return this.dmRemote.has(call.peerId) ? [call.peerId] : [];
    const list = this.participantsOf(call.groupId);
    return list.includes(this.selfId) ? list.filter((id) => id !== this.selfId) : [];
  }

  /** Everyone in a group's call, including you. */
  participantsOf(groupId: string): string[] {
    const hosted = this.hosted.get(groupId);
    if (hosted) return [...hosted];
    return this.groupCalls.get(groupId) ?? [];
  }

  /** Whether `peerId` says they are in a DM call with you. */
  dmPeerInCall(peerId: string): boolean {
    return this.dmRemote.has(peerId);
  }

  isIn(ref: CallRef): boolean {
    return sameCall(this.current, ref);
  }

  // --- Actions -------------------------------------------------------------------------------

  join(ref: CallRef): void {
    if (sameCall(this.current, ref)) return;
    if (ref.scope === 'group') {
      const isHost = this.opts.groupHost.isHost(ref.groupId);
      const group = this.opts.member.group(ref.groupId);
      if (!isHost && (!group || group.ended)) throw new Error('You are not in that group.');
      if (this.participantsOf(ref.groupId).length >= MAX_CALL_PARTICIPANTS) {
        throw new Error(`This call is full (${MAX_CALL_PARTICIPANTS} people).`);
      }
      this.leave();
      this.current = ref;
      if (isHost) {
        this.hostedCall(ref.groupId).add(this.selfId);
        this.broadcastState(ref.groupId);
      } else {
        this.send(group!.hostId, { kind: 'VOICE_JOIN', scope: 'group', groupId: ref.groupId });
      }
    } else {
      if (!this.opts.peers.isConnected(ref.peerId)) throw new Error('Connect to them first to call them.');
      this.leave();
      this.current = ref;
      this.send(ref.peerId, { kind: 'VOICE_JOIN', scope: 'dm' });
    }
    this.emit('changed');
  }

  leave(): void {
    const call = this.current;
    if (!call) return;
    this.current = undefined;
    if (call.scope === 'dm') {
      this.send(call.peerId, { kind: 'VOICE_LEAVE', scope: 'dm' });
    } else if (this.opts.groupHost.isHost(call.groupId)) {
      this.hosted.get(call.groupId)?.delete(this.selfId);
      this.broadcastState(call.groupId);
    } else {
      const hostId = this.opts.member.group(call.groupId)?.hostId;
      if (hostId) this.send(hostId, { kind: 'VOICE_LEAVE', scope: 'group', groupId: call.groupId });
    }
    this.emit('changed');
  }

  /** Sends a WebRTC signal from the companion page to `to` in the current call. */
  sendSignal(to: string, signal: VoiceSignal): boolean {
    const call = this.current;
    if (!call || !this.remoteParticipants().includes(to)) return false;
    if (call.scope === 'dm') return this.send(to, { kind: 'VOICE_SIGNAL', scope: 'dm', to, signal });
    const groupId = call.groupId;
    if (this.opts.groupHost.isHost(groupId)) {
      return this.send(to, { kind: 'VOICE_SIGNAL', scope: 'group', groupId, to, signal });
    }
    const hostId = this.opts.member.group(groupId)?.hostId;
    return !!hostId && this.send(hostId, { kind: 'VOICE_SIGNAL', scope: 'group', groupId, to, signal });
  }

  dispose(): void {
    this.leave();
    for (const groupId of [...this.hosted.keys()]) {
      this.hosted.delete(groupId);
      this.broadcastState(groupId);
    }
    for (const dispose of this.disposers) dispose();
    this.removeAllListeners();
  }

  // --- Incoming ------------------------------------------------------------------------------

  private onPayload(peer: RemotePeer, data: unknown): void {
    const payload = parseVoicePayload(data);
    if (!payload) return;
    const from = peer.peerId;
    switch (payload.kind) {
      case 'VOICE_JOIN':
      case 'VOICE_LEAVE':
        if (payload.scope === 'dm') this.onDmPresence(from, payload.kind === 'VOICE_JOIN');
        else this.onGroupPresence(from, payload.groupId!, payload.kind === 'VOICE_JOIN');
        return;
      case 'VOICE_STATE': {
        // Only the group's host may say who is in its call.
        const group = this.opts.member.group(payload.groupId);
        if (!group || group.hostId !== from) return;
        this.groupCalls.set(payload.groupId, payload.participants);
        if (this.isIn({ scope: 'group', groupId: payload.groupId }) || payload.participants.includes(this.selfId)) {
          this.opts.log.debug(`Call in #${group.name}: ${payload.participants.length} participant(s)`);
        }
        this.emit('changed');
        return;
      }
      case 'VOICE_SIGNAL':
        this.onSignal(from, payload);
        return;
      default:
        return;
    }
  }

  private onDmPresence(from: string, inCall: boolean): void {
    const had = this.dmRemote.has(from);
    if (inCall) this.dmRemote.add(from);
    else this.dmRemote.delete(from);
    if (had === inCall) return;
    if (inCall && !this.isIn({ scope: 'dm', peerId: from })) this.emit('incoming', from);
    this.emit('changed');
  }

  private onGroupPresence(from: string, groupId: string, inCall: boolean): void {
    if (!this.opts.groupHost.isHost(groupId)) return;
    if (!this.memberIds(groupId).has(from)) return;
    const call = this.hostedCall(groupId);
    if (inCall) {
      if (call.size >= MAX_CALL_PARTICIPANTS && !call.has(from)) return;
      call.add(from);
    } else {
      call.delete(from);
    }
    this.broadcastState(groupId);
    this.emit('changed');
  }

  private onSignal(sender: string, payload: Extract<VoicePayload, { kind: 'VOICE_SIGNAL' }>): void {
    if (payload.scope === 'dm') {
      if (payload.to === this.selfId && this.isIn({ scope: 'dm', peerId: sender }) && this.dmRemote.has(sender)) {
        this.emit('signal', sender, payload.signal);
      }
      return;
    }
    const groupId = payload.groupId!;
    if (this.opts.groupHost.isHost(groupId)) {
      // A member's signal: forward it, vouching for who sent it, but only between participants.
      const call = this.hosted.get(groupId);
      if (!call?.has(sender) || payload.from !== undefined) return;
      if (payload.to === this.selfId) {
        if (call.has(this.selfId) && this.isIn({ scope: 'group', groupId })) this.emit('signal', sender, payload.signal);
        return;
      }
      if (call.has(payload.to)) {
        this.send(payload.to, { kind: 'VOICE_SIGNAL', scope: 'group', groupId, to: payload.to, from: sender, signal: payload.signal });
      }
      return;
    }
    // As a member, signals only come from the host: either the host's own (no `from`) or forwarded.
    const group = this.opts.member.group(groupId);
    if (!group || group.hostId !== sender || payload.to !== this.selfId || !this.isIn({ scope: 'group', groupId })) return;
    const origin = payload.from ?? sender;
    if (origin === this.selfId || !this.remoteParticipants().includes(origin)) return;
    this.emit('signal', origin, payload.signal);
  }

  // --- Cleanup -------------------------------------------------------------------------------

  private onDisconnected(peerId: string): void {
    let changed = this.dmRemote.delete(peerId);
    for (const [groupId, call] of this.hosted) {
      if (call.delete(peerId)) {
        this.broadcastState(groupId);
        changed = true;
      }
    }
    for (const groupId of [...this.groupCalls.keys()]) {
      if (this.opts.member.group(groupId)?.hostId === peerId) {
        this.groupCalls.delete(groupId);
        changed = true;
      }
    }
    const call = this.current;
    if (call?.scope === 'group' && !this.opts.groupHost.isHost(call.groupId) && this.opts.member.group(call.groupId)?.hostId === peerId) {
      this.current = undefined;
      changed = true;
    }
    if (changed) this.emit('changed');
  }

  /** Drops calls for groups we no longer host and people no longer in them. */
  private reconcileHosted(): void {
    let changed = false;
    for (const [groupId, call] of [...this.hosted]) {
      if (!this.opts.groupHost.isHost(groupId)) {
        this.hosted.delete(groupId);
        if (this.isIn({ scope: 'group', groupId })) this.current = undefined;
        changed = true;
        continue;
      }
      const members = this.memberIds(groupId);
      let removed = false;
      for (const peerId of [...call]) {
        if (peerId !== this.selfId && !members.has(peerId)) removed = call.delete(peerId) || removed;
      }
      // Re-publish whenever membership changes so newcomers learn about a running call.
      if (call.size > 0 || removed) this.broadcastState(groupId);
      changed = changed || removed;
    }
    if (changed) this.emit('changed');
  }

  private reconcileJoined(): void {
    const call = this.current;
    let changed = false;
    for (const groupId of [...this.groupCalls.keys()]) {
      const group = this.opts.member.group(groupId);
      if (!group || group.ended) {
        this.groupCalls.delete(groupId);
        changed = true;
      }
    }
    if (call?.scope === 'group' && !this.opts.groupHost.isHost(call.groupId)) {
      const group = this.opts.member.group(call.groupId);
      if (!group || group.ended) {
        this.current = undefined;
        changed = true;
      }
    }
    if (changed) this.emit('changed');
  }

  // --- Helpers -------------------------------------------------------------------------------

  private hostedCall(groupId: string): Set<string> {
    let call = this.hosted.get(groupId);
    if (!call) this.hosted.set(groupId, (call = new Set()));
    return call;
  }

  private memberIds(groupId: string): Set<string> {
    const group = this.opts.groupHost.hosted().find((g) => g.groupId === groupId);
    return new Set(group?.members.map((m) => m.peerId) ?? []);
  }

  private broadcastState(groupId: string): void {
    const participants = [...(this.hosted.get(groupId) ?? [])];
    for (const peerId of this.memberIds(groupId)) {
      if (peerId !== this.selfId) this.send(peerId, { kind: 'VOICE_STATE', groupId, participants });
    }
  }

  private send(peerId: string, payload: VoicePayload): boolean {
    return this.opts.peers.send(peerId, 'lanVoice', payload);
  }
}
