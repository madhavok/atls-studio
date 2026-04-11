/** @vitest-environment happy-dom */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../stores/contextStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useAppStore } from '../stores/appStore';
import { BlackboardSection } from './AtlsInternals/sections/BlackboardSection';
import { ContextMetricsSection } from './AtlsInternals/sections/ContextMetricsSection';
import { IndexDbSection } from './AtlsInternals/sections/IndexDbSection';
import { ReconcileFreshnessSection } from './AtlsInternals/sections/ReconcileFreshnessSection';
import { ToolTokenSection } from './AtlsInternals/sections/ToolTokenSection';
import { AtlsInternals } from './AtlsInternals/index';
import { FileIntelTab } from './AtlsPanel/FileIntelTab';
import { OverviewTab } from './AtlsPanel/OverviewTab';
import { PatternsTab } from './AtlsPanel/PatternsTab';
import { HealthTab } from './AtlsPanel/HealthTab';
import { IssuesTab } from './AtlsPanel/IssuesTab';
import { AtlsPanel } from './AtlsPanel/index';
import { AlertIcon as AtlsPanelAlertIcon } from './AtlsPanel/icons';
import { FolderIcon } from './FileExplorer/icons';
import { SwarmPanel } from './SwarmPanel/index';
import { SwarmErrorBoundary } from './SwarmPanel/SwarmErrorBoundary';
import { AgentTerminalView } from './Terminal/AgentTerminalView';
import { WindowControls } from './WindowControls/index';
import { ImageAttachment } from './ImageAttachment';
import { SignatureView } from './SignatureView';
import { ChatMessage } from './ChatMessage';
import { ToastContainer } from './Toast/index';
import { CloseIcon } from './icons';
import { QuickActions, type QuickAction } from './QuickActions/index';
import { SearchPanel } from './SearchPanel/index';
import { SessionPicker } from './SessionPicker/index';

vi.mock('../hooks/useAtls', () => ({
  useAtls: () => ({
    scanProject: vi.fn(),
    diagnoseSymbols: vi.fn(),
  }),
}));

