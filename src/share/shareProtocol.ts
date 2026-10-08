/**
 * `lanCodeSync` channel payloads: a host sharing its workspace with one of its groups.
 * Yjs updates and file bytes are base64 inside the JSON frames.
 */
import { isGroupId, MAX_FRAME_BYTES } from '../signaling/protocolTypes';

export const MAX_SHARED_FILE_BYTES = 512 * 1024;
export const MAX_DIR_ENTRIES = 2000;
export const MAX_CHANGED_PATHS = 200;
const MAX_PATH = 1024;
const MAX_B64 = MAX_FRAME_BYTES - 4096;

export type FsOp = 'stat' | 'readDir' | 'read' | 'save';
export type FsErrorCode = 'not-found' | 'forbidden' | 'too-large' | 'not-a-file' | 'not-a-directory' | 'read-only' | 'failed';

export interface SharedStat {
  type: 'file' | 'directory';
  size: number;
  mtime: number;
  ctime: number;
}

export interface SharedDirEntry {
  name: string;
  type: 'file' | 'directory';
}

export type FsResult =
  | { ok: true; stat?: SharedStat; entries?: SharedDirEntry[]; dataB64?: string }
  | { ok: false; error: FsErrorCode; message?: string };

export type DocErrorCode = FsErrorCode | 'binary';

export type SharePayload =
  | { kind: 'SESSION_STATE'; sessionId: string; groupId: string; rootName: string; hostId: string; editors: string[] }
  | { kind: 'SESSION_END'; sessionId: string }
  | { kind: 'FS_REQUEST'; sessionId: string; reqId: string; op: FsOp; path: string }
  | ({ kind: 'FS_RESPONSE'; sessionId: string; reqId: string } & FsResult)
  | { kind: 'FS_CHANGED'; sessionId: string; paths: string[] }
  | { kind: 'DOC_OPEN'; sessionId: string; path: string }
  | { kind: 'DOC_CLOSE'; sessionId: string; path: string }
  | { kind: 'DOC_SYNC'; sessionId: string; path: string; stateB64: string; canEdit: boolean }
  | { kind: 'DOC_ERROR'; sessionId: string; path: string; error: DocErrorCode }
  | { kind: 'DOC_UPDATE'; sessionId: string; path: string; updateB64: string }
  | { kind: 'AWARENESS'; sessionId: string; updateB64: string };

/** What each participant publishes through y-protocols awareness. */
export interface PeerAwarenessState {
  user: { peerId: string; name: string; color: string };
  /** Relative path of the file they are looking at, if it is in the shared folder. */
  activeFile: string | null;
  /** Yjs relative positions (JSON) in `activeFile`'s document. */
  cursor: { anchor: unknown; head: unknown } | null;
}

// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number, min = 1): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isB64 = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_B64 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
const isPeerId = (v: unknown): v is string => typeof v === 'string' && /^p-[0-9a-f]{16}$/.test(v);
const isId = (v: unknown): v is string => isStr(v, 64) && /^[A-Za-z0-9-]+$/.test(v);

const FS_OPS: readonly FsOp[] = ['stat', 'readDir', 'read', 'save'];
const FS_ERRORS: readonly FsErrorCode[] = ['not-found', 'forbidden', 'too-large', 'not-a-file', 'not-a-directory', 'read-only', 'failed'];

/**
 * A shared path is relative and POSIX-style: `""` is the root, otherwise segments joined by `/`
 * with no empty, `.` or `..` segments, no backslashes, and no NUL. The host still re-checks
 * the resolved real path against the shared root; this is only the wire format.
 */
export function isSharePath(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_PATH) return false;
  if (v === '') return true;
  if (v.includes('\0') || v.includes('\\') || v.startsWith('/')) return false;
  return v.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function isStat(v: unknown): v is SharedStat {
  return isObj(v) && (v.type === 'file' || v.type === 'directory') && isNum(v.size) && isNum(v.mtime) && isNum(v.ctime);
}

function isEntry(v: unknown): v is SharedDirEntry {
  return isObj(v) && isStr(v.name, 255) && !String(v.name).includes('/') && (v.type === 'file' || v.type === 'directory');
}

