import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT_RANGE,
  formatHostForUrl,
  isLanAddress,
  listenInRange,
  normalizeAddress,
  parsePortRange,
  rankDialAddresses,
} from '../src/util/network';

describe('isLanAddress', () => {
  it.each([
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.50',
    '169.254.10.1',
    '127.0.0.1',
    '::1',
    'fe80::1%en0',
    'fd12:3456::1',
    '::ffff:192.168.1.2',
  ])('accepts %s', (addr) => expect(isLanAddress(addr)).toBe(true));

  it.each(['8.8.8.8', '172.32.0.1', '1.1.1.1', '2001:4860:4860::8888', 'not-an-ip', ''])('rejects %s', (addr) =>
    expect(isLanAddress(addr)).toBe(false),
  );
});

describe('address helpers', () => {
  it('normalizes mapped and zoned addresses', () => {
    expect(normalizeAddress('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeAddress('fe80::abcd%en0')).toBe('fe80::abcd');
  });

  it('ranks unique LAN addresses with IPv4 first, keeping order otherwise', () => {
    expect(rankDialAddresses(['fe80::1', '192.168.1.9', '8.8.8.8', '10.0.0.2', '192.168.1.9'])).toEqual([
      '192.168.1.9',
      '10.0.0.2',
      'fe80::1',
    ]);
  });

  it('brackets IPv6 hosts for URLs', () => {
    expect(formatHostForUrl('fe80::1')).toBe('[fe80::1]');
    expect(formatHostForUrl('10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('parsePortRange', () => {
  it('parses valid ranges', () => expect(parsePortRange(' 43000 - 43010 ')).toEqual({ min: 43000, max: 43010 }));
  it.each(['', 'abc', '500-600', '43010-43000', '60000-70000', undefined])('falls back for %s', (value) =>
    expect(parsePortRange(value)).toEqual(DEFAULT_PORT_RANGE),
  );
});

describe('listenInRange', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it('skips ports that are already taken', async () => {
    const blocker = net.createServer();
    servers.push(blocker);
    const range = { min: 47100, max: 47105 };
    const first = await listenInRange(blocker, range, '127.0.0.1');

    const server = net.createServer();
    servers.push(server);
    const second = await listenInRange(server, range, '127.0.0.1');
    expect(second).toBeGreaterThan(first);
  });

  it('fails when the whole range is taken', async () => {
    const blocker = net.createServer();
    servers.push(blocker);
    const port = await listenInRange(blocker, { min: 47110, max: 47110 }, '127.0.0.1');
    const server = net.createServer();
    await expect(listenInRange(server, { min: port, max: port }, '127.0.0.1')).rejects.toThrow(/No free port/);
  });
});
