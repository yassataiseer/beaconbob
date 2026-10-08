import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { nullLog } from '../src/util/logger';
import { AudioBridge } from '../src/voice/audioBridge';
import { CallManager } from '../src/voice/callManager';
import { VoiceController } from '../src/voice/voiceController';
import { discover, startNode, type TestNode, waitFor } from './helpers';

/**
 * Real audio between real browsers: headless Chrome with a fake microphone (a test tone)
 * loads each peer's companion page, and we check over the DevTools protocol that WebRTC
 * connects and audio bytes actually flow, including between two group members who are only
 * connected to the host.
 */
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const canRun = fs.existsSync(CHROME) && !process.env.BEACONBOB_SKIP_BROWSER;
const assets = path.resolve(__dirname, '../media/voice');

/** Just enough of the Chrome DevTools Protocol. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }
  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }
  close(): void {
    this.ws.close();
  }
}

let chrome: ChildProcess;
let cdp: Cdp;
let profile: string;
/** Page sessions by peer name. */
const pages = new Map<string, string>();

async function openPage(name: string, url: string): Promise<void> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  pages.set(name, sessionId);
}

async function evaluate<T>(name: string, expression: string): Promise<T> {
  const sessionId = pages.get(name);
  if (!sessionId) throw new Error(`No page for ${name}`);
  const { result } = await cdp.send<{ result: { value: T } }>(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  return result.value;
}

type Stats = Record<string, { state: string; bytesReceived: number }>;
const stats = (name: string) => evaluate<Stats>(name, 'window.__beaconbobVoice ? window.__beaconbobVoice.stats() : {}');

async function waitForAsync(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await check().catch(() => false))) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface VoiceNode extends TestNode {
  calls: CallManager;
  bridge: AudioBridge;
  voice: VoiceController;
}

const nodes: VoiceNode[] = [];
let portBase = 47600;

async function node(name: string): Promise<VoiceNode> {
  const n = (await startNode(name)) as VoiceNode;
  n.calls = new CallManager({ peers: n.peers, groupHost: n.host, member: n.member, identity: n.identity, log: nullLog });
  n.bridge = new AudioBridge(assets, nullLog, { min: portBase, max: portBase + 4 });
  portBase += 5;
  await n.bridge.start();
  const names = new Map<string, string>();
  n.voice = new VoiceController({
    calls: n.calls,
    bridge: n.bridge,
    selfId: n.identity.peerId,
    selfName: () => name,
    nameOf: (id) => names.get(id) ?? id,
    titleOf: (call) => (call.scope === 'dm' ? 'Direct call' : 'Group call'),
    openPage: (url) => openPage(name, url),
    log: nullLog,
  });
  const stop = n.stop;
  n.stop = async () => {
    n.voice.dispose();
    n.calls.dispose();
    await n.bridge.stop();
    await stop();
  };
  nodes.push(n);
  return n;
}

describe.skipIf(!canRun)('voice in a real browser (headless Chrome, fake microphone)', () => {
  beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconbob-chrome-'));
    chrome = spawn(CHROME, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ]);
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15_000);
      chrome.stderr!.on('data', (chunk: Buffer) => {
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(chunk.toString());
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    cdp = await Cdp.connect(wsUrl);
  }, 30_000);

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()));
    for (const sessionId of pages.values()) {
      await cdp.send('Runtime.evaluate', { expression: 'window.close()' }, sessionId).catch(() => undefined);
    }
    pages.clear();
  });

  afterAll(async () => {
    cdp?.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill();
      await exited;
    }
    if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('a 1:1 call connects and carries audio both ways; mute and leave work', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    discover(alice, bob);
    await alice.peers.connect(bob.identity.peerId);

    await alice.voice.join({ scope: 'dm', peerId: bob.identity.peerId });
    await bob.voice.join({ scope: 'dm', peerId: alice.identity.peerId });
    await waitFor(() => alice.bridge.isConnected && bob.bridge.isConnected, 10_000);
    await waitFor(() => alice.voice.state.mic === 'ok' && bob.voice.state.mic === 'ok', 10_000);

    const flowing = async (from: VoiceNode, to: string) => {
      const s = await stats(to);
      return s[from.identity.peerId]?.state === 'connected' && s[from.identity.peerId].bytesReceived > 2000;
    };
    await waitForAsync(() => flowing(bob, 'Alice'), 'Bob -> Alice audio');
    await waitForAsync(() => flowing(alice, 'Bob'), 'Alice -> Bob audio');
    await waitFor(() => alice.voice.state.connections[bob.identity.peerId] === 'connected', 5000);
    // The fake microphone plays a tone, so both sides should light up as speaking.
    await waitFor(() => alice.voice.state.speaking.has(bob.identity.peerId), 8000);

    alice.voice.setMuted(true);
    await waitForAsync(() => evaluate<boolean>('Alice', 'window.__beaconbobVoice.muted()'), 'mute to reach the page');

    bob.voice.leave();
    await waitForAsync(async () => Object.keys(await stats('Alice')).length === 0, 'Alice to drop the connection');
    expect(alice.calls.remoteParticipants()).toEqual([]);
  }, 60_000);

  it('a group call meshes everyone, with members connected only through the host', async () => {
    const alice = await node('Alice');
    const bob = await node('Bob');
    const carol = await node('Carol');
    for (const a of [alice, bob, carol]) for (const b of [alice, bob, carol]) if (a !== b) discover(a, b);
    const groupId = alice.host.create('standup', 'public');
    await bob.member.requestJoin(alice.identity.peerId, groupId);
    await carol.member.requestJoin(alice.identity.peerId, groupId);
    await waitFor(() => !!bob.member.group(groupId) && !!carol.member.group(groupId));
    expect(bob.peers.isConnected(carol.identity.peerId)).toBe(false);

    for (const n of [alice, bob, carol]) await n.voice.join({ scope: 'group', groupId });
    await waitFor(() => [alice, bob, carol].every((n) => n.calls.remoteParticipants().length === 2), 10_000);

    const allConnected = async (name: string, others: VoiceNode[]) => {
      const s = await stats(name);
      return others.every((o) => s[o.identity.peerId]?.state === 'connected' && s[o.identity.peerId].bytesReceived > 2000);
    };
    await waitForAsync(() => allConnected('Bob', [alice, carol]), 'Bob hearing Alice and Carol');
    await waitForAsync(() => allConnected('Carol', [alice, bob]), 'Carol hearing Alice and Bob');
    await waitForAsync(() => allConnected('Alice', [bob, carol]), 'Alice hearing Bob and Carol');
  }, 60_000);
});
