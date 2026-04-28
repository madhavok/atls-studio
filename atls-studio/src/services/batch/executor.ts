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
  Step,
} from './types';

import { getHandler } from './opMap';
import { coerceFilePathsArray, normalizeStepParams } from './paramNorm';
import { isStepAllowed, getAutoVerifySteps, isStepCountExceeded, evaluateCondition, isBlockedForSwarm } from './policy';
import { stepOutputToResult } from './resultFormatter';
import { resetRecallBudget } from './handlers/session';
import { SnapshotTracker, AwarenessLevel, canonicalizeSnapshotHash } from './snapshotTracker';
import { recordForwarding as manifestRecordForwarding, clearForward as manifestClearForward } from '../hashManifest';
import { computeFileViewHashParts, matchesViewRef } from '../fileViewStore';
import { getTurn as hppGetTurn } from '../hashProtocol';
import { useRoundHistoryStore } from '../../stores/roundHistoryStore';
import type { LineRegion } from './snapshotTracker';
import { parseHashRef } from '../../utils/hashRefParsers';
import { buildIntentContext, resolveIntents, isPressured } from './intents';
import { validateBatchSteps, validateBatchEnvelope } from './validateBatchSteps';
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
  return value.replace(/\\/g, '/');
}

function extractEditTargetFile(params: Record<string, unknown>): string | undefined {
  // Include the `f` alias: rebaseSubsequentSteps runs against future steps
  // BEFORE normalizeStepParams aliases `f` → `file_path`. Without this, a
  // future step using `f: "h:HASH:A-B"` (or `f: "src/foo.ts"`) would be
  // skipped by the rebase even though the handler will ultimately target
  // that file.
  const f = params.file ?? params.file_path ?? params.f;
  return typeof f === 'string' ? f : undefined;
}

/**
 * Resolve a mix of raw paths and `h:HASH[:...]` hash-refs into the set of
 * file paths that should be registered as own-writes.
 *
 * For hash-refs we try TWO resolution strategies in order:
 *   1. Match the bare hash against snapshot-tracker entries' full
 *      `snapshotHash` / `canonicalHash` (covers cite-hash inputs).
 *   2. Match against per-entry FileView retention short hashes
 *      (`computeFileViewHashParts(path, rev).shortHash`) — covers the
 *      `h:<retention>` shape the model gets from the view fence.
 * The raw input is also registered as-is for defense-in-depth. Both
 * strategies are read-only on the tracker; order-preserving dedup.
 *
 * Why this matters: `isOwnWrite(path)` is how the `canonical_revision_changed`
 * listener decides whether to skip reconcile for paths we edited ourselves.
 * If the pre-register stores only `"h:HASH:A-B"` but the watcher event
 * delivers the resolved path `"src/foo.ts"`, the lookup misses → reconcile
 * runs → view's `fullBody` gets cleared mid-batch. The post-handler
 * registration (line ~2796) is too late to cover the race window.
 */
function resolveOwnWritePaths(
  candidates: string[],
  tracker: SnapshotTracker,
): string[] {
  const out = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    out.add(raw);
    if (!raw.startsWith('h:')) continue;
    // Strip `:line` / `:A-B` / shape modifiers — only the bare hash matters.
    const body = raw.slice(2);
    const colon = body.indexOf(':');
    const bare = colon >= 0 ? body.slice(0, colon) : body;
    if (!bare) continue;
    for (const [, id] of tracker.entries()) {
      // Strategy 1: full-hash / canonical-hash match (cite-hash inputs).
      if (id.snapshotHash === bare || id.canonicalHash === bare) {
        out.add(id.filePath);
        continue;
      }
      // Strategy 2: retention-short match (FileView fence inputs).
      const rev = id.canonicalHash ?? id.snapshotHash;
      if (!rev) continue;
      try {
        const { shortHash } = computeFileViewHashParts(id.filePath, rev);
        if (shortHash === bare) out.add(id.filePath);
      } catch {
        // Malformed path/revision — ignore.
      }
    }
  }
  return [...out];
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

