import { randomUUID } from 'node:crypto';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { GroupHost } from '../groups/groupHost';
import type { Identity } from '../security/identity';
import { DocumentManager, INIT_ORIGIN } from '../sync/documentManager';
import type { RemotePeer } from '../transport/peerConnection';
import type { PeerManager } from '../transport/peerManager';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import { readAwarenessUpdate } from './awarenessCodec';
import {
  type FsErrorCode,
  type FsResult,
  fromB64,
  parseAwarenessState,
  parseSharePayload,
  type SharePayload,
  toB64,
} from './shareProtocol';
import { ShareFsError, type WorkspaceAccess } from './workspaceAccess';

/** How the host session reaches the host's own editor. */
export interface HostEditorAdapter {
  /** Text of a shared file as the host's editor has it: the unsaved buffer if open, else disk. */
  readText(path: string): Promise<string>;
  /** Mirrors `text` into the host's editor buffer for `path`, and back, until disposed. */
  bind(path: string, text: Y.Text): () => void;
  /** Saves the host's buffer for `path` to disk. */
  save(path: string): Promise<void>;
}

export interface HostSessionView {
  sessionId: string;
  groupId: string;
  rootName: string;
  root: string;
  editors: string[];
}

export interface SessionHostOptions {
  peers: PeerManager;
  groups: GroupHost;
  identity: Identity;
  adapter: HostEditorAdapter;
  log: Log;
}

interface HostSession {
  sessionId: string;
  groupId: string;
  access: WorkspaceAccess;
  editors: Set<string>;
  /** Members that have been told about the session. */
  members: Set<string>;
  docs: DocumentManager;
  subscribers: Map<string, Set<string>>;
  bindings: Map<string, () => void>;
  opening: Map<string, Promise<void>>;
  awareness: Awareness;
  /** Which member owns each awareness client id. */
  clientOwners: Map<number, string>;
}

const MAX_CLIENTS_PER_PEER = 4;
const MAX_STATE_B64 = 1024 * 1024 - 8192;

/**
 * The host side of workspace sharing. Members talk only to the host: it answers file
 * requests, owns the authoritative Yjs documents (bound to its real editor buffers), applies
 * a member's edits only if they may edit, and forwards edits and cursors to everyone else.
 */
