import { Emitter } from '../util/events';

export type PeerStatus = 'available' | 'busy';

export interface AdvertisedGroup {
  groupId: string;
  name: string;
}

export interface DiscoveredPeer {
  peerId: string;
  name: string;
  workspace: string;
  fingerprint: string;
  version: string;
  status: PeerStatus;
  /** Public groups this peer hosts. */
  publicGroups: AdvertisedGroup[];
  /** LAN addresses advertised in A/AAAA records, plus the address the response came from. */
  addresses: string[];
  port: number;
  lastSeen: number;
}

export type PeerAdvertisement = Omit<DiscoveredPeer, 'lastSeen'>;

type RegistryEvents = {
  peerDiscovered: [DiscoveredPeer];
  peerUpdated: [DiscoveredPeer];
  peerLost: [DiscoveredPeer];
};

function sameAdvertisement(a: PeerAdvertisement, b: PeerAdvertisement): boolean {
  const addressesA = new Set(a.addresses);
  return (
    a.name === b.name &&
    a.workspace === b.workspace &&
    a.fingerprint === b.fingerprint &&
    a.version === b.version &&
    a.status === b.status &&
    a.port === b.port &&
    addressesA.size === new Set(b.addresses).size &&
    b.addresses.every((addr) => addressesA.has(addr)) &&
    a.publicGroups.length === b.publicGroups.length &&
    a.publicGroups.every((g, i) => g.groupId === b.publicGroups[i].groupId && g.name === b.publicGroups[i].name)
  );
}

export interface PeerRegistryOptions {
  /** How long a peer survives a goodbye packet, in case it is only republishing. */
  goodbyeGraceMs?: number;
}

/** Peers currently visible on the local subnet, keyed by peer id. */
export class PeerRegistry extends Emitter<RegistryEvents> {
  private readonly peers = new Map<string, DiscoveredPeer>();
  private readonly goneTimers = new Map<string, NodeJS.Timeout>();
  private readonly goodbyeGraceMs: number;

  constructor(opts: PeerRegistryOptions = {}) {
    super();
    this.goodbyeGraceMs = opts.goodbyeGraceMs ?? 4000;
  }

  upsert(ad: PeerAdvertisement, now = Date.now()): DiscoveredPeer {
    this.cancelGone(ad.peerId);
    const existing = this.peers.get(ad.peerId);
    const peer: DiscoveredPeer = {
      ...ad,
      addresses: [...ad.addresses],
      publicGroups: ad.publicGroups.map((g) => ({ ...g })),
      lastSeen: now,
    };
    this.peers.set(ad.peerId, peer);
    if (!existing) this.emit('peerDiscovered', peer);
    else if (!sameAdvertisement(existing, ad)) this.emit('peerUpdated', peer);
    return peer;
  }

  /**
   * A goodbye arrived. Peers republish (goodbye, then announce) whenever their TXT data
   * changes, so removal waits briefly and is cancelled if the peer shows up again.
   */
  markGone(peerId: string): void {
    if (!this.peers.has(peerId) || this.goneTimers.has(peerId)) return;
    const timer = setTimeout(() => {
      this.goneTimers.delete(peerId);
      this.remove(peerId);
    }, this.goodbyeGraceMs);
    timer.unref?.();
    this.goneTimers.set(peerId, timer);
  }

  remove(peerId: string): void {
    this.cancelGone(peerId);
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    this.emit('peerLost', peer);
  }

  /** Drops peers that have not answered a query within `maxAgeMs` (for example after a crash). */
  sweep(maxAgeMs: number, now = Date.now()): void {
    for (const peer of [...this.peers.values()]) {
      if (now - peer.lastSeen > maxAgeMs) this.remove(peer.peerId);
    }
  }

  get(peerId: string): DiscoveredPeer | undefined {
    return this.peers.get(peerId);
  }

  list(): DiscoveredPeer[] {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  clear(): void {
    for (const peerId of [...this.peers.keys()]) this.remove(peerId);
  }

  private cancelGone(peerId: string): void {
    const timer = this.goneTimers.get(peerId);
    if (!timer) return;
    clearTimeout(timer);
    this.goneTimers.delete(peerId);
  }
}
