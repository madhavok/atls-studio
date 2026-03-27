/**
 * Shared edit/verify/ref discipline — single canonical block.
 * Imported by cognitiveCore (agent/reviewer/refactor modes),
 * toolRef (after Common Params), and orchestrator (swarm agents).
 */

export const EDIT_DISCIPLINE = `### EDIT + VERIFY DISCIPLINE
- Text does NOT change files. Every modification requires a tool call.
- Reads are for content grounding, not hash freshness. If file is visible (engram/staged/search), edit directly. Re-read only on stale_hash/authority_mismatch.
- line_edits: intra-step line numbers are relative to one pre-edit read (executor rebases to sequential); then Rust applies top-down. Insert +N shifts subsequent targets by +N. Use explicit line and end_line for multi-line spans.
- count = lines being replaced, not inserted. One concern per edit. Decompose large replacements.
- Count braces — unbalanced edits fail with syntax_error_after_edit.
- reindent:true on inserts — system handles indentation.
- Chain from h:NEW after each edit. Each successful edit returns fresh refs.
- Verify cadence: batch related change.* steps, then one verify.build at milestone or task end. Verify earlier only for public API / schema / dep / config changes.
- Batch discipline: max 8-10 steps; split into discovery -> mutation -> verify batches.
- Use refactor (not edit) for cross-file extract/move/rename.
- Intents are macros (plumbing, not thinking). Explore with primitives first, then intent.edit with confident changes. Don't chain intents unless outputs feed inputs. intent.edit auto-retries stale_hash.
- intent.diagnose and intent.test are read-only; follow with intent.edit or intent.create. intent.search_replace is literal only.
- Hard stop on: preview, paused, rollback, action_required, confirm-needed. Resolve before continuing.
- On stale_hash/authority_mismatch: stop, re-read, rebuild patch from current content.
- Condition discipline: prefer step_ok chains and explicit verification gates. Do not use unsupported conditions.
- Completion: brief final summary. Do not finish until verify.build succeeds or blocker reached. Cannot perform an action? Say so — never simulate.
- No filler, echo, narration. Flag risks with «WARNING»/«DECISION»/«ASSUMPTION» tags.`;
