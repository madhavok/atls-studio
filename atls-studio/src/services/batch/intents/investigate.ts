/**
 * intent.investigate — search, read, stage, and cache results with BB-awareness.
 *
 * Skips steps when the context already has coverage:
 * - BB has prior results for similar query key? skip search, use cached
 * - Result files already staged? skip re-read
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { makeStepId, isFileStaged, computeNextTargets } from '../intents';

export const resolveInvestigate: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const query = (params.query as string) ?? '';
  const filePaths = normalizeFilePaths(params);
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'investigate';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  const bbKey = `investigate:${query.slice(0, 60).replace(/\s+/g, '_').toLowerCase()}`;
  const hasCachedResults = !force && context.bbKeys.has(bbKey);

  const searchId = makeStepId(intentId, 'search');
  const readId = makeStepId(intentId, 'read');
  const stageId = makeStepId(intentId, 'stage');
  const bbWriteId = makeStepId(intentId, 'bb_write');

  if (!hasCachedResults) {
    if (filePaths.length > 0) {
      steps.push({
        id: searchId,
        use: 'search.code',
        with: { queries: [query], file_paths: filePaths },
      });
    } else {
      steps.push({
        id: searchId,
        use: 'search.code',
        with: { queries: [query] },
      });
    }
  }

  const allFilesStaged = filePaths.length > 0 && filePaths.every(f => isFileStaged(context.staged, f));
  const needsRead = force || (!allFilesStaged && !hasCachedResults);

  if (needsRead) {
    if (!hasCachedResults) {
      steps.push({
        id: readId,
        use: 'read.context',
        with: { type: 'smart' },
        in: { file_paths: { from_step: searchId, path: 'content.file_paths' } },
        if: { step_has_refs: searchId },
      });
    } else if (filePaths.length > 0) {
      steps.push({
        id: readId,
        use: 'read.context',
        with: { type: 'smart', file_paths: filePaths },
      });
    }
  }

  const needsStage = force || !allFilesStaged;
  if (needsStage && !hasCachedResults) {
    steps.push({
      id: stageId,
      use: 'session.stage',
      in: { hashes: { from_step: readId, path: 'refs' } },
      if: { step_has_refs: readId },
    });
  }

  if (!hasCachedResults) {
    steps.push({
      id: bbWriteId,
      use: 'session.bb.write',
      with: { key: bbKey, content: `Investigation: ${query}` },
      in: { derived_from: { from_step: searchId, path: 'refs' } },
      if: { step_has_refs: searchId },
    });
  }

  const lookahead = computeNextTargets(intentId, 'intent.investigate', filePaths, context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};

function normalizeFilePaths(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.file_paths)) return params.file_paths as string[];
  if (typeof params.file_path === 'string') return [params.file_path];
  return [];
}
