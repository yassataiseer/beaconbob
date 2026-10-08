/**
 * Pure conversions between editor text changes and Yjs text edits, plus the three-way
 * reconcile used when the editor and the shared document drift apart. Offsets are UTF-16
 * code units, as in both VS Code and Y.Text.
 */
import type * as Y from 'yjs';

export interface TextChange {
  offset: number;
  deleteLength: number;
  insertText: string;
}

type DeltaOp = { insert?: unknown; delete?: number; retain?: number };

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Converts a Y.Text event delta into changes against the text before the event. */
export function deltaToChanges(delta: readonly DeltaOp[]): TextChange[] {
  const changes: TextChange[] = [];
  let index = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      index += op.retain;
    } else if (op.delete !== undefined) {
      const last = changes.at(-1);
      if (last && last.offset + last.deleteLength === index && last.insertText === '') last.deleteLength += op.delete;
      else changes.push({ offset: index, deleteLength: op.delete, insertText: '' });
      index += op.delete;
    } else if (typeof op.insert === 'string') {
      const last = changes.at(-1);
      if (last && last.offset + last.deleteLength === index) last.insertText += op.insert;
      else changes.push({ offset: index, deleteLength: 0, insertText: op.insert });
    }
  }
  return changes;
}

/** Applies non-overlapping changes that are all expressed against `text`. */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, c.offset) + c.insertText + out.slice(c.offset + c.deleteLength);
  }
  return out;
}

/** Applies editor changes (all against the pre-change text) to a Y.Text, last first. */
export function applyChangesToYText(ytext: Y.Text, changes: readonly TextChange[]): void {
  for (const c of [...changes].sort((a, b) => b.offset - a.offset)) {
    if (c.deleteLength > 0) ytext.delete(c.offset, c.deleteLength);
    if (c.insertText) ytext.insert(c.offset, c.insertText);
  }
}

/** The single changed region between two strings, never splitting a surrogate pair. */
export function diffHunk(a: string, b: string): TextChange | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHighSurrogate(a.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix--;
  return { offset: prefix, deleteLength: a.length - prefix - suffix, insertText: b.slice(prefix, b.length - suffix) };
}

/** Where position `pos` (in the text before `hunk`) ends up after `hunk` is applied. */
function mapThrough(pos: number, hunk: TextChange): number {
  if (pos <= hunk.offset) return pos;
  if (pos >= hunk.offset + hunk.deleteLength) return pos + hunk.insertText.length - hunk.deleteLength;
  return hunk.offset + hunk.insertText.length;
}

/**
 * Three-way merge of single-hunk edits. `base` is the text both sides last agreed on, `local`
 * is the editor now, `remote` is the shared document now. Returns the change to apply to the
 * shared document (in its coordinates) and the merged text both sides should end up with.
 */
export function reconcile(base: string, local: string, remote: string): { toRemote: TextChange | null; merged: string } {
  if (local === remote) return { toRemote: null, merged: remote };
  const localHunk = diffHunk(base, local);
  if (!localHunk) return { toRemote: null, merged: remote };
  const remoteHunk = diffHunk(base, remote);
  if (!remoteHunk) return { toRemote: localHunk, merged: local };
  const start = mapThrough(localHunk.offset, remoteHunk);
  const end = Math.max(start, mapThrough(localHunk.offset + localHunk.deleteLength, remoteHunk));
  const toRemote = { offset: start, deleteLength: end - start, insertText: localHunk.insertText };
  return { toRemote, merged: applyChanges(remote, [toRemote]) };
}
