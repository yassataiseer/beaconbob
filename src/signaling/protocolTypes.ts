/**
 * Wire protocol shared by every BeaconBob peer. All frames are JSON `SignalingMessage`
 * envelopes. The handshake (HELLO, HELLO_ACK, AUTH, HELLO_REJECT) is sent in the clear; every
 * frame after the responder accepts goes through the session's frame codec.
 */

export const SIGNALING_VERSION = '1.0';
/** Upper bound for a single WebSocket frame, enforced by `ws` via `maxPayload`. */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_CHAT_LENGTH = 8000;

export type ChannelName = 'lanChat' | 'lanCodeSync' | 'lanVoice';
export const CHANNEL_NAMES: readonly ChannelName[] = ['lanChat', 'lanCodeSync', 'lanVoice'];

export type SignalingType =
  // Reserved for Phase 2 (WebRTC audio negotiation).
  | 'OFFER'
  | 'ANSWER'
  | 'ICE_CANDIDATE'
  | 'ROOM_STATE'
  // Handshake.
  | 'HELLO'
  | 'HELLO_ACK'
  | 'HELLO_REJECT'
  | 'AUTH'
  | 'WELCOME'
  // Session.
  | 'CHANNEL'
  | 'PING'
  | 'BYE';

export interface SignalingMessage<T = unknown> {
  version: typeof SIGNALING_VERSION;
  type: SignalingType;
  senderId: string;
  targetId: string;
  sessionId: string;
  payload: T;
}

export interface HelloPayload {
  name: string;
  workspace: string;
  appVersion: string;
  /** Long-lived Ed25519 key, base64 SPKI DER. */
  publicKey: string;
  /** 32 random bytes, base64. */
  nonce: string;
  /** Per-session X25519 key, base64 SPKI DER. */
  ephemeralKey: string;
  /** Why the initiator is connecting. Changes the approval prompt; absent for a plain connect. */
  intent?: ConnectIntent;
}

export type ConnectIntent =
  | { kind: 'join'; groupId: string }
  | { kind: 'invite'; groupId: string; groupName: string };

export interface HelloAckPayload extends HelloPayload {
  /** Responder's signature over the handshake transcript. */
  signature: string;
}

export type RejectReason =
  | 'declined'
  | 'busy'
  | 'duplicate'
  | 'already-connected'
  | 'wrong-target'
  | 'auth-failed'
  | 'protocol-error'
  | 'timeout';

const REJECT_REASONS: readonly RejectReason[] = [
  'declined',
  'busy',
  'duplicate',
  'already-connected',
  'wrong-target',
  'auth-failed',
  'protocol-error',
  'timeout',
];

export interface HelloRejectPayload {
  reason: RejectReason;
}

export interface AuthPayload {
  /** Initiator's signature over the handshake transcript. */
  signature: string;
}

export type WelcomePayload = Record<string, never>;

export interface ChannelPayload {
  channel: ChannelName;
  data: unknown;
}

export interface PingPayload {
  ts: number;
}

export interface ByePayload {
  reason: string;
}

type Msg<K extends SignalingType, P> = SignalingMessage<P> & { type: K };

export type ProtocolMessage =
  | Msg<'HELLO', HelloPayload>
  | Msg<'HELLO_ACK', HelloAckPayload>
  | Msg<'HELLO_REJECT', HelloRejectPayload>
  | Msg<'AUTH', AuthPayload>
  | Msg<'WELCOME', WelcomePayload>
  | Msg<'CHANNEL', ChannelPayload>
  | Msg<'PING', PingPayload>
  | Msg<'BYE', ByePayload>;

export type PayloadOf<K extends ProtocolMessage['type']> = Extract<ProtocolMessage, { type: K }>['payload'];

export interface Envelope {
  senderId: string;
  targetId: string;
  sessionId: string;
}

export function createMessage<K extends ProtocolMessage['type']>(
  type: K,
  payload: PayloadOf<K>,
  envelope: Envelope,
): Extract<ProtocolMessage, { type: K }> {
  return { version: SIGNALING_VERSION, type, ...envelope, payload } as Extract<ProtocolMessage, { type: K }>;
}

