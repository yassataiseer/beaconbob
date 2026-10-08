import * as vscode from 'vscode';
import type * as Y from 'yjs';
import type { Log } from '../util/logger';
import { LOCAL_ORIGIN } from './documentManager';
import { applyChanges, applyChangesToYText, deltaToChanges, diffHunk, reconcile, type TextChange } from './textOps';

export interface YjsBindingOptions {
  uri: vscode.Uri;
  text: Y.Text;
  /** False for read-only guests: local changes are reverted instead of shared. */
  canEdit: () => boolean;
  log: Log;
}

const DRIFT_CHECK_MS = 300;
const MAX_SYNC_ROUNDS = 5;

/**
 * Keeps a VS Code `TextDocument` and a `Y.Text` identical.
 *
 * `shadow` is the text both sides last agreed on. In the common case changes are applied
 * precisely: a local edit's content changes go straight into Y, and a remote Y event's delta
 * becomes a `WorkspaceEdit`. Applying an edit is asynchronous, so if anything else happens
 * meanwhile (the user keeps typing, more remote edits arrive) the binding falls back to a
 * three-way reconcile of `shadow`, the editor text, and the Y text, which never drops a
 * keystroke. A debounced check repairs any drift that slips through.
 */
export class YjsBinding implements vscode.Disposable {
  private text: Y.Text;
  private shadow: string;
  private applying = false;
  private dirty = false;
  private disposed = false;
  private driftTimer: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly opts: YjsBindingOptions) {
    this.text = opts.text;
    this.shadow = this.document()?.getText() ?? '';
    this.text.observe(this.onRemote);
    this.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => this.onLocal(e)));
    void this.sync();
  }

  get uri(): vscode.Uri {
    return this.opts.uri;
  }

  /** Swaps in a replacement Y.Text (the host re-sent the document); the editor follows it. */
  reset(text: Y.Text): void {
    this.text.unobserve(this.onRemote);
    this.text = text;
    this.text.observe(this.onRemote);
    // Anything local that differs from the host's copy is discarded.
    this.shadow = this.document()?.getText() ?? this.shadow;
    void this.sync(true);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.driftTimer);
    this.text.unobserve(this.onRemote);
    for (const s of this.subscriptions) s.dispose();
  }

  private document(): vscode.TextDocument | undefined {
    const key = this.opts.uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  private async ensureDocument(): Promise<vscode.TextDocument> {
    return this.document() ?? vscode.workspace.openTextDocument(this.opts.uri);
  }

  private onLocal(e: vscode.TextDocumentChangeEvent): void {
    if (this.disposed || e.document.uri.toString() !== this.opts.uri.toString() || e.contentChanges.length === 0) return;
    this.scheduleDriftCheck();
    if (this.applying || this.dirty || !this.opts.canEdit()) {
      this.dirty = true;
      if (!this.applying) void this.sync();
      return;
    }
    const changes: TextChange[] = e.contentChanges.map((c) => ({
      offset: c.rangeOffset,
      deleteLength: c.rangeLength,
      insertText: c.text,
    }));
    this.text.doc?.transact(() => applyChangesToYText(this.text, changes), LOCAL_ORIGIN);
    this.shadow = applyChanges(this.shadow, changes);
  }

  private readonly onRemote = (event: Y.YTextEvent) => {
    if (this.disposed || event.transaction.origin === LOCAL_ORIGIN) return;
    if (this.applying || this.dirty) {
      this.dirty = true;
      if (!this.applying) void this.sync();
      return;
    }
    const changes = deltaToChanges(event.delta);
    if (changes.length === 0) return;
    void this.applyToEditor(changes, applyChanges(this.shadow, changes));
  };

  /** Applies changes expressed against `shadow` to the editor. */
  private async applyToEditor(changes: TextChange[], expected: string): Promise<void> {
    this.applying = true;
    let ok = false;
    try {
      const doc = await this.ensureDocument();
      if (doc.getText() === this.shadow) {
        const edit = new vscode.WorkspaceEdit();
        for (const c of changes) {
          edit.replace(doc.uri, new vscode.Range(doc.positionAt(c.offset), doc.positionAt(c.offset + c.deleteLength)), c.insertText);
        }
        ok = (await vscode.workspace.applyEdit(edit)) && doc.getText() === expected;
      }
    } catch (err) {
      this.opts.log.warn(`Applying a shared edit failed: ${(err as Error).message}`);
    } finally {
      this.applying = false;
    }
    if (ok) this.shadow = expected;
    else this.dirty = true;
    if (this.dirty) await this.sync();
  }

  /**
   * Brings editor and Y back in line. With `remoteWins`, or for read-only guests, the Y text
   * is authoritative; otherwise local and remote changes since `shadow` are merged.
   */
  private async sync(remoteWins = false): Promise<void> {
    if (this.applying || this.disposed) return;
    for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
      this.dirty = false;
      let doc: vscode.TextDocument;
      try {
        doc = await this.ensureDocument();
      } catch {
        return;
      }
      const local = doc.getText();
      const remote = this.text.toString();
      if (local === remote) {
        this.shadow = local;
        return;
      }
      let target = remote;
      if (!remoteWins && this.opts.canEdit()) {
        const { toRemote } = reconcile(this.shadow, local, remote);
        if (toRemote) {
          this.text.doc?.transact(() => applyChangesToYText(this.text, [toRemote]), LOCAL_ORIGIN);
        }
        target = this.text.toString();
      }
      // Every local change up to `local` is now in Y (or deliberately discarded), so `local`
      // is the new common base. If the editor write below fails, the next round must not
      // push those changes a second time.
      this.shadow = local;
      const hunk = diffHunk(local, target);
      if (!hunk) {
        this.shadow = target;
        return;
      }
      this.applying = true;
      let ok = false;
      try {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(hunk.offset), doc.positionAt(hunk.offset + hunk.deleteLength)), hunk.insertText);
        ok = await vscode.workspace.applyEdit(edit);
      } catch (err) {
        this.opts.log.warn(`Re-syncing a shared document failed: ${(err as Error).message}`);
      } finally {
        this.applying = false;
      }
      if (ok) this.shadow = target;
      if (ok && doc.getText() === target && !this.dirty) return;
      // Something changed while we were applying; go round again from the new state.
    }
    this.opts.log.warn(`Could not settle ${this.opts.uri.toString()} after ${MAX_SYNC_ROUNDS} attempts; will retry on the next change.`);
    this.scheduleDriftCheck();
  }

  private scheduleDriftCheck(): void {
    clearTimeout(this.driftTimer);
    this.driftTimer = setTimeout(() => {
      const doc = this.document();
      if (!this.applying && doc && doc.getText() !== this.text.toString()) void this.sync();
    }, DRIFT_CHECK_MS);
  }
}
