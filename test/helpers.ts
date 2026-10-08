import { ChatService } from '../src/chat/chatService';
import { ConversationStore } from '../src/chat/conversationStore';
import { PeerRegistry } from '../src/discovery/peerRegistry';
import { GroupHost } from '../src/groups/groupHost';
import { GroupMember } from '../src/groups/groupMember';
import { generateIdentity, type Identity } from '../src/security/identity';
import type { CodecFactory } from '../src/signaling/handshakeCommon';
import type { ConnectIntent } from '../src/signaling/protocolTypes';
import { SignalServer } from '../src/signaling/signalServer';
import type { RemotePeer } from '../src/transport/peerConnection';
import { PeerManager } from '../src/transport/peerManager';
import { nullLog } from '../src/util/logger';

export interface TestNode {
  name: string;
  identity: Identity;
  registry: PeerRegistry;
  peers: PeerManager;
  server: SignalServer;
  store: ConversationStore;
  chat: ChatService;
  host: GroupHost;
  member: GroupMember;
  port: number;
  prompts: Array<{ peer: RemotePeer; intent: ConnectIntent | undefined }>;
  /** What the simulated user answers when asked to approve a connection. */
  answer: (peer: RemotePeer, intent: ConnectIntent | undefined) => Promise<boolean>;
  stop(): Promise<void>;
}

let nextPort = 46100;

export async function startNode(name: string, codecFactory?: CodecFactory, identity = generateIdentity()): Promise<TestNode> {
  const registry = new PeerRegistry();
  const profile = () => ({ name, workspace: `${name}-ws`, appVersion: '0.1.0' });
  const node = { name, identity, registry, prompts: [] } as unknown as TestNode;
  node.answer = async () => true;

  node.peers = new PeerManager({
    identity,
    getProfile: profile,
    registry,
    log: nullLog,
    codecFactory,
    promptApproval: (peer, intent) => {
      node.prompts.push({ peer, intent });
      return node.answer(peer, intent);
    },
    screenIntent: (peer, intent) => (intent.kind === 'join' ? node.host.screenJoin(peer, intent) : 'prompt'),
  });
  node.store = new ConversationStore({ typingTimeoutMs: 300 });
  const deps = { peers: node.peers, store: node.store, identity, getSelfName: () => name, log: nullLog };
  node.host = new GroupHost(deps);
  node.member = new GroupMember(deps);
  node.chat = new ChatService({ peers: node.peers, store: node.store, selfId: identity.peerId, getSelfName: () => name });
  node.server = new SignalServer({ identity, getProfile: profile, authorize: node.peers.authorize, log: nullLog, codecFactory });
  node.server.on('connection', (conn) => node.peers.adopt(conn));
  const base = nextPort;
  nextPort += 10;
  node.port = await node.server.start({ min: base, max: base + 9 }, '127.0.0.1');
  node.stop = async () => {
    node.host.dispose();
    node.member.dispose();
    node.chat.dispose();
    node.peers.dispose();
    node.store.dispose();
    await node.server.stop();
  };
  return node;
}

/** Makes `other` visible in `node`'s registry, as mDNS would. */
export function discover(node: TestNode, other: TestNode, overrides: { fingerprint?: string } = {}): void {
  node.registry.upsert({
    peerId: other.identity.peerId,
    name: other.name,
    workspace: `${other.name}-ws`,
    fingerprint: overrides.fingerprint ?? other.identity.fingerprint,
    version: '1.0.0',
    status: 'available',
    publicGroups: other.host.publicGroups(),
    addresses: ['127.0.0.1'],
    port: other.port,
  });
}

export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