/** Validates a `lanCodeSync` payload. Returns `undefined` for anything malformed. */
export function parseSharePayload(data: unknown): SharePayload | undefined {
  if (!isObj(data) || !isId(data.sessionId)) return undefined;
  const sessionId = data.sessionId;
  switch (data.kind) {
    case 'SESSION_STATE':
      if (
        !isGroupId(data.groupId) ||
        !isStr(data.rootName, 128) ||
        !isPeerId(data.hostId) ||
        !Array.isArray(data.editors) ||
        data.editors.length > 64 ||
        !data.editors.every(isPeerId)
      ) {
        return undefined;
      }
      return {
        kind: 'SESSION_STATE',
        sessionId,
        groupId: data.groupId,
        rootName: data.rootName,
        hostId: data.hostId,
        editors: [...data.editors],
      };
    case 'SESSION_END':
      return { kind: 'SESSION_END', sessionId };
    case 'FS_REQUEST':
      if (!isId(data.reqId) || !FS_OPS.includes(data.op as FsOp) || !isSharePath(data.path)) return undefined;
      return { kind: 'FS_REQUEST', sessionId, reqId: data.reqId, op: data.op as FsOp, path: data.path };
    case 'FS_RESPONSE': {
      if (!isId(data.reqId)) return undefined;
      if (data.ok === false) {
        if (!FS_ERRORS.includes(data.error as FsErrorCode)) return undefined;
        const message = isStr(data.message, 200) ? data.message : undefined;
        return { kind: 'FS_RESPONSE', sessionId, reqId: data.reqId, ok: false, error: data.error as FsErrorCode, message };
      }
      if (data.ok !== true) return undefined;
      if (data.stat !== undefined && !isStat(data.stat)) return undefined;
      if (
        data.entries !== undefined &&
        (!Array.isArray(data.entries) || data.entries.length > MAX_DIR_ENTRIES || !data.entries.every(isEntry))
      ) {
        return undefined;
      }
      if (data.dataB64 !== undefined && !isB64(data.dataB64)) return undefined;
      return {
        kind: 'FS_RESPONSE',
        sessionId,
        reqId: data.reqId,
        ok: true,
        ...(data.stat ? { stat: { ...(data.stat as SharedStat) } } : {}),
        ...(data.entries ? { entries: (data.entries as SharedDirEntry[]).map((e) => ({ name: e.name, type: e.type })) } : {}),
        ...(data.dataB64 !== undefined ? { dataB64: data.dataB64 as string } : {}),
      };
    }
    case 'FS_CHANGED':
      if (!Array.isArray(data.paths) || data.paths.length > MAX_CHANGED_PATHS || !data.paths.every(isSharePath)) {
        return undefined;
      }
      return { kind: 'FS_CHANGED', sessionId, paths: [...data.paths] };
    case 'DOC_OPEN':
    case 'DOC_CLOSE':
      return isSharePath(data.path) && data.path !== '' ? { kind: data.kind, sessionId, path: data.path } : undefined;
    case 'DOC_SYNC':
      if (!isSharePath(data.path) || !isB64(data.stateB64) || typeof data.canEdit !== 'boolean') return undefined;
      return { kind: 'DOC_SYNC', sessionId, path: data.path, stateB64: data.stateB64, canEdit: data.canEdit };
    case 'DOC_ERROR':
      if (!isSharePath(data.path) || !(data.error === 'binary' || FS_ERRORS.includes(data.error as FsErrorCode))) {
        return undefined;
      }
      return { kind: 'DOC_ERROR', sessionId, path: data.path, error: data.error as DocErrorCode };
    case 'DOC_UPDATE':
      return isSharePath(data.path) && data.path !== '' && isB64(data.updateB64)
        ? { kind: 'DOC_UPDATE', sessionId, path: data.path, updateB64: data.updateB64 }
        : undefined;
    case 'AWARENESS':
      return isB64(data.updateB64) ? { kind: 'AWARENESS', sessionId, updateB64: data.updateB64 } : undefined;
    default:
      return undefined;
  }
}

/** Validates an awareness state published by someone else; drops anything unexpected. */
export function parseAwarenessState(v: unknown): PeerAwarenessState | undefined {
  if (!isObj(v) || !isObj(v.user)) return undefined;
  const { user } = v;
  if (!isPeerId(user.peerId) || !isStr(user.name, 64) || !isStr(user.color, 16) || !/^#[0-9a-fA-F]{6}$/.test(user.color)) {
    return undefined;
  }
  const activeFile = v.activeFile === null || v.activeFile === undefined ? null : v.activeFile;
  if (activeFile !== null && (!isSharePath(activeFile) || activeFile === '')) return undefined;
  let cursor: PeerAwarenessState['cursor'] = null;
  if (isObj(v.cursor) && isObj(v.cursor.anchor) && isObj(v.cursor.head)) {
    cursor = { anchor: v.cursor.anchor, head: v.cursor.head };
  }
  return { user: { peerId: user.peerId, name: user.name, color: user.color }, activeFile, cursor };
}

const PALETTE = ['#e06c75', '#61afef', '#98c379', '#d19a66', '#c678dd', '#56b6c2', '#e5c07b', '#be5046'];

/** Every peer computes the same colour for a given peer id. */
export function colorFor(peerId: string): string {
  let hash = 0;
  for (const ch of peerId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
