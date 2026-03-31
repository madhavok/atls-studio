/**
 * Unit tests for session handlers — task_advance, hashes/refs unification.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handlePin, handleStage, handleStats, handleTaskAdvance, handleTaskPlan } from './session';
import { useContextStore } from '../../../stores/contextStore';

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
});

describe('handlePin', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('adds a hint when h: prefix is used with a step-like id and nothing pins', async () => {
    const result = await handlePin(
      { hashes: ['h:r1', 'h:r2'] },
      createMockCtx() as unknown as Parameters<typeof handlePin>[1],
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('pin: no matching chunks');
    expect(result.summary).toContain('from_step');
    expect(result.summary).toContain('h:r1');
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
