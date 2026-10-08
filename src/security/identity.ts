import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Long-lived Ed25519 identity shared by every editor window of a user profile. The key (and so
 * the fingerprint) is stable, but each window gets its own `peerId`: a key-derived prefix plus a
 * random per-session suffix, so that two windows on one machine never collide on the network.
 */
export interface Identity {
  peerId: string;
  /** Base64 SPKI DER. */
  publicKey: string;
  fingerprint: string;
  privateKey: crypto.KeyObject;
}

interface StoredIdentity {
  version: 1;
  publicKey: string;
  privateKeyPem: string;
}

const IDENTITY_FILE = 'identity.json';

function keyDigest(publicKeyB64: string): Buffer {
  return crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest();
}

const PEER_ID_PATTERN = /^p-[0-9a-f]{8}[0-9a-f]{8}$/;

function keyPrefix(publicKeyB64: string): string {
  return keyDigest(publicKeyB64).subarray(0, 4).toString('hex');
}

export function newPeerId(publicKeyB64: string): string {
  return `p-${keyPrefix(publicKeyB64)}${crypto.randomBytes(4).toString('hex')}`;
}

export function isPeerIdFormat(peerId: string): boolean {
  return PEER_ID_PATTERN.test(peerId);
}

/** A peer id is only valid for the key whose digest prefix it carries. */
export function peerIdMatchesKey(peerId: string, publicKeyB64: string): boolean {
  return isPeerIdFormat(peerId) && peerId.slice(2, 10) === keyPrefix(publicKeyB64);
}

/** 128-bit SHA-256 prefix, grouped for reading aloud: `a1b2 c3d4 ...`. */
export function fingerprintFromPublicKey(publicKeyB64: string): string {
  const hex = keyDigest(publicKeyB64).subarray(0, 16).toString('hex');
  return hex.match(/.{4}/g)!.join(' ');
}

export function isValidPublicKey(publicKeyB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function fromKeyPair(publicKeyB64: string, privateKey: crypto.KeyObject): Identity {
  return {
    peerId: newPeerId(publicKeyB64),
    publicKey: publicKeyB64,
    fingerprint: fingerprintFromPublicKey(publicKeyB64),
    privateKey,
  };
}

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return fromKeyPair(der, privateKey);
}

async function readIdentity(file: string): Promise<Identity | undefined> {
  try {
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as StoredIdentity;
    if (stored.version === 1 && isValidPublicKey(stored.publicKey)) {
      return fromKeyPair(stored.publicKey, crypto.createPrivateKey(stored.privateKeyPem));
    }
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

export async function loadOrCreateIdentity(dir: string): Promise<Identity> {
  const file = path.join(dir, IDENTITY_FILE);
  const existing = await readIdentity(file);
  if (existing) return existing;

  const identity = generateIdentity();
  const stored: StoredIdentity = {
    version: 1,
    publicKey: identity.publicKey,
    privateKeyPem: identity.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
  await fs.mkdir(dir, { recursive: true });
  try {
    // `wx` so that two windows activating at once agree on a single key.
    await fs.writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600, flag: 'wx' });
    return identity;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const winner = await readIdentity(file);
  if (winner) return winner;
  // The file exists but is corrupt: replace it.
  await fs.writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  return identity;
}

export function sign(identity: Identity, data: Buffer): string {
  return crypto.sign(null, data, identity.privateKey).toString('base64');
}

export function verify(publicKeyB64: string, data: Buffer, signatureB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, data, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
