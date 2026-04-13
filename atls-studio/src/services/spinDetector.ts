/**
 * Spin Detector — pure sliding-window heuristics over RoundSnapshot fingerprints.
 *
 * Classifies model spinning into one of five modes by analyzing tool signatures,
 * target file overlap, BB convergence, hash ref eviction/consumption patterns,
 * assistant text repetition, and steering injection effectiveness.
 *
 * All functions are pure (no side effects, no store access).
 */

import type { RoundSnapshot } from '../stores/roundHistoryStore';
import type { OperationKind } from './batch/types';
import { OP_TO_SHORT } from './batch/opShorthand';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SpinMode =
  | 'context_loss'
  | 'goal_drift'
  | 'stuck_in_phase'
  | 'tool_confusion'
  | 'volatile_unpinned'
  | 'completion_gate'
  | 'none';

export interface SpinDiagnosis {
  spinning: boolean;
  mode: SpinMode;
  confidence: number;
  evidence: string[];
  triggerRound: number;
  suggestedAction: string;
}

export interface SpinFingerprint {
  round: number;
  toolSignature: string[];
  targetFiles: string[];
  bbDelta: string[];
  wmDelta: number;
  hashRefsConsumed: string[];
  hashRefsEvicted: string[];
  assistantTextHash: string;
  steeringInjected: string[];
  isResearchRound: boolean;
  coveragePlateau: boolean;
  hadRealChangeThisRound: boolean;
  changeDryRunPreviewRound: boolean;
  volatileRefsSuggested: boolean;
  hadSessionPinStep: boolean;
  /** False for snapshots saved before dry-run vs real-change semantics existed. */
  spinSemanticsPresent: boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MIN_WINDOW = 3;
const DEFAULT_WINDOW = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFingerprint(s: RoundSnapshot): SpinFingerprint {
  const semanticsPresent = s.hadRealChangeThisRound !== undefined
    || s.changeDryRunPreviewRound !== undefined;
  const hadReal = s.hadRealChangeThisRound ?? false;
  const dryPreview = s.changeDryRunPreviewRound ?? false;
  return {
    round: s.round,
    toolSignature: s.toolSignature ?? [],
    targetFiles: s.targetFiles ?? [],
    bbDelta: s.bbDelta ?? [],
    wmDelta: s.wmDelta ?? 0,
    hashRefsConsumed: s.hashRefsConsumed ?? [],
    hashRefsEvicted: s.hashRefsEvicted ?? [],
    assistantTextHash: s.assistantTextHash ?? '',
    steeringInjected: s.steeringInjected ?? [],
    isResearchRound: s.isResearchRound ?? true,
    coveragePlateau: s.coveragePlateau ?? false,
    hadRealChangeThisRound: hadReal,
    changeDryRunPreviewRound: dryPreview,
    volatileRefsSuggested: s.volatileRefsSuggested ?? false,
    hadSessionPinStep: s.hadSessionPinStep ?? false,
    spinSemanticsPresent: semanticsPresent,
  };
}

/** Phase label for UI timeline — distinguishes real edits from dry-run previews. */
export function phaseCategoryFromSnapshot(s: RoundSnapshot): string {
  return categorizeTools(toFingerprint(s));
}

function shortOpLabel(op: string): string {
  const mapped = OP_TO_SHORT[op as OperationKind];
  if (mapped) return mapped;
  const dot = op.lastIndexOf('.');
  return dot >= 0 ? op.slice(dot + 1) : op;
}

/** Unique ops in step order, joined as batch shorthands (e.g. rs+ax). */
function summarizeToolSignature(sig: string[]): string {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const op of sig) {
    if (!seen.has(op)) {
      seen.add(op);
      order.push(op);
    }
  }
  const parts = order.map(shortOpLabel);
  const joined = parts.slice(0, 5).join('+');
  return order.length > 5 ? `${joined}+…` : joined;
}

/**
 * Spin Trace “Phase” column: coarse bucket (edit/preview/read/…) when known,
 * otherwise exact op shorthands so batches never show as “other”.
 */
export function phaseDisplayFromSnapshot(s: RoundSnapshot): string {
  const fp = toFingerprint(s);
  const sig = fp.toolSignature;
  if (sig.length === 0) return '—';
  const cat = categorizeTools(fp);
  if (cat === 'other') return summarizeToolSignature(sig);
  return cat;
}

