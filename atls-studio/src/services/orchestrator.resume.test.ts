import { describe, expect, it, beforeEach } from 'vitest';
import { orchestrator } from './orchestrator';
import { useSwarmStore } from '../stores/swarmStore';

describe('orchestrator resumeAfterApproval', () => {
  beforeEach(() => {
    useSwarmStore.getState().resetSwarm();
  });

  it('throws when swarm has no plan', async () => {
    await expect(
      orchestrator.resumeAfterApproval('sid', '/proj', {
        model: 'm',
        provider: 'anthropic',
        maxConcurrentAgents: 2,
        autoApprove: true,
      }),
    ).rejects.toThrow(/no plan/i);
  });
});
