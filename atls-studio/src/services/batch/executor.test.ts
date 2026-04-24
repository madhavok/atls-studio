import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpHandler, OperationKind, StepOutput } from './types';

const handlers = new Map<string, OpHandler>();

vi.mock('./opMap', () => ({
  getHandler: (op: OperationKind) => handlers.get(op),
  isReadonlyOp: () => false,
  isMutatingOp: (op: OperationKind) => op.startsWith('change.'),
}));

vi.mock('./policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./policy')>();
  return {
    isStepAllowed: () => ({ allowed: true }),
    getAutoVerifySteps: () => [],
    isStepCountExceeded: (idx: number, pol?: { max_steps?: number }) =>
      Boolean(pol?.max_steps) && idx >= pol.max_steps,
    evaluateCondition: actual.evaluateCondition,
    isBlockedForSwarm: actual.isBlockedForSwarm,
  };
});

vi.mock('./handlers/session', () => ({
  resetRecallBudget: () => {},
}));

import { executeUnifiedBatch, rebaseRegionsByDeltas, rebaseHashRefLineRange, buildPerFileDeltaMap } from './executor';
import type { PositionalDelta } from './executor';
import { computeFileViewHashParts } from '../fileViewStore';
import { AwarenessLevel } from './snapshotTracker';
import { useAppStore } from '../../stores/appStore';
import { isBlockedForSwarm } from './policy';

function makeCtx() {
  const awarenessCache = new Map();
  return {
    sessionId: null as string | null,
    isSwarmAgent: false,
    store: () => ({
      recordManageOps: () => {},
      recordToolCall: () => {},
      recordBatchRead: () => {},
      recordBatchBbWrite: () => {},
      recordCoveragePath: () => {},
      recordFileReadSpin: () => null,
      resetFileReadSpin: () => {},
      getPriorReadRanges: () => [],
      forwardStagedHash: () => 0,
      rebaseStagedLineNumbers: () => 0,
      addVerifyArtifact: () => {},
      getCurrentRev: () => 0,
      recordMemoryEvent: () => {},
      getAwareness: () => undefined,
      setAwareness: (entry: Record<string, unknown>) => { awarenessCache.set((entry.filePath as string).replace(/\\/g, '/').toLowerCase(), entry); },
      invalidateAwareness: () => {},
      invalidateAwarenessForPaths: () => {},
      getAwarenessCache: () => awarenessCache,
      getStagedEntries: () => new Map(),
      chunks: new Map(),
      listBlackboardEntries: () => [],
      getBlackboardEntryWithMeta: () => null,
      getUsedTokens: () => 0,
      maxTokens: 100000,
      getStagedSnippetsForRefresh: () => [],
      markEngramsSuspect: () => {},
      recordRevisionAdvance: () => {},
      registerEditHash: () => ({ registered: true }),
      bumpWorkspaceRev: () => {},
      invalidateArtifactsForPaths: () => {},
      compactChunks: vi.fn(() => ({ compacted: 0, freedTokens: 0 })),
    }),
    getProjectPath: () => null,
    resolveSearchRefs: async () => ({}),
    expandSetRefsInHashes: (hashes: string[]) => ({ expanded: hashes, notes: [] }),
    expandFilePathRefs: async () => ({ items: [], notes: [] }),
    atlsBatchQuery: async () => ({}),
  } as any;
}

/** Context store with pre-seeded chunks (e.g. repeat-read auto-stage path). */
function makeCtxWithChunks(
  chunks: Map<string, Record<string, unknown>>,
) {
  const base = makeCtx();
  return {
    ...base,
    store: () => ({
      ...base.store(),
      chunks,
    }),
  } as any;
}

function raw(summary: string, content: Record<string, unknown>, ok = true): StepOutput {
  return {
    kind: 'raw',
    ok,
    refs: [],
    summary,
    content,
  };
}

describe('executeUnifiedBatch interruption handling', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('does not cascade-stop batch after change.* dry-run/preview (subsequent steps run)', async () => {
    const applySpy = vi.fn().mockReturnValue(raw('created', { ok: true }));

    handlers.set('change.edit', async () =>
      raw('preview ready', {
        status: 'preview',
        dry_run: true,
        _next: 'Preview complete. Set dry_run:false to apply',
      }),
    );
    handlers.set('change.create', applySpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [
          { id: 'preview', use: 'change.edit' },
          { id: 'apply', use: 'change.create' },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.interruption).toBeUndefined();
    expect(result.step_results).toHaveLength(2);
    expect(result.step_results[1].summary).not.toContain('SKIPPED');
    expect(applySpy).toHaveBeenCalled();
  });

  it('allows a third change.* dry_run after two consecutive dry-run previews (warn only in spin_breaker)', async () => {
    const changeSpy = vi.fn().mockImplementation(async () =>
      raw('preview', {
        dry_run: true,
        _next: 'Preview complete. Set dry_run:false to apply',
      }),
    );
    handlers.set('change.edit', changeSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [
          { id: 'p1', use: 'change.edit' },
          { id: 'p2', use: 'change.edit' },
          { id: 'p3', use: 'change.edit', with: { dry_run: true } },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(changeSpy).toHaveBeenCalledTimes(3);
    expect(result.step_results).toHaveLength(3);
    expect(result.step_results[2].summary).not.toMatch(/BLOCKED/);
    expect(result.spin_breaker).toMatch(/<<WARN:.*dry-run previewed/);
  });

  it('does not cascade-stop batch for rename dry_run preview (read-only, files_modified:0)', async () => {
    const afterSpy = vi.fn().mockReturnValue(raw('done', { ok: true }));

    handlers.set('change.refactor', async () =>
      raw('rename preview', {
        old_name: 'foo',
        new_name: 'bar',
        dry_run: true,
        summary: { files_affected: 2, files_modified: 0, total_replacements: 2 },
        _next: 'Preview complete. Set dry_run:false to apply rename',
      }),
    );
    handlers.set('change.edit', afterSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [
          { id: 'rename-preview', use: 'change.refactor' },
          { id: 'followup-edit', use: 'change.edit' },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.interruption).toBeUndefined();
    expect(result.step_results).toHaveLength(2);
    expect(result.step_results[1].summary).not.toContain('SKIPPED');
    expect(afterSpy).toHaveBeenCalled();
  });

  it('does not pause batch when execute succeeds with _rollback data (ix / refactor execute)', async () => {
    const afterSpy = vi.fn().mockReturnValue(raw('done', { ok: true }));

    handlers.set('change.refactor', async () =>
      raw('extract done', {
        status: 'success',
        results: [{ op: 0, status: 'applied' }],
        files: 2,
        _rollback: { restore: [{ file: 'src/a.py', hash: 'h:abc123' }], delete: ['src/b.py'] },
        _action: 'execute',
      }),
    );
    handlers.set('verify.build', afterSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [
          { id: 'extract', use: 'change.refactor' },
          { id: 'verify', use: 'verify.build' },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.interruption).toBeUndefined();
    expect(result.step_results).toHaveLength(2);
    expect(result.step_results[1].summary).not.toContain('SKIPPED');
    expect(afterSpy).toHaveBeenCalled();
  });

  it('does not interrupt batch when refactor returns paused + resume_after (subsequent steps still run)', async () => {
    const afterSpy = vi.fn().mockReturnValue(raw('verify ok', { ok: true }));

    handlers.set('change.refactor', async () =>
      raw('lint failed', {
        status: 'paused',
        failed_operation_index: 1,
        resume_after: 0,
        _rollback: { restore: [{ file: 'src/a.py', hash: 'h:abc123' }] },
        _next: 'Fix and resume_after:0',
      }),
    );
    handlers.set('verify.build', afterSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [
          { id: 'extract', use: 'change.refactor' },
          { id: 'verify', use: 'verify.build' },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.interruption).toBeUndefined();
    expect(afterSpy).toHaveBeenCalled();
  });

  it('continues batch when a step reports paused for lint/rollback follow-up (no runtime stop)', async () => {
    const mutateSpy = vi.fn().mockReturnValue(raw('edited', { ok: true }));

    handlers.set('change.refactor', async () =>
      raw('lint paused', {
        status: 'paused',
        failed_operation_index: 1,
        resume_after: 0,
        _rollback: { restore: ['src/a.ts'] },
        _next: 'Fix the failing operation and resume_after:0',
      }),
    );
    handlers.set('change.edit', mutateSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [
          { id: 'refactor', use: 'change.refactor' },
          { id: 'followup', use: 'change.edit' },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.interruption).toBeUndefined();
    expect(result.step_results).toHaveLength(2);
    expect(mutateSpy).toHaveBeenCalled();
  });

  it('does not interrupt the batch for blocked system.exec output', async () => {
    const afterSpy = vi.fn();

    handlers.set('system.exec', async () =>
      raw('exec blocked', {
        status: 'blocked',
        _next: 'readonly policy blocks system.exec',
      }, false),
    );
    handlers.set('session.emit', async () => {
      afterSpy();
      return raw('continued', { ok: true });
    });

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [
          { id: 'exec', use: 'system.exec' },
          { id: 'after', use: 'session.emit' },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.interruption).toBeUndefined();
    expect(result.step_results).toHaveLength(2);
    expect(afterSpy).toHaveBeenCalledTimes(1);
  });
});

describe('executeUnifiedBatch auto-stage repeat read and verify stop', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('injects session.stage after file_refs when chunk readCount >= 2 and auto_stage_refs is off', async () => {
    const stageSpy = vi.fn(async () => ({
      kind: 'session' as const,
      ok: true,
      refs: [] as string[],
      summary: 'staged',
    }));
    const afterSpy = vi.fn(async () => raw('done', { ok: true }));

    handlers.set('session.stage', stageSpy as unknown as OpHandler);
    handlers.set('read.lines', async () => ({
      kind: 'file_refs' as const,
      ok: true,
      refs: ['h:beef42'],
      summary: 'read',
    }));
    handlers.set('session.emit', afterSpy as unknown as OpHandler);

    const chunk = {
      hash: 'fullbeef42hashxxxxxxxx',
      shortHash: 'beef42',
      type: 'result',
      content: 'x',
      tokens: 1,
      createdAt: new Date(),
      lastAccessed: Date.now(),
      source: 'src/repeat.ts',
      readCount: 2,
    };
    const ctx = makeCtxWithChunks(new Map([['k1', chunk]]));

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { auto_stage_refs: false },
        steps: [
          { id: 'r', use: 'read.lines', with: { hash: 'h:beef42', lines: '1-3' } },
          { id: 'tail', use: 'session.emit', with: {} },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(stageSpy).toHaveBeenCalledTimes(1);
    const stageParams = stageSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(stageParams.hashes).toEqual(['h:beef42']);
    expect(afterSpy).toHaveBeenCalled();
    expect(result.step_results.some(r => r.id === 'r__auto_stage_repeat')).toBe(true);
  });

  it('stops stepping after failed verify when stop_on_verify_failure is set', async () => {
    const afterSpy = vi.fn(async () => raw('after', { ok: true }));

    handlers.set('verify.build', async () => ({
      kind: 'verify_result' as const,
      ok: false,
      refs: [] as string[],
      summary: 'build failed',
      classification: 'fail' as const,
    }));
    handlers.set('session.emit', afterSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { stop_on_verify_failure: true },
        steps: [
          { id: 'v', use: 'verify.build', with: {} },
          { id: 'after', use: 'session.emit', with: {} },
        ],
      },
      makeCtx(),
    );

    expect(result.step_results).toHaveLength(1);
    expect(afterSpy).not.toHaveBeenCalled();
  });

  it('calls compactChunks after successful verify.build when compact_context_on_verify_success defaults true', async () => {
    const compactSpy = vi.fn(() => ({ compacted: 2, freedTokens: 1500 }));
    const ctx = makeCtx();
    const origStore = ctx.store;
    ctx.store = () => ({ ...origStore(), compactChunks: compactSpy });

    handlers.set('verify.build', async () => ({
      kind: 'verify_result' as const,
      ok: true,
      refs: [] as string[],
      summary: 'ok',
      classification: 'pass' as const,
    }));

    await executeUnifiedBatch(
      { version: '1.0', steps: [{ id: 'v', use: 'verify.build', with: {} }] },
      ctx,
    );

    expect(compactSpy).toHaveBeenCalledWith(['*'], { confirmWildcard: true });
  });

  it('does not compact after verify.build when compact_context_on_verify_success is false', async () => {
    const compactSpy = vi.fn(() => ({ compacted: 0, freedTokens: 0 }));
    const ctx = makeCtx();
    const origStore = ctx.store;
    ctx.store = () => ({ ...origStore(), compactChunks: compactSpy });

    handlers.set('verify.build', async () => ({
      kind: 'verify_result' as const,
      ok: true,
      refs: [] as string[],
      summary: 'ok',
      classification: 'pass' as const,
    }));

    await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { compact_context_on_verify_success: false },
        steps: [{ id: 'v', use: 'verify.build', with: {} }],
      },
      ctx,
    );

    expect(compactSpy).not.toHaveBeenCalled();
  });

  it('injects session.stage after file_refs when auto_stage_refs policy is true', async () => {
    const stageSpy = vi.fn(async () => ({
      kind: 'session' as const,
      ok: true,
      refs: [] as string[],
      summary: 'staged',
    }));
    handlers.set('session.stage', stageSpy as unknown as OpHandler);
    handlers.set('read.lines', async () => ({
      kind: 'file_refs' as const,
      ok: true,
      refs: ['h:aaa111'],
      summary: 'read',
    }));
    handlers.set('session.emit', async () => raw('tail', { ok: true }));

    await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { auto_stage_refs: true },
        steps: [
          { id: 'r', use: 'read.lines', with: { hash: 'h:aaa111', lines: '1-5' } },
          { id: 't', use: 'session.emit', with: {} },
        ],
      },
      makeCtx(),
    );

    expect(stageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hashes: ['h:aaa111'] }),
      expect.anything(),
      expect.anything(),
    );
    expect(stageSpy.mock.calls[0]![2]).toBe('r__auto_stage');
  });

  it('blocks session.plan for swarm agent context', async () => {
    expect(isBlockedForSwarm('session.plan')).toBe(true);
    const ctx = { ...makeCtx(), isSwarmAgent: true };
    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [{ id: 'p', use: 'session.plan', with: {} }],
      },
      ctx,
    );
    expect(result.step_results[0]?.error).toBe('not available to subagents');
  });
});

