/**
 * Unified Batch Executor — the step loop.
 *
 * Accepts a UnifiedBatchRequest, dispatches each step through the opMap,
 * resolves in/out bindings between steps, enforces execution policy,
 * and returns a UnifiedBatchResult.
 */

import type {
  UnifiedBatchRequest,
  UnifiedBatchResult,
  StepOutput,
  StepResult,
  RefExpr,
  HandlerContext,
  VerifyClassification,
  OperationKind,
} from './types';

import { getHandler } from './opMap';
import { coerceFilePathsArray, normalizeStepParams } from './paramNorm';
import { isStepAllowed, getAutoVerifySteps, isStepCountExceeded, evaluateCondition, isBlockedForSwarm } from './policy';
import { stepOutputToResult } from './resultFormatter';
import { resetRecallBudget } from './handlers/session';
import { SnapshotTracker, AwarenessLevel } from './snapshotTracker';
import type { LineRegion } from './snapshotTracker';
import { buildIntentContext, resolveIntents, isPressured } from './intents';
import { validateBatchSteps } from './validateBatchSteps';
import { useRetentionStore } from '../../stores/retentionStore';
import { useAppStore } from '../../stores/appStore';
import { invoke } from '@tauri-apps/api/core';
import { registerOwnWrite } from '../../hooks/useAtls';
import { serializeForTokenEstimate } from '../../utils/toon';
import './intents/index';

/** Ops that require a non-empty `file_paths` array after binding coercion. */
const FILE_PATH_REQUIRED_OPS = new Set<OperationKind>([
  'read.context',
  'read.shaped',
  'analyze.deps',
  'analyze.impact',
  'analyze.blast_radius',
  'analyze.structure',
]);

interface BatchResolvedEntry {
  source: string | null;
  content: string;
  tokens: number;
}

// ---------------------------------------------------------------------------
// Auto-workspace inference for verify.* steps
// ---------------------------------------------------------------------------

/**
 * Given a set of edited file paths from the current batch, infer the workspace
 * name by matching against the project's workspace registry. Returns the workspace
 * name if all paths belong to the same workspace, otherwise null.
 */
function inferWorkspaceFromPaths(editedPaths: Set<string>): string | null {
  if (editedPaths.size === 0) return null;
  const workspaces = useAppStore.getState().projectProfile?.workspaces ?? [];
  if (workspaces.length === 0) return null;

  const matchedNames = new Set<string>();
  for (const fp of editedPaths) {
    const norm = fp.replace(/\\/g, '/');
    for (const ws of workspaces) {
      if (ws.path === '.') continue;
      const wsPrefix = ws.path.replace(/\\/g, '/');
      if (norm.startsWith(wsPrefix + '/') || norm === wsPrefix) {
        matchedNames.add(ws.name);
        break;
      }
    }
  }
  if (matchedNames.size === 1) return [...matchedNames][0];
  return null;
}

// ---------------------------------------------------------------------------
// Cross-step line-number rebasing
// ---------------------------------------------------------------------------

function normalizePathForRebase(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function extractEditTargetFile(params: Record<string, unknown>): string | undefined {
  const f = params.file ?? params.file_path;
  return typeof f === 'string' ? f : undefined;
}

/**
 * Count lines in content matching Rust's `.lines()` behavior:
 * trailing newline does NOT produce an extra empty line.
 */
function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const stripped = content.replace(/\r?\n$/, '');
  return stripped.split(/\r?\n/).length;
}

interface PositionalDelta {
  line: number;
  delta: number;
  /**
   * When true (insert_before / prepend), shifts targets where `line >= anchor`.
   * When false/undefined (insert_after, replace, delete, …), shifts where `line > anchor`.
   */
  lineInclusive?: boolean;
}

/** Shallow-clone each line_edit object so intra-step rebase cannot mutate `step.with`. */
function cloneLineEditEntry(le: unknown): unknown {
  if (!le || typeof le !== 'object') return le;
  return { ...(le as Record<string, unknown>) };
}

/**
 * Fork line_edits arrays before snapshot→sequential conversion so the batch request
 * object keeps original coordinates for UI / persistence even when a step fails.
 */
function forkLineEditsForIntraStepRebase(params: Record<string, unknown>): Record<string, unknown> {
  let next = params;
  let forked = false;
  if (Array.isArray(params.line_edits)) {
    next = { ...next, line_edits: (params.line_edits as unknown[]).map(cloneLineEditEntry) };
    forked = true;
  }
  if (params.mode === 'batch_edits' && Array.isArray(params.edits)) {
    const edits = (params.edits as unknown[]).map((ed) => {
      if (!ed || typeof ed !== 'object') return ed;
      const e = ed as Record<string, unknown>;
      if (!Array.isArray(e.line_edits)) return { ...e };
      return { ...e, line_edits: e.line_edits.map(cloneLineEditEntry) };
    });
    next = { ...next, edits };
    forked = true;
  }
  return forked ? next : params;
}

/**
 * Net line-count change from a single line edit (matches Rust apply_line_edits semantics
 * for insert/delete/replace). Used for positional rebase math.
 */
/** Line index for intra-step rebase: only fixed positive snapshot lines participate. */
function snapshotLineForRebase(o: Record<string, unknown>): number {
  const line = o.line;
  if (line === 'end') return 0;
  if (typeof line === 'string' && /^\s*-\d+\s*$/.test(line)) return 0;
  if (typeof line === 'number' && Number.isFinite(line) && line < 0) return 0;
  if (typeof line === 'number' && Number.isFinite(line) && line > 0) return line;
  return 0;
}

function effectiveLineSpanCount(e: Record<string, unknown>): number {
  const line = snapshotLineForRebase(e);
  const endLine = typeof e.end_line === 'number' && Number.isFinite(e.end_line) ? e.end_line : null;
  if (endLine != null && line > 0) return Math.max(0, endLine - line + 1);
  return 1;
}

/** Normalize action: missing/empty → 'replace' (mirrors change.edit handler default). */
function normalizeEditAction(e: Record<string, unknown>): string {
  const raw = typeof e.action === 'string' ? e.action : '';
  return raw === '' ? 'replace' : raw;
}

function computeSingleEditNetDelta(e: Record<string, unknown>): number {
  const action = normalizeEditAction(e);
  const span = effectiveLineSpanCount(e);
  const contentLines = typeof e.content === 'string' && e.content.length > 0
    ? countContentLines(e.content as string)
    : 0;
  if (action === 'insert_before' || action === 'insert_after' || action === 'prepend' || action === 'append') {
    return contentLines;
  }
  if (action === 'delete') return -span;
  if (action === 'replace') return contentLines - span;
  if (action === 'move') return 0; // net global delta is 0; positional shifts handled in computePositionalDeltas
  if (action === 'replace_body') {
    const bodySpan = typeof e._resolved_body_span === 'number' ? e._resolved_body_span : 0;
    if (bodySpan > 0) return contentLines - bodySpan;
    // Body span unknown during intra-step rebase (pre-apply). _resolved_body_span is
    // backfilled from Rust's edits_resolved AFTER the handler runs, so it only helps
    // inter-step rebase. Limitation: if replace_body changes line count and another le
    // entry in the same step targets lines below it, the shift will be wrong.
    // Mitigation: replace_body should be the sole le entry in its step.
    return 0;
  }
  return 0;
}

/**
 * Compute per-edit positional deltas from a completed line_edits array.
 * Each entry records the **original-file** line where the edit occurred and
 * the net line change.  Because line_edits are applied sequentially (top-down),
 * each edit's `line` is relative to the post-prior-edits state.  We track a
 * running cumulative delta to convert back to original-file coordinates so that
 * `rebaseSubsequentSteps` can compare against pre-execution line numbers.
 *
 * Symbol-only edits (line <= 0) are excluded — they can't inform positional rebase.
 */
function computePositionalDeltas(lineEdits: unknown): PositionalDelta[] {
  if (!Array.isArray(lineEdits)) return [];
  const deltas: PositionalDelta[] = [];
  let cumulativeDelta = 0;
  for (const edit of lineEdits) {
    if (!edit || typeof edit !== 'object') continue;
    const e = edit as Record<string, unknown>;
    const action = normalizeEditAction(e);
    const line = snapshotLineForRebase(e);

    if (action === 'move' && line > 0) {
      // Move produces two positional shifts mirroring Rust's drain+insert (lib.rs:702-728).
      // Sequential line is post-prior-edits; convert back to original-file coords.
      const span = effectiveLineSpanCount(e);
      const dest = typeof e.destination === 'number' && e.destination > 0 ? e.destination : 0;
      if (dest > 0) {
        const origSource = line - cumulativeDelta;
        // Rust: insert_at = if dest > idx+1 { dest - count } else { dest }
        // idx = line-1 (0-based), so dest > (line-1)+1 ⟹ dest > line
        const effectiveDest = dest > line ? dest - span : dest;
        const origDest = effectiveDest > 0 ? effectiveDest - cumulativeDelta : 0;
        if (origSource > 0) deltas.push({ line: origSource, delta: -span });
        if (origDest > 0) deltas.push({ line: origDest, delta: span });
      }
      // Net cumulativeDelta unchanged (move is globally zero-sum)
      continue;
    }

    const d = computeSingleEditNetDelta(e);
    const originalLine = line > 0 ? line - cumulativeDelta : 0;
    if (d !== 0 && originalLine > 0) {
      const lineInclusive = action === 'insert_before' || action === 'prepend';
      deltas.push({ line: originalLine, delta: d, lineInclusive });
    }
    cumulativeDelta += d;
  }
  return deltas;
}

