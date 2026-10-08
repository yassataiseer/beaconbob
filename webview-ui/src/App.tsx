import { ConversationView } from './components/ConversationView';
import { Home } from './components/Home';
import { post, useExtensionState } from './hooks/useExtensionMessages';

export function App() {
  const state = useExtensionState();
  if (!state) return <div className="loading">Starting BeaconBob…</div>;

  return (
    <div className="app">
      {state.error && (
        <div className="error" role="alert">
          <span>{state.error}</span>
          <button className="link" onClick={() => post({ type: 'dismissError' })} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {state.active ? (
        <ConversationView key={state.active.id} conversation={state.active} />
      ) : (
        <Home state={state} />
      )}
    </div>
  );
}