/** Badge color key aligned with PHASE_COLORS in Spin Trace UI. */
export function phaseColorKeyFromSnapshot(s: RoundSnapshot): string {
  const fp = toFingerprint(s);
  const cat = categorizeTools(fp);
  if (cat !== 'other') return cat;
  return fp.toolSignature.length > 0 ? 'mixed_ops' : 'other';
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) { if (setB.has(x)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function intersectionCount(a: string[], b: string[]): number {
  const setA = new Set(a);
  let count = 0;
  for (const x of b) { if (setA.has(x)) count++; }
  return count;
}

function categorizeTools(fp: SpinFingerprint): string {
  const sig = fp.toolSignature;
  const hasChangeOp = sig.some(s => s.startsWith('change.'));
  if (fp.spinSemanticsPresent) {
    if (fp.hadRealChangeThisRound) return 'edit';
    if (fp.changeDryRunPreviewRound || (hasChangeOp && !fp.hadRealChangeThisRound)) return 'preview';
  } else if (hasChangeOp) {
    return 'edit';
  }

  const hasSearch = sig.some(s => s.startsWith('search.'));
  const hasRead = sig.some(s => s.startsWith('read.'));
  const hasVerify = sig.some(s => s.startsWith('verify.'));
  const hasBb = sig.some(s => s === 'session.bb.write');
  const hasDelegate = sig.some(s => s.startsWith('delegate.'));

  if (hasVerify) return 'verify';
  if (hasDelegate) return 'delegate';
  if (hasBb && !hasSearch && !hasRead) return 'consolidate';
  if (hasSearch && !hasRead) return 'search';
  if (hasRead) return 'read';

  if (sig.some(t => t.startsWith('analyze.'))) return 'analyze';
  if (sig.some(t => t.startsWith('session.'))) return 'session';
  if (sig.some(t => t.startsWith('annotate.'))) return 'annotate';
  if (sig.some(t => t.startsWith('intent.'))) return 'intent';
  if (sig.some(t => t.startsWith('system.'))) return 'system';

  return 'other';
}

// ---------------------------------------------------------------------------
// Detector: Context Loss
// ---------------------------------------------------------------------------

function detectContextLoss(window: SpinFingerprint[]): SpinDiagnosis | null {
  let evidence: string[] = [];
  let triggerRound = 0;
  let score = 0;

  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const curr = window[i];

    // Evicted refs in round N overlap with consumed refs in round N+1
    if (prev.hashRefsEvicted.length > 0 && curr.hashRefsConsumed.length > 0) {
      const overlap = intersectionCount(prev.hashRefsEvicted, curr.hashRefsConsumed);
      if (overlap > 0) {
        score += 0.4;
        if (!triggerRound) triggerRound = curr.round;
        evidence.push(`Round ${curr.round}: consumed ${overlap} refs that were evicted in round ${prev.round}`);
      }
    }

    // Re-reading files that were in a prior round's target set
    if (i >= 2) {
      const older = window[i - 2];
      const fileOverlap = intersectionCount(older.targetFiles, curr.targetFiles);
      if (fileOverlap > 0 && curr.bbDelta.length === 0) {
        score += 0.2;
        if (!triggerRound) triggerRound = curr.round;
        evidence.push(`Round ${curr.round}: re-reading ${fileOverlap} files from round ${older.round} without new BB findings`);
      }
    }
  }

  if (score < 0.3) return null;
  return {
    spinning: true,
    mode: 'context_loss',
    confidence: Math.min(score, 1.0),
    evidence,
    triggerRound: triggerRound || window[0].round,
    suggestedAction: 'Check BB for existing findings on these files. Use rec(h:XXXX) to restore evicted context. Do not re-read files already examined.',
  };
}

// ---------------------------------------------------------------------------
// Detector: Goal Drift
// ---------------------------------------------------------------------------

function detectGoalDrift(window: SpinFingerprint[]): SpinDiagnosis | null {
  if (window.length < 3) return null;
  let evidence: string[] = [];
  let triggerRound = 0;
  let score = 0;

  const categories = window.map(fp => categorizeTools(fp));

  for (let i = 2; i < categories.length; i++) {
    const prevCat = categories[i - 1];
    const currCat = categories[i];
    const hasBbUpdate = window[i].bbDelta.some(k => k.startsWith('status') || k === 'current-task-state');

    // Category shift without BB status update
    if (prevCat !== currCat && !hasBbUpdate) {
      const isRegressionFromEdit = prevCat === 'edit' && (currCat === 'search' || currCat === 'read');
      if (isRegressionFromEdit) {
        score += 0.35;
        if (!triggerRound) triggerRound = window[i].round;
        evidence.push(`Round ${window[i].round}: regressed from ${prevCat} to ${currCat} without BB status update`);
      } else if (prevCat === 'verify' && currCat !== 'edit') {
        score += 0.25;
        if (!triggerRound) triggerRound = window[i].round;
        evidence.push(`Round ${window[i].round}: shifted from verify to ${currCat} without acting on results`);
      }
    }
  }

  if (score < 0.3) return null;
  return {
    spinning: true,
    mode: 'goal_drift',
    confidence: Math.min(score, 1.0),
    evidence,
    triggerRound: triggerRound || window[0].round,
    suggestedAction: 'Review BB status and task plan. Refocus on the original goal before exploring new areas.',
  };
}

// ---------------------------------------------------------------------------
// Detector: Stuck in Phase
// ---------------------------------------------------------------------------

function detectVolatileUnpinned(window: SpinFingerprint[]): SpinDiagnosis | null {
  const bad = window.filter(fp => fp.volatileRefsSuggested && !fp.hadSessionPinStep);
  if (bad.length < 2) return null;
  const evidence = bad.map(fp =>
    `Round ${fp.round}: VOLATILE refs emitted but NO session.pin in that batch — content LOST next round`,
  );
  return {
    spinning: true,
    mode: 'volatile_unpinned',
    confidence: Math.min(0.55 + bad.length * 0.15, 1.0),
    evidence,
    triggerRound: bad[0].round,
    suggestedAction: 'PIN IMMEDIATELY. Every read/search returns h:refs that expire after ONE round. Add pi in:rN.refs in the SAME batch as your reads — not the next batch.',
  };
}

function detectStuckInPhase(window: SpinFingerprint[]): SpinDiagnosis | null {
  if (window.length < MIN_WINDOW) return null;
  let evidence: string[] = [];
  let triggerRound = 0;
  let score = 0;

  const categories = window.map(fp => categorizeTools(fp));

  // Maximal contiguous runs: same phase, 3+ rounds, no BB writes — one line per run (no overlapping ranges).
  type PhaseRun = { phase: string; len: number; startRound: number; endRound: number };
  const runs: PhaseRun[] = [];
  let runStart = 0;
  for (let i = 1; i <= categories.length; i++) {
    const atEnd = i === categories.length;
    if (!atEnd && categories[i] === categories[i - 1]) continue;
    const runEnd = i - 1;
    const len = runEnd - runStart + 1;
    if (len >= 3) {
      const slice = window.slice(runStart, i);
      if (slice.every(fp => fp.bbDelta.length === 0)) {
        runs.push({
          phase: categories[runStart],
          len,
          startRound: window[runStart].round,
          endRound: window[runEnd].round,
        });
      }
    }
    runStart = i;
  }

  if (runs.length > 0) {
    const best = runs.reduce((a, b) => (b.len > a.len ? b : a));
    triggerRound = best.startRound;
    score += Math.min(0.25 * (best.len - 3) + 0.5, 1.0);
    const detail = best.phase === 'preview'
      ? `${best.len} consecutive dry-run / preview rounds (${best.startRound}-${best.endRound}) — change previews without dry_run:false, pins, or BB updates`
      : `${best.len} consecutive ${best.phase} rounds (${best.startRound}-${best.endRound}) with no BB findings`;
    evidence.push(detail);
  }

  // Research rounds with coverage plateau
  const plateauRounds = window.filter(fp => fp.isResearchRound && fp.coveragePlateau);
  if (plateauRounds.length >= 2) {
    score += 0.2;
    evidence.push(`${plateauRounds.length} rounds with coverage plateau (no new files)`);
  }

  if (score < 0.3) return null;
  const previewStreak = evidence.some(e => e.includes('dry-run / preview'));
  return {
    spinning: true,
    mode: 'stuck_in_phase',
    confidence: Math.min(score, 1.0),
    evidence,
    triggerRound: triggerRound || window[0].round,
    suggestedAction: previewStreak
      ? 'Stop previewing: run change with dry_run:false, or pin refs (pi), and add BB notes or findings so context survives the next turn.'
      : 'Write BB findings for what you know so far, then transition to edits. Reading more will not help.',
  };
}

// ---------------------------------------------------------------------------
// Detector: Tool Confusion
// ---------------------------------------------------------------------------

function detectToolConfusion(window: SpinFingerprint[]): SpinDiagnosis | null {
  if (window.length < MIN_WINDOW) return null;
  let evidence: string[] = [];
  let triggerRound = 0;
  let score = 0;

  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const curr = window[i];

    // High Jaccard similarity of tool signatures with no new target files.
    // Skip when both rounds are change.* dry-run previews: identical
    // ['change.split_module'] lines are expected; stuck_in_phase handles that.
    const bothChangePreviews =
      prev.spinSemanticsPresent      && curr.spinSemanticsPresent
      && prev.changeDryRunPreviewRound
      && curr.changeDryRunPreviewRound;

    const sigSimilarity = jaccard(prev.toolSignature, curr.toolSignature);
    const newFiles = curr.targetFiles.filter(f => !prev.targetFiles.includes(f));

    if (!bothChangePreviews && sigSimilarity > 0.8 && newFiles.length === 0) {
      score += 0.3;
      if (!triggerRound) triggerRound = curr.round;
      evidence.push(`Round ${curr.round}: tool signature ${(sigSimilarity * 100).toFixed(0)}% similar to round ${prev.round}, no new files`);
    }

    // Identical assistant text hash = literal repetition
    if (curr.assistantTextHash && curr.assistantTextHash === prev.assistantTextHash) {
      score += 0.4;
      if (!triggerRound) triggerRound = curr.round;
      evidence.push(`Round ${curr.round}: identical assistant text hash as round ${prev.round}`);
    }
  }

  if (score < 0.3) return null;
  return {
    spinning: true,
    mode: 'tool_confusion',
    confidence: Math.min(score, 1.0),
    evidence,
    triggerRound: triggerRound || window[0].round,
    suggestedAction: 'Your last rounds used nearly identical tool calls with no new results. Declare a specific blocker or try a fundamentally different approach.',
  };
}

