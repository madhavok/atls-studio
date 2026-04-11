import { describe, it, expect, vi } from 'vitest';

const cancelSwarm = vi.fn();

vi.mock('../stores/swarmStore', () => ({
  useSwarmStore: { getState: () => ({ cancelSwarm }) },
}));

const { orchestrator } = await import('./orchestrator');

describe('orchestrator', () => {
  it('cancel forwards to swarm store (immediate)', () => {
    cancelSwarm.mockClear();
    orchestrator.cancel('immediate');
    expect(cancelSwarm).toHaveBeenCalledWith('immediate');
  });

  it('cancel forwards to swarm store (graceful)', () => {
    cancelSwarm.mockClear();
    orchestrator.cancel('graceful');
    expect(cancelSwarm).toHaveBeenCalledWith('graceful');
  });
});
