/**
 * Runs inside a real VS Code extension host (see test/vscode/run.mjs). Exercises the parts
 * that cannot be faked convincingly: YjsBinding against real TextDocuments and
 * `workspace.applyEdit`, and edits to documents a FileSystemProvider marks read-only.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as Y from 'yjs';
import { ConversationStore } from '../../src/chat/conversationStore';
import { PeerRegistry } from '../../src/discovery/peerRegistry';
import { GroupHost } from '../../src/groups/groupHost';
import { GroupMember } from '../../src/groups/groupMember';
import { generateIdentity } from '../../src/security/identity';
import { SessionGuest } from '../../src/share/sessionGuest';
import { SessionHost } from '../../src/share/sessionHost';
import { WorkspaceAccess } from '../../src/share/workspaceAccess';
import { SignalServer } from '../../src/signaling/signalServer';
import { LOCAL_ORIGIN } from '../../src/sync/documentManager';
import { YjsBinding } from '../../src/sync/yjsBinding';
import { PeerManager } from '../../src/transport/peerManager';
import { nullLog } from '../../src/util/logger';
import { BeaconFileSystem, SHARE_SCHEME, shareUri } from '../../src/vscode/beaconFs';
import { VscodeHostAdapter } from '../../src/vscode/hostAdapter';

const results: string[] = [];

async function waitFor(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${(err as Error).stack ?? err}`);
  }
}

function sharedText(initial: string): Y.Text {
  const text = new Y.Doc().getText('content');
  text.insert(0, initial);
  return text;
}

async function tempFile(content: string): Promise<vscode.Uri> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beaconbob-vscode-'));
  const file = path.join(dir, 'shared.ts');
  await fs.writeFile(file, content);
  return vscode.Uri.file(file);
}

/** Minimal in-memory provider whose files are read-only, like a guest without edit access. */
class ReadonlyFs implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  watch = () => new vscode.Disposable(() => undefined);
  stat = (): vscode.FileStat => ({
    type: vscode.FileType.File,
    ctime: 0,
    mtime: 0,
    size: 5,
    permissions: vscode.FilePermission.Readonly,
  });
  readDirectory = () => [];
  createDirectory = () => undefined;
  readFile = () => Buffer.from('hello');
  writeFile = () => {
    throw vscode.FileSystemError.NoPermissions();
  };
  delete = () => undefined;
  rename = () => undefined;
}

interface Peer {
  name: string;
  identity: ReturnType<typeof generateIdentity>;
  registry: PeerRegistry;
  peers: PeerManager;
  server: SignalServer;
  groupHost: GroupHost;
  member: GroupMember;
  port: number;
}

let nextPort = 47400;

async function startPeer(name: string): Promise<Peer> {
  const identity = generateIdentity();
  const registry = new PeerRegistry();
  const profile = () => ({ name, workspace: '', appVersion: 'test' });
  let groupHost: GroupHost | undefined;
  const peers = new PeerManager({
    identity,
    getProfile: profile,
    registry,
    log: nullLog,
    promptApproval: async () => true,
    screenIntent: (peer, intent) => (intent.kind === 'join' && groupHost ? groupHost.screenJoin(peer, intent) : 'prompt'),
  });
  const store = new ConversationStore();
  groupHost = new GroupHost({ peers, store, identity, getSelfName: () => name, log: nullLog });
  const member = new GroupMember({ peers, store, identity, getSelfName: () => name, log: nullLog });
  const server = new SignalServer({ identity, getProfile: profile, authorize: peers.authorize, log: nullLog });
  server.on('connection', (conn) => peers.adopt(conn));
  const port = await server.start({ min: nextPort, max: nextPort + 9 }, '127.0.0.1');
  nextPort += 10;
  return { name, identity, registry, peers, server, groupHost, member, port };
}

function introduce(a: Peer, b: Peer): void {
  a.registry.upsert({
    peerId: b.identity.peerId,
    name: b.name,
    workspace: '',
    fingerprint: b.identity.fingerprint,
    version: '1.0.0',
    status: 'available',
    publicGroups: [],
    addresses: ['127.0.0.1'],
    port: b.port,
  });
}

