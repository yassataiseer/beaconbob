import { Bonjour, type Browser, type Service } from 'bonjour-service';
import type { Identity } from '../security/identity';
import { isPeerIdFormat } from '../security/identity';
import { isGroupId, MAX_GROUP_NAME } from '../signaling/protocolTypes';
import type { Log } from '../util/logger';
import { isLanAddress, normalizeAddress, rankDialAddresses } from '../util/network';
import type { AdvertisedGroup, PeerAdvertisement, PeerRegistry, PeerStatus } from './peerRegistry';

export const SERVICE_TYPE = 'beaconbob';
export const PROTOCOL_VERSION = '1.0.0';

export interface MdnsProfile {
  name: string;
  workspace: string;
  status: PeerStatus;
  publicGroups: AdvertisedGroup[];
}

export interface MdnsServiceOptions {
  identity: Identity;
  port: number;
  profile: MdnsProfile;
  registry: PeerRegistry;
  log: Log;
  /** How often to re-query the subnet. Each round also sweeps peers that stopped answering. */
  refreshIntervalMs?: number;
  staleAfterMs?: number;
  /** Profile changes within this window are folded into one republish. */
  republishDelayMs?: number;
}

const MAX_TXT_FIELD = 64;
const FINGERPRINT_PATTERN = /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/;
/** Public groups ride in TXT keys g0..g4 as `<groupId>|<name>`. */
const GROUP_TXT_KEYS = ['g0', 'g1', 'g2', 'g3', 'g4'] as const;

function parseGroups(txt: Record<string, unknown>): AdvertisedGroup[] {
  const groups: AdvertisedGroup[] = [];
  for (const key of GROUP_TXT_KEYS) {
    const value = txtString(txt[key]);
    const sep = value.indexOf('|');
    if (sep === -1) continue;
    const groupId = value.slice(0, sep);
    const name = value.slice(sep + 1).slice(0, MAX_GROUP_NAME).trim();
    if (isGroupId(groupId) && name && !groups.some((g) => g.groupId === groupId)) groups.push({ groupId, name });
  }
  return groups;
}

function txtString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

/** Turns a resolved mDNS service into a peer advertisement, or `undefined` if it is malformed. */
export function parseAdvertisement(
  service: Pick<Service, 'txt' | 'port' | 'addresses' | 'referer'>,
): PeerAdvertisement | undefined {
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const peerId = txtString(txt.peerId);
  const fingerprint = txtString(txt.fp);
  if (!isPeerIdFormat(peerId) || !FINGERPRINT_PATTERN.test(fingerprint)) return undefined;
  if (!Number.isInteger(service.port) || service.port <= 0 || service.port > 65535) return undefined;

  const candidates: string[] = [];
  if (service.referer?.address) candidates.push(normalizeAddress(service.referer.address));
  for (const addr of service.addresses ?? []) candidates.push(normalizeAddress(addr));
  const addresses = rankDialAddresses(candidates);
  if (addresses.length === 0) return undefined;

  return {
    peerId,
    fingerprint,
    name: txtString(txt.user).slice(0, MAX_TXT_FIELD) || peerId,
    workspace: txtString(txt.workspace).slice(0, MAX_TXT_FIELD),
    version: txtString(txt.v).slice(0, 16),
    status: txtString(txt.status) === 'busy' ? 'busy' : 'available',
    publicGroups: parseGroups(txt),
    addresses,
    port: service.port,
  };
}

/**
 * Advertises this peer as `_beaconbob._tcp.local` and keeps `registry` in sync with the other
 * BeaconBob peers on the subnet.
 */
export class MdnsService {
  private bonjour: Bonjour | undefined;
  private service: Service | undefined;
  private browser: Browser | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private republishTimer: NodeJS.Timeout | undefined;
  private profile: MdnsProfile;
  private readonly refreshIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly republishDelayMs: number;

  constructor(private readonly opts: MdnsServiceOptions) {
    this.profile = opts.profile;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 15_000;
    this.staleAfterMs = opts.staleAfterMs ?? 50_000;
    this.republishDelayMs = opts.republishDelayMs ?? 1000;
  }

