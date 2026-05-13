/** @vitest-environment happy-dom */
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('../OrchestrationCockpit', () => ({
  OrchestrationCockpit: () => <div data-testid="m-cockpit" />,
}));

vi.mock('../SwarmPanel/SwarmErrorBoundary', () => ({
  SwarmErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('CodeViewer cockpit tab', () => {
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

  it('renders the cockpit as a closable virtual tab while swarm is active', () => {
    useAppStore.setState({
      openFiles: [SWARM_ORCHESTRATION_TAB_ID],
      activeFile: SWARM_ORCHESTRATION_TAB_ID,
    });
    useSwarmStore.setState({ isActive: true });

    render(<CodeViewer />);

    expect(screen.getByTestId('m-cockpit')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Close Orchestration Cockpit'));

    expect(useAppStore.getState().openFiles).not.toContain(SWARM_ORCHESTRATION_TAB_ID);
    expect(useAppStore.getState().activeFile).toBeNull();
  });
});
