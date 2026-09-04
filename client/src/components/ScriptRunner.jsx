import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import api from '../api';

function ScriptRunner({ agents, sendToAgent }) {
  const [language, setLanguage] = useState('powershell');
  const [scriptContent, setScriptContent] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [output, setOutput] = useState('');
  const [saveError, setSaveError] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState(agents.map(a => a.id));
  const editorRef = useRef(null);

  // Update selected agents when the set of agent IDs actually changes.
  // Previously this ran on every new `agents` array reference (even one
  // with identical ids), which would silently blow away any manual
  // selection a future "pick specific agents" UI might make.
  useEffect(() => {
    const nextIds = agents.map(a => a.id);
    setSelectedAgentIds((prev) => {
      const same =
        prev.length === nextIds.length && prev.every((id) => nextIds.includes(id));
      return same ? prev : nextIds;
    });
  }, [agents]);

  // Capture script results for the whole lifetime of this component, so
  // long-running scripts don't lose their output (was a 30s timeout before).
  useEffect(() => {
    const handler = (event) => {
      const msg = event.detail;
      if (msg?.type === 'script_result' && selectedAgentIds.includes(msg.agent_id)) {
        setOutput((prev) => prev + `\n[${msg.agent_id}] ${msg.data?.output ?? ''}`);
      }
    };
    window.addEventListener('agent-message', handler);
    return () => window.removeEventListener('agent-message', handler);
  }, [selectedAgentIds]);

  const runScript = () => {
    if (!scriptContent.trim()) return;
    if (selectedAgentIds.length === 0) {
      setOutput((prev) => prev + `\n[warning] No agents selected — script was not sent.`);
      return;
    }
    setOutput((prev) => (prev ? prev + `\n\n--- run @ ${new Date().toLocaleTimeString()} ---` : ''));
    sendToAgent({
      action: 'script_run',
      agent_ids: selectedAgentIds,
      language,
      content: scriptContent
    });
  };

  const clearOutput = () => setOutput('');

  const saveScript = async () => {
    if (!scriptName || !scriptContent) return;
    setSaveError('');
    try {
      await api.post('/scripts', { name: scriptName, language, content: scriptContent });
      alert('Script saved');
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
      {saveError && <div className="sr-error">{saveError}</div>}
      <div className="editor-wrap">
        <Editor
          height="220px"
          language={language === 'powershell' ? 'powershell' : 'vb'}
          value={scriptContent}
          onChange={setScriptContent}
          theme="vs-dark"
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
