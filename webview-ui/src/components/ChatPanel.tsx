import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ChatMessageView } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';

const TYPING_REFRESH_MS = 3000;
const TYPING_IDLE_MS = 2000;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}

/** Sends TYPING_STATUS sparingly: a refresh every few seconds while typing, and one "stopped". */
function useTypingSignal(conversationId: string) {
  const lastSent = useRef(0);
  const idleTimer = useRef<number | undefined>(undefined);

  const stop = () => {
    window.clearTimeout(idleTimer.current);
    if (lastSent.current !== 0) {
      lastSent.current = 0;
      post({ type: 'typing', conversationId, isTyping: false });
    }
  };

  const onInput = () => {
    const now = Date.now();
    if (now - lastSent.current > TYPING_REFRESH_MS) {
      lastSent.current = now;
      post({ type: 'typing', conversationId, isTyping: true });
    }
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(stop, TYPING_IDLE_MS);
  };

  // Leaving the conversation mid-sentence should not leave others seeing "typing…".
  useEffect(() => () => stop(), []);
  return { onInput, stop };
}

interface ChatPanelProps {
  conversationId: string;
  messages: ChatMessageView[];
  typing: string[];
  canSend: boolean;
  placeholder: string;
}

export function ChatPanel({ conversationId, messages, typing, canSend, placeholder }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const typingSignal = useTypingSignal(conversationId);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const send = () => {
    if (!draft.trim() || !canSend) return;
    post({ type: 'sendMessage', conversationId, content: draft });
    setDraft('');
    typingSignal.stop();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <section className="chat" aria-label="Messages">
      <div className="messages" ref={listRef} role="log" aria-live="polite">
        {messages.length === 0 && <div className="muted small empty">No messages yet.</div>}
        {messages.map((m) =>
          m.kind === 'system' ? (
            <div key={m.id} className="message system">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className={`message ${m.fromSelf ? 'self' : 'remote'}`}>
              <div className="meta">
                <span className="sender">{m.fromSelf ? 'You' : m.senderName}</span>
                <span className="muted">{formatTime(m.timestamp)}</span>
              </div>
              <div className="content">{m.content}</div>
            </div>
          ),
        )}
      </div>
      <div className="typing muted small">{typing.length > 0 ? typingLabel(typing) : '\u00a0'}</div>
      <div className="composer">
        <textarea
          value={draft}
          rows={2}
          placeholder={placeholder}
          disabled={!canSend}
          onChange={(e) => {
            setDraft(e.target.value);
            typingSignal.onInput();
          }}
          onKeyDown={onKeyDown}
          onBlur={typingSignal.stop}
        />
        <button onClick={send} disabled={!canSend || !draft.trim()}>
          Send
        </button>
      </div>
    </section>
  );
}
