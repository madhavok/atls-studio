/**
 * intent.refactor — full refactoring chain with state-aware elision.
 *
 * Composes with prior intents: if understand/survey already ran,
 * their results (pinned files, deps in BB, extract plans) are reused.
 *
 * Skips steps when the context already has coverage:
 * - File pinned from prior understand? skip read
 * - Deps in BB from prior survey? skip analyze.deps
 * - Extract plan in BB? skip analyze.extract_plan
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { makeStepId, isFilePinned, getFileAwareness, computeNextTargets } from '../intents';
import { AwarenessLevel } from '../snapshotTracker';

export const resolveRefactor: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const filePath = (params.file_path as string) ?? '';
  const strategy = (params.strategy as string) ?? 'by_cluster';
  const symbolNames = normalizeSymbols(params);
  const targetFile = params.target_file as string | undefined;
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'refactor';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  const awareness = getFileAwareness(context.awareness, filePath);
  const hasAwareness = awareness != null && awareness.level >= AwarenessLevel.SHAPED;
  const pinned = isFilePinned(context.pinnedSources, filePath);
  const depsKey = `deps:${filePath}`;
  const hasDeps = context.bbKeys.has(depsKey);
  const extractKey = `extract_plan:${filePath}`;
  const hasExtractPlan = context.bbKeys.has(extractKey);

  const readId = makeStepId(intentId, 'read_shaped');
  const pinId = makeStepId(intentId, 'pin');
  const depsId = makeStepId(intentId, 'analyze_deps');
  const extractId = makeStepId(intentId, 'extract_plan');
  const refactorId = makeStepId(intentId, 'refactor');
  const verifyId = makeStepId(intentId, 'verify');

  const needsRead = force || (!pinned && !hasAwareness);
  const needsPin = force || !pinned;
  const needsDeps = force || !hasDeps;
  const needsExtract = force || !hasExtractPlan;

  if (needsRead) {
    steps.push({
      id: readId,
      use: 'read.shaped',
      with: { file_paths: [filePath], shape: 'sig' },
    });
  }

  if (needsPin) {
    if (needsRead) {
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
      with: { file_paths: [filePath], mode: 'graph' },
    });
  }

  if (needsExtract) {
    steps.push({
      id: extractId,
      use: 'analyze.extract_plan',
      with: { file_path: filePath, strategy },
    });
  }

  const refactorWith: Record<string, unknown> = {
    action: 'execute',
    file_paths: [filePath],
  };
  if (symbolNames.length > 0) refactorWith.symbol_names = symbolNames;
  if (targetFile) refactorWith.to = targetFile;
  if (strategy) refactorWith.strategy = strategy;

  steps.push({
    id: refactorId,
    use: 'change.refactor',
    with: refactorWith,
    ...(needsExtract
      ? { if: { step_ok: extractId } }
      : {}),
  });

  steps.push({
    id: verifyId,
    use: 'verify.build',
    if: { step_ok: refactorId },
  });

  const lookahead = computeNextTargets(intentId, 'intent.refactor', [filePath], context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};

function normalizeSymbols(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.symbol_names)) return params.symbol_names as string[];
  if (typeof params.symbol_name === 'string') return [params.symbol_name];
  if (typeof params.function_name === 'string') return [params.function_name];
  return [];
}
