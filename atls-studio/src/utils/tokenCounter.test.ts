import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens } from './contextHash';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        selectedProvider: 'anthropic',
        selectedModel: 'claude-3-5-sonnet-20241022',
      },
    }),
  },
}));

const {
  clearTokenCache,
  countTokens,
  countTokensBatch,
  countTokensSync,
  countToolDefTokens,
} = await import('./tokenCounter');

describe('tokenCounter', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    clearTokenCache();
  });

  it('countTokens calls invoke and caches by provider:model:hash', async () => {
    invokeMock.mockResolvedValueOnce(99);
    const a = await countTokens('hello world');
    expect(a).toBe(99);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockResolvedValueOnce(0); // should not be used
    const b = await countTokens('hello world');
    expect(b).toBe(99);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('countTokens falls back to estimateTokens when invoke throws', async () => {
    invokeMock.mockRejectedValueOnce(new Error('ipc'));
    const n = await countTokens('abc');
    expect(n).toBe(estimateTokens('abc'));
  });

  it('countTokens retries IPC after failure instead of caching estimate', async () => {
    invokeMock.mockRejectedValueOnce(new Error('ipc'));
    const first = await countTokens('hello world');
    expect(first).toBe(estimateTokens('hello world'));
    invokeMock.mockResolvedValueOnce(42);
    const second = await countTokens('hello world');
    expect(second).toBe(42);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('countTokensBatch returns zeros for empty strings and batches uncached', async () => {
    invokeMock.mockResolvedValueOnce([5, 7]);
    const out = await countTokensBatch(['', 'x', 'y']);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(5);
    expect(out[2]).toBe(7);
  });

  it('countTokensSync uses estimate and fills cache', () => {
    const text = 'sync token text';
    const n = countTokensSync(text);
    expect(n).toBe(estimateTokens(text));
    const n2 = countTokensSync(text);
    expect(n2).toBe(n);
  });

  it('countToolDefTokens returns invoke result or 0 on failure', async () => {
    invokeMock.mockResolvedValueOnce(42);
    expect(await countToolDefTokens()).toBe(42);
    invokeMock.mockRejectedValueOnce(new Error('x'));
    expect(await countToolDefTokens()).toBe(0);
  });
});
