import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { usePanelResize } from './hooks/usePanelResize';
import { FileExplorer } from './components/FileExplorer';
import { CodeViewer } from './components/CodeViewer';
import { AtlsPanel } from './components/AtlsPanel';
import { ChatGridWorkspace } from './components/ChatGridWorkspace';
import { Settings } from './components/Settings';
import { QuickActions, QuickAction } from './components/QuickActions';
import { SearchPanel } from './components/SearchPanel';
import { MenuBar } from './components/MenuBar';
import { WindowControls } from './components/WindowControls';
import { SessionPicker } from './components/SessionPicker';
import { ToastContainer } from './components/Toast';
import { INTERNALS_TAB_ID } from './components/AtlsInternals';
import { useAppStore } from './stores/appStore';
import { useCostStore } from './stores/costStore';
import { useAtls } from './hooks/useAtls';
import { useOS } from './hooks/useOS';
import { useChatPersistence } from './hooks/useChatPersistence';
import { resetStaticPromptCache } from './services/aiService';

/**
 * ATLS Studio - AI-First IDE
 * 
 * Four-panel layout:
 * ┌────────────┬──────────────────┬────────────────┐
 * │            │                  │                │
 * │   File     │   Code Viewer    │   AI Chat      │
 * │   Explorer │                  │                │
 * │            ├──────────────────┤                │
 * │            │   ATLS Panel     │                │
 * │            │                  │                │
 * └────────────┴──────────────────┴────────────────┘
 */
