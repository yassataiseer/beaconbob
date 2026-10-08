import { randomUUID } from 'node:crypto';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { GroupMember } from '../groups/groupMember';
import type { Identity } from '../security/identity';
import { DocumentManager, INIT_ORIGIN } from '../sync/documentManager';
import type { RemotePeer } from '../transport/peerConnection';
import type { PeerManager } from '../transport/peerManager';
import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import {
  type DocErrorCode,
  type FsErrorCode,
  type FsOp,
  type FsResult,
  fromB64,
  parseAwarenessState,
  parseSharePayload,
  type PeerAwarenessState,
  type SharePayload,
  toB64,
} from './shareProtocol';

export const REMOTE_ORIGIN = Symbol('remote');

export class ShareRequestError extends Error {
  constructor(
    readonly code: DocErrorCode | 'timeout' | 'ended',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ShareRequestError';
  }
}

export interface GuestSessionView {
  sessionId: string;
  groupId: string;
  hostId: string;
  rootName: string;
  canEdit: boolean;
}

export interface RemoteCursor extends PeerAwarenessState {
  clientId: number;
}

interface GuestSession extends GuestSessionView {
  docs: DocumentManager;
  pendingOpen: Map<string, { promise: Promise<Y.Text>; resolve: (t: Y.Text) => void; reject: (e: Error) => void }>;
  awareness: Awareness;
}

export interface SessionGuestOptions {
  peers: PeerManager;
  groups: GroupMember;
  identity: Identity;
  log: Log;
  requestTimeoutMs?: number;
}

type GuestEvents = {
  changed: [];
  /** Files changed on the host's disk. */
  fsChanged: [groupId: string, paths: string[]];
  /** A document was replaced by the host's copy (for example after a rejected edit). */
  docReset: [groupId: string, path: string, text: Y.Text];
  ended: [groupId: string];
  awareness: [groupId: string];
};

/**
 * The member side of workspace sharing. Sessions are keyed by group id, which is also the
 * authority of the `beaconbob://` URIs for that session.
 */
export class SessionGuest extends Emitter<GuestEvents> {
  private readonly sessions = new Map<string, GuestSession>();
  private readonly requests = new Map<string, { resolve: (r: FsResult) => void; timer: NodeJS.Timeout; groupId: string }>();
  private readonly disposers: Array<() => void> = [];
  private readonly timeoutMs: number;

  constructor(private readonly opts: SessionGuestOptions) {
    super();
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.disposers.push(
      opts.peers.on('channel', (peer, channel, data) => {
        if (channel === 'lanCodeSync') this.onPayload(peer, data);
      }),
      opts.peers.on('disconnected', (peer) => {
        for (const s of [...this.sessions.values()]) if (s.hostId === peer.peerId) this.end(s.groupId);
      }),
      opts.groups.on('changed', () => {
        for (const s of [...this.sessions.values()]) {
          const group = opts.groups.group(s.groupId);
          if (!group || group.ended || group.hostId !== s.hostId) this.end(s.groupId);
        }
      }),
    );
  }

  // --- Queries -------------------------------------------------------------------------------

  list(): GuestSessionView[] {
    return [...this.sessions.values()].map(({ sessionId, groupId, hostId, rootName, canEdit }) => ({
      sessionId,
      groupId,
      hostId,
      rootName,
      canEdit,
    }));
  }

  get(groupId: string): GuestSessionView | undefined {
    return this.list().find((s) => s.groupId === groupId);
  }

  text(groupId: string, path: string): Y.Text | undefined {
    return this.sessions.get(groupId)?.docs.text(path);
  }

  doc(groupId: string, path: string): Y.Doc | undefined {
    return this.sessions.get(groupId)?.docs.doc(path);
  }

  awareness(groupId: string): Awareness | undefined {
    return this.sessions.get(groupId)?.awareness;
  }

  /** Everyone else's published cursor state in a session. */
  cursors(groupId: string): RemoteCursor[] {
    const session = this.sessions.get(groupId);
    if (!session) return [];
    const out: RemoteCursor[] = [];
    for (const [clientId, raw] of session.awareness.getStates()) {
      if (clientId === session.awareness.clientID) continue;
      const state = parseAwarenessState(raw);
      if (state) out.push({ ...state, clientId });
    }
    return out;
  }

