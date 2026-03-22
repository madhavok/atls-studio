import { beforeEach, describe, expect, it, vi } from 'vitest';

const { safeListenMock } = vi.hoisted(() => ({
  safeListenMock: vi.fn(),
}));

vi.mock('../utils/tauri', () => ({
  safeListen: (...args: unknown[]) => safeListenMock(...args),
}));

import { createTauriChatStream } from './chatTransport';

describe('createTauriChatStream', () => {
  beforeEach(() => {
    safeListenMock.mockReset();
  });

  it('returns empty stream when abortSignal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const stream = await createTauriChatStream({
      streamId: 'test-1',
      invoke: vi.fn(),
      abortSignal: ac.signal,
    });
    const reader = stream.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(true);
    expect(value).toBeUndefined();
    expect(safeListenMock).not.toHaveBeenCalled();
  });

  it('registers listener and starts invoke', async () => {
    const invokeFn = vi.fn().mockResolvedValue(undefined);
    let eventHandler: ((e: { payload: unknown }) => void) | null = null;
    safeListenMock.mockImplementation((_: string, fn: (e: { payload: unknown }) => void) => {
      eventHandler = fn;
      return Promise.resolve(() => {});
    });

    const stream = await createTauriChatStream({
      streamId: 'sid',
      invoke: invokeFn,
    });
    expect(safeListenMock).toHaveBeenCalledWith('chat-chunk-sid', expect.any(Function));
    expect(invokeFn).toHaveBeenCalled();
    expect(eventHandler).not.toBeNull();

    const chunks: unknown[] = [];
    const reader = stream.getReader();
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    };
    const readPromise = readLoop();

    await Promise.resolve();
    eventHandler!({ payload: { type: 'token', token: 'hello' } });
    eventHandler!({ payload: { type: 'done' } });

    await readPromise;
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ type: 'token', token: 'hello' });
    expect(chunks[1]).toEqual({ type: 'done' });
  });
});
