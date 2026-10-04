import React, { useState } from 'react';
import api from '../api';

const PRESET_COLORS = ['#22d3ee', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#60a5fa', '#94a3b8'];

// Inline tag creation + assignment editor (popover in the agent details panel).
// - Toggle existing tags on/off for this agent
// - Type a new name, pick a color, press Enter / Add -> tag is created AND assigned
export default function TagEditor({ agent, tags, onSaved, onClose }) {
  const [selected, setSelected] = useState(() => new Set((agent?.tags || []).map((t) => t.id)));
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createTag = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/tags', { name, color: newColor });
      setSelected((prev) => new Set(prev).add(res.data.id));
      setNewName('');
      onSaved?.(); // refresh global tag list
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create tag');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/agents/${agent.id}/tags`, { tag_ids: [...selected] });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to save tags');
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
          <label key={t.id} className={`te-tag ${selected.has(t.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
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
            placeholder="New tag name…"
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTag(); } }}
          />
          <button className="btn-ghost btn-small" onClick={createTag} disabled={busy || !newName.trim()}>Add</button>
        </div>
      </div>
      {error && <div className="te-error">{error}</div>}
      <div className="te-actions">
        <button className="btn-ghost btn-small" onClick={onClose}>Cancel</button>
        <button className="btn-primary btn-small" onClick={save} disabled={busy}>Save</button>
      </div>
    </div>
  );
}
