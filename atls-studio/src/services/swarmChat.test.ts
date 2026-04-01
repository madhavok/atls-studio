import { describe, it, expect } from 'vitest';

describe('swarmChat', () => {
  it('exports streamChatForSwarm', async () => {
    const mod = await import('./swarmChat');
    expect(typeof mod.streamChatForSwarm).toBe('function');
  });
});
