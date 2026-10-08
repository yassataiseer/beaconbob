import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { dmConversationId } from '../src/chat/conversationStore';
import { encryptedCodec } from '../src/security/frameCipher';
import { createEphemeralKey, createNonce } from '../src/security/handshake';
import { generateIdentity } from '../src/security/identity';
import { type CodecFactory, HandshakeError } from '../src/signaling/handshakeCommon';
import { createMessage, parseMessage } from '../src/signaling/protocolTypes';
import { delay, discover, startNode, type TestNode, waitFor } from './helpers';

const nodes: TestNode[] = [];
async function node(name: string) {
  const n = await startNode(name);
  nodes.push(n);
  return n;
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.stop()));
});

/** Messages in `node`'s direct conversation with `other`. */
function dm(node: TestNode, other: TestNode) {
  return node.store.messages(dmConversationId(other.identity.peerId));
}

async function connectPair() {
  const alice = await node('Alice');
  const bob = await node('Bob');
  discover(alice, bob);
  discover(bob, alice);
  await alice.peers.connect(bob.identity.peerId);
  await waitFor(() => bob.peers.stateOf(alice.identity.peerId) === 'connected');
  return { alice, bob };
}

describe('connection handshake', () => {
  it('connects after the remote user approves, showing them the proven fingerprint', async () => {
    const { alice, bob } = await connectPair();
    expect(alice.peers.stateOf(bob.identity.peerId)).toBe('connected');
    expect(bob.prompts).toHaveLength(1);
    expect(bob.prompts[0].peer).toMatchObject({
      peerId: alice.identity.peerId,
      name: 'Alice',
      fingerprint: alice.identity.fingerprint,
    });
    expect(bob.prompts[0].intent).toBeUndefined();
    expect(alice.prompts).toHaveLength(0);
  });

  it('reports a decline to the dialer', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    bob.answer = async () => false;
    discover(alice, bob);
    await expect(alice.peers.connect(bob.identity.peerId)).rejects.toMatchObject({ reason: 'declined' });
    expect(alice.peers.stateOf(bob.identity.peerId)).toBeUndefined();
    expect(bob.peers.stateOf(alice.identity.peerId)).toBeUndefined();
  });

  it('refuses a responder whose key does not match the advertised fingerprint', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    discover(alice, bob, { fingerprint: generateIdentity().fingerprint });
    await expect(alice.peers.connect(bob.identity.peerId)).rejects.toMatchObject({ reason: 'auth-failed' });
    expect(bob.prompts).toHaveLength(0);
  });

  it('rejects a dial aimed at a different peer id', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    const carol = await node('Carol');
    // Alice thinks Carol lives at Bob's port.
    alice.registry.upsert({
      peerId: carol.identity.peerId,
      name: 'Carol',
      workspace: '',
      fingerprint: carol.identity.fingerprint,
      version: '1.0.0',
      status: 'available',
      publicGroups: [],
      addresses: ['127.0.0.1'],
      port: bob.port,
    });
    await expect(alice.peers.connect(carol.identity.peerId)).rejects.toMatchObject({ reason: 'wrong-target' });
  });

  it('rejects an impersonator who claims a peer id bound to another key', async () => {
    const bob = await node('Bob');
    const victim = generateIdentity();
    const attacker = generateIdentity();
    const ws = new WebSocket(`ws://127.0.0.1:${bob.port}`);
    await new Promise((r) => ws.once('open', r));
    const reply = new Promise<string>((r) => ws.once('message', (d) => r(d.toString())));
    ws.send(
      JSON.stringify(
        createMessage(
          'HELLO',
          {
            name: 'Totally Alice',
            workspace: '',
            appVersion: '0.1.0',
            publicKey: attacker.publicKey,
            nonce: createNonce(),
            ephemeralKey: createEphemeralKey().publicKey,
          },
          { senderId: victim.peerId, targetId: bob.identity.peerId, sessionId: 's1' },
        ),
      ),
    );
    const msg = parseMessage(await reply);
    expect(msg).toMatchObject({ type: 'HELLO_REJECT', payload: { reason: 'auth-failed' } });
    expect(bob.prompts).toHaveLength(0);
    ws.terminate();
  });

  it('drops a client that never completes the handshake', async () => {
    const bob = await node('Bob');
    const ws = new WebSocket(`ws://127.0.0.1:${bob.port}`);
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise((r) => ws.once('close', r));
    ws.send('this is not json');
    await closed;
    expect(bob.prompts).toHaveLength(0);
  });

  it('unreachable peers fail with a clear reason', async () => {
    const alice = await node('Alice');
    alice.registry.upsert({
      peerId: generateIdentity().peerId,
      name: 'Ghost',
      workspace: '',
      fingerprint: generateIdentity().fingerprint,
      version: '1.0.0',
      status: 'available',
      publicGroups: [],
      addresses: ['127.0.0.1'],
      port: 1,
    });
    const err = await alice.peers.connect(alice.registry.list()[0].peerId).catch((e) => e);
    expect(err).toBeInstanceOf(HandshakeError);
    expect(err.reason).toBe('unreachable');
  });
});