describe('executeUnifiedBatch pseudo-op handling', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('rejects multi_tool_use.parallel with an actionable message', async () => {
    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [{ id: 'bad', use: 'multi_tool_use.parallel' }],
      },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    const first = result.step_results[0];
    expect(first?.error).toContain('OperationKind');
    expect(first?.error).toContain('multi_tool_use');
  });

  it('rejects literal USE as mistaken doc token with an actionable message', async () => {
    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [{ id: 'bad', use: 'USE' }],
      },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    const first = result.step_results[0];
    expect(first?.error).toContain('unknown operation: USE');
    expect(first?.error).toContain('labels the q: line operation column');
    expect(first?.error).toContain('read.shaped');
  });
});

describe('executeUnifiedBatch snapshot propagation', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('propagates content_hash from read.context into change.edit', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.content_hash).toBe('abc12345');
      return raw('applied', { status: 'ok' });
    });

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/demo.ts', content_hash: 'abc12345' }],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { file_paths: ['src/demo.ts'] } },
        { id: 'edit', use: 'change.edit', with: { file: 'src/demo.ts', line_edits: [{ line: 1, action: 'delete' }] } },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('allows change.edit with line_edits when read.lines has actual_range covering edit region', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));

    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/demo.ts',
      content_hash: 'cafefeed',
      content: 'const demo = 1;',
      actual_range: [[1, 5]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/demo.ts', lines: '1-5' } },
        { id: 'edit', use: 'change.edit', with: { file: 'src/demo.ts', line_edits: [{ line: 3, action: 'replace', content: 'const demo = 2;' }] } },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });
});

