import * as vscode from 'vscode';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { SessionGuest } from '../share/sessionGuest';
import type { SessionHost } from '../share/sessionHost';
import { colorFor, parseAwarenessState, type PeerAwarenessState } from '../share/shareProtocol';
import { DecorationManager, type RemoteCaret } from '../ui/decorationManager';
import { parseShareUri, shareUri } from './beaconFs';

export interface Participant {
  peerId: string;
  name: string;
  color: string;
  activeFile: string | null;
}

export interface PresenceOptions {
  host: SessionHost;
  guest: SessionGuest;
  selfId: string;
  selfName: () => string;
  /** Name to show for a peer (group membership is more trustworthy than self-reported names). */
  nameOf: (peerId: string) => string | undefined;
}

/** Where an editor sits in a sharing session, if it does. */
interface Placement {
  kind: 'host' | 'guest';
  groupId: string;
  path: string;
  awareness: Awareness;
  text: Y.Text | undefined;
}

function toRelative(text: Y.Text, offset: number): unknown {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, offset));
}

function fromRelative(json: unknown, text: Y.Text): number | undefined {
  try {
    const rel = Y.createRelativePositionFromJSON(json);
    const abs = text.doc ? Y.createAbsolutePositionFromRelativePosition(rel, text.doc) : null;
    return abs && abs.type === text ? abs.index : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Publishes your cursor into every session you take part in, and draws everyone else's
 * cursor in your visible editors. Cursor positions are Yjs relative positions, so they stay
 * attached to the right text while others edit around them.
 */
export class SharingPresence implements vscode.Disposable {
  private readonly decorations = new DecorationManager();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly offs: Array<() => void> = [];
  private hostAwarenessOff: (() => void) | undefined;
  private publishTimer: NodeJS.Timeout | undefined;
  private renderTimer: NodeJS.Timeout | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when anyone's presence (file, cursor) changes. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly opts: PresenceOptions) {
    this.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.schedulePublish()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedulePublish()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRender()),
      vscode.workspace.onDidChangeTextDocument(() => this.scheduleRender()),
      this.decorations,
      this.changed,
    );
    this.offs.push(
      opts.guest.on('awareness', () => this.onAwarenessChange()),
      opts.guest.on('changed', () => this.schedulePublish()),
      opts.host.on('changed', () => {
        this.watchHostAwareness();
        this.schedulePublish();
      }),
    );
    this.watchHostAwareness();
  }

  /** Everyone visible in a session (excluding you), for the sidebar. */
  participants(groupId: string): Participant[] {
    const awareness = this.awarenessFor(groupId);
    if (!awareness) return [];
    const out = new Map<string, Participant>();
    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const state = parseAwarenessState(raw);
      if (!state || state.user.peerId === this.opts.selfId) continue;
      out.set(state.user.peerId, {
        peerId: state.user.peerId,
        name: this.opts.nameOf(state.user.peerId) ?? state.user.name,
        color: colorFor(state.user.peerId),
        activeFile: state.activeFile,
      });
    }
    return [...out.values()];
  }

  /** Opens the file `peerId` is in and jumps to their cursor. */
  async follow(groupId: string, peerId: string): Promise<boolean> {
    const awareness = this.awarenessFor(groupId);
    const state = awareness && this.stateOf(awareness, peerId);
    if (!state?.activeFile) return false;
    const uri = this.uriFor(groupId, state.activeFile);
    if (!uri) return false;
    const editor = await vscode.window.showTextDocument(uri, { preview: false });
    const placement = this.placementOf(editor);
    if (state.cursor && placement?.text) {
      const index = fromRelative(state.cursor.head, placement.text);
      if (index !== undefined) {
        const pos = editor.document.positionAt(index);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
    return true;
  }

  dispose(): void {
    clearTimeout(this.publishTimer);
    clearTimeout(this.renderTimer);
    this.hostAwarenessOff?.();
    for (const off of this.offs) off();
    for (const s of this.subscriptions) s.dispose();
  }

  // --- Publishing ----------------------------------------------------------------------------

  private schedulePublish(): void {
    clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => this.publish(), 50);
  }

  private publish(): void {
    const editor = vscode.window.activeTextEditor;
    const placement = editor && this.placementOf(editor);
    const user = { peerId: this.opts.selfId, name: this.opts.selfName().slice(0, 64), color: colorFor(this.opts.selfId) };
    for (const { groupId, awareness } of this.allAwareness()) {
      const here = placement && placement.groupId === groupId ? placement : undefined;
      let cursor: PeerAwarenessState['cursor'] = null;
      if (here?.text && editor) {
        const doc = editor.document;
        cursor = {
          anchor: toRelative(here.text, doc.offsetAt(editor.selection.anchor)),
          head: toRelative(here.text, doc.offsetAt(editor.selection.active)),
        };
      }
      const state: PeerAwarenessState = { user, activeFile: here?.path ?? null, cursor };
      awareness.setLocalState(state);
    }
    this.scheduleRender();
  }

  // --- Rendering -----------------------------------------------------------------------------

  private onAwarenessChange(): void {
    this.scheduleRender();
    this.changed.fire();
  }

  private scheduleRender(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), 30);
  }

  private render(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const placement = this.placementOf(editor);
      if (!placement?.text) {
        this.decorations.clear(editor);
        continue;
      }
      const carets: RemoteCaret[] = [];
      for (const [clientId, raw] of placement.awareness.getStates()) {
        if (clientId === placement.awareness.clientID) continue;
        const state = parseAwarenessState(raw);
        if (!state?.cursor || state.activeFile !== placement.path || state.user.peerId === this.opts.selfId) continue;
        const anchor = fromRelative(state.cursor.anchor, placement.text);
        const head = fromRelative(state.cursor.head, placement.text);
        if (anchor === undefined || head === undefined) continue;
        const doc = editor.document;
        carets.push({
          peerId: state.user.peerId,
          name: this.opts.nameOf(state.user.peerId) ?? state.user.name,
          color: colorFor(state.user.peerId),
          anchor: doc.positionAt(Math.min(anchor, doc.getText().length)),
          head: doc.positionAt(Math.min(head, doc.getText().length)),
        });
      }
      this.decorations.render(editor, carets);
    }
  }

  // --- Lookup --------------------------------------------------------------------------------

  private watchHostAwareness(): void {
    this.hostAwarenessOff?.();
    this.hostAwarenessOff = undefined;
    const awareness = this.opts.host.awareness;
    if (!awareness) return;
    const handler = () => this.onAwarenessChange();
    awareness.on('change', handler);
    this.hostAwarenessOff = () => awareness.off('change', handler);
  }

  private allAwareness(): Array<{ groupId: string; awareness: Awareness }> {
    const out: Array<{ groupId: string; awareness: Awareness }> = [];
    const hosted = this.opts.host.active;
    if (hosted && this.opts.host.awareness) out.push({ groupId: hosted.groupId, awareness: this.opts.host.awareness });
    for (const s of this.opts.guest.list()) {
      const awareness = this.opts.guest.awareness(s.groupId);
      if (awareness) out.push({ groupId: s.groupId, awareness });
    }
    return out;
  }

  private awarenessFor(groupId: string): Awareness | undefined {
    return this.allAwareness().find((a) => a.groupId === groupId)?.awareness;
  }

  private stateOf(awareness: Awareness, peerId: string): PeerAwarenessState | undefined {
    for (const raw of awareness.getStates().values()) {
      const state = parseAwarenessState(raw);
      if (state?.user.peerId === peerId) return state;
    }
    return undefined;
  }

  private uriFor(groupId: string, path: string): vscode.Uri | undefined {
    const hosted = this.opts.host.active;
    if (hosted?.groupId === groupId && this.opts.host.access) {
      return vscode.Uri.file(this.opts.host.access.absolute(path));
    }
    return this.opts.guest.get(groupId) ? shareUri(groupId, path) : undefined;
  }

  private placementOf(editor: vscode.TextEditor): Placement | undefined {
    const uri = editor.document.uri;
    const shared = parseShareUri(uri);
    if (shared) {
      const awareness = this.opts.guest.awareness(shared.groupId);
      if (!awareness || !shared.path) return undefined;
      return { kind: 'guest', groupId: shared.groupId, path: shared.path, awareness, text: this.opts.guest.text(shared.groupId, shared.path) };
    }
    const hosted = this.opts.host.active;
    const access = this.opts.host.access;
    const awareness = this.opts.host.awareness;
    if (uri.scheme !== 'file' || !hosted || !access || !awareness) return undefined;
    const rel = access.toRelative(uri.fsPath);
    if (!rel || !access.isVisible(rel)) return undefined;
    return { kind: 'host', groupId: hosted.groupId, path: rel, awareness, text: this.opts.host.text(rel) };
  }
}
