/**
 * Result Formatter — converts batch execution results into model-facing strings.
 */

import type {
  StepOutput,
  StepResult,
  UnifiedBatchResult,
  VerifyClassification,
  VerifyConfidence,
} from './types';
import { SHORT_HASH_LEN } from '../../utils/contextHash';
import { parseHashRef } from '../../utils/hashRefParsers';
import type { HashModifierV2 } from '../../utils/uhppTypes';
import { getRef } from '../hashProtocol';
import { useContextStore } from '../../stores/contextStore';
import {
  BATCH_FAILURE_BB_KEY,
  BATCH_FAILURE_THRESHOLD,
  getBatchFailureSummary,
  recordBatchFailure,
} from '../freshnessTelemetry';

// ---------------------------------------------------------------------------
// Per-step formatting
// ---------------------------------------------------------------------------

const CLASSIFICATION_LABELS: Record<VerifyClassification, string> = {
  'pass': '[PASS]',
  'pass-with-warnings': '[WARN]',
  'fail': '[FAIL]',
  'tool-error': '[TOOL-ERROR]',
};

const VERIFY_CONFIDENCE_LABELS: Record<VerifyConfidence, string> = {
  fresh: 'fresh',
  cached: 'cached',
  'stale-suspect': 'stale-suspect',
  obsolete: 'obsolete',
};

function deriveStepVerificationConfidence(step: StepResult): VerifyConfidence | undefined {
  if (!step.use.startsWith('verify.')) return undefined;
  const verifyMeta = step as StepResult & {
    verification_confidence?: VerifyConfidence;
    verification_reused?: boolean;
    verification_obsolete?: boolean;
    verification_stale?: boolean;
  };
  if (verifyMeta.verification_confidence) return verifyMeta.verification_confidence;
  const artifacts = (step.artifacts ?? {}) as Record<string, unknown>;
  if (verifyMeta.verification_obsolete || artifacts.obsolete === true) return 'obsolete';
  if (verifyMeta.verification_stale || artifacts.suspect_external_change === true || artifacts.stale === true) return 'stale-suspect';
  const summary = artifacts.summary as Record<string, unknown> | undefined;
  const source = typeof summary?.source === 'string' ? summary.source : undefined;
  if (verifyMeta.verification_reused || source === 'cache' || source === 'cached') return 'cached';
  return 'fresh';
}

function stepStatusLabel(step: StepResult): string {
  if (step.classification) return CLASSIFICATION_LABELS[step.classification];
  if (step.summary?.includes('SKIPPED')) return '[SKIP]';
  return step.ok ? '[OK]' : '[FAIL]';
}

