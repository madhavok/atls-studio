/** @vitest-environment happy-dom */
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './stores/appStore';
import { useSwarmStore } from './stores/swarmStore';
import { useCostStore } from './stores/costStore';

const os = vi.hoisted(() => ({
  isMac: false,
  isWindows: true,
  isLinux: false,
}));

const tauriListen = vi.hoisted(() => {
  const ref: { menuCb: ((e: { payload: string }) => void) | null } = { menuCb: null };
  return {
    ref,
    listen: vi.fn((_e: string, cb: (e: { payload: string }) => void) => {
      ref.menuCb = cb;
      return Promise.resolve(vi.fn());
    }),
  };
});

const atlsM = vi.hoisted(() => ({
  newProject: vi.fn(),
  openProjectWithPicker: vi.fn(),
  loadFileTree: vi.fn(),
  scanProject: vi.fn(),
  refreshIssues: vi.fn(),
  addFolderToWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
  closeWorkspace: vi.fn(),
}));

const chatPers = vi.hoisted(() => ({
  loadSession: vi.fn(),
  createNewSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn(),
}));

vi.mock('./hooks/useOS', () => ({ useOS: () => os }));
vi.mock('./hooks/useAtls', () => ({ useAtls: () => atlsM }));
vi.mock('./hooks/useChatPersistence', () => ({ useChatPersistence: () => chatPers }));
vi.mock('./hooks/usePanelResize', () => ({
  usePanelResize: () => ({
    handleLeftResize: vi.fn(),
    handleRightResize: vi.fn(),
    handleBottomResize: vi.fn(),
    isResizing: false,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriListen.listen,
}));

vi.mock('./services/aiService', async (importOriginal) => {
  const a = await importOriginal<typeof import('./services/aiService')>();
  return { ...a, resetStaticPromptCache: vi.fn() };
});

vi.mock('./components/FileExplorer', () => ({ FileExplorer: () => <div data-testid="m-fe" /> }));
vi.mock('./components/CodeViewer', async () => {
  const { useAppStore } = await import('./stores/appStore');
  const { SWARM_ORCHESTRATION_TAB_ID } = await import('./constants/swarmOrchestrationTab');
  return {
    CodeViewer: () => {
      const activeFile = useAppStore((s) => s.activeFile);
      const openFiles = useAppStore((s) => s.openFiles);
      const chatMode = useAppStore((s) => s.chatMode);
      const designPreviewContent = useAppStore((s) => s.designPreviewContent);
      const hasDesignPreview = chatMode === 'designer' && designPreviewContent.length > 0;
      if (openFiles.length === 0 && !hasDesignPreview) {
        return <div data-testid="m-cv" />;
      }
      return (
        <div data-testid="m-cv">
          {activeFile === SWARM_ORCHESTRATION_TAB_ID ? <div data-testid="m-swarm" /> : null}
        </div>
      );
    },
  };
});
vi.mock('./components/AtlsPanel', () => ({ AtlsPanel: () => <div data-testid="m-atls" /> }));
vi.mock('./components/AiChat', () => ({ AiChat: () => <div data-testid="m-aichat" /> }));
vi.mock('./components/Settings', () => ({
  Settings: (p: { isOpen: boolean }) => (p.isOpen ? <div data-testid="m-settings" /> : null),
}));
vi.mock('./components/QuickActions', () => ({
  QuickActions: (p: { isOpen: boolean; mode: string }) =>
    p.isOpen ? <div data-testid={`m-qa-${p.mode}`} /> : null,
}));
vi.mock('./components/SearchPanel', () => ({
  SearchPanel: (p: { isOpen: boolean }) => (p.isOpen ? <div data-testid="m-search" /> : null),
}));
vi.mock('./components/MenuBar', () => ({
  MenuBar: (p: { onNewChat: () => void; onAddFolder?: () => void; onSaveWorkspace?: () => void; onOpenWorkspace: () => void; onCloseWorkspace?: () => void }) => (
    <div>
      <button type="button" data-testid="mb-newchat" onClick={p.onNewChat}>
        newchat
      </button>
    </div>
  ),
}));
vi.mock('./components/WindowControls', () => ({ WindowControls: () => <div data-testid="m-wc" /> }));
vi.mock('./components/SessionPicker', () => ({
  SessionPicker: (p: {
    isOpen: boolean;
    onNewSession: () => Promise<void>;
    onLoadSession: (id: string) => Promise<void>;
    onClose: () => void;
  }) =>
    p.isOpen ? (
      <div data-testid="m-sess">
        <button
          type="button"
          data-testid="sess-new"
          onClick={() => {
            void p.onNewSession();
          }}
        >
          new
        </button>
        <button type="button" data-testid="sess-close" onClick={p.onClose}>
          c
        </button>
        <button
          type="button"
          data-testid="sess-load"
          onClick={() => {
            void p.onLoadSession('s1');
          }}
        >
          load
        </button>
      </div>
    ) : null,
}));
vi.mock('./components/SwarmPanel', () => ({ SwarmPanel: () => <div data-testid="m-swarm" /> }));
vi.mock('./components/SwarmPanel/SwarmErrorBoundary', () => ({
  SwarmErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/Toast', () => ({ ToastContainer: () => <div data-testid="m-toast" /> }));

import { resetStaticPromptCache } from './services/aiService';
import { SWARM_ORCHESTRATION_TAB_ID } from './constants/swarmOrchestrationTab';
import App from './App';

function resetAppStores() {
  useSwarmStore.getState().resetSwarm();
  useCostStore.getState().resetChat();
  useAppStore.getState().clearWorkspace();
  useAppStore.setState({
    toasts: [],
    explorerCollapsed: false,
    terminalCollapsed: false,
    quickActionsOpen: false,
    quickFindOpen: false,
    searchPanelOpen: false,
    terminalOpen: false,
    projectPath: null,
    activeRoot: null,
    files: [],
    activeFile: null,
    chatMode: 'agent',
  });
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings, theme: 'dark' },
  });
}

describe('App shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriListen.ref.menuCb = null;
    Object.assign(os, { isMac: false, isWindows: true, isLinux: false });
    resetAppStores();
  });

  it('renders app-root and main layout on Windows', () => {
    render(<App />);
    expect(screen.getByTestId('app-root')).toBeTruthy();
    expect(screen.getByTestId('main-layout')).toBeTruthy();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applies project title segment when projectPath is set', () => {
    useAppStore.setState({ projectPath: 'C:\\work\\myproj' });
    render(<App />);
    expect(screen.getByText('myproj')).toBeTruthy();
  });

  it('loadFileTree when projectPath is set', () => {
    useAppStore.setState({ projectPath: '/tmp/p' });
    render(<App />);
    expect(atlsM.loadFileTree).toHaveBeenCalledWith('/tmp/p');
  });

  it('keyboard: Ctrl+Shift+P opens quick actions', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().quickActionsOpen).toBe(true);
  });

  it('keyboard: Ctrl+, opens settings', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(screen.getByTestId('m-settings')).toBeTruthy();
  });

  it('keyboard: Ctrl+O calls openProjectWithPicker', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'o', keyCode: 79, ctrlKey: true });
    expect(atlsM.openProjectWithPicker).toHaveBeenCalled();
  });

  it('prevents ctrl+wheel zoom on document', () => {
    const add = vi.spyOn(document, 'addEventListener');
    render(<App />);
    const wheel = add.mock.calls.find((c) => c[0] === 'wheel')?.[1] as (e: WheelEvent) => void;
    expect(wheel).toBeTypeOf('function');
    const ev = { ctrlKey: true, preventDefault: vi.fn() } as unknown as WheelEvent;
    wheel(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    add.mockRestore();
  });

  it('toggles session picker from new chat in menu (Windows)', () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('mb-newchat'));
    expect(screen.getByTestId('m-sess')).toBeTruthy();
  });

  it('completes new session from SessionPicker and resets', async () => {
    const resetChatSpy = vi.spyOn(useCostStore.getState(), 'resetChat');
    render(<App />);
    fireEvent.click(screen.getByTestId('mb-newchat'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('sess-new'));
    });
    expect(chatPers.createNewSession).toHaveBeenCalled();
    expect(useAppStore.getState().messages).toEqual([]);
    expect(resetChatSpy).toHaveBeenCalled();
    expect(resetStaticPromptCache).toHaveBeenCalled();
  });

  it('loads swarm panel when chatMode swarm and swarm active', () => {
    useAppStore.setState({
      chatMode: 'swarm',
      openFiles: [SWARM_ORCHESTRATION_TAB_ID],
      activeFile: SWARM_ORCHESTRATION_TAB_ID,
    });
    useSwarmStore.setState({ isActive: true });
    render(<App />);
    expect(screen.getByTestId('m-swarm')).toBeTruthy();
  });

  it('uses mac top layout and menu-event listener', async () => {
    Object.assign(os, { isMac: true, isWindows: false, isLinux: false });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<App />);
    await waitFor(() => {
      expect(tauriListen.ref.menuCb).toBeTypeOf('function');
    });
    await act(async () => {
      tauriListen.ref.menuCb!({ payload: 'settings' });
    });
    expect(screen.getByTestId('m-settings')).toBeTruthy();

    await act(async () => {
      tauriListen.ref.menuCb!({ payload: 'documentation' });
    });
    expect(open).toHaveBeenCalled();
    open.mockRestore();

    await act(async () => {
      tauriListen.ref.menuCb!({ payload: 'atls-internals' });
    });
    expect(useAppStore.getState().openFile).toBeDefined();
  });

  it('status bar quick actions and terminal toggle', () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Quick Actions/i).closest('span')!);
    expect(useAppStore.getState().quickActionsOpen).toBe(true);
    fireEvent.click(screen.getByText(/Terminal/i).closest('span')!);
    expect(useAppStore.getState().terminalOpen).toBe(true);
  });

  it('shows chat collapse when swarm+swarm mode', () => {
    useAppStore.setState({ chatMode: 'swarm' });
    useSwarmStore.setState({ isActive: true });
    render(<App />);
    const collapse = screen.getByTitle('Collapse Chat');
    fireEvent.click(collapse);
    const expand = screen.getByTitle('Expand Chat');
    fireEvent.click(expand);
  });
});
