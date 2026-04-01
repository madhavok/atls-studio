import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { chatDb } from './chatDb';

describe('chatDb', () => {
  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    await chatDb.close();
  });

  it('init returns true when invoke succeeds', async () => {
    invoke.mockResolvedValueOnce(undefined);
    const ok = await chatDb.init('/tmp/proj');
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('chat_db_init', { projectPath: '/tmp/proj' });
    expect(chatDb.isInitialized()).toBe(true);
    await chatDb.close();
  });

  it('init returns false when invoke fails', async () => {
    invoke.mockRejectedValueOnce(new Error('db fail'));
    const ok = await chatDb.init('/bad');
    expect(ok).toBe(false);
    expect(chatDb.isInitialized()).toBe(false);
  });

  it('createSession invokes backend with expected payload', async () => {
    invoke.mockResolvedValue(undefined);
    await chatDb.init('/p');
    const id = await chatDb.createSession('agent', 'Title', 'fixed-id');
    expect(id).toBe('fixed-id');
    expect(invoke).toHaveBeenCalledWith(
      'chat_db_create_session',
      expect.objectContaining({ id: 'fixed-id', title: 'Title', mode: 'agent', isSwarm: false }),
    );
    await chatDb.close();
  });
});
