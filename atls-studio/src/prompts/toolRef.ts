/**
 * Tool reference for the collapsed batch-only surface.
 */

import { generateFamilyLines } from '../services/batch/families';
import { generateShorthandLegend } from '../services/batch/opShorthand';

export const BATCH_TOOL_REF = `## Batch Tool — line-per-step (shell = builds/git/packages ONLY; h:XXXX = universal pointer)
Pass q: one step per line. Format: STEP_ID <operation> key:val key:val
<operation> accepts short codes (see Short codes below) or full dotted names. In structured JSON steps, the property is \`use\`: set it to that operation name (e.g. read.shaped, rc, spl) — never the literal string "USE" (some docs label the operation column that way for readability only).
Arrays: comma-separated (ps:a.ts,b.ts). Quoted values for spaces/colons: content:"const x = 1;"
Complex nested objects: inline JSON-like {…} syntax (le, creates).
Dataflow: in:stepId.path (e.g. in:r1.refs). Conditional: if:stepId.ok. on_error:stop|continue|rollback

### Operation Families
${generateFamilyLines()}

${generateShorthandLegend()}

### Common Params (short codes in Key above; full names always accepted)
sa subtask?:name summary:required
rc type:smart|full|module|component|test|tree ps:path1,path2 depth?:N glob?:pattern line_range?:start-end max_lines?:N
rs ps:path1,path2 shape:sig max_files?:N
rl hash:h:XXXX lines:15-50 | f:path sl:N el:N context_lines?:0-5
rf ps:path1,path2 type?:smart|full — simpler than rc, no shaped/tree/bind support
sc qs:term1,term2 ps?:path1,path2 limit?:N compact?:true
sy sn:name1,name2 limit?:N
su sn:name1,name2 filter?:pattern limit?:N
sv type?:code|function|concept query?:text threshold?:N limit?:N
si ps?:path1 sf?:high|medium|low|all issue_mode?:correctness|all|security limit?:N
sp ps?:path1 patterns?:pattern1,pattern2
sm query:text regions?:active,archived,bb max_results?:N
ad|at|ai ps:path1 filter?:pattern limit?:N
ab sn:name1 ps?:path1 action?:move
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
ru action?:set|delete|list key:name content?:"text"
em content:"text" type?:name
pi hashes:h:HASH1,h:HASH2 — or bare step id (in:r1.refs resolves refs)
sh|ld|db|sg|ust|pc|ulo|dro|rec|st|ch
nn|nr|ns|nm — hash-targeted metadata ops (hash:h:XXXX + op-specific params)
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
Bug hunt: si → rs(sig) top 3-5 suspects → full-read + BB finding per fn → fix confirmed bugs → task_complete (report honestly if < N found)
Feature: rs(sig) targets → spl → ce per subtask → task_complete
Refactor: ax → spl → cf per extraction → task_complete
Investigation (no edits): iv → BB structured findings → task_complete with report
Review: rs(sig) → full-read changed fns → BB review findings → task_complete with summary

### Tool Selection for Reads (one tool per target — do not chain)
- Discovery: rs(sig) for structure, sc for patterns
- Confirmation: rl for the specific function body you need
- DO NOT chain: rs → rl → rc → rf → dr on the same file. Pick one appropriate tool, pin the result, analyze, write a finding.
- Switching read tools on the same file IS re-reading. The system tracks this.
- If a read is BLOCKED, you already have the content. Act on it.

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

