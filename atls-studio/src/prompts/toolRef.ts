/**
 * Tool reference for the collapsed batch-only surface.
 */

import { generateFamilyLines } from '../services/batch/families';

export const BATCH_TOOL_REF = `## Batch Tool — line-per-step (shell = builds/git/packages ONLY; h:XXXX = universal pointer)
Pass q: one step per line. Format: ID USE key:val key:val
Arrays: comma-separated (file_paths:a.ts,b.ts). Quoted values for spaces/colons: content:"const x = 1;"
Complex nested objects: inline JSON-like {…} syntax (line_edits, creates).
Dataflow: in:stepId.path (e.g. in:r1.refs). Conditional: if:stepId.ok. on_error:stop|continue|rollback

### Operation Families
${generateFamilyLines()}

### Common Params (canonical names — aliases auto-resolved)
session.advance subtask?:name summary:required
read.context type:smart|full|module|component|test|tree file_paths:path1,path2 depth?:N glob?:pattern line_range?:start-end max_lines?:N
read.shaped file_paths:path1,path2 shape:sig|skeleton max_files?:N
read.lines hash:h:XXXX lines:15-50 | file_path:path start_line:N end_line:N context_lines?:0-5
search.code queries:term1,term2 file_paths?:path1,path2 limit?:N compact?:true
search.symbol symbol_names:name1,name2 limit?:N
search.usage symbol_names:name1,name2 filter?:pattern limit?:N
search.similar type?:code|function|concept query?:text threshold?:N limit?:N
search.issues file_paths?:path1 severity_filter?:high|medium|low|all issue_mode?:correctness|all|security limit?:N
search.patterns file_paths?:path1 patterns?:pattern1,pattern2
search.memory query:text regions?:active,archived,bb max_results?:N
analyze.deps|calls|structure|impact|blast_radius|extract_plan file_paths:path1 filter?:pattern limit?:N symbol_names?:name1
change.edit file_path:path line_edits:[{line:N,action:replace,count:M,content:"new code"}]
  line: end | -1 | symbol:fn(name) — replace/replace_body get end_line from symbol span
  actions: replace, insert_before, insert_after, delete, move
  Intra-step coords: snapshot-style (relative to file before any edit in step); executor rebases
  legacy: edits:[{file:path,old:text,new:text}] — short unambiguous replacements only
  also: creates:[{path:p,content:c}] | revise:hash | undo:h:$last_edit | deletes:path1,path2
change.create creates:[{path:p,content:c}]
change.delete file_paths:path1,path2 confirm?:true dry_run?:false
change.refactor action:inventory|impact_analysis|execute|rollback|rename|move|extract file_paths?:path1 symbol_names?:name1
change.rollback restore:[{file:path,hash:h}] delete?:path1,path2
change.split_module source_file:path target_dir:dir plan:[{module:name,symbols:[s1,s2]}] dry_run?:true
verify.build|test|lint|typecheck target_dir?:dir workspace?:name runner?:name
system.git action:status|diff|stage|unstage|commit|push|log|reset|restore files?:path1,path2 message?:"text" all?:true
system.workspaces action:list|search|add|remove|set_active|rescan
system.exec cmd:"command text"
delegate.retrieve query:"what to find" focus_files?:path1,path2 max_tokens?:N
delegate.design query:"what to design" focus_files?:path1,path2
session.bb.write key:name content:"text"
session.bb.read keys:key1,key2
session.bb.delete keys:key1,key2
session.rule action?:set|delete|list key:name content?:"text"
session.emit content:"text" type?:name
session.pin hashes:h:HASH1,h:HASH2 — or bare step id (in:r1.refs resolves refs)
session.shape|load|debug|stage|unstage|compact|unload|drop|recall|stats|compact_history
annotate.note|retype|split|merge — hash-targeted metadata ops (hash:h:XXXX + op-specific params)
intent.understand file_paths:path1,path2 force?:true
intent.edit file_path:path line_edits:[...] verify?:true force?:true
intent.edit_multi edits:[{file_path:p,line_edits:[...]}] verify?:true
intent.investigate query:text file_paths?:path1
intent.diagnose file_paths?:path1 severity?:high query?:text
intent.survey directory:dir depth?:N
intent.refactor file_path:path strategy?:name symbol_names?:s1 target_file?:path
intent.create target_path:path content:"text" ref_files?:path1 verify?:true
intent.test source_file:path test_file?:path
intent.search_replace old_text:"text" new_text:"text" file_glob?:pattern max_matches?:N verify?:true
intent.extract source_file:path symbol_names?:s1 target_file:path

### Examples
s1 search.code queries:auth
s2 change.edit file_path:src/api.ts line_edits:[{line:10,action:replace,count:1,content:"const x = 1;"}]
s3 verify.typecheck if:s2.ok

r1 read.context type:smart file_paths:src/api.ts,src/db.ts
p1 session.pin in:r1.refs
p2 session.pin hashes:h:abc123,h:def456
-- WRONG: session.pin hashes:h:r1  (r1 is a step ID, not a content hash — use in:r1.refs instead)

u1 intent.understand file_paths:src/api.ts
e1 intent.edit file_path:src/api.ts line_edits:[{line:10,action:replace,count:1,content:"const x = 1;"}]

Path discipline: if a filename is ambiguous (exists in multiple dirs), use search.symbol or the project tree to confirm the directory before read.lines. Wrong paths waste rounds and fragment spin tracking.

### Field Reference (canonical names — aliases auto-resolved, response uses same names)
file_path: single file (aliases: file, f, path, target_file, source_file; auto-promotes to file_paths for array ops)
file_paths: array of paths/h:refs (aliases: files, paths)
content_hash: file content identity hash (aliases: snapshot_hash, hash)
h: short hash pointer (h:XXXX); refs/hashes: array of h:XXXX pointers
lines: line count in response objects (aliases: total_lines, line_count)
symbol_names: symbol list (aliases: symbol, symbol_name); query/queries, key/keys, cmd also auto-resolved

### Task Recipes (follow the matching recipe)
Bug hunt: search.issues → read.shaped(sig) top 3-5 suspects → full-read + BB finding per fn → fix confirmed bugs → verify.build → task_complete (report honestly if < N found)
Feature: read.shaped(sig) targets → session.plan → change.edit per subtask → verify.build → task_complete
Refactor: analyze.extract_plan → session.plan → change.refactor per extraction → verify.build → task_complete
Investigation (no edits): intent.investigate → BB structured findings → task_complete with report
Review: read.shaped(sig) → full-read changed fns → BB review findings → task_complete with summary

### Tool Selection for Reads (one tool per target — do not chain)
- Discovery: read.shaped(sig) for structure, search.code for patterns
- Confirmation: read.lines for the specific function body you need
- DO NOT chain: read.shaped → read.lines → read.context → read.file → delegate.retrieve on the same file. Pick one appropriate tool, pin the result, analyze, write a finding.
- Switching read tools on the same file IS re-reading. The system tracks this.
- If a read is BLOCKED, you already have the content. Act on it.

### Rules
- file_path/file_paths resolve from active workspace root. Subfolder prefix if monorepo (e.g. \`atls-studio/src/foo.ts\`).
- file_paths: actual paths or h:refs, not query strings. deletes/restore: paths or h:refs.
- verify.*: subprocess uses PATH with ATLS_TOOLCHAIN_PATH prepended. system.exec runs in PTY (may see different PATH).
- system.exec: PowerShell — cmd saved to temp .ps1; prefer system.git for git, verify.* for checks.
- prefer cheapest tool: sigs -> read.shaped; one symbol -> search.symbol; types -> verify.typecheck; file list -> read.context(tree).
- use delegate.retrieve/design when cheap research suffices before a bigger reasoning pass.`;

export const SUBAGENT_TOOL_REF = `

**DELEGATE** — dispatch a cheaper model as a specialized subagent inside batch
• delegate.retrieve query:"what to find" → searches code, pins relevant blocks, writes retriever:findings BB key
• delegate.design query:"..." → planning research + writes design:research BB key
• delegate.code query:"implement X" → edits files, verifies, writes coder:report BB key
• delegate.test query:"test X" → writes/runs tests, iterates on failures, writes tester:results BB key
• focus_files?:path1,path2, max_tokens?:N, token_budget?:N are optional
Returns engram refs (not inline code) — pinned content appears in your next WM update.
Example:
d1 delegate.retrieve query:"authentication flow" focus_files:src/auth/
d2 delegate.code query:"add input validation to UserService.create" focus_files:src/services/user.ts`;

export const NATIVE_TOOL_TOKENS_ESTIMATE = 100;

export const DESIGNER_TOOL_REF = `## Designer Tools — READ ONLY
Use batch() only. One step per line: ID USE key:val

Examples
s1 search.code queries:auth,login
r1 read.context type:smart file_paths:src/api.ts

d1 annotate.design content:"# Plan" append:false
bb1 session.bb.write key:design-decisions content:"..."`;

