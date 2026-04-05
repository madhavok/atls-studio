/**
 * intent.diagnose — discover issues, read affected context, analyze impact, cache.
 *
 * The discovery half of "fix this error". Prepares everything for intent.edit next turn.
 * Does NOT emit any change.* steps — output is cached analysis only.
 *
 * Pipeline: search.issues -> read.context -> analyze.impact -> session.stage -> session.bb.write
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { makeStepId, isFileStaged, computeNextTargets, normalizeIntentFilePaths } from '../intents';

export const resolveDiagnose: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const filePaths = normalizeIntentFilePaths(params);
  const severity = (params.severity as string) ?? undefined;
  const query = (params.query as string) ?? '';
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'diagnose';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  const bbKey = buildBBKey(filePaths, query);
  const hasCached = !force && context.bbKeys.has(bbKey);

  const searchId = makeStepId(intentId, 'search_issues');
  const readId = makeStepId(intentId, 'read');
  const impactId = makeStepId(intentId, 'impact');
  const stageId = makeStepId(intentId, 'stage');
  const bbWriteId = makeStepId(intentId, 'bb_write');

  if (!hasCached) {
    const searchWith: Record<string, unknown> = {};
    if (filePaths.length > 0) searchWith.file_paths = filePaths;
    if (severity) searchWith.severity_filter = severity;
    if (query) searchWith.category = query;

    steps.push({
      id: searchId,
      use: 'search.issues',
      with: searchWith,
    });

    const allFilesStaged = filePaths.length > 0
      && filePaths.every(f => isFileStaged(context.staged, f));

    if (!allFilesStaged) {
      if (filePaths.length > 0) {
        steps.push({
          id: readId,
          use: 'read.context',
          with: { type: 'smart', file_paths: filePaths },
          if: { step_has_refs: searchId },
        });
      } else {
        steps.push({
          id: readId,
          use: 'read.context',
          with: { type: 'smart' },
          in: { file_paths: { from_step: searchId, path: 'content.file_paths' } },
          if: { step_has_refs: searchId },
        });
      }
    }

    steps.push({
      id: impactId,
      use: 'analyze.impact',
      ...(filePaths.length > 0
        ? { with: { file_paths: filePaths } }
        : { in: { file_paths: { from_step: searchId, path: 'content.file_paths' } } }),
      if: { step_has_refs: searchId },
    });

    steps.push({
      id: stageId,
      use: 'session.stage',
      in: { hashes: { from_step: readId, path: 'refs' } },
      if: { step_has_refs: readId },
    });

    steps.push({
      id: bbWriteId,
      use: 'session.bb.write',
      with: { key: bbKey, content: `Diagnosis: ${query || filePaths.join(', ')}` },
      in: { derived_from: { from_step: searchId, path: 'refs' } },
      if: { step_has_refs: searchId },
    });
  }

  const lookahead = computeNextTargets(intentId, 'intent.diagnose', filePaths, context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};

function buildBBKey(filePaths: string[], query: string): string {
  const slug = query
    ? query.slice(0, 60).replace(/\s+/g, '_').toLowerCase()
    : filePaths.slice(0, 3).join(',').slice(0, 60).replace(/\s+/g, '_').toLowerCase();
  return `diagnose:${slug}`;
}
