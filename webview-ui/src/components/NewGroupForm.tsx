import { type FormEvent, useState } from 'react';
import type { GroupVisibilityView } from '../../../src/ui/ipcTypes';
import { post } from '../hooks/useExtensionMessages';

export function NewGroupForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<GroupVisibilityView>('public');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    post({ type: 'createGroup', name, visibility });
    onDone();
  };

  return (
    <form className="card new-group" onSubmit={submit}>
      <input
        autoFocus
        value={name}
        maxLength={32}
        placeholder="Group name, e.g. frontend"
        onChange={(e) => setName(e.target.value)}
      />
      <div className="radio-row" role="radiogroup" aria-label="Visibility">
        <label>
          <input type="radio" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> Public
          <span className="muted small block">Anyone nearby can see it and ask to join</span>
        </label>
        <label>
          <input type="radio" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> Private
          <span className="muted small block">Hidden; invite people yourself</span>
        </label>
      </div>
      <div className="actions">
        <button type="submit" disabled={!name.trim()}>
          Create
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
