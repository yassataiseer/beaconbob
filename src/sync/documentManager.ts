import * as Y from 'yjs';
import { fromB64, toB64 } from '../share/shareProtocol';
import { Emitter } from '../util/events';

/** Origin for changes made by the local editor (as opposed to applied from the network). */
export const LOCAL_ORIGIN = Symbol('local-editor');
/** Origin for loading a document's initial content. */
export const INIT_ORIGIN = Symbol('init');

const TEXT_KEY = 'content';

type DocEvents = {
  /** A document changed; `origin` says who changed it. */
  update: [path: string, update: Uint8Array, origin: unknown];
  /** A document was replaced wholesale (the host re-sent it); bindings must re-attach. */
  reset: [path: string, text: Y.Text];
  removed: [path: string];
};

/** One Y.Doc per shared file path. Used on both the host and the guest side. */
export class DocumentManager extends Emitter<DocEvents> {
  private readonly docs = new Map<string, Y.Doc>();

  has(path: string): boolean {
    return this.docs.has(path);
  }

  paths(): string[] {
    return [...this.docs.keys()];
  }

  text(path: string): Y.Text | undefined {
    return this.docs.get(path)?.getText(TEXT_KEY);
  }

  doc(path: string): Y.Doc | undefined {
    return this.docs.get(path);
  }

  /** Creates the document for `path` with `initial` text (host side). */
  create(path: string, initial = ''): Y.Text {
    const existing = this.text(path);
    if (existing) return existing;
    const doc = this.track(path, new Y.Doc());
    const text = doc.getText(TEXT_KEY);
    if (initial) doc.transact(() => text.insert(0, initial), INIT_ORIGIN);
    return text;
  }

  /** Creates or replaces the document for `path` from the host's full state (guest side). */
  load(path: string, stateB64: string): Y.Text {
    const previous = this.docs.get(path);
    const doc = this.track(path, new Y.Doc());
    Y.applyUpdate(doc, fromB64(stateB64), INIT_ORIGIN);
    const text = doc.getText(TEXT_KEY);
    if (previous) {
      previous.destroy();
      this.emit('reset', path, text);
    }
    return text;
  }

  applyUpdate(path: string, updateB64: string, origin: unknown): boolean {
    const doc = this.docs.get(path);
    if (!doc) return false;
    try {
      Y.applyUpdate(doc, fromB64(updateB64), origin);
      return true;
    } catch {
      return false;
    }
  }

  encodeState(path: string): string | undefined {
    const doc = this.docs.get(path);
    return doc ? toB64(Y.encodeStateAsUpdate(doc)) : undefined;
  }

  delete(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    this.docs.delete(path);
    doc.destroy();
    this.emit('removed', path);
  }

  clear(): void {
    for (const path of this.paths()) this.delete(path);
  }

  private track(path: string, doc: Y.Doc): Y.Doc {
    this.docs.set(path, doc);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (this.docs.get(path) === doc) this.emit('update', path, update, origin);
    });
    return doc;
  }
}
