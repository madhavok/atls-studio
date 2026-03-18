/**
 * intent.extract — extract symbols from source to a new target file.
 *
 * Uses change.refactor(action:execute) for cross-language support.
 * Works for TS/JS and Rust (split_match is Rust-only).
 *
 * Discipline: Symbols must be self-contained (no tangled dependencies).
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { AwarenessLevel } from '../snapshotTracker';
import { makeStepId, isFilePinned, getFileAwareness, computeNextTargets } from '../intents';

export const resolveExtract: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const sourceFile = (params.source_file as string) ?? '';
  const symbolNames = normalizeSymbols(params);
  const targetFile = (params.target_file as string) ?? '';
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'extract';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  const awareness = getFileAwareness(context.awareness, sourceFile);
  const hasAwareness = awareness != null && awareness.level >= AwarenessLevel.SHAPED;
  const pinned = isFilePinned(context.pinnedSources, sourceFile);

  const readId = makeStepId(intentId, 'read');
  const refactorId = makeStepId(intentId, 'refactor');
  const verifyId = makeStepId(intentId, 'verify');

  const needsRead = force || (!pinned && !hasAwareness);

  if (needsRead) {
    steps.push({
      id: readId,
      use: 'read.shaped',
      with: { file_paths: [sourceFile], shape: 'sig' },
    });
  }

  const refactorWith: Record<string, unknown> = {
    action: 'execute',
    file_paths: [sourceFile],
    to: targetFile,
  };
  if (symbolNames.length > 0) refactorWith.symbol_names = symbolNames;

  steps.push({
    id: refactorId,
    use: 'change.refactor',
    with: refactorWith,
  });

  steps.push({
    id: verifyId,
    use: 'verify.build',
    if: { step_ok: refactorId },
  });

  const lookahead = computeNextTargets(
    intentId, 'intent.extract', [sourceFile, targetFile].filter(Boolean), context,
  );
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};

function normalizeSymbols(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.symbol_names)) return params.symbol_names as string[];
  if (typeof params.symbol_name === 'string') return [params.symbol_name];
  if (typeof params.function_name === 'string') return [params.function_name];
  return [];
}
