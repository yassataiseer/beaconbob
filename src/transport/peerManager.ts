import type { PeerRegistry } from '../discovery/peerRegistry';
import type { Identity } from '../security/identity';
import { type CodecFactory, HandshakeError, type LocalProfile } from '../signaling/handshakeCommon';
import type { ChannelName, ConnectIntent } from '../signaling/protocolTypes';
import { dial as defaultDial, type DialOptions } from '../signaling/signalClient';
import type { AuthorizeDecision, AuthorizeFn } from '../signaling/signalServer';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import type { ConnectionDirection, PeerConnection, RemotePeer } from './peerConnection';

export type ConnectionState = 'connecting' | 'connected';

/** How a stated intent changes the approval: decide without asking, or ask as usual. */
export type IntentScreen = 'accept' | 'reject' | 'prompt';

export interface ConnectionInfo {
  direction: ConnectionDirection;
  intent: ConnectIntent | undefined;
}

export interface PeerManagerOptions {
  identity: Identity;
  getProfile: () => LocalProfile;
  registry: PeerRegistry;
  /** Asks the local user whether `peer` may connect. */
  promptApproval: (peer: RemotePeer, intent: ConnectIntent | undefined, signal: AbortSignal) => Promise<boolean>;
  /** Consulted before prompting when an incoming connection states an intent. */
  screenIntent?: (peer: RemotePeer, intent: ConnectIntent) => IntentScreen;
  log: Log;
  codecFactory?: CodecFactory;
  dial?: (opts: DialOptions) => Promise<PeerConnection>;
}

type ManagerEvents = {
  changed: [];
  connected: [RemotePeer, ConnectionInfo];
  disconnected: [RemotePeer, string];
  channel: [RemotePeer, ChannelName, unknown];
};

/**
 * Owns every live `PeerConnection` (at most one per peer) and every in-flight dial.
 *
 * When two peers dial each other at once, the connection initiated by the lower peer id wins.
 * Both sides apply the same rule, so they always agree on which socket survives.
 */
export class PeerManager extends Emitter<ManagerEvents> {
  private readonly connections = new Map<string, PeerConnection>();
  private readonly dialing = new Map<string, AbortController>();
  private readonly prompting = new Set<string>();
  private disposed = false;

  constructor(private readonly opts: PeerManagerOptions) {
    super();
  }

  get selfId(): string {
    return this.opts.identity.peerId;
  }

  stateOf(peerId: string): ConnectionState | undefined {
    if (this.connections.get(peerId)?.isOpen) return 'connected';
    if (this.dialing.has(peerId)) return 'connecting';
    return undefined;
  }

  connected(): RemotePeer[] {
    return [...this.connections.values()].filter((c) => c.isOpen).map((c) => c.remote);
  }

  isConnected(peerId: string): boolean {
    return this.stateOf(peerId) === 'connected';
  }

  remote(peerId: string): RemotePeer | undefined {
    const conn = this.connections.get(peerId);
    return conn?.isOpen ? conn.remote : undefined;
  }

  async connect(peerId: string, intent?: ConnectIntent): Promise<void> {
    if (this.disposed || this.connections.has(peerId) || this.dialing.has(peerId)) return;
    const peer = this.opts.registry.get(peerId);
    if (!peer) throw new Error('That peer is no longer visible on the network.');

    const controller = new AbortController();
    this.dialing.set(peerId, controller);
    this.emit('changed');
    try {
      const conn = await (this.opts.dial ?? defaultDial)({
        identity: this.opts.identity,
        profile: this.opts.getProfile(),
        target: { peerId, fingerprint: peer.fingerprint, addresses: peer.addresses, port: peer.port },
        intent,
        log: this.opts.log,
        signal: controller.signal,
        codecFactory: this.opts.codecFactory,
      });
      this.adopt(conn);
    } catch (err) {
      // `cancelled`: their simultaneous dial won here. `duplicate`: our dial lost on their side,
      // so their connection is the one that will arrive. Neither is a user-facing failure.
      const benign = err instanceof HandshakeError && (err.reason === 'cancelled' || err.reason === 'duplicate');
      if (!benign) throw err;
      this.opts.log.info(`Dial to ${peerId} superseded (${(err as HandshakeError).reason})`);
    } finally {
      if (this.dialing.get(peerId) === controller) this.dialing.delete(peerId);
      this.emit('changed');
    }
  }

