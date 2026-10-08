import type { WebSocket } from 'ws';
import { encryptedCodec } from '../security/frameCipher';
import type { EphemeralKeyPair, HandshakeRole, HandshakeTranscript } from '../security/handshake';
import { fingerprintFromPublicKey, type Identity, isValidPublicKey, peerIdMatchesKey } from '../security/identity';
import type { FrameCodec } from '../transport/frames';
import type { RemotePeer } from '../transport/peerConnection';
import {
  type ConnectIntent,
  createMessage,
  type Envelope,
  type HelloPayload,
  type PayloadOf,
  type ProtocolMessage,
  type RejectReason,
} from './protocolTypes';

export interface LocalProfile {
  name: string;
  workspace: string;
  appVersion: string;
}

export interface SessionKeyParams {
  role: HandshakeRole;
  ephemeral: EphemeralKeyPair;
  remoteEphemeralKey: string;
  transcript: HandshakeTranscript;
}

/** Builds the codec for frames after the handshake (plaintext or encrypted). */
export type CodecFactory = (params: SessionKeyParams) => FrameCodec;

export type HandshakeFailure = RejectReason | 'unreachable' | 'cancelled';

export class HandshakeError extends Error {
  constructor(
    readonly reason: HandshakeFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'HandshakeError';
  }
}

/** Defaults to the encrypted codec; a remote key that cannot be used is an auth failure. */
export function createSessionCodec(factory: CodecFactory | undefined, params: SessionKeyParams): FrameCodec {
  try {
    return (factory ?? encryptedCodec)(params);
  } catch (err) {
    throw new HandshakeError('auth-failed', `key exchange failed: ${(err as Error).message}`);
  }
}

export function buildHello(
  identity: Identity,
  profile: LocalProfile,
  nonce: string,
  ephemeralKey: string,
  intent?: ConnectIntent,
): HelloPayload {
  return {
    name: profile.name.slice(0, 64) || identity.peerId,
    workspace: profile.workspace.slice(0, 64),
    appVersion: profile.appVersion.slice(0, 16),
    publicKey: identity.publicKey,
    nonce,
    ephemeralKey,
    ...(intent ? { intent } : {}),
  };
}

/** Copies a validated intent so no extra wire fields ride along. */
export function copyIntent(intent: ConnectIntent | undefined): ConnectIntent | undefined {
  if (!intent) return undefined;
  return intent.kind === 'join'
    ? { kind: 'join', groupId: intent.groupId }
    : { kind: 'invite', groupId: intent.groupId, groupName: intent.groupName };
}

/** Returns the claimed remote identity if its peer id is bound to its key, else `undefined`. */
export function remoteFromHello(senderId: string, hello: HelloPayload, address: string): RemotePeer | undefined {
  if (!isValidPublicKey(hello.publicKey) || !peerIdMatchesKey(senderId, hello.publicKey)) return undefined;
  return {
    peerId: senderId,
    name: hello.name,
    workspace: hello.workspace,
    appVersion: hello.appVersion,
    publicKey: hello.publicKey,
    fingerprint: fingerprintFromPublicKey(hello.publicKey),
    address,
  };
}

export function sendHandshake<K extends ProtocolMessage['type']>(
  ws: WebSocket,
  type: K,
  payload: PayloadOf<K>,
  envelope: Envelope,
): void {
  ws.send(JSON.stringify(createMessage(type, payload, envelope)));
}
