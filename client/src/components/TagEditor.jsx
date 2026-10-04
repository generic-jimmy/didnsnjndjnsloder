import React, { useState, useRef } from 'react';
import api from '../api';

const PRESET_COLORS = ['#22d3ee', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#60a5fa', '#94a3b8'];

// Inline tag creation + assignment editor (popover in the agent details panel).
// EVERY change applies INSTANTLY — toggling a tag or creating a new one is
// persisted immediately (no separate "Save" step to forget), so tags show up
// on the agent card and details panel the moment you create them.
// Failures roll back the checkbox and show an inline error.
export default function TagEditor({ agent, tags, onSaved, onClose }) {
  // `applied` mirrors what the server has already accepted for this agent.
  const [applied, setApplied] = useState(() => new Set((agent?.tags || []).map((t) => t.id)));
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const appliedRef = useRef(applied);
  appliedRef.current = applied;

  const persist = async (nextSet) => {
    const prev = new Set(appliedRef.current);
    setApplied(nextSet); // optimistic
    setBusy(true);
    setError('');
    try {
      await api.put(`/agents/${agent.id}/tags`, { tag_ids: [...nextSet] });
      onSaved?.(); // refresh global tag list + agent rows (chips update everywhere)
    } catch (err) {
      setApplied(prev); // rollback
      setError(err?.response?.data?.error || 'Failed to save tags');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id) => {
    const next = new Set(appliedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    persist(next);
  };

  const createTag = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/tags', { name, color: newColor });
      const id = res.data.id;
      setNewName('');
      // Created AND assigned to this agent in one motion:
      const next = new Set(appliedRef.current).add(id);
      await api.put(`/agents/${agent.id}/tags`, { tag_ids: [...next] });
      setApplied(next);
      onSaved?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create tag');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tag-editor" onClick={(e) => e.stopPropagation()}>
      <div className="te-head">
        <span>Tags — {agent.hostname}</span>
        <button className="te-close" onClick={onClose} title="Close">×</button>
      </div>
      <div className="te-list">
        {tags.length === 0 && <div className="te-empty">No tags yet — create your first one below.</div>}
        {tags.map((t) => (
          <label key={t.id} className={`te-tag ${applied.has(t.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={applied.has(t.id)} disabled={busy} onChange={() => toggle(t.id)} />
            <span className="te-dot" style={{ background: t.color || '#22d3ee' }} />
            {t.name}
          </label>
        ))}
      </div>
      <div className="te-create">
        <div className="te-swatch-row">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`te-swatch ${newColor === c ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => setNewColor(c)}
              title={c}
            />
          ))}
        </div>
        <div className="te-create-row">
          <input
            type="text"
            placeholder="New tag name… (Enter to create & apply)"
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTag(); } }}
          />
          <button className="btn-ghost btn-small" onClick={createTag} disabled={busy || !newName.trim()}>Create</button>
        </div>
      </div>
      {error && <div className="te-error">{error}</div>}
      <div className="te-actions">
        <span className="te-hint">{busy ? 'Saving…' : 'Changes apply instantly'}</span>
        <button className="btn-primary btn-small" onClick={onClose} disabled={busy}>Done</button>
      </div>
    </div>
  );
}
