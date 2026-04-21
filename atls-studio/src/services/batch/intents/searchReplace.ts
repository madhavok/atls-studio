/**
 * intent.search_replace — literal find/replace across files.
 *
 * Searches for old_text, emits per-hit-file text-replace edit slots, then
 * verifies. Works ONLY for literal text replacement, not semantic transforms.
 *
 * Edit shape: `{edits:[{file, old, new}], replace_all:true}` — dispatched to
 * the backend `replace` op via `resolve_edit_operation` (Rust), which
 * verifies the `old` substring exists in the file before writing. FTS false
 * positives (hits where the token appears but the literal string doesn't)
 * produce `Pattern not found` errors instead of corrupting unrelated lines.
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

// Tuned for literal find/replace across a project: FTS can rank a freshly
// created low-frequency file below the top-10 even when it's the only
// literal match. Since the backend `replace` op errors cheaply on files
// that don't contain `old_text` (`Pattern not found`, no disk write), a
// wider net is safe — spurious hits are filtered by the backend. 50 keeps
// us well below any per-batch step-count ceiling.
const DEFAULT_MAX_MATCHES = 50;
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

  /** Concrete path (no wildcards): bind file_path in `with`; search may still omit per-hit paths. */
  const isConcreteGlob = Boolean(fileGlob && !fileGlob.includes('*') && !fileGlob.includes('?'));

  for (let i = 0; i < maxMatches; i++) {
    const editId = makeStepId(intentId, `edit_${i}`);

    // Text-replace shape: the backend `replace` op verifies `old` exists in
    // the target file (errors `Pattern not found` otherwise) and replaces
    // only that substring, leaving surrounding content intact. `replace_all`
    // matches the intent's semantic — replace every occurrence in each hit
    // file. `resolve_edit_operation` routes `edits:[{old,new}]` to `replace`
    // when no line_edits/mode are present. `inheritSingleEditContext` folds
    // the top-level `file_path` into `edits[0].file`.
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
      // emitting cryptic skipped stubs.
      if: {
        step_content_array_nonempty: { step_id: searchId, path: 'file_paths' },
      },
    };

    if (!isConcreteGlob) {
      // Per-hit file binding. `content.file_paths` may include duplicates if
      // the same file had multiple hits; the second run on an already-
      // replaced file returns `Pattern not found` (clean, idempotent — no
      // corruption), so tolerating a few extra slots is fine.
      editStep.in = {
        file_path: { from_step: searchId, path: `content.file_paths.${i}` },
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
