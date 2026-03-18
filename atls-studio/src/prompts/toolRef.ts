/**
 * Tool reference for the collapsed batch-only surface.
 */

export const ATLS_TOOL_REF = `## Batch Tool (shell = builds/git/packages ONLY; h:XXXX = universal pointer)
Use one native execution surface: batch({version:"1.0",steps:[...]}).

### Operation Families
discover: search.code, search.symbol, search.usage, search.similar, search.issues, search.patterns
understand: read.context, read.shaped, read.lines, read.file, analyze.deps, analyze.calls, analyze.structure, analyze.impact, analyze.blast_radius, analyze.extract_plan
change: change.edit, change.create, change.delete, change.refactor, change.rollback, change.split_match
verify: verify.build, verify.test, verify.lint, verify.typecheck
session: session.plan, session.advance, session.status, session.pin (hashes:["h:X",...]), session.unpin, session.stage, session.unstage, session.compact, session.unload, session.drop, session.recall, session.stats, session.bb.write, session.bb.read, session.bb.delete, session.bb.list, session.rule, session.emit, session.shape, session.load, session.compact_history
annotate: annotate.engram (hash, fields:{...}), annotate.note, annotate.link (from:"h:X" to:"h:Y"), annotate.retype, annotate.split, annotate.merge, annotate.design
delegate: delegate.retrieve, delegate.design
system: system.exec, system.git, system.workspaces, system.help
intent: intent.understand, intent.edit, intent.edit_multi, intent.investigate, intent.diagnose, intent.survey, intent.refactor, intent.create, intent.test, intent.search_replace, intent.extract

### Common Params (canonical names — aliases auto-resolved)
session.advance subtask:optional (omit to advance to next) summary:required
read.context type:smart|full|module|component|test|tree file_paths:[] depth?:N glob?:"" line_range?:[start,end] max_lines?:N (use full for full content; do NOT use raw)
read.shaped file_paths:[] shape:""
read.lines hash+lines ("15-50") | ref ("h:XXXX:15-50" — hash 6-16 hex) | file_path+start_line+end_line | context_lines?:0-5 (default 3, returns target_range + actual_range)
search.code queries:[] file_paths?:[] limit?:N compact?:bool
search.symbol symbol_names:[] limit?:N
search.usage symbol_names:[] filter?:"" limit?:N
search.similar type?:code|function|concept|pattern query?:"" threshold?:N limit?:N
search.issues file_paths?:[] severity_filter?:high|medium|low|all category?:"" limit?:N
search.patterns file_paths?:[] patterns?:[]
analyze.deps mode:graph|related|impact file_paths:[] filter?:"" limit?:N
analyze.calls symbol_names:[] depth?:N filter?:"" limit?:N
analyze.structure file_paths:[] kinds?:[] hub_threshold?:N exclude_hubs?:bool
analyze.impact file_paths:[] symbol_names?:[]
analyze.blast_radius file_paths?:[] symbol_names?:[] action?:""
analyze.extract_plan file_path:"" strategy:by_cluster|by_prefix|by_kind min_lines?:N min_complexity?:N
change.edit file_path:"" line_edits:[{line:N, action:"replace", count:M, content:"new code"}] — preferred: replaces lines N..N+M-1, no old text needed
  also: line_edits:[{line:N, action:"insert_before"|"insert_after", content:"...", reindent?:true}]
  also: line_edits:[{line:N, action:"delete", count:M}]
  also: line_edits:[{line:N, action:"move", count:M, destination:D, reindent?:true}]
  also: line_edits:[{anchor:"unique text", action:"replace", count:M, content:"..."}] — anchor resolves to line
  legacy: edits:[{file,old,new}] — exact text match, use only for short unambiguous replacements
  also: creates:[{path,content}] | revise:"hash" | undo:"h:$last_edit" | deletes:["path"|"h:X",...]
change.create creates:[{path,content}]
change.delete file_paths:["path"|"h:X",...]
change.refactor action:inventory|impact_analysis|execute|rollback file_paths?:[] symbol_names?:[]
change.rollback restore:[{file,hash}] delete?:["path"|"h:X",...] (file, hash, delete accept h:refs)
change.split_match file_path:"" function_name:"" target_module?:"" dry_run?:true strategy?:"" match_index?:N
change.split_module source_file:"" target_dir:"" plan:[{module,symbols:[]}] dry_run?:true mod_style?:""
verify.build|test|lint|typecheck target_dir?:"" workspace?:"" runner?:""
system.git action:status|diff|stage|commit|push|log|reset workspace?:""
system.workspaces action:list|search|add|remove|rescan
system.exec cmd:"" terminal_id?:""
delegate.retrieve query:"" focus_files?:[] max_tokens?:N
delegate.design query:"" focus_files?:[] max_tokens?:N
session.bb.write key:"" content:"" derived_from?:[]
session.bb.read keys:[]
session.bb.delete keys:[]
session.rule action?:set|delete|list key:"" content?:""
intent.understand file_paths:[] force?:bool — reads, analyzes deps, stages, pins; skips steps already done (staged/pinned/BB/awareness)
intent.edit file_path:"" line_edits:[...] verify?:bool force?:bool — reads if needed, edits, auto-retries on stale_hash, verifies
intent.edit_multi edits:[{file_path:"",line_edits:[...]}] verify?:bool force?:bool — per-file read/edit/retry, single verify.build at end; AI must know exact edits for all files
intent.investigate query:"" file_paths?:[] force?:bool — searches, reads results, stages, caches in BB; skips if BB has prior results
intent.diagnose file_paths?:[] severity?:"" query?:"" force?:bool — search.issues, read context, analyze.impact, stage, cache; does NOT edit (read-only discovery)
intent.survey directory:"" depth?:N force?:bool — reads tree, stages sigs, caches in BB; skips if tree already cached
intent.refactor file_path:"" strategy?:"" symbol_names?:[] target_file?:"" force?:bool — reads, pins, analyzes, extracts plan, splits, verifies; reuses prior understand/survey results
intent.create target_path:"" content:"" ref_files?:[] verify?:bool force?:bool — reads ref_file sigs for dep context, creates file, verifies types; AI must provide full content
intent.test source_file:"" test_file?:"" force?:bool — reads source sigs + existing test context, stages, caches in BB; does NOT write the test (context prep only)
intent.search_replace search_query?:"" old_text:"" new_text:"" file_glob?:"" max_matches?:N verify?:bool force?:bool — searches, emits capped anchor-based edits, verifies; literal text only, no regex
intent.extract source_file:"" symbol_names?:[] target_file:"" force?:bool — reads source, splits via change.split_match, verifies; symbols must be self-contained

### Examples
batch({version:"1.0",goal:"search then edit",steps:[{id:"s1",use:"search.code",with:{queries:["auth"]}},{id:"s2",use:"change.edit",with:{edits:[...]}},{id:"s3",use:"verify.typecheck",if:{step_ok:"s2"}}]})
batch({version:"1.0",goal:"batch related implementation before verification",steps:[{id:"r1",use:"read.context",with:{type:"smart",file_paths:["src/auth.ts","src/session.ts"]}},{id:"c1",use:"change.edit",with:{edits:[...]}},{id:"c2",use:"change.edit",if:{step_ok:"c1"},with:{edits:[...]}},{id:"v1",use:"verify.build",if:{step_ok:"c2"}}]})
batch({version:"1.0",steps:[{id:"r1",use:"read.context",with:{type:"smart",file_paths:["src/api.ts","src/db.ts"]}},{id:"p1",use:"session.pin",in:{hashes:{from_step:"r1",path:"refs"}}}]})
batch({version:"1.0",steps:[{id:"plan",use:"analyze.extract_plan",with:{file_path:"src/lib.rs",strategy:"by_cluster"}},{id:"split",use:"change.split_match",with:{file_path:"src/lib.rs",function_name:"dispatch",target_module:"handlers.rs",dry_run:false}}]})
batch({version:"1.0",steps:[{id:"git",use:"system.git",with:{action:"status"}},{id:"help",use:"system.help",with:{topic:"edit"}}]})
batch({version:"1.0",steps:[{id:"u1",use:"intent.understand",with:{file_paths:["src/auth.ts","src/session.ts"]}}]})
batch({version:"1.0",steps:[{id:"u1",use:"intent.understand",with:{file_paths:["src/api.ts"]}},{id:"e1",use:"intent.edit",with:{file_path:"src/api.ts",line_edits:[{line:10,action:"replace",count:1,content:"const x = 1;"}]}}]})

### Dataflow
Step dataflow: in:{param:{from_step:"s1",path:"refs.0"}}.
Literal refs: {ref:"h:X"}.
Named bindings: {bind:"$name"}.
Literals: {value:123}.
Policy: mode:"readonly"|"mutable"|"safe-mutable", verify_after_change, rollback_on_failure, max_steps, stop_on_verify_failure.
Discipline: use mode:"safe-mutable" for any batch that might mutate or exec; readonly is for analysis-only batches.
on_error: "stop"|"continue"|"rollback" per step.

### Param Aliases (auto-resolved — use canonical names above)
- file_path aliases: file, f, path, target_file, source_file → file_path
- file_paths: file_path (string) auto-promotes to file_paths:[file_path] for array ops
- symbol_names aliases: symbol, symbol_name, name (search.symbol only) → symbol_names
- queries aliases: query (search.code only) → queries
- hashes aliases: refs → hashes
- keys aliases: key → keys (bb.read/bb.delete only)
- cmd aliases: command → cmd
- content aliases: contents → content
- fn(name)/cls(name) wrappers auto-stripped from symbol_names entries

### Rules
- file_paths: actual paths or h:refs, not query strings
- deletes, delete (rollback): paths or h:refs — resolve to path
- hashes (session.pin/unpin/compact/unload/drop/recall): h:refs pass-through
- restore items: file and hash accept h:refs
- line_edits: prefer line+count+action:"replace" with explicit line numbers from read_lines output — no old text needed. For 200+ line files, always use line_edits with line numbers. Anchors (content-match, shift-immune) are a fallback when line numbers are unavailable.
- use refactor, not edit, for cross-file extract/move/rename flows
- each successful edit returns fresh refs; chain from the newest refs
- default cadence: batch related change.* steps first, then run one verify.build at a milestone or task end unless the change is high risk
- use delegate.retrieve or delegate.design when cheap research is enough before a bigger reasoning pass
- intents are macros — they expand to primitives before execution; the executor never sees intent.* at dispatch time
- intents skip steps already done: staged files skip re-read, pinned files skip re-pin, BB-cached results skip re-search
- use force:true on any intent to bypass state checks and emit all steps
- intents compose: intent.understand + intent.edit in one batch works — edit reuses understand's staged/pinned refs via from_step wiring
- intent.edit and intent.edit_multi auto-retry once on stale_hash via conditional steps — no manual retry needed
- intent.diagnose and intent.test are read-only — they prepare context but never mutate; follow with intent.edit or intent.create
- intent.search_replace is literal only — old_text must be exact, no regex, no semantic transforms

### Model Discipline
- never call an intent you haven't prepared for: read files before intent.edit, have exact line_edits before intent.edit_multi
- intents automate plumbing (reads, retries, verify), not thinking — if you don't know the inputs, use primitives to explore first
- don't use intents for exploration: read.context then reason, then intent.edit with confident changes
- two-turn rule for fix workflows: turn 1 = intent.diagnose or intent.investigate (gather), turn 2 = intent.edit or intent.edit_multi (apply)
- batch size discipline: max 8-10 steps per batch; split into discovery -> mutation -> verify batches
- verify cadence: batch related edits, verify at milestones; exception: public API / schema / dependency changes verify immediately
- read before write, always: even with intent.edit auto-read, prefer having read in a prior turn to avoid stale hash retries
- don't chain intents in one batch unless outputs feed inputs: intent.understand + intent.edit OK; intent.investigate + intent.edit BAD (needs reasoning between)
- prefer the cheapest tool: signatures? read.shaped; one symbol? search.symbol; types? verify.typecheck; file list? read.context(tree)
- use primitives when the workflow is non-standard: 3 well-chosen primitives > 1 intent that does the wrong thing`;

export const SUBAGENT_TOOL_REF = `

**DELEGATE** — dispatch a cheaper retriever/design model inside batch
• delegate.retrieve query:"what to find" → searches code, pins relevant blocks, returns source snippets
• delegate.design query:"..." → planning research + blackboard write for design findings
• focus_files?:["path/hint.ts"] and max_tokens?:N are optional
Example:
batch({version:"1.0",steps:[{id:"d1",use:"delegate.retrieve",with:{query:"authentication flow",focus_files:["src/auth/"]}}]})`;

export const NATIVE_TOOL_TOKENS_ESTIMATE = 1100;

export const DESIGNER_TOOL_REF = `## Designer Tools — READ ONLY
Use batch() only.

Examples
batch({version:"1.0",steps:[{id:"s1",use:"search.code",with:{queries:["auth","login"]}},{id:"r1",use:"read.context",with:{type:"smart",file_paths:["src/api.ts"]}}]})
batch({version:"1.0",steps:[{id:"d1",use:"annotate.design",with:{content:"# Plan\\n\\n",append:false}},{id:"bb1",use:"session.bb.write",with:{key:"design-decisions",content:"..."}}]})`;
