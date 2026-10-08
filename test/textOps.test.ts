import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyChanges, applyChangesToYText, deltaToChanges, diffHunk, reconcile } from '../src/sync/textOps';

function ytext(initial: string): Y.Text {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, initial);
  return text;
}

/** Records the delta of the next change to `text`. */
function captureDelta(text: Y.Text, change: () => void) {
  let delta: unknown[] = [];
  const observer = (e: Y.YTextEvent) => {
    delta = e.delta;
  };
  text.observe(observer);
  change();
  text.unobserve(observer);
  return delta as Parameters<typeof deltaToChanges>[0];
}

describe('deltaToChanges', () => {
  it('turns a Y delta into changes against the old text', () => {
    const text = ytext('hello world');
    const before = text.toString();
    const delta = captureDelta(text, () =>
      text.doc!.transact(() => {
        text.delete(0, 5);
        text.insert(0, 'howdy');
        text.insert(text.length, '!');
      }),
    );
    const changes = deltaToChanges(delta);
    expect(applyChanges(before, changes)).toBe(text.toString());
    expect(changes).toEqual([
      { offset: 0, deleteLength: 5, insertText: 'howdy' },
      { offset: 11, deleteLength: 0, insertText: '!' },
    ]);
  });

  it('handles several separate edits in one transaction', () => {
    const text = ytext('a-b-c-d');
    const before = text.toString();
    const delta = captureDelta(text, () =>
      text.doc!.transact(() => {
        text.delete(6, 1);
        text.insert(4, 'X');
        text.delete(0, 2);
      }),
    );
    expect(applyChanges(before, deltaToChanges(delta))).toBe(text.toString());
  });
});

describe('applyChangesToYText', () => {
  it('applies multi-cursor style changes (all against the old text)', () => {
    const text = ytext('one two three');
    const changes = [
      { offset: 8, deleteLength: 5, insertText: '3' },
      { offset: 0, deleteLength: 3, insertText: '1' },
      { offset: 4, deleteLength: 3, insertText: '2' },
    ];
    const expected = applyChanges(text.toString(), changes);
    applyChangesToYText(text, changes);
    expect(text.toString()).toBe(expected);
    expect(expected).toBe('1 2 3');
  });

  it('keeps CRLF line endings intact', () => {
    const text = ytext('a\r\nb\r\n');
    applyChangesToYText(text, [{ offset: 3, deleteLength: 0, insertText: 'x\r\n' }]);
    expect(text.toString()).toBe('a\r\nx\r\nb\r\n');
  });
});

describe('diffHunk', () => {
  it('finds the single changed region', () => {
    expect(diffHunk('abcdef', 'abXYef')).toEqual({ offset: 2, deleteLength: 2, insertText: 'XY' });
    expect(diffHunk('abc', 'abc')).toBeNull();
    expect(diffHunk('', 'new')).toEqual({ offset: 0, deleteLength: 0, insertText: 'new' });
    expect(diffHunk('aaa', 'aaaa')).toEqual({ offset: 3, deleteLength: 0, insertText: 'a' });
  });

  it('never splits a surrogate pair (emoji)', () => {
    const a = 'x😀y';
    const b = 'x😃y';
    const hunk = diffHunk(a, b)!;
    expect(hunk).toEqual({ offset: 1, deleteLength: 2, insertText: '😃' });
    expect(applyChanges(a, [hunk])).toBe(b);
  });
});

describe('reconcile', () => {
  it('merges a local edit with a remote edit elsewhere', () => {
    const base = 'line one\nline two\n';
    const local = 'LINE one\nline two\n';
    const remote = 'line one\nline two\nline three\n';
    const { toRemote, merged } = reconcile(base, local, remote);
    expect(merged).toBe('LINE one\nline two\nline three\n');
    expect(applyChanges(remote, [toRemote!])).toBe(merged);
  });

  it('shifts a local edit that comes after the remote one', () => {
    const { merged } = reconcile('abc', 'abcX', 'Rabc');
    expect(merged).toBe('RabcX');
  });

  it('keeps the local edit when nothing changed remotely, and vice versa', () => {
    expect(reconcile('abc', 'abXc', 'abc')).toEqual({
      toRemote: { offset: 2, deleteLength: 0, insertText: 'X' },
      merged: 'abXc',
    });
    expect(reconcile('abc', 'abc', 'abRc')).toEqual({ toRemote: null, merged: 'abRc' });
  });

  it('keeps both sides when they edit the same spot', () => {
    const { merged } = reconcile('hello', 'hello!', 'hello?');
    expect(merged).toContain('!');
    expect(merged).toContain('?');
  });

  it('typing into a region the remote deleted still lands', () => {
    const { merged } = reconcile('keep DELETE keep', 'keep DELETEtyped keep', 'keep  keep');
    expect(merged).toContain('typed');
    expect(merged).not.toContain('DELETE');
  });
});