describe('executeUnifiedBatch read-range gate (line edits)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('rejects change.edit when read.lines range does not cover edit lines', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));

    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/demo.ts',
      content_hash: 'cafefeed',
      content: 'x',
      actual_range: [[1, 5]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/demo.ts', lines: '1-5' } },
        { id: 'edit', use: 'change.edit', with: { file: 'src/demo.ts', line_edits: [{ line: 10, action: 'replace', content: 'nope' }] } },
      ],
    }, makeCtx());

    expect(editSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    const step = result.step_results.find(s => s.id === 'edit');
    expect(step?.error).toContain('target region not yet read');
    expect((step?.artifacts as { _internal?: { error_class?: string } } | undefined)?._internal?.error_class).toBe(
      'edit_outside_read_range',
    );
  });

  it('rejects spanning edit when middle lines were never read (gap between regions)', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));
    let readCalls = 0;
    handlers.set('read.lines', async () => {
      readCalls += 1;
      return raw('read_lines', {
        file: 'src/gap.ts',
        content_hash: 'aaa',
        content: 'x',
        actual_range: readCalls === 1 ? [[1, 2]] : [[5, 6]],
      });
    });
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.lines', with: { file_path: 'src/gap.ts', lines: '1-2' } },
        { id: 'r2', use: 'read.lines', with: { file_path: 'src/gap.ts', lines: '5-6' } },
        { id: 'edit', use: 'change.edit', with: { file: 'src/gap.ts', line_edits: [{ line: 2, end_line: 5, action: 'replace', content: 'z' }] } },
      ],
    }, makeCtx());

    expect(editSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('skips gate for hash-ref file paths (h:…)', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));
    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/x.ts',
      content_hash: 'zzz',
      content: 'a',
      actual_range: [[1, 1]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/x.ts', lines: '1-1' } },
        {
          id: 'edit',
          use: 'change.edit',
          with: { file: 'h:deadbeef:1-400', line_edits: [{ line: 200, action: 'insert_before', content: '// z' }] },
        },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('allows change.edit when file param is not the path key but content_hash matches a tracked read', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));
    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/demo.ts',
      content_hash: 'cafefeed',
      content: 'x',
      actual_range: [[1, 5]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/demo.ts', lines: '1-5' } },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'wrong-path-label',
            content_hash: 'cafefeed',
            line_edits: [{ line: 3, action: 'replace', content: 'y' }],
          },
        },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('allows change.edit at any line after read.context (canonical read bypasses range gate)', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok' }));
    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/wide.ts', content_hash: 'canon1', content: 'full' }],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { file_paths: ['src/wide.ts'] } },
        { id: 'edit', use: 'change.edit', with: { file: 'src/wide.ts', line_edits: [{ line: 900, action: 'replace', content: 'x' }] } },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('allows a later change.edit on the same file without fresh read.lines after first successful edit', async () => {
    const editSpy = vi.fn(async () => raw('applied', { status: 'ok', drafts: [{ file: 'src/chained.ts', content_hash: 'h2' }] }));
    handlers.set('read.lines', async () => raw('read_lines', {
      file: 'src/chained.ts',
      content_hash: 'h1',
      content: 'code',
      actual_range: [[1, 3]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/chained.ts', lines: '1-3' } },
        { id: 'e1', use: 'change.edit', with: { file: 'src/chained.ts', line_edits: [{ line: 2, action: 'replace', content: 'a' }] } },
        { id: 'e2', use: 'change.edit', with: { file: 'src/chained.ts', line_edits: [{ line: 50, action: 'insert_before', content: '// far' }] } },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editSpy).toHaveBeenCalledTimes(2);
  });
});

describe('executeUnifiedBatch intra-step snapshot line rebasing', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('always rebases intra-step line_edits as snapshot coordinates', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.line_numbering).toBeUndefined();
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le).toHaveLength(2);
      expect(le[0].line).toBe(5);
      expect(le[1].line).toBe(17); // 15 + 2 from insert at 5 with two lines
      return raw('applied', { status: 'ok' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/a.ts',
            line_edits: [
              { line: 5, action: 'insert_before', content: 'a\nb' },
              { line: 15, action: 'replace', content: 'x' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('does not mutate step.with.line_edits when change.edit fails', async () => {
    const snapshot = [
      { line: 5, action: 'insert_before', content: 'a\nb' },
      { line: 15, action: 'replace', content: 'x' },
    ];
    const steps = [
      {
        id: 'edit',
        use: 'change.edit' as const,
        with: {
          file: 'src/a.ts',
          line_edits: snapshot.map((e) => ({ ...e })),
        },
      },
    ];

    handlers.set('change.edit', async () => raw('failed', { error: 'backend rejected' }, false));

    await executeUnifiedBatch({ version: '1.0', steps }, makeCtx());

    const le = steps[0].with.line_edits as Array<Record<string, unknown>>;
    expect(le[0].line).toBe(5);
    expect(le[1].line).toBe(15);
    expect(le.map((e) => e.action)).toEqual(['insert_before', 'replace']);
  });

  it('intra-step insert_before shifts a later edit at the same snapshot line', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le).toHaveLength(2);
      expect(le[0].line).toBe(10);
      expect(le[1].line).toBe(11);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/a.ts',
            line_edits: [
              { line: 10, action: 'insert_before', content: '// x' },
              { line: 10, action: 'replace', content: 'y' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('strips legacy line_numbering from params after rebase', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.line_numbering).toBeUndefined();
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le[1].line).toBe(17);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/a.ts',
            line_numbering: 'sequential',
            line_edits: [
              { line: 5, action: 'insert_before', content: 'a\nb' },
              { line: 15, action: 'replace', content: 'x' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('rebases each file line_edits in batch_edits mode', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.line_numbering).toBeUndefined();
      const edits = params.edits as Array<Record<string, unknown>>;
      const le = edits[0].line_edits as Array<Record<string, unknown>>;
      expect(le[1].line).toBe(12); // 10 + 2 from prior insert at 5
      return raw('applied', { status: 'ok', mode: 'batch_edits' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            mode: 'batch_edits',
            edits: [
              {
                file: 'src/a.ts',
                line_edits: [
                  { line: 5, action: 'insert_before', content: 'a\nb' },
                  { line: 10, action: 'replace', content: 'x' },
                ],
              },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('rebases insert_before/insert_after after implicit replace (no action field)', async () => {
    // Batch 1 regression: replace lines 3-7 with 8 lines (+3 delta), then
    // insert_before at snapshot 9, insert_after at snapshot 16.
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le).toHaveLength(3);
      // Edit A: implicit replace at 3-7 (no action) — stays at 3
      expect(le[0].line).toBe(3);
      // Edit B: insert_before at snapshot 9 → 9 + 3 = 12
      expect(le[1].line).toBe(12);
      // Edit C: insert_after at snapshot 16 → 16 + 3 (from A) + 1 (from B) = 20
      expect(le[2].line).toBe(20);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/user.ts',
            line_edits: [
              { line: 3, end_line: 7, content: 'a\nb\nc\nd\ne\nf\ng\nh' },
              { line: 9, action: 'insert_before', content: '/** JSDoc */' },
              { line: 16, action: 'insert_after', content: 'function normalizeEmail() {}' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('rebases move destination after prior delete', async () => {
    // Batch 2 regression: delete lines 35-37 (-3 delta), then move lines 31-33
    // to destination 41. Destination should shift to 38 (41 - 3).
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le).toHaveLength(2);
      // Edit A: delete at 35 — stays at 35
      expect(le[0].line).toBe(35);
      // Edit B: move at snapshot 31 — source is before the delete (31 < 35), no shift
      expect(le[1].line).toBe(31);
      // Move destination: snapshot 41 → 41 - 3 = 38
      expect(le[1].destination).toBe(38);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/users.ts',
            line_edits: [
              { line: 35, end_line: 37, action: 'delete' },
              { line: 31, end_line: 33, action: 'move', destination: 41 },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('propagates cumulative delta across mixed action types', async () => {
    // 3 edits: replace (implicit) +2, insert_before +1, insert_after at end
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le).toHaveLength(3);
      expect(le[0].line).toBe(5);
      // Edit B: snapshot 10, +2 from implicit replace at 5 → 12
      expect(le[1].line).toBe(12);
      // Edit C: snapshot 20, +2 from A, +1 from B → 23
      expect(le[2].line).toBe(23);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/mixed.ts',
            line_edits: [
              { line: 5, end_line: 6, content: 'a\nb\nc\nd' },                  // implicit replace: 4 - 2 = +2
              { line: 10, action: 'insert_before', content: '// comment' },      // +1
              { line: 20, action: 'insert_after', content: '// trailing' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Multiedit / multibatch stress tests — exercises snapshot propagation,
// in-bindings, conditionals, rollback, max_steps, and path normalization.
// ---------------------------------------------------------------------------

describe('executeUnifiedBatch multiedit multibatch stress', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('propagates per-file content_hash to batch_edits (edits: [{ file, line_edits }, ...])', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const edits = params.edits as Array<Record<string, unknown>>;
      expect(edits).toHaveLength(3);
      expect(edits[0].file).toBe('src/a.ts');
      expect(edits[0].content_hash).toBe('hash-a');
      expect(edits[1].file).toBe('src/b.ts');
      expect(edits[1].content_hash).toBe('hash-b');
      expect(edits[2].file).toBe('src/c.ts');
      expect(edits[2].content_hash).toBe('hash-c');
      return raw('batch applied', { status: 'ok', mode: 'batch_edits' });
    });

    handlers.set('read.context', async () => raw('multi-read', {
      results: [
        { file: 'src/a.ts', content_hash: 'hash-a' },
        { file: 'src/b.ts', content_hash: 'hash-b' },
        { file: 'src/c.ts', content_hash: 'hash-c' },
      ],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { file_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] } },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            edits: [
              { file: 'src/a.ts', line_edits: [{ line: 1, action: 'insert_before', content: '// a' }] },
              { file: 'src/b.ts', line_edits: [{ line: 1, action: 'insert_before', content: '// b' }] },
              { file: 'src/c.ts', line_edits: [{ line: 1, action: 'insert_before', content: '// c' }] },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('interleaved canonical reads and edits: each edit gets hash from prior read of same file', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async (_params: Record<string, unknown>) => {
      const path = (_params.file_paths as string[])[0];
      const hashes: Record<string, string> = {
        'src/a.ts': 'hash-a-v1',
        'src/b.ts': 'hash-b-v1',
        'src/c.ts': 'hash-c-v1',
      };
      return raw('read', {
        results: [{ file: path, content_hash: hashes[path] ?? 'unknown', content: 'line' }],
      });
    });
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', { status: 'ok' });
    });

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        { id: 'e1', use: 'change.edit', with: { file: 'src/a.ts', line_edits: [{ line: 1, action: 'replace', content: 'a' }] } },
        { id: 'r2', use: 'read.context', with: { type: 'full', file_paths: ['src/b.ts'] } },
        { id: 'e2', use: 'change.edit', with: { file: 'src/b.ts', line_edits: [{ line: 1, action: 'replace', content: 'b' }] } },
        { id: 'r3', use: 'read.context', with: { type: 'full', file_paths: ['src/c.ts'] } },
        { id: 'e3', use: 'change.edit', with: { file: 'src/c.ts', line_edits: [{ line: 1, action: 'replace', content: 'c' }] } },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editCalls).toHaveLength(3);
    expect(editCalls[0].content_hash).toBe('hash-a-v1');
    expect(editCalls[1].content_hash).toBe('hash-b-v1');
    expect(editCalls[2].content_hash).toBe('hash-c-v1');
  });

  it('resolves in-bindings: from_step and path into prior output', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.edits).toEqual([{ file: 'src/x.ts', old: 'old', new: 'new' }]);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/x.ts', content_hash: 'h123' }],
      edits: [{ file: 'src/x.ts', old: 'old', new: 'new' }],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { file_paths: ['src/x.ts'] } },
        {
          id: 'edit',
          use: 'change.edit',
          in: { edits: { from_step: 'read', path: 'content.edits' } },
          with: { file: 'src/x.ts' },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        edits: [expect.objectContaining({ file: 'src/x.ts', old: 'old', new: 'new' })],
        file_path: 'src/x.ts',
      }),
      expect.anything(),
      'edit',
    );
  });

  it('resolves named bindings (out/in bind)', async () => {
    const verifySpy = vi.fn(async () => raw('verified', { ok: true }));

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/foo.ts', content_hash: 'pre-edit-hash' }],
    }));
    handlers.set('change.edit', async () => ({
      kind: 'raw',
      ok: true,
      refs: ['h:post-edit-hash'],
      summary: 'edit',
      content: { status: 'ok', drafts: [{ file: 'src/foo.ts', content_hash: 'post-edit-hash' }] },
    }));
    handlers.set('verify.build', verifySpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { type: 'full', file_paths: ['src/foo.ts'] } },
        { id: 'edit', use: 'change.edit', with: { file: 'src/foo.ts', line_edits: [{ line: 1, action: 'delete' }] }, out: 'editOut' },
        {
          id: 'verify',
          use: 'verify.build',
          in: { refs: { bind: 'editOut' } },
          with: {},
        },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(verifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ hashes: ['h:post-edit-hash'] }),
      expect.anything(),
      'verify',
    );
  });

  it('skips step when if step_ok condition fails', async () => {
    const verifySpy = vi.fn();

    handlers.set('change.edit', async () => raw('failed', { status: 'error' }, false));
    handlers.set('verify.build', verifySpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'edit', use: 'change.edit', with: { file: 'x.ts', line_edits: [{ line: 1, action: 'delete' }] } },
        { id: 'verify', use: 'verify.build', if: { step_ok: 'edit' }, with: {} },
      ],
    }, makeCtx());

    // edit ran (failed), verify skipped due to step_ok: 'edit' false
    expect(result.step_results.length).toBeGreaterThanOrEqual(1);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('honors max_steps and stops before exceeding', async () => {
    const callOrder: string[] = [];

    handlers.set('read.context', async () => {
      callOrder.push('read');
      return raw('read', { results: [{ file: 'x', content_hash: 'h' }] });
    });
    handlers.set('change.edit', async () => {
      callOrder.push('edit');
      return raw('applied', { status: 'ok' });
    });

    const result = await executeUnifiedBatch({
      version: '1.0',
      policy: { max_steps: 2 },
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['a.ts'] } },
        { id: 'e1', use: 'change.edit', with: { file: 'a.ts', line_edits: [{ line: 1, action: 'delete' }] } },
        { id: 'r2', use: 'read.context', with: { type: 'full', file_paths: ['b.ts'] } },
        { id: 'e2', use: 'change.edit', with: { file: 'b.ts', line_edits: [{ line: 1, action: 'delete' }] } },
      ],
    }, makeCtx());

    // With max_steps=2, r1 and e1 execute (indices 0,1), then r2 (index 2) exceeds budget and triggers break.
    expect(result.ok).toBe(false);
    expect(result.step_results).toHaveLength(3); // r1, e1, r2-skipped (break after first skip)
    expect(callOrder).toEqual(['read', 'edit']);
  });

  it('failed refactor with on_error:rollback still injects change.rollback (no batch interruption)', async () => {
    const rollbackSpy = vi.fn(async () => raw('rolled back', { ok: true }));

    handlers.set('change.refactor', async () =>
      raw('paused', {
        status: 'paused',
        _rollback: { restore: ['src/a.ts'], delete: [] },
        _next: 'Fix and resume',
      }, false),
    );
    handlers.set('change.rollback', rollbackSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      policy: { rollback_on_failure: true },
      steps: [
        { id: 'refactor', use: 'change.refactor', with: {}, on_error: 'rollback' },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.interruption).toBeUndefined();
    expect(rollbackSpy).toHaveBeenCalled();
  });

  it('injects change.rollback after a failing step when on_error is rollback, policy allows it, and a prior change step exposed _rollback', async () => {
    const rollbackSpy = vi.fn(async () => raw('rolled back', { ok: true }));

    handlers.set('change.refactor', async () =>
      raw('extract ok', {
        status: 'success',
        _rollback: { restore: [{ file: 'src/a.py', hash: 'h:abc123' }], delete: ['src/b.py'] },
      }),
    );
    handlers.set('verify.build', async () => raw('verify failed', { error: 'lint' }, false));
    handlers.set('change.rollback', rollbackSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { rollback_on_failure: true },
        steps: [
          { id: 'extract', use: 'change.refactor', with: {} },
          { id: 'verify', use: 'verify.build', with: {}, on_error: 'rollback' },
        ],
      },
      makeCtx(),
    );

    expect(rollbackSpy).toHaveBeenCalledOnce();
    expect(rollbackSpy.mock.calls[0]![0]).toMatchObject({
      restore: [{ file: 'src/a.py', hash: 'h:abc123' }],
      delete: ['src/b.py'],
    });
    const rollbackStep = result.step_results.find((r) => r.id === 'verify__rollback');
    expect(rollbackStep?.use).toBe('change.rollback');
    expect(rollbackStep?.ok).toBe(true);
  });

  it('does not inject change.rollback when rollback_on_failure is false even if on_error is rollback', async () => {
    const rollbackSpy = vi.fn();

    handlers.set('change.refactor', async () =>
      raw('extract ok', {
        status: 'success',
        _rollback: { restore: [{ file: 'src/a.py', hash: 'h:x' }] },
      }),
    );
    handlers.set('verify.build', async () => raw('verify failed', { error: 'lint' }, false));
    handlers.set('change.rollback', rollbackSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { rollback_on_failure: false },
        steps: [
          { id: 'extract', use: 'change.refactor', with: {} },
          { id: 'verify', use: 'verify.build', with: {}, on_error: 'rollback' },
        ],
      },
      makeCtx(),
    );

    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(result.step_results.some((r) => r.id === 'verify__rollback')).toBe(false);
  });

  it('does not inject change.rollback when no prior change step produced _rollback.restore', async () => {
    const rollbackSpy = vi.fn();

    handlers.set('change.edit', async () => raw('edited', { status: 'ok' }));
    handlers.set('verify.build', async () => raw('verify failed', { error: 'lint' }, false));
    handlers.set('change.rollback', rollbackSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { rollback_on_failure: true },
        steps: [
          {
            id: 'edit',
            use: 'change.edit',
            with: { file: 'x.ts', line_edits: [{ line: 1, action: 'delete' }] },
          },
          { id: 'verify', use: 'verify.build', with: {}, on_error: 'rollback' },
        ],
      },
      makeCtx(),
    );

    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(result.step_results).toHaveLength(2);
  });

  it('updates snapshotTracker after change.rollback — subsequent step sees restored hash', async () => {
    handlers.set('read.context', async () =>
      raw('read', {
        results: [{ file: 'src/a.py', content_hash: 'h:originalHash', content: 'x' }],
      }),
    );
    handlers.set('change.refactor', async () =>
      raw('refactored', {
        status: 'success',
        file: 'src/a.py',
        content_hash: 'h:newEditHash',
        _rollback: { restore: [{ file: 'src/a.py', hash: 'h:originalHash' }] },
      }),
    );
    handlers.set('verify.build', async () => raw('verify failed', { error: 'lint' }, false));
    handlers.set('change.rollback', async () =>
      raw('rolled back', { ok: true }),
    );

    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.content_hash).toBe('originalHash');
      return raw('post-rollback edit ok', { status: 'ok' });
    });
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { rollback_on_failure: true },
        steps: [
          { id: 'read', use: 'read.context', with: { type: 'full', file_paths: ['src/a.py'] } },
          { id: 'refactor', use: 'change.refactor', with: {} },
          { id: 'verify', use: 'verify.build', with: {}, on_error: 'rollback' },
          { id: 'post-edit', use: 'change.edit', with: { file: 'src/a.py', line_edits: [{ line: 1, action: 'delete' }] } },
        ],
      },
      makeCtx(),
    );

    expect(result.step_results.some((r) => r.id === 'verify__rollback')).toBe(true);
    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('clears hashManifest forward entry after change.rollback', async () => {
    const { getForwardMap, resetManifestState } = await import('../hashManifest');
    resetManifestState();

    handlers.set('read.context', async () =>
      raw('read', {
        results: [{ file: 'src/c.py', content_hash: 'h:origHashC12345', content: 'x' }],
      }),
    );
    handlers.set('change.refactor', async () =>
      raw('refactored', {
        status: 'success',
        file: 'src/c.py',
        content_hash: 'h:newHashC123456',
        _rollback: { restore: [{ file: 'src/c.py', hash: 'h:origHashC12345' }] },
      }),
    );
    handlers.set('verify.build', async () => raw('verify failed', { error: 'lint' }, false));
    handlers.set('change.rollback', async () =>
      raw('rolled back', { ok: true }),
    );

    await executeUnifiedBatch(
      {
        version: '1.0',
        policy: { rollback_on_failure: true },
        steps: [
          { id: 'read', use: 'read.context', with: { type: 'full', file_paths: ['src/c.py'] } },
          { id: 'refactor', use: 'change.refactor', with: {} },
          { id: 'verify', use: 'verify.build', with: {}, on_error: 'rollback' },
        ],
      },
      makeCtx(),
    );

    const forwardMap = getForwardMap();
    const hasStaleForward = Array.from(forwardMap.values()).some(
      (entry) => entry.source === 'src/c.py' && entry.newShortHash.startsWith('newHash'),
    );
    expect(hasStaleForward).toBe(false);

    resetManifestState();
  });

  it('normalizes path separators for snapshot lookup (backslash read vs forward edit)', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.content_hash).toBe('same-hash');
      return raw('applied', { status: 'ok' });
    });

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src\\foo.ts', content_hash: 'same-hash', content: 'x' }],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { type: 'full', file_paths: ['src/foo.ts'] } },
        { id: 'edit', use: 'change.edit', with: { file: 'src/foo.ts', line_edits: [{ line: 1, action: 'delete' }] } },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('continues on step failure when on_error is continue', async () => {
    const afterSpy = vi.fn(async () => raw('continued', { ok: true }));

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'x.ts', content_hash: 'hash-x' }],
    }));
    handlers.set('change.edit', async () => raw('failed', {}, false));
    handlers.set('session.emit', afterSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { type: 'full', file_paths: ['x.ts'] } },
        { id: 'edit', use: 'change.edit', with: { file: 'x.ts', line_edits: [{ line: 1, action: 'delete' }] }, on_error: 'continue' },
        { id: 'after', use: 'session.emit' },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.step_results).toHaveLength(3);
    expect(afterSpy).toHaveBeenCalled();
  });

  it('stops batch on step failure when on_error is stop', async () => {
    const afterSpy = vi.fn();

    handlers.set('change.edit', async () => raw('failed', { error: 'edit failed' }, false));
    handlers.set('session.emit', afterSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'edit', use: 'change.edit', with: { file: 'x.ts', line_edits: [{ line: 1, action: 'delete' }] }, on_error: 'stop' },
        { id: 'after', use: 'session.emit' },
      ],
    }, makeCtx());

    expect(result.ok).toBe(false);
    expect(afterSpy).not.toHaveBeenCalled();
    expect(result.step_results).toHaveLength(1);
  });

  it('long chain: read 5 files, batch_edits to all 5, each gets correct hash', async () => {
    const files = ['pkg/a.ts', 'pkg/b.ts', 'pkg/c.ts', 'pkg/d.ts', 'pkg/e.ts'];
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const edits = params.edits as Array<Record<string, unknown>>;
      expect(edits).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(edits[i].file).toBe(files[i]);
        expect(edits[i].content_hash).toBe(`hash-${files[i].replace('/', '-')}`);
      }
      return raw('batch ok', { status: 'ok' });
    });

    handlers.set('read.context', async () => raw('multi', {
      results: files.map(f => ({
        file: f,
        content_hash: `hash-${f.replace('/', '-')}`,
      })),
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { file_paths: files } },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            edits: files.map(f => ({
              file: f,
              line_edits: [{ line: 1, action: 'insert_before', content: `// ${f}` }],
            })),
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Hash freshness multiedit multibatch — ensures content_hash stays correct
// across sequential edits, batch_edits, and mixed read/edit chains. Critical
// for avoiding stale_hash errors when the same file is modified multiple
// times in one batch.
// ---------------------------------------------------------------------------

describe('executeUnifiedBatch hash freshness multiedit multibatch', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('sequential edits to same file: edit2 receives post-edit1 hash from drafts', async () => {
    const editCalls: Array<{ params: Record<string, unknown> }> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/impl.ts', content_hash: 'hash-v1', content: 'const x = 1;' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ params: { ...params } });
      if (editCalls.length === 1) {
        return { kind: 'raw', ok: true, refs: [], summary: 'applied', content: { status: 'ok', drafts: [{ file: 'src/impl.ts', content_hash: 'hash-v2' }] } };
      }
      return raw('applied', { status: 'ok' });
    });

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { type: 'full', file_paths: ['src/impl.ts'] } },
        { id: 'edit1', use: 'change.edit', with: { file: 'src/impl.ts', line_edits: [{ line: 1, action: 'replace', content: 'const x = 2;' }] } },
        { id: 'edit2', use: 'change.edit', with: { file: 'src/impl.ts', line_edits: [{ line: 2, action: 'insert_after', content: '// added' }] } },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editCalls).toHaveLength(2);
    expect(editCalls[0].params.content_hash).toBe('hash-v1');
    expect(editCalls[1].params.content_hash).toBe('hash-v2');
  });

  it('batch_edits: file A edited first, then batch to A+B — A gets post-edit hash, B gets read hash', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const edits = params.edits as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(edits) && edits.length === 2) {
        const aEntry = edits.find(e => (e.file ?? e.file_path) === 'src/a.ts');
        const bEntry = edits.find(e => (e.file ?? e.file_path) === 'src/b.ts');
        expect(aEntry?.content_hash).toBe('hash-a-post');
        expect(bEntry?.content_hash).toBe('hash-b-read');
        return raw('batch ok', { status: 'ok' });
      }
      return { kind: 'raw', ok: true, refs: [], summary: 'ok', content: { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-a-post' }] } };
    });

    handlers.set('read.context', async () => raw('read', {
      results: [
        { file: 'src/a.ts', content_hash: 'hash-a-read' },
        { file: 'src/b.ts', content_hash: 'hash-b-read' },
      ],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { file_paths: ['src/a.ts', 'src/b.ts'] } },
        { id: 'edit1', use: 'change.edit', with: { file: 'src/a.ts', line_edits: [{ line: 1, action: 'replace', content: 'a' }] } },
        {
          id: 'edit2',
          use: 'change.edit',
          with: {
            edits: [
              { file: 'src/a.ts', line_edits: [{ line: 2, action: 'insert_before', content: '// a2' }] },
              { file: 'src/b.ts', line_edits: [{ line: 1, action: 'insert_before', content: '// b' }] },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledTimes(2);
    const batchCall = editSpy.mock.calls.find(c => {
      const p = c[0] as Record<string, unknown>;
      return Array.isArray(p.edits) && p.edits.length === 2;
    });
    expect(batchCall).toBeDefined();
  });

  it('three sequential edits to same file: each receives hash from prior step', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', { results: [{ file: 'x.ts', content_hash: 'h1', content: 'a' }] }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      const n = editCalls.length;
      const nextHash = `h${n + 1}`;
      return { kind: 'raw', ok: true, refs: [], summary: 'ok', content: { status: 'ok', drafts: [{ file: 'x.ts', content_hash: nextHash }] } };
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r', use: 'read.context', with: { type: 'full', file_paths: ['x.ts'] } },
        { id: 'e1', use: 'change.edit', with: { file: 'x.ts', line_edits: [{ line: 1, action: 'replace', content: 'b' }] } },
        { id: 'e2', use: 'change.edit', with: { file: 'x.ts', line_edits: [{ line: 1, action: 'replace', content: 'c' }] } },
        { id: 'e3', use: 'change.edit', with: { file: 'x.ts', line_edits: [{ line: 1, action: 'replace', content: 'd' }] } },
      ],
    }, makeCtx());

    expect(editCalls[0].content_hash).toBe('h1');
    expect(editCalls[1].content_hash).toBe('h2');
    expect(editCalls[2].content_hash).toBe('h3');
  });

  it('edit fails (no drafts): subsequent edit to same file still gets read hash', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', { results: [{ file: 'f.ts', content_hash: 'h-initial', content: 'x' }] }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      if (editCalls.length === 1) {
        return raw('failed', { error: 'stale_hash' }, false);
      }
      return raw('applied', { status: 'ok' });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r', use: 'read.context', with: { type: 'full', file_paths: ['f.ts'] } },
        { id: 'e1', use: 'change.edit', with: { file: 'f.ts', line_edits: [{ line: 1, action: 'delete' }] }, on_error: 'continue' },
        { id: 'e2', use: 'change.edit', with: { file: 'f.ts', line_edits: [{ line: 1, action: 'replace', content: 'fixed' }] } },
      ],
    }, makeCtx());

    expect(editCalls[0].content_hash).toBe('h-initial');
    expect(editCalls[1].content_hash).toBe('h-initial');
  });

  it('batch with f/h alias: drafts use backend shorthand and tracker records correctly', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', { results: [{ file: 'src/foo.ts', content_hash: 'old-hash', content: 'x' }] }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      if (editCalls.length === 1) {
        return { kind: 'raw', ok: true, refs: [], summary: 'ok', content: { batch: [{ f: 'src/foo.ts', h: 'backend-hash' }] } };
      }
      return raw('ok', { status: 'ok' });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r', use: 'read.context', with: { type: 'full', file_paths: ['src/foo.ts'] } },
        { id: 'e1', use: 'change.edit', with: { file: 'src/foo.ts', line_edits: [{ line: 1, action: 'replace', content: 'y' }] } },
        { id: 'e2', use: 'change.edit', with: { file: 'src/foo.ts', line_edits: [{ line: 2, action: 'insert_after', content: 'z' }] } },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);
    expect(editCalls[0].content_hash).toBe('old-hash');
    expect(editCalls[1].content_hash).toBe('backend-hash');
  });
});

