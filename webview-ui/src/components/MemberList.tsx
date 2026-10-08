import type { ConversationDetail } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';

export function MemberList({ conversation }: { conversation: ConversationDetail }) {
  const { groupId, isHost, members, invitable } = conversation;
  if (!groupId) return null;

  return (
    <div className="panel">
      <div className="subsection-title muted small">Members</div>
      <ul className="rows">
        {members.map((m) => (
          <li key={m.peerId} className="row static">
            <span className="row-main">
              <span className="row-title">
                {m.isSelf ? `${m.name} (you)` : m.name}
                {m.isHost && <span className="tag">host</span>}
              </span>
              <span className="fingerprint small">{m.fingerprint}</span>
            </span>
            {isHost && !m.isSelf && (
              <button className="secondary" onClick={() => post({ type: 'removeMember', groupId, peerId: m.peerId })}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {isHost && (
        <>
          <div className="subsection-title muted small">Invite</div>
          {invitable.length === 0 ? (
            <div className="muted small empty">Nobody else is visible on the network.</div>
          ) : (
            <ul className="rows">
              {invitable.map((p) => (
                <li key={p.peerId} className="row static">
                  <span className="row-main">
                    <span className="row-title">{p.name}</span>
                  </span>
                  {p.invited ? (
                    <span className="muted small">Invited…</span>
                  ) : (
                    <button onClick={() => post({ type: 'inviteToGroup', groupId, peerId: p.peerId })}>Invite</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
