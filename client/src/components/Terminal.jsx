import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function Terminal({ agent, sendToAgent, active, running, connected }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const isInitialized = useRef(false);
  // NEW: has xterm actually been open()ed on a VISIBLE container?
  const hasOpened = useRef(false);
  // NEW: output that arrives before the terminal is visible gets buffered
  // here and flushed right after open(), so early shell output is never lost.
  const pendingWrites = useRef([]);
  // NEW: cancel handle for the deferred-open retry loop
  const openRetry = useRef(null);

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
    if (!hasOpened.current) return;
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

  // ====================================================================
  // BUG FIX — "terminal sometimes doesn't show":
  // Both panels stay mounted and are toggled with `.panel.hidden
  // { display: none }`. The old code called term.open() in the mount
  // effect, so any mount that happened while the panel was hidden
  // (e.g. selecting a new agent while on the Script tab) attached xterm
  // to a 0x0 display:none container. The renderer never attaches and the
  // terminal stays blank forever — even after switching back to the tab.
  //
  // FIX: create the Terminal instance on mount, but DEFER term.open()
  // until the panel is actually visible (active && measurable size),
  // with a short retry loop for the frame where CSS finishes applying.
  // ====================================================================
  useEffect(() => {
    if (!terminalRef.current || isInitialized.current) return;
    isInitialized.current = true;
    hasOpened.current = false;
    pendingWrites.current = [];

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

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Deferred open: wait until the container is visible, then open, flush
    // buffered output, fit and focus. Retries a few frames because the
    // display switch may land a frame after `active` flips.
    const tryOpen = (attemptsLeft) => {
      const el = terminalRef.current;
      if (!el || hasOpened.current) return;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) {
        if (attemptsLeft > 0) {
          openRetry.current = requestAnimationFrame(() => tryOpen(attemptsLeft - 1));
        }
        return; // still hidden — will re-arm when `active` changes
      }
      term.open(el);
      hasOpened.current = true;
      // Flush anything the agent sent before the terminal became visible
      for (const chunk of pendingWrites.current) term.write(chunk);
      pendingWrites.current = [];
      fitAndSync(true);
      if (active) term.focus();
    };

    // If the panel is visible right now, open on the next frame; otherwise
    // the [active] effect below re-arms the retry when the tab is shown.
    openRetry.current = requestAnimationFrame(() => tryOpen(30));

    const handleAgentMessage = (event) => {
      const msg = event.detail;
      if (msg?.agent_id === agent.id && msg?.type === 'terminal_output') {
        const rawText = msg.data?.data || msg.data;
        if (rawText) {
          if (!hasOpened.current) {
            // Terminal not visible yet — buffer, flush after open()
            pendingWrites.current.push(rawText);
            if (pendingWrites.current.length > 500) pendingWrites.current.shift();
            return;
          }
          const buffer = term.buffer.active;
          // Fixed: xterm's IBuffer property is `viewportY`, not `viewY`.
          const atBottom = buffer.viewportY >= buffer.baseY;
          term.write(rawText, () => {
            if (atBottom) term.scrollToBottom();
          });
        }
      }
    };
    window.addEventListener('agent-message', handleAgentMessage);

    // Input is a pure passthrough — the backend PTY is the source of truth.
    const dataDisposable = term.onData((data) => {
      sendToAgentRef.current({
        action: 'terminal_input',
        agent_id: agent.id,
        data
      });
    });

    const resizeDisposable = term.onResize(() => {
      const t = xtermRef.current;
      if (!t || !hasOpened.current) return;
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
      if (openRetry.current) cancelAnimationFrame(openRetry.current);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      isInitialized.current = false;
      hasOpened.current = false;
      pendingWrites.current = [];
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

  // When the tab becomes visible, finish opening (if deferred) and re-fit.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      if (xtermRef.current && !hasOpened.current) {
        // Panel just became visible — run the deferred open now
        const el = terminalRef.current;
        if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
          const term = xtermRef.current;
          term.open(el);
          hasOpened.current = true;
          for (const chunk of pendingWrites.current) term.write(chunk);
          pendingWrites.current = [];
        }
      }
      fitAndSync(true);
      xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, agent.id]);

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

  // Overlay state: never leave the operator staring at a mysterious void.
  let overlay = null;
  if (!connected) {
    overlay = { cls: 'warn', text: '⚡ Link down — reconnecting to server…' };
  } else if (agent.status === 'offline' || agent.status === 'banned') {
    overlay = { cls: 'warn', text: agent.status === 'banned'
      ? '⛔ Agent is banned — terminal disabled'
      : '⏸ Agent offline — waiting for it to come back…' };
  } else if (!hasOpened.current && !running) {
    overlay = { cls: 'info', text: '▶ Press Start to launch the shell' };
  }

  return (
    <div className="terminal-wrap" style={{ position: 'relative', width: '100%', height: '100%', minHeight: '300px', overflow: 'hidden' }}>
      <div
        ref={terminalRef}
        className={`terminal ${overlay ? 'terminal-dim' : ''}`}
        style={{ width: '100%', height: '100%' }}
        tabIndex={active ? 0 : -1}
        onClick={() => xtermRef.current?.focus()}
        onFocus={() => xtermRef.current?.focus()}
      />
      {overlay && (
        <div className={`terminal-overlay ${overlay.cls}`} onClick={() => xtermRef.current?.focus()}>
          <span>{overlay.text}</span>
        </div>
      )}
    </div>
  );
}

export default Terminal;
