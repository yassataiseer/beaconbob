/**
 * `lanVoice` channel payloads. Audio itself never touches these connections: it flows over
 * WebRTC directly between the participants' companion browser pages. These messages only
 * say who is in which call and carry the WebRTC offers, answers and ICE candidates.
 *
 * Group calls are coordinated by the group's host (members are only connected to the host,
 * who forwards signals between them and vouches for the sender). A DM call is between two
 * directly connected peers.
 */
import { isGroupId } from '../signaling/protocolTypes';

export type CallScope = 'group' | 'dm';

export interface IceCandidateInit {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export type VoiceSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: IceCandidateInit };

export type VoicePayload =
  | { kind: 'VOICE_JOIN'; scope: CallScope; groupId?: string }
  | { kind: 'VOICE_LEAVE'; scope: CallScope; groupId?: string }
  /** Host to every group member: who is in the group's call right now. */
  | { kind: 'VOICE_STATE'; groupId: string; participants: string[] }
  /** `from` is only set by a host forwarding a signal between two members. */
  | { kind: 'VOICE_SIGNAL'; scope: CallScope; groupId?: string; to: string; from?: string; signal: VoiceSignal };

export const MAX_CALL_PARTICIPANTS = 8;
const MAX_SDP = 32 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPeerId = (v: unknown): v is string => typeof v === 'string' && /^p-[0-9a-f]{16}$/.test(v);
const isStrOrNull = (v: unknown, max: number) => v === null || v === undefined || (typeof v === 'string' && v.length <= max);

export function parseVoiceSignal(v: unknown): VoiceSignal | undefined {
  if (!isObj(v)) return undefined;
  if (v.type === 'offer' || v.type === 'answer') {
    return typeof v.sdp === 'string' && v.sdp.length > 0 && v.sdp.length <= MAX_SDP ? { type: v.type, sdp: v.sdp } : undefined;
  }
  if (v.type === 'ice' && isObj(v.candidate)) {
    const c = v.candidate;
    if (typeof c.candidate !== 'string' || c.candidate.length > 1024) return undefined;
    if (!isStrOrNull(c.sdpMid, 64) || !isStrOrNull(c.usernameFragment, 256)) return undefined;
    const index = c.sdpMLineIndex;
    if (index !== null && index !== undefined && !(Number.isInteger(index) && (index as number) >= 0 && (index as number) < 16)) {
      return undefined;
    }
    return {
      type: 'ice',
      candidate: {
        candidate: c.candidate,
        sdpMid: (c.sdpMid as string | null | undefined) ?? null,
        sdpMLineIndex: (index as number | null | undefined) ?? null,
        usernameFragment: (c.usernameFragment as string | null | undefined) ?? null,
      },
    };
  }
  return undefined;
}

function scopeFields(v: Obj): { scope: CallScope; groupId?: string } | undefined {
  if (v.scope === 'dm') return v.groupId === undefined ? { scope: 'dm' } : undefined;
  if (v.scope === 'group') return isGroupId(v.groupId) ? { scope: 'group', groupId: v.groupId } : undefined;
  return undefined;
}

/** Validates a `lanVoice` payload, copying only known fields. */
export function parseVoicePayload(data: unknown): VoicePayload | undefined {
  if (!isObj(data)) return undefined;
  switch (data.kind) {
    case 'VOICE_JOIN':
    case 'VOICE_LEAVE': {
      const scope = scopeFields(data);
      return scope ? { kind: data.kind, ...scope } : undefined;
    }
    case 'VOICE_STATE':
      if (
        !isGroupId(data.groupId) ||
        !Array.isArray(data.participants) ||
        data.participants.length > MAX_CALL_PARTICIPANTS ||
        !data.participants.every(isPeerId)
      ) {
        return undefined;
      }
      return { kind: 'VOICE_STATE', groupId: data.groupId, participants: [...new Set(data.participants as string[])] };
    case 'VOICE_SIGNAL': {
      const scope = scopeFields(data);
      const signal = parseVoiceSignal(data.signal);
      if (!scope || !signal || !isPeerId(data.to)) return undefined;
      if (data.from !== undefined && !isPeerId(data.from)) return undefined;
      return {
        kind: 'VOICE_SIGNAL',
        ...scope,
        to: data.to,
        ...(data.from !== undefined ? { from: data.from as string } : {}),
        signal,
      };
    }
    default:
      return undefined;
  }
}
