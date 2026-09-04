import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function Terminal({ agent, sendToAgent, active, running, connected }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const isInitialized = useRef(false);
  const lineRef = useRef('');

  const sendToAgentRef = useRef(sendToAgent);
  useEffect(() => {
    sendToAgentRef.current = sendToAgent;
  }, [sendToAgent]);

  // Mount xterm once
  useEffect(() => {
    if (!terminalRef.current || isInitialized.current) return;
    isInitialized.current = true;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      theme: {
        background: '#0d1117',
        foreground: '#d7e3f4',
        cursor: '#22d3ee',
        selectionBackground: 'rgba(34, 211, 238, 0.3)'
      }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);

    const sendSize = () => {
      sendToAgentRef.current({
        action: 'terminal_resize',
        agent_id: agent.id,
        cols: term.cols,
        rows: term.rows
      });
    };

    requestAnimationFrame(() => {
      fitAddon.fit();
      term.focus();
      sendSize();
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const handleAgentMessage = (event) => {
      const msg = event.detail;
      if (msg?.agent_id === agent.id && msg?.type === 'terminal_output') {
        const rawText = msg.data?.data || msg.data;
        if (rawText) {
          const buffer = term.buffer.active;
          const atBottom = buffer.viewY >= buffer.baseY;
          term.write(rawText);
          if (atBottom) {
            requestAnimationFrame(() => term.scrollToBottom());
          }
        }
      }
    };
    window.addEventListener('agent-message', handleAgentMessage);

    const dataDisposable = term.onData((data) => {
      // Track line for cls/clear detection only
      for (const ch of data) {
        if (ch === '\r') {
          const cmd = lineRef.current.trim().toLowerCase();
          if (cmd === 'cls' || cmd === 'clear') {
            term.clear();
          }
          lineRef.current = '';
        } else if (ch === '\x7f' || ch === '\b') {
          lineRef.current = lineRef.current.slice(0, -1);
        } else if (ch >= ' ' && ch !== '\x1b') {
          lineRef.current += ch;
        }
      }

      sendToAgentRef.current({
        action: 'terminal_input',
        agent_id: agent.id,
        data
      });
    });

    const resizeDisposable = term.onResize(() => sendSize());

    return () => {
      window.removeEventListener('agent-message', handleAgentMessage);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      isInitialized.current = false;
    };
  }, [agent.id]);

  // Start/stop shell
  useEffect(() => {
    if (running && connected) {
      sendToAgentRef.current({ action: 'terminal_start', agent_id: agent.id, shell: 'cmd' });
    } else {
      sendToAgentRef.current({ action: 'terminal_stop', agent_id: agent.id });
    }
    return () => {
      sendToAgentRef.current({ action: 'terminal_stop', agent_id: agent.id });
    };
  }, [running, connected, agent.id]);

  // Ensure focus when terminal becomes active or running
  useEffect(() => {
    if (active && running && connected && xtermRef.current) {
      const focusTimer = setTimeout(() => {
        xtermRef.current?.focus();
      }, 100);
      return () => clearTimeout(focusTimer);
    }
  }, [active, running, connected]);

  // Resize observer
  useEffect(() => {
    if (!terminalRef.current) return;
    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current?.element) {
        requestAnimationFrame(() => {
          try {
            fitAddonRef.current.fit();
          } catch (e) {}
        });
      }
    });
    observer.observe(terminalRef.current);
    return () => observer.disconnect();
  }, []);

  // Re-fit when active changes
  useEffect(() => {
    if (!active || !xtermRef.current) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        xtermRef.current?.focus();
        sendToAgentRef.current({
          action: 'terminal_resize',
          agent_id: agent.id,
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows
        });
      } catch (e) {}
    });
    return () => cancelAnimationFrame(raf);
  }, [active, agent.id]);

  return (
    <div
      ref={terminalRef}
      className="terminal"
      style={{ width: '100%', height: '100%', minHeight: '300px', overflow: 'hidden' }}
      tabIndex={0}
      onClick={() => xtermRef.current?.focus()}
      onFocus={() => xtermRef.current?.focus()}
    />
  );
}

export default Terminal;
