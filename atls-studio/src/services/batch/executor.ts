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
} from './types';

import { getHandler } from './opMap';
import { normalizeStepParams } from './paramNorm';
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
import './intents/index';

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
 * Compute per-edit positional deltas from a completed line_edits array.
 * Each entry records the line where the edit occurred and the net line change.
 * Anchor/symbol edits (line <= 0) are excluded — they can't inform positional rebase.
 */
function computePositionalDeltas(lineEdits: unknown): PositionalDelta[] {
  if (!Array.isArray(lineEdits)) return [];
  const deltas: PositionalDelta[] = [];
  for (const edit of lineEdits) {
    if (!edit || typeof edit !== 'object') continue;
    const e = edit as Record<string, unknown>;
    const action = typeof e.action === 'string' ? e.action : '';
    const line = typeof e.line === 'number' && Number.isFinite(e.line) ? e.line : 0;
    const count = typeof e.count === 'number' && Number.isFinite(e.count) ? e.count : 1;
    const contentLines = typeof e.content === 'string' && e.content.length > 0
      ? countContentLines(e.content as string)
      : 0;
    let d = 0;
    if (action === 'insert_before' || action === 'insert_after' || action === 'prepend' || action === 'append') d = contentLines;
    else if (action === 'delete') d = -count;
    else if (action === 'replace') d = contentLines - count;
    if (d !== 0 && line > 0) deltas.push({ line, delta: d });
  }
  return deltas;
}

function estimateLineDeltaFromEdits(lineEdits: unknown): number {
  return computePositionalDeltas(lineEdits).reduce((sum, d) => sum + d.delta, 0);
}

