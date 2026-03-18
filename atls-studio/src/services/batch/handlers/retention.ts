/**
 * Retention integration for batch handlers.
 *
 * Provides checkRetention() which handlers call after getting a result
 * but before calling addChunk. If the retention store indicates a collapse
 * (same fingerprint, same outcome), returns the existing ref to reuse.
 */

import type { StepOutput, HandlerContext, OperationKind } from '../types';
import { buildRetentionFingerprint } from '../../retentionFingerprint';
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
 */
export function checkRetention(
  use: OperationKind | string,
  params: Record<string, unknown>,
  resultContent: string,
  ok: boolean,
  outputKind: StepOutput['kind'],
  summaryLabel: string,
  classification?: string,
): RetentionCheckResult {
  const fp = buildRetentionFingerprint(use, params);
  if (!fp) return { reused: false };

  const contentHash = hashContentSync(resultContent);
  const store = useRetentionStore.getState();
  const action = store.recordResult(fp, contentHash, ok, classification);

  if (action.action === 'collapse') {
    return {
      reused: true,
      output: {
        kind: outputKind,
        ok,
        refs: [`h:${action.latestHash}`],
        summary: `${summaryLabel} (run #${action.occurrenceCount}, same outcome — reusing h:${action.latestHash})`,
        tokens: 0,
        classification: classification as StepOutput['classification'],
      },
    };
  }

  return { reused: false };
}
