import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import api from '../api';

function ScriptRunner({ agents, tags = [], sendToAgent, defaultAgentId }) {
  const [language, setLanguage] = useState('powershell');
  const [scriptContent, setScriptContent] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [output, setOutput] = useState('');
  const [saveError, setSaveError] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState(
    defaultAgentId ? [defaultAgentId] : []
  );
  const [savedScripts, setSavedScripts] = useState([]);
  const [notice, setNotice] = useState('');
  const [targetTagFilter, setTargetTagFilter] = useState('all');
  const editorRef = useRef(null);

  // Sync selection when the agent set changes — keep existing manual picks,
  // default to the currently selected agent on first load.
  useEffect(() => {
    setSelectedAgentIds((prev) => {
      const validIds = new Set(agents.map((a) => a.id));
      const kept = prev.filter((id) => validIds.has(id));
      if (kept.length > 0) return kept;
      if (defaultAgentId && validIds.has(defaultAgentId)) return [defaultAgentId];
      return agents.map((a) => a.id);
    });
  }, [agents, defaultAgentId]);

  const loadSavedScripts = () => {
    api.get('/scripts').then((res) => setSavedScripts(res.data || [])).catch(() => {});
  };

  useEffect(() => {
    loadSavedScripts();
  }, []);

  const appendOutput = (line) => setOutput((prev) => (prev ? `${prev}\n${line}` : line));

  // Capture script results for the whole lifetime of this component, so
  // long-running scripts don't lose their output (was a 30s timeout before).
  //
  // BUG FIX — "script doesn't show results": the old handler only read
  // `msg.data?.output`. If the agent reports its result under `data` (the
  // same shape terminal_output uses) or as a bare string, the old code
  // appended empty lines and the output pane looked dead. This parser now
  // accepts every shape the server can relay.
  useEffect(() => {
    const handler = (event) => {
      const msg = event.detail;
      const d = msg?.data;
      if (msg?.type === 'script_result') {
        const text =
          typeof d === 'string'
            ? d
            : typeof d?.output === 'string'
              ? d.output
              : typeof d?.data === 'string'
                ? d.data
                : (d?.output ?? d?.data ?? '');
        appendOutput(`[${msg.agent_id}] ${text}`);
      } else if (msg?.type === 'script_error') {
        // NEW: server now tells us when a target is offline / payload invalid
        const errText = typeof d === 'string' ? d : d?.error || 'unknown error';
        const who = msg.agent_id ? `agent ${msg.agent_id}` : 'runner';
        appendOutput(`[error] ${who}: ${errText}`);
      }
    };
    window.addEventListener('agent-message', handler);
    return () => window.removeEventListener('agent-message', handler);
  }, []);

  const toggleAgent = (id) => {
    setSelectedAgentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const runScript = () => {
    if (!scriptContent.trim()) {
      setNotice('Write a script first.');
      return;
    }
    if (selectedAgentIds.length === 0) {
      setNotice('No agents selected — tick at least one target above the Run button.');
      return;
    }
    setNotice('');
    setSaveError('');
    const stamp = new Date().toLocaleTimeString();
    setOutput((prev) => (prev ? `${prev}\n\n--- run @ ${stamp} ---` : `--- run @ ${stamp} ---`));
    appendOutput(`[runner] dispatching to ${selectedAgentIds.length} agent(s)…`);

    // BUG FIX — sendToAgent used to silently drop the message when the
    // websocket was down; the operator pressed Run and nothing ever happened.
    // The Dashboard now returns false in that case and we surface it.
    const ok = sendToAgent({
      action: 'script_run',
      agent_ids: selectedAgentIds,
      language,
      content: scriptContent
    });

    if (!ok) {
      appendOutput('[error] Link to server is down — script was NOT sent. Wait for the link to reconnect.');
    }
  };

  const clearOutput = () => setOutput('');

  const saveScript = async () => {
    if (!scriptName || !scriptContent) {
      setSaveError('Script needs a name and some content before saving.');
      return;
    }
    setSaveError('');
    try {
      await api.post('/scripts', { name: scriptName, language, content: scriptContent });
      setNotice(`Saved "${scriptName}" ✓`);
      loadSavedScripts();
    } catch (err) {
      console.error(err);
      const data = err?.response?.data;
      const backendMessage =
        typeof data === 'string'
          ? data
          : data?.message || data?.error || data?.detail;
      setSaveError(backendMessage || err?.message || 'Failed to save script.');
    }
  };

  const loadScript = (id) => {
    const s = savedScripts.find((x) => x.id === id);
    if (!s) return;
    setScriptName(s.name || '');
    setScriptContent(s.content || '');
    if (s.language) setLanguage(s.language);
    setNotice(`Loaded "${s.name}" ✓`);
  };

  const deleteScript = async (id) => {
    try {
      await api.delete(`/scripts/${id}`);
      loadSavedScripts();
      setNotice('Script deleted');
    } catch (err) {
      setSaveError(err?.response?.data?.error || 'Failed to delete script.');
    }
  };

  const agentName = (id) => agents.find((a) => a.id === id)?.hostname || id;
  void agentName;

  // Group-targeting: filter the visible target list by tag
  const visibleTargets = targetTagFilter === 'all'
    ? agents
    : agents.filter((a) => (a.tags || []).some((t) => t.id === targetTagFilter));

  return (
    <div className="script-runner">
      <div className="sr-head">
        <span className="panel-title">
          <span className="title-dot" /> Script Runner
        </span>
        <div className="sr-controls">
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="powershell">PowerShell</option>
            <option value="vbscript">VBScript</option>
          </select>
          <input
            type="text"
            placeholder="Script name"
            value={scriptName}
            onChange={(e) => setScriptName(e.target.value)}
          />
          <button className="btn-ghost" onClick={saveScript}>Save</button>
          <button className="btn-primary" onClick={runScript}>▶ Run</button>
        </div>
      </div>

      {savedScripts.length > 0 && (
        <div className="sr-saved">
          <span className="sr-saved-label">Saved:</span>
          {savedScripts.map((s) => (
            <span key={s.id} className="sr-saved-chip" onClick={() => loadScript(s.id)} title="Click to load">
              {s.name}
              <button
                className="sr-saved-del"
                title="Delete script"
                onClick={(e) => { e.stopPropagation(); deleteScript(s.id); }}
              >×</button>
            </span>
          ))}
        </div>
      )}

      {/* Multi-target selection — filter by tag for group runs */}
      <div className="sr-targets">
        <span className="sr-targets-label">Targets:</span>
        {tags.length > 0 && (
          <select
            className="sr-tag-filter"
            value={targetTagFilter}
            onChange={(e) => setTargetTagFilter(e.target.value)}
            title="Show only agents with this tag"
          >
            <option value="all">All agents</option>
            {tags.map((t) => <option key={t.id} value={t.id}>Tag: {t.name}</option>)}
          </select>
        )}
        {visibleTargets.map((a) => (
          <label key={a.id} className={`sr-target ${selectedAgentIds.includes(a.id) ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={selectedAgentIds.includes(a.id)}
              onChange={() => toggleAgent(a.id)}
            />
            {a.hostname}
          </label>
        ))}
        <button
          className="btn-ghost btn-small"
          onClick={() => setSelectedAgentIds(visibleTargets.map((a) => a.id))}
        >All</button>
        <button className="btn-ghost btn-small" onClick={() => setSelectedAgentIds([])}>None</button>
      </div>

      {(saveError || notice) && (
        <div className={saveError ? 'sr-error' : 'sr-notice'}>{saveError || notice}</div>
      )}

      <div className="editor-wrap">
        <Editor
          height="220px"
          language={language === 'powershell' ? 'powershell' : 'vb'}
          value={scriptContent}
          onChange={setScriptContent}
          theme="vs-dark"
          // Keep Monaco's layout in sync when panels are shown/hidden —
          // without this the editor can render 0-height inside the hidden
          // tab and look broken when switched back.
          automaticLayout
          onMount={(editor) => {
            editorRef.current = editor;
            editor.focus();
          }}
        />
      </div>
      <div className="output">
        <div className="output-head">
          <span>Output</span>
          <button className="btn-ghost btn-small" onClick={clearOutput} disabled={!output}>
            Clear
          </button>
        </div>
        <pre>{output || '// script output will appear here'}</pre>
      </div>
    </div>
  );
}

export default ScriptRunner;