// ---------------------------------------------------------------------------------------------
// Validation. Everything off the wire is untrusted.

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown, max: number, min = 0): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function isB64(v: unknown, max: number): v is string {
  return isStr(v, max, 1) && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const ID_MAX = 64;
const NAME_MAX = 64;
export const MAX_GROUP_NAME = 32;
export const MAX_GROUP_MEMBERS = 32;
export const MAX_GROUP_HISTORY = 50;

const GROUP_ID_PATTERN = /^g-[0-9a-f]{12}$/;
const PEER_ID_PATTERN = /^p-[0-9a-f]{16}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/;

export function isGroupId(v: unknown): v is string {
  return typeof v === 'string' && GROUP_ID_PATTERN.test(v);
}

function isPeerId(v: unknown): v is string {
  return typeof v === 'string' && PEER_ID_PATTERN.test(v);
}

function isGroupName(v: unknown): v is string {
  return isStr(v, MAX_GROUP_NAME, 1) && !v.includes('|');
}

function isIntent(v: unknown): v is ConnectIntent {
  if (!isObj(v) || !isGroupId(v.groupId)) return false;
  if (v.kind === 'join') return true;
  return v.kind === 'invite' && isGroupName(v.groupName);
}

function isHello(p: unknown): p is HelloPayload {
  return (
    isObj(p) &&
    isStr(p.name, NAME_MAX, 1) &&
    isStr(p.workspace, 64) &&
    isStr(p.appVersion, 16) &&
    isB64(p.publicKey, 128) &&
    isB64(p.nonce, 64) &&
    isB64(p.ephemeralKey, 128) &&
    (p.intent === undefined || isIntent(p.intent))
  );
}

function isPayloadValid(type: SignalingType, p: unknown): boolean {
  switch (type) {
    case 'HELLO':
      return isHello(p);
    case 'HELLO_ACK':
      return isHello(p) && isB64((p as HelloPayload & Obj).signature, 128);
    case 'HELLO_REJECT':
      return isObj(p) && REJECT_REASONS.includes(p.reason as RejectReason);
    case 'AUTH':
      return isObj(p) && isB64(p.signature, 128);
    case 'WELCOME':
      return isObj(p);
    case 'CHANNEL':
      return isObj(p) && CHANNEL_NAMES.includes(p.channel as ChannelName) && 'data' in p;
    case 'PING':
      return isObj(p) && isFiniteNum(p.ts);
    case 'BYE':
      return isObj(p) && isStr(p.reason, 64);
    default:
      return false;
  }
}

/** Parses and validates a frame. Returns `undefined` for anything malformed or unsupported. */
export function parseMessage(raw: string): ProtocolMessage | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isObj(msg) ||
    msg.version !== SIGNALING_VERSION ||
    !isStr(msg.type, 32) ||
    !isStr(msg.senderId, ID_MAX, 1) ||
    !isStr(msg.targetId, ID_MAX, 1) ||
    !isStr(msg.sessionId, ID_MAX, 1) ||
    !isPayloadValid(msg.type as SignalingType, msg.payload)
  ) {
    return undefined;
  }
  return msg as unknown as ProtocolMessage;
}

// ---------------------------------------------------------------------------------------------
// lanChat channel payloads (design doc section 3.5). The doc's `ChatEnvelope.senderId` is
// carried by the outer `SignalingMessage`, so a CHANNEL frame's `data` is the bare payload.

export type GroupVisibility = 'public' | 'private';

export interface GroupMemberInfo {
  peerId: string;
  name: string;
  fingerprint: string;
}

/** A message as the host forwards it: the host vouches for who sent it. */
export interface RelayedMessage {
  senderId: string;
  senderName: string;
  messageId: string;
  content: string;
  timestamp: number;
}

export type GroupRemovedReason = 'removed' | 'closed' | 'declined';

/**
 * `TEXT` and `TYPING_STATUS` without a `groupId` are direct messages. With a `groupId` they go
 * from a member to the group's host, which forwards them as `GROUP_RELAY` / `GROUP_TYPING`.
 * Every other `GROUP_*` kind is either a member's request to the host or the host's answer.
 */
export type ChatPayload =
  | { kind: 'TEXT'; messageId: string; content: string; timestamp: number; groupId?: string }
  | { kind: 'TYPING_STATUS'; isTyping: boolean; groupId?: string }
  | ({ kind: 'GROUP_RELAY'; groupId: string } & RelayedMessage)
  | { kind: 'GROUP_TYPING'; groupId: string; senderId: string; senderName: string; isTyping: boolean }
  | {
      kind: 'GROUP_STATE';
      groupId: string;
      name: string;
      visibility: GroupVisibility;
      hostId: string;
      members: GroupMemberInfo[];
    }
  | { kind: 'GROUP_HISTORY'; groupId: string; messages: RelayedMessage[] }
  | { kind: 'GROUP_JOIN_REQUEST'; groupId: string }
  | { kind: 'GROUP_INVITE'; groupId: string; groupName: string }
  | { kind: 'GROUP_INVITE_RESPONSE'; groupId: string; accept: boolean }
  | { kind: 'GROUP_LEAVE'; groupId: string }
  | { kind: 'GROUP_REMOVED'; groupId: string; reason: GroupRemovedReason }
  // Defined by the design doc, not implemented yet.
  | { kind: 'FILE_TRANSFER_OFFER'; fileId: string; fileName: string; sizeBytes: number }
  | { kind: 'FILE_CHUNK'; fileId: string; chunkIndex: number; base64Data: string };