/**
 * After a successful change.edit step, shift line numbers in subsequent
 * same-file steps so they reflect insertions/deletions from earlier steps.
 * Only adjusts explicit `line` values (anchor-based edits resolve at apply time).
 *
 * Uses positional deltas: each future line is shifted only by edits that
 * occurred at or before that line, not by a single global delta.
 */
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
      if (typeof entry.line === 'number' && entry.line > 0 && !entry.anchor && !entry.symbol) {
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
 * Auto-inject snapshot_hash into change op params from the tracker.
 * Mutates mergedParams in place.
 */
function injectSnapshotHashes(
  mergedParams: Record<string, unknown>,
  tracker: SnapshotTracker,
): void {
  const targetFile = (mergedParams.file ?? mergedParams.file_path) as string | undefined;
  if (typeof targetFile === 'string' && !mergedParams.snapshot_hash) {
    const trackedHash = tracker.getHash(targetFile);
    if (trackedHash) {
      mergedParams.snapshot_hash = trackedHash;
    }
  }
  if (Array.isArray(mergedParams.edits)) {
    mergedParams.edits = mergedParams.edits.map((edit) => {
      if (!edit || typeof edit !== 'object') return edit;
      const entry = edit as Record<string, unknown>;
      const editFile = (entry.file ?? entry.file_path) as string | undefined;
      if (typeof editFile === 'string' && !entry.snapshot_hash) {
        const trackedHash = tracker.getHash(editFile);
        if (trackedHash) {
          entry.snapshot_hash = trackedHash;
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
        if (!entry?.content || !ef) continue;
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
          }
        }
      } catch (e) {
        console.warn(`[executor] snippet refresh failed for ${snippet.key}:`, e);
      }
    }
  }
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

function detectBatchInterruption(stepId: string, stepIndex: number, stepUse: string, output: StepOutput): BatchInterruption | null {
  const artifact = getArtifact(output);
  if (!artifact) return null;
  if (isBlockingSystemExec(stepUse, artifact)) return null;

  const status = typeof artifact.status === 'string' ? artifact.status.toLowerCase() : '';
  const hasRollback = Boolean(artifact._rollback);
  const hasResumeAfter = artifact.resume_after !== undefined;
  const actionRequired = typeof artifact.action_required === 'string' ? artifact.action_required.toLowerCase() : '';
  const next = typeof artifact._next === 'string' ? artifact._next.toLowerCase() : '';
  const dryRun = artifact.dry_run === true;

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

  const isConfirmationRequired =
    dryRun
    || status === 'preview'
    || status === 'dry_run_preview'
    || actionRequired.includes('confirm')
    || next.includes('confirm:true')
    || next.includes('dry_run:false')
    || next.includes('preview complete')
    || next.includes('awaiting review')
    || next.includes('review and confirm');
  if (isConfirmationRequired) {
    return {
      kind: 'confirmation_required',
      step_id: stepId,
      step_index: stepIndex,
      tool_name: stepUse,
      summary: summarizeInterruption(artifact, `${stepId}: confirmation required before continuing`),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeUnifiedBatch(
  request: UnifiedBatchRequest,
  ctx: HandlerContext,
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

  // Reset per-batch state
  resetRecallBudget();
  const snapshotTracker = new SnapshotTracker();
  const batchEditedPaths = new Set<string>();

  // Seed from persistent awareness cache
  seedSnapshotTracker(snapshotTracker, ctx.store().getAwarenessCache());

  const policy = request.policy;

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
      results.push(stepOutputToResult(step.id, step.use, output, 0));
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
      results.push(stepOutputToResult(step.id, step.use, output, 0));
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
      results.push(stepOutputToResult(step.id, step.use, output, 0));
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
        results.push(stepOutputToResult(step.id, step.use, output, 0));
        continue;
      }
    }

    // Resolve in bindings
    const resolvedInputs = resolveInBindings(step.in, stepOutputs, namedBindings);

    // Merge with and resolved inputs (resolved inputs override with)
    let mergedParams: Record<string, unknown> = normalizeStepParams(step.use, { ...step.with, ...resolvedInputs });

    // Merge policy options for change ops (e.g. refactor_validation_mode)
    if (request.policy?.refactor_validation_mode && step.use.startsWith('change.')) {
      mergedParams = { ...mergedParams, refactor_validation_mode: request.policy.refactor_validation_mode };
    }

    // Auto-inject snapshot_hash for change ops from the tracker
    if (step.use.startsWith('change.') && snapshotTracker.size > 0) {
      injectSnapshotHashes(mergedParams, snapshotTracker);
    }

    // Auto-inject workspace for verify steps when not specified and files were edited
    if (step.use.startsWith('verify.') && !mergedParams.workspace && batchEditedPaths.size > 0) {
      const inferred = inferWorkspaceFromPaths(batchEditedPaths);
      if (inferred) mergedParams.workspace = inferred;
    }

    // Dispatch
    const handler = getHandler(step.use);
    if (!handler) {
      const output: StepOutput = {
        kind: 'raw', ok: false, refs: [],
        summary: `${step.id}: ERROR unknown operation "${step.use}"`,
        error: `unknown operation: ${step.use}`,
      };
      stepOutputs.set(step.id, output);
      results.push(stepOutputToResult(step.id, step.use, output, Date.now() - stepStart));
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
    results.push(stepOutputToResult(step.id, step.use, output, Date.now() - stepStart));

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
  const summary = request.goal
    ? `${request.goal}: ${okCount}/${totalCount} steps ok (${Date.now() - batchStart}ms)`
    : `batch: ${okCount}/${totalCount} steps ok (${Date.now() - batchStart}ms)`;

  return {
    ok: batchOk,
    summary,
    step_results: results,
    final_refs: allRefs.length > 0 ? allRefs : undefined,
    bb_refs: bbRefs.length > 0 ? bbRefs : undefined,
    verify: verifyResults.length > 0 ? verifyResults : undefined,
    interruption,
    intent_metrics: intentResult.metrics.length > 0 ? intentResult.metrics : undefined,
    duration_ms: Date.now() - batchStart,
  };
}
