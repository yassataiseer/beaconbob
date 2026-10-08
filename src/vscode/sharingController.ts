import * as vscode from 'vscode';
import type { GroupHost } from '../groups/groupHost';
import type { GroupMember } from '../groups/groupMember';
import type { Identity } from '../security/identity';
import { SessionGuest } from '../share/sessionGuest';
import { SessionHost } from '../share/sessionHost';
import { DEFAULT_SHARING_EXCLUDES, WorkspaceAccess } from '../share/workspaceAccess';
import type { PeerManager } from '../transport/peerManager';
import type { SharingView } from '../ui/ipcTypes';
import { type Log, scoped } from '../util/logger';
import { BeaconFileSystem, SHARE_SCHEME, shareUri } from './beaconFs';
import { VscodeHostAdapter } from './hostAdapter';
import { SharingPresence } from './presence';
import { SharedFilesTree } from './sharedFilesTree';

export interface SharingControllerOptions {
  peers: PeerManager;
  groupHost: GroupHost;
  member: GroupMember;
  identity: Identity;
  displayName: () => string;
  log: Log;
  /** Something the sidebar shows changed. */
  onChange: () => void;
}

/** Everything about workspace sharing that touches the editor, in one place. */
export class SharingController implements vscode.Disposable {
  readonly host: SessionHost;
  readonly guest: SessionGuest;
  private readonly fs: BeaconFileSystem;
  private readonly tree: SharedFilesTree;
  private readonly presence: SharingPresence;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly offs: Array<() => void> = [];
  private watcher: vscode.Disposable | undefined;
  private pendingChanges = new Set<string>();
  private changeTimer: NodeJS.Timeout | undefined;
  private readonly mounted = new Set<string>();
  private presenceSignature = '';

