import * as crypto from 'node:crypto';

export interface HandshakeSide {
  peerId: string;
  publicKey: string;
  nonce: string;
  ephemeralKey: string;
}

export interface HandshakeTranscript {
  sessionId: string;
  initiator: HandshakeSide;
  responder: HandshakeSide;
}

export type HandshakeRole = 'initiator' | 'responder';

export function createNonce(): string {
  return crypto.randomBytes(32).toString('base64');
}

export interface EphemeralKeyPair {
  /** Base64 SPKI DER. */
  publicKey: string;
  privateKey: crypto.KeyObject;
}

export function createEphemeralKey(): EphemeralKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
}

/**
 * Bytes each side signs with its identity key. Both nonces bind the signature to this session
 * (no replay); both ephemeral keys bind the key exchange to the identities (no MITM); the role
 * label stops one side's signature from being reflected back as the other's.
 */
export function transcriptBytes(role: HandshakeRole, t: HandshakeTranscript): Buffer {
  const side = (s: HandshakeSide) => [s.peerId, s.publicKey, s.nonce, s.ephemeralKey];
  return Buffer.from(
    ['beaconbob-handshake-v1', role, t.sessionId, ...side(t.initiator), ...side(t.responder)].join('\n'),
    'utf8',
  );
}
