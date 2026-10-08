import type { RawData, WebSocket } from 'ws';
import {
  type ChannelName,
  type ConnectIntent,
  createMessage,
  parseMessage,
  type PayloadOf,
  type ProtocolMessage,
} from '../signaling/protocolTypes';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import { type Frame, type FrameCodec, toBuffer } from './frames';

/** A peer whose identity was proven during the handshake. */
export interface RemotePeer {
  peerId: string;
  name: string;
  workspace: string;
  appVersion: string;
  publicKey: string;
  fingerprint: string;
  address: string;
}

export type ConnectionDirection = 'inbound' | 'outbound';

export interface PeerConnectionInit {
  ws: WebSocket;
  codec: FrameCodec;
  localPeerId: string;
  remote: RemotePeer;
  sessionId: string;
  direction: ConnectionDirection;
  /** Why the initiator opened this connection, if it said (accepted together with the connection). */
  intent?: ConnectIntent;
  /** Frames that arrived while the handshake still owned the socket. */
  pendingFrames?: Frame[];
  log: Log;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

type ConnectionEvents = {
  channel: [ChannelName, unknown];
  close: [string];
};

type SessionType = 'CHANNEL' | 'PING' | 'BYE' | 'WELCOME';

/**
 * One authenticated socket to one peer. Carries named channels (`lanChat`, `lanCodeSync`)
 * multiplexed over the same connection, plus heartbeats. Frames received before `start()`
 * are held so the owner can attach listeners first.
 */
export class PeerConnection extends Emitter<ConnectionEvents> {
  readonly remote: RemotePeer;
  readonly direction: ConnectionDirection;
  readonly sessionId: string;
  readonly connectedAt = Date.now();
  /** Peer id of whoever dialed. Used to break ties between simultaneous connections. */
  readonly initiatorId: string;
  readonly intent: ConnectIntent | undefined;

  private readonly ws: WebSocket;
  private readonly codec: FrameCodec;
  private readonly localPeerId: string;
  private readonly log: Log;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private held: Frame[] | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastReceived = Date.now();
  private closeReason: string | undefined;
  private closed = false;

  constructor(init: PeerConnectionInit) {
    super();
    this.ws = init.ws;
    this.codec = init.codec;
    this.localPeerId = init.localPeerId;
    this.remote = init.remote;
    this.sessionId = init.sessionId;
    this.direction = init.direction;
    this.initiatorId = init.direction === 'outbound' ? init.localPeerId : init.remote.peerId;
    this.intent = init.intent;
    this.log = init.log;
    this.heartbeatIntervalMs = init.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimeoutMs = init.heartbeatTimeoutMs ?? 35_000;
    this.held = [...(init.pendingFrames ?? [])];

    this.ws.on('message', this.onRawMessage);
    this.ws.on('close', this.onClose);
    this.ws.on('error', (err) => this.log.warn(`Socket error with ${this.remote.name}: ${err.message}`));
    if (this.ws.readyState !== this.ws.OPEN) queueMicrotask(this.onClose);
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === this.ws.OPEN;
  }

  /** Begins delivering frames and heartbeats. Call after attaching listeners. */
  start(): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    for (const frame of held) this.handleFrame(frame);
    if (this.closed) return;
    this.heartbeat = setInterval(() => this.tick(), this.heartbeatIntervalMs);
  }

  send(channel: ChannelName, data: unknown): boolean {
    return this.sendSession('CHANNEL', { channel, data });
  }

  sendSession<K extends SessionType>(type: K, payload: PayloadOf<K>): boolean {
    if (!this.isOpen) return false;
    const msg = createMessage(type, payload, {
      senderId: this.localPeerId,
      targetId: this.remote.peerId,
      sessionId: this.sessionId,
    });
    try {
      this.ws.send(this.codec.encode(JSON.stringify(msg)));
      return true;
    } catch (err) {
      this.log.warn(`Failed to send to ${this.remote.name}: ${(err as Error).message}`);
      return false;
    }
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closeReason ??= reason;
    this.sendSession('BYE', { reason: reason.slice(0, 64) });
    this.ws.close(1000, reason.slice(0, 64));
    // Do not wait forever for the remote side to complete the close handshake.
    setTimeout(() => this.ws.terminate(), 2000).unref();
  }

  private tick(): void {
    if (Date.now() - this.lastReceived > this.heartbeatTimeoutMs) {
      this.log.warn(`No traffic from ${this.remote.name} for ${this.heartbeatTimeoutMs}ms, dropping`);
      this.closeReason ??= 'timeout';
      this.ws.terminate();
      return;
    }
    this.sendSession('PING', { ts: Date.now() });
  }

  private readonly onRawMessage = (data: RawData, isBinary: boolean) => {
    const frame = { data: toBuffer(data), isBinary };
    if (this.held) this.held.push(frame);
    else this.handleFrame(frame);
  };

  private handleFrame(frame: Frame): void {
    if (this.closed) return;
    let msg: ProtocolMessage | undefined;
    try {
      msg = parseMessage(this.codec.decode(frame));
    } catch (err) {
      this.log.warn(`Undecodable frame from ${this.remote.name}: ${(err as Error).message}`);
    }
    if (
      !msg ||
      msg.senderId !== this.remote.peerId ||
      msg.targetId !== this.localPeerId ||
      msg.sessionId !== this.sessionId
    ) {
      this.protocolError();
      return;
    }
    this.lastReceived = Date.now();

    switch (msg.type) {
      case 'CHANNEL':
        this.emit('channel', msg.payload.channel, msg.payload.data);
        return;
      case 'PING':
      case 'WELCOME':
        return;
      case 'BYE':
        this.closeReason ??= msg.payload.reason || 'remote-closed';
        this.ws.close(1000);
        return;
      default:
        this.protocolError();
    }
  }

  private protocolError(): void {
    this.closeReason ??= 'protocol-error';
    this.ws.terminate();
  }

  private readonly onClose = () => {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.held = undefined;
    this.emit('close', this.closeReason ?? 'disconnected');
    this.removeAllListeners();
  };
}
