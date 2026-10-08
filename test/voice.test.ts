import { afterEach, describe, expect, it } from 'vitest';
import { CallManager } from '../src/voice/callManager';
import { parseVoicePayload, parseVoiceSignal, type VoiceSignal } from '../src/voice/voiceProtocol';
import { nullLog } from '../src/util/logger';
import { delay, discover, startNode, type TestNode, waitFor } from './helpers';

interface VoiceNode extends TestNode {
  calls: CallManager;
  received: Array<{ from: string; signal: VoiceSignal }>;
  incoming: string[];
}

const nodes: VoiceNode[] = [];

async function node(name: string): Promise<VoiceNode> {
  const n = (await startNode(name)) as VoiceNode;
  n.calls = new CallManager({ peers: n.peers, groupHost: n.host, member: n.member, identity: n.identity, log: nullLog });
  n.received = [];
  n.incoming = [];
  n.calls.on('signal', (from, signal) => n.received.push({ from, signal }));
  n.calls.on('incoming', (peerId) => n.incoming.push(peerId));
  const stop = n.stop;
  n.stop = async () => {
    n.calls.dispose();
    await stop();
  };
  nodes.push(n);
  return n;
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.stop()));
});

const offer: VoiceSignal = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };

async function groupOfThree() {
  const alice = await node('Alice');
  const bob = await node('Bob');
  const carol = await node('Carol');
  for (const a of [alice, bob, carol]) for (const b of [alice, bob, carol]) if (a !== b) discover(a, b);
  const groupId = alice.host.create('frontend', 'public');
  await bob.member.requestJoin(alice.identity.peerId, groupId);
  await carol.member.requestJoin(alice.identity.peerId, groupId);
  await waitFor(() => alice.host.hosted()[0].members.length === 3 && !!bob.member.group(groupId) && !!carol.member.group(groupId));
  return { alice, bob, carol, groupId };
}

describe('group calls', () => {
  it('the host publishes who is in the call to every member', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    bob.calls.join({ scope: 'group', groupId });
    await waitFor(() => carol.calls.participantsOf(groupId).includes(bob.identity.peerId));
    // Carol is not in the call, so she has nobody to exchange audio with.
    expect(carol.calls.remoteParticipants()).toEqual([]);
    expect(bob.calls.remoteParticipants()).toEqual([]);

    alice.calls.join({ scope: 'group', groupId });
    carol.calls.join({ scope: 'group', groupId });
    await waitFor(() => bob.calls.remoteParticipants().length === 2);
    expect(bob.calls.remoteParticipants().sort()).toEqual([alice.identity.peerId, carol.identity.peerId].sort());
    expect(alice.calls.remoteParticipants().sort()).toEqual([bob.identity.peerId, carol.identity.peerId].sort());

    bob.calls.leave();
    await waitFor(() => carol.calls.remoteParticipants().length === 1);
    expect(carol.calls.remoteParticipants()).toEqual([alice.identity.peerId]);
  });

  it('the host forwards signals between members and vouches for the sender', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    for (const n of [alice, bob, carol]) n.calls.join({ scope: 'group', groupId });
    await waitFor(() => bob.calls.remoteParticipants().length === 2 && carol.calls.remoteParticipants().length === 2);

    expect(bob.calls.sendSignal(carol.identity.peerId, offer)).toBe(true);
    await waitFor(() => carol.received.length === 1);
    expect(carol.received[0]).toEqual({ from: bob.identity.peerId, signal: offer });
    expect(bob.peers.isConnected(carol.identity.peerId)).toBe(false);

    bob.calls.sendSignal(alice.identity.peerId, offer);
    alice.calls.sendSignal(bob.identity.peerId, { type: 'answer', sdp: 'v=0' });
    await waitFor(() => alice.received.length === 1 && bob.received.length === 1);
    expect(alice.received[0].from).toBe(bob.identity.peerId);
    expect(bob.received[0].from).toBe(alice.identity.peerId);
  });

  it('drops signals to or from people who are not in the call', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    alice.calls.join({ scope: 'group', groupId });
    bob.calls.join({ scope: 'group', groupId });
    await waitFor(() => bob.calls.remoteParticipants().length === 1);
    // Carol is in the group but not the call.
    expect(bob.calls.sendSignal(carol.identity.peerId, offer)).toBe(false);
    carol.peers.send(alice.identity.peerId, 'lanVoice', {
      kind: 'VOICE_SIGNAL',
      scope: 'group',
      groupId,
      to: bob.identity.peerId,
      signal: offer,
    });
    // A member cannot pretend a forwarded signal came from someone else.
    bob.peers.send(alice.identity.peerId, 'lanVoice', {
      kind: 'VOICE_SIGNAL',
      scope: 'group',
      groupId,
      to: alice.identity.peerId,
      from: carol.identity.peerId,
      signal: offer,
    });
    await delay(100);
    expect(bob.received).toEqual([]);
    expect(alice.received).toEqual([]);
  });

  it('ignores a call state published by someone other than the host', async () => {
    const { bob, carol, groupId } = await groupOfThree();
    await carol.peers.connect(bob.identity.peerId);
    carol.peers.send(bob.identity.peerId, 'lanVoice', {
      kind: 'VOICE_STATE',
      groupId,
      participants: [carol.identity.peerId, bob.identity.peerId],
    });
    await delay(100);
    expect(bob.calls.participantsOf(groupId)).toEqual([]);
  });

  it('people who leave the group or disconnect drop out of the call', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    for (const n of [alice, bob, carol]) n.calls.join({ scope: 'group', groupId });
    await waitFor(() => alice.calls.remoteParticipants().length === 2);
    alice.host.remove(groupId, carol.identity.peerId);
    await waitFor(() => bob.calls.remoteParticipants().length === 1);
    expect(carol.calls.call).toBeUndefined();

    bob.peers.disconnect(alice.identity.peerId);
    await waitFor(() => alice.calls.remoteParticipants().length === 0);
    expect(bob.calls.call).toBeUndefined();
  });

  it('closing the group ends its call', async () => {
    const { alice, bob, groupId } = await groupOfThree();
    alice.calls.join({ scope: 'group', groupId });
    bob.calls.join({ scope: 'group', groupId });
    await waitFor(() => bob.calls.remoteParticipants().length === 1);
    alice.host.close(groupId);
    await waitFor(() => bob.calls.call === undefined);
    expect(alice.calls.call).toBeUndefined();
  });

  it('newcomers to the group learn about a running call', async () => {
    const { alice, bob, groupId } = await groupOfThree();
    bob.calls.join({ scope: 'group', groupId });
    const dave = await node('Dave');
    discover(dave, alice);
    await dave.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => dave.calls.participantsOf(groupId).includes(bob.identity.peerId));
  });
});

