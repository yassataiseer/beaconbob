import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import { type HostEditorAdapter, SessionHost } from '../src/share/sessionHost';
import { SessionGuest, ShareRequestError } from '../src/share/sessionGuest';
import { colorFor } from '../src/share/shareProtocol';
import { WorkspaceAccess } from '../src/share/workspaceAccess';
import { LOCAL_ORIGIN } from '../src/sync/documentManager';
import { applyChanges, applyChangesToYText, deltaToChanges } from '../src/sync/textOps';
import { nullLog } from '../src/util/logger';
import { delay, discover, startNode, type TestNode, waitFor } from './helpers';

/** Stands in for the host's editor: one in-memory buffer per file, bound to its Y.Text. */
class FakeHostEditor implements HostEditorAdapter {
  readonly buffers = new Map<string, string>();
  readonly saves: string[] = [];
  private readonly bound = new Map<string, Y.Text>();

  constructor(private readonly root: string) {}

  async readText(rel: string): Promise<string> {
    return this.buffers.get(rel) ?? fs.readFile(path.join(this.root, rel), 'utf8');
  }

  bind(rel: string, text: Y.Text): () => void {
    this.buffers.set(rel, text.toString());
    this.bound.set(rel, text);
    const observer = (event: Y.YTextEvent) => {
      if (event.transaction.origin === LOCAL_ORIGIN) return;
      this.buffers.set(rel, applyChanges(this.buffers.get(rel) ?? '', deltaToChanges(event.delta)));
    };
    text.observe(observer);
    return () => {
      text.unobserve(observer);
      this.bound.delete(rel);
    };
  }

  /** The host typing into their own buffer. */
  type(rel: string, offset: number, insertText: string, deleteLength = 0): void {
    const change = { offset, deleteLength, insertText };
    this.buffers.set(rel, applyChanges(this.buffers.get(rel) ?? '', [change]));
    const text = this.bound.get(rel);
    text?.doc?.transact(() => applyChangesToYText(text, [change]), LOCAL_ORIGIN);
  }

  async save(rel: string): Promise<void> {
    this.saves.push(rel);
    await fs.writeFile(path.join(this.root, rel), this.buffers.get(rel) ?? '');
  }
}

interface SharingNode extends TestNode {
  sharingHost: SessionHost;
  sharingGuest: SessionGuest;
  editor: FakeHostEditor;
}

let root: string;
const nodes: SharingNode[] = [];

async function node(name: string): Promise<SharingNode> {
  const n = (await startNode(name)) as SharingNode;
  n.editor = new FakeHostEditor(root);
  n.sharingHost = new SessionHost({ peers: n.peers, groups: n.host, identity: n.identity, adapter: n.editor, log: nullLog });
  n.sharingGuest = new SessionGuest({ peers: n.peers, groups: n.member, identity: n.identity, log: nullLog, requestTimeoutMs: 2000 });
  const stop = n.stop;
  n.stop = async () => {
    n.sharingHost.dispose();
    n.sharingGuest.dispose();
    await stop();
  };
  nodes.push(n);
  return n;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'beaconbob-share-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'const answer = 42;\n');
  await fs.writeFile(path.join(root, 'README.md'), '# demo\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
  await fs.writeFile(path.join(root, 'debug.log'), 'noise\n');
  await fs.writeFile(path.join(root, '.gitignore'), '*.log\n');
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), '');
  await fs.writeFile(path.join(root, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
});

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.stop()));
  await fs.rm(root, { recursive: true, force: true });
});

/** Alice hosts #frontend with Bob and Carol in it and starts sharing `root`. */
async function sharedGroup() {
  const alice = await node('Alice');
  const bob = await node('Bob');
  const carol = await node('Carol');
  for (const a of [alice, bob, carol]) for (const b of [alice, bob, carol]) if (a !== b) discover(a, b);
  const groupId = alice.host.create('frontend', 'public');
  await bob.member.requestJoin(alice.identity.peerId, groupId);
  await carol.member.requestJoin(alice.identity.peerId, groupId);
  await waitFor(() => !!bob.member.group(groupId) && !!carol.member.group(groupId));
  await waitFor(() => alice.host.hosted()[0].members.length === 3);
  alice.sharingHost.start(groupId, await WorkspaceAccess.create(root));
  await waitFor(() => !!bob.sharingGuest.get(groupId) && !!carol.sharingGuest.get(groupId));
  return { alice, bob, carol, groupId };
}

const textOf = (n: SharingNode, groupId: string, rel: string) => n.sharingGuest.text(groupId, rel)?.toString();

