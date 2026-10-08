import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { nullLog } from '../src/util/logger';
import { AudioBridge, parseFromPage } from '../src/voice/audioBridge';
import { waitFor } from './helpers';

const assets = path.resolve(__dirname, '../media/voice');
const bridges: AudioBridge[] = [];
let base = 47700;

async function bridge(): Promise<{ bridge: AudioBridge; port: number; token: string }> {
  const b = new AudioBridge(assets, nullLog, { min: base, max: base + 4 });
  base += 5;
  bridges.push(b);
  const port = await b.start();
  const token = new URL(b.url).hash.replace('#token=', '');
  return { bridge: b, port, token };
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.stop()));
});

function get(port: number, pathname: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function socket(port: number, query: string, origin: string | undefined) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, origin ? { origin } : {});
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

describe('AudioBridge', () => {
  it('serves the page with a strict content security policy', async () => {
    const { port } = await bridge();
    const page = await get(port, '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('BeaconBob voice');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).toContain(`connect-src ws://127.0.0.1:${port}`);
    expect((await get(port, '/voice.js')).status).toBe(200);
    expect((await get(port, '/../package.json')).status).toBe(404);
    expect((await get(port, '/etc/passwd')).status).toBe(404);
  });

  it('refuses requests addressed to another host name (DNS rebinding)', async () => {
    const { port } = await bridge();
    expect((await get(port, '/', `evil.example:${port}`)).status).toBe(403);
  });

  it('only lets the page connect with the right token and origin', async () => {
    const { bridge: b, port, token } = await bridge();
    const origin = `http://127.0.0.1:${port}`;
    await expect(socket(port, '', origin)).rejects.toThrow(/403/);
    await expect(socket(port, '?token=wrong', origin)).rejects.toThrow(/403/);
    await expect(socket(port, `?token=${token}`, 'http://evil.example')).rejects.toThrow(/403/);
    await expect(socket(port, `?token=${token}`, undefined)).rejects.toThrow(/403/);

    const ws = await socket(port, `?token=${token}`, origin);
    await waitFor(() => b.isConnected);
    ws.close();
  });

  it('a newer page replaces an older one', async () => {
    const { bridge: b, port, token } = await bridge();
    const origin = `http://127.0.0.1:${port}`;
    const first = await socket(port, `?token=${token}`, origin);
    const told = new Promise<string>((resolve) => first.once('message', (d) => resolve(d.toString())));
    const second = await socket(port, `?token=${token}`, origin);
    expect(JSON.parse(await told)).toEqual({ type: 'replaced' });
    await waitFor(() => b.isConnected);
    expect(b.send({ type: 'mute', muted: true })).toBe(true);
    second.close();
  });
});

describe('parseFromPage', () => {
  it('accepts page messages and rejects junk', () => {
    expect(parseFromPage('{"type":"ready","mic":"ok"}')).toEqual({ type: 'ready', mic: 'ok', message: undefined });
    expect(parseFromPage('{"type":"speaking","peers":["self","p-0011223344556677"]}')).toBeDefined();
    expect(parseFromPage('{"type":"speaking","peers":["<script>"]}')).toBeUndefined();
    expect(
      parseFromPage('{"type":"connections","states":{"p-0011223344556677":"connected","bogus":"connected","p-8899aabbccddeeff":"exploded"}}'),
    ).toEqual({ type: 'connections', states: { 'p-0011223344556677': 'connected' } });
    expect(parseFromPage('{"type":"signal","to":"p-0011223344556677","signal":{"type":"offer","sdp":"v=0"}}')).toBeDefined();
    expect(parseFromPage('{"type":"signal","to":"nobody","signal":{"type":"offer","sdp":"v=0"}}')).toBeUndefined();
    expect(parseFromPage('not json')).toBeUndefined();
    expect(parseFromPage('{"type":"exec","cmd":"rm -rf /"}')).toBeUndefined();
  });
});