function App() {
  const { 
    explorerCollapsed,
    terminalCollapsed,
    projectPath,
    activeRoot,
    quickActionsOpen,
    setQuickActionsOpen,
    quickFindOpen,
    setQuickFindOpen,
    searchPanelOpen,
    setSearchPanelOpen,
    terminalOpen,
    setTerminalOpen,
    files,
    openFile,
    activeFile,
    closeFile,
    chatWorkspaceLayout,
    setChatWorkspaceLayout,
    addToast,
    newChat,
    resetAgentProgress,
  } = useAppStore();
  const { newProject, openProjectWithPicker, loadFileTree, scanProject, refreshIssues, addFolderToWorkspace, saveWorkspace, openWorkspace, closeWorkspace } = useAtls();
  const { loadSession, createNewSession, deleteSession } = useChatPersistence();
  const { isMac, isWindows, isLinux } = useOS();
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(380);
  const [bottomHeight, setBottomHeight] = useState(200);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useAppStore((s) => s.settings.theme);

  // Apply theme class to document root
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(theme);
  }, [theme]);
  
  // Panel resize handlers
  const { handleLeftResize, handleRightResize, handleBottomResize, isResizing } = usePanelResize({
    leftWidth,
    setLeftWidth,
    rightWidth,
    setRightWidth,
    bottomHeight,
    setBottomHeight,
  });

  // Prevent Ctrl/Cmd+wheel zoom at document level (minimal overhead)
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    // Prevent WebKit pinch-to-zoom gestures (macOS WKWebView)
    const handleGesture = (e: Event) => {
      e.preventDefault();
    };

    document.addEventListener('wheel', handleWheel, { passive: false });
    document.addEventListener('gesturestart', handleGesture);
    document.addEventListener('gesturechange', handleGesture);
    document.addEventListener('gestureend', handleGesture);

    return () => {
      document.removeEventListener('wheel', handleWheel, { passive: false } as EventListenerOptions);
      document.removeEventListener('gesturestart', handleGesture);
      document.removeEventListener('gesturechange', handleGesture);
      document.removeEventListener('gestureend', handleGesture);
    };
  }, []);
  
  // Load file tree when project path changes
  useEffect(() => {
    if (projectPath) {
      loadFileTree(projectPath);
    }
  }, [projectPath, loadFileTree]);

  useEffect(() => {
    setChatWorkspaceLayout(activeFile ? 'document' : 'grid');
  }, [activeFile, setChatWorkspaceLayout]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+P or Cmd+Shift+P - Quick Actions
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuickActionsOpen(true);
      }
      // Ctrl+P or Cmd+P - Quick Find (file search)
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuickFindOpen(true);
      }
      // Ctrl+, or Cmd+, - Settings
      else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
      // Ctrl+Shift+F or Cmd+Shift+F - Search in Files
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchPanelOpen(true);
      }
      // Ctrl+O or Cmd+O - Open Project
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openProjectWithPicker();
      }
      // Ctrl+` or Cmd+` - Toggle Terminal
      else if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        setTerminalOpen(!terminalOpen);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setQuickActionsOpen, setQuickFindOpen, setSearchPanelOpen, setTerminalOpen, terminalOpen, openProjectWithPicker]);

  // Define Quick Actions
  const quickActions = useMemo<QuickAction[]>(() => [
    // File actions
    { id: 'file.newProject', label: 'New Project', category: 'file', shortcut: 'Ctrl+Shift+N', action: () => newProject() },
    { id: 'file.open', label: 'Open Project...', category: 'file', shortcut: 'Ctrl+O', action: () => openProjectWithPicker() },
    { id: 'file.save', label: 'Save File', category: 'file', shortcut: 'Ctrl+S', action: () => {
      window.dispatchEvent(new CustomEvent('editor-save-file'));
    }},
    { id: 'file.close', label: 'Close File', category: 'file', shortcut: 'Ctrl+W', action: () => {
      if (activeFile) closeFile(activeFile);
    }},
    
    // ATLS actions
    { id: 'atls.scan', label: 'ATLS: Scan Project', category: 'atls', shortcut: 'Ctrl+Shift+S', action: () => { const r = activeRoot ?? projectPath; if (r) scanProject(r, false); } },
    { id: 'atls.findIssues', label: 'ATLS: Find Issues', category: 'atls', action: () => {
      const r = activeRoot ?? projectPath;
      if (r) {
        refreshIssues(r);
        addToast({ type: 'info', message: 'Refreshing issues...' });
      }
    }},
    
    // Navigate actions
    { id: 'nav.quickFind', label: 'Quick Find File', category: 'navigate', shortcut: 'Ctrl+P', action: () => setQuickFindOpen(true) },
    { id: 'nav.searchInFiles', label: 'Search in Files', category: 'navigate', shortcut: 'Ctrl+Shift+F', action: () => setSearchPanelOpen(true) },
    { id: 'nav.jumpToSource', label: 'Jump to Source', category: 'navigate', shortcut: 'F12', action: () => {
      window.dispatchEvent(new CustomEvent('editor-action', { detail: { action: 'jump-to-source' } }));
    }},
    { id: 'nav.findUsages', label: 'Find Usages', category: 'navigate', shortcut: 'Shift+F12', action: () => {
      window.dispatchEvent(new CustomEvent('editor-action', { detail: { action: 'find-usages' } }));
    }},
    
    // Settings actions
    { id: 'settings.open', label: 'Open Settings', category: 'settings', shortcut: 'Ctrl+,', action: () => setSettingsOpen(true) },
    { id: 'settings.theme', label: 'Change Theme', category: 'settings', action: () => {
      // Toggle theme via store (wired in Phase 9)
      const { theme, setTheme } = useAppStore.getState() as any;
      if (typeof setTheme === 'function') {
        setTheme(theme === 'dark' ? 'light' : 'dark');
      } else {
        setSettingsOpen(true);
      }
    }},
    
    // Terminal actions
    { id: 'terminal.new', label: 'New Terminal', category: 'terminal', shortcut: 'Ctrl+`', action: () => setTerminalOpen(true) },
    { id: 'terminal.toggle', label: 'Toggle Terminal', category: 'terminal', action: () => setTerminalOpen(!terminalOpen) },
  ], [newProject, openProjectWithPicker, projectPath, scanProject, setQuickFindOpen, setSearchPanelOpen, setTerminalOpen, terminalOpen, activeFile, closeFile, refreshIssues, addToast, setSettingsOpen]);

  // Flatten file tree for quick find
  const flattenFiles = useCallback((nodes: typeof files, result: QuickAction[] = []): QuickAction[] => {
    for (const node of nodes) {
      if (node.type === 'file') {
        result.push({
          id: `file:${node.path}`,
          label: node.name,
          category: 'file',
          action: () => openFile(node.path),
        });
      }
      if (node.children) {
        flattenFiles(node.children, result);
      }
    }
    return result;
  }, [openFile]);

  const fileActions = useMemo(() => flattenFiles(files), [files, flattenFiles]);

  // Resizer drag handlers

  const handleNewProject = async () => {
    await newProject();
  };
  const handleOpenProject = async () => {
    await openProjectWithPicker();
  };

  const handleAddFolder = useCallback(async () => {
    await addFolderToWorkspace();
  }, [addFolderToWorkspace]);

  const handleSaveWorkspace = useCallback(async () => {
    await saveWorkspace();
  }, [saveWorkspace]);

  const handleOpenWorkspace = useCallback(async () => {
    await openWorkspace();
  }, [openWorkspace]);

  const handleCloseWorkspace = useCallback(async () => {
    await closeWorkspace();
  }, [closeWorkspace]);

  const handleNewChat = useCallback(() => {
    setPendingProjectPath(projectPath);
    setSessionPickerOpen(true);
  }, [projectPath]);

  const handleFindInFile = useCallback(() => {
    window.dispatchEvent(new CustomEvent('editor-action', { detail: { action: 'find' } }));
  }, []);

  const handleReplaceInFile = useCallback(() => {
    window.dispatchEvent(new CustomEvent('editor-action', { detail: { action: 'replace' } }));
  }, []);

  const handleToggleTerminal = useCallback(() => {
    setTerminalOpen(!terminalOpen);
  }, [setTerminalOpen, terminalOpen]);

  // macOS: listen for native menu events emitted from the Rust backend
  useEffect(() => {
    if (!isMac) return;

    const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
    const ZOOM_KEY = 'atls-studio-zoom';
    const readZoom = () => {
      try { const v = localStorage.getItem(ZOOM_KEY); if (v !== null) { const i = parseInt(v, 10); if (i >= 0 && i < ZOOM_LEVELS.length) return i; } } catch {}
      return 2;
    };
    const applyZoom = (idx: number) => {
      const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx));
      localStorage.setItem(ZOOM_KEY, String(clamped));
      document.documentElement.style.fontSize = `${ZOOM_LEVELS[clamped] * 16}px`;
    };

    const unlisten = listen<string>('menu-event', (event) => {
      switch (event.payload) {
        case 'new-project': handleNewProject(); break;
        case 'open-project': handleOpenProject(); break;
        case 'new-chat': handleNewChat(); break;
        case 'add-folder': handleAddFolder(); break;
        case 'save-workspace': handleSaveWorkspace(); break;
        case 'open-workspace': handleOpenWorkspace(); break;
        case 'close-workspace': handleCloseWorkspace(); break;
        case 'save':
        case 'save-all':
          window.dispatchEvent(new CustomEvent('editor-save-file'));
          break;
        case 'settings': setSettingsOpen(true); break;
        case 'find-in-file': handleFindInFile(); break;
        case 'replace': handleReplaceInFile(); break;
        case 'quick-actions': setQuickActionsOpen(true); break;
        case 'quick-find': setQuickFindOpen(true); break;
        case 'search-in-files': setSearchPanelOpen(true); break;
        case 'toggle-terminal': handleToggleTerminal(); break;
        case 'zoom-in': applyZoom(readZoom() + 1); break;
        case 'zoom-out': applyZoom(readZoom() - 1); break;
        case 'reset-zoom': applyZoom(2); break;
        case 'documentation':
          window.open('https://atls.dev/docs', '_blank', 'noopener,noreferrer');
          break;
        case 'keyboard-shortcuts': setQuickActionsOpen(true); break;
        case 'atls-internals':
          useAppStore.getState().openFile(INTERNALS_TAB_ID);
          break;
      }
    });

    return () => { unlisten.then(fn => fn()); };
  }, [isMac, handleNewProject, handleOpenProject, handleNewChat, handleAddFolder,
      handleSaveWorkspace, handleOpenWorkspace, handleCloseWorkspace,
      handleFindInFile, handleReplaceInFile, handleToggleTerminal,
      setSettingsOpen, setQuickActionsOpen, setQuickFindOpen, setSearchPanelOpen]);

  const documentFocused = chatWorkspaceLayout === 'document' && Boolean(activeFile);

  return (
    <div 
      ref={rootRef}
      data-testid="app-root"
      className={`h-screen w-screen flex flex-col bg-studio-bg text-studio-text overflow-hidden ${isMac ? 'mac-style' : 'win-style'}`}
      style={{ touchAction: 'manipulation', overscrollBehavior: 'none' }}
    >
      {/* Windows/Linux: Compact title bar with window controls */}
      {(isWindows || isLinux) && (
        <div 
          className="h-7 bg-studio-surface border-b border-studio-border flex items-center shrink-0" 
          data-tauri-drag-region
        >
          <span className="text-xs font-medium text-studio-title ml-3">ATLS</span>
          <div className="flex-1 text-center text-xs text-studio-muted pointer-events-none" data-tauri-drag-region>
            {projectPath ? projectPath.split(/[/\\]/).pop() : 'ATLS Studio'}
          </div>
          <WindowControls />
        </div>
      )}

      {/* Menu Bar (Windows/Linux only — macOS uses native NSMenu) */}
      {!isMac && (
        <MenuBar 
          onNewProject={handleNewProject}
          onOpenProject={handleOpenProject}
          onSaveFile={() => window.dispatchEvent(new CustomEvent('editor-save-file'))}
          onSettings={() => setSettingsOpen(true)}
          onNewChat={handleNewChat}
          onFindInFiles={() => setSearchPanelOpen(true)}
          onFindInFile={handleFindInFile}
          onReplaceInFile={handleReplaceInFile}
          onToggleTerminal={handleToggleTerminal}
          onAddFolder={projectPath ? handleAddFolder : undefined}
          onSaveWorkspace={projectPath ? handleSaveWorkspace : undefined}
          onOpenWorkspace={handleOpenWorkspace}
          onCloseWorkspace={projectPath ? handleCloseWorkspace : undefined}
        />
      )}

      {/* Modals */}
      <Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <QuickActions 
        isOpen={quickActionsOpen} 
        onClose={() => setQuickActionsOpen(false)} 
        actions={quickActions}
        mode="actions"
      />
      <QuickActions 
        isOpen={quickFindOpen} 
        onClose={() => setQuickFindOpen(false)} 
        actions={fileActions}
        mode="files"
      />
      <SearchPanel 
        isOpen={searchPanelOpen} 
        onClose={() => setSearchPanelOpen(false)} 
      />
      <SessionPicker
        isOpen={sessionPickerOpen}
        projectPath={pendingProjectPath || ''}
        onNewSession={async () => {
          setSessionPickerOpen(false);
          await createNewSession();
          newChat();
          resetStaticPromptCache();
          resetAgentProgress();
          useCostStore.getState().resetChat();
        }}
        onLoadSession={async (sessionId) => {
          setSessionPickerOpen(false);
          await loadSession(sessionId);
        }}
        onDeleteSession={deleteSession}
        onClose={() => setSessionPickerOpen(false)}
      />

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden" data-testid="main-layout">
        {/* Left Panel - File Explorer */}
        <div 
          className={`shrink-0 bg-studio-surface border-r border-studio-border overflow-hidden ${isResizing ? '' : 'transition-[width] duration-150'}`}
          style={{ width: explorerCollapsed ? 40 : leftWidth }}
        >
          <FileExplorer />
        </div>

        {/* Left Resizer */}
        <div 
          className="panel-resizer"
          onMouseDown={handleLeftResize}
        />

        {/* Center Panel - Chat grid primary or document focus */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {documentFocused ? (
            <>
              {/* Main View - Code Viewer (files, internals, cockpit virtual tabs) */}
              <div
                className="flex-1 overflow-hidden min-h-0"
                style={{ minHeight: 200 }}
              >
                <CodeViewer />
              </div>

              {/* Bottom Resizer */}
              <div
                className="panel-resizer-horizontal"
                onMouseDown={handleBottomResize}
              />

              {/* Bottom Panel - ATLS Intelligence & Terminal (tabbed) */}
              <div
                className={`shrink-0 bg-studio-surface border-t border-studio-border overflow-hidden ${isResizing ? '' : 'transition-[height] duration-150'}`}
                style={{ height: terminalCollapsed ? 40 : bottomHeight }}
              >
                <AtlsPanel />
              </div>
            </>
          ) : (
            <ChatGridWorkspace variant="primary" loadSession={loadSession} />
          )}
        </div>

        {/* Right Resizer - only show when document focus docks the chat grid */}
        {documentFocused && !chatCollapsed && (
          <div 
            className="panel-resizer"
            onMouseDown={handleRightResize}
          />
        )}

        {documentFocused && (
          <div
            className={`shrink-0 bg-studio-surface border-l border-studio-border overflow-hidden flex flex-col ${isResizing ? '' : 'transition-[width] duration-150'} ${
              chatCollapsed ? 'w-10' : ''
            }`}
            style={{ width: chatCollapsed ? 40 : rightWidth }}
          >
            {chatCollapsed ? (
              <div className="h-full flex flex-col items-center py-2">
                <button
                  onClick={() => setChatCollapsed(false)}
                  className="p-2 hover:bg-studio-border rounded text-studio-muted hover:text-studio-text"
                  title="Expand Chat Grid"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                  </svg>
                </button>
                <div className="mt-2 text-xs text-studio-muted [writing-mode:vertical-lr] rotate-180">
                  Chat Grid
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-studio-border bg-studio-bg">
                  <span className="text-xs font-medium text-studio-title">Chat Grid</span>
                  <button
                    onClick={() => setChatCollapsed(true)}
                    className="p-1 hover:bg-studio-border rounded text-studio-muted hover:text-studio-text"
                    title="Collapse Chat Grid"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                    </svg>
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <ChatGridWorkspace variant="dock" loadSession={loadSession} />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Status Bar */}
      <footer className={`h-6 flex items-center px-4 text-xs text-studio-muted shrink-0 ${
        isMac 
          ? 'bg-[#2c2c2e] border-t border-[#3d3d3f]' 
          : 'bg-studio-surface border-t border-studio-border'
      }`}>
        <span>Ready</span>
        <span className="mx-4 text-studio-border">|</span>
        <span className="hover:text-studio-text cursor-pointer" onClick={() => setQuickActionsOpen(true)}>
          {isMac ? '⌘⇧P' : 'Ctrl+Shift+P'} Quick Actions
        </span>
        <span className="mx-4 text-studio-border">|</span>
        <span 
          className={`hover:text-studio-text cursor-pointer ${terminalOpen ? 'text-studio-accent' : ''}`}
          onClick={() => setTerminalOpen(!terminalOpen)}
        >
          Terminal ({isMac ? '⌘`' : 'Ctrl+`'})
        </span>
        <span className="ml-auto">ATLS v3.0.0</span>
      </footer>

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
}

export default App;
