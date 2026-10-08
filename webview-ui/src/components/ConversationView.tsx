import { useState } from 'react';
import type { ConversationDetail, VoiceView } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';
import { VoiceButton } from './CallBar';
import { ChatPanel } from './ChatPanel';
import { MemberList } from './MemberList';
import { JoinRequestCard } from './Rows';
import { SharingPanel } from './SharingPanel';

export function ConversationView({
  conversation,
  globalCall,
}: {
  conversation: ConversationDetail;
  globalCall: VoiceView['call'];
}) {
  const [showMembers, setShowMembers] = useState(false);
  const { groupId, isHost, ended } = conversation;

  const placeholder = ended
    ? 'This conversation has ended'
    : conversation.canSend
      ? `Message ${conversation.title}`
      : conversation.kind === 'dm'
        ? 'Connect to this person to send messages'
        : 'Waiting for the host…';

  return (
    <div className="conversation">
      <header className="conversation-header">
        <button className="link back" onClick={() => post({ type: 'closeConversation' })} aria-label="Back">
          ‹
        </button>
        <div className="row-main">
          <span className="conversation-title">
            {conversation.title}
            {isHost && <span className="tag">host</span>}
          </span>
          <span className="muted small">{conversation.subtitle}</span>
        </div>
        {groupId && (
          <button className="secondary" onClick={() => setShowMembers((v) => !v)} aria-expanded={showMembers}>
            {showMembers ? 'Hide members' : `Members (${conversation.members.length})`}
          </button>
        )}
      </header>

      {!ended && (conversation.kind === 'dm' || groupId) && (
        <div className="actions conversation-actions voice-actions">
          <VoiceButton
            conversationId={conversation.id}
            kind={conversation.kind}
            voice={conversation.voice}
            globalCall={globalCall}
          />
          {conversation.voice.others.length > 0 && !conversation.voice.joined && (
            <span className="muted small">In the call: {conversation.voice.others.join(', ')}</span>
          )}
        </div>
      )}

      {groupId && (
        <div className="actions conversation-actions">
          {isHost ? (
            <button className="secondary" onClick={() => post({ type: 'closeGroup', groupId })}>
              Close group
            </button>
          ) : (
            <button className="secondary" onClick={() => post({ type: 'leaveGroup', groupId })}>
              {ended ? 'Remove from list' : 'Leave group'}
            </button>
          )}
        </div>
      )}

      {ended && <div className="notice">{ended}</div>}

      {groupId && conversation.sharing && <SharingPanel groupId={groupId} sharing={conversation.sharing} />}

      {conversation.joinRequests.map((r) => (
        <JoinRequestCard key={r.peerId} request={r} />
      ))}

      {showMembers && <MemberList conversation={conversation} />}

      <ChatPanel
        conversationId={conversation.id}
        messages={conversation.messages}
        typing={conversation.typing}
        canSend={conversation.canSend && !ended}
        placeholder={placeholder}
      />
    </div>
  );
}
