import * as net from 'node:net';
import * as os from 'node:os';

export interface PortRange {
  min: number;
  max: number;
}

export const DEFAULT_PORT_RANGE: PortRange = { min: 42520, max: 42560 };

export function parsePortRange(value: string | undefined): PortRange {
  const match = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(value ?? '');
  if (!match) return DEFAULT_PORT_RANGE;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (min < 1024 || max > 65535 || min > max) return DEFAULT_PORT_RANGE;
  return { min, max };
}

/** Strips the IPv4-mapped IPv6 prefix and any zone id (`fe80::1%en0`). */
export function normalizeAddress(address: string): string {
  let a = address.trim();
  if (a.toLowerCase().startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  return a;
}

/**
 * True for loopback, RFC 1918 private, link-local, and IPv6 ULA addresses.
 * Anything routable on the public internet is rejected.
 */
export function isLanAddress(address: string): boolean {
  const a = normalizeAddress(address);
  if (net.isIPv4(a)) {
    const [o1, o2] = a.split('.').map(Number);
    return (
      o1 === 10 ||
      o1 === 127 ||
      (o1 === 172 && o2 >= 16 && o2 <= 31) ||
      (o1 === 192 && o2 === 168) ||
      (o1 === 169 && o2 === 254)
    );
  }
  if (net.isIPv6(a)) {
    const lower = a.toLowerCase();
    if (lower === '::1') return true;
    const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
    const isLinkLocal = (firstHextet & 0xffc0) === 0xfe80;
    const isUniqueLocal = (firstHextet & 0xfe00) === 0xfc00;
    return isLinkLocal || isUniqueLocal;
  }
  return false;
}

/** Non-internal LAN addresses of this machine, IPv4 first. */
export function getLocalAddresses(): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.internal || !isLanAddress(addr.address)) continue;
      (addr.family === 'IPv4' ? v4 : v6).push(addr.address);
    }
  }
  return [...v4, ...v6];
}

/** Orders candidate addresses for dialing: unique, LAN-only, IPv4 before IPv6. */
export function rankDialAddresses(addresses: Iterable<string>): string[] {
  const unique = [...new Set([...addresses].map((a) => a.trim()).filter((a) => isLanAddress(a)))];
  return unique.sort((a, b) => Number(net.isIPv6(a)) - Number(net.isIPv6(b)));
}

export function formatHostForUrl(address: string): string {
  return net.isIPv6(normalizeAddress(address)) ? `[${address}]` : address;
}

/**
 * Binds `server` to the first free port in `range`. Binding directly (rather than probing
 * first) avoids a race with other processes grabbing the port in between.
 */
export async function listenInRange(server: net.Server, range: PortRange, host?: string): Promise<number> {
  for (let port = range.min; port <= range.max; port++) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
        else reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    if (bound) return port;
  }
  throw new Error(`No free port in range ${range.min}-${range.max}`);
}
