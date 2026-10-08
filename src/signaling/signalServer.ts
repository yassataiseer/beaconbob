import * as http from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { createEphemeralKey, createNonce, type HandshakeTranscript, transcriptBytes } from '../security/handshake';
import { type Identity, sign, verify } from '../security/identity';
import { FrameQueue } from '../transport/frames';
import { PeerConnection, type RemotePeer } from '../transport/peerConnection';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import { isLanAddress, listenInRange, normalizeAddress, type PortRange } from '../util/network';
import {
  buildHello,
  type CodecFactory,
  copyIntent,
  createSessionCodec,
  HandshakeError,
  type LocalProfile,
  remoteFromHello,
  sendHandshake,
} from './handshakeCommon';
import { type ConnectIntent, MAX_FRAME_BYTES, parseMessage, type RejectReason } from './protocolTypes';

export type AuthorizeDecision = { accept: true } | { accept: false; reason: RejectReason };

/**
 * Decides whether an authenticated remote peer may connect (user prompt, duplicate checks).
 * `intent` is why they are connecting, if they said. `signal` aborts if the remote side hangs
 * up while the decision is pending.
 */
export type AuthorizeFn = (
  peer: RemotePeer,
  intent: ConnectIntent | undefined,
  signal: AbortSignal,
) => Promise<AuthorizeDecision>;

export interface SignalServerOptions {
  identity: Identity;
  getProfile: () => LocalProfile;
  authorize: AuthorizeFn;
  log: Log;
  codecFactory?: CodecFactory;
  handshakeTimeoutMs?: number;
  approvalTimeoutMs?: number;
}

type ServerEvents = {
  connection: [PeerConnection];
};

/**
 * Embedded WebSocket server: the responder side of the BeaconBob handshake. Every peer runs one,
 * so there is no relay; a successful handshake produces a direct `PeerConnection`.
 */
export class SignalServer extends Emitter<ServerEvents> {
  private http: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private port: number | undefined;

  constructor(private readonly opts: SignalServerOptions) {
    super();
  }

  get listeningPort(): number | undefined {
    return this.port;
  }

