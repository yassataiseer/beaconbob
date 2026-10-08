import { useState } from 'react';
import type { ConversationSummary, PublicGroupView } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';
import { NewGroupForm } from './NewGroupForm';
import { ConversationList } from './Rows';

export function GroupList({ groups, publicGroups }: { groups: ConversationSummary[]; publicGroups: PublicGroupView[] }) {
  const [creating, setCreating] = useState(false);
  const nearby = publicGroups.filter((g) => g.state !== 'joined');

  return (
    <section aria-label="Groups">
      <div className="section-header">
        <div className="section-title">Groups</div>
        {!creating && (
          <button className="link small-link" onClick={() => setCreating(true)}>
            + New group
          </button>
        )}
      </div>
      {creating && <NewGroupForm onDone={() => setCreating(false)} />}
      {groups.length === 0 && !creating && <div className="muted small empty">You are not in any groups yet.</div>}
      <ConversationList items={groups} />

      {nearby.length > 0 && (
        <>
          <div className="subsection-title muted small">Public groups nearby</div>
          <ul className="rows">
            {nearby.map((g) => (
              <li key={g.groupId} className="row static">
                <span className="row-main">
                  <span className="row-title">#{g.name}</span>
                  <span className="muted small">hosted by {g.hostName}</span>
                </span>
                {g.state === 'requested' ? (
                  <span className="muted small">Requested…</span>
                ) : (
                  <button onClick={() => post({ type: 'joinGroup', hostId: g.hostId, groupId: g.groupId })}>Join</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