function estimateLineDeltaFromEdits(lineEdits: unknown): number {
  return computePositionalDeltas(lineEdits).reduce((sum, d) => sum + d.delta, 0);
}

/**
 * After Rust applies line edits, `edits_resolved` contains per-edit metadata
 * including `lines_affected` (the actual body span for replace_body).
 * Patch `_resolved_body_span` back into the corresponding `line_edits` entries
 * so `computePositionalDeltas` can compute accurate deltas for replace_body.
 * Must be called before `rebaseSubsequentSteps`.
 */
function backfillResolvedBodySpans(
  mergedParams: Record<string, unknown>,
  output: StepOutput,
): void {
  if (!output.ok || !output.content || typeof output.content !== 'object' || Array.isArray(output.content)) return;
  const artifact = output.content as Record<string, unknown>;

  const patchFromResolutions = (lineEdits: unknown[], resolutions: unknown[]) => {
    for (let k = 0; k < lineEdits.length && k < resolutions.length; k++) {
      const le = lineEdits[k];
      const res = resolutions[k];
      if (!le || typeof le !== 'object' || !res || typeof res !== 'object') continue;
      const entry = le as Record<string, unknown>;
      const resolution = res as Record<string, unknown>;
      if (entry.action === 'replace_body' && typeof entry._resolved_body_span !== 'number') {
        const linesAffected = resolution.lines_affected;
        if (typeof linesAffected === 'number' && linesAffected > 0) {
          entry._resolved_body_span = linesAffected;
        }
      }
    }
  };

  // Single-file draft path: edits_resolved at top level
  const topResolutions = artifact.edits_resolved;
  if (Array.isArray(topResolutions) && Array.isArray(mergedParams.line_edits)) {
    patchFromResolutions(mergedParams.line_edits as unknown[], topResolutions);
  }

  // batch_edits path: each drafts[] entry may carry its own edits_resolved
  const drafts = artifact.drafts ?? artifact.batch ?? artifact.results;
  if (Array.isArray(drafts) && mergedParams.mode === 'batch_edits' && Array.isArray(mergedParams.edits)) {
    const paramEdits = mergedParams.edits as Array<Record<string, unknown>>;
    for (const draftEntry of drafts) {
      if (!draftEntry || typeof draftEntry !== 'object') continue;
      const draft = draftEntry as Record<string, unknown>;
      const draftFile = (draft.f ?? draft.file ?? draft.file_path) as string | undefined;
      const draftResolutions = draft.edits_resolved;
      if (!draftFile || !Array.isArray(draftResolutions)) continue;
      const draftKey = normalizePathForRebase(draftFile);
      for (const pe of paramEdits) {
        const peFile = extractEditTargetFile(pe);
        if (!peFile || normalizePathForRebase(peFile) !== draftKey) continue;
        if (Array.isArray(pe.line_edits)) {
          patchFromResolutions(pe.line_edits as unknown[], draftResolutions);
        }
      }
    }
  }
}

/**
 * After a successful change.edit step, shift line numbers in subsequent
 * same-file steps so they reflect insertions/deletions from earlier steps.
 * Only adjusts explicit `line` values (symbol-only edits resolve at apply time).
 *
 * Uses positional deltas: each future line is shifted only by edits that
 * occurred at or before that line, not by a single global delta.
 */
/**
 * Every numeric `line` in the array is relative to the file **before** any edit in this step.
 * Convert to sequential coordinates (what Rust expects) by shifting each entry i>0 by the sum
 * of net deltas from prior edits j<i (insert_before/prepend use an inclusive boundary at the anchor
 * line; other actions use a strict “below anchor” rule, matching `rebaseSubsequentSteps`).
 * Mutates `line_edits` in place. Skips symbol-only entries.
 */
/**
 * Compute the positional shift that edit `e` (at snapshot line `snapLine`)
 * contributes to a subsequent edit at `targetSnap`. For most actions this is
 * a single delta; for `move` it's two (delete at source, insert at dest).
 */
function intraStepShiftFromEdit(e: Record<string, unknown>, snapLine: number, targetSnap: number): number {
  const action = normalizeEditAction(e);
  if (action === 'move') {
    const span = effectiveLineSpanCount(e);
    const dest = typeof e.destination === 'number' && e.destination > 0 ? e.destination : 0;
    if (dest <= 0 || snapLine <= 0) return 0;
    let shift = 0;
    if (snapLine < targetSnap) shift -= span; // source removal shifts down
    const effectiveDest = dest > snapLine ? dest - span : dest;
    if (effectiveDest < targetSnap) shift += span; // dest insertion shifts up
    return shift;
  }
  const d = computeSingleEditNetDelta(e);
  if (action === 'insert_before' || action === 'prepend') {
    return snapLine <= targetSnap ? d : 0;
  }
  if (action === 'insert_after' || action === 'append') {
    return snapLine < targetSnap ? d : 0;
  }
  return (snapLine < targetSnap) ? d : 0;
}

function rebaseIntraStepSnapshotLineEdits(lineEdits: unknown[]): void {
  if (lineEdits.length < 2) return;

  // Sort entries by snapshot line (ascending) so lower-line edits precede
  // higher-line edits. This matches Rust's top-down sequential application
  // and prevents cross-range rebase mis-ordering when a delete at a high line
  // and an insert at a low line coexist in the same step.
  const indices = lineEdits.map((edit, idx) => {
    if (!edit || typeof edit !== 'object') return { idx, snap: 0 };
    const o = edit as Record<string, unknown>;
    const line = snapshotLineForRebase(o);
    const hasSymbol = o.symbol != null && typeof o.symbol === 'string';
    return { idx, snap: line > 0 && !hasSymbol ? line : 0 };
  });
  indices.sort((a, b) => {
    if (a.snap === 0 && b.snap === 0) return a.idx - b.idx;
    if (a.snap === 0) return 1;
    if (b.snap === 0) return -1;
    return a.snap !== b.snap ? a.snap - b.snap : a.idx - b.idx;
  });
  const sorted: unknown[] = indices.map(e => lineEdits[e.idx]);
  for (let k = 0; k < lineEdits.length; k++) lineEdits[k] = sorted[k];

  const snapshotLines: number[] = indices.map(e => e.snap);

  for (let i = 1; i < lineEdits.length; i++) {
    const targetSnap = snapshotLines[i];
    if (targetSnap <= 0) continue;
    const o = lineEdits[i] as Record<string, unknown>;
    const hasSymbol = o.symbol != null && typeof o.symbol === 'string';
    const snap = snapshotLineForRebase(o);
    const endLine = typeof o.end_line === 'number' && Number.isFinite(o.end_line as number) && (o.end_line as number) > 0
      ? (o.end_line as number)
      : 0;
    const dest = typeof o.destination === 'number' && Number.isFinite(o.destination as number) && (o.destination as number) > 0
      ? (o.destination as number)
      : 0;

    // Single pass: compute line, end_line, and destination shifts together
    // instead of 3 separate inner loops over 0..i
    let shift = 0, endShift = 0, destShift = 0;
    for (let j = 0; j < i; j++) {
      const origJ = snapshotLines[j];
      if (origJ <= 0) continue;
      const editJ = lineEdits[j] as Record<string, unknown>;
      shift += intraStepShiftFromEdit(editJ, origJ, targetSnap);
      if (endLine > 0) endShift += intraStepShiftFromEdit(editJ, origJ, endLine);
      if (dest > 0) destShift += intraStepShiftFromEdit(editJ, origJ, dest);
    }
    if (snap > 0 && !hasSymbol) {
      o.line = targetSnap + shift;
    }
    if (endLine > 0 && endShift !== 0) o.end_line = endLine + endShift;
    if (dest > 0 && destShift !== 0) o.destination = dest + destShift;
  }
}

/**
 * Apply intra-step snapshot rebasing for all line_edits (always snapshot semantics).
 * Strips `line_numbering` from params before dispatch (legacy field).
 */
function applyIntraStepSnapshotRebaseIfNeeded(params: Record<string, unknown>): void {
  const top = params.line_edits;
  if (Array.isArray(top)) rebaseIntraStepSnapshotLineEdits(top);
  if (params.mode === 'batch_edits' && Array.isArray(params.edits)) {
    for (const ed of params.edits) {
      if (!ed || typeof ed !== 'object') continue;
      const entry = ed as Record<string, unknown>;
      if (Array.isArray(entry.line_edits)) rebaseIntraStepSnapshotLineEdits(entry.line_edits as unknown[]);
    }
  }
  if (params.line_numbering !== undefined) delete params.line_numbering;
}

/**
 * Build a per-file positional delta map from completed step params.
 * Handles both single-file (top-level line_edits) and multi-file
 * (batch_edits mode with edits[]) payloads.
 */
function buildPerFileDeltaMap(
  completedParams: Record<string, unknown>,
): Map<string, PositionalDelta[]> {
  const map = new Map<string, PositionalDelta[]>();

  const topFile = extractEditTargetFile(completedParams);
  if (topFile && Array.isArray(completedParams.line_edits)) {
    const deltas = computePositionalDeltas(completedParams.line_edits);
    if (deltas.length > 0) map.set(normalizePathForRebase(topFile), deltas);
  }

  if (completedParams.mode === 'batch_edits' && Array.isArray(completedParams.edits)) {
    for (const ed of completedParams.edits) {
      if (!ed || typeof ed !== 'object') continue;
      const entry = ed as Record<string, unknown>;
      const file = extractEditTargetFile(entry);
      if (!file || !Array.isArray(entry.line_edits)) continue;
      const key = normalizePathForRebase(file);
      const deltas = computePositionalDeltas(entry.line_edits);
      if (deltas.length === 0) continue;
      const existing = map.get(key);
      if (existing) existing.push(...deltas);
      else map.set(key, deltas);
    }
  }

  return map;
}

