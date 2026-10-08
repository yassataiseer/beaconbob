import {
  type ConversationId,
  type ConversationStore,
  dmConversationId,
  groupConversationId,
  parseConversationId,
} from '../chat/conversationStore';
import type { PeerRegistry } from '../discovery/peerRegistry';
import type { GroupHost, HostedGroupView } from '../groups/groupHost';
import type { GroupEndReason, GroupMember, JoinedGroup } from '../groups/groupMember';
import type { Identity } from '../security/identity';
import type { PeerManager } from '../transport/peerManager';
import type {
  ConversationDetail,
  ConversationSummary,
  InvitableView,
  JoinRequestView,
  MemberView,
  PeerView,
  PublicGroupView,
  UiState,
} from './ipcTypes';

export interface StateSources {
  identity: Identity;
  selfName: string;
  port: number | null;
  addresses: string[];
  registry: PeerRegistry;
  peers: PeerManager;
  store: ConversationStore;
  host: GroupHost;
  member: GroupMember;
  error: string | null;
}

const ENDED_TEXT: Record<GroupEndReason, string> = {
  closed: 'The host closed this group.',
  removed: 'You were removed from this group.',
  'host-left': 'The host disconnected, so this group has ended.',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function buildPeers(s: StateSources): PeerView[] {
  const views = new Map<string, PeerView>();
  for (const peer of s.registry.list()) {
    views.set(peer.peerId, {
      peerId: peer.peerId,
      name: peer.name,
      workspace: peer.workspace,
      fingerprint: peer.fingerprint,
      state: s.peers.stateOf(peer.peerId) ?? 'available',
      onNetwork: true,
      address: peer.addresses[0] ?? null,
    });
  }
  for (const remote of s.peers.connected()) {
    views.set(remote.peerId, {
      peerId: remote.peerId,
      name: remote.name,
      workspace: remote.workspace,
      fingerprint: remote.fingerprint,
      state: 'connected',
      onNetwork: views.get(remote.peerId)?.onNetwork ?? false,
      address: remote.address,
    });
  }
  const order = { connected: 0, connecting: 1, available: 2 };
  return [...views.values()].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
}

function peerName(s: StateSources, peerId: string): string {
  return s.peers.remote(peerId)?.name ?? s.registry.get(peerId)?.name ?? 'Unknown peer';
}

function hostedSummary(s: StateSources, g: HostedGroupView): ConversationSummary {
  const id = groupConversationId(g.groupId);
  return {
    id,
    kind: 'group',
    title: `#${g.name}`,
    subtitle: `${g.visibility} · ${plural(g.members.length, 'member')} · you host`,
    unread: s.store.unread(id),
    lastActivity: s.store.lastActivity(id),
    ended: null,
    isHost: true,
  };
}

function joinedSummary(s: StateSources, g: JoinedGroup): ConversationSummary {
  const id = groupConversationId(g.groupId);
  const hostName = g.members.find((m) => m.peerId === g.hostId)?.name ?? peerName(s, g.hostId);
  return {
    id,
    kind: 'group',
    title: `#${g.name}`,
    subtitle: `${plural(g.members.length, 'member')} · hosted by ${hostName}`,
    unread: s.store.unread(id),
    lastActivity: s.store.lastActivity(id),
    ended: g.ended ? ENDED_TEXT[g.ended] : null,
    isHost: false,
  };
}

function dmSummary(s: StateSources, peerId: string): ConversationSummary {
  const id = dmConversationId(peerId);
  return {
    id,
    kind: 'dm',
    title: peerName(s, peerId),
    subtitle: s.peers.isConnected(peerId) ? 'connected' : 'offline',
    unread: s.store.unread(id),
    lastActivity: s.store.lastActivity(id),
    ended: null,
    isHost: false,
  };
}

function members(s: StateSources, list: Array<{ peerId: string; name: string; fingerprint: string }>, hostId: string): MemberView[] {
  return list.map((m) => ({ ...m, isHost: m.peerId === hostId, isSelf: m.peerId === s.identity.peerId }));
}

function joinRequestViews(s: StateSources): JoinRequestView[] {
  return s.host.joinRequests().map((r) => ({
    groupId: r.groupId,
    groupName: r.groupName,
    peerId: r.peer.peerId,
    name: r.peer.name,
    fingerprint: r.peer.fingerprint,
  }));
}

function invitable(s: StateSources, g: HostedGroupView): InvitableView[] {
  const inGroup = new Set(g.members.map((m) => m.peerId));
  const invited = new Set(g.invited);
  return buildPeers(s)
    .filter((p) => !inGroup.has(p.peerId) && (p.onNetwork || p.state === 'connected'))
    .map((p) => ({ peerId: p.peerId, name: p.name, invited: invited.has(p.peerId) }));
}

function detail(s: StateSources, id: ConversationId, summary: ConversationSummary): ConversationDetail {
  const parsed = parseConversationId(id)!;
  const base = {
    ...summary,
    messages: s.store.messages(id).map(({ id: mid, kind, senderName, content, timestamp, fromSelf }) => ({
      id: mid,
      kind,
      senderName,
      content,
      timestamp,
      fromSelf,
    })),
    typing: s.store.typingNames(id),
    groupId: null,
    peerId: null,
    visibility: null,
    members: [],
    joinRequests: [],
    invitable: [],
  };
  if (parsed.kind === 'dm') {
    return { ...base, peerId: parsed.key, canSend: s.peers.isConnected(parsed.key) };
  }
  const hosted = s.host.hosted().find((g) => g.groupId === parsed.key);
  if (hosted) {
    return {
      ...base,
      groupId: hosted.groupId,
      visibility: hosted.visibility,
      canSend: true,
      members: members(s, hosted.members, s.identity.peerId),
      joinRequests: joinRequestViews(s).filter((r) => r.groupId === hosted.groupId),
      invitable: invitable(s, hosted),
    };
  }
  const joined = s.member.group(parsed.key);
  return {
    ...base,
    groupId: parsed.key,
    visibility: joined?.visibility ?? null,
    canSend: !!joined && !joined.ended && s.peers.isConnected(joined.hostId),
    members: joined ? members(s, joined.members, joined.hostId) : [],
  };
}

/** Snapshot of everything the sidebar shows. */
export function buildUiState(s: StateSources): UiState {
  const summaries = new Map<ConversationId, ConversationSummary>();
  for (const g of s.host.hosted()) summaries.set(groupConversationId(g.groupId), hostedSummary(s, g));
  for (const g of s.member.joined()) summaries.set(groupConversationId(g.groupId), joinedSummary(s, g));
  for (const id of s.store.ids()) {
    const parsed = parseConversationId(id);
    if (parsed?.kind === 'dm') summaries.set(id, dmSummary(s, parsed.key));
  }

  const activeId = s.store.activeId;
  const activeSummary = activeId ? summaries.get(activeId) : undefined;

  const publicGroups: PublicGroupView[] = s.registry.list().flatMap((peer) =>
    peer.publicGroups.map((g) => {
      const joined = s.member.group(g.groupId);
      const state: PublicGroupView['state'] =
        joined && !joined.ended ? 'joined' : s.member.isPending(g.groupId) ? 'requested' : 'available';
      return { groupId: g.groupId, name: g.name, hostId: peer.peerId, hostName: peer.name, state };
    }),
  );

  return {
    self: {
      peerId: s.identity.peerId,
      name: s.selfName,
      fingerprint: s.identity.fingerprint,
      port: s.port,
      addresses: s.addresses,
    },
    peers: buildPeers(s),
    conversations: [...summaries.values()].sort((a, b) => b.lastActivity - a.lastActivity),
    active: activeId && activeSummary ? detail(s, activeId, activeSummary) : null,
    publicGroups,
    invitations: s.member.pendingInvitations().map((i) => ({ ...i })),
    joinRequests: joinRequestViews(s),
    error: s.error,
  };
}
