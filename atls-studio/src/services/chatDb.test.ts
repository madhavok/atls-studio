import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../stores/appStore';

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

  it('saveFullSession calls chat_db_add_message once per id when duplicate ids are present', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_db_get_messages') return [];
      if (cmd === 'chat_db_get_blackboard_entries') return [];
      return undefined;
    });
    await chatDb.init('/proj');
    const dupId = 'duplicate-message-id';
    const messages: Message[] = [
      { id: dupId, role: 'user', content: 'first', timestamp: new Date() },
      { id: dupId, role: 'user', content: 'last', timestamp: new Date() },
    ];
    await chatDb.saveFullSession('session-1', messages, [], undefined);

    const addCalls = invoke.mock.calls.filter((c) => c[0] === 'chat_db_add_message');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0][1]).toMatchObject({ id: dupId, sessionId: 'session-1', content: 'last' });

    await chatDb.close();
  });
});
