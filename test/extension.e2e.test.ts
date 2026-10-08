import { type ChildProcess, execSync, fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FromWebview, UiState } from '../src/ui/ipcTypes';
import { getLocalAddresses } from '../src/util/network';
import { waitFor } from './helpers';

/**
 * Separate processes each load the bundled `dist/extension.js` against a stub `vscode` API,
 * find each other over real mDNS, and then drive everything through the same webview
 * messages the React UI sends.
 */
const canRun = getLocalAddresses().length > 0 && !process.env.BEACONBOB_SKIP_MDNS;

interface Host {
  name: string;
  child: ChildProcess;
  state: UiState | undefined;
  prompts: Array<{ message: string; detail: string }>;
  notifications: string[];
  opened: string[];
  html: string;
  errors: string[];
  post(msg: FromWebview): void;
}

const root = path.resolve(__dirname, '..');
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beaconbob-e2e-'));

function spawnHost(name: string): Promise<Host> {
  const child = fork(path.join(__dirname, 'e2e/hostProcess.cjs'), {
    env: {
      ...process.env,
      BEACONBOB_DISPLAY_NAME: name,
      BEACONBOB_TEST_STORAGE: path.join(storageRoot, name),
      BEACONBOB_TEST_PORTS: '47300-47320',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const host: Host = {
    name,
    child,
    state: undefined,
    prompts: [],
    notifications: [],
    opened: [],
    html: '',
    errors: [],
    post: (msg) => child.send({ cmd: 'webview', msg }),
  };
  return new Promise((resolve, reject) => {
    child.on('message', (m: { event: string } & Record<string, never>) => {
      if (m.event === 'state') host.state = m.state;
      else if (m.event === 'prompt') host.prompts.push({ message: m.message, detail: m.detail });
      else if (m.event === 'notify') host.notifications.push(m.message);
      else if (m.event === 'openExternal') host.opened.push(m.url);
      else if (m.event === 'error') host.errors.push(m.message);
      else if (m.event === 'activated') {
        host.html = m.html;
        resolve(host);
      } else if (m.event === 'ready') child.send({ cmd: 'activate' });
    });
    child.once('exit', (code) => reject(new Error(`${name} exited early with ${code}`)));
  });
}

const peerIn = (host: Host, name: string) => host.state?.peers.find((p) => p.name === name);
const conversation = (host: Host, title: string) => host.state?.conversations.find((c) => c.title === title);
const activeMessages = (host: Host) => host.state?.active?.messages ?? [];

describe.skipIf(!canRun)('extension end to end (three processes)', () => {
  let alice: Host;
  let bob: Host;
  let carol: Host;

  beforeAll(async () => {
    // BEACONBOB_E2E_USE_BUILD=1 tests whatever is already in dist/ (for example the minified
    // production bundle) instead of rebuilding.
    if (!process.env.BEACONBOB_E2E_USE_BUILD) execSync('npm run build:ext', { cwd: root, stdio: 'ignore' });
    [alice, bob, carol] = await Promise.all([spawnHost('Alice'), spawnHost('Bob'), spawnHost('Carol')]);
    const names = ['Alice', 'Bob', 'Carol'];
    // Wait for the specific peers: other tests advertise on the same network at the same time.
    await waitFor(
      () => [alice, bob, carol].every((h) => names.filter((n) => n !== h.name).every((n) => !!peerIn(h, n))),
      10_000,
    );
  }, 30_000);

  afterAll(() => {
    for (const h of [alice, bob, carol]) h?.child.kill();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('serves the webview with a locked-down CSP', () => {
    expect(alice.html).toContain("default-src 'none'");
    expect(alice.html).toMatch(/script-src 'nonce-[^']+'/);
    expect(alice.html).toContain('main.js');
  });

  it('connects with approval and exchanges direct messages', async () => {
    expect(alice.state!.self.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
    expect(peerIn(alice, 'Bob')).toMatchObject({ state: 'available', workspace: 'Bob-workspace' });

    const bobId = peerIn(alice, 'Bob')!.peerId;
    const aliceId = peerIn(bob, 'Alice')!.peerId;
    alice.post({ type: 'connect', peerId: bobId });
    await waitFor(() => peerIn(alice, 'Bob')?.state === 'connected' && peerIn(bob, 'Alice')?.state === 'connected', 10_000);
    expect(bob.prompts.at(-1)?.message).toBe('Alice wants to connect to you over BeaconBob');
    expect(bob.prompts.at(-1)?.detail).toContain(`Fingerprint: ${alice.state!.self.fingerprint}`);

    alice.post({ type: 'startDm', peerId: bobId });
    await waitFor(() => alice.state?.active?.id === `dm:${bobId}`);
    alice.post({ type: 'sendMessage', conversationId: `dm:${bobId}`, content: 'hello from alice' });

    await waitFor(() => conversation(bob, 'Alice')?.unread === 1);
    bob.post({ type: 'openConversation', id: `dm:${aliceId}` });
    await waitFor(() => activeMessages(bob).some((m) => m.content === 'hello from alice' && m.senderName === 'Alice'));
    expect(conversation(bob, 'Alice')?.unread).toBe(0);

    bob.post({ type: 'typing', conversationId: `dm:${aliceId}`, isTyping: true });
    await waitFor(() => alice.state!.active!.typing.includes('Bob'));
    bob.post({ type: 'sendMessage', conversationId: `dm:${aliceId}`, content: 'hey alice' });
    await waitFor(() => activeMessages(alice).some((m) => m.content === 'hey alice' && !m.fromSelf));

    // Calling: Alice starts a call, her browser is asked to open the voice page, Bob is notified.
    alice.post({ type: 'joinVoice', conversationId: `dm:${bobId}` });
    await waitFor(() => alice.state?.voice.call?.title === 'Call with Bob');
    await waitFor(() => alice.opened.length === 1);
    expect(alice.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:425\d\d\/#token=[A-Za-z0-9_-]{20,}$/);
    await waitFor(() => bob.notifications.includes('Alice is calling you'));
    await waitFor(() => conversation(bob, 'Alice')?.inCallCount === 1);
    expect(bob.state!.active?.voice).toMatchObject({ joined: false, others: ['Alice'], canJoin: true });
    alice.post({ type: 'leaveVoice' });
    await waitFor(() => alice.state?.voice.call === null && conversation(bob, 'Alice')?.inCallCount === 0);

    alice.post({ type: 'closeConversation' });
    bob.post({ type: 'closeConversation' });
    await waitFor(() => alice.state?.active === null && bob.state?.active === null);
  }, 30_000);

  it('runs a hosted public group: in-band join, join by connecting, relay, and host shutdown', async () => {
    alice.post({ type: 'createGroup', name: '#frontend', visibility: 'public' });
    await waitFor(() => alice.state?.active?.title === '#frontend');
    const groupId = alice.state!.active!.groupId!;
    const convId = `group:${groupId}`;

    // The group is advertised over mDNS and shows up for everyone nearby.
    const nearby = (h: Host) => h.state?.publicGroups.find((g) => g.groupId === groupId);
    await waitFor(() => !!nearby(bob) && !!nearby(carol), 15_000);
    expect(nearby(carol)).toMatchObject({ name: 'frontend', hostName: 'Alice', state: 'available' });

    // Bob is already connected to Alice, so his request travels in-band and waits for her.
    bob.post({ type: 'joinGroup', hostId: nearby(bob)!.hostId, groupId });
    await waitFor(() => nearby(bob)?.state === 'requested');
    await waitFor(() => alice.state!.joinRequests.some((r) => r.name === 'Bob'));
    expect(alice.notifications).toContain('Bob wants to join #frontend');
    const bobId = alice.state!.joinRequests.find((r) => r.name === 'Bob')!.peerId;
    alice.post({ type: 'respondJoinRequest', groupId, peerId: bobId, accept: true });
    await waitFor(() => conversation(bob, '#frontend') !== undefined);

    // Carol is not connected to anyone: one prompt on Alice's side covers connecting and joining.
    const promptsBefore = alice.prompts.length;
    carol.post({ type: 'joinGroup', hostId: nearby(carol)!.hostId, groupId });
    await waitFor(() => conversation(carol, '#frontend') !== undefined, 10_000);
    expect(alice.prompts.slice(promptsBefore).map((p) => p.message)).toEqual(['Carol wants to join #frontend']);
    expect(peerIn(carol, 'Bob')?.state).toBe('available');

    await waitFor(() => alice.state!.active!.members.length === 3);
    expect(alice.state!.active!.members.map((m) => m.name).sort()).toEqual(['Alice', 'Bob', 'Carol']);

    // Bob and Carol are not connected to each other; Alice forwards between them.
    bob.post({ type: 'openConversation', id: convId });
    carol.post({ type: 'openConversation', id: convId });
    await waitFor(() => bob.state?.active?.id === convId && carol.state?.active?.id === convId);
    bob.post({ type: 'sendMessage', conversationId: convId, content: 'hi from bob' });
    await waitFor(() => activeMessages(carol).some((m) => m.content === 'hi from bob' && m.senderName === 'Bob'));
    await waitFor(() => activeMessages(alice).some((m) => m.content === 'hi from bob'));
    carol.post({ type: 'sendMessage', conversationId: convId, content: 'hi from carol' });
    await waitFor(() => activeMessages(bob).some((m) => m.content === 'hi from carol'));
    expect(carol.state!.active!.members.map((m) => m.name).sort()).toEqual(['Alice', 'Bob', 'Carol']);

    // When the host's editor shuts down, members see the group end.
    const aliceExited = new Promise((r) => alice.child.once('exit', r));
    alice.child.send({ cmd: 'deactivate' });
    await aliceExited;
    await waitFor(() => !!bob.state?.active?.ended && !!carol.state?.active?.ended, 5_000);
    expect(bob.state!.active!.canSend).toBe(false);

    expect([...alice.errors, ...bob.errors, ...carol.errors]).toEqual([]);
  }, 60_000);
});