function verifyArtifactSuffix(step: StepResult): string {
  if (!step.artifacts && !step.use.startsWith('verify.')) return '';
  const summary = (step.artifacts as Record<string, unknown> | undefined)?.summary as Record<string, unknown> | undefined;
  const parts: string[] = [];
  const confidence = deriveStepVerificationConfidence(step);
  if (confidence) parts.push(VERIFY_CONFIDENCE_LABELS[confidence]);
  if (typeof summary?.error_count === 'number') parts.push(`errors: ${summary.error_count}`);
  if (typeof summary?.warning_count === 'number') parts.push(`warnings: ${summary.warning_count}`);
  const source = typeof summary?.source === 'string' ? summary.source : undefined;
  if (source === 'invalid_command') parts.push('invalid command');
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

export function formatStepOutput(output: StepOutput): string {
  if (output.content && typeof output.content === 'object' && !Array.isArray(output.content)) {
    const content = output.content as Record<string, unknown>;
    if (typeof content._hint === 'string') {
      const nextSteps = Array.isArray(content.likely_next_steps)
        ? content.likely_next_steps.filter((step): step is string => typeof step === 'string' && step.trim().length > 0)
        : [];
      if (nextSteps.length > 0) {
        return `${output.summary} Next: ${nextSteps.join(' | ')}`;
      }
    }
  }
  return output.summary;
}

// ---------------------------------------------------------------------------
// UnifiedBatchResult formatting
// ---------------------------------------------------------------------------

const MAX_STEP_SUMMARY_CHARS = 2000;
const MAX_GIT_SUMMARY_CHARS = 64_000;

function capSummary(text: string): string {
  if (text.length <= MAX_STEP_SUMMARY_CHARS) return text;
  return text.substring(0, MAX_STEP_SUMMARY_CHARS) + '... [truncated]';
}

function fileBasename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

function actualRangeLabel(actualRange: unknown): string | undefined {
  if (!Array.isArray(actualRange) || actualRange.length === 0) return undefined;
  return actualRange
    .map((r: unknown) => {
      if (!Array.isArray(r)) return '';
      const s = r[0] as number;
      const e = r[1] as number | null;
      return e != null ? `${s}-${e}` : `${s}`;
    })
    .filter(Boolean)
    .join(',');
}

/** Mirrors executor extractFileRefsWithRanges — file + line spans for omission anchors. */
function collectArtifactAnchors(artifacts: Record<string, unknown>): string[] {
  const out: string[] = [];

  function pushFileRange(file: string, actualRange: unknown): void {
    const base = fileBasename(file);
    const range = actualRangeLabel(actualRange);
    out.push(range ? `${base}:${range}` : base);
  }

  if (typeof artifacts.file === 'string') {
    pushFileRange(artifacts.file, artifacts.actual_range);
  }
  const results = artifacts.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (typeof rec.file === 'string') {
          pushFileRange(rec.file, rec.actual_range);
        }
      }
    }
  }
  return out;
}

function formatModifierLines(mod: HashModifierV2): string | undefined {
  if (typeof mod === 'object' && mod !== null && 'lines' in mod) {
    const lines = (mod as { lines: [number, number | null][] }).lines;
    if (Array.isArray(lines)) {
      return lines.map(([s, e]) => (e != null ? `${s}-${e}` : `${s}`)).join(',');
    }
  }
  return undefined;
}

function anchorFromRefs(refs: string[] | undefined): string | undefined {
  const raw = refs?.find(r => r.trimStart().startsWith('h:'));
  if (!raw) return undefined;
  const parsed = parseHashRef(raw.trim());
  if (!parsed) return undefined;
  const short = parsed.hash.slice(0, SHORT_HASH_LEN);
  const cref = getRef(parsed.hash);
  const base = cref?.source ? fileBasename(cref.source) : undefined;
  const lineSpec = formatModifierLines(parsed.modifier);
  const head = `h:${short}${base ? ` ${base}` : ''}`;
  return lineSpec ? `${head}:${lineSpec}` : head;
}

/** Provenance hint when middle-truncating a step summary (pins / file reads). */
function buildTruncationAnchor(step: StepResult): string | undefined {
  const art = step.artifacts;
  if (art && typeof art === 'object' && !Array.isArray(art)) {
    const anchors = collectArtifactAnchors(art as Record<string, unknown>);
    if (anchors.length > 0) {
      const shown = anchors.slice(0, 3);
      const suffix = anchors.length > 3 ? ' …' : '';
      return `${shown.join(', ')}${suffix}`;
    }
  }
  return anchorFromRefs(step.refs);
}

function capStepSummary(text: string, stepUse: string, step: StepResult): string {
  if (stepUse.startsWith('read.')) return text;
  const limit = stepUse === 'system.git' ? MAX_GIT_SUMMARY_CHARS : MAX_STEP_SUMMARY_CHARS;
  if (text.length <= limit) return text;
  const headBudget = Math.floor(limit * 0.75);
  const tailBudget = limit - headBudget - 40;
  const head = text.substring(0, headBudget);
  const tail = text.substring(text.length - tailBudget);
  const omitted = text.length - headBudget - tailBudget;
  const anchor = buildTruncationAnchor(step);
  const omission = anchor
    ? `[${omitted} chars omitted — ${anchor}]`
    : `[${omitted} chars omitted]`;
  return `${head}\n...${omission}...\n${tail}`;
}

