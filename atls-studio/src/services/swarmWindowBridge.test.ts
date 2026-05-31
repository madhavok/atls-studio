/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canRecoverSwarmTask, canStopSwarmTask } from './swarmWindowBridge';
import { useSwarmStore } from '../stores/swarmStore';

vi.mock('./orchestrator', () => ({
  orchestrator: { resumeAfterApproval: vi.fn().mockResolvedValue(undefined) },
}));

describe('swarmWindowBridge', () => {
  beforeEach(() => {
    useSwarmStore.setState({
      tasks: [{
        id: 'task-1',
        title: 'Task',
        description: 'desc',
        status: 'failed',
        assignedModel: 'claude-sonnet-4-5',
        assignedProvider: 'anthropic',
        assignedRole: 'coder',
        contextHashes: [],
        fileClaims: [],
        contextFiles: [],
        dependencies: [],
        tokensUsed: 0,
        costCents: 0,
        retryCount: 0,
        maxRetries: 3,
        conversationLog: [],
      }],
    });
  });

  it('canRecoverSwarmTask accepts failed/cancelled/awaiting_input', () => {
    const task = useSwarmStore.getState().tasks[0];
    expect(canRecoverSwarmTask(task)).toBe(true);
    expect(canRecoverSwarmTask({ ...task, status: 'running' })).toBe(false);
  });

  it('canStopSwarmTask accepts running/pending', () => {
    const task = useSwarmStore.getState().tasks[0];
    expect(canStopSwarmTask({ ...task, status: 'running' })).toBe(true);
    expect(canStopSwarmTask(task)).toBe(false);
  });
});
