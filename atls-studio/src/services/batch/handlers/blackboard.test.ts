import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../../../stores/contextStore';
import { handleBbWrite, handleBbRead, handleBbDelete, handleBbList } from './blackboard';

const chatDbMock = vi.hoisted(() => ({
  isInitialized: vi.fn(() => false),
  setBlackboardNote: vi.fn().mockResolvedValue(undefined),
  deleteBlackboardNote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../chatDb', () => ({
  chatDb: chatDbMock,
}));

function createMockCtx(overrides?: Record<string, unknown>) {
  return {
    store: () => useContextStore.getState(),
    sessionId: null as string | null,
    atlsBatchQuery: vi.fn().mockResolvedValue({ results: [] }),
    ...overrides,
  };
}

function awareness(path: string, snapshotHash: string) {
  return {
    filePath: path,
    snapshotHash,
    level: 1,
    readRegions: [] as Array<{ start: number; end: number }>,
    recordedAt: Date.now(),
  };
}

describe('blackboard handlers', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    chatDbMock.isInitialized.mockReturnValue(false);
    chatDbMock.setBlackboardNote.mockResolvedValue(undefined);
    chatDbMock.deleteBlackboardNote.mockResolvedValue(undefined);
  });

  it('bb_write rejects missing key', async () => {
    const r = await handleBbWrite(
      { content: 'x' } as { key?: string; content: string },
      createMockCtx() as unknown as Parameters<typeof handleBbWrite>[1],
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/missing key/);
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

  it('bb_write fails when DB delete fails on empty content', async () => {
    chatDbMock.isInitialized.mockReturnValue(true);
    chatDbMock.deleteBlackboardNote.mockRejectedValueOnce(new Error('db down'));
    const store = useContextStore.getState();
    store.setBlackboardEntry('k1', 'hello');
    const r = await handleBbWrite(
      { key: 'k1', content: '' },
      createMockCtx({ sessionId: 's1' }) as unknown as Parameters<typeof handleBbWrite>[1],
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/could not delete note from database/);
    expect(store.getBlackboardEntry('k1')).toBe('hello');
  });

  it('bb_write rolls back store when persist fails', async () => {
    chatDbMock.isInitialized.mockReturnValue(true);
    chatDbMock.setBlackboardNote.mockRejectedValueOnce(new Error('disk full'));
    const store = useContextStore.getState();
    const r = await handleBbWrite(
      { key: 'persist-fail', content: 'body' },
      createMockCtx({ sessionId: 's1' }) as unknown as Parameters<typeof handleBbWrite>[1],
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/could not persist note to database/);
    expect(store.getBlackboardEntry('persist-fail')).toBeNull();
  });

  it('bb_write adds STALE DERIVATION when awareness hash drifts during persist', async () => {
    const store = useContextStore.getState();
    const path = 'src/stale-write.ts';
    store.setAwareness(awareness(path, 'rev1'));
    chatDbMock.isInitialized.mockReturnValue(true);
    chatDbMock.setBlackboardNote.mockImplementation(async () => {
      store.setAwareness(awareness(path, 'rev2'));
    });
    const r = await handleBbWrite(
      { key: 'note', content: 'c', derived_from: [path] },
      createMockCtx({ sessionId: 's1' }) as unknown as Parameters<typeof handleBbWrite>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/STALE DERIVATION/);
    expect(r.summary).toMatch(/stale-write\.ts/);
  });

  it('bb_write notes older stem versions that may be superseded', async () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('task-1', 'older');
    const r = await handleBbWrite(
      { key: 'task-2', content: 'newer' },
      createMockCtx() as unknown as Parameters<typeof handleBbWrite>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/older version/);
    expect(r.summary).toMatch(/task-1/);
  });

  it('bb_write auto-cleans superseded shadowable entries', async () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('repair:old.ts', 'stale repair', {
      filePath: 'src/old.ts',
      snapshotHash: 'h0',
    });
    store.supersedeBlackboardForPath('src/old.ts', 'h1');
    expect(store.getBlackboardEntryWithMeta('repair:old.ts')?.state).toBe('superseded');

    chatDbMock.isInitialized.mockReturnValue(true);
    const r = await handleBbWrite(
      { key: 'fresh', content: 'writes trigger cleanup' },
      createMockCtx({ sessionId: 's1' }) as unknown as Parameters<typeof handleBbWrite>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/auto-cleaned/);
    expect(r.summary).toMatch(/repair:old\.ts/);
    expect(store.getBlackboardEntry('repair:old.ts')).toBeNull();
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

  it('bb_read accepts a single string keys param', async () => {
    useContextStore.getState().setBlackboardEntry('solo', 'x');
    const r = await handleBbRead(
      { keys: 'solo' },
      createMockCtx() as unknown as Parameters<typeof handleBbRead>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/bb_read:solo/);
  });

  it('bb_read errors when keys missing', async () => {
    const r = await handleBbRead(
      { keys: [] },
      createMockCtx() as unknown as Parameters<typeof handleBbRead>[1],
    );
    expect(r.ok).toBe(false);
  });

  it('bb_read marks stale when derived source revision changes', async () => {
    const store = useContextStore.getState();
    const path = 'src/drift.ts';
    store.setAwareness(awareness(path, 'rev1'));
    store.setBlackboardEntry('dr', 'content', { derivedFrom: [path] });
    store.setAwareness(awareness(path, 'rev2'));
    const r = await handleBbRead(
      { keys: ['dr'] },
      createMockCtx() as unknown as Parameters<typeof handleBbRead>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/stale: source changed/);
    expect(r.summary).toMatch(/drift\.ts/);
  });

  it('bb_read includes superseded and historical meta lines', async () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('repair:x.ts', 'r', {
      filePath: 'src/x.ts',
      snapshotHash: 'old',
    });
    store.supersedeBlackboardForPath('src/x.ts', 'newrev999');
    useContextStore.setState(s => {
      const m = new Map(s.blackboardEntries);
      m.set('hist-only', {
        content: 'h',
        createdAt: new Date(),
        tokens: 1,
        kind: 'general',
        state: 'historical',
        updatedAt: Date.now(),
      });
      return { blackboardEntries: m };
    });
    const r = await handleBbRead(
      { keys: ['repair:x.ts', 'hist-only', 'missing'] },
      createMockCtx() as unknown as Parameters<typeof handleBbRead>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/superseded/);
    expect(r.summary).toMatch(/historical/);
    expect(r.summary).toMatch(/NOT_FOUND/);
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

  it('bb_delete fails when database delete fails', async () => {
    chatDbMock.isInitialized.mockReturnValue(true);
    chatDbMock.deleteBlackboardNote.mockRejectedValueOnce(new Error('db'));
    useContextStore.getState().setBlackboardEntry('x', 'y');
    const r = await handleBbDelete(
      { keys: ['x'] },
      createMockCtx({ sessionId: 's1' }) as unknown as Parameters<typeof handleBbDelete>[1],
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/could not delete/);
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

  it('bb_list reports empty when blackboard has no entries', async () => {
    useContextStore.setState({ blackboardEntries: new Map() });
    const r = await handleBbList(
      {},
      createMockCtx() as unknown as Parameters<typeof handleBbList>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/\(empty\)/);
  });

  it('bb_list separates active and superseded sections', async () => {
    const s = useContextStore.getState();
    s.setBlackboardEntry('repair:a.ts', 'old', { filePath: 'src/a.ts', snapshotHash: 'v0' });
    s.setBlackboardEntry('live', 'active note');
    s.supersedeBlackboardForPath('src/a.ts', 'v1');
    const r = await handleBbList(
      {},
      createMockCtx() as unknown as Parameters<typeof handleBbList>[1],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/live/);
    expect(r.summary).toMatch(/superseded\/historical/);
    expect(r.summary).toMatch(/repair:a\.ts/);
  });
});
