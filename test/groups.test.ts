import { afterEach, describe, expect, it } from 'vitest';
import { groupConversationId } from '../src/chat/conversationStore';
import { generateIdentity } from '../src/security/identity';
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

const texts = (n: TestNode, groupId: string) =>
  n.store.messages(groupConversationId(groupId)).filter((m) => m.kind === 'text');
const systems = (n: TestNode, groupId: string) =>
  n.store.messages(groupConversationId(groupId)).filter((m) => m.kind === 'system').map((m) => m.content);
const memberNames = (n: TestNode, groupId: string) =>
  n.member.group(groupId)?.members.map((m) => m.name).sort() ?? [];

async function trio() {
  const alice = await node('Alice');
  const bob = await node('Bob');
  const carol = await node('Carol');
  for (const a of [alice, bob, carol]) for (const b of [alice, bob, carol]) if (a !== b) discover(a, b);
  return { alice, bob, carol };
}

describe('public groups', () => {
  it('joining by connecting: one prompt, naming the group, admits the member', async () => {
    const { alice, bob } = await trio();
    const groupId = alice.host.create('#frontend', 'public');

    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => !!bob.member.group(groupId));

    expect(alice.prompts).toHaveLength(1);
    expect(alice.prompts[0].intent).toEqual({ kind: 'join', groupId });
    expect(memberNames(bob, groupId)).toEqual(['Alice', 'Bob']);
    expect(systems(bob, groupId)).toContain('You joined #frontend, hosted by Alice');
    expect(systems(alice, groupId)).toContain('Bob joined');
  });

  it('joining over an existing connection waits for the host to approve', async () => {
    const { alice, bob } = await trio();
    await alice.peers.connect(bob.identity.peerId);
    const groupId = alice.host.create('frontend', 'public');
    const requests: string[] = [];
    alice.host.on('joinRequest', (r) => requests.push(r.peer.name));

    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => requests.length === 1);
    expect(bob.member.isPending(groupId)).toBe(true);
    expect(alice.host.joinRequests()).toMatchObject([{ groupId, groupName: 'frontend', peer: { name: 'Bob' } }]);

    alice.host.respondJoinRequest(groupId, bob.identity.peerId, true);
    await waitFor(() => !!bob.member.group(groupId));
    expect(bob.member.isPending(groupId)).toBe(false);
    expect(alice.host.joinRequests()).toEqual([]);
  });

  it('a declined in-band request tells the member', async () => {
    const { alice, bob } = await trio();
    await alice.peers.connect(bob.identity.peerId);
    const groupId = alice.host.create('frontend', 'public');
    const declined: string[] = [];
    bob.member.on('joinDeclined', (d) => declined.push(d.hostName));

    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => alice.host.joinRequests().length === 1);
    alice.host.respondJoinRequest(groupId, bob.identity.peerId, false);
    await waitFor(() => declined.length === 1);
    expect(declined).toEqual(['Alice']);
    expect(bob.member.group(groupId)).toBeUndefined();
  });

  it('declining the connection prompt rejects the join', async () => {
    const { alice, bob } = await trio();
    alice.answer = async () => false;
    const groupId = alice.host.create('frontend', 'public');
    await expect(bob.member.requestJoin(alice.identity.peerId, groupId)).rejects.toMatchObject({ reason: 'declined' });
    expect(bob.member.isPending(groupId)).toBe(false);
  });

  it('the host forwards messages between members who are not connected to each other', async () => {
    const { alice, bob, carol } = await trio();
    const groupId = alice.host.create('frontend', 'public');
    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await carol.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => memberNames(bob, groupId).length === 3 && memberNames(carol, groupId).length === 3);
    expect(bob.peers.isConnected(carol.identity.peerId)).toBe(false);
    expect(systems(bob, groupId)).toContain('Carol joined');

    expect(bob.member.send(groupId, 'hi from bob')).toBe(true);
    await waitFor(() => texts(carol, groupId).some((m) => m.content === 'hi from bob'));
    expect(texts(carol, groupId).find((m) => m.content === 'hi from bob')).toMatchObject({
      senderName: 'Bob',
      senderId: bob.identity.peerId,
      fromSelf: false,
    });
    expect(texts(alice, groupId).some((m) => m.content === 'hi from bob')).toBe(true);
    expect(texts(bob, groupId).filter((m) => m.content === 'hi from bob')).toHaveLength(1);

    alice.host.send(groupId, 'hi from the host');
    await waitFor(() => texts(bob, groupId).some((m) => m.content === 'hi from the host'));
    await waitFor(() => texts(carol, groupId).some((m) => m.content === 'hi from the host'));

    carol.member.setTyping(groupId, true);
    await waitFor(() => bob.store.typingNames(groupConversationId(groupId)).includes('Carol'));
    expect(alice.store.typingNames(groupConversationId(groupId))).toContain('Carol');
  });

  it('late joiners get recent history', async () => {
    const { alice, bob, carol } = await trio();
    const groupId = alice.host.create('frontend', 'public');
    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => !!bob.member.group(groupId));
    bob.member.send(groupId, 'early message');
    await waitFor(() => texts(alice, groupId).length === 1);

    await carol.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => texts(carol, groupId).some((m) => m.content === 'early message' && m.senderName === 'Bob'));
  });
});

