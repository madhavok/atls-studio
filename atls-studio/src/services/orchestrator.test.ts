import { describe, it, expect, vi } from 'vitest';

const cancelSwarm = vi.fn();

vi.mock('../stores/swarmStore', () => ({
  useSwarmStore: { getState: () => ({ cancelSwarm }) },
}));

const { orchestrator } = await import('./orchestrator');

describe('orchestrator', () => {
  it('cancel forwards to swarm store', () => {
    cancelSwarm.mockClear();
    orchestrator.cancel('immediate');
    expect(cancelSwarm).toHaveBeenCalledWith('immediate');
  });
});