describe('sharing a workspace with a group', () => {
  it('members see the session, read-only by default', async () => {
    const { alice, bob, groupId } = await sharedGroup();
    expect(bob.sharingGuest.get(groupId)).toMatchObject({ rootName: path.basename(root), canEdit: false, hostId: alice.identity.peerId });
    expect(alice.sharingHost.active).toMatchObject({ groupId, editors: [] });
  });

  it('browsing hides ignored and excluded files', async () => {
    const { bob, groupId } = await sharedGroup();
    const top = await bob.sharingGuest.request(groupId, 'readDir', '');
    expect(top.entries).toEqual([
      { name: '.gitignore', type: 'file' },
      { name: 'README.md', type: 'file' },
      { name: 'logo.bin', type: 'file' },
      { name: 'src', type: 'directory' },
    ]);
    expect((await bob.sharingGuest.request(groupId, 'stat', 'src/app.ts')).stat).toMatchObject({ type: 'file', size: 19 });
    await expect(bob.sharingGuest.request(groupId, 'stat', '.env')).rejects.toMatchObject({ code: 'not-found' });
    await expect(bob.sharingGuest.request(groupId, 'readDir', 'node_modules')).rejects.toMatchObject({ code: 'not-found' });
    const bin = await bob.sharingGuest.request(groupId, 'read', 'logo.bin');
    expect(Buffer.from(bin.dataB64!, 'base64')).toEqual(Buffer.from([0, 1, 2, 3]));
  });

  it('refuses to open binary files as shared documents', async () => {
    const { bob, groupId } = await sharedGroup();
    await expect(bob.sharingGuest.openDoc(groupId, 'logo.bin')).rejects.toMatchObject({ code: 'binary' });
  });

  it('a read-only member gets the document but their edits are reverted', async () => {
    const { alice, bob, groupId } = await sharedGroup();
    const text = await bob.sharingGuest.openDoc(groupId, 'src/app.ts');
    expect(text.toString()).toBe('const answer = 42;\n');

    text.doc!.transact(() => text.insert(0, '// hacked\n'), LOCAL_ORIGIN);
    await waitFor(() => textOf(bob, groupId, 'src/app.ts') === 'const answer = 42;\n');
    expect(alice.editor.buffers.get('src/app.ts')).toBe('const answer = 42;\n');
  });

  it('an editor’s change reaches the host buffer and other members; the host’s typing flows out', async () => {
    const { alice, bob, carol, groupId } = await sharedGroup();
    alice.sharingHost.setCanEdit(bob.identity.peerId, true);
    await waitFor(() => bob.sharingGuest.get(groupId)?.canEdit === true);
    const bobText = await bob.sharingGuest.openDoc(groupId, 'src/app.ts');
    await carol.sharingGuest.openDoc(groupId, 'src/app.ts');

    bobText.doc!.transact(() => bobText.insert(0, '// bob\n'), LOCAL_ORIGIN);
    await waitFor(() => alice.editor.buffers.get('src/app.ts') === '// bob\nconst answer = 42;\n');
    await waitFor(() => textOf(carol, groupId, 'src/app.ts') === '// bob\nconst answer = 42;\n');

    alice.editor.type('src/app.ts', alice.editor.buffers.get('src/app.ts')!.length, 'export {};\n');
    await waitFor(() => textOf(bob, groupId, 'src/app.ts')?.endsWith('export {};\n') === true);
    await waitFor(() => textOf(carol, groupId, 'src/app.ts')?.endsWith('export {};\n') === true);
  });

  it('concurrent edits converge everywhere', async () => {
    const { alice, bob, carol, groupId } = await sharedGroup();
    alice.sharingHost.setCanEdit(bob.identity.peerId, true);
    alice.sharingHost.setCanEdit(carol.identity.peerId, true);
    await waitFor(() => !!bob.sharingGuest.get(groupId)?.canEdit && !!carol.sharingGuest.get(groupId)?.canEdit);
    const b = await bob.sharingGuest.openDoc(groupId, 'README.md');
    const c = await carol.sharingGuest.openDoc(groupId, 'README.md');

    b.doc!.transact(() => b.insert(0, 'B'), LOCAL_ORIGIN);
    c.doc!.transact(() => c.insert(c.length, 'C'), LOCAL_ORIGIN);
    alice.editor.type('README.md', 2, 'A');

    const all = () => [alice.editor.buffers.get('README.md'), textOf(bob, groupId, 'README.md'), textOf(carol, groupId, 'README.md')];
    await waitFor(() => new Set(all()).size === 1 && all()[0]!.length === '# demo\n'.length + 3);
    expect(all()[0]).toContain('B');
    expect(all()[0]).toContain('C');
    expect(all()[0]).toContain('A');
  });

  it('saving is for editors only and saves the host buffer', async () => {
    const { alice, bob, groupId } = await sharedGroup();
    const text = await bob.sharingGuest.openDoc(groupId, 'README.md');
    await expect(bob.sharingGuest.request(groupId, 'save', 'README.md')).rejects.toMatchObject({ code: 'read-only' });

    alice.sharingHost.setCanEdit(bob.identity.peerId, true);
    await waitFor(() => bob.sharingGuest.get(groupId)?.canEdit === true);
    text.doc!.transact(() => text.insert(text.length, 'more\n'), LOCAL_ORIGIN);
    await waitFor(() => alice.editor.buffers.get('README.md') === '# demo\nmore\n');
    await bob.sharingGuest.request(groupId, 'save', 'README.md');
    expect(alice.editor.saves).toEqual(['README.md']);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# demo\nmore\n');
  });

  it('revoking edit access stops further edits', async () => {
    const { alice, bob, groupId } = await sharedGroup();
    alice.sharingHost.setCanEdit(bob.identity.peerId, true);
    await waitFor(() => bob.sharingGuest.get(groupId)?.canEdit === true);
    const text = await bob.sharingGuest.openDoc(groupId, 'README.md');
    alice.sharingHost.setCanEdit(bob.identity.peerId, false);
    await waitFor(() => bob.sharingGuest.get(groupId)?.canEdit === false);
    text.doc!.transact(() => text.insert(0, 'x'), LOCAL_ORIGIN);
    await delay(100);
    expect(alice.editor.buffers.get('README.md')).toBe('# demo\n');
  });

  it('forwards cursors, attributing them to the right member', async () => {
    const { alice, bob, carol, groupId } = await sharedGroup();
    await bob.sharingGuest.openDoc(groupId, 'README.md');
    bob.sharingGuest.awareness(groupId)!.setLocalState({
      user: { peerId: bob.identity.peerId, name: 'Bob', color: colorFor(bob.identity.peerId) },
      activeFile: 'README.md',
      cursor: { anchor: { item: null, tname: 'content', type: null, assoc: 0 }, head: { item: null, tname: 'content', type: null, assoc: 0 } },
    });
    await waitFor(() => carol.sharingGuest.cursors(groupId).some((c) => c.user.name === 'Bob' && c.activeFile === 'README.md'));
    await waitFor(() => [...alice.sharingHost.awareness!.getStates().values()].some((s) => (s as { user?: { name: string } }).user?.name === 'Bob'));
  });

  it('drops cursor updates that claim to be someone else', async () => {
    const { bob, carol, groupId } = await sharedGroup();
    bob.sharingGuest.awareness(groupId)!.setLocalState({
      user: { peerId: carol.identity.peerId, name: 'Carol', color: '#000000' },
      activeFile: null,
      cursor: null,
    });
    await delay(150);
    expect(carol.sharingGuest.cursors(groupId)).toEqual([]);
  });

  it('removing a member ends their session; stopping ends everyone’s', async () => {
    const { alice, bob, carol, groupId } = await sharedGroup();
    alice.host.remove(groupId, carol.identity.peerId);
    await waitFor(() => !carol.sharingGuest.get(groupId));
    await expect(carol.sharingGuest.request(groupId, 'readDir', '')).rejects.toBeInstanceOf(ShareRequestError);
    expect(bob.sharingGuest.get(groupId)).toBeDefined();

    alice.sharingHost.stop();
    await waitFor(() => !bob.sharingGuest.get(groupId));
  });

  it('members who join later are told about the session', async () => {
    const { alice, groupId } = await sharedGroup();
    const dave = await node('Dave');
    discover(dave, alice);
    await dave.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => !!dave.sharingGuest.get(groupId));
  });

  it('only the group host can start a session for it', async () => {
    const { alice, bob, carol, groupId } = await sharedGroup();
    // Carol connects to Bob and pretends to be sharing #frontend.
    await carol.peers.connect(bob.identity.peerId);
    carol.peers.send(bob.identity.peerId, 'lanCodeSync', {
      kind: 'SESSION_STATE',
      sessionId: 'fake-session',
      groupId,
      rootName: 'evil',
      hostId: carol.identity.peerId,
      editors: [bob.identity.peerId],
    });
    await delay(100);
    expect(bob.sharingGuest.get(groupId)?.hostId).toBe(alice.identity.peerId);
    expect(bob.sharingGuest.get(groupId)?.rootName).toBe(path.basename(root));
  });

  it('closing the group ends the session', async () => {
    const { alice, bob, groupId } = await sharedGroup();
    alice.host.close(groupId);
    await waitFor(() => !bob.sharingGuest.get(groupId));
    expect(alice.sharingHost.active).toBeUndefined();
  });

  it('file changes on the host reach members', async () => {
    const { alice, bob, groupId } = await sharedGroup();
    const seen: string[][] = [];
    bob.sharingGuest.on('fsChanged', (changedGroup, paths) => {
      if (changedGroup === groupId) seen.push(paths);
    });
    alice.sharingHost.notifyChanged(['src/new.ts', 'debug.log', '.env']);
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual(['src/new.ts']);
  });
});
