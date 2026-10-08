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
  /** People in this conversation's voice call right now (including you). */
  inCallCount: number;
}

export interface ConversationVoiceView {
  /** Whether you are in this conversation's call. */
  joined: boolean;
  /** Names of the others in the call. */
  others: string[];
  canJoin: boolean;
}

export type MicStateView = 'unknown' | 'ok' | 'denied' | 'error';

export interface VoiceParticipantView {
  peerId: string;
  name: string;
  speaking: boolean;
  state: 'connecting' | 'connected' | 'failed';
}

export interface VoiceView {
  /** The call you are in, if any. */
  call: { conversationId: string; title: string } | null;
  pageConnected: boolean;
  mic: MicStateView;
  micMessage: string | null;
  muted: boolean;
  selfSpeaking: boolean;
  participants: VoiceParticipantView[];
  /** Set when the local voice server could not start. */
  unavailable: string | null;
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

export interface ParticipantView {
  peerId: string;
  name: string;
  color: string;
  /** Shared-relative path of the file they are in, if any. */
  activeFile: string | null;
}

export interface SharingView {
  /** Whether a workspace is being shared with this group right now. */
  active: boolean;
  rootName: string | null;
  isHost: boolean;
  hostName: string;
  /** Guests: whether you may edit. Host: always true. */
  canEdit: boolean;
  /** Peer ids the host has granted edit access. */
  editors: string[];
  participants: ParticipantView[];
  /** Host only: why sharing cannot start here, if it cannot. */
  cannotShareReason: string | null;
  /** Guests: "Open in Explorer" needs a folder already open in this window. */
  canMount: boolean;
}

export interface ConversationDetail extends ConversationSummary {
  /** Workspace sharing for this group (null for direct messages). */
  sharing: SharingView | null;
  voice: ConversationVoiceView;
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
  voice: VoiceView;
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
  | { type: 'removeMember'; groupId: string; peerId: string }
  | { type: 'startSharing'; groupId: string }
  | { type: 'stopSharing' }
  | { type: 'setCanEdit'; peerId: string; canEdit: boolean }
  | { type: 'openSharedFiles' }
  | { type: 'mountShared'; groupId: string }
  | { type: 'followPeer'; groupId: string; peerId: string }
  | { type: 'joinVoice'; conversationId: string }
  | { type: 'leaveVoice' }
  | { type: 'setMuted'; muted: boolean }
  | { type: 'openVoicePage' };