// ---------------------------------------------------------------------------
// Ref contamination prevention — ensures from_step/bind never leak content
// into params expecting hash refs when the source step has refs: [].
// ---------------------------------------------------------------------------

describe('executeUnifiedBatch ref contamination prevention', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('from_step without path returns undefined when prior step has refs:[] (no content leak)', async () => {
    const receivedParams: Array<Record<string, unknown>> = [];

    handlers.set('system.exec', async () => ({
      kind: 'raw' as const,
      ok: true,
      refs: [],
      summary: 'exec output',
      content: { stdout: 'leaked content that should not appear' },
    }));
    handlers.set('read.lines', async (params: Record<string, unknown>) => {
      receivedParams.push({ ...params });
      return { kind: 'file_refs' as const, ok: true, refs: ['h:abc123'], summary: 'ok' };
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'exec', use: 'system.exec', with: { cmd: 'echo hi' } },
        { id: 'read', use: 'read.lines', in: { ref: { from_step: 'exec' } }, with: { hash: 'h:abc123', lines: '1-10' } },
      ],
    }, makeCtx());

    expect(receivedParams[0].ref).toBeUndefined();
    expect(receivedParams[0].hash).toBe('h:abc123');
  });

  it('bind returns undefined when bound step has refs:[] (no content leak)', async () => {
    const receivedParams: Array<Record<string, unknown>> = [];

    handlers.set('session.emit', async () => ({
      kind: 'raw' as const,
      ok: true,
      refs: [],
      summary: 'emit done',
      content: { data: 'should not leak' },
    }));
    handlers.set('read.lines', async (params: Record<string, unknown>) => {
      receivedParams.push({ ...params });
      return { kind: 'file_refs' as const, ok: true, refs: ['h:def456'], summary: 'ok' };
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'emit', use: 'session.emit', out: 'emitOut' },
        { id: 'read', use: 'read.lines', in: { ref: { bind: 'emitOut' } }, with: { hash: 'h:def456', lines: '5-15' } },
      ],
    }, makeCtx());

    expect(receivedParams[0].ref).toBeUndefined();
    expect(receivedParams[0].hash).toBe('h:def456');
  });

  it('from_step with explicit path still extracts content correctly', async () => {
    const receivedParams: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => ({
      kind: 'file_refs' as const,
      ok: true,
      refs: ['h:aaa111'],
      summary: 'read',
      content: { results: [{ file: 'src/x.ts', content_hash: 'h123' }], edits: [{ file: 'src/x.ts', old: 'old', new: 'new' }] },
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      receivedParams.push({ ...params });
      return raw('applied', { status: 'ok' });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.context', with: { file_paths: ['src/x.ts'] } },
        {
          id: 'edit',
          use: 'change.edit',
          in: { edits: { from_step: 'read', path: 'content.edits' } },
          with: { file: 'src/x.ts' },
        },
      ],
    }, makeCtx());

    expect(receivedParams[0].edits).toEqual([
      expect.objectContaining({ file: 'src/x.ts', old: 'old', new: 'new' }),
    ]);
  });

  it('emits _binding_warning when from_step resolves to nothing', async () => {
    const receivedParams: Array<Record<string, unknown>> = [];

    handlers.set('system.exec', async () => ({
      kind: 'raw' as const,
      ok: true,
      refs: [],
      summary: 'done',
    }));
    handlers.set('read.lines', async (params: Record<string, unknown>) => {
      receivedParams.push({ ...params });
      return { kind: 'file_refs' as const, ok: true, refs: ['h:abc123'], summary: 'ok' };
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'exec', use: 'system.exec', with: { cmd: 'test' } },
        { id: 'read', use: 'read.lines', in: { ref: { from_step: 'exec' } }, with: { hash: 'h:abc123', lines: '1-5' } },
      ],
    }, makeCtx());

    expect(receivedParams[0]._binding_warning_ref).toMatch(/resolved to nothing/);
  });

  it('skips change.edit when in.file_path from_step resolves to nothing (search slot beyond hits)', async () => {
    const editSpy = vi.fn();

    handlers.set('search.code', async () => ({
      kind: 'search_results' as const,
      ok: true,
      refs: ['h:search1'],
      summary: 'search',
      content: { file_paths: ['a.ts'], lines: [1] },
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 's1', use: 'search.code', with: { queries: ['x'] } },
        {
          id: 'e2',
          use: 'change.edit',
          with: { line_edits: [{ line: 1, action: 'replace', content: 'y' }] },
          in: {
            file_path: { from_step: 's1', path: 'content.file_paths.1' },
            line: { from_step: 's1', path: 'content.lines.1' },
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).not.toHaveBeenCalled();
    const e2 = result.step_results.find(r => r.id === 'e2');
    expect(e2?.ok).toBe(true);
    expect(e2?.summary).toContain('SKIPPED');
    expect(e2?.summary).toContain('file_path');
  });

  it('change.edit binds content.lines.0 and content.lines.1 from same search step', async () => {
    const editSpy = vi.fn();

    handlers.set('search.code', async () => ({
      kind: 'search_results' as const,
      ok: true,
      refs: ['h:search1'],
      summary: 'search',
      content: { file_paths: ['a.ts', 'a.ts'], lines: [1, 5] },
    }));
    handlers.set('change.edit', async (params) => {
      editSpy(params);
      return raw('ok', { drafts: [{ file: 'a.ts', content_hash: 'h1' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 's1', use: 'search.code', with: { queries: ['x'] } },
        {
          id: 'e0',
          use: 'change.edit',
          with: { file_path: 'a.ts', line_edits: [{ action: 'replace', content: 'y' }] },
          in: { line: { from_step: 's1', path: 'content.lines.0' } },
        },
        {
          id: 'e1',
          use: 'change.edit',
          with: { file_path: 'a.ts', line_edits: [{ action: 'replace', content: 'z' }] },
          in: { line: { from_step: 's1', path: 'content.lines.1' } },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledTimes(2);
    expect((editSpy.mock.calls[0][0] as Record<string, unknown>).line).toBe(1);
    expect((editSpy.mock.calls[1][0] as Record<string, unknown>).line).toBe(5);
  });

  it('evicts mutation-sensitive retention entries after successful change.edit', async () => {
    const { useRetentionStore } = await import('../../stores/retentionStore');
    useRetentionStore.getState().reset();
    useRetentionStore.getState().recordResult('verify:verify.build', 'h1', true);
    useRetentionStore.getState().recordResult('exec:npm run build', 'h2', true);
    useRetentionStore.getState().recordResult('search.code:auth', 'h3', true);

    handlers.set('change.edit', async () => raw('applied', { drafts: [{ file: 'src/x.ts', h: 'h:new1' }] }));

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'e1', use: 'change.edit', with: { file: 'src/x.ts', line_edits: [{ line: 1, action: 'delete' }] } },
      ],
    }, makeCtx());

    expect(useRetentionStore.getState().getEntry('verify:verify.build')).toBeNull();
    expect(useRetentionStore.getState().getEntry('exec:npm run build')).toBeNull();
    // search.code is NOT mutation-sensitive — should survive
    expect(useRetentionStore.getState().getEntry('search.code:auth')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inter-step rebase: move and replace_body — P0 regression tests.
// Validates that rebaseSubsequentSteps correctly shifts line numbers in
// step 2 after step 1 uses move or replace_body on the same file.
// ---------------------------------------------------------------------------

describe('executeUnifiedBatch inter-step rebase for move and replace_body', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('move-down: step1 moves lines 5-7 to dest 15, step2 line 12 shifts correctly', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 5, end_line: 7, action: 'move', destination: 15 }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 12, action: 'replace', content: 'changed' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);
    // Move lines 5-7 (3 lines) to dest 15:
    // - Source at 5: delta -3 → lines >=5 shift down by 3
    // - Effective dest: dest > source+1 → 15 - 3 = 12; delta +3 → lines >=12 shift up by 3
    // Original line 12: shift from source (5 < 12 → -3), shift from dest (12 >= 12 → +3) = net 0
    // BUT the positional model applies: d.line < targetLine for each delta entry
    // Source delta at orig line 5, delta -3: 5 < 12 → applies → shift = -3
    // Dest delta at orig line 12, delta +3: 12 < 12 is false → does NOT apply → shift stays -3
    // So line 12 → 12 + (-3) = 9
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    expect(le2[0].line).toBe(9);
  });

  it('move-up: step1 moves lines 15-17 to dest 5, step2 line 10 shifts correctly', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 15, end_line: 17, action: 'move', destination: 5 }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 10, action: 'replace', content: 'changed' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);
    // Move lines 15-17 (3 lines) to dest 5 (move up):
    // - Source at 15: delta -3
    // - Effective dest: dest <= source → dest = 5; delta +3
    // Original line 10: source delta at 15, -3: 15 < 10 is false → does not apply
    //                    dest delta at 5, +3: 5 < 10 → applies → shift = +3
    // So line 10 → 10 + 3 = 13
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    expect(le2[0].line).toBe(13);
  });

  it('move does not shift lines outside affected range', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 5, end_line: 7, action: 'move', destination: 15 }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 2, action: 'replace', content: 'unchanged' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);
    // Line 2 is before the source (5) — no delta applies
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    expect(le2[0].line).toBe(2);
  });

  it('replace_body with _resolved_body_span: step2 line shifted by body delta', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{
              line: 5, action: 'replace_body',
              content: 'line1\nline2\nline3',
              _resolved_body_span: 10,
            }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 20, action: 'replace', content: 'changed' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);
    // replace_body at line 5 with _resolved_body_span=10, content has 3 lines
    // delta = 3 - 10 = -7, applied at line 5
    // Line 20: 5 < 20 → delta -7 applies → 20 + (-7) = 13
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    expect(le2[0].line).toBe(13);
  });

  it('intra-step: move within same step shifts subsequent edits', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le).toHaveLength(2);
      // Move lines 5-7 (3 lines) to dest 15:
      // Intra-step: edit[0] is move at snap 5, dest 15
      // Subsequent edit at snap 10: source < target (5 < 10) → -3; effectiveDest = 15-3=12 < 10? no → shift = -3
      // So line 10 → 10 + (-3) = 7
      expect(le[1].line).toBe(7);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [
              { line: 5, end_line: 7, action: 'move', destination: 15 },
              { line: 10, action: 'replace', content: 'x' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('intra-step: move source after subsequent snap but dest before — insertion shift applies', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le).toHaveLength(2);
      // Move 45-50 (6 lines) to dest 5. Subsequent edit at snap 20:
      // Source removal at 45 does not shift 20 (45 < 20 is false).
      // Insertion at effective dest 5 does (5 < 20) → +6 → 20 + 6 = 26.
      expect(le[1].line).toBe(26);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [
              { line: 45, end_line: 50, action: 'move', destination: 5 },
              { line: 20, action: 'replace', content: 'x' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('cross-step: delete in step1 shifts move destination in step2', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 10, end_line: 14, action: 'delete' }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 5, end_line: 7, action: 'move', destination: 30 }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);
    // Step 1 deletes lines 10-14 (5 lines, delta -5 at original line 10).
    // Step 2 move: line 5 is before deletion (10 < 5 is false) → no shift → stays 5.
    // destination 30: 10 < 30 → delta -5 applies → 30 - 5 = 25.
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    expect(le2[0].line).toBe(5);
    expect(le2[0].destination).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Adversarial stress — tries to break read-range gate, rebasing, path keys.
// Some tests document known gaps (e.g. batch_edits without top-level file).
// ---------------------------------------------------------------------------

describe('executeUnifiedBatch line-edit pipeline stress', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('documents gap: batch_edits has no top-level file so read-range gate is skipped', async () => {
    const editSpy = vi.fn(async () => raw('batch', { status: 'ok', mode: 'batch_edits' }));
    handlers.set('read.lines', async () => raw('rl', {
      file: 'src/only-read.ts',
      content_hash: 'h1',
      content: 'x',
      actual_range: [[1, 2]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/only-read.ts', lines: '1-2' } },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            mode: 'batch_edits',
            edits: [
              { file: 'src/never-read.ts', line_edits: [{ line: 500, action: 'replace', content: 'z' }] },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('non-numeric line anchors skip per-edit gate checks (e.g. string end)', async () => {
    const editSpy = vi.fn(async () => raw('ok', { status: 'ok' }));
    handlers.set('read.lines', async () => raw('rl', {
      file: 'src/narrow.ts',
      content_hash: 'h1',
      content: 'one line only',
      actual_range: [[1, 1]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/narrow.ts', lines: '1-1' } },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/narrow.ts',
            line_edits: [{ line: 'end' as unknown as number, action: 'insert_before', content: '// tail' }],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it('normalizes path keys: read.lines file vs edit file casing differ', async () => {
    const editSpy = vi.fn(async () => raw('ok', { status: 'ok' }));
    handlers.set('read.lines', async () => raw('rl', {
      file: 'src/Case/File.TS',
      content_hash: 'h1',
      content: 'x',
      actual_range: [[1, 10]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/Case/File.TS', lines: '1-10' } },
        { id: 'edit', use: 'change.edit', with: { file: 'SRC/case/file.ts', line_edits: [{ line: 5, action: 'replace', content: 'y' }] } },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('intra-step chain: insert + delete + replace + move rebases to sequential coordinates', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      expect(le).toHaveLength(4);
      expect(le[0].line).toBe(4);
      expect(le[1].line).toBe(2);
      expect(le[2].line).toBe(11);
      expect(le[3].line).toBe(6);
      return raw('ok', { status: 'ok' });
    });
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/chain.ts',
            line_edits: [
              { line: 4, action: 'insert_before', content: 'new\n' },
              { line: 3, action: 'delete' },
              { line: 10, action: 'replace', content: 'R' },
              { line: 5, end_line: 7, action: 'move', destination: 12 },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).toHaveBeenCalledOnce();
  });

  it('inter-step: four edits on same file rebase later steps', async () => {
    const calls: number[][] = [];
    handlers.set('read.context', async () => raw('rc', {
      results: [{ file: 'src/stack.ts', content_hash: 'v0', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      calls.push(le.map(e => e.line as number));
      return raw('ok', { status: 'ok', drafts: [{ file: 'src/stack.ts', content_hash: `v${calls.length}` }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r', use: 'read.context', with: { file_paths: ['src/stack.ts'] } },
        { id: 'e1', use: 'change.edit', with: { file: 'src/stack.ts', line_edits: [{ line: 2, action: 'insert_before', content: 'a\n' }] } },
        { id: 'e2', use: 'change.edit', with: { file: 'src/stack.ts', line_edits: [{ line: 5, action: 'delete' }] } },
        { id: 'e3', use: 'change.edit', with: { file: 'src/stack.ts', line_edits: [{ line: 8, action: 'replace', content: 'z' }] } },
        { id: 'e4', use: 'change.edit', with: { file: 'src/stack.ts', line_edits: [{ line: 1, action: 'insert_before', content: '// h\n' }] } },
      ],
    }, makeCtx());

    expect(calls).toHaveLength(4);
    expect(calls[1][0]).toBe(6);
    expect(calls[2][0]).toBe(8);
    expect(calls[3][0]).toBe(1);
  });

  it('inter-step insert_before shifts a future step that targets the same line number', async () => {
    const calls: number[] = [];
    handlers.set('read.context', async () => raw('rc', {
      results: [{ file: 'src/a.ts', content_hash: 'v0', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      const le = params.line_edits as Array<Record<string, unknown>>;
      calls.push(le[0].line as number);
      return raw('ok', { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'v1' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r', use: 'read.context', with: { file_paths: ['src/a.ts'] } },
        { id: 'e1', use: 'change.edit', with: { file: 'src/a.ts', line_edits: [{ line: 10, action: 'insert_before', content: '//\n' }] } },
        { id: 'e2', use: 'change.edit', with: { file: 'src/a.ts', line_edits: [{ line: 10, action: 'replace', content: 'z' }] } },
      ],
    }, makeCtx());

    expect(calls).toEqual([10, 11]);
  });

  it('rejects when one numeric edit is out of range even if another uses end anchor', async () => {
    const editSpy = vi.fn(async () => raw('ok', { status: 'ok' }));
    handlers.set('read.lines', async () => raw('rl', {
      file: 'src/mixed.ts',
      content_hash: 'h1',
      content: 'x',
      actual_range: [[2, 3]],
    }));
    handlers.set('change.edit', editSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'read', use: 'read.lines', with: { file_path: 'src/mixed.ts', lines: '2-3' } },
        {
          id: 'edit',
          use: 'change.edit',
          with: {
            file: 'src/mixed.ts',
            line_edits: [
              { line: 'end' as unknown as number, action: 'insert_before', content: '// ok' },
              { line: 99, action: 'replace', content: 'bad' },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('inter-step rebase shifts end_line alongside line when prior edit adds lines', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 10, end_line: 20, action: 'replace', content: Array(30).fill('x').join('\n') }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 50, end_line: 60, action: 'replace', content: 'changed' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    // e1 replaced 11 lines (10-20) with 30 lines → net +19
    // delta at original line 10, delta +19
    // line 50: d.line (10) < 50 → shift +19 → 69
    // end_line 60: d.line (10) < 60 → shift +19 → 79
    expect(le2[0].line).toBe(69);
    expect(le2[0].end_line).toBe(79);
  });

  it('inter-step rebase shifts end_line when prior edit deletes lines', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }] });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 5, end_line: 15, action: 'replace', content: 'single' }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 30, end_line: 40, action: 'replace', content: 'changed' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    // e1 replaced 11 lines (5-15) with 1 line → net -10
    // delta at original line 5, delta -10
    // line 30: d.line (5) < 30 → shift -10 → 20
    // end_line 40: d.line (5) < 40 → shift -10 → 30
    expect(le2[0].line).toBe(20);
    expect(le2[0].end_line).toBe(30);
  });

  it('inter-step rebase shifts line numbers but preserves content_hash from tracker', async () => {
    // Contract test: rebaseSubsequentSteps modifies line/end_line but does NOT
    // touch content_hash. The executor's injectSnapshotHashes fills content_hash
    // from the tracker (which holds the post-edit hash after step 1 completes).
    // This prevents Rust line_remap from double-adjusting coordinates.
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/f.ts', content_hash: 'hash-original', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push({ ...params });
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/f.ts', content_hash: 'hash-after-step1' }],
      });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/f.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/f.ts',
            line_edits: [{ line: 10, end_line: 20, action: 'replace', content: Array(30).fill('x').join('\n') }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/f.ts',
            line_edits: [{ line: 50, action: 'replace', content: 'changed' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);

    // Step 2 params: line should be rebased (50 + 19 = 69)
    const step2Params = editCalls[1] as Record<string, unknown>;
    const le2 = step2Params.line_edits as Array<Record<string, unknown>>;
    expect(le2[0].line).toBe(69);

    // content_hash should be the POST-edit hash from step 1 (injected by tracker),
    // NOT the original model hash. When Rust sees this hash matches the current file,
    // it skips line_remap entirely — no double-adjustment.
    expect(step2Params.content_hash).toBe('hash-after-step1');
  });
});

// ---------------------------------------------------------------------------
// Inter-step rebase: batch_edits mode — validates that rebaseSubsequentSteps
// correctly builds per-file delta maps from batch_edits entries and applies
// shifts to both single-file and nested batch_edits future steps.
// ---------------------------------------------------------------------------

describe('executeUnifiedBatch inter-step rebase for batch_edits mode', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('batch_edits step followed by single-file step: lines are rebased', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [
        { file: 'src/a.ts', content_hash: 'hash-a1', content: 'x' },
        { file: 'src/b.ts', content_hash: 'hash-b1', content: 'y' },
      ],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        mode: 'batch_edits',
        drafts: [
          { file: 'src/a.ts', content_hash: 'hash-a2' },
          { file: 'src/b.ts', content_hash: 'hash-b2' },
        ],
      });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts', 'src/b.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            mode: 'batch_edits',
            edits: [
              {
                file: 'src/a.ts',
                line_edits: [{ line: 5, action: 'insert_before', content: 'new1\nnew2\nnew3' }],
              },
              {
                file: 'src/b.ts',
                line_edits: [{ line: 10, end_line: 15, action: 'delete' }],
              },
            ],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 20, action: 'replace', content: 'changed-a' }],
          },
        },
        {
          id: 'e3', use: 'change.edit', with: {
            file: 'src/b.ts',
            line_edits: [{ line: 30, end_line: 35, action: 'replace', content: 'changed-b' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(3);

    // e1 inserted 3 lines at line 5 in src/a.ts → delta +3 at line 5
    // e2 targets src/a.ts line 20: 5 < 20 → shift +3 → line 23
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    expect(le2[0].line).toBe(23);

    // e1 deleted 6 lines (10-15) in src/b.ts → delta -6 at line 10
    // e3 targets src/b.ts line 30: 10 < 30 → shift -6 → line 24; end_line 35 → 29
    const le3 = (editCalls[2] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    expect(le3[0].line).toBe(24);
    expect(le3[0].end_line).toBe(29);
  });

  it('batch_edits step followed by another batch_edits step: nested edits rebased', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [
        { file: 'src/a.ts', content_hash: 'hash-a1', content: 'x' },
        { file: 'src/b.ts', content_hash: 'hash-b1', content: 'y' },
      ],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        mode: 'batch_edits',
        drafts: [
          { file: 'src/a.ts', content_hash: 'hash-a2' },
          { file: 'src/b.ts', content_hash: 'hash-b2' },
        ],
      });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts', 'src/b.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            mode: 'batch_edits',
            edits: [
              {
                file: 'src/a.ts',
                line_edits: [{ line: 10, action: 'insert_before', content: 'x1\nx2\nx3\nx4\nx5' }],
              },
            ],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            mode: 'batch_edits',
            edits: [
              {
                file: 'src/a.ts',
                line_edits: [{ line: 25, action: 'replace', content: 'replaced' }],
              },
              {
                file: 'src/b.ts',
                line_edits: [{ line: 8, action: 'replace', content: 'untouched' }],
              },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);

    // e1 inserted 5 lines at line 10 in src/a.ts → delta +5 at line 10
    // e2 nested edits: src/a.ts line 25 → 10 < 25 → shift +5 → 30
    const e2Edits = (editCalls[1] as Record<string, unknown>).edits as Array<Record<string, unknown>>;
    const leA = e2Edits[0].line_edits as Array<Record<string, unknown>>;
    expect(leA[0].line).toBe(30);

    // e2 nested edits: src/b.ts line 8 — not touched by e1 → stays 8
    const leB = e2Edits[1].line_edits as Array<Record<string, unknown>>;
    expect(leB[0].line).toBe(8);
  });

  it('replace_body without _resolved_body_span uses edits_resolved backfill', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }],
        edits_resolved: [{ resolved_line: 5, action: 'replace_body', lines_affected: 12 }],
      });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 5, action: 'replace_body', content: 'a\nb\nc' }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 30, action: 'replace', content: 'changed' }],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);

    // replace_body at line 5: content has 3 lines, body span was 12 (from edits_resolved)
    // delta = 3 - 12 = -9 at line 5
    // e2 line 30: 5 < 30 → shift -9 → 21
    const le2 = (editCalls[1] as Record<string, unknown>).line_edits as Array<Record<string, unknown>>;
    expect(le2[0].line).toBe(21);
  });

  it('single-file step followed by batch_edits step: nested edits on same file rebased', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/a.ts', content_hash: 'hash-v1', content: 'x' }],
    }));
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/a.ts', content_hash: 'hash-v2' }],
      });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.context', with: { type: 'full', file_paths: ['src/a.ts'] } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/a.ts',
            line_edits: [{ line: 5, end_line: 14, action: 'delete' }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            mode: 'batch_edits',
            edits: [
              {
                file: 'src/a.ts',
                line_edits: [{ line: 40, end_line: 45, action: 'replace', content: 'new' }],
              },
            ],
          },
        },
      ],
    }, makeCtx());

    expect(editCalls).toHaveLength(2);

    // e1 deleted 10 lines (5-14) in src/a.ts → delta -10 at line 5
    // e2 nested edits: src/a.ts line 40 → 5 < 40 → shift -10 → 30; end_line 45 → 35
    const e2Edits = (editCalls[1] as Record<string, unknown>).edits as Array<Record<string, unknown>>;
    const leA = e2Edits[0].line_edits as Array<Record<string, unknown>>;
    expect(leA[0].line).toBe(30);
    expect(leA[0].end_line).toBe(35);
  });
});

