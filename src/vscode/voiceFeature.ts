import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseConversationId } from '../chat/conversationStore';
import type { GroupHost } from '../groups/groupHost';
import type { GroupMember } from '../groups/groupMember';
import type { Identity } from '../security/identity';
import type { PeerManager } from '../transport/peerManager';
import type { ConversationVoiceView, VoiceView } from '../ui/ipcTypes';
import { type Log, scoped } from '../util/logger';
import { AudioBridge } from '../voice/audioBridge';
import { CallManager, type CallRef } from '../voice/callManager';
import { VoiceController } from '../voice/voiceController';
import { MAX_CALL_PARTICIPANTS } from '../voice/voiceProtocol';

export interface VoiceFeatureOptions {
  extensionPath: string;
  peers: PeerManager;
  groupHost: GroupHost;
  member: GroupMember;
  identity: Identity;
  displayName: () => string;
  nameOf: (peerId: string) => string;
  log: Log;
  onChange: () => void;
}

const conversationOf = (call: CallRef) => (call.scope === 'group' ? `group:${call.groupId}` : `dm:${call.peerId}`);

/** Voice calls in the editor: the call manager, the local voice page server, and notifications. */
export class VoiceFeature implements vscode.Disposable {
  readonly calls: CallManager;
  private readonly bridge: AudioBridge;
  private readonly controller: VoiceController;
  private unavailable: string | null = null;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly opts: VoiceFeatureOptions) {
    const log = scoped(opts.log, 'voice');
    this.calls = new CallManager({ peers: opts.peers, groupHost: opts.groupHost, member: opts.member, identity: opts.identity, log });
    this.bridge = new AudioBridge(path.join(opts.extensionPath, 'media', 'voice'), log);
    this.controller = new VoiceController({
      calls: this.calls,
      bridge: this.bridge,
      selfId: opts.identity.peerId,
      selfName: opts.displayName,
      nameOf: opts.nameOf,
      titleOf: (call) => this.titleOf(call),
      openPage: async (url) => {
        if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) {
          throw new Error('Could not open the voice page in your browser.');
        }
      },
      log,
    });
    this.offs.push(
      this.controller.on('changed', opts.onChange),
      this.calls.on('incoming', (peerId) => void this.onIncoming(peerId)),
    );
    this.bridge.start().catch((err: Error) => {
      this.unavailable = `Voice is unavailable: ${err.message}`;
      log.error(this.unavailable);
      opts.onChange();
    });
  }

  /** The call bar at the top of the sidebar. */
  view(): VoiceView {
    const call = this.calls.call;
    const state = this.controller.state;
    return {
      call: call ? { conversationId: conversationOf(call), title: this.titleOf(call) } : null,
      pageConnected: state.pageConnected,
      mic: state.mic,
      micMessage: state.micMessage,
      muted: state.muted,
      selfSpeaking: state.speaking.has('self'),
      participants: this.calls.remoteParticipants().map((peerId) => ({
        peerId,
        name: this.opts.nameOf(peerId),
        speaking: state.speaking.has(peerId),
        state: state.connections[peerId] ?? 'connecting',
      })),
      unavailable: this.unavailable,
    };
  }

  /** Voice details for one conversation. */
  conversation(kind: 'dm' | 'group', key: string): { inCallCount: number; view: ConversationVoiceView } {
    const selfId = this.opts.identity.peerId;
    if (kind === 'group') {
      const participants = this.calls.participantsOf(key);
      const joined = this.calls.isIn({ scope: 'group', groupId: key });
      const inGroup = this.opts.groupHost.isHost(key) || (!!this.opts.member.group(key) && !this.opts.member.group(key)!.ended);
      return {
        inCallCount: participants.length,
        view: {
          joined,
          others: participants.filter((id) => id !== selfId).map(this.opts.nameOf),
          canJoin: !this.unavailable && inGroup && (joined || participants.length < MAX_CALL_PARTICIPANTS),
        },
      };
    }
    const joined = this.calls.isIn({ scope: 'dm', peerId: key });
    const theyAreIn = this.calls.dmPeerInCall(key);
    return {
      inCallCount: Number(joined) + Number(theyAreIn),
      view: {
        joined,
        others: theyAreIn ? [this.opts.nameOf(key)] : [],
        canJoin: !this.unavailable && this.opts.peers.isConnected(key),
      },
    };
  }

  async join(conversationId: string): Promise<void> {
    if (this.unavailable) throw new Error(this.unavailable);
    const parsed = parseConversationId(conversationId);
    if (!parsed) return;
    const call: CallRef = parsed.kind === 'group' ? { scope: 'group', groupId: parsed.key } : { scope: 'dm', peerId: parsed.key };
    await this.controller.join(call);
  }

  leave(): void {
    this.controller.leave();
  }

  setMuted(muted: boolean): void {
    this.controller.setMuted(muted);
  }

  openPage(): Promise<void> {
    return this.controller.openPage();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.controller.dispose();
    this.calls.dispose();
    void this.bridge.stop();
  }

  private titleOf(call: CallRef): string {
    if (call.scope === 'dm') return `Call with ${this.opts.nameOf(call.peerId)}`;
    const name =
      this.opts.groupHost.groupName(call.groupId) ?? this.opts.member.group(call.groupId)?.name ?? 'group';
    return `#${name}`;
  }

  private async onIncoming(peerId: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(`${this.opts.nameOf(peerId)} is calling you`, 'Join', 'Ignore');
    if (choice !== 'Join' || !this.calls.dmPeerInCall(peerId)) return;
    try {
      await this.join(`dm:${peerId}`);
    } catch (err) {
      void vscode.window.showErrorMessage((err as Error).message);
    }
  }
}
