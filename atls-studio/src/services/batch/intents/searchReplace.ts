/**
 * intent.search_replace — literal find/replace across files.
 *
 * Searches for old_text, emits capped edit slots with line numbers from search hits,
 * then verifies. Works ONLY for literal text replacement, not semantic transforms.
 *
 * Discipline: old_text must be exact. No regex. No AI reasoning about what to change.
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { makeStepId, computeNextTargets } from '../intents';

const DEFAULT_MAX_MATCHES = 10;

export const resolveSearchReplace: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const searchQuery = (params.search_query as string) ?? (params.old_text as string) ?? '';
  const oldText = (params.old_text as string) ?? '';
  const newText = (params.new_text as string) ?? '';
  const fileGlob = (params.file_glob as string) ?? undefined;
  const maxMatches = typeof params.max_matches === 'number'
    ? Math.min(params.max_matches, 20)
    : DEFAULT_MAX_MATCHES;
  const verify = params.verify !== false;
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'search_replace';

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  const bbKey = `search_replace:${oldText.slice(0, 40).replace(/\s+/g, '_')}`;
  const hasCached = !force && context.bbKeys.has(bbKey);

  if (hasCached) {
    return { steps: [] };
  }

  const searchId = makeStepId(intentId, 'search');
  const searchWith: Record<string, unknown> = { queries: [searchQuery] };
  if (fileGlob) searchWith.file_paths = [fileGlob];

  steps.push({
    id: searchId,
    use: 'search.code',
    with: searchWith,
  });

  const editStepIds: string[] = [];

  const replaceSpanLines = Math.max(1, oldText.split('\n').length);

  for (let i = 0; i < maxMatches; i++) {
    const editId = makeStepId(intentId, `edit_${i}`);
    editStepIds.push(editId);

    const editWith: Record<string, unknown> = {
      line_edits: [{
        action: 'replace',
        content: newText,
      }],
    };
    if (replaceSpanLines > 1) {
      editWith.replace_span_lines = replaceSpanLines;
    }

    steps.push({
      id: editId,
      use: 'change.edit',
      with: editWith,
      in: {
        file_path: { from_step: searchId, path: `content.file_paths.${i}` },
        line: { from_step: searchId, path: `content.lines.${i}` },
      },
      if: { step_has_refs: searchId },
    });
  }

  steps.push({
    id: makeStepId(intentId, 'bb_write'),
    use: 'session.bb.write',
    with: { key: bbKey, content: `Replaced "${oldText.slice(0, 40)}" with "${newText.slice(0, 40)}"` },
    if: { step_has_refs: searchId },
  });

  if (verify) {
    steps.push({
      id: makeStepId(intentId, 'verify'),
      use: 'verify.build',
      if: { step_has_refs: searchId },
    });
  }

  const lookahead = computeNextTargets(intentId, 'intent.search_replace', [], context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};
