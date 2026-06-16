/** @vitest-environment happy-dom */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAppStore } from '../../stores/appStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { SWARM_ORCHESTRATION_TAB_ID } from '../../constants/swarmOrchestrationTab';
import { CodeViewer } from './index';

vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="m-editor" />,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

describe('CodeViewer orchestration surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSwarmStore.getState().resetSwarm();
    useAppStore.setState({
      openFiles: [],
      activeFile: null,
      chatMode: 'agent',
      designPreviewContent: '',
    });
  });

  it('no longer renders a dedicated orchestration cockpit editor tab', () => {
    // Orchestration is now rendered as canvas windows; the swarm tab id must not
    // produce a cockpit surface or a virtual editor tab in the code viewer.
    useAppStore.setState({
      openFiles: [SWARM_ORCHESTRATION_TAB_ID],
      activeFile: SWARM_ORCHESTRATION_TAB_ID,
    });
    useSwarmStore.setState({ isActive: true });

    render(<CodeViewer />);

    expect(screen.queryByTestId('m-cockpit')).toBeNull();
    expect(screen.queryByText('Orchestration Cockpit')).toBeNull();
    expect(screen.queryByTitle('Close Orchestration Cockpit')).toBeNull();
  });
});