describe('private groups and invites', () => {
  it('rejects an uninvited join without prompting the host', async () => {
    const { alice, bob } = await trio();
    const groupId = alice.host.create('secret', 'private');
    await expect(bob.member.requestJoin(alice.identity.peerId, groupId)).rejects.toMatchObject({ reason: 'declined' });
    expect(alice.prompts).toHaveLength(0);
    expect(alice.host.publicGroups()).toEqual([]);
  });

  it('rejects an uninvited in-band join', async () => {
    const { alice, bob } = await trio();
    await alice.peers.connect(bob.identity.peerId);
    const groupId = alice.host.create('secret', 'private');
    const declined: string[] = [];
    bob.member.on('joinDeclined', (d) => declined.push(d.hostName));
    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => declined.length === 1);
    expect(alice.host.joinRequests()).toEqual([]);
  });

  it('inviting someone not yet connected: their prompt names the group, accepting joins', async () => {
    const { alice, bob } = await trio();
    const groupId = alice.host.create('secret', 'private');
    await alice.host.invite(groupId, bob.identity.peerId);
    await waitFor(() => !!bob.member.group(groupId));
    expect(bob.prompts).toHaveLength(1);
    expect(bob.prompts[0].intent).toEqual({ kind: 'invite', groupId, groupName: 'secret' });
    expect(memberNames(bob, groupId)).toEqual(['Alice', 'Bob']);
  });

  it('declining the invite prompt leaves the group alone', async () => {
    const { alice, bob } = await trio();
    bob.answer = async () => false;
    const groupId = alice.host.create('secret', 'private');
    await expect(alice.host.invite(groupId, bob.identity.peerId)).rejects.toMatchObject({ reason: 'declined' });
    expect(alice.host.hosted()[0].invited).toEqual([]);
    expect(bob.member.joined()).toEqual([]);
  });

  it('inviting a connected peer goes in-band and waits for their answer', async () => {
    const { alice, bob, carol } = await trio();
    await alice.peers.connect(bob.identity.peerId);
    await alice.peers.connect(carol.identity.peerId);
    const groupId = alice.host.create('secret', 'private');
    const invitations: string[] = [];
    bob.member.on('invitation', (i) => invitations.push(`${i.hostName}:${i.groupName}`));

    await alice.host.invite(groupId, bob.identity.peerId);
    await alice.host.invite(groupId, carol.identity.peerId);
    await waitFor(() => invitations.length === 1);
    expect(invitations).toEqual(['Alice:secret']);
    expect(bob.member.pendingInvitations()).toHaveLength(1);

    bob.member.respondInvite(groupId, true);
    await waitFor(() => !!bob.member.group(groupId));
    await waitFor(() => carol.member.pendingInvitations().length === 1);
    carol.member.respondInvite(groupId, false);
    await waitFor(() => systems(alice, groupId).includes('Carol declined the invite'));
    expect(alice.host.hosted()[0].members.map((m) => m.name)).toEqual(['Alice', 'Bob']);
  });

  it('an invited peer can also join by request', async () => {
    const { alice, bob } = await trio();
    await alice.peers.connect(bob.identity.peerId);
    const groupId = alice.host.create('secret', 'private');
    await alice.host.invite(groupId, bob.identity.peerId);
    await waitFor(() => bob.member.pendingInvitations().length === 1);
    bob.member.respondInvite(groupId, true);
    await waitFor(() => !!bob.member.group(groupId));
  });
});

