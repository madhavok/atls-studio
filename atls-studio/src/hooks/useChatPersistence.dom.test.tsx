/** @vitest-environment happy-dom */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useChatPersistence from './useChatPersistence';
import { useAppStore } from '../stores/appStore';
import { useContextStore } from '../stores/contextStore';
import { useCostStore } from '../stores/costStore';
import type { DbSession } from '../services/chatDb';

const geminiStub = {
  version: '1',
  googleCacheName: null,
  vertexCacheName: null,
  googleCachedMessageCount: 0,
  vertexCachedMessageCount: 0,
} as const;

const chatDbMock = vi.hoisted(() => ({
  init: vi.fn(() => Promise.resolve(true)),
  isInitialized: vi.fn(() => false),
  close: vi.fn(() => Promise.resolve()),
  getSessions: vi.fn(() => Promise.resolve([] as DbSession[])),
  getSession: vi.fn(() => Promise.resolve(null)),
  createSession: vi.fn(() => Promise.resolve('new-id')),
  saveFullSession: vi.fn(() => Promise.resolve()),
  saveMemorySnapshot: vi.fn(() => Promise.resolve()),
  loadFullSession: vi.fn(() => Promise.resolve(null)),
  deleteSession: vi.fn(() => Promise.resolve()),
  addBlackboardEntry: vi.fn(() => Promise.resolve()),
  removeBlackboardEntries: vi.fn(() => Promise.resolve()),
  getMemorySnapshot: vi.fn(() => Promise.resolve(null)),
  getBlackboardNotes: vi.fn(() => Promise.resolve([])),
  getArchivedChunks: vi.fn(() => Promise.resolve([])),
  getStagedSnippets: vi.fn(() => Promise.resolve(new Map())),
  getAllSessionState: vi.fn(() => Promise.resolve({})),
  setSessionState: vi.fn(() => Promise.resolve()),
  getSessionState: vi.fn(() => Promise.resolve(null)),
  deleteMessagesFrom: vi.fn(() => Promise.resolve()),
  deleteMessagesAfter: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/chatDb', () => ({
  chatDb: chatDbMock,
}));

vi.mock('../services/aiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiService')>();
  return {
    ...actual,
    getGeminiCacheSnapshot: vi.fn(() => geminiStub),
    restoreGeminiCacheSnapshot: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
    close: vi.fn(() => Promise.resolve()),
  }),
}));

describe('useChatPersistence (hook)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatDbMock.init.mockResolvedValue(true);
    chatDbMock.isInitialized.mockReturnValue(false);
    chatDbMock.getSessions.mockResolvedValue([]);
    chatDbMock.close.mockResolvedValue(undefined);
    useAppStore.setState({
      projectPath: null,
      messages: [],
      chatSessions: [],
      currentSessionId: null,
      contextUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        maxTokens: 100_000,
        percentage: 0,
      },
    });
    useContextStore.getState().resetSession();
    useCostStore.getState().resetChat();
  });

  it('initChatDb returns true when chatDb.init succeeds', async () => {
    const { result } = renderHook(() => useChatPersistence());
    await expect(result.current.initChatDb('/proj/a')).resolves.toBe(true);
    expect(chatDbMock.init).toHaveBeenCalledWith('/proj/a');
  });

  it('initChatDb returns false when chatDb.init throws', async () => {
    chatDbMock.init.mockRejectedValueOnce(new Error('db down'));
    const { result } = renderHook(() => useChatPersistence());
    await expect(result.current.initChatDb('/proj/b')).resolves.toBe(false);
  });

  it('loadSessions returns [] when database is not initialized', async () => {
    const { result } = renderHook(() => useChatPersistence());
    await expect(result.current.loadSessions()).resolves.toEqual([]);
    expect(chatDbMock.getSessions).not.toHaveBeenCalled();
  });

  it('loadSessions maps DB rows into chatSessions', async () => {
    chatDbMock.isInitialized.mockReturnValue(true);
    const created = '2026-04-01T10:00:00.000Z';
    const updated = '2026-04-02T11:00:00.000Z';
    chatDbMock.getSessions.mockResolvedValueOnce([{
      id: 's1',
      title: 'Hello',
      mode: 'agent',
      created_at: created,
      updated_at: updated,
      is_swarm: false,
      context_usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        cost_cents: 5,
      },
    }]);

    const { result } = renderHook(() => useChatPersistence());
    const sessions = await result.current.loadSessions();

    expect(chatDbMock.getSessions).toHaveBeenCalledWith(200);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('s1');
    expect(sessions[0]?.title).toBe('Hello');
    expect(sessions[0]?.createdAt.toISOString()).toBe(created);
    expect(sessions[0]?.contextUsage?.totalTokens).toBe(30);
    expect(useAppStore.getState().chatSessions).toHaveLength(1);
  });

  it('createNewSession returns null when database is not initialized', async () => {
    const { result } = renderHook(() => useChatPersistence());
    await expect(result.current.createNewSession()).resolves.toBeNull();
    expect(chatDbMock.createSession).not.toHaveBeenCalled();
  });

  it('syncBlackboardEntry does not call DB without a current session', async () => {
    chatDbMock.isInitialized.mockReturnValue(true);
    const { result } = renderHook(() => useChatPersistence());
    const chunk = {
      hash: 'h1',
      shortHash: 'h1short',
      type: 'file' as const,
      source: 'src/x.ts',
      content: 'x',
      tokens: 1,
      createdAt: new Date(),
    };
    await result.current.syncBlackboardEntry(chunk);
    expect(chatDbMock.addBlackboardEntry).not.toHaveBeenCalled();
  });

  it('exposes isInitialized from chatDb', () => {
    chatDbMock.isInitialized.mockReturnValueOnce(true);
    const { result } = renderHook(() => useChatPersistence());
    expect(result.current.isInitialized).toBe(true);
  });

  it('runs closeWithoutProject when hook mounts with no project', async () => {
    renderHook(() => useChatPersistence());
    await waitFor(() => {
      expect(chatDbMock.close).toHaveBeenCalled();
    });
  });
});
