import { describe, it, expect } from 'vitest';
import type { UnifiedBatchResult, StepResult } from './batch/types';

const { buildBatchSyntheticToolCalls } = await import('./aiService');

describe('buildBatchSyntheticToolCalls', () => {
  const makeResult = (steps: Partial<StepResult>[]): UnifiedBatchResult => ({
    ok: true,
    summary: 'test',
    duration_ms: 100,
    step_results: steps.map((s, i) => ({
      id: s.id ?? `s${i + 1}`,
      use: s.use ?? ('read.context' as StepResult['use']),
      ok: s.ok ?? true,
      duration_ms: s.duration_ms ?? 10,
      ...s,
    })) as StepResult[],
  });

  it('maps step results to synthetic tool call events', () => {
    const result = makeResult([
      { id: 'r1', use: 'search.code' as StepResult['use'], ok: true, summary: 'found 3 matches' },
      { id: 'e1', use: 'change.edit' as StepResult['use'], ok: false, error: 'file not found' },
    ]);
    const batchArgs = {
      id: 'b1',
      steps: [
        { id: 'r1', use: 'search.code', with: { queries: ['foo'] } },
        { id: 'e1', use: 'change.edit', with: { file: 'src/x.ts' } },
      ],
    };

    const children = buildBatchSyntheticToolCalls(result, batchArgs);
    expect(children).toHaveLength(2);
    expect(children[0].name).toBe('search.code');
    expect(children[0].status).toBe('completed');
    expect(children[0].args.step_id).toBe('r1');
    expect(children[0].args.queries).toEqual(['foo']);
    expect(children[1].status).toBe('failed');
  });

  it('threads toolTrace from delegate artifacts into args', () => {
    const trace = [
      { toolName: 'search.code', message: 'Searching: foo', round: 0, ts: 1000, done: false },
      { toolName: 'search.code', message: 'Done: search.code', round: 0, ts: 1001, done: true },
      { toolName: 'session.pin', message: 'Pinning findings...', round: 1, ts: 1500, done: false },
    ];
    const result = makeResult([
      {
        id: 'd1',
        use: 'delegate.retrieve' as StepResult['use'],
        ok: true,
        summary: 'retriever: 4 refs',
        artifacts: { toolTrace: trace, toolCalls: 2, rounds: 2 },
      },
    ]);
    const batchArgs = {
      steps: [{ id: 'd1', use: 'delegate.retrieve', with: { query: 'find auth' } }],
    };

    const children = buildBatchSyntheticToolCalls(result, batchArgs);
    expect(children).toHaveLength(1);
    expect(children[0].args.toolTrace).toEqual(trace);
  });

  it('omits toolTrace when not present in artifacts', () => {
    const result = makeResult([
      { id: 's1', use: 'search.code' as StepResult['use'], ok: true, summary: 'done' },
    ]);
    const batchArgs = { steps: [{ id: 's1', use: 'search.code', with: {} }] };

    const children = buildBatchSyntheticToolCalls(result, batchArgs);
    expect(children[0].args).not.toHaveProperty('toolTrace');
  });
});