/** Exported for tests — positional shift contract for rebase math. */
export interface PositionalDelta {
  line: number;
  delta: number;
  /**
   * When true (insert_before / prepend), shifts targets where `line >= anchor`.
   * When false/undefined (insert_after, replace, delete, …), shifts where `line > anchor`.
   */
  lineInclusive?: boolean;
  /**
   * For `delete` edits only: number of OLD lines consumed starting at `line`.
   * FileView rebase ({@link applyEditToFileView}) drops rows / regions whose
   * coordinate falls in `[line, line + consumes - 1]` rather than shifting
   * them into a collision with a surviving neighbor. Undefined for
   * replace/insert_* — those shift coordinates but don't remove old rows.
   */
  consumes?: number;
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
      // `consumes` marks lines the edit REMOVES from the old file. Rows /
      // regions whose old coordinate falls in [line, line+consumes-1] drop
      // on rebase rather than shifting into a collision. Populated only for
      // `delete` — replace/insert_* leave it undefined so rows in the
      // target range survive with content re-derived from the new body.
      const consumes = action === 'delete' ? effectiveLineSpanCount(e) : undefined;
      deltas.push({ line: originalLine, delta: d, lineInclusive, ...(consumes ? { consumes } : {}) });
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
 *
 * When `artifact` is provided, `edits_resolved[i].resolved_line` backfills
 * any `line_edits[i].line` that's missing. This matters because the
 * `change.edit` handler injects `line` from hash-ref line anchors
 * (`f:h:HASH:N`) / top-level `params.line` only into its locally-normalized
 * `resolved.line_edits` array — the original `mergedParams.line_edits` the
 * executor sees still lacks `line`, so the rebase math silently fell back to
 * zero deltas. Without backfill, an edit like `ce f:h:X:4 le:[{action:"insert_after",content:"..."}]`
 * produces an empty delta map — the FileView can update total lines but
 * can't shift skeleton rows or filled regions, which regresses the
 * sparse-sig statefulness contract. The backend always reports the
 * resolved line in `edits_resolved` by construction; read it directly.
 */
export function buildPerFileDeltaMap(
  completedParams: Record<string, unknown>,
  artifact?: Record<string, unknown>,
): Map<string, PositionalDelta[]> {
  const map = new Map<string, PositionalDelta[]>();

  const topFile = extractEditTargetFile(completedParams);
  if (topFile && Array.isArray(completedParams.line_edits)) {
    const topResolved = artifact ? extractTopLevelEditsResolved(artifact) : undefined;
    const backfilled = backfillLinesFromResolved(
      completedParams.line_edits as unknown[],
      topResolved,
    );
    const deltas = computePositionalDeltas(backfilled);
    if (deltas.length > 0) {
      // Key by BOTH the raw source param AND the artifact's resolved path.
      // `resolveDeltasForFile` looks up by the edited file path from the
      // artifact (e.g. `fv-debug.ts`); when the request used a hash-ref
      // shape (`f: "h:ab09b8:4"`), only the hash-ref key would land without
      // this dual-keying and downstream rebase would miss. Both keys point
      // to the same array — idempotent, no double-apply risk.
      map.set(normalizePathForRebase(topFile), deltas);
      const resolvedPath = artifact ? extractTopLevelResolvedPath(artifact) : undefined;
      if (resolvedPath) {
        const resolvedKey = normalizePathForRebase(resolvedPath);
        if (!map.has(resolvedKey)) map.set(resolvedKey, deltas);
      }
    }
  }

  if (completedParams.mode === 'batch_edits' && Array.isArray(completedParams.edits)) {
    const resolvedByFile = artifact ? extractBatchEditsResolved(artifact) : undefined;
    const resolvedPathByRawKey = artifact ? extractBatchResolvedPaths(artifact) : undefined;
    for (const ed of completedParams.edits) {
      if (!ed || typeof ed !== 'object') continue;
      const entry = ed as Record<string, unknown>;
      const file = extractEditTargetFile(entry);
      if (!file || !Array.isArray(entry.line_edits)) continue;
      const key = normalizePathForRebase(file);
      const resolvedForFile = resolvedByFile?.get(key)
        ?? resolvedByFile?.get(resolvedPathByRawKey?.get(key) ?? '');
      const backfilled = backfillLinesFromResolved(
        entry.line_edits as unknown[],
        resolvedForFile,
      );
      const deltas = computePositionalDeltas(backfilled);
      if (deltas.length === 0) continue;
      const existing = map.get(key);
      if (existing) existing.push(...deltas);
      else map.set(key, deltas);
      // Also key by the resolved path so hash-ref requests route correctly.
      const resolvedPath = resolvedPathByRawKey?.get(key);
      if (resolvedPath) {
        const resolvedKey = normalizePathForRebase(resolvedPath);
        if (resolvedKey !== key && !map.has(resolvedKey)) {
          map.set(resolvedKey, deltas);
        }
      }
    }
  }

  return map;
}

/**
 * Clone each le entry and inject coordinates from `resolutions[i]` when the
 * request-level le is missing them. Fills BOTH `line` (from
 * `resolved_line`) AND, for `replace` / `replace_body` / `delete`,
 * `end_line` (from `resolved_line + lines_affected - 1`).
 *
 * Why both: `computeSingleEditNetDelta` for `replace` returns
 * `contentLines - span`, where `span = effectiveLineSpanCount(e)` reads
 * `end_line`. Without `end_line` it defaults to 1, so a replace over 5
 * pre-edit lines with 6 new lines of content shows delta=+5 instead of
 * +1 — multi-step rebase then shifts subsequent steps by the wrong
 * amount, landing them in the wrong place and corrupting the file. For
 * inserts, `end_line` is irrelevant (insert delta = contentLines), so we
 * skip backfilling there.
 */
function backfillLinesFromResolved(
  lineEdits: unknown[],
  resolutions: unknown[] | undefined,
): unknown[] {
  if (!Array.isArray(lineEdits) || lineEdits.length === 0) return [];
  if (!Array.isArray(resolutions) || resolutions.length === 0) return lineEdits.slice();
  return lineEdits.map((le, i) => {
    if (!le || typeof le !== 'object') return le;
    const e = { ...(le as Record<string, unknown>) };
    const res = resolutions[i];
    if (!res || typeof res !== 'object') return e;
    const r = res as Record<string, unknown>;
    const rl = r.resolved_line;
    const la = r.lines_affected;
    const resAction = typeof r.action === 'string' ? r.action : undefined;
    const hasExplicitLine = typeof e.line === 'number' && e.line > 0;
    const hasSymbol = e.symbol != null;

    if (!hasExplicitLine && !hasSymbol && typeof rl === 'number' && rl > 0) {
      e.line = rl;
    }

    // Backfill end_line for span-based actions (replace / replace_body /
    // delete) when it's missing AND the resolution carries
    // `lines_affected` representing the pre-edit span. Without this,
    // `effectiveLineSpanCount` falls back to 1 and the delta math for
    // replace is wrong by (span - 1), which silently shifts subsequent
    // edits in the same batch by the wrong amount.
    const action = typeof e.action === 'string'
      ? e.action
      : (resAction ?? 'replace');
    const isSpanAction = action === 'replace' || action === 'replace_body' || action === 'delete';
    const hasExplicitEnd = typeof e.end_line === 'number' && e.end_line > 0;
    if (isSpanAction && !hasExplicitEnd && typeof la === 'number' && la > 0) {
      const startLine = typeof e.line === 'number' && e.line > 0 ? e.line : rl;
      if (typeof startLine === 'number' && startLine > 0) {
        e.end_line = startLine + la - 1;
      }
    }
    return e;
  });
}

/** Extract the single-file top-level `edits_resolved` array from a draft artifact. */
function extractTopLevelEditsResolved(artifact: Record<string, unknown>): unknown[] | undefined {
  const top = artifact.edits_resolved;
  if (Array.isArray(top)) return top;
  // draft artifacts store resolutions nested: `drafts[0].edits_resolved` on single-file payloads.
  const drafts = artifact.drafts;
  if (Array.isArray(drafts) && drafts.length === 1 && drafts[0] && typeof drafts[0] === 'object') {
    const nested = (drafts[0] as Record<string, unknown>).edits_resolved;
    if (Array.isArray(nested)) return nested;
  }
  return undefined;
}

/** Build a per-file `edits_resolved` lookup for batch_edits artifacts keyed by separator-normalized path. */
function extractBatchEditsResolved(artifact: Record<string, unknown>): Map<string, unknown[]> {
  const map = new Map<string, unknown[]>();
  for (const key of ['drafts', 'batch', 'results'] as const) {
    const arr = artifact[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const file = SnapshotTracker.extractFilePath(rec);
      const resolutions = rec.edits_resolved;
      if (file && Array.isArray(resolutions)) {
        map.set(normalizePathForRebase(file), resolutions);
      }
    }
  }
  return map;
}

/**
 * Extract the resolved file path from a single-file draft artifact.
 * Handlers rewrite hash-ref inputs (`f:"h:HASH:N"`) to real paths before
 * writing — `drafts[0].file` carries the resolved path. Used to dual-key
 * the delta map so downstream lookups by edited file path find the entry
 * regardless of what the model originally passed.
 */
function extractTopLevelResolvedPath(artifact: Record<string, unknown>): string | undefined {
  const top = SnapshotTracker.extractFilePath(artifact);
  if (top) return top;
  const drafts = artifact.drafts;
  if (Array.isArray(drafts) && drafts.length >= 1 && drafts[0] && typeof drafts[0] === 'object') {
    return SnapshotTracker.extractFilePath(drafts[0] as Record<string, unknown>);
  }
  const results = artifact.results;
  if (Array.isArray(results) && results.length >= 1 && results[0] && typeof results[0] === 'object') {
    return SnapshotTracker.extractFilePath(results[0] as Record<string, unknown>);
  }
  return undefined;
}

/**
 * For batch_edits: map each input `edits[i]` raw-param key to the resolved
 * path the handler wrote to disk. The model's raw `f: "h:HASH"` key
 * doesn't match the resolved `drafts[j].file` — we bridge by matching
 * positional order where possible, falling back to identity when paths
 * are already resolved.
 */
function extractBatchResolvedPaths(artifact: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of ['drafts', 'batch', 'results'] as const) {
    const arr = artifact[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const resolved = SnapshotTracker.extractFilePath(rec);
      if (!resolved) continue;
      // For batch entries, the `edit_target_ref` (raw input) survives
      // round-trip in some backend responses; bridge raw→resolved when
      // available. Otherwise the resolved path is its own key (identity).
      const rawRef = typeof rec.edit_target_ref === 'string' ? rec.edit_target_ref : resolved;
      map.set(normalizePathForRebase(rawRef), resolved);
    }
  }
  return map;
}

/**
 * Shift a set of LineRegion boundaries by the same positional-delta math used
 * for `line_edits` rebase. Mirrors `applyDeltasToLineEdits` (inclusive vs
 * strict) so tracker read-coverage stays aligned with where code actually
 * moved. Used by the slim-ack rebase path to keep canonical-level awareness
 * across edits without forcing a re-read. Exported for tests.
 */
