import { describe, expect, it } from 'vitest';
import { useSwarmStore } from './swarmStore';

describe('swarmStore', () => {
  it('initializes idle with no session', () => {
    const s = useSwarmStore.getState();
    expect(s.status).toBe('idle');
    expect(s.sessionId).toBeNull();
    expect(s.isActive).toBe(false);
  });
});