/** Apply positional deltas to a single line_edits array in-place. */
function applyDeltasToLineEdits(
  lineEdits: unknown[],
  deltas: PositionalDelta[],
): void {
  for (const le of lineEdits) {
    if (!le || typeof le !== 'object') continue;
    const entry = le as Record<string, unknown>;
    if (typeof entry.line === 'number' && entry.line > 0 && !entry.symbol) {
      const targetLine = entry.line as number;
      let shift = 0;
      for (const d of deltas) {
        const applies = d.lineInclusive ? d.line <= targetLine : d.line < targetLine;
        if (applies) shift += d.delta;
      }
      if (shift !== 0) entry.line = targetLine + shift;
    }
    if (typeof entry.end_line === 'number' && entry.end_line > 0) {
      const targetEnd = entry.end_line as number;
      let endShift = 0;
      for (const d of deltas) {
        const applies = d.lineInclusive ? d.line <= targetEnd : d.line < targetEnd;
        if (applies) endShift += d.delta;
      }
      if (endShift !== 0) entry.end_line = targetEnd + endShift;
    }
    if (typeof entry.destination === 'number' && entry.destination > 0) {
      const targetDest = entry.destination as number;
      let destShift = 0;
      for (const d of deltas) {
        const applies = d.lineInclusive ? d.line <= targetDest : d.line < targetDest;
        if (applies) destShift += d.delta;
      }
      if (destShift !== 0) entry.destination = targetDest + destShift;
    }
  }
}

function rebaseSubsequentSteps(
  completedParams: Record<string, unknown>,
  stepsToRun: Array<{ id: string; use: string; with?: Record<string, unknown> }>,
  startIndex: number,
): void {
  const deltaMap = buildPerFileDeltaMap(completedParams);
  if (deltaMap.size === 0) return;

  for (let j = startIndex; j < stepsToRun.length; j++) {
    const future = stepsToRun[j];
    if (!future.use.startsWith('change.') || !future.with) continue;

    // Rebase top-level line_edits when the future step targets a file we edited
    const futureFile = extractEditTargetFile(future.with);
    if (futureFile) {
      const deltas = deltaMap.get(normalizePathForRebase(futureFile));
      if (deltas && Array.isArray(future.with.line_edits)) {
        applyDeltasToLineEdits(future.with.line_edits as unknown[], deltas);
      }
    }

    // Rebase nested edits[] entries (batch_edits mode in a future step)
    if (Array.isArray(future.with.edits)) {
      for (const ed of future.with.edits) {
        if (!ed || typeof ed !== 'object') continue;
        const entry = ed as Record<string, unknown>;
        const entryFile = extractEditTargetFile(entry);
        if (!entryFile) continue;
        const deltas = deltaMap.get(normalizePathForRebase(entryFile));
        if (deltas && Array.isArray(entry.line_edits)) {
          applyDeltasToLineEdits(entry.line_edits as unknown[], deltas);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extracted helpers
// ---------------------------------------------------------------------------

/**
 * Seed the snapshot tracker from the persistent awareness cache.
 * Carries forward awareness for unchanged files across batches.
 */
function seedSnapshotTracker(
  tracker: SnapshotTracker,
  awarenessCache: ReadonlyMap<string, { level: number; filePath: string; snapshotHash: string; readRegions: LineRegion[]; shapeHash?: string }>,
): void {
  for (const [, entry] of awarenessCache) {
    const readKind = entry.level === AwarenessLevel.CANONICAL ? 'canonical' as const
      : entry.level >= AwarenessLevel.SHAPED ? 'shaped' as const : 'cached' as const;
    tracker.record(entry.filePath, entry.snapshotHash, readKind, {
      readRegion: entry.readRegions.length > 0 ? entry.readRegions[0] : undefined,
      shapeHash: entry.shapeHash,
    });
    for (const region of entry.readRegions.slice(1)) {
      tracker.record(entry.filePath, entry.snapshotHash, 'lines', { readRegion: region });
    }
  }
}

/**
 * Auto-inject content_hash into change op params from the tracker.
 * Mutates mergedParams in place.
 */
function injectSnapshotHashes(
  mergedParams: Record<string, unknown>,
  tracker: SnapshotTracker,
): void {
  const targetFile = (mergedParams.file ?? mergedParams.file_path) as string | undefined;
  if (typeof targetFile === 'string' && !mergedParams.content_hash) {
    const trackedHash = tracker.getHash(targetFile);
    if (trackedHash) {
      mergedParams.content_hash = trackedHash;
    }
  }
  if (Array.isArray(mergedParams.edits)) {
    mergedParams.edits = mergedParams.edits.map((edit) => {
      if (!edit || typeof edit !== 'object') return edit;
      const entry = edit as Record<string, unknown>;
      const editFile = (entry.file ?? entry.file_path) as string | undefined;
      if (typeof editFile === 'string' && !entry.content_hash) {
        const trackedHash = tracker.getHash(editFile);
        if (trackedHash) {
          entry.content_hash = trackedHash;
        }
      }
      return entry;
    });
  }
}

/**
 * Map change.edit `file` to a tracker path key: prefer content_hash resolution, then raw path,
 * then treat `file` as a snapshot hash id (so read.lines coverage matches prior reads).
 */
function resolveGatePathForTracker(
  mergedParams: Record<string, unknown>,
  tracker: SnapshotTracker,
): string {
  const raw = (mergedParams.file ?? mergedParams.file_path) as string | undefined;
  if (typeof raw !== 'string') return '';
  const ch = mergedParams.content_hash ?? mergedParams.snapshot_hash;
  if (typeof ch === 'string') {
    const p = tracker.findFilePathForSnapshotHash(ch);
    if (p) return p;
  }
  if (!raw.startsWith('h:') && tracker.getIdentity(raw)) return raw;
  const fromRaw = tracker.findFilePathForSnapshotHash(raw);
  if (fromRaw) return fromRaw;
  return raw;
}

/**
 * Record snapshot hashes from step output into the tracker.
 * Handles read ops (lines, shaped, canonical) and change ops (invalidate + re-record).
 */
function recordSnapshotFromOutput(
  step: { use: string },
  output: StepOutput,
  snapshotTracker: SnapshotTracker,
  ctx: HandlerContext,
  policy: { auto_reread_after_mutation?: boolean } | undefined,
): void {
  if (!output.ok || !output.content || typeof output.content !== 'object' || Array.isArray(output.content)) return;

  const isChangeStep = step.use.startsWith('change.');
  const autoReread = policy?.auto_reread_after_mutation !== false;
  const readKind = step.use === 'read.context' ? 'canonical' as const
    : step.use === 'read.file' ? 'canonical' as const
    : step.use === 'read.shaped' ? 'shaped' as const
    : step.use === 'read.lines' ? 'lines' as const
    : isChangeStep ? 'canonical' as const
    : 'cached' as const;

  const artifact = output.content as Record<string, unknown>;

  if (isChangeStep && autoReread) {
    // After a mutation, invalidate old hashes and record new ones.
    // Also pre-register the revision advance cause so the file watcher's
    // reconcileSourceRevision picks up 'same_file_prior_edit' instead of
    // defaulting to 'external_file_change'.
    const store = ctx.store();
    const sid = ctx.sessionId ?? undefined;
    const sources = [artifact.results, artifact.drafts, artifact.batch];
    for (const arr of sources) {
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const fp = SnapshotTracker.extractFilePath(rec);
        const sh = SnapshotTracker.extractHash(rec);
        if (fp && sh) {
          snapshotTracker.invalidateAndRerecord(fp, sh);
          store.recordRevisionAdvance(fp, sh, 'same_file_prior_edit', sid);
        }
      }
    }
    // Also check top-level file+hash
    const topFp = SnapshotTracker.extractFilePath(artifact);
    const topSh = SnapshotTracker.extractHash(artifact);
    if (topFp && topSh) {
      snapshotTracker.invalidateAndRerecord(topFp, topSh);
      store.recordRevisionAdvance(topFp, topSh, 'same_file_prior_edit', sid);
    }
  } else {
    // Extended recording: extract readRegions from read.lines, shapeHash from read.shaped
    if (step.use === 'read.lines') {
      const rlFile = artifact.file as string | undefined;
      const rlActualRange = artifact.actual_range as Array<[number, number | null]> | undefined;
      const rlHash = SnapshotTracker.extractHash(artifact);
      const lineTotal = typeof artifact.lines === 'number' ? artifact.lines : undefined;
      if (rlFile && rlHash && Array.isArray(rlActualRange)) {
        for (const range of rlActualRange) {
          const start = range[0];
          const end = range[1] ?? start;
          if (typeof start === 'number' && typeof end === 'number') {
            snapshotTracker.record(rlFile, rlHash, 'lines', {
              readRegion: { start, end },
              ...(lineTotal != null ? { fullFileLineCount: lineTotal } : {}),
            });
          }
        }
      }
    } else if (step.use === 'read.shaped') {
      const shapedResults = artifact.results as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(shapedResults)) {
        for (const result of shapedResults) {
          if (!result || typeof result !== 'object') continue;
          const fp = result.file as string | undefined;
          const sh = SnapshotTracker.extractHash(result);
          const shapeHash = result.shape_hash as string | undefined;
          if (fp && sh) {
            snapshotTracker.record(fp, sh, 'shaped', { shapeHash: shapeHash || undefined });
          }
        }
      }
    }
    snapshotTracker.recordFromResponse(artifact, readKind);
  }

  // Forward new hashes to staged entries after edit completion
  if (isChangeStep) {
    const drafts = artifact.drafts as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(drafts)) {
      for (const draft of drafts) {
        const path = draft.file as string | undefined;
        const hash = draft.content_hash as string | undefined;
        if (path && hash) {
          ctx.store().forwardStagedHash(path, hash);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Post-edit content refresh — keep engrams & snippets live after mutations
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** File paths + optional actual_range embedded in file_refs step content. */
function extractFileRefsWithRanges(output: StepOutput): Array<{ path: string; range?: string }> {
  if (output.kind !== 'file_refs' || !output.ok || !output.content || typeof output.content !== 'object') return [];
  const c = output.content as Record<string, unknown>;
  const entries: Array<{ path: string; range?: string }> = [];

  function rangeLabel(actualRange: unknown): string | undefined {
    if (!Array.isArray(actualRange) || actualRange.length === 0) return undefined;
    return actualRange.map((r: unknown) => {
      if (!Array.isArray(r)) return '';
      const s = r[0] as number;
      const e = r[1] as number | null;
      return e != null ? `${s}-${e}` : `${s}`;
    }).filter(Boolean).join(',');
  }

  if (typeof c.file === 'string') {
    entries.push({ path: c.file, range: rangeLabel(c.actual_range) });
  }
  const results = c.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (typeof rec.file === 'string') {
          entries.push({ path: rec.file, range: rangeLabel(rec.actual_range) });
        }
      }
    }
  }
  return entries;
}

/** File paths embedded in file_refs step content (read.lines, read.context, etc.). */
function extractFilePathsFromFileRefsContent(output: StepOutput): string[] {
  return extractFileRefsWithRanges(output).map(e => e.path);
}

/**
 * Extract file paths mentioned in a session.bb.write step's params.
 * Used to scope spin-counter resets to relevant files only.
 */
function extractBbWriteFilePaths(params: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const key = params.key as string | undefined;
  const derivedFrom = params.derived_from ?? params.derivedFrom;
  if (Array.isArray(derivedFrom)) {
    for (const d of derivedFrom) {
      if (typeof d === 'string') paths.push(d);
    }
  }
  const filePath = params.file_path ?? params.filePath;
  if (typeof filePath === 'string') paths.push(filePath);
  if (typeof key === 'string' && (key.includes('/') || key.includes('\\'))) {
    paths.push(key);
  }
  return paths;
}

function collectEditedFiles(artifact: Record<string, unknown>): Array<{ filePath: string; newHash: string }> {
  const results: Array<{ filePath: string; newHash: string }> = [];
  const seen = new Set<string>();
  for (const arr of [artifact.results, artifact.drafts, artifact.batch]) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const fp = SnapshotTracker.extractFilePath(rec);
      const sh = SnapshotTracker.extractHash(rec);
      if (fp && sh) {
        const key = normalizePath(fp);
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ filePath: fp, newHash: sh });
        }
      }
    }
  }
  const topFp = SnapshotTracker.extractFilePath(artifact);
  const topSh = SnapshotTracker.extractHash(artifact);
  if (topFp && topSh && !seen.has(normalizePath(topFp))) {
    results.push({ filePath: topFp, newHash: topSh });
  }
  return results;
}