  // --- Requests ------------------------------------------------------------------------------

  async request(groupId: string, op: FsOp, path: string): Promise<Extract<FsResult, { ok: true }>> {
    const session = this.sessions.get(groupId);
    if (!session) throw new ShareRequestError('ended', 'The sharing session has ended.');
    const reqId = randomUUID();
    const result = await new Promise<FsResult>((resolve) => {
      const timer = setTimeout(() => {
        this.requests.delete(reqId);
        resolve({ ok: false, error: 'failed', message: 'timeout' });
      }, this.timeoutMs);
      this.requests.set(reqId, { resolve, timer, groupId });
      if (!this.send(session, { kind: 'FS_REQUEST', sessionId: session.sessionId, reqId, op, path })) {
        clearTimeout(timer);
        this.requests.delete(reqId);
        resolve({ ok: false, error: 'failed', message: 'not connected' });
      }
    });
    if (!result.ok) {
      if (result.message === 'timeout') throw new ShareRequestError('timeout', 'The host did not answer in time.');
      throw new ShareRequestError(result.error as FsErrorCode, result.message);
    }
    return result;
  }

  /** Subscribes to a file's shared document and resolves once the host's copy has arrived. */
  openDoc(groupId: string, path: string): Promise<Y.Text> {
    const session = this.sessions.get(groupId);
    if (!session) return Promise.reject(new ShareRequestError('ended', 'The sharing session has ended.'));
    const existing = session.docs.text(path);
    if (existing) return Promise.resolve(existing);
    const pending = session.pendingOpen.get(path);
    if (pending) return pending.promise;

    let resolve!: (t: Y.Text) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<Y.Text>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      session.pendingOpen.delete(path);
      reject(new ShareRequestError('timeout', 'The host did not send the file in time.'));
    }, this.timeoutMs);
    session.pendingOpen.set(path, {
      promise,
      resolve: (t) => {
        clearTimeout(timer);
        resolve(t);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    this.send(session, { kind: 'DOC_OPEN', sessionId: session.sessionId, path });
    return promise;
  }

  closeDoc(groupId: string, path: string): void {
    const session = this.sessions.get(groupId);
    if (!session?.docs.has(path)) return;
    session.docs.delete(path);
    this.send(session, { kind: 'DOC_CLOSE', sessionId: session.sessionId, path });
  }

  /** Asks the host for a fresh copy of a document, discarding local changes. */
  resync(groupId: string, path: string): void {
    const session = this.sessions.get(groupId);
    if (session?.docs.has(path)) this.send(session, { kind: 'DOC_OPEN', sessionId: session.sessionId, path });
  }

  dispose(): void {
    for (const groupId of [...this.sessions.keys()]) this.end(groupId);
    for (const dispose of this.disposers) dispose();
    this.removeAllListeners();
  }

  // --- Incoming ------------------------------------------------------------------------------

  private onPayload(peer: RemotePeer, data: unknown): void {
    const payload = parseSharePayload(data);
    if (!payload) return;

    if (payload.kind === 'SESSION_STATE') {
      this.onState(peer, payload);
      return;
    }
    const session = [...this.sessions.values()].find((s) => s.sessionId === payload.sessionId);
    if (!session || session.hostId !== peer.peerId) return;

    switch (payload.kind) {
      case 'SESSION_END':
        this.end(session.groupId);
        return;
      case 'FS_RESPONSE': {
        const request = this.requests.get(payload.reqId);
        if (!request || request.groupId !== session.groupId) return;
        this.requests.delete(payload.reqId);
        clearTimeout(request.timer);
        const { kind: _kind, sessionId: _sid, reqId: _req, ...result } = payload;
        request.resolve(result as FsResult);
        return;
      }
      case 'FS_CHANGED':
        this.emit('fsChanged', session.groupId, payload.paths);
        return;
      case 'DOC_SYNC': {
        const existed = session.docs.has(payload.path);
        const pending = session.pendingOpen.get(payload.path);
        if (!existed && !pending) return;
        let text: Y.Text;
        try {
          text = session.docs.load(payload.path, payload.stateB64);
        } catch {
          pending?.reject(new ShareRequestError('failed', 'The host sent an unreadable document.'));
          session.pendingOpen.delete(payload.path);
          return;
        }
        if (pending) {
          session.pendingOpen.delete(payload.path);
          pending.resolve(text);
        }
        if (payload.canEdit !== session.canEdit) {
          session.canEdit = payload.canEdit;
          this.emit('changed');
        }
        return;
      }
      case 'DOC_ERROR': {
        const pending = session.pendingOpen.get(payload.path);
        session.pendingOpen.delete(payload.path);
        pending?.reject(new ShareRequestError(payload.error, `The host could not open ${payload.path} (${payload.error}).`));
        return;
      }
      case 'DOC_UPDATE':
        session.docs.applyUpdate(payload.path, payload.updateB64, REMOTE_ORIGIN);
        return;
      case 'AWARENESS':
        try {
          applyAwarenessUpdate(session.awareness, fromB64(payload.updateB64), REMOTE_ORIGIN);
        } catch {
          // Malformed awareness from the host: ignore.
        }
        return;
      default:
        return;
    }
  }

  private onState(peer: RemotePeer, state: Extract<SharePayload, { kind: 'SESSION_STATE' }>): void {
    const group = this.opts.groups.group(state.groupId);
    // Only the host of a group we are actually in may open a session for it.
    if (!group || group.ended || group.hostId !== peer.peerId || state.hostId !== peer.peerId) return;
    const canEdit = state.editors.includes(this.opts.identity.peerId);
    const existing = this.sessions.get(state.groupId);
    if (existing && existing.sessionId === state.sessionId) {
      existing.rootName = state.rootName;
      existing.canEdit = canEdit;
      this.emit('changed');
      return;
    }
    if (existing) this.end(state.groupId);

    const session: GuestSession = {
      sessionId: state.sessionId,
      groupId: state.groupId,
      hostId: peer.peerId,
      rootName: state.rootName,
      canEdit,
      docs: new DocumentManager(),
      pendingOpen: new Map(),
      awareness: new Awareness(new Y.Doc()),
    };
    session.awareness.setLocalState(null);
    session.docs.on('update', (path, update, origin) => {
      if (origin === REMOTE_ORIGIN || origin === INIT_ORIGIN) return;
      if (!session.canEdit) {
        // Our copy diverged although we cannot edit; get the host's version back.
        this.resync(session.groupId, path);
        return;
      }
      this.send(session, { kind: 'DOC_UPDATE', sessionId: session.sessionId, path, updateB64: toB64(update) });
    });
    session.docs.on('reset', (path, text) => this.emit('docReset', session.groupId, path, text));
    session.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === 'local') {
          const mine = [...added, ...updated, ...removed].filter((id) => id === session.awareness.clientID);
          if (mine.length > 0) {
            this.send(session, {
              kind: 'AWARENESS',
              sessionId: session.sessionId,
              updateB64: toB64(encodeAwarenessUpdate(session.awareness, mine)),
            });
          }
        }
        this.emit('awareness', session.groupId);
      },
    );
    this.sessions.set(state.groupId, session);
    this.opts.log.info(`${peer.name} is sharing ${state.rootName} with #${group.name}`);
    this.emit('changed');
  }

  private end(groupId: string): void {
    const session = this.sessions.get(groupId);
    if (!session) return;
    this.sessions.delete(groupId);
    for (const pending of session.pendingOpen.values()) {
      pending.reject(new ShareRequestError('ended', 'The sharing session has ended.'));
    }
    for (const [reqId, request] of this.requests) {
      if (request.groupId !== groupId) continue;
      clearTimeout(request.timer);
      this.requests.delete(reqId);
      request.resolve({ ok: false, error: 'failed', message: 'ended' });
    }
    session.docs.clear();
    session.awareness.destroy();
    this.emit('ended', groupId);
    this.emit('changed');
  }

  private send(session: GuestSession, payload: SharePayload): boolean {
    return this.opts.peers.send(session.hostId, 'lanCodeSync', payload);
  }
}
