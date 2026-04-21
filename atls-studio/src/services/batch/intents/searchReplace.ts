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

  const sq = searchQuery.trim();
  const ot = oldText.trim();
  if (!sq && !ot) {
    return {
      steps: [
        {
          id: makeStepId(intentId, 'blocked'),
          use: 'session.emit',
          with: { label: 'intent.search_replace' },
        },
      ],
    };
  }

  const steps: Step[] = [];
  const prepareNext: Step[] = [];

  const bbKey = `search_replace:${oldText.slice(0, 40).replace(/\s+/g, '_')}`;
  const hasCached = !force && context.bbKeys.has(bbKey);

  if (hasCached) {
    return { steps: [] };
  }

  const searchId = makeStepId(intentId, 'search');
  const searchWith: Record<string, unknown> = {
    queries: [searchQuery],
    /** Align backend hit cap + structured `content.lines` length with edit slot count (default 10). */
    limit: maxMatches,
    max_file_paths: maxMatches,
  };
  if (fileGlob) searchWith.file_paths = [fileGlob];

  steps.push({
    id: searchId,
    use: 'search.code',
    with: searchWith,
  });

  const replaceSpanLines = Math.max(1, oldText.split('\n').length);
  /** Concrete path (no wildcards): bind file_path in `with`; search may still omit per-hit paths. */
  const isConcreteGlob = Boolean(fileGlob && !fileGlob.includes('*') && !fileGlob.includes('?'));

  for (let i = 0; i < maxMatches; i++) {
    const editId = makeStepId(intentId, `edit_${i}`);

    const editWith: Record<string, unknown> = {
      line_edits: [{
        action: 'replace',
        content: newText,
      }],
    };
    if (replaceSpanLines > 1) {
      editWith.replace_span_lines = replaceSpanLines;
    }

    if (isConcreteGlob) {
      editWith.file_path = fileGlob;
    }

    const editStep: Step = {
      id: editId,
      use: 'change.edit',
      with: editWith,
      // Gate each edit slot on the search having real hits so zero-hit
      // searches collapse to a clean "no replacements" rather than
      // emitting 10 cryptic skipped stubs.
      if: {
        step_content_array_nonempty: { step_id: searchId, path: 'file_paths' },
      },
    };

    if (isConcreteGlob) {
      editStep.in = {
        line: { from_step: searchId, path: `content.lines.${i}` },
      };
    } else {
      editStep.in = {
        file_path: { from_step: searchId, path: `content.file_paths.${i}` },
        line: { from_step: searchId, path: `content.lines.${i}` },
      };
    }

    steps.push(editStep);
  }

  // Gate bb_write + verify on the search actually producing hits — not
  // just on the step producing a wrapper result ref. `step_has_refs`
  // passes when search.code returns zero hits (the empty-result chunk is
  // still emitted as a ref), which previously led to a misleading
  // bb.write claiming the rename happened + a verify on no-op edits.
  const hasHits = {
    step_content_array_nonempty: { step_id: searchId, path: 'file_paths' },
  };

  steps.push({
    id: makeStepId(intentId, 'bb_write'),
    use: 'session.bb.write',
    with: { key: bbKey, content: `Replaced "${oldText.slice(0, 40)}" with "${newText.slice(0, 40)}"` },
    if: hasHits,
  });

  if (verify) {
    steps.push({
      id: makeStepId(intentId, 'verify'),
      use: 'verify.build',
      if: hasHits,
    });
  }

  const lookahead = computeNextTargets(intentId, 'intent.search_replace', [], context);
  prepareNext.push(...lookahead);

  return { steps, prepareNext };
};