export class SessionHost extends Emitter<{ changed: [] }> {
  private session: HostSession | undefined;
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly opts: SessionHostOptions) {
    super();
    this.disposers.push(
      opts.peers.on('channel', (peer, channel, data) => {
        if (channel === 'lanCodeSync') void this.onPayload(peer, data);
      }),
      opts.groups.on('changed', () => this.reconcileMembers()),
    );
  }

  get active(): HostSessionView | undefined {
    const s = this.session;
    return s && {
      sessionId: s.sessionId,
      groupId: s.groupId,
      rootName: s.access.rootName,
      root: s.access.root,
      editors: [...s.editors],
    };
  }

  /** The host's own awareness (for publishing the host's cursor). */
  get awareness(): Awareness | undefined {
    return this.session?.awareness;
  }

  get access(): WorkspaceAccess | undefined {
    return this.session?.access;
  }

  /** The shared document for `path`, if some member has it open. */
  text(path: string): Y.Text | undefined {
    return this.session?.docs.text(path);
  }

  start(groupId: string, access: WorkspaceAccess): string {
    if (this.session) {
      throw new Error('You are already sharing your workspace with another group. Stop sharing there first.');
    }
    if (!this.opts.groups.isHost(groupId)) throw new Error('You can only share with a group you host.');
    const awarenessDoc = new Y.Doc();
    const session: HostSession = {
      sessionId: randomUUID(),
      groupId,
      access,
      editors: new Set(),
      members: new Set(),
      docs: new DocumentManager(),
      subscribers: new Map(),
      bindings: new Map(),
      opening: new Map(),
      awareness: new Awareness(awarenessDoc),
      clientOwners: new Map(),
    };
    session.docs.on('update', (path, update, origin) => this.relayDocUpdate(session, path, update, origin));
    session.awareness.on('update', (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
      this.relayAwareness(session, changes, origin),
    );
    this.session = session;
    this.opts.log.info(`Sharing ${access.root} with group ${groupId}`);
    this.reconcileMembers();
    this.emit('changed');
    return session.sessionId;
  }

  stop(): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    for (const peerId of session.members) this.send(peerId, { kind: 'SESSION_END', sessionId: session.sessionId });
    for (const dispose of session.bindings.values()) dispose();
    session.docs.clear();
    session.awareness.destroy();
    this.opts.log.info('Stopped sharing');
    this.emit('changed');
  }

  setCanEdit(peerId: string, canEdit: boolean): void {
    const session = this.session;
    if (!session || !session.members.has(peerId)) return;
    if (canEdit) session.editors.add(peerId);
    else session.editors.delete(peerId);
    this.broadcastState(session);
    this.emit('changed');
  }

  /** Called by the host's file watcher; forwards visible changes to members. */
  notifyChanged(paths: string[]): void {
    const session = this.session;
    if (!session) return;
    const visible = paths.filter((p) => session.access.isVisible(p)).slice(0, 200);
    if (visible.length === 0) return;
    for (const peerId of session.members) this.send(peerId, { kind: 'FS_CHANGED', sessionId: session.sessionId, paths: visible });
  }

  dispose(): void {
    this.stop();
    for (const dispose of this.disposers) dispose();
    this.removeAllListeners();
  }

  // --- Membership ----------------------------------------------------------------------------

  private memberIds(session: HostSession): Set<string> {
    const group = this.opts.groups.hosted().find((g) => g.groupId === session.groupId);
    return new Set(group?.members.map((m) => m.peerId).filter((id) => id !== this.opts.identity.peerId) ?? []);
  }

  private reconcileMembers(): void {
    const session = this.session;
    if (!session) return;
    if (!this.opts.groups.isHost(session.groupId)) {
      this.stop();
      return;
    }
    const current = this.memberIds(session);
    let changed = false;
    let editorsChanged = false;
    for (const peerId of [...session.members]) {
      if (current.has(peerId)) continue;
      session.members.delete(peerId);
      editorsChanged = session.editors.delete(peerId) || editorsChanged;
      this.dropPeer(session, peerId);
      this.send(peerId, { kind: 'SESSION_END', sessionId: session.sessionId });
      changed = true;
    }
    for (const peerId of current) {
      if (session.members.has(peerId)) continue;
      session.members.add(peerId);
      this.send(peerId, this.stateOf(session));
      // Bring the newcomer up to date on everyone's cursors.
      const clients = [...session.awareness.getStates().keys()];
      if (clients.length > 0) {
        this.send(peerId, {
          kind: 'AWARENESS',
          sessionId: session.sessionId,
          updateB64: toB64(encodeAwarenessUpdate(session.awareness, clients)),
        });
      }
      changed = true;
    }
    if (editorsChanged) this.broadcastState(session);
    if (changed) this.emit('changed');
  }

  private dropPeer(session: HostSession, peerId: string): void {
    for (const [path, subs] of session.subscribers) {
      if (subs.delete(peerId) && subs.size === 0) this.closeDoc(session, path);
    }
    const owned = [...session.clientOwners].filter(([, owner]) => owner === peerId).map(([id]) => id);
    for (const id of owned) session.clientOwners.delete(id);
    if (owned.length > 0) removeAwarenessStates(session.awareness, owned, 'host');
  }

  // --- Incoming ------------------------------------------------------------------------------

  private async onPayload(peer: RemotePeer, data: unknown): Promise<void> {
    const session = this.session;
    const payload = parseSharePayload(data);
    if (!session || !payload || payload.sessionId !== session.sessionId) return;
    if (!session.members.has(peer.peerId)) return;
    switch (payload.kind) {
      case 'FS_REQUEST': {
        const result = await this.handleFs(session, peer.peerId, payload.op, payload.path);
        if (this.session === session) {
          this.send(peer.peerId, { kind: 'FS_RESPONSE', sessionId: session.sessionId, reqId: payload.reqId, ...result });
        }
        return;
      }
      case 'DOC_OPEN':
        await this.openDoc(session, peer.peerId, payload.path);
        return;
      case 'DOC_CLOSE': {
        const subs = session.subscribers.get(payload.path);
        if (subs?.delete(peer.peerId) && subs.size === 0) this.closeDoc(session, payload.path);
        return;
      }
      case 'DOC_UPDATE': {
        if (!session.subscribers.get(payload.path)?.has(peer.peerId)) return;
        if (!session.editors.has(peer.peerId)) {
          // Read-only members cannot change the document; put their copy back.
          this.sendSync(session, peer.peerId, payload.path);
          return;
        }
        if (!session.docs.applyUpdate(payload.path, payload.updateB64, peer.peerId)) {
          this.sendSync(session, peer.peerId, payload.path);
        }
        return;
      }
      case 'AWARENESS':
        this.onAwareness(session, peer.peerId, payload.updateB64);
        return;
      default:
        return;
    }
  }

  private async handleFs(session: HostSession, peerId: string, op: string, path: string): Promise<FsResult> {
    try {
      switch (op) {
        case 'stat':
          return { ok: true, stat: await session.access.stat(path) };
        case 'readDir':
          return { ok: true, entries: await session.access.readDir(path) };
        case 'read':
          return { ok: true, dataB64: (await session.access.readBytes(path)).toString('base64') };
        case 'save':
          if (!session.editors.has(peerId)) return { ok: false, error: 'read-only' };
          if (!session.docs.has(path)) return { ok: false, error: 'not-found' };
          await this.opts.adapter.save(path);
          return { ok: true };
        default:
          return { ok: false, error: 'failed' };
      }
    } catch (err) {
      if (err instanceof ShareFsError) {
        const code: FsErrorCode = err.code === 'binary' ? 'not-a-file' : err.code;
        return { ok: false, error: code };
      }
      this.opts.log.warn(`Shared file request failed: ${(err as Error).message}`);
      return { ok: false, error: 'failed' };
    }
  }

  private async openDoc(session: HostSession, peerId: string, path: string): Promise<void> {
    try {
      if (!session.docs.has(path)) {
        let opening = session.opening.get(path);
        if (!opening) {
          opening = (async () => {
            const stat = await session.access.stat(path);
            if (stat.type !== 'file') throw new ShareFsError('not-a-file');
            await session.access.readText(path); // size, binary and visibility checks
            const text = await this.opts.adapter.readText(path);
            if (this.session !== session || session.docs.has(path)) return;
            const ytext = session.docs.create(path, text);
            session.bindings.set(path, this.opts.adapter.bind(path, ytext));
          })().finally(() => session.opening.delete(path));
          session.opening.set(path, opening);
        }
        await opening;
      }
      if (this.session !== session || !session.members.has(peerId)) return;
      let subs = session.subscribers.get(path);
      if (!subs) session.subscribers.set(path, (subs = new Set()));
      subs.add(peerId);
      this.sendSync(session, peerId, path);
    } catch (err) {
      const error = err instanceof ShareFsError ? err.code : 'failed';
      this.send(peerId, { kind: 'DOC_ERROR', sessionId: session.sessionId, path, error });
    }
  }

  private closeDoc(session: HostSession, path: string): void {
    session.subscribers.delete(path);
    session.bindings.get(path)?.();
    session.bindings.delete(path);
    session.docs.delete(path);
  }

  private sendSync(session: HostSession, peerId: string, path: string): void {
    const stateB64 = session.docs.encodeState(path);
    if (stateB64 === undefined) return;
    if (stateB64.length > MAX_STATE_B64) {
      this.send(peerId, { kind: 'DOC_ERROR', sessionId: session.sessionId, path, error: 'too-large' });
      return;
    }
    this.send(peerId, {
      kind: 'DOC_SYNC',
      sessionId: session.sessionId,
      path,
      stateB64,
      canEdit: session.editors.has(peerId),
    });
  }

  private onAwareness(session: HostSession, peerId: string, updateB64: string): void {
    const update = fromB64(updateB64);
    const entries = readAwarenessUpdate(update);
    if (!entries) return;
    for (const { clientId, state } of entries) {
      const owner = session.clientOwners.get(clientId);
      if (owner && owner !== peerId) return;
      if (clientId === session.awareness.clientID) return;
      if (state !== null) {
        const parsed = parseAwarenessState(state);
        if (!parsed || parsed.user.peerId !== peerId) return;
      }
    }
    for (const { clientId } of entries) {
      if (session.clientOwners.has(clientId)) continue;
      const owned = [...session.clientOwners.values()].filter((o) => o === peerId).length;
      if (owned >= MAX_CLIENTS_PER_PEER) return;
      session.clientOwners.set(clientId, peerId);
    }
    applyAwarenessUpdate(session.awareness, update, peerId);
  }

  // --- Outgoing ------------------------------------------------------------------------------

  private relayDocUpdate(session: HostSession, path: string, update: Uint8Array, origin: unknown): void {
    if (origin === INIT_ORIGIN) return;
    const subs = session.subscribers.get(path);
    if (!subs) return;
    const payload: SharePayload = { kind: 'DOC_UPDATE', sessionId: session.sessionId, path, updateB64: toB64(update) };
    for (const peerId of subs) if (peerId !== origin) this.send(peerId, payload);
  }

  private relayAwareness(
    session: HostSession,
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    const clients = [...changes.added, ...changes.updated, ...changes.removed];
    if (clients.length === 0) return;
    const payload: SharePayload = {
      kind: 'AWARENESS',
      sessionId: session.sessionId,
      updateB64: toB64(encodeAwarenessUpdate(session.awareness, clients)),
    };
    for (const peerId of session.members) if (peerId !== origin) this.send(peerId, payload);
  }

  private stateOf(session: HostSession): SharePayload {
    return {
      kind: 'SESSION_STATE',
      sessionId: session.sessionId,
      groupId: session.groupId,
      rootName: session.access.rootName.slice(0, 128),
      hostId: this.opts.identity.peerId,
      editors: [...session.editors],
    };
  }

  private broadcastState(session: HostSession): void {
    const state = this.stateOf(session);
    for (const peerId of session.members) this.send(peerId, state);
  }

  private send(peerId: string, payload: SharePayload): boolean {
    return this.opts.peers.send(peerId, 'lanCodeSync', payload);
  }
}
