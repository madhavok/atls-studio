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
  BatchInterruption,
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
import { useRetentionStore } from '../../stores/retentionStore';
import { useAppStore } from '../../stores/appStore';
import { invoke } from '@tauri-apps/api/core';
import { getFreshnessJournal } from '../freshnessJournal';
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
  const count = typeof e.count === 'number' && Number.isFinite(e.count) ? e.count : 1;
  return count;
}

function computeSingleEditNetDelta(e: Record<string, unknown>): number {
  const action = typeof e.action === 'string' ? e.action : '';
  const span = effectiveLineSpanCount(e);
  const contentLines = typeof e.content === 'string' && e.content.length > 0
    ? countContentLines(e.content as string)
    : 0;
  if (action === 'insert_before' || action === 'insert_after' || action === 'prepend' || action === 'append') {
    return contentLines;
  }
  if (action === 'delete') return -span;
  if (action === 'replace') return contentLines - span;
  // replace_body/move and unknown actions: delta not modeled here (same as legacy computePositionalDeltas)
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
    const line = snapshotLineForRebase(e);
    const d = computeSingleEditNetDelta(e);
    const originalLine = line > 0 ? line - cumulativeDelta : 0;
    if (d !== 0 && originalLine > 0) deltas.push({ line: originalLine, delta: d });
    cumulativeDelta += d;
  }
  return deltas;
}

