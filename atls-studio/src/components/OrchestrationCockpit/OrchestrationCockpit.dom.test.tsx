/** @vitest-environment happy-dom */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../stores/appStore';
import { useOrchestrationUiStore } from '../../stores/orchestrationUiStore';
import { useSwarmStore, type SwarmTask } from '../../stores/swarmStore';
import { SWARM_ORCHESTRATION_TAB_ID } from '../../constants/swarmOrchestrationTab';
import { orchestrator } from '../../services/orchestrator';
import { OrchestrationCockpit } from './index';

vi.mock('../../services/orchestrator', () => ({
  orchestrator: { resumeAfterApproval: vi.fn() },
}));

vi.mock('../../services/aiService', () => ({
  getProviderFromModel: () => 'anthropic',
}));

vi.mock('../Terminal/AgentTerminalView', () => ({
  AgentTerminalView: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="agent-terminal-view">{terminalId}</div>
  ),
}));

function task(overrides: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id: 'task-1',
    title: 'Implement cockpit shell',
    description: 'Create first-class agent windows and mission control.',
    status: 'running',
    assignedModel: 'claude-sonnet-4-5',
    assignedProvider: 'anthropic',
    assignedRole: 'coder',
    contextHashes: [],
    fileClaims: ['src/App.tsx'],
    contextFiles: [],
    dependencies: [],
    tokensUsed: 12345,
    costCents: 42,
    retryCount: 0,
    maxRetries: 10,
    conversationLog: [{
      id: 'msg-1',
      role: 'assistant',
      content: 'Working on the cockpit layout.',
      timestamp: new Date(),
    }],
    ...overrides,
  };
}

describe('OrchestrationCockpit', () => {
  beforeEach(() => {
    localStorage.clear();
    useOrchestrationUiStore.getState().resetLayout();
    useSwarmStore.getState().resetSwarm();
    useAppStore.setState({
      projectPath: '/tmp/project',
      settings: { ...useAppStore.getState().settings, selectedModel: 'claude-sonnet-4-5', selectedProvider: 'anthropic' },
    });
  });

  it('renders mission, agent windows, and runtime panels', () => {
    useSwarmStore.setState({
      isActive: true,
      status: 'running',
      userRequest: 'Build a multi-agent cockpit',
      sessionId: 'session-1',
      tasks: [task()],
      stats: {
        ...useSwarmStore.getState().stats,
        totalTasks: 1,
        runningTasks: 1,
        totalTokensUsed: 12345,
        totalCostCents: 42,
        elapsedMs: 2500,
      },
    });

    render(<OrchestrationCockpit />);

    expect(screen.getByTestId('orchestration-cockpit')).toBeTruthy();
    expect(screen.getByText('Mission Control')).toBeTruthy();
    expect(screen.getAllByText('Implement cockpit shell').length).toBeGreaterThan(0);
    expect(screen.getByText('Runtime Context')).toBeTruthy();
    expect(screen.getByText('Telemetry')).toBeTruthy();
  });

  it('selects an agent task from its window', () => {
    useSwarmStore.setState({
      isActive: true,
      status: 'running',
      tasks: [task()],
      stats: { ...useSwarmStore.getState().stats, totalTasks: 1, runningTasks: 1 },
    });

    render(<OrchestrationCockpit />);
    fireEvent.click(screen.getByTestId('agent-window-task-1'));

    expect(useOrchestrationUiStore.getState().selectedTaskId).toBe('task-1');
  });

  it('closes workbench files without closing the cockpit tab', () => {
    useAppStore.setState({
      openFiles: [SWARM_ORCHESTRATION_TAB_ID, 'src/App.tsx'],
      activeFile: SWARM_ORCHESTRATION_TAB_ID,
    });

    render(<OrchestrationCockpit />);
    fireEvent.click(screen.getByTitle('Close src/App.tsx'));

    expect(useAppStore.getState().openFiles).toEqual([SWARM_ORCHESTRATION_TAB_ID]);
  });

  it('requeues failed tasks and resumes swarm dispatch', async () => {
    useSwarmStore.setState({
      isActive: true,
      status: 'failed',
      sessionId: 'session-1',
      plan: 'Retry failed task',
      tasks: [task({ status: 'failed', error: 'Tool call failed' })],
      stats: { ...useSwarmStore.getState().stats, totalTasks: 1 },
    });

    render(<OrchestrationCockpit />);
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(orchestrator.resumeAfterApproval).toHaveBeenCalled();
    });
    expect(useSwarmStore.getState().tasks[0].status).toBe('pending');
  });
});
