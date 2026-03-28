/**
 * Shared edit/verify/ref discipline — single canonical block.
 * Imported by cognitiveCore (agent/reviewer/refactor modes),
 * toolRef (after Common Params), and orchestrator (swarm agents).
 */

export const EDIT_DISCIPLINE = `### EDIT + VERIFY DISCIPLINE
- Text does NOT change files. Every modification requires a tool call.
- Reads are for content grounding, not hash freshness. If file is visible (engram/staged/search), edit directly. Re-read only on stale_hash/authority_mismatch.
- line_edits: intra-step line numbers are relative to one pre-edit read (executor rebases to sequential); then Rust applies top-down. Insert +N shifts subsequent targets by +N. Use explicit line and end_line for multi-line spans; line:"end" / negative indices / symbol+replace avoid manual line hunting.
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
- Tool failure pivot: if a tool returns validation errors or "not_found" for all inputs, do NOT re-read and re-plan. Diagnose the mismatch in one sentence, then call an alternative tool in the same batch or the next step. split_module needs named symbols (fn/struct/enum) — if the file has none, use change.edit to create them first.
- On stale_hash/authority_mismatch: stop, re-read, rebuild patch from current content.
- Condition discipline: prefer step_ok chains and explicit verification gates. Do not use unsupported conditions.
- Completion: brief final summary. Do not finish until verify.build succeeds or blocker reached. Cannot perform an action? Say so — never simulate.
- No filler, echo, narration. Flag risks with «WARNING»/«DECISION»/«ASSUMPTION» tags.

### CHANGE JUSTIFICATION
- Before any change.edit or intent.edit, state in one sentence: what is broken and what observable behavior changes. "Adds reject parameter" is not justification if reject is never called.
- Behavioral changes (e.g., switching from right-neighbor to left-neighbor tab selection) require acknowledging the behavior change, not framing it as a "bug fix."
- Do not rewrite comments to match your edit and call that "fixing the comment/code mismatch." If the comment is wrong, say so; if the code is wrong, prove it.

### MEMORY DISCIPLINE IN EDIT WORKFLOW
- Before editing: check if file is already pinned/staged. If yes, edit directly — do NOT re-read.
- After reading for edit: pin the ref immediately. The edit will inherit the pin.
- After editing: the new h:ref is auto-pinned (inherits). Unpin old refs you no longer need.
- Multi-file edit sessions: pin all target sigs at start, edit in sequence, unpin+drop at end.
- If you get stale_hash: re-read ONCE, pin, then edit. Do not re-read again.`;
