import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    isBlockedForSwarm: () => false,
  };
});

vi.mock('./handlers/session', () => ({
  resetRecallBudget: () => {},
}));

import { executeUnifiedBatch } from './executor';

function makeCtx() {
  const awarenessCache = new Map();
  return {
    store: () => ({
      recordManageOps: () => {},
      recordToolCall: () => {},
      forwardStagedHash: () => 0,
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
    }),
    getProjectPath: () => null,
    resolveSearchRefs: async () => ({}),
    expandSetRefsInHashes: (hashes: string[]) => ({ expanded: hashes, notes: [] }),
    expandFilePathRefs: async () => ({ items: [], notes: [] }),
    atlsBatchQuery: async () => ({}),
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

  it('interrupts the batch at the first preview/confirmation boundary', async () => {
    const applySpy = vi.fn();

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

    expect(result.ok).toBe(false);
    expect(result.interruption).toEqual({
      kind: 'confirmation_required',
      step_id: 'preview',
      step_index: 0,
      tool_name: 'change.edit',
      summary: 'Preview complete. Set dry_run:false to apply',
    });
    expect(result.step_results).toHaveLength(1);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('interrupts the batch when a step pauses for lint/rollback follow-up', async () => {
    const mutateSpy = vi.fn();

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

    expect(result.ok).toBe(false);
    expect(result.interruption).toEqual({
      kind: 'paused_on_error',
      step_id: 'refactor',
      step_index: 0,
      tool_name: 'change.refactor',
      summary: 'Fix the failing operation and resume_after:0',
    });
    expect(result.step_results).toHaveLength(1);
    expect(mutateSpy).not.toHaveBeenCalled();
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

describe('executeUnifiedBatch snapshot propagation', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('propagates snapshot_hash from read.context into change.edit', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.snapshot_hash).toBe('abc12345');
      expect(params.content_hash).toBeUndefined();
      return raw('applied', { status: 'ok' });
    });

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/demo.ts', snapshot_hash: 'abc12345' }],
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
      snapshot_hash: 'cafefeed',
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

// ---------------------------------------------------------------------------
// Multiedit / multibatch stress tests — exercises snapshot propagation,
// in-bindings, conditionals, rollback, max_steps, and path normalization.
// ---------------------------------------------------------------------------

describe('executeUnifiedBatch multiedit multibatch stress', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('propagates per-file snapshot_hash to batch_edits (edits: [{ file, line_edits }, ...])', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const edits = params.edits as Array<Record<string, unknown>>;
      expect(edits).toHaveLength(3);
      expect(edits[0].file).toBe('src/a.ts');
      expect(edits[0].snapshot_hash).toBe('hash-a');
      expect(edits[1].file).toBe('src/b.ts');
      expect(edits[1].snapshot_hash).toBe('hash-b');
      expect(edits[2].file).toBe('src/c.ts');
      expect(edits[2].snapshot_hash).toBe('hash-c');
      return raw('batch applied', { status: 'ok', mode: 'batch_edits' });
    });

    handlers.set('read.context', async () => raw('multi-read', {
      results: [
        { file: 'src/a.ts', snapshot_hash: 'hash-a' },
        { file: 'src/b.ts', snapshot_hash: 'hash-b' },
        { file: 'src/c.ts', snapshot_hash: 'hash-c' },
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
        results: [{ file: path, snapshot_hash: hashes[path] ?? 'unknown', content: 'line' }],
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
    expect(editCalls[0].snapshot_hash).toBe('hash-a-v1');
    expect(editCalls[1].snapshot_hash).toBe('hash-b-v1');
    expect(editCalls[2].snapshot_hash).toBe('hash-c-v1');
  });

  it('resolves in-bindings: from_step and path into prior output', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.edits).toEqual([{ file: 'src/x.ts', old: 'old', new: 'new' }]);
      return raw('applied', { status: 'ok' });
    });

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/x.ts', snapshot_hash: 'h123' }],
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
    );
  });

  it('resolves named bindings (out/in bind)', async () => {
    const verifySpy = vi.fn(async () => raw('verified', { ok: true }));

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src/foo.ts', snapshot_hash: 'pre-edit-hash' }],
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
      return raw('read', { results: [{ file: 'x', snapshot_hash: 'h' }] });
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

  it('interruption from paused refactor preempts rollback injection', async () => {
    // When change.refactor returns status:paused with _rollback, we interrupt before
    // the rollback-injection block. Rollback injection only runs when a step fails
    // without triggering interruption — which cannot happen when _rollback is present.
    const rollbackSpy = vi.fn();

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

    expect(result.ok).toBe(false);
    expect(result.interruption?.kind).toBe('paused_on_error');
    expect(rollbackSpy).not.toHaveBeenCalled(); // interrupt happens first
  });

  it('normalizes path separators for snapshot lookup (backslash read vs forward edit)', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.snapshot_hash).toBe('same-hash');
      return raw('applied', { status: 'ok' });
    });

    handlers.set('read.context', async () => raw('read', {
      results: [{ file: 'src\\foo.ts', snapshot_hash: 'same-hash', content: 'x' }],
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
      results: [{ file: 'x.ts', snapshot_hash: 'hash-x' }],
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
        expect(edits[i].snapshot_hash).toBe(`hash-${files[i].replace('/', '-')}`);
      }
      return raw('batch ok', { status: 'ok' });
    });

    handlers.set('read.context', async () => raw('multi', {
      results: files.map(f => ({
        file: f,
        snapshot_hash: `hash-${f.replace('/', '-')}`,
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
// Hash freshness multiedit multibatch — ensures snapshot_hash stays correct
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
      results: [{ file: 'src/impl.ts', snapshot_hash: 'hash-v1', content: 'const x = 1;' }],
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
    expect(editCalls[0].params.snapshot_hash).toBe('hash-v1');
    expect(editCalls[1].params.snapshot_hash).toBe('hash-v2');
  });

  it('batch_edits: file A edited first, then batch to A+B — A gets post-edit hash, B gets read hash', async () => {
    const editSpy = vi.fn(async (params: Record<string, unknown>) => {
      const edits = params.edits as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(edits) && edits.length === 2) {
        const aEntry = edits.find(e => (e.file ?? e.file_path) === 'src/a.ts');
        const bEntry = edits.find(e => (e.file ?? e.file_path) === 'src/b.ts');
        expect(aEntry?.snapshot_hash).toBe('hash-a-post');
        expect(bEntry?.snapshot_hash).toBe('hash-b-read');
        return raw('batch ok', { status: 'ok' });
      }
      return { kind: 'raw', ok: true, refs: [], summary: 'ok', content: { status: 'ok', drafts: [{ file: 'src/a.ts', content_hash: 'hash-a-post' }] } };
    });

    handlers.set('read.context', async () => raw('read', {
      results: [
        { file: 'src/a.ts', snapshot_hash: 'hash-a-read' },
        { file: 'src/b.ts', snapshot_hash: 'hash-b-read' },
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

    handlers.set('read.context', async () => raw('read', { results: [{ file: 'x.ts', snapshot_hash: 'h1', content: 'a' }] }));
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

    expect(editCalls[0].snapshot_hash).toBe('h1');
    expect(editCalls[1].snapshot_hash).toBe('h2');
    expect(editCalls[2].snapshot_hash).toBe('h3');
  });

  it('edit fails (no drafts): subsequent edit to same file still gets read hash', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', { results: [{ file: 'f.ts', snapshot_hash: 'h-initial', content: 'x' }] }));
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

    expect(editCalls[0].snapshot_hash).toBe('h-initial');
    expect(editCalls[1].snapshot_hash).toBe('h-initial');
  });

  it('batch with f/h alias: drafts use backend shorthand and tracker records correctly', async () => {
    const editCalls: Array<Record<string, unknown>> = [];

    handlers.set('read.context', async () => raw('read', { results: [{ file: 'src/foo.ts', snapshot_hash: 'old-hash', content: 'x' }] }));
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
    expect(editCalls[0].snapshot_hash).toBe('old-hash');
    expect(editCalls[1].snapshot_hash).toBe('backend-hash');
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
      content: { results: [{ file: 'src/x.ts', snapshot_hash: 'h123' }], edits: [{ file: 'src/x.ts', old: 'old', new: 'new' }] },
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
