import { describe, expect, it } from 'vitest';
import {
  ConversationStore,
  dmConversationId,
  groupConversationId,
  parseConversationId,
  type StoredMessage,
} from '../src/chat/conversationStore';
import { normalizeGroupName } from '../src/groups/groupTypes';
import { parseFromWebview } from '../src/ui/webviewMessages';
import { waitFor } from './helpers';

const msg = (id: string, overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  id,
  kind: 'text',
  senderId: 'p-0011223344556677',
  senderName: 'Bob',
  content: `message ${id}`,
  timestamp: Date.now(),
  fromSelf: false,
  ...overrides,
});

describe('ConversationStore', () => {
  it('counts unread messages except in the open conversation', () => {
    const store = new ConversationStore();
    const a = dmConversationId('p-a');
    const b = groupConversationId('g-0123456789ab');
    store.append(a, msg('1'));
    store.append(a, msg('2'));
    store.append(a, msg('3', { fromSelf: true }));
    store.system(a, 'Bob connected');
    expect(store.unread(a)).toBe(2);

    store.setActive(b);
    store.append(b, msg('4'));
    expect(store.unread(b)).toBe(0);

    store.setActive(a);
    expect(store.unread(a)).toBe(0);
    expect(store.activeId).toBe(a);
  });

  it('de-duplicates by sender and message id and caps history', () => {
    const store = new ConversationStore({ historyLimit: 3 });
    const id = dmConversationId('p-a');
    expect(store.append(id, msg('1'))).toBe(true);
    expect(store.append(id, msg('1'))).toBe(false);
    expect(store.append(id, msg('1', { senderId: 'p-other0000000000' }))).toBe(true);
    for (const n of ['2', '3', '4']) store.append(id, msg(n));
    expect(store.messages(id).map((m) => m.id)).toEqual(['2', '3', '4']);
    expect(store.recentText(id, 2).map((m) => m.id)).toEqual(['3', '4']);
  });

  it('typing expires, clears on a message, and clears per peer everywhere', async () => {
    const store = new ConversationStore({ typingTimeoutMs: 100 });
    const a = dmConversationId('p-a');
    const g = groupConversationId('g-0123456789ab');
    store.ensure(a);
    store.ensure(g);
    store.setTyping(a, 'p-bob', 'Bob', true);
    expect(store.typingNames(a)).toEqual(['Bob']);
    await waitFor(() => store.typingNames(a).length === 0, 1000);

    store.setTyping(a, 'p-bob', 'Bob', true);
    store.append(a, msg('1', { senderId: 'p-bob' }));
    expect(store.typingNames(a)).toEqual([]);

    store.setTyping(a, 'p-bob', 'Bob', true);
    store.setTyping(g, 'p-bob', 'Bob', true);
    store.clearTyping('p-bob');
    expect(store.typingNames(a)).toEqual([]);
    expect(store.typingNames(g)).toEqual([]);
    store.dispose();
  });

  it('forgets the active conversation when it is deleted', () => {
    const store = new ConversationStore();
    const id = groupConversationId('g-0123456789ab');
    store.ensure(id);
    store.setActive(id);
    store.delete(id);
    expect(store.activeId).toBeUndefined();
    expect(store.has(id)).toBe(false);
  });

  it('parses conversation ids', () => {
    expect(parseConversationId('dm:p-1')).toEqual({ kind: 'dm', key: 'p-1' });
    expect(parseConversationId('group:g-1')).toEqual({ kind: 'group', key: 'g-1' });
    for (const bad of ['dm:', 'chat:x', 'nocolon', '']) expect(parseConversationId(bad)).toBeUndefined();
  });
});

describe('normalizeGroupName', () => {
  it.each([
    ['#frontend', 'frontend'],
    ['  design   team ', 'design team'],
    ['a|b', 'a b'],
    ['x'.repeat(50), 'x'.repeat(32)],
  ])('%s -> %s', (raw, expected) => expect(normalizeGroupName(raw)).toBe(expected));

  it.each(['', '   ', '###', '|'])('rejects %j', (raw) => expect(normalizeGroupName(raw)).toBeUndefined());
});

describe('parseFromWebview', () => {
  it('accepts well-formed messages', () => {
    const ok = [
      { type: 'ready' },
      { type: 'closeConversation' },
      { type: 'openConversation', id: 'dm:p-1' },
      { type: 'sendMessage', conversationId: 'group:g-1', content: 'hi' },
      { type: 'typing', conversationId: 'dm:p-1', isTyping: true },
      { type: 'createGroup', name: 'frontend', visibility: 'private' },
      { type: 'joinGroup', hostId: 'p-1', groupId: 'g-1' },
      { type: 'respondJoinRequest', groupId: 'g-1', peerId: 'p-2', accept: false },
      { type: 'removeMember', groupId: 'g-1', peerId: 'p-2' },
    ];
    for (const m of ok) expect(parseFromWebview(m)).toEqual(m);
  });

  it('rejects malformed messages and drops extra fields', () => {
    expect(parseFromWebview({ type: 'createGroup', name: 'x', visibility: 'secret' })).toBeUndefined();
    expect(parseFromWebview({ type: 'sendMessage', conversationId: 'dm:p-1', content: '' })).toBeUndefined();
    expect(parseFromWebview({ type: 'typing', conversationId: 'dm:p-1' })).toBeUndefined();
    expect(parseFromWebview({ type: 'sendChat', content: 'old api' })).toBeUndefined();
    expect(parseFromWebview(null)).toBeUndefined();
    expect(parseFromWebview({ type: 'leaveGroup', groupId: 'g-1', evil: true })).toEqual({ type: 'leaveGroup', groupId: 'g-1' });
  });
});
