/**
 * intent.understand — read, analyze, stage, and pin files with state-aware elision.
 *
 * Skips steps when the context already has coverage:
 * - File staged? skip read.shaped + session.stage
 * - File pinned? skip session.pin
 * - Deps in BB? skip analyze.deps
 * - Awareness >= SHAPED? skip read (but stage/pin may still be needed)
 * - Large file (readRegions end > 500)? add analyze.extract_plan
 *
 * Wiring rules:
 * - When read is emitted, stage and pin wire from read's refs via from_step
 * - When read is skipped (awareness hit), stage and pin are also skipped
 *   (the file is already in context from the prior read that created awareness)
 * - Pin always wires from read (not stage), since session.stage batch
 *   returns empty refs
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { AwarenessLevel } from '../snapshotTracker';
import { makeStepId, isFileStaged, isFilePinned, getFileAwareness, estimateFileLines, computeNextTargets, normalizeIntentFilePaths } from '../intents';

const LARGE_FILE_THRESHOLD = 500;

export const resolveUnderstand: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const filePaths = normalizeIntentFilePaths(params);
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'understand';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  for (let i = 0; i < filePaths.length; i++) {
    const fp = filePaths[i];
    const awareness = getFileAwareness(context.awareness, fp);
    const hasAwareness = awareness != null && awareness.level >= AwarenessLevel.SHAPED;
    const staged = isFileStaged(context.staged, fp);
    const pinned = isFilePinned(context.pinnedSources, fp);
    const depsKey = `deps:${fp}`;
    const hasDeps = context.bbKeys.has(depsKey);
    const fileLines = estimateFileLines(context.awareness, fp);
    const isLargeFile = fileLines > LARGE_FILE_THRESHOLD;

    const readId = makeStepId(intentId, 'read_shaped', i);
    const depsId = makeStepId(intentId, 'analyze_deps', i);
    const stageId = makeStepId(intentId, 'stage', i);
    const pinId = makeStepId(intentId, 'pin', i);
    const extractId = makeStepId(intentId, 'extract_plan', i);

    const needsRead = force || (!staged && !hasAwareness);
    const needsDeps = force || !hasDeps;

    if (needsRead) {
      steps.push({
        id: readId,
        use: 'read.shaped',
        with: { file_paths: [fp], shape: 'sig' },
      });

      if (force || !staged) {
        steps.push({
          id: stageId,
          use: 'session.stage',
          in: { hashes: { from_step: readId, path: 'refs' } },
        });
      }

      if (force || !pinned) {
        steps.push({
          id: pinId,
          use: 'session.pin',
          in: { hashes: { from_step: readId, path: 'refs' } },
        });
      }
    }

    if (needsDeps) {
      steps.push({
        id: depsId,
        use: 'analyze.deps',
        with: { file_paths: [fp], mode: 'related' },
      });
    }

    if (isLargeFile || force) {
      steps.push({
        id: extractId,
        use: 'analyze.extract_plan',
        with: { file_path: fp, strategy: 'by_cluster' },
        ...(needsRead ? { if: { step_has_refs: readId } } : {}),
      });
    }
  }

  const lookahead = computeNextTargets(intentId, 'intent.understand', filePaths, context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};
