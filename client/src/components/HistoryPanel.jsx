import React, { useState, useEffect } from 'react';
import api from '../api';
import { timeAgo } from '../utils';

// Renders the per-agent activity feed from command_logs — every script run
// and its output, newest first. The old console never wrote to this table;
// the server now logs runs + results, so output survives reloads and can
// always be reviewed here.
function HistoryPanel({ agent, refreshKey }) {
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    if (!agent?.id) return;
    setLoading(true);
    setError('');
    api.get(`/agents/${agent.id}/history?limit=50`)
      .then((res) => setRows(res.data || []))
      .catch((err) => setError(err?.response?.data?.error || 'Failed to load history'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, refreshKey]);

  if (!agent) return null;

  return (
    <div className="history-panel">
      <div className="history-head">
        <span className="panel-title">
          <span className="title-dot amber" /> Activity — {agent.hostname}
        </span>
        <button className="btn-ghost btn-small" onClick={load}>Refresh</button>
      </div>
      {loading && <div className="history-empty">Loading history…</div>}
      {!loading && error && <div className="sr-error">{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div className="history-empty">No logged activity yet — run a script and it will appear here.</div>
      )}
      <div className="history-list">
        {rows.map((row) => (
          <div key={row.id} className="history-item">
            <div
              className="history-item-head"
              onClick={() => setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
            >
              <span className="history-time" title={new Date(row.executed_at).toLocaleString()}>
                {timeAgo(row.executed_at)}
              </span>
              <span className="history-operator">{row.operator_username || '—'}</span>
              <span className="history-command">{(row.command || '').split('\n')[0].slice(0, 90) || '(empty)'}</span>
              <span className={`history-caret ${expanded[row.id] ? 'open' : ''}`}>▸</span>
            </div>
            {expanded[row.id] && (
              <pre className="history-output">{row.output || '(no output recorded)'}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default HistoryPanel;