vi.mock('../services/chatDb', () => ({
  chatDb: {
    init: vi.fn().mockResolvedValue(undefined),
    getSessions: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(async () => 'windows'),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

const invokeMock = vi.fn().mockResolvedValue({
  file_count: 1,
  symbol_count: 2,
  issue_count: 0,
  relation_count: 0,
  signature_count: 0,
  call_count: 0,
  last_indexed: null,
  db_size_bytes: 1024,
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function resetStores() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
  useSwarmStore.getState().resetSwarm();
  useAppStore.getState().clearWorkspace();
  useAppStore.setState({
    toasts: [],
    terminalOpen: false,
    terminalCollapsed: false,
    atlsPanelTab: 'issues',
    scanStatus: {
      isScanning: false,
      progress: 0,
      filesProcessed: 0,
      filesTotal: 0,
      phase: undefined,
    },
  });
}

describe('0% line coverage — DOM smokes', () => {
  beforeEach(() => {
    resetStores();
    invokeMock.mockClear();
  });

  it('BlackboardSection shows token budget', () => {
    render(<BlackboardSection />);
    expect(screen.getByText('Token Budget')).toBeTruthy();
  });

  it('ContextMetricsSection shows context budget', () => {
    render(<ContextMetricsSection />);
    expect(screen.getByText('Context Budget')).toBeTruthy();
  });

  it('IndexDbSection loads index stats on button click', async () => {
    render(<IndexDbSection />);
    fireEvent.click(screen.getByRole('button', { name: /load index stats/i }));
    expect(invokeMock).toHaveBeenCalledWith('atls_get_database_stats');
  });

  it('ReconcileFreshnessSection shows reconcile heading', () => {
    render(<ReconcileFreshnessSection />);
    expect(screen.getByText(/Last reconcile sweep/i)).toBeTruthy();
  });

  it('ToolTokenSection shows tool token grand stats', () => {
    render(<ToolTokenSection />);
    expect(screen.getByText('Tool Calls')).toBeTruthy();
  });

  it('FileIntelTab empty state without project', () => {
    render(<FileIntelTab />);
    expect(screen.getByText(/Open a project/i)).toBeTruthy();
  });

  it('OverviewTab prompts to open a project', () => {
    render(<OverviewTab />);
    expect(screen.getByText(/Open a project to view its profile/i)).toBeTruthy();
  });

  it('PatternsTab empty state without project', () => {
    render(<PatternsTab />);
    expect(screen.getByText(/Open a project/i)).toBeTruthy();
  });

  it('SwarmPanel renders when swarm is active', () => {
    useSwarmStore.setState({ isActive: true, status: 'idle' });
    render(<SwarmPanel />);
    expect(screen.getByText(/Swarm Orchestration/i)).toBeTruthy();
  });

  it('AgentTerminalView shows waiting empty state', () => {
    render(<AgentTerminalView terminalId="e2e-term" />);
    expect(screen.getByText(/Waiting for agent commands/i)).toBeTruthy();
  });

  it('WindowControls exposes minimize control on Windows', () => {
    render(<WindowControls />);
    expect(screen.getByRole('button', { name: /minimize/i })).toBeTruthy();
  });

  it('ImageAttachment renders from data URL', () => {
    render(
      <ImageAttachment
        attachment={{
          id: 'img-1',
          name: 'x.png',
          path: '/x.png',
          type: 'image',
          mediaType: 'image/png',
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }}
      />,
    );
    expect(screen.getByRole('img', { name: 'x.png' })).toBeTruthy();
  });

  it('SignatureView shows attachment name', () => {
    render(
      <SignatureView
        attachment={{
          id: 'f-1',
          name: 'sig.rs',
          path: '/p/sig.rs',
          type: 'file',
          content: 'fn main() {}',
          metadata: { language: 'rust', source_lines: 1 },
        }}
      />,
    );
    expect(screen.getByText('sig.rs')).toBeTruthy();
  });

  it('ToastContainer renders queued toasts', () => {
    useAppStore.setState({
      toasts: [{ id: 't1', type: 'info', message: 'hello-toast', duration: 0 }],
    });
    render(<ToastContainer />);
    expect(screen.getByText('hello-toast')).toBeTruthy();
  });

  it('SwarmErrorBoundary shows fallback when child throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom(): null {
      throw new Error('smoke-error');
    }
    render(
      <SwarmErrorBoundary>
        <Boom />
      </SwarmErrorBoundary>,
    );
    expect(screen.getByText('Swarm panel crashed')).toBeTruthy();
    expect(screen.getByText(/smoke-error/)).toBeTruthy();
    err.mockRestore();
  });

  it('SwarmErrorBoundary renders children when healthy', () => {
    render(
      <SwarmErrorBoundary>
        <span>swarm-ok</span>
      </SwarmErrorBoundary>,
    );
    expect(screen.getByText('swarm-ok')).toBeTruthy();
  });

  it('AtlsInternals shows diagnostics shell', () => {
    render(<AtlsInternals />);
    expect(screen.getByText('ATLS Internals')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Expand All/i })).toBeTruthy();
  });

  it('ChatMessage renders markdown body', () => {
    render(
      <ChatMessage
        message={{
          id: 'm1',
          role: 'user',
          content: 'Hello **world**',
          timestamp: new Date(),
        }}
      />,
    );
    expect(screen.getByText('world')).toBeTruthy();
  });

  it('shared CloseIcon renders', () => {
    render(<CloseIcon />);
    expect(document.querySelector('svg')).toBeTruthy();
  });

  it('AtlsPanelAlertIcon renders', () => {
    render(<AtlsPanelAlertIcon severity="high" />);
    expect(document.querySelector('svg')).toBeTruthy();
  });

  it('FileExplorer FolderIcon renders', () => {
    render(<FolderIcon open={false} />);
    expect(document.querySelector('svg')).toBeTruthy();
  });

  it('HealthTab empty state without project', () => {
    render(<HealthTab />);
    expect(screen.getByText(/Open a project to view language health/i)).toBeTruthy();
  });

  it('IssuesTab empty state without project', () => {
    render(<IssuesTab />);
    expect(screen.getByText('Open a project')).toBeTruthy();
  });

  it('AtlsPanel shows intelligence header', () => {
    render(<AtlsPanel />);
    expect(screen.getByText('ATLS Intelligence')).toBeTruthy();
  });

  it('QuickActions lists actions when open', () => {
    const actions: QuickAction[] = [
      { id: 'a1', label: 'Do thing', category: 'file', action: vi.fn() },
    ];
    render(<QuickActions isOpen onClose={vi.fn()} actions={actions} />);
    expect(screen.getByText('Do thing')).toBeTruthy();
  });

  it('SearchPanel shows query input when open', () => {
    render(<SearchPanel isOpen onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText(/search/i)).toBeTruthy();
  });

  it('SessionPicker welcome state', async () => {
    render(
      <SessionPicker
        isOpen
        projectPath="C:\\demo\\proj"
        onNewSession={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Welcome Back')).toBeTruthy();
    });
    expect(screen.getByText('No previous conversations')).toBeTruthy();
  });
});
