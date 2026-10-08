import * as vscode from 'vscode';

export interface RemoteCaret {
  peerId: string;
  name: string;
  color: string;
  anchor: vscode.Position;
  head: vscode.Position;
}

interface ColorTypes {
  selection: vscode.TextEditorDecorationType;
  caret: vscode.TextEditorDecorationType;
}

/** Draws other people's selections and carets (with a name flag) in visible editors. */
export class DecorationManager implements vscode.Disposable {
  private readonly types = new Map<string, ColorTypes>();
  /** Which colours each editor currently shows, so stale ones can be cleared. */
  private readonly shown = new Map<vscode.TextEditor, Set<string>>();

  render(editor: vscode.TextEditor, carets: RemoteCaret[]): void {
    const byColor = new Map<string, RemoteCaret[]>();
    for (const c of carets) byColor.set(c.color, [...(byColor.get(c.color) ?? []), c]);

    const previous = this.shown.get(editor) ?? new Set<string>();
    for (const color of previous) {
      if (byColor.has(color)) continue;
      const types = this.types.get(color);
      if (types) {
        editor.setDecorations(types.selection, []);
        editor.setDecorations(types.caret, []);
      }
    }

    for (const [color, group] of byColor) {
      const types = this.typesFor(color);
      editor.setDecorations(
        types.selection,
        group
          .filter((c) => !c.anchor.isEqual(c.head))
          .map((c) => ({ range: new vscode.Range(c.anchor, c.head), hoverMessage: c.name })),
      );
      editor.setDecorations(
        types.caret,
        group.map((c) => ({
          range: new vscode.Range(c.head, c.head),
          hoverMessage: c.name,
          renderOptions: {
            after: {
              contentText: c.name,
              color: '#ffffff',
              backgroundColor: color,
              // Float the name flag above the caret instead of pushing the line's text aside.
              textDecoration:
                'none; position: absolute; top: -1.15em; padding: 0 3px; border-radius: 2px; font-size: 10px; ' +
                'line-height: 1.2em; white-space: nowrap; pointer-events: none; z-index: 10;',
            },
          },
        })),
      );
    }
    this.shown.set(editor, new Set(byColor.keys()));
  }

  clear(editor: vscode.TextEditor): void {
    this.render(editor, []);
    this.shown.delete(editor);
  }

  dispose(): void {
    for (const types of this.types.values()) {
      types.selection.dispose();
      types.caret.dispose();
    }
    this.types.clear();
    this.shown.clear();
  }

  private typesFor(color: string): ColorTypes {
    let types = this.types.get(color);
    if (!types) {
      types = {
        selection: vscode.window.createTextEditorDecorationType({
          backgroundColor: `${color}40`,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
        caret: vscode.window.createTextEditorDecorationType({
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
          before: {
            contentText: '\u200b',
            textDecoration: `none; border-left: 2px solid ${color}; margin-left: -1px; margin-right: -1px;`,
          },
        }),
      };
      this.types.set(color, types);
    }
    return types;
  }
}