  async start(range: PortRange, host?: string): Promise<number> {
    const server = http.createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' }).end('BeaconBob signaling expects a WebSocket upgrade\n');
    });
    const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
    wss.on('connection', (ws, req) => {
      void this.handleSocket(ws, normalizeAddress(req.socket.remoteAddress ?? ''));
    });
    // `ws` re-emits the HTTP server's errors, including EADDRINUSE while `listenInRange` is
    // still probing ports; those are expected, so only report errors once we are listening.
    wss.on('error', (err) => {
      if (this.port !== undefined) this.opts.log.error(`Signal server error: ${err.message}`);
    });
    this.port = await listenInRange(server, range, host);
    this.http = server;
    this.wss = wss;
    this.opts.log.info(`Signal server listening on port ${this.port}`);
    return this.port;
  }

  async stop(): Promise<void> {
    const { wss, http: server } = this;
    this.wss = undefined;
    this.http = undefined;
    this.port = undefined;
    if (!wss || !server) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handleSocket(ws: WebSocket, address: string): Promise<void> {
    const log = this.opts.log;
    if (!isLanAddress(address)) {
      log.warn(`Refusing non-LAN connection from ${address}`);
      ws.close(1008, 'lan-only');
      return;
    }
    ws.on('error', (err) => log.debug(`Handshake socket error from ${address}: ${err.message}`));

    const queue = new FrameQueue(ws);
    const { identity } = this.opts;
    const handshakeTimeout = this.opts.handshakeTimeoutMs ?? 15_000;
    let envelope = { senderId: identity.peerId, targetId: 'unknown', sessionId: 'unknown' };

    const reject = (reason: RejectReason) => {
      if (ws.readyState === ws.OPEN) {
        sendHandshake(ws, 'HELLO_REJECT', { reason }, envelope);
        ws.close(4403, reason);
      }
    };

    try {
      const helloFrame = await queue.next(handshakeTimeout);
      const hello = helloFrame.isBinary ? undefined : parseMessage(helloFrame.data.toString('utf8'));
      if (!hello || hello.type !== 'HELLO') throw new HandshakeError('protocol-error');
      envelope = { senderId: identity.peerId, targetId: hello.senderId, sessionId: hello.sessionId };
      if (hello.targetId !== identity.peerId) throw new HandshakeError('wrong-target');
      const claimed = remoteFromHello(hello.senderId, hello.payload, address);
      if (!claimed) throw new HandshakeError('auth-failed', 'peer id is not bound to its key');

      const nonce = createNonce();
      const ephemeral = createEphemeralKey();
      const transcript: HandshakeTranscript = {
        sessionId: hello.sessionId,
        initiator: {
          peerId: hello.senderId,
          publicKey: hello.payload.publicKey,
          nonce: hello.payload.nonce,
          ephemeralKey: hello.payload.ephemeralKey,
        },
        responder: { peerId: identity.peerId, publicKey: identity.publicKey, nonce, ephemeralKey: ephemeral.publicKey },
      };
      sendHandshake(
        ws,
        'HELLO_ACK',
        {
          ...buildHello(identity, this.opts.getProfile(), nonce, ephemeral.publicKey),
          signature: sign(identity, transcriptBytes('responder', transcript)),
        },
        envelope,
      );

      const authFrame = await queue.next(handshakeTimeout);
      const auth = authFrame.isBinary ? undefined : parseMessage(authFrame.data.toString('utf8'));
      if (!auth || auth.type !== 'AUTH' || auth.sessionId !== hello.sessionId || auth.senderId !== hello.senderId) {
        throw new HandshakeError('protocol-error');
      }
      if (!verify(claimed.publicKey, transcriptBytes('initiator', transcript), auth.payload.signature)) {
        throw new HandshakeError('auth-failed', 'bad initiator signature');
      }
      const codec = createSessionCodec(this.opts.codecFactory, {
        role: 'responder',
        ephemeral,
        remoteEphemeralKey: hello.payload.ephemeralKey,
        transcript,
      });

      const intent = copyIntent(hello.payload.intent);
      const decision = await this.decide(ws, claimed, intent);
      if (!decision.accept) throw new HandshakeError(decision.reason);

      const conn = new PeerConnection({
        ws,
        codec,
        localPeerId: identity.peerId,
        remote: claimed,
        sessionId: hello.sessionId,
        direction: 'inbound',
        intent,
        pendingFrames: queue.detach(),
        log,
      });
      conn.sendSession('WELCOME', {});
      log.info(`Accepted ${claimed.name} (${claimed.peerId}) from ${address}`);
      this.emit('connection', conn);
    } catch (err) {
      queue.detach();
      if (err instanceof HandshakeError) {
        log.info(`Rejected connection from ${address}: ${err.message}`);
        if (err.reason !== 'unreachable' && err.reason !== 'cancelled') reject(err.reason);
      } else {
        log.debug(`Handshake with ${address} ended: ${(err as Error).message}`);
        reject('timeout');
      }
      if (ws.readyState !== ws.CLOSED) setTimeout(() => ws.terminate(), 1000).unref();
    }
  }

  /** Runs `authorize`, giving up if the remote hangs up or the user takes too long. */
  private async decide(
    ws: WebSocket,
    peer: RemotePeer,
    intent: ConnectIntent | undefined,
  ): Promise<AuthorizeDecision> {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    ws.once('close', onClose);
    const timer = setTimeout(() => controller.abort(), this.opts.approvalTimeoutMs ?? 120_000);
    try {
      const aborted = new Promise<AuthorizeDecision>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve({ accept: false, reason: 'timeout' })),
      );
      return await Promise.race([this.opts.authorize(peer, intent, controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
      ws.off('close', onClose);
    }
  }
}
