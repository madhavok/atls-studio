/**
 * intent.search_replace — literal find/replace across files.
 *
 * Searches for old_text, emits per-hit-file text-replace edit slots, then
 * verifies. Works ONLY for literal text replacement, not semantic transforms.
 *
 * Edit shape: `{edits:[{file, old, new}], replace_all:true}` — dispatched to
 * `change.edit`'s draft path, which preserves FileView/HPP freshness,
 * undo tracking, and lint-on-write while treating `old` as an exact content
 * anchor. Search is literal-filtered before expansion so FTS false positives
 * do not fan out into edit attempts.
 *
 * Historical bug: emitted `line_edits:[{action:'replace', content:new}]`
 * bound to a single line number from search hits. That replaced the ENTIRE
 * line at the hit position regardless of whether the line contained `old` —
 * combined with FTS's token-level matching, it clobbered unrelated code in
 * files that merely contained any token from the query. The text-replace
 * shape sidesteps that entirely.
 *
 * Discipline: old_text must be exact. No regex. No AI reasoning about what to change.
 */

import type { IntentResolver, IntentResult, IntentContext, Step } from '../types';
import { makeStepId, computeNextTargets } from '../intents';

// Tuned for literal find/replace across a project: each slot targets one
// UNIQUE hit file (see `content.unique_file_paths` binding below), not a
// per-hit slot, so 20 slots cover most realistic refactors. Unique-file
// binding also avoids the old "file has 5 hits → slot 0 replaces all, slots
// 1-4 then get Pattern not found" noise. Backend's `replace` op still
// handles FTS false positives cheaply (no disk write), so raising via
// `max_matches` up to the ceiling is safe.
const DEFAULT_MAX_MATCHES = 20;
const MAX_MATCHES_CEILING = 100;

export const resolveSearchReplace: IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
): IntentResult => {
  const searchQuery = (params.search_query as string) ?? (params.old_text as string) ?? '';
  const oldText = (params.old_text as string) ?? '';
  const newText = (params.new_text as string) ?? '';
  const fileGlob = (params.file_glob as string) ?? undefined;
  const maxMatches = typeof params.max_matches === 'number'
    ? Math.min(params.max_matches, MAX_MATCHES_CEILING)
    : DEFAULT_MAX_MATCHES;
  const verify = params.verify !== false;
  const force = params.force === true;
  const intentId = (params._intentId as string) ?? 'search_replace';

  const ot = oldText.trim();
  if (!ot) {
    return {
      steps: [
        {
          id: makeStepId(intentId, 'blocked'),
          use: 'session.emit',
          with: {
            label: 'intent.search_replace',
            content: 'intent.search_replace requires exact old_text; no edits were emitted.',
          },
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
    queries: [oldText || searchQuery],
    exact_text: oldText,
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

  /** Concrete path (no wildcards): bind file_path in `with`; search may still omit per-hit paths. */
  const isConcreteGlob = Boolean(fileGlob && !fileGlob.includes('*') && !fileGlob.includes('?'));

  for (let i = 0; i < maxMatches; i++) {
    const editId = makeStepId(intentId, `edit_${i}`);

    // Text-replace shape stays on `change.edit`'s draft route: the primitive
    // verifies `old` exists, preserves FileView/HPP freshness semantics, and
    // replaces only that substring. `replace_all` matches the intent's
    // semantic — replace every occurrence in each literal-hit file.
    const editWith: Record<string, unknown> = {
      edits: [{ old: oldText, new: newText }],
      replace_all: true,
    };

    if (isConcreteGlob) {
      editWith.file_path = fileGlob;
    }

    const editStep: Step = {
      id: editId,
      use: 'change.edit',
      with: editWith,
      // Gate each edit slot on the search having real hits so zero-hit
      // searches collapse to a clean "no replacements" rather than
      // emitting cryptic skipped stubs. Gate against the deduped list
      // so the presence/absence signal matches the binding source.
      if: {
        step_content_array_nonempty: { step_id: searchId, path: 'unique_file_paths' },
      },
    };

    if (!isConcreteGlob) {
      // Per-unique-file binding: `content.unique_file_paths` has first-
      // occurrence order with duplicates removed, so each slot targets a
      // distinct file. Combined with `replace_all:true`, one slot per file
      // is sufficient — no wasted "Pattern not found" retries on files that
      // the previous slot already rewrote.
      editStep.in = {
        file_path: { from_step: searchId, path: `content.unique_file_paths.${i}` },
      };
    }

    steps.push(editStep);
  }

  // Gate bb_write + verify on the search actually producing hits — not
  // just on the step producing a wrapper result ref. `step_has_refs`
  // passes when search.code returns zero hits (the empty-result chunk is
  // still emitted as a ref), which previously led to a misleading
  // bb.write claiming the rename happened + a verify on no-op edits.
  // Check the deduped list to match the edit-slot binding source.
  const hasHits = {
    step_content_array_nonempty: { step_id: searchId, path: 'unique_file_paths' },
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
