/**
 * Tool reference for the collapsed batch-only surface.
 */

import { generateFamilyLines } from '../services/batch/families';

export const BATCH_TOOL_REF = `## Batch Tool (shell = builds/git/packages ONLY; h:XXXX = universal pointer)
Use one native execution surface: batch({version:"1.0",steps:[...]}).

### Operation Families
${generateFamilyLines()}

### Common Params (canonical names — aliases auto-resolved)
session.advance subtask:optional (omit to advance to next) summary:required
read.context type:smart|full|module|component|test|tree file_paths:[] depth?:N glob?:"" line_range?:[start,end] max_lines?:N (use full for full content; do NOT use raw)
read.shaped file_paths:[] shape:"" max_files?:N (caps path count when bindings supply long lists)
read.lines hash+lines ("15-50") | ref ("h:XXXX:15-50" — hash 6-16 hex) | file_path+start_line+end_line | context_lines?:0-5 (default 3, returns target_range + actual_range)
search.code queries:[] file_paths?:[] limit?:N compact?:bool
search.symbol symbol_names:[] limit?:N
search.usage symbol_names:[] filter?:"" limit?:N
search.similar type?:code|function|concept|pattern query?:"" threshold?:N limit?:N
search.issues file_paths?:[] severity_filter?:high|medium|low|all category?:"" issue_mode?:correctness|all|security (default correctness — omits Style-category issues) limit?:N
search.patterns file_paths?:[] patterns?:[]
search.memory query:"" regions?:[active,archived,dormant,bb,staged,dropped] case_sensitive?:bool max_results?:N
analyze.deps|calls|structure|impact|blast_radius|extract_plan file_paths:[] — common: filter?:"" limit?:N symbol_names?:[] (system.help for full params per op)
change.edit file_path:"" line_edits:[{line:N, action:"replace", count:M, content:"new code"}] — preferred: replaces lines N..N+M-1, no old text needed
  line: "end" | -1 (last line, no prior read) | symbol:"fn(name)" + position — Rust resolves; replace/replace_body get end_line from symbol span when omitted
  also: line_edits:[{line:N, action:"insert_before"|"insert_after", content:"...", reindent?:true}]
  also: line_edits:[{line:N, action:"delete", count:M}] — spans must keep valid syntax; partial deletes may fail with syntax_error_after_edit
  also: line_edits:[{line:N, action:"move", count:M, destination:D, reindent?:true}]
  also: line_edits:[{line:N, end_line:M, action:"replace", ...}] — end_line overrides count for inclusive span N..=M
  Intra-step coords are snapshot-style: all numeric lines are relative to the file before any edit in the step; the batch executor rebases to sequential before apply. Then each subsequent edit's line refers to the file state after prior edits (Rust apply_line_edits).
  legacy: edits:[{file,old,new}] — exact text match, use only for short unambiguous replacements
  also: creates:[{path,content}] | revise:"hash" | undo:"h:$last_edit" | deletes:["path"|"h:X",...]
change.create creates:[{path,content}]
change.delete file_paths:["path"|"h:X",...] confirm?:true dry_run?:false
change.refactor action:inventory|impact_analysis|execute|rollback|rename|move|extract file_paths?:[] symbol_names?:[]
change.rollback restore:[{file,hash}] delete?:["path"|"h:X",...] — restore.hash: prefer h:$last_edit / h:$last_edit-N or hashes from execute _rollback
change.split_module source_file:"" target_dir:"" plan:[{module,symbols:[]}] dry_run?:true mod_style?:""
verify.build|test|lint|typecheck target_dir?:"" workspace?:"" runner?:""
system.git action:status|diff|stage|unstage|commit|push|log|reset|restore workspace?:"" files?:[] message?:"" all?:bool
system.workspaces action:list|search|add|remove|set_active|rescan
system.exec cmd:"" terminal_id?:""
delegate.retrieve query:"" focus_files?:[] max_tokens?:N
delegate.design query:"" focus_files?:[] max_tokens?:N
session.bb.write key:"" content:"" derived_from?:[]
session.bb.read keys:[]
session.bb.delete keys:[]
session.rule action?:set|delete|list key:"" content?:""
session.emit content:"" type?:""
session.shape|load|debug|stage|unstage|compact|unload|drop|recall|stats|compact_history — session management (system.help for params)
annotate.note|retype|split|merge — hash-targeted metadata ops (hash:"" + op-specific params); full list includes annotate.engram|link|design — see ### Operation Families above
intent.understand file_paths:[] force?:bool — reads, analyzes deps, stages, pins; skips steps already done
intent.edit file_path:"" line_edits:[...] verify?:bool force?:bool — reads if needed, edits, auto-retries on stale_hash, verifies
intent.edit_multi edits:[{file_path:"",line_edits:[...]}] verify?:bool force?:bool — per-file read/edit/retry, single verify.build at end
intent.investigate query:"" file_paths?:[] force?:bool — search.code (capped paths) + read.shaped(sig), stages, caches in BB (not full smart read per hit)
intent.diagnose file_paths?:[] severity?:"" query?:"" force?:bool — search.issues + analyze.impact, read-only discovery
intent.survey directory:"" depth?:N force?:bool — read.context(tree, default depth 2, max 3), read.shaped(sig) with max_files cap, caches in BB
intent.refactor file_path:"" strategy?:"" symbol_names?:[] target_file?:"" force?:bool — reads, pins, analyzes, extracts plan, refactors, verifies
intent.create target_path:"" content:"" ref_files?:[] verify?:bool force?:bool — creates file with dep context, verifies types
intent.test source_file:"" test_file?:"" force?:bool — reads source sigs + test context, read-only prep
intent.search_replace search_query?:"" old_text:"" new_text:"" file_glob?:"" max_matches?:N verify?:bool force?:bool — literal text only, no regex
intent.extract source_file:"" symbol_names?:[] target_file:"" force?:bool — reads source, refactors, verifies

### Examples
batch({version:"1.0",goal:"search then edit",steps:[{id:"s1",use:"search.code",with:{queries:["auth"]}},{id:"s2",use:"change.edit",with:{edits:[...]}},{id:"s3",use:"verify.typecheck",if:{step_ok:"s2"}}]})
batch({version:"1.0",steps:[{id:"r1",use:"read.context",with:{type:"smart",file_paths:["src/api.ts","src/db.ts"]}},{id:"p1",use:"session.pin",in:{hashes:{from_step:"r1",path:"refs"}}}]})
batch({version:"1.0",steps:[{id:"u1",use:"intent.understand",with:{file_paths:["src/api.ts"]}},{id:"e1",use:"intent.edit",with:{file_path:"src/api.ts",line_edits:[{line:10,action:"replace",count:1,content:"const x = 1;"}]}}]})

### Dataflow
Step dataflow: in:{param:{from_step:"s1",path:"refs.0"}}.
Literal refs: {ref:"h:X"}.
Named bindings: {bind:"$name"}.
Literals: {value:123}.
Policy (optional): verify_after_change, rollback_on_failure, max_steps (capped server-side), stop_on_verify_failure, auto_stage_refs.
Do not set policy.mode — execution mode is app-controlled (Ask chat is read-only; Agent/Designer/Reviewer/etc. always run mutable). Use verify_after_change for automatic verify.build after change.* steps.
on_error: "stop"|"continue"|"rollback" per step.

### Param Aliases (auto-resolved)
file/f/path/target_file/source_file -> file_path (auto-promotes to file_paths:[] for array ops); query -> queries; symbol/symbol_name -> symbol_names; refs -> hashes; key -> keys; command -> cmd; contents -> content. fn()/cls() wrappers stripped.

### Rules
- file_path/file_paths resolve from active workspace root. Subfolder prefix if monorepo (e.g. \`atls-studio/src/foo.ts\`).
- file_paths: actual paths or h:refs, not query strings. deletes/restore: paths or h:refs.
- verify.build|test|lint|typecheck: subprocess uses PATH with ATLS_TOOLCHAIN_PATH prepended (set env to match nvm/fnm/volta bins). system.exec runs in the PTY and may see a different PATH — use _metadata.executable_probe on verify results to see resolved tools.
- Do not nest OpenAI multi_tool_use.parallel (or similar) inside batch steps; use multiple batch steps instead.
- system.exec: PowerShell — cmd saved to temp .ps1; prefer system.git for git, verify.* for checks.
- hash-building refactor: read.shaped(sig) -> h:SOURCE; change.create body = imports + h:XXXX:sym(Name):dedent + exports; strip source; verify.typecheck.
- prefer cheapest tool: sigs -> read.shaped; one symbol -> search.symbol; types -> verify.typecheck; file list -> read.context(tree).
- use delegate.retrieve/design when cheap research suffices before a bigger reasoning pass.`;

