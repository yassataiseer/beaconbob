import { randomUUID } from 'node:crypto';
import { type ChatPayload, MAX_CHAT_LENGTH, parseChatPayload } from '../signaling/protocolTypes';
import type { RemotePeer } from '../transport/peerConnection';
import type { PeerManager } from '../transport/peerManager';
import { type ConversationStore, dmConversationId } from './conversationStore';

export interface ChatServiceOptions {
  peers: PeerManager;
  store: ConversationStore;
  selfId: string;
  getSelfName: () => string;
}

/** 1:1 direct messages over `lanChat` with a directly connected peer. */
export class ChatService {
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly opts: ChatServiceOptions) {
    const { peers, store } = opts;
    this.disposers.push(
      peers.on('channel', (peer, channel, data) => {
        if (channel === 'lanChat') this.onPayload(peer, data);
      }),
      peers.on('connected', (peer) => {
        const id = dmConversationId(peer.peerId);
        if (store.has(id)) store.system(id, `${peer.name} connected`);
      }),
      peers.on('disconnected', (peer) => {
        store.clearTyping(peer.peerId);
        const id = dmConversationId(peer.peerId);
        if (store.has(id)) store.system(id, `${peer.name} disconnected`);
      }),
    );
  }

  /** Opens (or creates) the DM conversation with a connected peer. */
  open(peerId: string): boolean {
    if (!this.opts.peers.isConnected(peerId)) return false;
    this.opts.store.ensure(dmConversationId(peerId));
    return true;
  }

  /** Returns false if the peer is not connected, so the message could not be delivered. */
  send(peerId: string, content: string): boolean {
    const text = content.trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return false;
    const payload: ChatPayload = { kind: 'TEXT', messageId: randomUUID(), content: text, timestamp: Date.now() };
    if (!this.opts.peers.send(peerId, 'lanChat', payload)) return false;
    this.opts.store.append(dmConversationId(peerId), {
      id: payload.messageId,
      kind: 'text',
      senderId: this.opts.selfId,
      senderName: this.opts.getSelfName(),
      content: text,
      timestamp: payload.timestamp,
      fromSelf: true,
    });
    return true;
  }

  setTyping(peerId: string, isTyping: boolean): void {
    this.opts.peers.send(peerId, 'lanChat', { kind: 'TYPING_STATUS', isTyping } satisfies ChatPayload);
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
  }

  private onPayload(peer: RemotePeer, data: unknown): void {
    const payload = parseChatPayload(data);
    if (!payload) return;
    const id = dmConversationId(peer.peerId);
    if (payload.kind === 'TEXT' && !payload.groupId) {
      this.opts.store.append(id, {
        id: payload.messageId,
        kind: 'text',
        senderId: peer.peerId,
        senderName: peer.name,
        content: payload.content,
        timestamp: payload.timestamp,
        fromSelf: false,
      });
    } else if (payload.kind === 'TYPING_STATUS' && !payload.groupId) {
      this.opts.store.setTyping(id, peer.peerId, peer.name, payload.isTyping);
    }
  }
}