function estimateLineDeltaFromEdits(lineEdits: unknown): number {
  return computePositionalDeltas(lineEdits).reduce((sum, d) => sum + d.delta, 0);
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
 * of net deltas from prior edits j<i whose snapshot line is strictly before this entry's snapshot
 * line (same rule as `rebaseSubsequentSteps`). Mutates `line_edits` in place. Skips symbol-only entries.
 */
function rebaseIntraStepSnapshotLineEdits(lineEdits: unknown[]): void {
  if (lineEdits.length < 2) return;
  const snapshotLines: number[] = lineEdits.map((edit) => {
    if (!edit || typeof edit !== 'object') return 0;
    const o = edit as Record<string, unknown>;
    const line = snapshotLineForRebase(o);
    const hasSymbol = o.symbol != null && typeof o.symbol === 'string';
    if (line > 0 && !hasSymbol) return line;
    return 0;
  });
  for (let i = 1; i < lineEdits.length; i++) {
    const targetSnap = snapshotLines[i];
    if (targetSnap <= 0) continue;
    let shift = 0;
    for (let j = 0; j < i; j++) {
      const origJ = snapshotLines[j];
      if (origJ <= 0) continue;
      const d = computeSingleEditNetDelta(lineEdits[j] as Record<string, unknown>);
      if (origJ < targetSnap) shift += d;
    }
    const o = lineEdits[i] as Record<string, unknown>;
    const hasSymbol = o.symbol != null && typeof o.symbol === 'string';
    const snap = snapshotLineForRebase(o);
    if (snap > 0 && !hasSymbol) {
      o.line = targetSnap + shift;
    }
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

function rebaseSubsequentSteps(
  completedParams: Record<string, unknown>,
  stepsToRun: Array<{ id: string; use: string; with?: Record<string, unknown> }>,
  startIndex: number,
): void {
  const editedFile = extractEditTargetFile(completedParams);
  if (!editedFile) return;
  const editedKey = normalizePathForRebase(editedFile);

  const deltas = Array.isArray(completedParams.line_edits)
    ? computePositionalDeltas(completedParams.line_edits)
    : [];
  if (deltas.length === 0) return;

  for (let j = startIndex; j < stepsToRun.length; j++) {
    const future = stepsToRun[j];
    if (!future.use.startsWith('change.') || !future.with) continue;
    const futureFile = extractEditTargetFile(future.with);
    if (!futureFile || normalizePathForRebase(futureFile) !== editedKey) continue;

    const futureEdits = future.with.line_edits;
    if (!Array.isArray(futureEdits)) continue;
    for (const le of futureEdits) {
      if (!le || typeof le !== 'object') continue;
      const entry = le as Record<string, unknown>;
      if (typeof entry.line === 'number' && entry.line > 0 && !entry.symbol) {
        const targetLine = entry.line as number;
        let shift = 0;
        for (const d of deltas) {
          // BUG5 FIX: Only apply delta if the completed edit started strictly before
          // the future edit's target line. Edits at the same line or after don't shift it.
          if (d.line < targetLine) shift += d.delta;
        }
        if (shift !== 0) entry.line = targetLine + shift;
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
    // After a mutation, invalidate old hashes and record new ones
    const sources = [artifact.results, artifact.drafts, artifact.batch];
    for (const arr of sources) {
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const fp = SnapshotTracker.extractFilePath(rec);
        const sh = SnapshotTracker.extractHash(rec);
        if (fp && sh) snapshotTracker.invalidateAndRerecord(fp, sh);
      }
    }
    // Also check top-level file+hash
    const topFp = SnapshotTracker.extractFilePath(artifact);
    const topSh = SnapshotTracker.extractHash(artifact);
    if (topFp && topSh) snapshotTracker.invalidateAndRerecord(topFp, topSh);
  } else {
    // Extended recording: extract readRegions from read.lines, shapeHash from read.shaped
    if (step.use === 'read.lines') {
      const rlFile = artifact.file as string | undefined;
      const rlActualRange = artifact.actual_range as Array<[number, number | null]> | undefined;
      const rlHash = SnapshotTracker.extractHash(artifact);
      if (rlFile && rlHash && Array.isArray(rlActualRange)) {
        for (const range of rlActualRange) {
          const start = range[0];
          const end = range[1] ?? start;
          if (typeof start === 'number' && typeof end === 'number') {
            snapshotTracker.record(rlFile, rlHash, 'lines', { readRegion: { start, end } });
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
 * After a change step, refresh engram and snippet content so the context
 * window reflects the post-edit file state. Resolves h:NEW from the hash
 * registry (content already indexed after the write) and replaces content
 * in-place. Hash forwarding in addChunk compacts the old engram.
 */
async function refreshContextAfterEdit(
  artifact: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<void> {
  const editedFiles = collectEditedFiles(artifact);
  if (editedFiles.length === 0) return;

  const store = ctx.store();

  // Partition: files with full-file engrams vs snippet-only
  const fullFileRefs: string[] = [];
  const fullFileMap = new Map<string, { filePath: string; newHash: string }>();
  const snippetFiles: Array<{ filePath: string; newHash: string }> = [];

  for (const ef of editedFiles) {
    if (hasEngramForSource(ctx, ef.filePath)) {
      const ref = ef.newHash.startsWith('h:') ? ef.newHash : `h:${ef.newHash}`;
      fullFileRefs.push(ref);
      fullFileMap.set(ref, ef);
    }
    const snippets = store.getStagedSnippetsForRefresh(ef.filePath);
    if (snippets.length > 0) {
      snippetFiles.push(ef);
    }
  }

  // 1. Full-file engram refresh via batch resolve (single IPC)
  if (fullFileRefs.length > 0) {
    try {
      const resolved = await invoke<Array<BatchResolvedEntry | null>>('batch_resolve_hash_refs', { refs: fullFileRefs });
      for (let i = 0; i < fullFileRefs.length; i++) {
        const entry = resolved[i];
        const ef = fullFileMap.get(fullFileRefs[i]);
        if (!ef) continue;
        if (!entry?.content) {
          store.markEngramsSuspect([ef.filePath], 'same_file_prior_edit' as 'unknown', 'content');
          continue;
        }
        store.addChunk(entry.content, 'smart', ef.filePath, undefined, undefined, undefined, {
          sourceRevision: ef.newHash.replace(/^h:/, ''),
          origin: 'edit-refresh',
        });
      }
    } catch (e) {
      console.warn('[executor] full-file content refresh failed:', e);
    }
  }

  // 2. Line-range snippet refresh + 3. Shaped snippet re-derive
  for (const ef of snippetFiles) {
    const snippets = store.getStagedSnippetsForRefresh(ef.filePath);
    const bareHash = ef.newHash.replace(/^h:/, '');

    for (const snippet of snippets) {
      try {
        if (snippet.shapeSpec) {
          // Shaped snippet: re-derive via h:NEW:{shape}
          const rawRef = `h:${bareHash}:${snippet.shapeSpec}`;
          const resolved = await invoke<{ content: string; source?: string | null }>('resolve_hash_ref', { rawRef });
          if (resolved?.content) {
            store.stageSnippet(snippet.key, resolved.content, snippet.source, undefined, bareHash, snippet.shapeSpec, 'derived');
          } else {
            store.unstageSnippet(snippet.key);
          }
        } else if (snippet.lines) {
          // Line-range snippet: relocate lines then re-slice
          const journal = getFreshnessJournal(ef.filePath);
          const delta = journal?.lineDelta ?? 0;
          const relocatedLines = delta !== 0 ? applyLineDelta(snippet.lines, delta) : snippet.lines;

          const rawRef = `h:${bareHash}:${relocatedLines}`;
          const resolved = await invoke<{ content: string; source?: string | null }>('resolve_hash_ref', { rawRef });
          if (resolved?.content) {
            store.stageSnippet(snippet.key, resolved.content, snippet.source, relocatedLines, bareHash, undefined, 'latest');
          } else {
            store.markEngramsSuspect([ef.filePath], 'same_file_prior_edit' as 'unknown', 'content');
          }
        } else {
          // Full-file staged snippet (no lines, no shape): resolve full content
          const rawRef = `h:${bareHash}`;
          const resolved = await invoke<{ content: string; source?: string | null }>('resolve_hash_ref', { rawRef });
          if (resolved?.content) {
            store.stageSnippet(snippet.key, resolved.content, snippet.source, undefined, bareHash, undefined, 'latest');
          } else {
            store.unstageSnippet(snippet.key);
          }
        }
      } catch (e) {
        console.warn(`[executor] snippet refresh failed for ${snippet.key}:`, e);
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

function summarizeInterruption(artifact: Record<string, unknown>, fallback: string): string {
  const actionRequired = artifact.action_required;
  if (typeof actionRequired === 'string' && actionRequired.trim()) return actionRequired.trim();
  const next = artifact._next;
  if (typeof next === 'string' && next.trim()) return next.trim();
  const warning = artifact._warning;
  if (typeof warning === 'string' && warning.trim()) return warning.trim();
  const summary = artifact.summary;
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  return fallback;
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

/** End batch after this step; no `interruption` — chat keeps going (rollback covers real edits). */
function shouldStopBatchAfterDryRunPreview(artifact: Record<string, unknown>): boolean {
  if (artifact.dry_run === true) return true;
  const st = typeof artifact.status === 'string' ? artifact.status.toLowerCase() : '';
  return st === 'preview' || st === 'dry_run_preview';
}

function detectBatchInterruption(stepId: string, stepIndex: number, stepUse: string, output: StepOutput): BatchInterruption | null {
  const artifact = getArtifact(output);
  if (!artifact) return null;
  if (isBlockingSystemExec(stepUse, artifact)) return null;

  const status = typeof artifact.status === 'string' ? artifact.status.toLowerCase() : '';
  const hasRollback = Boolean(artifact._rollback);
  const hasResumeAfter = artifact.resume_after !== undefined;

  const reason = typeof artifact.reason === 'string' ? artifact.reason : undefined;
  const isSuspectExternal = reason === 'suspect_external_change';

  const isPaused =
    status === 'paused'
    || status === 'failed_lint'
    || status === 'error'
    || hasRollback
    || hasResumeAfter;
  if (isPaused) {
    return {
      kind: 'paused_on_error',
      step_id: stepId,
      step_index: stepIndex,
      tool_name: stepUse,
      summary: summarizeInterruption(artifact, `${stepId}: paused and requires follow-up before continuing`),
      interruption_reason: isSuspectExternal ? 'suspect_external_change' : undefined,
    };
  }

  // Dry-run / preview no longer emit confirmation_required — rollback covers apply; agent chat should not halt.
  return null;
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
  const stepOutputs = new Map<string, StepOutput>();
  const namedBindings = new Map<string, StepOutput>();
  const results: StepResult[] = [];
  const allRefs: string[] = [];
  const bbRefs: string[] = [];
  const verifyResults: Array<{ step_id: string; passed: boolean; summary: string; classification?: VerifyClassification }> = [];
  let batchOk = true;
  let interruption: BatchInterruption | undefined;
  let spinBreaker: string | undefined;
  let spinBlocked = false;

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
      continue;
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
      applyIntraStepSnapshotRebaseIfNeeded(mergedParams);
    }

    // Auto-inject workspace for verify steps when not specified and files were edited
    if (step.use.startsWith('verify.') && !mergedParams.workspace && batchEditedPaths.size > 0) {
      const inferred = inferWorkspaceFromPaths(batchEditedPaths);
      if (inferred) mergedParams.workspace = inferred;
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

    // Block further reads/searches after the spin breaker fires
    if (spinBlocked && (step.use.startsWith('read.') || step.use.startsWith('search.'))) {
      const output: StepOutput = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: BLOCKED — read spin detected. Use existing h:refs, write to BB, or make an edit.`,
        error: 'read_spin_blocked',
      };
      stepOutputs.set(step.id, output);
      recordStepResult(step.id, step.use, output, 0);
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

    let output: StepOutput;
    try {
      output = await handler(mergedParams, ctx);
    } catch (e) {
      output = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: ERROR ${e instanceof Error ? e.message : String(e)}`,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // Store outputs
    stepOutputs.set(step.id, output);

    // Record snapshot hashes from step output
    recordSnapshotFromOutput(step, output, snapshotTracker, ctx, policy);

    // Post-edit housekeeping for successful change ops
    if (output.ok && step.use.startsWith('change.')) {
      // Rebase line numbers in subsequent same-file change steps
      if (step.use === 'change.edit') {
        rebaseSubsequentSteps(mergedParams, stepsToRun, i + 1);
      }
      // Track edited file paths for auto-workspace inference on verify steps
      if (output.content && typeof output.content === 'object') {
        const drafts = (output.content as Record<string, unknown>).drafts;
        if (Array.isArray(drafts)) {
          for (const d of drafts) {
            const f = (d as Record<string, unknown>)?.file ?? (d as Record<string, unknown>)?.f;
            if (typeof f === 'string') batchEditedPaths.add(f);
          }
        }
        const written = (output.content as Record<string, unknown>).written;
        if (Array.isArray(written)) {
          for (const w of written) {
            if (typeof w === 'string') batchEditedPaths.add(w);
          }
        }
      }
      // Register paths as own writes to suppress spurious intel:file_change from watcher
      registerOwnWrite([...batchEditedPaths]);
      // Synchronously rebase staged snippet line numbers from the freshness journal.
      // This must happen before the async content refresh so the model sees
      // correct line references in the next round's context.
      if (output.content && typeof output.content === 'object') {
        const editedInStep = collectEditedFiles(output.content as Record<string, unknown>);
        for (const ef of editedInStep) {
          const journal = getFreshnessJournal(ef.filePath);
          if (journal?.lineDelta) {
            ctx.store().rebaseStagedLineNumbers(ef.filePath, journal.lineDelta);
          }
        }
      }
      // Evict cached verify/exec/analysis results so they re-run against the updated files
      useRetentionStore.getState().evictMutationSensitive();
      // Refresh engram/snippet content so context reflects post-edit state
      if (output.content && typeof output.content === 'object' && !Array.isArray(output.content)) {
        refreshContextAfterEdit(output.content as Record<string, unknown>, ctx)
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
      if (spinEntries.length > 0) {
        const br = ctx.store().recordFileReadSpin(spinEntries);
        if (br) {
          const isHardBlock = br.startsWith('<<STOP:');
          if (isHardBlock) { spinBreaker = br; spinBlocked = true; }
          else if (!spinBlocked) { spinBreaker = br; }
        }
      }
    }
    if (output.ok && step.use === 'session.bb.write') {
      const bbKey = typeof mergedParams.key === 'string' ? mergedParams.key : undefined;
      const bbContent = typeof mergedParams.content === 'string' ? mergedParams.content : undefined;
      ctx.store().recordBatchBbWrite(bbKey, bbContent);
      const bbPaths = extractBbWriteFilePaths(mergedParams);
      ctx.store().resetFileReadSpin(bbPaths.length > 0 ? bbPaths : undefined);
    }
    if (output.ok && step.use.startsWith('change.')) {
      ctx.store().resetFileReadSpin();
    }

    if (!isAutoStep) userStepIndex += 1;
    const stepInterruption = detectBatchInterruption(step.id, i, step.use, output);
    const stepArtifact = getArtifact(output);
    const shouldTreatBlockedSystemExecAsNonFatal =
      stepArtifact !== null && isBlockingSystemExec(step.use, stepArtifact);
    if (stepInterruption && !shouldTreatBlockedSystemExecAsNonFatal) {
      interruption = stepInterruption;
      batchOk = false;
      break;
    }
    // Stop after change.* dry-run / preview so later steps are not run, but do not set `interruption` (chat/swarm keep going).
    if (
      output.ok
      && stepArtifact
      && step.use.startsWith('change.')
      && shouldStopBatchAfterDryRunPreview(stepArtifact)
    ) {
      break;
    }
    // Error handling
    if (!output.ok && !shouldTreatBlockedSystemExecAsNonFatal) {
      const errorBehavior = step.on_error ?? 'continue';
      if (errorBehavior === 'stop') {
        batchOk = false;
        break;
      }
      if (errorBehavior === 'rollback' && request.policy?.rollback_on_failure) {
        // Collect restore/delete from most recent change step with _rollback (refactor execute)
        let rollbackWith: Record<string, unknown> = {};
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
      break;
    }
  }

  // Build summary
  // Flush awareness to persistent cross-batch cache
  for (const [, identity] of snapshotTracker.entries()) {
    ctx.store().setAwareness({
      filePath: identity.filePath,
      snapshotHash: identity.snapshotHash,
      level: snapshotTracker.getAwarenessLevel(identity.filePath),
      readRegions: identity.readRegions ?? [],
      shapeHash: identity.shapeHash,
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
    interruption,
    intent_metrics: intentResult.metrics.length > 0 ? intentResult.metrics : undefined,
    duration_ms: Date.now() - batchStart,
  };
}