export const SUBAGENT_TOOL_REF = `

**DELEGATE** — dispatch a cheaper model as a specialized subagent inside batch
• delegate.retrieve query:"what to find" → searches code, pins relevant blocks, writes retriever:findings BB key
• delegate.design query:"..." → planning research + writes design:research BB key
• delegate.code query:"implement X" → edits files, verifies, writes coder:report BB key
• delegate.test query:"test X" → writes/runs tests, iterates on failures, writes tester:results BB key
• focus_files?:["path/hint.ts"], max_tokens?:N, token_budget?:N are optional
Returns engram refs (not inline code) — pinned content appears in your next WM update.
Example:
batch({version:"1.0",steps:[{id:"d1",use:"delegate.retrieve",with:{query:"authentication flow",focus_files:["src/auth/"]}}]})
batch({version:"1.0",steps:[{id:"d2",use:"delegate.code",with:{query:"add input validation to UserService.create",focus_files:["src/services/user.ts"]}}]})`;

export const NATIVE_TOOL_TOKENS_ESTIMATE = 1100;

export const DESIGNER_TOOL_REF = `## Designer Tools — READ ONLY
Use batch() only.

Examples
batch({version:"1.0",steps:[{id:"s1",use:"search.code",with:{queries:["auth","login"]}},{id:"r1",use:"read.context",with:{type:"smart",file_paths:["src/api.ts"]}}]})
batch({version:"1.0",steps:[{id:"d1",use:"annotate.design",with:{content:"# Plan\\n\\n",append:false}},{id:"bb1",use:"session.bb.write",with:{key:"design-decisions",content:"..."}}]})`;
