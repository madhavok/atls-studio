import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../stores/appStore';
import type { ContextChunk } from '../stores/contextStore';

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

  it('addSegments JSON includes __syntheticChildren, __thoughtSignature, __toolCallId, and spread args', async () => {
    invoke.mockResolvedValue(undefined);
    await chatDb.init('/proj');
    await chatDb.addSegments('mid', [
      {
        type: 'tool',
        toolCall: {
          id: 'tc-1',
          name: 'read_file',
          args: { path: 'a.ts' },
          result: 'ok',
          status: 'completed',
          thoughtSignature: 'sig9',
          syntheticChildren: [{ id: 'c1', name: 'child', args: { x: 1 }, result: 'r', status: 'completed' }],
        },
      },
    ]);
    const segCall = invoke.mock.calls.find((c) => c[0] === 'chat_db_add_segments');
    expect(segCall).toBeDefined();
    const rows = (segCall![1] as { segments: { tool_args: string }[] }).segments;
    const parsed = JSON.parse(rows[0].tool_args);
    expect(parsed.__toolCallId).toBe('tc-1');
    expect(parsed.__thoughtSignature).toBe('sig9');
    expect(parsed.__toolCallStatus).toBe('completed');
    expect(parsed.__syntheticChildren).toHaveLength(1);
    expect(parsed.__syntheticChildren[0].id).toBe('c1');
    expect(parsed.path).toBe('a.ts');
    await chatDb.close();
  });

  it('replaceSegments uses the same tool_args shape as addSegments', async () => {
    invoke.mockResolvedValue(undefined);
    await chatDb.init('/proj');
    await chatDb.replaceSegments('mid2', [
      { type: 'tool', toolCall: { id: 'x', name: 'n', status: 'running', args: { q: 1 } } },
    ]);
    const segCall = invoke.mock.calls.find((c) => c[0] === 'chat_db_replace_segments');
    expect(segCall).toBeDefined();
    const parsed = JSON.parse((segCall![1] as { segments: { tool_args: string }[] }).segments[0].tool_args);
    expect(parsed.__toolCallId).toBe('x');
    expect(parsed.q).toBe(1);
    expect(parsed.__toolCallStatus).toBe('running');
    await chatDb.close();
  });

  it('saveFullSession calls replaceSegments when content unchanged but parts include tools', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_db_get_messages') {
        return [{
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          content: 'same',
          timestamp: '2020-01-01T00:00:00Z',
        }];
      }
      if (cmd === 'chat_db_get_blackboard_entries') return [];
      return undefined;
    });
    await chatDb.init('/proj');
    const messages: Message[] = [{
      id: 'm1',
      role: 'assistant',
      content: 'same',
      timestamp: new Date(),
      parts: [{ type: 'tool', toolCall: { id: 't1', name: 'grep', status: 'completed' } }],
    }];
    await chatDb.saveFullSession('s1', messages, []);

    expect(invoke.mock.calls.some((c) => c[0] === 'chat_db_update_message_content')).toBe(false);
    const rep = invoke.mock.calls.filter((c) => c[0] === 'chat_db_replace_segments');
    expect(rep).toHaveLength(1);
    expect((rep[0][1] as { segments: unknown[] }).segments).toHaveLength(1);
    await chatDb.close();
  });

  it('saveFullSession deletes segments when content changes and new message has no segments', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_db_get_messages') {
        return [{
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          content: 'old-body',
          timestamp: '2020-01-01T00:00:00Z',
        }];
      }
      if (cmd === 'chat_db_get_blackboard_entries') return [];
      if (cmd === 'chat_db_get_segments') {
        return [{ id: 1, message_id: 'm1', seq: 0, type: 'text', content: 'seg', tool_name: undefined, tool_args: undefined, tool_result: undefined }];
      }
      return undefined;
    });
    await chatDb.init('/proj');
    // Empty content and no parts → no segments to save; triggers delete when content changed.
    await chatDb.saveFullSession('s1', [{
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    }], []);

    expect(invoke.mock.calls.some((c) => c[0] === 'chat_db_update_message_content')).toBe(true);
    expect(invoke.mock.calls.some((c) => c[0] === 'chat_db_delete_segments')).toBe(true);
    expect(invoke.mock.calls.some((c) => c[0] === 'chat_db_replace_segments')).toBe(false);
    await chatDb.close();
  });

  it('setSessionStateBatch invokes chat_db_set_session_state_batch with entry pairs', async () => {
    invoke.mockResolvedValue(undefined);
    await chatDb.init('/proj');
    await chatDb.setSessionStateBatch('s1', { hash_stack: '[]', edit_hash_stack: '[1]' });
    expect(invoke).toHaveBeenCalledWith(
      'chat_db_set_session_state_batch',
      expect.objectContaining({
        sessionId: 's1',
        entries: expect.arrayContaining([['hash_stack', '[]'], ['edit_hash_stack', '[1]']]),
      }),
    );
    await chatDb.close();
  });

  it('setSessionStateBatch is a no-op when entries empty', async () => {
    invoke.mockResolvedValue(undefined);
    await chatDb.init('/proj');
    const n = invoke.mock.calls.length;
    await chatDb.setSessionStateBatch('s1', {});
    expect(invoke.mock.calls.length).toBe(n);
    await chatDb.close();
  });

  it('getAllSessionState maps rows to a record', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_db_get_all_session_state') {
        return [{ key: 'hash_stack', value: 'x' }, { key: 'k2', value: 'y' }];
      }
      return undefined;
    });
    await chatDb.init('/proj');
    const all = await chatDb.getAllSessionState('s1');
    expect(all).toEqual({ hash_stack: 'x', k2: 'y' });
    await chatDb.close();
  });

  it('saveArchivedChunks maps ContextChunk fields to snake_case payload', async () => {
    invoke.mockResolvedValue(undefined);
    await chatDb.init('/proj');
    const chunks: ContextChunk[] = [{
      hash: 'hfull',
      shortHash: 'hf',
      type: 'raw',
      source: 'p.ts',
      content: 'body',
      tokens: 3,
      digest: 'd',
      editDigest: 'ed',
      summary: 's',
      pinned: true,
      createdAt: new Date('2024-06-01T00:00:00Z'),
      lastAccessed: 0,
    }];
    await chatDb.saveArchivedChunks('s1', chunks);
    expect(invoke).toHaveBeenCalledWith(
      'chat_db_save_archived_chunks',
      expect.objectContaining({
        sessionId: 's1',
        chunks: [
          expect.objectContaining({
            hash: 'hfull',
            short_hash: 'hf',
            digest: 'd',
            edit_digest: 'ed',
            summary: 's',
            pinned: true,
            source: 'p.ts',
          }),
        ],
      }),
    );
    await chatDb.close();
  });

  it('getArchivedChunks maps DB rows back to ContextChunk', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_db_get_archived_chunks') {
        return [{
          id: 1,
          session_id: 's1',
          hash: 'H',
          short_hash: 'sh',
          type: 'smart',
          source: 'src/x.ts',
          content: 'c',
          tokens: 2,
          digest: 'dig',
          edit_digest: 'edig',
          summary: 'su',
          pinned: false,
          created_at: '2024-01-02T03:04:05Z',
        }];
      }
      return undefined;
    });
    await chatDb.init('/proj');
    const out = await chatDb.getArchivedChunks('s1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      hash: 'H',
      shortHash: 'sh',
      type: 'smart',
      source: 'src/x.ts',
      content: 'c',
      tokens: 2,
      digest: 'dig',
      editDigest: 'edig',
      summary: 'su',
      pinned: false,
    });
    expect(out[0].createdAt.toISOString()).toBe('2024-01-02T03:04:05.000Z');
    await chatDb.close();
  });
});