// ---------------------------------------------------------------------------
// recordRevisionAdvance for change step outputs
// ---------------------------------------------------------------------------

describe('recordRevisionAdvance on change step outputs', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('calls recordRevisionAdvance for each file in drafts/results/batch arrays', async () => {
    const revAdvanceSpy = vi.fn();
    const ctx = makeCtx();
    const origStore = ctx.store;
    ctx.store = () => ({ ...origStore(), recordRevisionAdvance: revAdvanceSpy });
    ctx.sessionId = 'sess-1';

    handlers.set('change.edit', async () =>
      raw('edit ok', {
        drafts: [{ file: 'src/a.ts', content_hash: 'hash-a' }],
        results: [{ file: 'src/b.ts', hash: 'hash-b' }],
      }),
    );

    await executeUnifiedBatch(
      { version: '1.0', steps: [{ id: 'e1', use: 'change.edit' }] },
      ctx,
    );

    const calls = revAdvanceSpy.mock.calls.map(
      ([path, rev, cause, sid]: [string, string, string, string | undefined]) =>
        ({ path, rev, cause, sid }),
    );
    expect(calls).toContainEqual({ path: 'src/a.ts', rev: 'hash-a', cause: 'same_file_prior_edit', sid: 'sess-1' });
    expect(calls).toContainEqual({ path: 'src/b.ts', rev: 'hash-b', cause: 'same_file_prior_edit', sid: 'sess-1' });
  });

  it('calls recordRevisionAdvance for top-level file+hash', async () => {
    const revAdvanceSpy = vi.fn();
    const ctx = makeCtx();
    const origStore = ctx.store;
    ctx.store = () => ({ ...origStore(), recordRevisionAdvance: revAdvanceSpy });
    ctx.sessionId = null;

    handlers.set('change.create', async () =>
      raw('created', { file: 'src/new.ts', content_hash: 'hash-new' }),
    );

    await executeUnifiedBatch(
      { version: '1.0', steps: [{ id: 'c1', use: 'change.create' }] },
      ctx,
    );

    const calls = revAdvanceSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls).toContainEqual(['src/new.ts', 'hash-new', 'same_file_prior_edit', undefined]);
  });

  it('does not call recordRevisionAdvance for non-change steps', async () => {
    const revAdvanceSpy = vi.fn();
    const ctx = makeCtx();
    const origStore = ctx.store;
    ctx.store = () => ({ ...origStore(), recordRevisionAdvance: revAdvanceSpy });

    handlers.set('read.context', async () =>
      raw('read ok', { results: [{ file: 'src/r.ts', content_hash: 'hash-r' }] }),
    );

    await executeUnifiedBatch(
      { version: '1.0', steps: [{ id: 'r1', use: 'read.context' }] },
      ctx,
    );

    expect(revAdvanceSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rebaseRegionsByDeltas — same positional math as applyDeltasToLineEdits,
// applied to read-coverage regions for the slim-ack rebase path.
// ---------------------------------------------------------------------------

describe('slim-ack rebase — end-of-batch awareness flush', () => {
  // appStore.setSettings persists to localStorage; stub under vitest node env.
  beforeAll(() => {
    if (typeof (globalThis as { localStorage?: Storage }).localStorage === 'undefined') {
      const store: Record<string, string> = {};
      (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
        key: (i: number) => Object.keys(store)[i] ?? null,
        get length() { return Object.keys(store).length; },
      } satisfies Storage;
    }
  });

  beforeEach(() => {
    handlers.clear();
    useAppStore.getState().setSettings({ compressEditAcks: false });
  });

  afterEach(() => {
    useAppStore.getState().setSettings({ compressEditAcks: false });
  });

  function makeCtxWithSeededAwareness() {
    const base = makeCtx();
    const preSeeded = new Map<string, Record<string, unknown>>();
    preSeeded.set('src/f.ts', {
      filePath: 'src/f.ts',
      snapshotHash: 'hash-before',
      level: AwarenessLevel.CANONICAL,
      readRegions: [{ start: 1, end: 10 }],
      shapeHash: undefined,
      recordedAt: 0,
    });
    const setAwarenessCalls: Array<Record<string, unknown>> = [];
    return {
      ...base,
      store: () => ({
        ...base.store(),
        getAwarenessCache: () => preSeeded,
        setAwareness: (entry: Record<string, unknown>) => {
          setAwarenessCalls.push(entry);
          preSeeded.set(entry.filePath as string, entry);
        },
      }),
      _calls: setAwarenessCalls,
    } as ReturnType<typeof makeCtx> & { _calls: Array<Record<string, unknown>> };
  }

  it('compressEditAcks OFF (default): edited file flushed with level NONE and empty regions', async () => {
    const ctx = makeCtxWithSeededAwareness();

    handlers.set('change.edit', async () =>
      raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/f.ts', content_hash: 'hash-after' }],
        edits_resolved: [{ resolved_line: 5, action: 'insert_after', lines_affected: 2 }],
      }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [{
        id: 'e1', use: 'change.edit', with: {
          file: 'src/f.ts',
          content_hash: 'hash-before',
          line_edits: [{ line: 5, action: 'insert_after', content: 'new1\nnew2' }],
        },
      }],
    }, ctx);

    const fEntry = ctx._calls.find(c => c.filePath === 'src/f.ts');
    expect(fEntry).toBeDefined();
    expect(fEntry?.level).toBe(AwarenessLevel.NONE);
    expect(fEntry?.readRegions).toEqual([]);
  });

  it('compressEditAcks ON: edited file flushed with canonical level and rebased regions', async () => {
    useAppStore.getState().setSettings({ compressEditAcks: true });

    const ctx = makeCtxWithSeededAwareness();

    handlers.set('change.edit', async () =>
      raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/f.ts', content_hash: 'hash-after' }],
        edits_resolved: [{ resolved_line: 5, action: 'insert_after', lines_affected: 2 }],
      }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [{
        id: 'e1', use: 'change.edit', with: {
          file: 'src/f.ts',
          content_hash: 'hash-before',
          line_edits: [{ line: 5, action: 'insert_after', content: 'new1\nnew2' }],
        },
      }],
    }, ctx);

    const fEntry = ctx._calls.find(c => c.filePath === 'src/f.ts');
    expect(fEntry).toBeDefined();
    expect(fEntry?.level).toBe(AwarenessLevel.CANONICAL);
    // insert_after L5 with 2 content lines → +2 delta at line 5 (strict > 5)
    // region [1,10]: start=1 (5<1 false, no shift), end=10 (5<10 true, +2) → [1,12]
    expect(fEntry?.readRegions).toEqual([{ start: 1, end: 12 }]);
    expect(fEntry?.snapshotHash).toBe('hash-after');
  });

  it('compressEditAcks ON: non-edited files flush unchanged regardless of toggle', async () => {
    useAppStore.getState().setSettings({ compressEditAcks: true });

    const ctx = makeCtxWithSeededAwareness();
    // Also seed an unrelated file
    (ctx.store().getAwarenessCache() as Map<string, Record<string, unknown>>).set('src/other.ts', {
      filePath: 'src/other.ts',
      snapshotHash: 'other-hash',
      level: AwarenessLevel.CANONICAL,
      readRegions: [{ start: 1, end: 50 }],
      recordedAt: 0,
    });

    handlers.set('change.edit', async () =>
      raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/f.ts', content_hash: 'hash-after' }],
      }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [{
        id: 'e1', use: 'change.edit', with: {
          file: 'src/f.ts',
          content_hash: 'hash-before',
          line_edits: [{ line: 5, action: 'insert_after', content: 'x' }],
        },
      }],
    }, ctx);

    const otherEntry = ctx._calls.find(c => c.filePath === 'src/other.ts');
    expect(otherEntry?.level).toBe(AwarenessLevel.CANONICAL);
    expect(otherEntry?.readRegions).toEqual([{ start: 1, end: 50 }]);
  });
});

