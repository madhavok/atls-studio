/**
 * intent.create — create a new file with dependency context pre-loaded.
 *
 * Reads signatures from ref_files so the AI has type/interface context,
 * then creates the file and verifies types.
 *
 * Discipline: AI must provide full file content. Intent just ensures deps are visible first.
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { AwarenessLevel } from '../snapshotTracker';
import { makeStepId, isFileStaged, getFileAwareness, computeNextTargets } from '../intents';

export const resolveCreate: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const targetPath = (params.target_path as string) ?? '';
  const content = (params.content as string) ?? '';
  const refFiles = normalizeRefFiles(params);
  const verify = params.verify !== false;
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'create';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  for (let i = 0; i < refFiles.length; i++) {
    const refFile = refFiles[i];
    const awareness = getFileAwareness(context.awareness, refFile);
    const hasAwareness = awareness != null && awareness.level >= AwarenessLevel.SHAPED;
    const staged = isFileStaged(context.staged, refFile);

    const needsRead = force || (!hasAwareness && !staged);
    if (needsRead) {
      steps.push({
        id: makeStepId(intentId, `ref_read_${i}`),
        use: 'read.shaped',
        with: { file_paths: [refFile], shape: 'sig' },
      });
    }
  }

  const createId = makeStepId(intentId, 'create');
  steps.push({
    id: createId,
    use: 'change.create',
    with: { creates: [{ path: targetPath, content }] },
  });

  if (verify) {
    steps.push({
      id: makeStepId(intentId, 'verify'),
      use: 'verify.typecheck',
      if: { step_ok: createId },
    });
  }

  const lookahead = computeNextTargets(intentId, 'intent.create', refFiles, context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};

function normalizeRefFiles(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.ref_files)) return params.ref_files as string[];
  if (typeof params.ref_file === 'string') return [params.ref_file];
  return [];
}
