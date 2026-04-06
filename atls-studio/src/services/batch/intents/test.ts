/**
 * intent.test — prepare context for writing tests.
 *
 * Reads source signatures and existing test file context, stages both,
 * and caches in BB. Does NOT write the test — prepares context only.
 * AI writes via intent.edit or intent.create on the next turn.
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { AwarenessLevel } from '../snapshotTracker';
import { makeStepId, isFileStaged, getFileAwareness } from '../intents';

function resolveSource(params: Record<string, unknown>): string {
  if (typeof params.source_file === 'string' && params.source_file.trim()) return params.source_file.trim();
  if (typeof params.file_path === 'string' && params.file_path.trim()) return params.file_path.trim();
  const ps = params.file_paths;
  if (Array.isArray(ps) && ps.length > 0) {
    const first = ps[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
  }
  return '';
}

export const resolveTest: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const sourceFile = resolveSource(params);
  const testFile = (params.test_file as string) ?? undefined;
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'test';

  const steps: Step[] = [];

  const bbKey = `test_context:${sourceFile}`;
  const hasCached = !force && context.bbKeys.has(bbKey);

  if (hasCached) {
    return { steps: [] };
  }

  const sourceReadId = makeStepId(intentId, 'source_read');
  const testReadId = makeStepId(intentId, 'test_read');
  const stageId = makeStepId(intentId, 'stage');
  const bbWriteId = makeStepId(intentId, 'bb_write');

  const sourceAwareness = getFileAwareness(context.awareness, sourceFile);
  const sourceHasAwareness = sourceAwareness != null && sourceAwareness.level >= AwarenessLevel.SHAPED;
  const sourceStaged = isFileStaged(context.staged, sourceFile);
  const needsSourceRead = force || (!sourceHasAwareness && !sourceStaged);

  if (needsSourceRead) {
    steps.push({
      id: sourceReadId,
      use: 'read.shaped',
      with: { file_paths: [sourceFile], shape: 'sig' },
    });
  }

  if (testFile) {
    const testAwareness = getFileAwareness(context.awareness, testFile);
    const testHasAwareness = testAwareness != null && testAwareness.level >= AwarenessLevel.SHAPED;
    const testStaged = isFileStaged(context.staged, testFile);
    const needsTestRead = force || (!testHasAwareness && !testStaged);

    if (needsTestRead) {
      steps.push({
        id: testReadId,
        use: 'read.context',
        with: { type: 'smart', file_paths: [testFile] },
      });
    }
  }

  if (needsSourceRead) {
    steps.push({
      id: stageId,
      use: 'session.stage',
      in: { hashes: { from_step: sourceReadId, path: 'refs' } },
    });
  }

  steps.push({
    id: bbWriteId,
    use: 'session.bb.write',
    with: {
      key: bbKey,
      content: `Test context for ${sourceFile}${testFile ? ` (extending ${testFile})` : ''}`,
    },
  });

  return { steps };
};