describe('rebaseRegionsByDeltas', () => {
  it('returns regions unchanged when deltas are empty', () => {
    const regions = [{ start: 1, end: 10 }];
    expect(rebaseRegionsByDeltas(regions, [])).toEqual(regions);
  });

  it('returns deltas unchanged when regions are empty', () => {
    expect(rebaseRegionsByDeltas([], [{ line: 5, delta: 2 }])).toEqual([]);
  });

  it('insert_after style (strict > anchor): shifts end when anchor < end, not start when anchor >= start', () => {
    // region [1,10], edit inserts 2 lines AFTER line 5 → end shifts +2 (5<10), start unchanged (5>=1 but !inclusive means 5<1 is false)
    const deltas: PositionalDelta[] = [{ line: 5, delta: 2 }];
    expect(rebaseRegionsByDeltas([{ start: 1, end: 10 }], deltas)).toEqual([{ start: 1, end: 12 }]);
  });

  it('insert_before style (inclusive at anchor): shifts both start and end when anchor <= boundary', () => {
    // region [5,10], insert_before at line 5 with +2 → start shifts +2, end shifts +2 → [7,12]
    const deltas: PositionalDelta[] = [{ line: 5, delta: 2, lineInclusive: true }];
    expect(rebaseRegionsByDeltas([{ start: 5, end: 10 }], deltas)).toEqual([{ start: 7, end: 12 }]);
  });

  it('delete shrinks region end when delete anchor < end', () => {
    // region [1,10], delete 3 lines starting at line 4 → end shifts -3 → [1,7]
    const deltas: PositionalDelta[] = [{ line: 4, delta: -3 }];
    expect(rebaseRegionsByDeltas([{ start: 1, end: 10 }], deltas)).toEqual([{ start: 1, end: 7 }]);
  });

  it('delete above region shifts both start and end', () => {
    // region [20,30], delete 5 lines at line 5 → both shift -5 → [15,25]
    const deltas: PositionalDelta[] = [{ line: 5, delta: -5 }];
    expect(rebaseRegionsByDeltas([{ start: 20, end: 30 }], deltas)).toEqual([{ start: 15, end: 25 }]);
  });

  it('cumulative deltas stack: multiple insertions below a region', () => {
    // region [50,60], +2 at L10, +3 at L20, +1 at L100 (last doesn't shift — 100 > 60)
    const deltas: PositionalDelta[] = [
      { line: 10, delta: 2 },
      { line: 20, delta: 3 },
      { line: 100, delta: 1 },
    ];
    expect(rebaseRegionsByDeltas([{ start: 50, end: 60 }], deltas)).toEqual([{ start: 55, end: 65 }]);
  });

  it('region whose start > anchor but end < anchor does not shift (anchor below region)', () => {
    // This shouldn't happen in practice, but we assert behavior: if anchor is below the region,
    // no shift occurs — only anchors at or before a boundary shift that boundary.
    const deltas: PositionalDelta[] = [{ line: 100, delta: 5 }];
    expect(rebaseRegionsByDeltas([{ start: 10, end: 20 }], deltas)).toEqual([{ start: 10, end: 20 }]);
  });

  it('drops a region whose end falls below start after a delete', () => {
    // region [5,6], delete 10 lines at line 1 → both shift -10 → [-5,-4] → dropped
    const deltas: PositionalDelta[] = [{ line: 1, delta: -10 }];
    expect(rebaseRegionsByDeltas([{ start: 5, end: 6 }], deltas)).toEqual([]);
  });

  it('drops a region whose start clamps below 1 after a large delete', () => {
    // region [2,10], delete 5 lines at line 1 → start=-3, end=5 → start<1 → dropped
    const deltas: PositionalDelta[] = [{ line: 1, delta: -5 }];
    expect(rebaseRegionsByDeltas([{ start: 2, end: 10 }], deltas)).toEqual([]);
  });

  it('handles multiple regions independently', () => {
    // Two regions; insert +2 at L5 only shifts the higher region.
    const deltas: PositionalDelta[] = [{ line: 5, delta: 2 }];
    expect(rebaseRegionsByDeltas([
      { start: 1, end: 3 },
      { start: 10, end: 20 },
    ], deltas)).toEqual([
      { start: 1, end: 3 },
      { start: 12, end: 22 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// rebaseHashRefLineRange — shift the A-B portion of h:HASH:A-B refs using
// the same positional-delta math applyDeltasToLineEdits / rebaseRegionsByDeltas
// use. Needed so step 2's f:"h:HASH:A-B" lines up with the file state that
// step 1 produced (Rust treats A-B as current-file line numbers).
// ---------------------------------------------------------------------------

describe('rebaseHashRefLineRange', () => {
  it('returns value unchanged when deltas are empty', () => {
    expect(rebaseHashRefLineRange('h:abc123:6-10', [])).toBe('h:abc123:6-10');
  });

  it('returns value unchanged when not a hash-ref', () => {
    const deltas: PositionalDelta[] = [{ line: 5, delta: 2 }];
    expect(rebaseHashRefLineRange('src/foo.ts', deltas)).toBe('src/foo.ts');
  });

  it('returns hash-ref without line range unchanged', () => {
    const deltas: PositionalDelta[] = [{ line: 5, delta: 2 }];
    expect(rebaseHashRefLineRange('h:abc123', deltas)).toBe('h:abc123');
  });

  it('returns value unchanged when anchor is above the range (no applicable shift)', () => {
    const deltas: PositionalDelta[] = [{ line: 100, delta: 5 }];
    expect(rebaseHashRefLineRange('h:abc123:6-10', deltas)).toBe('h:abc123:6-10');
  });

  it('insert_after style (strict): anchor < end shifts end only when anchor >= start', () => {
    // h:abc:6-10 + insert_after L5 with +2:
    //   start=6: 5<6 true → +2 = 8
    //   end=10:  5<10 true → +2 = 12
    //   → h:abc:8-12
    const deltas: PositionalDelta[] = [{ line: 5, delta: 2 }];
    expect(rebaseHashRefLineRange('h:abc123:6-10', deltas)).toBe('h:abc123:8-12');
  });

  it('insert_after mid-range: anchor inside range shifts end only', () => {
    // h:abc:6-10 + insert_after L7 with +3:
    //   start=6: 7<6 false → +0 = 6
    //   end=10:  7<10 true → +3 = 13
    //   → h:abc:6-13
    const deltas: PositionalDelta[] = [{ line: 7, delta: 3 }];
    expect(rebaseHashRefLineRange('h:abc123:6-10', deltas)).toBe('h:abc123:6-13');
  });

  it('insert_before style (inclusive): anchor at start shifts both', () => {
    // h:abc:6-10 + insert_before L6 with +2 (lineInclusive):
    //   start=6: 6<=6 true → +2 = 8
    //   end=10:  6<=10 true → +2 = 12
    const deltas: PositionalDelta[] = [{ line: 6, delta: 2, lineInclusive: true }];
    expect(rebaseHashRefLineRange('h:abc123:6-10', deltas)).toBe('h:abc123:8-12');
  });

  it('delete above the range shifts both', () => {
    // h:abc:20-30 + delete 5 lines at L5:
    //   start=20: 5<20 true → -5 = 15
    //   end=30:   5<30 true → -5 = 25
    const deltas: PositionalDelta[] = [{ line: 5, delta: -5 }];
    expect(rebaseHashRefLineRange('h:abc123:20-30', deltas)).toBe('h:abc123:15-25');
  });

  it('multiple ranges shift independently (h:HASH:A-B,C-D)', () => {
    // insert +2 at L5: first range fully above → shifts both; second range starts at 10 → also shifts both
    const deltas: PositionalDelta[] = [{ line: 5, delta: 2 }];
    expect(rebaseHashRefLineRange('h:abc123:6-8,10-15', deltas)).toBe('h:abc123:8-10,12-17');
  });

  it('reproduces the demo-trace scenario (e1 +2 delta shifts e2 target)', () => {
    // Round 5 e1 replaced 5 lines with 7 lines at L6 (insert_after-equivalent, delta +2 at line 6).
    // e2 used f:"h:53e378:12-14" expecting greetUser. After rebase, target shifts to L14-16.
    const deltas: PositionalDelta[] = [{ line: 6, delta: 2 }];
    expect(rebaseHashRefLineRange('h:53e378:12-14', deltas)).toBe('h:53e378:14-16');
  });

  it('clamps rebased start to >= 1 after a large delete above', () => {
    // h:abc:2-8 + delete 10 at L1:
    //   start=2: 1<2 true → -10 = -8 → clamp 1
    //   end=8:   1<8 true → -10 = -2 → clamp max(newStart, 1) = 1
    const deltas: PositionalDelta[] = [{ line: 1, delta: -10 }];
    expect(rebaseHashRefLineRange('h:abc123:2-8', deltas)).toBe('h:abc123:1-1');
  });

  it('leaves shaped refs (h:HASH:sig, h:HASH:fold) untouched', () => {
    const deltas: PositionalDelta[] = [{ line: 5, delta: 2 }];
    expect(rebaseHashRefLineRange('h:abc123:sig', deltas)).toBe('h:abc123:sig');
    expect(rebaseHashRefLineRange('h:abc123:fold', deltas)).toBe('h:abc123:fold');
  });
});

// ---------------------------------------------------------------------------
// Inter-step hash-ref rebase integration: when step 1 shifts lines in a file,
// step 2's f:"h:HASH:A-B" gets its range rebased so the backend applies at
// the right coordinates in the current file. Reproduces the demo-trace bug
// (round 5 e2 / round 6 / round 8) and confirms the fix.
// ---------------------------------------------------------------------------

describe('inter-step rebase — hash-ref line ranges on f/file/file_path', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('shifts future step f:"h:HASH:A-B" by deltas from prior same-file edit', async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    handlers.set('change.edit', async (params) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/foo.ts', content_hash: 'hash-after', h: 'hash-after', old_h: 'abc123' }],
        edits_resolved: [{ resolved_line: 6, action: 'replace', lines_affected: 7 }],
      });
    });

    const ctx = makeCtx();
    // Seed the tracker via a read so the hash → path resolver works when
    // rebaseSubsequentSteps sees f:"h:abc123:12-14" in step 2.
    handlers.set('read.lines', async () =>
      raw('read', { file: 'src/foo.ts', content_hash: 'abc123', actual_range: [[1, 20]], lines: 20 }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'r1', use: 'read.lines', with: { f: 'src/foo.ts', sl: 1, el: 20 },
        },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/foo.ts',
            content_hash: 'abc123',
            line_edits: [{ line: 6, end_line: 10, action: 'replace', content: Array(7).fill('x').join('\n') }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            f: 'h:abc123:12-14',
            line_edits: [{ content: 'new body' }],
          },
        },
      ],
    }, ctx);

    // e1 was the first change.edit call; e2's `f:` was rebased by the
    // executor pre-normalization, and `paramNorm` then aliased `f` → `file_path`
    // before the handler saw it. Assert on file_path.
    const e2Call = editCalls[1];
    expect(e2Call).toBeDefined();
    expect(e2Call.file_path ?? e2Call.file ?? e2Call.f).toBe('h:abc123:14-16');
  });

  it('shifts future step f:"h:RETENTION:A-B" (FileView ref) to cite hash + rebased lines', async () => {
    const cite = 'abc123';
    const { shortHash: retentionShort } = computeFileViewHashParts('src/foo.ts', cite);
    expect(retentionShort).not.toBe(cite);

    const editCalls: Array<Record<string, unknown>> = [];
    handlers.set('change.edit', async (params) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/foo.ts', content_hash: 'hash-after', h: 'hash-after', old_h: cite }],
        edits_resolved: [{ resolved_line: 6, action: 'replace', lines_affected: 7 }],
      });
    });

    const ctx = makeCtx();
    handlers.set('read.lines', async () =>
      raw('read', { file: 'src/foo.ts', content_hash: cite, actual_range: [[1, 20]], lines: 20 }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.lines', with: { f: 'src/foo.ts', sl: 1, el: 20 } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/foo.ts',
            content_hash: cite,
            line_edits: [{ line: 6, end_line: 10, action: 'replace', content: Array(7).fill('x').join('\n') }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            f: `h:${retentionShort}:12-14`,
            line_edits: [{ content: 'new body' }],
          },
        },
      ],
    }, ctx);

    const e2Call = editCalls[1];
    expect(e2Call).toBeDefined();
    expect(e2Call.file_path ?? e2Call.file ?? e2Call.f).toBe(`h:${cite}:14-16`);
  });

  it('does not shift when hash does not resolve to an edited file', async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    handlers.set('change.edit', async (params) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/foo.ts', content_hash: 'hash-after', h: 'hash-after', old_h: 'abc123' }],
        edits_resolved: [{ resolved_line: 6, action: 'replace', lines_affected: 7 }],
      });
    });

    const ctx = makeCtx();

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/foo.ts',
            content_hash: 'abc123',
            line_edits: [{ line: 6, end_line: 10, action: 'replace', content: Array(7).fill('x').join('\n') }],
          },
        },
        {
          // Different file — hash doesn't resolve to src/foo.ts, no rebase should apply
          id: 'e2', use: 'change.edit', with: {
            f: 'h:beef9999:12-14',
            line_edits: [{ content: 'other' }],
          },
        },
      ],
    }, ctx);

    const e2Call = editCalls[1];
    expect(e2Call?.file_path ?? e2Call?.file ?? e2Call?.f).toBe('h:beef9999:12-14');
  });

  it('shifts nested batch_edits edits[] entry f: hash-refs', async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    handlers.set('change.edit', async (params) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/foo.ts', content_hash: 'hash-after', h: 'hash-after', old_h: 'abc123' }],
        edits_resolved: [{ resolved_line: 6, action: 'replace', lines_affected: 7 }],
      });
    });

    const ctx = makeCtx();
    handlers.set('read.lines', async () =>
      raw('read', { file: 'src/foo.ts', content_hash: 'abc123', actual_range: [[1, 20]], lines: 20 }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.lines', with: { f: 'src/foo.ts', sl: 1, el: 20 } },
        {
          id: 'e1', use: 'change.edit', with: {
            file: 'src/foo.ts',
            content_hash: 'abc123',
            line_edits: [{ line: 6, end_line: 10, action: 'replace', content: Array(7).fill('x').join('\n') }],
          },
        },
        {
          id: 'e2', use: 'change.edit', with: {
            mode: 'batch_edits',
            edits: [
              { f: 'h:abc123:12-14', line_edits: [{ content: 'a' }] },
              { f: 'h:abc123:16-18', line_edits: [{ content: 'b' }] },
            ],
          },
        },
      ],
    }, ctx);

    const e2Call = editCalls[1];
    const edits = e2Call?.edits as Array<Record<string, unknown>> | undefined;
    expect(edits?.[0]?.f).toBe('h:abc123:14-16');
    expect(edits?.[1]?.f).toBe('h:abc123:18-20');
  });
});

