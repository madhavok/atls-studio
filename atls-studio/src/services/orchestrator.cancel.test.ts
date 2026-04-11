import { describe, expect, it, vi } from 'vitest';

const cancelSwarm = vi.fn();

vi.mock('../stores/swarmStore', () => ({
  useSwarmStore: { getState: () => ({ cancelSwarm }) },
}));

const { orchestrator } = await import('./orchestrator');

describe('OrchestratorService.cancel', () => {
  it('delegates graceful cancel to swarm store without local cleanup', () => {
    cancelSwarm.mockClear();
    orchestrator.cancel('graceful');
    expect(cancelSwarm).toHaveBeenCalledOnce();
    expect(cancelSwarm).toHaveBeenCalledWith('graceful');
  });

  it('immediate cancel forwards to swarm store and runs cleanup', () => {
    cancelSwarm.mockClear();
    orchestrator.cancel('immediate');
    expect(cancelSwarm).toHaveBeenCalledWith('immediate');
  });
});
