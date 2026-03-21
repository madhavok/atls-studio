import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useAppStore } from '../../stores/appStore';
import { useTerminalStore, TerminalInstance, getTerminalStore } from '../../stores/terminalStore';
import '@xterm/xterm/css/xterm.css';
import { CloseIcon } from '../icons';

let isCreatingInitialTerminal = false;

const AddIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
  </svg>
);

interface XTermInstance {
  terminal: XTerm;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  outputUnlisten?: UnlistenFn;
  exitUnlisten?: UnlistenFn;
  flushTimeout?: ReturnType<typeof setTimeout> | null;
  isInitialized: boolean;
}

const xtermInstances = new Map<string, XTermInstance>();

let globalTerminalContainer: HTMLDivElement | null = null;

function getGlobalContainer(): HTMLDivElement {
  if (!globalTerminalContainer) {
    globalTerminalContainer = document.createElement('div');
    globalTerminalContainer.id = 'atls-terminal-container';
    globalTerminalContainer.style.cssText = 'position: fixed; top: -9999px; left: -9999px; width: 1px; height: 1px; overflow: hidden;';
    document.body.appendChild(globalTerminalContainer);
  }
  return globalTerminalContainer;
}

const XTERM_THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

function getOrCreateXterm(terminalId: string): XTermInstance | null {
  if (xtermInstances.has(terminalId)) {
    return xtermInstances.get(terminalId)!;
  }

  const container = document.createElement('div');
  container.style.cssText = 'width: 100%; height: 100%;';
  container.dataset.terminalId = terminalId;
  getGlobalContainer().appendChild(container);

  const terminal = new XTerm({
    cursorBlink: true,
    theme: XTERM_THEME,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    scrollback: 10000,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  const instance: XTermInstance = { terminal, fitAddon, container, isInitialized: false };
  xtermInstances.set(terminalId, instance);

  let outputBuffer = '';
  const flushOutput = () => {
    if (outputBuffer) {
      terminal.write(outputBuffer);
      outputBuffer = '';
    }
    instance.flushTimeout = null;
  };

  listen<string>(`pty-output-${terminalId}`, (event) => {
    outputBuffer += event.payload;
    if (!instance.flushTimeout) {
      instance.flushTimeout = setTimeout(flushOutput, 16);
    }
    if (outputBuffer.length > 4096) {
      if (instance.flushTimeout) clearTimeout(instance.flushTimeout);
      flushOutput();
    }
  }).then(unlisten => {
    const inst = xtermInstances.get(terminalId);
    if (inst) inst.outputUnlisten = unlisten;
  }).catch(e => console.warn(`[Terminal] Failed to listen for pty-output-${terminalId}:`, e));

  listen<boolean>(`pty-exit-${terminalId}`, (event) => {
    if (event.payload) {
      terminal.writeln('\r\n\x1b[90m[Process exited]\x1b[0m');
    } else {
      terminal.writeln('\r\n\x1b[31m[Process exited with error]\x1b[0m');
    }
  }).then(unlisten => {
    const inst = xtermInstances.get(terminalId);
    if (inst) inst.exitUnlisten = unlisten;
  }).catch(e => console.warn(`[Terminal] Failed to listen for pty-exit-${terminalId}:`, e));

  return instance;
}

function cleanupXtermInstance(tabId: string) {
  const instance = xtermInstances.get(tabId);
  if (instance) {
    if (instance.flushTimeout) clearTimeout(instance.flushTimeout);
    if (instance.outputUnlisten) instance.outputUnlisten();
    if (instance.exitUnlisten) instance.exitUnlisten();
    instance.terminal.dispose();
    instance.container.remove();
    xtermInstances.delete(tabId);
  }
}

// ---------------------------------------------------------------------------
// TerminalPane — renders a tab bar + xterm for a filtered set of terminals
// ---------------------------------------------------------------------------

interface TerminalPaneProps {
  label: string;
  tabs: TerminalInstance[];
  activeId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCreateTerminal?: () => void;
  emptyMessage: string;
}

function TerminalPane({ label, tabs, activeId, onSelectTab, onCloseTab, onCreateTerminal, emptyMessage }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Mount/show active terminal in this pane
  useEffect(() => {
    if (!containerRef.current || !activeId) return;

    const instance = getOrCreateXterm(activeId);
    if (!instance) return;

    containerRef.current.innerHTML = '';
    containerRef.current.appendChild(instance.container);

    if (!instance.isInitialized) {
      instance.terminal.open(instance.container);
      instance.isInitialized = true;
    }

    const fitTimer = setTimeout(() => {
      instance.fitAddon.fit();
      const dims = instance.fitAddon.proposeDimensions();
      if (dims) {
        invoke('resize_pty', { id: activeId, cols: dims.cols, rows: dims.rows }).catch(console.error);
      }
      instance.terminal.focus();
    }, 50);

    const handleResize = () => {
      if (!instance.isInitialized) return;
      instance.fitAddon.fit();
      const dims = instance.fitAddon.proposeDimensions();
      if (dims) {
        invoke('resize_pty', { id: activeId, cols: dims.cols, rows: dims.rows }).catch(console.error);
      }
    };

    window.addEventListener('resize', handleResize);
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(fitTimer);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      if (instance.container.parentElement === containerRef.current) {
        getGlobalContainer().appendChild(instance.container);
      }
    };
  }, [activeId]);

  // Handle terminal input
  useEffect(() => {
    if (!activeId) return;
    const instance = xtermInstances.get(activeId);
    if (!instance) return;

    const handleData = (data: string) => {
      invoke('write_pty', { id: activeId, data }).catch((err) => {
        console.error('[Terminal] write_pty failed:', err);
        const store = useTerminalStore.getState();
        const term = store.terminals.get(activeId);
        if (term && !term.isAlive) return;
        store.markTerminalDead(activeId);
        useAppStore.getState().addToast({
          type: 'error',
          message: 'Terminal disconnected — input was not sent to the shell.',
          duration: 5000,
        });
      });
    };
    const disposable = instance.terminal.onData(handleData);
    return () => disposable.dispose();
  }, [activeId]);

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Pane header + tabs */}
      <div className="flex items-center bg-studio-surface border-b border-studio-border px-2 shrink-0">
        <span className="text-xs font-semibold text-studio-title uppercase tracking-wide mr-2 shrink-0 py-1">
          {label}
        </span>
        <div className="flex items-center gap-1 flex-1 overflow-x-auto scrollbar-thin py-1">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`
                flex items-center gap-2 px-3 py-1 rounded cursor-pointer group
                ${tab.id === activeId
                  ? 'bg-studio-bg text-studio-text'
                  : 'text-studio-muted hover:text-studio-text hover:bg-studio-border/30'
                }
              `}
              onClick={() => onSelectTab(tab.id)}
            >
              <span className="text-xs whitespace-nowrap">{tab.name}</span>
              {!tab.isAlive && (
                <span className="text-xs text-studio-error">(exited)</span>
              )}
              <button
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-studio-border rounded transition-opacity"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              >
                <CloseIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
        {onCreateTerminal && (
          <button
            onClick={onCreateTerminal}
            className="p-1 text-studio-muted hover:text-studio-text hover:bg-studio-border/30 rounded shrink-0"
            title="New Terminal"
          >
            <AddIcon />
          </button>
        )}
      </div>

      {/* Terminal content or empty state */}
      {tabs.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-studio-muted">
          {emptyMessage}
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 p-2" style={{ minHeight: 100 }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TerminalPanel — split layout: User Terminals | Agent Terminals
// ---------------------------------------------------------------------------

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TerminalPanel({ isOpen, onClose }: TerminalPanelProps) {
  const { projectPath } = useAppStore();
  const [, forceUpdate] = useState(0);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const {
    activeTerminalId,
    activeAgentTerminalId,
    createTerminal,
    closeTerminal,
    setActiveTerminal,
    setActiveAgentTerminal,
    getUserTerminals,
    getAgentTerminals,
  } = useTerminalStore();

  const userTabs = getUserTerminals();
  const agentTabs = getAgentTerminals();
  const hasAgentTerminals = agentTabs.length > 0;

  const handleCreateUserTerminal = useCallback(async () => {
    await createTerminal(projectPath || undefined);
    forceUpdate(n => n + 1);
  }, [createTerminal, projectPath]);

  // Auto-create first user terminal when panel opens
  useEffect(() => {
    if (isOpen && !isCreatingInitialTerminal) {
      const current = getTerminalStore().getUserTerminals();
      if (current.length === 0) {
        isCreatingInitialTerminal = true;
        handleCreateUserTerminal().finally(() => { isCreatingInitialTerminal = false; });
      }
    }
  }, [isOpen, handleCreateUserTerminal]);

  const handleCloseTab = async (tabId: string) => {
    cleanupXtermInstance(tabId);
    await closeTerminal(tabId);
    forceUpdate(n => n + 1);
    const remaining = getTerminalStore().getTerminalsArray();
    if (remaining.length === 0) onClose();
  };

  // Draggable split resizer
  const handleSplitResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const ratio = Math.max(0.2, Math.min(0.8, (moveEvent.clientX - rect.left) / rect.width));
      setSplitRatio(ratio);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="h-full flex flex-col bg-studio-bg">
      {/* Close panel button row */}
      <div className="flex items-center justify-end bg-studio-surface border-b border-studio-border px-2 py-0.5">
        <button
          onClick={onClose}
          className="p-1 text-studio-muted hover:text-studio-text hover:bg-studio-border/30 rounded"
          title="Close Terminal Panel"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Split panes */}
      <div ref={splitContainerRef} className="flex-1 flex min-h-0">
        {/* User terminals pane */}
        <div style={{ width: hasAgentTerminals ? `${splitRatio * 100}%` : '100%' }} className="min-w-0">
          <TerminalPane
            label="User"
            tabs={userTabs}
            activeId={activeTerminalId}
            onSelectTab={setActiveTerminal}
            onCloseTab={handleCloseTab}
            onCreateTerminal={handleCreateUserTerminal}
            emptyMessage="No user terminals"
          />
        </div>

        {/* Split divider + Agent pane — only rendered when agent terminals exist */}
        {hasAgentTerminals && (
          <>
            <div
              className="panel-resizer shrink-0"
              onMouseDown={handleSplitResize}
            />
            <div style={{ width: `${(1 - splitRatio) * 100}%` }} className="min-w-0">
              <TerminalPane
                label="Agent"
                tabs={agentTabs}
                activeId={activeAgentTerminalId}
                onSelectTab={setActiveAgentTerminal}
                onCloseTab={handleCloseTab}
                emptyMessage="No agent terminals"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default TerminalPanel;