export function rebaseRegionsByDeltas(
  regions: LineRegion[],
  deltas: PositionalDelta[],
): LineRegion[] {
  if (regions.length === 0 || deltas.length === 0) return regions.slice();
  const out: LineRegion[] = [];
  for (const region of regions) {
    let startShift = 0;
    let endShift = 0;
    for (const d of deltas) {
      if (d.lineInclusive ? d.line <= region.start : d.line < region.start) startShift += d.delta;
      if (d.lineInclusive ? d.line <= region.end   : d.line < region.end)   endShift   += d.delta;
    }
    const start = region.start + startShift;
    const end = region.end + endShift;
    if (end >= start && start >= 1) out.push({ start, end });
  }
  return out;
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

/**
 * Shift the line-range portion of an `h:HASH:A-B` (or `h:HASH:A-B,C-D`) ref by
 * the same positional-delta math `applyDeltasToLineEdits` uses. Returns the
 * rewritten string, or the original if there's nothing to shift.
 *
 * The Rust `draft` handler treats the A-B portion of such refs as absolute
 * line numbers in the CURRENT on-disk file (see `load_draft_base_content` +
 * the `edit_target_range` path in `batch_query/mod.rs`). That means when an
 * earlier same-batch edit shifts lines, A-B must be shifted identically —
 * same invariant as `line_edits[].line/end_line`. Exported for tests.
 */
export function rebaseHashRefLineRange(value: string, deltas: PositionalDelta[]): string {
  if (deltas.length === 0 || !value.startsWith('h:')) return value;
  const parsed = parseHashRef(value);
  if (!parsed) return value;
  const { modifier } = parsed;
  if (typeof modifier !== 'object' || modifier === null) return value;
  if (!('lines' in modifier) || 'shape' in modifier) return value;
  const lines = modifier.lines as Array<[number, number | null]>;
  if (!Array.isArray(lines) || lines.length === 0) return value;

  let changed = false;
  const rebased: Array<[number, number | null]> = lines.map(([start, end]) => {
    let startShift = 0;
    let endShift = 0;
    const effectiveEnd = end ?? start;
    for (const d of deltas) {
      if (d.lineInclusive ? d.line <= start : d.line < start) startShift += d.delta;
      if (d.lineInclusive ? d.line <= effectiveEnd : d.line < effectiveEnd) endShift += d.delta;
    }
    if (startShift !== 0 || endShift !== 0) changed = true;
    const newStart = Math.max(1, start + startShift);
    const newEnd = end == null ? null : Math.max(newStart, end + endShift);
    return [newStart, newEnd];
  });
  if (!changed) return value;

  const rangeStr = rebased.map(([s, e]) => (e == null ? `${s}` : `${s}-${e}`)).join(',');
  return `h:${parsed.hash}:${rangeStr}`;
}

/**
 * Resolve the delta-map lookup key for a future step's file reference.
 * - Plain paths → normalized path key.
 * - Hash-refs (h:HASH or h:HASH:A-B) → resolved via a pre-captured
 *   hash → path alias map (or undefined if the hash isn't known).
 *
 * The alias map is captured BEFORE `recordSnapshotFromOutput` runs for the
 * just-completed edit — otherwise `invalidateAndRerecord` would have already
 * wiped the old hash, and the model's common pattern of citing the
 * pre-edit hash in a subsequent step would be un-resolvable.
 */
function resolveFileKeyForRebaseLookup(
  rawFile: string,
  hashAliases: ReadonlyMap<string, string>,
): string | undefined {
  if (!rawFile.startsWith('h:')) return normalizePathForRebase(rawFile);
  // canonicalizeSnapshotHash mirrors the same `h:<hex>:<rest>` → `<hex>` rule
  // the tracker uses, so ranges and shape modifiers don't defeat lookup.
  const stripped = rawFile.slice(2);
  const colon = stripped.indexOf(':');
  const bare = colon >= 0 ? stripped.slice(0, colon) : stripped;
  const resolved = hashAliases.get(bare);
  return resolved ? normalizePathForRebase(resolved) : undefined;
}

/** Shift hash-ref ranges on the f/file/file_path keys of a params object in place. */
function rebaseHashRefFileKeys(
  params: Record<string, unknown>,
  deltas: PositionalDelta[],
): void {
  for (const key of ['f', 'file', 'file_path'] as const) {
    const v = params[key];
    if (typeof v !== 'string') continue;
    const rebased = rebaseHashRefLineRange(v, deltas);
    if (rebased !== v) params[key] = rebased;
  }
}

/**
 * Rebase read-op hash-ref string keys (`ref`, `hash`) that may carry an A-B
 * line-range suffix. Kept separate from {@link rebaseHashRefFileKeys} because
 * change ops do not accept `ref` and read-op `hash` is canonically the hash
 * identity rather than a file locator.
 */
function rebaseReadOpHashRefKeys(
  params: Record<string, unknown>,
  deltas: PositionalDelta[],
): void {
  for (const key of ['ref', 'hash'] as const) {
    const v = params[key];
    if (typeof v !== 'string') continue;
    const rebased = rebaseHashRefLineRange(v, deltas);
    if (rebased !== v) params[key] = rebased;
  }
}

/**
 * Rebase a `lines:` range-string (e.g. `"15-50"` or `"15-50,80-120"`) by the
 * same positional-delta math used for hash-ref line-ranges and line_edits.
 * Returns the rewritten string or the original when no shift applies.
 */
export function rebaseLinesRangeString(value: string, deltas: PositionalDelta[]): string {
  if (deltas.length === 0) return value;
  let changed = false;
  const parts = value.split(',');
  const rebasedParts: string[] = [];
  for (const rawPart of parts) {
    const t = rawPart.trim();
    if (!t) { rebasedParts.push(rawPart); continue; }
    const dash = t.indexOf('-');
    if (dash < 0) {
      const n = parseInt(t, 10);
      if (!Number.isFinite(n) || n <= 0) { rebasedParts.push(rawPart); continue; }
      let shift = 0;
      for (const d of deltas) {
        if (d.lineInclusive ? d.line <= n : d.line < n) shift += d.delta;
      }
      const next = Math.max(1, n + shift);
      if (next !== n) changed = true;
      rebasedParts.push(String(next));
      continue;
    }
    const startStr = t.slice(0, dash);
    const endStr = t.slice(dash + 1);
    const start = parseInt(startStr, 10);
    if (!Number.isFinite(start) || start <= 0) { rebasedParts.push(rawPart); continue; }
    const end = endStr === '' ? null : parseInt(endStr, 10);
    if (end != null && !Number.isFinite(end)) { rebasedParts.push(rawPart); continue; }

    let startShift = 0;
    let endShift = 0;
    const effectiveEnd = end ?? start;
    for (const d of deltas) {
      if (d.lineInclusive ? d.line <= start : d.line < start) startShift += d.delta;
      if (d.lineInclusive ? d.line <= effectiveEnd : d.line < effectiveEnd) endShift += d.delta;
    }
    if (startShift === 0 && endShift === 0) { rebasedParts.push(rawPart); continue; }
    const newStart = Math.max(1, start + startShift);
    const newEnd = end == null ? null : Math.max(newStart, end + endShift);
    changed = true;
    rebasedParts.push(newEnd == null ? `${newStart}-` : `${newStart}-${newEnd}`);
  }
  return changed ? rebasedParts.join(',') : value;
}

/**
 * Apply positional deltas to a read-op future's line-range params:
 *   - `lines` (range string)
 *   - numeric `start_line` / `end_line` / `sl` / `el` (global aliases in
 *     [`paramNorm.ts`](../paramNorm.ts); rebase runs BEFORE normalization so
 *     we honor both the short and long forms).
 *
 * Hash-ref suffix on `f`/`file`/`file_path` and on read-only `ref`/`hash`
 * keys is handled by {@link rebaseHashRefFileKeys} / {@link rebaseReadOpHashRefKeys}.
 */
function rebaseReadOpLineParams(
  params: Record<string, unknown>,
  deltas: PositionalDelta[],
): void {
  if (deltas.length === 0) return;
  if (typeof params.lines === 'string') {
    const next = rebaseLinesRangeString(params.lines, deltas);
    if (next !== params.lines) params.lines = next;
  }
  for (const startKey of ['start_line', 'sl'] as const) {
    for (const endKey of startKey === 'start_line' ? ['end_line'] as const : ['el'] as const) {
      const sv = params[startKey];
      const ev = params[endKey];
      if (typeof sv !== 'number' || sv <= 0) continue;
      let startShift = 0;
      for (const d of deltas) {
        if (d.lineInclusive ? d.line <= sv : d.line < sv) startShift += d.delta;
      }
      if (startShift !== 0) params[startKey] = Math.max(1, sv + startShift);
      if (typeof ev === 'number' && ev > 0) {
        let endShift = 0;
        for (const d of deltas) {
          if (d.lineInclusive ? d.line <= ev : d.line < ev) endShift += d.delta;
        }
        if (endShift !== 0) {
          const newStart = typeof params[startKey] === 'number' ? params[startKey] as number : sv;
          params[endKey] = Math.max(newStart, ev + endShift);
        }
      }
    }
  }
}

/**
 * Read-op families whose futures participate in the widened rebase pass.
 * Kept narrow on purpose: change-ops keep the richer line_edits pipeline,
 * and other ops (search/analyze/verify/etc.) do not carry line coordinates
 * that the executor can shift without model-visible semantics changing.
 */
const READ_REBASE_OPS = new Set<string>(['read.lines', 'read.shaped']);

/** File-locator keys — touched by the existing line-range rebase path for change.edit. */
const STALE_HASH_REF_KEYS_FILE: ReadonlyArray<string> = ['f', 'file', 'file_path'];
/** Read-op identity keys — not in the line-range rebase path's key set. */
const STALE_HASH_REF_KEYS_READ: ReadonlyArray<string> = ['ref', 'hash'];

/**
 * Rewrite stale `h:OLD[:suffix]` refs on future steps to `h:NEW[:suffix]`
 * using the pre-invalidation hashAliases (OLD → path) combined with the
 * tracker's current path → newHash mapping.
 *
 * Distinct from the line-range rebase pass: this only rotates the hash
 * portion so downstream handlers can resolve it after the mutation's
 * `invalidateAndRerecord` wiped the old hash. Line math (for change.edit)
 * still runs in {@link rebaseSubsequentSteps}.
 *
 * Key filter:
 * - `all`: rewrites both file-locator keys AND read-op identity keys.
 *   Used for non-edit change ops (refactor, create, split_module, …) which
 *   do not emit line_edits, so the line-range rebase pass is a no-op and
 *   hash substitution is the only way a future `h:OLD` cite becomes valid.
 * - `readOnly`: rewrites only `ref`/`hash` read-op identity keys.
 *   Used after change.edit, where the line-range rebase pass already handles
 *   `f`/`file`/`file_path` on change.* and read.* futures (preserving the
 *   hash identity per the documented edit → edit contract).
 */
function substituteStaleFileRefs(
  stepsToRun: Array<{ id: string; use: string; with?: Record<string, unknown> }>,
  startIndex: number,
  hashAliases: ReadonlyMap<string, string>,
  tracker: SnapshotTracker,
  mode: 'all' | 'readOnly',
): void {
  if (hashAliases.size === 0) return;
  const keys = mode === 'all'
    ? [...STALE_HASH_REF_KEYS_FILE, ...STALE_HASH_REF_KEYS_READ]
    : STALE_HASH_REF_KEYS_READ;
  for (let j = startIndex; j < stepsToRun.length; j++) {
    const future = stepsToRun[j];
    if (!future.with) continue;
    substituteStaleHashRefsOnObject(future.with, hashAliases, tracker, keys);
    // Nested edits[] entries (batch_edits mode). File-locator keys only —
    // nested edits never carry `ref`/`hash` read-op keys.
    if (mode === 'all' && Array.isArray(future.with.edits)) {
      for (const ed of future.with.edits) {
        if (!ed || typeof ed !== 'object') continue;
        substituteStaleHashRefsOnObject(
          ed as Record<string, unknown>,
          hashAliases,
          tracker,
          STALE_HASH_REF_KEYS_FILE,
        );
      }
    }
  }
}

/**
 * In-place hash rotation on a single params record. Mutates `params[key]`
 * for each key in `keys` whose current value is `h:OLD[:suffix]` where OLD
 * resolves via `hashAliases` to a file the tracker now holds under a new hash.
 */
function substituteStaleHashRefsOnObject(
  params: Record<string, unknown>,
  hashAliases: ReadonlyMap<string, string>,
  tracker: SnapshotTracker,
  keys: ReadonlyArray<string>,
): void {
  for (const key of keys) {
    const v = params[key];
    if (typeof v !== 'string' || !v.startsWith('h:')) continue;
    const bare = canonicalizeSnapshotHash(v);
    if (!bare) continue;
    const path = hashAliases.get(bare);
    if (!path) continue;
    const newHash = tracker.getHash(path);
    if (!newHash || newHash === bare) continue;
    // Preserve any `:suffix` (line ranges, shape modifiers, `source`, …).
    const stripped = v.slice(2);
    const colon = stripped.indexOf(':');
    const suffix = colon >= 0 ? stripped.slice(colon) : '';
    params[key] = `h:${newHash}${suffix}`;
  }
}

function rebaseSubsequentSteps(
  completedParams: Record<string, unknown>,
  stepsToRun: Array<{ id: string; use: string; with?: Record<string, unknown> }>,
  startIndex: number,
  hashAliases: ReadonlyMap<string, string>,
  opts?: { rebaseReadOps?: boolean; artifact?: Record<string, unknown> },
): void {
  const deltaMap = buildPerFileDeltaMap(completedParams, opts?.artifact);
  if (deltaMap.size === 0) return;

  const rebaseReadOps = opts?.rebaseReadOps !== false;

  for (let j = startIndex; j < stepsToRun.length; j++) {
    const future = stepsToRun[j];
    if (!future.with) continue;

    const isChangeFuture = future.use.startsWith('change.');
    const isReadFuture = rebaseReadOps && READ_REBASE_OPS.has(future.use);
    if (!isChangeFuture && !isReadFuture) continue;

    // Rebase top-level line_edits AND any h:HASH:A-B ranges on f/file/file_path
    // when the future step targets a file we edited. Hash-ref file keys are
    // resolved to a path via the captured pre-edit hash→path aliases so the
    // lookup matches the same key `buildPerFileDeltaMap` produces.
    const futureFile = extractEditTargetFile(future.with);
    if (futureFile) {
      const lookupKey = resolveFileKeyForRebaseLookup(futureFile, hashAliases);
      const deltas = lookupKey ? deltaMap.get(lookupKey) : undefined;
      if (deltas) {
        if (isChangeFuture && Array.isArray(future.with.line_edits)) {
          applyDeltasToLineEdits(future.with.line_edits as unknown[], deltas);
        }
        rebaseHashRefFileKeys(future.with, deltas);
        if (isReadFuture) {
          rebaseReadOpHashRefKeys(future.with, deltas);
          rebaseReadOpLineParams(future.with, deltas);
        }
      }
    } else if (isReadFuture) {
      // Read futures may reference the edited file purely via ref/hash (no
      // f/file/file_path), e.g. `read.lines ref:"h:OLD:10-20"`. Try to
      // resolve via hashAliases.
      for (const key of ['ref', 'hash'] as const) {
        const v = future.with[key];
        if (typeof v !== 'string' || !v.startsWith('h:')) continue;
        const lookupKey = resolveFileKeyForRebaseLookup(v, hashAliases);
        const deltas = lookupKey ? deltaMap.get(lookupKey) : undefined;
        if (!deltas) continue;
        rebaseReadOpHashRefKeys(future.with, deltas);
        rebaseReadOpLineParams(future.with, deltas);
        break;
      }
    }

    // Rebase nested edits[] entries (batch_edits mode in a future change step)
    if (isChangeFuture && Array.isArray(future.with.edits)) {
      for (const ed of future.with.edits) {
        if (!ed || typeof ed !== 'object') continue;
        const entry = ed as Record<string, unknown>;
        const entryFile = extractEditTargetFile(entry);
        if (!entryFile) continue;
        const lookupKey = resolveFileKeyForRebaseLookup(entryFile, hashAliases);
        const deltas = lookupKey ? deltaMap.get(lookupKey) : undefined;
        if (!deltas) continue;
        if (Array.isArray(entry.line_edits)) {
          applyDeltasToLineEdits(entry.line_edits as unknown[], deltas);
        }
        rebaseHashRefFileKeys(entry, deltas);
      }
    }
  }
}

/**
 * Snapshot the tracker's hash → path mapping at this instant. Called BEFORE
 * `recordSnapshotFromOutput` runs `invalidateAndRerecord`, so the pre-edit
 * hash the model is most likely to cite in a subsequent step is still
 * resolvable. Includes both `snapshotHash` and (when present) `canonicalHash`
 * so shaped reads which produce derived hashes still resolve to the file.
 *
 * Also maps **FileView retention** short hashes (`computeFileViewHashParts(path,
 * revision).shortHash`) → path. After UHPP, fences emit that retention `h:<RET>`
 * while the tracker records cite `content_hash`; without this entry,
 * `resolveFileKeyForRebaseLookup` misses and intra-batch line rebasing skips.
 */
function captureHashAliases(tracker: SnapshotTracker): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [, id] of tracker.entries()) {
    aliases.set(id.snapshotHash, id.filePath);
    if (id.canonicalHash && id.canonicalHash !== id.snapshotHash) {
      aliases.set(id.canonicalHash, id.filePath);
    }
    const rev = id.canonicalHash ?? id.snapshotHash;
    if (rev && id.filePath) {
      try {
        const { shortHash } = computeFileViewHashParts(id.filePath, rev);
        if (shortHash) aliases.set(shortHash, id.filePath);
      } catch {
        // best-effort — malformed path/revision should not break alias capture
      }
    }
  }
  return aliases;
}