  start(): void {
    if (this.bonjour) return;
    const log = this.opts.log;
    const bonjour = new Bonjour({}, (err: Error) => log.warn(`mDNS responder error: ${err.message}`));
    // bonjour-service does not handle socket errors itself; an unhandled 'error' would throw.
    const mdns = (bonjour as unknown as { server: { mdns: NodeJS.EventEmitter } }).server.mdns;
    mdns.on('error', (err: Error) => log.error(`mDNS socket error: ${err.message}`));
    mdns.on('warning', (err: Error) => log.debug(`mDNS socket warning: ${err.message}`));
    this.bonjour = bonjour;

    this.publish();
    this.browse();
    this.refreshTimer = setInterval(() => this.browse(), this.refreshIntervalMs);
    log.info(`Advertising _${SERVICE_TYPE}._tcp.local on port ${this.opts.port} as ${this.opts.identity.peerId}`);
  }

  /**
   * Republishes with new TXT data (display name, public groups). bonjour-service cannot update
   * a record in place, so this sends a goodbye and re-announces; the registry's goodbye grace
   * period keeps peers from briefly dropping us.
   */
  updateProfile(profile: MdnsProfile): void {
    this.profile = profile;
    if (!this.bonjour) return;
    clearTimeout(this.republishTimer);
    this.republishTimer = setTimeout(() => {
      const previous = this.service;
      if (!this.bonjour || !previous) return;
      this.service = undefined;
      previous.stop?.(() => this.publish());
    }, this.republishDelayMs);
  }

  async stop(): Promise<void> {
    const bonjour = this.bonjour;
    if (!bonjour) return;
    this.bonjour = undefined;
    clearInterval(this.refreshTimer);
    clearTimeout(this.republishTimer);
    this.browser?.stop();
    this.browser = undefined;
    this.service = undefined;
    // unpublishAll sends the TTL=0 goodbye packets; wait for it before closing the socket.
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      bonjour.unpublishAll(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await new Promise<void>((resolve) => bonjour.destroy(() => resolve()));
    this.opts.registry.clear();
  }

  private publish(): void {
    if (!this.bonjour) return;
    const { identity, port } = this.opts;
    const txt: Record<string, string> = {
      v: PROTOCOL_VERSION,
      user: this.profile.name.slice(0, MAX_TXT_FIELD),
      workspace: this.profile.workspace.slice(0, MAX_TXT_FIELD),
      peerId: identity.peerId,
      fp: identity.fingerprint,
      status: this.profile.status,
    };
    this.profile.publicGroups.slice(0, GROUP_TXT_KEYS.length).forEach((group, i) => {
      txt[GROUP_TXT_KEYS[i]] = `${group.groupId}|${group.name.slice(0, MAX_GROUP_NAME)}`;
    });
    this.service = this.bonjour.publish({
      name: `BeaconBob ${identity.peerId}`,
      type: SERVICE_TYPE,
      protocol: 'tcp',
      port,
      txt,
    });
  }

  /**
   * bonjour-service's Browser only reports services it has not seen before, so a fresh browser
   * per round is what lets us notice peers that are still alive versus ones that vanished.
   */
  private browse(): void {
    if (!this.bonjour) return;
    this.browser?.stop();
    const browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' });
    browser.on('up', (s) => this.onServiceSeen(s));
    browser.on('txt-update', (s) => this.onServiceSeen(s));
    browser.on('srv-update', (s) => this.onServiceSeen(s));
    browser.on('down', (s) => this.onServiceGone(s));
    this.browser = browser;
    this.opts.registry.sweep(this.staleAfterMs);
  }

  private onServiceSeen(service: Service): void {
    const ad = parseAdvertisement(service);
    if (!ad) {
      this.opts.log.debug(`Ignoring malformed advertisement "${service.name}"`);
      return;
    }
    if (ad.peerId === this.opts.identity.peerId) return;
    if (service.referer?.address && !isLanAddress(service.referer.address)) return;
    this.opts.registry.upsert(ad);
  }

  private onServiceGone(service: Service): void {
    const peerId = txtString((service.txt as Record<string, unknown> | undefined)?.peerId);
    if (peerId && peerId !== this.opts.identity.peerId) this.opts.registry.markGone(peerId);
  }
}