// ---------------------------------------------------------------------------
// P0 regression: alias capture + read-op rebase widened beyond change.edit.
// Covers change.refactor → change.edit, change.edit → read.lines, and the
// rebaseAllChangeOps feature-flag rollback path.
// ---------------------------------------------------------------------------

describe('inter-step hash substitution — widened change.* alias capture (P0.1)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  afterEach(() => {
    useAppStore.setState((s) => ({ settings: { ...s.settings, rebaseAllChangeOps: true } }));
  });

  it('rewrites a stale h:OLD cite on a later change.edit after change.refactor rotates the file hash', async () => {
    const editCalls: Array<Record<string, unknown>> = [];
    handlers.set('read.lines', async () =>
      raw('read', { file: 'src/rn.ts', content_hash: 'oldhash', actual_range: [[1, 5]], lines: 5 }),
    );
    handlers.set('change.refactor', async () =>
      raw('renamed', {
        status: 'success',
        results: [{ file: 'src/rn.ts', content_hash: 'newhash', h: 'newhash', old_h: 'oldhash' }],
        _action: 'execute',
      }),
    );
    handlers.set('change.edit', async (params) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', { status: 'ok' });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.lines', with: { f: 'src/rn.ts', sl: 1, el: 5 } },
        { id: 'cf', use: 'change.refactor' },
        // Edit cites the PRE-refactor hash; after the refactor rotates
        // src/rn.ts oldhash → newhash, the executor should rewrite `f`.
        { id: 'ce', use: 'change.edit', with: { f: 'h:oldhash:source', line_edits: [{ content: 'x' }] } },
      ],
    }, makeCtx());

    const cePayload = editCalls[0];
    expect(cePayload).toBeDefined();
    const rewritten = (cePayload.file_path ?? cePayload.file ?? cePayload.f) as string;
    expect(rewritten).toBe('h:newhash:source');
  });

  it('rewrites a stale h:OLD cite on a later read.lines ref after change.edit rotates the file hash', async () => {
    const readCalls: Array<Record<string, unknown>> = [];
    handlers.set('read.lines', async (params) => {
      readCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('read', { file: 'src/a.ts', content_hash: 'afterhash', actual_range: [[1, 3]], lines: 3 });
    });
    handlers.set('change.edit', async () =>
      raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/a.ts', content_hash: 'afterhash', h: 'afterhash', old_h: 'preedit' }],
        edits_resolved: [{ resolved_line: 2, action: 'replace', lines_affected: 1 }],
      }),
    );

    // Seed awareness so the tracker sees 'preedit' for src/a.ts before the edit.
    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r0', use: 'read.lines', with: { f: 'src/a.ts', sl: 1, el: 3 } },
      ],
    }, makeCtx());
    readCalls.length = 0;

    const ctx = makeCtx();
    // Pre-seed the awareness cache so the second batch's tracker picks up
    // 'preedit' for src/a.ts.
    ctx.store().setAwareness({
      level: AwarenessLevel.CANONICAL,
      filePath: 'src/a.ts',
      snapshotHash: 'preedit',
      readRegions: [{ start: 1, end: 3 }],
    });
    // Stub read.lines to return a content_hash so the tracker rotates.
    handlers.set('read.lines', async (params) => {
      readCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('read', { file: 'src/a.ts', content_hash: 'afterhash', actual_range: [[1, 3]], lines: 3 });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'ce', use: 'change.edit', with: { file: 'src/a.ts', line_edits: [{ line: 2, action: 'replace', content: 'x' }] } },
        { id: 'r1', use: 'read.lines', with: { ref: 'h:preedit:1-3' } },
      ],
    }, ctx);

    // The read.lines call after the edit should have had its stale ref
    // rewritten from h:preedit → h:afterhash by substituteStaleFileRefs.
    const r1 = readCalls[0];
    expect(r1?.ref).toBe('h:afterhash:1-3');
  });

  it('legacy behavior when rebaseAllChangeOps=false: refactor → edit does NOT rewrite stale hash', async () => {
    useAppStore.setState((s) => ({ settings: { ...s.settings, rebaseAllChangeOps: false } }));
    const editCalls: Array<Record<string, unknown>> = [];
    handlers.set('read.lines', async () =>
      raw('read', { file: 'src/rn.ts', content_hash: 'oldhash', actual_range: [[1, 5]], lines: 5 }),
    );
    handlers.set('change.refactor', async () =>
      raw('renamed', {
        status: 'success',
        results: [{ file: 'src/rn.ts', content_hash: 'newhash', h: 'newhash', old_h: 'oldhash' }],
        _action: 'execute',
      }),
    );
    handlers.set('change.edit', async (params) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', { status: 'ok' });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r1', use: 'read.lines', with: { f: 'src/rn.ts', sl: 1, el: 5 } },
        { id: 'cf', use: 'change.refactor' },
        { id: 'ce', use: 'change.edit', with: { f: 'h:oldhash:source', line_edits: [{ content: 'x' }] } },
      ],
    }, makeCtx());

    const cePayload = editCalls[0];
    const reffed = (cePayload.file_path ?? cePayload.file ?? cePayload.f) as string;
    expect(reffed).toBe('h:oldhash:source');
  });
});

describe('read-op rebase — change.edit rotates future read.lines coordinates (P0.2)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  afterEach(() => {
    useAppStore.setState((s) => ({ settings: { ...s.settings, rebaseAllChangeOps: true } }));
  });

  it('shifts future read.lines `lines:` range by positional deltas from prior edit', async () => {
    const readCalls: Array<Record<string, unknown>> = [];
    handlers.set('read.lines', async (params) => {
      readCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('read', { file: 'src/x.ts', content_hash: 'h1', actual_range: [[1, 30]], lines: 30 });
    });
    handlers.set('change.edit', async () =>
      raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/x.ts', content_hash: 'h2', h: 'h2', old_h: 'h1' }],
        edits_resolved: [{ resolved_line: 5, action: 'insert_before', lines_affected: 3 }],
      }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r0', use: 'read.lines', with: { f: 'src/x.ts', sl: 1, el: 30 } },
        {
          id: 'ce', use: 'change.edit', with: {
            file: 'src/x.ts',
            content_hash: 'h1',
            line_edits: [{ line: 5, action: 'insert_before', content: 'a\nb\nc' }],
          },
        },
        // Future read.lines: stale coordinates; should be shifted by +3 for
        // the insert_before at line 5.
        { id: 'r1', use: 'read.lines', with: { f: 'src/x.ts', lines: '20-25' } },
      ],
    }, makeCtx());

    // readCalls[0] was the seed r0; readCalls[1] is r1 — that's the one to check.
    const r1 = readCalls[1];
    expect(r1?.lines).toBe('23-28');
  });

  it('shifts future read.lines start_line/end_line numeric pair', async () => {
    const readCalls: Array<Record<string, unknown>> = [];
    handlers.set('read.lines', async (params) => {
      readCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('read', { file: 'src/y.ts', content_hash: 'h1', actual_range: [[1, 30]], lines: 30 });
    });
    handlers.set('change.edit', async () =>
      raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/y.ts', content_hash: 'h2', h: 'h2', old_h: 'h1' }],
        edits_resolved: [{ resolved_line: 5, action: 'insert_before', lines_affected: 3 }],
      }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r0', use: 'read.lines', with: { f: 'src/y.ts', sl: 1, el: 30 } },
        {
          id: 'ce', use: 'change.edit', with: {
            file: 'src/y.ts',
            content_hash: 'h1',
            line_edits: [{ line: 5, action: 'insert_before', content: 'a\nb\nc' }],
          },
        },
        { id: 'r1', use: 'read.lines', with: { f: 'src/y.ts', sl: 20, el: 25 } },
      ],
    }, makeCtx());

    const r1 = readCalls[1];
    // `sl` rebased: 20 + 3 = 23; `el`: 25 + 3 = 28. Alias still `sl`/`el`
    // because executor rebases BEFORE paramNorm aliases them to start_line/end_line.
    expect(r1?.sl ?? r1?.start_line).toBe(23);
    expect(r1?.el ?? r1?.end_line).toBe(28);
  });

  it('flag off: future read.lines lines: range is NOT shifted', async () => {
    useAppStore.setState((s) => ({ settings: { ...s.settings, rebaseAllChangeOps: false } }));
    const readCalls: Array<Record<string, unknown>> = [];
    handlers.set('read.lines', async (params) => {
      readCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('read', { file: 'src/x.ts', content_hash: 'h1', actual_range: [[1, 30]], lines: 30 });
    });
    handlers.set('change.edit', async () =>
      raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/x.ts', content_hash: 'h2', h: 'h2', old_h: 'h1' }],
        edits_resolved: [{ resolved_line: 5, action: 'insert_before', lines_affected: 3 }],
      }),
    );

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        { id: 'r0', use: 'read.lines', with: { f: 'src/x.ts', sl: 1, el: 30 } },
        {
          id: 'ce', use: 'change.edit', with: {
            file: 'src/x.ts',
            content_hash: 'h1',
            line_edits: [{ line: 5, action: 'insert_before', content: 'a\nb\nc' }],
          },
        },
        { id: 'r1', use: 'read.lines', with: { f: 'src/x.ts', lines: '20-25' } },
      ],
    }, makeCtx());

    const r1 = readCalls[1];
    expect(r1?.lines).toBe('20-25');
  });
});