function hasEngramForSource(ctx: HandlerContext, sourcePath: string): boolean {
  const pathNorm = normalizePath(sourcePath);
  for (const [, chunk] of ctx.store().chunks) {
    if (chunk.compacted || !chunk.source) continue;
    if (normalizePath(chunk.source) === pathNorm) return true;
  }
  return false;
}

function parseLineSpec(spec: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const part of spec.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const dash = t.indexOf('-');
    if (dash >= 0) {
      const s = parseInt(t.slice(0, dash).trim(), 10);
      const e = parseInt(t.slice(dash + 1).trim(), 10);
      if (Number.isFinite(s) && Number.isFinite(e)) ranges.push([s, e]);
    } else {
      const n = parseInt(t, 10);
      if (Number.isFinite(n)) ranges.push([n, n]);
    }
  }
  return ranges;
}

function applyLineDelta(lineSpec: string, delta: number): string {
  const ranges = parseLineSpec(lineSpec);
  if (ranges.length === 0) return lineSpec;
  return ranges.map(([s, e]) => {
    const ns = Math.max(1, s + delta);
    const ne = Math.max(ns, e + delta);
    return `${ns}-${ne}`;
  }).join(',');
}

/**
 * Post-edit context refresh — resolve fresh content from the new hash.
 *
 * Freshness is priority 0. The system performed the edit, the system has the
 * new hash, the system resolves the truth. addChunk with the same source
 * triggers hash forwarding (old engram auto-compacted, new one installed as
 * fresh with correct line numbers). Staged snippets are re-resolved from the
 * new hash rather than unstaged.
 *
 * markEngramsSuspect is only used as a fallback when resolution fails.
 */
