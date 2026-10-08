import type { FromWebview } from './ipcTypes';

const MAX_ID = 128;
const MAX_TEXT = 10_000;

const str = (v: unknown, max = MAX_ID): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const bool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Validates a message posted by the webview. The webview is our code, but it renders peer data. */
export function parseFromWebview(raw: unknown): FromWebview | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'dismissError':
    case 'closeConversation':
    case 'stopSharing':
    case 'openSharedFiles':
      return { type: m.type };
    case 'startSharing':
    case 'mountShared':
      return str(m.groupId) ? { type: m.type, groupId: m.groupId } : undefined;
    case 'setCanEdit':
      return str(m.peerId) && bool(m.canEdit) ? { type: 'setCanEdit', peerId: m.peerId, canEdit: m.canEdit } : undefined;
    case 'followPeer':
      return str(m.groupId) && str(m.peerId) ? { type: 'followPeer', groupId: m.groupId, peerId: m.peerId } : undefined;
    case 'connect':
    case 'disconnect':
    case 'startDm':
      return str(m.peerId) ? { type: m.type, peerId: m.peerId } : undefined;
    case 'openConversation':
      return str(m.id) ? { type: 'openConversation', id: m.id } : undefined;
    case 'sendMessage':
      return str(m.conversationId) && str(m.content, MAX_TEXT)
        ? { type: 'sendMessage', conversationId: m.conversationId, content: m.content }
        : undefined;
    case 'typing':
      return str(m.conversationId) && bool(m.isTyping)
        ? { type: 'typing', conversationId: m.conversationId, isTyping: m.isTyping }
        : undefined;
    case 'createGroup':
      return str(m.name, 200) && (m.visibility === 'public' || m.visibility === 'private')
        ? { type: 'createGroup', name: m.name, visibility: m.visibility }
        : undefined;
    case 'joinGroup':
      return str(m.hostId) && str(m.groupId) ? { type: 'joinGroup', hostId: m.hostId, groupId: m.groupId } : undefined;
    case 'inviteToGroup':
    case 'removeMember':
      return str(m.groupId) && str(m.peerId) ? { type: m.type, groupId: m.groupId, peerId: m.peerId } : undefined;
    case 'respondInvite':
      return str(m.groupId) && bool(m.accept) ? { type: 'respondInvite', groupId: m.groupId, accept: m.accept } : undefined;
    case 'respondJoinRequest':
      return str(m.groupId) && str(m.peerId) && bool(m.accept)
        ? { type: 'respondJoinRequest', groupId: m.groupId, peerId: m.peerId, accept: m.accept }
        : undefined;
    case 'leaveGroup':
    case 'closeGroup':
      return str(m.groupId) ? { type: m.type, groupId: m.groupId } : undefined;
    default:
      return undefined;
  }
}
