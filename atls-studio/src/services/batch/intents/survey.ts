/**
 * intent.survey — read directory tree, stage sigs, cache in BB.
 *
 * Skips steps when the context already has coverage:
 * - tree:${directory} in BB? skip tree read
 * - Files already staged? only stage new ones
 *
 * prepareNext: read.shaped for hub files (highest import count from dep graph in BB).
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { makeStepId, isFileStaged, computeNextTargets } from '../intents';

export const resolveSurvey: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const directory = (params.directory as string) ?? '.';
  const depth = typeof params.depth === 'number' ? params.depth : 3;
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'survey';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  const treeKey = `tree:${directory}`;
  const hasTree = !force && context.bbKeys.has(treeKey);

  const treeReadId = makeStepId(intentId, 'tree_read');
  const sigReadId = makeStepId(intentId, 'sig_read');
  const stageId = makeStepId(intentId, 'stage');
  const bbWriteId = makeStepId(intentId, 'bb_write');
  const bbInvalidateId = makeStepId(intentId, 'bb_invalidate');

  if (!hasTree) {
    if (force) {
      steps.push({
        id: bbInvalidateId,
        use: 'session.bb.delete',
        with: { keys: [treeKey] },
      });
    }

    steps.push({
      id: treeReadId,
      use: 'read.context',
      with: { type: 'tree', file_paths: [directory], depth },
    });

    steps.push({
      id: sigReadId,
      use: 'read.shaped',
      with: { shape: 'sig' },
      in: { file_paths: { from_step: treeReadId, path: 'content.file_paths' } },
      if: { step_has_refs: treeReadId },
    });

    steps.push({
      id: stageId,
      use: 'session.stage',
      in: { hashes: { from_step: sigReadId, path: 'refs' } },
      if: { step_has_refs: sigReadId },
    });

    steps.push({
      id: bbWriteId,
      use: 'session.bb.write',
      with: { key: treeKey },
      in: { content: { from_step: treeReadId, path: 'content.tree' } },
      if: { step_ok: treeReadId },
    });
  }

  const lookahead = computeNextTargets(intentId, 'intent.survey', [directory], context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};
