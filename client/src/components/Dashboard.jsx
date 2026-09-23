import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import AgentList from './AgentList';
import Terminal from './Terminal';
import ScriptRunner from './ScriptRunner';
import HistoryPanel from './HistoryPanel';
import { flagEmoji, countryLabel, osIcon, osLabel, timeAgo, fullDate } from '../utils';

function Dashboard({ token, onLogout }) {
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [activeTab, setActiveTab] = useState('shell');
  const [shellRunning, setShellRunning] = useState({}); // per-agent: { [agentId]: bool }
  const wsRef = useRef(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('rto.sidebar.collapsed') !== '1'
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const w = parseInt(localStorage.getItem('rto.sidebar.width') || '', 10);
    return Number.isFinite(w) && w >= 200 ? w : 280;
  });
  const [historyKey, setHistoryKey] = useState(0);
  const [linkNotice, setLinkNotice] = useState('');
  const sidebarWidthRef = useRef(sidebarWidth);
  const dragState = useRef(null);
  const onLogoutRef = useRef(onLogout);
  useEffect(() => {
    onLogoutRef.current = onLogout;
  }, [onLogout]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    let disposed = false;   // prevents reconnect attempts after unmount / token change
    let ws = null;
    let retries = 0;
    let timer = null;

    const fetchAgents = () => {
      api.get('/agents').then((res) => setAgents(res.data)).catch(console.error);
    };

    const connect = () => {
      if (disposed) return;
      const wsUrl = `${window.location.origin.replace(/^http/, 'ws')}/ws/operator?token=${token}`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retries = 0;
        setWsConnected(true);
        // Re-sync the agent list on every (re)connect so statuses aren't stale
        fetchAgents();
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (msg.type === 'agent_status') {
          // BUG FIX — upsert instead of map-only. The old code updated the
          // agent row ONLY if it was already in state, so an agent connecting
          // for the first time (or after a fresh enroll) never appeared until
          // a manual page refresh.
          setAgents((prev) => {
            const exists = prev.some((a) => a.id === msg.agent.id);
            if (exists) {
              return prev.map((a) =>
                a.id === msg.agent.id ? { ...a, ...msg.agent, status: msg.agent.status } : a
              );
            }
            // Unknown agent — fetch the full row (the WS payload is partial)
            api.get('/agents').then((res) => setAgents(res.data)).catch(() => {});
            return prev;
          });
          // keep the selected agent object in sync so terminal overlays,
          // badges and "last seen" react live to status changes
          setSelectedAgent((prev) =>
            prev && prev.id === msg.agent.id ? { ...prev, ...msg.agent, status: msg.agent.status } : prev
          );
        } else if (msg.type === 'agent_removed') {
          // NEW: agent was deleted — drop it from the list, clear selection
          setAgents((prev) => prev.filter((a) => a.id !== msg.agent_id));
          setSelectedAgent((prev) => (prev?.id === msg.agent_id ? null : prev));
        } else if (msg.type === 'terminal_output' || msg.type === 'script_result' || msg.type === 'script_error') {
          // Pass to child components (Terminal / ScriptRunner) via a custom event
          window.dispatchEvent(new CustomEvent('agent-message', { detail: msg }));
          // A new result may have landed — refresh the activity feed badge
          if (msg.type === 'script_result') setHistoryKey((k) => k + 1);
        }
      };
      ws.onclose = (event) => {
        setWsConnected(false);
        if (disposed) return;
        // 4003 = invalid/expired token — stop retrying and force re-auth
        if (event.code === 4003) {
          onLogoutRef.current();
          return;
        }
        // Exponential backoff: 1s, 2s, 4s, 8s ... capped at 15s
        const delay = Math.min(1000 * 2 ** retries, 15000);
        retries += 1;
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        try { ws.close(); } catch (e) { /* noop */ }
      };
    };

    fetchAgents(); // initial load
    connect();     // then keep the link alive automatically

    // NEW: periodic refresh so "last seen" and statuses stay honest even
    // without WS events (heartbeats only touch the DB server-side).
    const poll = setInterval(fetchAgents, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') fetchAgents(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      if (ws) ws.close();
    };
  }, [token]);

  // Returns false when the link is down so callers can surface feedback
  // instead of silently dropping the operator's action.
  const sendToAgent = (message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
      return true;
    }
    setLinkNotice('Link to server is down — your last action was NOT delivered.');
    setTimeout(() => setLinkNotice(''), 4000);
    return false;
  };

  const toggleSidebar = () => {
    setSidebarOpen((prev) => {
      const next = !prev;
      localStorage.setItem('rto.sidebar.collapsed', next ? '0' : '1');
      return next;
    });
  };

  const onResizeMove = (e) => {
    const d = dragState.current;
    if (!d) return;
    const min = 200;
    const max = Math.max(min, Math.floor(window.innerWidth * 0.5));
    const next = Math.min(max, Math.max(min, d.startWidth + (e.clientX - d.startX)));
    setSidebarWidth(next);
  };

  const onResizeEnd = () => {
    dragState.current = null;
    document.body.classList.remove('resizing');
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeEnd);
    localStorage.setItem('rto.sidebar.width', String(sidebarWidthRef.current));
  };

  const onResizeStart = (e) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: sidebarWidth };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', onResizeEnd);
  };

  const refreshAgents = () => {
    api.get('/agents').then((res) => {
      setAgents(res.data);
      // keep the selected agent object fresh after ban/unban/delete
      setSelectedAgent((prev) => (prev ? res.data.find((a) => a.id === prev.id) || null : null));
    }).catch(console.error);
  };

  const onlineCount = agents.filter((a) => a.status === 'online' && !a.banned).length;
  const bannedCount = agents.filter((a) => a.banned).length;
  const shellIsRunning = !!selectedAgent && !!shellRunning[selectedAgent.id];

  return (
    <div className="dashboard">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <div>
            <h1>Badman</h1>
            <span className="brand-sub">Operator Console</span>
          </div>
        </div>
        <button
          className={`btn-sidebar-toggle ${sidebarOpen ? 'active' : ''}`}
          onClick={toggleSidebar}
          title={sidebarOpen ? 'Hide agent panel' : 'Show agent panel'}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
            <line x1="6.5" y1="2.5" x2="6.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        <div className="topbar-stats">
          <div className="stat">
            <span className="stat-label">Agents</span>
            <span className="stat-value">{agents.length}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Online</span>
            <span className="stat-value">{onlineCount}</span>
          </div>
          {bannedCount > 0 && (
            <div className="stat">
              <span className="stat-label">Banned</span>
              <span className="stat-value banned">{bannedCount}</span>
            </div>
          )}
        </div>
        <span className={`conn-pill ${wsConnected ? 'online' : 'offline'}`}>
          <span className="conn-dot" />
          {wsConnected ? 'Link Established' : 'Link Down'}
        </span>
        <button className="btn-logout" onClick={onLogout}>Sign out</button>
      </header>

      {linkNotice && <div className="link-notice">{linkNotice}</div>}

      <div className="workspace">
        <aside
          className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}
          style={{ width: sidebarOpen ? sidebarWidth : 0 }}
        >
          <div className="sidebar-head">
            <span>Deployed Agents</span>
            <span className="count-badge">{agents.length}</span>
          </div>
          <AgentList
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={setSelectedAgent}
            onAgentsChanged={refreshAgents}
          />
        </aside>
        {sidebarOpen && <div className="sidebar-resizer" onMouseDown={onResizeStart} />}

        <main className="main-panel">
          {selectedAgent ? (
            <div className="tab-area">
              {/* NEW: full agent details — OS, IP, country flag, ISP, first/last seen */}
              <section className="agent-details">
                <div className="ad-title-row">
                  <span className="ad-flag" title={countryLabel(selectedAgent)}>
                    {flagEmoji(selectedAgent.country_code)}
                  </span>
                  <span className="ad-hostname">{selectedAgent.hostname}</span>
                  <span className={`agent-badge ${selectedAgent.banned ? 'banned' : selectedAgent.status}`}>
                    {selectedAgent.banned ? 'banned' : selectedAgent.status}
                  </span>
                  <span className="ad-seen">
                    last seen {timeAgo(selectedAgent.last_seen)} · first seen {timeAgo(selectedAgent.created_at)}
                  </span>
                </div>
                <div className="ad-grid">
                  <div className="ad-cell"><span className="ad-label">IP</span><span className="ad-value mono">{selectedAgent.ip_address || '—'}</span></div>
                  <div className="ad-cell"><span className="ad-label">OS</span><span className="ad-value">{osIcon(selectedAgent)} {osLabel(selectedAgent)}</span></div>
                  <div className="ad-cell"><span className="ad-label">Arch</span><span className="ad-value mono">{selectedAgent.os_arch || '—'}</span></div>
                  <div className="ad-cell"><span className="ad-label">Platform</span><span className="ad-value">{selectedAgent.platform || '—'}</span></div>
                  <div className="ad-cell"><span className="ad-label">User</span><span className="ad-value">{selectedAgent.username || '—'}</span></div>
                  <div className="ad-cell"><span className="ad-label">Country</span><span className="ad-value">{flagEmoji(selectedAgent.country_code)} {countryLabel(selectedAgent)}</span></div>
                  <div className="ad-cell"><span className="ad-label">ISP</span><span className="ad-value">{selectedAgent.isp || '—'}</span></div>
                  <div className="ad-cell"><span className="ad-label">Agent ID</span><span className="ad-value mono">{selectedAgent.id.slice(0, 13)}…</span></div>
                </div>
                {selectedAgent.banned && selectedAgent.ban_reason && (
                  <div className="ad-banreason">Ban reason: {selectedAgent.ban_reason}</div>
                )}
              </section>

              <nav className="tabbar">
                <button
                  className={`tab ${activeTab === 'shell' ? 'active' : ''}`}
                  onClick={() => setActiveTab('shell')}
                >
                  <span className={`tab-dot ${wsConnected ? 'live' : ''}`} />
                  Shell
                </button>
                <button
                  className={`tab ${activeTab === 'scripts' ? 'active' : ''}`}
                  onClick={() => setActiveTab('scripts')}
                >
                  <span className={`tab-dot amber ${wsConnected ? 'live' : ''}`} />
                  Script Runner
                </button>
                <button
                  className={`tab ${activeTab === 'history' ? 'active' : ''}`}
                  onClick={() => setActiveTab('history')}
                >
                  <span className="tab-dot green" />
                  Activity
                </button>
                <span className="tabbar-meta">
                  {selectedAgent.hostname} · {selectedAgent.ip_address || '0.0.0.0'}
                </span>
              </nav>

              <section className={`panel terminal-panel ${activeTab === 'shell' ? '' : 'hidden'}`}>
                <div className="panel-head">
                  <span className="panel-title">
                    <span className="title-dot" /> Interactive Shell
                  </span>
                  <span className="panel-meta">cmd · {selectedAgent.hostname}</span>
                  <button
                    className={`btn-shell-toggle ${shellIsRunning ? 'running' : ''}`}
                    onClick={() => setShellRunning((prev) => ({ ...prev, [selectedAgent.id]: !prev[selectedAgent.id] }))}
                    title={shellIsRunning ? 'Stop the background shell' : 'Start the background shell'}
                  >
                    <span className="shell-toggle-dot" />
                    {shellIsRunning ? 'Stop' : 'Start'}
                  </button>
                </div>
                <div className="terminal-body">
                  <Terminal
                    agent={selectedAgent}
                    sendToAgent={sendToAgent}
                    active={activeTab === 'shell'}
                    running={shellIsRunning}
                    connected={wsConnected}
                  />
                </div>
              </section>

              <section className={`panel script-panel ${activeTab === 'scripts' ? '' : 'hidden'}`}>
                <ScriptRunner
                  agents={agents}
                  defaultAgentId={selectedAgent.id}
                  sendToAgent={sendToAgent}
                />
              </section>

              <section className={`panel history-tab ${activeTab === 'history' ? '' : 'hidden'}`}>
                <HistoryPanel agent={selectedAgent} refreshKey={historyKey} />
              </section>
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">⌁</span>
              <h2>No Agent Selected</h2>
              <p>Select a deployed agent from the left to open a shell, script runner and activity feed.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default Dashboard;
