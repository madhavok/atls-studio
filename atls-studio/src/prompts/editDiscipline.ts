/**
 * Shared edit/verify/ref discipline — single canonical block.
 * Imported by cognitiveCore (agent/reviewer/refactor modes),
 * toolRef (after Common Params), and orchestrator (swarm agents).
 */

export const EDIT_DISCIPLINE = `### EDIT + VERIFY DISCIPLINE
- Text does NOT change files. Every modification requires a tool call.
- Reads are for content grounding, not hash freshness. If file is visible (engram/staged/search), edit directly. Re-read only on stale_hash/authority_mismatch.
- Hash-ref edits: use file_path:h:XXXX:L-M line_edits:[{content:"..."}]. The hash ref carries identity + line range; only new content is needed. No old text echo, no separate content_hash, no line/end_line. Engrams show current content with line numbers — edit directly from what you see. After each edit, h:NEW ref is returned with edits_resolved. Chain within the same batch using edits_resolved line numbers. Across turns, the engram is refreshed with post-edit content — re-read only on stale_hash or external change.
- line_edits: intra-step line numbers are relative to one pre-edit read (executor rebases to sequential); then Rust applies top-down. Insert +N shifts subsequent targets by +N. Always provide line + end_line (1-based inclusive; single-line: end_line=line, omit defaults to line). line:"end" / negative indices / symbol+replace resolve to concrete bounds. action defaults to replace when omitted. move produces positional shifts at both source and destination — subsequent same-file edits are auto-rebased. replace_body body span is resolved by Rust.
- move is line-based with no structural awareness. Moving a property/member out of its enclosing object/class will emit move_structural_warning (hard error in strict mode). For object property or class member moves, prefer explicit replace (delete source + insert at destination) or refactor tools.
- One concern per edit. Decompose large replacements. Successful static verify auto-compacts working memory.
- Count braces — unbalanced edits fail with syntax_error_after_edit.
- reindent:true on inserts — system handles indentation.
- Chain from h:NEW after each edit. Each successful edit returns fresh refs and edits_resolved (per-edit resolved_line, action, lines_affected). Use edits_resolved for chaining, not mental math.
- Verify cadence: batch related change.* steps, then one vb at milestone or task end. Verify earlier only for public API / schema / dep / config changes.
- Batch discipline: max 8-10 steps; split into discovery -> mutation -> verify batches.
- Use refactor (not edit) for cross-file extract/move/rename.
- Intents are macros (plumbing, not thinking). Explore with primitives first, then ie with confident changes. Don't chain intents unless outputs feed inputs. ie auto-retries stale_hash.
- id and it are read-only; follow with ie or ic. is is literal only.
- Hard stop on: preview, paused, rollback, action_required, confirm-needed. Resolve before continuing.
- Tool failure pivot: if a tool returns validation errors or "not_found" for all inputs, do NOT re-read and re-plan. Diagnose the mismatch in one sentence, then call an alternative tool in the same batch or the next step. cm needs named symbols (fn/struct/enum) — if the file has none, use ce to create them first.
- On stale_hash/authority_mismatch: stop, re-read, rebuild patch from current content. content_hash enables shadow line remap (automatic line drift correction when file changed between read and edit).
- On pattern_not_found: check the suggestion field if present (line, confidence, tier) before re-reading — it may indicate a whitespace or indentation mismatch.
- Condition discipline: prefer step_ok chains and explicit verification gates. Do not use unsupported conditions.
- Completion: brief final summary. Do not finish until vb succeeds or blocker reached. Cannot perform an action? Say so — never simulate.
- No filler, echo, narration. Flag risks with «WARNING»/«DECISION»/«ASSUMPTION» tags.

### CHANGE JUSTIFICATION
- Before any ce or ie, state in one sentence: what is broken and what observable behavior changes. "Adds reject parameter" is not justification if reject is never called.
- Behavioral changes (e.g., switching from right-neighbor to left-neighbor tab selection) require acknowledging the behavior change, not framing it as a "bug fix."
- Do not rewrite comments to match your edit and call that "fixing the comment/code mismatch." If the comment is wrong, say so; if the code is wrong, prove it.

### MEMORY DISCIPLINE IN EDIT WORKFLOW
- Before editing: check the Pinned: line in working memory. If the target file is listed, edit directly — do NOT re-read.
- After reading for edit: pin the ref immediately. The edit will inherit the pin.
- After editing: the new h:ref is auto-pinned (inherits). Unpin old refs you no longer need.
- Multi-file edit sessions: pin all target sigs at start, edit in sequence, unpin+drop at end.
- If you get stale_hash: re-read ONCE, pin, then edit. Do not re-read again.

### POST-EDIT CONTEXT
- After each edit, the engram is refreshed with post-edit content and correct line numbers. The h:OLD..h:NEW diff ref and compact diff in BB edit:* are also available.
- Within a batch, chain from edits_resolved — the executor rebases line numbers between steps.
- Across turns, the engram has correct content. Re-read only on stale_hash, authority_mismatch, or external file change.
- On edit_outside_read_range: issue rl for the target region, then retry the edit in the same batch.`;
