import { describe, expect, it } from 'vitest';
import { createEphemeralKey, createNonce } from '../src/security/handshake';
import { generateIdentity } from '../src/security/identity';
import { createMessage, parseChatPayload, parseMessage } from '../src/signaling/protocolTypes';

const envelope = { senderId: 'p-0011223344556677', targetId: 'p-8899aabbccddeeff', sessionId: 'session-1' };

function hello() {
  return {
    name: 'Alice',
    workspace: 'beaconbob-core',
    appVersion: '0.1.0',
    publicKey: generateIdentity().publicKey,
    nonce: createNonce(),
    ephemeralKey: createEphemeralKey().publicKey,
  };
}

describe('parseMessage', () => {
  it('round-trips every session message type', () => {
    const msgs = [
      createMessage('HELLO', hello(), envelope),
      createMessage('HELLO_ACK', { ...hello(), signature: 'c2ln' }, envelope),
      createMessage('HELLO_REJECT', { reason: 'declined' }, envelope),
      createMessage('AUTH', { signature: 'c2ln' }, envelope),
      createMessage('WELCOME', {}, envelope),
      createMessage('CHANNEL', { channel: 'lanChat', data: { any: 'thing' } }, envelope),
      createMessage('PING', { ts: 1 }, envelope),
      createMessage('BYE', { reason: 'user' }, envelope),
    ];
    for (const msg of msgs) expect(parseMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it('rejects malformed frames', () => {
    const valid = createMessage('PING', { ts: 1 }, envelope);
    const bad: unknown[] = [
      'not json',
      null,
      [],
      { ...valid, version: '2.0' },
      { ...valid, type: 'OFFER' },
      { ...valid, type: 'NOPE' },
      { ...valid, senderId: '' },
      { ...valid, sessionId: 'x'.repeat(200) },
      { ...valid, payload: { ts: 'soon' } },
      createMessage('HELLO_REJECT', { reason: 'because' as never }, envelope),
      createMessage('CHANNEL', { channel: 'lanVideo' as never, data: 1 }, envelope),
      createMessage('HELLO', { ...hello(), publicKey: 'not base64!' }, envelope),
      createMessage('HELLO', { ...hello(), name: '' }, envelope),
    ];
    for (const raw of bad) {
      expect(parseMessage(typeof raw === 'string' ? raw : JSON.stringify(raw))).toBeUndefined();
    }
  });
});

describe('connect intent', () => {
  it('accepts join and invite intents on HELLO', () => {
    for (const intent of [
      { kind: 'join', groupId: 'g-0123456789ab' },
      { kind: 'invite', groupId: 'g-0123456789ab', groupName: 'design' },
    ] as const) {
      const msg = createMessage('HELLO', { ...hello(), intent }, envelope);
      expect(parseMessage(JSON.stringify(msg))?.payload).toMatchObject({ intent });
    }
  });

  it('rejects malformed intents', () => {
    for (const intent of [
      { kind: 'join', groupId: 'not-a-group' },
      { kind: 'invite', groupId: 'g-0123456789ab' },
      { kind: 'invite', groupId: 'g-0123456789ab', groupName: 'a|b' },
      { kind: 'invite', groupId: 'g-0123456789ab', groupName: 'x'.repeat(40) },
      { kind: 'kick', groupId: 'g-0123456789ab' },
    ]) {
      const msg = createMessage('HELLO', { ...hello(), intent: intent as never }, envelope);
      expect(parseMessage(JSON.stringify(msg))).toBeUndefined();
    }
  });
});

describe('group payloads', () => {
  const groupId = 'g-0123456789ab';
  const member = { peerId: 'p-0011223344556677', name: 'Alice', fingerprint: 'aaaa bbbb cccc dddd eeee ffff 0000 1111' };
  const relayed = { senderId: member.peerId, senderName: 'Alice', messageId: 'm1', content: 'hi', timestamp: 1 };

  it('accepts every group kind', () => {
    const valid = [
      { kind: 'TEXT', groupId, messageId: 'm1', content: 'hi', timestamp: 1 },
      { kind: 'TYPING_STATUS', groupId, isTyping: true },
      { kind: 'GROUP_RELAY', groupId, ...relayed },
      { kind: 'GROUP_TYPING', groupId, senderId: member.peerId, senderName: 'Alice', isTyping: false },
      { kind: 'GROUP_STATE', groupId, name: 'frontend', visibility: 'public', hostId: member.peerId, members: [member] },
      { kind: 'GROUP_HISTORY', groupId, messages: [relayed] },
      { kind: 'GROUP_JOIN_REQUEST', groupId },
      { kind: 'GROUP_INVITE', groupId, groupName: 'frontend' },
      { kind: 'GROUP_INVITE_RESPONSE', groupId, accept: true },
      { kind: 'GROUP_LEAVE', groupId },
      { kind: 'GROUP_REMOVED', groupId, reason: 'closed' },
    ];
    for (const payload of valid) expect(parseChatPayload(payload)).toEqual(payload);
  });

  it('rejects malformed group payloads', () => {
    const invalid = [
      { kind: 'TEXT', groupId: 'g-nope', messageId: 'm1', content: 'hi', timestamp: 1 },
      { kind: 'GROUP_RELAY', groupId, ...relayed, senderId: 'someone' },
      { kind: 'GROUP_STATE', groupId, name: 'frontend', visibility: 'secret', hostId: member.peerId, members: [member] },
      { kind: 'GROUP_STATE', groupId, name: 'frontend', visibility: 'public', hostId: member.peerId, members: [{ ...member, fingerprint: 'x' }] },
      {
        kind: 'GROUP_STATE',
        groupId,
        name: 'frontend',
        visibility: 'public',
        hostId: member.peerId,
        members: Array.from({ length: 33 }, () => member),
      },
      { kind: 'GROUP_HISTORY', groupId, messages: Array.from({ length: 51 }, () => relayed) },
      { kind: 'GROUP_INVITE_RESPONSE', groupId, accept: 'yes' },
      { kind: 'GROUP_REMOVED', groupId, reason: 'banished' },
    ];
    for (const payload of invalid) expect(parseChatPayload(payload)).toBeUndefined();
  });
});

describe('parseChatPayload', () => {
  it('accepts TEXT and TYPING_STATUS', () => {
    expect(parseChatPayload({ kind: 'TEXT', messageId: 'm1', content: 'hi', timestamp: 5 })).toEqual({
      kind: 'TEXT',
      messageId: 'm1',
      content: 'hi',
      timestamp: 5,
    });
    expect(parseChatPayload({ kind: 'TYPING_STATUS', isTyping: true })).toEqual({
      kind: 'TYPING_STATUS',
      isTyping: true,
    });
  });

  it('strips unknown fields and rejects bad payloads', () => {
    expect(
      parseChatPayload({ kind: 'TEXT', messageId: 'm1', content: 'hi', timestamp: 5, html: '<b>' }),
    ).not.toHaveProperty('html');
    expect(parseChatPayload({ kind: 'TEXT', messageId: 'm1', content: '', timestamp: 5 })).toBeUndefined();
    expect(parseChatPayload({ kind: 'TEXT', messageId: 'm1', content: 'x'.repeat(9000), timestamp: 5 })).toBeUndefined();
    expect(parseChatPayload({ kind: 'TYPING_STATUS', isTyping: 'yes' })).toBeUndefined();
    expect(parseChatPayload({ kind: 'FILE_CHUNK', fileId: 'f', chunkIndex: 0, base64Data: '' })).toBeUndefined();
    expect(parseChatPayload('TEXT')).toBeUndefined();
  });
});