// ---------------------------------------------------------------------------
// buildPerFileDeltaMap — edits_resolved backfill for hash-ref input shapes
// ---------------------------------------------------------------------------

describe('buildPerFileDeltaMap — edits_resolved backfill', () => {
  it('returns empty deltas when le lacks line and no artifact is provided', () => {
    // Regression lock: the `f:h:HASH:N` shape at `change.edit`'s request
    // level means the executor's snapshot of `mergedParams.line_edits` has
    // no `line` field (it's injected by `change.edit`'s internal
    // `resolveEditOperation` into a fresh array). Without artifact backfill
    // the delta map comes out empty and the FileView refresh sees zero
    // shifts — sparse-sig skeletons stop rebasing on insert/delete.
    const params = {
      file: 'src/foo.ts',
      line_edits: [{ action: 'insert_after', content: 'const x = 1;' }],
    };
    const map = buildPerFileDeltaMap(params);
    expect(map.size).toBe(0);
  });

  it('backfills line from artifact.edits_resolved when le lacks line', () => {
    // Same request, but now the artifact from the completed step carries
    // `edits_resolved: [{resolved_line: 4, action: "insert_after", lines_affected: 2}]`.
    // buildPerFileDeltaMap should pull `line: 4` from there and produce the
    // correct +2 delta so downstream rebase (and FileView splice) works.
    const params = {
      file: 'src/foo.ts',
      line_edits: [{ action: 'insert_after', content: 'const x = 1;\nconst y = 2;' }],
    };
    const artifact = {
      drafts: [{ file: 'src/foo.ts', content_hash: 'h2', h: 'h2' }],
      edits_resolved: [{ resolved_line: 4, action: 'insert_after', lines_affected: 2 }],
    };
    const map = buildPerFileDeltaMap(params, artifact);
    const deltas = map.get('src/foo.ts');
    expect(deltas).toEqual([{ line: 4, delta: 2, lineInclusive: false }]);
  });

  it('backfills batch_edits from per-file drafts[].edits_resolved', () => {
    // batch_edits path: resolutions live nested inside each drafts[] entry,
    // one array per edited file.
    const params = {
      mode: 'batch_edits',
      edits: [
        {
          file: 'src/a.ts',
          line_edits: [{ action: 'delete' }], // line missing — supplied via hash-ref
        },
        {
          file: 'src/b.ts',
          line_edits: [{ action: 'insert_before', content: 'new' }],
        },
      ],
    };
    const artifact = {
      drafts: [
        {
          file: 'src/a.ts',
          content_hash: 'hA2',
          h: 'hA2',
          edits_resolved: [{ resolved_line: 10, action: 'delete', lines_affected: 1 }],
        },
        {
          file: 'src/b.ts',
          content_hash: 'hB2',
          h: 'hB2',
          edits_resolved: [{ resolved_line: 3, action: 'insert_before', lines_affected: 1 }],
        },
      ],
    };
    const map = buildPerFileDeltaMap(params, artifact);
    expect(map.get('src/a.ts')).toEqual([
      { line: 10, delta: -1, lineInclusive: false, consumes: 1 },
    ]);
    expect(map.get('src/b.ts')).toEqual([
      { line: 3, delta: 1, lineInclusive: true },
    ]);
  });

  it('preserves explicit line when le already has one (backfill is no-op)', () => {
    // When the model supplied `line` directly, we must NOT overwrite with
    // resolved_line — they'd agree in the simple case but the explicit form
    // is authoritative for the request.
    const params = {
      file: 'src/keep.ts',
      line_edits: [{ line: 5, action: 'replace', content: 'new', end_line: 5 }],
    };
    const artifact = {
      edits_resolved: [{ resolved_line: 5, action: 'replace', lines_affected: 1 }],
    };
    const map = buildPerFileDeltaMap(params, artifact);
    // Zero delta for same-length replace; net result is an empty map (correct).
    expect(map.size).toBe(0);
  });

  it('replace with hash-ref:L-M backfills end_line so delta uses real span', () => {
    // Live-bug regression: model passes `f:"h:HASH:112-116"` with 6-line
    // content. Request's le entry has only `action: replace, content: "6 lines"`
    // — no `line` / `end_line`. Without end_line backfill, the delta
    // calculator defaults span=1 → delta = contentLines(6) - 1 = +5, which
    // is wrong (real delta is +1). Subsequent steps then shift by +5
    // instead of +1 and land at the wrong file coordinates.
    const params = {
      file: 'src/hit.ts',
      line_edits: [{
        action: 'replace',
        content: 'a\nb\nc\nd\ne\nf', // 6 lines
      }],
    };
    const artifact = {
      drafts: [{ file: 'src/hit.ts', content_hash: 'h2', h: 'h:h2' }],
      // Rust reports resolved_line + lines_affected (pre-span for replace).
      edits_resolved: [{ resolved_line: 112, action: 'replace', lines_affected: 5 }],
    };
    const map = buildPerFileDeltaMap(params, artifact);
    const deltas = map.get('src/hit.ts');
    // Correct delta = contentLines(6) - span(5) = +1, not +5.
    expect(deltas).toEqual([{ line: 112, delta: 1, lineInclusive: false }]);
  });

  it('delete backfills end_line so consumes-range drops exactly the deleted lines', () => {
    // Multi-line delete via hash-ref: f:"h:HASH:5-8" le:[{action:"delete"}]
    // lines_affected=4 from Rust; backfill end_line=8 so span computes
    // correctly. Delta should be -4 with consumes:4.
    const params = {
      file: 'src/del.ts',
      line_edits: [{ action: 'delete' }],
    };
    const artifact = {
      drafts: [{ file: 'src/del.ts', content_hash: 'h2' }],
      edits_resolved: [{ resolved_line: 5, action: 'delete', lines_affected: 4 }],
    };
    const map = buildPerFileDeltaMap(params, artifact);
    const deltas = map.get('src/del.ts');
    expect(deltas).toEqual([{ line: 5, delta: -4, lineInclusive: false, consumes: 4 }]);
  });

  it('insert_after does NOT backfill end_line (irrelevant for insert math)', () => {
    // Inserts add content, don't replace a span. delta = contentLines,
    // independent of end_line. Adding end_line would be harmless but
    // semantically wrong — pin down that we only inject it for span actions.
    const params = {
      file: 'src/ins.ts',
      line_edits: [{ action: 'insert_after', content: 'x\ny' }], // 2 lines
    };
    const artifact = {
      edits_resolved: [{ resolved_line: 3, action: 'insert_after', lines_affected: 2 }],
    };
    const map = buildPerFileDeltaMap(params, artifact);
    const deltas = map.get('src/ins.ts');
    expect(deltas).toEqual([{ line: 3, delta: 2, lineInclusive: false }]);
  });

  it('dual-keys by raw source param AND resolved path for hash-ref inputs', () => {
    // The live bug: `ce f:"h:ab09b8:4" le:[{action:"insert_after",content:"..."}]`
    // leaves `mergedParams.f = "h:ab09b8:4"` — extractEditTargetFile returns
    // that raw hash-ref, so the delta map got keyed by "h:ab09b8:4" and
    // downstream `resolveDeltasForFile("fv-debug.ts", …)` missed. Result:
    // FileView got empty deltas → sparse sig skeleton never rebased.
    //
    // Fix: also key by the artifact's resolved path (drafts[0].file) so
    // lookups by edited-file path land on the same delta array.
    const params = {
      f: 'h:ab09b8:4',
      line_edits: [{ action: 'insert_after', content: 'const y = 2;\nconst z = 3;' }],
    };
    const artifact = {
      drafts: [{ file: 'fv-debug.ts', content_hash: 'h2', h: 'h:h2', old_h: 'h:ab09b8' }],
      edits_resolved: [{ resolved_line: 4, action: 'insert_after', lines_affected: 2 }],
    };
    const map = buildPerFileDeltaMap(params, artifact);
    // The raw-ref key lands (legacy / intra-batch rebase consumers).
    expect(map.get('h:ab09b8:4')).toEqual([{ line: 4, delta: 2, lineInclusive: false }]);
    // The resolved-path key ALSO lands — this is what `resolveDeltasForFile`
    // looks up from `collectEditedFiles` (which pulls file paths from drafts).
    expect(map.get('fv-debug.ts')).toEqual([{ line: 4, delta: 2, lineInclusive: false }]);
  });
});

// ---------------------------------------------------------------------------
// Hash-ref view-retention-short rewrite — full-revision preflight comparison
// ---------------------------------------------------------------------------

describe('injectSnapshotHashes — rewrites h:<retention-short>:suffix on f/file/file_path', () => {
  beforeAll(() => {
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/target.ts', content_hash: 'hash-after', h: 'hash-after', old_h: 'revFulla' }],
        edits_resolved: [{ resolved_line: 5, action: 'replace', lines_affected: 3 }],
      });
    });
  });

  /** ctx variant that exposes a `fileViews` Map so `resolveCiteFromView` can match. */
  function makeCtxWithFileViews(fileViews: Map<string, { filePath: string; shortHash: string; sourceRevision: string; previousShortHashes?: string[] }>) {
    const base = makeCtx();
    return {
      ...base,
      store: () => ({
        ...base.store(),
        fileViews,
      }),
    } as typeof base;
  }

  it('rewrites f:"h:<retention-short>:A-B" to f:"h:<full-source-revision>:A-B" before handler dispatch', async () => {
    // The live bug (AtlsInternals transcript R4): model reads with `rf type:full`
    // → gets back `h:<retention-short>` (6-char path-derived hash). Then edits
    // with `f:"h:<short>:A-B"`. The handler's `canonicalizeContentHash` cuts
    // at the first colon → 6-char short. Preflight compares that 6-char
    // against the full 16-char disk hash → mismatch → "content changed —
    // re-read and retry". But the view is FRESH — the 6-char short is just
    // the retention ref, not a stale cite.
    //
    // Fix: in `injectSnapshotHashes`, if `f` / `file` / `file_path` is a
    // hash-ref whose SHORT resolves to a live FileView, rewrite the hash
    // part to the view's full sourceRevision. Suffix (line range, shape
    // modifier) preserved verbatim. `deriveEditTargetMeta` then sets
    // edit_target_hash to the full hash, and preflight hash comparison
    // works properly.
    const fullRev = 'revFulla1234b567cd89ef';
    const { shortHash } = computeFileViewHashParts('src/target.ts', fullRev);
    expect(shortHash).not.toBe(fullRev); // they must differ
    const fileViews = new Map<string, { filePath: string; shortHash: string; sourceRevision: string }>();
    fileViews.set('src/target.ts', { filePath: 'src/target.ts', shortHash, sourceRevision: fullRev });

    const editCalls: Array<Record<string, unknown>> = [];
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/target.ts', content_hash: 'revPost2', h: 'revPost2', old_h: fullRev }],
        edits_resolved: [{ resolved_line: 2, action: 'replace', lines_affected: 1 }],
      });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'e1', use: 'change.edit', with: {
            f: `h:${shortHash}:2-2`,
            le: [{ content: 'const y = 99;' }],
          },
        },
      ],
    }, makeCtxWithFileViews(fileViews));

    expect(editCalls).toHaveLength(1);
    const call = editCalls[0];
    // `f` (or its aliased form) should now carry the FULL sourceRevision,
    // not the retention short.
    const fValue = (call.f ?? call.file ?? call.file_path) as string;
    expect(fValue).toBeTruthy();
    expect(fValue.includes(`:${fullRev}:`) || fValue.startsWith(`h:${fullRev}:`)).toBe(true);
    expect(fValue.includes(`h:${shortHash}:`)).toBe(false);
    // Line-range suffix preserved.
    expect(fValue.endsWith(':2-2')).toBe(true);
  });

  it('preserves non-view hash-refs — no rewrite when ref does not resolve to a view', async () => {
    // Empty view map — nothing to resolve against.
    const fileViews = new Map<string, { filePath: string; shortHash: string; sourceRevision: string }>();

    const editCalls: Array<Record<string, unknown>> = [];
    handlers.set('change.edit', async (params: Record<string, unknown>) => {
      editCalls.push(JSON.parse(JSON.stringify(params)));
      return raw('applied', {
        status: 'ok',
        drafts: [{ file: 'src/other.ts', content_hash: 'h2', h: 'h2' }],
        edits_resolved: [{ resolved_line: 5, action: 'replace', lines_affected: 1 }],
      });
    });

    await executeUnifiedBatch({
      version: '1.0',
      steps: [
        {
          id: 'e1', use: 'change.edit', with: {
            f: 'h:beefdead:5',
            le: [{ content: 'x' }],
          },
        },
      ],
    }, makeCtxWithFileViews(fileViews));

    const call = editCalls[0];
    // Unchanged — no view matched.
    expect((call.f ?? call.file ?? call.file_path)).toBe('h:beefdead:5');
  });
});
