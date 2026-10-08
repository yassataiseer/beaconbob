import { afterEach, describe, expect, it } from 'vitest';
import { MdnsService } from '../src/discovery/mdnsService';
import { PeerRegistry } from '../src/discovery/peerRegistry';
import { generateIdentity } from '../src/security/identity';
import { nullLog } from '../src/util/logger';
import { getLocalAddresses } from '../src/util/network';
import { waitFor } from './helpers';

// Uses real multicast on UDP 5353, so it needs a LAN interface. Set BEACONBOB_SKIP_MDNS=1 to skip.
const canMulticast = getLocalAddresses().length > 0 && !process.env.BEACONBOB_SKIP_MDNS;

describe.skipIf(!canMulticast)('mDNS discovery (live multicast)', () => {
  const services: MdnsService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.stop()));
  });

  function advertise(name: string, port: number) {
    const identity = generateIdentity();
    const registry = new PeerRegistry({ goodbyeGraceMs: 1500 });
    const service = new MdnsService({
      identity,
      port,
      registry,
      log: nullLog,
      profile: { name, workspace: 'live-test', status: 'available', publicGroups: [] },
      refreshIntervalMs: 500,
      staleAfterMs: 5000,
      republishDelayMs: 50,
    });
    services.push(service);
    service.start();
    return { identity, registry, service };
  }

  it('two peers find each other and see the goodbye on shutdown', async () => {
    // Distinct names so the extension e2e test, which also browses mDNS, cannot confuse them.
    const alice = advertise('LiveAlice', 47201);
    const bob = advertise('LiveBob', 47202);

    await waitFor(() => alice.registry.get(bob.identity.peerId) !== undefined, 8000);
    await waitFor(() => bob.registry.get(alice.identity.peerId) !== undefined, 8000);

    const seen = alice.registry.get(bob.identity.peerId)!;
    expect(seen).toMatchObject({ name: 'LiveBob', port: 47202, fingerprint: bob.identity.fingerprint });
    expect(alice.registry.get(alice.identity.peerId)).toBeUndefined();

    services.splice(services.indexOf(bob.service), 1);
    await bob.service.stop();
    await waitFor(() => alice.registry.get(bob.identity.peerId) === undefined, 3000);
  });

  it('republishing with a public group updates peers without them losing us', async () => {
    const carol = advertise('LiveCarol', 47203);
    const dave = advertise('LiveDave', 47204);
    await waitFor(() => dave.registry.get(carol.identity.peerId) !== undefined, 8000);

    let lost = 0;
    dave.registry.on('peerLost', (p) => {
      if (p.peerId === carol.identity.peerId) lost++;
    });
    const group = { groupId: 'g-0123456789ab', name: 'frontend' };
    carol.service.updateProfile({ name: 'LiveCarol', workspace: 'live-test', status: 'available', publicGroups: [group] });

    await waitFor(() => dave.registry.get(carol.identity.peerId)?.publicGroups[0]?.name === 'frontend', 8000);
    expect(dave.registry.get(carol.identity.peerId)!.publicGroups).toEqual([group]);
    expect(lost).toBe(0);
  });
});
