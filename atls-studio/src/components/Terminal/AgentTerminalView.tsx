import { useEffect, useRef, useCallback } from 'react';
import { useTerminalStore, type AgentCommandEntry } from '../../stores/terminalStore';

// ---------------------------------------------------------------------------
// AgentTerminalView — read-only virtual terminal for agent command display.
// Shows clean command/output pairs; only Ctrl+C passes through to the PTY.
// ---------------------------------------------------------------------------

function StatusIndicator({ entry }: { entry: AgentCommandEntry }) {
  switch (entry.status) {
    case 'running':
      return <span className="agent-term-status running" />;
    case 'done':
      return <span className="agent-term-status text-green-400">✓</span>;
    case 'error':
      return (
        <span className="agent-term-status text-red-400">
          ✗ exit {entry.exitCode}
        </span>
      );
    case 'timeout':
      return <span className="agent-term-status text-yellow-400">⏱ timeout</span>;
    case 'message':
      return null;
    default:
      return null;
  }
}

function CommandEntry({ entry }: { entry: AgentCommandEntry }) {
  if (entry.status === 'message') {
    return (
      <div className="agent-term-message">
        <pre className="agent-term-output">{entry.output}</pre>
      </div>
    );
  }

  return (
    <div className="agent-term-entry">
      <div className="agent-term-cmd-line">
        <span className="agent-term-prompt">❯</span>
        <span className="agent-term-cmd">{entry.command}</span>
        <StatusIndicator entry={entry} />
      </div>
      {entry.output && (
        <pre className="agent-term-output">{entry.output}</pre>
      )}
    </div>
  );
}

interface AgentTerminalViewProps {
  terminalId: string;
}

export function AgentTerminalView({ terminalId }: AgentTerminalViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const agentLogVersion = useTerminalStore(s => s.agentLogVersion);
  const getAgentLog = useTerminalStore(s => s.getAgentLog);
  const sendInterrupt = useTerminalStore(s => s.sendInterrupt);

  const entries = getAgentLog(terminalId);

  // Auto-scroll to bottom on new content
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [agentLogVersion]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 40;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Ctrl+C passthrough
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      sendInterrupt(terminalId);
    }
  }, [terminalId, sendInterrupt]);

  // Focus on mount so Ctrl+C works immediately
  useEffect(() => {
    containerRef.current?.focus();
  }, [terminalId]);

  return (
    <div
      ref={containerRef}
      className="agent-term-container"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={scrollRef}
        className="agent-term-scroll"
        onScroll={handleScroll}
      >
        {entries.length === 0 ? (
          <div className="agent-term-empty">
            Waiting for agent commands…
          </div>
        ) : (
          entries.map(entry => (
            <CommandEntry key={entry.id} entry={entry} />
          ))
        )}
      </div>
      <div className="agent-term-hint">
        Ctrl+C to interrupt
      </div>
    </div>
  );
}
