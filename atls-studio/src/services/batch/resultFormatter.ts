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

function capStepSummary(text: string, stepUse: string): string {
  const limit = stepUse === 'system.git' ? MAX_GIT_SUMMARY_CHARS : MAX_STEP_SUMMARY_CHARS;
  if (text.length <= limit) return text;
  const headBudget = Math.floor(limit * 0.75);
  const tailBudget = limit - headBudget - 40;
  const head = text.substring(0, headBudget);
  const tail = text.substring(text.length - tailBudget);
  const omitted = text.length - headBudget - tailBudget;
  return `${head}\n...[${omitted} chars omitted]...\n${tail}`;
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
    if (step.summary) {
      lines.push(`${label} ${step.id}: ${capStepSummary(step.summary, step.use)}${suffix}${staleSuffix}${durationTag}`);
    } else if (step.error) {
      lines.push(`${label} ${step.id}: ${capStepSummary(step.error, step.use)}${durationTag}`);
    }
  }

  if (result.interruption) {
    const reason = result.interruption.interruption_reason === 'suspect_external_change'
      ? ' (STALE: external change since verification — re-read required)'
      : '';
    lines.push(`[ATLS] BATCH INTERRUPTED at ${result.interruption.step_id}: ${result.interruption.summary}${reason}`);
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

  return {
    id: stepId,
    use: use as StepResult['use'],
    ok: output.ok,
    refs: output.refs.length > 0 ? output.refs : undefined,
    artifacts,
    summary: output.summary,
    error: output.error,
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
