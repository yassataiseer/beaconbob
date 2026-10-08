// Runs the bundled extension in a plain Node process against a minimal stand-in for the
// `vscode` API, driven over IPC by test/extension.e2e.test.ts. One process per simulated peer.
const Module = require('node:module');
const path = require('node:path');

const send = (event, data) => process.send?.({ event, ...data });
const disposable = { dispose() {} };
const listeners = { webviewMessage: [], visibility: [] };
let provider;
let promptAnswer = process.env.BEACONBOB_TEST_ANSWER ?? 'Accept';

function uri(fsPath) {
  return { fsPath, path: fsPath, scheme: 'file', toString: () => `file://${fsPath}` };
}

const log = (level) => (msg, ...args) => {
  if (process.env.BEACONBOB_TEST_VERBOSE) process.stderr.write(`[${process.env.BEACONBOB_DISPLAY_NAME}] ${level} ${msg} ${args.join(' ')}\n`);
};

const vscode = {
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
  window: {
    createOutputChannel: () => ({ debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), show() {}, dispose() {} }),
    showWarningMessage: async (message, options, ...items) => {
      send('prompt', { message, detail: options?.detail, items });
      // Clicks the prompt's action button, whatever it is labelled.
      return promptAnswer === 'Accept' ? items[0] : undefined;
    },
    // Notifications resolve to undefined, as if the user dismissed them without clicking.
    showErrorMessage: async (message) => {
      send('notify', { level: 'error', message });
      return undefined;
    },
    showInformationMessage: async (message) => {
      send('notify', { level: 'info', message });
      return undefined;
    },
    showQuickPick: async (items) => items[0],
    registerWebviewViewProvider: (_viewType, p) => {
      provider = p;
      return disposable;
    },
  },
  commands: { registerCommand: () => disposable },
  workspace: {
    name: `${process.env.BEACONBOB_DISPLAY_NAME}-workspace`,
    getConfiguration: () => ({ get: (key) => (key === 'portRange' ? process.env.BEACONBOB_TEST_PORTS : undefined) }),
    onDidChangeConfiguration: () => disposable,
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, ...rest);
};

const extension = require(path.resolve(__dirname, '../../dist/extension.js'));

function resolveView() {
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (u) => u,
    onDidReceiveMessage: (cb) => (listeners.webviewMessage.push(cb), disposable),
    postMessage: async (msg) => (send('state', { state: msg.state }), true),
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: (cb) => (listeners.visibility.push(cb), disposable),
    onDidDispose: () => disposable,
  };
  provider.resolveWebviewView(view);
  return webview;
}

process.on('message', async (msg) => {
  try {
    if (msg.cmd === 'activate') {
      const context = {
        subscriptions: [],
        globalStorageUri: uri(process.env.BEACONBOB_TEST_STORAGE),
        extensionUri: uri(path.resolve(__dirname, '../..')),
        extension: { packageJSON: { version: '0.1.0-test' } },
      };
      await extension.activate(context);
      const webview = resolveView();
      send('activated', { html: webview.html });
      for (const cb of listeners.webviewMessage) cb({ type: 'ready' });
    } else if (msg.cmd === 'webview') {
      for (const cb of listeners.webviewMessage) cb(msg.msg);
    } else if (msg.cmd === 'answer') {
      promptAnswer = msg.answer;
    } else if (msg.cmd === 'deactivate') {
      await extension.deactivate();
      send('deactivated', {});
      process.exit(0);
    }
  } catch (err) {
    send('error', { message: String(err?.stack ?? err) });
  }
});

send('ready', {});
