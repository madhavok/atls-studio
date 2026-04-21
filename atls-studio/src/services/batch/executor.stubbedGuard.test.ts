/**
 * Regression tests for stub-shape template calcification.
 *
 * When `stubBatchToolUseInputs` (historyCompressor.ts) compresses past
 * assistant batch tool_use inputs, it rewrites them to
 * `{_stubbed, _compressed: true}`. Earlier versions emitted
 * `{_stubbed, version: '1.0'}`, which looked like a legal batch envelope.
 * The model (observed in production transport logs) copied that shape as
 * its next tool call, and the executor silently accepted it as a 0-step
 * batch. These tests ensure `executeUnifiedBatch` rejects the stubbed
 * shape and any other empty envelope with an actionable error.
 */

import { describe, expect, it, vi } from 'vitest';
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
    isStepCountExceeded: () => false,
    evaluateCondition: actual.evaluateCondition,
    isBlockedForSwarm: actual.isBlockedForSwarm,
  };
});

vi.mock('./handlers/session', () => ({
  resetRecallBudget: () => {},
}));

import { executeUnifiedBatch } from './executor';
import { validateBatchEnvelope } from './validateBatchSteps';
import type { UnifiedBatchRequest } from './types';

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
      setAwareness: () => {},
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

function raw(summary: string, content: Record<string, unknown>, ok = true): StepOutput {
  return { kind: 'raw', ok, refs: [], summary, content };
}

describe('validateBatchEnvelope — unit', () => {
  it('rejects envelope with _stubbed sentinel', () => {
    const result = validateBatchEnvelope({ _stubbed: '1 step: session x1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stubbed/i);
  });

  it('rejects envelope with _compressed sentinel', () => {
    const result = validateBatchEnvelope({ _compressed: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stubbed/i);
  });

  it('rejects envelope with both _stubbed and _compressed (the production shape)', () => {
    const result = validateBatchEnvelope({
      _stubbed: '6 steps: read x6',
      _compressed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stubbed/i);
  });

  it('rejects envelope with empty steps and no q', () => {
    const result = validateBatchEnvelope({ version: '1.0', steps: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty batch envelope/i);
  });

  it('rejects envelope with neither steps nor q', () => {
    const result = validateBatchEnvelope({ version: '1.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty batch envelope/i);
  });

  it('accepts envelope with non-empty steps', () => {
    const result = validateBatchEnvelope({
      version: '1.0',
      steps: [{ id: 's1', use: 'session.stats' }],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts envelope with q: DSL block', () => {
    const result = validateBatchEnvelope({
      version: '1.0',
      q: 's1 session.stats',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects envelope with whitespace-only q string', () => {
    const result = validateBatchEnvelope({ version: '1.0', q: '   \n  ' });
    expect(result.ok).toBe(false);
  });
});

describe('executeUnifiedBatch — stubbed-envelope rejection', () => {
  it('rejects the exact production calcification shape without invoking handlers', async () => {
    const handlerSpy = vi.fn();
    handlers.clear();
    handlers.set('session.stats', handlerSpy as unknown as OpHandler);

    const stubbed = {
      _stubbed: '1 step: session x1',
      _compressed: true,
    } as unknown as UnifiedBatchRequest;

    const result = await executeUnifiedBatch(stubbed, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/stubbed envelope/i);
    expect(result.step_results).toHaveLength(1);
    expect(result.step_results[0].id).toBe('__batch_envelope__');
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('rejects legacy {_stubbed, version} shape (pre-fix, still seen in conversations in flight)', async () => {
    const handlerSpy = vi.fn();
    handlers.clear();
    handlers.set('session.stats', handlerSpy as unknown as OpHandler);

    const legacyStubbed = {
      _stubbed: '6 steps: read x6',
      version: '1.0',
    } as unknown as UnifiedBatchRequest;

    const result = await executeUnifiedBatch(legacyStubbed, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/stubbed envelope/i);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('rejects empty-steps envelope with no q (no silent 0-step success)', async () => {
    const handlerSpy = vi.fn();
    handlers.clear();
    handlers.set('session.stats', handlerSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      { version: '1.0', steps: [] } as unknown as UnifiedBatchRequest,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/empty batch envelope/i);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('passes a normal non-empty batch through to handlers', async () => {
    const handlerSpy = vi.fn().mockReturnValue(raw('ok', { tokens: 0 }));
    handlers.clear();
    handlers.set('session.stats', handlerSpy as unknown as OpHandler);

    const result = await executeUnifiedBatch(
      {
        version: '1.0',
        steps: [{ id: 's1', use: 'session.stats' }],
      },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(result.step_results[0].id).toBe('s1');
  });
});