// ---------------------------------------------------------------------------
// Rule B — FileView-merge pointer
// When a successful read.lines / read.shaped result will be canonically held
// by a live pinned FileView, emit a one-line pointer instead of the raw body.
// The FileView block in working memory becomes the single source of truth.
//
// Timing note: the `rl` handler creates the view via `ensureFileView` and
// auto-pins it, but the actual merge of the read body into `filledRegions`
// happens AFTER this formatter runs (via `addChunk(readSpan)` from
// `materializeFileRefsContentIfNeeded` or `refreshRoundEnd`). By the time the
// model sees the next round's manifest, the fill has landed. We therefore
// gate on `view.pinned` — a sufficient signal that (a) the fill path is
// wired and (b) the model will retain the view — and trust the async merge.
// ---------------------------------------------------------------------------

function formatRange(r: [number, number | null]): string {
  const [s, e] = r;
  return e != null && e !== s ? `${s}-${e}` : `${s}`;
}

function coerceRangeArray(value: unknown): Array<[number, number | null]> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: Array<[number, number | null]> = [];
  for (const r of value) {
    if (!Array.isArray(r) || r.length === 0) return null;
    const s = r[0];
    const e = r.length > 1 ? r[1] : null;
    if (typeof s !== 'number') return null;
    if (e != null && typeof e !== 'number') return null;
    out.push([s, e]);
  }
  return out;
}

/**
 * If this step's content will be canonically held by a pinned FileView,
 * return a compact pointer line; else null.
 */
function tryBuildFileViewMergedPointer(step: StepResult): string | null {
  if (!step.ok) return null;
  if (step.use !== 'read.lines' && step.use !== 'read.shaped') return null;
  const art = step.artifacts as Record<string, unknown> | undefined;
  if (!art || typeof art !== 'object') return null;

  const store = useContextStore.getState();

  if (step.use === 'read.shaped') {
    const results = art.results;
    if (!Array.isArray(results) || results.length === 0) return null;
    const pointers: string[] = [];
    for (const entry of results) {
      if (!entry || typeof entry !== 'object') return null;
      const row = entry as Record<string, unknown>;
      const file = typeof row.file === 'string' ? row.file : null;
      const hashRef = typeof row.h === 'string' ? row.h : null;
      if (!file || !hashRef) return null;
      const view = store.getFileView(file);
      if (!view || !view.pinned) return null;
      pointers.push(`${file} -> ${hashRef}`);
    }
    return `read_shaped: merged into FileViews: ${pointers.join('; ')} | see ## FILE VIEWS`;
  }

  // step.use === 'read.lines'
  const file = typeof art.file === 'string' ? art.file : null;
  const hashRef = typeof art.hash === 'string' ? art.hash : null;
  const ranges =
    coerceRangeArray(art.actual_range) ??
    coerceRangeArray(art.target_range);
  if (!file || !hashRef || !ranges) return null;
  // engram: reads (from hashes) don't have a backing file — skip.
  if (file.startsWith('engram:')) return null;

  const view = store.getFileView(file);
  if (!view || !view.pinned) return null;

  // Optional safety: if the view has loaded its skeleton (totalLines > 0) and
  // the requested range falls entirely outside the file, bail — the handler
  // should have failed the step, but a bad backend payload shouldn't emit a
  // misleading pointer. Ranges within [1, totalLines] or with totalLines
  // unknown (pre-skeleton) pass through.
  if (view.totalLines > 0) {
    for (const [s, e] of ranges) {
      const endLine = e ?? s;
      if (s < 1 || endLine > view.totalLines) return null;
    }
  }

  const rangeLabel = ranges.map(formatRange).join(',');
  const tokenTag = typeof step.tokens_delta === 'number' && step.tokens_delta > 0
    ? ` (${step.tokens_delta}tk)`
    : '';
  return `read_lines: ${file}:${rangeLabel} -> merged into ${hashRef} [${rangeLabel}]${tokenTag} | see ## FILE VIEWS`;
}

