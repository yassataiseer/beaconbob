import type { SharingView } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';

export function SharingPanel({ groupId, sharing }: { groupId: string; sharing: SharingView }) {
  if (sharing.isHost && !sharing.active) {
    return (
      <div className="share-bar">
        {sharing.cannotShareReason ? (
          <span className="muted small">{sharing.cannotShareReason}</span>
        ) : (
          <button onClick={() => post({ type: 'startSharing', groupId })}>
            Share workspace{sharing.rootName ? ` (${sharing.rootName})` : ''}
          </button>
        )}
      </div>
    );
  }
  if (!sharing.active) return null;

  return (
    <div className="share-panel">
      <div className="share-banner">
        {sharing.isHost ? (
          <span>
            Sharing <strong>{sharing.rootName}</strong> with this group
          </span>
        ) : (
          <span>
            <strong>{sharing.hostName}</strong> is sharing <strong>{sharing.rootName}</strong>
            <span className="muted"> · {sharing.canEdit ? 'you can edit' : 'read-only'}</span>
          </span>
        )}
      </div>
      <div className="actions">
        {sharing.isHost ? (
          <button className="secondary" onClick={() => post({ type: 'stopSharing' })}>
            Stop sharing
          </button>
        ) : (
          <>
            <button onClick={() => post({ type: 'openSharedFiles' })}>Open shared files</button>
            <button
              className="secondary"
              disabled={!sharing.canMount}
              title={sharing.canMount ? undefined : 'Open a folder in this window first (or it is already added)'}
              onClick={() => post({ type: 'mountShared', groupId })}
            >
              Open in Explorer
            </button>
          </>
        )}
      </div>
      {sharing.participants.length > 0 && (
        <ul className="rows participants">
          {sharing.participants.map((p) => (
            <li key={p.peerId} className="row static">
              <span className="presence-dot" style={{ background: p.color }} aria-hidden />
              <span className="row-main">
                <span className="row-title">{p.name}</span>
                <span className="muted small">{p.activeFile ?? 'not in a shared file'}</span>
              </span>
              {p.activeFile && (
                <button className="secondary" onClick={() => post({ type: 'followPeer', groupId, peerId: p.peerId })}>
                  Go to
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
