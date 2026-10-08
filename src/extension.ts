import * as os from 'node:os';
import * as vscode from 'vscode';
import { ChatService } from './chat/chatService';
import { ConversationStore, groupConversationId, parseConversationId, type ConversationId } from './chat/conversationStore';
import { type MdnsProfile, MdnsService } from './discovery/mdnsService';
import { PeerRegistry } from './discovery/peerRegistry';
import { GroupHost } from './groups/groupHost';
import { GroupMember } from './groups/groupMember';
import { loadOrCreateIdentity } from './security/identity';
import { HandshakeError, type LocalProfile } from './signaling/handshakeCommon';
import type { ConnectIntent } from './signaling/protocolTypes';
import { SignalServer } from './signaling/signalServer';
import type { RemotePeer } from './transport/peerConnection';
import { PeerManager } from './transport/peerManager';
import type { FromWebview } from './ui/ipcTypes';
import { buildUiState } from './ui/stateBuilder';
import { SidebarProvider } from './ui/webviewProvider';
import { type Log, scoped } from './util/logger';
import { getLocalAddresses, parsePortRange, type PortRange } from './util/network';

let shutdown: (() => Promise<void>) | undefined;

function config() {
  return vscode.workspace.getConfiguration('beaconbob');
}

function displayName(): string {
  const configured = config().get<string>('displayName')?.trim();
  if (configured) return configured;
  if (process.env.BEACONBOB_DISPLAY_NAME) return process.env.BEACONBOB_DISPLAY_NAME;
  try {
    return os.userInfo().username;
  } catch {
    return 'BeaconBob user';
  }
}

/** `what` describes the attempt, for example "connect to Bob" or "join #design". */
function describeFailure(err: unknown, peerName: string, what: string, range: PortRange): string {
  if (!(err instanceof HandshakeError)) return `Could not ${what}: ${(err as Error).message}`;
  switch (err.reason) {
    case 'declined':
      return `${peerName} declined your request to ${what}.`;
    case 'timeout':
      return `${peerName} did not answer in time.`;
    case 'busy':
      return `${peerName} is already answering another request. Try again in a moment.`;
    case 'already-connected':
      return `You are already connected to ${peerName}.`;
    case 'unreachable':
      return `Could not reach ${peerName}. Check that both machines are on the same network and that the firewall allows TCP ports ${range.min}-${range.max}.`;
    case 'auth-failed':
      return `Could not verify ${peerName}'s identity, so the connection was refused.`;
    case 'wrong-target':
      return `The peer at ${peerName}'s address has a different identity. It may have restarted; wait for it to reappear.`;
    case 'protocol-error':
      return `${peerName} sent something unexpected. It may be running an incompatible version of BeaconBob.`;
    default:
      return `Could not ${what} (${err.reason}).`;
  }
}

