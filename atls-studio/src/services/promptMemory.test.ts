import { describe, it, expect } from 'vitest';
import {
  TOTAL_ROUND_SOFT_BUDGET,
  TOTAL_ROUND_ESCALATION,
  isPersistentAnchorKey,
  classifyStageSnippet,
  reconcileBudgets,
  CONVERSATION_HISTORY_BUDGET_TOKENS,
  STAGED_BUDGET_TOKENS,
  WM_BUDGET_TOKENS,
  WORKSPACE_CONTEXT_BUDGET_TOKENS,
  BLACKBOARD_BUDGET_TOKENS,
  TOTAL_SOFT_PRESSURE_PCT,
} from './promptMemory';

describe('convergence guard constants', () => {
  it('TOTAL_ROUND_SOFT_BUDGET is 6', () => {
    expect(TOTAL_ROUND_SOFT_BUDGET).toBe(6);
  });

  it('TOTAL_ROUND_ESCALATION is 8', () => {
    expect(TOTAL_ROUND_ESCALATION).toBe(8);
  });

  it('escalation > soft budget', () => {
    expect(TOTAL_ROUND_ESCALATION).toBeGreaterThan(TOTAL_ROUND_SOFT_BUDGET);
  });
});

describe('isPersistentAnchorKey / classifyStageSnippet', () => {
  it('isPersistentAnchorKey matches entry and edit prefixes', () => {
    expect(isPersistentAnchorKey('entry:foo')).toBe(true);
    expect(isPersistentAnchorKey('edit:bar')).toBe(true);
    expect(isPersistentAnchorKey('other:baz')).toBe(false);
  });

  it('classifyStageSnippet uses persistent anchor path for entry keys', () => {
    const small = classifyStageSnippet('entry:x', 50);
    expect(small.admissionClass).toBe('persistentAnchor');
    const other = classifyStageSnippet('note:x', 50);
    expect(other.admissionClass).toBe('transientAnchor');
  });
});

describe('reconcileBudgets (GAP 3)', () => {
  const DEFAULT_SUM =
    CONVERSATION_HISTORY_BUDGET_TOKENS
    + STAGED_BUDGET_TOKENS
    + WM_BUDGET_TOKENS
    + WORKSPACE_CONTEXT_BUDGET_TOKENS
    + BLACKBOARD_BUDGET_TOKENS;

  it('returns defaults and no pressure actions when well under budget', () => {
    const r = reconcileBudgets({
      contextWindowTokens: 200_000,
      staticSystemTokens: 3_000,
      toolDefTokens: 5_000,
      currentHistoryTokens: 0,
      currentStagedTokens: 0,
      currentWorkspaceContextTokens: 0,
      currentBlackboardTokens: 0,
      currentWmTokens: 0,
    });
    expect(r.availableTokens).toBe(200_000 - 3_000 - 5_000);
    expect(r.conversationHistoryBudgetTokens).toBe(CONVERSATION_HISTORY_BUDGET_TOKENS);
    expect(r.stagedBudgetTokens).toBe(STAGED_BUDGET_TOKENS);
    expect(r.wmBudgetTokens).toBe(WM_BUDGET_TOKENS);
    expect(r.workspaceContextBudgetTokens).toBe(WORKSPACE_CONTEXT_BUDGET_TOKENS);
    expect(r.blackboardBudgetTokens).toBe(BLACKBOARD_BUDGET_TOKENS);
    expect(r.plannedPressureActions).toEqual([]);
  });

  it('scales budgets down proportionally on a shrunken context window', () => {
    // Target: availableTokens small enough that defaultsSum > soft envelope.
    const contextWindowTokens = 40_000;
    const staticSystemTokens = 2_000;
    const toolDefTokens = 3_000;
    const available = contextWindowTokens - staticSystemTokens - toolDefTokens;
    const softEnvelope = Math.floor(available * TOTAL_SOFT_PRESSURE_PCT);
    expect(DEFAULT_SUM).toBeGreaterThan(softEnvelope);

    const r = reconcileBudgets({
      contextWindowTokens,
      staticSystemTokens,
      toolDefTokens,
      currentHistoryTokens: 0,
      currentStagedTokens: 0,
      currentWorkspaceContextTokens: 0,
      currentBlackboardTokens: 0,
      currentWmTokens: 0,
    });

    const reconciledSum = r.conversationHistoryBudgetTokens
      + r.stagedBudgetTokens
      + r.wmBudgetTokens
      + r.workspaceContextBudgetTokens
      + r.blackboardBudgetTokens;

    // Reconciled sum fits within the soft envelope (with small flooring loss).
    expect(reconciledSum).toBeLessThanOrEqual(softEnvelope);
    // Each layer was scaled, not zeroed.
    expect(r.conversationHistoryBudgetTokens).toBeGreaterThan(0);
    expect(r.wmBudgetTokens).toBeGreaterThan(0);
    // Proportions are preserved: history is still the largest single layer.
    expect(r.wmBudgetTokens).toBeGreaterThan(r.conversationHistoryBudgetTokens);
    expect(r.conversationHistoryBudgetTokens).toBeGreaterThan(r.workspaceContextBudgetTokens);
  });

  it('emits pressure actions sorted by overage when history and staged are both heavy', () => {
    const r = reconcileBudgets({
      contextWindowTokens: 200_000,
      staticSystemTokens: 3_000,
      toolDefTokens: 5_000,
      currentHistoryTokens: CONVERSATION_HISTORY_BUDGET_TOKENS + 6_000,
      currentStagedTokens: STAGED_BUDGET_TOKENS + 10_000,
      currentWorkspaceContextTokens: 0,
      currentBlackboardTokens: 0,
      currentWmTokens: 0,
    });

    expect(r.plannedPressureActions).toContain('compact_history');
    expect(r.plannedPressureActions).toContain('prune_staged');
    // Staged is the most-over → it should come first.
    expect(r.plannedPressureActions[0]).toBe('prune_staged');
    expect(r.plannedPressureActions[1]).toBe('compact_history');
  });

  it('is pure: same input produces identical output', () => {
    const input = {
      contextWindowTokens: 128_000,
      staticSystemTokens: 2_500,
      toolDefTokens: 4_500,
      currentHistoryTokens: 10_000,
      currentStagedTokens: 3_000,
      currentWorkspaceContextTokens: 1_000,
      currentBlackboardTokens: 500,
      currentWmTokens: 8_000,
    };
    expect(reconcileBudgets(input)).toEqual(reconcileBudgets(input));
  });

  it('clamps availableTokens to 0 when static+tools exceed the window', () => {
    const r = reconcileBudgets({
      contextWindowTokens: 1_000,
      staticSystemTokens: 2_000,
      toolDefTokens: 500,
      currentHistoryTokens: 100,
      currentStagedTokens: 0,
      currentWorkspaceContextTokens: 0,
      currentBlackboardTokens: 0,
      currentWmTokens: 0,
    });
    expect(r.availableTokens).toBe(0);
    expect(r.conversationHistoryBudgetTokens).toBe(0);
    // History overage is present since current > 0 while allocation is 0.
    expect(r.plannedPressureActions[0]).toBe('compact_history');
  });
});