describe('direct calls', () => {
  it('both sides joining connects them; the callee is notified', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    discover(alice, bob);
    await alice.peers.connect(bob.identity.peerId);

    alice.calls.join({ scope: 'dm', peerId: bob.identity.peerId });
    await waitFor(() => bob.incoming.length === 1);
    expect(bob.incoming).toEqual([alice.identity.peerId]);
    expect(bob.calls.dmPeerInCall(alice.identity.peerId)).toBe(true);
    expect(alice.calls.remoteParticipants()).toEqual([]);

    bob.calls.join({ scope: 'dm', peerId: alice.identity.peerId });
    await waitFor(() => alice.calls.remoteParticipants().length === 1);
    expect(bob.calls.remoteParticipants()).toEqual([alice.identity.peerId]);

    alice.calls.sendSignal(bob.identity.peerId, offer);
    await waitFor(() => bob.received.length === 1);
    expect(bob.received[0].from).toBe(alice.identity.peerId);

    bob.calls.leave();
    await waitFor(() => alice.calls.remoteParticipants().length === 0);
    expect(alice.calls.call).toEqual({ scope: 'dm', peerId: bob.identity.peerId });
  });

  it('joining another call leaves the current one', async () => {
    const { alice, bob, groupId } = await groupOfThree();
    alice.calls.join({ scope: 'group', groupId });
    bob.calls.join({ scope: 'group', groupId });
    await waitFor(() => bob.calls.remoteParticipants().length === 1);
    bob.calls.join({ scope: 'dm', peerId: alice.identity.peerId });
    await waitFor(() => !alice.calls.participantsOf(groupId).includes(bob.identity.peerId));
  });

  it('cannot call someone you are not connected to', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    discover(alice, bob);
    expect(() => alice.calls.join({ scope: 'dm', peerId: bob.identity.peerId })).toThrow(/Connect/);
  });
});

describe('voice protocol', () => {
  const groupId = 'g-0123456789ab';
  const peer = 'p-0011223344556677';

  it('validates payloads', () => {
    expect(parseVoicePayload({ kind: 'VOICE_JOIN', scope: 'dm' })).toEqual({ kind: 'VOICE_JOIN', scope: 'dm' });
    expect(parseVoicePayload({ kind: 'VOICE_JOIN', scope: 'group', groupId })).toBeDefined();
    expect(parseVoicePayload({ kind: 'VOICE_JOIN', scope: 'group' })).toBeUndefined();
    expect(parseVoicePayload({ kind: 'VOICE_JOIN', scope: 'dm', groupId })).toBeUndefined();
    expect(parseVoicePayload({ kind: 'VOICE_STATE', groupId, participants: [peer, peer] })).toEqual({
      kind: 'VOICE_STATE',
      groupId,
      participants: [peer],
    });
    expect(parseVoicePayload({ kind: 'VOICE_STATE', groupId, participants: ['nope'] })).toBeUndefined();
    expect(parseVoicePayload({ kind: 'VOICE_SIGNAL', scope: 'dm', to: peer, signal: offer })).toBeDefined();
    expect(parseVoicePayload({ kind: 'VOICE_SIGNAL', scope: 'dm', to: peer, signal: { type: 'bye' } })).toBeUndefined();
  });

  it('validates signals', () => {
    const ice = { type: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
    expect(parseVoiceSignal(ice)).toEqual({ type: 'ice', candidate: { ...ice.candidate, usernameFragment: null } });
    expect(parseVoiceSignal({ type: 'offer', sdp: '' })).toBeUndefined();
    expect(parseVoiceSignal({ type: 'offer', sdp: 'x'.repeat(40_000) })).toBeUndefined();
    expect(parseVoiceSignal({ type: 'ice', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 99 } })).toBeUndefined();
  });
});
