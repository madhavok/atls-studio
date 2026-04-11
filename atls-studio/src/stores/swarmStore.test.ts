import { describe, expect, it } from 'vitest';
import { useSwarmStore } from './swarmStore';

describe('swarmStore', () => {
  it('initializes idle with no session', () => {
    const s = useSwarmStore.getState();
    expect(s.status).toBe('idle');
    expect(s.sessionId).toBeNull();
    expect(s.isActive).toBe(false);
  });

  it('startSwarm activates researching session', () => {
    useSwarmStore.getState().resetSwarm();
    useSwarmStore.getState().startSwarm('sess-a', 'ship widgets');
    const s = useSwarmStore.getState();
    expect(s.isActive).toBe(true);
    expect(s.sessionId).toBe('sess-a');
    expect(s.status).toBe('researching');
    expect(s.userRequest).toBe('ship widgets');
  });

  it('resetSwarm returns to idle', () => {
    useSwarmStore.getState().startSwarm('s', 'x');
    useSwarmStore.getState().resetSwarm();
    expect(useSwarmStore.getState().isActive).toBe(false);
    expect(useSwarmStore.getState().sessionId).toBeNull();
  });
});
