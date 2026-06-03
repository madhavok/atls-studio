/** @vitest-environment happy-dom */
/**
 * App shell integration: real ChatGridWorkspace (not the App.dom stub).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentWindowStore } from './stores/agentWindowStore';
import { useAgentRuntimeStore } from './stores/agentRuntimeStore';
import { useAppStore } from './stores/appStore';
import { useCostStore } from './stores/costStore';
import { useSwarmStore } from './stores/swarmStore';

const os = vi.hoisted(() => ({
  isMac: false,
  isWindows: true,
  isLinux: false,
}));

const tauriListen = vi.hoisted(() => ({
  ref: { menuCb: null as ((e: { payload: string }) => void) | null },
  listen: vi.fn((_e: string, cb: (e: { payload: string }) => void) => {
    tauriListen.ref.menuCb = cb;
    return Promise.resolve(vi.fn());
  }),
}));

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

const chatDbMock = vi.hoisted(() => ({
  initialized: false,
  loadFullSession: vi.fn(async () => null),
  getSessions: vi.fn(async () => []),
}));

const fetchModelsMock = vi.hoisted(() => vi.fn(async () => [{
  id: 'claude-sonnet-4-5',
  name: 'Claude Sonnet 4.5',
  provider: 'anthropic',
  contextWindow: 200000,
  isReasoning: true,
}]));

vi.mock('./hooks/useOS', () => ({ useOS: () => os }));
vi.mock('./hooks/useAtls', () => ({ useAtls: () => atlsM }));
vi.mock('./hooks/useChatPersistence', () => ({
  useChatPersistence: () => ({
    loadSession: vi.fn(async () => true),
    createNewSession: vi.fn(async () => 'session-new'),
    deleteSession: vi.fn(async () => undefined),
  }),
}));
vi.mock('./hooks/usePanelResize', () => ({
  usePanelResize: () => ({
    handleLeftResize: vi.fn(),
    handleRightResize: vi.fn(),
    handleBottomResize: vi.fn(),
    isResizing: false,
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriListen.listen }));
vi.mock('./services/aiService', () => ({
  fetchModels: fetchModelsMock,
  resetStaticPromptCache: vi.fn(),
  streamChat: vi.fn(),
}));
vi.mock('./services/activateAgentWindow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/activateAgentWindow')>();
  return { ...actual, activateAgentWindow: vi.fn(async () => undefined) };
});
vi.mock('./services/agentShellSync', () => ({
  syncShellToProjectPath: vi.fn(async () => undefined),
}));
vi.mock('./services/chatDb', () => ({
  chatDb: {
    isInitialized: () => chatDbMock.initialized,
    loadFullSession: chatDbMock.loadFullSession,
    getSessions: chatDbMock.getSessions,
    createSession: vi.fn(),
    addMessage: vi.fn(),
    updateSessionTitle: vi.fn(),
  },
}));
vi.mock('./components/FileExplorer', () => ({ FileExplorer: () => <div data-testid="m-fe" /> }));
vi.mock('./components/CodeViewer', () => ({ CodeViewer: () => <div data-testid="m-cv" /> }));
vi.mock('./components/AtlsPanel', () => ({ AtlsPanel: () => <div data-testid="m-atls" /> }));
vi.mock('./components/AiChat', () => ({ AiChat: () => <div data-testid="m-aichat" /> }));
vi.mock('./components/Settings', () => ({
  Settings: (p: { isOpen: boolean }) => (p.isOpen ? <div data-testid="m-settings" /> : null),
}));
vi.mock('./components/QuickActions', () => ({
  QuickActions: (p: { isOpen: boolean }) => (p.isOpen ? <div data-testid={`m-qa-${p.mode ?? 'actions'}`} /> : null),
}));
vi.mock('./components/SearchPanel', () => ({
  SearchPanel: (p: { isOpen: boolean }) => (p.isOpen ? <div data-testid="m-search" /> : null),
}));
vi.mock('./components/MenuBar', () => ({
  MenuBar: (p: { onNewChat: () => void }) => (
    <button type="button" data-testid="mb-newchat" onClick={p.onNewChat}>newchat</button>
  ),
}));
vi.mock('./components/WindowControls', () => ({ WindowControls: () => <div data-testid="m-wc" /> }));
vi.mock('./components/SessionPicker', () => ({ SessionPicker: () => null }));
vi.mock('./components/SwarmPanel', () => ({ SwarmPanel: () => <div data-testid="m-swarm" /> }));
vi.mock('./components/SwarmPanel/SwarmErrorBoundary', () => ({
  SwarmErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/Toast', () => ({ ToastContainer: () => <div data-testid="m-toast" /> }));

import App from './App';

function resetStores() {
  useSwarmStore.getState().resetSwarm();
  useCostStore.getState().resetChat();
  useAppStore.getState().clearWorkspace();
  useAgentWindowStore.getState().reset();
  useAgentRuntimeStore.getState().reset();
  useAppStore.setState({
    projectPath: '/tmp/project',
    currentSessionId: 'session-1',
    chatMode: 'agent',
    chatWorkspaceLayout: 'grid',
    activeFile: null,
    openFiles: [],
    chatSessions: [{
      id: 'session-1',
      title: 'Primary Chat',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
    }],
    availableModels: [{
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      provider: 'anthropic',
      contextWindow: 200000,
      isReasoning: true,
    }],
    settings: {
      ...useAppStore.getState().settings,
      selectedModel: 'claude-sonnet-4-5',
      selectedProvider: 'anthropic',
      anthropicApiKey: 'test-key',
    },
  });
  useAgentWindowStore.getState().hydrateProject('/tmp/project');
  useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Primary Chat');
  useAgentRuntimeStore.getState().ensureRuntime({
    windowId: 'primary-session-1',
    sessionId: 'session-1',
    parentSessionId: 'session-1',
  });
}

describe('App grid shell integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('mounts the real ChatGridWorkspace primary surface', () => {
    render(<App />);
    expect(screen.getByTestId('app-root')).toBeTruthy();
    expect(screen.getByTestId('chat-grid-primary')).toBeTruthy();
    expect(screen.getByTestId('primary-chat-window')).toBeTruthy();
    expect(screen.queryByTestId('m-chat-grid-primary')).toBeNull();
    expect(screen.queryByTestId('m-aichat')).toBeNull();
  });

  it('binds Ctrl+N to new chat handler', async () => {
    render(<App />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    });
    expect(screen.getByTestId('chat-grid-primary')).toBeTruthy();
  });
});