async function sharingEndToEnd(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beaconbob-share-e2e-'));
  await fs.writeFile(path.join(dir, 'app.ts'), 'const answer = 42;\n');
  const alice = await startPeer('Alice');
  const bob = await startPeer('Bob');
  introduce(bob, alice);
  const disposables: vscode.Disposable[] = [];
  let sessionHost: SessionHost | undefined;
  let sessionGuest: SessionGuest | undefined;
  try {
    const groupId = alice.groupHost.create('pairing', 'public');
    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => !!bob.member.group(groupId), 'Bob to join the group');

    const host: SessionHost = new SessionHost({
      peers: alice.peers,
      groups: alice.groupHost,
      identity: alice.identity,
      adapter: new VscodeHostAdapter(() => host.access, nullLog),
      log: nullLog,
    });
    sessionHost = host;
    const guest = new SessionGuest({ peers: bob.peers, groups: bob.member, identity: bob.identity, log: nullLog });
    sessionGuest = guest;
    const beaconFs = new BeaconFileSystem(guest, nullLog);
    disposables.push(beaconFs, vscode.workspace.registerFileSystemProvider(SHARE_SCHEME, beaconFs, { isCaseSensitive: true }));

    host.start(groupId, await WorkspaceAccess.create(dir));
    await waitFor(() => !!guest.get(groupId), 'Bob to see the session');
    host.setCanEdit(bob.identity.peerId, true);
    await waitFor(() => guest.get(groupId)?.canEdit === true, 'Bob to get edit access');

    // Bob opens Alice's file through the virtual filesystem and types into it.
    const guestEditor = await vscode.window.showTextDocument(shareUri(groupId, 'app.ts'));
    assert.equal(guestEditor.document.getText(), 'const answer = 42;\n');
    await guestEditor.edit((b) => b.insert(new vscode.Position(0, 0), '// from bob\n'));
    const hostUri = vscode.Uri.file(path.join(dir, 'app.ts'));
    const hostDoc = () => vscode.workspace.textDocuments.find((d) => d.uri.toString() === hostUri.toString());
    await waitFor(() => hostDoc()?.getText() === '// from bob\nconst answer = 42;\n', "Bob's edit in Alice's buffer");

    // Alice types in her own editor; Bob sees it.
    const hostEditor = await vscode.window.showTextDocument(hostUri, { viewColumn: vscode.ViewColumn.Beside });
    await hostEditor.edit((b) => b.insert(hostEditor.document.positionAt(hostEditor.document.getText().length), 'export {};\n'));
    await waitFor(() => guestEditor.document.getText().endsWith('export {};\n'), "Alice's edit in Bob's editor");

    // Bob saves: Alice's buffer is written to her disk.
    assert.ok(await guestEditor.document.save(), 'save from the guest');
    await waitFor(() => !hostDoc()?.isDirty, "Alice's buffer to be saved");
    assert.equal(await fs.readFile(path.join(dir, 'app.ts'), 'utf8'), '// from bob\nconst answer = 42;\nexport {};\n');

    // Without edit access, Bob's typing does not stick and never reaches Alice.
    host.setCanEdit(bob.identity.peerId, false);
    await waitFor(() => guest.get(groupId)?.canEdit === false, 'edit access to be revoked');
    const before = hostDoc()!.getText();
    await guestEditor.edit((b) => b.insert(new vscode.Position(0, 0), 'sneaky '));
    await waitFor(() => guestEditor.document.getText() === before, "Bob's read-only typing to be reverted");
    assert.equal(hostDoc()!.getText(), before);
  } finally {
    sessionHost?.dispose();
    sessionGuest?.dispose();
    for (const d of disposables) d.dispose();
    for (const p of [alice, bob]) {
      p.peers.dispose();
      await p.server.stop();
    }
  }
}

