/**
 * Unit tests for session handlers — task_advance, hashes/refs unification.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleCompact,
  handleCompactHistory,
  handleDrop,
  handlePin,
  handleRecall,
  handleSessionDebug,
  handleStage,
  handleStats,
  handleTaskAdvance,
  handleTaskPlan,
  handleTaskStatus,
  handleUnload,
  handleUnpin,
  handleUnstage,
  resetRecallBudget,
} from './session';
import { useContextStore } from '../../../stores/contextStore';
import type { StepOutput } from '../types';

const invokeMock = vi.hoisted(() =>
  vi.fn((cmd: string) => {
    if (cmd === 'resolve_hash_ref') {
      return Promise.resolve({ content: 'staged-from-invoke', source: 'src/invoked.ts' });
    }
    return Promise.resolve(null);
  }),
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

function createMockCtx(overrides?: Partial<{
  taskPlan: { goal: string; subtasks: Array<{ id: string; title: string; status: string }>; activeSubtaskId: string | null } | null;
  expandSetRefsInHashes: (hashes: string[]) => { expanded: string[]; notes: string[] };
  atlsBatchQuery: (op: string, params: unknown) => Promise<unknown>;
}>) {
  return {
    /** Fresh state each read — Zustand replaces state objects on update; a captured snapshot goes stale. */
    store: () => useContextStore.getState(),
    sessionId: 'test-session',
    isSwarmAgent: false,
    getProjectPath: () => null,
    resolveSearchRefs: async () => ({}),
    expandSetRefsInHashes: (hashes: string[]) => ({ expanded: hashes, notes: [] }),
    atlsBatchQuery: async () => ({}),
    ...overrides,
  };
}

