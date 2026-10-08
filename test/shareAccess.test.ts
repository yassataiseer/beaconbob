import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeAwarenessUpdate, Awareness } from 'y-protocols/awareness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readAwarenessUpdate } from '../src/share/awarenessCodec';
import { colorFor, isSharePath, parseAwarenessState, parseSharePayload } from '../src/share/shareProtocol';
import { WorkspaceAccess } from '../src/share/workspaceAccess';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'beaconbob-access-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'beaconbob-outside-'));
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'build'));
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a');
  await fs.writeFile(path.join(root, 'src', 'nested', 'b.ts'), 'b');
  await fs.writeFile(path.join(root, 'build', 'out.js'), 'x');
  await fs.writeFile(path.join(root, '.env.local'), 'SECRET');
  await fs.writeFile(path.join(root, 'server.key'), 'KEY');
  await fs.writeFile(path.join(root, '.gitignore'), 'build/\n*.tmp\n');
  await fs.writeFile(path.join(root, 'scratch.tmp'), 'tmp');
  await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(600 * 1024));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link-out.txt'));
  await fs.symlink(path.join(root, 'src', 'a.ts'), path.join(root, 'link-in.ts'));
  await fs.symlink(path.join(root, 'build', 'out.js'), path.join(root, 'link-to-ignored.js'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('WorkspaceAccess', () => {
  it('lists only visible files', async () => {
    const access = await WorkspaceAccess.create(root);
    const names = (await access.readDir('')).map((e) => e.name);
    expect(names).toEqual(['.gitignore', 'big.txt', 'link-in.ts', 'src']);
    expect(await access.readDir('src')).toEqual([
      { name: 'a.ts', type: 'file' },
      { name: 'nested', type: 'directory' },
    ]);
  });

  it('refuses traversal, symlink escapes, ignored and excluded paths', async () => {
    const access = await WorkspaceAccess.create(root);
    for (const bad of ['../etc/passwd', '/etc/passwd', 'src/../../x', 'a\\b']) {
      await expect(access.stat(bad)).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(access.readBytes('link-out.txt')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(access.readBytes('build/out.js')).rejects.toMatchObject({ code: 'not-found' });
    await expect(access.readBytes('link-to-ignored.js')).rejects.toMatchObject({ code: 'not-found' });
    await expect(access.readBytes('.env.local')).rejects.toMatchObject({ code: 'not-found' });
    await expect(access.readBytes('server.key')).rejects.toMatchObject({ code: 'not-found' });
    await expect(access.readBytes('scratch.tmp')).rejects.toMatchObject({ code: 'not-found' });
    expect((await access.readBytes('link-in.ts')).toString()).toBe('a');
  });

  it('caps file size and rejects reading directories', async () => {
    const access = await WorkspaceAccess.create(root);
    await expect(access.readBytes('big.txt')).rejects.toMatchObject({ code: 'too-large' });
    await expect(access.readBytes('src')).rejects.toMatchObject({ code: 'not-a-file' });
    await expect(access.readDir('src/a.ts')).rejects.toMatchObject({ code: 'not-a-directory' });
  });

  it('picks up .gitignore changes on reload', async () => {
    const access = await WorkspaceAccess.create(root);
    expect(access.isVisible('src/a.ts')).toBe(true);
    await fs.writeFile(path.join(root, '.gitignore'), 'src/\n');
    await access.reloadIgnore();
    expect(access.isVisible('src/a.ts')).toBe(false);
  });

  it('maps host paths to shared paths', async () => {
    const access = await WorkspaceAccess.create(root);
    expect(access.toRelative(path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(access.toRelative(root)).toBe('');
    expect(access.toRelative(path.join(outside, 'secret.txt'))).toBeUndefined();
  });
});

describe('share protocol', () => {
  it('validates shared paths', () => {
    for (const ok of ['', 'a', 'src/app.ts', '.github/workflows/ci.yml']) expect(isSharePath(ok)).toBe(true);
    for (const bad of ['/a', 'a/', 'a//b', '../a', 'a/../b', './a', 'a\\b', 'a\0b', 'x'.repeat(1100)]) {
      expect(isSharePath(bad)).toBe(false);
    }
  });

  it('accepts well-formed payloads and copies only known fields', () => {
    const state = {
      kind: 'SESSION_STATE',
      sessionId: 's-1',
      groupId: 'g-0123456789ab',
      rootName: 'repo',
      hostId: 'p-0011223344556677',
      editors: [],
    };
    expect(parseSharePayload({ ...state, extra: 'dropped' })).toStrictEqual(state);
    expect(parseSharePayload({ kind: 'FS_REQUEST', sessionId: 's', reqId: 'r', op: 'readDir', path: '' })).toBeDefined();
    expect(parseSharePayload({ kind: 'FS_RESPONSE', sessionId: 's', reqId: 'r', ok: false, error: 'read-only' })).toBeDefined();
    expect(
      parseSharePayload({ kind: 'FS_RESPONSE', sessionId: 's', reqId: 'r', ok: true, entries: [{ name: 'a', type: 'file' }] }),
    ).toBeDefined();
  });

  it('rejects malformed payloads', () => {
    const bad = [
      { kind: 'FS_REQUEST', sessionId: 's', reqId: 'r', op: 'delete', path: 'a' },
      { kind: 'FS_REQUEST', sessionId: 's', reqId: 'r', op: 'read', path: '../a' },
      { kind: 'DOC_OPEN', sessionId: 's', path: '' },
      { kind: 'DOC_UPDATE', sessionId: 's', path: 'a', updateB64: 'not base64!' },
      { kind: 'FS_RESPONSE', sessionId: 's', reqId: 'r', ok: true, entries: [{ name: 'a/b', type: 'file' }] },
      { kind: 'FS_RESPONSE', sessionId: 's', reqId: 'r', ok: false, error: 'kaboom' },
      { kind: 'SESSION_STATE', sessionId: 's', groupId: 'g-x', rootName: 'r', hostId: 'p-0011223344556677', editors: [] },
      { kind: 'DOC_SYNC', sessionId: 'bad id with spaces', path: 'a', stateB64: '', canEdit: true },
    ];
    for (const payload of bad) expect(parseSharePayload(payload)).toBeUndefined();
  });

  it('validates awareness states', () => {
    const peerId = 'p-0011223344556677';
    const good = { user: { peerId, name: 'Bob', color: colorFor(peerId) }, activeFile: 'src/a.ts', cursor: null };
    expect(parseAwarenessState(good)).toEqual(good);
    expect(parseAwarenessState({ ...good, activeFile: '../x' })).toBeUndefined();
    expect(parseAwarenessState({ ...good, user: { ...good.user, color: 'red; background:url(x)' } })).toBeUndefined();
    expect(colorFor(peerId)).toBe(colorFor(peerId));
  });

  it('reads awareness updates without applying them', () => {
    const awareness = new Awareness(new Y.Doc());
    awareness.setLocalState({ user: { name: 'Bob' } });
    const entries = readAwarenessUpdate(encodeAwarenessUpdate(awareness, [awareness.clientID]));
    expect(entries).toEqual([{ clientId: awareness.clientID, clock: expect.any(Number), state: { user: { name: 'Bob' } } }]);
    expect(readAwarenessUpdate(new Uint8Array([200, 1]))).toBeUndefined();
    awareness.destroy();
  });
});
