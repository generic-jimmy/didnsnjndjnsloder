import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function Terminal({ agent, sendToAgent, active, running, connected }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const isInitialized = useRef(false);

  const sendToAgentRef = useRef(sendToAgent);
  useEffect(() => {
    sendToAgentRef.current = sendToAgent;
  }, [sendToAgent]);

  // Fit + notify the agent of the new size in one place, with guards
  // against fitting a hidden / zero-size container (this was previously
  // silently swallowed, which is why a bad fit could go undetected and
  // leave the backend PTY at the wrong cols/rows -> wrapped/garbled output).
  const fitAndSync = (force = false) => {
    const el = terminalRef.current;
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!el || !term || !fitAddon) return;
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return; // not visible, skip

    const prevCols = term.cols;
    const prevRows = term.rows;
    try {
      fitAddon.fit();
    } catch (e) {
      console.error('Terminal fit failed:', e);
      return;
    }

    // Explicitly send size whenever we asked for a fit, instead of relying
    // solely on term.onResize firing (fit() only fires that event when the
    // computed cols/rows actually change, which can mask a stale backend size).
    if (force || term.cols !== prevCols || term.rows !== prevRows) {
      sendToAgentRef.current({
        action: 'terminal_resize',
        agent_id: agent.id,
        cols: term.cols,
        rows: term.rows
      });
    }
  };

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

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    requestAnimationFrame(() => {
      fitAndSync(true);
      // Only steal focus on mount if this terminal is actually the visible one.
      if (active) term.focus();
    });

    const handleAgentMessage = (event) => {
      const msg = event.detail;
      if (msg?.agent_id === agent.id && msg?.type === 'terminal_output') {
        const rawText = msg.data?.data || msg.data;
        if (rawText) {
          const buffer = term.buffer.active;
          // Fixed: xterm's IBuffer property is `viewportY`, not `viewY`.
          // The old code referenced a nonexistent property, so `atBottom`
          // was always false and autoscroll never ran.
          const atBottom = buffer.viewportY >= buffer.baseY;
          term.write(rawText, () => {
            // Scroll after the write has actually been processed, not just
            // queued, so we scroll to where the content really ends up.
            if (atBottom) term.scrollToBottom();
          });
        }
      }
    };
    window.addEventListener('agent-message', handleAgentMessage);

    // NOTE: removed the client-side "shadow" line buffer that tried to
    // detect `cls`/`clear` and locally call term.clear(). It had no way to
    // track arrow keys, ctrl sequences, tab-completion or pasted text, so it
    // would drift out of sync with the real shell state, and calling
    // term.clear() locally raced with the backend's own output for the same
    // command, causing flicker/partial redraws. The backend PTY is the
    // source of truth for what the screen should contain; input is now a
    // pure passthrough.
    const dataDisposable = term.onData((data) => {
      sendToAgentRef.current({
        action: 'terminal_input',
        agent_id: agent.id,
        data
      });
    });

    const resizeDisposable = term.onResize(() => {
      const t = xtermRef.current;
      if (!t) return;
      sendToAgentRef.current({
        action: 'terminal_resize',
        agent_id: agent.id,
        cols: t.cols,
        rows: t.rows
      });
    });

    return () => {
      window.removeEventListener('agent-message', handleAgentMessage);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      isInitialized.current = false;
    };
  }, [agent.id]);

  // Start/stop shell. Track the previous running/connected pair so a brief
  // `connected` flicker (e.g. a momentary websocket hiccup) doesn't tear
  // down and restart the shell — that restart window is a real cause of
  // "sometimes I can't type", since input sent while the shell is mid-
  // restart gets dropped.
  const prevShellState = useRef({ running: null, connected: null });
  useEffect(() => {
    const shouldRun = running && connected;
    const prevShouldRun =
      prevShellState.current.running && prevShellState.current.connected;

    if (shouldRun && !prevShouldRun) {
      sendToAgentRef.current({ action: 'terminal_start', agent_id: agent.id, shell: 'cmd' });
    } else if (!shouldRun && prevShouldRun) {
      sendToAgentRef.current({ action: 'terminal_stop', agent_id: agent.id });
    }

    prevShellState.current = { running, connected };
  }, [running, connected, agent.id]);

  // True unmount cleanup only.
  useEffect(() => {
    return () => {
      sendToAgentRef.current({ action: 'terminal_stop', agent_id: agent.id });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  // Ensure focus when terminal becomes active or running
  useEffect(() => {
    if (active && running && connected && xtermRef.current) {
      const focusTimer = setTimeout(() => {
        xtermRef.current?.focus();
      }, 100);
      return () => clearTimeout(focusTimer);
    }
  }, [active, running, connected]);

  // Resize observer — guarded fit + explicit sync (see fitAndSync above).
  useEffect(() => {
    if (!terminalRef.current) return;
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAndSync());
    });
    observer.observe(terminalRef.current);
    return () => observer.disconnect();
  }, []);

  // Re-fit when active changes
  useEffect(() => {
    if (!active || !xtermRef.current) return;
    const raf = requestAnimationFrame(() => {
      fitAndSync(true);
      xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, agent.id]);

  return (
    <div
      ref={terminalRef}
      className="terminal"
      style={{ width: '100%', height: '100%', minHeight: '300px', overflow: 'hidden' }}
      tabIndex={active ? 0 : -1}
      onClick={() => xtermRef.current?.focus()}
      onFocus={() => xtermRef.current?.focus()}
    />
  );
}

export default Terminal;
