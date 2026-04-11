import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../../../stores/contextStore';
import { handleBbWrite, handleBbRead, handleBbDelete, handleBbList } from './blackboard';

vi.mock('../../chatDb', () => ({
  chatDb: {
    isInitialized: () => false,
    setBlackboardNote: vi.fn(),
    deleteBlackboardNote: vi.fn(),
  },
}));

function createMockCtx(overrides?: Record<string, unknown>) {
  return {
    store: () => useContextStore.getState(),
    sessionId: null as string | null,
    atlsBatchQuery: vi.fn().mockResolvedValue({ results: [] }),
    ...overrides,
  };
}

describe('blackboard handlers', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('bb_write rejects reserved __ctx_ key prefix', async () => {
    const r = await handleBbWrite(
      { key: '__ctx_x', content: 'nope' },
      createMockCtx() as unknown as Parameters<typeof handleBbWrite>[1],
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/reserved/);
  });

  it('bb_write deletes entry when content empty', async () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('k1', 'hello');
    const r = await handleBbWrite(
      { key: 'k1', content: '   ' },
      createMockCtx() as unknown as Parameters<typeof handleBbWrite>[1],
    );
    expect(r.ok).toBe(true);
    expect(store.getBlackboardEntry('k1')).toBeNull();
  });

  it('bb_read returns content for keys', async () => {
    useContextStore.getState().setBlackboardEntry('a', 'one');
    const r = await handleBbRead(
      { keys: ['a'] },
      createMockCtx() as unknown as Parameters<typeof handleBbRead>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/bb_read:a/);
  });

  it('bb_read errors when keys missing', async () => {
    const r = await handleBbRead(
      { keys: [] },
      createMockCtx() as unknown as Parameters<typeof handleBbRead>[1],
    );
    expect(r.ok).toBe(false);
  });

  it('bb_delete removes an entry', async () => {
    useContextStore.getState().setBlackboardEntry('rm', 'x');
    const r = await handleBbDelete(
      { keys: ['rm'] },
      createMockCtx() as unknown as Parameters<typeof handleBbDelete>[1],
    );
    expect(r.ok).toBe(true);
    expect(useContextStore.getState().getBlackboardEntry('rm')).toBeNull();
  });

  it('bb_list summarizes keys', async () => {
    const s = useContextStore.getState();
    s.setBlackboardEntry('z1', 'a');
    s.setBlackboardEntry('z2', 'b');
    const r = await handleBbList(
      {},
      createMockCtx() as unknown as Parameters<typeof handleBbList>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/z1/);
    expect(r.summary).toMatch(/z2/);
  });
});