describe('simultaneous dials', () => {
  it('both sides keep exactly one connection, initiated by the lower peer id', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    // Slow approvals keep both dials in flight at the same time.
    alice.answer = async () => {
      await delay(200);
      return true;
    };
    bob.answer = alice.answer;
    discover(alice, bob);
    discover(bob, alice);

    await Promise.all([alice.peers.connect(bob.identity.peerId), bob.peers.connect(alice.identity.peerId)]);
    await waitFor(
      () =>
        alice.peers.stateOf(bob.identity.peerId) === 'connected' &&
        bob.peers.stateOf(alice.identity.peerId) === 'connected',
    );
    await delay(100);
    expect(alice.peers.connected()).toHaveLength(1);
    expect(bob.peers.connected()).toHaveLength(1);

    // Nobody had to approve anything: each side had already asked to connect.
    expect(alice.prompts.length + bob.prompts.length).toBe(0);

    // The surviving socket really works in both directions.
    alice.chat.send(bob.identity.peerId, 'ping');
    bob.chat.send(alice.identity.peerId, 'pong');
    await waitFor(() => dm(alice, bob).some((m) => m.content === 'pong'));
    await waitFor(() => dm(bob, alice).some((m) => m.content === 'ping'));
  });
});

describe('encryption on the wire', () => {
  it('sends only binary ciphertext once the handshake is done', async () => {
    const wire: Array<string | Buffer> = [];
    const recording: CodecFactory = (params) => {
      const inner = encryptedCodec(params);
      return {
        encode: (text) => {
          const frame = inner.encode(text);
          wire.push(frame);
          return frame;
        },
        decode: (frame) => inner.decode(frame),
      };
    };
    const alice = await startNode('Alice', recording);
    const bob = await startNode('Bob', recording);
    nodes.push(alice, bob);
    discover(alice, bob);
    await alice.peers.connect(bob.identity.peerId);
    await waitFor(() => bob.peers.stateOf(alice.identity.peerId) === 'connected');

    alice.chat.send(bob.identity.peerId, 'top secret');
    await waitFor(() => dm(bob, alice).some((m) => m.content === 'top secret'));
    expect(wire.length).toBeGreaterThanOrEqual(2);
    for (const frame of wire) {
      expect(Buffer.isBuffer(frame)).toBe(true);
      expect((frame as Buffer).includes(Buffer.from('top secret'))).toBe(false);
    }
  });
});

describe('direct messages', () => {
  it('delivers messages and typing status both ways', async () => {
    const { alice, bob } = await connectPair();
    const aliceDm = dmConversationId(bob.identity.peerId);

    expect(alice.chat.send(bob.identity.peerId, '  hello bob  ')).toBe(true);
    await waitFor(() => dm(bob, alice).some((m) => m.kind === 'text'));
    const received = dm(bob, alice).find((m) => m.kind === 'text')!;
    expect(received).toMatchObject({ content: 'hello bob', senderName: 'Alice', fromSelf: false });
    expect(bob.store.unread(dmConversationId(alice.identity.peerId))).toBe(1);

    bob.chat.send(alice.identity.peerId, 'hi alice');
    await waitFor(() => dm(alice, bob).some((m) => m.content === 'hi alice'));
    expect(dm(alice, bob).find((m) => m.content === 'hello bob')?.fromSelf).toBe(true);

    bob.chat.setTyping(alice.identity.peerId, true);
    await waitFor(() => alice.store.typingNames(aliceDm).includes('Bob'));
    bob.chat.setTyping(alice.identity.peerId, false);
    await waitFor(() => alice.store.typingNames(aliceDm).length === 0);

    // Typing expires on its own if "stopped typing" never arrives.
    bob.chat.setTyping(alice.identity.peerId, true);
    await waitFor(() => alice.store.typingNames(aliceDm).includes('Bob'));
    await waitFor(() => alice.store.typingNames(aliceDm).length === 0, 1000);
  });

  it('keeps each conversation separate', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    const carol = await node('Carol');
    discover(alice, bob);
    discover(alice, carol);
    await alice.peers.connect(bob.identity.peerId);
    await alice.peers.connect(carol.identity.peerId);
    alice.chat.send(bob.identity.peerId, 'just for bob');
    await waitFor(() => dm(bob, alice).length > 0);
    await delay(50);
    expect(carol.store.ids()).toEqual([]);
  });

  it('does not send to someone who is not connected', async () => {
    const alice = await node('Alice');
    expect(alice.chat.send(generateIdentity().peerId, 'anyone?')).toBe(false);
    expect(alice.store.ids()).toEqual([]);
  });

  it('notices when a peer leaves', async () => {
    const { alice, bob } = await connectPair();
    alice.chat.open(bob.identity.peerId);
    bob.peers.disconnect(alice.identity.peerId);
    await waitFor(() => alice.peers.stateOf(bob.identity.peerId) === undefined);
    await waitFor(() => dm(alice, bob).some((m) => m.kind === 'system' && m.content === 'Bob disconnected'));
  });
});
