import type { ConversationSummary, JoinRequestView } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';

function ConversationRow({ conversation }: { conversation: ConversationSummary }) {
  return (
    <li>
      <button className="row" onClick={() => post({ type: 'openConversation', id: conversation.id })}>
        <span className="row-main">
          <span className="row-title">
            {conversation.title}
            {conversation.isHost && <span className="tag">host</span>}
            {conversation.ended && <span className="tag muted-tag">ended</span>}
            {conversation.inCallCount > 0 && <span className="tag voice-tag">{conversation.inCallCount} in call</span>}
          </span>
          <span className="muted small">{conversation.subtitle}</span>
        </span>
        {conversation.unread > 0 && <span className="badge">{conversation.unread}</span>}
      </button>
    </li>
  );
}

export function ConversationList({ items }: { items: ConversationSummary[] }) {
  return (
    <ul className="rows">
      {items.map((c) => (
        <ConversationRow key={c.id} conversation={c} />
      ))}
    </ul>
  );
}

export function JoinRequestCard({ request }: { request: JoinRequestView }) {
  const respond = (accept: boolean) =>
    post({ type: 'respondJoinRequest', groupId: request.groupId, peerId: request.peerId, accept });
  return (
    <div className="card">
      <span>
        <strong>{request.name}</strong> wants to join <strong>#{request.groupName}</strong>
        <span className="fingerprint small block">{request.fingerprint}</span>
      </span>
      <div className="actions">
        <button onClick={() => respond(true)}>Let in</button>
        <button className="secondary" onClick={() => respond(false)}>
          Decline
        </button>
      </div>
    </div>
  );
}
