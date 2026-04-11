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

export function formatBatchResult(result: UnifiedBatchResult): string {
  const lines: string[] = [];

  const staleVerifyStepIds = new Set<string>();
  for (const [, artifact] of useContextStore.getState().verifyArtifacts) {
    if (artifact.stale) staleVerifyStepIds.add(artifact.stepId);
  }

  for (const step of result.step_results) {
    const label = stepStatusLabel(step);
    const suffix = step.use.startsWith('verify.') ? verifyArtifactSuffix(step) : '';
    const durationTag = step.duration_ms > 0 ? ` (${step.duration_ms}ms)` : '';
    const staleSuffix = step.use.startsWith('verify.') && step.ok && staleVerifyStepIds.has(step.id)
      ? ' [STALE: cached verification result — rerun canonical command]'
      : '';
    const primary = (typeof step.summary === 'string' ? step.summary.trim() : '')
      || (typeof step.error === 'string' ? step.error.trim() : '')
      || '';
    if (primary) {
      lines.push(`${label} ${step.id} (${step.use}): ${capStepSummary(primary, step.use, step)}${suffix}${staleSuffix}${durationTag}`);
    } else {
      const fallback = step.ok
        ? `[completed${step.refs?.length ? ` — ${step.refs.length} ref(s)` : ''}]`
        : '[failed — no message]';
      lines.push(`${label} ${step.id} (${step.use}): ${fallback}${suffix}${staleSuffix}${durationTag}`);
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

  // Volatile nudge: aggregate refs from read/search/analysis steps
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
        if (ref.startsWith('h:') && !volatileRefs.includes(ref)) {
          volatileRefs.push(ref);
        }
      }
    }
  }
  if (volatileRefs.length > 0) {
    const shortRefs = volatileRefs.slice(0, 8).join(' ');
    const overflow = volatileRefs.length > 8 ? ` +${volatileRefs.length - 8} more` : '';
    lines.push(`⚠ VOLATILE — refs expire next round. pin to keep: \`pi ${shortRefs}\`${overflow}`);
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