// ---------------------------------------------------------------------------
// Rule A — failed-step dedupe (byte-equal, within-batch)
// ---------------------------------------------------------------------------

interface FailureGroup {
  op: string;
  primary: string;
  stepIds: string[];
  sources: Array<string | undefined>;
}

function extractPrimaryMessage(step: StepResult): string {
  return (typeof step.summary === 'string' ? step.summary.trim() : '')
    || (typeof step.error === 'string' ? step.error.trim() : '')
    || '';
}

/**
 * Group all failed steps by (op, primary-message). Empty messages are not deduped
 * (they'd render as "[failed — no message]" which is already tiny).
 */
function groupFailuresByClass(steps: StepResult[]): Map<string, FailureGroup> {
  const groups = new Map<string, FailureGroup>();
  for (const step of steps) {
    if (step.ok) continue;
    const primary = extractPrimaryMessage(step);
    if (!primary) continue;
    const key = `${step.use}::${primary}`;
    let group = groups.get(key);
    if (!group) {
      group = { op: step.use, primary, stepIds: [], sources: [] };
      groups.set(key, group);
    }
    group.stepIds.push(step.id);
    group.sources.push(buildTruncationAnchor(step));
  }
  return groups;
}

/**
 * After telemetry records, write/update the repeated-misuse BB key when any class
 * has crossed BATCH_FAILURE_THRESHOLD. Idempotent — overwrites the same key with
 * a fresh digest each round a crossing class is observed.
 */
function maybeWriteBatchFailuresBb(): void {
  const crossing = getBatchFailureSummary().filter(e => e.count >= BATCH_FAILURE_THRESHOLD);
  if (crossing.length === 0) return;
  const body = crossing.map(e =>
    `- ${e.op} x${e.count}: ${e.errorSnippet}${e.exampleStepIds.length > 0 ? `  [recent steps: ${e.exampleStepIds.join(', ')}]` : ''}`
  ).join('\n');
  try {
    useContextStore.getState().setBlackboardEntry(BATCH_FAILURE_BB_KEY, body);
  } catch {
    // BB write is best-effort; telemetry remains in memory regardless.
  }
}

