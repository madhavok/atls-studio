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

### RETENTION — one ref, auto-persisted
Reads (rs/rl/rc/rf) auto-pin their FileView — the returned \`h:<short>\` survives across rounds automatically. Every ref is \`h:<short>\`; the runtime resolves whether it's a view or a chunk.
Non-read refs (search, verify, exec, git) that a later step in the same batch consumes are auto-persisted. For cross-round persistence, use \`pi\` (by hash or step id: \`pi r1\`) or \`bw\`.
Release: \`pu\` when done, \`pc\` to compact, \`dro\` to delete. \`pi/pu/pc/dro\` accept hashes or step ids (\`pu r1\`). ASSESS surfaces stale pins for cleanup.

### q: field — executable steps only
- \`q\` must contain **only** step lines (format above). Each non-empty line with two or more tokens is parsed and **executed** as a batch step.
- Do **not** paste commit messages, PR/description prose, bullets, or narration into \`q\` — those lines become fake steps and fail (unknown operation).
- Put explanations in normal assistant text. Lines in \`q\` used only as comments must start with \`#\` or \`--\` (parser skips them).
- \`bw\` content is a single quoted string — do not split prose across multiple steps. Correct: \`b1 bw key:findings content:"BUG — file.ts:fn, line 42. Return should be continue."\` Wrong: encoding each sentence of your findings as a separate batch step (they become invalid step IDs).

### Never emit \`_stubbed\` / \`_compressed\`
If you see \`{"_stubbed": "...", "_compressed": true}\` in your own prior tool_use inputs, that is post-hoc history compression — **not a callable shape**. The runtime rewrites large past batch inputs to that sentinel to save tokens; it is never something you should produce. Always emit real \`steps\` or a \`q:\` DSL block. The batch executor rejects envelopes containing \`_stubbed\` or \`_compressed\` with an explicit error.

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
sa subtask?:id summary:required — \`subtask\` is the id **before** the colon in spl (e.g. \`analyze\`, NOT the title \`Inspect\`). Omit to advance the currently active subtask. There is no \`subtask:*\` operation; never set \`use\` to \`subtask:...\`.
spl goal:"required" subtasks:["id1:Title1","id2:Title2"] — JSON array of id:title strings works in both q: and structured JSON. Also accepted: [{id,title},...] array of objects, {id1:"Title1",id2:"Title2"} object-of-strings, or "id1:Title1,id2:Title2" comma-separated string (q: line form only). tasks/plan/list/items aliased to subtasks. h: prefixes are labels, not UHPP expansion targets.
rc type:full|tree ps:path1,path2 depth?:N glob?:pattern line_range?:start-end max_lines?:N
  type:full = whole-file body. type:tree = directory listing (not file content).
  Any file read returns ONE retention ref per file: h:<short> — the FileView identity. Auto-pinned; unpin (pu) when you're done.
rl hash:h:XXXX lines:15-50 | f:path sl:N el:N context_lines?:0-5
  Prefer when you already have line bounds (search hits, sig [A-B] folds, errors, git). Line slices fill into the file's live FileView at their source position. The returned ref is the SAME h:<short> as any prior rs/rf/rc on that file — multiple rl calls merge into the same view identity. Auto-pinned. For sc/sy (search/symbol) result hashes, lines are into the formatted result text (engram body), not a source file — use f:+sl/el when you need real file lines.
rs ps:path1,path2 shape:sig|fold|grep|dedent|nocomment|exclude|concept|pattern|if|snap|refs|highlight max_files?:N
  shape:sig — use when opening a file without slice coordinates yet: indent-preserved skeleton (code) / heading outline (markdown), ~5-10% of full size, with [A-B] fold markers. If search/tools already gave path + lines, skip to **rl** instead. Still prefer **sig** over **rf** / **rc type:full** when you only need structure. shape: is required. Returns h:<short> (auto-pinned); subsequent rl into the same file uses the same ref.
rf ps:path1,path2 type?:full — smart view (symbols + imports + related + issues) by default; type:full for the whole body. HEAVIER than rs shape:sig; reach for it only when you need the dependency graph, issues list, or full content. Returns h:<short> (auto-pinned), same as rs/rl for the same file.
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
ag sn:name1 mode?:callees|callers|subgraph depth?:N ps?:path1 symbols?:name1,name2
ax f:path strategy?:by_cluster|by_prefix|by_kind min_lines?:N min_complexity?:N
ce f:h:XXXX:L-M le:[{content:"new code"}]
  Hash-ref editing: f carries hash identity + line range. content is the only required field per le entry.
  Minimal form: f:h:XXXX:15-50 le:[{content:"replacement"}] — hash proves snapshot, :L-M targets span, content is new text. No old text, no separate content_hash, no sl/el needed.
  Explicit form: f:path content_hash:h:XXXX le:[{line:N,end_line:M,content:"new code"}] — when editing by path or targeting a different range than the hash ref.
  Path minimal: f:.gitignore:1 le:[{content:"..."}] or f:.gitignore:1-1 — trailing :L or :L-M on a real path is split to path + range (same idea as hash :L-M).
  line + end_line: 1-based inclusive span. Auto-injected from hash ref range when omitted. end | -1 | symbol:fn(name) resolve to concrete bounds.
  action: defaults to replace when omitted. Other actions: insert_before, insert_after, delete, move, replace_body.
  All actions that change line counts (insert_before, insert_after, delete, move, replace with different length) produce positional shifts — auto-rebased across le entries within the same ce step and across ce steps in the same batch.
  move: additionally requires destination:N (1-based).
  replace_body: replaces function/class body (Rust: brace-delimited; Python: def/class/async def blocks by indent). Reported in edits_resolved. Use as the sole le entry in its step — intra-step rebase cannot pre-compute its line delta.
  Intra-step coords: ALL le entries use snapshot-style coordinates (relative to file BEFORE any edit in this step). The executor rebases automatically. Do NOT manually compute shifted line numbers.
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
bl — enumerate BB keys (no params; reports active and superseded sections)
ru action?:set|delete|list key?:name content?:"text" — list needs only action:list (no key). set/delete need key (alias: hash → same as key for rule name).
em content:"text" type?:name
pi hashes:h:HASH1,h:HASH2 — or \`pi in:r1.refs\` (dataflow). Reads auto-pin their FileView; use \`pi\` only for **non-read** results (search/verify/exec) or to re-pin with a different shape. **hashes** = **h:**… only; use \`in:r1.refs\` on the step line, not inside \`hashes\` as text.
pu hashes:h:HASH1,h:HASH2 — unpin (requires actual h:refs, not step IDs). Any chunk ref whose source has a FileView transparently unpins the view.
dro hashes:h:HASH1,h:HASH2 — or scope:dormant|archived max?:N (drops without hashes). Dropping a FileView ref (any h:<short> that resolves to a view, or any chunk ref for that file) removes the whole view + its backing chunks. Set refs: h:@dormant (archived/cold), h:@dematerialized (last-round refs)
rec hashes:h:HASH1 — recall evicted/archived content back into context
pc hashes:h:HASH1,h:HASH2 tier?:pointer|sig — compact to digest
sh hash:h:XXXX — resolve + reshape a hash ref
sg hash:h:XXXX lines:start-end | content:"text" label:"name" — stage snippet (hash+lines or content+label)
ust hash:h:XXXX | label:"name" | hashes:h:H1,h:H2 — unstage (one of hash/label/hashes required)
ulo hashes:h:HASH1,h:HASH2 — unload engrams from context
db|st|ch — no required params (debug, stats, compact history)
nn hash:h:XXXX note:"text" and/or fields:{digest,summary,type} — attach a note and/or edit engram metadata
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
r1 rs ps:src/api.ts,src/db.ts shape:sig
-- read auto-pins the FileView for src/api.ts and src/db.ts; no p1 pi step needed.
e1 ce f:h:abc123:15-22 le:[{content:"function auth() { return true; }"}]
-- minimal: hash ref carries identity + line range; only new content needed.
e2 ce f:src/api.ts content_hash:h:abc123 le:[{line:30,end_line:30,content:"const x = 1;"}]
-- explicit form: when editing by path or targeting a range not in the hash ref.
v1 vk if:e2.ok

s1 sc qs:authenticate ps:src
p2 pi in:s1.refs
-- search result refs ARE volatile — pin in the same batch if you want to keep them.
-- (reads skip this step; they auto-pin.)

u1 iu ps:src/api.ts
e3 ie f:h:abc123:10-10 le:[{content:"const x = 1;"}]

-- multi-region edit in one step: use ORIGINAL line numbers for all le entries (executor rebases)
e4 ce f:h:abc123 le:[{line:10,end_line:12,action:insert_after,content:"// inserted"},{line:50,end_line:55,content:"replaced block"}]
-- line 50 is the ORIGINAL line, not 50+inserted_lines. The executor handles the shift.

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
Bug hunt: si -> top 3-5 suspects: **rl** when hits include file lines, else **rs shape:sig** then **rl** at [A-B] folds + bw finding per fn -> fix confirmed -> task_complete
Feature: **rl** targets with known lines, else **rs shape:sig** -> spl -> **rl** slices at [A-B] folds -> ce per subtask -> task_complete
Refactor: ax -> spl -> cf per extraction -> vb -> fix from h:ref if failed -> task_complete
Refactor (split): ax -> cm dry_run:true -> cm dry_run:false -> vb -> task_complete
Investigation: iv -> bw structured findings per target -> task_complete with report
Review: targets with lines -> **rl**; else **rs shape:sig** -> **rl** changed fns at [A-B] folds -> bw review finding per fn -> task_complete
(Reads auto-pin; no explicit pi step in these recipes. pu finished targets before moving on.)

### Read Pattern (FileView — one hash per file, auto-healing, cheapest first)
- No line targets yet: **rs shape:sig** — cheap skeleton with [A-B] fold markers, then **rl** those spans. Returns \`h:<short>\` (auto-pinned).
- Already have path + lines: **rl sl:A el:B** — same FileView \`h:<short>\`.
- More slices: **rl** again — merges into the same view.
- Full body: **rc type:full** / **rf type:full** only when slicing isn't enough.
- Release: **pu** when done, **pc** to compact, **dro** to delete. ASSESS surfaces stale pins.
- Edits: pass the fence ref (\`h:<short>\`) to \`content_hash\` or \`f:h:<short>\`. Runtime resolves the current source revision internally.
- Markers: \`[edited L..-.. this round]\` — reconsider prior reasoning. \`[REMOVED was L..-..]\` / \`[UNRECOVERABLE: …]\` — re-read if you need that content.

### Tool messages (read literally)
- **reused** (read.file / load / read.lines): Same content already at the given **h:**. Use that **h:** directly — runtime did not re-read.
- **Read spin** (\`<<WARN:\` / \`<<NUDGE:\`): Tracked overlap on reads. Use **h:refs**, **bw**, or an **edit** rather than re-reading.
- **SKIPPED (condition not met)**: A prior \`if:\` step failed — fix upstream.
- **SKIPPED (file_path not bound)** / **file_paths must resolve**: Fix **in:** bindings or add **ps** / **file_paths**.
- **pin: no matching refs**: **hashes** must list real **h:**… from tool output, or use a step id directly (\`pi r1\`).
- **change.edit** "file not found": **f** / **file_path** must be a real workspace path or **h:**… (optional :line span).
- **target region not yet read**: Read the target region first (same batch is ideal), then retry.
- **content changed — re-read and retry**: File changed externally; re-read and retry.
- **annotate.design** (\`nd\`): Designer mode only; skip in agent mode.
- **status:preview / dry_run** (cm, cd, cf): Preview only. If validation_issues is empty, re-submit the same plan with dry_run:false.

### Rules
- f/ps resolve from active workspace root. Subfolder prefix if monorepo (e.g. \`atls-studio/src/foo.ts\`).
- ps: actual paths or h:refs, not query strings. deletes/restore: paths or h:refs.
- vb|vt|vl|vk: subprocess uses PATH with ATLS_TOOLCHAIN_PATH prepended. xe runs in PTY (may see different PATH).
- xe: PowerShell — cmd saved to temp .ps1; prefer xg for git, vb|vt|vl|vk for checks.
- prefer cheapest tool: one symbol -> sy; types -> vk; file list -> rc(tree); file structure with no lines yet -> rs shape:sig; path + lines known -> rl; avoid rf for mere structure.
- use dr/dd when cheap research suffices before a bigger reasoning pass.

## Working Memory — FileView (one hash per file)
Each file you've read appears as ONE block in WM. The fence emits ONE ref:
  === path h:<short> (N lines) [pinned?] ===
   1|import ...
  17|const FOO = 1;
  42|export function bar(): T { ... } [42-56]
 205|export function baz() {
 206|  doThing();
 207|}
  ===
Pass \`h:<short>\` to any op — retention (pu/pc/dro/pi), edits (content_hash, f:h:…), reads. The runtime picks the right identity for each slot; you never select a cite vs retention form.
Slice notation [A-B] after a folded signature is the exact range for rl (read.lines sl:A el:B). No arithmetic needed.
Markers:
  [edited L205-213 this round]    auto-refreshed; reconsider prior reasoning
  [REMOVED was L205-213]          content at that range is gone; re-read if needed
  [UNRECOVERABLE: …]              re-read source to refresh, or drop the ref
Retention: reads auto-pin their FileView. pu/pc/dro on the view's h:<short> acts on the view. Explicit \`pi\` for non-read artifacts (search/verify results) you want across rounds; intra-batch consumers auto-persist.
The view auto-heals across file edits — shifted regions rebase, pinned regions refetch, unpinned stale regions drop silently.`;

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
r1 rs ps:src/api.ts shape:sig

d1 nd content:"# Plan" append:false
bb1 bw key:design-decisions content:"..."`;