  constructor(private readonly opts: SharingControllerOptions) {
    const log = scoped(opts.log, 'share');
    this.host = new SessionHost({
      peers: opts.peers,
      groups: opts.groupHost,
      identity: opts.identity,
      adapter: new VscodeHostAdapter(() => this.host.access, log),
      log,
    });
    this.guest = new SessionGuest({ peers: opts.peers, groups: opts.member, identity: opts.identity, log });
    this.fs = new BeaconFileSystem(this.guest, log);
    this.tree = new SharedFilesTree(
      this.guest,
      this.fs,
      (groupId) => this.nameOf(opts.member.group(groupId)?.hostId ?? '') ?? 'Host',
      (groupId) => opts.member.group(groupId)?.name ?? 'group',
    );
    this.presence = new SharingPresence({
      host: this.host,
      guest: this.guest,
      selfId: opts.identity.peerId,
      selfName: opts.displayName,
      nameOf: (peerId) => this.nameOf(peerId),
    });

    this.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(SHARE_SCHEME, this.fs, { isCaseSensitive: true }),
      vscode.window.registerTreeDataProvider('beaconbob.sharedFiles', this.tree),
      this.fs,
      this.tree,
      this.presence,
      this.presence.onDidChange(() => this.onPresenceChange()),
    );
    this.offs.push(
      this.host.on('changed', () => {
        this.syncWatcher();
        opts.onChange();
      }),
      this.guest.on('changed', () => {
        void vscode.commands.executeCommand('setContext', 'beaconbob.hasSharedFiles', this.guest.list().length > 0);
        opts.onChange();
      }),
      this.guest.on('ended', (groupId) => this.unmount(groupId)),
    );
  }

  /** What the sidebar shows about sharing in a group's conversation. */
  view(groupId: string, isHost: boolean): SharingView | null {
    const participants = this.presence.participants(groupId).map((p) => ({ ...p }));
    if (isHost) {
      const active = this.host.active;
      const here = active?.groupId === groupId;
      let cannotShareReason: string | null = null;
      if (active && !here) cannotShareReason = 'You are already sharing your workspace with another group.';
      else if (!this.shareableFolder()) cannotShareReason = 'Open a folder in this window to share it.';
      return {
        active: here,
        rootName: here ? active.rootName : (this.shareableFolder()?.name ?? null),
        isHost: true,
        hostName: this.opts.displayName(),
        canEdit: true,
        editors: here ? active.editors : [],
        participants: here ? participants : [],
        cannotShareReason,
        canMount: false,
      };
    }
    const session = this.guest.get(groupId);
    const hostId = this.opts.member.group(groupId)?.hostId ?? '';
    if (!session) {
      return {
        active: false,
        rootName: null,
        isHost: false,
        hostName: this.nameOf(hostId) ?? 'The host',
        canEdit: false,
        editors: [],
        participants: [],
        cannotShareReason: null,
        canMount: false,
      };
    }
    return {
      active: true,
      rootName: session.rootName,
      isHost: false,
      hostName: this.nameOf(session.hostId) ?? 'The host',
      canEdit: session.canEdit,
      editors: [],
      participants,
      cannotShareReason: null,
      canMount: (vscode.workspace.workspaceFolders?.length ?? 0) > 0 && !this.mounted.has(groupId),
    };
  }

  async startSharing(groupId: string): Promise<void> {
    const folder = this.shareableFolder();
    if (!folder) throw new Error('Open a folder in this window to share it.');
    const excludes = vscode.workspace.getConfiguration('beaconbob').get<string[]>('sharing.exclude') ?? DEFAULT_SHARING_EXCLUDES;
    const access = await WorkspaceAccess.create(folder.uri.fsPath, excludes);
    this.host.start(groupId, access);
  }

  stopSharing(): void {
    this.host.stop();
  }

  setCanEdit(peerId: string, canEdit: boolean): void {
    this.host.setCanEdit(peerId, canEdit);
  }

  async openSharedFiles(): Promise<void> {
    await vscode.commands.executeCommand('beaconbob.sharedFiles.focus');
  }

  /** Adds the shared folder to the Explorer. Needs a folder already open (see `view`). */
  mount(groupId: string): void {
    const session = this.guest.get(groupId);
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!session) throw new Error('That sharing session has ended.');
    if (folders.length === 0) {
      throw new Error('Open a folder first: adding the shared folder to an empty window would restart BeaconBob.');
    }
    const uri = shareUri(groupId, '');
    if (folders.some((f) => f.uri.toString() === uri.toString())) return;
    const name = `${this.nameOf(session.hostId) ?? 'Host'}: ${session.rootName}`;
    if (vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name })) this.mounted.add(groupId);
    this.opts.onChange();
  }

  follow(groupId: string, peerId: string): Promise<boolean> {
    return this.presence.follow(groupId, peerId);
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
    this.watcher?.dispose();
    for (const groupId of [...this.mounted]) this.unmount(groupId);
    this.host.dispose();
    this.guest.dispose();
    for (const off of this.offs) off();
    for (const s of this.subscriptions) s.dispose();
  }

  // --- Internals -----------------------------------------------------------------------------

  private shareableFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
  }

  private nameOf(peerId: string): string | undefined {
    if (!peerId) return undefined;
    if (peerId === this.opts.identity.peerId) return this.opts.displayName();
    for (const g of this.opts.groupHost.hosted()) {
      const m = g.members.find((x) => x.peerId === peerId);
      if (m) return m.name;
    }
    for (const g of this.opts.member.joined()) {
      const m = g.members.find((x) => x.peerId === peerId);
      if (m) return m.name;
    }
    return this.opts.peers.remote(peerId)?.name;
  }

  private onPresenceChange(): void {
    // Cursor moves fire constantly; the sidebar only cares who is in which file.
    const signature = [this.host.active?.groupId, ...this.guest.list().map((s) => s.groupId)]
      .filter((g): g is string => !!g)
      .flatMap((g) => this.presence.participants(g).map((p) => `${g}:${p.peerId}:${p.activeFile}`))
      .join('|');
    if (signature === this.presenceSignature) return;
    this.presenceSignature = signature;
    this.opts.onChange();
  }

  /** Watches the shared folder while sharing, so guests hear about changes on disk. */
  private syncWatcher(): void {
    const active = this.host.active;
    if (!active) {
      this.watcher?.dispose();
      this.watcher = undefined;
      return;
    }
    if (this.watcher) return;
    const pattern = new vscode.RelativePattern(vscode.Uri.file(active.root), '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = (uri: vscode.Uri) => {
      const access = this.host.access;
      const rel = access?.toRelative(uri.fsPath);
      if (!access || rel === undefined) return;
      if (rel === '.gitignore') void access.reloadIgnore();
      this.pendingChanges.add(rel);
      // The parent listing changes too when files appear or disappear.
      this.pendingChanges.add(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
      clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => {
        const paths = [...this.pendingChanges];
        this.pendingChanges = new Set();
        this.host.notifyChanged(paths);
      }, 300);
    };
    this.watcher = vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(onChange),
      watcher.onDidChange(onChange),
      watcher.onDidDelete(onChange),
    );
  }

  private unmount(groupId: string): void {
    if (!this.mounted.delete(groupId)) return;
    const uri = shareUri(groupId, '').toString();
    const index = vscode.workspace.workspaceFolders?.findIndex((f) => f.uri.toString() === uri) ?? -1;
    if (index >= 0) vscode.workspace.updateWorkspaceFolders(index, 1);
  }
}