export async function run(): Promise<void> {
  await test('remote Yjs edits reach the editor buffer', async () => {
    const uri = await tempFile('const a = 1;\n');
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = sharedText(doc.getText());
    const binding = new YjsBinding({ uri, text, canEdit: () => true, log: nullLog });
    text.doc!.transact(() => {
      text.insert(0, '// remote\n');
      text.insert(text.length, 'export {};\n');
    });
    await waitFor(() => doc.getText() === text.toString(), 'editor to match Y');
    assert.equal(doc.getText(), '// remote\nconst a = 1;\nexport {};\n');
    binding.dispose();
  });

  await test('local editor edits (including multi-cursor) reach Yjs', async () => {
    const uri = await tempFile('one\ntwo\nthree\n');
    const editor = await vscode.window.showTextDocument(uri);
    const text = sharedText(editor.document.getText());
    const binding = new YjsBinding({ uri, text, canEdit: () => true, log: nullLog });
    await editor.edit((b) => {
      b.insert(new vscode.Position(0, 0), '1:');
      b.insert(new vscode.Position(2, 0), '3:');
    });
    await waitFor(() => text.toString() === editor.document.getText(), 'Y to match editor');
    assert.equal(text.toString(), '1:one\ntwo\n3:three\n');
    binding.dispose();
  });

  await test('typing while remote edits are being applied loses nothing', async () => {
    const uri = await tempFile('0123456789\n');
    const editor = await vscode.window.showTextDocument(uri);
    const text = sharedText(editor.document.getText());
    const binding = new YjsBinding({ uri, text, canEdit: () => true, log: nullLog });
    // Remote edits land without waiting while the user keeps typing. Keystrokes are applied
    // one after another (as real typing is); a keystroke VS Code rejects because the buffer
    // changed under it is retried, like the next key press would be.
    for (let i = 0; i < 10; i++) {
      text.doc!.transact(() => text.insert(0, `R${i}`));
      let typed = false;
      for (let attempt = 0; attempt < 20 && !typed; attempt++) {
        typed = await editor.edit((b) => b.insert(editor.document.positionAt(editor.document.getText().length), `L${i}`));
      }
      assert.ok(typed, `keystroke L${i} was never accepted by the editor`);
    }
    await waitFor(() => editor.document.getText() === text.toString(), 'editor and Y to converge', 6000);
    const final = text.toString();
    for (let i = 0; i < 10; i++) {
      assert.ok(final.includes(`R${i}`), `missing remote edit R${i} in ${JSON.stringify(final)}`);
      assert.ok(final.includes(`L${i}`), `missing local edit L${i} in ${JSON.stringify(final)}`);
    }
    binding.dispose();
  });

  await test('a read-only guest reverts their own typing to the shared text', async () => {
    const uri = await tempFile('shared\n');
    const editor = await vscode.window.showTextDocument(uri);
    const text = sharedText(editor.document.getText());
    const binding = new YjsBinding({ uri, text, canEdit: () => false, log: nullLog });
    let localYChanges = 0;
    text.doc!.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN) localYChanges++;
    });
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'nope '));
    await waitFor(() => editor.document.getText() === 'shared\n', 'local change to be reverted');
    assert.equal(localYChanges, 0);
    binding.dispose();
  });

  await test('applyEdit works on a document whose provider marks it read-only', async () => {
    const reg = vscode.workspace.registerFileSystemProvider('bbtest', new ReadonlyFs(), { isCaseSensitive: true });
    try {
      const uri = vscode.Uri.parse('bbtest://group/file.txt');
      await vscode.window.showTextDocument(uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 5), ' world');
      const applied = await vscode.workspace.applyEdit(edit);
      results.push(`info applyEdit on read-only provider document returned ${applied}; text=${JSON.stringify(doc.getText())}`);
      assert.equal(applied, true, 'remote edits must still apply to read-only guest documents');
      assert.equal(doc.getText(), 'hello world');
    } finally {
      reg.dispose();
    }
  });

  await test('end to end: a guest edits the host’s file through beaconbob:// and saves it', () => sharingEndToEnd());

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const report = results.join('\n');
  await fs.writeFile(process.env.BEACONBOB_VSCODE_REPORT ?? path.join(os.tmpdir(), 'beaconbob-vscode-report.txt'), report);
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error(report);
}
