import { describe, expect, it } from 'vitest';
import { parseAdvertisement } from '../src/discovery/mdnsService';
import { type PeerAdvertisement, PeerRegistry } from '../src/discovery/peerRegistry';
import { generateIdentity } from '../src/security/identity';

function ad(overrides: Partial<PeerAdvertisement> = {}): PeerAdvertisement {
  return {
    peerId: 'p-0011223344556677',
    name: 'Alice',
    workspace: 'core',
    fingerprint: 'aaaa bbbb cccc dddd eeee ffff 0000 1111',
    version: '1.0.0',
    status: 'available',
    publicGroups: [],
    addresses: ['192.168.1.5'],
    port: 42521,
    ...overrides,
  };
}

describe('PeerRegistry', () => {
  it('emits discovered, updated, and lost', () => {
    const registry = new PeerRegistry();
    const events: string[] = [];
    registry.on('peerDiscovered', (p) => events.push(`discovered:${p.name}`));
    registry.on('peerUpdated', (p) => events.push(`updated:${p.name}`));
    registry.on('peerLost', (p) => events.push(`lost:${p.name}`));

    registry.upsert(ad());
    registry.upsert(ad({ addresses: ['192.168.1.5'] }));
    registry.upsert(ad({ name: 'Alice Dev' }));
    registry.remove('p-0011223344556677');
    registry.remove('p-0011223344556677');

    expect(events).toEqual(['discovered:Alice', 'updated:Alice Dev', 'lost:Alice Dev']);
  });

  it('treats a reordered address list as unchanged', () => {
    const registry = new PeerRegistry();
    let updates = 0;
    registry.on('peerUpdated', () => updates++);
    registry.upsert(ad({ addresses: ['192.168.1.5', '10.0.0.5'] }));
    registry.upsert(ad({ addresses: ['10.0.0.5', '192.168.1.5'] }));
    expect(updates).toBe(0);
  });

  it('reports a change in advertised groups', () => {
    const registry = new PeerRegistry();
    let updates = 0;
    registry.on('peerUpdated', () => updates++);
    registry.upsert(ad());
    registry.upsert(ad({ publicGroups: [{ groupId: 'g-0123456789ab', name: 'frontend' }] }));
    expect(updates).toBe(1);
  });

  it('waits out a goodbye in case the peer is just republishing', async () => {
    const registry = new PeerRegistry({ goodbyeGraceMs: 50 });
    const lost: string[] = [];
    registry.on('peerLost', (p) => lost.push(p.peerId));

    registry.upsert(ad({ peerId: 'p-aaaaaaaaaaaaaaaa' }));
    registry.markGone('p-aaaaaaaaaaaaaaaa');
    registry.upsert(ad({ peerId: 'p-aaaaaaaaaaaaaaaa' }));
    registry.upsert(ad({ peerId: 'p-bbbbbbbbbbbbbbbb' }));
    registry.markGone('p-bbbbbbbbbbbbbbbb');
    await new Promise((r) => setTimeout(r, 120));

    expect(lost).toEqual(['p-bbbbbbbbbbbbbbbb']);
    expect(registry.get('p-aaaaaaaaaaaaaaaa')).toBeDefined();
  });

  it('sweeps peers that stopped answering', () => {
    const registry = new PeerRegistry();
    const lost: string[] = [];
    registry.on('peerLost', (p) => lost.push(p.peerId));
    registry.upsert(ad({ peerId: 'p-aaaaaaaaaaaaaaaa' }), 1_000);
    registry.upsert(ad({ peerId: 'p-bbbbbbbbbbbbbbbb' }), 50_000);
    registry.sweep(30_000, 60_000);
    expect(lost).toEqual(['p-aaaaaaaaaaaaaaaa']);
    expect(registry.list().map((p) => p.peerId)).toEqual(['p-bbbbbbbbbbbbbbbb']);
  });
});

describe('parseAdvertisement', () => {
  const identity = generateIdentity();
  const txt = { v: '1.0.0', user: 'Bob', workspace: 'core', peerId: identity.peerId, fp: identity.fingerprint, status: 'available' };

  it('parses a well-formed service', () => {
    const parsed = parseAdvertisement({
      txt,
      port: 42522,
      addresses: ['fe80::1', '192.168.1.7'],
      referer: { address: '192.168.1.7', family: 'IPv4', port: 5353, size: 0 },
    });
    expect(parsed).toMatchObject({ peerId: identity.peerId, name: 'Bob', port: 42522, status: 'available' });
    expect(parsed?.addresses).toEqual(['192.168.1.7', 'fe80::1']);
  });

  it('drops public addresses and malformed records', () => {
    expect(parseAdvertisement({ txt, port: 42522, addresses: ['8.8.8.8'] })).toBeUndefined();
    expect(parseAdvertisement({ txt: { ...txt, peerId: 'evil' }, port: 1, addresses: ['10.0.0.1'] })).toBeUndefined();
    expect(parseAdvertisement({ txt: { ...txt, fp: 'short' }, port: 1, addresses: ['10.0.0.1'] })).toBeUndefined();
    expect(parseAdvertisement({ txt, port: 0, addresses: ['10.0.0.1'] })).toBeUndefined();
  });

  it('reads public groups from g0..g4 and skips bad entries', () => {
    const parsed = parseAdvertisement({
      txt: {
        ...txt,
        g0: 'g-0123456789ab|frontend',
        g1: 'not-a-group|nope',
        g2: 'g-0123456789ab|duplicate',
        g3: 'g-aaaaaaaaaaaa|',
        g4: Buffer.from('g-bbbbbbbbbbbb|design'),
        g5: 'g-cccccccccccc|ignored',
      },
      port: 1,
      addresses: ['10.0.0.1'],
    });
    expect(parsed?.publicGroups).toEqual([
      { groupId: 'g-0123456789ab', name: 'frontend' },
      { groupId: 'g-bbbbbbbbbbbb', name: 'design' },
    ]);
  });

  it('caps long display names', () => {
    const parsed = parseAdvertisement({ txt: { ...txt, user: 'x'.repeat(500) }, port: 1, addresses: ['10.0.0.1'] });
    expect(parsed?.name).toHaveLength(64);
  });
});
