import * as vscode from 'vscode';
import type * as Y from 'yjs';
import type { HostEditorAdapter } from '../share/sessionHost';
import type { WorkspaceAccess } from '../share/workspaceAccess';
import { YjsBinding } from '../sync/yjsBinding';
import type { Log } from '../util/logger';

/**
 * Connects the host's sharing session to the host's real editor: shared documents are bound
 * to the host's `file://` buffers, so guest edits appear there (unsaved, like any edit) and
 * the host's own typing flows out to guests.
 */
export class VscodeHostAdapter implements HostEditorAdapter {
  constructor(
    private readonly access: () => WorkspaceAccess | undefined,
    private readonly log: Log,
  ) {}

  async readText(path: string): Promise<string> {
    return (await vscode.workspace.openTextDocument(this.uri(path))).getText();
  }

  bind(path: string, text: Y.Text): () => void {
    const binding = new YjsBinding({ uri: this.uri(path), text, canEdit: () => true, log: this.log });
    return () => binding.dispose();
  }

  async save(path: string): Promise<void> {
    const uri = this.uri(path);
    const doc =
      vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ??
      (await vscode.workspace.openTextDocument(uri));
    if (!(await doc.save()) && doc.isDirty) throw new Error(`Could not save ${path}`);
  }

  private uri(path: string): vscode.Uri {
    const access = this.access();
    if (!access) throw new Error('Not sharing');
    return vscode.Uri.file(access.absolute(path));
  }
}