async function promptApproval(
  peer: RemotePeer,
  intent: ConnectIntent | undefined,
  registry: PeerRegistry,
  groupName: (groupId: string) => string | undefined,
): Promise<boolean> {
  const advertised = registry.get(peer.peerId);
  const detail = [
    `Fingerprint: ${peer.fingerprint}`,
    peer.workspace ? `Workspace: ${peer.workspace}` : undefined,
    `Address: ${peer.address}`,
    '',
    advertised && advertised.fingerprint !== peer.fingerprint
      ? 'Warning: this key does not match the one advertised on the network.'
      : undefined,
    `Only accept if this fingerprint matches the one ${peer.name} sees under "You" in their BeaconBob panel.`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  let title = `${peer.name} wants to connect to you over BeaconBob`;
  let action = 'Accept';
  if (intent?.kind === 'join') {
    title = `${peer.name} wants to join #${groupName(intent.groupId) ?? 'your group'}`;
    action = 'Let them in';
  } else if (intent?.kind === 'invite') {
    title = `${peer.name} invites you to join #${intent.groupName}`;
    action = 'Join';
  }
  const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, action);
  return choice === action;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('BeaconBob', { log: true });
  context.subscriptions.push(channel);
  const log: Log = channel;

  const identity = await loadOrCreateIdentity(context.globalStorageUri.fsPath);
  const appVersion = String(context.extension.packageJSON.version ?? '0.0.0');
  const portRange = parsePortRange(config().get<string>('portRange'));
  const profile = (): LocalProfile => ({ name: displayName(), workspace: vscode.workspace.name ?? '', appVersion });
  log.info(`Identity ${identity.peerId}, fingerprint ${identity.fingerprint}`);

  const registry = new PeerRegistry();
  // The group host decides join intents; it needs `peers`, so it is assigned just below.
  let host: GroupHost | undefined;
  const peers = new PeerManager({
    identity,
    getProfile: profile,
    registry,
    promptApproval: (peer, intent) => promptApproval(peer, intent, registry, (id) => host?.groupName(id)),
    screenIntent: (peer, intent) => (intent.kind === 'join' && host ? host.screenJoin(peer, intent) : 'prompt'),
    log: scoped(log, 'peers'),
  });
  const store = new ConversationStore();
  const groupHost = new GroupHost({ peers, store, identity, getSelfName: displayName, log: scoped(log, 'groups') });
  host = groupHost;
  const member = new GroupMember({ peers, store, identity, getSelfName: displayName, log: scoped(log, 'groups') });
  const chat = new ChatService({ peers, store, selfId: identity.peerId, getSelfName: displayName });

  const server = new SignalServer({
    identity,
    getProfile: profile,
    authorize: peers.authorize,
    log: scoped(log, 'signal'),
  });
  server.on('connection', (conn) => peers.adopt(conn));

  let port: number;
  try {
    port = await server.start(portRange);
  } catch (err) {
    log.error(`Could not start signaling server: ${(err as Error).message}`);
    void vscode.window.showErrorMessage(
      `BeaconBob could not open a port in ${portRange.min}-${portRange.max}. Change "beaconbob.portRange" and reload.`,
    );
    throw err;
  }

  const mdnsProfile = (): MdnsProfile => ({
    name: displayName(),
    workspace: profile().workspace,
    status: 'available',
    publicGroups: groupHost.publicGroups(),
  });
  const mdns = new MdnsService({ identity, port, profile: mdnsProfile(), registry, log: scoped(log, 'mdns') });
  mdns.start();

  let lastError: string | null = null;
  const fail = (message: string) => {
    lastError = message;
    log.warn(message);
    refresh();
  };

  const buildState = () =>
    buildUiState({
      identity,
      selfName: displayName(),
      port: server.listeningPort ?? null,
      addresses: getLocalAddresses(),
      registry,
      peers,
      store,
      host: groupHost,
      member,
      error: lastError,
    });

  const nameOf = (peerId: string) => peers.remote(peerId)?.name ?? registry.get(peerId)?.name ?? 'That peer';

  const connectTo = (peerId: string) => {
    lastError = null;
    const name = nameOf(peerId);
    peers.connect(peerId).catch((err: unknown) => fail(describeFailure(err, name, `connect`, portRange)));
  };

  const open = (id: ConversationId) => {
    store.setActive(id);
    refresh();
  };

  const sendTo = (conversationId: string, content: string) => {
    const parsed = parseConversationId(conversationId);
    if (!parsed) return;
    let sent: boolean;
    if (parsed.kind === 'dm') sent = chat.send(parsed.key, content);
    else if (groupHost.isHost(parsed.key)) sent = groupHost.send(parsed.key, content);
    else sent = member.send(parsed.key, content);
    if (!sent) fail('The message could not be sent. The other side may have disconnected.');
  };

  const setTyping = (conversationId: string, isTyping: boolean) => {
    const parsed = parseConversationId(conversationId);
    if (!parsed) return;
    if (parsed.kind === 'dm') chat.setTyping(parsed.key, isTyping);
    else if (groupHost.isHost(parsed.key)) groupHost.setTyping(parsed.key, isTyping);
    else member.setTyping(parsed.key, isTyping);
  };

  const groupNameFromNetwork = (groupId: string) =>
    registry
      .list()
      .flatMap((p) => p.publicGroups)
      .find((g) => g.groupId === groupId)?.name;

  const handleMessage = (msg: FromWebview) => {
    switch (msg.type) {
      case 'dismissError':
        lastError = null;
        refresh();
        break;
      case 'connect':
        connectTo(msg.peerId);
        break;
      case 'disconnect':
        peers.disconnect(msg.peerId);
        break;
      case 'openConversation': {
        const id = msg.id as ConversationId;
        if (parseConversationId(id) && store.has(id)) open(id);
        break;
      }
      case 'closeConversation':
        store.setActive(undefined);
        refresh();
        break;
      case 'sendMessage':
        sendTo(msg.conversationId, msg.content);
        break;
      case 'typing':
        setTyping(msg.conversationId, msg.isTyping);
        break;
      case 'startDm':
        if (chat.open(msg.peerId)) open(`dm:${msg.peerId}`);
        else fail(`Connect to ${nameOf(msg.peerId)} first to send them a direct message.`);
        break;
      case 'createGroup':
        try {
          open(groupConversationId(groupHost.create(msg.name, msg.visibility)));
        } catch (err) {
          fail((err as Error).message);
        }
        break;
      case 'joinGroup': {
        lastError = null;
        const hostName = nameOf(msg.hostId);
        const what = `join #${groupNameFromNetwork(msg.groupId) ?? 'their group'}`;
        member.requestJoin(msg.hostId, msg.groupId).catch((err: unknown) => fail(describeFailure(err, hostName, what, portRange)));
        refresh();
        break;
      }
      case 'inviteToGroup': {
        lastError = null;
        const name = nameOf(msg.peerId);
        groupHost
          .invite(msg.groupId, msg.peerId)
          .catch((err: unknown) => fail(describeFailure(err, name, 'accept the invite', portRange)));
        break;
      }
      case 'respondInvite':
        member.respondInvite(msg.groupId, msg.accept);
        break;
      case 'respondJoinRequest':
        groupHost.respondJoinRequest(msg.groupId, msg.peerId, msg.accept);
        break;
      case 'leaveGroup':
        if (store.activeId === groupConversationId(msg.groupId)) store.setActive(undefined);
        member.leave(msg.groupId);
        refresh();
        break;
      case 'closeGroup':
        if (store.activeId === groupConversationId(msg.groupId)) store.setActive(undefined);
        groupHost.close(msg.groupId);
        refresh();
        break;
      case 'removeMember':
        groupHost.remove(msg.groupId, msg.peerId);
        break;
    }
  };

  const sidebar = new SidebarProvider(context.extensionUri, buildState, handleMessage);
  let refreshQueued = false;
  const refresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      sidebar.postState();
    }, 16);
  };

  const unsubscribe = [
    registry.on('peerDiscovered', refresh),
    registry.on('peerUpdated', refresh),
    registry.on('peerLost', refresh),
    peers.on('changed', refresh),
    store.on('changed', refresh),
    groupHost.on('changed', refresh),
    member.on('changed', refresh),
    groupHost.on('publicGroupsChanged', () => mdns.updateProfile(mdnsProfile())),
    groupHost.on('joinRequest', async (request) => {
      const choice = await vscode.window.showInformationMessage(
        `${request.peer.name} wants to join #${request.groupName}`,
        'Let them in',
        'Decline',
      );
      if (choice) groupHost.respondJoinRequest(request.groupId, request.peer.peerId, choice === 'Let them in');
    }),
    member.on('invitation', async (invitation) => {
      const choice = await vscode.window.showInformationMessage(
        `${invitation.hostName} invited you to #${invitation.groupName}`,
        'Join',
        'Decline',
      );
      if (choice) member.respondInvite(invitation.groupId, choice === 'Join');
    }),
    member.on('joinDeclined', ({ hostName }) => fail(`${hostName} declined your request to join.`)),
  ];

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar),
    vscode.commands.registerCommand('beaconbob.connect', async () => {
      const candidates = registry.list().filter((p) => peers.stateOf(p.peerId) === undefined);
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage('No other BeaconBob peers are visible on this network yet.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        candidates.map((p) => ({
          label: p.name,
          description: p.workspace,
          detail: `Fingerprint ${p.fingerprint}`,
          peerId: p.peerId,
        })),
        { placeHolder: 'Connect to a peer on your network' },
      );
      if (pick) connectTo(pick.peerId);
    }),
    vscode.commands.registerCommand('beaconbob.disconnect', async () => {
      const connected = peers.connected();
      if (connected.length === 0) {
        void vscode.window.showInformationMessage('You are not connected to anyone.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        connected.map((p) => ({ label: p.name, description: p.workspace, peerId: p.peerId })),
        { placeHolder: 'Disconnect from a peer' },
      );
      if (pick) peers.disconnect(pick.peerId);
    }),
    vscode.commands.registerCommand('beaconbob.showLogs', () => channel.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('beaconbob.displayName')) {
        mdns.updateProfile(mdnsProfile());
        refresh();
      }
      if (e.affectsConfiguration('beaconbob.portRange')) {
        void vscode.window.showInformationMessage('Reload the window to apply the new BeaconBob port range.');
      }
    }),
  );

  shutdown = async () => {
    shutdown = undefined;
    for (const off of unsubscribe) off();
    // Hosted groups are closed first so members hear about it before the sockets go.
    groupHost.dispose();
    member.dispose();
    chat.dispose();
    peers.dispose();
    store.dispose();
    // Let the BYE frames flush before the server tears down inbound sockets.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await Promise.allSettled([server.stop(), mdns.stop()]);
  };
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
}
