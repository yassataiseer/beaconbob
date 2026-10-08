import type { UiState } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';
import { GroupList } from './GroupList';
import { PeerList } from './PeerList';
import { ConversationList, JoinRequestCard } from './Rows';

export function Home({ state }: { state: UiState }) {
  const groups = state.conversations.filter((c) => c.kind === 'group');
  const dms = state.conversations.filter((c) => c.kind === 'dm');

  return (
    <>
      <section className="self" aria-label="You">
        <div className="section-title">You</div>
        <div className="self-name">{state.self.name}</div>
        <div className="fingerprint" title="Share this with peers so they can verify it is you">
          {state.self.fingerprint}
        </div>
        <div className="muted small">
          {state.self.addresses.length > 0
            ? `${state.self.addresses[0]}:${state.self.port ?? '?'}`
            : 'No LAN interface found'}
        </div>
      </section>

      {state.invitations.length > 0 && (
        <section aria-label="Invitations">
          <div className="section-title">Invitations</div>
          {state.invitations.map((inv) => (
            <div key={inv.groupId} className="card">
              <span>
                <strong>{inv.hostName}</strong> invited you to <strong>#{inv.groupName}</strong>
              </span>
              <div className="actions">
                <button onClick={() => post({ type: 'respondInvite', groupId: inv.groupId, accept: true })}>Join</button>
                <button
                  className="secondary"
                  onClick={() => post({ type: 'respondInvite', groupId: inv.groupId, accept: false })}
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {state.joinRequests.length > 0 && (
        <section aria-label="Join requests">
          <div className="section-title">Join requests</div>
          {state.joinRequests.map((r) => (
            <JoinRequestCard key={`${r.groupId}:${r.peerId}`} request={r} />
          ))}
        </section>
      )}

      <GroupList groups={groups} publicGroups={state.publicGroups} />

      {dms.length > 0 && (
        <section aria-label="Direct messages">
          <div className="section-title">Direct messages</div>
          <ConversationList items={dms} />
        </section>
      )}

      <PeerList peers={state.peers} />
    </>
  );
}
