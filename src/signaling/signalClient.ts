import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createEphemeralKey, createNonce, type HandshakeTranscript, transcriptBytes } from '../security/handshake';
import { type Identity, sign, verify } from '../security/identity';
import { FrameQueue, FrameQueueClosedError, FrameTimeoutError } from '../transport/frames';
import { PeerConnection } from '../transport/peerConnection';
import type { Log } from '../util/logger';
import { formatHostForUrl, rankDialAddresses } from '../util/network';
import {
  buildHello,
  type CodecFactory,
  createSessionCodec,
  HandshakeError,
  type LocalProfile,
  remoteFromHello,
  sendHandshake,
} from './handshakeCommon';
import { type ConnectIntent, MAX_FRAME_BYTES, parseMessage } from './protocolTypes';

export interface DialTarget {
  peerId: string;
  /** Fingerprint advertised over mDNS. The responder's proven key must match it. */
  fingerprint?: string;
  addresses: string[];
  port: number;
}

export interface DialOptions {
  identity: Identity;
  profile: LocalProfile;
  target: DialTarget;
  intent?: ConnectIntent;
  log: Log;
  signal?: AbortSignal;
  codecFactory?: CodecFactory;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** How long the remote user has to answer the approval prompt. */
  approvalTimeoutMs?: number;
}

function openSocket(url: string, timeoutMs: number, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    const onAbort = () => ws.terminate();
    signal?.addEventListener('abort', onAbort, { once: true });
    ws.once('open', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(ws);
    });
    ws.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

async function connectToAny(target: DialTarget, opts: DialOptions): Promise<{ ws: WebSocket; address: string }> {
  const errors: string[] = [];
  for (const address of rankDialAddresses(target.addresses)) {
    if (opts.signal?.aborted) break;
    const url = `ws://${formatHostForUrl(address)}:${target.port}`;
    try {
      const ws = await openSocket(url, opts.connectTimeoutMs ?? 4000, opts.signal);
      return { ws, address };
    } catch (err) {
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }
  if (opts.signal?.aborted) throw new HandshakeError('cancelled');
  throw new HandshakeError('unreachable', `Could not reach peer (${errors.join('; ') || 'no LAN addresses'})`);
}

/**
 * Initiator side of the handshake. Resolves with an authenticated connection once the remote
 * user accepts, or rejects with a `HandshakeError` describing why not.
 */
export async function dial(opts: DialOptions): Promise<PeerConnection> {
  const { identity, target, log } = opts;
  const { ws, address } = await connectToAny(target, opts);
  ws.on('error', (err) => log.debug(`Dial socket error to ${address}: ${err.message}`));
  const queue = new FrameQueue(ws);
  const onAbort = () => ws.terminate();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const envelope = { senderId: identity.peerId, targetId: target.peerId, sessionId: randomUUID() };
  const handshakeTimeout = opts.handshakeTimeoutMs ?? 15_000;

  const readHandshake = async (timeoutMs: number) => {
    const frame = await queue.next(timeoutMs);
    return { frame, msg: frame.isBinary ? undefined : parseMessage(frame.data.toString('utf8')) };
  };

  try {
    const nonce = createNonce();
    const ephemeral = createEphemeralKey();
    sendHandshake(
      ws,
      'HELLO',
      buildHello(identity, opts.profile, nonce, ephemeral.publicKey, opts.intent),
      envelope,
    );

    const { msg: ack } = await readHandshake(handshakeTimeout);
    if (ack?.type === 'HELLO_REJECT') throw new HandshakeError(ack.payload.reason);
    if (!ack || ack.type !== 'HELLO_ACK' || ack.sessionId !== envelope.sessionId || ack.targetId !== identity.peerId) {
      throw new HandshakeError('protocol-error');
    }
    if (ack.senderId !== target.peerId) throw new HandshakeError('wrong-target');
    const remote = remoteFromHello(ack.senderId, ack.payload, address);
    if (!remote) throw new HandshakeError('auth-failed', 'peer id is not bound to its key');
    if (target.fingerprint && remote.fingerprint !== target.fingerprint) {
      throw new HandshakeError('auth-failed', 'key does not match the advertised fingerprint');
    }

    const transcript: HandshakeTranscript = {
      sessionId: envelope.sessionId,
      initiator: { peerId: identity.peerId, publicKey: identity.publicKey, nonce, ephemeralKey: ephemeral.publicKey },
      responder: {
        peerId: ack.senderId,
        publicKey: ack.payload.publicKey,
        nonce: ack.payload.nonce,
        ephemeralKey: ack.payload.ephemeralKey,
      },
    };
    if (!verify(remote.publicKey, transcriptBytes('responder', transcript), ack.payload.signature)) {
      throw new HandshakeError('auth-failed', 'bad responder signature');
    }
    const codec = createSessionCodec(opts.codecFactory, {
      role: 'initiator',
      ephemeral,
      remoteEphemeralKey: ack.payload.ephemeralKey,
      transcript,
    });
    sendHandshake(ws, 'AUTH', { signature: sign(identity, transcriptBytes('initiator', transcript)) }, envelope);

    const { frame, msg: verdict } = await readHandshake(opts.approvalTimeoutMs ?? 125_000);
    if (verdict?.type === 'HELLO_REJECT') throw new HandshakeError(verdict.payload.reason);
    let welcome;
    try {
      welcome = parseMessage(codec.decode(frame));
    } catch {
      welcome = undefined;
    }
    if (
      !welcome ||
      welcome.type !== 'WELCOME' ||
      welcome.sessionId !== envelope.sessionId ||
      welcome.senderId !== remote.peerId
    ) {
      throw new HandshakeError('protocol-error');
    }

    opts.signal?.removeEventListener('abort', onAbort);
    log.info(`Connected to ${remote.name} (${remote.peerId}) at ${address}`);
    return new PeerConnection({
      ws,
      codec,
      localPeerId: identity.peerId,
      remote,
      sessionId: envelope.sessionId,
      direction: 'outbound',
      intent: opts.intent,
      pendingFrames: queue.detach(),
      log,
    });
  } catch (err) {
    queue.detach();
    opts.signal?.removeEventListener('abort', onAbort);
    ws.terminate();
    if (opts.signal?.aborted) throw new HandshakeError('cancelled');
    if (err instanceof HandshakeError) throw err;
    if (err instanceof FrameTimeoutError) throw new HandshakeError('timeout');
    if (err instanceof FrameQueueClosedError) throw new HandshakeError('unreachable', 'Peer closed the connection');
    throw err;
  }
}
