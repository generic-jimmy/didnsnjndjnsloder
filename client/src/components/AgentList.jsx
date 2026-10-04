import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { VariableSizeList as VList } from 'react-window';
import api from '../api';
import Flag from './Flag';
import TagChips from './TagChips';
import { osLabel, timeAgoShort, fullDate, regionName } from '../utils';

// ---------------------------------------------------------------------------
// SMART AGENT LIST
// - ONLINE agents ALWAYS float to the top, then OFFLINE, then BANNED (groups
//   are labeled). The operator's sort choice applies INSIDE each group.
// - Live search across hostname / IP / user / country / ISP / tags.
//   (Country / ISP / tag text all match the search box — type "kenya",
//   "safaricom" or a tag name to narrow the list.)
// - Virtualized (react-window): renders only visible rows, fluid at 1000s.
// ---------------------------------------------------------------------------
const STATUS_ORDER = ['online', 'offline', 'banned'];
const HEADER_H = 22;
const CARD_H = 60;

function statusOf(a) {
  return a.banned ? 'banned' : (a.status === 'online' ? 'online' : 'offline');
}
function rank(a) {
  return STATUS_ORDER.indexOf(statusOf(a));
}

function matchesQuery(a, q) {
  if (!q) return true;
  const hay = [
    a.hostname, a.ip_address, a.username, a.country,
    a.country_code && regionName(a.country_code), a.isp,
    ...(a.tags || []).map((t) => t.name)
  ].filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

function AgentList({ agents, selectedAgent, onSelect, onAgentsChanged, tags = [] }) {
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sortKey, setSortKey] = useState('last_seen');

  // Tick so "seen 2m ago" stays honest
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [query]);

  const banAgent = async (e, agent) => {
    e.stopPropagation();
    const reason = window.prompt(
      `Ban "${agent.hostname}"?\nThe agent will be kicked and rejected while banned.` +
      `\n\nOptional reason:`,
      'Banned by operator'
    );
    if (reason === null) return;
    try {
      await api.post(`/agents/${agent.id}/ban`, { reason: reason || 'Banned by operator' });
      onAgentsChanged?.();
    } catch (err) {
      window.alert(err?.response?.data?.error || 'Failed to ban agent');
    }
  };

  const unbanAgent = async (e, agent) => {
    e.stopPropagation();
    try {
      await api.post(`/agents/${agent.id}/unban`, {});
      onAgentsChanged?.();
    } catch (err) {
      window.alert(err?.response?.data?.error || 'Failed to unban agent');
    }
  };

  const deleteAgent = async (e, agent) => {
    e.stopPropagation();
    if (!window.confirm(
      `Permanently DELETE "${agent.hostname}"?\n\nThis removes the agent and its whole command history. This cannot be undone.`
    )) return;
    try {
      await api.delete(`/agents/${agent.id}`);
      onAgentsChanged?.();
    } catch (err) {
      window.alert(err?.response?.data?.error || 'Failed to delete agent');
    }
  };

  // Group + sort pipeline (search-aware)
  const { rows, counts } = useMemo(() => {
    const f = { online: 0, offline: 0, banned: 0 };
    for (const a of agents) f[statusOf(a)] += 1;

    const filtered = agents.filter((a) => matchesQuery(a, debounced));

    const secondary = (a, b) => {
      switch (sortKey) {
        case 'hostname':
          return String(a.hostname || '').localeCompare(String(b.hostname || ''));
        case 'country':
          return String(a.country || a.country_code || 'zzz').localeCompare(String(b.country || b.country_code || 'zzz'));
        case 'os':
          return osLabel(a).localeCompare(osLabel(b));
        case 'last_seen':
        default: {
          const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0;
          const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0;
          return tb - ta;
        }
      }
    };

    filtered.sort((a, b) => rank(a) - rank(b) || secondary(a, b));

    // Build virtual rows: a labeled header starts each visible group
    const out = [];
    for (const status of STATUS_ORDER) {
      const group = filtered.filter((a) => statusOf(a) === status);
      if (group.length === 0) continue;
      out.push({ type: 'header', key: `h-${status}`, status, count: group.length });
      for (const a of group) out.push({ type: 'agent', key: a.id, agent: a });
    }
    return { rows: out, counts: f };
  }, [agents, debounced, sortKey]);

  // Measure the scroll container so the list fills it exactly
  const containerRef = useRef(null);
  const [listH, setListH] = useState(400);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setListH(el.clientHeight));
    ro.observe(el);
    setListH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const listRef = useRef(null);
  useEffect(() => {
    listRef.current?.resetAfterIndex(0, true);
    listRef.current?.scrollTo(0);
  }, [rows]);

  const getItemSize = useCallback(
    (i) => (rows[i]?.type === 'header' ? HEADER_H : CARD_H),
    [rows]
  );

  const Row = ({ index, style }) => {
    const row = rows[index];
    if (row.type === 'header') {
      return (
        <div style={style} className={`al-header ${row.status}`}>
          <span className="al-header-dot" />
          {row.status} <span className="al-header-count">{row.count}</span>
        </div>
      );
    }
    const a = row.agent;
    const status = statusOf(a);
    return (
      <div style={{ ...style, paddingBottom: 5 }}>
        <div
          className={`agent-card ${selectedAgent?.id === a.id ? 'selected' : ''} ${a.banned ? 'is-banned' : ''}`}
          onClick={() => onSelect(a)}
          title={fullDate(a.last_seen)}
        >
          <div className="agent-main">
            <span className={`status-dot ${status}`} />
            <Flag agent={a} size="sm" />
            <span className="agent-host">{a.hostname}</span>
            <TagChips tags={a.tags || []} max={2} small />
            <span className={`agent-badge ${status}`}>{status}</span>
          </div>
          <div className="agent-meta">
            <span className="agent-ip mono" title={a.ip_address}>{a.ip_address || '0.0.0.0'}</span>
            <span className="agent-seen">seen {timeAgoShort(a.last_seen)}</span>
            <div className="agent-actions" onClick={(e) => e.stopPropagation()}>
              {a.banned ? (
                <button className="agent-btn ok" title="Unban this agent" onClick={(e) => unbanAgent(e, a)}>Unban</button>
              ) : (
                <button className="agent-btn warn" title="Ban this agent" onClick={(e) => banAgent(e, a)}>Ban</button>
              )}
              <button className="agent-btn danger" title="Permanently remove this agent" onClick={(e) => deleteAgent(e, a)}>Delete</button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (agents.length === 0) {
    return (
      <div className="agent-list">
        <div className="agent-empty">No agents deployed yet</div>
      </div>
    );
  }

  return (
    <div className="agent-list smart">
      <div className="al-toolbar">
        <input
          className="al-search"
          type="text"
          placeholder="Search host, IP, user, country, ISP, tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="al-sort" value={sortKey} onChange={(e) => setSortKey(e.target.value)} title="Sort within groups">
          <option value="last_seen">Recent</option>
          <option value="hostname">Name</option>
          <option value="country">Country</option>
          <option value="os">OS</option>
        </select>
      </div>

      <div className="al-scroll" ref={containerRef}>
        {rows.length === 0 ? (
          <div className="agent-empty">No agents match the current search.</div>
        ) : (
          <VList
            ref={listRef}
            height={listH}
            width="100%"
            itemCount={rows.length}
            itemSize={getItemSize}
            itemKey={(i) => rows[i].key}
            className="al-vlist"
          >
            {Row}
          </VList>
        )}
      </div>

      <div className="al-footer">
        showing {rows.filter((r) => r.type === 'agent').length} of {agents.length}
        <span className="al-footer-sep">·</span>
        <span className="online">{counts.online} online</span>
        <span className="al-footer-sep">·</span>
        <span>{counts.offline} offline</span>
        {counts.banned > 0 && (
          <>
            <span className="al-footer-sep">·</span>
            <span className="banned">{counts.banned} banned</span>
          </>
        )}
      </div>
    </div>
  );
}

export default AgentList;