export function formatBatchResult(result: UnifiedBatchResult): string {
  const lines: string[] = [];

  const staleVerifyStepIds = new Set<string>();
  for (const [, artifact] of useContextStore.getState().verifyArtifacts) {
    if (artifact.stale) staleVerifyStepIds.add(artifact.stepId);
  }

  // Rule A — prebuild failure groups. First occurrence of each class renders
  // the full message; subsequent identical failures are replaced by a single
  // "+N identical" tail inserted immediately after the first.
  const failureGroups = groupFailuresByClass(result.step_results);
  const suppressedStepIds = new Set<string>();
  const collapseAfterStepId = new Map<string, FailureGroup>();
  for (const group of failureGroups.values()) {
    if (group.stepIds.length < 2) continue;
    const [firstId, ...rest] = group.stepIds;
    for (const id of rest) suppressedStepIds.add(id);
    collapseAfterStepId.set(firstId, group);
  }

  // Rule D — record every failure class (even N=1) once per batch, with total
  // count. Surfaces repeated-misuse patterns that per-batch dedupe otherwise
  // hides from the archived-shell learning loop.
  let thresholdCrossed = false;
  for (const group of failureGroups.values()) {
    const postCount = recordBatchFailure(group.op, group.primary, group.stepIds);
    if (postCount >= BATCH_FAILURE_THRESHOLD) thresholdCrossed = true;
  }
  if (thresholdCrossed) maybeWriteBatchFailuresBb();

  for (const step of result.step_results) {
    if (suppressedStepIds.has(step.id)) continue;

    const label = stepStatusLabel(step);
    const suffix = step.use.startsWith('verify.') ? verifyArtifactSuffix(step) : '';
    const durationTag = step.duration_ms > 0 ? ` (${step.duration_ms}ms)` : '';
    const staleSuffix = step.use.startsWith('verify.') && step.ok && staleVerifyStepIds.has(step.id)
      ? ' [cached — result may not reflect latest edits; rerun with vb to refresh]'
      : '';

    // Rule B — replace raw line-body dump with a FileView merge pointer when
    // the content is already canonical in a live pinned view. Falls through to
    // the normal summary/error chain when no view covers the range.
    const mergedPointer = tryBuildFileViewMergedPointer(step);
    const summaryPrimary = typeof step.summary === 'string' ? step.summary.trim() : '';
    const errorPrimary = typeof step.error === 'string' ? step.error.trim() : '';
    const primary = mergedPointer ?? (summaryPrimary || errorPrimary);

    if (primary) {
      lines.push(`${label} ${step.id} (${step.use}): ${capStepSummary(primary, step.use, step)}${suffix}${staleSuffix}${durationTag}`);
    } else {
      const fallback = step.ok
        ? `[completed${step.refs?.length ? ` — ${step.refs.length} ref(s)` : ''}]`
        : '[failed — no message]';
      lines.push(`${label} ${step.id} (${step.use}): ${fallback}${suffix}${staleSuffix}${durationTag}`);
    }

    // Rule A — immediate dedupe tail for this group's suppressed siblings.
    const collapse = collapseAfterStepId.get(step.id);
    if (collapse) {
      const tailIds = collapse.stepIds.slice(1);
      const tailSources = collapse.sources.slice(1).filter((s): s is string => !!s);
      const sourcesSuffix = tailSources.length > 0 ? ` - ${tailSources.join(', ')}` : '';
      lines.push(`[FAIL] +${tailIds.length} identical (${tailIds.join(', ')})${sourcesSuffix} - same class: ${collapse.op}`);
    }

    if (step.use.startsWith('delegate.') && step.ok) {
      if (step.refs?.length) {
        lines.push(`  refs: ${step.refs.join(' ')}`);
      }
      const art = step.artifacts as Record<string, unknown> | undefined;
      const bbKeys = art?.bbKeys as string[] | undefined;
      if (bbKeys?.length) {
        lines.push(`  BB: ${bbKeys.map(k => `h:bb:${k}`).join(' ')}`);
        lines.push('  (Blackboard bodies are inlined in the step summary when present.)');
      }
    }
  }

  if (result.interruption) {
    const reason = result.interruption.interruption_reason === 'suspect_external_change'
      ? ' (STALE: external change since verification — re-read required)'
      : '';
    lines.push(`[ATLS] BATCH INTERRUPTED at ${result.interruption.step_id}: ${result.interruption.summary}${reason}`);
  }

  // Collect base hashes pinned in this batch so we don't nudge the agent to re-pin
  // refs it already pinned. session.pin emits its resolved hashes on step.refs.
  const pinnedBaseHashes = new Set<string>();
  for (const step of result.step_results) {
    if (step.ok && step.use === 'session.pin' && step.refs?.length) {
      for (const ref of step.refs) {
        const base = ref.replace(/^h:/, '').split(':')[0];
        if (base) pinnedBaseHashes.add(base);
      }
    }
  }

  // Volatile nudge: aggregate refs from read/search/analysis steps, minus anything
  // already pinned in this batch.
  const READ_SEARCH_OPS = new Set([
    'read.context', 'read.shaped', 'read.lines', 'read.file',
    'search.code', 'search.symbol', 'search.usage', 'search.similar',
    'search.issues', 'search.patterns', 'search.memory',
    'analyze.deps', 'analyze.calls', 'analyze.structure',
    'analyze.impact', 'analyze.blast_radius', 'analyze.extract_plan',
  ]);
  const volatileRefs: string[] = [];
  for (const step of result.step_results) {
    if (step.ok && step.refs?.length && READ_SEARCH_OPS.has(step.use)) {
      for (const ref of step.refs) {
        if (!ref.startsWith('h:') || volatileRefs.includes(ref)) continue;
        const base = ref.replace(/^h:/, '').split(':')[0];
        if (base && pinnedBaseHashes.has(base)) continue;
        volatileRefs.push(ref);
      }
    }
  }
  if (volatileRefs.length > 0) {
    const shortRefs = volatileRefs.slice(0, 8).join(' ');
    const overflow = volatileRefs.length > 8 ? ` +${volatileRefs.length - 8} more` : '';
    lines.push(`⚠ VOLATILE — WILL BE LOST NEXT ROUND. PIN NOW in this batch or write to BB. Add: \`pi ${shortRefs}\`${overflow}`);
  }

  const counts = { pass: 0, warn: 0, fail: 0, toolError: 0, other: 0 };
  for (const step of result.step_results) {
    switch (step.classification) {
      case 'pass': counts.pass++; break;
      case 'pass-with-warnings': counts.warn++; break;
      case 'fail': counts.fail++; break;
      case 'tool-error': counts.toolError++; break;
      default: step.ok ? counts.pass++ : counts.fail++; break;
    }
  }
  const parts: string[] = [];
  if (counts.pass > 0) parts.push(`${counts.pass} pass`);
  if (counts.warn > 0) parts.push(`${counts.warn} warn`);
  if (counts.fail > 0) parts.push(`${counts.fail} fail`);
  if (counts.toolError > 0) parts.push(`${counts.toolError} tool-error`);
  const statusLabel = result.ok ? 'ok' : (result.interruption ? 'interrupted' : 'failed');
  lines.push(`[ATLS] ${result.step_results.length} steps: ${parts.join(', ')} (${result.duration_ms}ms) | ${statusLabel}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// StepResult conversion
// ---------------------------------------------------------------------------

export function stepOutputToResult(
  stepId: string,
  use: string,
  output: StepOutput,
  durationMs: number,
): StepResult {
  const artifacts = (output.content && typeof output.content === 'object' && !Array.isArray(output.content))
    ? output.content as Record<string, unknown>
    : undefined;
  const verificationConfidence = use.startsWith('verify.')
    ? deriveStepVerificationConfidence({
        id: stepId,
        use: use as StepResult['use'],
        ok: output.ok,
        artifacts,
        duration_ms: durationMs,
      } as StepResult)
    : undefined;

  const summaryTrim = typeof output.summary === 'string' ? output.summary.trim() : '';
  const errorTrim = typeof output.error === 'string' ? output.error.trim() : '';
  let summary: string | undefined = summaryTrim || undefined;
  let error: string | undefined = errorTrim || undefined;
  if (!summary && !error) {
    if (output.ok) {
      summary = output.refs.length > 0
        ? `OK (${output.refs.length} ref${output.refs.length === 1 ? '' : 's'})`
        : 'OK';
    } else {
      error = 'Step failed (no message)';
    }
  }

  return {
    id: stepId,
    use: use as StepResult['use'],
    ok: output.ok,
    refs: output.refs.length > 0 ? output.refs : undefined,
    artifacts,
    summary,
    error,
    classification: output.classification,
    duration_ms: durationMs,
    tokens_delta: output.tokens,
    _threshold_hint: output._threshold_hint,
    _hash_warnings: output._hash_warnings,
    ...(verificationConfidence ? {
      verification_confidence: verificationConfidence,
      verification_reused: verificationConfidence === 'cached' || undefined,
      verification_obsolete: verificationConfidence === 'obsolete' || undefined,
      verification_stale: verificationConfidence === 'stale-suspect' || undefined,
    } : {}),
  } as StepResult;
}