async function refreshContextAfterEdit(
  artifact: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<void> {
  const editedFiles = collectEditedFiles(artifact);
  if (editedFiles.length === 0) return;

  const store = ctx.store();

  for (const ef of editedFiles) {
    const bareHash = ef.newHash.replace(/^h:/, '');

    // 1. Resolve fresh post-edit content and replace the engram
    try {
      const resolved = await invoke<{ content: string; source?: string | null }>(
        'resolve_hash_ref', { rawRef: `h:${bareHash}` },
      );
      if (resolved?.content) {
        store.addChunk(resolved.content, 'file', ef.filePath,
          undefined, undefined, bareHash, {
            sourceRevision: bareHash,
            origin: 'edit-refresh',
            viewKind: 'latest',
          });
      }
    } catch (e) {
      console.warn('[executor] engram refresh failed, marking suspect:', e);
      if (hasEngramForSource(ctx, ef.filePath)) {
        store.markEngramsSuspect([ef.filePath], 'same_file_prior_edit' as 'unknown', 'content');
      }
    }

    // 2. Refresh staged snippets from the new hash
    const snippets = store.getStagedSnippetsForRefresh(ef.filePath);
    for (const snippet of snippets) {
      try {
        if (snippet.shapeSpec) {
          const rawRef = `h:${bareHash}:${snippet.shapeSpec}`;
          const resolved = await invoke<{ content: string; source?: string | null }>(
            'resolve_hash_ref', { rawRef },
          );
          resolved?.content
            ? store.stageSnippet(snippet.key, resolved.content, snippet.source,
                undefined, bareHash, snippet.shapeSpec, 'derived')
            : store.unstageSnippet(snippet.key);
        } else if (snippet.lines) {
          const rawRef = `h:${bareHash}:${snippet.lines}`;
          const resolved = await invoke<{ content: string; source?: string | null }>(
            'resolve_hash_ref', { rawRef },
          );
          resolved?.content
            ? store.stageSnippet(snippet.key, resolved.content, snippet.source,
                snippet.lines, bareHash, undefined, 'latest')
            : store.unstageSnippet(snippet.key);
        } else {
          store.unstageSnippet(snippet.key);
        }
      } catch (e) {
        console.warn(`[executor] snippet refresh failed for ${snippet.key}:`, e);
        store.unstageSnippet(snippet.key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Impact-driven section-level auto-staging
// ---------------------------------------------------------------------------

function mergeLineRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur[0] <= prev[1] + 3) {
      prev[1] = Math.max(prev[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/**
 * After a change step, query impact analysis for the edited files and
 * directly stage the dependent symbol line ranges. Uses affected_symbols
 * with line/end_line from the Rust change_impact query.
 *
 * Pipeline: change_impact → group symbols by file → merge ranges →
 * read_lines per file → stageSnippet. Caps at 5 dependent files and
 * 5k tokens total to avoid bloating the staged block.
 */
async function runImpactAutoStage(
  editedPaths: string[],
  ctx: HandlerContext,
): Promise<{ staged: number; files: number; tokens: number }> {
  if (editedPaths.length === 0) return { staged: 0, files: 0, tokens: 0 };

  const result = await ctx.atlsBatchQuery('change_impact', { file_paths: editedPaths });
  const impact = result as {
    affected_symbols?: Array<{ name: string; file: string; kind: string; line: number; end_line?: number }>;
  };

  const symbols = impact.affected_symbols;
  if (!symbols || symbols.length === 0) return { staged: 0, files: 0, tokens: 0 };

  const store = ctx.store();
  const staged = store.getStagedEntries();
  const stageByFile = new Map<string, Array<[number, number]>>();

  for (const sym of symbols) {
    if (!sym.file || !sym.line) continue;
    if (editedPaths.some(ep => normalizePath(ep) === normalizePath(sym.file))) continue;

    const endLine = sym.end_line ?? (sym.line + 20);
    const existing = stageByFile.get(sym.file) ?? [];
    existing.push([sym.line, endLine]);
    stageByFile.set(sym.file, existing);
  }

  const MAX_FILES = 5;
  const MAX_TOTAL_TOKENS = 5_000;
  let totalTokens = 0;
  let stagedCount = 0;
  let fileCount = 0;

  for (const [filePath, ranges] of stageByFile) {
    if (fileCount >= MAX_FILES || totalTokens >= MAX_TOTAL_TOKENS) break;

    const srcNorm = normalizePath(filePath);
    let alreadyStaged = false;
    for (const [, s] of staged) {
      if (s.source && normalizePath(s.source) === srcNorm) { alreadyStaged = true; break; }
    }
    if (alreadyStaged) continue;

    const merged = mergeLineRanges(ranges);
    const lineSpec = merged.map(([s, e]) => `${s}-${e}`).join(',');

    try {
      const ctxResult = await ctx.atlsBatchQuery('context', { type: 'full', file_paths: [filePath] });
      const ctxResults = (ctxResult as Record<string, unknown>)?.results as Array<Record<string, unknown>> | undefined;
      const first = ctxResults?.[0];
      const fileHash = (first?.content_hash ?? first?.hash) as string | undefined;
      if (!fileHash) continue;

      const cleanHash = fileHash.startsWith('h:') ? fileHash : `h:${fileHash}`;
      const readResult = await ctx.atlsBatchQuery('read_lines', {
        hash: cleanHash,
        lines: lineSpec,
        file_path: filePath,
        context_lines: 2,
      }) as Record<string, unknown>;

      const content = readResult.content as string | undefined;
      if (!content) continue;

      const label = `impact:${filePath.split(/[/\\]/).pop()}:${lineSpec}`;
      const bareHash = fileHash.replace(/^h:/, '');
      const stageResult = store.stageSnippet(label, content, filePath, lineSpec, bareHash, undefined, 'derived');
      if (stageResult.ok) {
        totalTokens += stageResult.tokens;
        stagedCount++;
        fileCount++;
      }
    } catch (e) {
      console.warn(`[executor] impact stage read failed for ${filePath}:`, e);
    }
  }

  return { staged: stagedCount, files: fileCount, tokens: totalTokens };
}

/**
 * Build and record a VerifyArtifact from a verify step's output.
 */
function buildVerifyArtifact(
  step: { id: string; use: string },
  output: StepOutput,
  results: StepResult[],
  stepOutputs: Map<string, StepOutput>,
  snapshotTracker: SnapshotTracker,
  ctx: HandlerContext,
): void {
  const filesObserved: string[] = [];
  for (const prior of results) {
    if (!prior.use.startsWith('change.') || !prior.ok) continue;
    const priorOutput = stepOutputs.get(prior.id);
    if (!priorOutput?.content || typeof priorOutput.content !== 'object') continue;
    const artifact = priorOutput.content as Record<string, unknown>;
    const drafts = (artifact.drafts ?? artifact.results ?? artifact.batch) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(drafts)) {
      for (const d of drafts) {
        const f = (d.f ?? d.file ?? d.path ?? d.file_path) as string | undefined;
        if (f) filesObserved.push(f);
      }
    }
  }

  const verifyRaw = output.content as Record<string, unknown> | undefined;
  const warnCount = typeof verifyRaw?.warnings === 'number' ? verifyRaw.warnings : 0;
  const errCount = typeof verifyRaw?.errors === 'number' ? verifyRaw.errors : 0;
  const stepVerificationConfidence = stepOutputToResult(step.id, step.use, output, 0).verification_confidence;
  const verifySource = verifyRaw && typeof verifyRaw.summary === 'object' && verifyRaw.summary && 'source' in verifyRaw.summary
    ? (verifyRaw.summary.source === 'cache' ? 'cache' : 'command')
    : 'command';

  const uniqueFiles = [...new Set(filesObserved)];
  const fileFingerprint: Record<string, string> = {};
  const observedHashes = snapshotTracker.getAllForFiles(uniqueFiles);
  for (const [fp, hash] of observedHashes) {
    fileFingerprint[fp] = hash;
  }

  ctx.store().addVerifyArtifact({
    id: `${step.id}_${Date.now()}`,
    createdAtRev: ctx.store().getCurrentRev(),
    filesObserved: uniqueFiles,
    ok: output.ok,
    warnings: warnCount,
    errors: errCount,
    stepId: step.id,
    confidence: stepVerificationConfidence,
    source: verifySource,
    stale: stepVerificationConfidence === 'obsolete' || stepVerificationConfidence === 'stale-suspect',
    staleReason: stepVerificationConfidence === 'obsolete'
      ? 'workspace_changed_since_verification'
      : stepVerificationConfidence === 'stale-suspect'
        ? 'suspect_external_change'
        : undefined,
    fileFingerprint: Object.keys(fileFingerprint).length > 0 ? fileFingerprint : undefined,
  });
}

// ---------------------------------------------------------------------------
// Ref / binding resolution
// ---------------------------------------------------------------------------

function resolveRefExpr(
  expr: RefExpr,
  stepOutputs: ReadonlyMap<string, StepOutput>,
  namedBindings: ReadonlyMap<string, StepOutput>,
): unknown {
  if ('value' in expr) return expr.value;

  if ('ref' in expr) return expr.ref;

  if ('bind' in expr) {
    const bound = namedBindings.get(expr.bind);
    if (!bound) return undefined;
    return bound.refs.length > 0 ? bound.refs : undefined;
  }

  if ('from_step' in expr) {
    const output = stepOutputs.get(expr.from_step);
    if (!output) return undefined;
    if (expr.path) {
      // Dot-path access into the StepOutput
      const parts = expr.path.split('.');
      let current: unknown = output;
      for (const part of parts) {
        if (current == null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    }
    return output.refs.length > 0 ? output.refs : undefined;
  }

  return undefined;
}

function resolveInBindings(
  inSpec: Record<string, RefExpr> | undefined,
  stepOutputs: ReadonlyMap<string, StepOutput>,
  namedBindings: ReadonlyMap<string, StepOutput>,
): Record<string, unknown> {
  if (!inSpec) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, expr] of Object.entries(inSpec)) {
    const val = resolveRefExpr(expr, stepOutputs, namedBindings);
    if (val !== undefined) {
      resolved[key] = val;
    } else if ('from_step' in expr || 'bind' in expr) {
      const source = 'from_step' in expr ? `step '${expr.from_step}'` : `binding '${(expr as { bind: string }).bind}'`;
      resolved[`_binding_warning_${key}`] = `${key}: resolved to nothing from ${source} (0 refs). Use explicit path or provide value directly.`;
    }
  }
  return resolved;
}

function getArtifact(output: StepOutput): Record<string, unknown> | null {
  if (!output.content || typeof output.content !== 'object' || Array.isArray(output.content)) return null;
  return output.content as Record<string, unknown>;
}

/** system.exec outputs that indicate policy-block or confirmation — not real execution failures. */
function isBlockingSystemExec(
  stepUse: string,
  artifact: Record<string, unknown>,
): boolean {
  if (stepUse !== 'system.exec') return false;
  const status = typeof artifact.status === 'string' ? artifact.status.toLowerCase() : '';
  const actionRequired = typeof artifact.action_required === 'string' ? artifact.action_required.toLowerCase() : '';
  const next = typeof artifact._next === 'string' ? artifact._next.toLowerCase() : '';
  return (
    status === 'paused'
    || status === 'failed_lint'
    || status === 'error'
    || status === 'blocked'
    || Boolean(artifact._rollback)
    || artifact.resume_after !== undefined
    || artifact.dry_run === true
    || actionRequired.includes('confirm')
    || next.includes('confirm:true')
    || next.includes('dry_run:false')
    || next.includes('preview complete')
    || next.includes('awaiting review')
    || next.includes('review and confirm')
  );
}

/** Detect whether a change.* step result is a dry-run preview (no files written). */
function isDryRunPreview(output: StepOutput): boolean {
  const art = getArtifact(output);
  if (!art) return false;
  return art.dry_run === true
    || art.dry_run === 1
    || art.status === 'preview'
    || (typeof art._next === 'string' && art._next.toLowerCase().includes('dry_run:false'));
}

// ---------------------------------------------------------------------------
// Progress callback — fired after each step so callers can stream partial results
// ---------------------------------------------------------------------------

export interface BatchStepProgress {
  stepId: string;
  stepUse: string;
  stepIndex: number;
  totalSteps: number;
  ok: boolean;
  summaryLine: string;
  durationMs: number;
}

export type OnBatchStepComplete = (progress: BatchStepProgress) => void;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeUnifiedBatch(
  request: UnifiedBatchRequest,
  ctx: HandlerContext,
  onStepComplete?: OnBatchStepComplete,
): Promise<UnifiedBatchResult> {
  const batchStart = Date.now();

  const validation = validateBatchSteps(request.steps ?? []);
  if (!validation.ok) {
    const msg = `batch: ERROR ${validation.error}`;
    return {
      ok: false,
      summary: msg,
      step_results: [
        {
          id: '__batch_validation__',
          use: 'session.stats',
          ok: false,
          error: validation.error,
          summary: msg,
          duration_ms: 0,
        },
      ],
      duration_ms: Date.now() - batchStart,
    };
  }

  const stepOutputs = new Map<string, StepOutput>();
  const namedBindings = new Map<string, StepOutput>();
  const results: StepResult[] = [];
  const allRefs: string[] = [];
  const bbRefs: string[] = [];
  const verifyResults: Array<{ step_id: string; passed: boolean; summary: string; classification?: VerifyClassification }> = [];
  let batchOk = true;
  let spinBreaker: string | undefined;
  let dryRunPreviewCount = 0;

  // Expose step outputs to handlers (e.g. session.pin resolves step IDs to hashes)
  ctx.getStepOutput = (stepId: string) => stepOutputs.get(stepId);
  ctx.forEachStepOutput = (fn: (stepId: string, output: StepOutput) => void) => {
    for (const [id, out] of stepOutputs) fn(id, out);
  };

  // Reset per-batch state
  resetRecallBudget();
  const snapshotTracker = new SnapshotTracker();
  const batchEditedPaths = new Set<string>();

  // Seed from persistent awareness cache
  seedSnapshotTracker(snapshotTracker, ctx.store().getAwarenessCache());

  const policy = request.policy;

  /** Push a step result and notify the caller for progressive UI updates. */
  function recordStepResult(stepId: string, stepUse: string, output: StepOutput, durationMs: number): void {
    const result = stepOutputToResult(stepId, stepUse, output, durationMs);
    results.push(result);
    if (onStepComplete) {
      const label = output.classification
        ? { pass: '[OK]', 'pass-with-warnings': '[WARN]', fail: '[FAIL]', 'tool-error': '[TOOL-ERROR]' }[output.classification]
        : output.summary?.includes('SKIPPED') ? '[SKIP]' : (output.ok ? '[OK]' : '[FAIL]');
      const suffix = durationMs > 0 ? ` (${durationMs}ms)` : '';
      const text = output.summary || output.error || stepId;
      const summaryLine = `${label} ${stepId}: ${text}${suffix}`;
      onStepComplete({
        stepId,
        stepUse,
        stepIndex: results.length - 1,
        totalSteps: stepsToRun.length,
        ok: output.ok,
        summaryLine,
        durationMs,
      });
    }
  }

  // Resolve intent.* macro steps before main loop
  const intentCtx = buildIntentContext(ctx.store, stepOutputs);
  const intentResult = resolveIntents(request.steps, intentCtx);
  const stepsToRun = [...intentResult.expanded];
  if (intentResult.lookahead.length > 0 && !isPressured(ctx.store)) {
    stepsToRun.push(...intentResult.lookahead);
  }

  // Track batch size for compliance metrics
  ctx.store().recordManageOps(request.steps.length);
  ctx.store().recordToolCall();

  // Pre-register named refs from the request envelope
  if (request.refs) {
    for (const hint of request.refs) {
      // Store as a synthetic StepOutput so bindings can reference them
      namedBindings.set(hint.name, {
        kind: 'raw', ok: true, refs: [hint.ref], summary: `ref:${hint.name}`,
      });
    }
  }

  let userStepIndex = 0;

  for (let i = 0; i < stepsToRun.length; i++) {
    const step = stepsToRun[i];
    const stepStart = Date.now();
    const isAutoStep = step.id.includes('__auto_stage') || step.id.includes('__auto_verify') || step.id.includes('__rollback') || step.id.includes('__lookahead');

    // Max steps check: only when model explicitly set policy.max_steps
    if (!isAutoStep && policy && isStepCountExceeded(userStepIndex, policy)) {
      const output: StepOutput = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: SKIPPED (max_steps ${policy.max_steps} exceeded)`,
        error: 'max_steps exceeded',
      };
      stepOutputs.set(step.id, output);
      recordStepResult(step.id, step.use, output, 0);
      batchOk = false;
      break;
    }

    // Swarm agent restriction
    if (ctx.isSwarmAgent && isBlockedForSwarm(step.use)) {
      const output: StepOutput = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.use}: ERROR blocked for swarm agents (orchestrator owns lifecycle)`,
        error: 'blocked for swarm agents',
      };
      stepOutputs.set(step.id, output);
      recordStepResult(step.id, step.use, output, 0);
      // G23: honor on_error:'stop' for blocked steps
      if (step.on_error === 'stop') { batchOk = false; break; }
      continue;
    }

    // Policy mode check — non-fatal: skip blocked steps, don't interrupt batch
    const allowed = isStepAllowed(step, request.policy);
    if (!allowed.allowed) {
      const output: StepOutput = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: BLOCKED — ${allowed.reason}`,
        error: allowed.reason,
      };
      stepOutputs.set(step.id, output);
      recordStepResult(step.id, step.use, output, 0);
      if (step.on_error === 'stop') { batchOk = false; break; }
      continue;
    }

    // G19: file claims enforcement — reject change ops targeting files outside claims
    if (ctx.fileClaims && ctx.fileClaims.length > 0 && step.use.startsWith('change.')) {
      const targetFile = (step.with?.file ?? step.with?.file_path) as string | undefined;
      const claimNorm = new Set(ctx.fileClaims.map(f => f.replace(/\\/g, '/').toLowerCase()));
      if (targetFile && !targetFile.startsWith('h:') && !claimNorm.has(targetFile.replace(/\\/g, '/').toLowerCase())) {
        const output: StepOutput = {
          kind: 'raw', ok: false, refs: [],
          summary: `${step.id}: BLOCKED — file ${targetFile} is outside swarm file claims [${ctx.fileClaims.join(', ')}]`,
          error: 'file_claim_violation',
        };
        stepOutputs.set(step.id, output);
        recordStepResult(step.id, step.use, output, 0);
        batchOk = false;
        if (step.on_error === 'stop') break;
        continue;
      }
    }

    // Conditional execution
    if (step.if) {
      const condMet = evaluateCondition(step.if, stepOutputs);
      if (!condMet) {
        const output: StepOutput = {
          kind: 'raw', ok: true, refs: [],
          summary: `${step.id}: SKIPPED (condition not met)`,
        };
        stepOutputs.set(step.id, output);
        recordStepResult(step.id, step.use, output, 0);
        continue;
      }
    }

    // Resolve in bindings
    const resolvedInputs = resolveInBindings(step.in, stepOutputs, namedBindings);

    // Merge with and resolved inputs (resolved inputs override with)
    let mergedParams: Record<string, unknown> = normalizeStepParams(step.use, { ...step.with, ...resolvedInputs });

    // change.edit: optional file_path / line from in.from_step — skip slot when binding produced nothing (e.g. search slot beyond hit count)
    if (step.use === 'change.edit') {
      const fp = mergedParams.file_path;
      const missingFile = typeof fp !== 'string' || !fp.trim();
      const bindingWarning = typeof mergedParams._binding_warning_file_path === 'string';
      if (
        step.in?.file_path
        && 'from_step' in step.in.file_path
        && (missingFile || bindingWarning)
      ) {
        const output: StepOutput = {
          kind: 'raw',
          ok: true,
          refs: [],
          summary: `${step.id}: SKIPPED (file_path not bound from prior step)`,
        };
        stepOutputs.set(step.id, output);
        recordStepResult(step.id, step.use, output, Date.now() - stepStart);
        continue;
      }

      const lineRaw = mergedParams.line ?? mergedParams.start_line;
      const lineMissing =
        lineRaw === undefined
        || lineRaw === null
        || (typeof lineRaw === 'number' && !Number.isFinite(lineRaw))
        || (typeof lineRaw === 'string' && !lineRaw.trim());
      const lineBindingWarning = typeof mergedParams._binding_warning_line === 'string';
      if (
        step.in?.line
        && 'from_step' in step.in.line
        && (lineMissing || lineBindingWarning)
      ) {
        const output: StepOutput = {
          kind: 'raw',
          ok: true,
          refs: [],
          summary: `${step.id}: SKIPPED (line not bound from prior step)`,
        };
        stepOutputs.set(step.id, output);
        recordStepResult(step.id, step.use, output, Date.now() - stepStart);
        continue;
      }
    }

    if (FILE_PATH_REQUIRED_OPS.has(step.use)) {
      const rawFp = mergedParams.file_paths;
      const coerced = coerceFilePathsArray(rawFp);
      if (coerced.length === 0) {
        const preview =
          rawFp === undefined
            ? 'undefined'
            : typeof rawFp === 'string'
              ? rawFp.slice(0, 120)
              : serializeForTokenEstimate(rawFp).slice(0, 240);
        const bindingSource = step.in?.file_paths && 'from_step' in step.in.file_paths
          ? ` (binding from step '${step.in.file_paths.from_step}' resolved to nothing)`
          : '';
        const output: StepOutput = {
          kind: 'raw',
          ok: false,
          refs: [],
          summary: `${step.id}: ERROR file_paths must resolve to a non-empty string[] (paths or h: refs). Got: ${preview}${bindingSource}. Use explicit file_paths in 'with', or read.lines with a known h:ref.`,
          error: 'invalid file_paths binding',
        };
        stepOutputs.set(step.id, output);
        recordStepResult(step.id, step.use, output, Date.now() - stepStart);
        batchOk = false;
        if (step.on_error === 'stop') break;
        continue;
      }
      mergedParams.file_paths = coerced;
    }

    // Merge policy options for change ops (e.g. refactor_validation_mode)
    if (request.policy?.refactor_validation_mode && step.use.startsWith('change.')) {
      mergedParams = { ...mergedParams, refactor_validation_mode: request.policy.refactor_validation_mode };
    }

    // Auto-inject content_hash for change ops from the tracker
    if (step.use.startsWith('change.') && snapshotTracker.size > 0) {
      injectSnapshotHashes(mergedParams, snapshotTracker);
    }

    // Optional: all line numbers in one change.edit are relative to the same pre-edit snapshot
    if (step.use === 'change.edit') {
      mergedParams = forkLineEditsForIntraStepRebase(mergedParams);
      applyIntraStepSnapshotRebaseIfNeeded(mergedParams);
    }

    // Read-range edit gate: reject line edits outside prior read.lines coverage
    if (step.use === 'change.edit' && snapshotTracker.size > 0) {
      const gateFileRaw = (mergedParams.file ?? mergedParams.file_path) as string | undefined;
      const gateLineEdits = mergedParams.line_edits as Array<Record<string, unknown>> | undefined;
      const gatePath = gateFileRaw ? resolveGatePathForTracker(mergedParams, snapshotTracker) : '';
      if (
        typeof gateFileRaw === 'string' &&
        !gateFileRaw.startsWith('h:') &&
        Array.isArray(gateLineEdits) &&
        !snapshotTracker.hasCanonicalRead(gatePath) &&
        !batchEditedPaths.has(gateFileRaw) &&
        !batchEditedPaths.has(gatePath)
      ) {
        for (const le of gateLineEdits) {
          const line = le.line;
          const endLine = (le.end_line ?? le.line);
          if (typeof line !== 'number' || line <= 0) continue;
          const end = typeof endLine === 'number' ? endLine : line;
          if (!snapshotTracker.hasReadCoverage(gatePath, line, end)) {
            const output: StepOutput = {
              kind: 'edit_result', ok: false, refs: [],
              summary: `${step.id}: edit_outside_read_range — lines ${line}-${end} of ${gatePath} not covered by a prior read.lines. Read the target region first, then retry the edit.`,
              error: `edit_outside_read_range: lines ${line}-${end} not covered by prior read.lines`,
              content: { error_class: 'edit_outside_read_range', file: gatePath, line, end_line: end, _next: 'read.lines for the target region, then retry' },
            };
            stepOutputs.set(step.id, output);
            recordStepResult(step.id, step.use, output, Date.now() - stepStart);
            batchOk = false;
            break;
          }
        }
        if (stepOutputs.has(step.id)) {
          if (step.on_error === 'stop') break;
          continue;
        }
      }
    }

    // Auto-inject workspace for verify steps when not specified and files were edited
    if (step.use.startsWith('verify.') && !mergedParams.workspace && batchEditedPaths.size > 0) {
      const inferred = inferWorkspaceFromPaths(batchEditedPaths);
      if (inferred) mergedParams.workspace = inferred;
    }

    // session.pin: prior step bound to hashes.refs but returned no h:refs (empty array or missing)
    if (step.use === 'session.pin') {
      const inHashes = step.in?.hashes;
      const fromStep =
        inHashes && typeof inHashes === 'object' && inHashes !== null && 'from_step' in inHashes
          ? String((inHashes as { from_step: string }).from_step).trim()
          : '';
      const hashesParam = mergedParams.hashes;
      const emptyHashes =
        hashesParam === undefined
        || hashesParam === null
        || (Array.isArray(hashesParam) && hashesParam.length === 0);
      if (fromStep && emptyHashes) {
        const output: StepOutput = {
          kind: 'raw',
          ok: false,
          refs: [],
          summary:
            `pin: ERROR step '${fromStep}' produced no h:refs — cannot pin. Re-run a read/search that returns VOLATILE refs, or pass explicit hashes:h:… (pin in the same batch as the read when possible).`,
          error: `pin: empty refs from step '${fromStep}'`,
        };
        stepOutputs.set(step.id, output);
        recordStepResult(step.id, step.use, output, Date.now() - stepStart);
        batchOk = false;
        if (step.on_error === 'stop') break;
        continue;
      }
    }

    // Dispatch (runtime JSON may use non-OperationKind names e.g. OpenAI multi_tool_use.*)
    const useStr = String(step.use);
    if (useStr === 'multi_tool_use.parallel' || useStr.startsWith('multi_tool_use.')) {
      const output: StepOutput = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: ERROR batch steps must use ATLS operation names (e.g. read.context, search.issues), not "${useStr}"`,
        error:
          `unknown operation: ${useStr} — batch uses OperationKind names; express parallel work as multiple batch steps, not OpenAI multi_tool_use wrappers`,
      };
      stepOutputs.set(step.id, output);
      recordStepResult(step.id, step.use, output, Date.now() - stepStart);
      batchOk = false;
      if (step.on_error === 'stop') break;
      continue;
    }

    if (useStr.toUpperCase() === 'USE') {
      const output: StepOutput = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: ERROR "${useStr}" is not an operation — line-syntax docs label the operation column "USE"; set use to a real op (e.g. read.shaped, session.plan, rc, spl, vk)`,
        error:
          `unknown operation: ${useStr} — "USE" in batch docs labels the q: line operation column; set use to a real operation (e.g. read.shaped, session.plan, verify.typecheck, or short codes like rs, spl, vk)`,
      };
      stepOutputs.set(step.id, output);
      recordStepResult(step.id, step.use, output, Date.now() - stepStart);
      batchOk = false;
      if (step.on_error === 'stop') break;
      continue;
    }

    const handler = getHandler(step.use);
    if (!handler) {
      const output: StepOutput = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: ERROR unknown operation "${step.use}"`,
        error: `unknown operation: ${step.use}`,
      };
      stepOutputs.set(step.id, output);
      recordStepResult(step.id, step.use, output, Date.now() - stepStart);
      batchOk = false;
      if (step.on_error === 'stop') break;
      continue;
    }

    // G22: pre-register own writes before handler invocation to close the watcher TOCTOU gap
    if (step.use.startsWith('change.')) {
      const preTargetFile = extractEditTargetFile(mergedParams);
      if (preTargetFile) registerOwnWrite([preTargetFile]);
      if (Array.isArray(mergedParams.edits)) {
        const preTargets = (mergedParams.edits as Array<Record<string, unknown>>)
          .map(e => extractEditTargetFile(e)).filter((f): f is string => !!f);
        if (preTargets.length > 0) registerOwnWrite(preTargets);
      }
    }

    let output: StepOutput;
    try {
      output = await handler(mergedParams, ctx, step.id);
    } catch (e) {
      output = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: ERROR ${e instanceof Error ? e.message : String(e)}`,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // Surface parser-level warnings attached by parseBatchLines (e.g. the
    // `hashes:in:STEP.refs` auto-correct) so the model sees the hint even
    // when the handler still succeeded via the rewritten params.
    const parseWarnings = (step as { _parseWarnings?: unknown })._parseWarnings;
    if (Array.isArray(parseWarnings) && parseWarnings.length > 0) {
      const note = parseWarnings
        .filter((w): w is string => typeof w === 'string')
        .join(' | ');
      if (note) {
        output.summary = output.summary
          ? `${output.summary} | parse-warning: ${note}`
          : `${step.id}: parse-warning: ${note}`;
      }
    }

    // Store outputs
    stepOutputs.set(step.id, output);

    // Record snapshot hashes from step output
    recordSnapshotFromOutput(step, output, snapshotTracker, ctx, policy);

    // Post-edit housekeeping for successful change ops
    if (output.ok && step.use.startsWith('change.')) {
      // Rebase line numbers in subsequent same-file change steps
      if (step.use === 'change.edit') {
        backfillResolvedBodySpans(mergedParams, output);
        rebaseSubsequentSteps(mergedParams, stepsToRun, i + 1);
        // G3: rebase staged snippet line ranges as fallback before re-resolve
        const deltaMap = buildPerFileDeltaMap(mergedParams);
        for (const [normPath, deltas] of deltaMap) {
          const netDelta = deltas.reduce((sum, d) => sum + d.delta, 0);
          if (netDelta !== 0) ctx.store().rebaseStagedLineNumbers(normPath, netDelta);
        }
      }
      // Track edited file paths for auto-workspace inference and own-write registration.
      // Must cover all array shapes the backend may return (results, drafts, batch, written)
      // plus the top-level file field, matching SnapshotTracker.extractFilePath coverage.
      if (output.content && typeof output.content === 'object') {
        const art = output.content as Record<string, unknown>;
        for (const key of ['drafts', 'results', 'batch'] as const) {
          const arr = art[key];
          if (!Array.isArray(arr)) continue;
          for (const d of arr) {
            if (!d || typeof d !== 'object') continue;
            const f = SnapshotTracker.extractFilePath(d as Record<string, unknown>);
            if (f) batchEditedPaths.add(f);
          }
        }
        const written = art.written;
        if (Array.isArray(written)) {
          for (const w of written) {
            if (typeof w === 'string') batchEditedPaths.add(w);
          }
        }
        // G30: scan created/created_files arrays from create operations
        for (const createdKey of ['created', 'created_files'] as const) {
          const created = art[createdKey];
          if (Array.isArray(created)) {
            for (const c of created) {
              if (typeof c === 'string') batchEditedPaths.add(c);
              else if (c && typeof c === 'object') {
                const f = SnapshotTracker.extractFilePath(c as Record<string, unknown>);
                if (f) batchEditedPaths.add(f);
              }
            }
          }
        }
        const topFile = SnapshotTracker.extractFilePath(art);
        if (topFile) batchEditedPaths.add(topFile);
      }
      // Register paths as own writes to suppress spurious intel:file_change from watcher
      registerOwnWrite([...batchEditedPaths]);
      // Evict cached verify/exec/analysis results so they re-run against the updated files
      useRetentionStore.getState().evictMutationSensitive();
      // Refresh engram/snippet content with real post-edit content (awaited for correctness)
      if (output.content && typeof output.content === 'object' && !Array.isArray(output.content)) {
        await refreshContextAfterEdit(output.content as Record<string, unknown>, ctx)
          .catch(e => console.warn('[executor] content refresh error:', e));
      }

      // Impact-driven section-level auto-staging: query change_impact for
      // edited files, extract affected symbol line ranges in dependent files,
      // and stage just those sections (not whole files).
      if (batchEditedPaths.size > 0 && !step.id.includes('__')) {
        runImpactAutoStage([...batchEditedPaths], ctx)
          .catch(e => console.warn('[executor] impact auto-stage failed:', e));
      }
    }

    // Named bindings
    if (step.out) {
      const names = Array.isArray(step.out) ? step.out : [step.out];
      for (const name of names) {
        namedBindings.set(name, output);
      }
    }

    // Collect refs
    if (output.refs.length > 0) allRefs.push(...output.refs);
    if (output.kind === 'bb_ref') bbRefs.push(...output.refs);
    if (output.kind === 'verify_result') {
      verifyResults.push({ step_id: step.id, passed: output.ok, summary: output.summary, classification: output.classification });
      buildVerifyArtifact(step, output, results, stepOutputs, snapshotTracker, ctx);

      const STATIC_VERIFY_OPS = new Set(['verify.build', 'verify.lint', 'verify.typecheck']);
      if (output.ok && STATIC_VERIFY_OPS.has(step.use) && (policy?.compact_context_on_verify_success ?? true)) {
        const { compacted, freedTokens } = ctx.store().compactChunks(['*'], { confirmWildcard: true });
        if (compacted > 0) {
          console.log(`[executor] post-verify compact: ${compacted} chunks compacted (${(freedTokens / 1000).toFixed(1)}k freed)`);
        }
      }
    }

    // Record result
    recordStepResult(step.id, step.use, output, Date.now() - stepStart);

    // Track op kinds for BB-write nudge + read-spin circuit breaker + coverage
    if (output.ok && output.kind === 'file_refs') {
      ctx.store().recordBatchRead();
      const spinEntries = extractFileRefsWithRanges(output);
      for (const entry of spinEntries) {
        ctx.store().recordCoveragePath(entry.path);
      }
      // Shaped reads are discovery-only — skip spin tracking so they don't
      // pollute range counts that gate subsequent investigation reads.
      if (spinEntries.length > 0 && step.use !== 'read.shaped') {
        const br = ctx.store().recordFileReadSpin(spinEntries);
        // Read-spin is tracked in the store and surfaced via spin_breaker / UI; it does not hard-block steps.
        if (br) spinBreaker = br;
      }
    }
    if (output.ok && step.use === 'session.bb.write') {
      const bbKey = typeof mergedParams.key === 'string' ? mergedParams.key : undefined;
      const bbContent = typeof mergedParams.content === 'string' ? mergedParams.content : undefined;
      ctx.store().recordBatchBbWrite(bbKey, bbContent);
      // Any BB write counts as "acting before reading more" — full reset so the
      // agent can proceed with new reads after writing findings.
      ctx.store().resetFileReadSpin();
      spinBreaker = undefined;
    }
    if (output.ok && step.use.startsWith('change.') && !isDryRunPreview(output)) {
      ctx.store().resetFileReadSpin();
      spinBreaker = undefined;
    }

    if (!isAutoStep) userStepIndex += 1;
    const stepArtifact = getArtifact(output);
    const shouldTreatBlockedSystemExecAsNonFatal =
      stepArtifact !== null && isBlockingSystemExec(step.use, stepArtifact);
    // Track consecutive dry-run previews — warn in summary only (no step blocking)
    if (output.ok && step.use.startsWith('change.') && isDryRunPreview(output)) {
      dryRunPreviewCount += 1;
      if (dryRunPreviewCount >= 2) {
        spinBreaker = `<<WARN: ${step.use} dry-run previewed ${dryRunPreviewCount}x. Execute with dry_run:false to apply; avoid redundant previews.>>`;
      }
    } else if (output.ok && step.use.startsWith('change.')) {
      dryRunPreviewCount = 0;
    }
    // Error handling
    if (!output.ok && !shouldTreatBlockedSystemExecAsNonFatal) {
      const errorBehavior = step.on_error ?? 'continue';
      if (errorBehavior === 'stop') {
        batchOk = false;
        break;
      }
      if (errorBehavior === 'rollback' && request.policy?.rollback_on_failure) {
        // Collect restore/delete from _rollback: failing change.* step first, else prior change.* output
        let rollbackWith: Record<string, unknown> = {};
        const selfContent = output.content as Record<string, unknown> | undefined;
        const selfRb = step.use.startsWith('change.')
          ? (selfContent?._rollback as Record<string, unknown> | undefined)
          : undefined;
        if (selfRb?.restore) {
          rollbackWith = { restore: selfRb.restore, delete: selfRb.delete };
        } else {
          for (let j = i - 1; j >= 0; j--) {
            const prior = stepsToRun[j];
            if (prior?.use?.startsWith('change.')) {
              const priorOut = stepOutputs.get(prior.id);
              const content = priorOut?.content as Record<string, unknown> | undefined;
              const rb = content?._rollback as Record<string, unknown> | undefined;
              if (rb?.restore) {
                rollbackWith = { restore: rb.restore, delete: rb.delete };
                break;
              }
            }
          }
        }
        if (rollbackWith.restore) {
          stepsToRun.push({
            id: `${step.id}__rollback`,
            use: 'change.rollback',
            with: rollbackWith,
            on_error: 'continue',
          });
        }
      }
    }

    // Auto-behaviors from policy
    if (output.ok) {
      // Auto-verify after change
      const autoVerifySteps = getAutoVerifySteps(step.id, step.use, request.policy);
      if (autoVerifySteps.length > 0) {
        stepsToRun.splice(i + 1, 0, ...autoVerifySteps);
      }

      // Auto-stage refs: only for outputs that carry resolvable refs (read/context/load, bb)
      const stageableKinds = new Set<StepOutput['kind']>(['file_refs', 'bb_ref']);
      if (request.policy?.auto_stage_refs && output.refs.length > 0 && stageableKinds.has(output.kind)) {
        stepsToRun.splice(i + 1, 0, {
          id: `${step.id}__auto_stage`,
          use: 'session.stage',
          with: { hashes: output.refs },
          on_error: 'continue',
        });
      }

      // Auto-stage on repeated reads: when a file is read 2+ times, stage its
      // signature to break the dormant re-read loop. Only triggers for file_refs
      // outputs and skips already-staged sources.
      if (output.kind === 'file_refs' && output.refs.length > 0 && !request.policy?.auto_stage_refs) {
        const store = ctx.store();
        const staged = store.getStagedEntries();
        const refsToStage: string[] = [];
        for (const ref of output.refs) {
          for (const [, chunk] of store.chunks) {
            if (chunk.shortHash === ref || chunk.hash === ref || `h:${chunk.shortHash}` === ref) {
              if ((chunk.readCount || 0) >= 2 && chunk.source) {
                const srcNorm = normalizePath(chunk.source);
                let alreadyStaged = false;
                for (const [, s] of staged) {
                  if (s.source && normalizePath(s.source) === srcNorm) { alreadyStaged = true; break; }
                }
                if (!alreadyStaged) refsToStage.push(ref);
              }
              break;
            }
          }
        }
        if (refsToStage.length > 0) {
          stepsToRun.splice(i + 1, 0, {
            id: `${step.id}__auto_stage_repeat`,
            use: 'session.stage',
            with: { hashes: refsToStage },
            on_error: 'continue',
          });
        }
      }
    }

    // Verify failure stop check
    if (output.kind === 'verify_result' && !output.ok && request.policy?.stop_on_verify_failure) {
      batchOk = false;
      break;
    }
  }

  // Build summary
  // Flush awareness to persistent cross-batch cache.
  // Edited files get downgraded awareness (no readRegions) so the next batch
  // requires a fresh read.lines before further edits — the diff-only protocol.
  for (const [, identity] of snapshotTracker.entries()) {
    const wasEditedInBatch = batchEditedPaths.has(identity.filePath);
    ctx.store().setAwareness({
      filePath: identity.filePath,
      snapshotHash: identity.snapshotHash,
      level: wasEditedInBatch
        ? AwarenessLevel.NONE
        : snapshotTracker.getAwarenessLevel(identity.filePath),
      readRegions: wasEditedInBatch ? [] : (identity.readRegions ?? []),
      shapeHash: wasEditedInBatch ? undefined : identity.shapeHash,
      recordedAt: Date.now(),
    });
  }

  const okCount = results.filter(r => r.ok).length;
  const totalCount = results.length;
  const summaryBase = request.goal
    ? `${request.goal}: ${okCount}/${totalCount} steps ok (${Date.now() - batchStart}ms)`
    : `batch: ${okCount}/${totalCount} steps ok (${Date.now() - batchStart}ms)`;
  const summary = spinBreaker ? `${summaryBase}\n\n${spinBreaker}` : summaryBase;

  return {
    ok: batchOk,
    summary,
    ...(spinBreaker ? { spin_breaker: spinBreaker } : {}),
    step_results: results,
    final_refs: allRefs.length > 0 ? allRefs : undefined,
    bb_refs: bbRefs.length > 0 ? bbRefs : undefined,
    verify: verifyResults.length > 0 ? verifyResults : undefined,
    intent_metrics: intentResult.metrics.length > 0 ? intentResult.metrics : undefined,
    duration_ms: Date.now() - batchStart,
  };
}
