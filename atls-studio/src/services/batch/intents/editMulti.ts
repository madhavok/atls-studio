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
import { makeStepId, isFileStaged, getFileAwareness, computeNextTargets, resolveAwarenessPathBySuffix } from '../intents';
import { normalizeStepParams } from '../paramNorm';
import { RECOVERABLE_EDIT_ERROR_CLASSES } from './editCommon';

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
    const endLine = typeof e.end_line === 'number' ? e.end_line : line;
    if (line != null) {
      if (line < min) min = line;
      if ((endLine ?? line) > max) max = endLine ?? line;
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
    const { file_path: rawFilePath, line_edits: lineEdits } = edits[i];

    // Resolve workspace-abbreviated paths (`utils/foo.ts`) to the canonical
    // key stored in awareness (`src/utils/foo.ts`) before making read
    // decisions. Without this, the macro would re-read an already-loaded
    // file (or, worse, emit edits whose gate lookup can't find the read).
    const resolvedPath = resolveAwarenessPathBySuffix(context.awareness, rawFilePath) ?? rawFilePath;

    const awareness = getFileAwareness(context.awareness, resolvedPath);
    const hasAwareness = awareness != null && awareness.level >= AwarenessLevel.SHAPED;
    const staged = isFileStaged(context.staged, resolvedPath);
    const editRange = extractEditRange(lineEdits);

    const readId = makeStepId(intentId, `read_${i}`);
    const editId = makeStepId(intentId, `edit_${i}`);
    const retryReadId = makeStepId(intentId, `retry_read_${i}`);
    const retryEditId = makeStepId(intentId, `retry_edit_${i}`);

    const regionsCoverEdit = hasAwareness && editRange != null && awareness != null
      && awareness.readRegions.some(r => r.start <= editRange.start && r.end >= editRange.end);

    // Read when the target region isn't already covered by awareness or a
    // staged snippet. Previously this also required `!hasAwareness`, which
    // meant a file that had only been sig-shaped (awareness present, no
    // line-level regions) would skip the read and then trip the executor's
    // read-coverage gate at edit time.
    const needsRead = force || (!staged && !regionsCoverEdit);

    if (needsRead && editRange) {
      steps.push({
        id: readId,
        use: 'read.lines',
        with: {
          file_path: resolvedPath,
          start_line: Math.max(1, editRange.start - 5),
          end_line: editRange.end + 5,
        },
      });
    } else if (needsRead) {
      steps.push({
        id: readId,
        use: 'read.shaped',
        with: { file_paths: [resolvedPath], shape: 'sig' },
      });
    }

    steps.push({
      id: editId,
      use: 'change.edit',
      with: { file_path: resolvedPath, line_edits: lineEdits },
    });
    editStepIds.push(editId);

    if (editRange) {
      steps.push({
        id: retryReadId,
        use: 'read.lines',
        with: {
          file_path: resolvedPath,
          start_line: Math.max(1, editRange.start - 5),
          end_line: editRange.end + 5,
        },
        if: { step_error_class_in: { step_id: editId, classes: RECOVERABLE_EDIT_ERROR_CLASSES } },
      });
    } else {
      steps.push({
        id: retryReadId,
        use: 'read.shaped',
        with: { file_paths: [resolvedPath], shape: 'sig' },
        if: { step_error_class_in: { step_id: editId, classes: RECOVERABLE_EDIT_ERROR_CLASSES } },
      });
    }

    steps.push({
      id: retryEditId,
      use: 'change.edit',
      with: { file_path: resolvedPath, line_edits: lineEdits },
      if: { step_error_class_in: { step_id: editId, classes: RECOVERABLE_EDIT_ERROR_CLASSES } },
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
    return (params.edits as Record<string, unknown>[]).map((e) => {
      const n = normalizeStepParams('change.edit', e && typeof e === 'object' ? { ...e } : {});
      return {
        file_path: (n.file_path as string) ?? '',
        line_edits: (n.line_edits as unknown[]) ?? [],
      };
    });
  }
  return [];
}
