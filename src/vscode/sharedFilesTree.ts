import * as vscode from 'vscode';
import type { SessionGuest } from '../share/sessionGuest';
import { type BeaconFileSystem, shareUri } from './beaconFs';

interface Node {
  groupId: string;
  path: string;
  type: 'root' | 'directory' | 'file';
  label: string;
}

/** "Shared files" view: every workspace someone is sharing with you, browsable and openable. */
export class SharedFilesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly offGuest: Array<() => void> = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly guest: SessionGuest,
    private readonly fs: BeaconFileSystem,
    private readonly hostName: (groupId: string) => string,
    private readonly groupName: (groupId: string) => string,
  ) {
    const refresh = () => this.refresh();
    this.offGuest.push(guest.on('changed', refresh), guest.on('ended', refresh), guest.on('fsChanged', refresh));
  }

  refresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.changed.fire(undefined), 200);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const uri = shareUri(node.groupId, node.path);
    if (node.type === 'file') {
      const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
      return item;
    }
    if (node.type === 'directory') return new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Collapsed);
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    const access = this.guest.get(node.groupId)?.canEdit ? '' : ' · read-only';
    item.description = `${this.hostName(node.groupId)} · #${this.groupName(node.groupId)}${access}`;
    item.iconPath = new vscode.ThemeIcon('remote');
    item.contextValue = 'beaconbobSharedRoot';
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.guest.list().map((s) => ({ groupId: s.groupId, path: '', type: 'root', label: s.rootName }));
    }
    if (node.type === 'file') return [];
    try {
      const entries = await this.fs.readDirectory(shareUri(node.groupId, node.path));
      return entries
        .map(([name, type]): Node => ({
          groupId: node.groupId,
          path: node.path ? `${node.path}/${name}` : name,
          type: type === vscode.FileType.Directory ? 'directory' : 'file',
          label: name,
        }))
        .sort((a, b) => (a.type === b.type ? a.label.localeCompare(b.label) : a.type === 'directory' ? -1 : 1));
    } catch {
      return [];
    }
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const off of this.offGuest) off();
    this.changed.dispose();
  }
}
