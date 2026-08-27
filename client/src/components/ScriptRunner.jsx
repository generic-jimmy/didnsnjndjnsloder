import React, { useState } from 'react';
import Editor from '@monaco-editor/react';
import api from '../api';

function ScriptRunner({ agents, sendToAgent }) {
  const [language, setLanguage] = useState('powershell');
  const [scriptContent, setScriptContent] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [output, setOutput] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState(agents.map(a => a.id));

  // Update selected agents when prop changes
  React.useEffect(() => {
    setSelectedAgentIds(agents.map(a => a.id));
  }, [agents]);

  const runScript = () => {
    if (!scriptContent.trim()) return;
    sendToAgent({
      action: 'script_run',
      agent_ids: selectedAgentIds,
      language,
      content: scriptContent
    });
    // Listen for results
    const handler = (event) => {
      const msg = event.detail;
      if (msg.type === 'script_result' && selectedAgentIds.includes(msg.agent_id)) {
        setOutput((prev) => prev + `\n[${msg.agent_id}] ${msg.data.output}`);
      }
    };
    window.addEventListener('agent-message', handler);
    // Clean up listener after some time (or keep it)
    setTimeout(() => window.removeEventListener('agent-message', handler), 30000);
  };

  const saveScript = async () => {
    if (!scriptName || !scriptContent) return;
    try {
      await api.post('/scripts', { name: scriptName, language, content: scriptContent });
      alert('Script saved');
    } catch (err) {
      console.error(err);
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
      <div className="editor-wrap">
        <Editor
          height="280px"
          language={language === 'powershell' ? 'powershell' : 'vb'}
          value={scriptContent}
          onChange={setScriptContent}
          theme="vs-dark"
        />
      </div>
      <div className="output">
        <div className="output-head">Output</div>
        <pre>{output || '// script output will appear here'}</pre>
      </div>
    </div>
  );
}

export default ScriptRunner;
