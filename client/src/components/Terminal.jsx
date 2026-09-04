import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function Terminal({ agent, sendToAgent, active, running, connected }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const isInitialized = useRef(false);
  const lineRef = useRef(''); // tracks the current typed line for cls/clear detection

  // Maintain latest reference to prevent useEffect teardown loops if parent re-renders
  const sendToAgentRef = useRef(sendToAgent);
  useEffect(() => {
    sendToAgentRef.current = sendToAgent;
  }, [sendToAgent]);

  // Mount the xterm instance once (independent of session start/stop)
  useEffect(() => {
    // Prevent React 18 Strict Mode double-mounting bugs
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
    
    // Defer initial fit + focus to ensure container dimensions are calculated
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
        // Safe extraction wrapper depending on C2 object nesting layers
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
      // Local Echo removed completely. ConPTY echoes automatically.
      
      // Track the line context strictly for clearing operations
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
      
      // Send key events straight to backend C2 router
      sendToAgentRef.current({ action: 'terminal_input', agent_id: agent.id, data });
    });

    const resizeDisposable = term.onResize(() => sendSize());

    return () => {
      window.removeEventListener('agent-message', handleAgentMessage);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      isInitialized.current = false;
    };
  }, [agent.id]); // Removed sendToAgent to prevent terminal destruction on function recreation

  // Start/stop the remote shell session based on the `running` prop, and
  // RE-ESTABLISH it when the link comes back up (the agent clears its terminal
  // session on disconnect, so we must re-send terminal_start after a reconnect).
  useEffect(() => {
    if (running && connected) {
      sendToAgentRef.current({ action: 'terminal_start', agent_id: agent.id, shell: 'cmd' });
    } else {
      sendToAgentRef.current({ action: 'terminal_stop', agent_id: agent.id });
    }
    // Stop the shell when this effect tears down (agent switch / unmount),
    // so switching agents doesn't leave an orphaned shell on the old agent.
    return () => {
      sendToAgentRef.current({ action: 'terminal_stop', agent_id: agent.id });
    };
  }, [running, connected, agent.id]);

  // Replaced window resize with ResizeObserver for accurate component-level layout shifts
  useEffect(() => {
    if (!terminalRef.current) return;

    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current?.element) {
        requestAnimationFrame(() => {
          try {
            fitAddonRef.current.fit();
          } catch (e) {
            // Suppress fit errors during rapid unmounts
          }
        });
      }
    });

    observer.observe(terminalRef.current);
    
    return () => observer.disconnect();
  }, []);

  // Re-fit + focus + report size when the shell tab becomes visible again.
  // Fixes distortion caused by fitting while the panel was hidden (display:none).
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
      } catch (e) {
        // suppress if the terminal is disposed mid-frame
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active, agent.id]);

  return (
    <div 
      ref={terminalRef} 
      className="terminal" 
      style={{ width: '100%', height: '100%', minHeight: '300px', overflow: 'hidden' }} 
      onClick={() => xtermRef.current?.focus()}
    />
  );
}

export default Terminal;
