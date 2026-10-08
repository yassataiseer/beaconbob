import { useEffect, useState } from 'react';
import type { FromWebview, ToWebview, UiState } from '../../../src/ui/ipcTypes';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi may only be called once per webview.
const vscode: VsCodeApi = acquireVsCodeApi();

export function post(message: FromWebview): void {
  vscode.postMessage(message);
}

/** Latest state pushed by the extension host; `undefined` until the first snapshot arrives. */
export function useExtensionState(): UiState | undefined {
  const [state, setState] = useState<UiState>();

  useEffect(() => {
    const onMessage = (event: MessageEvent<ToWebview>) => {
      if (event.data?.type === 'state') setState(event.data.state);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return state;
}