describe('handleTaskAdvance', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('advances to next subtask when subtask omitted and plan has 2+ subtasks', async () => {
    const plan = {
      goal: 'test',
      subtasks: [
        { id: 'a', title: 'phase a', status: 'active' as const },
        { id: 'b', title: 'phase b', status: 'pending' as const },
      ],
      activeSubtaskId: 'a' as string | null,
    };
    useContextStore.getState().setTaskPlan(plan);

    const result = await handleTaskAdvance(
      { summary: 'Completed phase a: analyzed structure and identified extraction targets.' },
      createMockCtx() as unknown as Parameters<typeof handleTaskAdvance>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('task_advance: b(active)');
    const updated = useContextStore.getState().taskPlan;
    expect(updated?.subtasks.find(s => s.id === 'a')?.status).toBe('done');
    expect(updated?.subtasks.find(s => s.id === 'b')?.status).toBe('active');
  });

  it('returns error when subtask omitted and current is last subtask', async () => {
    const plan = {
      goal: 'test',
      subtasks: [
        { id: 'a', title: 'phase a', status: 'done' as const },
        { id: 'b', title: 'phase b', status: 'active' as const },
      ],
      activeSubtaskId: 'b' as string | null,
    };
    useContextStore.getState().setTaskPlan(plan);

    const result = await handleTaskAdvance(
      { summary: 'Completed phase b: all work done, verification passed.' },
      createMockCtx() as unknown as Parameters<typeof handleTaskAdvance>[1],
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/plan complete|no next subtask/);
  });

  it('uses explicit subtask when provided', async () => {
    const plan = {
      goal: 'test',
      subtasks: [
        { id: 'a', title: 'a', status: 'active' as const },
        { id: 'b', title: 'b', status: 'pending' as const },
        { id: 'c', title: 'c', status: 'pending' as const },
      ],
      activeSubtaskId: 'a' as string | null,
    };
    useContextStore.getState().setTaskPlan(plan);

    const ctx = createMockCtx() as unknown as Parameters<typeof handleTaskAdvance>[1];
    const result = await handleTaskAdvance(
      { subtask: 'c', summary: 'Skipping b, jumping to c for targeted fix. Phase b not needed for this change.' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('task_advance: c(active)');
  });

  it('resolves subtask by human title when passed instead of id (unique match)', async () => {
    const plan = {
      goal: 'review',
      subtasks: [
        { id: 'analyze', title: 'Inspect', status: 'active' as const },
        { id: 'report', title: 'Summarize', status: 'pending' as const },
      ],
      activeSubtaskId: 'analyze' as string | null,
    };
    useContextStore.getState().setTaskPlan(plan);

    const result = await handleTaskAdvance(
      { subtask: 'Inspect', summary: 'Completed inspect phase: traced runtime boot, context store, and batch executor surface.' },
      createMockCtx() as unknown as Parameters<typeof handleTaskAdvance>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('task_advance: analyze(active)');
  });

  it('advances via case-insensitive id match', async () => {
    const plan = {
      goal: 'x',
      subtasks: [
        { id: 'Analyze', title: 'Inspect', status: 'active' as const },
        { id: 'Report', title: 'Summarize', status: 'pending' as const },
      ],
      activeSubtaskId: 'Analyze' as string | null,
    };
    useContextStore.getState().setTaskPlan(plan);

    const result = await handleTaskAdvance(
      { subtask: 'analyze', summary: 'Case-insensitive id match — advance phase with enough detail to satisfy min.' },
      createMockCtx() as unknown as Parameters<typeof handleTaskAdvance>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('task_advance: Analyze(active)');
  });

  it('rejects ambiguous title match (two subtasks share a title)', async () => {
    const plan = {
      goal: 'x',
      subtasks: [
        { id: 'a', title: 'Inspect', status: 'active' as const },
        { id: 'b', title: 'Inspect', status: 'pending' as const },
      ],
      activeSubtaskId: 'a' as string | null,
    };
    useContextStore.getState().setTaskPlan(plan);

    const result = await handleTaskAdvance(
      { subtask: 'Inspect', summary: 'Ambiguous title — should not pick silently; enough chars to pass the summary gate.' },
      createMockCtx() as unknown as Parameters<typeof handleTaskAdvance>[1],
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found in plan');
  });

  it('resolves colon-prefixed string subtasks from session.plan for explicit session.advance', async () => {
    const ctx = createMockCtx() as unknown as Parameters<typeof handleTaskPlan>[1];
    const planResult = await handleTaskPlan(
      {
        goal: 'multi-phase',
        subtasks: [
          'round1_discover: Discovery — tree (DONE)',
          'round2_read_pin: Read and pin (DONE)',
          'round3_analyze: Analyze deps',
        ],
      },
      ctx,
    );
    expect(planResult.ok).toBe(true);

    const adv = await handleTaskAdvance(
      {
        subtask: 'round2_read_pin',
        summary:
          'Rounds 1-2 complete. Got tree, read executor sig, pinned chunk. Need to advance plan past discovery.',
      },
      ctx,
    );
    expect(adv.ok).toBe(true);
    expect(adv.summary).toContain('task_advance: round2_read_pin(active)');
    const updated = useContextStore.getState().taskPlan;
    expect(updated?.subtasks.find(s => s.id === 'round1_discover')?.status).toBe('done');
    expect(updated?.subtasks.find(s => s.id === 'round2_read_pin')?.status).toBe('active');
  });
});

describe('handleStage', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('defaults context_lines to 3 for read_lines staging', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({
      content: '   1|line1\n   2|line2\n   3|line3\n   4|line4',
      actual_range: [[1, 4]],
      target_range: [[2, 3]],
      context_lines: 3,
    });
    const result = await handleStage(
      { hash: 'h:abc123', lines: '2-3' },
      createMockCtx({ atlsBatchQuery }) as unknown as Parameters<typeof handleStage>[1],
    );

    expect(result.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenCalledWith('read_lines', {
      hash: 'h:abc123',
      lines: '2-3',
      context_lines: 3,
    });
    expect(result.summary).toContain('ctx:3');
  });

  it('uses a span-unique stage key and stores source revision for exact spans', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({
      content: 'line2\nline3',
      actual_range: [[2, 3]],
      target_range: [[2, 3]],
      context_lines: 0,
    });

    const result = await handleStage(
      { hash: 'h:abc123', lines: '2-3', context_lines: 0 },
      createMockCtx({ atlsBatchQuery }) as unknown as Parameters<typeof handleStage>[1],
    );

    expect(result.ok).toBe(true);
    const staged = useContextStore.getState().stagedSnippets.get('h:abc123:2-3:ctx(0)');
    expect(staged).toBeDefined();
    expect(staged?.sourceRevision).toBe('abc123');
  });

  it('retries read_lines after stale when context refresh returns a new hash', async () => {
    const store = useContextStore.getState();
    const short = store.addChunk('line1\nline2\nline3', 'result', 'src/stale-stage.ts', undefined, undefined, 'oldrev');

    let readLinesCalls = 0;
    const atlsBatchQuery = vi.fn(async (op: string, params: Record<string, unknown>) => {
      if (op === 'read_lines') {
        readLinesCalls += 1;
        if (readLinesCalls === 1) return { error: 'stale' };
        return { content: '   2|line2\n   3|line3' };
      }
      if (op === 'context') {
        return {
          results: [{ file: 'src/stale-stage.ts', content_hash: 'newrev', content: 'line1\nline2\nline3' }],
        };
      }
      return {};
    });

    const result = await handleStage(
      { hash: `h:${short}`, lines: '2-3', context_lines: 0 },
      createMockCtx({ atlsBatchQuery }) as unknown as Parameters<typeof handleStage>[1],
    );

    expect(result.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenCalledWith(
      'context',
      expect.objectContaining({ type: 'full', file_paths: ['src/stale-stage.ts'] }),
    );
    expect(readLinesCalls).toBe(2);
  });
});

describe('handlePin', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('adds a hint when h: prefix is used with a step-like id and nothing pins (zero-match errs)', async () => {
    const result = await handlePin(
      { hashes: ['h:r1', 'h:r2'] },
      createMockCtx() as unknown as Parameters<typeof handlePin>[1],
    );
    // Zero-match retention ops now err loudly instead of silently returning ok
    // (prevents the templated-stub spin).
    expect(result.ok).toBe(false);
    expect(result.error).toContain('pin: ERROR no matching chunks');
    expect(result.error).toContain('from_step');
    expect(result.error).toContain('h:r1');
  });

  it('materializes file_refs step output into chunks before pinning hashes', async () => {
    const fileRefsOut: StepOutput = {
      kind: 'file_refs',
      ok: true,
      refs: ['h:deadbeef'],
      summary: 'read',
      content: {
        results: [
          {
            file: 'src/pin-mat.ts',
            content: 'export const x = 1;\n',
            hash: 'deadbeef',
            content_hash: 'rev-pin-1',
          },
        ],
      },
    };
    const stepOutputs = new Map<string, StepOutput>([['read_step', fileRefsOut]]);
    const ctx = {
      ...createMockCtx(),
      forEachStepOutput: (fn: (id: string, out: StepOutput) => void) => {
        for (const [id, out] of stepOutputs) fn(id, out);
      },
      getStepOutput: (id: string) => stepOutputs.get(id),
    } as unknown as Parameters<typeof handlePin>[1];

    const result = await handlePin({ hashes: ['h:deadbeef'] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/pin: 1 chunk/);
    expect(useContextStore.getState().getChunkContent('h:deadbeef')).toContain('export const x');
  });

  it('recovers dataflow from params.in string (with: { in: "r1.refs" })', async () => {
    const h = useContextStore.getState().addChunk('pin-via-in', 'search', 'recover.ts');
    const stepOutputs = new Map<string, StepOutput>([
      ['r1', { kind: 'file_refs', ok: true, refs: [`h:${h}`], summary: 'read' }],
    ]);
    const ctx = {
      ...createMockCtx(),
      forEachStepOutput: (fn: (id: string, out: StepOutput) => void) => {
        for (const [id, out] of stepOutputs) fn(id, out);
      },
      getStepOutput: (id: string) => stepOutputs.get(id),
    } as unknown as Parameters<typeof handlePin>[1];

    const result = await handlePin({ in: 'r1.refs' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/pin: 1 chunk/);
  });

  it('recovers dataflow from params.in with in: prefix ("in:r1.refs")', async () => {
    const h = useContextStore.getState().addChunk('pin-via-in-prefix', 'search', 'recover2.ts');
    const stepOutputs = new Map<string, StepOutput>([
      ['r1', { kind: 'file_refs', ok: true, refs: [`h:${h}`], summary: 'read' }],
    ]);
    const ctx = {
      ...createMockCtx(),
      forEachStepOutput: (fn: (id: string, out: StepOutput) => void) => {
        for (const [id, out] of stepOutputs) fn(id, out);
      },
      getStepOutput: (id: string) => stepOutputs.get(id),
    } as unknown as Parameters<typeof handlePin>[1];

    const result = await handlePin({ in: 'in:r1.refs' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/pin: 1 chunk/);
  });

  it('still errors when params.in references nonexistent step', async () => {
    const ctx = {
      ...createMockCtx(),
      getStepOutput: () => undefined,
    } as unknown as Parameters<typeof handlePin>[1];

    const result = await handlePin({ in: 'r99.refs' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no hashes supplied/);
  });

  it('includes executor binding warning when hashes resolved to nothing from from_step', async () => {
    const result = await handlePin(
      {
        _binding_warning_hashes:
          "hashes: resolved to nothing from step 's3' (0 refs). Use explicit path or provide value directly.",
      },
      createMockCtx() as unknown as Parameters<typeof handlePin>[1],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("step 's3'");
    expect(result.error).toMatch(/deduped|empty/i);
  });
});

describe('handleDrop', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('scope:dormant drops compacted unpinned chunks without explicit hashes', async () => {
    const store = useContextStore.getState();
    const short = store.addChunk('content to compact', 'smart', 'src/dormant.ts', undefined, undefined, 'rev1', {
      sourceRevision: 'rev1',
      viewKind: 'latest',
    });
    const { compacted } = store.compactChunks([`h:${short}`]);
    expect(compacted).toBe(1);

    const ctx = createMockCtx() as unknown as Parameters<typeof handleDrop>[1];
    const result = await handleDrop({ scope: 'dormant' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('scope:dormant');
    expect(
      Array.from(useContextStore.getState().chunks.values()).some(c => c.shortHash === short),
    ).toBe(false);
  });

  it('scope:dormant returns ok when no dormant compacted chunks exist', async () => {
    const ctx = createMockCtx() as unknown as Parameters<typeof handleDrop>[1];
    const result = await handleDrop({ scope: 'dormant' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/0 dormant/);
  });

  it('requires hashes when scope is not dormant/archived', async () => {
    const ctx = createMockCtx() as unknown as Parameters<typeof handleDrop>[1];
    const result = await handleDrop({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no hashes supplied/);
  });

  it('scope:archived drops archived chunks without explicit hashes', async () => {
    const store = useContextStore.getState();
    const short = store.addChunk('archived body', 'smart', 'src/arch.ts', undefined, undefined, 'archrev', {
      sourceRevision: 'archrev',
      viewKind: 'latest',
    });
    // Move to archive via unload.
    store.unloadChunks([`h:${short}`]);
    expect(
      Array.from(useContextStore.getState().archivedChunks.values()).some(c => c.shortHash === short),
    ).toBe(true);

    const ctx = createMockCtx() as unknown as Parameters<typeof handleDrop>[1];
    const result = await handleDrop({ scope: 'archived' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('scope:archived');
    expect(
      Array.from(useContextStore.getState().archivedChunks.values()).some(c => c.shortHash === short),
    ).toBe(false);
  });

  it('scope:archived returns ok when nothing archived', async () => {
    const ctx = createMockCtx() as unknown as Parameters<typeof handleDrop>[1];
    const result = await handleDrop({ scope: 'archived' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/0 archived/);
  });
});

describe('handleStats', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('includes memory telemetry aggregates in stats output', async () => {
    const store = useContextStore.getState();
    store.recordMemoryEvent({
      action: 'retry',
      reason: 'medium_confidence_rebind',
      confidence: 'medium',
      strategy: 'symbol_identity',
      factors: ['symbol_identity'],
    });
    store.recordMemoryEvent({
      action: 'block',
      reason: 'stale_hash',
    });

    const result = await handleStats(
      {},
      createMockCtx() as unknown as Parameters<typeof handleStats>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('mem:2');
    expect(result.summary).toContain('rebind:1');
    expect(result.summary).toContain('block:1');
    expect(result.summary).toContain('retry:1');
  });
});

describe('handleTaskAdvance advance gate', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('warns when advancing without BB findings or edits', async () => {
    const plan = {
      goal: 'test advance gate',
      subtasks: [
        { id: 'a', title: 'phase a', status: 'active' as const },
        { id: 'b', title: 'phase b', status: 'pending' as const },
      ],
      activeSubtaskId: 'a' as string | null,
    };
    useContextStore.getState().setTaskPlan(plan);

    const result = await handleTaskAdvance(
      { summary: 'Moving on without writing findings — this should trigger the advance gate warning.' },
      createMockCtx() as unknown as Parameters<typeof handleTaskAdvance>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('WARNING');
    expect(result.summary).toContain('Advancing without BB findings');
  });

  it('does not warn when BB write happened before advance', async () => {
    const plan = {
      goal: 'test advance gate with findings',
      subtasks: [
        { id: 'a', title: 'phase a', status: 'active' as const },
        { id: 'b', title: 'phase b', status: 'pending' as const },
      ],
      activeSubtaskId: 'a' as string | null,
    };
    useContextStore.getState().setTaskPlan(plan);
    useContextStore.getState().setBlackboardEntry('finding:test', 'clear — no issues found');
    useContextStore.setState(state => ({
      batchMetrics: { ...state.batchMetrics, hadBbWrite: true, hadSubstantiveBbWrite: true },
    }));

    const result = await handleTaskAdvance(
      { summary: 'Phase a complete: examined target, wrote finding, no issues found in the code.' },
      createMockCtx() as unknown as Parameters<typeof handleTaskAdvance>[1],
    );

    expect(result.ok).toBe(true);
    expect(result.summary).not.toContain('WARNING');
  });
});

describe('handleTaskPlan', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('errors when goal missing', async () => {
    const r = await handleTaskPlan({ subtasks: ['a: A'] }, createMockCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing goal/);
  });

  it('accepts object subtasks', async () => {
    const r = await handleTaskPlan(
      { goal: 'g', subtasks: [{ id: 'x1', title: 'T1' }] },
      createMockCtx() as any,
    );
    expect(r.ok).toBe(true);
    const p = useContextStore.getState().taskPlan;
    expect(p?.subtasks[0]).toMatchObject({ id: 'x1', title: 'T1', status: 'active' });
  });

  it('accepts scalar string subtasks (OpenAI-style single label)', async () => {
    const r = await handleTaskPlan({ goal: 'g', subtasks: 'analyze' }, createMockCtx() as any);
    expect(r.ok).toBe(true);
    const p = useContextStore.getState().taskPlan;
    expect(p?.subtasks).toHaveLength(1);
    expect(p?.subtasks[0]).toMatchObject({ id: 'analyze', title: 'analyze', status: 'active' });
  });
});

describe('handleTaskStatus', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('reports no plan', async () => {
    const r = await handleTaskStatus({}, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/no plan/);
  });

  it('lists subtask statuses', async () => {
    await handleTaskPlan(
      { goal: 'g2', subtasks: ['p1: One', 'p2: Two'] },
      createMockCtx() as any,
    );
    const r = await handleTaskStatus({}, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('p1(active)');
    expect(r.summary).toContain('p2(pending)');
  });
});

describe('handleTaskAdvance errors', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('errors when no plan', async () => {
    const r = await handleTaskAdvance(
      { summary: 'x'.repeat(60) },
      createMockCtx() as any,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no active plan/);
  });

  it('errors when no active subtask', async () => {
    // Bypass setTaskPlan normalization (it forces an active subtask when none marked active).
    const now = Date.now();
    useContextStore.setState({
      taskPlan: {
        id: 'inconsistent',
        goal: 'g',
        subtasks: [
          { id: 'a', title: 'a', status: 'pending' },
          { id: 'b', title: 'b', status: 'pending' },
        ],
        activeSubtaskId: 'a',
        status: 'active',
        createdAt: now,
        retryCount: 0,
        evidenceRefs: [],
      },
    });
    const r = await handleTaskAdvance({ summary: 'y'.repeat(60) }, createMockCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no active subtask/);
  });

  it('errors when explicit subtask missing', async () => {
    useContextStore.getState().setTaskPlan({
      goal: 'g',
      subtasks: [{ id: 'a', title: 'a', status: 'active' as const }],
      activeSubtaskId: 'a',
    });
    const r = await handleTaskAdvance(
      { subtask: 'nope', summary: 'z'.repeat(60) },
      createMockCtx() as any,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it('errors when subtask already done', async () => {
    useContextStore.getState().setTaskPlan({
      goal: 'g',
      subtasks: [
        { id: 'a', title: 'a', status: 'done' as const },
        { id: 'b', title: 'b', status: 'active' as const },
      ],
      activeSubtaskId: 'b',
    });
    const r = await handleTaskAdvance(
      { subtask: 'a', summary: 'z'.repeat(60) },
      createMockCtx() as any,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already done/);
  });

  it('errors when summary too short', async () => {
    useContextStore.getState().setTaskPlan({
      goal: 'g',
      subtasks: [
        { id: 'a', title: 'a', status: 'active' as const },
        { id: 'b', title: 'b', status: 'pending' as const },
      ],
      activeSubtaskId: 'a',
    });
    const r = await handleTaskAdvance({ summary: 'short' }, createMockCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/min 50 chars/);
  });
});

describe('handleUnload / handleCompact', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('handleUnload frees chunks', async () => {
    const h = useContextStore.getState().addChunk('body', 'smart', 'f.ts');
    const ctx = createMockCtx() as any;
    const r = await handleUnload({ hashes: [`h:${h}`] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/unload:/);
  });

  it('handleUnload errors when hashes missing', async () => {
    const r = await handleUnload({}, createMockCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no hashes supplied/);
  });

  it('handleCompact compacts chunks (pointer tier)', async () => {
    const h = useContextStore.getState().addChunk('compact me', 'smart', 'c.ts');
    const ctx = createMockCtx() as any;
    const r = await handleCompact({ hashes: [`h:${h}`] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/compact:/);
  });

  it('handleCompact tier sig resolves signature content via invoke', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { rawRef?: string }) => {
      if (cmd === 'register_hash_content') return null;
      if (cmd === 'resolve_hash_ref' && args?.rawRef?.endsWith(':sig')) {
        return { content: 'SIG_DIGEST_FOR_TESTS' };
      }
      return null;
    });
    const h = useContextStore.getState().addChunk('body for sig compact', 'smart', 'sig.ts');
    const ctx = createMockCtx() as any;
    const r = await handleCompact({ hashes: [`h:${h}`], tier: 'sig' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('sig tier');
    expect(invokeMock).toHaveBeenCalledWith('register_hash_content', expect.any(Object));
    expect(invokeMock).toHaveBeenCalledWith('resolve_hash_ref', expect.objectContaining({ rawRef: expect.stringContaining(':sig') }));
  });

  it('handleCompact errors when hashes missing', async () => {
    const r = await handleCompact({}, createMockCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no hashes supplied/);
  });
});

describe('handleStage content and batch', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    invokeMock.mockClear();
  });

  it('stages raw content with label', async () => {
    const r = await handleStage(
      { content: 'inline body', label: 'lbl' },
      createMockCtx() as any,
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/staged \[lbl\]/);
  });

  it('stage_batch resolves hashes via invoke', async () => {
    const r = await handleStage(
      { hashes: ['deadbeef12'] },
      createMockCtx({ sessionId: 's1' }) as any,
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/stage_batch/);
    expect(invokeMock).toHaveBeenCalled();
  });
});

describe('handleUnstage', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('unstages all with hashes *', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('k1', 'a', 's', undefined, undefined, undefined, 'snapshot');
    const r = await handleUnstage({ hashes: ['*'] }, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/unstaged all/);
  });

  it('errors when nothing matched', async () => {
    const r = await handleUnstage({ hashes: ['h:deadbeef', 'h:cafebabe'] }, createMockCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/none of/);
  });

  it('unstages by hash key', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('h:abc', 'x', 's', undefined, undefined, undefined, 'snapshot');
    const r = await handleUnstage({ hash: 'abc' }, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('h:abc');
  });
});

describe('handleUnpin', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('unpins after pin', async () => {
    const h = useContextStore.getState().addChunk('p', 'smart', 'p.ts');
    await handlePin({ hashes: [`h:${h}`] }, createMockCtx() as any);
    const r = await handleUnpin({ hashes: [`h:${h}`] }, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/unpin:/);
  });

  it('errors when hashes missing', async () => {
    const r = await handleUnpin({}, createMockCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no hashes supplied/);
  });

  it('recovers dataflow from params.in string', async () => {
    const h = useContextStore.getState().addChunk('unpin-in', 'search', 'unpin-in.ts');
    await handlePin({ hashes: [`h:${h}`] }, createMockCtx() as any);
    const stepOutputs = new Map<string, StepOutput>([
      ['r1', { kind: 'raw', ok: true, refs: [`h:${h}`], summary: 'read' }],
    ]);
    const ctx = {
      ...createMockCtx(),
      getStepOutput: (id: string) => stepOutputs.get(id),
    } as unknown as Parameters<typeof handleUnpin>[1];
    const r = await handleUnpin({ in: 'r1.refs' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/unpin: 1/);
  });
});

describe('handleRecall', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
    resetRecallBudget();
  });

  it('returns chunk content', async () => {
    const h = useContextStore.getState().addChunk('recall-body', 'smart', 'r.ts');
    const r = await handleRecall({ hashes: [`h:${h}`] }, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('recall-body');
  });

  it('truncates oversized recall', async () => {
    const big = `${'Q'.repeat(51_000)}`;
    const h = useContextStore.getState().addChunk(big, 'smart', 'big.ts');
    const r = await handleRecall({ hashes: [`h:${h}`] }, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('[truncated at 50k chars]');
  });

  it('respects batch char budget', async () => {
    resetRecallBudget();
    const a = useContextStore.getState().addChunk('A'.repeat(60_000), 'smart', 'a.ts');
    const b = useContextStore.getState().addChunk('B'.repeat(60_000), 'smart', 'b.ts');
    const r = await handleRecall({ hashes: [`h:${a}`, `h:${b}`] }, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('BUDGET_EXCEEDED');
  });

  it('recovers dataflow from params.in string', async () => {
    resetRecallBudget();
    const h = useContextStore.getState().addChunk('recall-in-body', 'smart', 'recall-in.ts');
    const stepOutputs = new Map<string, StepOutput>([
      ['r1', { kind: 'raw', ok: true, refs: [`h:${h}`], summary: 'read' }],
    ]);
    const ctx = {
      ...createMockCtx(),
      getStepOutput: (id: string) => stepOutputs.get(id),
    } as unknown as Parameters<typeof handleRecall>[1];
    const r = await handleRecall({ in: 'r1.refs' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('recall-in-body');
  });
});

describe('handleSessionDebug', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('includes chunk and plan summary', async () => {
    useContextStore.getState().addChunk('d', 'smart', 'd.ts');
    await handleTaskPlan({ goal: 'dg', subtasks: ['s1: Step'] }, createMockCtx() as any);
    const r = await handleSessionDebug({}, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/debug:/);
    expect(r.summary).toContain('Plan:');
  });
});

describe('handleCompactHistory', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  function compressibleHistory(): Array<{ role: string; content: unknown }> {
    const oldestAssistant = 'A'.repeat(4000);
    const recentAssistant = 'B'.repeat(4000);
    const latestAssistant = 'C'.repeat(4000);
    return [
      { role: 'user', content: 'initial request' },
      { role: 'assistant', content: oldestAssistant },
      { role: 'user', content: 'tool results 1' },
      { role: 'assistant', content: 'round 1 filler' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'round 2 filler' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: recentAssistant },
      { role: 'user', content: 'tool results 4' },
      { role: 'assistant', content: latestAssistant },
      { role: 'user', content: 'tool results 5' },
    ];
  }

  it('no tool loop state', async () => {
    const r = await handleCompactHistory({}, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/no active tool loop/);
  });

  it('compresses when tool loop state present', async () => {
    const history = compressibleHistory();
    const r = await handleCompactHistory(
      {},
      {
        ...createMockCtx(),
        toolLoopState: {
          round: 8,
          priorTurnBoundary: 0,
          conversationHistory: history,
        },
      } as any,
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/compact_history: compressed/);
  });
});

describe('handleDrop scope dormant max', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('respects max when collecting dormant hashes', async () => {
    const store = useContextStore.getState();
    const hashes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sh = store.addChunk(`c${i}`, 'smart', `src/x${i}.ts`, undefined, undefined, `rev${i}`, {
        sourceRevision: `rev${i}`,
        viewKind: 'latest',
      });
      hashes.push(`h:${sh}`);
    }
    const { compacted } = store.compactChunks(hashes);
    expect(compacted).toBeGreaterThan(0);

    const r = await handleDrop({ scope: 'dormant', max: 2 }, createMockCtx() as any);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('scope:dormant');
  });
});

// ---------------------------------------------------------------------------
// Ephemeral-retention handler defense — zero-match retention ops err loudly
// instead of silently returning ok, so the templated-stub spin pattern
// (`{use:"session.unpin"}` with no args, re-emitted from compacted history)
// surfaces as [FAIL] lines the model can self-correct on.
// ---------------------------------------------------------------------------

describe('retention handlers — ephemeral output defense', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('handleUnpin errs when no hashes supplied (compacted-stub reuse)', async () => {
    const result = await handleUnpin(
      {},
      createMockCtx() as unknown as Parameters<typeof handleUnpin>[1],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no hashes supplied/);
    expect(result.error).toMatch(/MANIFEST|manifest/);
    expect(result.error).toMatch(/ephemeral/i);
  });

  it('handleUnpin errs with "did not resolve" when refs are unknown', async () => {
    const result = await handleUnpin(
      { hashes: ['h:nonexistent123'] },
      createMockCtx() as unknown as Parameters<typeof handleUnpin>[1],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not resolve/);
    // Hints at wrong hash identity (cite vs retention).
    expect(result.error).toMatch(/cite:@h:|retention/);
  });

  it('handleUnpin returns ok no-op when refs are already unpinned', async () => {
    const store = useContextStore.getState();
    const h = store.addChunk('content', 'smart', 'src/noop.ts');
    // pin then unpin so the ref exists but is already unpinned
    await handlePin({ hashes: [`h:${h}`] }, createMockCtx() as any);
    await handleUnpin({ hashes: [`h:${h}`] }, createMockCtx() as any);
    // second unpin of the same ref: existing but already released
    const result = await handleUnpin(
      { hashes: [`h:${h}`] },
      createMockCtx() as any,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/already unpinned.*no-op/);
  });

  it('handlePin errs when no hashes supplied', async () => {
    const result = await handlePin(
      {},
      createMockCtx() as unknown as Parameters<typeof handlePin>[1],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no hashes supplied/);
    expect(result.error).toMatch(/ephemeral/i);
  });

  it('handleDrop errs when no hashes and no scope supplied', async () => {
    const result = await handleDrop(
      {},
      createMockCtx() as unknown as Parameters<typeof handleDrop>[1],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no hashes supplied/);
  });

  it('handleDrop errs when explicit hashes resolve to zero matches', async () => {
    const result = await handleDrop(
      { hashes: ['h:nonexistent456'] },
      createMockCtx() as unknown as Parameters<typeof handleDrop>[1],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no matching refs in manifest/);
  });

  it('handleUnload errs when no hashes supplied', async () => {
    const result = await handleUnload(
      {},
      createMockCtx() as unknown as Parameters<typeof handleUnload>[1],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no hashes supplied/);
  });

  it('handleCompact errs when no hashes supplied', async () => {
    const result = await handleCompact(
      {},
      createMockCtx() as unknown as Parameters<typeof handleCompact>[1],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no hashes supplied/);
  });
});
