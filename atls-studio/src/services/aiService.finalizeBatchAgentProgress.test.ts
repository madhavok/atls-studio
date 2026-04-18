/**
 * Unit tests for finalizeBatchAgentProgress — the UI finalizer that maps
 * executor step outcomes onto pre-registered agent-progress rows.
 *
 * Regression: validation failures produced one summary line while N rows had
 * been pre-registered, so a line-index walk marked rows 1..N-1 "completed".
 */
import { describe, it, expect } from 'vitest';
import type { AgentToolSummary } from '../stores/appStore';

const { finalizeBatchAgentProgress } = await import('./aiService');

function row(stepId: string, id = `tc::${stepId}`): AgentToolSummary {
  return {
    id,
    parentId: 'tc',
    name: 'session.bb.write',
    detail: 'session.bb.write',
    status: 'pending',
    round: 1,
    stepId,
    stepIndex: 0,
    totalSteps: 3,
  };
}

describe('finalizeBatchAgentProgress', () => {
  it('marks rows without matching outcomes as failed on validation abort', () => {
    const summaries = [row('b1'), row('b2'), row('b3')];
    const outcomes = [{ id: '__batch_validation__', ok: false }];
    const out = finalizeBatchAgentProgress(summaries, outcomes, false);
    expect(out.map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('mirrors executor ok flag per step id (not positional)', () => {
    const summaries = [row('b1'), row('b2'), row('b3')];
    const outcomes = [
      { id: 'b1', ok: true },
      { id: 'b3', ok: false },
      { id: 'b2', ok: true },
    ];
    const out = finalizeBatchAgentProgress(summaries, outcomes, true);
    expect(out.find((r) => r.stepId === 'b1')?.status).toBe('completed');
    expect(out.find((r) => r.stepId === 'b2')?.status).toBe('completed');
    expect(out.find((r) => r.stepId === 'b3')?.status).toBe('failed');
  });

  it('treats rows without matching outcomes as failed even when batch ok', () => {
    const summaries = [row('b1'), row('unknown')];
    const outcomes = [{ id: 'b1', ok: true }];
    const out = finalizeBatchAgentProgress(summaries, outcomes, true);
    expect(out[0].status).toBe('completed');
    expect(out[1].status).toBe('failed');
  });

  it('handles missing outcomes array gracefully', () => {
    const summaries = [row('b1')];
    const out = finalizeBatchAgentProgress(summaries, undefined, false);
    expect(out[0].status).toBe('failed');
  });
});
