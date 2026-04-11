/** @vitest-environment happy-dom */
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../stores/contextStore';
import { useSwarmStore } from '../stores/swarmStore';
import { BlackboardSection } from './AtlsInternals/sections/BlackboardSection';
import { ContextMetricsSection } from './AtlsInternals/sections/ContextMetricsSection';
import { IndexDbSection } from './AtlsInternals/sections/IndexDbSection';
import { ReconcileFreshnessSection } from './AtlsInternals/sections/ReconcileFreshnessSection';
import { ToolTokenSection } from './AtlsInternals/sections/ToolTokenSection';
import { FileIntelTab } from './AtlsPanel/FileIntelTab';
import { OverviewTab } from './AtlsPanel/OverviewTab';
import { PatternsTab } from './AtlsPanel/PatternsTab';
import { SwarmPanel } from './SwarmPanel/index';
import { AgentTerminalView } from './Terminal/AgentTerminalView';
import { WindowControls } from './WindowControls/index';

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
});
