import * as vscode from 'vscode';
import { type SessionGuest, ShareRequestError } from '../share/sessionGuest';
import { isSharePath, type SharedStat } from '../share/shareProtocol';
import { YjsBinding } from '../sync/yjsBinding';
import type { Log } from '../util/logger';

export const SHARE_SCHEME = 'beaconbob';

/** `beaconbob://<groupId>/<path>`: the group id picks the session, the path is shared-relative. */
export function shareUri(groupId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SHARE_SCHEME, authority: groupId, path: `/${path}` });
}

export function parseShareUri(uri: vscode.Uri): { groupId: string; path: string } | undefined {
  if (uri.scheme !== SHARE_SCHEME) return undefined;
  const path = uri.path.replace(/^\/+/, '').replace(/\/+$/, '');
  return isSharePath(path) ? { groupId: uri.authority, path } : undefined;
}

function toFsError(err: unknown, uri: vscode.Uri): Error {
  if (!(err instanceof ShareRequestError)) return vscode.FileSystemError.Unavailable(uri);
  switch (err.code) {
    case 'not-found':
      return vscode.FileSystemError.FileNotFound(uri);
    case 'not-a-file':
      return vscode.FileSystemError.FileIsADirectory(uri);
    case 'not-a-directory':
      return vscode.FileSystemError.FileNotADirectory(uri);
    case 'forbidden':
    case 'read-only':
      return vscode.FileSystemError.NoPermissions(uri);
    case 'too-large':
      return vscode.FileSystemError.NoPermissions('This file is too large to share (over 512 KB).');
    default:
      return vscode.FileSystemError.Unavailable(err.message);
  }
}

const READ_ONLY_HINT = new vscode.MarkdownString('Read-only: ask the host for edit access.');

/**
 * Serves the host's shared folder to a guest. Text files are backed by the shared Yjs
 * document (so what you open is the live buffer, including the host's unsaved changes);
 * other files are fetched as bytes. Saving asks the host to save its buffer.
 */
