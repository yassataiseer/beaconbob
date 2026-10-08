import { Emitter } from '../util/events';
import type { Log } from '../util/logger';
import type { AudioBridge, FromPage, MicState, PeerAudioState } from './audioBridge';
import type { CallManager, CallRef } from './callManager';

export interface VoiceControllerOptions {
  calls: CallManager;
  bridge: AudioBridge;
  selfId: string;
  selfName: () => string;
  nameOf: (peerId: string) => string;
  /** Human title for a call ("#frontend", "Call with Bob"). */
  titleOf: (call: CallRef) => string;
  /** Opens the companion page in the user's browser. */
  openPage: (url: string) => Promise<void>;
  log: Log;
  /** How long the page may be gone (a reload) before you are taken out of the call. */
  pageGraceMs?: number;
}

export interface VoiceState {
  pageConnected: boolean;
  mic: MicState;
  micMessage: string | null;
  muted: boolean;
  /** Peer ids currently speaking; "self" for you. */
  speaking: Set<string>;
  connections: Record<string, PeerAudioState>;
}

/** Glue between the call manager (who is in the call) and the companion page (the audio). */
export class VoiceController extends Emitter<{ changed: [] }> {
  private readonly voice: VoiceState = {
    pageConnected: false,
    mic: 'unknown',
    micMessage: null,
    muted: false,
    speaking: new Set(),
    connections: {},
  };
  private readonly disposers: Array<() => void> = [];
  private leaveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: VoiceControllerOptions) {
    super();
    const { calls, bridge } = opts;
    this.disposers.push(
      calls.on('changed', () => {
        if (!calls.call) this.resetAudioState();
        this.pushCall();
        this.emit('changed');
      }),
      calls.on('signal', (from, signal) => bridge.send({ type: 'signal', from, signal })),
      bridge.on('connected', () => {
        clearTimeout(this.leaveTimer);
        this.voice.pageConnected = true;
        this.pushCall();
        this.emit('changed');
      }),
      bridge.on('disconnected', () => {
        this.voice.pageConnected = false;
        this.voice.mic = 'unknown';
        this.resetAudioState();
        clearTimeout(this.leaveTimer);
        // Without the page there is no audio; leave unless it comes straight back (a reload).
        this.leaveTimer = setTimeout(() => {
          if (!bridge.isConnected && calls.call) {
            opts.log.info('Voice page closed; leaving the call');
            calls.leave();
          }
        }, opts.pageGraceMs ?? 5000);
        this.emit('changed');
      }),
      bridge.on('message', (m) => this.onPage(m)),
    );
  }

  get state(): Readonly<VoiceState> {
    return this.voice;
  }

  async join(call: CallRef): Promise<void> {
    this.opts.calls.join(call);
    if (!this.opts.bridge.isConnected) await this.openPage();
  }

  leave(): void {
    this.opts.calls.leave();
  }

  setMuted(muted: boolean): void {
    this.voice.muted = muted;
    this.opts.bridge.send({ type: 'mute', muted });
    this.emit('changed');
  }

  async openPage(): Promise<void> {
    await this.opts.openPage(this.opts.bridge.url);
  }

  dispose(): void {
    clearTimeout(this.leaveTimer);
    for (const dispose of this.disposers) dispose();
    this.removeAllListeners();
  }

  private onPage(message: FromPage): void {
    switch (message.type) {
      case 'ready':
        this.voice.mic = message.mic;
        this.voice.micMessage = message.message ?? null;
        break;
      case 'signal':
        this.opts.calls.sendSignal(message.to, message.signal);
        return;
      case 'speaking': {
        const next = new Set(message.peers);
        const same = next.size === this.voice.speaking.size && [...next].every((p) => this.voice.speaking.has(p));
        if (same) return;
        this.voice.speaking = next;
        break;
      }
      case 'connections':
        this.voice.connections = message.states;
        break;
      case 'muted':
        this.voice.muted = message.muted;
        break;
      case 'leave':
        this.opts.calls.leave();
        return;
    }
    this.emit('changed');
  }

  private resetAudioState(): void {
    this.voice.speaking = new Set();
    this.voice.connections = {};
  }

  private pushCall(): void {
    const call = this.opts.calls.call;
    this.opts.bridge.send({
      type: 'call',
      selfId: this.opts.selfId,
      selfName: this.opts.selfName(),
      title: call ? this.opts.titleOf(call) : null,
      participants: this.opts.calls.remoteParticipants().map((peerId) => ({ peerId, name: this.opts.nameOf(peerId) })),
      muted: this.voice.muted,
    });
  }
}
