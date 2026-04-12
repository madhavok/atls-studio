/**
 * Shared edit/verify/ref discipline — single canonical block (slim).
 * Imported by aiService (tool modes), toolRef, and orchestrator (swarm agents).
 * Defers freshness detail to runtime labels ([FRESH], [STALE], stale_hash).
 */

export const EDIT_DISCIPLINE = `### EDIT + VERIFY DISCIPLINE
- Edit from visible content (engram/staged/search). Edit results return [FRESH] refs with edits_resolved — chain from those.
- Hash-ref edits: f:h:XXXX:L-M le:[{content:"..."}]. Hash ref carries identity + line range; only new content needed.
- line_edits: line + end_line (1-based inclusive; single-line: end_line=line). action defaults to replace. line:"end" / negative indices / symbol+replace resolve to concrete bounds. move produces positional shifts — subsequent same-file edits are auto-rebased.
- move is line-based with no structural awareness. Moving a property/member out of its enclosing object/class will emit move_structural_warning. For object property or class member moves, prefer explicit replace or refactor tools.
- One concern per edit. Decompose large replacements. Count braces — unbalanced edits fail.
- Multi-region edits on the same file: read ALL target regions before the edit step. Edits in earlier regions shift line numbers of later regions — use edits_resolved coordinates (not original line numbers) for subsequent same-file edits in later steps.
- reindent:true on inserts — system handles indentation.
- Chain from h:NEW after each edit. Use edits_resolved for chaining, not mental math.
- Verify cadence: batch related change.* steps, then one vb at milestone or task end. Verify earlier only for public API / schema / dep / config changes.
- Batch discipline: max 8-10 steps; split into discovery -> mutation -> verify batches.
- Use refactor (not edit) for cross-file extract/move/rename.
- Intents are macros (plumbing, not thinking). Explore with primitives first, then ie with confident changes. ie auto-retries stale_hash.
- id and it are read-only; follow with ie or ic. is is literal only.
- Hard stop on: preview, paused, rollback, action_required, confirm-needed. Resolve before continuing.
- Tool failure pivot: diagnose the mismatch in one sentence, then call an alternative tool. cm needs named symbols — if the file has none, use ce first.
- On stale_hash: re-read once, rebuild patch. On pattern_not_found: check the suggestion field before re-reading.
- Condition discipline: prefer step_ok chains and explicit verification gates.
- Completion: brief final summary. Do not finish until vb succeeds or blocker reached. Cannot perform an action? Say so — never simulate.
- No filler, echo, narration. Flag risks with «WARNING»/«DECISION»/«ASSUMPTION» tags.

### CHANGE JUSTIFICATION
- Before any ce or ie, state in one sentence: what is broken and what observable behavior changes. "Adds reject parameter" is not justification if reject is never called.
- Behavioral changes require acknowledging the behavior change, not framing it as a "bug fix."
- Do not rewrite comments to match your edit and call that "fixing the comment/code mismatch."

### POST-EDIT CONTEXT
- Engrams auto-refresh after edit. Consult ## HASH MANIFEST for per-hash freshness before editing.
- On edit_outside_read_range: rl the region, retry in same batch.
- rl on **sc/sy** result hashes targets the formatted search/symbol text; use \`f\`+line range for file lines.`;
