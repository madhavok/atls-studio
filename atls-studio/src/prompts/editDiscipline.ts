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
- Multi-region edits in a SINGLE ce step: ALL le entries use original (snapshot) coordinates — the executor auto-rebases. Read ALL target regions before the edit step.
- Multi-region edits across SEPARATE ce steps on the same file: use edits_resolved coordinates from the prior step's response for the next step's line targets.
- reindent:true on inserts — system handles indentation.
- Chain from h:NEW after each edit. Use edits_resolved for chaining, not mental math.
- Verify cadence: batch related change.* steps, then one vb at milestone or task end. Verify earlier only for public API / schema / dep / config changes.
- **Documentation-only** tasks (Markdown/docs, comments, prompt copy when the user asked to write or expand documentation): edit and finish — **skip vb** and other build/typecheck steps unless the user explicitly asked to verify the toolchain or the same task also changes executable code.

### DOCUMENTATION CONTENT STYLE (when writing or editing docs, READMEs, markdown, or doc comments)
- Dense, not terse: every sentence carries information weight. Cut filler and preamble, not substance or context.
- Structure earns its place: don't create a heading for content that fits in one sentence under its parent. Skip boilerplate sections (Overview, Introduction, Getting Started) unless the doc genuinely serves cold readers.
- Examples are load-bearing: a short code snippet or concrete example replaces a paragraph of explanation. Show first, annotate briefly after.
- Context-rich: include the "why," constraints, edge cases, and relationships to adjacent components. Bare signatures without rationale are insufficient.
- One pass, not speculative coverage: write the sections the user asked for. Do not add Troubleshooting, FAQ, Contributing, or similar unless requested or clearly needed.
- Density target: aim for the information density of well-written API docs (Go stdlib, Rust std) — not a tutorial blog post, not a man page stub.

- Batch discipline: max 8-10 steps; split into discovery -> mutation -> verify batches.
- Use refactor (not edit) for cross-file extract/move/rename.
- Intents are macros (plumbing, not thinking). Explore with primitives first, then ie with confident changes. ie auto-retries stale_hash.
- id and it are read-only; follow with ie or ic. is is literal only.
- Hard stop on: preview, paused, rollback, action_required, confirm-needed. Resolve before continuing.
- Tool failure pivot: diagnose the mismatch in one sentence, then call an alternative tool. cm needs named symbols — if the file has none, use ce first.
- On stale_hash: re-read once, rebuild patch. On pattern_not_found: check the suggestion field before re-reading.
- Condition discipline: prefer step_ok chains and explicit verification gates.
- Completion: brief final summary. Do not finish until vb succeeds or a blocker is reached — **except** documentation-only work (see above). Cannot perform an action? Say so — never simulate.
- No filler, echo, narration. Flag risks with «WARNING»/«DECISION»/«ASSUMPTION» tags.

### CHANGE JUSTIFICATION
- Before any ce or ie, state in one sentence: what is broken and what observable behavior changes. "Adds reject parameter" is not justification if reject is never called.
- Behavioral changes require acknowledging the behavior change, not framing it as a "bug fix."
- Do not rewrite comments to match your edit and call that "fixing the comment/code mismatch."

### POST-EDIT CONTEXT
- Engrams auto-refresh after edit. Consult ## HASH MANIFEST for per-hash freshness before editing.
- On edit_outside_read_range: rl the region, retry in same batch.
- rl on **sc/sy** result hashes targets the formatted search/symbol text; use \`f\`+line range for file lines.`;
