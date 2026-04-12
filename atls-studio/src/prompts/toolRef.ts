/**
 * Tool reference for the collapsed batch-only surface.
 */

import { generateFamilyLines } from '../services/batch/families';
import { generateShorthandLegend } from '../services/batch/opShorthand';

export const BATCH_TOOL_REF = `## Batch Tool — line-per-step (shell = builds/git/packages ONLY; h:XXXX = universal pointer)
Pass q: one step per line. Format: STEP_ID <operation> key:val key:val
<operation> accepts short codes (see Short codes below) or full dotted names — never the literal string "USE" (some docs label the operation column that way for readability only).
Everything resolves through **workspace paths** and **h:XXXX** (UHPP). Arrays: comma-separated (ps:a.ts,b.ts). Quoted values for spaces/colons: content:"const x = 1;"
Complex values: inline {…} syntax where noted (le, creates).
Dataflow: in:stepId.path (e.g. in:r1.refs) binds prior step output into this step. **f**, **ps**, **hashes** must be real paths or **h:**… — never paste \`in:r1.refs\` as if it were a path or hash string. Conditional: if:stepId.ok. on_error:stop|continue|rollback

### *** PIN IN THE SAME BATCH — NON-NEGOTIABLE ***
Every read/search/verify returns VOLATILE h:refs. They are DESTROYED after one round.
You MUST include \`pi in:rN.refs\` (or \`pi hashes:h:XXXX,...\`) in the SAME q: block as the reads.
DO NOT defer pinning to a separate batch call — by then the refs are gone and you must re-read.
Correct: \`r1 rc ps:file.ts\` + \`p1 pi in:r1.refs\` in one q: block.
WRONG: batch 1 reads, batch 2 pins. The refs expired between batches.

### q: field — executable steps only
- \`q\` must contain **only** step lines (format above). Each non-empty line with two or more tokens is parsed and **executed** as a batch step.
- Do **not** paste commit messages, PR/description prose, bullets, or narration into \`q\` — those lines become fake steps and fail (unknown operation).
- Put explanations in normal assistant text. Lines in \`q\` used only as comments must start with \`#\` or \`--\` (parser skips them).
- \`bw\` content is a single quoted string — do not split prose across multiple steps. Correct: \`b1 bw key:findings content:"BUG — file.ts:fn, line 42. Return should be continue."\` Wrong: encoding each sentence of your findings as a separate batch step (they become invalid step IDs).

### JSON \`steps\` array (native batch args) — same discipline as \`q\`
When you pass \`batch\` with a \`steps\` array instead of line-oriented \`q\`:
- Each element must be a real step: \`id\` (short identifier) + \`use\` (operation name or short code) + optional \`with\` / \`in\` / \`if\`.
- **Never** put markdown headings, numbered outline lines, English sentences, or backtick-wrapped code fragments in \`id\` — use tokens like \`bw1\`, \`s1\`, \`p1\` only.
- **Never** put prose, placeholders, or punctuation alone in \`use\` — only registered operations (e.g. \`session.bb.write\`, \`search.issues\`, \`intent.search_replace\`).
- Narration and findings belong in the assistant message or in \`session.bb.write\` content — **not** as extra fake \`steps\`.
- Example JSON step (change.edit): \`{ "id": "e1", "use": "change.edit", "with": { "f": "src/utils/api.ts", "content_hash": "h:abc123", "le": [{ "line": 15, "end_line": 22, "content": "function auth() { return true; }" }] } }\`
  \`le\` must be an array of objects — never a raw string or split across multiple JSON keys.

### Operation Families
${generateFamilyLines()}

${generateShorthandLegend()}

### Common Params (short codes in Key above; full names always accepted)
sa subtask?:name summary:required
rc type:smart|full|module|component|test|tree ps:path1,path2 depth?:N glob?:pattern line_range?:start-end max_lines?:N
rs ps:path1,path2 shape:sig max_files?:N
rl hash:h:XXXX lines:15-50 | f:path sl:N el:N context_lines?:0-5
  For file/smart/raw engrams, lines are into that file snapshot. For sc/sy (search/symbol) result hashes, lines are into the formatted result text (engram body), not a source file — use f:+sl/el when you need real file lines.
rf ps:path1,path2 type?:smart|full — simpler than rc, no shaped/tree/bind support
sc qs:term1,term2 ps?:path1,path2 limit?:N compact?:true
sy sn:name1,name2 limit?:N
su sn:name1,name2 filter?:pattern limit?:N
sv type?:code|function|concept query?:text threshold?:N limit?:N
si ps?:path1 sf?:high|medium|low|all issue_mode?:correctness|all|security limit?:N
sp ps?:path1 patterns?:pattern1,pattern2
sm query:text regions?:active,archived,bb max_results?:N
ad|at|ai ps:path1 filter?:pattern limit?:N
ab sn:name1 ps:path1 action?:move
ac sn:name1,name2 depth?:N filter?:pattern limit?:N
ax f:path strategy?:by_cluster|by_prefix|by_kind min_lines?:N min_complexity?:N
ce f:h:XXXX:L-M le:[{content:"new code"}]
  Hash-ref editing: f carries hash identity + line range. content is the only required field per le entry.
  Minimal form: f:h:XXXX:15-50 le:[{content:"replacement"}] — hash proves snapshot, :L-M targets span, content is new text. No old text, no separate content_hash, no sl/el needed.
  Explicit form: f:path content_hash:h:XXXX le:[{line:N,end_line:M,content:"new code"}] — when editing by path or targeting a different range than the hash ref.
  Path minimal: f:.gitignore:1 le:[{content:"..."}] or f:.gitignore:1-1 — trailing :L or :L-M on a real path is split to path + range (same idea as hash :L-M).
  line + end_line: 1-based inclusive span. Auto-injected from hash ref range when omitted. end | -1 | symbol:fn(name) resolve to concrete bounds.
  action: defaults to replace when omitted. Other actions: insert_before, insert_after, delete, move, replace_body.
  move: requires destination:N (1-based). Produces positional shifts at both source and destination — auto-rebased in multi-step batches.
  replace_body: replaces function/class body (Rust: brace-delimited; Python: def/class/async def blocks by indent). Reported in edits_resolved.
  Intra-step coords: snapshot-style (relative to file before any edit in step); executor rebases.
  Response: edits_resolved:[{resolved_line,action,lines_affected}] — use for chaining, not mental math. On failure: suggestion:{line,confidence,tier,preview} when fuzzy match found.
  also: creates:[{path:p,content:c}] | revise:hash | undo:h:$last_edit | deletes:path1,path2
cc creates:[{path:p,content:c}]
cd ps:path1,path2 confirm?:true dry_run?:false
cf action:inventory|impact_analysis|execute|rollback|rename|move|extract ps?:path1 sn?:name1
cb restore:[{file:path,hash:h}] delete?:path1,path2
cm source_file:path target_dir:dir plan:[{module:name,symbols:[s1,s2]}] dry_run?:true
vb|vt|vl|vk target_dir?:dir workspace?:name runner?:name
xg action:status|diff|stage|unstage|commit|push|log|reset|restore files?:path1,path2 message?:"text" all?:true
xw action:list|search|add|remove|set_active|rescan
xe cmd:"command text"
dr query:"what to find" ff?:path1,path2 max_tokens?:N
dd query:"what to design" ff?:path1,path2
bw key:name content:"text"
br keys:key1,key2
bd keys:key1,key2
ru action?:set|delete|list key?:name content?:"text" — list needs only action:list (no key). set/delete need key (alias: hash → same as key for rule name).
em content:"text" type?:name
pi hashes:h:HASH1,h:HASH2 — or \`pi in:r1.refs\` (dataflow). **hashes** = **h:**… only; use \`in:r1.refs\` on the step line, not inside \`hashes\` as text.
pu hashes:h:HASH1,h:HASH2 — unpin (requires actual h:refs, not step IDs)
dro hashes:h:HASH1,h:HASH2 — or scope:dormant max?:N (drops without hashes). Set refs: h:@dormant (archived/cold), h:@dematerialized (last-round refs)
rec hashes:h:HASH1 — recall evicted/archived content back into context
pc hashes:h:HASH1,h:HASH2 tier?:pointer|sig — compact to digest
sh hash:h:XXXX — resolve + reshape a hash ref
sg hash:h:XXXX lines:start-end | content:"text" label:"name" — stage snippet (hash+lines or content+label)
ust hash:h:XXXX | label:"name" | hashes:h:H1,h:H2 — unstage (one of hash/label/hashes required)
ulo hashes:h:HASH1,h:HASH2 — unload engrams from context
ld ps:path1,path2 — load files into context
db|st|ch — no required params (debug, stats, compact history)
nn hash:h:XXXX note:"text" — annotate engram (not content — use eng for structured fields)
eng hash:h:XXXX fields:{note:"...",type:"..."} — structured engram edit
nk from:h:XXXX to:h:YYYY — link two engrams
nr hash:h:XXXX type:name — retype an engram
ns hash:h:XXXX at:N — split engram at line N
nm hashes:h:H1,h:H2,h:H3 — merge engrams (min 2)
iu ps:path1,path2 force?:true
ie f:path le:[...] verify?:true force?:true
im edits:[{f:p,le:[...]}] verify?:true
iv query:text ps?:path1
id ps?:path1 severity?:high query?:text
srv directory:dir depth?:N
ifr f:path strategy?:by_cluster|by_prefix|by_kind sn?:s1 target_file?:path — rename is cf action:rename, not ifr
ic target_path:path content:"text" ref_files?:path1 verify?:true
it source_file:path test_file?:path
is old_text:"text" new_text:"text" file_glob?:pattern max_matches?:N verify?:true
ix source_file:path sn?:s1 target_file:path — aliases: f, path, file_path, or ps:single_path

### Examples
r1 rc type:smart ps:src/api.ts,src/db.ts
p1 pi in:r1.refs
e1 ce f:h:abc123:15-22 le:[{content:"function auth() { return true; }"}]
-- minimal: hash ref carries identity + line range; only new content needed.
e2 ce f:src/api.ts content_hash:h:abc123 le:[{line:30,end_line:30,content:"const x = 1;"}]
-- explicit form: when editing by path or targeting a range not in the hash ref.
v1 vk if:e2.ok

p2 pi hashes:h:abc123,h:def456
-- WRONG: pi hashes:h:r1  (r1 is a step ID, not a content hash — use in:r1.refs instead)

u1 iu ps:src/api.ts
e3 ie f:h:abc123:10-10 le:[{content:"const x = 1;"}]

Path discipline: if a filename is ambiguous (exists in multiple dirs), use sy or the project tree to confirm the directory before rl. Wrong paths waste rounds and fragment spin tracking.

### Field Reference (canonical names — short aliases auto-resolved, response uses canonical)
f/file_path: single file (also: file, path, target_file, source_file; auto-promotes to ps for array ops)
ps/file_paths: array of paths/h:refs (also: files, paths)
content_hash: file content identity hash (also: snapshot_hash, hash)
h: short hash pointer (h:XXXX); refs/hashes: array of h:XXXX pointers
sn/symbol_names: symbol list (also: symbol, symbol_name)
qs/queries, le/line_edits, sl/start_line, el/end_line, sf/severity_filter, ff/focus_files — auto-resolved
key/keys, cmd also auto-resolved

### Task Recipes (follow the matching recipe)
Bug hunt: si -> rs(sig) top 3-5 suspects -> pi sigs -> rl + bw finding per fn -> fix confirmed -> task_complete
Feature: rs(sig) targets -> pi -> spl -> ce per subtask -> task_complete
Refactor: ax -> spl -> cf per extraction -> vb -> pi if failed (fix from h:ref) -> task_complete
Refactor (split): ax -> cm dry_run:true -> cm dry_run:false -> vb -> task_complete
Investigation: iv -> bw structured findings per target -> task_complete with report
Review: rs(sig) -> pi -> rl changed fns -> bw review finding per fn -> task_complete

### Read Pattern (standard two-step)
- Discovery: rs(sig) for structure -> pin what matters
- Targeted: rl for the specific function body to examine or edit
- DO NOT chain rs -> rl -> rc -> rf on same file. One read tool, pin, analyze, write finding.
- If the batch summary includes a **read spin** warning (\`<<WARN:\` / \`<<NUDGE:\`), you already have (or fragmented) coverage of that file — prefer **h:refs**, **bw**, or an **edit** over blind re-reads.

### Tool messages (read literally — not always "bugs")
- **redundant** (read.file / load / read.lines): Same revision already in context at the given **h:**. Do **not** repeat the same path read; use that **h:** in \`f\`, \`ce\`, or \`pi\`.
- **Read spin** (\`<<WARN:\` / \`<<NUDGE:\` in the batch summary): Tracked overlap on reads — not a hard stop. Still use **h:refs**, **bw**, or an **edit** rather than re-reading the same region.
- **SKIPPED (condition not met)**: A prior \`if:\` step failed — fix upstream.
- **SKIPPED (file_path not bound)** / **file_paths must resolve**: Fix **in:** bindings or add **ps** / **file_paths** where required (rc, rs, ab, ad, at, ai, etc.).
- **pin: no matching chunks**: **hashes** must list real **h:**… from tool output, or use step dataflow \`pi in:r1.refs\`. Never put the text \`in:r1.refs\` inside the **hashes** field.
- **change.edit** "file not found": **f** / **file_path** must be a real workspace path or **h:…** (optional :line span). Invalid: \`in:c1.refs[0]:2-4\` as **f**. After **cc**, use the **path** you created or **h:** from the create result.
- **edit_outside_read_range**: The edit targets lines not covered by a prior \`rl\` / \`read.lines\`. Read the target region first (same batch is ideal), then retry. When planning multi-region edits on the same file, read ALL target regions upfront before the edit step.
- **annotate.design** (\`nd\`): **Designer mode only** — in agent mode it always errors; skip family tests there.
- **VOLATILE / WILL BE LOST**: Result has h:refs that EXPIRE after ONE round. You MUST \`pi\` in the SAME batch or \`bw\` to persist. If you see this warning and did not pin, your content is already scheduled for deletion.
- **status:preview / dry_run** (cm, cd, cf): Preview only — no files written. If validation_issues is empty, re-submit the same plan with dry_run:false. Do NOT preview the same plan twice.

### Rules
- f/ps resolve from active workspace root. Subfolder prefix if monorepo (e.g. \`atls-studio/src/foo.ts\`).
- ps: actual paths or h:refs, not query strings. deletes/restore: paths or h:refs.
- vb|vt|vl|vk: subprocess uses PATH with ATLS_TOOLCHAIN_PATH prepended. xe runs in PTY (may see different PATH).
- xe: PowerShell — cmd saved to temp .ps1; prefer xg for git, vb|vt|vl|vk for checks.
- prefer cheapest tool: sigs -> rs; one symbol -> sy; types -> vk; file list -> rc(tree).
- use dr/dd when cheap research suffices before a bigger reasoning pass.`;

export const SUBAGENT_TOOL_REF = `

**DELEGATE** — dispatch a cheaper model as a specialized subagent inside batch
• dr query:"what to find" → searches code, pins relevant blocks, writes retriever:findings BB key
• dd query:"..." → planning research + writes design:research BB key
• dc query:"implement X" → edits files, verifies, writes coder:report BB key
• dt query:"test X" → writes/runs tests, iterates on failures, writes tester:results BB key
• ff?:path1,path2, max_tokens?:N, token_budget?:N are optional
Returns engram refs (not inline code) — pinned content appears in your next WM update.
Example:
d1 dr query:"authentication flow" ff:src/auth/
d2 dc query:"add input validation to UserService.create" ff:src/services/user.ts`;

export const NATIVE_TOOL_TOKENS_ESTIMATE = 100;

export const DESIGNER_TOOL_REF = `## Designer Tools — READ ONLY
Use batch with q: only — one step per line: STEP_ID <operation> key:val (short codes accepted)

Examples
s1 sc qs:auth,login
r1 rc type:smart ps:src/api.ts

d1 nd content:"# Plan" append:false
bb1 bw key:design-decisions content:"..."`;

