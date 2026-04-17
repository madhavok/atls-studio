/**
 * intent.edit — freshness-aware edit with conditional retry on stale_hash.
 *
 * Skips steps when the context already has coverage:
 * - Awareness has fresh snapshotHash? skip re-read
 * - File pinned? skip pin
 * - Read regions cover edit lines? skip read.lines
 *
 * Error recovery: emits conditional retry steps using ConditionExpr.
 * If the primary edit fails, a re-read + retry edit fires automatically.
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { AwarenessLevel } from '../snapshotTracker';
import { makeStepId, isFilePinned, isFileStaged, getFileAwareness, computeNextTargets } from '../intents';

export const resolveEdit: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const filePath = (params.file_path as string) ?? '';
  const lineEdits = params.line_edits as unknown[] ?? [];
  const verify = params.verify !== false;
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'edit';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  const awareness = getFileAwareness(context.awareness, filePath);
  const hasAwareness = awareness != null && awareness.level >= AwarenessLevel.SHAPED;
  const staged = isFileStaged(context.staged, filePath);
  const pinned = isFilePinned(context.pinnedSources, filePath);

  const editRange = extractEditRange(lineEdits);

  const readId = makeStepId(intentId, 'read_lines');
  const editId = makeStepId(intentId, 'edit');
  const verifyId = makeStepId(intentId, 'verify');
  const retryReadId = makeStepId(intentId, 'retry_read');
  const retryEditId = makeStepId(intentId, 'retry_edit');

  const regionsCoverEdit = hasAwareness && editRange != null && awareness != null
    && awareness.readRegions.some(r => r.start <= editRange.start && r.end >= editRange.end);

  // Canonical awareness (full read in prior batch) bypasses the read-range gate,
  // so no pre-read is needed. For anything less, require read coverage or staged content.
  const isCanonical = awareness != null && awareness.level >= AwarenessLevel.CANONICAL;
  const needsRead = force || (!isCanonical && !regionsCoverEdit && !staged);

  if (needsRead && editRange) {
    steps.push({
      id: readId,
      use: 'read.lines',
      with: {
        file_path: filePath,
        start_line: Math.max(1, editRange.start - 5),
        end_line: editRange.end + 5,
      },
    });
  } else if (needsRead) {
    steps.push({
      id: readId,
      use: 'read.shaped',
      with: { file_paths: [filePath], shape: 'sig' },
    });
  }

  steps.push({
    id: editId,
    use: 'change.edit',
    with: { file_path: filePath, line_edits: lineEdits },
  });

  // Conditional retry: re-read + retry edit on failure (stale_hash recovery)
  if (editRange) {
    steps.push({
      id: retryReadId,
      use: 'read.lines',
      with: {
        file_path: filePath,
        start_line: Math.max(1, editRange.start - 5),
        end_line: editRange.end + 5,
      },
      if: { not: { step_ok: editId } },
    });
  } else {
    steps.push({
      id: retryReadId,
      use: 'read.shaped',
      with: { file_paths: [filePath], shape: 'sig' },
      if: { not: { step_ok: editId } },
    });
  }

  steps.push({
    id: retryEditId,
    use: 'change.edit',
    with: { file_path: filePath, line_edits: lineEdits },
    if: { not: { step_ok: editId } },
  });

  if (verify) {
    steps.push({
      id: verifyId,
      use: 'verify.build',
      if: { or: [{ step_ok: editId }, { step_ok: retryEditId }] },
    });
  }

  const lookahead = computeNextTargets(intentId, 'intent.edit', [filePath], context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};

function extractEditRange(lineEdits: unknown[]): { start: number; end: number } | null {
  if (!Array.isArray(lineEdits) || lineEdits.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const edit of lineEdits) {
    if (typeof edit !== 'object' || edit == null) continue;
    const e = edit as Record<string, unknown>;
    const line = typeof e.line === 'number' ? e.line : null;
    const endLine = typeof e.end_line === 'number' ? e.end_line : line;
    if (line != null) {
      if (line < min) min = line;
      if ((endLine ?? line) > max) max = endLine ?? line;
    }
  }
  if (min === Infinity || max === -Infinity) return null;
  return { start: min, end: max };
}
