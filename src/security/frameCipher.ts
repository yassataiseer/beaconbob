import * as crypto from 'node:crypto';
import type { SessionKeyParams } from '../signaling/handshakeCommon';
import type { Frame, FrameCodec } from '../transport/frames';
import { transcriptBytes } from './handshake';

const KEY_BYTES = 32;
const TAG_BYTES = 16;
const AAD = Buffer.from('beaconbob-frame-v1');

export interface SessionKeys {
  sendKey: Buffer;
  recvKey: Buffer;
}

/**
 * X25519 shared secret from the two ephemeral keys, expanded with HKDF-SHA256 into one key per
 * direction. The salt is a hash of the signed handshake transcript, so tampering with any
 * handshake field leaves the two sides with different keys.
 */
export function deriveSessionKeys(params: SessionKeyParams): SessionKeys {
  const remote = crypto.createPublicKey({
    key: Buffer.from(params.remoteEphemeralKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (remote.asymmetricKeyType !== 'x25519') throw new Error('Ephemeral key is not X25519');
  const shared = crypto.diffieHellman({ privateKey: params.ephemeral.privateKey, publicKey: remote });
  if (shared.every((b) => b === 0)) throw new Error('Degenerate X25519 shared secret');

  const salt = crypto.createHash('sha256').update(transcriptBytes('initiator', params.transcript)).digest();
  const expand = (info: string) => Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, KEY_BYTES));
  const initiatorToResponder = expand('beaconbob-v1 initiator->responder');
  const responderToInitiator = expand('beaconbob-v1 responder->initiator');
  return params.role === 'initiator'
    ? { sendKey: initiatorToResponder, recvKey: responderToInitiator }
    : { sendKey: responderToInitiator, recvKey: initiatorToResponder };
}

function nonceFor(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

/**
 * AES-256-GCM over binary WebSocket frames. Nonces are implicit per-direction counters: TCP
 * keeps frames in order, so any replayed, dropped, or reordered frame fails authentication.
 * Text (unencrypted) frames are rejected outright.
 */
export class FrameCipher implements FrameCodec {
  private sendCounter = 0n;
  private recvCounter = 0n;

  constructor(private readonly keys: SessionKeys) {}

  encode(text: string): Buffer {
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keys.sendKey, nonceFor(this.sendCounter++));
    cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]);
  }

  decode(frame: Frame): string {
    if (!frame.isBinary) throw new Error('Unencrypted frame rejected');
    if (frame.data.length < TAG_BYTES) throw new Error('Frame too short');
    const body = frame.data.subarray(0, frame.data.length - TAG_BYTES);
    const tag = frame.data.subarray(frame.data.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.keys.recvKey, nonceFor(this.recvCounter));
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    // final() throws if authentication fails; only then is the counter advanced.
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    this.recvCounter++;
    return plain.toString('utf8');
  }
}

export const encryptedCodec = (params: SessionKeyParams): FrameCodec => new FrameCipher(deriveSessionKeys(params));
