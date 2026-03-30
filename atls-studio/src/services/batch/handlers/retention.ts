/**
 * Retention integration for batch handlers.
 *
 * Provides checkRetention() which handlers call after getting a result
 * but before calling addChunk. If the retention store indicates a collapse
 * (same fingerprint, same outcome), returns the existing ref to reuse.
 */

import type { StepOutput, HandlerContext, OperationKind } from '../types';
import { buildRetentionFingerprint, type FingerprintResult } from '../../retentionFingerprint';
import { useRetentionStore } from '../../../stores/retentionStore';
import { hashContentSync } from '../../../utils/contextHash';

export type RetentionCheckResult =
  | { reused: true; output: StepOutput }
  | { reused: false };

/**
 * Check retention for a tool result before storing it as a chunk.
 *
 * @param use - The operation kind (e.g. 'search.code', 'verify.build')
 * @param params - The operation parameters
 * @param resultContent - The result string that would be stored as a chunk
 * @param ok - Whether the operation succeeded
 * @param outputKind - The StepOutput kind for the result
 * @param summaryLabel - Human-readable label for the summary line
 * @param classification - Optional VerifyClassification for verify ops
 * @param structuredContent - Optional structured content to preserve on collapse (e.g. file_paths for downstream bindings)
 */
export function checkRetention(
  use: OperationKind | string,
  params: Record<string, unknown>,
  resultContent: string,
  ok: boolean,
  outputKind: StepOutput['kind'],
  summaryLabel: string,
  classification?: string,
  structuredContent?: unknown,
): RetentionCheckResult {
  const result = buildRetentionFingerprint(use, params);
  if (!result) return { reused: false };

  const { fingerprint, semanticSignature } = result;
  const contentHash = hashContentSync(resultContent);
  const store = useRetentionStore.getState();
  const action = store.recordResult(fingerprint, contentHash, ok, classification);

  // Attach semanticSignature to the entry after recording
  const entry = store.getEntry(fingerprint);
  if (entry && !entry.semanticSignature) {
    entry.semanticSignature = semanticSignature;
  }

  if (action.action === 'collapse') {
    if (entry?.traceState === 'distilled' && entry.distillSummary) {
      return {
        reused: true,
        output: {
          kind: outputKind,
          ok,
          refs: [],
          summary: entry.distillSummary,
          tokens: 0,
          classification: classification as StepOutput['classification'],
        },
      };
    }
    return {
      reused: true,
      output: {
        kind: outputKind,
        ok,
        refs: [`h:${action.latestHash}`],
        summary: `${summaryLabel} (run #${action.occurrenceCount}, same outcome — reusing h:${action.latestHash})`,
        tokens: 0,
        classification: classification as StepOutput['classification'],
        ...(structuredContent !== undefined ? { content: structuredContent } : {}),
      },
    };
  }

  return { reused: false };
}