  readonly authorize: AuthorizeFn = async (peer, intent, signal): Promise<AuthorizeDecision> => {
    if (this.disposed) return { accept: false, reason: 'busy' };
    if (this.connections.get(peer.peerId)?.isOpen) return { accept: false, reason: 'already-connected' };
    const screen = intent && this.opts.screenIntent ? this.opts.screenIntent(peer, intent) : 'prompt';
    if (screen === 'reject') return { accept: false, reason: 'declined' };

    const ourDial = this.dialing.get(peer.peerId);
    if (ourDial) {
      if (peer.peerId > this.selfId) return { accept: false, reason: 'duplicate' };
      // Their dial wins. We already chose to connect to this peer, so no prompt is needed,
      // as long as it is the same key we saw advertised. An intent that needs an answer
      // (a join request, an invite) still gets the prompt.
      const needsAnswer = intent !== undefined && screen !== 'accept';
      if (!needsAnswer && this.opts.registry.get(peer.peerId)?.fingerprint === peer.fingerprint) {
        ourDial.abort();
        return { accept: true };
      }
    }

    if (screen === 'accept') return { accept: true };
    if (this.prompting.has(peer.peerId)) return { accept: false, reason: 'busy' };
    this.prompting.add(peer.peerId);
    let accepted: boolean;
    try {
      accepted = await this.opts.promptApproval(peer, intent, signal);
    } finally {
      this.prompting.delete(peer.peerId);
    }
    if (signal.aborted) return { accept: false, reason: 'timeout' };
    if (!accepted) return { accept: false, reason: 'declined' };
    if (this.connections.get(peer.peerId)?.isOpen) return { accept: false, reason: 'already-connected' };
    return { accept: true };
  };

  adopt(conn: PeerConnection): void {
    const peerId = conn.remote.peerId;
    if (this.disposed) {
      conn.close('shutdown');
      return;
    }
    const existing = this.connections.get(peerId);
    if (existing?.isOpen) {
      const preferredInitiator = peerId < this.selfId ? peerId : this.selfId;
      const loser = conn.initiatorId === preferredInitiator && existing.initiatorId !== preferredInitiator ? existing : conn;
      loser.close('duplicate');
      if (loser === conn) return;
    }

    this.connections.set(peerId, conn);
    conn.on('channel', (channel, data) => this.emit('channel', conn.remote, channel, data));
    conn.on('close', (reason) => {
      if (this.connections.get(peerId) !== conn) return;
      this.connections.delete(peerId);
      this.opts.log.info(`Disconnected from ${conn.remote.name} (${reason})`);
      this.emit('disconnected', conn.remote, reason);
      this.emit('changed');
    });
    // Announce before `start()` delivers any held frames, so listeners can set up per-peer
    // state (for example admitting a group member) before that peer's first message arrives.
    if (!conn.isOpen) return;
    this.emit('connected', conn.remote, { direction: conn.direction, intent: conn.intent });
    conn.start();
    this.emit('changed');
  }

  disconnect(peerId: string, reason = 'user'): void {
    this.dialing.get(peerId)?.abort();
    this.connections.get(peerId)?.close(reason);
  }

  send(peerId: string, channel: ChannelName, data: unknown): boolean {
    return this.connections.get(peerId)?.send(channel, data) ?? false;
  }

  /** Sends to every connected peer; returns how many accepted the frame. */
  broadcast(channel: ChannelName, data: unknown): number {
    let sent = 0;
    for (const conn of this.connections.values()) if (conn.send(channel, data)) sent++;
    return sent;
  }

  dispose(reason = 'shutdown'): void {
    this.disposed = true;
    for (const controller of this.dialing.values()) controller.abort();
    for (const conn of [...this.connections.values()]) conn.close(reason);
  }
}
