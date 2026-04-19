/**
 * Auto-pin on read — handler-level integration tests.
 *
 * Asserts that read.shaped / read.lines / read.context auto-pin the resulting
 * FileView when `settings.autoPinReads` is on, and leave state untouched when
 * the flag is off. Also covers idempotence with explicit session.pin, and the
 * "released unused" telemetry path.
 *
 * See `docs/auto-pin-on-read.md`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../../../stores/contextStore';
import { useAppStore } from '../../../stores/appStore';
import { handleRead, handleReadLines, handleReadShaped } from './context';
import {
  peekAutoPinMetrics,
  resetAutoPinTelemetry,
} from '../../autoPinTelemetry';

const invokeMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('../../toolHelpers', () => ({
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

function resetAll() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
  resetAutoPinTelemetry();
  invokeMock.mockReset();
  invokeWithTimeoutMock.mockReset();
}

function setAutoPin(enabled: boolean) {
  const prev = useAppStore.getState().settings;
  useAppStore.setState({ settings: { ...prev, autoPinReads: enabled } });
}

function makeCtx(overrides?: Partial<Parameters<typeof handleRead>[1]>) {
  return {
    atlsBatchQuery: vi.fn(),
    expandFilePathRefs: vi.fn(async (filePaths: string[]) => ({
      items: filePaths.map((path) => ({ kind: 'path' as const, path })),
      notes: [] as string[],
    })),
    store: () => useContextStore.getState(),
    getProjectPath: () => null,
    ...overrides,
  } as unknown as Parameters<typeof handleRead>[1];
}

describe('auto-pin on read — flag ON (default)', () => {
  beforeEach(() => {
    resetAll();
    setAutoPin(true);
  });

  it('read.context (full) auto-pins the FileView', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/demo.ts', content: 'const x = 1;\n', content_hash: 'canon1111' }],
      }),
    });

    const result = await handleRead({ type: 'full', file_paths: ['src/demo.ts'] }, ctx);

    expect(result.ok).toBe(true);
    const view = useContextStore.getState().fileViews.get('src/demo.ts');
    expect(view).toBeDefined();
    expect(view!.pinned).toBe(true);
    expect(view!.autoPinnedAt).toBeGreaterThan(0);
    expect(peekAutoPinMetrics().created).toBe(1);
  });

  it('read.shaped auto-pins and records the shape', async () => {
    // Shaped path: atlsBatchQuery('context', ...) fetches full content, then
    // invokeWithTimeout calls shape op via the hash resolver.
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/shaped.ts', content: 'function demo() {\n  return 1;\n}\n', content_hash: 'canon2222' }],
      }),
    });
    invokeWithTimeoutMock.mockResolvedValueOnce({
      content: 'function demo() {\n  return 1;\n}\n',
      source: 'src/shaped.ts',
      content_hash: 'canon2222',
    });
    invokeWithTimeoutMock.mockResolvedValueOnce({
      content: 'function demo();',
      source: 'src/shaped.ts',
      content_hash: 'canon2222',
      selector: 'sig',
    });

    const result = await handleReadShaped({ file_paths: ['src/shaped.ts'], shape: 'sig' }, ctx);
    expect(result.ok).toBe(true);

    const view = useContextStore.getState().fileViews.get('src/shaped.ts');
    expect(view).toBeDefined();
    expect(view!.pinned).toBe(true);
    expect(view!.pinnedShape).toBe('sig');
    expect(view!.autoPinnedAt).toBeGreaterThan(0);
    expect(peekAutoPinMetrics().created).toBe(1);
  });

  it('read.lines on a file-backed read auto-pins the FileView', async () => {
    invokeMock; // not used here — read.lines uses atlsBatchQuery
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        file: 'src/lines.ts',
        h: 'h:abc12345',
        content_hash: 'abc12345000000000000000000000000',
        target_range: [[2, 3]],
        actual_range: [[2, 3]],
        context_lines: 2,
        content: 'const demo = 1;',
      }),
    });

    const result = await handleReadLines({ hash: 'h:abc12345000000000000000000000000', lines: '2-3' }, ctx);

    expect(result.ok).toBe(true);
    const view = useContextStore.getState().fileViews.get('src/lines.ts');
    expect(view).toBeDefined();
    expect(view!.pinned).toBe(true);
    expect(view!.autoPinnedAt).toBeGreaterThan(0);
    expect(peekAutoPinMetrics().created).toBe(1);
  });

  it('second read of the same file does NOT double-pin or double-count', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/dup.ts', content: 'x\n', content_hash: 'dup11111' }],
      }),
    });

    await handleRead({ type: 'full', file_paths: ['src/dup.ts'] }, ctx);
    await handleRead({ type: 'full', file_paths: ['src/dup.ts'] }, ctx);

    // Only one auto-pin event — the second read is a no-op on an already-pinned view.
    expect(peekAutoPinMetrics().created).toBe(1);
    expect(useContextStore.getState().fileViews.get('src/dup.ts')!.pinned).toBe(true);
  });

  it('explicit session.pin on an already auto-pinned view is a no-op for counters', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/mix.ts', content: 'x\n', content_hash: 'mix11111' }],
      }),
    });
    await handleRead({ type: 'full', file_paths: ['src/mix.ts'] }, ctx);

    const view = useContextStore.getState().fileViews.get('src/mix.ts')!;
    const autoPinnedAtBefore = view.autoPinnedAt;

    // Manual pinChunks on the same view should not re-bump autoPinnedAt or counter.
    const { count, alreadyPinned } = useContextStore.getState().pinChunks([view.hash]);
    expect(count).toBe(0);
    expect(alreadyPinned).toBe(1);
    expect(useContextStore.getState().fileViews.get('src/mix.ts')!.autoPinnedAt).toBe(autoPinnedAtBefore);
    expect(peekAutoPinMetrics().created).toBe(1);
  });
});

describe('auto-pin on read — flag OFF (legacy)', () => {
  beforeEach(() => {
    resetAll();
    setAutoPin(false);
  });

  it('read.context does NOT pin; model must emit session.pin explicitly', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/nopin.ts', content: 'x\n', content_hash: 'nopin111' }],
      }),
    });

    const result = await handleRead({ type: 'full', file_paths: ['src/nopin.ts'] }, ctx);

    expect(result.ok).toBe(true);
    const view = useContextStore.getState().fileViews.get('src/nopin.ts');
    expect(view).toBeDefined();
    expect(view!.pinned).toBe(false);
    expect(view!.autoPinnedAt).toBeUndefined();
    expect(peekAutoPinMetrics().created).toBe(0);
  });

  it('read.shaped does NOT pin under flag off', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/noshape.ts', content: 'function demo() {\n  return 1;\n}\n', content_hash: 'noshape1' }],
      }),
    });
    invokeWithTimeoutMock.mockResolvedValueOnce({
      content: 'function demo() {\n  return 1;\n}\n',
      source: 'src/noshape.ts',
      content_hash: 'noshape1',
    });
    invokeWithTimeoutMock.mockResolvedValueOnce({
      content: 'function demo();',
      source: 'src/noshape.ts',
      content_hash: 'noshape1',
      selector: 'sig',
    });

    await handleReadShaped({ file_paths: ['src/noshape.ts'], shape: 'sig' }, ctx);

    const view = useContextStore.getState().fileViews.get('src/noshape.ts');
    expect(view).toBeDefined();
    expect(view!.pinned).toBe(false);
    expect(peekAutoPinMetrics().created).toBe(0);
  });
});

describe('auto-pin on read — unused-pin telemetry', () => {
  beforeEach(() => {
    resetAll();
    setAutoPin(true);
  });

  it('increments autoPinsReleasedUnused when an auto-pinned view is unpinned without re-access', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/unused.ts', content: 'x\n', content_hash: 'unused11' }],
      }),
    });
    await handleRead({ type: 'full', file_paths: ['src/unused.ts'] }, ctx);

    const metrics0 = peekAutoPinMetrics();
    expect(metrics0.created).toBe(1);
    expect(metrics0.releasedUnused).toBe(0);

    // Unpin without any intermediate re-read. lastAccessed never advanced past
    // autoPinnedAt → "released unused" increments.
    const view = useContextStore.getState().fileViews.get('src/unused.ts')!;
    useContextStore.getState().unpinChunks([view.hash]);

    const metrics1 = peekAutoPinMetrics();
    expect(metrics1.releasedUnused).toBe(1);
    // After unpin, autoPinnedAt marker is cleared so a future auto-pin on a
    // fresh read is a clean state.
    expect(useContextStore.getState().fileViews.get('src/unused.ts')!.autoPinnedAt).toBeUndefined();
  });

  it('does NOT increment autoPinsReleasedUnused when the view was re-accessed after auto-pin', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/used.ts', content: 'x\n', content_hash: 'used1111' }],
      }),
    });
    await handleRead({ type: 'full', file_paths: ['src/used.ts'] }, ctx);

    // Simulate a re-access by bumping lastAccessed deterministically — Date.now()
    // ms resolution makes a real re-read racy to assert against autoPinnedAt.
    useContextStore.setState((s) => {
      const next = new Map(s.fileViews);
      const v = next.get('src/used.ts');
      if (v) next.set('src/used.ts', { ...v, lastAccessed: (v.autoPinnedAt ?? 0) + 100 });
      return { fileViews: next };
    });

    const view = useContextStore.getState().fileViews.get('src/used.ts')!;
    expect(view.lastAccessed).toBeGreaterThan(view.autoPinnedAt!);

    useContextStore.getState().unpinChunks([view.hash]);

    expect(peekAutoPinMetrics().releasedUnused).toBe(0);
  });
});
