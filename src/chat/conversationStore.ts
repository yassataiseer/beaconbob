import { Emitter } from '../util/events';

export type ConversationId = `dm:${string}` | `group:${string}`;

export const dmConversationId = (peerId: string): ConversationId => `dm:${peerId}`;
export const groupConversationId = (groupId: string): ConversationId => `group:${groupId}`;

export function parseConversationId(id: string): { kind: 'dm' | 'group'; key: string } | undefined {
  const sep = id.indexOf(':');
  const kind = id.slice(0, sep);
  const key = id.slice(sep + 1);
  if (sep === -1 || !key || (kind !== 'dm' && kind !== 'group')) return undefined;
  return { kind, key };
}

export interface StoredMessage {
  id: string;
  kind: 'text' | 'system';
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
  fromSelf: boolean;
}

interface Conversation {
  messages: StoredMessage[];
  seen: Set<string>;
  unread: number;
  typing: Map<string, { name: string; timer: NodeJS.Timeout }>;
  lastActivity: number;
}

export interface ConversationStoreOptions {
  historyLimit?: number;
  typingTimeoutMs?: number;
}

type StoreEvents = { changed: [ConversationId] };

/** Message history, unread counts, and typing state for every DM and group conversation. */
export class ConversationStore extends Emitter<StoreEvents> {
  private readonly conversations = new Map<ConversationId, Conversation>();
  private readonly historyLimit: number;
  private readonly typingTimeoutMs: number;
  private active: ConversationId | undefined;

  constructor(opts: ConversationStoreOptions = {}) {
    super();
    this.historyLimit = opts.historyLimit ?? 500;
    this.typingTimeoutMs = opts.typingTimeoutMs ?? 6000;
  }

  has(id: ConversationId): boolean {
    return this.conversations.has(id);
  }

  ids(): ConversationId[] {
    return [...this.conversations.keys()];
  }

  ensure(id: ConversationId): void {
    if (this.conversations.has(id)) return;
    this.conversations.set(id, { messages: [], seen: new Set(), unread: 0, typing: new Map(), lastActivity: Date.now() });
    this.emit('changed', id);
  }

  delete(id: ConversationId): void {
    const conv = this.conversations.get(id);
    if (!conv) return;
    for (const { timer } of conv.typing.values()) clearTimeout(timer);
    this.conversations.delete(id);
    if (this.active === id) this.active = undefined;
    this.emit('changed', id);
  }

  /** Adds a message unless one with the same sender and id is already stored. */
  append(id: ConversationId, message: StoredMessage): boolean {
    this.ensure(id);
    const conv = this.conversations.get(id)!;
    const key = `${message.senderId}:${message.id}`;
    if (conv.seen.has(key)) return false;
    conv.seen.add(key);
    conv.messages.push(message);
    while (conv.messages.length > this.historyLimit) {
      const dropped = conv.messages.shift()!;
      conv.seen.delete(`${dropped.senderId}:${dropped.id}`);
    }
    conv.lastActivity = Math.max(conv.lastActivity, Date.now());
    if (message.kind === 'text' && !message.fromSelf) {
      if (conv.typing.has(message.senderId)) this.clearTypingIn(conv, message.senderId);
      if (this.active !== id) conv.unread++;
    }
    this.emit('changed', id);
    return true;
  }

  system(id: ConversationId, content: string): void {
    this.append(id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: 'system',
      senderId: '',
      senderName: '',
      content,
      timestamp: Date.now(),
      fromSelf: false,
    });
  }

  messages(id: ConversationId): readonly StoredMessage[] {
    return this.conversations.get(id)?.messages ?? [];
  }

  /** The most recent text messages, oldest first. */
  recentText(id: ConversationId, limit: number): StoredMessage[] {
    return this.messages(id).filter((m) => m.kind === 'text').slice(-limit);
  }

  unread(id: ConversationId): number {
    return this.conversations.get(id)?.unread ?? 0;
  }

  lastActivity(id: ConversationId): number {
    return this.conversations.get(id)?.lastActivity ?? 0;
  }

  /** The conversation the user is looking at never accumulates unread messages. */
  setActive(id: ConversationId | undefined): void {
    this.active = id;
    const conv = id && this.conversations.get(id);
    if (conv && conv.unread > 0) {
      conv.unread = 0;
      this.emit('changed', id);
    }
  }

  get activeId(): ConversationId | undefined {
    return this.active && this.conversations.has(this.active) ? this.active : undefined;
  }

  setTyping(id: ConversationId, peerId: string, name: string, isTyping: boolean): void {
    const conv = this.conversations.get(id);
    if (!conv) return;
    if (!isTyping) {
      if (this.clearTypingIn(conv, peerId)) this.emit('changed', id);
      return;
    }
    const existing = conv.typing.get(peerId);
    if (existing) clearTimeout(existing.timer);
    // Typing expires on its own in case the "stopped typing" frame never arrives.
    const timer = setTimeout(() => {
      if (this.clearTypingIn(conv, peerId)) this.emit('changed', id);
    }, this.typingTimeoutMs);
    timer.unref?.();
    conv.typing.set(peerId, { name, timer });
    if (!existing) this.emit('changed', id);
  }

  typingNames(id: ConversationId): string[] {
    return [...(this.conversations.get(id)?.typing.values() ?? [])].map((t) => t.name);
  }

  /** Clears `peerId`'s typing indicator everywhere (for example after they disconnect). */
  clearTyping(peerId: string): void {
    for (const [id, conv] of this.conversations) {
      if (this.clearTypingIn(conv, peerId)) this.emit('changed', id);
    }
  }

  dispose(): void {
    for (const conv of this.conversations.values()) {
      for (const { timer } of conv.typing.values()) clearTimeout(timer);
    }
    this.conversations.clear();
    this.removeAllListeners();
  }

  private clearTypingIn(conv: Conversation, peerId: string): boolean {
    const entry = conv.typing.get(peerId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    conv.typing.delete(peerId);
    return true;
  }
}