function parseRelayed(v: unknown): RelayedMessage | undefined {
  if (
    !isObj(v) ||
    !isPeerId(v.senderId) ||
    !isStr(v.senderName, NAME_MAX, 1) ||
    !isStr(v.messageId, ID_MAX, 1) ||
    !isStr(v.content, MAX_CHAT_LENGTH, 1) ||
    !isFiniteNum(v.timestamp)
  ) {
    return undefined;
  }
  return {
    senderId: v.senderId,
    senderName: v.senderName,
    messageId: v.messageId,
    content: v.content,
    timestamp: v.timestamp,
  };
}

function parseMember(v: unknown): GroupMemberInfo | undefined {
  if (!isObj(v) || !isPeerId(v.peerId) || !isStr(v.name, NAME_MAX, 1) || !isStr(v.fingerprint, 64)) {
    return undefined;
  }
  if (!FINGERPRINT_PATTERN.test(v.fingerprint)) return undefined;
  return { peerId: v.peerId, name: v.name, fingerprint: v.fingerprint };
}

function optionalGroupId(v: unknown): { ok: boolean; groupId?: string } {
  if (v === undefined) return { ok: true };
  return isGroupId(v) ? { ok: true, groupId: v } : { ok: false };
}

/** Validates and copies a `lanChat` payload, dropping unknown fields. */
export function parseChatPayload(data: unknown): ChatPayload | undefined {
  if (!isObj(data)) return undefined;
  switch (data.kind) {
    case 'TEXT': {
      const group = optionalGroupId(data.groupId);
      if (
        !group.ok ||
        !isStr(data.messageId, ID_MAX, 1) ||
        !isStr(data.content, MAX_CHAT_LENGTH, 1) ||
        !isFiniteNum(data.timestamp)
      ) {
        return undefined;
      }
      return {
        kind: 'TEXT',
        messageId: data.messageId,
        content: data.content,
        timestamp: data.timestamp,
        ...(group.groupId ? { groupId: group.groupId } : {}),
      };
    }
    case 'TYPING_STATUS': {
      const group = optionalGroupId(data.groupId);
      if (!group.ok || typeof data.isTyping !== 'boolean') return undefined;
      return { kind: 'TYPING_STATUS', isTyping: data.isTyping, ...(group.groupId ? { groupId: group.groupId } : {}) };
    }
    case 'GROUP_RELAY': {
      const msg = parseRelayed(data);
      return msg && isGroupId(data.groupId) ? { kind: 'GROUP_RELAY', groupId: data.groupId, ...msg } : undefined;
    }
    case 'GROUP_TYPING':
      if (
        !isGroupId(data.groupId) ||
        !isPeerId(data.senderId) ||
        !isStr(data.senderName, NAME_MAX, 1) ||
        typeof data.isTyping !== 'boolean'
      ) {
        return undefined;
      }
      return {
        kind: 'GROUP_TYPING',
        groupId: data.groupId,
        senderId: data.senderId,
        senderName: data.senderName,
        isTyping: data.isTyping,
      };
    case 'GROUP_STATE': {
      if (
        !isGroupId(data.groupId) ||
        !isGroupName(data.name) ||
        (data.visibility !== 'public' && data.visibility !== 'private') ||
        !isPeerId(data.hostId) ||
        !Array.isArray(data.members) ||
        data.members.length > MAX_GROUP_MEMBERS
      ) {
        return undefined;
      }
      const members = data.members.map(parseMember);
      if (members.some((m) => !m)) return undefined;
      return {
        kind: 'GROUP_STATE',
        groupId: data.groupId,
        name: data.name,
        visibility: data.visibility,
        hostId: data.hostId,
        members: members as GroupMemberInfo[],
      };
    }
    case 'GROUP_HISTORY': {
      if (!isGroupId(data.groupId) || !Array.isArray(data.messages) || data.messages.length > MAX_GROUP_HISTORY) {
        return undefined;
      }
      const messages = data.messages.map(parseRelayed);
      if (messages.some((m) => !m)) return undefined;
      return { kind: 'GROUP_HISTORY', groupId: data.groupId, messages: messages as RelayedMessage[] };
    }
    case 'GROUP_JOIN_REQUEST':
    case 'GROUP_LEAVE':
      return isGroupId(data.groupId) ? { kind: data.kind, groupId: data.groupId } : undefined;
    case 'GROUP_INVITE':
      return isGroupId(data.groupId) && isGroupName(data.groupName)
        ? { kind: 'GROUP_INVITE', groupId: data.groupId, groupName: data.groupName }
        : undefined;
    case 'GROUP_INVITE_RESPONSE':
      return isGroupId(data.groupId) && typeof data.accept === 'boolean'
        ? { kind: 'GROUP_INVITE_RESPONSE', groupId: data.groupId, accept: data.accept }
        : undefined;
    case 'GROUP_REMOVED':
      return isGroupId(data.groupId) &&
        (data.reason === 'removed' || data.reason === 'closed' || data.reason === 'declined')
        ? { kind: 'GROUP_REMOVED', groupId: data.groupId, reason: data.reason }
        : undefined;
    default:
      return undefined;
  }
}
