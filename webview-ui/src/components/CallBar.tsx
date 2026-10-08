import type { VoiceView } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';

function micProblem(voice: VoiceView): string | null {
  if (voice.mic === 'denied') return 'Microphone blocked in the voice page. Allow it in the browser and reload the page.';
  if (voice.mic === 'error') return `Microphone problem: ${voice.micMessage ?? 'unknown error'}`;
  return null;
}

/** Shown at the top of every view while you are in a call. */
export function CallBar({ voice }: { voice: VoiceView }) {
  if (!voice.call) return null;
  const problem = micProblem(voice);

  return (
    <div className="call-bar" role="region" aria-label="Voice call">
      <div className="call-head">
        <span className={`dot ${voice.selfSpeaking ? 'speaking-dot' : 'dot-connected'}`} aria-hidden />
        <button
          className="link call-title"
          onClick={() => post({ type: 'openConversation', id: voice.call!.conversationId })}
          title="Open this conversation"
        >
          {voice.call.title}
        </button>
        <div className="actions">
          <button
            className={voice.muted ? '' : 'secondary'}
            onClick={() => post({ type: 'setMuted', muted: !voice.muted })}
            aria-pressed={voice.muted}
          >
            {voice.muted ? 'Unmute' : 'Mute'}
          </button>
          <button className="secondary" onClick={() => post({ type: 'leaveVoice' })}>
            Leave
          </button>
        </div>
      </div>

      {!voice.pageConnected && (
        <div className="call-warning">
          <span>The voice page isn&apos;t open, so there is no audio.</span>
          <button onClick={() => post({ type: 'openVoicePage' })}>Open voice page</button>
        </div>
      )}
      {problem && <div className="call-warning">{problem}</div>}

      {voice.participants.length === 0 ? (
        <div className="muted small">Waiting for others to join…</div>
      ) : (
        <ul className="rows">
          {voice.participants.map((p) => (
            <li key={p.peerId} className="row static">
              <span
                className={`dot ${p.speaking ? 'speaking-dot' : p.state === 'connected' ? 'dot-connected' : p.state === 'failed' ? 'dot-failed' : 'dot-connecting'}`}
                aria-hidden
              />
              <span className="row-main">
                <span className="row-title">{p.name}</span>
              </span>
              <span className="muted small">{p.state === 'connected' ? (p.speaking ? 'speaking' : '') : p.state}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Join / leave controls for one conversation's call. */
export function VoiceButton({ conversationId, kind, voice, globalCall }: {
  conversationId: string;
  kind: 'dm' | 'group';
  voice: { joined: boolean; others: string[]; canJoin: boolean };
  globalCall: VoiceView['call'];
}) {
  if (voice.joined) {
    return (
      <button className="secondary" onClick={() => post({ type: 'leaveVoice' })}>
        {kind === 'dm' ? 'Leave call' : 'Leave voice'}
      </button>
    );
  }
  const label =
    kind === 'dm'
      ? voice.others.length > 0
        ? 'Join call'
        : 'Call'
      : voice.others.length > 0
        ? `Join voice (${voice.others.length})`
        : 'Start voice';
  const switching = globalCall && globalCall.conversationId !== conversationId;
  return (
    <button
      disabled={!voice.canJoin}
      title={switching ? `This leaves ${globalCall!.title}` : undefined}
      onClick={() => post({ type: 'joinVoice', conversationId })}
    >
      {label}
    </button>
  );
}
