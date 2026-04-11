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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SpinMode =
  | 'context_loss'
  | 'goal_drift'
  | 'stuck_in_phase'
  | 'tool_confusion'
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
  };
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

function categorizeTools(sig: string[]): string {
  const hasSearch = sig.some(s => s.startsWith('search.'));
  const hasRead = sig.some(s => s.startsWith('read.'));
  const hasEdit = sig.some(s => s.startsWith('change.'));
  const hasVerify = sig.some(s => s.startsWith('verify.'));
  const hasBb = sig.some(s => s === 'session.bb.write');
  const hasDelegate = sig.some(s => s.startsWith('delegate.'));

  if (hasEdit) return 'edit';
  if (hasVerify) return 'verify';
  if (hasDelegate) return 'delegate';
  if (hasBb && !hasSearch && !hasRead) return 'consolidate';
  if (hasSearch && !hasRead) return 'search';
  if (hasRead) return 'read';
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

  const categories = window.map(fp => categorizeTools(fp.toolSignature));

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

function detectStuckInPhase(window: SpinFingerprint[]): SpinDiagnosis | null {
  if (window.length < MIN_WINDOW) return null;
  let evidence: string[] = [];
  let triggerRound = 0;
  let score = 0;

  const categories = window.map(fp => categorizeTools(fp.toolSignature));

  // 3+ consecutive rounds with same category and no BB delta
  let streak = 1;
  for (let i = 1; i < categories.length; i++) {
    if (categories[i] === categories[i - 1]) {
      streak++;
      if (streak >= 3 && window.slice(i - streak + 1, i + 1).every(fp => fp.bbDelta.length === 0)) {
        const phase = categories[i];
        score += 0.15 * streak;
        if (!triggerRound) triggerRound = window[i - streak + 1].round;
        evidence.push(`${streak} consecutive ${phase} rounds (${window[i - streak + 1].round}-${window[i].round}) with no BB findings`);
      }
    } else {
      streak = 1;
    }
  }

  // Research rounds with coverage plateau
  const plateauRounds = window.filter(fp => fp.isResearchRound && fp.coveragePlateau);
  if (plateauRounds.length >= 2) {
    score += 0.2;
    evidence.push(`${plateauRounds.length} rounds with coverage plateau (no new files)`);
  }

  if (score < 0.3) return null;
  return {
    spinning: true,
    mode: 'stuck_in_phase',
    confidence: Math.min(score, 1.0),
    evidence,
    triggerRound: triggerRound || window[0].round,
    suggestedAction: 'Write BB findings for what you know so far, then transition to edits. Reading more will not help.',
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

    // High Jaccard similarity of tool signatures with no new target files
    const sigSimilarity = jaccard(prev.toolSignature, curr.toolSignature);
    const newFiles = curr.targetFiles.filter(f => !prev.targetFiles.includes(f));

    if (sigSimilarity > 0.8 && newFiles.length === 0) {
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

  const window = mainRounds.slice(-windowSize).map(toFingerprint);
  const lines: string[] = [];

  for (const fp of window) {
    const tools = fp.toolSignature.length > 0 ? fp.toolSignature.join(',') : '-';
    const files = fp.targetFiles.length > 0 ? `${fp.targetFiles.length} files` : '-';
    const bb = fp.bbDelta.length > 0 ? fp.bbDelta.join(',') : '-';
    const steering = fp.steeringInjected.length > 0 ? `${fp.steeringInjected.length} blocks` : '-';
    const flags: string[] = [];
    if (fp.isResearchRound) flags.push('R');
    if (fp.coveragePlateau) flags.push('P');
    if (fp.hashRefsEvicted.length > 0) flags.push(`E${fp.hashRefsEvicted.length}`);
    const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';

    lines.push(`R${fp.round}${flagStr}: tools=${tools} | files=${files} | bb=${bb} | steering=${steering}`);
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