// ---------------------------------------------------------------------------
// Detector: Completion Gate
// ---------------------------------------------------------------------------

function detectCompletionGate(window: SpinFingerprint[]): SpinDiagnosis | null {
  if (window.length < 2) return null;
  let evidence: string[] = [];
  let triggerRound = 0;
  let score = 0;

  const completionPattern = /completion|verify|FORCE STOP/i;

  let consecutiveCompletionSteering = 0;
  for (const fp of window) {
    const hasCompletionSteering = fp.steeringInjected.some(s => completionPattern.test(s));
    if (hasCompletionSteering) {
      consecutiveCompletionSteering++;
      if (consecutiveCompletionSteering >= 2) {
        score += 0.3;
        if (!triggerRound) triggerRound = fp.round;
        evidence.push(`Round ${fp.round}: completion steering active for ${consecutiveCompletionSteering} consecutive rounds`);
      }
    } else {
      consecutiveCompletionSteering = 0;
    }
  }

  // Steering injected but no behavioral change (same tools, no new findings)
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const curr = window[i];
    if (prev.steeringInjected.length > 0 && curr.steeringInjected.length > 0) {
      const steeringSame = jaccard(prev.steeringInjected, curr.steeringInjected) > 0.8;
      const toolsSame = jaccard(prev.toolSignature, curr.toolSignature) > 0.7;
      if (steeringSame && toolsSame) {
        score += 0.2;
        evidence.push(`Round ${curr.round}: same steering and tools as round ${prev.round} — model ignoring guardrails`);
      }
    }
  }

  if (score < 0.3) return null;
  return {
    spinning: true,
    mode: 'completion_gate',
    confidence: Math.min(score, 1.0),
    evidence,
    triggerRound: triggerRound || window[0].round,
    suggestedAction: 'Completion is blocked. Read the specific blocker message and address it directly, or call task_complete with an honest summary.',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze the last N round snapshots for spinning patterns.
 * Returns the highest-confidence diagnosis, or mode='none' if no spin detected.
 */
export function diagnoseSpinning(
  snapshots: RoundSnapshot[],
  windowSize: number = DEFAULT_WINDOW,
): SpinDiagnosis {
  const mainRounds = snapshots.filter(s => !s.isSubagentRound && !s.isSwarmRound);
  if (mainRounds.length < MIN_WINDOW) {
    return { spinning: false, mode: 'none', confidence: 0, evidence: [], triggerRound: 0, suggestedAction: '' };
  }

  const window = mainRounds.slice(-windowSize).map(toFingerprint);

  const detectors = [
    detectContextLoss,
    detectVolatileUnpinned,
    detectToolConfusion,
    detectStuckInPhase,
    detectGoalDrift,
    detectCompletionGate,
  ];

  let best: SpinDiagnosis | null = null;
  for (const detect of detectors) {
    const result = detect(window);
    if (result && (!best || result.confidence > best.confidence)) {
      best = result;
    }
  }

  return best ?? {
    spinning: false,
    mode: 'none',
    confidence: 0,
    evidence: [],
    triggerRound: 0,
    suggestedAction: '',
  };
}

/**
 * Generate a human-readable spin trace summary for the last N rounds.
 * Useful for the diagnose tool and UI panel.
 */
export function formatSpinTrace(
  snapshots: RoundSnapshot[],
  windowSize: number = DEFAULT_WINDOW,
): string {
  const mainRounds = snapshots.filter(s => !s.isSubagentRound && !s.isSwarmRound);
  if (mainRounds.length === 0) return 'No rounds recorded.';

  const slice = mainRounds.slice(-windowSize);
  const lines: string[] = [];

  for (const s of slice) {
    const fp = toFingerprint(s);
    const tools = fp.toolSignature.length > 0 ? fp.toolSignature.join(',') : '-';
    const files = fp.targetFiles.length > 0 ? `${fp.targetFiles.length} files` : '-';
    const bb = fp.bbDelta.length > 0 ? fp.bbDelta.join(',') : '-';
    const steering = fp.steeringInjected.length > 0 ? `${fp.steeringInjected.length} blocks` : '-';
    const flags: string[] = [];
    if (fp.isResearchRound) flags.push('R');
    if (fp.coveragePlateau) flags.push('P');
    if (fp.hashRefsEvicted.length > 0) flags.push(`E${fp.hashRefsEvicted.length}`);
    const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';

    const readExtras = s.readFileStepCount !== undefined || s.uniqueReadSpans !== undefined
      ? ` | reads=${s.readFileStepCount ?? '—'} spans=${s.uniqueReadSpans ?? '—'}`
      : '';

    lines.push(`R${fp.round}${flagStr}: tools=${tools} | files=${files} | bb=${bb} | steering=${steering}${readExtras}`);
  }

  return lines.join('\n');
}

/**
 * Compute a compact WM diff between two snapshots for context loss diagnosis.
 */
export function computeWmDiff(
  olderSnapshot: RoundSnapshot | undefined,
  newerSnapshot: RoundSnapshot | undefined,
): string {
  if (!olderSnapshot || !newerSnapshot) return 'Insufficient snapshots for WM diff.';

  const oldFiles = new Set(olderSnapshot.targetFiles ?? []);
  const newFiles = new Set(newerSnapshot.targetFiles ?? []);
  const oldRefs = new Set(olderSnapshot.hashRefsConsumed ?? []);
  const newRefs = new Set(newerSnapshot.hashRefsConsumed ?? []);

  const addedFiles = [...newFiles].filter(f => !oldFiles.has(f));
  const droppedFiles = [...oldFiles].filter(f => !newFiles.has(f));
  const addedRefs = [...newRefs].filter(r => !oldRefs.has(r));
  const droppedRefs = [...oldRefs].filter(r => !newRefs.has(r));

  const parts: string[] = [];
  if (addedFiles.length > 0) parts.push(`+files: ${addedFiles.join(', ')}`);
  if (droppedFiles.length > 0) parts.push(`-files: ${droppedFiles.join(', ')}`);
  if (addedRefs.length > 0) parts.push(`+refs: ${addedRefs.join(', ')}`);
  if (droppedRefs.length > 0) parts.push(`-refs: ${droppedRefs.join(', ')}`);

  const tokenDelta = (newerSnapshot.wmTokens ?? 0) - (olderSnapshot.wmTokens ?? 0);
  parts.push(`WM tokens: ${olderSnapshot.wmTokens ?? 0} -> ${newerSnapshot.wmTokens ?? 0} (${tokenDelta >= 0 ? '+' : ''}${tokenDelta})`);

  return parts.length > 0 ? parts.join('\n') : 'No significant WM changes.';
}