describe('membership changes', () => {
  async function groupOfThree() {
    const t = await trio();
    const groupId = t.alice.host.create('frontend', 'public');
    await t.bob.member.requestJoin(t.alice.identity.peerId, groupId);
    await t.carol.member.requestJoin(t.alice.identity.peerId, groupId);
    await waitFor(() => memberNames(t.bob, groupId).length === 3 && memberNames(t.carol, groupId).length === 3);
    return { ...t, groupId };
  }

  it('removing a member tells them and everyone else', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    alice.host.remove(groupId, carol.identity.peerId);
    await waitFor(() => carol.member.group(groupId)?.ended === 'removed');
    await waitFor(() => memberNames(bob, groupId).length === 2);
    expect(systems(bob, groupId)).toContain('Carol left');
    expect(carol.member.send(groupId, 'still here?')).toBe(false);
  });

  it('leaving removes you from the group', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    carol.member.leave(groupId);
    expect(carol.member.group(groupId)).toBeUndefined();
    expect(carol.store.has(groupConversationId(groupId))).toBe(false);
    await waitFor(() => memberNames(bob, groupId).length === 2);
    expect(systems(alice, groupId)).toContain('Carol left');
  });

  it('closing the group ends it for every member', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    alice.host.close(groupId);
    await waitFor(() => bob.member.group(groupId)?.ended === 'closed' && carol.member.group(groupId)?.ended === 'closed');
    expect(alice.host.isHost(groupId)).toBe(false);
    expect(systems(bob, groupId)).toContain('The host closed this group.');
  });

  it('a member disconnecting is removed from the group', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    carol.peers.disconnect(alice.identity.peerId);
    await waitFor(() => memberNames(bob, groupId).length === 2);
    expect(systems(alice, groupId)).toContain('Carol left (disconnected)');
  });

  it('the host disconnecting ends the group for members', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    alice.peers.dispose();
    await waitFor(() => bob.member.group(groupId)?.ended === 'host-left' && carol.member.group(groupId)?.ended === 'host-left');
  });
});

describe('trust', () => {
  it('ignores group state and messages from anyone but the host', async () => {
    const { alice, bob, carol } = await trio();
    const groupId = alice.host.create('frontend', 'public');
    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => !!bob.member.group(groupId));
    // Carol connects to Bob directly and tries to pose as the host.
    await carol.peers.connect(bob.identity.peerId);
    const forged = (kind: string, extra: object) => carol.peers.send(bob.identity.peerId, 'lanChat', { kind, groupId, ...extra });

    forged('GROUP_STATE', {
      name: 'hijacked',
      visibility: 'public',
      hostId: carol.identity.peerId,
      members: [
        { peerId: bob.identity.peerId, name: 'Bob', fingerprint: bob.identity.fingerprint },
        { peerId: carol.identity.peerId, name: 'Carol', fingerprint: carol.identity.fingerprint },
      ],
    });
    forged('GROUP_RELAY', {
      senderId: alice.identity.peerId,
      senderName: 'Alice',
      messageId: 'fake',
      content: 'forged message',
      timestamp: Date.now(),
    });
    forged('GROUP_REMOVED', { reason: 'closed' });
    await delay(100);

    const group = bob.member.group(groupId)!;
    expect(group.name).toBe('frontend');
    expect(group.hostId).toBe(alice.identity.peerId);
    expect(group.ended).toBeUndefined();
    expect(texts(bob, groupId)).toEqual([]);
  });

  it('the host drops messages from non-members', async () => {
    const { alice, bob, carol } = await trio();
    const groupId = alice.host.create('frontend', 'public');
    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => !!bob.member.group(groupId));
    await carol.peers.connect(alice.identity.peerId);
    carol.peers.send(alice.identity.peerId, 'lanChat', {
      kind: 'TEXT',
      groupId,
      messageId: 'm1',
      content: 'sneaking in',
      timestamp: Date.now(),
    });
    await delay(100);
    expect(texts(alice, groupId)).toEqual([]);
    expect(texts(bob, groupId)).toEqual([]);
  });

  it('the connection tie-break never skips a join approval', async () => {
    // Bob (the joiner) gets the lower id, so his dial is the one that wins the tie-break and
    // would normally be auto-accepted by Alice, who is dialing him at the same moment.
    const [low, high] = [generateIdentity(), generateIdentity()].sort((a, b) => (a.peerId < b.peerId ? -1 : 1));
    const alice = await startNode('Alice', undefined, high);
    const bob = await startNode('Bob', undefined, low);
    nodes.push(alice, bob);
    discover(alice, bob);
    discover(bob, alice);
    const groupId = alice.host.create('frontend', 'public');
    alice.answer = async () => {
      await delay(150);
      return false;
    };
    await Promise.allSettled([
      alice.peers.connect(bob.identity.peerId),
      bob.member.requestJoin(alice.identity.peerId, groupId),
    ]);
    await delay(300);
    expect(alice.prompts.some((p) => p.intent?.kind === 'join')).toBe(true);
    expect(alice.host.hosted()[0].members.map((m) => m.name)).toEqual(['Alice']);
  });
});