/** Pre-`invalidateAndRerecord` cite snapshot per file (normalized path → bare hash). */
function capturePathToPreMutationCite(tracker: SnapshotTracker): Map<string, string> {
  const m = new Map<string, string>();
  for (const [, id] of tracker.entries()) {
    m.set(normalizePathForRebase(id.filePath), id.snapshotHash);
  }
  return m;
}

/**
 * Rewrite `f`/`file`/`file_path` values that use a FileView **retention** short
 * hash to the pre-mutation **cite** hash (same line/shape suffix). Retention
 * ids are not registered in the Rust forward map; cite ids are. Line-range
 * rebasing (`rebaseSubsequentSteps`) still keys off the cite hash like before
 * UHPP.
 */
function rewriteFileViewRetentionRefsToCite(
  stepsToRun: Array<{ id: string; use: string; with?: Record<string, unknown> }>,
  startIndex: number,
  hashAliases: ReadonlyMap<string, string>,
  pathToPreMutationCite: ReadonlyMap<string, string>,
): void {
  const keys = ['f', 'file', 'file_path'] as const;
  const rewriteObject = (obj: Record<string, unknown>) => {
    for (const key of keys) {
      const v = obj[key];
      if (typeof v !== 'string' || !v.startsWith('h:')) continue;
      const bare = canonicalizeSnapshotHash(v);
      if (!bare) continue;
      const path = hashAliases.get(bare);
      if (!path) continue;
      const oldCite = pathToPreMutationCite.get(normalizePathForRebase(path));
      if (!oldCite || bare === oldCite) continue;
      let viewShort: string;
      try {
        viewShort = computeFileViewHashParts(path, oldCite).shortHash;
      } catch {
        continue;
      }
      if (bare !== viewShort) continue;
      const stripped = v.slice(2);
      const colon = stripped.indexOf(':');
      const suffix = colon >= 0 ? stripped.slice(colon) : '';
      obj[key] = `h:${oldCite}${suffix}`;
    }
  };

  for (let j = startIndex; j < stepsToRun.length; j++) {
    const future = stepsToRun[j];
    if (!future.with || !future.use.startsWith('change.')) continue;
    rewriteObject(future.with);
    if (Array.isArray(future.with.edits)) {
      for (const ed of future.with.edits) {
        if (ed && typeof ed === 'object') rewriteObject(ed as Record<string, unknown>);
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
 * When a content_hash looks like a FileView retention short-hash, swap it for
 * the view's current sourceRevision. This lets the model pass the single
 * `h:<RET>` from the fence into any slot (retention OR cite) and lets the
 * runtime pick the right identity. Returns the replacement hash or undefined
 * when no view matches.
 *
 * Consults each view's forwarding chain (`previousShortHashes`) in addition
 * to the current `shortHash`, so a stale retention ref the model carries
 * from a prior round (before an own-edit bumped the revision-derived short)
 * still resolves to the view's current `sourceRevision`. Matches the
 * resolution policy of `findViewByRef`: direct current-short match wins
 * before any chain hit so a brand-new view is not accidentally shadowed by
 * a historical entry.
 */
function resolveCiteFromView(
  candidate: unknown,
  ctx: HandlerContext,
): string | undefined {
  if (typeof candidate !== 'string' || !candidate) return undefined;
  const bare = candidate.startsWith('h:') ? candidate.slice(2) : candidate;
  const short = bare.split(':')[0];
  if (!short || !/^[0-9a-fA-F_]{6,16}$/.test(short)) return undefined;
  try {
    const views = ctx.store().fileViews;
    if (!views) return undefined;
    // Pass 1: direct current-short match (hot path).
    for (const view of views.values()) {
      if (view.shortHash === short
        || view.shortHash.startsWith(short)
        || short.startsWith(view.shortHash)
      ) {
        return view.sourceRevision;
      }
    }
    // Pass 2: forwarding chain. Lets stale refs from prior rounds rewrite
    // to the current sourceRevision without the model having to copy the
    // new retention short.
    for (const view of views.values()) {
      if (!view.previousShortHashes || view.previousShortHashes.length === 0) continue;
      if (matchesViewRef(view, short)) {
        return view.sourceRevision;
      }
    }
  } catch {
    // Non-fatal: fall through to tracker.
  }
  return undefined;
}

/**
 * Rewrite a hash-ref `h:<retention short>[:suffix]` to `h:<full source
 * revision>[:suffix]` when the short resolves to a live FileView. The
 * suffix (line range, shape modifier) is preserved verbatim. Returns the
 * rewritten string or the original when no view matches.
 *
 * Why this matters for preflight: `change.edit` handlers call
 * `canonicalizeContentHash` which just strips `h:` and cuts at the first
 * colon — so `h:9b8348:1-148` becomes `"9b8348"` (6 chars). Preflight
 * then compares that 6-char short against the full 16-char disk hash and
 * always mismatches, blocking the edit with "content changed — re-read
 * and retry" even though the view is fresh. Rewriting the `f` shape to
 * carry the full sourceRevision before the handler runs means
 * `canonicalizeContentHash` emits a full-length hash and the preflight
 * comparison works correctly.
 */
function rewriteHashRefViewShortToSourceRev(
  value: string,
  ctx: HandlerContext,
): string {
  if (!value.startsWith('h:')) return value;
  const body = value.slice(2);
  const colonIdx = body.indexOf(':');
  const shortPart = colonIdx >= 0 ? body.slice(0, colonIdx) : body;
  const suffix = colonIdx >= 0 ? body.slice(colonIdx) : '';
  if (!shortPart || !/^[0-9a-fA-F_]{6,16}$/.test(shortPart)) return value;
  const resolved = resolveCiteFromView(`h:${shortPart}`, ctx);
  if (!resolved || resolved === shortPart) return value;
  return `h:${resolved}${suffix}`;
}

/**
 * Auto-inject content_hash into change op params from the tracker. Also
 * resolves FileView retention hashes to the view's current source revision
 * so the model can pass the one ref the fence emits into any slot.
 * Mutates mergedParams in place.
 */
function injectSnapshotHashes(
  mergedParams: Record<string, unknown>,
  tracker: SnapshotTracker,
  ctx: HandlerContext,
): void {
  // Rewrite hash-ref file keys carrying a view retention short into the
  // view's full sourceRevision BEFORE deriveEditTargetMeta runs. Without
  // this, the handler's canonicalHash derivation keeps the 6-char short
  // and the preflight hash comparison mismatches against the 16-char disk
  // hash — spuriously blocking valid edits with "content changed".
  for (const key of ['f', 'file', 'file_path'] as const) {
    const v = mergedParams[key];
    if (typeof v === 'string' && v.startsWith('h:')) {
      const rewritten = rewriteHashRefViewShortToSourceRev(v, ctx);
      if (rewritten !== v) mergedParams[key] = rewritten;
    }
  }
  const targetFile = (mergedParams.file ?? mergedParams.file_path) as string | undefined;
  if (typeof targetFile === 'string' && !mergedParams.content_hash) {
    const trackedHash = tracker.getHash(targetFile);
    if (trackedHash) {
      mergedParams.content_hash = trackedHash;
    }
  } else if (typeof mergedParams.content_hash === 'string') {
    // Model-supplied content_hash: if it's a FileView retention hash, swap
    // to the view's current sourceRevision. One-ref-per-work-object contract.
    const resolved = resolveCiteFromView(mergedParams.content_hash, ctx);
    if (resolved && resolved !== mergedParams.content_hash) {
      mergedParams.content_hash = resolved;
    }
  }
  if (Array.isArray(mergedParams.edits)) {
    mergedParams.edits = mergedParams.edits.map((edit) => {
      if (!edit || typeof edit !== 'object') return edit;
      const entry = edit as Record<string, unknown>;
      // Same view-retention-short rewrite on nested edits[].
      for (const key of ['f', 'file', 'file_path'] as const) {
        const v = entry[key];
        if (typeof v === 'string' && v.startsWith('h:')) {
          const rewritten = rewriteHashRefViewShortToSourceRev(v, ctx);
          if (rewritten !== v) entry[key] = rewritten;
        }
      }
      const editFile = (entry.file ?? entry.file_path) as string | undefined;
      if (typeof editFile === 'string' && !entry.content_hash) {
        const trackedHash = tracker.getHash(editFile);
        if (trackedHash) {
          entry.content_hash = trackedHash;
        }
      } else if (typeof entry.content_hash === 'string') {
        const resolved = resolveCiteFromView(entry.content_hash, ctx);
        if (resolved && resolved !== entry.content_hash) {
          entry.content_hash = resolved;
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
  if (!raw.startsWith('h:')) {
    const exact = findCaseSensitiveTrackerIdentity(tracker, raw);
    if (exact) return exact.filePath;
    if (findCaseOnlyTrackerCollision(tracker, raw)) return raw;
  }
  const ch = mergedParams.content_hash ?? mergedParams.snapshot_hash;
  if (typeof ch === 'string') {
    const p = tracker.findFilePathForSnapshotHash(ch);
    if (p) return p;
  }
  if (!raw.startsWith('h:')) {
    const identity = tracker.getIdentity(raw);
    if (identity) return identity.filePath;
  }
  const fromRaw = tracker.findFilePathForSnapshotHash(raw);
  if (fromRaw) return fromRaw;
  // Tail-match fallback: the model may pass `utils/foo.ts` for a tracker
  // entry keyed at `src/utils/foo.ts`. Without this, the read-coverage
  // gate fires "target region not yet read" on a read that already
  // happened under the resolved path. Only used when the suffix is
  // unambiguous (a single tracker entry ends in the given tail).
  if (!raw.startsWith('h:')) {
    const bySuffix = tracker.resolvePathByTailSuffix(raw);
    if (bySuffix) return bySuffix;
  }
  return raw;
}

function normalizeGatePathForCaseMatch(path: string): string {
  return path.replace(/\\/g, '/');
}

function findCaseSensitiveTrackerIdentity(
  tracker: SnapshotTracker,
  filePath: string,
): ReturnType<SnapshotTracker['getIdentity']> {
  const target = normalizeGatePathForCaseMatch(filePath);
  for (const [, identity] of tracker.entries()) {
    if (normalizeGatePathForCaseMatch(identity.filePath) === target) return identity;
  }
  return undefined;
}

function findCaseOnlyTrackerCollision(
  tracker: SnapshotTracker,
  filePath: string,
): ReturnType<SnapshotTracker['getIdentity']> {
  const target = normalizeGatePathForCaseMatch(filePath);
  const targetFolded = target.toLowerCase();
  for (const [, identity] of tracker.entries()) {
    const tracked = normalizeGatePathForCaseMatch(identity.filePath);
    if (tracked !== target && tracked.toLowerCase() === targetFolded) return identity;
  }
  return undefined;
}

function trackerRegionsCover(regions: LineRegion[], target: LineRegion): boolean {
  return regions.some(r => r.start <= target.start && r.end >= target.end);
}

function hasCaseSensitiveCanonicalRead(tracker: SnapshotTracker, filePath: string): boolean {
  const identity = findCaseSensitiveTrackerIdentity(tracker, filePath);
  if (!identity) return false;
  if (identity.canonicalHash != null) return true;
  if (identity.readKind !== 'lines') return false;
  const lineCount = identity.fullFileLineCount;
  if (lineCount == null || lineCount < 1 || !identity.readRegions?.length) return false;
  return trackerRegionsCover(identity.readRegions, { start: 1, end: lineCount });
}

function hasCaseSensitiveReadCoverage(
  tracker: SnapshotTracker,
  filePath: string,
  start: number,
  end: number,
): boolean {
  const identity = findCaseSensitiveTrackerIdentity(tracker, filePath);
  if (!identity?.readRegions?.length) return false;
  return trackerRegionsCover(identity.readRegions, { start, end });
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
  batchForwardsByPath?: Map<string, string>,
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
    //
    // Crucially, populate the hash-manifest forward map here: the prior
    // canonical hash (visible in past tool-output transcripts) must
    // resolve to the new one so a later reference to `h:OLD` walks to
    // `h:NEW` transparently. Without this, the model keeps picking old
    // hashes out of its own history and hitting a stale-ref error even
    // though the runtime knows exactly where the file moved.
    const store = ctx.store();
    const sid = ctx.sessionId ?? undefined;
    const turnNumber = (() => { try { return hppGetTurn(); } catch { return 0; } })();
    const registerForward = (fp: string, newShort: string, prior?: string) => {
      if (!prior || prior === newShort) return;
      try {
        manifestRecordForwarding(prior, newShort, fp, 'same_file_prior_edit', turnNumber);
        batchForwardsByPath?.set(fp.replace(/\\/g, '/').toLowerCase(), prior);
      }
      catch (e) { console.warn('[executor] recordForwarding failed:', e); }
    };
    const sources = [artifact.results, artifact.drafts, artifact.batch];
    for (const arr of sources) {
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const fp = SnapshotTracker.extractFilePath(rec);
        const sh = SnapshotTracker.extractHash(rec);
        if (fp && sh) {
          const { priorShortHash } = snapshotTracker.invalidateAndRerecord(fp, sh);
          registerForward(fp, canonicalizeSnapshotHash(sh), priorShortHash);
          store.recordRevisionAdvance(fp, sh, 'same_file_prior_edit', sid);
        }
      }
    }
    // Also check top-level file+hash
    const topFp = SnapshotTracker.extractFilePath(artifact);
    const topSh = SnapshotTracker.extractHash(artifact);
    if (topFp && topSh) {
      const { priorShortHash } = snapshotTracker.invalidateAndRerecord(topFp, topSh);
      registerForward(topFp, canonicalizeSnapshotHash(topSh), priorShortHash);
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
 * Post-edit context refresh — resolve fresh content from the new hash and
 * splice it deterministically into the FileView.
 *
 * Every `change.edit` reports per-edit coordinates (`edits_resolved[]`) and
 * the executor already computes `PositionalDelta[]` from the request's
 * `line_edits` (see `buildPerFileDeltaMap`). Combined with
 * `resolve_hash_ref('h:<newHash>')` giving us the authoritative post-edit
 * body, there is no reason to route the view through a reconcile→clear-
 * fullBody→applyFullBodyFromChunk→re-slice dance — we have exact inputs,
 * apply them exactly.
 *
 * Pipeline:
 *
 *   1. `addChunk(newHash)` installs the new content as the latest file-
 *      backed chunk. Hash forwarding auto-compacts the old chunk.
 *   2. `reconcileSourceRevision(..., { skipViewReconcile: true, … })`
 *      reconciles chunks + staged snippets only — the FileView is handled
 *      in step 3 with authoritative bytes. Skipping the view reconcile
 *      removes a transient "cleared fullBody" state that could leak into
 *      a render if the refresh observer fires at the wrong moment.
 *   3. `applyEditToFileView(…)` splices the view in one pass: skeleton
 *      rows re-derive from `newBody` at rebased coordinates, filled
 *      regions rebase + refill, and `fullBody` (when the view had one)
 *      updates to `newBody`. The view stays in the same shape the
 *      reader chose — slice views stay slice, full views stay full.
 *   4. Staged snippets re-resolve from the new hash.
 *
 * Net effect: next round's `## FILE VIEWS` block shows the updated file
 * at the correct coordinates with authoritative post-edit content. No
 * re-read needed. `markEngramsSuspect` is the only fallback when
 * `resolve_hash_ref` fails.
 */
async function refreshContextAfterEdit(
  artifact: Record<string, unknown>,
  ctx: HandlerContext,
  opts?: { deltaMap?: ReadonlyMap<string, PositionalDelta[]> },
): Promise<void> {
  const editedFiles = collectEditedFiles(artifact);
  if (editedFiles.length === 0) return;

  const store = ctx.store();
  const currentRound = (() => {
    try { return useRoundHistoryStore.getState().snapshots.length; } catch { return 0; }
  })();

  for (const ef of editedFiles) {
    const bareHash = ef.newHash.replace(/^h:/, '');

    // Per-anchor shifts introduced by this edit. `buildPerFileDeltaMap`
    // keys on `normalizePathForRebase`; monorepo layouts can pass raw or
    // lowercased paths, so try each. Empty array is a valid no-op — means
    // the edit didn't shift lines (e.g. single-line replace).
    const deltas = opts?.deltaMap
      ? (resolveDeltasForFile(opts.deltaMap, ef.filePath) ?? [])
      : [];

    try {
      const resolved = await invoke<{ content: string; source?: string | null }>(
        'resolve_hash_ref', { rawRef: `h:${bareHash}` },
      );
      if (resolved?.content) {
        // 1. Install the new chunk as the latest file-backed content.
        store.addChunk(resolved.content, 'file', ef.filePath,
          undefined, undefined, bareHash, {
            sourceRevision: bareHash,
            origin: 'edit-refresh',
            viewKind: 'latest',
          });

        // 2. Reconcile chunks + staged snippets only. The view is handled
        //    below with authoritative bytes; skipping the view reconcile
        //    avoids the transient fullBody-cleared state.
        try {
          store.reconcileSourceRevision(
            ef.filePath,
            bareHash,
            'same_file_prior_edit',
            { postEditResolved: true, skipViewReconcile: true },
          );
        } catch (e) {
          console.warn('[executor] post-edit chunk reconcile failed:', e);
        }

        // 3. Deterministic FileView refresh: splice skeleton + regions +
        //    fullBody using the per-anchor deltas and the new body bytes.
        //    For newly created files (no prior view), create one and fill it.
        try {
          const didUpdate = store.applyEditToFileView({
            filePath: ef.filePath,
            sourceRevision: bareHash,
            newBody: resolved.content,
            deltas,
            round: currentRound,
          });
          if (!didUpdate) {
            store.ensureFileView(ef.filePath, bareHash);
            store.applyFullBodyFromChunk({
              filePath: ef.filePath,
              sourceRevision: bareHash,
              content: resolved.content,
              chunkHash: bareHash,
              totalLines: resolved.content.split('\n').length,
            });
          }
        } catch (e) {
          console.warn('[executor] FileView edit refresh failed:', e);
        }
      }
    } catch (e) {
      console.warn('[executor] engram refresh failed, marking suspect:', e);
      if (hasEngramForSource(ctx, ef.filePath)) {
        store.markEngramsSuspect([ef.filePath], 'same_file_prior_edit' as 'unknown', 'content');
      }
    }

    // 4. Refresh staged snippets from the new hash.
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

/**
 * Look up positional deltas for a specific file in the batch's per-file
 * delta map. `buildPerFileDeltaMap` keys on separator-normalized paths;
 * try that normalized spelling first, then the raw path. Do not lowercase
 * as a fallback: ATLS path resolution is case-sensitive, so `Src/A.ts`
 * and `src/a.ts` must not share positional deltas.
 */
function resolveDeltasForFile(
  deltaMap: ReadonlyMap<string, PositionalDelta[]>,
  filePath: string,
): PositionalDelta[] | undefined {
  const norm = normalizePathForRebase(filePath);
  return deltaMap.get(norm)
    ?? deltaMap.get(filePath)
    ?? undefined;
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

// ---------------------------------------------------------------------------
// Auto-persist intra-batch refs
// ---------------------------------------------------------------------------

/**
 * Recursively walk a value and collect any `h:<short>` substrings whose base
 * hash appears in `producedBaseHashes`. Used to detect later-step references
 * to this step's output refs inside `with` params.
 */
function scanValueForProducedHashes(
  v: unknown,
  producedBaseHashes: ReadonlySet<string>,
  out: Set<string>,
  depth: number = 0,
): void {
  if (depth > 8) return; // Cycle / deep-object guard.
  if (typeof v === 'string') {
    const re = /h:([0-9a-fA-F_]{6,16})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v)) !== null) {
      const base = m[1].toLowerCase();
      if (producedBaseHashes.has(base)) out.add(`h:${m[1]}`);
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) scanValueForProducedHashes(item, producedBaseHashes, out, depth + 1);
    return;
  }
  if (v && typeof v === 'object') {
    for (const val of Object.values(v)) scanValueForProducedHashes(val, producedBaseHashes, out, depth + 1);
  }
}

/**
 * Pin refs from the producing step when any later step consumes them via
 * `in:` binding, named binding, literal ref, or `h:<short>` substring in
 * `with` values. Ensures the state machine handles intra-batch persistence
 * — the model never needs an explicit `pi` for refs used within the same
 * batch. Cross-round persistence still requires `pi` / `bw`.
 *
 * Idempotent: `pinChunks` no-ops on already-pinned refs. Skips retention
 * ops (they manipulate refs, don't produce new persistable ones). Skips
 * when the producing step has no refs.
 */
function autoPersistIntraBatch(
  producingStep: { id: string; use: string; out?: string | string[] },
  outputRefs: readonly string[],
  futureSteps: readonly Step[],
  namedBindings: ReadonlyMap<string, StepOutput>,
  ctx: HandlerContext,
): void {
  if (outputRefs.length === 0) return;
  // Retention ops (session.pin/unpin/drop/etc.) either explicitly pin or
  // explicitly release — their output refs are not "new work state" to
  // auto-persist.
  if (producingStep.use.startsWith('session.')) return;

  const producingId = producingStep.id;
  const producedBaseHashes = new Set<string>();
  for (const r of outputRefs) {
    if (typeof r !== 'string' || !r.startsWith('h:')) continue;
    const base = r.slice(2).split(':')[0];
    if (base) producedBaseHashes.add(base.toLowerCase());
  }
  if (producedBaseHashes.size === 0) return;

  // Named bindings that point at this step's output.
  const boundNames = new Set<string>();
  if (producingStep.out) {
    const names = Array.isArray(producingStep.out) ? producingStep.out : [producingStep.out];
    for (const n of names) boundNames.add(n);
  }
  // Also include names that `namedBindings` already associates with this
  // step's output (covers request-level `refs[]` pre-registration where the
  // name maps to a synthetic StepOutput carrying one of our hashes).
  for (const [name, out] of namedBindings) {
    for (const r of out.refs) {
      const base = r.replace(/^h:/, '').split(':')[0];
      if (base && producedBaseHashes.has(base.toLowerCase())) boundNames.add(name);
    }
  }

  const refsToPin = new Set<string>();

  for (const futureStep of futureSteps) {
    if (futureStep.in) {
      for (const expr of Object.values(futureStep.in)) {
        if ('from_step' in expr && expr.from_step === producingId) {
          for (const r of outputRefs) refsToPin.add(r);
        } else if ('bind' in expr && boundNames.has(expr.bind)) {
          for (const r of outputRefs) refsToPin.add(r);
        } else if ('ref' in expr && typeof expr.ref === 'string') {
          const base = expr.ref.replace(/^h:/, '').split(':')[0];
          if (base && producedBaseHashes.has(base.toLowerCase())) refsToPin.add(expr.ref);
        }
      }
    }
    if (futureStep.with) {
      scanValueForProducedHashes(futureStep.with, producedBaseHashes, refsToPin);
    }
  }

  if (refsToPin.size === 0) return;

  // Strip line-range / shape modifiers before pinning — pin is on the base
  // identity, not the slice. Retention auto-follows slice refs via `findChunkByRef`.
  const baseRefs = new Set<string>();
  for (const r of refsToPin) {
    const m = r.match(/^h:([0-9a-fA-F_]{6,16})/);
    if (m) baseRefs.add(`h:${m[1]}`);
  }

  try {
    ctx.store().pinChunks([...baseRefs]);
  } catch (e) {
    console.warn('[executor] auto-persist intra-batch failed:', e);
  }
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

  // Envelope validation (runs before step-level validation): rejects
  // stubbed/compressed shells (post-hoc history-compression artifacts the
  // model may template-calcify) and empty envelopes with neither `steps`
  // nor `q`. See validateBatchEnvelope for rationale.
  const envelopeValidation = validateBatchEnvelope(
    request as unknown as Record<string, unknown>,
  );
  if (!envelopeValidation.ok) {
    const msg = `batch: ERROR ${envelopeValidation.error}`;
    return {
      ok: false,
      summary: msg,
      step_results: [
        {
          id: '__batch_envelope__',
          use: 'session.stats',
          ok: false,
          error: envelopeValidation.error,
          summary: msg,
          duration_ms: 0,
        },
      ],
      duration_ms: Date.now() - batchStart,
    };
  }

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
  const batchForwardsByPath = new Map<string, string>();

  // Slim-ack rebase toggle: when true, after a successful change.edit we
  // rebase tracker readRegions + fullFileLineCount by the same positional
  // deltas the executor already uses for line_edits rebase, and end-of-batch
  // awareness flush preserves those rebased regions (instead of wiping).
  // Default false — preserves today's diff-only protocol.
  const slimAckEnabled = (() => {
    try { return useAppStore.getState().settings.compressEditAcks === true; }
    catch { return false; }
  })();

  // Widened-rebase toggle (P0): when true (default), capture hash aliases
  // for every successful change.* step and rebase read.lines / read.shaped
  // futures in the same batch. When false, legacy behavior — alias capture
  // + rebase only fire for change.edit → change.* chains.
  const rebaseAllChangeOps = (() => {
    try { return useAppStore.getState().settings.rebaseAllChangeOps !== false; }
    catch { return true; }
  })();

  // Batch read-spin WARN/NUDGE surface toggle. When false, the read-spin
  // counters in contextStore still advance (so state stays consistent if the
  // user re-enables the toggle) but no `<<WARN:`/`<<NUDGE:` string is
  // surfaced in the batch summary. Controlled via
  // `settings.messageToggles.batchReadSpinWarn`.
  const batchReadSpinWarnEnabled = (() => {
    try { return useAppStore.getState().settings.messageToggles.batchReadSpinWarn !== false; }
    catch { return true; }
  })();

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
        summary: `${step.use}: not available to subagents`,
        error: 'not available to subagents',
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
        summary: `${step.id}: ${step.use} unavailable in read-only mode`,
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
      const claimNorm = new Set(ctx.fileClaims.map(f => normalizePathForRebase(f)));
      if (targetFile && !targetFile.startsWith('h:') && !claimNorm.has(normalizePathForRebase(targetFile))) {
        const output: StepOutput = {
          kind: 'raw', ok: false, refs: [],
          summary: `${step.id}: ${step.use} rejected — path "${targetFile}" outside this agent's scope [${ctx.fileClaims.join(', ')}]`,
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

    // Auto-inject content_hash + rewrite FileView retention shorts on
    // change ops. The tracker-size gate used to skip this path entirely
    // when the tracker was empty, but the view-retention-short rewrite
    // needs to run even without tracker entries (pure rf-then-edit flow
    // can populate a FileView without a canonical tracker read record).
    // Internal branches already no-op when their particular input is
    // absent, so running unconditionally here is safe.
    if (step.use.startsWith('change.')) {
      injectSnapshotHashes(mergedParams, snapshotTracker, ctx);
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
        !hasCaseSensitiveCanonicalRead(snapshotTracker, gatePath) &&
        !batchEditedPaths.has(gateFileRaw) &&
        !batchEditedPaths.has(gatePath)
      ) {
        for (const le of gateLineEdits) {
          const line = le.line;
          const endLine = (le.end_line ?? le.line);
          if (typeof line !== 'number' || line <= 0) continue;
          const end = typeof endLine === 'number' ? endLine : line;
          if (!hasCaseSensitiveReadCoverage(snapshotTracker, gatePath, line, end)) {
            const output: StepOutput = {
              kind: 'edit_result', ok: false, refs: [],
              summary: `${step.id}: target region not yet read — read lines ${line}-${end} of ${gatePath} first, then retry.`,
              error: `target region not yet read — read lines ${line}-${end} first`,
              content: { file: gatePath, line, end_line: end, _next: 'read.lines for the target region, then retry', _internal: { error_class: 'edit_outside_read_range' } },
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

    // G22: pre-register own writes before handler invocation to close the
    // watcher TOCTOU gap. The Rust backend emits `canonical_revision_changed`
    // during the edit command; its TS listener runs `isOwnWrite(path)` to
    // skip reconcile for paths we edited ourselves. Without pre-registration
    // the event can land BEFORE the post-handler `registerOwnWrite` below,
    // causing the listener to reconcile the file — which clears `fullBody`
    // on the FileView and defeats the statefulness contract even for
    // successful edits.
    //
    // extractEditTargetFile returns the raw source param (e.g.
    // `"h:HASH:A-B"` for hash-ref inputs). That raw string doesn't match
    // the path Rust emits in the event, so we resolve hash-refs to their
    // actual file path via the snapshot tracker before registering. Both
    // forms get registered for defense-in-depth — the post-handler
    // registration on line ~2796 will re-register using the artifact's
    // resolved path if anything was missed.
    if (step.use.startsWith('change.')) {
      const preTargetFile = extractEditTargetFile(mergedParams);
      if (preTargetFile) {
        registerOwnWrite(resolveOwnWritePaths([preTargetFile], snapshotTracker));
      }
      if (Array.isArray(mergedParams.edits)) {
        const preTargets = (mergedParams.edits as Array<Record<string, unknown>>)
          .map(e => extractEditTargetFile(e)).filter((f): f is string => !!f);
        if (preTargets.length > 0) {
          registerOwnWrite(resolveOwnWritePaths(preTargets, snapshotTracker));
        }
      }
    }

    // Slim-ack rebase path: capture pre-edit tracker regions for files this
    // change.edit step will touch so that after the handler wipes the tracker
    // via invalidateAndRerecord we can replay rebased regions back in.
    // Keyed by normalizePathForRebase so buildPerFileDeltaMap lookups align.
    let preEditTrackerRegions: Map<string, { file: string; regions: LineRegion[]; lineCount?: number; shapeHash?: string }> | undefined;
    if (slimAckEnabled && step.use === 'change.edit') {
      preEditTrackerRegions = new Map();
      const collect = (f: string | undefined) => {
        if (!f || f.startsWith('h:')) return;
        const id = snapshotTracker.getIdentity(f);
        if (!id) return;
        if ((id.readRegions?.length ?? 0) === 0 && id.fullFileLineCount == null) return;
        const key = normalizePathForRebase(f);
        if (preEditTrackerRegions!.has(key)) return;
        preEditTrackerRegions!.set(key, {
          file: id.filePath,
          regions: (id.readRegions ?? []).slice(),
          lineCount: id.fullFileLineCount,
          shapeHash: id.shapeHash,
        });
      };
      collect(extractEditTargetFile(mergedParams));
      if (Array.isArray(mergedParams.edits)) {
        for (const e of mergedParams.edits) {
          if (e && typeof e === 'object') collect(extractEditTargetFile(e as Record<string, unknown>));
        }
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

    // Capture pre-edit hash→path aliases for rebaseSubsequentSteps. Must
    // happen BEFORE recordSnapshotFromOutput's invalidateAndRerecord wipes
    // the old hash; otherwise a future step citing h:OLD:A-B on the same
    // file can't be resolved for rebase.
    //
    // P0.1: gated on `rebaseAllChangeOps`, capture for any successful
    // change.* step (not just change.edit). change.refactor / change.create /
    // change.split_module also trigger invalidateAndRerecord in
    // recordSnapshotFromOutput below, so their old hashes need the same
    // pre-invalidation alias snapshot for downstream rebase.
    const shouldCaptureAliases = output.ok && (
      rebaseAllChangeOps
        ? step.use.startsWith('change.')
        : step.use === 'change.edit'
    );
    const hashAliasesForRebase: ReadonlyMap<string, string> =
      shouldCaptureAliases ? captureHashAliases(snapshotTracker) : new Map();
    const pathToPreMutationCite: ReadonlyMap<string, string> =
      shouldCaptureAliases ? capturePathToPreMutationCite(snapshotTracker) : new Map();

    // Record snapshot hashes from step output
    recordSnapshotFromOutput(step, output, snapshotTracker, ctx, policy, batchForwardsByPath);

    // Post-edit housekeeping for successful change ops
    if (output.ok && step.use.startsWith('change.')) {
      // P0.1: After the tracker rotates hashes via invalidateAndRerecord,
      // rewrite stale `h:OLD` cites on future steps.
      //
      //   - change.edit (`readOnly`): only read-op identity keys `ref`/`hash`
      //     are rewritten; the existing rebaseSubsequentSteps pass handles
      //     `f`/`file`/`file_path` by shifting line ranges while preserving
      //     the hash identity (the documented edit → edit contract).
      //   - change.refactor / change.create / change.split_module (`all`):
      //     these ops do not emit line_edits, so the rebase pass is a no-op
      //     and hash substitution is the only way a future `h:OLD` cite
      //     becomes resolvable after the mutation.
      if (rebaseAllChangeOps && hashAliasesForRebase.size > 0) {
        substituteStaleFileRefs(
          stepsToRun,
          i + 1,
          hashAliasesForRebase,
          snapshotTracker,
          step.use === 'change.edit' ? 'readOnly' : 'all',
        );
      }
      // Rebase line numbers in subsequent same-file change steps. The
      // line_edits + resolved-body-span pipeline is change.edit-specific;
      // other change ops only need the hash-alias + read-op rebase pass.
      //
      // `postEditDeltaMap` is hoisted out of the change.edit branch so the
      // FileView refresh below can consume it. Non-change.edit ops don't
      // emit line_edits, so the map is empty for them — passing an empty
      // map is a no-op at the reconcile site.
      let postEditDeltaMap: Map<string, PositionalDelta[]> | undefined;
      if (step.use === 'change.edit') {
        if (hashAliasesForRebase.size > 0 && pathToPreMutationCite.size > 0) {
          rewriteFileViewRetentionRefsToCite(
            stepsToRun,
            i + 1,
            hashAliasesForRebase,
            pathToPreMutationCite,
          );
        }
        backfillResolvedBodySpans(mergedParams, output);
        const artifactForDeltas = (output.content && typeof output.content === 'object' && !Array.isArray(output.content))
          ? output.content as Record<string, unknown>
          : undefined;
        rebaseSubsequentSteps(mergedParams, stepsToRun, i + 1, hashAliasesForRebase, {
          rebaseReadOps: rebaseAllChangeOps,
          artifact: artifactForDeltas,
        });
        // G3: rebase staged snippet line ranges as fallback before re-resolve
        postEditDeltaMap = buildPerFileDeltaMap(mergedParams, artifactForDeltas);
        for (const [normPath, deltas] of postEditDeltaMap) {
          const netDelta = deltas.reduce((sum, d) => sum + d.delta, 0);
          if (netDelta !== 0) ctx.store().rebaseStagedLineNumbers(normPath, netDelta);
        }
        // Slim-ack: replay rebased tracker regions. recordSnapshotFromOutput
        // just ran invalidateAndRerecord which wiped readRegions; shift the
        // captured pre-edit regions by the same deltas used for line_edits /
        // staged snippet rebase and write them back. Keeps canonical awareness
        // across edits — the model doesn't need a fresh read.lines if FileView
        // already carries the post-edit content at these coordinates.
        if (slimAckEnabled && preEditTrackerRegions && preEditTrackerRegions.size > 0) {
          for (const [normPath, deltas] of postEditDeltaMap) {
            const pre = preEditTrackerRegions.get(normPath);
            if (!pre) continue;
            const rebasedRegions = rebaseRegionsByDeltas(pre.regions, deltas);
            const netDelta = deltas.reduce((sum, d) => sum + d.delta, 0);
            const newLineCount = pre.lineCount != null
              ? Math.max(0, pre.lineCount + netDelta)
              : undefined;
            snapshotTracker.setReadRegions(pre.file, rebasedRegions, newLineCount, pre.shapeHash);
          }
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
      // Refresh engram/snippet content with real post-edit content (awaited
      // for correctness). Pass `postEditDeltaMap` so FileView region rebase
      // uses per-position precision — regions above an edit anchor stay
      // put, regions below shift by the net delta at that anchor. Without
      // this, a single scalar `freshnessJournal.lineDelta` applies
      // uniformly to every region, which corrupts slice views for edits
      // that only shift part of the file.
      if (output.content && typeof output.content === 'object' && !Array.isArray(output.content)) {
        await refreshContextAfterEdit(
          output.content as Record<string, unknown>,
          ctx,
          postEditDeltaMap ? { deltaMap: postEditDeltaMap } : undefined,
        ).catch(e => console.warn('[executor] content refresh error:', e));
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

    // Auto-persist intra-batch: scan later steps for consumers of this step's
    // output refs and pin matching refs so they survive past round-end. The
    // state machine handles intra-batch persistence; the model only needs
    // explicit `pi` / `bw` for cross-round retention.
    if (output.ok && output.refs.length > 0) {
      autoPersistIntraBatch(
        step,
        output.refs,
        stepsToRun.slice(i + 1),
        namedBindings,
        ctx,
      );
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
        // Counters advance regardless; only the user-facing WARN/NUDGE string is gated.
        if (br && batchReadSpinWarnEnabled) spinBreaker = br;
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

    if (output.ok && step.use === 'change.rollback') {
      try {
        const rbWith = mergedParams as Record<string, unknown>;
        const rbRestore = rbWith.restore as Array<{ file?: string; hash?: string }> | undefined;
        if (Array.isArray(rbRestore)) {
          for (const entry of rbRestore) {
            const fp = typeof entry?.file === 'string' ? entry.file : undefined;
            const hash = typeof entry?.hash === 'string' ? entry.hash.replace(/^h:/, '') : undefined;
            if (fp && hash) {
              snapshotTracker.invalidateAndRerecord(fp, hash);
              const normKey = fp.replace(/\\/g, '/').toLowerCase();
              const priorShort = batchForwardsByPath.get(normKey);
              if (priorShort) {
                manifestClearForward(priorShort);
                batchForwardsByPath.delete(normKey);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[executor] rollback tracker/manifest sync failed:', e);
      }
    }

    if (!isAutoStep) userStepIndex += 1;
    const stepArtifact = getArtifact(output);
    const shouldTreatBlockedSystemExecAsNonFatal =
      stepArtifact !== null && isBlockingSystemExec(step.use, stepArtifact);
    // Track consecutive dry-run previews — warn in summary only (no step blocking)
    if (output.ok && step.use.startsWith('change.') && isDryRunPreview(output)) {
      dryRunPreviewCount += 1;
      if (dryRunPreviewCount >= 2 && batchReadSpinWarnEnabled) {
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
  // Default (diff-only protocol): edited files get downgraded awareness
  // (no readRegions) so the next batch requires a fresh read.lines before
  // further edits.
  // Slim-ack mode (compressEditAcks): preserve the tracker's rebased regions
  // + line count so canonical awareness carries across batches — FileView
  // already holds the post-edit content at those coordinates.
  for (const [, identity] of snapshotTracker.entries()) {
    const wasEditedInBatch = batchEditedPaths.has(identity.filePath);
    const preserveAfterEdit = wasEditedInBatch && slimAckEnabled;
    ctx.store().setAwareness({
      filePath: identity.filePath,
      snapshotHash: identity.snapshotHash,
      level: (wasEditedInBatch && !preserveAfterEdit)
        ? AwarenessLevel.NONE
        : snapshotTracker.getAwarenessLevel(identity.filePath),
      readRegions: (wasEditedInBatch && !preserveAfterEdit) ? [] : (identity.readRegions ?? []),
      shapeHash: (wasEditedInBatch && !preserveAfterEdit) ? undefined : identity.shapeHash,
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
