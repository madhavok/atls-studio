import { beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateSpin,
  resetSpinCircuitBreaker,
  getSpinCircuitBreakerState,
} from './spinCircuitBreaker';
import type { SpinDiagnosis } from './spinDetector';
import type { RoundSnapshot } from '../stores/roundHistoryStore';

function snap(round: number, turnId: number = 1): RoundSnapshot {
  // Minimal shape — spinCircuitBreaker only reads turnId / isSubagentRound /
  // isSwarmRound, and we force the diagnosis via `diagnosisOverride`.
  return {
    round,
    timestamp: round * 1000,
    turnId,
    wmTokens: 0,
    bbTokens: 0,
    stagedTokens: 0,
    archivedTokens: 0,
    overheadTokens: 0,
    freeTokens: 0,
    maxTokens: 200_000,
    staticSystemTokens: 0,
    conversationHistoryTokens: 0,
    stagedBucketTokens: 0,
    workspaceContextTokens: 0,
    providerInputTokens: 0,
    estimatedTotalPromptTokens: 0,
    cacheStablePrefixTokens: 0,
    cacheChurnTokens: 0,
    reliefAction: 'none',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCents: 0,
    compressionSavings: 0,
    rollingSavings: 0,
    rolledRounds: 0,
    rollingSummaryTokens: 0,
    freedTokens: 0,
    cumulativeSaved: 0,
    toolCalls: 0,
    manageOps: 0,
    hypotheticalNonBatchedCost: 0,
    actualCost: 0,
  } as RoundSnapshot;
}

function diag(mode: SpinDiagnosis['mode'], confidence: number, round = 1): SpinDiagnosis {
  return {
    spinning: confidence >= 0.3,
    mode,
    confidence,
    evidence: [],
    triggerRound: round,
    suggestedAction: `Handle ${mode}`,
  };
}

describe('spinCircuitBreaker', () => {
  beforeEach(() => resetSpinCircuitBreaker());

  it('returns tier "none" when diagnosis is not spinning', () => {
    const ev = evaluateSpin([snap(1)], { diagnosisOverride: diag('none', 0) });
    expect(ev.tier).toBe('none');
    expect(ev.shouldHalt).toBe(false);
    expect(ev.message).toBeUndefined();
  });

  it('returns tier "none" when confidence below minConfidence threshold', () => {
    const ev = evaluateSpin([snap(1)], { diagnosisOverride: diag('context_loss', 0.5) });
    expect(ev.tier).toBe('none');
  });

  it('first detection yields tier "nudge" with mode-specific message', () => {
    const ev = evaluateSpin([snap(1)], { diagnosisOverride: diag('context_loss', 0.8) });
    expect(ev.tier).toBe('nudge');
    expect(ev.shouldHalt).toBe(false);
    expect(ev.message).toContain('SPIN — context loss');
  });

  it('escalates to "strong" on second consecutive same-mode detection', () => {
    evaluateSpin([snap(1)], { diagnosisOverride: diag('goal_drift', 0.75) });
    const ev = evaluateSpin([snap(2)], { diagnosisOverride: diag('goal_drift', 0.75) });
    expect(ev.tier).toBe('strong');
    expect(ev.message).toContain('CIRCUIT BREAKER');
    expect(ev.message).toContain('goal_drift');
    expect(ev.shouldHalt).toBe(false);
  });

  it('escalates to "halt" on third consecutive same-mode detection when haltEnabled', () => {
    evaluateSpin([snap(1)], { diagnosisOverride: diag('tool_confusion', 0.9), haltEnabled: true });
    evaluateSpin([snap(2)], { diagnosisOverride: diag('tool_confusion', 0.9), haltEnabled: true });
    const ev = evaluateSpin([snap(3)], {
      diagnosisOverride: diag('tool_confusion', 0.9),
      haltEnabled: true,
    });
    expect(ev.tier).toBe('halt');
    expect(ev.shouldHalt).toBe(true);
    expect(ev.message).toContain('CIRCUIT BREAKER HALTED');
  });

  it('suppresses "halt" tier to "strong" when haltEnabled=false (default)', () => {
    evaluateSpin([snap(1)], { diagnosisOverride: diag('tool_confusion', 0.9) });
    evaluateSpin([snap(2)], { diagnosisOverride: diag('tool_confusion', 0.9) });
    const ev = evaluateSpin([snap(3)], { diagnosisOverride: diag('tool_confusion', 0.9) });
    expect(ev.tier).toBe('strong');
    expect(ev.shouldHalt).toBe(false);
  });

  it('resets streak when mode changes mid-turn', () => {
    evaluateSpin([snap(1)], { diagnosisOverride: diag('context_loss', 0.8) });
    evaluateSpin([snap(2)], { diagnosisOverride: diag('context_loss', 0.8) });
    const ev = evaluateSpin([snap(3)], { diagnosisOverride: diag('goal_drift', 0.8) });
    expect(ev.tier).toBe('nudge');
    expect(ev.consecutiveSameMode).toBe(1);
  });

  it('resets streak when a clean round lands between detections (decay)', () => {
    evaluateSpin([snap(1)], { diagnosisOverride: diag('context_loss', 0.8) });
    evaluateSpin([snap(2)], { diagnosisOverride: diag('context_loss', 0.8) });
    // Clean round → streak decays
    evaluateSpin([snap(3)], { diagnosisOverride: diag('none', 0) });
    const ev = evaluateSpin([snap(4)], { diagnosisOverride: diag('context_loss', 0.8) });
    expect(ev.tier).toBe('nudge');
    expect(ev.consecutiveSameMode).toBe(1);
  });

  it('resets state on new turnId so spins do not leak across user turns', () => {
    evaluateSpin([snap(1, 1)], { diagnosisOverride: diag('context_loss', 0.8) });
    evaluateSpin([snap(2, 1)], { diagnosisOverride: diag('context_loss', 0.8) });
    // Same mode but on a NEW user turn — escalation state must reset.
    const ev = evaluateSpin([snap(3, 2)], { diagnosisOverride: diag('context_loss', 0.8) });
    expect(ev.tier).toBe('nudge');
    expect(getSpinCircuitBreakerState()?.turnId).toBe(2);
  });

  it('resetSpinCircuitBreaker clears the internal state', () => {
    evaluateSpin([snap(1)], { diagnosisOverride: diag('context_loss', 0.8) });
    expect(getSpinCircuitBreakerState()).not.toBeNull();
    resetSpinCircuitBreaker();
    expect(getSpinCircuitBreakerState()).toBeNull();
  });

  it('is idempotent on repeated calls with the same snapshots (but still advances on repeated diagnosis)', () => {
    // Each evaluateSpin call is treated as a "round tick" — callers are
    // responsible for invoking once per round. Document that behavior.
    const a = evaluateSpin([snap(1)], { diagnosisOverride: diag('volatile_unpinned', 0.95) });
    const b = evaluateSpin([snap(1)], { diagnosisOverride: diag('volatile_unpinned', 0.95) });
    expect(a.tier).toBe('nudge');
    expect(b.tier).toBe('strong');
  });

  it('volatile_unpinned nudge copy contains the pinning directive', () => {
    const ev = evaluateSpin([snap(1)], {
      diagnosisOverride: diag('volatile_unpinned', 0.95),
    });
    expect(ev.message).toContain('PINNING');
    expect(ev.message).toContain('pi ');
  });
});
