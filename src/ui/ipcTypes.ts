/**
 * Messages between the extension host and the sidebar webview. Shared by both builds, so this
 * file must stay free of runtime imports.
 */

export interface SelfView {
  peerId: string;
  name: string;
  fingerprint: string;
  port: number | null;
  addresses: string[];
}

export type PeerViewState = 'available' | 'connecting' | 'connected';

export interface PeerView {
  peerId: string;
  name: string;
  workspace: string;
  fingerprint: string;
  state: PeerViewState;
  /** False once the peer stopped answering mDNS but a live connection remains. */
  onNetwork: boolean;
  address: string | null;
}

export interface ChatMessageView {
  id: string;
  kind: 'text' | 'system';
  senderName: string;
  content: string;
  timestamp: number;
  fromSelf: boolean;
}

export type ConversationKind = 'dm' | 'group';
export type GroupVisibilityView = 'public' | 'private';

export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  title: string;
  subtitle: string;
  unread: number;
  lastActivity: number;
  /** Why the conversation can no longer be used, if it can't. */
  ended: string | null;
  isHost: boolean;
}

export interface MemberView {
  peerId: string;
  name: string;
  fingerprint: string;
  isHost: boolean;
  isSelf: boolean;
}

export interface JoinRequestView {
  groupId: string;
  groupName: string;
  peerId: string;
  name: string;
  fingerprint: string;
}

export interface InvitableView {
  peerId: string;
  name: string;
  invited: boolean;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessageView[];
  typing: string[];
  canSend: boolean;
  groupId: string | null;
  peerId: string | null;
  visibility: GroupVisibilityView | null;
  members: MemberView[];
  joinRequests: JoinRequestView[];
  /** Host only: people who could be invited. */
  invitable: InvitableView[];
}

export interface PublicGroupView {
  groupId: string;
  name: string;
  hostId: string;
  hostName: string;
  state: 'available' | 'requested' | 'joined';
}

export interface InvitationView {
  groupId: string;
  groupName: string;
  hostId: string;
  hostName: string;
}

export interface UiState {
  self: SelfView;
  peers: PeerView[];
  conversations: ConversationSummary[];
  /** The open conversation, or null on the home view. */
  active: ConversationDetail | null;
  publicGroups: PublicGroupView[];
  invitations: InvitationView[];
  joinRequests: JoinRequestView[];
  error: string | null;
}

export type ToWebview = { type: 'state'; state: UiState };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'dismissError' }
  | { type: 'connect'; peerId: string }
  | { type: 'disconnect'; peerId: string }
  | { type: 'openConversation'; id: string }
  | { type: 'closeConversation' }
  | { type: 'sendMessage'; conversationId: string; content: string }
  | { type: 'typing'; conversationId: string; isTyping: boolean }
  | { type: 'startDm'; peerId: string }
  | { type: 'createGroup'; name: string; visibility: GroupVisibilityView }
  | { type: 'joinGroup'; hostId: string; groupId: string }
  | { type: 'inviteToGroup'; groupId: string; peerId: string }
  | { type: 'respondInvite'; groupId: string; accept: boolean }
  | { type: 'respondJoinRequest'; groupId: string; peerId: string; accept: boolean }
  | { type: 'leaveGroup'; groupId: string }
  | { type: 'closeGroup'; groupId: string }
  | { type: 'removeMember'; groupId: string; peerId: string };
