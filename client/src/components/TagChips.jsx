import React from 'react';

// Colored tag chips — used in the agent list, details panel and script runner.
export default function TagChips({ tags = [], max = 3, small = false }) {
  if (!tags.length) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className={`tag-chips ${small ? 'small' : ''}`}>
      {shown.map((t) => (
        <span key={t.id} className="tag-chip" style={{ '--tag-color': t.color || '#22d3ee' }} title={`Tag: ${t.name}`}>
          {t.name}
        </span>
      ))}
      {rest > 0 && <span className="tag-chip more" title={tags.map((t) => t.name).join(', ')}>+{rest}</span>}
    </span>
  );
}
