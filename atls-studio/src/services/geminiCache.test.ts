import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock('../stores/contextStore', () => ({
  useContextStore: {
    getState: () => ({
      chunks: new Map(),
      archivedChunks: new Map(),
    }),
  },
}));

import {
  resetHppHydrationCache,
  getGeminiCacheSnapshot,
  restoreGeminiCacheSnapshot,
  manageGeminiRollingCache,
  geminiUncachedMessagesStartIndex,
} from './geminiCache';

describe('geminiCache', () => {
  beforeEach(() => {
    invoke.mockReset();
    resetHppHydrationCache();
    restoreGeminiCacheSnapshot({
      version: 'v6',
      googleCacheName: null,
      vertexCacheName: null,
      googleCachedMessageCount: 0,
      vertexCachedMessageCount: 0,
    });
  });

  it('snapshot round-trips', () => {
    const snap = {
      version: 'v6',
      googleCacheName: 'g1',
      vertexCacheName: null,
      googleCachedMessageCount: 3,
      vertexCachedMessageCount: 0,
    };
    restoreGeminiCacheSnapshot(snap);
    expect(getGeminiCacheSnapshot()).toEqual(snap);
  });

  it('skips cache creation when estimated tokens below threshold', async () => {
    const tinyMessages = [{ role: 'user' as const, content: 'hi' }];
    const r = await manageGeminiRollingCache('google', 'k', 'm', 'sys', tinyMessages);
    expect(r.cacheName).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('creates cache when prompt is large enough', async () => {
    invoke.mockResolvedValueOnce('cache-name-1');
    const big = 'x'.repeat(450_000);
    const messages = [{ role: 'user' as const, content: big }];
    const r = await manageGeminiRollingCache('google', 'k', 'gemini-2.0-flash', 'sys', messages);
    expect(r.cacheName).toBe('cache-name-1');
    expect(invoke).toHaveBeenCalledWith(
      'gemini_create_cache',
      expect.objectContaining({ provider: 'google', model: 'gemini-2.0-flash' }),
    );
  });

  it('geminiUncachedMessagesStartIndex: prefix + tail covers full history', () => {
    expect(geminiUncachedMessagesStartIndex(3, 3)).toBe(2);
    expect(geminiUncachedMessagesStartIndex(2, 3)).toBe(2);
    expect(geminiUncachedMessagesStartIndex(1, 0)).toBe(0);
    expect(geminiUncachedMessagesStartIndex(1, 1)).toBe(0);
    expect(geminiUncachedMessagesStartIndex(1, 2)).toBe(1);
  });

  it('caches prefix only when multiple messages so stream tail is non-empty', async () => {
    invoke.mockResolvedValueOnce('cache-name-2');
    // Combined size must exceed ZONE_B_LIMIT (~128k tokens) so rolling cache runs.
    const big = 'x'.repeat(225_000);
    const messages = [
      { role: 'user' as const, content: big },
      { role: 'assistant' as const, content: big },
    ];
    const r = await manageGeminiRollingCache('google', 'k', 'gemini-2.0-flash', 'sys', messages);
    expect(r.cacheName).toBe('cache-name-2');
    expect(r.cachedMessageCount).toBe(1);
    const call = invoke.mock.calls.find((c) => c[0] === 'gemini_create_cache');
    expect(call).toBeDefined();
    const payload = call![1] as { messages: { role: string; content: string }[] };
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].role).toBe('user');
  });
});