export class BeaconFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly bindings = new Map<string, YjsBinding>();
  /** Documents opened by `readFile` that no editor has claimed yet. */
  private readonly unclaimed = new Map<string, NodeJS.Timeout>();
  private readonly mtimes = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly offGuest: Array<() => void> = [];

  constructor(
    private readonly guest: SessionGuest,
    private readonly log: Log,
  ) {
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.bind(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.unbind(doc.uri)),
    );
    this.offGuest.push(
      guest.on('fsChanged', (groupId, paths) => {
        this.changes.fire(paths.map((p) => ({ type: vscode.FileChangeType.Changed, uri: shareUri(groupId, p) })));
      }),
      guest.on('docReset', (groupId, path) => {
        const text = guest.text(groupId, path);
        if (text) this.bindings.get(shareUri(groupId, path).toString())?.reset(text);
      }),
      guest.on('changed', () => {
        // Edit access may have changed: let VS Code re-check permissions of open files.
        const uris = [...this.bindings.values()].map((b) => b.uri);
        if (uris.length > 0) this.changes.fire(uris.map((uri) => ({ type: vscode.FileChangeType.Changed, uri })));
      }),
      guest.on('ended', (groupId) => {
        for (const [key, binding] of this.bindings) {
          if (parseShareUri(binding.uri)?.groupId !== groupId) continue;
          binding.dispose();
          this.bindings.delete(key);
        }
        this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri: shareUri(groupId, '') }]);
      }),
    );
    for (const doc of vscode.workspace.textDocuments) this.bind(doc);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const target = this.target(uri);
    const session = this.guest.get(target.groupId);
    const permissions = session?.canEdit ? undefined : vscode.FilePermission.Readonly;
    if (target.path === '') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0, permissions };
    }
    const text = this.guest.text(target.groupId, target.path);
    if (text) {
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: this.mtimes.get(uri.toString()) ?? 0,
        size: Buffer.byteLength(text.toString()),
        permissions,
      };
    }
    const stat = await this.request(uri, 'stat').then((r) => r.stat as SharedStat);
    return {
      type: stat.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: stat.ctime,
      mtime: stat.mtime,
      size: stat.size,
      permissions,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> {
    const { entries = [] } = await this.request(uri, 'readDir');
    return entries.map((e) => [e.name, e.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { groupId, path } = this.target(uri);
    try {
      const text = await this.guest.openDoc(groupId, path);
      this.markUnclaimed(uri);
      return Buffer.from(text.toString(), 'utf8');
    } catch (err) {
      if (err instanceof ShareRequestError && err.code === 'binary') {
        const { dataB64 = '' } = await this.request(uri, 'read');
        return Buffer.from(dataB64, 'base64');
      }
      throw toFsError(err, uri);
    }
  }

  async writeFile(uri: vscode.Uri): Promise<void> {
    const { groupId, path } = this.target(uri);
    const session = this.guest.get(groupId);
    if (!session) throw vscode.FileSystemError.Unavailable('The sharing session has ended.');
    if (!session.canEdit) throw vscode.FileSystemError.NoPermissions(READ_ONLY_HINT.value);
    if (!this.guest.text(groupId, path)) {
      throw vscode.FileSystemError.NoPermissions('Only open text files can be saved to the host.');
    }
    await this.request(uri, 'save');
    this.mtimes.set(uri.toString(), Date.now());
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Only the host can create, delete, or rename shared files.');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Only the host can create, delete, or rename shared files.');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Only the host can create, delete, or rename shared files.');
  }

  dispose(): void {
    for (const binding of this.bindings.values()) binding.dispose();
    this.bindings.clear();
    for (const timer of this.unclaimed.values()) clearTimeout(timer);
    for (const s of this.subscriptions) s.dispose();
    for (const off of this.offGuest) off();
    this.changes.dispose();
  }

  private target(uri: vscode.Uri): { groupId: string; path: string } {
    const target = parseShareUri(uri);
    if (!target) throw vscode.FileSystemError.FileNotFound(uri);
    if (!this.guest.get(target.groupId)) throw vscode.FileSystemError.Unavailable('The sharing session has ended.');
    return target;
  }

  private async request(uri: vscode.Uri, op: 'stat' | 'readDir' | 'read' | 'save') {
    const { groupId, path } = this.target(uri);
    try {
      return await this.guest.request(groupId, op, path);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  private bind(doc: vscode.TextDocument): void {
    const target = parseShareUri(doc.uri);
    if (!target) return;
    const key = doc.uri.toString();
    clearTimeout(this.unclaimed.get(key));
    this.unclaimed.delete(key);
    if (this.bindings.has(key)) return;
    const text = this.guest.text(target.groupId, target.path);
    if (!text) return;
    text.doc?.on('update', () => this.mtimes.set(key, Date.now()));
    this.bindings.set(
      key,
      new YjsBinding({
        uri: doc.uri,
        text,
        canEdit: () => this.guest.get(target.groupId)?.canEdit ?? false,
        log: this.log,
      }),
    );
  }

  private unbind(uri: vscode.Uri): void {
    const target = parseShareUri(uri);
    const key = uri.toString();
    const binding = this.bindings.get(key);
    if (!target || !binding) return;
    binding.dispose();
    this.bindings.delete(key);
    this.guest.closeDoc(target.groupId, target.path);
  }

  /** VS Code sometimes reads files without opening an editor; don't stay subscribed forever. */
  private markUnclaimed(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.bindings.has(key) || this.unclaimed.has(key)) return;
    const timer = setTimeout(() => {
      this.unclaimed.delete(key);
      const target = parseShareUri(uri);
      const open = vscode.workspace.textDocuments.some((d) => d.uri.toString() === key);
      if (target && !open && !this.bindings.has(key)) this.guest.closeDoc(target.groupId, target.path);
    }, 10_000);
    this.unclaimed.set(key, timer);
  }
}
