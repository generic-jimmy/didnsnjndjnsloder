import React from 'react';

function AgentList({ agents, selectedAgent, onSelect }) {
  if (agents.length === 0) {
    return (
      <div className="agent-list">
        <div className="agent-empty">No agents deployed yet</div>
      </div>
    );
  }

  return (
    <div className="agent-list">
      <ul>
        {agents.map((agent) => (
          <li
            key={agent.id}
            className={`agent-card ${selectedAgent?.id === agent.id ? 'selected' : ''}`}
            onClick={() => onSelect(agent)}
          >
            <div className="agent-main">
              <span className={`status-dot ${agent.status}`}></span>
              <span className="agent-host">{agent.hostname}</span>
              <span className={`agent-badge ${agent.status}`}>{agent.status}</span>
            </div>
            <div className="agent-meta">
              <span>{agent.ip_address || '0.0.0.0'}</span>
              <span className="agent-os">{agent.os_version || 'Windows'}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default AgentList;
