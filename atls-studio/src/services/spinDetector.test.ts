import { describe, it, expect } from 'vitest';
import { diagnoseSpinning, phaseCategoryFromSnapshot } from './spinDetector';
import type { RoundSnapshot } from '../stores/roundHistoryStore';

function baseSnap(overrides: Partial<RoundSnapshot>): RoundSnapshot {
  return {
    round: 1,
    timestamp: 0,
    wmTokens: 0,
    bbTokens: 0,
    stagedTokens: 0,
    archivedTokens: 0,
    overheadTokens: 0,
    freeTokens: 0,
    maxTokens: 0,
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
    ...overrides,
  };
}

describe('phaseCategoryFromSnapshot', () => {
  it('classifies dry-run-only change.split_module as preview, not edit', () => {
    const s = baseSnap({
      round: 6,
      toolSignature: ['change.split_module'],
      hadRealChangeThisRound: false,
      changeDryRunPreviewRound: true,
    });
    expect(phaseCategoryFromSnapshot(s)).toBe('preview');
  });

  it('classifies real change as edit when semantics present', () => {
    const s = baseSnap({
      toolSignature: ['change.edit'],
      hadRealChangeThisRound: true,
      changeDryRunPreviewRound: false,
    });
    expect(phaseCategoryFromSnapshot(s)).toBe('edit');
  });

  it('uses legacy edit label when semantics keys absent', () => {
    const s = baseSnap({
      toolSignature: ['change.edit'],
    });
    expect(phaseCategoryFromSnapshot(s)).toBe('edit');
  });
});

describe('diagnoseSpinning', () => {
  it('treats repeated change.* dry-run previews as stuck_in_phase, not tool_confusion (jaccard)', () => {
    const snaps: RoundSnapshot[] = [4, 5, 6].map((r) => baseSnap({
      round: r,
      toolSignature: ['change.split_module'],
      hadRealChangeThisRound: false,
      changeDryRunPreviewRound: true,
      bbDelta: [],
      isResearchRound: true,
      volatileRefsSuggested: false,
      hadSessionPinStep: false,
    }));
    const d = diagnoseSpinning(snaps);
    expect(d.mode).toBe('stuck_in_phase');
    expect(d.evidence.join(' ')).toMatch(/dry-run|preview/i);
    expect(d.evidence.join(' ')).not.toMatch(/consecutive edit rounds/i);
    expect(d.mode).not.toBe('tool_confusion');
  });

  it('stuck_in_phase uses one evidence line for a single long preview run (no overlapping ranges)', () => {
    const snaps: RoundSnapshot[] = [5, 6, 7, 8].map((r) => baseSnap({
      round: r,
      toolSignature: ['change.split_module'],
      hadRealChangeThisRound: false,
      changeDryRunPreviewRound: true,
      bbDelta: [],
      isResearchRound: true,
      volatileRefsSuggested: false,
      hadSessionPinStep: false,
    }));
    const d = diagnoseSpinning(snaps, 5);
    const phaseLines = d.evidence.filter(e => /consecutive dry-run/i.test(e));
    expect(phaseLines.length).toBe(1);
    expect(phaseLines[0]).toMatch(/\(5-8\)/);
    expect(phaseLines[0]).toMatch(/4 consecutive/);
  });

  it('many consecutive split_module previews match user modularization loop (no false tool_confusion)', () => {
    const snaps: RoundSnapshot[] = [7, 8, 9, 10, 11].map((r) => baseSnap({
      round: r,
      toolSignature: ['change.split_module'],
      targetFiles: [],
      hadRealChangeThisRound: false,
      changeDryRunPreviewRound: true,
      bbDelta: [],
      isResearchRound: true,
      volatileRefsSuggested: false,
      hadSessionPinStep: false,
    }));
    const d = diagnoseSpinning(snaps);
    expect(d.mode).not.toBe('tool_confusion');
    expect(d.evidence.every(e => !/tool signature \d+% similar.*no new files/i.test(e))).toBe(true);
  });

  it('detects volatile output without session.pin when pattern repeats in window', () => {
    const snaps: RoundSnapshot[] = [1, 2, 3].map((r) => baseSnap({
      round: r,
      toolSignature: ['read.shaped'],
      hadRealChangeThisRound: false,
      changeDryRunPreviewRound: false,
      volatileRefsSuggested: true,
      hadSessionPinStep: false,
      bbDelta: [],
    }));
    const d = diagnoseSpinning(snaps);
    expect(d.spinning).toBe(true);
    expect(d.mode).toBe('tool_confusion');
    expect(d.evidence.some(e => /VOLATILE|pin/i.test(e))).toBe(true);
  });
});
