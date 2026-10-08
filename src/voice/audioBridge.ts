import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import { listenInRange, type PortRange } from '../util/network';
import { parseVoiceSignal, type VoiceSignal } from './voiceProtocol';

/** Fixed range so the page keeps the same origin, and the browser remembers mic permission. */
export const VOICE_PORT_RANGE: PortRange = { min: 42580, max: 42599 };

export type MicState = 'unknown' | 'ok' | 'denied' | 'error';
export type PeerAudioState = 'connecting' | 'connected' | 'failed';

/** Extension to page. */
export type ToPage =
  | {
      type: 'call';
      selfId: string;
      selfName: string;
      title: string | null;
      participants: Array<{ peerId: string; name: string }>;
      muted: boolean;
    }
  | { type: 'signal'; from: string; signal: VoiceSignal }
  | { type: 'mute'; muted: boolean }
  | { type: 'replaced' };

/** Page to extension. */
export type FromPage =
  | { type: 'ready'; mic: Exclude<MicState, 'unknown'>; message?: string }
  | { type: 'signal'; to: string; signal: VoiceSignal }
  | { type: 'speaking'; peers: string[] }
  | { type: 'connections'; states: Record<string, PeerAudioState> }
  | { type: 'muted'; muted: boolean }
  | { type: 'leave' };

const PEER_ID = /^p-[0-9a-f]{16}$/;
const SELF = 'self';

export function parseFromPage(raw: string): FromPage | undefined {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof m !== 'object' || m === null) return undefined;
  switch (m.type) {
    case 'ready':
      if (m.mic !== 'ok' && m.mic !== 'denied' && m.mic !== 'error') return undefined;
      return { type: 'ready', mic: m.mic, message: typeof m.message === 'string' ? m.message.slice(0, 200) : undefined };
    case 'signal': {
      const signal = parseVoiceSignal(m.signal);
      return typeof m.to === 'string' && PEER_ID.test(m.to) && signal ? { type: 'signal', to: m.to, signal } : undefined;
    }
    case 'speaking':
      return Array.isArray(m.peers) && m.peers.length <= 16 && m.peers.every((p) => p === SELF || (typeof p === 'string' && PEER_ID.test(p)))
        ? { type: 'speaking', peers: [...(m.peers as string[])] }
        : undefined;
    case 'connections': {
      if (typeof m.states !== 'object' || m.states === null) return undefined;
      const states: Record<string, PeerAudioState> = {};
      for (const [peerId, state] of Object.entries(m.states as Record<string, unknown>).slice(0, 16)) {
        if (PEER_ID.test(peerId) && (state === 'connecting' || state === 'connected' || state === 'failed')) states[peerId] = state;
      }
      return { type: 'connections', states };
    }
    case 'muted':
      return typeof m.muted === 'boolean' ? { type: 'muted', muted: m.muted } : undefined;
    case 'leave':
      return { type: 'leave' };
    default:
      return undefined;
  }
}

const ASSETS: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/voice.js': 'voice.js',
  '/voice.css': 'voice.css',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

type BridgeEvents = { connected: []; disconnected: []; message: [FromPage] };

/**
 * Hosts the companion voice page on 127.0.0.1 and talks to it over a WebSocket. The page runs
 * in the user's normal browser because editor webviews cannot use the microphone.
 *
 * Only that page may connect: the WebSocket needs a random per-session token (passed in the
 * URL fragment, so it never appears in a request line), the Origin must be this server, and
 * the Host header must be 127.0.0.1 (which defeats DNS rebinding).
 */
export class AudioBridge extends Emitter<BridgeEvents> {
  private server: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private socket: WebSocket | undefined;
  private port: number | undefined;
  private readonly token = randomBytes(24).toString('base64url');

  constructor(
    private readonly assetsDir: string,
    private readonly log: Log,
    private readonly range: PortRange = VOICE_PORT_RANGE,
  ) {
    super();
  }

  get isConnected(): boolean {
    return this.socket?.readyState === 1;
  }

  /** The page URL, including the token. */
  get url(): string {
    if (this.port === undefined) throw new Error('Voice bridge is not running');
    return `http://127.0.0.1:${this.port}/#token=${this.token}`;
  }

  async start(): Promise<number> {
    if (this.port !== undefined) return this.port;
    const server = http.createServer((req, res) => void this.serve(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      if (!this.allowSocket(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.adopt(ws));
    });
    this.port = await listenInRange(server, this.range, '127.0.0.1');
    this.server = server;
    this.wss = wss;
    this.log.info(`Voice page available on 127.0.0.1:${this.port}`);
    return this.port;
  }

  send(message: ToPage): boolean {
    if (!this.isConnected) return false;
    this.socket!.send(JSON.stringify(message));
    return true;
  }

  async stop(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  private origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private hostOk(req: http.IncomingMessage): boolean {
    return req.headers.host === `127.0.0.1:${this.port}`;
  }

  private allowSocket(req: http.IncomingMessage): boolean {
    if (!this.hostOk(req) || req.headers.origin !== this.origin()) return false;
    const url = new URL(req.url ?? '/', this.origin());
    if (url.pathname !== '/ws') return false;
    const given = Buffer.from(url.searchParams.get('token') ?? '');
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private adopt(ws: WebSocket): void {
    // One page at a time: a newer tab replaces an older one.
    if (this.socket && this.socket !== ws) {
      const old = this.socket;
      old.send(JSON.stringify({ type: 'replaced' } satisfies ToPage));
      old.close();
    }
    this.socket = ws;
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = parseFromPage(data.toString());
      if (message) this.emit('message', message);
    });
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.emit('disconnected');
    });
    ws.on('error', (err) => this.log.debug(`Voice page socket error: ${err.message}`));
    this.emit('connected');
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.hostOk(req) || req.method !== 'GET') {
      res.writeHead(403).end();
      return;
    }
    const pathname = new URL(req.url ?? '/', this.origin()).pathname;
    const file = ASSETS[pathname];
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await fs.readFile(path.join(this.assetsDir, file));
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'microphone=(self)',
        'content-security-policy': [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self'",
          `connect-src ws://127.0.0.1:${this.port}`,
          "media-src 'self' blob: mediastream:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      });
      res.end(body);
    } catch {
      res.writeHead(500).end();
    }
  }
}
