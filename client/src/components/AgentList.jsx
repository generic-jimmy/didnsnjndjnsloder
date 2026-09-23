import React, { useState, useEffect } from 'react';
import api from '../api';
import { flagEmoji, countryLabel, osIcon, osLabel, timeAgo, fullDate } from '../utils';

function AgentList({ agents, selectedAgent, onSelect, onAgentsChanged }) {
  const [now, setNow] = useState(Date.now());

  // Tick every 15s so "last seen 2m ago" stays honest without refetching
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  if (agents.length === 0) {
    return (
      <div className="agent-list">
        <div className="agent-empty">No agents deployed yet</div>
      </div>
    );
  }

  const banAgent = async (e, agent) => {
    e.stopPropagation();
    const reason = window.prompt(
      `Ban "${agent.hostname}"?\nThe agent will be kicked and rejected while banned.` +
      `\n\nOptional reason:`,
      'Banned by operator'
    );
    if (reason === null) return; // cancelled
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

  return (
    <div className="agent-list">
      <ul>
        {agents.map((agent) => {
          const status = agent.banned ? 'banned' : (agent.status || 'offline');
          return (
            <li
              key={agent.id}
              className={`agent-card ${selectedAgent?.id === agent.id ? 'selected' : ''} ${agent.banned ? 'is-banned' : ''}`}
              onClick={() => onSelect(agent)}
              title={fullDate(agent.last_seen)}
            >
              <div className="agent-main">
                <span className={`status-dot ${status}`}></span>
                <span className="agent-flag" title={countryLabel(agent)}>{flagEmoji(agent.country_code)}</span>
                <span className="agent-host">{agent.hostname}</span>
                <span className={`agent-badge ${status}`}>{status}</span>
              </div>
              <div className="agent-meta">
                <span className="agent-os-line" title={osLabel(agent)}>
                  <span className="agent-os-icon">{osIcon(agent)}</span>
                  {agent.ip_address || '0.0.0.0'}
                </span>
                <span className="agent-seen">seen {timeAgo(agent.last_seen)}</span>
              </div>
              <div className="agent-actions" onClick={(e) => e.stopPropagation()}>
                {agent.banned ? (
                  <button
                    className="agent-btn ok"
                    title="Unban this agent"
                    onClick={(e) => unbanAgent(e, agent)}
                  >Unban</button>
                ) : (
                  <button
                    className="agent-btn warn"
                    title="Ban this agent"
                    onClick={(e) => banAgent(e, agent)}
                  >Ban</button>
                )}
                <button
                  className="agent-btn danger"
                  title="Permanently remove this agent"
                  onClick={(e) => deleteAgent(e, agent)}
                >Delete</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default AgentList;
