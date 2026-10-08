import { describe, expect, it } from 'vitest';
import { deriveSessionKeys, encryptedCodec, FrameCipher } from '../src/security/frameCipher';
import { createEphemeralKey, createNonce, type HandshakeTranscript } from '../src/security/handshake';
import { generateIdentity } from '../src/security/identity';
import type { SessionKeyParams } from '../src/signaling/handshakeCommon';

function session() {
  const initiatorId = generateIdentity();
  const responderId = generateIdentity();
  const initiatorEph = createEphemeralKey();
  const responderEph = createEphemeralKey();
  const transcript: HandshakeTranscript = {
    sessionId: 's1',
    initiator: { peerId: initiatorId.peerId, publicKey: initiatorId.publicKey, nonce: createNonce(), ephemeralKey: initiatorEph.publicKey },
    responder: { peerId: responderId.peerId, publicKey: responderId.publicKey, nonce: createNonce(), ephemeralKey: responderEph.publicKey },
  };
  const initiator: SessionKeyParams = { role: 'initiator', ephemeral: initiatorEph, remoteEphemeralKey: responderEph.publicKey, transcript };
  const responder: SessionKeyParams = { role: 'responder', ephemeral: responderEph, remoteEphemeralKey: initiatorEph.publicKey, transcript };
  return { initiator, responder, transcript };
}

const binary = (data: Buffer) => ({ data, isBinary: true });

describe('frame encryption', () => {
  it('both sides derive mirrored keys', () => {
    const { initiator, responder } = session();
    const a = deriveSessionKeys(initiator);
    const b = deriveSessionKeys(responder);
    expect(a.sendKey.equals(b.recvKey)).toBe(true);
    expect(a.recvKey.equals(b.sendKey)).toBe(true);
    expect(a.sendKey.equals(a.recvKey)).toBe(false);
  });

  it('round-trips in both directions and hides the plaintext', () => {
    const { initiator, responder } = session();
    const a = encryptedCodec(initiator);
    const b = encryptedCodec(responder);
    for (const text of ['hello', '{"type":"PING"}', 'ünïcødé ✓', '']) {
      const frame = a.encode(text) as Buffer;
      expect(frame.includes(Buffer.from('hello'))).toBe(false);
      expect(b.decode(binary(frame))).toBe(text);
      expect(a.decode(binary(b.encode(text) as Buffer))).toBe(text);
    }
  });

  it('encrypts identical messages differently each time', () => {
    const { initiator } = session();
    const a = encryptedCodec(initiator);
    expect((a.encode('same') as Buffer).equals(a.encode('same') as Buffer)).toBe(false);
  });

  it('rejects tampered, replayed, reordered, and unencrypted frames', () => {
    const { initiator, responder } = session();
    const sender = encryptedCodec(initiator);

    const tampered = sender.encode('one') as Buffer;
    tampered[0] ^= 0x01;
    expect(() => encryptedCodec(responder).decode(binary(tampered))).toThrow();

    const replaySender = encryptedCodec(initiator);
    const replayReceiver = encryptedCodec(responder);
    const first = replaySender.encode('first') as Buffer;
    expect(replayReceiver.decode(binary(first))).toBe('first');
    expect(() => replayReceiver.decode(binary(first))).toThrow();

    const orderSender = encryptedCodec(initiator);
    const orderReceiver = encryptedCodec(responder);
    orderSender.encode('skipped');
    expect(() => orderReceiver.decode(binary(orderSender.encode('second') as Buffer))).toThrow();

    expect(() => encryptedCodec(responder).decode({ data: Buffer.from('{"type":"PING"}'), isBinary: false })).toThrow(
      /Unencrypted/,
    );
  });

  it('a failed frame does not desynchronize the counter', () => {
    const { initiator, responder } = session();
    const sender = encryptedCodec(initiator);
    const receiver = encryptedCodec(responder);
    expect(() => receiver.decode(binary(Buffer.alloc(40)))).toThrow();
    expect(receiver.decode(binary(sender.encode('still fine') as Buffer))).toBe('still fine');
  });

  it('keys depend on the whole transcript', () => {
    const { initiator, responder } = session();
    const tamperedTranscript = { ...responder.transcript, sessionId: 's2' };
    const a = new FrameCipher(deriveSessionKeys(initiator));
    const b = new FrameCipher(deriveSessionKeys({ ...responder, transcript: tamperedTranscript }));
    expect(() => b.decode(binary(a.encode('hi')))).toThrow();
  });

  it('refuses a non-X25519 ephemeral key', () => {
    const { initiator } = session();
    expect(() => deriveSessionKeys({ ...initiator, remoteEphemeralKey: generateIdentity().publicKey })).toThrow(/X25519/);
  });
});
