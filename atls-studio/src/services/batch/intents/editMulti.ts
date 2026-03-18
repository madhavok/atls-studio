/**
 * intent.edit_multi — batch multi-file edits with per-file retry and single verify.
 *
 * For each file: read-if-needed -> edit -> retry-on-stale.
 * One verify.build at the end, conditioned on all edits succeeding.
 *
 * Discipline: AI must have ALREADY READ all target files and know exact line_edits.
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { AwarenessLevel } from '../snapshotTracker';
import { makeStepId, isFileStaged, getFileAwareness, computeNextTargets } from '../intents';

interface FileEdit {
  file_path: string;
  line_edits: unknown[];
}

function extractEditRange(lineEdits: unknown[]): { start: number; end: number } | null {
  if (!Array.isArray(lineEdits) || lineEdits.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const edit of lineEdits) {
    if (typeof edit !== 'object' || edit == null) continue;
    const e = edit as Record<string, unknown>;
    const line = typeof e.line === 'number' ? e.line : null;
    const count = typeof e.count === 'number' ? e.count : 1;
    if (line != null) {
      if (line < min) min = line;
      if (line + count - 1 > max) max = line + count - 1;
    }
  }
  if (min === Infinity || max === -Infinity) return null;
  return { start: min, end: max };
}

export const resolveEditMulti: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const edits = normalizeEdits(params);
  const verify = params.verify !== false;
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'edit_multi';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];
  const editStepIds: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const { file_path: filePath, line_edits: lineEdits } = edits[i];

    const awareness = getFileAwareness(context.awareness, filePath);
    const hasAwareness = awareness != null && awareness.level >= AwarenessLevel.SHAPED;
    const staged = isFileStaged(context.staged, filePath);
    const editRange = extractEditRange(lineEdits);

    const readId = makeStepId(intentId, `read_${i}`);
    const editId = makeStepId(intentId, `edit_${i}`);
    const retryReadId = makeStepId(intentId, `retry_read_${i}`);
    const retryEditId = makeStepId(intentId, `retry_edit_${i}`);

    const regionsCoverEdit = hasAwareness && editRange != null && awareness != null
      && awareness.readRegions.some(r => r.start <= editRange.start && r.end >= editRange.end);

    const needsRead = force || (!hasAwareness && !staged && !regionsCoverEdit);

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
    editStepIds.push(editId);

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
  }

  if (verify && editStepIds.length > 0) {
    const lastEditId = editStepIds[editStepIds.length - 1];
    steps.push({
      id: makeStepId(intentId, 'verify'),
      use: 'verify.build',
      if: { step_ok: lastEditId },
    });
  }

  const allFiles = edits.map(e => e.file_path);
  const lookahead = computeNextTargets(intentId, 'intent.edit_multi', allFiles, context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};

function normalizeEdits(params: Record<string, unknown>): FileEdit[] {
  if (Array.isArray(params.edits)) {
    return (params.edits as Record<string, unknown>[]).map(e => ({
      file_path: (e.file_path as string) ?? '',
      line_edits: (e.line_edits as unknown[]) ?? [],
    }));
  }
  return [];
}
