import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fingerprintFromPublicKey,
  generateIdentity,
  isPeerIdFormat,
  loadOrCreateIdentity,
  peerIdMatchesKey,
  sign,
  verify,
} from '../src/security/identity';

const tmpDirs: string[] = [];
async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beaconbob-id-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('identity', () => {
  it('signs and verifies', () => {
    const id = generateIdentity();
    const data = Buffer.from('hello');
    const sig = sign(id, data);
    expect(verify(id.publicKey, data, sig)).toBe(true);
    expect(verify(id.publicKey, Buffer.from('hellO'), sig)).toBe(false);
    expect(verify(generateIdentity().publicKey, data, sig)).toBe(false);
    expect(verify('garbage', data, sig)).toBe(false);
  });

  it('binds peer ids to the key prefix', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(isPeerIdFormat(a.peerId)).toBe(true);
    expect(peerIdMatchesKey(a.peerId, a.publicKey)).toBe(true);
    expect(peerIdMatchesKey(a.peerId, b.publicKey)).toBe(false);
    expect(peerIdMatchesKey('p-nothex', a.publicKey)).toBe(false);
  });

  it('formats fingerprints as eight groups of four hex digits', () => {
    const fp = fingerprintFromPublicKey(generateIdentity().publicKey);
    expect(fp).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
  });

  it('persists the key but issues a fresh peer id per load', async () => {
    const dir = await tmpDir();
    const first = await loadOrCreateIdentity(dir);
    const second = await loadOrCreateIdentity(dir);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.peerId).not.toBe(first.peerId);
    expect(peerIdMatchesKey(second.peerId, first.publicKey)).toBe(true);
    const sig = sign(first, Buffer.from('x'));
    expect(verify(second.publicKey, Buffer.from('x'), sig)).toBe(true);
  });

  it('agrees on one key when two windows create it concurrently', async () => {
    const dir = await tmpDir();
    const [a, b] = await Promise.all([loadOrCreateIdentity(dir), loadOrCreateIdentity(dir)]);
    expect(a.publicKey).toBe(b.publicKey);
  });

  it('replaces a corrupt identity file', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'identity.json'), '{not json');
    const id = await loadOrCreateIdentity(dir);
    const again = await loadOrCreateIdentity(dir);
    expect(again.publicKey).toBe(id.publicKey);
  });
});
