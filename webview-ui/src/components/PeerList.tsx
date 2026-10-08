import type { PeerView } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';

function PeerRow({ peer }: { peer: PeerView }) {
  const action =
    peer.state === 'connected' ? (
      <div className="actions">
        <button onClick={() => post({ type: 'startDm', peerId: peer.peerId })}>Message</button>
        <button className="secondary" onClick={() => post({ type: 'disconnect', peerId: peer.peerId })}>
          Disconnect
        </button>
      </div>
    ) : peer.state === 'connecting' ? (
      <button className="secondary" onClick={() => post({ type: 'disconnect', peerId: peer.peerId })}>
        Cancel
      </button>
    ) : (
      <button onClick={() => post({ type: 'connect', peerId: peer.peerId })}>Connect</button>
    );

  return (
    <li className={`peer peer-${peer.state}`}>
      <span className={`dot dot-${peer.state}`} aria-hidden />
      <div className="peer-info">
        <div className="peer-name">
          {peer.name}
          {peer.state === 'connecting' && <span className="muted"> · waiting for approval…</span>}
          {!peer.onNetwork && <span className="muted"> · off mDNS</span>}
        </div>
        {peer.workspace && <div className="muted small">{peer.workspace}</div>}
        <div className="fingerprint small" title="Peer key fingerprint">
          {peer.fingerprint}
        </div>
      </div>
      {action}
    </li>
  );
}

export function PeerList({ peers }: { peers: PeerView[] }) {
  return (
    <section className="peers" aria-label="Peers">
      <div className="section-title">People</div>
      {peers.length === 0 ? (
        <div className="muted small empty">
          Looking for peers… Other people need BeaconBob open on the same network.
        </div>
      ) : (
        <ul>
          {peers.map((peer) => (
            <PeerRow key={peer.peerId} peer={peer} />
          ))}
        </ul>
      )}
    </section>
  );
}
