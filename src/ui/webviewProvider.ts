import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromWebview, ToWebview, UiState } from './ipcTypes';
import { parseFromWebview } from './webviewMessages';

/** Hosts the React sidebar (peers, groups, conversations) built by Vite into `dist/webview`. */
export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'beaconbob.sidebar';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => UiState,
    private readonly onMessage: (msg: FromWebview) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const assets = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
    view.webview.html = this.html(view.webview, assets);
    view.webview.onDidReceiveMessage((raw) => {
      const msg = parseFromWebview(raw);
      if (!msg) return;
      if (msg.type === 'ready') this.postState();
      else this.onMessage(msg);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.postState();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  postState(): void {
    const view = this.view;
    if (!view) return;
    const msg: ToWebview = { type: 'state', state: this.getState() };
    void view.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, assets: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>BeaconBob</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
