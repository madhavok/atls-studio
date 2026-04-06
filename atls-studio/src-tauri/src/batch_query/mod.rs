use super::*;

mod helpers;
use helpers::*;

use crate::refactor_engine::*;
use crate::git_ops::{
    index_deleted_files, index_modified_files, probe_executable, run_git_command, run_shell_cmd_async,
};
use crate::code_intel::expand_concept;
use crate::path_utils::{
    detect_format, find_manifest_candidates_under, find_manifest_nearest, normalize_line_endings,
    read_file_with_format, resolve_project_path, resolve_tree_directory_path, serialize_with_format,
    to_relative_path, FileFormat, ManifestKind,
};
/// Parse `files` for git stage/unstage/restore: JSON array of strings, or a single non-empty string.
fn git_files_param(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        Some(serde_json::Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                vec![]
            } else {
                vec![t.to_string()]
            }
        }
        _ => vec![],
    }
}

/// batch_query - THE primary ATLS interface (33+ operations)
/// This is the main entry point for all code analysis and editing
#[tauri::command]
pub async fn atls_batch_query(
    app: AppHandle,
    operation: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _resolved_root, workspace_rel_paths) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        let root_hint = params.get("root").and_then(|v| v.as_str());
        let (proj, resolved) = resolve_project(&roots, &ar, root_hint)?;
        let ws_paths: Vec<String> = roots.iter()
            .flat_map(|r| r.sub_workspaces.iter())
            .map(|w| w.rel_path.clone())
            .filter(|s| !s.is_empty() && s != ".")
            .collect();
        (proj, resolved, ws_paths)
    };
    // Lock released â€” verify/git/exec can run without blocking other operations
    let project_root = project.root_path();
    let project_root_owned = project_root.to_path_buf();

    // Hash-relational resolver: resolve h:XXXX references in all params
    let mut params = params;
    let hash_resolve_warnings: Vec<String>;
    {
        let hr_state = app.state::<hash_resolver::HashRegistryState>();
        let registry = hr_state.registry.lock().await;
        let (_resolved, warnings) = hash_resolver::resolve_hash_refs(&mut params, &registry, project_root);
        if !warnings.is_empty() {
            eprintln!("[HPP] {} hash ref(s) unresolved: {:?}", warnings.len(), warnings);
        }
        hash_resolve_warnings = warnings;
    }

    // Edit dispatcher: route operation "edit" to the correct backend op (delete_files, draft, batch_edits, etc.)
    let (operation, params) = resolve_edit_operation(operation, params);

    let mut result: Result<serde_json::Value, String> = match operation.as_str() {
            "help" => {
                Ok(serde_json::json!({
                    "operations": [
                        "context", "code_search", "find_symbol", "symbol_usage", "call_hierarchy", "symbol_dep_graph",
                        "dependencies", "find_similar", "edit", "refactor", "extract_plan", "split_module",
                        "impact_analysis", "refactor_rollback",
                        "ast_query", "detect_patterns", "find_issues", "verify", "git", "workspaces", "help"
                    ],
                    "description": "ATLS v2.0 - Consolidated code intelligence tools. Use arrays to batch operations.",
                    "details": {
                        "context": "Read code (type: smart|full|module|component|test|tree, file_paths:[]) â€” full: entire file by default; optional line_range:[start,end] or max_lines for partial â€” tree: depth:3, glob:\"**/*.ts\"",
                        "code_search": "Semantic search (queries:[])",
                        "find_symbol": "Symbol lookup (query:str, limit:20)",
                        "symbol_usage": "Find definitions and references (symbol_names:[], filter:str?, limit:15)",
                        "call_hierarchy": "Call graph analysis (symbol_names:[], depth:2, filter:str?, limit:10)",
                        "symbol_dep_graph": "Intra-file symbol dependency graph (file_paths:[], kinds?:[], hub_threshold?:N, exclude_hubs?:true) â€” symbols + edges + hub detection (IQR outlier) + hub-excluded clusters",
                        "extract_plan": "Propose extraction plan (file_path or file_paths:[], strategy:'by_cluster'|'by_prefix'|'by_kind', min_lines?, min_complexity?) â€” hub-aware clustering, multi-segment prefix grouping, cohesion/risk metrics + ready-to-execute params",
                        "split_module": "Split monolithic file into directory module (source_file, target_dir, plan:[{module,symbols:[]}], dry_run?:true, mod_style?:'mod_rs') -- creates mod.rs + child modules with pub use re-exports",
                        "dependencies": "Analyze structure (mode: graph|related|impact, file_paths:[], filter:str?, limit:30)",
                        "find_similar": "Similarity search (type: code|function|concept|pattern, + type-specific params)",
                        "edit": "Modify code (edits|creates|deletes|line_edits|revise|undo). Auto-lints and auto-writes (lint reports but never blocks).",
                        "refactor": "Structural changes (action: inventory|rename|move|extract|impact_analysis|execute|rewire_consumers|plan|rollback)",
                        "ast_query": "Structural patterns (query: 'function where complexity > 10', 'fn where name contains X and params > 2'). syntax:'raw' for SQL WHERE.",
                        "detect_patterns": "Find anti-patterns (file_paths:[], patterns:[])",
                        "find_issues": "Find code issues (file_paths:[], severity:high|medium|low)",
                        "verify": "Run checks (type: test|build|typecheck|lint, workspace:'name' for monorepos)",
                        "git": "Version control (action: status|diff|stage|unstage|commit|push|log|reset, workspace:'name')",
                        "workspaces": "Manage sub-projects (action: list|search|add|remove|set_active|rescan)"
                    },
                    "consolidated": {
                        "edit_modes": {
                            "creates": "Create files [{path, content}] â†’ auto-lint â†’ auto-write on success",
                            "edits": "Text replacement [{file, old, new}] â†’ auto-lint â†’ auto-write on success",
                            "line_edits": "Line-level editing [{line, action, content?, count?, symbol?, position?, anchor?}] actions: insert_before|insert_after|replace|delete. For brace languages, replace with anchor+multiline content auto-infers block extent; set count explicitly for Python/non-brace. Multi-edit in one call: default is sequential (each line is after prior edits). Pass line_numbering:'snapshot' so every line is relative to the same pre-edit read; the batch executor rebases to sequential before apply. Prefer anchors for shift immunity.",
                            "revise": "Chain edits (revise:'hash', line_edits:[...]) â†’ patch content â†’ auto-write",
                            "undo": "Rollback (undo:'hash') â†’ restores file to state before the edit",
                            "deletes": "Delete files [path|h:ref, ...]",
                            "note": "All edits auto-lint and auto-write. Lint reports issues but never blocks writes."
                        },
                        "refactor_actions": {
                            "inventory": "List methods by complexity (file_paths, min_complexity)",
                            "impact_analysis": "Full blast radius (symbol, from) â†’ definitions, references, imports, files_touched",
                            "execute": "Atomic line-edit refactoring: create?:{path,content}, source:'h:X', remove_lines?:'23-30', import_updates?:[{file,line,anchor?,action,content}] â†’ sequential lint pipeline with auto-rollback",
                            "rewire_consumers": "Rewrite imports in consumer files after hash-building extraction (source_file, target_file, symbol_names:[], dry_run?:false). Also adds source import for still-referenced symbols. Returns consumer_import_fixes + rollback data.",
                            "rollback": "Restore files to pre-refactor hashes (restore:[{file, hash}], delete?:[paths|h:ref])",
                            "rename": "(legacy, prefer execute+import_updates) Cross-file rename (old_name, new_name)",
                            "move": "(legacy, prefer execute+create+remove_lines) Move symbols (symbol_names, target_file)",
                            "extract": "(legacy, prefer execute+create+remove_lines) Extract methods (file_path, extractions:[{target_file, methods}])",
                            "plan": "(REMOVED â€” use execute with operations array for batch refactoring)"
                        },
                        "find_similar_types": {
                            "code": "Find similar code (pattern, threshold)",
                            "function": "Find similar functions (function_names, threshold)",
                            "concept": "Find by concept (concepts, limit)",
                            "pattern": "Find design patterns (patterns:['singleton','factory'])"
                        },
                        "dependencies_modes": {
                            "graph": "Import/export graph",
                            "related": "Files that would break if changed",
                            "impact": "Ripple effect analysis"
                        }
                    },
                    "workflows": {
                        "autonomous_coding": [
                            "1. context/code_search - understand code",
                            "2. edit(creates/edits/line_edits) - auto-lint + auto-write on success",
                            "3. if lint issues: edit(revise:'hash',line_edits:[...]) - fix and re-write (optional)",
                            "4. verify.typecheck - full type validation",
                            "5. verify.test - run tests",
                            "6. system.git action:commit - commit changes"
                        ],
                        "safe_refactoring_pipeline": [
                            "1. refactor(action:inventory) - find targets by complexity",
                            "2. refactor(action:impact_analysis, symbol, from) - full blast radius",
                            "3. refactor(action:execute, create, source:'h:X', remove_lines, import_updates) - atomic HPP pipeline with auto-rollback",
                            "4. verify.typecheck - catch cross-file semantic issues",
                            "5. if errors: refactor(action:rollback, restore:[{file, hash}]) - restore pre-refactor state"
                        ],
                        "hash_building_refactor": [
                            "1. read.context type:full + session.pin - get h:SOURCE with FULL content (required for symbol anchors)",
                            "2. edit(creates:[{path, content:'imports\\n\\nh:SOURCE:cls(Name):dedent\\n'}]) - compose file from hash refs",
                            "3. edit(line_edits:[{action:'delete', line:N, count:M}]) - remove extracted code from source",
                            "4. refactor(action:'rewire_consumers', source_file, target_file, symbol_names:[...]) - auto-rewrite imports in all consumer files",
                            "5. verify.typecheck - validate all files",
                            "CRITICAL: Source hash MUST have full content (not sig/shaped). Symbol anchors (cls/fn/sym) against shaped content will error."
                        ]
                    },
                    "decision_trees": {
                        "edit_mode": {
                            "new_file": "creates:[{path,content}]",
                            "text_replace": "edits:[{file,old,new}] â€” flexible whitespace matching",
                            "by_line": "line_edits:[{line,action,content,anchor?}] â€” use anchor for shift immunity; or line_numbering:'snapshot' for multiple numeric line edits from one read",
                            "multi_file": "mode:'batch_edits' edits:[{file,content_hash,line_edits},...] â€” atomic multi-file",
                            "lint_fix": "revise:'hash' line_edits:[...] â€” fix buffered lint errors",
                            "rollback": "undo:'hash' â€” restore file to pre-edit state"
                        },
                        "edit_vs_refactor": {
                            "localized_change": "edit â€” direct, faster for single-file edits",
                            "extract_move_rename": "refactor â€” tracks symbol moves, updates imports, atomic rollback",
                            "multi_file_coordinated": "edit batch_edits for consistent changes; refactor execute for structural moves",
                            "lint_fix": "edit revise:'hash' â€” always use edit for lint fixes"
                        },
                        "find_code": {
                            "exact_symbol": "find_symbol query:'...'",
                            "usages_of_symbol": "symbol_usage symbol_names:[...]",
                            "semantic_search": "code_search queries:[...]",
                            "similar_implementations": "find_similar type:'concept' concepts:[...]"
                        }
                    },
                    "error_catalog": {
                        "E001_STALE_HASH_PEEK": "peek_lines returns {error:'stale',hint:'File changed since last read'} â€” re-read the file to get a fresh hash",
                        "E002_STALE_HASH_BATCH": "batch_edits/line_edits blocks on stale hash by default. Pass stale_policy:'follow_latest' to auto-resolve. Response includes stale:true when allowed",
                        "E003_ANCHOR_MISS": "No contains() match â€” errors by default. Pass anchor_miss_policy:'fallback' per-edit to fall back to line hint. Make anchor text more specific",
                        "E004_ANCHOR_AMBIGUOUS": "Multiple matches â€” silently picks closest to edit.line hint. No error, no window limit. Make anchor more unique if wrong line picked",
                        "E005_HASH_NOT_FOUND": "Hash not in registry â€” returns HashResolutionError. Use stats to check loaded hashes, recall if archived, re-read if dropped",
                        "E006_DELETED_CONTENT": "Source path from hash no longer exists â€” returns {error:'stale',hint:'File path from hash is invalid...'}. Re-read the file"
                    },
                    "anchor_spec": {
                        "matching": "Raw line.contains(anchor) substring match against ALL file lines",
                        "single_match": "Use that line number (ignores edit.line)",
                        "multiple_matches": "Pick closest to edit.line hint (disambiguation, no window limit, no error)",
                        "zero_matches": "Fall back to edit.line, append anchor text to anchor_miss warnings array",
                        "rule": "anchor is truth, line is fallback hint. anchor + line = anchor-first with line as disambiguator"
                    },
                    "workspace_detection": {
                        "build_files": ["package.json","tsconfig.json","Cargo.toml","requirements.txt","pyproject.toml","go.mod","Makefile","CMakeLists.txt","build.gradle","build.gradle.kts","pom.xml","Package.swift","*.sln","*.csproj"],
                        "max_depth": 3,
                        "skip_dirs": ["node_modules","target","dist","build","vendor","__pycache__",".git",".atls","obj","bin"],
                        "source_auto": "Detected from filesystem on project open and action:rescan",
                        "source_manual": "User-added via action:add, preserved across rescans",
                        "when_explicit_needed": "Multiple workspaces detected â€” specify workspace:'name' for verify/git operations"
                    },
                    "hash_lifecycle": {
                        "states": "active â†’ edit â†’ {old: archived (read-only, recallable), new: active} â†’ compact â†’ digest in WM + full in archive â†’ drop â†’ manifest only",
                        "chain_rule": "Each edit returns h:NEW. Use h:NEW for next edit. NEVER reuse h:OLD after edit",
                        "stale_behavior": "peek_lines: returns error. batch_edits: auto-resolves to current (non-blocking). Inconsistent by design â€” peek is strict, batch is forgiving",
                        "archive_access": "Compacted/archived content still resolves via h:ref â€” archive is the backing store",
                        "manifest": "After drop: metadata only (path, symbols, line count). Must re-read to get content back"
                    },
                    "persistent_budget": {
                        "stage_limit": "No hard cap â€” staging always succeeds. Soft ceiling at 25k; stats line warns when exceeded. Entry sigs (entry:*) are permanent and protected from unstage('*'). BP4 cached at 10% cost on Anthropic, 75% discount on Gemini",
                        "bb_limit": "BB_MAX_TOKENS=10000 â€” in working memory block. Cached via systemInstruction on Gemini only; uncached on Anthropic/OpenAI",
                        "combined_ceiling": "Stage (soft 25k) + BB (10k) â€” model self-manages via stats feedback",
                        "overflow": "No overflow â€” staging always succeeds. Keep staged lean by unstaging completed work"
                    },
                    "batch_limits": {
                        "note": "All limits are advisory recommendations, not enforced in code",
                        "creates": "~30 files/call recommended",
                        "edits": "~30 replacements/call recommended",
                        "line_edits": "~30 operations/call recommended (single file)",
                        "batch_edits": "~30 files reasonable per call",
                        "refactor_execute": "No hard limit â€” lint-gated per operation with pause/resume"
                    }
                }))
            }
            "symbol_usage" => {
                let symbol_names: Vec<String> = params
                    .get("symbol_names")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                if symbol_names.is_empty() {
                    return Err("symbol_names required for symbol_usage operation".to_string());
                }

                let verbose = params
                    .get("verbose")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let filter = params
                    .get("filter")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(15);
                
                let mut results = Vec::new();
                for symbol_name in symbol_names {
                    if verbose {
                        match project.query().get_symbol_usage(&symbol_name) {
                            Ok(usage) => {
                                results.push(serde_json::json!({
                                    "symbol": symbol_name,
                                    "definitions": usage.definitions,
                                    "references": usage.references,
                                    "total_refs": usage.references.len(),
                                    "total_definitions": usage.definitions.len()
                                }));
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "symbol": symbol_name,
                                    "error": e.to_string()
                                }));
                            }
                        }
                    } else {
                        match project.query().get_symbol_usage_compact(&symbol_name, filter.as_deref(), limit) {
                            Ok(usage) => {
                                results.push(serde_json::json!({
                                    "symbol": symbol_name,
                                    "defined": usage.definitions,
                                    "used_by": usage.used_by,
                                    "total_refs": usage.total_refs,
                                    "file_count": usage.file_count,
                                    "files_shown": usage.files_shown,
                                    "has_more": usage.has_more
                                }));
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "symbol": symbol_name,
                                    "error": e.to_string()
                                }));
                            }
                        }
                    }
                }
                
                Ok(serde_json::json!({ "results": results }))
            }
            "code_search" => {
                let queries: Vec<String> = params
                    .get("queries")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                if queries.is_empty() {
                    return Err("queries required for code_search operation".to_string());
                }
                
                let limit: usize = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(20);
                
                let compact = params
                    .get("compact")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let grouped = params
                    .get("grouped")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let tiered = params
                    .get("tiered")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let context_lines: usize = params
                    .get("context_lines")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(1);

                let file_paths: Option<Vec<String>> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect());

                let search_cache = app.state::<SearchCacheState>();
                let file_cache = &search_cache.file_cache;

                let mut results = Vec::new();

                // For tiered/grouped modes, keep per-query structure as-is
                let use_dedup = !tiered && !grouped && queries.len() > 1;

                // Cross-query dedup accumulator: (file, symbol, line) -> best result
                let mut dedup_map: std::collections::HashMap<(String, String, u32), atls_core::query::search::CodeSearchResult> = std::collections::HashMap::new();
                let mut dedup_query_hits: std::collections::HashMap<(String, String, u32), usize> = std::collections::HashMap::new();

                for query_str in &queries {
                    // Strip path/ext filter syntax (path:..., ext:...) â€” code_search uses plain FTS5 terms only.
                    // Hyphen (-) treated as space so "recommendations-index" becomes two tokens; FTS5 uses - as NOT operator.
                    let stripped: String = query_str
                        .replace("path:", " ")
                        .replace("ext:", " ")
                        .chars()
                        .map(|c| if "#[]{}().:;*\"'^/\\-".contains(c) { ' ' } else { c })
                        .collect::<String>()
                        .split_whitespace()
                        .collect::<Vec<&str>>()
                        .join(" ");
                    let search_query = if stripped.trim().is_empty() { query_str } else { &stripped };

                    if tiered {
                        match project.query().search_code_tiered(search_query, limit, Some(file_cache)) {
                            Ok(tiered_result) => {
                                let (high, medium) = if let Some(ref fps) = file_paths {
                                    (
                                        tiered_result.high_confidence.into_iter().filter(|r| fps.iter().any(|f| r.file == *f || r.file.starts_with(f.as_str()) || r.file.ends_with(f.as_str()))).collect::<Vec<_>>(),
                                        tiered_result.medium_confidence.into_iter().filter(|r| fps.iter().any(|f| r.file == *f || r.file.starts_with(f.as_str()) || r.file.ends_with(f.as_str()))).collect::<Vec<_>>(),
                                    )
                                } else {
                                    (tiered_result.high_confidence, tiered_result.medium_confidence)
                                };
                                results.push(serde_json::json!({
                                    "query": query_str,
                                    "high": high,
                                    "medium": medium,
                                    "low_count": tiered_result.low_confidence_count,
                                    "total": tiered_result.total_matches
                                }));
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "query": query_str,
                                    "error": e.to_string()
                                }));
                            }
                        }
                    } else if grouped {
                        match project.query().search_code_grouped(search_query, limit, Some(file_cache), context_lines) {
                            Ok(grouped_result) => {
                                let groups = if let Some(ref fps) = file_paths {
                                    grouped_result.groups.into_iter().filter(|g| fps.iter().any(|f| g.file == *f || g.file.starts_with(f.as_str()) || g.file.ends_with(f.as_str()))).collect::<Vec<_>>()
                                } else {
                                    grouped_result.groups
                                };
                                results.push(serde_json::json!({
                                    "query": query_str,
                                    "groups": groups,
                                    "total": grouped_result.total_matches
                                }));
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "query": query_str,
                                    "error": e.to_string()
                                }));
                            }
                        }
                    } else {
                        match project.query().search_code_full(search_query, limit, Some(file_cache), context_lines) {
                            Ok(raw_results) => {
                                let search_results = if let Some(ref fps) = file_paths {
                                    raw_results.into_iter().filter(|r| fps.iter().any(|f| r.file == *f || r.file.starts_with(f.as_str()) || r.file.ends_with(f.as_str()))).collect::<Vec<_>>()
                                } else {
                                    raw_results
                                };
                                if use_dedup {
                                    for r in search_results {
                                        let key = (r.file.clone(), r.symbol.clone(), r.line);
                                        *dedup_query_hits.entry(key.clone()).or_insert(0) += 1;
                                        let entry = dedup_map.entry(key);
                                        entry.and_modify(|existing| {
                                            if r.relevance > existing.relevance {
                                                *existing = r.clone();
                                            }
                                        }).or_insert(r);
                                    }
                                } else if compact {
                                    let compact_results: Vec<serde_json::Value> = search_results
                                        .iter()
                                        .map(|r| {
                                            let cr = r.to_compact();
                                            serde_json::json!({
                                                "s": cr.s,
                                                "f": cr.f,
                                                "l": cr.l,
                                                "k": cr.k,
                                                "r": cr.r,
                                                "c": cr.c
                                            })
                                        })
                                        .collect();
                                    results.push(serde_json::json!({
                                        "q": query_str,
                                        "r": compact_results
                                    }));
                                } else {
                                    results.push(serde_json::json!({
                                        "query": query_str,
                                        "results": search_results
                                    }));
                                }
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "query": query_str,
                                    "error": e.to_string()
                                }));
                            }
                        }
                    }
                }

                // Merge deduped results: boost symbols that matched multiple queries
                if use_dedup {
                    let mut merged: Vec<atls_core::query::search::CodeSearchResult> = dedup_map.into_iter()
                        .map(|(key, mut r)| {
                            let hits = dedup_query_hits.get(&key).copied().unwrap_or(1);
                            if hits > 1 {
                                // Multi-query hit bonus: 10% per extra query, capped at 1.0
                                r.relevance = (r.relevance * (1.0 + 0.1 * (hits - 1) as f64)).min(1.0);
                            }
                            r
                        })
                        .collect();
                    merged.sort_by(|a, b| b.relevance.partial_cmp(&a.relevance).unwrap_or(std::cmp::Ordering::Equal));
                    merged.truncate(limit);

                    if compact {
                        let compact_results: Vec<serde_json::Value> = merged.iter()
                            .map(|r| {
                                let cr = r.to_compact();
                                serde_json::json!({
                                    "s": cr.s, "f": cr.f, "l": cr.l,
                                    "k": cr.k, "r": cr.r, "c": cr.c
                                })
                            })
                            .collect();
                        results.push(serde_json::json!({
                            "q": queries.join(", "),
                            "r": compact_results,
                            "deduped": true
                        }));
                    } else {
                        results.push(serde_json::json!({
                            "queries": queries,
                            "results": merged,
                            "deduped": true
                        }));
                    }
                }
                
                Ok(serde_json::json!({ "results": results }))
            }
            "context" => {
                let context_type = params
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("smart");

                let mut file_paths: Vec<String> = if let Some(single) = params
                    .get("file_path")
                    .and_then(|v| v.as_str())
                {
                    vec![single.to_string()]
                } else {
                    params.get("file_paths")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default()
                };
                
                // tree defaults to project root when no paths specified
                if file_paths.is_empty() && context_type == "tree" {
                    file_paths.push(".".to_string());
                }

                if file_paths.is_empty() {
                    return Err("file_path or file_paths required for context operation".to_string());
                }

                let tree_workspace_rel_paths = &workspace_rel_paths;
                
                let mut results = Vec::new();
                for file_path in file_paths {
                    // Convert to relative path for database lookup (strips \\?\ prefix)
                    let relative_path = to_relative_path(project_root, &file_path);

                    // Register raw file content in hash registry for all context types
                    // so h: references resolve for smart/module/component/test contexts too.
                    // Hoist file_hash via SnapshotService (caches mtime+size, single hash derivation).
                    let file_hash: Option<String> = if context_type != "tree" {
                        let resolved = resolve_project_path(project_root, &file_path);
                        // Use workspace-aware resolution so the registered source path
                        // includes the sub-workspace prefix when needed.
                        let (effective_resolved, effective_fp) = if resolved.exists() {
                            (resolved.clone(), file_path.clone())
                        } else {
                            resolve_source_file_with_workspace_hint(project_root, &file_path, &workspace_rel_paths)
                                .unwrap_or_else(|| (resolved.clone(), file_path.clone()))
                        };
                        let ss_state = app.state::<crate::snapshot::SnapshotServiceState>();
                        let mut snapshot_svc = ss_state.service.lock().await;
                        match snapshot_svc.get_resolved(&effective_resolved, &effective_fp) {
                            Ok(snap) => {
                                let fhash = snap.snapshot_hash.clone();
                                let content_for_registry = if snap.content.is_empty() {
                                    std::fs::read_to_string(&effective_resolved).ok().map(|c| normalize_line_endings(&c))
                                } else {
                                    Some(snap.content.clone())
                                };
                                if let Some(content) = content_for_registry {
                                    let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                    let mut registry = hr_state.registry.lock().await;
                                    let lang = hash_resolver::detect_lang(Some(&effective_fp));
                                    let line_count = content.lines().count();
                                    let prev_rev = registry.get_current_revision(&effective_fp);
                                    registry.register(fhash.clone(), hash_resolver::HashEntry {
                                        source: Some(effective_fp.clone()),
                                        content: content.clone(),
                                        tokens: content.len() / 4,
                                        lang,
                                        line_count,
                                        symbol_count: None,
                                    });
                                    if effective_fp.contains('/') || effective_fp.contains('\\') {
                                        let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                            "path": effective_fp,
                                            "revision": fhash,
                                            "previous_revision": prev_rev
                                        }));
                                    }
                                    // Keep FileCache in sync during migration
                                    if let Ok(meta) = std::fs::metadata(&effective_resolved) {
                                        let fc_state = app.state::<hash_resolver::FileCacheState>();
                                        let mut fc = fc_state.cache.lock().await;
                                        fc.insert(
                                            effective_resolved.to_string_lossy().to_string(),
                                            fhash.clone(),
                                            metadata_modified_ns(&meta),
                                            meta.len(),
                                        );
                                    }
                                }
                                Some(fhash)
                            }
                            Err(_) => None,
                        }
                    } else {
                        None
                    };

                    let history_data: Option<serde_json::Value> = if params.get("history").and_then(|v| v.as_bool()).unwrap_or(false) {
                        if let Some(ref fh) = file_hash {
                            let undo_state = app.state::<UndoStoreState>();
                            let undo_store = undo_state.entries.lock().await;
                            lookup_undo_history(&undo_store, &file_path, Some(fh))
                                .or_else(|| lookup_undo_history(&undo_store, &relative_path, Some(fh)))
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    match context_type {
                        "smart" => {
                            let edit_targets: Vec<String> = params.get("edit_targets")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.replace('\\', "/"))).collect())
                                .unwrap_or_default();
                            let is_edit_target = edit_targets.iter().any(|t| {
                                let fp_norm = file_path.replace('\\', "/");
                                fp_norm == *t || fp_norm.ends_with(t.as_str()) || t.ends_with(fp_norm.as_str())
                            });
                            match project.query().get_smart_context(&relative_path) {
                                Ok(context) => {
                                    let mut entry = serde_json::json!({
                                        "file": file_path,
                                        "context": context
                                    });
                                    if let Some(ref fh) = file_hash {
                                        entry["h"] = serde_json::json!(format!("h:{}", &fh[..hash_resolver::SHORT_HASH_LEN]));
                                        entry["content_hash"] = serde_json::json!(fh);
                                    }
                                    if let Some(ref prev) = history_data {
                                        entry["previous"] = prev.clone();
                                    }
                                    // Auto-include full content for edit targets under 200 lines
                                    if is_edit_target {
                                        let edit_resolved = resolve_project_path(project_root, &file_path);
                                    if let Ok(content) = read_file_with_format(&edit_resolved).map(|(c, _)| c) {
                                            let line_count = content.lines().count();
                                            if line_count <= 200 {
                                                entry["content"] = serde_json::json!(content);
                                                entry["lines"] = serde_json::json!(line_count);
                                                entry["edit_target_expanded"] = serde_json::json!(true);
                                            } else {
                                                entry["lines"] = serde_json::json!(line_count);
                                                entry["edit_target_too_large"] = serde_json::json!(true);
                                            }
                                        }
                                    }
                                    results.push(entry);
                                }
                                Err(e) => {
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "error": e.to_string()
                                    }));
                                }
                            }
                        }
                        "module" => {
                            let depth = params
                                .get("depth")
                                .and_then(|v| v.as_u64())
                                .map(|v| v as u32)
                                .unwrap_or(1);
                            match project.query().get_module_context(&relative_path, depth) {
                                Ok(mut context) => {
                                    // Fallback: if imports empty, scan the file on disk for import statements
                                    if context.imports.is_empty() {
                                        let full_path = resolve_project_path(project_root, &relative_path);
                                        if let Ok(content) = std::fs::read_to_string(&full_path) {
                                            for line in content.lines().take(150) {
                                                let trimmed = line.trim();
                                                if (trimmed.starts_with("import ") || trimmed.starts_with("import{")) && trimmed.contains("from ") {
                                                    if let Some(from_idx) = trimmed.rfind("from ") {
                                                        let module = trimmed[from_idx + 5..].trim_matches(|c: char| c == '\'' || c == '"' || c == ';' || c == ' ');
                                                        if !module.is_empty() { context.imports.push(module.to_string()); }
                                                    }
                                                } else if trimmed.starts_with("from ") && trimmed.contains(" import ") {
                                                    if let Some(m) = trimmed.splitn(3, ' ').nth(1) { context.imports.push(m.to_string()); }
                                                } else if trimmed.starts_with("use ") {
                                                    let m = trimmed["use ".len()..].trim_end_matches(';').trim();
                                                    if !m.is_empty() { context.imports.push(m.to_string()); }
                                                }
                                            }
                                        }
                                    }
                                    let mut entry = serde_json::json!({
                                        "file": file_path,
                                        "context": context
                                    });
                                    if let Some(ref fh) = file_hash {
                                        entry["h"] = serde_json::json!(format!("h:{}", &fh[..hash_resolver::SHORT_HASH_LEN]));
                                        entry["content_hash"] = serde_json::json!(fh);
                                    }
                                    if let Some(ref prev) = history_data {
                                        entry["previous"] = prev.clone();
                                    }
                                    results.push(entry);
                                }
                                Err(e) => {
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "error": e.to_string()
                                    }));
                                }
                            }
                        }
                        "full" => {
                            // No default limit â€” "full" means full file; max_lines only when caller wants partial.
                            // Safety cap at 50k lines to avoid runaway on malformed or huge files.
                            const FULL_MAX_LINES: usize = 50_000;
                            let max_lines = params
                                .get("max_lines")
                                .and_then(|v| v.as_u64())
                                .map(|v| v as usize)
                                .unwrap_or(FULL_MAX_LINES);

                            let line_range: Option<(usize, usize)> = params
                                .get("line_range")
                                .and_then(|v| v.as_array())
                                .and_then(|arr| {
                                    if arr.len() >= 2 {
                                        let start = arr[0].as_u64()? as usize;
                                        let end = arr[1].as_u64()? as usize;
                                        Some((start, end))
                                    } else {
                                        None
                                    }
                                });
                            
                            let resolved_path = resolve_project_path(project_root, &file_path);

                            // Track the effective relative path — may differ from
                            // file_path when workspace fallback resolves a sub-workspace
                            // prefix (e.g. "src/foo.ts" → "atls-studio/src/foo.ts").
                            let mut effective_file_path = file_path.clone();
                            let read_result = read_file_with_format(&resolved_path)
                                .map(|(content, _fmt)| content)
                                .or_else(|_| {
                                    resolve_source_file_with_workspace_hint(project_root, &file_path, &workspace_rel_paths)
                                        .and_then(|(p, effective_rel)| {
                                            read_file_with_format(&p).ok().map(|(content, _fmt)| (content, effective_rel))
                                        })
                                        .map(|(content, effective_rel)| {
                                            effective_file_path = effective_rel;
                                            content
                                        })
                                        .ok_or_else(|| format!("File not found: {}", file_path))
                                });
                            
                            match read_result {
                                Ok(content) => {
                                    // Register via SnapshotService + HashRegistry
                                    let ss_state = app.state::<crate::snapshot::SnapshotServiceState>();
                                    let mut snapshot_svc = ss_state.service.lock().await;
                                    let snap = snapshot_svc.snapshot_from_content(&effective_file_path, &content, None);
                                    let file_hash = snap.snapshot_hash;
                                    drop(snapshot_svc);
                                    {
                                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                        let mut registry = hr_state.registry.lock().await;
                                        let lang = hash_resolver::detect_lang(Some(&effective_file_path));
                                        let line_count = content.lines().count();
                                        let prev_rev = registry.get_current_revision(&effective_file_path);
                                        registry.register(file_hash.clone(), hash_resolver::HashEntry {
                                            source: Some(effective_file_path.clone()),
                                            content: content.clone(),
                                            tokens: content.len() / 4,
                                            lang,
                                            line_count,
                                            symbol_count: None,
                                        });
                                        if effective_file_path.contains('/') || effective_file_path.contains('\\') {
                                            let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                                "path": effective_file_path,
                                                "revision": file_hash,
                                                "previous_revision": prev_rev
                                            }));
                                        }
                                    }

                                    let all_lines: Vec<&str> = content.lines().collect();
                                    let total_lines = all_lines.len();

                                    let (display_lines, truncated) = if let Some((start, end)) = line_range {
                                        let s = start.saturating_sub(1).min(total_lines);
                                        let e = end.min(total_lines);
                                        let slice: Vec<&str> = all_lines[s..e].to_vec();
                                        let cap = max_lines.min(slice.len());
                                        let trunc = slice.len() > max_lines;
                                        (slice.into_iter().take(cap).collect::<Vec<&str>>(), trunc)
                                    } else {
                                        let trunc = total_lines > max_lines;
                                        (all_lines.into_iter().take(max_lines).collect::<Vec<&str>>(), trunc)
                                    };
                                    
                                    let display_content = display_lines.join("\n");

                                    if truncated {
                                        let ss_state2 = app.state::<crate::snapshot::SnapshotServiceState>();
                                        let mut ss2 = ss_state2.service.lock().await;
                                        let display_snap = ss2.snapshot_from_content(&effective_file_path, &display_content, None);
                                        let display_hash = display_snap.snapshot_hash;
                                        drop(ss2);
                                        if display_hash != file_hash {
                                            let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                            let mut registry = hr_state.registry.lock().await;
                                            registry.register(display_hash.clone(), hash_resolver::HashEntry {
                                                source: None,
                                                content: display_content.clone(),
                                                tokens: display_content.len() / 4,
                                                lang: hash_resolver::detect_lang(Some(&effective_file_path)),
                                                line_count: display_content.lines().count(),
                                                symbol_count: None,
                                            });
                                        }
                                    }

                                    results.push(serde_json::json!({
                                        "file": effective_file_path,
                                        "h": format!("h:{}", &file_hash[..hash_resolver::SHORT_HASH_LEN]),
                                        "content_hash": file_hash,
                                        "content": display_content,
                                        "truncated": truncated,
                                        "lines": total_lines
                                    }));
                                }
                                Err(e) => {
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "error": e.to_string(),
                                        "resolved_path": resolved_path.to_string_lossy()
                                    }));
                                }
                            }
                        }
                        "component" => {
                            // React/Vue component context
                            let resolved_path = resolve_project_path(project_root, &file_path);
                            let ext = resolved_path.extension()
                                .and_then(|e| e.to_str())
                                .unwrap_or("");
                            
                            // Check if it's a component file
                            let is_component = matches!(ext, "tsx" | "jsx" | "vue") ||
                                file_path.contains("component") ||
                                file_path.contains("Component");
                            
                            if !is_component {
                                results.push(serde_json::json!({
                                    "file": file_path,
                                    "error": "File does not appear to be a React/Vue component",
                                    "suggestion": "Use context type 'smart' for non-component files"
                                }));
                                continue;
                            }
                            
                            // Get smart context as base
                            let smart_ctx = project.query().get_smart_context(&file_path).ok();
                            
                            // Read file to extract component-specific info
                            let content = std::fs::read_to_string(&resolved_path).unwrap_or_default();
                            
                            // Extract props (look for interface Props or type Props)
                            let props: Vec<&str> = content.lines()
                                .filter(|l| l.contains("Props") || l.contains("props:"))
                                .take(10)
                                .collect();
                            
                            // Extract hooks (useState, useEffect, etc.)
                            let hooks: Vec<&str> = content.lines()
                                .filter(|l| l.contains("use") && (
                                    l.contains("useState") || 
                                    l.contains("useEffect") ||
                                    l.contains("useCallback") ||
                                    l.contains("useMemo") ||
                                    l.contains("useRef") ||
                                    l.contains("useContext")
                                ))
                                .take(20)
                                .collect();
                            
                            // Extract child components (look for <Component tags)
                            let children: Vec<String> = content.lines()
                                .filter_map(|l| {
                                    if let Some(start) = l.find('<') {
                                        let rest = &l[start+1..];
                                        if let Some(end) = rest.find(|c: char| !c.is_alphanumeric()) {
                                            let tag = &rest[..end];
                                            if !tag.is_empty() && tag.chars().next().unwrap().is_uppercase() {
                                                return Some(tag.to_string());
                                            }
                                        }
                                    }
                                    None
                                })
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter()
                                .take(20)
                                .collect();
                            
                            let mut entry = serde_json::json!({
                                "file": file_path,
                                "type": "component",
                                "framework": if ext == "vue" { "vue" } else { "react" },
                                "props_preview": props,
                                "hooks": hooks,
                                "child_components": children,
                                "smart_context": smart_ctx
                            });
                            if let Some(ref fh) = file_hash {
                                entry["h"] = serde_json::json!(format!("h:{}", &fh[..hash_resolver::SHORT_HASH_LEN]));
                                entry["content_hash"] = serde_json::json!(fh);
                            }
                            if let Some(ref prev) = history_data {
                                entry["previous"] = prev.clone();
                            }
                            results.push(entry);
                        }
                        "test" => {
                            // Test context - pair test file with implementation
                            let resolved_path = resolve_project_path(project_root, &file_path);
                            
                            // Detect if this is a test file
                            let is_test = file_path.contains(".test.") ||
                                file_path.contains(".spec.") ||
                                file_path.contains("_test.") ||
                                file_path.contains("__tests__");
                            
                            // Find the corresponding implementation file
                            let impl_file = if is_test {
                                // Test file -> find implementation
                                file_path
                                    .replace(".test.", ".")
                                    .replace(".spec.", ".")
                                    .replace("_test.", ".")
                                    .replace("__tests__/", "")
                            } else {
                                // Implementation file -> find test
                                let stem = resolved_path.file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("");
                                let ext = resolved_path.extension()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("ts");
                                format!("{}.test.{}", stem, ext)
                            };
                            
                            // Read test file content
                            let content = std::fs::read_to_string(&resolved_path).unwrap_or_default();
                            
                            // Extract test names
                            let test_names: Vec<String> = content.lines()
                                .filter_map(|l| {
                                    let l = l.trim();
                                    if l.starts_with("it(") || l.starts_with("test(") || 
                                       l.starts_with("describe(") || l.starts_with("it.") {
                                        // Extract the test name from quotes
                                        if let Some(start) = l.find(|c| c == '\'' || c == '"' || c == '`') {
                                            let rest = &l[start+1..];
                                            let quote = l.chars().nth(start)?;
                                            if let Some(end) = rest.find(quote) {
                                                return Some(rest[..end].to_string());
                                            }
                                        }
                                    }
                                    None
                                })
                                .take(30)
                                .collect();
                            
                            // Get smart context for the file
                            let smart_ctx = project.query().get_smart_context(&file_path).ok();

                            // Check if the paired file actually exists on disk
                            let paired_resolved = resolve_project_path(project_root, &impl_file);
                            let paired_exists = paired_resolved.exists();
                            
                            let mut entry = serde_json::json!({
                                "file": file_path,
                                "type": "test",
                                "is_test_file": is_test,
                                "paired_file": impl_file,
                                "paired_file_exists": paired_exists,
                                "test_names": test_names,
                                "test_count": test_names.len(),
                                "smart_context": smart_ctx
                            });
                            if let Some(ref fh) = file_hash {
                                entry["h"] = serde_json::json!(format!("h:{}", &fh[..hash_resolver::SHORT_HASH_LEN]));
                                entry["content_hash"] = serde_json::json!(fh);
                            }
                            if let Some(ref prev) = history_data {
                                entry["previous"] = prev.clone();
                            }
                            results.push(entry);
                        }
                        "tree" => {
                            let depth = params
                                .get("depth")
                                .and_then(|v| v.as_u64())
                                .map(|v| (v as u32).min(10))
                                .unwrap_or(3);
                            let glob_pattern = params
                                .get("glob")
                                .and_then(|v| v.as_str());

                            let glob_matcher = if let Some(pat) = glob_pattern {
                                let glob = globset::Glob::new(pat)
                                    .map_err(|e| format!("Invalid glob pattern '{}': {}", pat, e))?;
                                Some(glob.compile_matcher())
                            } else {
                                None
                            };

                            let include_ignored = params.get("include_ignored")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let (resolved, tree_root_display) =
                                resolve_tree_directory_path(project_root, &file_path, &tree_workspace_rel_paths);
                            if !resolved.is_dir() {
                                results.push(serde_json::json!({
                                    "root": file_path,
                                    "error": "Not a directory",
                                    "resolved_path": resolved.to_string_lossy(),
                                    "hint": "Path may be under a sub-workspace: try prefixing with the package folder (see system.workspaces list) or open that folder as the project root."
                                }));
                                continue;
                            }

                            let gi = if include_ignored { None } else { load_atlsignore(&resolved) };
                            let tree_format = match params.get("tree_format").and_then(|v| v.as_str()) {
                                Some("indented") => crate::TreeFormat::Indented,
                                Some("compact") | None => crate::TreeFormat::Compact,
                                Some(other) => {
                                    return Err(format!(
                                        "Invalid tree_format '{}' — use compact (default) or indented",
                                        other
                                    ));
                                }
                            };
                            let line_counts = params
                                .get("line_counts")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);

                            let (tree_text, file_count, dir_count, file_paths, file_paths_truncated) =
                                build_compact_tree(
                                &resolved,
                                &resolved,
                                depth,
                                glob_matcher.as_ref(),
                                gi.as_ref(),
                                tree_format,
                                line_counts,
                            );

                            results.push(serde_json::json!({
                                "root": tree_root_display,
                                "files": file_count,
                                "dirs": dir_count,
                                "tree": tree_text,
                                "file_paths": file_paths,
                                "file_paths_truncated": file_paths_truncated
                            }));
                        }
                        _ => {
                            return Err(format!("Unsupported context type: {}. Use: smart, module, full, component, test, tree", context_type));
                        }
                    }
                }
                
                Ok(serde_json::json!({ "results": results }))
            }
            "dependencies" => {
                let file_paths: Vec<String> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                if file_paths.is_empty() {
                    return Err("file_paths required for dependencies operation".to_string());
                }
                
                let mode = params
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("graph");
                
                let mut results = Vec::new();
                for file_path in file_paths {
                    // Convert to relative path for database lookup
                    let relative_path = to_relative_path(project_root, &file_path);
                    
                    match mode {
                        "graph" => {
                            match project.query().get_file_graph(&relative_path, 20) {
                                Ok(Some(graph)) => {
                                    let mut graph_json = serde_json::to_value(&graph).unwrap_or(serde_json::json!(null));
                                    // Fallback: if outgoing is empty, scan file for import statements
                                    if graph.outgoing.is_empty() {
                                        let full_path = resolve_project_path(project_root, &file_path);
                                        if let Ok(content) = std::fs::read_to_string(&full_path) {
                                            let imports: Vec<serde_json::Value> = atls_core::query::parse_imports_from_content(&content, 150)
                                                .into_iter()
                                                .map(|m| serde_json::json!({"path": m, "relation_type": "IMPORTS"}))
                                                .collect();
                                            if !imports.is_empty() {
                                                if let Some(obj) = graph_json.as_object_mut() {
                                                    obj.insert("outgoing".to_string(), serde_json::json!(imports));
                                                }
                                            }
                                        }
                                    }
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "graph": graph_json
                                    }));
                                }
                                Ok(None) => {
                                    // File not in DB - still try to extract imports from disk
                                    let full_path = resolve_project_path(project_root, &file_path);
                                    let outgoing: Vec<serde_json::Value> = if let Ok(content) = std::fs::read_to_string(&full_path) {
                                        atls_core::query::parse_imports_from_content(&content, 150)
                                            .into_iter()
                                            .map(|m| serde_json::json!({"path": m, "relation_type": "IMPORTS"}))
                                            .collect()
                                    } else {
                                        Vec::new()
                                    };
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "graph": {
                                            "incoming": [],
                                            "outgoing": outgoing,
                                            "symbols": []
                                        }
                                    }));
                                }
                                Err(e) => {
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "error": e.to_string()
                                    }));
                                }
                            }
                        }
                        "related" => {
                            let depth = params
                                .get("depth")
                                .and_then(|v| v.as_u64())
                                .map(|v| v as u32)
                                .unwrap_or(2);
                            let limit = params
                                .get("limit")
                                .and_then(|v| v.as_u64())
                                .map(|v| v as usize)
                                .unwrap_or(30);
                            let filter = params
                                .get("filter")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_lowercase());

                            match project.query().get_related_files(&relative_path, depth) {
                                Ok(related) => {
                                    let mut final_related = if params
                                        .get("include_imports")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false)
                                    {
                                        let full_path = resolve_project_path(project_root, &file_path);
                                        if let Ok(content) = std::fs::read_to_string(&full_path) {
                                            atls_core::query::parse_imports_from_content(&content, 150)
                                                .into_iter()
                                                .map(|m| serde_json::json!({
                                                    "path": m,
                                                    "relation": "IMPORTS",
                                                    "depth": 1
                                                }))
                                                .collect::<Vec<_>>()
                                        } else {
                                            serde_json::to_value(&related).unwrap_or(serde_json::json!([]))
                                                .as_array().cloned().unwrap_or_default()
                                        }
                                    } else {
                                        serde_json::to_value(&related).unwrap_or(serde_json::json!([]))
                                            .as_array().cloned().unwrap_or_default()
                                    };

                                    if let Some(ref f) = filter {
                                        final_related.retain(|v: &serde_json::Value| {
                                            v.get("path")
                                                .and_then(serde_json::Value::as_str)
                                                .map(|p: &str| p.to_lowercase().contains(f))
                                                .unwrap_or(false)
                                        });
                                    }

                                    let total_related = final_related.len();
                                    let has_more = total_related > limit;
                                    final_related.truncate(limit);

                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "related": final_related,
                                        "total_related": total_related,
                                        "shown": final_related.len(),
                                        "has_more": has_more
                                    }));
                                }
                                Err(e) => {
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "error": e.to_string()
                                    }));
                                }
                            }
                        }
                        "impact" => {
                            // Impact analysis - show what would be affected by changes
                            match project.query().get_change_impact(&[relative_path.clone()]) {
                                Ok(impact) => {
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "direct_dependents": impact.direct_dependents,
                                        "indirect_dependents": impact.indirect_dependents,
                                        "affected_symbols": impact.affected_symbols,
                                        "summary": impact.summary
                                    }));
                                }
                                Err(e) => {
                                    results.push(serde_json::json!({
                                        "file": file_path,
                                        "error": e.to_string()
                                    }));
                                }
                            }
                        }
                        _ => {
                            return Err(format!("Unsupported dependencies mode: {}. Use: graph, related, impact", mode));
                        }
                    }
                }
                
                Ok(serde_json::json!({ "results": results }))
            }
            "call_hierarchy" => {
                let symbol_names: Vec<String> = params
                    .get("symbol_names")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                if symbol_names.is_empty() {
                    return Err("symbol_names required for call_hierarchy operation".to_string());
                }
                
                let depth = params
                    .get("depth")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32)
                    .unwrap_or(2);

                let verbose = params
                    .get("verbose")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let filter = params
                    .get("filter")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(10);
                
                let mut results = Vec::new();
                for symbol_name in &symbol_names {
                    if verbose {
                        match project.query().get_call_hierarchy(symbol_name, depth) {
                            Ok(hierarchy) => {
                                if hierarchy.is_empty() {
                                    results.push(serde_json::json!({
                                        "symbol": symbol_name,
                                        "hierarchy": [],
                                        "reason": "symbol_not_indexed"
                                    }));
                                } else {
                                    let node = &hierarchy[0];
                                    let reason = if node.callers.is_empty() && node.callees.is_empty() {
                                        Some("isolated_function")
                                    } else {
                                        None
                                    };
                                    let mut entry = serde_json::json!({
                                        "symbol": symbol_name,
                                        "hierarchy": hierarchy
                                    });
                                    if let Some(r) = reason {
                                        entry.as_object_mut().unwrap().insert("reason".to_string(), serde_json::json!(r));
                                    }
                                    results.push(entry);
                                }
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "symbol": symbol_name,
                                    "error": e.to_string()
                                }));
                            }
                        }
                    } else {
                        match project.query().get_call_hierarchy_compact(symbol_name, depth, filter.as_deref(), limit) {
                            Ok(hierarchy) => {
                                if hierarchy.is_empty() {
                                    results.push(serde_json::json!({
                                        "symbol": symbol_name,
                                        "reason": "symbol_not_indexed"
                                    }));
                                } else {
                                    let node = &hierarchy[0];
                                    let mut obj = serde_json::json!({
                                        "symbol": symbol_name,
                                        "file": node.file,
                                        "line": node.line,
                                        "kind": node.kind,
                                        "callers": node.callers,
                                        "callees": node.callees,
                                        "total_callers": node.total_callers,
                                        "total_callees": node.total_callees
                                    });
                                    if let Some(el) = node.end_line {
                                        obj["end_line"] = serde_json::json!(el);
                                    }
                                    results.push(obj);
                                }
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "symbol": symbol_name,
                                    "error": e.to_string()
                                }));
                            }
                        }
                    }
                }
                
                Ok(serde_json::json!({ "results": results }))
            }
            "symbol_dep_graph" => {
                let file_paths: Vec<String> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                if file_paths.is_empty() {
                    return Err("file_paths required for symbol_dep_graph operation".to_string());
                }
                let kind_filter: Option<Vec<String>> = params
                    .get("kinds")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());
                let kind_refs: Option<Vec<&str>> = kind_filter.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());
                let hub_threshold: Option<usize> = params
                    .get("hub_threshold")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize);
                let exclude_hubs = params
                    .get("exclude_hubs")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let mut results = Vec::new();
                for fp in &file_paths {
                    let resolved = resolve_project_path(project_root, fp);
                    let relative_path = to_relative_path(project_root, resolved.to_string_lossy().as_ref())
                        .replace('\\', "/");
                    match project.query().get_file_symbol_deps(
                        &relative_path, kind_refs.as_deref(), hub_threshold, exclude_hubs,
                    ) {
                        Ok(graph) => results.push(graph),
                        Err(e) => results.push(serde_json::json!({
                            "file": fp, "error": e.to_string()
                        })),
                    }
                }
                if results.len() == 1 {
                    Ok(results.into_iter().next().unwrap())
                } else {
                    Ok(serde_json::json!({ "results": results }))
                }
            }
            "suggest_operations" => {
                let intent = params
                    .get("intent")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let intent_lower = intent.to_lowercase();
                
                let recommendations: Vec<serde_json::Value> = if intent_lower.contains("understand") || intent_lower.contains("how") || intent_lower.contains("what") {
                    vec![
                        serde_json::json!({"operation": "context", "params": "type:smart, file_paths:[...]", "description": "Get file structure and symbols"}),
                        serde_json::json!({"operation": "code_search", "params": "queries:[...]", "description": "Find relevant code by meaning"}),
                        serde_json::json!({"operation": "call_hierarchy", "params": "symbol_names:[...]", "description": "Trace function call relationships"}),
                    ]
                } else if intent_lower.contains("fix") || intent_lower.contains("issue") || intent_lower.contains("bug") {
                    vec![
                        serde_json::json!({"operation": "find_issues", "params": "file_paths:[...]", "description": "Find issues in files"}),
                        serde_json::json!({"operation": "context", "params": "type:smart", "description": "Understand issue context"}),
                        serde_json::json!({"operation": "edit", "params": "line_edits:[...], deep_check:true", "description": "Apply fix with lint check"}),
                        serde_json::json!({"operation": "verify", "params": "type:test", "description": "Run tests to verify fixes"}),
                    ]
                } else if intent_lower.contains("refactor") || intent_lower.contains("extract") || intent_lower.contains("move") {
                    vec![
                        serde_json::json!({"operation": "context", "params": "type:smart", "description": "Understand current structure"}),
                        serde_json::json!({"operation": "symbol_usage", "params": "symbol_names:[...]", "description": "Find all usages"}),
                        serde_json::json!({"operation": "dependencies", "params": "mode:related", "description": "See affected files"}),
                        serde_json::json!({"operation": "verify", "params": "type:typecheck", "description": "Verify types after refactoring"}),
                    ]
                } else if intent_lower.contains("edit") || intent_lower.contains("change") || intent_lower.contains("modify") {
                    vec![
                        serde_json::json!({"operation": "context", "params": "type:full, file_paths:[...]", "description": "Read file content"}),
                        serde_json::json!({"operation": "edit", "params": "line_edits:[{line,action,content}], deep_check:true", "description": "Edit by line (applies directly, lint-checked)"}),
                        serde_json::json!({"operation": "verify", "params": "type:typecheck", "description": "Verify types after edit"}),
                    ]
                } else if intent_lower.contains("find") || intent_lower.contains("search") || intent_lower.contains("where") {
                    vec![
                        serde_json::json!({"operation": "code_search", "params": "queries:[...]", "description": "Search by meaning"}),
                        serde_json::json!({"operation": "symbol_usage", "params": "symbol_names:[...]", "description": "Find symbol definitions and references"}),
                        serde_json::json!({"operation": "find_symbol", "params": "query:...", "description": "Find symbol by name"}),
                    ]
                } else if intent_lower.contains("depend") || intent_lower.contains("import") {
                    vec![
                        serde_json::json!({"operation": "dependencies", "params": "mode:graph", "description": "Import/export graph"}),
                        serde_json::json!({"operation": "dependencies", "params": "mode:related", "description": "Related files"}),
                    ]
                } else if intent_lower.contains("test") || intent_lower.contains("verify") || intent_lower.contains("check") {
                    vec![
                        serde_json::json!({"operation": "verify", "params": "type:test, target_dir:subdir (optional)", "description": "Run tests (auto-detects project, target_dir for monorepos)"}),
                        serde_json::json!({"operation": "verify", "params": "type:build", "description": "Build project"}),
                        serde_json::json!({"operation": "verify", "params": "type:typecheck", "description": "TypeScript check (detects tsconfig.json)"}),
                        serde_json::json!({"operation": "verify", "params": "type:lint", "description": "Run linter"}),
                    ]
                } else if intent_lower.contains("commit") || intent_lower.contains("push") || intent_lower.contains("git") || intent_lower.contains("ship") {
                    vec![
                        serde_json::json!({"operation": "git", "params": "action:status", "description": "Check git status"}),
                        serde_json::json!({"operation": "git", "params": "action:diff", "description": "View changes"}),
                        serde_json::json!({"operation": "git", "params": "action:stage, files:[...] or all:true", "description": "Stage changes"}),
                        serde_json::json!({"operation": "git", "params": "action:commit, message:'...', all:true optional (git commit -a)", "description": "Commit changes"}),
                        serde_json::json!({"operation": "git", "params": "action:push", "description": "Push to remote"}),
                    ]
                } else if intent_lower.contains("deploy") || intent_lower.contains("release") || intent_lower.contains("complete") {
                    vec![
                        serde_json::json!({"operation": "verify", "params": "type:build", "description": "Ensure build passes"}),
                        serde_json::json!({"operation": "verify", "params": "type:test", "description": "Ensure tests pass"}),
                        serde_json::json!({"operation": "git", "params": "action:status", "description": "Check for uncommitted changes"}),
                        serde_json::json!({"operation": "git", "params": "action:commit, message:'...', all:true optional", "description": "Commit if needed"}),
                        serde_json::json!({"operation": "git", "params": "action:push", "description": "Push to remote"}),
                    ]
                } else {
                    vec![
                        serde_json::json!({"operation": "code_search", "params": "queries:[...]", "description": "Search by meaning"}),
                        serde_json::json!({"operation": "context", "params": "type:smart", "description": "Understand a file"}),
                        serde_json::json!({"operation": "find_issues", "params": "", "description": "Find code issues"}),
                        serde_json::json!({"operation": "verify", "params": "type:test", "description": "Run tests"}),
                        serde_json::json!({"operation": "git", "params": "action:status", "description": "Check git status"}),
                    ]
                };
                
                Ok(serde_json::json!({
                    "intent": intent,
                    "recommended": recommendations
                }))
            }
            "symbol_edit" => {
                // Symbol-level editing using line ranges from the index
                let edits = params
                    .get("edits")
                    .and_then(|v| v.as_array())
                    .ok_or("edits array required for symbol_edit operation")?;
                
                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                let lint_enabled = params
                    .get("lint")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                let mut results = Vec::new();
                let mut modified_file_paths: Vec<String> = Vec::new();
                let project_root_str = project_root.to_string_lossy().replace('\\', "/");
                let lookup = QuerySymbolLookup { query: project.query() };

                // Phase 1: Resolve all symbol ranges upfront and group by file
                struct ResolvedEdit<'a> {
                    file: String,
                    file_normalized: String,
                    symbol: String,
                    action: String,
                    content: String,
                    scope: String,
                    wrapper: Option<String>,
                    target: Option<String>,
                    start_line: u32,
                    end_line: u32,
                    kind: String,
                    #[allow(dead_code)]
                    edit_ref: &'a serde_json::Value,
                }

                let mut resolved_edits: Vec<ResolvedEdit> = Vec::new();
                for edit in edits {
                    let file = edit.get("file").and_then(|v| v.as_str()).unwrap_or("");
                    let symbol = edit.get("symbol").and_then(|v| v.as_str()).unwrap_or("");
                    let action = edit.get("action").and_then(|v| v.as_str()).unwrap_or("replace");
                    let content = edit.get("content").and_then(|v| v.as_str()).unwrap_or("");

                    if file.is_empty() || symbol.is_empty() {
                        results.push(serde_json::json!({
                            "file": file, "symbol": symbol,
                            "error": "file and symbol are required"
                        }));
                        continue;
                    }

                    let resolved_path = resolve_project_path(project_root, file);
                    let file_normalized = file.replace('\\', "/");
                    let file_lookup = normalize_for_lookup(file, project_root);

                    let lookup_result = project.query().get_symbol_line_range(&file_lookup, symbol)
                        .or_else(|_| project.query().get_symbol_line_range(file, symbol));

                    match lookup_result {
                        Ok(Some(range)) => {
                            let scope = edit.get("scope").and_then(|v| v.as_str()).unwrap_or(
                                match action { "wrap" => "inner", _ => "outer" }
                            ).to_string();
                            resolved_edits.push(ResolvedEdit {
                                file: file.to_string(),
                                file_normalized,
                                symbol: symbol.to_string(),
                                action: action.to_string(),
                                content: content.to_string(),
                                scope,
                                wrapper: edit.get("wrapper").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                target: edit.get("target").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                start_line: range.start_line,
                                end_line: range.end_line,
                                kind: range.kind.clone(),
                                edit_ref: edit,
                            });
                        }
                        Ok(None) => {
                            // Symbol not found â€” try to provide available symbols as suggestions
                            let resolved_str = resolved_path.to_string_lossy().replace('\\', "/");
                            let relative_path = if resolved_str.starts_with(&project_root_str) {
                                resolved_str.trim_start_matches(&project_root_str).trim_start_matches('/').to_string()
                            } else {
                                file_normalized.clone()
                            };
                            
                            // Query available symbols in this file for suggestions
                            let available_symbols: Vec<serde_json::Value> = {
                                let db = project.db();
                                let conn = db.conn();
                                let path_fwd = file_normalized.clone();
                                let path_pattern = format!("%{}", path_fwd);
                                
                                // Find file_id
                                let file_id: Option<i64> = conn.query_row(
                                    "SELECT id FROM files WHERE path = ? OR path LIKE ? LIMIT 1",
                                    rusqlite::params![&path_fwd, &path_pattern],
                                    |row| row.get(0)
                                ).ok();
                                
                                if let Some(fid) = file_id {
                                    // Get top symbols, preferring case-insensitive partial matches
                                    let symbol_lower = symbol.to_lowercase();
                                    let mut stmt = conn.prepare(
                                        "SELECT name, kind, line FROM symbols WHERE file_id = ? ORDER BY line LIMIT 30"
                                    ).ok();
                                    
                                    if let Some(ref mut s) = stmt {
                                        let rows = s.query_map(rusqlite::params![fid], |row| {
                                            Ok((
                                                row.get::<_, String>(0)?,
                                                row.get::<_, String>(1)?,
                                                row.get::<_, u32>(2)?,
                                            ))
                                        }).ok();
                                        
                                        if let Some(rows) = rows {
                                            let all: Vec<_> = rows.filter_map(|r| r.ok()).collect();
                                            // Prioritize partial matches, then show top by line
                                            let mut scored: Vec<_> = all.iter().map(|(name, kind, line)| {
                                                let name_lower = name.to_lowercase();
                                                let score = if name_lower == symbol_lower { 100 }
                                                    else if name_lower.contains(&symbol_lower) { 50 }
                                                    else if symbol_lower.contains(&name_lower) { 30 }
                                                    else { 0 };
                                                (score, name, kind, line)
                                            }).collect();
                                            scored.sort_by(|a, b| b.0.cmp(&a.0));
                                            scored.iter().take(10).map(|(score, name, kind, line)| {
                                                serde_json::json!({
                                                    "name": name,
                                                    "kind": kind,
                                                    "line": line,
                                                    "match_score": score
                                                })
                                            }).collect()
                                        } else { vec![] }
                                    } else { vec![] }
                                } else { vec![] }
                            };
                            
                            results.push(serde_json::json!({
                                "file": file,
                                "symbol": symbol,
                                "error": "Symbol not found in file",
                                "available_symbols": available_symbols,
                                "debug": {
                                    "tried_paths": [file, &file_normalized, &relative_path],
                                    "project_root": project_root_str
                                },
                                "hint": if available_symbols.is_empty() {
                                    "File not in index. Run scan_project, then retry."
                                } else {
                                    "Symbol not found. See available_symbols for valid names in this file."
                                }
                            }));
                        }
                        Err(e) => {
                            results.push(serde_json::json!({
                                "file": file,
                                "symbol": symbol,
                                "error": format!("Failed to get symbol range: {}", e)
                            }));
                        }
                    }
                }

                // Phase 2: Group by file, sort by start_line descending, apply bottom-up
                let mut edits_by_file: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
                for (i, re) in resolved_edits.iter().enumerate() {
                    edits_by_file.entry(re.file.clone()).or_default().push(i);
                }

                for (file_key, mut edit_indices) in edits_by_file {
                    // Sort by start_line descending so bottom edits don't shift top ranges
                    edit_indices.sort_by(|a, b| {
                        resolved_edits[*b].start_line.cmp(&resolved_edits[*a].start_line)
                    });

                    let resolved_path = resolve_project_path(project_root, &file_key);
                    let file_content = match std::fs::read_to_string(&resolved_path).map(|c| normalize_line_endings(&c)) {
                        Ok(c) => c,
                        Err(e) => {
                            for &idx in &edit_indices {
                                let re = &resolved_edits[idx];
                                results.push(serde_json::json!({
                                    "file": re.file, "symbol": re.symbol,
                                    "error": format!("Failed to read file: {}", e),
                                }));
                            }
                            continue;
                        }
                    };

                    let mut current_content = file_content;

                    for &idx in &edit_indices {
                        let re = &resolved_edits[idx];
                        let lines: Vec<&str> = current_content.lines().collect();
                        let start_idx = (re.start_line as usize).saturating_sub(1);
                        let end_idx = std::cmp::min(re.end_line as usize, lines.len());

                        if start_idx >= lines.len() || start_idx >= end_idx {
                            results.push(serde_json::json!({
                                "file": re.file, "symbol": re.symbol,
                                "error": "Symbol range out of bounds (file may have changed)"
                            }));
                            continue;
                        }

                        let symbol_lines: Vec<&str> = lines[start_idx..end_idx].to_vec();

                        let edit_result = apply_symbol_edit_action(
                            &symbol_lines, &re.action, &re.content, &re.scope,
                            re.wrapper.as_deref(), re.target.as_deref(),
                            &lines, start_idx, end_idx,
                            Some(&lookup as &dyn SymbolLookup), &re.file_normalized,
                        );

                        match edit_result {
                            Ok(symbol_result) => {
                                let new_lines: Vec<String> = if re.action == "move" {
                                    symbol_result
                                } else {
                                    let mut nl: Vec<String> = Vec::new();
                                    for line in lines.iter().take(start_idx) {
                                        nl.push(line.to_string());
                                    }
                                    nl.extend(symbol_result);
                                    for line in lines.iter().skip(end_idx) {
                                        nl.push(line.to_string());
                                    }
                                    nl
                                };

                                let new_content = new_lines.join("\n");

                                if dry_run {
                                    let old_content: Vec<&str> = lines[start_idx..end_idx].to_vec();
                                    results.push(serde_json::json!({
                                        "file": re.file, "symbol": re.symbol,
                                        "range": { "start_line": re.start_line, "end_line": re.end_line, "kind": re.kind },
                                        "action": re.action,
                                        "preview": { "old": old_content.join("\n"), "new": re.content },
                                        "status": "preview"
                                    }));
                                } else {
                                    // Update in-memory content for next edit on same file
                                    current_content = new_content;
                                    results.push(serde_json::json!({
                                        "file": re.file, "symbol": re.symbol,
                                        "range": { "start_line": re.start_line, "end_line": re.end_line, "kind": re.kind },
                                        "action": re.action,
                                        "status": "applied"
                                    }));
                                }
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "file": re.file, "symbol": re.symbol, "error": e
                                }));
                            }
                        }
                    }

                    // Write once per file after all edits are applied
                    if !dry_run {
                        match crate::snapshot::atomic_write(&resolved_path, current_content.as_bytes()) {
                            Ok(()) => {
                                if !modified_file_paths.contains(&file_key) {
                                    modified_file_paths.push(file_key);
                                }
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "error": format!("Failed to write file {}: {}", resolved_path.display(), e)
                                }));
                            }
                        }
                    }
                }

                // Post-write linting and incremental indexing
                let lint_summary = if !dry_run && lint_enabled && !modified_file_paths.is_empty() {
                    let (_, summary) = lint_written_files(project_root, &modified_file_paths);
                    summary
                } else {
                    None
                };
                let index_result = if !dry_run && !modified_file_paths.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), modified_file_paths.clone()).await
                } else {
                    serde_json::json!(null)
                };
                
                Ok(serde_json::json!({
                    "results": results,
                    "lints": lint_summary,
                    "index": index_result,
                    "summary": {
                        "files_modified": modified_file_paths.len(),
                        "lints": lint_summary.as_ref().map(|s| s.total).unwrap_or(0)
                    }
                }))
            }
            "find_symbol" => {
                // Fuzzy symbol search using atls-core
                // Accept: query (string), name (string alias), or symbol_names (array - uses first)
                let query_raw = params
                    .get("query")
                    .and_then(|v| v.as_str())
                    .or_else(|| params.get("name").and_then(|v| v.as_str()))
                    .or_else(|| params.get("symbol_names").and_then(|v| v.as_array()).and_then(|arr| arr.first()).and_then(|v| v.as_str()))
                    .ok_or("query required for find_symbol operation (also accepts: name, symbol_names)")?;
                // Support fn(name)/cls(name) style: extract bare name for DB (symbols table stores name only)
                let query = shape_ops::parse_symbol_anchor_str(query_raw)
                    .map(|(_, name)| name.to_string())
                    .unwrap_or_else(|| query_raw.to_string());
                
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(20);
                
                match project.query().find_symbol(&query) {
                    Ok(symbols) => {
                        // Batch resolve file_ids to file paths
                        let file_ids: Vec<i64> = symbols.iter().map(|s| s.file_id).collect();
                        let file_path_map: std::collections::HashMap<i64, String> = if !file_ids.is_empty() {
                            let conn = project.query().db().conn();
                            let placeholders = file_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                            let sql = format!("SELECT id, path FROM files WHERE id IN ({})", placeholders);
                            let mut stmt = conn.prepare(&sql).unwrap_or_else(|_| panic!("Failed to prepare"));
                            let params: Vec<Box<dyn rusqlite::types::ToSql>> = file_ids.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>).collect();
                            let rows = stmt.query_map(rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())), |row| {
                                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                            }).unwrap_or_else(|_| panic!("Failed to query"));
                            rows.filter_map(|r| r.ok()).collect()
                        } else {
                            std::collections::HashMap::new()
                        };

                        let results: Vec<serde_json::Value> = symbols
                            .into_iter()
                            .take(limit)
                            .map(|s| {
                                let file = file_path_map.get(&s.file_id).cloned().unwrap_or_default();
                                serde_json::json!({
                                    "name": s.name,
                                    "kind": s.kind,
                                    "file": file,
                                    "file_id": s.file_id,
                                    "line": s.line,
                                    "signature": s.signature,
                                    "rank": s.rank
                                })
                            })
                            .collect();
                        
                        if results.is_empty() {
                            // Fallback: provide fuzzy suggestions
                            let suggestions = project.query().find_symbol_suggestions(&query, 3)
                                .unwrap_or_default()
                                .into_iter()
                                .map(|(name, kind, score)| serde_json::json!({
                                    "name": name,
                                    "kind": kind,
                                    "score": format!("{:.2}", score)
                                }))
                                .collect::<Vec<_>>();
                            Ok(serde_json::json!({
                                "query": query,
                                "results": [],
                                "suggestions": suggestions
                            }))
                        } else {
                            Ok(serde_json::json!({
                                "query": query,
                                "results": results
                            }))
                        }
                    }
                    Err(e) => {
                        Err(format!("Symbol search failed: {}", e))
                    }
                }
            }
            "git" => {
                // Structured git operations for AI autonomous workflows
                let action = params
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or("status");
                
                let git_root = if let Some(ws_name) = params.get("workspace").and_then(|v| v.as_str()) {
                    // If workspace looks like a path (contains : or / or \), use it directly when valid
                    let is_path_like = ws_name.contains(':') || ws_name.contains('/') || ws_name.contains('\\');
                    if is_path_like {
                        let path = std::path::Path::new(ws_name);
                        if path.is_dir() {
                            path.canonicalize()
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_else(|_| ws_name.to_string())
                        } else {
                            return Err(format!(
                                "Workspace '{}' looks like a path but is not a valid directory. Use a detected workspace name (e.g. go-gin, rust-tokio) or omit workspace for project root.",
                                ws_name
                            ));
                        }
                    } else {
                        let roots_lock = state.roots.lock().await;
                        let all_ws: Vec<WorkspaceEntry> = roots_lock.iter()
                            .flat_map(|r| r.sub_workspaces.iter().cloned())
                            .collect();
                        resolve_workspace_fuzzy(&all_ws, ws_name).map_err(|e| format!(
                            "{}. Tip: workspace expects a detected name (e.g. go-gin) or an absolute path to the repo root.",
                            e
                        ))?
                    }
                } else {
                    project_root.to_string_lossy().to_string()
                };
                let project_root_str = git_root;
                
                // Serialize git operations per-repo to avoid index.lock contention
                let git_state = app.state::<GitOpState>();
                let _git_guard = git_state.lock_for(&project_root_str).await;
                
                match action {
                    "status" => {
                        let output = run_git_command(
                            vec!["status".into(), "--porcelain".into(), "-b".into()],
                            project_root_str.clone(),
                        ).await?;
                        
                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            return Err(format!("git status failed: {}", stderr));
                        }
                        
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let lines: Vec<&str> = stdout.lines().collect();
                        
                        // Parse branch info from first line (## branch...tracking)
                        let mut branch = String::new();
                        let mut ahead = 0i32;
                        let mut behind = 0i32;
                        
                        if let Some(first_line) = lines.first() {
                            if first_line.starts_with("## ") {
                                let branch_info = &first_line[3..];
                                if let Some(dotdot) = branch_info.find("...") {
                                    branch = branch_info[..dotdot].to_string();
                                    // Parse ahead/behind
                                    if let Some(bracket_start) = branch_info.find('[') {
                                        let tracking_info = &branch_info[bracket_start..];
                                        if tracking_info.contains("ahead ") {
                                            if let Some(start) = tracking_info.find("ahead ") {
                                                let rest = &tracking_info[start + 6..];
                                                let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                                                ahead = num_str.parse().unwrap_or(0);
                                            }
                                        }
                                        if tracking_info.contains("behind ") {
                                            if let Some(start) = tracking_info.find("behind ") {
                                                let rest = &tracking_info[start + 7..];
                                                let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                                                behind = num_str.parse().unwrap_or(0);
                                            }
                                        }
                                    }
                                } else {
                                    branch = branch_info.to_string();
                                }
                            }
                        }
                        
                        // Parse file statuses
                        let mut staged: Vec<serde_json::Value> = Vec::new();
                        let mut modified: Vec<serde_json::Value> = Vec::new();
                        let mut untracked: Vec<serde_json::Value> = Vec::new();
                        let mut deleted: Vec<serde_json::Value> = Vec::new();
                        
                        for line in lines.iter().skip(1) {
                            if line.len() < 3 { continue; }
                            let index_status = line.chars().next().unwrap_or(' ');
                            let worktree_status = line.chars().nth(1).unwrap_or(' ');
                            let file_path = line[3..].to_string();
                            
                            // Index status (staged)
                            match index_status {
                                'A' | 'M' | 'R' | 'C' => {
                                    staged.push(serde_json::json!({
                                        "path": file_path,
                                        "status": match index_status {
                                            'A' => "added",
                                            'M' => "modified",
                                            'R' => "renamed",
                                            'C' => "copied",
                                            _ => "unknown"
                                        }
                                    }));
                                }
                                'D' => {
                                    staged.push(serde_json::json!({
                                        "path": file_path,
                                        "status": "deleted"
                                    }));
                                }
                                _ => {}
                            }
                            
                            // Worktree status (unstaged)
                            match worktree_status {
                                'M' => {
                                    modified.push(serde_json::json!(file_path));
                                }
                                'D' => {
                                    deleted.push(serde_json::json!(file_path));
                                }
                                _ => {}
                            }
                            
                            // Untracked
                            if index_status == '?' && worktree_status == '?' {
                                untracked.push(serde_json::json!(file_path));
                            }
                        }
                        
                        Ok(serde_json::json!({
                            "action": "status",
                            "branch": branch,
                            "ahead": ahead,
                            "behind": behind,
                            "staged": staged,
                            "modified": modified,
                            "untracked": untracked,
                            "deleted": deleted,
                            "clean": staged.is_empty() && modified.is_empty() && untracked.is_empty() && deleted.is_empty(),
                            "_next": if !staged.is_empty() {
                                "Ready to commit: q: g1 system.git action:commit message:\"...\""
                            } else if !modified.is_empty() || !untracked.is_empty() {
                                "Stage files: q: g1 system.git action:stage files:..."
                            } else {
                                "Working tree clean"
                            }
                        }))
                    }
                    "diff" => {
                        let file_paths: Vec<String> = params
                            .get("files")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                            .unwrap_or_default();
                        
                        let staged = params
                            .get("staged")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        
                        // Get summary diff (single call)
                        let mut stat_args: Vec<String> = vec!["diff".into(), "--stat".into()];
                        if staged { stat_args.push("--cached".into()); }
                        
                        let output = run_git_command(stat_args, project_root_str.clone()).await?;
                        let stat_output = String::from_utf8_lossy(&output.stdout).to_string();
                        
                        // Build a single diff call for all files (avoids N subprocess spawns)
                        let files_to_diff: Vec<String> = if file_paths.is_empty() {
                            stat_output.lines()
                                .filter(|line| line.contains(" | "))
                                .filter_map(|line| line.split(" | ").next())
                                .map(|s| s.trim().to_string())
                                .take(10)
                                .collect()
                        } else {
                            file_paths.into_iter().take(10).collect()
                        };
                        
                        let mut diff_args: Vec<String> = vec!["diff".into(), "-U3".into()];
                        if staged { diff_args.push("--cached".into()); }
                        diff_args.push("--".into());
                        for f in &files_to_diff {
                            diff_args.push(f.clone());
                        }
                        
                        let diff_output = run_git_command(diff_args, project_root_str.clone()).await?;
                        let diff_content = String::from_utf8_lossy(&diff_output.stdout);
                        
                        // Parse the combined diff output, splitting by "diff --git" headers
                        let mut file_diffs: Vec<serde_json::Value> = Vec::new();
                        let mut current_file: Option<String> = None;
                        let mut hunks: Vec<serde_json::Value> = Vec::new();
                        let mut current_hunk: Option<(i32, i32, Vec<String>, usize)> = None;
                        const MAX_HUNK_LINES: usize = 500;
                        
                        for line in diff_content.lines() {
                            if line.starts_with("diff --git ") {
                                if let Some((old_start, new_start, lines, omitted)) = current_hunk.take() {
                                    let mut hunk = serde_json::json!({
                                        "old_start": old_start, "new_start": new_start, "lines": lines
                                    });
                                    if omitted > 0 {
                                        hunk["lines_omitted"] = serde_json::json!(omitted);
                                    }
                                    hunks.push(hunk);
                                }
                                if let Some(ref file_name) = current_file {
                                    if !hunks.is_empty() {
                                        file_diffs.push(serde_json::json!({
                                            "file": file_name, "hunks": hunks
                                        }));
                                    }
                                }
                                hunks = Vec::new();
                                current_file = line.split(" b/").nth(1).map(|s| s.to_string());
                            } else if line.starts_with("@@") {
                                if let Some((old_start, new_start, lines, omitted)) = current_hunk.take() {
                                    let mut hunk = serde_json::json!({
                                        "old_start": old_start, "new_start": new_start, "lines": lines
                                    });
                                    if omitted > 0 {
                                        hunk["lines_omitted"] = serde_json::json!(omitted);
                                    }
                                    hunks.push(hunk);
                                }
                                let parts: Vec<&str> = line.split(' ').collect();
                                let old_start = parts.get(1)
                                    .and_then(|s| s.trim_start_matches('-').split(',').next())
                                    .and_then(|s| s.parse::<i32>().ok())
                                    .unwrap_or(0);
                                let new_start = parts.get(2)
                                    .and_then(|s| s.trim_start_matches('+').split(',').next())
                                    .and_then(|s| s.parse::<i32>().ok())
                                    .unwrap_or(0);
                                current_hunk = Some((old_start, new_start, Vec::new(), 0));
                            } else if line.starts_with("---") || line.starts_with("+++") || line.starts_with("index ") {
                                // Skip diff metadata lines
                            } else if let Some((_, _, ref mut lines, ref mut omitted)) = current_hunk {
                                if lines.len() < MAX_HUNK_LINES {
                                    lines.push(line.to_string());
                                } else {
                                    *omitted += 1;
                                }
                            }
                        }
                        
                        // Flush final hunk
                        if let Some((old_start, new_start, lines, omitted)) = current_hunk {
                            let mut hunk = serde_json::json!({
                                "old_start": old_start, "new_start": new_start, "lines": lines
                            });
                            if omitted > 0 {
                                hunk["lines_omitted"] = serde_json::json!(omitted);
                            }
                            hunks.push(hunk);
                        }
                        if let Some(ref file_name) = current_file {
                            if !hunks.is_empty() {
                                file_diffs.push(serde_json::json!({
                                    "file": file_name, "hunks": hunks
                                }));
                            }
                        }
                        
                        Ok(serde_json::json!({
                            "action": "diff",
                            "staged": staged,
                            "summary": stat_output.lines().last().unwrap_or(""),
                            "files": file_diffs,
                            "_next": "Review changes, then pass q:\ng1 system.git action:stage files:...\nor\ng2 system.git action:commit message:\"...\""
                        }))
                    }
                    "stage" => {
                        let file_paths: Vec<String> = git_files_param(params.get("files"));
                        
                        let all = params
                            .get("all")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        
                        let mut args: Vec<String> = vec!["add".into()];
                        if all {
                            args.push("-A".into());
                        } else if file_paths.is_empty() {
                            return Err("files array or all:true required for stage action".to_string());
                        }
                        
                        for file in &file_paths {
                            args.push(file.clone());
                        }
                        
                        let output = run_git_command(args, project_root_str.clone()).await?;
                        
                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            return Err(format!("git add failed: {}", stderr));
                        }
                        
                        Ok(serde_json::json!({
                            "action": "stage",
                            "staged": if all { vec!["all".to_string()] } else { file_paths },
                            "success": true,
                            "_next": "Commit: q: g1 system.git action:commit message:\"...\""
                        }))
                    }
                    "unstage" => {
                        let file_paths: Vec<String> = git_files_param(params.get("files"));
                        
                        let mut args: Vec<String> = vec!["reset".into(), "HEAD".into(), "--".into()];
                        for file in &file_paths {
                            args.push(file.clone());
                        }
                        
                        let output = run_git_command(args, project_root_str.clone()).await?;
                        
                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            return Err(format!("git reset failed: {}", stderr));
                        }
                        
                        Ok(serde_json::json!({
                            "action": "unstage",
                            "unstaged": file_paths,
                            "success": true
                        }))
                    }
                    "commit" => {
                        let message = params
                            .get("message")
                            .and_then(|v| v.as_str())
                            .ok_or("message required for commit action")?;
                        let all = params
                            .get("all")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        let mut args: Vec<String> = vec!["commit".into()];
                        if all {
                            args.push("-a".into());
                        }
                        args.push("-m".into());
                        args.push(message.to_string());

                        let output = run_git_command(args, project_root_str.clone()).await?;
                        
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        
                        if !output.status.success() {
                            return Err(format!("git commit failed: {}", stderr));
                        }
                        
                        let commit_hash = stdout.lines()
                            .find(|line| line.contains('['))
                            .and_then(|line| {
                                let start = line.find(' ')? + 1;
                                let end = line.find(']')?;
                                Some(line[start..end].to_string())
                            })
                            .unwrap_or_default();
                        
                        Ok(serde_json::json!({
                            "action": "commit",
                            "success": true,
                            "commit": commit_hash,
                            "message": message,
                            "output": stdout.to_string(),
                            "_next": "Push to remote: q: g1 system.git action:push"
                        }))
                    }
                    "push" => {
                        let remote = params
                            .get("remote")
                            .and_then(|v| v.as_str())
                            .unwrap_or("origin");
                        
                        let branch = params
                            .get("branch")
                            .and_then(|v| v.as_str());
                        
                        let set_upstream = params
                            .get("set_upstream")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        
                        let mut args: Vec<String> = vec!["push".into()];
                        if set_upstream {
                            args.push("-u".into());
                        }
                        args.push(remote.to_string());
                        if let Some(b) = branch {
                            args.push(b.to_string());
                        }
                        
                        let output = run_git_command(args, project_root_str.clone()).await?;
                        
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        
                        if !output.status.success() {
                            return Err(format!("git push failed: {}", stderr));
                        }
                        
                        Ok(serde_json::json!({
                            "action": "push",
                            "success": true,
                            "remote": remote,
                            "output": combine_output(&stdout, &stderr)
                        }))
                    }
                    "log" => {
                        let limit = params
                            .get("limit")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(10) as usize;
                        
                        let output = run_git_command(
                            vec!["log".into(), "--oneline".into(), "-n".into(), limit.to_string()],
                            project_root_str.clone(),
                        ).await?;
                        
                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            return Err(format!("git log failed: {}", stderr));
                        }
                        
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let commits: Vec<serde_json::Value> = stdout.lines()
                            .filter_map(|line| {
                                let parts: Vec<&str> = line.splitn(2, ' ').collect();
                                if parts.len() == 2 {
                                    Some(serde_json::json!({
                                        "hash": parts[0],
                                        "message": parts[1]
                                    }))
                                } else {
                                    None
                                }
                            })
                            .collect();
                        
                        Ok(serde_json::json!({
                            "action": "log",
                            "commits": commits
                        }))
                    }
                    "reset" | "restore" => {
                        let files: Vec<String> = git_files_param(params.get("files"));

                        let restore_all = params
                            .get("all")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        let hard = params
                            .get("hard")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                            || params.get("mode").and_then(|v| v.as_str()) == Some("hard");

                        let git_ref = params
                            .get("ref")
                            .and_then(|v| v.as_str())
                            .unwrap_or("HEAD")
                            .to_string();

                        if hard {
                            let output = run_git_command(
                                vec!["reset".into(), "--hard".into(), git_ref.clone()],
                                project_root_str.clone(),
                            ).await?;
                            let stdout = String::from_utf8_lossy(&output.stdout);
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            if !output.status.success() {
                                return Err(format!("git reset --hard failed: {}", stderr));
                            }
                            Ok(serde_json::json!({
                                "action": "reset",
                                "mode": "hard",
                                "ref": git_ref,
                                "success": true,
                                "output": stdout.trim()
                            }))
                        } else if files.is_empty() && restore_all {
                            let output = run_git_command(
                                vec!["checkout".into(), git_ref.clone(), "--".into(), ".".into()],
                                project_root_str.clone(),
                            ).await?;
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            if !output.status.success() {
                                return Err(format!("git restore failed: {}", stderr));
                            }
                            Ok(serde_json::json!({
                                "action": "restore",
                                "mode": "all",
                                "ref": git_ref,
                                "success": true,
                                "files_restored": "all"
                            }))
                        } else if !files.is_empty() {
                            // When workspace is set, normalize paths: agent may pass repo-root form
                            // (omvibe-web/src/App.tsx) but workspace-as-repo expects src/App.tsx.
                            let normalized_files: Vec<String> = if params.get("workspace").is_some() {
                                let ws_dir = std::path::Path::new(&project_root_str)
                                    .file_name()
                                    .and_then(|o| o.to_str())
                                    .unwrap_or("");
                                let prefix = format!("{}/", ws_dir);
                                files.iter()
                                    .map(|f| {
                                        let f = f.replace('\\', "/");
                                        if !ws_dir.is_empty() && f.starts_with(&prefix) {
                                            f.strip_prefix(&prefix).unwrap_or(&f).to_string()
                                        } else {
                                            f
                                        }
                                    })
                                    .collect()
                            } else {
                                files.iter().map(|f| f.replace('\\', "/")).collect()
                            };
                            let mut args: Vec<String> = vec!["checkout".into(), git_ref.clone(), "--".into()];
                            args.extend(normalized_files.clone());
                            let output = run_git_command(args, project_root_str.clone()).await?;
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            if !output.status.success() {
                                return Err(format!("git restore failed: {}", stderr));
                            }
                            Ok(serde_json::json!({
                                "action": "restore",
                                "ref": git_ref,
                                "success": true,
                                "files_restored": normalized_files
                            }))
                        } else {
                            return Err("reset/restore requires either 'files' (array or single path string), 'all':true, or 'hard':true. Optional 'ref' (default HEAD).".to_string());
                        }
                    }
                    _ => {
                        Err(format!("Unknown git action: {}. Use: status, diff, stage, unstage, commit, push, log, reset, restore", action))
                    }
                }
            }
            "verify" => {
                // Filter for genuine diagnostic error lines, reducing false positives from
                // file paths (ErrorBoundary), npm metadata (npm ERR!), and handler names.
                let is_diagnostic_error_line = |line_lower: &str| -> bool {
                    if !line_lower.contains("error") { return false; }
                    if line_lower.contains("0 error") { return false; }
                    // Exclude identifier/path fragments
                    if line_lower.contains("error-handler") || line_lower.contains("error_handler") { return false; }
                    if line_lower.contains("errorboundary") { return false; }
                    if line_lower.contains("error-overlay") || line_lower.contains("error_overlay") { return false; }
                    if line_lower.contains("onerror") || line_lower.contains("handleerror") { return false; }
                    // npm metadata lines are wrapper noise, not diagnostics
                    if line_lower.starts_with("npm err") || line_lower.starts_with("npm error") { return false; }
                    // Require a diagnostic pattern: "error:", "error TS", ": error", "error["
                    line_lower.contains("error:") || line_lower.contains("error ts")
                        || line_lower.contains(": error") || line_lower.contains("error[")
                };

                // Structured verification for AI autonomous workflows
                // Uses run_shell_cmd_async for non-blocking subprocess execution
                
                let verify_type = params
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("test");
                
                // Accept optional target_dir / target_directory to scope verification
                let target_dir: Option<String> = params
                    .get("target_dir")
                    .or_else(|| params.get("target_directory"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                
                // Accept optional workspace name to resolve from workspace registry
                let workspace_name: Option<String> = params
                    .get("workspace")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                // Accept optional runner override to bypass auto-detection
                let runner: Option<String> = params
                    .get("runner")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                // Detect project directories â€” scan root and immediate children
                struct DetectedProjects {
                    node_dirs: Vec<PathBuf>,
                    ts_dirs: Vec<PathBuf>,
                    rust_dirs: Vec<PathBuf>,
                    python_dirs: Vec<PathBuf>,
                    go_dirs: Vec<PathBuf>,
                    php_dirs: Vec<PathBuf>,
                    ruby_dirs: Vec<PathBuf>,
                    c_cpp_dirs: Vec<PathBuf>,
                    java_dirs: Vec<PathBuf>,
                    csharp_dirs: Vec<PathBuf>,
                    swift_dirs: Vec<PathBuf>,
                    dart_dirs: Vec<PathBuf>,
                }
                
                let (detect_base, selection_reason, manifest_file) = if let Some(ref ws_name) = workspace_name {
                    let roots_lock = state.roots.lock().await;
                    let all_ws: Vec<WorkspaceEntry> = roots_lock.iter()
                        .flat_map(|r| r.sub_workspaces.iter().cloned())
                        .collect();
                    let base = PathBuf::from(resolve_workspace_fuzzy(&all_ws, ws_name)?);
                    let (reason, manifest) = if let Some((_, dir)) = find_manifest_nearest(&base) {
                        let m = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt"]
                            .iter()
                            .find(|f| dir.join(f).exists())
                            .map(|f| dir.join(f).to_string_lossy().to_string())
                            .unwrap_or_else(|| "unknown".to_string());
                        ("workspace specified", m)
                    } else {
                        ("workspace specified (no manifest found)", String::new())
                    };
                    (base, reason.to_string(), manifest)
                } else if let Some(ref td) = target_dir {
                    let resolved = resolve_project_path(project_root, td);
                    if let Some((kind, manifest_dir)) = find_manifest_nearest(&resolved) {
                        let manifest = match kind {
                            ManifestKind::Node => "package.json",
                            ManifestKind::Rust => "Cargo.toml",
                            ManifestKind::Go => "go.mod",
                            ManifestKind::Python => {
                                if manifest_dir.join("pyproject.toml").exists() { "pyproject.toml" } else { "requirements.txt" }
                            }
                            ManifestKind::Dart => "pubspec.yaml",
                            _ => "manifest",
                        };
                        (manifest_dir.clone(), "target_dir specified".to_string(), manifest_dir.join(manifest).to_string_lossy().to_string())
                    } else {
                        let manifest_candidates: Vec<serde_json::Value> = find_manifest_candidates_under(&resolved, 5)
                            .into_iter()
                            .take(16)
                            .map(|(k, d)| {
                                serde_json::json!({
                                    "kind": format!("{:?}", k),
                                    "directory": d.to_string_lossy(),
                                })
                            })
                            .collect();
                        return Ok(serde_json::json!({
                            "error": format!("target_dir '{}' has no package.json, Cargo.toml, go.mod, pyproject.toml, pubspec.yaml, or other supported manifest. Specify a directory containing a manifest.",
                                td),
                            "resolved_path": resolved.to_string_lossy(),
                            "hint": "Use target_dir to point to a subdirectory with package.json, Cargo.toml, go.mod, pubspec.yaml, or a .sln/.csproj folder.",
                            "manifest_candidates": manifest_candidates
                        }));
                    }
                } else {
                    let base = project_root.to_path_buf();
                    let (reason, manifest) = if let Some((_, dir)) = find_manifest_nearest(&base) {
                        let m = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt"]
                            .iter()
                            .find(|f| dir.join(f).exists())
                            .map(|f| dir.join(f).to_string_lossy().to_string())
                            .unwrap_or_else(|| "unknown".to_string());
                        ("detected at project root", m)
                    } else {
                        ("project root (no manifest found)", String::new())
                    };
                    (base, reason.to_string(), manifest)
                };
                let detect_base_root = detect_base.clone();

                let verify_metadata = |workspace_root: &PathBuf, manifest: &str, cmd: &str, reason: &str| {
                    serde_json::json!({
                        "workspace_root": workspace_root.to_string_lossy(),
                        "manifest_file": manifest,
                        "command": cmd,
                        "selection_reason": reason,
                        "executable_probe": probe_executable(cmd),
                        "path_note": "Verify/build prepends ATLS_TOOLCHAIN_PATH to PATH for subprocesses (GUI apps often lack nvm/fnm paths). system.exec uses the terminal PTY and may differ."
                    })
                };

                // Classify verify failure for clearer diagnostics. Returns (category, hint).
                let classify_verify_failure = |combined: &str| -> (String, String) {
                    let lower = combined.to_lowercase();
                    if lower.contains("not recognized")
                        || lower.contains("command not found")
                        || lower.contains("'cargo' is not recognized")
                        || lower.contains("'npm' is not recognized")
                        || lower.contains("'go' is not recognized")
                        || lower.contains("'python' is not recognized")
                        || lower.contains("'node' is not recognized")
                        || lower.contains("enoent")
                        || lower.contains("no such file or directory")
                    {
                        (
                            "HostMissingToolchain".to_string(),
                            "Toolchain not found on PATH for verify/build subprocesses. Install the tool, set ATLS_TOOLCHAIN_PATH to extra bin dirs (same as your shell), or use runner:'<absolute-path>'.".to_string(),
                        )
                    } else if lower.contains("no module")
                        || lower.contains("module not found")
                        || lower.contains("cannot find module")
                        || lower.contains("dependency")
                        || lower.contains("npm install")
                        || lower.contains("cargo fetch")
                        || lower.contains("pip install")
                    {
                        (
                            "DependencyIssue".to_string(),
                            "Missing dependency. Try: npm install, cargo build, or pip install -r requirements.txt".to_string(),
                        )
                    } else if lower.contains("workspace root")
                        || lower.contains("not a workspace root")
                        || lower.contains("outside of project")
                    {
                        (
                            "WrongWorkspaceRoot".to_string(),
                            "Command run from wrong directory. Use target_dir to specify the package root.".to_string(),
                        )
                    } else if lower.contains("refactor")
                        || lower.contains("extracted")
                        || lower.contains("moved symbol")
                    {
                        (
                            "RefactorInduced".to_string(),
                            "Failure likely caused by recent refactor. Review moved/extracted code and imports.".to_string(),
                        )
                    } else {
                        (
                            "BaselineProjectFailure".to_string(),
                            "Build/typecheck ran and reported failures. See diagnostic_preview and tool output (not a missing-toolchain guard).".to_string(),
                        )
                    }
                };
                
                let detected = tokio::task::spawn_blocking(move || {
                    let mut result = DetectedProjects {
                        node_dirs: Vec::new(),
                        ts_dirs: Vec::new(),
                        rust_dirs: Vec::new(),
                        python_dirs: Vec::new(),
                        go_dirs: Vec::new(),
                        php_dirs: Vec::new(),
                        ruby_dirs: Vec::new(),
                        c_cpp_dirs: Vec::new(),
                        java_dirs: Vec::new(),
                        csharp_dirs: Vec::new(),
                        swift_dirs: Vec::new(),
                        dart_dirs: Vec::new(),
                    };
                    
                    let check_dir = |dir: &std::path::Path, r: &mut DetectedProjects| {
                        if dir.join("package.json").exists() {
                            r.node_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("tsconfig.json").exists() {
                            r.ts_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("Cargo.toml").exists() {
                            r.rust_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("requirements.txt").exists() || dir.join("pyproject.toml").exists() {
                            r.python_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("go.mod").exists() {
                            r.go_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("composer.json").exists() {
                            r.php_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("Gemfile").exists() || dir.join("Rakefile").exists() {
                            r.ruby_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("Makefile").exists() || dir.join("CMakeLists.txt").exists() {
                            r.c_cpp_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("build.gradle").exists() || dir.join("build.gradle.kts").exists() || dir.join("pom.xml").exists() {
                            r.java_dirs.push(dir.to_path_buf());
                        }
                        let has_sln = std::fs::read_dir(dir).ok().map_or(false, |entries| {
                            entries.filter_map(|e| e.ok()).any(|e| {
                                let n = e.file_name().to_string_lossy().to_string();
                                n.ends_with(".sln") || n.ends_with(".csproj")
                            })
                        });
                        if has_sln {
                            r.csharp_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("Package.swift").exists() {
                            r.swift_dirs.push(dir.to_path_buf());
                        }
                        if dir.join("pubspec.yaml").exists() {
                            r.dart_dirs.push(dir.to_path_buf());
                        }
                    };
                    
                    check_dir(&detect_base, &mut result);
                    
                    let skip_dirs: std::collections::HashSet<&str> = ["node_modules", "target", "dist", "build", "vendor", "__pycache__"].iter().copied().collect();
                    if let Ok(entries) = std::fs::read_dir(&detect_base) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_dir() {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if name.starts_with('.') || skip_dirs.contains(name.as_str()) {
                                    continue;
                                }
                                check_dir(&path, &mut result);
                                if let Ok(sub_entries) = std::fs::read_dir(&path) {
                                    for sub_entry in sub_entries.flatten() {
                                        let sub_path = sub_entry.path();
                                        if sub_path.is_dir() {
                                            let sub_name = sub_entry.file_name().to_string_lossy().to_string();
                                            if !sub_name.starts_with('.') && !skip_dirs.contains(sub_name.as_str()) {
                                                check_dir(&sub_path, &mut result);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    if result.dart_dirs.is_empty() {
                        if let Some((_, d)) = find_manifest_candidates_under(&detect_base, 5)
                            .into_iter()
                            .find(|(k, _)| *k == ManifestKind::Dart)
                        {
                            result.dart_dirs.push(d);
                        }
                    }
                    if result.csharp_dirs.is_empty() {
                        if let Some((_, d)) = find_manifest_candidates_under(&detect_base, 5)
                            .into_iter()
                            .find(|(k, _)| *k == ManifestKind::CSharp)
                        {
                            result.csharp_dirs.push(d);
                        }
                    }

                    result
                }).await.map_err(|e| format!("Project detection failed: {}", e))?;
                
                // Resolve working directory for each project type
                let node_dir = detected.node_dirs.first().cloned();
                let rust_dir = detected.rust_dirs.first().cloned();
                let python_dir = detected.python_dirs.first().cloned();
                let go_dir = detected.go_dirs.first().cloned();
                let php_dir = detected.php_dirs.first().cloned();
                let ruby_dir = detected.ruby_dirs.first().cloned();
                let c_cpp_dir = detected.c_cpp_dirs.first().cloned();
                let java_dir = detected.java_dirs.first().cloned();
                let csharp_dir = detected.csharp_dirs.first().cloned();
                let swift_dir = detected.swift_dirs.first().cloned();
                let dart_dir = detected.dart_dirs.first().cloned();
                
                let has_package_json = node_dir.is_some();
                let has_cargo_toml = rust_dir.is_some();
                let has_requirements = python_dir.is_some();
                let has_go_mod = go_dir.is_some();
                let has_php = php_dir.is_some();
                let has_ruby = ruby_dir.is_some();
                let has_c_cpp = c_cpp_dir.is_some();
                let has_java = java_dir.is_some();
                let has_csharp = csharp_dir.is_some();
                let has_swift = swift_dir.is_some();
                let has_dart = dart_dir.is_some();
                let ts_dir = detected.ts_dirs.first().cloned();
                let has_tsconfig = ts_dir.is_some()
                    || node_dir.as_ref().map_or(false, |d| d.join("tsconfig.json").exists())
                    || project_root.join("tsconfig.json").exists();
                
                let timeout_seconds = params
                    .get("timeout_seconds")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(120);

                // Shell commands now use run_shell_cmd_async (spawn_blocking + timeout)
                
                // Collect detected project info for error messages
                let detected_info = || -> serde_json::Value {
                    let fmt_dirs = |dirs: &[PathBuf]| -> Vec<String> {
                        dirs.iter().map(|d| d.to_string_lossy().to_string()).collect()
                    };
                    serde_json::json!({
                        "node": fmt_dirs(&detected.node_dirs),
                        "typescript": fmt_dirs(&detected.ts_dirs),
                        "rust": fmt_dirs(&detected.rust_dirs),
                        "python": fmt_dirs(&detected.python_dirs),
                        "go": fmt_dirs(&detected.go_dirs),
                        "php": fmt_dirs(&detected.php_dirs),
                        "ruby": fmt_dirs(&detected.ruby_dirs),
                        "c_cpp": fmt_dirs(&detected.c_cpp_dirs),
                        "java": fmt_dirs(&detected.java_dirs),
                        "csharp": fmt_dirs(&detected.csharp_dirs),
                        "swift": fmt_dirs(&detected.swift_dirs),
                        "hint": "Use target_dir to scope to a subdirectory, or runner to override detection entirely"
                    })
                };
                
                // Preflight: validate resolved working directory before any shell execution
                let preflight_work_dir = |wd: &PathBuf, vtype: &str, _meta_fn: &dyn Fn(&PathBuf, &str, &str, &str) -> serde_json::Value| -> Option<serde_json::Value> {
                    if !wd.exists() || !wd.is_dir() {
                        Some(serde_json::json!({
                            "type": vtype,
                            "status": "tool-error",
                            "success": false,
                            "error": format!("Working directory does not exist: {}", wd.display()),
                            "resolved_path": wd.to_string_lossy(),
                            "_hint": "Check target_dir â€” the path may be double-nested. Use an absolute path or a workspace name."
                        }))
                    } else {
                        None
                    }
                };

                // When runner is specified, short-circuit all detection
                if let Some(ref runner_cmd) = runner {
                    let work_dir = if let Some(ref td) = target_dir {
                        resolve_project_path(project_root, td)
                    } else {
                        project_root.to_path_buf()
                    };
                    if let Some(err_result) = preflight_work_dir(&work_dir, verify_type, &verify_metadata) {
                        return Ok(err_result);
                    }
                    let runner_manifest = find_manifest_nearest(&work_dir)
                        .and_then(|(k, d)| {
                            let name = match k {
                                ManifestKind::Node => "package.json",
                                ManifestKind::Rust => "Cargo.toml",
                                ManifestKind::Go => "go.mod",
                                ManifestKind::Python => if d.join("pyproject.toml").exists() { "pyproject.toml" } else { "requirements.txt" },
                                ManifestKind::Dart => "pubspec.yaml",
                                _ => return Some(d.to_string_lossy().to_string()),
                            };
                            Some(d.join(name).to_string_lossy().to_string())
                        })
                        .unwrap_or_default();
                    let meta = verify_metadata(&work_dir, &runner_manifest, runner_cmd, "runner override");
                    let output = match run_shell_cmd_async(runner_cmd.to_string(), work_dir.clone(), timeout_seconds).await {
                        Ok(o) => o,
                        Err(e) => return Ok(serde_json::json!({
                            "type": verify_type,
                            "status": "tool-error",
                            "success": false,
                            "error": format!("Shell execution failed: {}", e),
                            "_hint": "Check that the toolchain is installed and on PATH.",
                            "_metadata": meta
                        })),
                    };
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    let combined = combine_output(&stdout, &stderr);
                    let success = output.status.success();
                    let status = if success { "pass" } else { "fail" };
                    let (runner_output, runner_truncated, runner_total_lines) = truncate_output_tail_biased(&combined, 8000, 20, 60);
                    let runner_next = if success { "Custom runner passed." } else { "Custom runner failed. Check output for details." };
                    let mut runner_result = serde_json::json!({
                        "type": verify_type,
                        "runner": runner_cmd,
                        "status": status,
                        "success": success,
                        "exit_code": output.status.code(),
                        "output_truncated": runner_truncated,
                        "lines": runner_total_lines,
                        "output": runner_output,
                        "_metadata": meta,
                        "_next": runner_next
                    });
                    if !success {
                        let (cat, hint) = classify_verify_failure(&combined);
                        runner_result["failure_category"] = serde_json::json!(cat);
                        runner_result["_hint"] = serde_json::json!(hint);
                    }
                    return Ok(runner_result);
                }

                match verify_type {
                    "test" => {
                        let scope: Vec<String> = params
                            .get("scope")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                            .unwrap_or_default();
                        
                        // Determine test command and working directory based on project type
                        let (cmd_str, work_dir): (String, PathBuf) = if has_cargo_toml {
                            let scope_str = scope.join(" ");
                            let cmd = if scope_str.is_empty() {
                                "cargo test -- --test-threads=1".to_string()
                            } else {
                                format!("cargo test {} -- --test-threads=1", scope_str)
                            };
                            (cmd, rust_dir.clone().unwrap())
                        } else if has_go_mod {
                            let scope_str = scope.join(" ");
                            let cmd = if scope_str.is_empty() {
                                "go test -v ./...".to_string()
                            } else {
                                format!("go test -v {}", scope_str)
                            };
                            (cmd, go_dir.clone().unwrap())
                        } else if has_package_json {
                            let nd = node_dir.clone().unwrap();
                            let pkg_json_path = nd.join("package.json");
                            let pkg_content = std::fs::read_to_string(&pkg_json_path).unwrap_or_default();
                            let uses_vitest = pkg_content.contains("vitest");
                            // Fallback order for packages without "test" (e.g. ESLint): test, ci, validate, lint, check
                            let fallback_script = ["test", "ci", "validate", "lint", "check"]
                                .iter()
                                .find(|name| {
                                    let pattern = format!("\"{}\":", name);
                                    pkg_content.contains(&pattern)
                                })
                                .copied();
                            let cmd = if uses_vitest {
                                let scope_str = scope.join(" ");
                                if scope_str.is_empty() {
                                    "npx vitest run".to_string()
                                } else {
                                    format!("npx vitest run {}", scope_str)
                                }
                            } else if let Some(script) = fallback_script {
                                format!("npm run {}", script)
                            } else {
                                "npm test".to_string()
                            };
                            (cmd, nd)
                        } else if has_requirements {
                            let scope_str = scope.join(" ");
                            let cmd = if scope_str.is_empty() {
                                "python -m pytest -v --tb=short".to_string()
                            } else {
                                format!("python -m pytest -v --tb=short {}", scope_str)
                            };
                            (cmd, python_dir.clone().unwrap())
                        } else if has_php {
                            let pd = php_dir.clone().unwrap();
                            let cmd = if pd.join("artisan").exists() {
                                "php artisan test".to_string()
                            } else if pd.join("composer.json").exists() {
                                "composer test".to_string()
                            } else {
                                "vendor/bin/phpunit".to_string()
                            };
                            (cmd, pd)
                        } else if has_ruby {
                            let rd = ruby_dir.clone().unwrap();
                            let cmd = if rd.join("Gemfile").exists() {
                                if rd.join("Rakefile").exists() {
                                    "bundle exec rake test".to_string()
                                } else {
                                    "bundle exec rspec".to_string()
                                }
                            } else {
                                "rake test".to_string()
                            };
                            (cmd, rd)
                        } else if has_java {
                            let jd = java_dir.clone().unwrap();
                            let cmd = if jd.join("gradlew").exists() || jd.join("gradlew.bat").exists() {
                                if cfg!(windows) { ".\\gradlew.bat test".to_string() } else { "./gradlew test".to_string() }
                            } else if jd.join("pom.xml").exists() {
                                "mvn test -q".to_string()
                            } else {
                                "gradle test".to_string()
                            };
                            (cmd, jd)
                        } else if has_csharp {
                            ("dotnet test".to_string(), csharp_dir.clone().unwrap())
                        } else if has_swift {
                            ("swift test".to_string(), swift_dir.clone().unwrap())
                        } else if has_c_cpp {
                            let cd = c_cpp_dir.clone().unwrap();
                            let cmd = if cd.join("CMakeLists.txt").exists() {
                                "cmake --build build --target test 2>&1 || ctest --test-dir build --output-on-failure".to_string()
                            } else {
                                "make test".to_string()
                            };
                            (cmd, cd)
                        } else {
                            return Ok(serde_json::json!({
                                "error": "Could not detect project type for testing",
                                "detected_projects": detected_info(),
                            }));
                        };
                        
                        let mut output = run_shell_cmd_async(cmd_str.clone(), work_dir.clone(), timeout_seconds).await?;
                        let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
                        let mut stderr = String::from_utf8_lossy(&output.stderr).to_string();
                        let mut combined = combine_output(&stdout, &stderr);

                        // Retry with npm install if Node test failed due to missing deps (e.g. npm-license)
                        // Use capped timeout for npm install (90s max) to avoid long hangs on large monorepos
                        if has_package_json && !output.status.success()
                            && (combined.contains("npm-license") || combined.contains("Cannot find module")
                                || combined.contains("MODULE_NOT_FOUND") || combined.contains("Error: Cannot find module"))
                        {
                            let install_timeout = std::cmp::min(90u64, timeout_seconds);
                            let _ = run_shell_cmd_async("npm install".to_string(), work_dir.clone(), install_timeout).await;
                            output = run_shell_cmd_async(cmd_str.clone(), work_dir.clone(), timeout_seconds).await?;
                            stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            combined = combine_output(&stdout, &stderr);
                        }
                        
                        // Parse test results (simplified parsing)
                        let mut passed = 0i32;
                        let mut failed = 0i32;
                        let mut skipped = 0i32;
                        let mut failures: Vec<serde_json::Value> = Vec::new();
                        
                        // Parse based on project type
                        if has_cargo_toml {
                            // Rust: "test result: ok. X passed; Y failed; Z ignored"
                            for line in combined.lines() {
                                if line.contains("test result:") {
                                    if let Some(p) = line.find(" passed") {
                                        let num_str: String = line[..p].chars().rev().take_while(|c| c.is_ascii_digit()).collect::<String>().chars().rev().collect();
                                        passed = num_str.parse().unwrap_or(0);
                                    }
                                    if let Some(f) = line.find(" failed") {
                                        let before = &line[..f];
                                        let num_str: String = before.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<String>().chars().rev().collect();
                                        failed = num_str.parse().unwrap_or(0);
                                    }
                                }
                                if line.contains("FAILED") && line.contains("::") {
                                    failures.push(serde_json::json!({
                                        "test": line.trim(),
                                        "error": "See output for details"
                                    }));
                                }
                            }
                        } else if has_package_json {
                            // Node: Look for common patterns
                            for line in combined.lines() {
                                if line.contains("âœ“") || line.contains("PASS") || line.contains("passed") {
                                    passed += 1;
                                }
                                if line.contains("âœ—") || line.contains("FAIL") || line.contains("failed") {
                                    failed += 1;
                                    if line.len() < 200 {
                                        failures.push(serde_json::json!({
                                            "test": line.trim(),
                                            "error": "Test failed"
                                        }));
                                    }
                                }
                                if line.contains("skipped") || line.contains("pending") {
                                    skipped += 1;
                                }
                            }
                            // Try to extract summary numbers
                            if let Some(line) = combined.lines().find(|l| l.contains("Tests:") || l.contains("tests")) {
                                let nums: Vec<i32> = line.split(|c: char| !c.is_ascii_digit())
                                    .filter_map(|s| s.parse::<i32>().ok())
                                    .collect();
                                if nums.len() >= 2 {
                                    passed = nums.get(0).copied().unwrap_or(passed);
                                    failed = nums.get(1).copied().unwrap_or(failed);
                                }
                            }
                        } else if has_requirements {
                            // Python pytest: "X passed, Y failed, Z skipped"
                            for line in combined.lines() {
                                if line.contains("passed") || line.contains("failed") {
                                    let parts: Vec<&str> = line.split(',').collect();
                                    for part in parts {
                                        let part = part.trim();
                                        if part.contains("passed") {
                                            passed = part.split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0);
                                        } else if part.contains("failed") {
                                            failed = part.split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0);
                                        } else if part.contains("skipped") {
                                            skipped = part.split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0);
                                        }
                                    }
                                }
                                if line.contains("FAILED") {
                                    failures.push(serde_json::json!({
                                        "test": line.trim(),
                                        "error": "See output"
                                    }));
                                }
                            }
                        } else if has_go_mod {
                            // Go -v output: "--- PASS:", "--- FAIL:", "--- SKIP:"
                            // Package summaries: "ok  pkg/path" or "FAIL pkg/path"
                            let mut ok_packages = 0i32;
                            let mut fail_packages = 0i32;
                            for line in combined.lines() {
                                let trimmed = line.trim();
                                if trimmed.contains("--- PASS:") {
                                    passed += 1;
                                } else if trimmed.contains("--- FAIL:") {
                                    failed += 1;
                                    failures.push(serde_json::json!({
                                        "test": trimmed.replace("--- FAIL:", "").trim(),
                                        "error": "Test failed"
                                    }));
                                } else if trimmed.contains("--- SKIP:") {
                                    skipped += 1;
                                } else if trimmed.starts_with("ok ") || trimmed.starts_with("ok\t") {
                                    ok_packages += 1;
                                } else if trimmed.starts_with("FAIL\t") || trimmed.starts_with("FAIL ") {
                                    if !trimmed.contains("--- FAIL:") {
                                        fail_packages += 1;
                                    }
                                }
                            }
                            // Fallback: if -v per-test lines were absent, use package summaries
                            if passed == 0 && failed == 0 && (ok_packages > 0 || fail_packages > 0) {
                                passed = ok_packages;
                                failed = fail_packages;
                            }
                        } else {
                            // Generic parsing for Java/C#/Swift/C++ and unknown toolchains
                            for line in combined.lines() {
                                let trimmed = line.trim();
                                let lower = trimmed.to_lowercase();
                                if lower.contains("pass") && !lower.contains("0 pass") {
                                    passed += 1;
                                }
                                if lower.contains("fail") && !lower.contains("0 fail") {
                                    failed += 1;
                                    if trimmed.len() < 300 {
                                        failures.push(serde_json::json!({
                                            "test": trimmed,
                                            "error": "See output"
                                        }));
                                    }
                                }
                                if lower.contains("skip") || lower.contains("ignored") {
                                    skipped += 1;
                                }
                            }
                        }
                        
                        let success = output.status.success() && failed == 0;
                        let output_truncated = combined.len() > 5000;
                        let missing_script = has_package_json
                            && (combined.contains("Missing script") || combined.contains("Missing script:"));
                        let (_hint, failure_category): (Option<String>, Option<String>) = if success {
                            (None, None)
                        } else if missing_script {
                            (Some("This package has no test script. Use runner:'npm run <script>' to run a specific script, or add a test script to package.json.".to_string()), Some("BaselineProjectFailure".to_string()))
                        } else if has_package_json && (combined.contains("npm-license") || combined.contains("ENOENT") || combined.contains("not found")) {
                            (Some("Missing test dependency. Try: npm install".to_string()), Some("DependencyIssue".to_string()))
                        } else if has_java && (combined.contains("not recognized") || combined.contains("command not found") || combined.contains("CommandNotFoundException") || (combined.contains("gradle") && combined.contains("Failed"))) {
                            (Some("Ensure Java/Gradle/Maven are installed and on PATH. If the toolchain exists outside PATH, use runner:'<absolute-path-to-gradlew> test' or another absolute command.".to_string()), Some("HostMissingToolchain".to_string()))
                        } else if has_requirements && (combined.contains("pytest") || combined.contains("No module")) && (combined.contains("not found") || combined.contains("No module named")) {
                            (Some("Ensure pytest is installed (pip install pytest). Use runner:'pytest' or target_dir to scope.".to_string()), Some("HostMissingToolchain".to_string()))
                        } else if (combined.contains("bundle") || combined.contains("rake") || combined.contains("rspec")) && (combined.contains("not found") || combined.contains("command not found")) {
                            (Some("Ensure Ruby, bundler, and rake are installed. Use runner:'bundle exec rake test' or runner:'bundle exec rspec'.".to_string()), Some("HostMissingToolchain".to_string()))
                        } else {
                            let (cat, hint) = classify_verify_failure(&combined);
                            (Some(hint), Some(cat))
                        };
                        let (output_val, test_truncated, test_total_lines) = truncate_output_tail_biased(&combined, 5000, 15, 50);
                        let _ = output_truncated; // superseded by test_truncated
                        let test_next = if success {
                            "Tests passed. Ready to commit: q: g1 system.git action:stage all:true"
                        } else {
                            "Fix failing tests, then re-run: q: v1 verify.test"
                        };
                        let status = if !output.status.success() || failed > 0 {
                            "fail"
                        } else if missing_script {
                            "tool-error"
                        } else {
                            "pass"
                        };
                        let mut result = serde_json::json!({
                            "type": "test",
                            "status": status,
                            "success": success,
                            "exit_code": output.status.code(),
                            "summary": {
                                "passed": passed,
                                "failed": failed,
                                "skipped": skipped,
                                "total": passed + failed + skipped
                            },
                            "failures": failures,
                            "output_truncated": test_truncated,
                            "lines": test_total_lines,
                            "output": output_val,
                            "_next": test_next
                        });
                        if let Some(h) = _hint {
                            result["_hint"] = serde_json::json!(h);
                        }
                        if let Some(cat) = failure_category {
                            result["failure_category"] = serde_json::json!(cat);
                        }
                        result["_metadata"] = verify_metadata(&work_dir, &manifest_file, &cmd_str, &selection_reason);
                        Ok(result)
                    }
                    "build" => {
                        // Determine build command and working directory based on project type
                        let (cmd_str, work_dir): (String, PathBuf) = if has_cargo_toml {
                            ("cargo build --message-format=json".to_string(), rust_dir.clone().unwrap())
                        } else if has_go_mod {
                            ("go build ./...".to_string(), go_dir.clone().unwrap())
                        } else if has_package_json {
                            ("npm run build".to_string(), node_dir.clone().unwrap())
                        } else if has_requirements {
                            ("python -m py_compile".to_string(), python_dir.clone().unwrap())
                        } else if has_php {
                            let pd = php_dir.clone().unwrap();
                            let cmd = if pd.join("artisan").exists() {
                                "php artisan test --help".to_string()
                            } else if pd.join("vendor").join("bin").join("phpunit").exists() {
                                "vendor/bin/phpunit --version".to_string()
                            } else if pd.join("composer.json").exists() {
                                "composer --version".to_string()
                            } else {
                                "php -v".to_string()
                            };
                            (cmd, pd)
                        } else if has_ruby {
                            let rd = ruby_dir.clone().unwrap();
                            let cmd = if rd.join("Gemfile").exists() {
                                if rd.join("Rakefile").exists() {
                                    "bundle exec rake -T".to_string()
                                } else {
                                    "bundle exec rspec --version".to_string()
                                }
                            } else {
                                "ruby -v".to_string()
                            };
                            (cmd, rd)
                        } else if has_java {
                            let jd = java_dir.clone().unwrap();
                            let cmd = if jd.join("gradlew").exists() || jd.join("gradlew.bat").exists() {
                                if cfg!(windows) { ".\\gradlew.bat build".to_string() } else { "./gradlew build".to_string() }
                            } else if jd.join("pom.xml").exists() {
                                "mvn compile -q".to_string()
                            } else {
                                "gradle build".to_string()
                            };
                            (cmd, jd)
                        } else if has_csharp {
                            ("dotnet build".to_string(), csharp_dir.clone().unwrap())
                        } else if has_swift {
                            ("swift build".to_string(), swift_dir.clone().unwrap())
                        } else if has_dart {
                            ("dart analyze".to_string(), dart_dir.clone().unwrap())
                        } else if has_c_cpp {
                            let cd = c_cpp_dir.clone().unwrap();
                            let cmd = if cd.join("CMakeLists.txt").exists() {
                                "cmake -B build -S . && cmake --build build".to_string()
                            } else {
                                "make".to_string()
                            };
                            (cmd, cd)
                        } else if let Some(ref td) = ts_dir {
                            // Fallback: TypeScript-only dir (e.g. Nest integration leaf with tsconfig but no package.json at leaf)
                            ("npx tsc -b".to_string(), td.clone())
                        } else {
                            let manifest_candidates: Vec<serde_json::Value> =
                                find_manifest_candidates_under(&detect_base_root, 5)
                                    .into_iter()
                                    .take(16)
                                    .map(|(k, d)| {
                                        serde_json::json!({
                                            "kind": format!("{:?}", k),
                                            "directory": d.to_string_lossy(),
                                        })
                                    })
                                    .collect();
                            let mut err = serde_json::json!({
                                "error": "Could not detect project type for building",
                                "detected_projects": detected_info(),
                                "manifest_candidates": manifest_candidates,
                            });
                            err["_hint"] = serde_json::json!(
                                "Use target_dir to scope to a subdirectory with package.json/Cargo.toml/pubspec.yaml, or runner to run a custom build command."
                            );
                            return Ok(err);
                        };
                        
                        if let Some(err_result) = preflight_work_dir(&work_dir, "build", &verify_metadata) {
                            return Ok(err_result);
                        }
                        let output = match run_shell_cmd_async(cmd_str.clone(), work_dir.clone(), timeout_seconds).await {
                            Ok(o) => o,
                            Err(e) => return Ok(serde_json::json!({
                                "type": "build",
                                "status": "tool-error",
                                "success": false,
                                "error": format!("Shell execution failed: {}", e),
                                "_hint": "Check that the toolchain is installed and on PATH.",
                                "_metadata": verify_metadata(&work_dir, &manifest_file, &cmd_str, &selection_reason)
                            })),
                        };
                        
                        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                        let combined = combine_output(&stdout, &stderr);
                        
                        // Parse errors
                        let mut errors: Vec<serde_json::Value> = Vec::new();
                        let mut warnings: Vec<serde_json::Value> = Vec::new();
                        
                        if has_cargo_toml {
                            // Parse Rust JSON messages
                            for line in stdout.lines() {
                                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) {
                                    if msg.get("reason").and_then(|r| r.as_str()) == Some("compiler-message") {
                                        if let Some(message) = msg.get("message") {
                                            let level = message.get("level").and_then(|l| l.as_str()).unwrap_or("");
                                            let text = message.get("message").and_then(|m| m.as_str()).unwrap_or("");
                                            let spans = message.get("spans").and_then(|s| s.as_array());
                                            
                            let location = spans.and_then(|s| s.first()).map(|span| {
                                let mut loc = serde_json::json!({
                                    "file": span.get("file_name").and_then(|f| f.as_str()).unwrap_or(""),
                                    "line": span.get("line_start").and_then(|l| l.as_u64()).unwrap_or(0),
                                    "col": span.get("column_start").and_then(|c| c.as_u64()).unwrap_or(0)
                                });
                                if let Some(el) = span.get("line_end").and_then(|v| v.as_u64()) {
                                    loc["end_line"] = serde_json::json!(el);
                                }
                                loc
                            });
                                            
                                            let entry = serde_json::json!({
                                                "message": text,
                                                "location": location
                                            });
                                            
                                            if level == "error" {
                                                errors.push(entry);
                                            } else if level == "warning" && warnings.len() < 20 {
                                                warnings.push(entry);
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            // Generic error parsing â€” require diagnostic patterns to reduce false positives
                            for line in combined.lines() {
                                let line_lower = line.to_lowercase();
                                if is_diagnostic_error_line(&line_lower) {
                                    // Try to parse file:line:col: error format
                                    let parts: Vec<&str> = line.splitn(4, ':').collect();
                                    if parts.len() >= 4 {
                                        errors.push(serde_json::json!({
                                            "file": parts[0],
                                            "line": parts[1].parse::<u32>().unwrap_or(0),
                                            "col": parts[2].parse::<u32>().unwrap_or(0),
                                            "message": parts[3].trim()
                                        }));
                                    } else if errors.len() < 20 {
                                        errors.push(serde_json::json!({
                                            "message": line.trim()
                                        }));
                                    }
                                } else if line_lower.contains("warning") && warnings.len() < 20 {
                                    warnings.push(serde_json::json!({
                                        "message": line.trim()
                                    }));
                                }
                            }
                        }
                        
                        let success = output.status.success() && errors.is_empty();
                        let status = if !output.status.success() || !errors.is_empty() {
                            "fail"
                        } else if !warnings.is_empty() {
                            "pass-with-warnings"
                        } else {
                            "pass"
                        };
                        
                        let mut build_result = serde_json::json!({
                            "type": "build",
                            "status": status,
                            "success": success,
                            "exit_code": output.status.code(),
                            "errors": errors,
                            "warnings": warnings,
                            "summary": {
                                "error_count": errors.len(),
                                "warning_count": warnings.len()
                            },
                            "_next": if success {
                                "Build succeeded. Run tests: q: v1 verify.test"
                            } else {
                                "Fix build errors, then re-run: q: v1 verify.build"
                            }
                        });
                        if !success {
                            let (cat, hint) = classify_verify_failure(&combined);
                            build_result["failure_category"] = serde_json::json!(cat);
                            build_result["_hint"] = serde_json::json!(hint);
                            let preview: String = combined.chars().take(4000).collect();
                            build_result["diagnostic_preview"] = serde_json::json!(preview);
                            build_result["baseline_confirmed"] = serde_json::json!(cat == "BaselineProjectFailure");
                        }
                        build_result["build_executed"] = serde_json::json!(true);
                        build_result["_metadata"] = verify_metadata(&work_dir, &manifest_file, &cmd_str, &selection_reason);
                        Ok(build_result)
                    }
                    "typecheck" => {
                        // Explicit toolchain override bypasses auto-detection order.
                        // Useful for monorepos with both Rust and TS where Cargo.toml
                        // is detected first but the caller wants to typecheck TS.
                        let toolchain_override: Option<&str> = params
                            .get("toolchain")
                            .and_then(|v| v.as_str());

                        // When workspace is explicit, prefer the root-level toolchain.
                        // E.g. atls-studio workspace has package.json at root but
                        // Cargo.toml only in src-tauri/ child â€” TS should win.
                        let root_has_node = detected.node_dirs.first().map_or(false, |d| *d == detect_base_root);
                        let root_has_ts = detected.ts_dirs.first().map_or(false, |d| *d == detect_base_root);
                        let root_has_rust = detected.rust_dirs.first().map_or(false, |d| *d == detect_base_root);
                        let root_prefers_ts = workspace_name.is_some()
                            && (root_has_node || root_has_ts)
                            && has_cargo_toml && !root_has_rust;

                        let use_rust = toolchain_override.map_or(
                            has_cargo_toml && !root_prefers_ts,
                            |t| t == "rust" || t == "rs",
                        );
                        let use_ts = toolchain_override.map_or(
                            root_prefers_ts || (!use_rust && (has_package_json || has_tsconfig)),
                            |t| t == "typescript" || t == "ts" || t == "node",
                        );
                        let use_java = toolchain_override.map_or(
                            !use_rust && !use_ts && has_java,
                            |t| t == "java",
                        );
                        let use_csharp = toolchain_override.map_or(
                            !use_rust && !use_ts && !use_java && has_csharp,
                            |t| t == "csharp" || t == "dotnet" || t == "cs",
                        );
                        let use_swift = toolchain_override.map_or(
                            !use_rust && !use_ts && !use_java && !use_csharp && has_swift,
                            |t| t == "swift",
                        );
                        let use_go = toolchain_override.map_or(
                            !use_rust && !use_ts && !use_java && !use_csharp && !use_swift && has_go_mod,
                            |t| t == "go" || t == "golang",
                        );
                        let use_python = toolchain_override.map_or(
                            !use_rust && !use_ts && !use_java && !use_csharp && !use_swift && !use_go && has_requirements,
                            |t| t == "python" || t == "py" || t == "mypy" || t == "pyright",
                        );
                        let use_c = toolchain_override.map_or(
                            !use_rust && !use_ts && !use_java && !use_csharp && !use_swift && !use_go && !use_python && has_c_cpp,
                            |t| t == "c" || t == "cpp" || t == "cc" || t == "clang" || t == "gcc",
                        );

                        if use_rust {
                            // Rust type checking via cargo check
                            let work_dir = rust_dir.clone().unwrap();
                            let output = run_shell_cmd_async("cargo check --message-format=json".to_string(), work_dir.clone(), timeout_seconds).await?;

                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

                            let mut errors: Vec<serde_json::Value> = Vec::new();
                            let mut warnings: Vec<serde_json::Value> = Vec::new();

                            // Parse cargo JSON messages (one per line)
                            for json_line in stdout.lines() {
                                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(json_line) {
                                    if msg.get("reason").and_then(|v| v.as_str()) == Some("compiler-message") {
                                        if let Some(message) = msg.get("message") {
                                            let level = message.get("level").and_then(|v| v.as_str()).unwrap_or("");
                                            let rendered = message.get("rendered").and_then(|v| v.as_str()).unwrap_or("");
                                            let msg_text = message.get("message").and_then(|v| v.as_str()).unwrap_or("");
                                            let code_val = message.get("code")
                                                .and_then(|c| c.get("code"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");

                                            // Extract primary span location
                                            let (file, line_num, col, end_line_opt) = message.get("spans")
                                                .and_then(|s| s.as_array())
                                                .and_then(|spans| spans.iter().find(|s| {
                                                    s.get("is_primary").and_then(|v| v.as_bool()).unwrap_or(false)
                                                }))
                                                .map(|span| {
                                                    let f = span.get("file_name").and_then(|v| v.as_str()).unwrap_or("");
                                                    let l = span.get("line_start").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                                    let c = span.get("column_start").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                                    let el = span.get("line_end").and_then(|v| v.as_u64()).map(|v| v as u32);
                                                    (f.to_string(), l, c, el)
                                                })
                                                .unwrap_or_default();

                                            let mut entry = serde_json::json!({
                                                "file": file,
                                                "line": line_num,
                                                "col": col,
                                                "code": code_val,
                                                "message": msg_text,
                                                "rendered": rendered
                                            });
                                            if let Some(el) = end_line_opt {
                                                entry["end_line"] = serde_json::json!(el);
                                            }

                                            match level {
                                                "error" => errors.push(entry),
                                                "warning" => warnings.push(entry),
                                                _ => {}
                                            }
                                        }
                                    }
                                }
                            }

                            let success = output.status.success() && errors.is_empty();

                            let tool_error: Option<String> = if !success && errors.is_empty() {
                                let msg = if !stderr.trim().is_empty() {
                                    stderr.trim().chars().take(500).collect()
                                } else {
                                    format!("cargo check exited with code {}", output.status.code().unwrap_or(-1))
                                };
                                Some(msg)
                            } else {
                                None
                            };

                            let status = if tool_error.is_some() {
                                "tool-error"
                            } else if !output.status.success() || !errors.is_empty() {
                                "fail"
                            } else if !warnings.is_empty() {
                                "pass-with-warnings"
                            } else {
                                "pass"
                            };

                            let mut result = serde_json::json!({
                                "type": "typecheck",
                                "toolchain": "rust",
                                "status": status,
                                "success": success,
                                "exit_code": output.status.code(),
                                "errors": errors,
                                "warnings": warnings,
                                "summary": {
                                    "error_count": errors.len(),
                                    "warning_count": warnings.len()
                                },
                                "_next": if success {
                                    "Types are valid. Run tests: q: v1 verify.test"
                                } else {
                                    "Fix type errors using q: e1 change.edit file_path:... line_edits:[...], then re-run: v2 verify.typecheck"
                                }
                            });
                            result["_metadata"] = verify_metadata(&work_dir, &manifest_file, &"cargo check --message-format=json", &selection_reason);
                            if let Some(ref err) = tool_error {
                                result.as_object_mut().unwrap().insert("tool_error".to_string(), serde_json::json!(err));
                            }
                            Ok(result)
                        } else if use_ts {
                            // TypeScript type checking
                            let work_dir = node_dir.clone()
                                .or_else(|| ts_dir.clone())
                                .unwrap_or_else(|| project_root.to_path_buf());
                            let output = run_shell_cmd_async("npx -p typescript tsc -b --pretty false".to_string(), work_dir.clone(), timeout_seconds).await?;

                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            let combined = combine_output(&stdout, &stderr);

                            let mut errors: Vec<serde_json::Value> = Vec::new();

                            for line in combined.lines() {
                                if line.contains("): error TS") {
                                    if let Some(paren_pos) = line.find('(') {
                                        let file = &line[..paren_pos];
                                        let rest = &line[paren_pos + 1..];
                                        if let Some(close_paren) = rest.find(')') {
                                            let coords = &rest[..close_paren];
                                            let parts: Vec<&str> = coords.split(',').collect();
                                            let line_num = parts.get(0).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                                            let col = parts.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);

                                            let msg_start = rest.find(": error ").map(|i| i + 8).unwrap_or(close_paren + 2);
                                            let message = &rest[msg_start..];

                                            let code = message.split(':').next().unwrap_or("").trim();
                                            let msg_text = message.split(':').skip(1).collect::<Vec<&str>>().join(":").trim().to_string();

                                            errors.push(serde_json::json!({
                                                "file": file,
                                                "line": line_num,
                                                "col": col,
                                                "code": code,
                                                "message": msg_text
                                            }));
                                        }
                                    }
                                }
                            }

                            let success = output.status.success() && errors.is_empty();

                            let tool_error: Option<String> = if !success && errors.is_empty() {
                                let msg = if !stderr.trim().is_empty() {
                                    stderr.trim().to_string()
                                } else if !stdout.trim().is_empty() {
                                    stdout.trim().chars().take(500).collect()
                                } else {
                                    format!("tsc exited with code {}", output.status.code().unwrap_or(-1))
                                };
                                Some(msg)
                            } else {
                                None
                            };

                            let status = if tool_error.is_some() {
                                "tool-error"
                            } else if !output.status.success() || !errors.is_empty() {
                                "fail"
                            } else {
                                "pass"
                            };

                            let mut result = serde_json::json!({
                                "type": "typecheck",
                                "toolchain": "typescript",
                                "status": status,
                                "success": success,
                                "exit_code": output.status.code(),
                                "errors": errors,
                                "summary": {
                                    "error_count": errors.len()
                                },
                                "_next": if success {
                                    "Types are valid. Run tests: q: v1 verify.test"
                                } else {
                                    "Fix type errors using q: e1 change.edit file_path:... line_edits:[...], then re-run: v2 verify.typecheck"
                                }
                            });
                            result["_metadata"] = verify_metadata(&work_dir, &manifest_file, &"npx -p typescript tsc -b --pretty false", &selection_reason);
                            if let Some(ref err) = tool_error {
                                result.as_object_mut().unwrap().insert("tool_error".to_string(), serde_json::json!(err));
                            }
                            Ok(result)
                        } else if use_java {
                            let jd = java_dir.clone().unwrap_or_else(|| project_root.to_path_buf());
                            let cmd = if jd.join("gradlew").exists() || jd.join("gradlew.bat").exists() {
                                if cfg!(windows) { ".\\gradlew.bat compileJava" } else { "./gradlew compileJava" }
                            } else if jd.join("pom.xml").exists() {
                                "mvn compile -q"
                            } else {
                                "gradle compileJava"
                            };
                            let output = run_shell_cmd_async(cmd.to_string(), jd.clone(), timeout_seconds).await?;
                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            let combined = combine_output(&stdout, &stderr);
                            let success = output.status.success();
                            let (java_output, java_truncated, java_total) = truncate_output_tail_biased(&combined, 5000, 15, 50);
                            let java_next = if success { "Compilation passed." } else { "Fix compilation errors, then re-run: q: v1 verify.typecheck" };
                            Ok(serde_json::json!({
                                "type": "typecheck",
                                "toolchain": "java",
                                "success": success,
                                "output_truncated": java_truncated,
                                "lines": java_total,
                                "output": java_output,
                                "_next": java_next
                            }))
                        } else if use_csharp {
                            let output = run_shell_cmd_async("dotnet build --no-restore".to_string(), csharp_dir.clone().unwrap_or_else(|| project_root.to_path_buf()), timeout_seconds).await?;
                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            let combined = combine_output(&stdout, &stderr);
                            let success = output.status.success();
                            let (csharp_output, csharp_truncated, csharp_total) = truncate_output_tail_biased(&combined, 5000, 15, 50);
                            let csharp_next = if success { "Build passed." } else { "Fix build errors, then re-run: q: v1 verify.build" };
                            Ok(serde_json::json!({
                                "type": "typecheck",
                                "toolchain": "csharp",
                                "success": success,
                                "output_truncated": csharp_truncated,
                                "lines": csharp_total,
                                "output": csharp_output,
                                "_next": csharp_next
                            }))
                        } else if use_swift {
                            let output = run_shell_cmd_async("swift build".to_string(), swift_dir.clone().unwrap(), timeout_seconds).await?;
                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            let combined = combine_output(&stdout, &stderr);
                            let success = output.status.success();
                            let (swift_output, swift_truncated, swift_total) = truncate_output_tail_biased(&combined, 5000, 15, 50);
                            let swift_next = if success { "Build passed." } else { "Fix build errors, then re-run: q: v1 verify.build" };
                            Ok(serde_json::json!({
                                "type": "typecheck",
                                "toolchain": "swift",
                                "success": success,
                                "output_truncated": swift_truncated,
                                "lines": swift_total,
                                "output": swift_output,
                                "_next": swift_next
                            }))
                        } else if use_go {
                            let work_dir = go_dir.clone().unwrap();
                            let output = run_shell_cmd_async("go vet ./...".to_string(), work_dir.clone(), timeout_seconds).await?;

                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            let combined = combine_output(&stdout, &stderr);

                            let mut errors: Vec<serde_json::Value> = Vec::new();
                            // go vet outputs to stderr: path/file.go:line:col: message
                            for line in combined.lines() {
                                let trimmed = line.trim();
                                if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("vet:") {
                                    continue;
                                }
                                // Match pattern: file.go:line:col: message  or  file.go:line: message
                                if let Some(first_colon) = trimmed.find(':') {
                                    let file_part = &trimmed[..first_colon];
                                    if file_part.ends_with(".go") {
                                        let rest = &trimmed[first_colon + 1..];
                                        let parts: Vec<&str> = rest.splitn(3, ':').collect();
                                        let line_num = parts.first().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0);
                                        let (col, msg_idx) = if parts.len() >= 3 {
                                            if let Ok(c) = parts[1].trim().parse::<u32>() {
                                                (c, 2)
                                            } else {
                                                (0u32, 1)
                                            }
                                        } else {
                                            (0u32, parts.len().saturating_sub(1))
                                        };
                                        let message = parts.get(msg_idx).unwrap_or(&"").trim().to_string();
                                        if !message.is_empty() {
                                            errors.push(serde_json::json!({
                                                "file": file_part,
                                                "line": line_num,
                                                "col": col,
                                                "message": message
                                            }));
                                        }
                                    }
                                }
                            }

                            let success = output.status.success() && errors.is_empty();

                            Ok(serde_json::json!({
                                "type": "typecheck",
                                "toolchain": "go",
                                "success": success,
                                "errors": errors,
                                "summary": {
                                    "error_count": errors.len()
                                },
                                "_next": if success {
                                    "go vet passed. Run tests: q: v1 verify.test"
                                } else {
                                    "Fix vet errors, then re-run: q: v1 verify.typecheck toolchain:go"
                                }
                            }))
                        } else if use_python {
                            let work_dir = python_dir.clone().unwrap();

                            // Try mypy first, fall back to pyright
                            let mypy_output = run_shell_cmd_async(
                                "mypy --no-color-output --show-error-codes .".to_string(),
                                work_dir.clone(), timeout_seconds
                            ).await;

                            let (toolchain_name, stdout, stderr, exit_success) = match mypy_output {
                                Ok(output) => {
                                    let so = String::from_utf8_lossy(&output.stdout).to_string();
                                    let se = String::from_utf8_lossy(&output.stderr).to_string();
                                    let not_found = se.contains("not found") || se.contains("not recognized")
                                        || se.contains("No such file");
                                    if not_found {
                                        // mypy not installed â€” try pyright
                                        match run_shell_cmd_async(
                                            "pyright --outputjson".to_string(),
                                            work_dir.clone(), timeout_seconds
                                        ).await {
                                            Ok(pr_out) => {
                                                let pr_so = String::from_utf8_lossy(&pr_out.stdout).to_string();
                                                let pr_se = String::from_utf8_lossy(&pr_out.stderr).to_string();
                                                ("pyright", pr_so, pr_se, pr_out.status.success())
                                            }
                                            Err(e) => return Err(format!("Neither mypy nor pyright available: {}", e)),
                                        }
                                    } else {
                                        ("mypy", so, se, output.status.success())
                                    }
                                }
                                Err(_) => {
                                    match run_shell_cmd_async(
                                        "pyright --outputjson".to_string(),
                                        work_dir.clone(), timeout_seconds
                                    ).await {
                                        Ok(pr_out) => {
                                            let pr_so = String::from_utf8_lossy(&pr_out.stdout).to_string();
                                            let pr_se = String::from_utf8_lossy(&pr_out.stderr).to_string();
                                            ("pyright", pr_so, pr_se, pr_out.status.success())
                                        }
                                        Err(e) => return Err(format!("Neither mypy nor pyright available: {}", e)),
                                    }
                                }
                            };

                            let mut errors: Vec<serde_json::Value> = Vec::new();

                            if toolchain_name == "mypy" {
                                // mypy output: file.py:line: error: message  [code]
                                for line in stdout.lines().chain(stderr.lines()) {
                                    let trimmed = line.trim();
                                    if !trimmed.contains(": error:") {
                                        continue;
                                    }
                                    if let Some(first_colon) = trimmed.find(':') {
                                        let file_part = &trimmed[..first_colon];
                                        let rest = &trimmed[first_colon + 1..];
                                        let parts: Vec<&str> = rest.splitn(2, ':').collect();
                                        let line_num = parts.first().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0);
                                        let message = parts.get(1).unwrap_or(&"").trim().to_string();
                                        // Extract error code from trailing [code]
                                        let (msg, code) = if let Some(bracket) = message.rfind('[') {
                                            let c = message[bracket+1..].trim_end_matches(']').trim().to_string();
                                            (message[..bracket].trim().to_string(), c)
                                        } else {
                                            (message, String::new())
                                        };
                                        errors.push(serde_json::json!({
                                            "file": file_part,
                                            "line": line_num,
                                            "col": 0,
                                            "code": code,
                                            "message": msg
                                        }));
                                    }
                                }
                            } else {
                                // pyright JSON output
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                                    if let Some(diagnostics) = parsed.get("generalDiagnostics").and_then(|v| v.as_array()) {
                                        for diag in diagnostics {
                                            let severity = diag.get("severity").and_then(|v| v.as_str()).unwrap_or("");
                                            if severity != "error" {
                                                continue;
                                            }
                                            let file = diag.get("file").and_then(|v| v.as_str()).unwrap_or("");
                                            let line_num = diag.get("range").and_then(|r| r.get("start")).and_then(|s| s.get("line")).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                            let col = diag.get("range").and_then(|r| r.get("start")).and_then(|s| s.get("character")).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                            let end_line_num = diag.get("range").and_then(|r| r.get("end")).and_then(|e| e.get("line")).and_then(|v| v.as_u64()).map(|v| v as u32);
                                            let message = diag.get("message").and_then(|v| v.as_str()).unwrap_or("");
                                            let rule = diag.get("rule").and_then(|v| v.as_str()).unwrap_or("");
                                            let mut err_obj = serde_json::json!({
                                                "file": file,
                                                "line": line_num,
                                                "col": col,
                                                "code": rule,
                                                "message": message
                                            });
                                            if let Some(el) = end_line_num {
                                                err_obj["end_line"] = serde_json::json!(el);
                                            }
                                            errors.push(err_obj);
                                        }
                                    }
                                }
                            }

                            let success = exit_success && errors.is_empty();

                            Ok(serde_json::json!({
                                "type": "typecheck",
                                "toolchain": toolchain_name,
                                "success": success,
                                "errors": errors,
                                "summary": {
                                    "error_count": errors.len()
                                },
                                "_next": if success {
                                    "Type check passed. Run tests: q: v1 verify.test"
                                } else {
                                    "Fix type errors, then re-run: q: v1 verify.typecheck toolchain:python"
                                }
                            }))
                        } else if use_c {
                            let work_dir = c_cpp_dir.clone().unwrap();

                            let cmd = if work_dir.join("CMakeLists.txt").exists() {
                                let build_dir = work_dir.join("build");
                                if build_dir.exists() {
                                    "cmake --build build 2>&1".to_string()
                                } else {
                                    "cmake -B build -S . && cmake --build build 2>&1".to_string()
                                }
                            } else if work_dir.join("Makefile").exists() || work_dir.join("makefile").exists() {
                                "make 2>&1".to_string()
                            } else {
                                // Fallback: syntax-check all .c/.cpp files with gcc/g++
                                let has_cpp = std::fs::read_dir(&work_dir).ok().map_or(false, |entries| {
                                    entries.filter_map(|e| e.ok()).any(|e| {
                                        let n = e.file_name().to_string_lossy().to_string();
                                        n.ends_with(".cpp") || n.ends_with(".cc") || n.ends_with(".cxx")
                                    })
                                });
                                if has_cpp {
                                    "g++ -fsyntax-only *.cpp *.cc *.cxx 2>&1 || true".to_string()
                                } else {
                                    "gcc -fsyntax-only *.c 2>&1 || true".to_string()
                                }
                            };

                            let output = run_shell_cmd_async(cmd, work_dir.clone(), timeout_seconds).await?;

                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            let combined = combine_output(&stdout, &stderr);

                            let mut errors: Vec<serde_json::Value> = Vec::new();
                            // GCC/Clang format: file:line:col: error: message
                            for line in combined.lines() {
                                let trimmed = line.trim();
                                if !trimmed.contains(": error:") && !trimmed.contains(": fatal error:") {
                                    continue;
                                }
                                // Split on first colon to get file, then line:col: severity: message
                                let segments: Vec<&str> = trimmed.splitn(4, ':').collect();
                                if segments.len() >= 4 {
                                    let file = segments[0].trim();
                                    let line_num = segments[1].trim().parse::<u32>().unwrap_or(0);
                                    let col = segments[2].trim().parse::<u32>().unwrap_or(0);
                                    let rest = segments[3].trim();
                                    let message = rest.strip_prefix("error:").or_else(|| rest.strip_prefix("fatal error:"))
                                        .unwrap_or(rest).trim().to_string();
                                    errors.push(serde_json::json!({
                                        "file": file,
                                        "line": line_num,
                                        "col": col,
                                        "message": message
                                    }));
                                }
                            }

                            let success = output.status.success() && errors.is_empty();

                            Ok(serde_json::json!({
                                "type": "typecheck",
                                "toolchain": "c",
                                "success": success,
                                "errors": errors,
                                "summary": {
                                    "error_count": errors.len()
                                },
                                "_next": if success {
                                    "Build passed. Run tests: q: v1 verify.test"
                                } else {
                                    "Fix compilation errors, then re-run: q: v1 verify.typecheck toolchain:c"
                                }
                            }))
                        } else {
                            let tc_msg = if let Some(tc) = toolchain_override {
                                format!("Toolchain '{}' requested but project files not found. Detected: see below.", tc)
                            } else {
                                "typecheck requires a Rust (Cargo.toml), TypeScript (tsconfig.json), Java (build.gradle/pom.xml), C# (*.csproj), Swift (Package.swift), Go (go.mod), Python (pyproject.toml/requirements.txt), or C/C++ (CMakeLists.txt/Makefile) project. Use toolchain param to override.".to_string()
                            };
                            return Ok(serde_json::json!({
                                "error": tc_msg,
                                "detected_projects": detected_info(),
                                "hint": "Pass toolchain:'typescript' (or rust, java, csharp, swift, go, python, c) to skip auto-detection"
                            }));
                        }
                    }
                    "lint" => {
                        // Run linting based on project type
                        let (cmd_str, work_dir): (String, PathBuf) = if has_cargo_toml {
                            ("cargo clippy --message-format=json".to_string(), rust_dir.clone().unwrap())
                        } else if has_package_json {
                            ("npx eslint . --format=json".to_string(), node_dir.clone().unwrap())
                        } else if has_requirements {
                            ("python -m flake8 --format=json".to_string(), python_dir.clone().unwrap())
                        } else if has_go_mod {
                            ("golangci-lint run --out-format=json".to_string(), go_dir.clone().unwrap())
                        } else if has_java {
                            let jd = java_dir.clone().unwrap();
                            let cmd = if jd.join("gradlew").exists() || jd.join("gradlew.bat").exists() {
                                if cfg!(windows) { ".\\gradlew.bat check".to_string() } else { "./gradlew check".to_string() }
                            } else {
                                "gradle check".to_string()
                            };
                            (cmd, jd)
                        } else if has_csharp {
                            ("dotnet format --verify-no-changes".to_string(), csharp_dir.clone().unwrap())
                        } else if has_swift {
                            ("swift package plugin lint".to_string(), swift_dir.clone().unwrap())
                        } else if has_c_cpp {
                            let cd = c_cpp_dir.clone().unwrap();
                            ("make lint 2>&1 || echo 'No lint target in Makefile'".to_string(), cd)
                        } else {
                            return Ok(serde_json::json!({
                                "error": "Could not detect project type for linting",
                                "detected_projects": detected_info(),
                            }));
                        };
                        
                        let output = run_shell_cmd_async(cmd_str.clone(), work_dir.clone(), timeout_seconds).await?;
                        
                        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                        
                        // Parse JSON output, handling known linter schemas:
                        //   ESLint: [{...}, ...] (array of file results)
                        //   golangci-lint: {"Issues": [...]} (nested object)
                        //   Clippy: newline-delimited JSON messages
                        //   flake8: {"filename": [{...}]} (object keyed by filename)
                        let (issues, raw_fallback): (Vec<serde_json::Value>, bool) = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                            if let Some(arr) = parsed.as_array() {
                                (arr.iter().take(50).cloned().collect(), false)
                            } else if let Some(obj) = parsed.as_object() {
                                // Try common nested keys from known linters
                                let nested = obj.get("Issues")
                                    .or_else(|| obj.get("issues"))
                                    .or_else(|| obj.get("results"))
                                    .or_else(|| obj.get("messages"))
                                    .or_else(|| obj.get("errors"));
                                if let Some(serde_json::Value::Array(arr)) = nested {
                                    (arr.iter().take(50).cloned().collect(), false)
                                } else {
                                    // flake8 style: {"file.py": [{...}]} - flatten all values that are arrays
                                    let mut flat: Vec<serde_json::Value> = Vec::new();
                                    for val in obj.values() {
                                        if let Some(arr) = val.as_array() {
                                            flat.extend(arr.iter().take(50 - flat.len()).cloned());
                                        }
                                    }
                                    if !flat.is_empty() {
                                        (flat, false)
                                    } else {
                                        (vec![parsed], false)
                                    }
                                }
                            } else {
                                (vec![parsed], false)
                            }
                        } else {
                            // Try newline-delimited JSON (Clippy --message-format=json)
                            let mut ndjson_issues: Vec<serde_json::Value> = Vec::new();
                            for line in stdout.lines() {
                                if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
                                    if val.get("reason").and_then(|r| r.as_str()) == Some("compiler-message") {
                                        if let Some(msg) = val.get("message") {
                                            ndjson_issues.push(msg.clone());
                                        }
                                    }
                                }
                            }
                            if !ndjson_issues.is_empty() {
                                (ndjson_issues.into_iter().take(50).collect(), false)
                            } else {
                                // True fallback: raw output wrapper
                                let raw = if stdout.len() > 3000 {
                                    format!("{}...[truncated]", &stdout[..3000])
                                } else {
                                    stdout.clone()
                                };
                                (vec![serde_json::json!({"raw_output": raw})], true)
                            }
                        };
                        
                        // Don't count raw_output wrappers as real issues
                        let real_issue_count = if raw_fallback { 0 } else { issues.len() };

                        // Detect missing tool: non-zero exit + empty/unparseable stdout + stderr mentions "not found"/"not recognized"
                        let tool_missing = !output.status.success()
                            && (stdout.trim().is_empty() || raw_fallback)
                            && (stderr.contains("not found")
                                || stderr.contains("not recognized")
                                || stderr.contains("No such file")
                                || stderr.contains("No module named"));

                        if tool_missing {
                            return Ok(serde_json::json!({
                                "type": "lint",
                                "success": false,
                                "error": "Lint tool not available",
                                "stderr": if stderr.len() < 1000 { stderr.clone() } else { stderr[..1000].to_string() },
                                "hint": "Install the required linter. E.g.: pip install flake8, npm i -g eslint, cargo install clippy",
                                "_next": "Install the missing tool and retry: q: v1 verify.lint"
                            }));
                        }

                        let success = output.status.success();

                        let mut result = serde_json::json!({
                            "type": "lint",
                            "success": success,
                            "issues": issues,
                            "issue_count": real_issue_count,
                            "_next": if success {
                                "Linting passed. Run: q: v1 verify.test"
                            } else {
                                "Fix lint issues with q: e1 change.edit file_path:... line_edits:[...]"
                            }
                        });
                        if !stderr.is_empty() && stderr.len() < 500 {
                            result.as_object_mut().unwrap().insert("stderr".to_string(), serde_json::json!(stderr));
                        }
                        if !success && real_issue_count == 0 && raw_fallback {
                            result.as_object_mut().unwrap().insert("tool_error".to_string(),
                                serde_json::json!("Linter exited with error but output could not be parsed. Check raw_output or stderr for details."));
                        }
                        result["_metadata"] = verify_metadata(&work_dir, &manifest_file, &cmd_str, &selection_reason);
                        Ok(result)
                    }
                    _ => {
                        Err(format!("Unknown verify type: {}. Use: test, build, typecheck, lint", verify_type))
                    }
                }
            }
            "find_similar_code" => {
                // Find code similar to a given pattern
                let pattern = params
                    .get("pattern")
                    .and_then(|v| v.as_str())
                    .or_else(|| params.get("code").and_then(|v| v.as_str()));
                
                let file_path = params
                    .get("file")
                    .and_then(|v| v.as_str());
                
                let line_range = params
                    .get("line_range")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        (
                            arr.first().and_then(|v| v.as_u64()).unwrap_or(1) as u32,
                            arr.get(1).and_then(|v| v.as_u64()).unwrap_or(u32::MAX as u64) as u32
                        )
                    });
                
                let user_threshold = params
                    .get("threshold")
                    .and_then(|v| v.as_f64());
                let threshold = user_threshold.unwrap_or(0.2);
                
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(20);
                
                // Get the code to compare
                let search_code = if let Some(p) = pattern {
                    p.to_string()
                } else if let (Some(file), Some((start, end))) = (file_path, line_range) {
                    let resolved = resolve_project_path(project_root, file);
                    match std::fs::read_to_string(&resolved) {
                        Ok(content) => {
                            let lines: Vec<&str> = content.lines().collect();
                            let start_idx = std::cmp::min((start as usize).saturating_sub(1), lines.len());
                            let end_idx = std::cmp::min(end as usize, lines.len());
                            if start_idx < end_idx {
                                lines[start_idx..end_idx].join("\n")
                            } else {
                                String::new()
                            }
                        }
                        Err(_) => return Err("Failed to read file".to_string())
                    }
                } else {
                    return Err("Either pattern/code or file+line_range required".to_string());
                };
                
                // Split camelCase/PascalCase/snake_case into sub-words for better recall.
                // e.g. "fetchModels" -> ["fetch", "Models", "fetchModels"]
                let split_subwords = |word: &str| -> Vec<String> {
                    let mut parts = Vec::new();
                    let mut last = 0;
                    let chars: Vec<char> = word.chars().collect();
                    for i in 1..chars.len() {
                        let split_here = (chars[i].is_uppercase() && !chars[i - 1].is_uppercase())
                            || chars[i] == '_';
                        if split_here {
                            let sub = &word[last..word.char_indices().nth(i).map(|(idx, _)| idx).unwrap_or(word.len())];
                            let sub = sub.trim_matches('_');
                            if sub.len() > 1 { parts.push(sub.to_lowercase()); }
                            last = word.char_indices().nth(i).map(|(idx, _)| idx).unwrap_or(word.len());
                        }
                    }
                    let tail = &word[last..];
                    let tail = tail.trim_matches('_');
                    if tail.len() > 1 { parts.push(tail.to_lowercase()); }
                    // Also include the full word as a token
                    if word.len() > 1 { parts.push(word.to_lowercase()); }
                    parts
                };

                // Extract function/method call names from the code as high-value
                // search tokens. These survive Rust syntax that destroys generic
                // tokenizers (byte literals, ? operator, method chains).
                // Patterns: `name(`, `.name(`, `name!(`, `::name(`
                let mut call_names: std::collections::HashSet<String> = std::collections::HashSet::new();
                // Extract function/method call names by scanning for `identifier(`
                // patterns: `.name(`, `name(`, `name!(`, `::name(`, `name::<T>(`.
                // Scan for `identifier(` and `.identifier(` and `identifier!(` patterns
                {
                    let code_bytes = search_code.as_bytes();
                    let len = code_bytes.len();
                    let mut i = 0;
                    while i < len {
                        // Find '(' which indicates a call
                        if code_bytes[i] == b'(' {
                            // Walk backwards over whitespace
                            let mut j = i;
                            while j > 0 && (code_bytes[j - 1] == b' ' || code_bytes[j - 1] == b'!') {
                                j -= 1;
                            }
                            // Walk backwards over optional ::<...> generic turbofish
                            if j >= 2 && code_bytes[j - 1] == b'>' {
                                let mut depth = 1;
                                j -= 2;
                                while j > 0 && depth > 0 {
                                    if code_bytes[j] == b'>' { depth += 1; }
                                    if code_bytes[j] == b'<' { depth -= 1; }
                                    if depth > 0 { j -= 1; }
                                }
                                // Skip the `::`
                                if j >= 2 && code_bytes[j - 1] == b':' && code_bytes[j - 2] == b':' {
                                    j -= 2;
                                }
                            }
                            // Walk backwards over identifier chars
                            let end = j;
                            while j > 0 && (code_bytes[j - 1].is_ascii_alphanumeric() || code_bytes[j - 1] == b'_') {
                                j -= 1;
                            }
                            if end > j {
                                let name = &search_code[j..end];
                                if name.len() >= 3
                                    && name.chars().next().map(|c| c.is_alphabetic() || c == '_').unwrap_or(false)
                                {
                                    let lower = name.to_lowercase();
                                    call_names.insert(lower);
                                }
                            }
                        }
                        i += 1;
                    }
                }

                // Tokenize search code into words, then split camelCase sub-words
                let raw_words: Vec<&str> = search_code
                    .split(|c: char| !c.is_alphanumeric() && c != '_')
                    .filter(|s| s.len() > 1)
                    .collect();
                let words: Vec<String> = raw_words.iter()
                    .flat_map(|w| split_subwords(w))
                    .collect();
                let words_refs: Vec<&str> = words.iter().map(|s| s.as_str()).collect();
                
                // Common language keywords to downweight in similarity scoring
                let stop_words: std::collections::HashSet<&str> = [
                    "const", "let", "var", "function", "return", "if", "else", "for",
                    "while", "import", "export", "from", "async", "await", "new", "this",
                    "true", "false", "null", "undefined", "fn", "pub", "use", "mod",
                    "struct", "impl", "self", "mut", "ref", "type", "enum", "match",
                    "some", "none", "ok", "err", "break", "continue", "loop", "where",
                    "trait", "crate", "super", "as", "in", "move", "dyn", "box",
                ].iter().copied().collect();
                
                let mut filtered_tokens: std::collections::HashSet<String> = words_refs.iter()
                    .filter(|s| !stop_words.contains(**s))
                    .map(|s| s.to_lowercase())
                    .collect();

                // Merge call names into the token set (they survive Rust syntax)
                for cn in &call_names {
                    if !stop_words.contains(cn.as_str()) {
                        filtered_tokens.insert(cn.clone());
                    }
                }

                // If all tokens were stop words, keep them anyway (the user's intent is specific)
                let search_tokens: std::collections::HashSet<String> = if filtered_tokens.is_empty() {
                    words_refs.iter().map(|s| s.to_lowercase()).collect()
                } else {
                    filtered_tokens
                };
                
                // Add bigrams for structural similarity
                let search_bigrams: std::collections::HashSet<String> = words_refs.windows(2)
                    .map(|w| format!("{}_{}", w[0].to_lowercase(), w[1].to_lowercase()))
                    .collect();
                
                if search_tokens.is_empty() && search_bigrams.is_empty() && call_names.is_empty() {
                    return Ok(serde_json::json!({
                        "error": "No significant tokens found in pattern",
                        "results": []
                    }));
                }
                
                let conn = project.db().conn();
                let mut results: Vec<(f64, serde_json::Value)> = Vec::new();

                // Compute effective threshold and scoring mode early so all phases use them.
                let long_pattern = search_tokens.len() > 30;
                let effective_threshold = if long_pattern && user_threshold.is_none() {
                    threshold * 0.5
                } else {
                    threshold
                };

                // Phase 0: Exact/prefix name match (fast, pure DB).
                // Only for single-token patterns â€” multi-token patterns should use
                // Jaccard similarity in Phase 1 for meaningful scores.
                let search_lower = search_code.trim().to_lowercase();
                let is_single_token = search_tokens.len() <= 1;
                if is_single_token {
                    let name_pattern = format!("{}%", search_lower);
                    if let Ok(mut name_stmt) = conn.prepare(
                        "SELECT s.name, f.path, s.line, s.kind, s.signature, s.metadata, s.end_line
                         FROM symbols s JOIN files f ON s.file_id = f.id
                         WHERE LOWER(s.name) LIKE ?1
                           AND s.kind IN ('function', 'method', 'arrow_function', 'class')
                         LIMIT 50"
                    ) {
                        if let Ok(name_rows) = name_stmt.query_map([&name_pattern], |row| {
                            Ok((
                                row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                                row.get::<_, u32>(2)?, row.get::<_, String>(3)?,
                                row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?,
                                row.get::<_, Option<u32>>(6)?,
                            ))
                        }) {
                            for row in name_rows.flatten() {
                                let (name, file, line, kind, signature, _metadata, db_end_line) = row;
                                let end_line = db_end_line.unwrap_or(line + 10);
                                let snippet = signature.clone().unwrap_or_default();
                                let sim = if name.to_lowercase() == search_lower { 1.0 } else { 0.4 };
                                results.push((sim, serde_json::json!({
                                    "name": name, "file": file, "line": line, "end_line": end_line,
                                    "kind": kind, "signature": signature,
                                    "similarity": sim, "snippet": snippet, "match_source": "name_fallback"
                                })));
                            }
                        }
                    }
                }

                // Phase 0.5: Use extracted call names for direct DB name lookups.
                // This catches Rust code patterns where the tokenizer fails
                // (e.g., `self.peek()?.eat_char()` â†’ call_names = {"peek", "eat_char"}).
                // Score = fraction of call_names that match the candidate's name.
                if !call_names.is_empty() && call_names.len() >= 2 {
                    let call_names_list: Vec<&str> = call_names.iter()
                        .filter(|n| !stop_words.contains(n.as_str()))
                        .map(|s| s.as_str())
                        .collect();
                    if !call_names_list.is_empty() {
                        // Build OR conditions for each call name
                        let conditions: Vec<String> = call_names_list.iter()
                            .map(|n| format!("LOWER(s.name) = '{}'", n.replace('\'', "''")))
                            .collect();
                        let sql = format!(
                            "SELECT s.name, f.path, s.line, s.kind, s.signature, s.metadata, s.end_line
                             FROM symbols s JOIN files f ON s.file_id = f.id
                             WHERE ({})
                               AND s.kind IN ('function', 'method', 'arrow_function')
                             LIMIT 100",
                            conditions.join(" OR ")
                        );
                        if let Ok(mut cn_stmt) = conn.prepare(&sql) {
                            if let Ok(cn_rows) = cn_stmt.query_map([], |row| {
                                Ok((
                                    row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                                    row.get::<_, u32>(2)?, row.get::<_, String>(3)?,
                                    row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?,
                                    row.get::<_, Option<u32>>(6)?,
                                ))
                            }) {
                                for row in cn_rows.flatten() {
                                    let (name, file, line, kind, signature, _metadata, db_end_line) = row;
                                    let end_line = db_end_line.unwrap_or(line + 10);
                                    let snippet = signature.clone().unwrap_or_default();
                                    // Score: how many of the call names does this function's
                                    // signature/name context match?
                                    let name_lower = name.to_lowercase();
                                    let sig_lower = signature.as_deref().unwrap_or("").to_lowercase();
                                    let combined = format!("{} {}", name_lower, sig_lower);
                                    let matched_calls = call_names_list.iter()
                                        .filter(|cn| combined.contains(*cn))
                                        .count();
                                    let sim = matched_calls as f64 / call_names_list.len() as f64;
                                    // Exact name match from the search code is high-confidence
                                    let boosted_sim = if call_names.contains(&name_lower) {
                                        sim.max(0.5)
                                    } else {
                                        sim
                                    };
                                    if boosted_sim >= effective_threshold {
                                        results.push((boosted_sim, serde_json::json!({
                                            "name": name, "file": file, "line": line, "end_line": end_line,
                                            "kind": kind, "signature": signature,
                                            "similarity": (boosted_sim * 100.0).round() / 100.0,
                                            "snippet": snippet,
                                            "match_source": "call_name_lookup"
                                        })));
                                    }
                                }
                            }
                        }
                    }
                }

                // Phase 1: Compare against name+signature in DB (no file I/O).
                // ORDER BY id DESC so newest symbols are included first.
                let phase_start = std::time::Instant::now();
                let phase_timeout = std::time::Duration::from_secs(20);
                let mut stmt = match conn.prepare(
                    "SELECT s.name, f.path, s.line, s.kind, s.signature, s.metadata,
                            s.end_line
                     FROM symbols s
                     JOIN files f ON s.file_id = f.id
                     WHERE s.kind IN ('function', 'method', 'arrow_function', 'class')
                     ORDER BY s.id DESC
                     LIMIT 1500"
                ) {
                    Ok(s) => s,
                    Err(e) => return Err(format!("Query error: {}", e))
                };
                
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<u32>>(6)?,
                    ))
                }).map_err(|e| e.to_string())?;

                let mut db_rows: Vec<(String, String, u32, String, Option<String>, Option<String>, Option<u32>)> = Vec::new();
                for row in rows {
                    if let Ok(r) = row {
                        db_rows.push(r);
                    }
                }

                let short_snippet = search_tokens.len() < 5;
                let similarity_fn = |s_tok: &std::collections::HashSet<String>,
                               s_bi: &std::collections::HashSet<String>,
                               t_tok: &std::collections::HashSet<String>,
                               t_bi: &std::collections::HashSet<String>| -> f64 {
                    if long_pattern {
                        // Asymmetric containment: how much of the candidate is in the query
                        let uni_inter = s_tok.intersection(t_tok).count();
                        let containment = if t_tok.is_empty() { 0.0 }
                            else { uni_inter as f64 / t_tok.len() as f64 };
                        let bi_inter = s_bi.intersection(t_bi).count();
                        let bi_containment = if t_bi.is_empty() { 0.0 }
                            else { bi_inter as f64 / t_bi.len() as f64 };
                        if short_snippet || t_bi.is_empty() {
                            containment
                        } else {
                            containment * 0.6 + bi_containment * 0.4
                        }
                    } else {
                        // Standard Jaccard similarity
                        let uni_inter = s_tok.intersection(t_tok).count();
                        let uni_union = s_tok.union(t_tok).count();
                        let uni_sim = if uni_union > 0 { uni_inter as f64 / uni_union as f64 } else { 0.0 };
                        if short_snippet {
                            return uni_sim;
                        }
                        let bi_inter = s_bi.intersection(t_bi).count();
                        let bi_union = s_bi.union(t_bi).count();
                        let bi_sim = if bi_union > 0 { bi_inter as f64 / bi_union as f64 } else { 0.0 };
                        uni_sim * 0.6 + bi_sim * 0.4
                    }
                };

                // Track Phase 0 hits to avoid duplicates in Phase 1
                let phase0_keys: std::collections::HashSet<String> = results.iter()
                    .map(|(_, v)| format!("{}:{}",
                        v.get("file").and_then(|f| f.as_str()).unwrap_or(""),
                        v.get("line").and_then(|l| l.as_u64()).unwrap_or(0)))
                    .collect();

                // Phase 1: Compare against signature + function name (no file I/O)
                let mut timed_out = false;
                for (name, file, line, kind, signature, _metadata, db_end_line) in &db_rows {
                    if phase_start.elapsed() > phase_timeout {
                        timed_out = true;
                        break;
                    }
                    let key = format!("{}:{}", file, line);
                    if phase0_keys.contains(&key) { continue; }
                    let sig_text = signature.as_deref().unwrap_or("");

                    // Include function name tokens alongside signature tokens, with camelCase split
                    let name_and_sig = format!("{} {}", name, sig_text);
                    let sig_raw: Vec<&str> = name_and_sig
                        .split(|c: char| !c.is_alphanumeric() && c != '_')
                        .filter(|s| s.len() > 1)
                        .collect();
                    let sig_words: Vec<String> = sig_raw.iter().flat_map(|w| split_subwords(w)).collect();
                    let sig_words_refs: Vec<&str> = sig_words.iter().map(|s| s.as_str()).collect();

                    let sig_tokens_filtered: std::collections::HashSet<String> = sig_words_refs.iter()
                        .filter(|s| !stop_words.contains(**s))
                        .map(|s| s.to_lowercase())
                        .collect();
                    let sig_tokens: std::collections::HashSet<String> = if search_tokens.iter().all(|t| stop_words.contains(t.as_str())) {
                        sig_words_refs.iter().map(|s| s.to_lowercase()).collect()
                    } else {
                        sig_tokens_filtered
                    };

                    let sig_bigrams: std::collections::HashSet<String> = sig_words_refs.windows(2)
                        .map(|w| format!("{}_{}", w[0].to_lowercase(), w[1].to_lowercase()))
                        .collect();

                    let similarity = similarity_fn(&search_tokens, &search_bigrams, &sig_tokens, &sig_bigrams);

                    if similarity >= effective_threshold {
                        let end_line = db_end_line.unwrap_or(*line + 10);
                        let snippet = signature.clone().unwrap_or_default();

                        results.push((similarity, serde_json::json!({
                            "name": name,
                            "file": file,
                            "line": line,
                            "end_line": end_line,
                            "kind": kind,
                            "signature": signature,
                            "similarity": (similarity * 100.0).round() / 100.0,
                            "snippet": snippet
                        })));
                    }
                }

                // Sort by similarity descending
                results.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                let final_results: Vec<serde_json::Value> = results.into_iter().take(limit).map(|(_, v)| v).collect();
                let result_count = final_results.len();

                let retry_hint = if result_count == 0 && user_threshold.is_none() {
                    Some("No results at default threshold. On fresh repos, run scan_project first to populate the similarity index. Then try threshold:0.1 for broader matching.")
                } else if result_count == 0 {
                    Some("No results. Try lowering the threshold value.")
                } else {
                    None
                };
                
                let mut response = serde_json::json!({
                    "threshold": effective_threshold,
                    "scoring_mode": if long_pattern { "asymmetric_containment" } else { "jaccard" },
                    "results": final_results,
                    "count": result_count,
                    "_threshold_hint": "Practical range: 0.2-0.4. Lower = more results. Cross-language matches typically score 0.2-0.3.",
                    "_next": "Review similar code for potential refactoring or deduplication"
                });
                if let Some(hint) = retry_hint {
                    response.as_object_mut().unwrap().insert("hint".to_string(), serde_json::json!(hint));
                }
                if timed_out {
                    response.as_object_mut().unwrap().insert("warning".to_string(),
                        serde_json::json!("Search timed out after 20s â€” returning partial results. Try narrowing with file_paths or a higher threshold."));
                }
                
                Ok(response)
            }
            "find_similar_functions" => {
                // Find functions similar to named functions using signature comparison
                // Accept: function_names (array) or functions (array alias)
                let function_names: Vec<String> = params
                    .get("function_names")
                    .or_else(|| params.get("functions"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                if function_names.is_empty() {
                    return Err("function_names required for find_similar_functions (also accepts: functions)".to_string());
                }
                
                let threshold = params
                    .get("threshold")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.3);
                
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(20);
                
                match project.query().find_similar_functions(&function_names, threshold, limit) {
                    Ok(matches) => {
                        // Group results by source function, dedup by (target, file, line)
                        let mut grouped: std::collections::HashMap<String, Vec<serde_json::Value>> = std::collections::HashMap::new();
                        let mut seen: std::collections::HashSet<(String, String, u32)> = std::collections::HashSet::new();
                        for m in &matches {
                            if !seen.insert((m.target.clone(), m.file.clone(), m.line)) { continue; }
                            // Filter exact self-matches (same name in same file)
                            if m.source == m.target && function_names.contains(&m.target) { continue; }
                            grouped.entry(m.source.clone()).or_default().push(serde_json::json!({
                                "target": m.target,
                                "file": m.file,
                                "line": m.line,
                                "similarity": format!("{:.1}%", m.similarity * 100.0),
                                "signature": m.signature,
                                "match_type": m.match_type
                            }));
                        }
                        
                        let total: usize = grouped.values().map(|v| v.len()).sum();
                        let results_val: serde_json::Value = if grouped.is_empty() {
                            serde_json::json!([])
                        } else {
                            serde_json::json!(grouped)
                        };
                        Ok(serde_json::json!({
                            "function_names": function_names,
                            "threshold": threshold,
                            "total_matches": total,
                            "results": results_val,
                            "_next": "Review similar functions for potential refactoring or deduplication"
                        }))
                    }
                    Err(e) => {
                        Ok(serde_json::json!({
                            "function_names": function_names,
                            "threshold": threshold,
                            "error": e.to_string(),
                            "results": []
                        }))
                    }
                }
            }
            "find_pattern_implementations" => {
                // Find implementations of design patterns (name-based + structural).
                // Supports both OOP patterns (class name matching) and Rust idiomatic
                // patterns (trait impls via metadata/signature inspection).
                let patterns: Vec<String> = params
                    .get("patterns")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_lowercase()))
                            .collect()
                    })
                    .unwrap_or_else(|| vec![
                        "singleton".to_string(),
                        "factory".to_string(),
                        "observer".to_string(),
                        "decorator".to_string(),
                        "strategy".to_string(),
                        "builder".to_string(),
                        "iterator".to_string(),
                        "adapter".to_string(),
                        "visitor".to_string(),
                    ]);
                
                let conn = project.db().conn();
                let mut results: Vec<serde_json::Value> = Vec::new();

                // Helper: run a SQL query and collect results as JSON
                let run_pattern_query = |sql: &str| -> Vec<serde_json::Value> {
                    let stmt = conn.prepare(sql).ok();
                    if let Some(mut stmt) = stmt {
                        stmt.query_map([], |row| {
                            Ok(serde_json::json!({
                                "name": row.get::<_, String>(0)?,
                                "file": row.get::<_, String>(1)?,
                                "line": row.get::<_, u32>(2)?,
                                "kind": row.get::<_, String>(3)?
                            }))
                        }).ok()
                            .map(|rows| rows.filter_map(|r| r.ok()).collect())
                            .unwrap_or_default()
                    } else {
                        Vec::new()
                    }
                };

                // Helper: deduplicate matches by (file, line)
                let dedup_matches = |mut matches: Vec<serde_json::Value>| -> Vec<serde_json::Value> {
                    let mut seen = std::collections::HashSet::new();
                    matches.retain(|m| {
                        let key = format!("{}:{}",
                            m.get("file").and_then(|f| f.as_str()).unwrap_or(""),
                            m.get("line").and_then(|l| l.as_u64()).unwrap_or(0));
                        seen.insert(key)
                    });
                    matches
                };
                
                for pattern in &patterns {
                    let matches: Vec<serde_json::Value> = match pattern.as_str() {
                        "singleton" => {
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE s.kind = 'class'
                                   AND (s.name LIKE '%Singleton%' 
                                        OR EXISTS (SELECT 1 FROM symbols s2 
                                                  WHERE s2.scope_id = s.id 
                                                  AND s2.name LIKE '%instance%'))
                                 LIMIT 20"
                            );
                            // Rust: static/lazy_static with OnceLock/OnceCell pattern
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.signature LIKE '%OnceLock%'
                                        OR s.signature LIKE '%OnceCell%'
                                        OR s.signature LIKE '%lazy_static%'
                                        OR s.name LIKE '%INSTANCE%'
                                        OR s.name LIKE '%SINGLETON%')
                                   AND s.kind IN ('variable', 'constant', 'static')
                                 LIMIT 20"
                            ));
                            dedup_matches(m)
                        }
                        "factory" => {
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.name LIKE '%Factory%' OR s.name LIKE '%Creator%')
                                   AND s.kind IN ('class', 'function', 'struct', 'trait')
                                 LIMIT 20"
                            );
                            // Rust: new() / create() / build() constructor functions
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE s.name IN ('new', 'create', 'from_config')
                                   AND s.kind IN ('function', 'method')
                                   AND (s.signature LIKE '%-> Self%'
                                        OR s.signature LIKE '%-> Box<%')
                                 LIMIT 30"
                            ));
                            dedup_matches(m)
                        }
                        "observer" => {
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.name LIKE '%Observer%' OR s.name LIKE '%Listener%' 
                                        OR s.name LIKE '%subscribe%' OR s.name LIKE '%emit%'
                                        OR s.name LIKE '%on\\_%' ESCAPE '\\'
                                        OR s.name LIKE '%notify%')
                                 LIMIT 20"
                            );
                            // Rust: channels (Sender/Receiver) and callback patterns
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.signature LIKE '%Sender<%'
                                        OR s.signature LIKE '%Receiver<%'
                                        OR s.signature LIKE '%Fn(%'
                                        OR s.signature LIKE '%FnMut(%')
                                   AND s.kind IN ('function', 'method', 'field')
                                   AND (s.name LIKE '%callback%'
                                        OR s.name LIKE '%handler%'
                                        OR s.name LIKE '%subscribe%'
                                        OR s.name LIKE '%register%')
                                 LIMIT 20"
                            ));
                            dedup_matches(m)
                        }
                        "builder" => {
                            // OOP: class/struct with Builder in name
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE s.name LIKE '%Builder%'
                                   AND s.kind IN ('class', 'struct')
                                 LIMIT 20"
                            );
                            // Rust: methods that return -> Self or -> &mut Self (fluent chaining)
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.signature LIKE '%-> Self%'
                                        OR s.signature LIKE '%-> &mut Self%'
                                        OR s.signature LIKE '%-> &Self%')
                                   AND s.kind IN ('method', 'function')
                                   AND s.name NOT IN ('new', 'default', 'clone', 'from')
                                 LIMIT 30"
                            ));
                            dedup_matches(m)
                        }
                        "iterator" => {
                            // OOP: class implementing Iterator/Iterable
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.name LIKE '%Iterator%' OR s.name LIKE '%Iterable%')
                                   AND s.kind IN ('class', 'struct', 'interface', 'trait')
                                 LIMIT 20"
                            );
                            // Rust: impl Iterator (via metadata) or next() methods returning Option
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.metadata LIKE '%Iterator%'
                                        OR s.metadata LIKE '%IntoIterator%')
                                   AND s.kind IN ('method', 'function', 'impl')
                                 LIMIT 30"
                            ));
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE s.name = 'next'
                                   AND s.kind = 'method'
                                   AND s.signature LIKE '%Option<%'
                                 LIMIT 20"
                            ));
                            dedup_matches(m)
                        }
                        "visitor" => {
                            // OOP: Visitor/Visitable classes
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.name LIKE '%Visitor%' OR s.name LIKE '%Visitable%')
                                   AND s.kind IN ('class', 'struct', 'interface', 'trait')
                                 LIMIT 20"
                            );
                            // Rust: visit_* methods or traits with Visitor metadata
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.name LIKE 'visit\\_%' ESCAPE '\\'
                                        OR s.name LIKE 'walk\\_%' ESCAPE '\\')
                                   AND s.kind IN ('method', 'function')
                                 LIMIT 30"
                            ));
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE s.metadata LIKE '%Visitor%'
                                   AND s.kind IN ('impl', 'method')
                                 LIMIT 20"
                            ));
                            dedup_matches(m)
                        }
                        "decorator" => {
                            // OOP: Decorator/Wrapper classes
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.name LIKE '%Decorator%' OR s.name LIKE '%Wrapper%')
                                   AND s.kind IN ('class', 'struct')
                                 LIMIT 20"
                            );
                            // Rust: Deref/DerefMut impl (delegation pattern)
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.metadata LIKE '%Deref%'
                                        OR s.metadata LIKE '%DerefMut%'
                                        OR s.metadata LIKE '%AsRef%')
                                   AND s.kind IN ('impl', 'method')
                                 LIMIT 20"
                            ));
                            dedup_matches(m)
                        }
                        "strategy" => {
                            // OOP: Strategy classes
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.name LIKE '%Strategy%' OR s.name LIKE '%Policy%')
                                   AND s.kind IN ('class', 'struct', 'interface', 'trait')
                                 LIMIT 20"
                            );
                            // Rust: traits with 2+ implementations (strategy = swappable impl)
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE s.kind = 'trait'
                                   AND (SELECT COUNT(DISTINCT s2.name) FROM symbols s2
                                        WHERE s2.metadata LIKE '%' || s.name || '%'
                                          AND s2.kind IN ('impl', 'method')) >= 2
                                 LIMIT 20"
                            ));
                            dedup_matches(m)
                        }
                        "adapter" => {
                            // OOP: Adapter classes
                            let mut m = run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.name LIKE '%Adapter%' OR s.name LIKE '%Adaptor%')
                                   AND s.kind IN ('class', 'struct')
                                 LIMIT 20"
                            );
                            // Rust: From/Into/TryFrom/TryInto implementations
                            m.extend(run_pattern_query(
                                "SELECT s.name, f.path, s.line, s.kind
                                 FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (s.metadata LIKE '%From<%'
                                        OR s.metadata LIKE '%Into<%'
                                        OR s.metadata LIKE '%TryFrom<%'
                                        OR s.metadata LIKE '%TryInto<%')
                                   AND s.kind IN ('impl', 'method')
                                 LIMIT 30"
                            ));
                            dedup_matches(m)
                        }
                        _ => Vec::new()
                    };
                    
                    if !matches.is_empty() {
                        results.push(serde_json::json!({
                            "pattern": pattern,
                            "count": matches.len(),
                            "matches": matches
                        }));
                    }
                }
                
                Ok(serde_json::json!({
                    "patterns_searched": patterns,
                    "results": results,
                    "patterns_found": results.len()
                }))
            }
            "find_conceptual_matches" => {
                // Find code matching concepts using FTS
                // Accept: concepts (array) or concept (string)
                let concepts: Vec<String> = params
                    .get("concepts")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .or_else(|| {
                        // Also accept single concept as string
                        params.get("concept")
                            .and_then(|v| v.as_str())
                            .map(|s| vec![s.to_string()])
                    })
                    .unwrap_or_default();
                
                if concepts.is_empty() {
                    return Err("concepts array required for find_conceptual_matches (also accepts: concept as string)".to_string());
                }
                
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(20);
                
                let mut all_results: Vec<serde_json::Value> = Vec::new();
                
                for concept in &concepts {
                    // Expand concept to related terms
                    let related_terms = expand_concept(concept);
                    
                    // Search using code_search
                    let search_results = project.query().search_code(&related_terms, limit);
                    
                    match search_results {
                        Ok(results) => {
                            let matches: Vec<serde_json::Value> = results.iter().map(|r| {
                                let rel = (r.relevance * 100.0).round() / 100.0;
                                serde_json::json!({
                                    "symbol": r.symbol,
                                    "file": r.file,
                                    "line": r.line,
                                    "kind": r.kind,
                                    "relevance": rel
                                })
                            }).collect();
                            
                            all_results.push(serde_json::json!({
                                "concept": concept,
                                "search_terms": related_terms,
                                "count": matches.len(),
                                "matches": matches
                            }));
                        }
                        Err(_) => {
                            all_results.push(serde_json::json!({
                                "concept": concept,
                                "error": "Search failed"
                            }));
                        }
                    }
                }
                
                Ok(serde_json::json!({
                    "concepts": concepts,
                    "results": all_results,
                    "_next": "Use q: r1 read.context type:smart file_paths:... to read the matched code"
                }))
            }
            "find_issues" => {
                // Find issues in the codebase with optional filtering
                use atls_core::{types::IssueSeverity, IssueFilterOptions};

                fn filter_issues_by_mode(
                    issues: Vec<atls_core::Issue>,
                    mode: &str,
                ) -> Vec<atls_core::Issue> {
                    if mode == "all" {
                        return issues;
                    }
                    if mode == "correctness" || mode == "security" {
                        return issues
                            .into_iter()
                            .filter(|i| !i.category.eq_ignore_ascii_case("style"))
                            .collect();
                    }
                    issues
                }
                
                let file_paths: Option<Vec<String>> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect()
                    });
                let target_directory: Option<String> = params
                    .get("target_directory")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                
                let category = params.get("category").and_then(|v| v.as_str());
                let severity_str = params.get("severity").and_then(|v| v.as_str());
                let limit = params.get("limit").and_then(|v| v.as_u64()).map(|v| v as u32);
                let offset = params.get("offset").and_then(|v| v.as_u64()).map(|v| v as u32);
                let issue_mode = params
                    .get("issue_mode")
                    .or_else(|| params.get("mode"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("correctness");
                
                let mut filter = IssueFilterOptions::default();
                if let Some(cat) = category {
                    filter.category = Some(cat.to_string());
                }
                if let Some(sev_str) = severity_str {
                    filter.severity = Some(match sev_str {
                        "high" => IssueSeverity::High,
                        "medium" => IssueSeverity::Medium,
                        "low" => IssueSeverity::Low,
                        _ => IssueSeverity::Medium,
                    });
                }
                filter.limit = Some(limit.unwrap_or(50));
                filter.offset = offset;

                // Build file_patterns using directory-prefix matching (not suffix)
                if let Some(ref dir) = target_directory {
                    let normalized = dir.replace('\\', "/");
                    let dir_prefix = if normalized.ends_with('/') { normalized } else { format!("{}/", normalized) };
                    filter.file_patterns = Some(vec![format!("{}%", dir_prefix)]);
                } else if let Some(ref paths) = file_paths {
                    let patterns: Vec<String> = paths.iter().flat_map(|p| {
                        let normalized = to_relative_path(project_root, &p.replace('\\', "/"));
                        if normalized.ends_with('/') {
                            let fwd = format!("{}%", normalized);
                            let bwd = format!("{}%", normalized.replace('/', "\\"));
                            vec![fwd, bwd]
                        } else {
                            let fwd = format!("%{}", normalized);
                            let bwd = format!("%{}", normalized.replace('/', "\\"));
                            vec![fwd, bwd]
                        }
                    }).collect();
                    filter.file_patterns = Some(patterns);
                }

                let mut count_filter = filter.clone();
                count_filter.limit = None;
                count_filter.offset = None;
                let matching_total_res = project.query().count_issues(&count_filter);
                
                match project.query().find_issues(&filter) {
                    Ok(issues) => {
                        let issues = filter_issues_by_mode(issues, issue_mode);
                        let matching_total =
                            matching_total_res.unwrap_or_else(|_| issues.len() as u64);
                        // Get file path mapping
                        let file_path_map: std::collections::HashMap<i64, String> = {
                            let conn = project.query().db().conn();
                            let mut stmt = conn.prepare("SELECT id, path FROM files")
                                .unwrap_or_else(|_| panic!("Failed to prepare"));
                            let rows = stmt.query_map([], |row| {
                                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                            }).unwrap_or_else(|_| panic!("Failed to query"));
                            rows.filter_map(|r| r.ok()).collect()
                        };
                        
                        let filtered = issues;
                        
                        let mut high = 0u32;
                        let mut medium = 0u32;
                        let mut low = 0u32;
                        for issue in &filtered {
                            match issue.severity {
                                IssueSeverity::High => high += 1,
                                IssueSeverity::Medium => medium += 1,
                                IssueSeverity::Low => low += 1,
                            }
                        }
                        
                        // Count occurrences of each (file, pattern_id) pair
                        let mut pattern_counts: std::collections::HashMap<(String, String), usize> =
                            std::collections::HashMap::new();
                        for i in &filtered {
                            let file_path = file_path_map.get(&i.file_id)
                                .cloned()
                                .unwrap_or_else(|| format!("file_id:{}", i.file_id))
                                .replace('\\', "/");
                            *pattern_counts.entry((file_path, i.pattern_id.clone())).or_insert(0) += 1;
                        }
                        
                        // Group by file, condense repeated patterns
                        let mut by_file: std::collections::HashMap<String, Vec<serde_json::Value>> =
                            std::collections::HashMap::new();
                        let mut emitted: std::collections::HashSet<(String, String)> =
                            std::collections::HashSet::new();
                        
                        for i in &filtered {
                            let file_path = file_path_map.get(&i.file_id)
                                .cloned()
                                .unwrap_or_else(|| format!("file_id:{}", i.file_id))
                                .replace('\\', "/");
                            let sev = match i.severity {
                                IssueSeverity::High => "high",
                                IssueSeverity::Medium => "medium",
                                IssueSeverity::Low => "low",
                            };
                            let key = (file_path.clone(), i.pattern_id.clone());
                            let count = *pattern_counts.get(&key).unwrap_or(&1);
                            
                            if count > 2 {
                                if !emitted.insert(key) { continue; }
                                by_file.entry(file_path).or_default().push(serde_json::json!({
                                    "pattern_id": i.pattern_id,
                                    "severity": sev,
                                    "count": count,
                                    "sample_line": i.line,
                                    "message": i.message,
                                    "category": i.category,
                                }));
                            } else {
                                let mut obj = serde_json::json!({
                                    "pattern_id": i.pattern_id,
                                    "severity": sev,
                                    "line": i.line,
                                    "message": i.message,
                                    "category": i.category,
                                });
                                if let Some(el) = i.end_line {
                                    obj["end_line"] = serde_json::json!(el);
                                }
                                by_file.entry(file_path).or_default().push(obj);
                            }
                        }
                        
                        let applied_limit = filter.limit.unwrap_or(50);
                        let applied_offset = filter.offset.unwrap_or(0);
                        let returned = filtered.len() as u32;
                        let returned_u64 = u64::from(returned);
                        let offset_u64 = u64::from(applied_offset);
                        let has_more = offset_u64.saturating_add(returned_u64) < matching_total;
                        let mut result = serde_json::json!({
                            "issues": by_file,
                            "summary": {
                                "total": filtered.len(),
                                "matching_total": matching_total,
                                "high": high,
                                "medium": medium,
                                "low": low
                            },
                            "pagination": {
                                "returned": returned,
                                "limit": applied_limit,
                                "offset": applied_offset,
                                "has_more": has_more
                            },
                            "_next": "summary.matching_total is the full matching row count; summary.total is this page. Use limit/offset to paginate, q: e1 change.edit file_path:... line_edits:[...] to fix, q: s1 search.issues mark_noise:true ... to suppress"
                        });
                        if filtered.is_empty() {
                            result["_hint"] = serde_json::json!(
                                "No issues found. Possible causes: (1) files not indexed â€” run manage({action:'scan'}), \
                                 (2) parse failures for this language â€” use detect_patterns for live detection, \
                                 (3) patterns may not cover this code style. Try: detect_patterns({file_paths:[...]}) or ast_query."
                            );
                        }
                        Ok(result)
                    }
                    Err(e) => {
                        Ok(serde_json::json!({
                            "error": e.to_string(),
                            "issues": [],
                            "summary": { "total": 0, "matching_total": 0, "high": 0, "medium": 0, "low": 0 }
                        }))
                    }
                }
            }
            "detect_patterns" => {
                // Run pattern detection on specified files
                let file_paths: Vec<String> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                let pattern_ids: Option<Vec<String>> = params
                    .get("patterns")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect()
                    });
                
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32)
                    .unwrap_or(100);
                
                let verbose = params
                    .get("verbose")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                let mut diagnostics: Vec<serde_json::Value> = Vec::new();
                
                // Query issues, collecting from each file path separately
                // (file_pattern is a single LIKE, so we query per-path and merge)
                let issues = if file_paths.is_empty() {
                    let mut filter = atls_core::query::IssueFilterOptions::default();
                    filter.limit = Some(limit);
                    match project.query().find_issues(&filter) {
                        Ok(i) => i,
                        Err(e) => return Err(format!("Failed to detect patterns: {}", e))
                    }
                } else {
                    let mut all_issues = Vec::new();
                    for fp in &file_paths {
                        let mut filter = atls_core::query::IssueFilterOptions::default();
                        filter.limit = Some(limit);
                        let clean = fp.replace('\\', "/");
                        let clean = clean.strip_prefix(r"\\?\").unwrap_or(&clean);
                        let normalized = to_relative_path(project_root, clean);
                        let fwd_pattern = if normalized.ends_with('/') {
                            format!("{}%", normalized)
                        } else {
                            format!("%{}", normalized)
                        };
                        let bwd_pattern = if normalized.ends_with('/') {
                            format!("{}%", normalized.replace('/', "\\"))
                        } else {
                            format!("%{}", normalized.replace('/', "\\"))
                        };
                        filter.file_patterns = Some(vec![fwd_pattern, bwd_pattern]);
                        match project.query().find_issues(&filter) {
                            Ok(mut i) => all_issues.append(&mut i),
                            Err(e) => return Err(format!("Failed to detect patterns: {}", e))
                        }
                    }
                    all_issues
                };
                
                // Filter by pattern IDs if specified
                let filtered_issues: Vec<_> = if let Some(ref id_list) = pattern_ids {
                    issues.into_iter()
                        .filter(|i| id_list.iter().any(|p| 
                            i.pattern_id.contains(p) || p.contains(&i.pattern_id)
                        ))
                        .collect()
                } else {
                    issues
                };
                
                // Batch resolve file IDs to paths (avoids N+1 queries)
                let issue_file_ids: std::collections::HashSet<i64> = filtered_issues.iter().map(|i| i.file_id).collect();
                let issue_file_map: std::collections::HashMap<i64, String> = if !issue_file_ids.is_empty() {
                    let conn = project.db().conn();
                    let placeholders = issue_file_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let sql = format!("SELECT id, path FROM files WHERE id IN ({})", placeholders);
                    let mut stmt = conn.prepare(&sql).unwrap_or_else(|_| panic!("Failed to prepare"));
                    let id_params: Vec<Box<dyn rusqlite::types::ToSql>> = issue_file_ids.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>).collect();
                    let rows = stmt.query_map(rusqlite::params_from_iter(id_params.iter().map(|b| b.as_ref())), |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    }).unwrap_or_else(|_| panic!("Failed to query"));
                    rows.filter_map(|r| r.ok()).collect()
                } else {
                    std::collections::HashMap::new()
                };

                // Group by pattern with condensed format for repeated issues
                let mut by_pattern: std::collections::HashMap<String, Vec<serde_json::Value>> = 
                    std::collections::HashMap::new();

                // Count occurrences of each (pattern, file) pair for condensing
                let mut pattern_file_counts: std::collections::HashMap<(String, i64), usize> = std::collections::HashMap::new();
                for issue in &filtered_issues {
                    *pattern_file_counts.entry((issue.pattern_id.clone(), issue.file_id)).or_insert(0) += 1;
                }

                let mut condensed_emitted: std::collections::HashSet<(String, i64)> = std::collections::HashSet::new();
                for issue in &filtered_issues {
                    let file_path = issue_file_map.get(&issue.file_id).cloned()
                        .unwrap_or_else(|| format!("file_id:{}", issue.file_id));
                    let pf_key = (issue.pattern_id.clone(), issue.file_id);
                    let count = *pattern_file_counts.get(&pf_key).unwrap_or(&1);

                    let entry = by_pattern.entry(issue.pattern_id.clone()).or_default();
                    if count > 2 {
                        if !condensed_emitted.insert(pf_key) { continue; }
                        entry.push(serde_json::json!({
                            "file": file_path,
                            "count": count,
                            "sample_line": issue.line,
                            "severity": format!("{:?}", issue.severity).to_lowercase(),
                            "category": issue.category
                        }));
                    } else {
                        let mut obj = serde_json::json!({
                            "file": file_path,
                            "line": issue.line,
                            "message": issue.message,
                            "severity": format!("{:?}", issue.severity).to_lowercase(),
                            "category": issue.category
                        });
                        if let Some(el) = issue.end_line {
                            obj["end_line"] = serde_json::json!(el);
                        }
                        entry.push(obj);
                    }
                }

                // Live detection fallback: if no stored issues found and file_paths given,
                // run tree-sitter detection directly against the files on disk.
                // Also runs unconditionally when verbose=true to provide diagnostics.
                if (by_pattern.is_empty() && !file_paths.is_empty()) || verbose {
                    use atls_core::detector::TreeSitterDetector;
                    let detector_reg = project.detector().lock().await;
                    let parser_reg = project.parser_registry();

                    // Resolve which files to scan (expand directories)
                    let mut resolved_files: Vec<(std::path::PathBuf, atls_core::types::Language)> = Vec::new();
                    for fp in &file_paths {
                        let full = project_root.join(fp);
                        if full.is_dir() {
                            if let Ok(entries) = std::fs::read_dir(&full) {
                                for entry in entries.flatten() {
                                    let p = entry.path();
                                    if p.is_file() {
                                        let lang = atls_core::types::Language::from_extension(
                                            p.extension().and_then(|e| e.to_str()).unwrap_or("")
                                        );
                                        if lang != atls_core::types::Language::Unknown {
                                            resolved_files.push((p, lang));
                                        }
                                    }
                                }
                                for entry in std::fs::read_dir(&full).into_iter().flatten().flatten() {
                                    let sub = entry.path();
                                    if sub.is_dir() {
                                        if let Ok(sub_entries) = std::fs::read_dir(&sub) {
                                            for se in sub_entries.flatten() {
                                                let p = se.path();
                                                if p.is_file() {
                                                    let lang = atls_core::types::Language::from_extension(
                                                        p.extension().and_then(|e| e.to_str()).unwrap_or("")
                                                    );
                                                    if lang != atls_core::types::Language::Unknown {
                                                        resolved_files.push((p, lang));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else if full.is_file() {
                            let lang = atls_core::types::Language::from_extension(
                                full.extension().and_then(|e| e.to_str()).unwrap_or("")
                            );
                            if lang != atls_core::types::Language::Unknown {
                                resolved_files.push((full, lang));
                            }
                        }
                    }

                    if verbose {
                        diagnostics.push(serde_json::json!({
                            "phase": "file_resolution",
                            "files_resolved": resolved_files.len(),
                            "languages": resolved_files.iter()
                                .map(|(_, l)| format!("{:?}", l))
                                .collect::<std::collections::HashSet<_>>()
                                .into_iter().collect::<Vec<_>>()
                        }));
                    }

                    let mut live_total: usize = 0;
                    for (file_path, lang) in &resolved_files {
                        if live_total >= limit as usize { break; }
                        let content = match std::fs::read_to_string(file_path) {
                            Ok(c) => c,
                            Err(e) => {
                                if verbose {
                                    diagnostics.push(serde_json::json!({
                                        "phase": "read_error",
                                        "file": file_path.to_string_lossy(),
                                        "error": e.to_string()
                                    }));
                                }
                                continue;
                            },
                        };
                        // Preprocess C/C++ files to strip macros before parsing
                        let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                        let parse_content = if atls_core::preprocess::is_c_family(ext) {
                            atls_core::preprocess::preprocess_c_macros(&content, Some(&file_path.to_string_lossy()))
                                .unwrap_or(content.clone())
                        } else {
                            content.clone()
                        };
                        let tree = match parser_reg.parse(*lang, &parse_content) {
                            Ok(t) => t,
                            Err(e) => {
                                if verbose {
                                    diagnostics.push(serde_json::json!({
                                        "phase": "parse_error",
                                        "file": file_path.to_string_lossy(),
                                        "error": format!("{:?}", e)
                                    }));
                                }
                                continue;
                            },
                        };
                        let patterns = detector_reg.get_patterns_for_language(*lang);
                        
                        if verbose {
                            let rel = file_path.strip_prefix(project_root)
                                .unwrap_or(file_path).to_string_lossy().replace('\\', "/");
                            let pattern_ids_for_lang: Vec<String> = patterns.iter()
                                .map(|p| p.id.clone())
                                .collect();
                            let has_ts_query: Vec<String> = patterns.iter()
                                .filter(|p| p.structural_hints.as_ref()
                                    .map(|h| h.tree_sitter_query.is_some()).unwrap_or(false))
                                .map(|p| p.id.clone())
                                .collect();
                            diagnostics.push(serde_json::json!({
                                "phase": "scan",
                                "file": rel,
                                "language": format!("{:?}", lang),
                                "patterns_available": pattern_ids_for_lang.len(),
                                "patterns_with_ts_query": has_ts_query.len(),
                                "pattern_ids": pattern_ids_for_lang,
                                "ts_query_ids": has_ts_query,
                                "file_lines": content.lines().count()
                            }));
                        }
                        
                        for pattern in patterns {
                            if live_total >= limit as usize { break; }
                            if let Some(ref hints) = pattern.structural_hints {
                                if hints.tree_sitter_query.is_some() {
                                    if let Some(ref id_list) = pattern_ids {
                                        if !id_list.iter().any(|p| pattern.id.contains(p) || p.contains(&pattern.id)) {
                                            continue;
                                        }
                                    }
                                    let detector = TreeSitterDetector::new(pattern.clone(), *lang);
                                    match detector.detect(&content, &tree) {
                                        Ok(detected) => {
                                            let rel_path = file_path.strip_prefix(project_root)
                                                .unwrap_or(file_path)
                                                .to_string_lossy()
                                                .replace('\\', "/");
                                            if verbose && detected.is_empty() {
                                                diagnostics.push(serde_json::json!({
                                                    "phase": "no_match",
                                                    "pattern_id": pattern.id,
                                                    "file": &rel_path,
                                                    "reason": "tree-sitter query matched 0 nodes"
                                                }));
                                            }
                                            for d in detected {
                                                let entry = by_pattern.entry(pattern.id.clone()).or_default();
                                                let mut obj = serde_json::json!({
                                                    "file": rel_path,
                                                    "line": d.line,
                                                    "message": d.message,
                                                    "severity": format!("{:?}", pattern.severity).to_lowercase(),
                                                    "category": &pattern.category
                                                });
                                                if let Some(el) = d.end_line {
                                                    obj["end_line"] = serde_json::json!(el);
                                                }
                                                entry.push(obj);
                                                live_total += 1;
                                                if live_total >= limit as usize { break; }
                                            }
                                        }
                                        Err(e) => {
                                            if verbose {
                                                diagnostics.push(serde_json::json!({
                                                    "phase": "detection_error",
                                                    "pattern_id": pattern.id,
                                                    "file": file_path.to_string_lossy(),
                                                    "error": format!("{:?}", e)
                                                }));
                                            }
                                        }
                                    }
                                } else if verbose {
                                    diagnostics.push(serde_json::json!({
                                        "phase": "skipped",
                                        "pattern_id": pattern.id,
                                        "reason": "no tree_sitter_query in structural_hints"
                                    }));
                                }
                            } else if verbose {
                                diagnostics.push(serde_json::json!({
                                    "phase": "skipped",
                                    "pattern_id": pattern.id,
                                    "reason": "no structural_hints defined"
                                }));
                            }
                        }
                    }
                }
                
                // Build results
                let mut results: Vec<serde_json::Value> = Vec::new();
                let mut total_matches: usize = 0;
                for (pattern_id, matches) in &by_pattern {
                    total_matches += matches.len();
                    results.push(serde_json::json!({
                        "pattern_id": pattern_id,
                        "count": matches.len(),
                        "matches": matches
                    }));
                }
                
                // Sort by count descending
                results.sort_by(|a, b| {
                    let count_a = a.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
                    let count_b = b.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
                    count_b.cmp(&count_a)
                });
                
                let ran_live_detection = (by_pattern.is_empty() && !file_paths.is_empty()) || verbose;

                let mut response = serde_json::json!({
                    "patterns": results,
                    "total_matches": total_matches,
                    "patterns_found": results.len(),
                    "_next": if total_matches == 0 {
                        "No patterns matched. Use verbose:true to see diagnostic info (which patterns were loaded, why they didn't match)."
                    } else {
                        "Use mark_finding_as_noise to suppress false positives"
                    }
                });

                if !file_paths.is_empty() {
                    response.as_object_mut().unwrap().insert(
                        "checked".to_string(),
                        serde_json::json!({
                            "files_requested": file_paths.len(),
                            "db_issues_found": filtered_issues.len(),
                            "live_fallback_ran": ran_live_detection,
                        }),
                    );
                }
                if total_matches == 0 && !file_paths.is_empty() {
                    response["_hint"] = serde_json::json!(
                        "No patterns matched. Possible causes: (1) C files may fail to parse (C uses C++ parser), \
                         (2) pattern queries may not compile for this language. Use verbose:true for diagnostics."
                    );
                }

                if verbose {
                    response.as_object_mut().unwrap().insert(
                        "diagnostics".to_string(),
                        serde_json::json!(diagnostics),
                    );
                }
                Ok(response)
            }
            "ast_query" => {
                // Query code by structural patterns
                // Simplified DSL: "KIND where CONDITION"
                // Examples: "function where complexity > 10", "function where name contains 'handle'"
                // syntax:"raw" bypasses the DSL parser and uses the query as a raw SQL WHERE clause
                let query = params
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or("query required for ast_query")?;
                
                let syntax = params
                    .get("syntax")
                    .and_then(|v| v.as_str())
                    .unwrap_or("natural");
                
                let file_paths: Option<Vec<String>> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect()
                    });
                
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .unwrap_or(50);
                
                let include_snippet = params
                    .get("include_snippet")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                // Build file filter
                let file_filter = if let Some(ref paths) = file_paths {
                    let patterns: Vec<String> = paths.iter()
                        .map(|p| format!("f.path LIKE '%{}%'", p.replace('\\', "/")))
                        .collect();
                    if patterns.is_empty() {
                        "1=1".to_string()
                    } else {
                        format!("({})", patterns.join(" OR "))
                    }
                } else {
                    "1=1".to_string()
                };
                
                let (kind_sql_owned, condition_sql) = if syntax == "raw" {
                    // Raw mode: reject DDL/DML keywords for safety
                    let q_upper = query.to_uppercase();
                    if ["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE", "ATTACH"]
                        .iter().any(|kw| q_upper.contains(kw)) {
                        return Err("Raw SQL contains disallowed keyword".to_string());
                    }
                    ("1=1".to_string(), query.to_string())
                } else {
                    let query_lower = query.to_lowercase();
                    let parts: Vec<&str> = query_lower.split(" where ").collect();
                    let kind_filter = parts.first().map(|s| s.trim()).unwrap_or("");
                    let condition = parts.get(1).map(|s| *s).unwrap_or("");
                    let kind_sql = match kind_filter {
                        "function" | "fn" => "kind IN ('function', 'method', 'arrow_function')".to_string(),
                        "class" => "kind = 'class'".to_string(),
                        "interface" => "kind = 'interface'".to_string(),
                        "method" => "kind = 'method'".to_string(),
                        "variable" | "var" | "const" | "let" => "kind IN ('variable', 'constant')".to_string(),
                        "struct" => "kind = 'struct'".to_string(),
                        "enum" => "kind = 'enum'".to_string(),
                        "trait" | "impl" => format!("kind = '{}'", kind_filter),
                        "*" | "any" | "" => "1=1".to_string(),
                        other => format!("kind = '{}'", other.replace('\'', "''")),
                    };
                    (kind_sql, parse_ast_condition(condition))
                };
                
                // Execute query (pure DB -- no disk I/O)
                let conn = project.db().conn();
                let sql = format!(
                    "SELECT s.name, f.path, s.line, s.kind, s.complexity, s.signature, s.metadata, s.end_line
                     FROM symbols s
                     JOIN files f ON s.file_id = f.id
                     WHERE {} AND {} AND {}
                     ORDER BY s.complexity DESC NULLS LAST, s.line
                     LIMIT {}",
                    kind_sql_owned, condition_sql, file_filter, limit
                );
                
                let mut stmt = match conn.prepare(&sql) {
                    Ok(s) => s,
                    Err(e) => return Err(format!("Query error: {}", e))
                };
                
                let rows = match stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<i32>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<u32>>(7)?,
                    ))
                }) {
                    Ok(r) => r,
                    Err(e) => return Err(format!("Query execution error: {}", e))
                };
                
                let mut results: Vec<serde_json::Value> = Vec::new();
                let mut seen = std::collections::HashSet::new();
                for row in rows {
                    match row {
                        Ok((name, file, line, kind, complexity, signature, metadata, db_end_line)) => {
                            if !seen.insert((file.clone(), line)) {
                                continue;
                            }

                            let mut result = serde_json::json!({
                                "name": name,
                                "file": file,
                                "line": line,
                                "kind": kind,
                                "complexity": complexity
                            });
                            
                            if let Some(ref sig) = signature {
                                result["signature"] = serde_json::json!(sig);
                            }

                            if let Some(el) = db_end_line {
                                result["end_line"] = serde_json::json!(el);
                                result["lines"] = serde_json::json!(el - line + 1);
                            }
                            
                            if let Some(meta_str) = &metadata {
                                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(meta_str) {
                                    if db_end_line.is_none() {
                                        if let Some(end_line) = meta.get("endLine").and_then(|v| v.as_u64()) {
                                            result["end_line"] = serde_json::json!(end_line);
                                            result["lines"] = serde_json::json!(end_line as u32 - line + 1);
                                        }
                                    }
                                    if let Some(has_await) = meta.get("hasAwait") {
                                        result["has_await"] = has_await.clone();
                                    }
                                    if let Some(has_try) = meta.get("hasTryCatch") {
                                        result["has_try_catch"] = has_try.clone();
                                    }
                                }
                            }
                            
                            if include_snippet {
                                if let Some(ref sig) = signature {
                                    result["snippet"] = serde_json::json!(sig);
                                }
                            }
                            
                            results.push(result);
                        }
                        Err(_) => continue
                    }
                }
                
                Ok(serde_json::json!({
                    "query": query,
                    "results": results,
                    "count": results.len(),
                    "syntax_used": syntax,
                    "_help": "DSL: KIND where CONDITION. Conditions: complexity>N, lines>N, params>N, name contains 'X', name starts_with 'X', has_await, is_async, is_exported. Use syntax:'raw' for direct SQL WHERE clause."
                }))
            }
            "extract_plan" => {
                let file_paths: Vec<String> = if let Some(arr) = params.get("file_paths").and_then(|v| v.as_array()) {
                    arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
                } else {
                    let fp = params.get("file_path")
                        .or_else(|| params.get("source_file"))
                        .and_then(|v| v.as_str())
                        .ok_or("file_path or file_paths required for extract_plan")?;
                    vec![fp.to_string()]
                };
                if file_paths.is_empty() {
                    return Err("file_path or file_paths required for extract_plan".to_string());
                }
                let is_batch = file_paths.len() > 1;
                let mut batch_results: Vec<serde_json::Value> = Vec::new();

                for file_path_owned in &file_paths {
                let file_path: &str = file_path_owned.as_str();
                let strategy = params
                    .get("strategy")
                    .and_then(|v| v.as_str())
                    .unwrap_or("by_cluster");
                let min_lines = params
                    .get("min_lines")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32);
                let min_complexity = params
                    .get("min_complexity")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32);

                let relative_path = file_path.replace('\\', "/");

                // Always get hub-excluded dep graph for planning
                let dep_graph = project.query().get_file_symbol_deps(&relative_path, None, None, true)
                    .map_err(|e| format!("dep graph failed: {}", e))?;

                let inventory = project.query().get_method_inventory(
                    &[relative_path.clone()], min_lines, min_complexity, None,
                ).map_err(|e| format!("inventory failed: {}", e))?;

                let clusters = dep_graph["clusters"].as_array().cloned().unwrap_or_default();
                let hubs = dep_graph["hubs"].as_array().cloned().unwrap_or_default();
                let edges: std::collections::HashSet<(String, String)> = dep_graph["edges"].as_array()
                    .map(|arr| arr.iter().filter_map(|e| {
                        let a = e.as_array()?;
                        Some((a.first()?.as_str()?.to_string(), a.get(1)?.as_str()?.to_string()))
                    }).collect())
                    .unwrap_or_default();

                let inv_methods: Vec<&atls_core::query::symbols::MethodInventoryEntry> =
                    inventory.methods.iter().collect();

                // Helper: split identifier into word segments (camelCase, PascalCase, snake_case, kebab-case)
                let split_words = |s: &str| -> Vec<String> {
                    let mut words = Vec::new();
                    let mut current = String::new();
                    for ch in s.chars() {
                        if ch == '_' || ch == '-' {
                            if !current.is_empty() {
                                words.push(std::mem::take(&mut current).to_lowercase());
                            }
                        } else if ch.is_uppercase() && !current.is_empty()
                            && current.chars().last().map_or(false, |c| c.is_lowercase()) {
                            words.push(std::mem::take(&mut current).to_lowercase());
                            current.push(ch);
                        } else {
                            current.push(ch);
                        }
                    }
                    if !current.is_empty() { words.push(current.to_lowercase()); }
                    words
                };

                // Helper: compute module metrics (cohesion, external_deps, risk, lines)
                let compute_module_metrics = |syms: &[String]| -> (u32, f64, Vec<String>, &'static str) {
                    let total_lines: u32 = syms.iter()
                        .filter_map(|s| inv_methods.iter().find(|m| m.name == *s).map(|m| m.lines))
                        .sum();
                    let sym_set: std::collections::HashSet<&str> = syms.iter().map(|s| s.as_str()).collect();
                    let internal_edges = edges.iter()
                        .filter(|(f, t)| sym_set.contains(f.as_str()) && sym_set.contains(t.as_str()))
                        .count();
                    let max_edges = syms.len() * syms.len().saturating_sub(1);
                    let cohesion = if max_edges > 0 { internal_edges as f64 / max_edges as f64 } else { 0.0 };
                    let external_deps: Vec<String> = syms.iter()
                        .flat_map(|s| {
                            let s = s.clone();
                            edges.iter()
                                .filter(move |(from, _)| *from == s)
                                .map(|(_, to)| to.clone())
                                .filter(|to| !sym_set.contains(to.as_str()))
                        })
                        .collect::<std::collections::HashSet<_>>()
                        .into_iter().collect();
                    let risk = if external_deps.len() > 10 { "high" }
                        else if external_deps.len() > 3 { "medium" }
                        else { "low" };
                    (total_lines, cohesion, external_deps, risk)
                };

                let source_ext = std::path::Path::new(file_path)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("rs");
                let mut proposed_modules: Vec<serde_json::Value> = Vec::new();
                let mut assigned: std::collections::HashSet<String> = std::collections::HashSet::new();
                let mut warnings: Vec<String> = Vec::new();

                match strategy {
                    "by_cluster" => {
                        for (i, cluster) in clusters.iter().enumerate() {
                            let syms: Vec<String> = cluster["symbols"].as_array()
                                .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                                .unwrap_or_default();
                            if syms.is_empty() { continue; }
                            let module_name = find_common_prefix(&syms)
                                .unwrap_or_else(|| format!("module_{}", i));
                            let target = format!("src/{}.{}", module_name, source_ext);
                            let cohesion = cluster["cohesion"].as_f64().unwrap_or(0.0);
                            let (total_lines, _, external_deps, risk) = compute_module_metrics(&syms);
                            proposed_modules.push(serde_json::json!({
                                "target": target,
                                "symbols": syms,
                                "lines": total_lines,
                                "cohesion": cohesion,
                                "external_deps": external_deps,
                                "risk": risk,
                            }));
                            for s in &syms { assigned.insert(s.clone()); }
                        }

                        // Detect single-blob pattern even after hub exclusion
                        let largest_cluster_ratio = proposed_modules.first()
                            .and_then(|m| m["symbols"].as_array())
                            .map(|a| a.len() as f64 / inv_methods.len().max(1) as f64)
                            .unwrap_or(0.0);
                        if proposed_modules.len() <= 2 && largest_cluster_ratio > 0.7 {
                            warnings.push(format!(
                                "Largest cluster contains {:.0}% of symbols. File may still be too interconnected for pure graph clustering. \
                                 Try: strategy:\"by_prefix\" for name-based grouping, or refactor hub functions into smaller helpers first.",
                                largest_cluster_ratio * 100.0
                            ));
                        }
                    }
                    "by_prefix" => {
                        // Multi-segment prefix grouping: try 1, 2, 3-segment prefixes,
                        // prefer longer (more specific) prefixes that group 3+ symbols.
                        let mut prefix_members: std::collections::HashMap<String, Vec<String>> =
                            std::collections::HashMap::new();
                        for method in &inv_methods {
                            let words = split_words(&method.name);
                            let max_prefix_len = words.len().min(3);
                            for len in 1..=max_prefix_len {
                                let prefix = words[..len].join("_");
                                prefix_members.entry(prefix).or_default().push(method.name.clone());
                            }
                        }

                        // Score: longer prefix * sqrt(group_size); minimum 3 members
                        let mut scored: Vec<(String, Vec<String>, f64)> = prefix_members.into_iter()
                            .filter(|(_, members)| members.len() >= 3)
                            .map(|(prefix, members)| {
                                let segments = prefix.matches('_').count() + 1;
                                let score = segments as f64 * (members.len() as f64).sqrt();
                                (prefix, members, score)
                            })
                            .collect();
                        scored.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

                        // Greedy: highest-specificity prefix first
                        for (prefix, members, _) in scored {
                            let unassigned_members: Vec<String> = members.into_iter()
                                .filter(|m| !assigned.contains(m))
                                .collect();
                            if unassigned_members.len() < 3 { continue; }

                            let (total_lines, cohesion, external_deps, risk) =
                                compute_module_metrics(&unassigned_members);
                            let target = format!("src/{}.{}", prefix, source_ext);
                            proposed_modules.push(serde_json::json!({
                                "target": target,
                                "symbols": unassigned_members,
                                "lines": total_lines,
                                "cohesion": (cohesion * 100.0).round() / 100.0,
                                "external_deps": external_deps,
                                "risk": risk,
                            }));
                            for s in &unassigned_members { assigned.insert(s.clone()); }
                        }

                        // Sort by lines desc for readability
                        proposed_modules.sort_by(|a, b| {
                            b["lines"].as_u64().unwrap_or(0).cmp(&a["lines"].as_u64().unwrap_or(0))
                        });
                    }
                    "by_kind" => {
                        let mut kind_groups: std::collections::HashMap<String, Vec<String>> =
                            std::collections::HashMap::new();
                        for method in &inv_methods {
                            kind_groups.entry(method.kind.clone()).or_default().push(method.name.clone());
                        }
                        for (kind, syms) in &kind_groups {
                            if syms.len() < 2 { continue; }
                            let (total_lines, cohesion, external_deps, risk) = compute_module_metrics(syms);
                            let target = format!("src/{}s.{}", kind, source_ext);
                            proposed_modules.push(serde_json::json!({
                                "target": target,
                                "symbols": syms,
                                "lines": total_lines,
                                "cohesion": (cohesion * 100.0).round() / 100.0,
                                "external_deps": external_deps,
                                "risk": risk,
                            }));
                            for s in syms { assigned.insert(s.clone()); }
                        }
                    }
                    _ => {
                        return Err(format!("Unknown strategy: {}. Use: by_cluster, by_prefix, by_kind", strategy));
                    }
                }

                let unassigned: Vec<String> = inv_methods.iter()
                    .filter(|m| !assigned.contains(&m.name))
                    .map(|m| m.name.clone())
                    .collect();

                let mut response = serde_json::json!({
                    "source": file_path,
                    "strategy": strategy,
                    "proposed_modules": proposed_modules,
                    "unassigned": unassigned,
                    "stats": {
                        "total_symbols": inv_methods.len(),
                        "assigned": assigned.len(),
                        "unassigned": unassigned.len(),
                        "modules": proposed_modules.len(),
                    },
                    "_next": "To execute: q: r1 change.refactor action:extract file_paths:<source> ... dry_run:true (see change.refactor for extractions / target modules)"
                });

                if !hubs.is_empty() {
                    response["hubs"] = serde_json::json!(hubs);
                    response["_hub_note"] = serde_json::json!(format!(
                        "{} hub(s) detected and excluded from clustering. Consider refactoring these into smaller helpers before clustering.",
                        hubs.len()
                    ));
                }
                if !warnings.is_empty() {
                    response["warnings"] = serde_json::json!(warnings);
                }

                batch_results.push(response);
                } // end for file_path_owned

                if is_batch {
                    Ok(serde_json::json!({ "results": batch_results, "count": batch_results.len() }))
                } else {
                    Ok(batch_results.into_iter().next().unwrap_or(serde_json::json!({})))
                }
            }
            "split_module" => {
                // Split a monolithic file into a directory module structure.
                // Accepts a plan mapping symbols to child modules, then:
                //   1. Validates all symbols exist in source
                //   2. Creates target_dir/{module}.rs for each plan entry
                //   3. Moves complete symbol bodies to target files
                //   4. Creates target_dir/mod.rs with pub mod + pub use re-exports
                //   5. Adds use super::* imports in child modules
                //   6. Runs lint verification
                let source_file = params
                    .get("source_file")
                    .or_else(|| params.get("file_path"))
                    .and_then(|v| v.as_str())
                    .ok_or("split_module requires 'source_file' (path to the monolithic file)")?;

                let target_dir = params
                    .get("target_dir")
                    .and_then(|v| v.as_str())
                    .ok_or("split_module requires 'target_dir' (directory for the new module structure)")?;

                let plan = params
                    .get("plan")
                    .and_then(|v| v.as_array())
                    .ok_or("split_module requires 'plan' array: [{module:string, symbols:[string]}]")?;

                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let mod_style = params
                    .get("mod_style")
                    .and_then(|v| v.as_str())
                    .unwrap_or("mod_rs");

                // Parse the plan entries
                struct SplitEntry {
                    module_name: String,
                    symbols: Vec<String>,
                }
                let mut entries: Vec<SplitEntry> = Vec::new();
                for (i, entry) in plan.iter().enumerate() {
                    let module_name = entry.get("module")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| format!("plan[{}] requires 'module' (module name)", i))?
                        .to_string();
                    let symbols: Vec<String> = entry.get("symbols")
                        .and_then(|v| v.as_array())
                        .ok_or_else(|| format!("plan[{}] requires 'symbols' array", i))?
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                    if symbols.is_empty() {
                        return Err(format!("plan[{}] has empty symbols array", i));
                    }
                    entries.push(SplitEntry { module_name, symbols });
                }

                // Resolve source file
                let (resolved_source, resolved_file_path) = match resolve_source_file_with_workspace_hint(project_root, source_file, &workspace_rel_paths) {
                    Some((path, rel)) => (path, rel),
                    None => return Err(format!("Source file not found: {}", source_file)),
                };
                let source_content = std::fs::read_to_string(&resolved_source)
                    .map_err(|e| format!("Failed to read source file: {}", e))?;

                let source_lang = atls_core::Language::from_extension(
                    resolved_source.extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                );
                let is_rust = matches!(source_lang, atls_core::Language::Rust);
                let is_python = matches!(source_lang, atls_core::Language::Python);
                let child_ext = if is_python { "py" } else if is_rust { "rs" } else {
                    resolved_source.extension().and_then(|s| s.to_str()).unwrap_or("rs")
                };

                // Validate all symbols exist and collect their content + ranges
                struct ResolvedSymbol {
                    name: String,
                    content: String,
                    #[allow(dead_code)] start_line: u32,
                    #[allow(dead_code)] end_line: u32,
                }
                let mut module_results: Vec<serde_json::Value> = Vec::new();
                let mut all_resolved: Vec<(String, Vec<ResolvedSymbol>)> = Vec::new();
                let mut all_ranges: Vec<(u32, u32)> = Vec::new();

                for entry in &entries {
                    let mut resolved_symbols: Vec<ResolvedSymbol> = Vec::new();
                    for sym_name in &entry.symbols {
                        // Try tree-sitter first for Rust, then symbol DB, then regex
                        let range_result = if is_rust {
                            find_symbol_by_parsing(&source_content, sym_name, source_lang, project.parser_registry())
                        } else {
                            None
                        };

                        let (start, end) = if let Some((s, e, _, _)) = range_result {
                            (s, e)
                        } else if let Ok(Some(r)) = project.query().get_symbol_line_range(&resolved_file_path, sym_name) {
                            (r.start_line, r.end_line)
                        } else {
                            // Regex fallback
                            match shape_ops::resolve_symbol_anchor_lines_lang(
                                &source_content, Some("fn"), sym_name,
                                if is_rust { Some("rust") } else { None },
                            ) {
                                Ok((s, e)) => (s, e),
                                Err(_) => {
                                    module_results.push(serde_json::json!({
                                        "module": entry.module_name,
                                        "symbol": sym_name,
                                        "status": "not_found",
                                    }));
                                    continue;
                                }
                            }
                        };

                        let lines: Vec<&str> = source_content.lines().collect();
                        let s_idx = (start as usize).saturating_sub(1).min(lines.len());
                        let e_idx = (end as usize).min(lines.len());
                        let content = if s_idx < e_idx {
                            lines[s_idx..e_idx].join("\n")
                        } else {
                            String::new()
                        };

                        if content.is_empty() {
                            module_results.push(serde_json::json!({
                                "module": entry.module_name,
                                "symbol": sym_name,
                                "status": "empty_content",
                            }));
                            continue;
                        }

                        all_ranges.push((start, end));
                        resolved_symbols.push(ResolvedSymbol {
                            name: sym_name.clone(),
                            content,
                            start_line: start,
                            end_line: end,
                        });
                    }
                    all_resolved.push((entry.module_name.clone(), resolved_symbols));
                }

                // Build the target directory path
                let target_dir_path = resolve_project_path(project_root, target_dir);

                // Collect module file info for the response
                let mut created_files: Vec<serde_json::Value> = Vec::new();
                let mut mod_declarations: Vec<String> = Vec::new();
                let mut pub_use_lines: Vec<String> = Vec::new();

                for (module_name, symbols) in &all_resolved {
                    if symbols.is_empty() { continue; }

                    let module_file = format!("{}/{}.{}", target_dir, module_name, child_ext);

                    let mut module_content = String::new();
                    if is_rust {
                        module_content.push_str("use super::*;\n\n");
                    }
                    for (i, sym) in symbols.iter().enumerate() {
                        if i > 0 { module_content.push_str("\n\n"); }
                        module_content.push_str(&sym.content);
                    }
                    module_content.push('\n');

                    if is_python {
                        mod_declarations.push(format!("from .{} import *", module_name));
                    } else {
                        mod_declarations.push(format!("pub mod {};", module_name));
                    }
                    for sym in symbols {
                        if !is_python {
                            pub_use_lines.push(format!("pub use {}::{};", module_name, sym.name));
                        }
                    }

                    let module_file_path = resolve_project_path(project_root, &module_file);
                    created_files.push(serde_json::json!({
                        "file": module_file,
                        "symbols": symbols.iter().map(|s| &s.name).collect::<Vec<_>>(),
                        "lines": symbols.len(),
                    }));

                    if !dry_run {
                        std::fs::create_dir_all(&target_dir_path)
                            .map_err(|e| format!("Failed to create target directory: {}", e))?;
                        let _ = crate::snapshot::atomic_write(&module_file_path, module_content.as_bytes());
                    }
                }

                let mod_rs_path = if is_python {
                    format!("{}/__init__.py", target_dir)
                } else if mod_style == "mod_rs" {
                    format!("{}/mod.rs", target_dir)
                } else {
                    format!("{}.rs", target_dir.trim_end_matches('/'))
                };

                let mut mod_rs_content = String::new();
                for decl in &mod_declarations {
                    mod_rs_content.push_str(decl);
                    mod_rs_content.push('\n');
                }
                if !pub_use_lines.is_empty() {
                    mod_rs_content.push('\n');
                    for line in &pub_use_lines {
                        mod_rs_content.push_str(line);
                        mod_rs_content.push('\n');
                    }
                }

                if !dry_run {
                    let mod_rs_full_path = resolve_project_path(project_root, &mod_rs_path);
                    let _ = crate::snapshot::atomic_write(&mod_rs_full_path, mod_rs_content.as_bytes());

                    // Remove extracted symbols from source file
                    if !all_ranges.is_empty() {
                        let mut ranges = all_ranges.clone();
                        ranges.sort_by(|a, b| b.0.cmp(&a.0)); // reverse order for safe removal
                        ranges.dedup();
                        let mut lines: Vec<String> = source_content.lines().map(|l| l.to_string()).collect();
                        for (start, end) in &ranges {
                            let s = (*start as usize).saturating_sub(1).min(lines.len());
                            let e = (*end as usize).min(lines.len());
                            if s < e {
                                lines.drain(s..e);
                            }
                        }
                        // Remove consecutive blank lines left by extraction
                        let mut cleaned: Vec<String> = Vec::new();
                        let mut prev_blank = false;
                        for line in &lines {
                            let is_blank = line.trim().is_empty();
                            if is_blank && prev_blank { continue; }
                            cleaned.push(line.clone());
                            prev_blank = is_blank;
                        }
                        let new_source = cleaned.join("\n");
                        let _ = crate::snapshot::atomic_write(&resolved_source, new_source.as_bytes());
                    }
                }

                // Lint verification (non-blocking)
                let mut lint_results: Vec<serde_json::Value> = Vec::new();
                if !dry_run {
                    let mut files_to_lint: Vec<String> = created_files.iter()
                        .filter_map(|f| f.get("file").and_then(|v| v.as_str()).map(|s| s.to_string()))
                        .collect();
                    files_to_lint.push(mod_rs_path.clone());
                    files_to_lint.push(resolved_file_path.to_string());

                    let (results, _) = lint_written_files_with_options(
                        project_root,
                        &files_to_lint,
                        true,
                        false,
                    );
                    for r in &results {
                        if r.severity == "error" {
                            lint_results.push(serde_json::json!({
                                "file": r.file,
                                "line": r.line,
                                "severity": r.severity,
                                "message": r.message,
                            }));
                        }
                    }
                }

                let total_symbols: usize = all_resolved.iter().map(|(_, syms)| syms.len()).sum();
                Ok(serde_json::json!({
                    "source_file": source_file,
                    "target_dir": target_dir,
                    "mod_rs": mod_rs_path,
                    "mod_style": mod_style,
                    "dry_run": dry_run,
                    "modules": created_files,
                    "mod_rs_content": mod_rs_content,
                    "stats": {
                        "total_modules": all_resolved.iter().filter(|(_, s)| !s.is_empty()).count(),
                        "total_symbols": total_symbols,
                        "total_ranges_removed": all_ranges.len(),
                    },
                    "lint_errors": lint_results,
                    "validation_issues": module_results,
                    "_next": if dry_run {
                        "Review the split plan. Set dry_run:false to execute."
                    } else if !lint_results.is_empty() {
                        "Split complete with lint errors. Fix errors and run verify."
                    } else {
                        "Split complete. Run q: v1 verify.typecheck to validate."
                    }
                }))
            }
            "extract_methods" => {
                // Extract methods from a file to new files (for splitting god objects)
                // Accept: file_path or source_file
                let file_path = params
                    .get("file_path")
                    .or_else(|| params.get("source_file"))
                    .and_then(|v| v.as_str())
                    .ok_or("file_path required for extract_methods (also accepts: source_file)")?;
                
                let extractions = params
                    .get("extractions")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| {
                                let target_file = v.get("target_file")?.as_str()?.to_string();
                                let methods: Vec<String> = v.get("methods")?
                                    .as_array()?
                                    .iter()
                                    .filter_map(|m| m.as_str().map(|s| s.to_string()))
                                    .collect();
                                let class_name = v.get("class_name").and_then(|c| c.as_str()).map(|s| s.to_string());
                                Some((target_file, methods, class_name))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                
                if extractions.is_empty() {
                    return Err("extractions array required. Each extraction needs: target_file, methods[]".to_string());
                }
                
                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                let delegation_style = params
                    .get("delegation_style")
                    .and_then(|v| v.as_str())
                    .unwrap_or("composition");
                
                // When true, continue processing remaining extractions even if one fails lint.
                // Default false: first lint failure stops batch (safe mode).
                let continue_on_lint_error = params
                    .get("continue_on_lint_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                // Optional kind filter for symbol disambiguation (e.g., "function" to prefer
                // functions over variables when names collide)
                let symbol_kind_filter = params
                    .get("symbol_kind")
                    .and_then(|v| v.as_str());

                // Dependency warning threshold for risk classification (informational only).
                // Extractions are never blocked â€” lint + typecheck are the real safety nets.
                let dep_risk_threshold = params
                    .get("dep_risk_threshold")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(10) as usize;

                // Resolve source file with fallback strategies for path mismatches
                let (resolved_source, resolved_file_path) = match resolve_source_file_with_workspace_hint(project_root, file_path, &workspace_rel_paths) {
                    Some((path, rel)) => {
                        (path, rel)
                    },
                    None => return Err(format!(
                        "Source file not found: {}. Tried direct path, common prefixes (src/, lib/), \
                         and recursive search. Verify the file exists in the project.",
                        file_path
                    ))
                };
                let file_path = resolved_file_path.as_str();
                let source_content = match std::fs::read_to_string(&resolved_source) {
                    Ok(c) => c,
                    Err(e) => return Err(format!("Failed to read source file: {}", e))
                };
                let source_lang_for_extract = atls_core::Language::from_extension(
                    std::path::Path::new(file_path)
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                );
                
                // Pre-flight check: validate source file has no syntax errors before extraction.
                // Prevents cascading failures where a broken source leads to broken extractions.
                // Skip for C/C++ where tree-sitter produces excessive false positives from
                // macros, preprocessor directives, and missing system headers.
                {
                    let source_ext = std::path::Path::new(file_path)
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    let source_lang = atls_core::Language::from_extension(source_ext);
                    let skip_preflight = matches!(source_lang,
                        atls_core::Language::C | atls_core::Language::Cpp
                    );
                    if !skip_preflight {
                        let (preflight_results, _) = lint_written_files_with_options(
                            project_root,
                            &[file_path.to_string()],
                            true,  // syntax-only: fast check
                            false, // use tree-sitter for preflight speed
                        );
                        let preflight_errors: Vec<_> = preflight_results.iter()
                            .filter(|r| r.severity == "error")
                            .collect();
                        if !preflight_errors.is_empty() {
                            let error_msgs: Vec<String> = preflight_errors.iter()
                                .take(5)
                                .map(|r| format!("{}:{}: {}", r.file, r.line, r.message))
                                .collect();
                            return Err(format!(
                                "Source file has {} pre-existing error(s). Fix these before extracting:\n{}",
                                preflight_errors.len(),
                                error_msgs.join("\n")
                            ));
                        }
                    }
                }

                // Extract file context (package/namespace + imports) from source
                let file_ctx = extract_file_context(&source_content, file_path, &project);
                
                let mut results: Vec<serde_json::Value> = Vec::new();
                let mut all_extracted_methods: Vec<String> = Vec::new();
                let mut written_target_files: Vec<String> = Vec::new();
                let mut extraction_failed = false;
                // Track (start_line, end_line) 1-indexed ranges extracted from source for post-extraction removal
                let mut source_extraction_ranges: Vec<(u32, u32)> = Vec::new();
                // For trait/impl methods: store delegation stubs keyed by extraction range.
                // Ranges with a stub get their body replaced instead of being removed.
                let mut source_delegation_stubs: std::collections::HashMap<(u32, u32), String> = std::collections::HashMap::new();
                // Track names of methods that got delegation stubs (skip source import for these)
                let mut stubbed_method_names: std::collections::HashSet<String> = std::collections::HashSet::new();
                // Accumulate AST refs from all extractions so we can upgrade
                // visibility of referenced private symbols in the source file.
                let mut all_extraction_ast_refs: std::collections::HashSet<String> = std::collections::HashSet::new();
                
                // Topological sort: build dependency graph for batch extractions
                // so that utility methods are extracted before the methods that call them.
                let original_order: Vec<String> = extractions.iter()
                    .map(|(t, m, _)| format!("{}:{}", t, m.join(",")))
                    .collect();
                let mut was_reordered = false;
                let extractions = if extractions.len() > 1 {
                    let _all_methods_flat: std::collections::HashSet<&str> = extractions.iter()
                        .flat_map(|(_, methods, _)| methods.iter().map(|s| s.as_str()))
                        .collect();

                    // For each extraction, find which methods from OTHER extractions it references
                    let mut deps: Vec<std::collections::HashSet<usize>> = vec![std::collections::HashSet::new(); extractions.len()];
                    for (i, (_, methods_i, _)) in extractions.iter().enumerate() {
                        for method_name in methods_i {
                            if let Ok(Some(range)) = project.query().get_symbol_line_range(file_path, method_name) {
                                let start = (range.start_line as usize).saturating_sub(1);
                                let end = std::cmp::min(range.end_line as usize, source_content.lines().count());
                                let code: String = source_content.lines()
                                    .skip(start)
                                    .take(end - start)
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                for (j, (_, methods_j, _)) in extractions.iter().enumerate() {
                                    if i == j { continue; }
                                    for other_method in methods_j {
                                        if is_identifier_match(&code, other_method) {
                                            deps[i].insert(j);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Topological sort (Kahn's algorithm)
                    let mut in_degree: Vec<usize> = vec![0; extractions.len()];
                    for dep_set in &deps {
                        for &dep in dep_set {
                            in_degree[dep] += 1;
                        }
                    }
                    let mut queue: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
                    for (i, &deg) in in_degree.iter().enumerate() {
                        if deg == 0 { queue.push_back(i); }
                    }
                    let mut sorted_indices: Vec<usize> = Vec::new();
                    while let Some(idx) = queue.pop_front() {
                        sorted_indices.push(idx);
                        for &dep in &deps[idx] {
                            in_degree[dep] -= 1;
                            if in_degree[dep] == 0 {
                                queue.push_back(dep);
                            }
                        }
                    }
                    if sorted_indices.len() < extractions.len() {
                        for i in 0..extractions.len() {
                            if !sorted_indices.contains(&i) {
                                sorted_indices.push(i);
                            }
                        }
                    }
                    sorted_indices.reverse();
                    was_reordered = sorted_indices.iter().enumerate().any(|(pos, &orig)| pos != orig);
                    sorted_indices.iter().map(|&i| extractions[i].clone()).collect::<Vec<_>>()
                } else {
                    extractions
                };
                let sorted_order: Vec<String> = extractions.iter()
                    .map(|(t, m, _)| format!("{}:{}", t, m.join(",")))
                    .collect();

                for (target_file, methods, class_name) in &extractions {
                    // Stop-on-failure: skip remaining extractions if a prior one failed lint
                    // (unless continue_on_lint_error is set)
                    if extraction_failed && !continue_on_lint_error {
                        results.push(serde_json::json!({
                            "target_file": target_file,
                            "status": "skipped",
                            "reason": "prior extraction failed lint check"
                        }));
                        continue;
                    }
                    
                    let mut extracted_code: Vec<String> = Vec::new();
                    let mut extracted_kinds: Vec<String> = Vec::new();
                    let mut method_info: Vec<serde_json::Value> = Vec::new();
                    // Per-method source range (None for cross-file methods)
                    let mut extracted_ranges_per_method: Vec<Option<(u32, u32)>> = Vec::new();
                    // Track whether any extraction used find_export_default_range.
                    // When true, we force standalone output (no class wrapper) regardless
                    // of what `extracted_kinds` contains â€” export default should never be
                    // wrapped in a generated class.
                    let mut used_export_default_range = false;
                    
                    for method_name in methods {
                        // Preflight: if symbol appears only on re-export/import lines, fail early
                        // with clear diagnostic (Fix #3). Index may not have barrel re-exports.
                        if shape_ops::symbol_only_in_reexport_import_lines(&source_content, method_name) {
                            return Err(format!(
                                "Symbol '{}' is re-exported/imported only, not locally defined. Use line-range extraction or define locally first.",
                                method_name
                            ));
                        }
                        // JS/TS "default" extraction: find the `export default` statement
                        // directly from source BEFORE trying the DB. The DB's LIKE fallback
                        // matches partial names (e.g., "default_email_options" for "default"),
                        // which returns the wrong symbol.
                        let is_js_ts = matches!(file_ctx.language,
                            atls_core::Language::JavaScript | atls_core::Language::TypeScript);
                        let js_default_early = if is_js_ts && method_name == "default" {
                            find_export_default_range(&source_content)
                        } else {
                            None
                        };

                        let (range, alt_content) = if let Some(def_range) = js_default_early {
                            used_export_default_range = true;
                            (def_range, None)
                        } else {
                            // Get method line range -- try specified file first, then global search.
                            // Verify the returned name is an exact match to avoid LIKE false positives.
                            match project.query().get_symbol_line_range(file_path, method_name) {
                                Ok(Some(r)) if r.name == *method_name => (r, None),
                                _ => {
                                    // Cross-file fallback with disambiguation (filtered to source language)
                                    let src_exts = source_lang_for_extract.extensions();
                                    let ext_filter = if src_exts.is_empty() { None } else { Some(src_exts) };
                                    match project.query().get_symbol_line_range_global_disambiguated(
                                        method_name,
                                        symbol_kind_filter.or(Some("function")),
                                        Some(5),
                                        ext_filter,
                                    ) {
                                        Ok(candidates) if !candidates.is_empty() && candidates[0].name == *method_name => {
                                            if dry_run && candidates.len() > 1 {
                                                method_info.push(serde_json::json!({
                                                    "method": method_name,
                                                    "ambiguous_candidates": candidates.iter().map(|c| serde_json::json!({
                                                        "file": &c.file,
                                                        "kind": &c.kind,
                                                        "lines": format!("{}-{}", c.start_line, c.end_line),
                                                        "signature": &c.signature
                                                    })).collect::<Vec<_>>()
                                                }));
                                            }
                                            let global_range = candidates.into_iter().next().unwrap();
                                            let alt_path = resolve_project_path(project_root, &global_range.file);
                                            match std::fs::read_to_string(&alt_path) {
                                                Ok(content) => (global_range, Some(content)),
                                                Err(_) => {
                                                    method_info.push(serde_json::json!({
                                                        "method": method_name,
                                                        "status": "not_found"
                                                    }));
                                                    continue;
                                                }
                                            }
                                        }
                                        _ => {
                                            // Tree-sitter fallback: parse the source file
                                            // directly when the symbol DB is stale.
                                            if let Some((start, end, name, kind)) =
                                                find_symbol_by_parsing(
                                                    &source_content,
                                                    method_name,
                                                    source_lang_for_extract,
                                                    project.parser_registry(),
                                                )
                                            {
                                                (atls_core::query::SymbolLineRange {
                                                    name,
                                                    kind,
                                                    file: file_path.to_string(),
                                                    start_line: start,
                                                    end_line: end,
                                                    signature: None,
                                                }, None)
                                            } else {
                                                method_info.push(serde_json::json!({
                                                    "method": method_name,
                                                    "status": "not_found"
                                                }));
                                                continue;
                                            }
                                        }
                                    }
                                }
                            }
                        };
                        
                        // Reject re-export/import-only symbols â€” no local definition to extract
                        let content_for_check: &str = alt_content.as_deref().unwrap_or(source_content.as_str());
                        let first_line = content_for_check.lines()
                            .nth((range.start_line as usize).saturating_sub(1))
                            .unwrap_or("");
                        if shape_ops::is_bodyless_or_reexport_line(first_line) {
                            return Err(format!(
                                "Symbol '{}' is re-exported/imported only, not locally defined. Use line-range extraction or define locally first.",
                                method_name
                            ));
                        }

                        // Extract method code (use alternate file content if method was found cross-file)
                        let content_ref = alt_content.as_deref().unwrap_or(&source_content);
                        let lines: Vec<&str> = content_ref.lines().collect();
                        let start_idx = std::cmp::min((range.start_line as usize).saturating_sub(1), lines.len());
                        let end_idx = std::cmp::min(range.end_line as usize, lines.len());
                        
                        let method_code: String = if start_idx < end_idx {
                            lines[start_idx..end_idx].join("\n")
                        } else {
                            String::new()
                        };
                        extracted_code.push(method_code.clone());
                        extracted_kinds.push(range.kind.clone());
                        all_extracted_methods.push(method_name.clone());
                        // Track range for source removal (only for methods in the source file, not cross-file)
                        if alt_content.is_none() {
                            source_extraction_ranges.push((range.start_line, range.end_line));
                            extracted_ranges_per_method.push(Some((range.start_line, range.end_line)));
                        } else {
                            extracted_ranges_per_method.push(None);
                        }
                        
                        let status_note = if alt_content.is_some() {
                            format!("extracted (found in {})", range.file)
                        } else {
                            "extracted".to_string()
                        };
                        method_info.push(serde_json::json!({
                            "method": method_name,
                            "lines": format!("{}-{}", range.start_line, range.end_line),
                            "status": status_note
                        }));
                    }
                    
                    if extracted_code.is_empty() {
                        results.push(serde_json::json!({
                            "target_file": target_file,
                            "status": "no_methods_found",
                            "methods": method_info
                        }));
                        continue;
                    }
                    
                    // Analyze missing dependencies (types, fields, unexported symbols)
                    let all_extracted_text_for_deps = extracted_code.join("\n");
                    let dep_warnings = analyze_missing_dependencies(
                        &all_extracted_text_for_deps,
                        file_path,
                        &methods.iter().map(|s| s.clone()).collect::<Vec<_>>(),
                        &project,
                        file_ctx.language,
                        Some(project_root),
                    );

                    // â”€â”€ UHPP deps pre-flight â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                    // Run :deps analysis per symbol to detect:
                    //   â€¢ additional imports (types, co-move candidates)
                    //   â€¢ scope nesting (closures that can't be cleanly extracted)
                    //   â€¢ co-move candidates (same-file types/helpers)
                    let lang_str = file_ctx.language.extensions().first().map(|s| *s);
                    let mut uhpp_needed_imports: Vec<String> = Vec::new();
                    let mut uhpp_co_move: Vec<serde_json::Value> = Vec::new();
                    let mut uhpp_scope_warnings: Vec<String> = Vec::new();

                    for method_name in methods {
                        let kind_hint = Some("fn");
                        if let Ok(deps_output) = crate::shape_ops::analyze_symbol_deps(
                            &source_content,
                            kind_hint,
                            method_name,
                            lang_str,
                        ) {
                            // Parse the structured output for imports
                            let mut in_needed = false;
                            let mut in_co_move = false;
                            let mut in_warnings = false;
                            for line in deps_output.lines() {
                                match line.trim() {
                                    "[needed_imports]" => { in_needed = true; in_co_move = false; in_warnings = false; }
                                    "[co_move]" => { in_needed = false; in_co_move = true; in_warnings = false; }
                                    "[scope]" | "[captured]" => { in_needed = false; in_co_move = false; }
                                    "[warnings]" => { in_needed = false; in_co_move = false; in_warnings = true; }
                                    "(none)" => {}
                                    line if in_needed => {
                                        uhpp_needed_imports.push(line.to_string());
                                    }
                                    line if in_co_move => {
                                        let parts: Vec<&str> = line.split('|').collect();
                                        if parts.len() >= 5 {
                                            uhpp_co_move.push(serde_json::json!({
                                                "kind": parts[0],
                                                "name": parts[1],
                                                "start_line": parts[2],
                                                "end_line": parts[3],
                                                "shared": parts[4] == "shared",
                                                "for_method": method_name,
                                            }));
                                        }
                                    }
                                    line if in_warnings && !line.is_empty() => {
                                        uhpp_scope_warnings.push(format!("{}: {}", method_name, line));
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    // Deduplicate UHPP imports
                    {
                        let mut seen = std::collections::HashSet::new();
                        uhpp_needed_imports.retain(|imp| seen.insert(imp.clone()));
                    }

                    // Auto-promote Go unexported symbols if they are the only blockers
                    let mut go_promotions: Vec<(String, String)> = Vec::new();
                    if file_ctx.language == atls_core::Language::Go && !dep_warnings.is_empty() {
                        let unexported: Vec<String> = dep_warnings.iter()
                            .filter(|w| {
                                w.get("issue").and_then(|v| v.as_str())
                                    .map(|s| s.contains("unexported"))
                                    .unwrap_or(false)
                            })
                            .filter_map(|w| w.get("symbol").and_then(|v| v.as_str()).map(|s| s.to_string()))
                            .collect();
                        if !unexported.is_empty() {
                            if dry_run {
                                for s in &unexported {
                                    let new_name = format!("{}{}",
                                        s.chars().next().unwrap().to_uppercase(),
                                        &s[s.chars().next().unwrap().len_utf8()..],
                                    );
                                    go_promotions.push((s.clone(), new_name));
                                }
                            } else {
                                go_promotions = promote_go_symbol_visibility(
                                    &resolved_source, &unexported, project_root,
                                );
                            }
                        }
                    }

                    // Risk classification (informational â€” never blocks extraction)
                    let extraction_risk = if dep_warnings.len() > dep_risk_threshold {
                        "high"
                    } else if !dep_warnings.is_empty() {
                        "medium"
                    } else {
                        "low"
                    };

                    // Generate class wrapper for extracted methods
                    let generated_class_name = class_name.clone().unwrap_or_else(|| {
                        let base = std::path::Path::new(target_file)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("ExtractedMethods");
                        base.split(|c: char| c == '_' || c == '-')
                            .map(|word| {
                                let mut chars = word.chars();
                                match chars.next() {
                                    Some(c) => c.to_uppercase().chain(chars).collect::<String>(),
                                    None => String::new()
                                }
                            })
                            .collect::<String>()
                    });
                    
                    // Determine file extension and language for the target file
                    let target_ext = std::path::Path::new(target_file)
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("ts");
                    
                    // Filter imports to only those referenced by extracted code
                    let all_extracted_text = extracted_code.join("\n");
                    let mut filtered_imports = filter_imports_for_code(
                        &file_ctx.import_lines,
                        &all_extracted_text,
                        file_ctx.language,
                    );
                    // Merge UHPP-detected imports that filter_imports_for_code missed
                    // (e.g., same-file types referenced only via type annotations)
                    for uhpp_imp in &uhpp_needed_imports {
                        let already_present = filtered_imports.iter().any(|fi| {
                            fi.trim() == uhpp_imp.trim()
                        });
                        if !already_present {
                            filtered_imports.push(uhpp_imp.clone());
                        }
                    }
                    // Deduplicate filtered imports (exact-match)
                    {
                        let mut seen = std::collections::HashSet::new();
                        filtered_imports.retain(|line| seen.insert(line.trim().to_string()));
                    }

                    // Rewrite TS/JS relative import paths when target is in a different directory
                    if matches!(file_ctx.language,
                        atls_core::Language::TypeScript | atls_core::Language::JavaScript
                    ) {
                        let source_dir = std::path::Path::new(file_path).parent().unwrap_or(std::path::Path::new(""));
                        let target_dir = std::path::Path::new(target_file).parent().unwrap_or(std::path::Path::new(""));
                        if source_dir != target_dir {
                            filtered_imports = rewrite_ts_import_paths(&filtered_imports, source_dir, target_dir);
                        }
                    }
                    
                    // Check if ALL extracted symbols are standalone top-level declarations
                    // (not class methods that need a wrapper). When true, JS/TS/Python emit
                    // bare exported declarations instead of a generated class wrapper.
                    // Includes functions, classes, interfaces, types, enums, and variables â€”
                    // all of which are invalid inside a generated class body.
                    let has_default_export = used_export_default_range || extracted_code.iter().any(|c| {
                        let trimmed = c.trim();
                        trimmed.starts_with("export default ") || trimmed.contains("\nexport default ")
                    });
                    let standalone_kinds = ["function", "class", "interface", "type", "enum", "variable", "constant"];
                    let all_standalone_functions = has_default_export
                        || extracted_kinds.iter().all(|k| standalone_kinds.contains(&k.as_str()));

                    // Query DB for the parent class metadata of the extracted methods.
                    // This allows generating correct class declarations with visibility,
                    // modifiers (static, abstract, sealed), and base class/interface info.
                    let parent_class_name: Option<String>;
                    let parent_class_kind: Option<String>;
                    let parent_class_metadata: Option<atls_core::types::SymbolMetadata>;
                    {
                        let conn = project.db().conn();
                        let first_method_line = methods.first()
                            .and_then(|m| project.query().get_symbol_line_range(file_path, m).ok().flatten())
                            .map(|r| r.start_line);
                        
                        if let Some(method_line) = first_method_line {
                            let file_path_fwd = file_path.replace('\\', "/");
                            let file_pattern = format!("%{}", file_path_fwd);
                            let row: Option<(String, String, Option<String>)> = conn.query_row(
                                "SELECT s.name, s.kind, s.metadata FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (f.path = ?1 OR f.path LIKE ?2)
                                   AND s.kind IN ('class', 'struct', 'interface')
                                   AND s.line <= ?3
                                   AND (s.end_line IS NULL OR s.end_line >= ?3)
                                 ORDER BY s.line DESC
                                 LIMIT 1",
                                rusqlite::params![&file_path_fwd, &file_pattern, method_line],
                                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                            ).ok();
                            
                            parent_class_name = row.as_ref().map(|(name, _, _)| name.clone());
                            parent_class_kind = row.as_ref().map(|(_, kind, _)| kind.clone());
                            parent_class_metadata = row.and_then(|(_, _, meta_json)| {
                                meta_json.and_then(|json_str| {
                                    serde_json::from_str::<atls_core::types::SymbolMetadata>(&json_str).ok()
                                })
                            });
                        } else {
                            parent_class_name = None;
                            parent_class_kind = None;
                            parent_class_metadata = None;
                        }
                    };

                    // Query sibling fields/constants from the same class scope.
                    // If a static/const/readonly field is referenced in the extracted code,
                    // include its source lines in the generated file to prevent undefined errors.
                    let sibling_field_code: Vec<String> = {
                        let conn = project.db().conn();
                        let file_path_fwd = file_path.replace('\\', "/");
                        let file_pattern = format!("%{}", file_path_fwd);
                        let first_method_line = methods.first()
                            .and_then(|m| project.query().get_symbol_line_range(file_path, m).ok().flatten())
                            .map(|r| r.start_line);
                        
                        if let Some(method_line) = first_method_line {
                            // Find the parent class id that encloses the first method
                            let parent_scope: Option<i64> = conn.query_row(
                                "SELECT s.id FROM symbols s
                                 JOIN files f ON s.file_id = f.id
                                 WHERE (f.path = ?1 OR f.path LIKE ?2)
                                   AND s.kind IN ('class', 'struct', 'interface')
                                   AND s.line <= ?3
                                   AND (s.end_line IS NULL OR s.end_line >= ?3)
                                 ORDER BY s.line DESC
                                 LIMIT 1",
                                rusqlite::params![&file_path_fwd, &file_pattern, method_line],
                                |row| row.get(0),
                            ).ok();

                            if let Some(scope_id) = parent_scope {
                                // Find field/constant/property/variable siblings in the same scope
                                let mut stmt = conn.prepare(
                                    "SELECT s.name, s.line, s.end_line, s.metadata FROM symbols s
                                     WHERE s.scope_id = ?1
                                       AND s.kind IN ('field', 'constant', 'property', 'variable')
                                     ORDER BY s.line"
                                ).unwrap_or_else(|_| conn.prepare("SELECT 1 WHERE 0").unwrap());
                                
                                let rows: Vec<(String, u32, Option<u32>, Option<String>)> = stmt.query_map(
                                    rusqlite::params![scope_id],
                                    |row| Ok((
                                        row.get::<_, String>(0)?,
                                        row.get::<_, u32>(1)?,
                                        row.get::<_, Option<u32>>(2)?,
                                        row.get::<_, Option<String>>(3)?,
                                    ))
                                ).ok()
                                    .map(|r| r.filter_map(|r| r.ok()).collect())
                                    .unwrap_or_default();

                                let source_lines: Vec<&str> = source_content.lines().collect();
                                let mut field_blocks: Vec<String> = Vec::new();
                                
                                for (field_name, line, end_line_opt, meta_json) in &rows {
                                    // Only include if the field name is referenced in extracted code
                                    if !all_extracted_text.contains(field_name.as_str()) {
                                        continue;
                                    }
                                    // Only include static/const/readonly fields (class-level, not instance)
                                    let is_static_const = meta_json.as_ref()
                                        .and_then(|j| serde_json::from_str::<atls_core::types::SymbolMetadata>(j).ok())
                                        .and_then(|m| m.modifiers)
                                        .map(|mods| mods.iter().any(|m| 
                                            m == "static" || m == "const" || m == "readonly" || m == "final"
                                        ))
                                        .unwrap_or(false);
                                    
                                    if is_static_const {
                                        let start = (*line as usize).saturating_sub(1).min(source_lines.len());
                                        let end = end_line_opt.unwrap_or(*line) as usize;
                                        let end = end.min(source_lines.len());
                                        if start < end {
                                            field_blocks.push(source_lines[start..end].join("\n"));
                                        }
                                    }
                                }
                                field_blocks
                            } else {
                                Vec::new()
                            }
                        } else {
                            Vec::new()
                        }
                    };

                    // Include exclusive co-move candidates (types/helpers only used by extracted code)
                    let mut co_move_code_blocks: Vec<String> = Vec::new();
                    let mut co_move_ranges_for_removal: Vec<(u32, u32)> = Vec::new();
                    for cm in &uhpp_co_move {
                        let is_shared = cm.get("shared").and_then(|v| v.as_bool()).unwrap_or(true);
                        if is_shared { continue; }
                        let start = cm.get("start_line").and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                        let end = cm.get("end_line").and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                        if start > 0 && end >= start {
                            let src_lines: Vec<&str> = source_content.lines().collect();
                            let s_idx = (start as usize).saturating_sub(1).min(src_lines.len());
                            let e_idx = (end as usize).min(src_lines.len());
                            if s_idx < e_idx {
                                let block = src_lines[s_idx..e_idx].join("\n");
                                let trimmed = block.trim();
                                if trimmed.starts_with("export ") {
                                    co_move_code_blocks.push(block);
                                } else {
                                    co_move_code_blocks.push(format!("export {}", trimmed));
                                }
                                co_move_ranges_for_removal.push((start, end));
                            }
                        }
                    }
                    // Prepend co-move blocks to extracted code
                    let mut all_extracted_for_target = co_move_code_blocks;
                    all_extracted_for_target.extend(extracted_code.iter().cloned());
                    // Also track co-move ranges for source removal
                    for range in &co_move_ranges_for_removal {
                        source_extraction_ranges.push(*range);
                    }

                    let class_content = match target_ext {
                        "ts" | "tsx" => {
                            let imports_block = if filtered_imports.is_empty() {
                                String::new()
                            } else {
                                format!("{}\n\n", filtered_imports.join("\n"))
                            };
                            if all_standalone_functions {
                                // Standalone declarations: preserve as bare exports, no class wrapper.
                                // Covers functions, classes, interfaces, types, enums, and variables.
                                let exported_fns: Vec<String> = extracted_code.iter().map(|code| {
                                    let trimmed = code.trim();
                                    if trimmed.starts_with("export ") {
                                        code.clone()
                                    } else if trimmed.starts_with("function ") || trimmed.starts_with("async function ")
                                        || trimmed.starts_with("class ") || trimmed.starts_with("abstract class ")
                                        || trimmed.starts_with("interface ") || trimmed.starts_with("type ")
                                        || trimmed.starts_with("enum ") || trimmed.starts_with("const ")
                                        || trimmed.starts_with("let ") || trimmed.starts_with("var ")
                                    {
                                        format!("export {}", trimmed)
                                    } else {
                                        code.clone()
                                    }
                                }).collect();
                                format!(
                                    "{}{}",
                                    imports_block,
                                    exported_fns.join("\n\n")
                                )
                            } else {
                                format!(
                                    "{}export class {} {{\n{}\n}}",
                                    imports_block,
                                    generated_class_name,
                                    extracted_code.join("\n\n")
                                )
                            }
                        }
                        "js" | "jsx" | "mjs" | "cjs" => {
                            let imports_block = if filtered_imports.is_empty() {
                                String::new()
                            } else {
                                format!("{}\n\n", filtered_imports.join("\n"))
                            };
                            if all_standalone_functions {
                                // Standalone declarations: preserve as bare exports, no class wrapper.
                                let exported_fns: Vec<String> = extracted_code.iter().map(|code| {
                                    let trimmed = code.trim();
                                    if trimmed.starts_with("export ") {
                                        code.clone()
                                    } else if trimmed.starts_with("function ") || trimmed.starts_with("async function ")
                                        || trimmed.starts_with("class ") || trimmed.starts_with("abstract class ")
                                        || trimmed.starts_with("interface ") || trimmed.starts_with("type ")
                                        || trimmed.starts_with("enum ") || trimmed.starts_with("const ")
                                        || trimmed.starts_with("let ") || trimmed.starts_with("var ")
                                    {
                                        format!("export {}", trimmed)
                                    } else {
                                        code.clone()
                                    }
                                }).collect();
                                format!(
                                    "{}{}",
                                    imports_block,
                                    exported_fns.join("\n\n")
                                )
                            } else {
                                format!(
                                    "{}export class {} {{\n{}\n}}",
                                    imports_block,
                                    generated_class_name,
                                    extracted_code.join("\n\n")
                                )
                            }
                        }
                        "rs" => {
                            // Rust: produce a flat module with pub items at top level.
                            let source_mod = derive_rust_module_name(file_path, project_root);
                            let target_mod = std::path::Path::new(target_file)
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("");

                            // â”€â”€ AST-based import analysis â”€â”€
                            // Parse the extracted code with tree-sitter to collect every
                            // type, function, module, and macro it actually references,
                            // then keep only the source imports that match.
                            let ast_refs = collect_rust_ast_references(
                                &all_extracted_text,
                                project.parser_registry(),
                            );
                            all_extraction_ast_refs.extend(ast_refs.iter().cloned());
                            let ast_filtered = filter_rust_imports_by_ast(
                                &file_ctx.import_lines,
                                &ast_refs,
                            );

                            // Resolve `self::X` imports through module aliases
                            // before rewriting, to avoid routing through private
                            // aliases (e.g. `self::fmt::Write` â†’ `core::fmt::Write`).
                            let alias_map = build_rust_module_alias_map(&file_ctx.import_lines);
                            let ast_filtered = resolve_self_imports_through_aliases(
                                &ast_filtered, &alias_map,
                            );

                            let mut rewritten = rewrite_rust_imports_for_new_module(
                                &ast_filtered,
                                &source_mod,
                                target_mod,
                                &methods.iter().map(|s| s.clone()).collect::<Vec<_>>(),
                            );

                            // Add imports for source-module symbols BEFORE the
                            // std/core fallback, so `discover_missing_rust_imports`
                            // sees them and doesn't emit conflicting paths
                            // (e.g. `crate::ser::Formatter` vs `core::fmt::Formatter`).
                            let source_sym_names: std::collections::HashSet<String> = if !source_mod.is_empty() {
                                let extracted_set: std::collections::HashSet<String> =
                                    methods.iter().map(|s| s.to_string()).collect();

                                // DB-based symbol names (broad, used for fallback suppression)
                                let source_syms: std::collections::HashSet<String> =
                                    project.query().get_all_symbol_names_for_file(file_path)
                                    .unwrap_or_default();

                                // Text-based module-level definitions (strict, used for
                                // import generation).  Only items at column 0 with a
                                // definition keyword are importable â€” NOT trait methods,
                                // struct fields, or local variables that the DB might index.
                                let module_level_defs: std::collections::HashSet<String> = {
                                    let mut defs = std::collections::HashSet::new();
                                    let def_prefixes: &[&str] = &[
                                        "fn ", "async fn ", "unsafe fn ", "const fn ",
                                        "struct ", "enum ", "type ", "trait ",
                                        "static ", "const ", "macro_rules! ",
                                    ];
                                    for line in source_content.lines() {
                                        if line.starts_with(' ') || line.starts_with('\t') {
                                            continue;
                                        }
                                        let trimmed = line.trim();
                                        // Strip visibility prefix
                                        let after_vis = if trimmed.starts_with("pub(") {
                                            trimmed.find(')')
                                                .map(|p| trimmed[p+1..].trim_start())
                                                .unwrap_or(trimmed)
                                        } else if trimmed.starts_with("pub ") {
                                            &trimmed[4..]
                                        } else {
                                            trimmed
                                        };
                                        for pfx in def_prefixes {
                                            if after_vis.starts_with(pfx) {
                                                let rest = &after_vis[pfx.len()..];
                                                let name_end = rest
                                                    .find(|c: char| !c.is_alphanumeric() && c != '_')
                                                    .unwrap_or(rest.len());
                                                let name = &rest[..name_end];
                                                if !name.is_empty() {
                                                    defs.insert(name.to_string());
                                                }
                                                break;
                                            }
                                        }
                                    }
                                    defs
                                };

                                for sym in &ast_refs {
                                    if extracted_set.contains(sym) { continue; }
                                    if module_level_defs.contains(sym.as_str()) {
                                        rewritten.push(format!(
                                            "use crate::{}::{};", source_mod, sym
                                        ));
                                    }
                                }
                                source_syms
                            } else {
                                std::collections::HashSet::new()
                            };

                            let extra_imports = discover_missing_rust_imports(
                                &ast_refs,
                                &rewritten,
                                &source_sym_names,
                            );
                            rewritten.extend(extra_imports);

                            let imports_block = if rewritten.is_empty() {
                                String::new()
                            } else {
                                let deduped = deduplicate_rust_imports(&rewritten);
                                format!("{}\n\n", deduped.join("\n"))
                            };

                            // â”€â”€ Per-function self-parameter transform â”€â”€
                            // Each extracted function may come from a different impl
                            // block or trait, so resolve the context independently.
                            // Returns (type_or_trait_name, is_trait).
                            let per_fn_ctx: Vec<Option<(String, bool)>> = extracted_code.iter().enumerate().map(|(i, code)| {
                                if !is_identifier_match(code, "self") {
                                    return None;
                                }
                                if let Some(ref pcn) = parent_class_name {
                                    return Some((pcn.clone(), false));
                                }
                                let method_name = methods.get(i);
                                let line = method_name
                                    .and_then(|m| project.query().get_symbol_line_range(file_path, m).ok().flatten())
                                    .map(|r| r.start_line);
                                line.and_then(|l| {
                                    find_rust_impl_type_for_line(&source_content, l, project.parser_registry())
                                })
                            }).collect();

                            // â”€â”€ Build delegation stubs for trait/impl methods â”€â”€
                            // When a method with `self` is extracted, leave a thin
                            // forwarding stub in the source so call sites using
                            // method syntax continue to work.
                            for (i, code) in extracted_code.iter().enumerate() {
                                if per_fn_ctx[i].is_none() { continue; }
                                let range = match extracted_ranges_per_method.get(i).and_then(|r| r.as_ref()) {
                                    Some(r) => *r,
                                    None => continue,
                                };
                                let fn_name = match methods.get(i) {
                                    Some(n) => n.as_str(),
                                    None => continue,
                                };
                                let param_names = extract_rust_fn_param_names(code, project.parser_registry());
                                let target_path = if target_mod.is_empty() {
                                    format!("crate::{}", fn_name)
                                } else {
                                    format!("crate::{}::{}", target_mod, fn_name)
                                };

                                // Build argument list: check if self is used in the
                                // body beyond `self::` path prefixes.  If so, pass
                                // self through the delegation call.
                                let mut args = Vec::new();
                                let body_start_stub = code.find('{').map(|p| p + 1).unwrap_or(0);
                                let body_stub = &code[body_start_stub..];
                                let body_no_self_path = body_stub.replace("self::", "__SELFPATH__");
                                if is_identifier_match(&body_no_self_path, "self") {
                                    args.push("self".to_string());
                                }
                                args.extend(param_names.iter().cloned());
                                let call = format!("{}({})", target_path, args.join(", "));

                                // Reconstruct signature: everything up to (and including)
                                // the opening `{`, then the delegation call, then `}`
                                let lines: Vec<&str> = code.lines().collect();
                                let mut sig_end = 0;
                                let mut brace_depth = 0;
                                for (li, line) in lines.iter().enumerate() {
                                    for ch in line.chars() {
                                        if ch == '{' {
                                            brace_depth += 1;
                                            if brace_depth == 1 {
                                                sig_end = li;
                                                break;
                                            }
                                        }
                                    }
                                    if brace_depth > 0 { break; }
                                }
                                let sig_lines: Vec<&str> = lines[..=sig_end].to_vec();
                                let indent = sig_lines.last()
                                    .map(|l| {
                                        let trimmed = l.trim_start();
                                        &l[..l.len() - trimmed.len()]
                                    })
                                    .unwrap_or("");
                                let stub = format!(
                                    "{}\n{}    {}\n{}}}",
                                    sig_lines.join("\n"),
                                    indent,
                                    call,
                                    indent,
                                );
                                source_delegation_stubs.insert(range, stub);
                                stubbed_method_names.insert(fn_name.to_string());
                            }

                            let transformed_code: Vec<String> = extracted_code.iter().enumerate().map(|(i, code)| {
                                let (type_name, is_trait) = match &per_fn_ctx[i] {
                                    Some(ctx) => (ctx.0.as_str(), ctx.1),
                                    None => return code.clone(),
                                };
                                if !is_identifier_match(code, "self") {
                                    return code.clone();
                                }

                                // Check if `self` is actually used in the function BODY
                                // beyond `self::` path prefixes.  If only `self::` paths
                                // exist, we can strip the self parameter entirely instead
                                // of replacing it with an explicit typed parameter.
                                let body_start = code.find('{').map(|p| p + 1).unwrap_or(0);
                                let body = &code[body_start..];
                                let body_no_self_path = body.replace("self::", "__SELFPATH__");
                                let self_used_in_body = is_identifier_match(&body_no_self_path, "self");

                                if !self_used_in_body {
                                    // self only appears in `self::` paths â€” remove from signature
                                    let mut result = code.clone();
                                    result = result.replace("&mut self, ", "");
                                    result = result.replace("&mut self)", ")");
                                    result = result.replace("&self, ", "");
                                    result = result.replace("&self)", ")");
                                    result = result.replace("mut self, ", "");
                                    result = result.replace("mut self)", ")");
                                    // bare `self,` (owned self) â€” careful not to match `self::`
                                    let result = {
                                        let mut r = result;
                                        // Only replace `self, ` at parameter position (after `(`)
                                        if let Some(paren) = r.find('(') {
                                            let after = &r[paren+1..];
                                            if after.trim_start().starts_with("self,") {
                                                let ws_len = after.len() - after.trim_start().len();
                                                let remove_start = paren + 1 + ws_len;
                                                let remove_end = remove_start + "self, ".len();
                                                if remove_end <= r.len() {
                                                    r = format!("{}{}", &r[..remove_start], &r[remove_end..]);
                                                }
                                            }
                                        }
                                        r
                                    };
                                    return result;
                                }

                                let param_name = {
                                    let mut param = String::new();
                                    for (ci, ch) in type_name.chars().enumerate() {
                                        if ch.is_uppercase() && ci > 0 {
                                            param.push('_');
                                        }
                                        param.push(ch.to_ascii_lowercase());
                                    }
                                    if param.len() > 20 { "this".to_string() } else { param }
                                };
                                // For trait methods: `&mut impl crate::mod::Trait`
                                // For impl methods:  `&mut crate::mod::Type`
                                let type_path = if source_mod.is_empty() {
                                    format!("crate::{}", type_name)
                                } else {
                                    format!("crate::{}::{}", source_mod, type_name)
                                };
                                let type_ref = if is_trait {
                                    format!("impl {}", type_path)
                                } else {
                                    type_path
                                };
                                let mut result = code.clone();
                                result = result.replace(
                                    "&mut self,",
                                    &format!("{}: &mut {},", param_name, type_ref),
                                );
                                result = result.replace(
                                    "&mut self)",
                                    &format!("{}: &mut {})", param_name, type_ref),
                                );
                                result = result.replace(
                                    "&self,",
                                    &format!("{}: &{},", param_name, type_ref),
                                );
                                result = result.replace(
                                    "&self)",
                                    &format!("{}: &{})", param_name, type_ref),
                                );
                                result = result.replace(
                                    "mut self,",
                                    &format!("mut {}: {},", param_name, type_ref),
                                );
                                result = result.replace(
                                    "mut self)",
                                    &format!("mut {}: {})", param_name, type_ref),
                                );
                                result = result.replace(
                                    "self,",
                                    &format!("{}: {},", param_name, type_ref),
                                );
                                result = result.replace("self.", &format!("{}.", param_name));
                                result
                            }).collect();

                            // â”€â”€ Rewrite body-level `self::` paths â”€â”€
                            // Inside function bodies, `use self::Foo::*` refers to the
                            // source module.  After extraction, `self::` must resolve
                            // to the source module's absolute path.
                            let self_rewrite_prefix = if source_mod.is_empty() {
                                "crate::".to_string()
                            } else {
                                format!("crate::{}::", source_mod)
                            };
                            let transformed_code: Vec<String> = transformed_code.iter().map(|code| {
                                if code.contains("self::") {
                                    code.replace("self::", &self_rewrite_prefix)
                                } else {
                                    code.clone()
                                }
                            }).collect();

                            // â”€â”€ pub(crate) visibility â”€â”€
                            let transformed_code: Vec<String> = transformed_code.iter().map(|code| {
                                let trimmed = code.trim_start();
                                if trimmed.starts_with("pub ") || trimmed.starts_with("pub(") {
                                    code.clone()
                                } else if trimmed.starts_with("fn ")
                                    || trimmed.starts_with("async fn ")
                                    || trimmed.starts_with("unsafe fn ")
                                    || trimmed.starts_with("const fn ")
                                    || trimmed.starts_with("struct ")
                                    || trimmed.starts_with("enum ")
                                    || trimmed.starts_with("type ")
                                    || trimmed.starts_with("trait ")
                                    || trimmed.starts_with("static ")
                                    || trimmed.starts_with("const ")
                                {
                                    format!("pub(crate) {}", trimmed)
                                } else {
                                    code.clone()
                                }
                            }).collect();

                            format!(
                                "{}{}",
                                imports_block,
                                transformed_code.join("\n\n")
                            )
                        }
                        "go" => {
                            let pkg = file_ctx.package_decl.as_deref().unwrap_or("package main");
                            let imports_block = if filtered_imports.is_empty() {
                                String::new()
                            } else {
                                format!("\nimport (\n{}\n)\n", filtered_imports.join("\n"))
                            };
                            format!(
                                "{}\n{}\n{}",
                                pkg,
                                imports_block,
                                extracted_code.join("\n\n")
                            )
                        }
                        "java" => {
                            let pkg_line = file_ctx.package_decl.as_deref()
                                .map(|p| format!("{}\n\n", p))
                                .unwrap_or_default();
                            let imports_block = if filtered_imports.is_empty() {
                                String::new()
                            } else {
                                format!("{}\n\n", filtered_imports.join("\n"))
                            };
                            // Generate stub field declarations for this.field references.
                            // Resolves actual types from source via tree-sitter; falls back to Object.
                            let field_stubs: String = {
                                let field_names: Vec<String> = dep_warnings.iter()
                                    .filter(|w| {
                                        w.get("kind").and_then(|k| k.as_str()) == Some("field")
                                            && w.get("issue").and_then(|i| i.as_str())
                                                .map(|i| i.contains("this.field"))
                                                .unwrap_or(false)
                                    })
                                    .filter_map(|w| w.get("symbol").and_then(|s| s.as_str()).map(|s| s.to_string()))
                                    .collect();
                                if field_names.is_empty() {
                                    String::new()
                                } else {
                                    // Try to resolve field types from source via tree-sitter
                                    let mut field_types: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                                    if let Ok(tree) = project.parser_registry().parse(atls_core::Language::Java, &source_content) {
                                        let root = tree.root_node();
                                        let mut stack = vec![root];
                                        while let Some(node) = stack.pop() {
                                            if node.kind() == "field_declaration" {
                                                // Extract type and declarator name
                                                let mut field_type = String::new();
                                                let mut decl_name = String::new();
                                                for i in 0..node.child_count() {
                                                    if let Some(child) = node.child(i) {
                                                        match child.kind() {
                                                            "type_identifier" | "generic_type" | "array_type"
                                                            | "integral_type" | "floating_point_type"
                                                            | "boolean_type" | "void_type" | "scoped_type_identifier" => {
                                                                field_type = child.utf8_text(source_content.as_bytes())
                                                                    .unwrap_or("Object").to_string();
                                                            }
                                                            "variable_declarator" => {
                                                                if let Some(name_node) = child.child_by_field_name("name") {
                                                                    decl_name = name_node.utf8_text(source_content.as_bytes())
                                                                        .unwrap_or("").to_string();
                                                                }
                                                            }
                                                            _ => {}
                                                        }
                                                    }
                                                }
                                                if !decl_name.is_empty() && !field_type.is_empty() {
                                                    field_types.insert(decl_name, field_type);
                                                }
                                            }
                                            let mut child_cursor = node.walk();
                                            if child_cursor.goto_first_child() {
                                                loop {
                                                    stack.push(child_cursor.node());
                                                    if !child_cursor.goto_next_sibling() { break; }
                                                }
                                            }
                                        }
                                    }
                                    let stubs: Vec<String> = field_names.iter()
                                        .map(|name| {
                                            let ftype = field_types.get(name)
                                                .map(|s| s.as_str())
                                                .unwrap_or("Object");
                                            format!("    private {} {};", ftype, name)
                                        })
                                        .collect();
                                    format!("{}\n\n", stubs.join("\n"))
                                }
                            };
                            // Build class declaration from parent metadata
                            let class_decl = {
                                let mut parts: Vec<&str> = Vec::new();
                                // Visibility from metadata, default to public
                                if let Some(ref meta) = parent_class_metadata {
                                    match meta.visibility {
                                        Some(atls_core::types::SymbolVisibility::Private) => parts.push("private"),
                                        Some(atls_core::types::SymbolVisibility::Protected) => parts.push("protected"),
                                        _ => parts.push("public"),
                                    }
                                    // Modifiers: static, abstract, final
                                    if let Some(ref mods) = meta.modifiers {
                                        for m in mods {
                                            match m.as_str() {
                                                "static" | "abstract" | "final" => parts.push(m.as_str()),
                                                _ => {}
                                            }
                                        }
                                    }
                                } else {
                                    parts.push("public");
                                }
                                parts.push("class");
                                let mut decl = format!("{} {}", parts.join(" "), generated_class_name);
                                // extends
                                if let Some(ref meta) = parent_class_metadata {
                                    if let Some(ref ext) = meta.extends {
                                        if !ext.is_empty() {
                                            decl.push_str(&format!(" extends {}", ext.join(", ")));
                                        }
                                    }
                                    if let Some(ref imp) = meta.implements {
                                        if !imp.is_empty() {
                                            decl.push_str(&format!(" implements {}", imp.join(", ")));
                                        }
                                    }
                                }
                                decl
                            };
                            // Include sibling static/const fields referenced by extracted code
                            let sibling_fields_block: String = if sibling_field_code.is_empty() {
                                String::new()
                            } else {
                                let indented: Vec<String> = sibling_field_code.iter()
                                    .map(|code| code.lines()
                                        .map(|line| if line.trim().is_empty() { String::new() } else { format!("    {}", line) })
                                        .collect::<Vec<_>>()
                                        .join("\n"))
                                    .collect();
                                format!("{}\n\n", indented.join("\n"))
                            };
                            let indented_methods: Vec<String> = extracted_code.iter()
                                .map(|code| {
                                    code.lines()
                                        .map(|line| if line.trim().is_empty() { String::new() } else { format!("    {}", line) })
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .collect();
                            format!(
                                "{}{}{} {{\n{}{}{}\n}}",
                                pkg_line,
                                imports_block,
                                class_decl,
                                field_stubs,
                                sibling_fields_block,
                                indented_methods.join("\n\n")
                            )
                        }
                        "cs" | "csx" => {
                            let ns = file_ctx.package_decl.as_deref().unwrap_or("namespace Extracted");
                            let usings_block = if filtered_imports.is_empty() {
                                String::new()
                            } else {
                                format!("{}\n\n", filtered_imports.join("\n"))
                            };
                            let is_file_scoped = ns.ends_with(';');
                            let indent = if is_file_scoped { "    " } else { "        " };
                            let indented_methods: Vec<String> = extracted_code.iter()
                                .map(|code| {
                                    code.lines()
                                        .map(|line| if line.trim().is_empty() { String::new() } else { format!("{}{}", indent, line) })
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .collect();
                            // Build C# class declaration from parent metadata
                            let class_decl = {
                                let mut parts: Vec<String> = Vec::new();
                                if let Some(ref meta) = parent_class_metadata {
                                    match meta.visibility {
                                        Some(atls_core::types::SymbolVisibility::Private) => parts.push("private".to_string()),
                                        Some(atls_core::types::SymbolVisibility::Protected) => parts.push("protected".to_string()),
                                        Some(atls_core::types::SymbolVisibility::Internal) => parts.push("internal".to_string()),
                                        _ => parts.push("public".to_string()),
                                    }
                                    if let Some(ref mods) = meta.modifiers {
                                        for m in mods {
                                            match m.as_str() {
                                                "static" | "abstract" | "sealed" | "partial" => {
                                                    parts.push(m.clone());
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                } else {
                                    parts.push("public".to_string());
                                }
                                parts.push("class".to_string());
                                parts.push(generated_class_name.clone());
                                let mut decl = parts.join(" ");
                                // Base list: extends + implements
                                let mut base_items: Vec<String> = Vec::new();
                                if let Some(ref meta) = parent_class_metadata {
                                    if let Some(ref ext) = meta.extends {
                                        base_items.extend(ext.iter().cloned());
                                    }
                                    if let Some(ref imp) = meta.implements {
                                        base_items.extend(imp.iter().cloned());
                                    }
                                }
                                if !base_items.is_empty() {
                                    decl.push_str(&format!(" : {}", base_items.join(", ")));
                                }
                                decl
                            };
                            // Include sibling static/const fields referenced by extracted code
                            let sibling_fields_block: String = if sibling_field_code.is_empty() {
                                String::new()
                            } else {
                                let indented: Vec<String> = sibling_field_code.iter()
                                    .map(|code| code.lines()
                                        .map(|line| if line.trim().is_empty() { String::new() } else { format!("{}{}", indent, line) })
                                        .collect::<Vec<_>>()
                                        .join("\n"))
                                    .collect();
                                format!("{}\n\n", indented.join("\n"))
                            };
                            if is_file_scoped {
                                format!(
                                    "{}{}\n\n{}\n{{\n{}{}\n}}",
                                    usings_block,
                                    ns,
                                    class_decl,
                                    sibling_fields_block,
                                    indented_methods.join("\n\n")
                                )
                            } else {
                                format!(
                                    "{}{}\n{{\n    {}\n    {{\n{}{}\n    }}\n}}",
                                    usings_block,
                                    ns,
                                    class_decl,
                                    sibling_fields_block,
                                    indented_methods.join("\n\n")
                                )
                            }
                        }
                        "py" | "pyi" | "pyw" => {
                            let imports_block = if filtered_imports.is_empty() {
                                String::new()
                            } else {
                                format!("{}\n\n", filtered_imports.join("\n"))
                            };
                            // Indent method bodies under a class with 4 spaces
                            let indented_methods: Vec<String> = extracted_code.iter()
                                .map(|code| {
                                    code.lines()
                                        .map(|line| if line.trim().is_empty() { String::new() } else { format!("    {}", line) })
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .collect();
                            format!(
                                "{}\nclass {}:\n{}",
                                imports_block,
                                generated_class_name,
                                indented_methods.join("\n\n")
                            )
                        }
                        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" | "h" | "c" => {
                            let includes_block = if filtered_imports.is_empty() {
                                String::new()
                            } else {
                                format!("{}\n\n", filtered_imports.join("\n"))
                            };
                            // Collect #define macros referenced by the extracted code
                            let all_code = extracted_code.join("\n");
                            let resolved_source_for_macros = resolve_project_path(project_root, file_path);
                            let macro_defines = collect_c_macros_for_code(
                                &source_content,
                                &resolved_source_for_macros,
                                &all_code,
                            );
                            // (macro names no longer checked â€” we always expand ALL_CAPS wrappers
                            //  in function signatures since the #define may be platform-conditional)
                            // Strip ALL_CAPS macro wrappers from function signatures in extracted code.
                            // e.g., `CJSON_PUBLIC(cJSON *) cJSON_Parse(...)` â†’ `cJSON * cJSON_Parse(...)`
                            // Always strip: the macro definition may be platform-conditional, so
                            // expanding to the inner argument is the safest portable representation.
                            let extracted_code: Vec<String> = extracted_code.iter().map(|code| {
                                let mut result = code.clone();
                                if let Ok(re) = regex::Regex::new(r"([A-Z][A-Z0-9_]{2,})\(([^)]*)\)") {
                                    // Only strip on lines that look like function signatures (before the body).
                                    // Find the first '{' to limit stripping to the declaration portion.
                                    let sig_end = result.find('{').unwrap_or(result.len()).min(500);
                                    let sig_part = &result[..sig_end];
                                    let body_part = &result[sig_end..];
                                    let mut stripped_sig = sig_part.to_string();
                                    let mut changed = true;
                                    while changed {
                                        changed = false;
                                        if let Some(caps) = re.captures(&stripped_sig) {
                                            let macro_name = caps.get(1).unwrap().as_str();
                                            // Skip common non-macro patterns like type casts
                                            if macro_name.len() >= 3 {
                                                let inner = caps.get(2).unwrap().as_str();
                                                let full_match = caps.get(0).unwrap();
                                                stripped_sig = format!(
                                                    "{}{}{}",
                                                    &stripped_sig[..full_match.start()],
                                                    inner,
                                                    &stripped_sig[full_match.end()..]
                                                );
                                                changed = true;
                                            }
                                        }
                                    }
                                    result = format!("{}{}", stripped_sig, body_part);
                                }
                                result
                            }).collect();
                            let macros_block = if macro_defines.is_empty() {
                                String::new()
                            } else {
                                format!("{}\n\n", macro_defines.join("\n"))
                            };
                            
                            // C++ class method wrapping: if methods came from a class/struct,
                            // wrap them in the class declaration to preserve correct syntax.
                            // C (plain) never uses class wrappers.
                            let is_cpp = matches!(target_ext, "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh");
                            let needs_class_wrapper = is_cpp
                                && parent_class_name.is_some()
                                && parent_class_kind.as_deref() != Some("interface");
                            
                            let code_body = if needs_class_wrapper {
                                let class_name = parent_class_name.as_deref().unwrap_or(&generated_class_name);
                                let kind_kw = match parent_class_kind.as_deref() {
                                    Some("struct") => "struct",
                                    _ => "class",
                                };
                                // Build base class list from metadata
                                let base_clause = parent_class_metadata.as_ref()
                                    .and_then(|meta| {
                                        let mut bases = Vec::new();
                                        if let Some(ref ext) = meta.extends {
                                            bases.extend(ext.iter().map(|b| format!("public {}", b)));
                                        }
                                        if let Some(ref impls) = meta.implements {
                                            bases.extend(impls.iter().map(|i| format!("public {}", i)));
                                        }
                                        if bases.is_empty() { None } else { Some(format!(" : {}", bases.join(", "))) }
                                    })
                                    .unwrap_or_default();
                                
                                // Determine access specifier from method visibility
                                let access_spec = parent_class_metadata.as_ref()
                                    .and_then(|meta| match meta.visibility {
                                        Some(atls_core::types::SymbolVisibility::Private) => Some("private"),
                                        Some(atls_core::types::SymbolVisibility::Protected) => Some("protected"),
                                        _ => Some("public"),
                                    })
                                    .unwrap_or("public");
                                
                                // Indent methods inside class
                                let indented: Vec<String> = extracted_code.iter()
                                    .map(|code| {
                                        code.lines()
                                            .map(|line| if line.trim().is_empty() { String::new() } else { format!("    {}", line) })
                                            .collect::<Vec<_>>()
                                            .join("\n")
                                    })
                                    .collect();
                                
                                // Include sibling fields if any
                                let fields_block = if !sibling_field_code.is_empty() {
                                    let indented_fields: Vec<String> = sibling_field_code.iter()
                                        .map(|f| format!("    {}", f))
                                        .collect();
                                    format!("{}\n\n", indented_fields.join("\n"))
                                } else {
                                    String::new()
                                };
                                
                                format!(
                                    "{} {}{} {{\n{}:\n{}{}\n}};",
                                    kind_kw, class_name, base_clause,
                                    access_spec, fields_block,
                                    indented.join("\n\n")
                                )
                            } else {
                                extracted_code.join("\n\n")
                            };
                            
                            if let Some(ref ns) = file_ctx.package_decl {
                                let ns_name = ns.trim_start_matches("namespace ")
                                    .trim_end_matches('{')
                                    .trim();
                                format!(
                                    "{}{}namespace {} {{\n\n{}\n\n}} // namespace {}",
                                    includes_block,
                                    macros_block,
                                    ns_name,
                                    code_body,
                                    ns_name
                                )
                            } else {
                                format!(
                                    "{}{}{}",
                                    includes_block,
                                    macros_block,
                                    code_body
                                )
                            }
                        }
                        // Fallback for unrecognized extensions
                        _ => extracted_code.join("\n\n")
                    };
                    
                    // Generate language-aware delegation hints
                    let delegation_code = generate_delegation_hint(
                        target_ext,
                        &generated_class_name,
                        file_path,
                        target_file,
                        delegation_style,
                    );

                    // â”€â”€ Non-Rust delegation stubs â”€â”€
                    // For TS/JS/Python/Java/C# standalone functions: generate thin
                    // forwarding stubs when the symbol is referenced elsewhere in source.
                    if !matches!(file_ctx.language, atls_core::Language::Rust) {
                        let mut excluded_lines: std::collections::HashSet<usize> = std::collections::HashSet::new();
                        for range_opt in &extracted_ranges_per_method {
                            if let Some((s, e)) = range_opt {
                                for ln in (*s as usize)..=(*e as usize) {
                                    excluded_lines.insert(ln);
                                }
                            }
                        }
                        let src_lines_for_ref: Vec<&str> = source_content.lines().enumerate()
                            .filter(|(i, _)| !excluded_lines.contains(&(i + 1)))
                            .map(|(_, l)| l)
                            .collect();
                        let source_minus_extracted = src_lines_for_ref.join("\n");

                        for (i, code) in extracted_code.iter().enumerate() {
                            let range = match extracted_ranges_per_method.get(i).and_then(|r| r.as_ref()) {
                                Some(r) => *r,
                                None => continue,
                            };
                            if source_delegation_stubs.contains_key(&range) { continue; }
                            let fn_name = match methods.get(i) {
                                Some(n) => n.as_str(),
                                None => continue,
                            };
                            if !is_identifier_match(&source_minus_extracted, fn_name) {
                                continue;
                            }
                            if let Some(stub) = generate_delegation_stub(
                                code, fn_name, target_file, file_ctx.language,
                                project.parser_registry(),
                            ) {
                                source_delegation_stubs.insert(range, stub);
                                stubbed_method_names.insert(fn_name.to_string());
                            }
                        }
                    }

                    if dry_run {
                        let mut preview = serde_json::json!({
                            "target_file": target_file,
                            "class_name": generated_class_name,
                            "methods": method_info,
                            "status": "dry_run_preview",
                            "_warning": "NO FILES WERE CREATED. This is a dry_run preview. Set dry_run:false to execute.",
                            "generated_code_preview": if class_content.len() > 500 {
                                format!("{}...", &class_content[..500])
                            } else {
                                class_content.clone()
                            },
                            "delegation_hint": delegation_code
                        });
                        preview.as_object_mut().unwrap().insert(
                            "extraction_risk".to_string(),
                            serde_json::json!(extraction_risk),
                        );
                        if !dep_warnings.is_empty() {
                            preview.as_object_mut().unwrap().insert(
                                "missing_dependencies".to_string(),
                                serde_json::json!(dep_warnings),
                            );
                        }
                        if !go_promotions.is_empty() {
                            preview.as_object_mut().unwrap().insert(
                                "go_promotions".to_string(),
                                serde_json::json!(go_promotions.iter().map(|(old, new)| {
                                    serde_json::json!({"old": old, "new": new})
                                }).collect::<Vec<_>>()),
                            );
                        }
                        // UHPP deps pre-flight results
                        if !uhpp_co_move.is_empty() {
                            preview.as_object_mut().unwrap().insert(
                                "co_move_candidates".to_string(),
                                serde_json::json!(uhpp_co_move),
                            );
                        }
                        if !uhpp_scope_warnings.is_empty() {
                            preview.as_object_mut().unwrap().insert(
                                "scope_warnings".to_string(),
                                serde_json::json!(uhpp_scope_warnings),
                            );
                        }
                        if !uhpp_needed_imports.is_empty() {
                            preview.as_object_mut().unwrap().insert(
                                "uhpp_needed_imports".to_string(),
                                serde_json::json!(uhpp_needed_imports),
                            );
                        }
                        results.push(preview);
                    } else {
                        // Parse-check BEFORE write (transactional): lint in-memory content first.
                        // Skip for C/C++ (macros cause false positives).
                        let is_c_cpp_target = matches!(target_ext,
                            "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh"
                        );
                        let lint_errors: Vec<linter::LintResult> = if is_c_cpp_target {
                            vec![] // Skip lint â€” macros cause false positives
                        } else {
                            let (lint_results, _) = lint_file_contents(
                                project_root,
                                &[(target_file.clone(), class_content.clone())],
                                true,  // syntax-only
                                false, // tree-sitter for speed
                            );
                            lint_results.into_iter()
                                .filter(|r| r.severity == "error")
                                .collect()
                        };
                        
                        if !lint_errors.is_empty() {
                            let error_msgs: Vec<String> = lint_errors.iter()
                                .take(5)
                                .map(|r| format!("{}:{}: {}", r.file, r.line, r.message))
                                .collect();
                            results.push(serde_json::json!({
                                "target_file": target_file,
                                "class_name": generated_class_name,
                                "methods": method_info,
                                "status": "failed_lint",
                                "lint_errors": error_msgs,
                                "generated_code_preview": if class_content.len() > 1000 {
                                    format!("{}...", &class_content[..1000])
                                } else {
                                    class_content.clone()
                                }
                            }));
                            extraction_failed = true;
                        } else {
                            // Parse-check passed â€” now write
                            let resolved_target = resolve_project_path(project_root, target_file);
                            if let Some(parent) = resolved_target.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            if std::fs::write(&resolved_target, &class_content).is_ok() {
                                    written_target_files.push(target_file.clone());
                                    let mut created_result = serde_json::json!({
                                        "target_file": target_file,
                                        "class_name": generated_class_name,
                                        "methods": method_info,
                                        "status": "created",
                                        "delegation_hint": delegation_code
                                    });
                                    if !dep_warnings.is_empty() {
                                        created_result.as_object_mut().unwrap().insert(
                                            "missing_dependencies".to_string(),
                                            serde_json::json!(dep_warnings),
                                        );
                                    }
                                    // UHPP: attach co-move and scope info
                                    if !uhpp_co_move.is_empty() {
                                        created_result.as_object_mut().unwrap().insert(
                                            "co_move_candidates".to_string(),
                                            serde_json::json!(uhpp_co_move),
                                        );
                                    }
                                    if !uhpp_scope_warnings.is_empty() {
                                        created_result.as_object_mut().unwrap().insert(
                                            "scope_warnings".to_string(),
                                            serde_json::json!(uhpp_scope_warnings),
                                        );
                                    }
                                    // Circular dependency check
                                    {
                                        let source_imports_from_target = filtered_imports.iter().any(|imp| {
                                            imp.contains(target_file.trim_end_matches(".ts")
                                                .trim_end_matches(".js")
                                                .trim_end_matches(".tsx")
                                                .trim_end_matches(".jsx"))
                                        });
                                        let target_needs_source_import = uhpp_co_move.iter().any(|cm| {
                                            cm.get("shared").and_then(|v| v.as_bool()).unwrap_or(false)
                                        });
                                        if source_imports_from_target && target_needs_source_import {
                                            created_result.as_object_mut().unwrap().insert(
                                                "circular_dep_warning".to_string(),
                                                serde_json::json!("Potential circular dependency: target imports from source AND source imports from target. Consider consolidating shared types."),
                                            );
                                        }
                                    }
                                    results.push(created_result);
                                } else {
                                    results.push(serde_json::json!({
                                        "target_file": target_file,
                                        "error": "Failed to write file",
                                        "status": "failed"
                                    }));
                                    extraction_failed = true;
                                }
                        }
                    }
                }
                
                // Post-write: remove extracted methods from the source file
                let mut source_removal_result: Option<serde_json::Value> = None;
                let mut mod_declaration_added: Option<String> = None;

                if !dry_run && !source_extraction_ranges.is_empty() {
                    let mut ranges = source_extraction_ranges.clone();
                    ranges.sort_by(|a, b| b.0.cmp(&a.0));

                    let src_lines: Vec<&str> = source_content.lines().collect();
                    let mut kept: Vec<bool> = vec![true; src_lines.len()];
                    // Collect stub replacement lines keyed by 0-based line index
                    let mut stub_replacements: std::collections::HashMap<usize, String> = std::collections::HashMap::new();

                    for (start, end) in &ranges {
                        let s = (*start as usize).saturating_sub(1);
                        let e = std::cmp::min(*end as usize, src_lines.len());

                        if let Some(stub_text) = source_delegation_stubs.get(&(*start, *end)) {
                            // Delegation stub: mark all lines in range as removed,
                            // then record the stub to be inserted at `s`.
                            for idx in s..e {
                                kept[idx] = false;
                            }
                            // Preserve preceding doc comments / attributes for stubs
                            stub_replacements.insert(s, stub_text.clone());
                        } else {
                            // Full removal (free functions)
                            for idx in s..e {
                                kept[idx] = false;
                            }
                            // Also remove preceding doc comments / blank lines belonging to the symbol
                            if s > 0 {
                                let mut doc_start = s;
                                while doc_start > 0 {
                                    let prev = src_lines[doc_start - 1].trim();
                                    if prev.is_empty()
                                        || prev.starts_with("///")
                                        || prev.starts_with("//!")
                                        || prev.starts_with("//")
                                        || prev.starts_with('#')
                                        || prev.starts_with('*')
                                        || prev.starts_with("/**")
                                        || prev.starts_with("\"\"\"")
                                    {
                                        doc_start -= 1;
                                        kept[doc_start] = false;
                                    } else {
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    // Build new source: kept lines + stub insertions
                    let mut new_src_parts: Vec<String> = Vec::new();
                    for (i, line) in src_lines.iter().enumerate() {
                        if let Some(stub) = stub_replacements.get(&i) {
                            new_src_parts.push(stub.clone());
                        }
                        if kept[i] {
                            new_src_parts.push(line.to_string());
                        }
                    }
                    let mut new_src = new_src_parts.join("\n");
                    new_src = collapse_blank_lines(&new_src);

                    // Transactional: parse-check rewritten source before commit.
                    // Skip C/C++ (macros cause false positives). On failure, rollback target files.
                    let src_ext = std::path::Path::new(file_path).extension().and_then(|e| e.to_str()).unwrap_or("");
                    let is_c_cpp = matches!(src_ext, "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh");
                    let source_lint_errors: Vec<linter::LintResult> = if is_c_cpp {
                        vec![]
                    } else {
                        let (lint_results, _) = lint_file_contents(
                            project_root,
                            &[(file_path.to_string(), new_src.clone())],
                            true, false,
                        );
                        lint_results.into_iter().filter(|r| r.severity == "error").collect()
                    };
                    if !source_lint_errors.is_empty() {
                        for tf in &written_target_files {
                            let _ = std::fs::remove_file(resolve_project_path(project_root, tf));
                        }
                        let msgs: Vec<String> = source_lint_errors.iter().take(5)
                            .map(|r| format!("{}:{}: {}", r.file, r.line, r.message)).collect();
                        return Err(format!(
                            "Source file parse-check failed after extraction. Rolled back {} target file(s). Errors:\n{}",
                            written_target_files.len(),
                            msgs.join("\n")
                        ));
                    }

                    if let Ok(()) = std::fs::write(&resolved_source, &new_src) {
                        source_removal_result = Some(serde_json::json!({
                            "status": "methods_removed",
                            "ranges_removed": ranges.iter().map(|(s, e)| format!("{}-{}", s, e)).collect::<Vec<_>>(),
                        }));

                        // Add use-imports only for extracted symbols that are
                        // actually called in the remaining source code.
                        // Skip methods with delegation stubs â€” they use full
                        // crate paths and don't need a separate import.
                        let remaining_src = std::fs::read_to_string(&resolved_source)
                            .unwrap_or_default();
                        for (target_file, methods, _) in &extractions {
                            let used_methods: Vec<String> = methods.iter()
                                .filter(|m| {
                                    !stubbed_method_names.contains(m.as_str())
                                        && is_identifier_match(&remaining_src, m)
                                })
                                .map(|m| m.to_string())
                                .collect();
                            if used_methods.is_empty() {
                                continue;
                            }
                            if let Some(import_line) = build_source_import_for_moved_symbols(
                                file_path,
                                target_file,
                                &used_methods,
                                file_ctx.language,
                            ) {
                                let current_src = std::fs::read_to_string(&resolved_source)
                                    .unwrap_or_default();
                                let with_import = insert_import_line(
                                    &current_src,
                                    &import_line,
                                    file_ctx.language,
                                );
                                let _ = std::fs::write(&resolved_source, &with_import);
                            }
                        }

                        // Remove now-unused imports from the source file.
                        cleanup_unused_imports(
                            &resolved_source, file_ctx.language, project.parser_registry(),
                        );
                    }
                }

                // For Rust: upgrade private symbols in the source file to pub(crate)
                // when they're referenced by the extracted code but were not themselves extracted.
                if !dry_run && file_ctx.language == atls_core::Language::Rust && !all_extraction_ast_refs.is_empty() {
                    let extracted_set: std::collections::HashSet<&str> =
                        all_extracted_methods.iter().map(|s| s.as_str()).collect();
                    upgrade_rust_visibility(
                        &resolved_source, &all_extraction_ast_refs, &extracted_set,
                    );
                }

                // For Rust: add mod declaration to the crate root for each new target file
                if !dry_run && file_ctx.language == atls_core::Language::Rust {
                    let source_dir = resolved_source.parent().unwrap_or(project_root);
                    for target_file in &written_target_files {
                        if let Some(msg) = ensure_rust_mod_declaration(target_file, source_dir, project_root) {
                            mod_declaration_added = Some(msg);
                        }
                    }
                }

                // Rewrite imports in consumer files that reference moved symbols
                let mut consumer_import_results: Vec<serde_json::Value> = Vec::new();
                if !all_extracted_methods.is_empty() {
                    for (target_file, methods, _) in &extractions {
                        let fixes = generate_consumer_import_updates(
                            &project,
                            file_path,
                            target_file,
                            methods,
                            file_ctx.language,
                            project_root,
                            dry_run,
                        );
                        consumer_import_results.extend(fixes);
                    }
                }

                // Add import of extracted symbols back to source file if it still references them
                if !dry_run && !all_extracted_methods.is_empty() {
                    let source_abs = resolve_project_path(project_root, file_path);
                    if let Ok(source_content) = std::fs::read_to_string(&source_abs) {
                        for (target_file, methods, _) in &extractions {
                            let still_used: Vec<String> = methods.iter()
                                .filter(|m| source_content.contains(m.as_str()))
                                .cloned()
                                .collect();
                            if !still_used.is_empty() {
                                if let Some(imp) = build_source_import_for_moved_symbols_with_root(
                                    file_path, target_file, &still_used,
                                    file_ctx.language, Some(project_root),
                                ) {
                                    let updated = insert_import_line(&source_content, &imp, file_ctx.language);
                                    if updated != source_content {
                                        let _ = std::fs::write(&source_abs, &updated);
                                        consumer_import_results.push(serde_json::json!({
                                            "consumer": file_path,
                                            "symbols": still_used,
                                            "action": "source_import_added",
                                            "new_import": imp,
                                        }));
                                    }
                                }
                            }
                        }
                    }
                }

                // Post-write indexing (linting already done per-file above)
                let mut all_modified_files = written_target_files.clone();
                // Include consumer files that had imports rewritten
                for fix in &consumer_import_results {
                    if let Some(consumer) = fix["consumer"].as_str() {
                        if fix["action"].as_str() == Some("import_rewritten") {
                            if !all_modified_files.contains(&consumer.to_string()) {
                                all_modified_files.push(consumer.to_string());
                            }
                        }
                    }
                }
                // Include source file in indexing if we modified it
                if source_removal_result.is_some() {
                    let src_rel = resolved_source.strip_prefix(project_root)
                        .map(|p| p.to_string_lossy().to_string().replace('\\', "/"))
                        .unwrap_or_else(|_| file_path.to_string());
                    if !all_modified_files.contains(&src_rel) {
                        all_modified_files.push(src_rel);
                    }
                }

                let lint_summary: Option<linter::LintSummary> = if !dry_run && !all_modified_files.is_empty() {
                    let (all_results, summary) = lint_written_files_with_options(project_root, &all_modified_files, true, false);
                    let _ = all_results;
                    summary
                } else {
                    None
                };
                let index_result = if !dry_run && !all_modified_files.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), all_modified_files.clone()).await
                } else {
                    serde_json::json!(null)
                };
                
                let mut response = serde_json::json!({
                    "source_file": file_path,
                    "dry_run": dry_run,
                    "delegation_style": delegation_style,
                    "extractions": results,
                    "created_files": written_target_files,
                    "source_cleanup": source_removal_result,
                    "consumer_import_fixes": consumer_import_results,
                    "mod_declaration": mod_declaration_added,
                    "lints": lint_summary,
                    "index": index_result,
                    "summary": {
                        "total_methods_extracted": all_extracted_methods.len(),
                        "target_files": extractions.len(),
                        "lints": lint_summary.as_ref().map(|s| s.total).unwrap_or(0)
                    },
                    "status": if dry_run { "dry_run_preview" } else { "success" },
                    "_next": if dry_run {
                        "DRY RUN ONLY â€” no files created. Re-run extract_methods with dry_run:false to execute."
                    } else if all_extracted_methods.is_empty() {
                        "No methods found in symbol index. Re-index the project and retry."
                    } else if source_removal_result.is_some() {
                        "Extraction complete. Methods removed from source and target files created. Verify with: q: v1 verify.typecheck"
                    } else {
                        "Target files created. Verify with: q: v1 verify.typecheck"
                    }
                });
                if was_reordered {
                    response.as_object_mut().unwrap().insert(
                        "extraction_order".to_string(),
                        serde_json::json!({
                            "reordered": true,
                            "original": original_order,
                            "sorted": sorted_order,
                            "reason": "topological sort: callees extracted before callers"
                        }),
                    );
                }
                Ok(response)
            }
            "move_symbol" => {
                // Move a symbol from one file to another
                // Accept: symbol_names (array), symbol_name (string), or symbol (string)
                let symbol_names: Vec<String> = params
                    .get("symbol_names")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .or_else(|| {
                        // Also accept single symbol_name or symbol as string
                        params.get("symbol_name")
                            .or_else(|| params.get("symbol"))
                            .and_then(|v| v.as_str())
                            .map(|s| vec![s.to_string()])
                    })
                    .unwrap_or_default();
                
                if symbol_names.is_empty() {
                    return Err("symbol_names required for move_symbol (also accepts: symbol_name, symbol)".to_string());
                }
                
                // Accept: target_file or to
                let target_file = params
                    .get("target_file")
                    .or_else(|| params.get("to"))
                    .and_then(|v| v.as_str())
                    .ok_or("target_file required for move_symbol (also accepts: to)")?;
                
                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                let create_file = params
                    .get("create_file")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                // Auto-update import statements in files that reference moved symbols (default: true)
                let update_imports = params
                    .get("update_imports")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                // Optional: generate a delegation stub at the original location
                let create_delegation = params
                    .get("create_delegation")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                // Optional source_file hint for moving symbols not yet in the index
                // (e.g., extract-generated files that haven't been re-indexed)
                let source_file_hint = params
                    .get("source_file")
                    .or_else(|| params.get("from"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let resolved_target = resolve_project_path(project_root, target_file);

                // Cross-language collision detection: source and target must be the same language
                let target_lang = atls_core::Language::from_extension(
                    std::path::Path::new(target_file)
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or(""),
                );
                if let Some(ref hint) = source_file_hint {
                    let source_lang = atls_core::Language::from_extension(
                        std::path::Path::new(hint.as_str())
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or(""),
                    );
                    if source_lang != atls_core::Language::Unknown
                        && target_lang != atls_core::Language::Unknown
                        && source_lang != target_lang
                    {
                        return Err(format!(
                            "Cross-language move blocked: source is {:?} but target is {:?}. \
                             Move operations must stay within the same language.",
                            source_lang, target_lang
                        ));
                    }
                }

                // Check for symbol collision at target file
                if resolved_target.exists() {
                    for sym_name in &symbol_names {
                        if let Ok(Some(existing)) = project.query().get_symbol_line_range(target_file, sym_name) {
                            if existing.name == *sym_name {
                                return Err(format!(
                                    "Symbol collision: '{}' already exists in {} at line {}. \
                                     Rename the symbol first or choose a different target.",
                                    sym_name, target_file, existing.start_line
                                ));
                            }
                        }
                    }
                }

                // Check if target exists or needs creation
                let target_exists = resolved_target.exists();
                if !target_exists && !create_file && !dry_run {
                    return Err(format!("Target file {} does not exist. Set create_file:true to create it", target_file));
                }
                
                let mut symbols_moved: Vec<serde_json::Value> = Vec::new();
                let mut imports_updated: Vec<serde_json::Value> = Vec::new();
                let mut errors: Vec<serde_json::Value> = Vec::new();
                let mut extracted_code: Vec<String> = Vec::new();
                let mut source_files_modified: std::collections::HashSet<String> = std::collections::HashSet::new();
                // Track line ranges to remove from source files after move
                // Key: source file path, Value: list of (start_line 1-indexed, end_line 1-indexed)
                let mut source_removal_ranges: std::collections::HashMap<String, Vec<(u32, u32)>> = std::collections::HashMap::new();
                // Collect file context (namespace/imports) from each source file for the target
                let mut collected_file_ctx: Option<FileContext> = None;
                
                // Pre-index the source_file hint unconditionally before lookup.
                // Freshly extracted files (e.g., from extract_methods) may not be in
                // the index yet. Indexing once before the symbol loop ensures all
                // symbols from the hint file are discoverable.
                let mut hint_pre_indexed = false;
                if let Some(ref hint_file) = source_file_hint {
                    let hint_resolved = resolve_project_path(project_root, hint_file);
                    if hint_resolved.is_file() {
                        let indexer = project.indexer().clone();
                        let indexer_guard = indexer.lock().await;
                        let _ = indexer_guard.on_file_change(&hint_resolved).await;
                        drop(indexer_guard);
                        hint_pre_indexed = true;
                    }
                }

                for symbol_name in &symbol_names {
                    // Find the symbol â€” try index first, then fallback strategies
                    let usage_result = project.query().get_symbol_usage(symbol_name);
                    let has_definitions = usage_result.as_ref()
                        .map(|u| !u.definitions.is_empty())
                        .unwrap_or(false);
                    
                    // Fallback: if index lookup failed, try re-indexing or global search.
                    let usage = if !has_definitions {
                        if let Some(ref hint_file) = source_file_hint {
                            if !hint_pre_indexed {
                                // Re-index the source file on-demand (shouldn't reach here
                                // normally, but handles edge cases)
                                let hint_resolved = resolve_project_path(project_root, hint_file);
                                if hint_resolved.is_file() {
                                    let indexer = project.indexer().clone();
                                    let indexer_guard = indexer.lock().await;
                                    let _ = indexer_guard.on_file_change(&hint_resolved).await;
                                    drop(indexer_guard);
                                }
                            }
                            // Retry lookup after (pre-)index
                            project.query().get_symbol_usage(symbol_name)
                        } else {
                            // No source_file_hint: try disambiguated global search
                            // Filter to target language extensions to avoid cross-language false positives
                            let tgt_exts = target_lang.extensions();
                            let tgt_ext_filter = if tgt_exts.is_empty() { None } else { Some(tgt_exts) };
                            match project.query().get_symbol_line_range_global_disambiguated(
                                symbol_name, Some("function"), Some(5), tgt_ext_filter,
                            ) {
                                Ok(candidates) if !candidates.is_empty() => {
                                    let global_range = &candidates[0];
                                    let found_path = resolve_project_path(project_root, &global_range.file);
                                    if found_path.is_file() {
                                        let indexer = project.indexer().clone();
                                        let indexer_guard = indexer.lock().await;
                                        let _ = indexer_guard.on_file_change(&found_path).await;
                                        drop(indexer_guard);
                                        project.query().get_symbol_usage(symbol_name)
                                    } else {
                                        usage_result
                                    }
                                }
                                _ => usage_result,
                            }
                        }
                    } else {
                        usage_result
                    };
                    
                    let usage = match usage {
                        Ok(u) if !u.definitions.is_empty() => u,
                        Ok(_) => {
                            // Still no definitions â€” try file-based fallback
                            if let Some(ref hint_file) = source_file_hint {
                                let hint_resolved = resolve_project_path(project_root, hint_file);
                                if let Ok(content) = std::fs::read_to_string(&hint_resolved) {
                                    // Scan for the symbol name in the file as a definition.
                                    // Covers language-specific declaration keywords, export
                                    // statements, and variable/const bindings (e.g., generated
                                    // class names from extract_methods that may not be indexed yet).
                                    let def_patterns: Vec<String> = vec![
                                        format!("class {} ", symbol_name),
                                        format!("class {}{{", symbol_name),
                                        format!("abstract class {}", symbol_name),
                                        format!("struct {} ", symbol_name),
                                        format!("struct {}{{", symbol_name),
                                        format!("fn {}(", symbol_name),
                                        format!("fn {}<", symbol_name),
                                        format!("func {}(", symbol_name),
                                        format!("func {}<", symbol_name),
                                        format!("function {}(", symbol_name),
                                        format!("function {} ", symbol_name),
                                        format!("def {}(", symbol_name),
                                        format!("def {}:", symbol_name),
                                        format!("interface {} ", symbol_name),
                                        format!("interface {}{{", symbol_name),
                                        format!("type {} ", symbol_name),
                                        format!("type {}=", symbol_name),
                                        format!("enum {} ", symbol_name),
                                        format!("enum {}{{", symbol_name),
                                        format!("const {} ", symbol_name),
                                        format!("const {}=", symbol_name),
                                        format!("let {} ", symbol_name),
                                        format!("var {} ", symbol_name),
                                        format!("export class {}", symbol_name),
                                        format!("export function {}", symbol_name),
                                        format!("export const {}", symbol_name),
                                        format!("export interface {}", symbol_name),
                                        format!("export type {}", symbol_name),
                                        format!("export enum {}", symbol_name),
                                    ];
                                    let found_line = content.lines().enumerate().find(|(_, line)| {
                                        let trimmed = line.trim();
                                        def_patterns.iter().any(|p| trimmed.contains(p.as_str()))
                                            || (trimmed.starts_with("export") && trimmed.contains(symbol_name.as_str()))
                                    });
                                    
                                    if found_line.is_some() {
                                        // Move the entire source file content
                                        if collected_file_ctx.is_none() {
                                            collected_file_ctx = Some(extract_file_context(&content, hint_file, &project));
                                        }
                                        extracted_code.push(content.clone());
                                        source_files_modified.insert(hint_file.clone());
                                        symbols_moved.push(serde_json::json!({
                                            "symbol": symbol_name,
                                            "from": hint_file,
                                            "to": target_file,
                                            "lines": format!("1-{}", content.lines().count()),
                                            "code_preview": if content.len() > 200 {
                                                format!("{}...", &content[..200])
                                            } else {
                                                content.clone()
                                            },
                                            "note": "Moved via source_file hint (symbol not in index)"
                                        }));
                                        continue;
                                    }
                                }
                            }
                            errors.push(serde_json::json!({
                                "symbol": symbol_name,
                                "error": "No definition found in index. Provide source_file (or from) \
                                          parameter to move symbols from files not yet indexed, or \
                                          use the original function/method name instead of a generated class name."
                            }));
                            continue;
                        }
                        Err(e) => {
                            if let Some(ref hint_file) = source_file_hint {
                                let hint_resolved = resolve_project_path(project_root, hint_file);
                                if let Ok(content) = std::fs::read_to_string(&hint_resolved) {
                                    if content.contains(symbol_name.as_str()) {
                                        if collected_file_ctx.is_none() {
                                            collected_file_ctx = Some(extract_file_context(&content, hint_file, &project));
                                        }
                                        extracted_code.push(content.clone());
                                        source_files_modified.insert(hint_file.clone());
                                        symbols_moved.push(serde_json::json!({
                                            "symbol": symbol_name,
                                            "from": hint_file,
                                            "to": target_file,
                                            "lines": format!("1-{}", content.lines().count()),
                                            "note": "Moved via source_file hint (index error)"
                                        }));
                                        continue;
                                    }
                                }
                            }
                            errors.push(serde_json::json!({
                                "symbol": symbol_name,
                                "error": format!(
                                    "Symbol not found: {}. Provide source_file (or from) parameter, \
                                     or re-index the file containing this symbol.",
                                    e
                                )
                            }));
                            continue;
                        }
                    };
                    
                    // Filter definitions to same language as target to prevent
                    // cross-language confusion (e.g., Go Context vs Python Context)
                    let filtered_defs: Vec<_> = if target_lang != atls_core::Language::Unknown {
                        usage.definitions.iter()
                            .filter(|d| {
                                let ext = std::path::Path::new(&d.file)
                                    .extension()
                                    .and_then(|e| e.to_str())
                                    .unwrap_or("");
                                let lang = atls_core::Language::from_extension(ext);
                                lang == target_lang || lang == atls_core::Language::Unknown
                            })
                            .collect()
                    } else {
                        usage.definitions.iter().collect()
                    };
                    let def = match filtered_defs.first() {
                        Some(d) => *d,
                        None => {
                            errors.push(serde_json::json!({
                                "symbol": symbol_name,
                                "error": format!(
                                    "No definition found for '{}' in {:?} files. Found in other languages only.",
                                    symbol_name, target_lang
                                )
                            }));
                            continue;
                        }
                    };
                    let source_file = &def.file;

                    if source_file == target_file || source_file.ends_with(target_file) || target_file.ends_with(source_file) {
                        // Symbol's definition is already in the target file â€” this is
                        // a no-op, not an error. Commonly happens when a prior move
                        // already relocated the symbol and the index reflects the new
                        // location. Report as a successful move (already completed).
                        symbols_moved.push(serde_json::json!({
                            "symbol": symbol_name,
                            "from": source_file,
                            "to": target_file,
                            "status": "already_at_target",
                            "note": "Symbol already exists at the target location; no action needed"
                        }));
                        continue;
                    }
                    
                    let range = match project.query().get_symbol_line_range(source_file, symbol_name) {
                        Ok(Some(r)) => r,
                        _ => {
                            errors.push(serde_json::json!({
                                "symbol": symbol_name,
                                "error": "Could not determine symbol boundaries"
                            }));
                            continue;
                        }
                    };
                    
                    let resolved_source = resolve_project_path(project_root, source_file);
                    let source_content = match std::fs::read_to_string(&resolved_source) {
                        Ok(c) => c,
                        Err(e) => {
                            errors.push(serde_json::json!({
                                "symbol": symbol_name,
                                "error": format!("Failed to read source: {}", e)
                            }));
                            continue;
                        }
                    };
                    
                    if collected_file_ctx.is_none() {
                        collected_file_ctx = Some(extract_file_context(&source_content, source_file, &project));
                    }

                    let lines: Vec<&str> = source_content.lines().collect();
                    let start_idx = std::cmp::min((range.start_line as usize).saturating_sub(1), lines.len());
                    let end_idx = std::cmp::min(range.end_line as usize, lines.len());
                    
                    let symbol_code: String = if start_idx < end_idx {
                        lines[start_idx..end_idx].join("\n")
                    } else {
                        String::new()
                    };

                    // Check if the target file already contains this symbol's code.
                    // This catches the case where source_file and target_file have
                    // different paths (e.g., relative vs absolute or different index
                    // entries) but the target already has the definition.
                    if target_exists {
                        let target_content_check = std::fs::read_to_string(&resolved_target).unwrap_or_default();
                        // Compare significant content: strip whitespace and check if
                        // the function/method signature is present in the target.
                        let sig_line = symbol_code.lines().next().unwrap_or("").trim();
                        if !sig_line.is_empty() && sig_line.len() >= 10 && target_content_check.contains(sig_line) {
                            symbols_moved.push(serde_json::json!({
                                "symbol": symbol_name,
                                "from": source_file,
                                "to": target_file,
                                "status": "already_at_target",
                                "note": "Symbol definition already exists in target file; no action needed"
                            }));
                            continue;
                        }
                    }

                    extracted_code.push(symbol_code.clone());
                    source_files_modified.insert(source_file.clone());
                    // Record the line range for auto-removal from source
                    source_removal_ranges.entry(source_file.clone())
                        .or_default()
                        .push((range.start_line, range.end_line));

                    // For Rust structs/enums/traits: also find and move associated impl blocks.
                    // These are separate top-level items that reference the moved type.
                    let is_rust_type = collected_file_ctx.as_ref()
                        .map(|c| c.language == atls_core::Language::Rust)
                        .unwrap_or(false)
                        && matches!(range.kind.as_str(), "struct" | "enum" | "trait" | "type");

                    let mut impl_blocks_moved: Vec<String> = Vec::new();
                    if is_rust_type {
                        // Scan source for `impl[<...>] SymbolName` or `impl[<...>] Trait for SymbolName`
                        // Also match generic forms: `impl<T> SymbolName<T>` and `impl<T> Trait for SymbolName<T>`
                        let impl_pattern_direct = format!("impl {}", symbol_name);
                        let impl_pattern_for = format!(" for {}", symbol_name);
                        let impl_pattern_generic = format!("impl<");
                        let mut i = 0;
                        while i < lines.len() {
                            let trimmed = lines[i].trim();
                            let is_impl = trimmed.starts_with(&impl_pattern_direct)
                                || (trimmed.starts_with("impl") && trimmed.contains(&impl_pattern_for))
                                || (trimmed.starts_with(&impl_pattern_generic) && (
                                    trimmed.contains(&format!("> {}", symbol_name))
                                    || trimmed.contains(&format!("> {} ", symbol_name))
                                    || trimmed.contains(&format!(" for {}", symbol_name))
                                ));
                            if is_impl {
                                // Find the matching closing brace, handling where-clauses
                                // that appear before the opening `{`.
                                let impl_start = i;
                                let mut brace_depth = 0i32;
                                let mut seen_open_brace = false;
                                let mut impl_end = i;
                                for j in i..lines.len() {
                                    for ch in lines[j].chars() {
                                        if ch == '{' {
                                            brace_depth += 1;
                                            seen_open_brace = true;
                                        }
                                        if ch == '}' { brace_depth -= 1; }
                                    }
                                    // Only terminate after we've entered the block body
                                    if seen_open_brace && brace_depth <= 0 {
                                        impl_end = j;
                                        break;
                                    }
                                }
                                // Safety: if we never saw an open brace, skip this candidate
                                if !seen_open_brace {
                                    i += 1;
                                    continue;
                                }
                                let impl_start_1 = (impl_start + 1) as u32;
                                let impl_end_1 = (impl_end + 1) as u32;
                                // Avoid double-counting if this overlaps the primary symbol range
                                if impl_start_1 > range.end_line || impl_end_1 < range.start_line {
                                    let impl_code: String = lines[impl_start..=impl_end].join("\n");
                                    extracted_code.push(impl_code.clone());
                                    impl_blocks_moved.push(format!("{}-{}", impl_start_1, impl_end_1));
                                    source_removal_ranges.entry(source_file.clone())
                                        .or_default()
                                        .push((impl_start_1, impl_end_1));
                                }
                                i = impl_end + 1;
                            } else {
                                i += 1;
                            }
                        }
                    }
                    
                    let mut moved_entry = serde_json::json!({
                        "symbol": symbol_name,
                        "from": source_file,
                        "to": target_file,
                        "lines": format!("{}-{}", range.start_line, range.end_line),
                        "code_preview": if symbol_code.len() > 200 {
                            format!("{}...", &symbol_code[..200])
                        } else {
                            symbol_code.clone()
                        }
                    });
                    if !impl_blocks_moved.is_empty() {
                        moved_entry.as_object_mut().unwrap().insert(
                            "impl_blocks_moved".to_string(),
                            serde_json::json!(impl_blocks_moved),
                        );
                    }
                    symbols_moved.push(moved_entry);
                    
                    for ref_loc in &usage.references {
                        if ref_loc.file != *source_file && ref_loc.file != target_file {
                            imports_updated.push(serde_json::json!({
                                "file": ref_loc.file,
                                "symbol": symbol_name,
                                "action": "update_import",
                                "from": source_file,
                                "to": target_file
                            }));
                        }
                    }
                }
                
                if symbols_moved.is_empty() {
                    return Ok(serde_json::json!({
                        "error": "No symbols could be moved",
                        "errors": errors,
                        "symbols_moved": []
                    }));
                }
                
                // Analyze missing dependencies for all moved symbols
                let move_dep_warnings = if let Some(ref ctx) = collected_file_ctx {
                    let all_moved_code = extracted_code.join("\n");
                    let first_source = source_files_modified.iter().next()
                        .map(|s| s.as_str())
                        .unwrap_or("");
                    analyze_missing_dependencies(
                        &all_moved_code,
                        first_source,
                        &symbol_names,
                        &project,
                        ctx.language,
                        Some(project_root),
                    )
                } else {
                    Vec::new()
                };

                // Auto-promote Go unexported symbols blocking the move
                let mut move_go_promotions: Vec<(String, String)> = Vec::new();
                if let Some(ref ctx) = collected_file_ctx {
                    if ctx.language == atls_core::Language::Go && !move_dep_warnings.is_empty() {
                        let unexported: Vec<String> = move_dep_warnings.iter()
                            .filter(|w| {
                                w.get("issue").and_then(|v| v.as_str())
                                    .map(|s| s.contains("unexported"))
                                    .unwrap_or(false)
                            })
                            .filter_map(|w| w.get("symbol").and_then(|v| v.as_str()).map(|s| s.to_string()))
                            .collect();
                        if !unexported.is_empty() {
                            if dry_run {
                                for s in &unexported {
                                    let new_name = format!("{}{}",
                                        s.chars().next().unwrap().to_uppercase(),
                                        &s[s.chars().next().unwrap().len_utf8()..],
                                    );
                                    move_go_promotions.push((s.clone(), new_name));
                                }
                            } else {
                                let first_src = source_files_modified.iter().next()
                                    .map(|s| resolve_project_path(project_root, s));
                                if let Some(src_path) = first_src {
                                    move_go_promotions = promote_go_symbol_visibility(
                                        &src_path, &unexported, project_root,
                                    );
                                }
                            }
                        }
                    }
                }

                if dry_run {
                    let mut result = serde_json::json!({
                        "dry_run": true,
                        "symbols_moved": symbols_moved,
                        "imports_to_update": imports_updated,
                        "target_file": target_file,
                        "target_exists": target_exists,
                        "errors": errors,
                        "_next": "Preview complete. Set dry_run:false to move symbols (imports auto-updated by default, set update_imports:false to skip)"
                    });
                    if !move_dep_warnings.is_empty() {
                        result.as_object_mut().unwrap().insert(
                            "missing_dependencies".to_string(),
                            serde_json::json!(move_dep_warnings),
                        );
                    }
                    if !move_go_promotions.is_empty() {
                        result.as_object_mut().unwrap().insert(
                            "go_promotions".to_string(),
                            serde_json::json!(move_go_promotions.iter().map(|(old, new)| {
                                serde_json::json!({"old": old, "new": new})
                            }).collect::<Vec<_>>()),
                        );
                    }
                    if create_delegation {
                        let target_mod = std::path::Path::new(target_file)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("");
                        let lang = collected_file_ctx.as_ref()
                            .map(|c| c.language)
                            .unwrap_or(atls_core::Language::Unknown);
                        let mut delegation_previews: Vec<serde_json::Value> = Vec::new();
                        for (i, code) in extracted_code.iter().enumerate() {
                            let sym_name = symbol_names.get(i).map(|s| s.as_str()).unwrap_or("");
                            if !sym_name.is_empty() {
                                if let Some(stub) = generate_delegation_stub(
                                    code, sym_name, target_mod, lang, project.parser_registry(),
                                ) {
                                    delegation_previews.push(serde_json::json!({
                                        "symbol": sym_name,
                                        "stub_preview": if stub.len() > 300 {
                                            format!("{}...", &stub[..300])
                                        } else {
                                            stub
                                        }
                                    }));
                                }
                            }
                        }
                        if !delegation_previews.is_empty() {
                            result.as_object_mut().unwrap().insert(
                                "delegation_stubs".to_string(),
                                serde_json::json!(delegation_previews),
                            );
                        }
                    }
                    return Ok(result);
                }
                
                // Apply the move
                // 1. Add extracted code to target file
                let target_content = if target_exists {
                    std::fs::read_to_string(&resolved_target).unwrap_or_default()
                } else {
                    String::new()
                };
                
                let new_target_content = if target_content.is_empty() {
                    // New file: prepend file context (namespace/imports) from source
                    let mut code_body = extracted_code.join("\n\n");
                    if let Some(ref ctx) = collected_file_ctx {
                        let target_ext = std::path::Path::new(target_file)
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or("");

                        // For Java/C#: copy instance field declarations referenced via this.field
                        // into the moved code to prevent undefined symbol lint errors.
                        // Only scan if the code actually contains "this." references.
                        if matches!(target_ext, "java" | "cs") && code_body.contains("this.") {
                            let mut field_names: Vec<String> = Vec::new();
                            // skip(1): the first element of split("this.") is text BEFORE the
                            // first "this." and does NOT contain a field name.
                            for part in code_body.split("this.").skip(1) {
                                if let Some(fname) = part.split(|c: char| !c.is_alphanumeric() && c != '_').next() {
                                    if !fname.is_empty()
                                        && fname.len() >= 2
                                        && !field_names.contains(&fname.to_string())
                                        && !symbol_names.iter().any(|n| n == fname)
                                    {
                                        field_names.push(fname.to_string());
                                    }
                                }
                            }

                            if !field_names.is_empty() {
                                // Query the source file for field declarations
                                let first_source = source_files_modified.iter().next()
                                    .map(|s| s.as_str())
                                    .unwrap_or("");
                                let source_path = resolve_project_path(project_root, first_source);
                                let source_text = std::fs::read_to_string(&source_path).unwrap_or_default();
                                let mut field_decls: Vec<String> = Vec::new();

                                for field_name in &field_names {
                                    // Try index lookup for field line range
                                    if let Ok(Some(frange)) = project.query().get_symbol_line_range(first_source, field_name) {
                                        if frange.kind == "field" || frange.kind == "variable" || frange.kind == "property" {
                                            let src_lines: Vec<&str> = source_text.lines().collect();
                                            let fs = std::cmp::min((frange.start_line as usize).saturating_sub(1), src_lines.len());
                                            let fe = std::cmp::min(frange.end_line as usize, src_lines.len());
                                            if fs < fe {
                                                let decl = src_lines[fs..fe].join("\n");
                                                if !decl.trim().is_empty() {
                                                    field_decls.push(format!("    {}", decl.trim()));
                                                }
                                            }
                                        }
                                    } else {
                                        // Fallback: scan source for common field declaration patterns
                                        for line in source_text.lines() {
                                            let trimmed = line.trim();
                                            if trimmed.contains(field_name.as_str())
                                                && !trimmed.starts_with("//")
                                                && !trimmed.starts_with("/*")
                                                && !trimmed.contains('(')
                                                && (trimmed.contains("private ")
                                                    || trimmed.contains("protected ")
                                                    || trimmed.contains("public ")
                                                    || trimmed.contains("final ")
                                                    || trimmed.contains("readonly "))
                                            {
                                                // Likely a field declaration line
                                                let decl = format!("    {}", trimmed);
                                                if !field_decls.contains(&decl) {
                                                    field_decls.push(decl);
                                                }
                                                break;
                                            }
                                        }
                                    }
                                }

                                if !field_decls.is_empty() {
                                    // Prepend field declarations before the method code
                                    let fields_block = field_decls.join("\n");
                                    code_body = format!("// Instance fields (copied from source)\n{}\n\n{}", fields_block, code_body);
                                }
                            }
                        }

                        // For move operations, include ALL imports from the source file.
                        // Missing imports cause compilation errors; extra imports only cause warnings.
                        // This is much safer than token-based filtering which can miss needed deps.
                        let mut all_imports = ctx.import_lines.clone();

                        // For Rust: rewrite self::/super:: imports and add crate::source_mod re-export
                        if target_ext == "rs" {
                            let first_source = source_files_modified.iter().next()
                                .map(|s| s.as_str())
                                .unwrap_or("");
                            let source_mod = derive_rust_module_name(first_source, project_root);
                            let target_mod = std::path::Path::new(target_file)
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("");
                            // Filter to only referenced imports first, then rewrite paths
                            let code_body_ref = &code_body;
                            let filtered = filter_imports_for_code(&all_imports, code_body_ref, ctx.language);
                            all_imports = rewrite_rust_imports_for_new_module(
                                &filtered,
                                &source_mod,
                                target_mod,
                                &symbol_names,
                            );
                        }

                        // For Java, derive the package declaration from the target file path
                        // since moving to a different directory changes the package.
                        let effective_package = if target_ext == "java" {
                            let new_pkg = derive_java_package_from_path(target_file);
                            // If moving to a different package, add an import for the original
                            // package's wildcard so types from the source package resolve.
                            if let (Some(ref orig_pkg), Some(ref new_p)) = (&ctx.package_decl, &new_pkg) {
                                let orig_pkg_name = orig_pkg.trim_start_matches("package ").trim_end_matches(';').trim();
                                let new_pkg_name = new_p.trim_start_matches("package ").trim_end_matches(';').trim();
                                if orig_pkg_name != new_pkg_name {
                                    let orig_import = format!("import {}.*;", orig_pkg_name);
                                    if !all_imports.iter().any(|i| i.contains(orig_pkg_name)) {
                                        all_imports.push(orig_import);
                                    }
                                }
                            }
                            new_pkg.or_else(|| ctx.package_decl.clone())
                        } else if target_ext == "go" {
                            // For Go, derive package name from target directory
                            let target_dir = std::path::Path::new(target_file)
                                .parent()
                                .and_then(|p| p.file_name())
                                .and_then(|n| n.to_str());
                            target_dir
                                .map(|d| format!("package {}", d))
                                .or_else(|| ctx.package_decl.clone())
                        } else {
                            ctx.package_decl.clone()
                        };

                        build_target_file_header(
                            target_ext,
                            effective_package.as_deref(),
                            &all_imports,
                            &code_body,
                            target_file,
                        )
                    } else {
                        code_body
                    }
                } else {
                    format!("{}\n\n{}", target_content, extracted_code.join("\n\n"))
                };
                
                // Create parent directories if needed
                if let Some(parent) = resolved_target.parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        return Ok(serde_json::json!({
                            "error": format!("Failed to create target directory: {}", e),
                            "symbols_moved": []
                        }));
                    }
                }
                
                if let Err(e) = std::fs::write(&resolved_target, &new_target_content) {
                    return Ok(serde_json::json!({
                        "error": format!("Failed to write target file: {}", e),
                        "symbols_moved": []
                    }));
                }
                
                // Build delegation stubs if requested, keyed by (source_file, start_line)
                let mut delegation_stubs: std::collections::HashMap<(String, u32), String> = std::collections::HashMap::new();
                if create_delegation {
                    let target_mod = std::path::Path::new(target_file)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    let lang = collected_file_ctx.as_ref()
                        .map(|c| c.language)
                        .unwrap_or(atls_core::Language::Unknown);
                    for (i, code) in extracted_code.iter().enumerate() {
                        let sym_name = symbol_names.get(i).map(|s| s.as_str()).unwrap_or("");
                        if !sym_name.is_empty() {
                            if let Some(stub) = generate_delegation_stub(
                                code, sym_name, target_mod, lang, project.parser_registry(),
                            ) {
                                // Find the source file and start line for this symbol
                                if let Some(src_file) = source_files_modified.iter().next() {
                                    if let Ok(Some(range)) = project.query().get_symbol_line_range(src_file, sym_name) {
                                        delegation_stubs.insert((src_file.clone(), range.start_line), stub);
                                    }
                                }
                            }
                        }
                    }
                }

                // Auto-remove moved symbols from source files (or replace with delegation stubs).
                // Removes the extracted line ranges and cleans up any resulting
                // blank-line clusters (collapses 3+ consecutive blank lines to 2).
                let mut source_removal_results: Vec<serde_json::Value> = Vec::new();
                for (src_file, mut ranges) in source_removal_ranges.drain() {
                    let resolved_src = resolve_project_path(project_root, &src_file);
                    if let Ok(src_content) = std::fs::read_to_string(&resolved_src) {
                        let src_lines: Vec<&str> = src_content.lines().collect();

                        // Merge overlapping/adjacent ranges before removal to prevent
                        // gaps that leave orphaned braces.
                        ranges.sort_by(|a, b| a.0.cmp(&b.0));
                        let mut merged: Vec<(u32, u32)> = Vec::new();
                        for (start, end) in &ranges {
                            if let Some(last) = merged.last_mut() {
                                if *start <= last.1 + 1 {
                                    last.1 = std::cmp::max(last.1, *end);
                                    continue;
                                }
                            }
                            merged.push((*start, *end));
                        }

                        let mut kept: Vec<bool> = vec![true; src_lines.len()];
                        for (start, end) in &merged {
                            let s = (*start as usize).saturating_sub(1);
                            let e = std::cmp::min(*end as usize, src_lines.len());
                            for idx in s..e {
                                kept[idx] = false;
                            }
                            // Also remove any immediately preceding blank/comment-only lines
                            // (JavaDoc, docstrings, etc.) that likely belong to the removed symbol.
                            if s > 0 {
                                let mut doc_start = s;
                                while doc_start > 0 {
                                    let prev = src_lines[doc_start - 1].trim();
                                    if prev.is_empty()
                                        || prev.starts_with("///")
                                        || prev.starts_with("//")
                                        || prev.starts_with('#')
                                        || prev.starts_with('*')
                                        || prev.starts_with("/**")
                                        || prev.starts_with("\"\"\"")
                                    {
                                        doc_start -= 1;
                                        kept[doc_start] = false;
                                    } else {
                                        break;
                                    }
                                }
                            }
                        }

                        // Post-pass: remove orphaned closing braces left behind when
                        // the body of a block was removed but the closing `}` fell just
                        // outside the recorded range.
                        for idx in 0..src_lines.len() {
                            if !kept[idx] {
                                continue;
                            }
                            let trimmed = src_lines[idx].trim();
                            if trimmed == "}" || trimmed == "};" {
                                // Check if the line immediately above is removed
                                let prev_removed = idx > 0 && !kept[idx - 1];
                                // Also check if the line immediately below is removed or end-of-file
                                let next_removed = idx + 1 >= src_lines.len() || !kept[idx + 1];
                                if prev_removed || next_removed {
                                    // Verify this brace is truly orphaned: scan upward
                                    // for a matching opening brace that's still kept.
                                    let mut has_open_brace = false;
                                    let mut depth = 0i32;
                                    for scan_idx in (0..idx).rev() {
                                        if !kept[scan_idx] { continue; }
                                        for ch in src_lines[scan_idx].chars() {
                                            if ch == '{' { depth += 1; }
                                            if ch == '}' { depth -= 1; }
                                        }
                                        if depth > 0 {
                                            has_open_brace = true;
                                            break;
                                        }
                                    }
                                    if !has_open_brace {
                                        kept[idx] = false;
                                    }
                                }
                            }
                        }

                        // When delegation stubs exist, replace the removed range with
                        // the stub instead of deleting; otherwise remove entirely.
                        let mut new_src_lines: Vec<String> = Vec::new();
                        let mut i = 0;
                        while i < src_lines.len() {
                            if !kept[i] {
                                // Check if this is the start of a range that has a delegation stub
                                let line_1indexed = (i + 1) as u32;
                                if let Some(stub) = delegation_stubs.get(&(src_file.clone(), line_1indexed)) {
                                    new_src_lines.push(stub.clone());
                                    // Skip all removed lines in this range
                                    while i < src_lines.len() && !kept[i] {
                                        i += 1;
                                    }
                                    continue;
                                }
                                i += 1;
                                continue;
                            }
                            new_src_lines.push(src_lines[i].to_string());
                            i += 1;
                        }
                        let new_src = new_src_lines.join("\n");

                        // Build an import line to add to the source so remaining code
                        // can still reference the moved symbol(s) from their new location.
                        let import_line = build_source_import_for_moved_symbols(
                            &src_file,
                            target_file,
                            &symbol_names,
                            collected_file_ctx.as_ref().map(|c| c.language)
                                .unwrap_or(atls_core::Language::Unknown),
                        );

                        // Insert the import after the last existing import in the source
                        let mut final_src = if let Some(ref imp_line) = import_line {
                            insert_import_line(&new_src, imp_line,
                                collected_file_ctx.as_ref().map(|c| c.language)
                                    .unwrap_or(atls_core::Language::Unknown))
                        } else {
                            new_src
                        };

                        // Collapse 3+ consecutive blank lines to at most 2
                        final_src = collapse_blank_lines(&final_src);

                        // If the source file has no substantive code left (only package
                        // declarations, imports, comments, and blanks), delete it entirely
                        // rather than leaving a broken empty file that fails lint.
                        // Handles Go grouped imports `import (...)`, Java/C# using blocks,
                        // and Python multi-line from/import.
                        let has_substantive_code = {
                            let mut in_grouped_import = false;
                            let mut found_substantive = false;
                            for line in final_src.lines() {
                                let t = line.trim();
                                if t.is_empty() { continue; }

                                // Track Go/Java grouped import blocks: `import (`
                                if (t.starts_with("import ") || t == "import") && t.ends_with('(') {
                                    in_grouped_import = true;
                                    continue;
                                }
                                if in_grouped_import {
                                    if t == ")" {
                                        in_grouped_import = false;
                                    }
                                    continue;
                                }

                                let is_boilerplate = t.starts_with("package ")
                                    || t.starts_with("import ")
                                    || t.starts_with("using ")
                                    || t.starts_with("from ")
                                    || t.starts_with("use ")
                                    || t.starts_with("pub use ")
                                    || t.starts_with("#include ")
                                    || t.starts_with("//")
                                    || t.starts_with("/*")
                                    || t.starts_with('*')
                                    || t.starts_with("*/")
                                    || t.starts_with('#')
                                    || t.starts_with("\"\"\"")
                                    || t.starts_with("'''")
                                    || t.starts_with("module ");
                                if !is_boilerplate {
                                    found_substantive = true;
                                    break;
                                }
                            }
                            found_substantive
                        };

                        if has_substantive_code {
                            if let Ok(()) = std::fs::write(&resolved_src, &final_src) {
                                // Clean up imports that are no longer needed after removal
                                let src_lang = collected_file_ctx.as_ref()
                                    .map(|c| c.language)
                                    .unwrap_or(atls_core::Language::Unknown);
                                cleanup_unused_imports(
                                    &resolved_src, src_lang, project.parser_registry(),
                                );
                                source_removal_results.push(serde_json::json!({
                                    "file": src_file,
                                    "status": "symbol_removed",
                                    "ranges_removed": ranges.iter().map(|(s, e)| format!("{}-{}", s, e)).collect::<Vec<_>>(),
                                    "import_added": import_line
                                }));
                            }
                        } else {
                            // Source file is effectively empty â€” delete it
                            let _ = std::fs::remove_file(&resolved_src);
                            source_removal_results.push(serde_json::json!({
                                "file": src_file,
                                "status": "file_deleted",
                                "reason": "No substantive code remaining after symbol removal"
                            }));
                        }
                    }
                }

                // For Rust: upgrade private symbols to pub(crate) and add mod declaration
                let mut move_mod_declaration: Option<String> = None;
                if let Some(ref ctx) = collected_file_ctx {
                    if ctx.language == atls_core::Language::Rust {
                        // Collect AST references from all moved code
                        let all_moved_code = extracted_code.join("\n");
                        let moved_refs = collect_rust_ast_references(
                            &all_moved_code, project.parser_registry(),
                        );
                        let moved_sym_set: std::collections::HashSet<&str> =
                            symbol_names.iter().map(|s| s.as_str()).collect();

                        for src in &source_files_modified {
                            let resolved_src = resolve_project_path(project_root, src);
                            upgrade_rust_visibility(
                                &resolved_src, &moved_refs, &moved_sym_set,
                            );
                            // Add mod declaration for new target file
                            let source_dir = resolved_src.parent().unwrap_or(project_root);
                            if let Some(msg) = ensure_rust_mod_declaration(
                                target_file, source_dir, project_root,
                            ) {
                                move_mod_declaration = Some(msg);
                            }
                        }
                    }
                }

                // Collect all modified files (target + sources)
                let mut move_modified_files: Vec<String> = vec![target_file.to_string()];
                for src in &source_files_modified {
                    if !move_modified_files.contains(src) {
                        move_modified_files.push(src.clone());
                    }
                }

                // Auto-update imports in referencing files
                let mut imports_actually_updated: Vec<serde_json::Value> = Vec::new();
                if update_imports && !imports_updated.is_empty() {
                    let target_lang = atls_core::Language::from_extension(
                        std::path::Path::new(target_file)
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or(""),
                    );

                    // Group import updates by file to batch edits
                    let mut updates_by_file: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();
                    for update_entry in &imports_updated {
                        if let (Some(file), Some(sym), Some(from)) = (
                            update_entry.get("file").and_then(|v| v.as_str()),
                            update_entry.get("symbol").and_then(|v| v.as_str()),
                            update_entry.get("from").and_then(|v| v.as_str()),
                        ) {
                            updates_by_file
                                .entry(file.to_string())
                                .or_default()
                                .push((sym.to_string(), from.to_string()));
                        }
                    }

                    for (ref_file, symbol_sources) in &updates_by_file {
                        let resolved_ref = resolve_project_path(project_root, ref_file);
                        let ref_content = match std::fs::read_to_string(&resolved_ref) {
                            Ok(c) => c,
                            Err(_) => continue,
                        };

                        let moved_sym_names: Vec<String> = symbol_sources.iter()
                            .map(|(s, _)| s.clone())
                            .collect();

                        // Build proper import for the target module
                        if let Some(new_import) = build_source_import_for_moved_symbols(
                            ref_file,
                            target_file,
                            &moved_sym_names,
                            target_lang,
                        ) {
                            // Skip if this import already exists (deduplication)
                            if ref_content.contains(new_import.trim()) {
                                continue;
                            }

                            // Remove old import lines referencing the source file for moved symbols
                            let old_stem = symbol_sources.first()
                                .map(|(_, from)| {
                                    std::path::Path::new(from.as_str())
                                        .file_stem()
                                        .and_then(|s| s.to_str())
                                        .unwrap_or("")
                                        .to_string()
                                })
                                .unwrap_or_default();

                            let mut updated_lines: Vec<String> = Vec::new();
                            for line in ref_content.lines() {
                                let t = line.trim();
                                let is_old_import = !old_stem.is_empty() && t.contains(&old_stem) && (
                                    t.starts_with("import ") || t.starts_with("from ") ||
                                    t.starts_with("use ") || t.starts_with("pub use ") ||
                                    t.starts_with("using ") || t.starts_with("#include ")
                                );
                                if !is_old_import {
                                    updated_lines.push(line.to_string());
                                }
                            }
                            let cleaned = updated_lines.join("\n");

                            // Insert new import
                            let with_import = insert_import_line(
                                &cleaned, &new_import, target_lang,
                            );

                            if with_import != ref_content {
                                if let Ok(()) = std::fs::write(&resolved_ref, &with_import) {
                                    imports_actually_updated.push(serde_json::json!({
                                        "file": ref_file,
                                        "status": "updated"
                                    }));
                                    if !move_modified_files.contains(ref_file) {
                                        move_modified_files.push(ref_file.clone());
                                    }
                                }
                            }
                        }
                    }
                }

                // Post-write syntax-only linting for the target file.
                // Full compilation lint (go build, javac, rustc) produces false positives
                // because it runs on the single extracted file in isolation, unable to
                // resolve same-package types, crate modules, or project-level imports.
                // Syntax-only lint catches malformed code (missing braces, bad tokens)
                // without requiring full project context.
                let lint_summary = if !move_modified_files.is_empty() {
                    let (_, summary) = lint_written_files_with_options(
                        project_root, &move_modified_files, true, false
                    );
                    summary
                } else {
                    None
                };
                let index_result = if !move_modified_files.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), move_modified_files.clone()).await
                } else {
                    serde_json::json!(null)
                };
                
                let mut move_result = serde_json::json!({
                    "dry_run": false,
                    "symbols_moved": symbols_moved,
                    "target_file": target_file,
                    "target_created": !target_exists,
                    "source_cleanup": source_removal_results,
                    "imports_to_update": imports_updated,
                    "mod_declaration": move_mod_declaration,
                    "errors": errors,
                    "lints": lint_summary,
                    "index": index_result,
                    "manual_steps": [
                        "Verify auto-updated imports are correct",
                        "Add exports to target file if needed"
                    ],
                    "_next": "Symbols moved and removed from source. Imports auto-updated."
                });
                if !move_dep_warnings.is_empty() {
                    move_result.as_object_mut().unwrap().insert(
                        "missing_dependencies".to_string(),
                        serde_json::json!(move_dep_warnings),
                    );
                }
                if !imports_actually_updated.is_empty() {
                    move_result.as_object_mut().unwrap().insert(
                        "imports_auto_updated".to_string(),
                        serde_json::json!(imports_actually_updated),
                    );
                }
                Ok(move_result)
            }
            "rename_symbol" => {
                // Rename a symbol across the codebase with language scoping,
                // word-boundary regex, stdlib protection, scoped rename, and auto-rollback.
                let raw_old_name = params
                    .get("old_name")
                    .and_then(|v| v.as_str())
                    .ok_or("old_name required for rename_symbol")?;
                
                let new_name = params
                    .get("new_name")
                    .and_then(|v| v.as_str())
                    .ok_or("new_name required for rename_symbol")?;
                
                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                // Scoped rename: support ClassName.MethodName syntax.
                // When old_name contains a dot (e.g., "ByteSize.Humanize"), auto-scope
                // the rename to files where the class is defined. This prevents renaming
                // unrelated methods with the same name across the entire project.
                let (class_scope_name, old_name): (Option<&str>, &str) = if raw_old_name.contains('.') {
                    let parts: Vec<&str> = raw_old_name.splitn(2, '.').collect();
                    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
                        (Some(parts[0]), parts[1])
                    } else {
                        (None, raw_old_name)
                    }
                } else {
                    (None, raw_old_name)
                };
                
                // Get scope: "project" or array of file paths
                let mut scope_files: Option<Vec<String>> = params
                    .get("scope")
                    .and_then(|v| {
                        if v.as_str() == Some("project") {
                            None
                        } else if let Some(arr) = v.as_array() {
                            Some(arr.iter()
                                .filter_map(|s| s.as_str().map(|s| s.to_string()))
                                .collect())
                        } else {
                            None
                        }
                    });

                // If ClassName.MethodName was provided, auto-scope to files containing the class
                if let Some(class_name) = class_scope_name {
                    if scope_files.is_none() {
                        if let Ok(class_usage) = project.query().get_symbol_usage(class_name) {
                            let class_files: Vec<String> = class_usage.definitions.iter()
                                .map(|d| d.file.clone())
                                .collect();
                            if !class_files.is_empty() {
                                let mut scope_set: std::collections::HashSet<String> =
                                    class_files.into_iter().collect();
                                for r in &class_usage.references {
                                    scope_set.insert(r.file.clone());
                                }
                                scope_files = Some(scope_set.into_iter().collect());
                            }
                        }
                    }
                }

                // Safety threshold for rename operations
                let max_replacements = params
                    .get("max_replacements")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(50) as usize;
                
                // Determine source language from file_path/source_file param to scope
                // the index query — avoids fetching cross-language rows entirely.
                let source_lang_hint: Option<String> = params
                    .get("file_path")
                    .or_else(|| params.get("source_file"))
                    .and_then(|v| v.as_str())
                    .and_then(|fp| {
                        let ext = std::path::Path::new(fp)
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or("");
                        let lang = atls_core::Language::from_extension(ext);
                        if lang == atls_core::Language::Unknown { None }
                        else { Some(lang.as_str().to_string()) }
                    });

                // Find all usages of the symbol — language-filtered when possible.
                let usage = match &source_lang_hint {
                    Some(lang) => project.query().get_symbol_usage_for_language(old_name, lang),
                    None => project.query().get_symbol_usage(old_name),
                };
                let usage = match usage {
                    Ok(u) => u,
                    Err(e) => {
                        return Ok(serde_json::json!({
                            "error": format!("Failed to find symbol: {}", e),
                            "old_name": old_name,
                            "files_modified": 0
                        }));
                    }
                };
                
                // --- Language scoping: determine the definition language ---
                // When source_lang_hint is set the query was already filtered; fall back
                // to the first definition's language for post-query filtering.
                let def_language: Option<String> = source_lang_hint.clone()
                    .or_else(|| usage.definitions.first().and_then(|d| d.language.clone()));
                
                let mut warnings: Vec<String> = Vec::new();
                
                // Collect all files that need changes, filtering by language + scope
                let mut files_to_update: std::collections::HashMap<String, Vec<u32>> = std::collections::HashMap::new();
                
                for def in &usage.definitions {
                    if let Some(ref scope) = scope_files {
                        if !scope.iter().any(|s| def.file.contains(s) || s.contains(&def.file)) {
                            continue;
                        }
                    }
                    // Language filter: skip definitions in other languages
                    if let (Some(ref target_lang), Some(ref def_lang)) = (&def_language, &def.language) {
                        if def_lang.to_lowercase() != target_lang.to_lowercase() {
                            warnings.push(format!(
                                "Skipped cross-language definition in {} ({}, target: {})",
                                def.file, def_lang, target_lang
                            ));
                            continue;
                        }
                    }
                    files_to_update.entry(def.file.clone()).or_default().push(def.line);
                }
                
                let mut filtered_ref_count: usize = 0;
                for ref_loc in &usage.references {
                    if let Some(ref scope) = scope_files {
                        if !scope.iter().any(|s| ref_loc.file.contains(s) || s.contains(&ref_loc.file)) {
                            continue;
                        }
                    }
                    // Language filter: skip references in other languages
                    if let (Some(ref target_lang), Some(ref ref_lang)) = (&def_language, &ref_loc.language) {
                        if ref_lang.to_lowercase() != target_lang.to_lowercase() {
                            warnings.push(format!(
                                "Skipped cross-language reference in {} ({}, target: {})",
                                ref_loc.file, ref_lang, target_lang
                            ));
                            continue;
                        }
                    }
                    filtered_ref_count += 1;
                    files_to_update.entry(ref_loc.file.clone()).or_default().push(ref_loc.line);
                }
                
                // Fallback: when index returns nothing, scan scope files (if provided)
                // or re-parse definition files with tree-sitter to recover from stale index.
                if files_to_update.is_empty() && usage.definitions.is_empty() {
                    if let Some(ref scope) = scope_files {
                        let old_name_bytes = old_name.as_bytes();
                        let word_re = regex::Regex::new(
                            &format!(r"\b{}\b", regex::escape(old_name))
                        ).ok();
                        for scope_path in scope.iter().take(20) {
                            let resolved = resolve_project_path(project_root, scope_path);
                            if !resolved.is_file() { continue; }
                            if let Ok(content) = std::fs::read_to_string(&resolved) {
                                if !content.as_bytes().windows(old_name_bytes.len())
                                    .any(|w| w == old_name_bytes) { continue; }
                                if let Some(ref re) = word_re {
                                    if re.is_match(&content) {
                                        let rel = resolved.strip_prefix(project_root)
                                            .unwrap_or(&resolved)
                                            .to_string_lossy()
                                            .replace('\\', "/");
                                        files_to_update.entry(rel).or_default();
                                        warnings.push(format!(
                                            "Symbol '{}' found via text search in {} (not in index)",
                                            old_name, scope_path
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }

                if files_to_update.is_empty() {
                    return Ok(serde_json::json!({
                        "warning": "No occurrences found (after language filtering)",
                        "old_name": old_name,
                        "new_name": new_name,
                        "files_modified": 0,
                        "cross_language_warnings": warnings,
                        "hint": "If the symbol was recently created, try re-indexing the project first",
                        "summary": {
                            "files_affected": 0,
                            "files_modified": 0,
                            "total_replacements": 0,
                            "definitions": usage.definitions.len(),
                            "references": filtered_ref_count,
                            "references_total": usage.references.len(),
                            "references_filtered": usage.references.len() - filtered_ref_count,
                            "language": def_language
                        }
                    }));
                }

                // Supplementary sibling-file search: the index may miss recently-created
                // files or cross-file references within the same package/module. Scan
                // directories containing definitions for additional files with the symbol.
                // Capped to avoid O(n*m) blowup on large codebases.
                {
                    let lang_extensions: &[&str] = match def_language.as_deref() {
                        Some("go") => &["go"],
                        Some("java") => &["java"],
                        Some("typescript") => &["ts", "tsx"],
                        Some("javascript") => &["js", "jsx"],
                        Some("rust") => &["rs"],
                        Some("python") => &["py"],
                        Some("csharp") => &["cs"],
                        Some("c") => &["c", "h"],
                        Some("cpp") | Some("c++") => &["cpp", "cc", "cxx", "h", "hpp"],
                        _ => &[],
                    };
                    // Skip sibling scan when index already found many files (large codebase)
                    if !lang_extensions.is_empty() && files_to_update.len() < 30 {
                        let def_dirs: std::collections::HashSet<std::path::PathBuf> =
                            usage.definitions.iter()
                                .filter_map(|d| {
                                    let p = resolve_project_path(project_root, &d.file);
                                    p.parent().map(|dir| dir.to_path_buf())
                                })
                                .collect();
                        let old_name_bytes = old_name.as_bytes();
                        let mut scanned = 0usize;
                        'dir_loop: for dir in &def_dirs {
                            if let Ok(entries) = std::fs::read_dir(dir) {
                                for entry in entries.flatten() {
                                    let path = entry.path();
                                    if !path.is_file() { continue; }
                                    let ext = path.extension()
                                        .and_then(|e| e.to_str())
                                        .unwrap_or("");
                                    if !lang_extensions.contains(&ext) { continue; }
                                    let rel = path.strip_prefix(project_root)
                                        .unwrap_or(&path)
                                        .to_string_lossy()
                                        .replace('\\', "/");
                                    if files_to_update.contains_key(&rel) { continue; }
                                    if let Some(ref scope) = scope_files {
                                        if !scope.iter().any(|s| rel.contains(s.as_str()) || s.contains(&rel)) {
                                            continue;
                                        }
                                    }
                                    // Buffered line-by-line search with early exit
                                    scanned += 1;
                                    if scanned > 200 { break 'dir_loop; } // Cap total files scanned
                                    if let Ok(file) = std::fs::File::open(&path) {
                                        use std::io::BufRead;
                                        let reader = std::io::BufReader::new(file);
                                        let mut found = false;
                                        for line in reader.lines().take(10_000) {
                                            if let Ok(l) = line {
                                                if l.as_bytes().windows(old_name_bytes.len())
                                                    .any(|w| w == old_name_bytes)
                                                {
                                                    found = true;
                                                    break;
                                                }
                                            }
                                        }
                                        if found {
                                            files_to_update.insert(rel, vec![]);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Build regex for word-boundary matching (prevents partial matches
                // like renaming "Write" inside "WriteHeader" or "io.Writer")
                let escaped = regex::escape(old_name);
                let rename_regex = match regex::Regex::new(&format!(r"\b{}\b", escaped)) {
                    Ok(r) => r,
                    Err(e) => {
                        return Ok(serde_json::json!({
                            "error": format!("Invalid symbol name for regex: {}", e),
                            "old_name": old_name
                        }));
                    }
                };
                
                // --- Stdlib / external reference protection ---
                // Detects qualified references to external packages (e.g., io.Write,
                // std::io::Write, fmt.Write) and skips them during replacement.
                let is_qualified_external_ref = |line: &str, name: &str, lang: Option<&str>| -> bool {
                    match lang {
                        Some("go") => {
                            // Go: pkg.Symbol -- skip if preceded by an import alias + dot
                            // e.g. "io.Write", "fmt.Write", "http.Write"
                            let dot_pattern = format!(".{}", name);
                            if let Some(pos) = line.find(&dot_pattern) {
                                if pos > 0 {
                                    let before = &line[..pos];
                                    let qualifier = before.rsplit(|c: char| !c.is_alphanumeric() && c != '_').next().unwrap_or("");
                                    if !qualifier.is_empty() && qualifier != "self" && qualifier != "this" {
                                        return true;
                                    }
                                }
                            }
                            false
                        }
                        Some("rust") => {
                            // Rust: path::Symbol -- skip if preceded by :: qualifier from
                            // external crate (std, core, alloc, or third-party)
                            let colon_pattern = format!("::{}", name);
                            if line.contains(&colon_pattern) {
                                // Check if this is a std/core/alloc/external path
                                for prefix in &["std::", "core::", "alloc::", "io::", "fmt::"] {
                                    if line.contains(prefix) {
                                        return true;
                                    }
                                }
                            }
                            false
                        }
                        Some("python") => {
                            // Python: module.Symbol
                            let dot_pattern = format!(".{}", name);
                            if let Some(pos) = line.find(&dot_pattern) {
                                if pos > 0 {
                                    let ch = line.as_bytes()[pos - 1];
                                    if (ch as char).is_alphanumeric() || ch == b'_' {
                                        return true;
                                    }
                                }
                            }
                            false
                        }
                        Some("typescript") | Some("javascript") => {
                            // TS/JS: module.Symbol
                            let dot_pattern = format!(".{}", name);
                            if let Some(pos) = line.find(&dot_pattern) {
                                if pos > 0 {
                                    let ch = line.as_bytes()[pos - 1];
                                    if (ch as char).is_alphanumeric() || ch == b'_' || ch == b'$' {
                                        return true;
                                    }
                                }
                            }
                            false
                        }
                        _ => false,
                    }
                };
                
                let lang_str = def_language.as_deref();

                // Lazy baseline lint: deferred until post-write lint detects errors.
                // Avoids expensive upfront linting of ALL candidate files (the #1
                // bottleneck causing 60s timeouts on large codebases like Gson).
                // Original file contents are cached in `original_contents` for rollback,
                // so we can always re-lint originals on demand.
                
                let mut results: Vec<serde_json::Value> = Vec::new();
                let mut files_modified = 0;
                let mut total_replacements = 0;
                let mut total_skipped = 0;
                let mut rename_modified_files: Vec<String> = Vec::new();
                // Store original content for rollback on lint failure
                let mut original_contents: std::collections::HashMap<String, (std::path::PathBuf, String)> = std::collections::HashMap::new();
                // Cache modified file contents to avoid re-reading during post-write lint
                let mut modified_contents: Vec<(String, String)> = Vec::new();
                
                for (file_path, lines) in &files_to_update {
                    let resolved_path = resolve_project_path(project_root, file_path);
                    
                    let content = match std::fs::read_to_string(&resolved_path) {
                        Ok(c) => c,
                        Err(e) => {
                            results.push(serde_json::json!({
                                "file": file_path,
                                "error": format!("Failed to read: {}", e),
                                "status": "error"
                            }));
                            continue;
                        }
                    };
                    
                    // Full-file word-boundary replacement with stdlib protection.
                    // Replaces ALL occurrences in each file (not line-scoped) because
                    // the index may miss internal call sites, causing cascading errors.
                    let file_lines: Vec<&str> = content.lines().collect();
                    let mut new_lines: Vec<String> = Vec::with_capacity(file_lines.len());
                    let mut replacement_count = 0;
                    let mut skipped_count = 0;
                    
                    for line in file_lines.iter() {
                        if rename_regex.is_match(line) {
                            if is_qualified_external_ref(line, old_name, lang_str) {
                                skipped_count += 1;
                                new_lines.push(line.to_string());
                            } else {
                                let replaced = rename_regex.replace_all(line, new_name);
                                let count = rename_regex.find_iter(line).count();
                                replacement_count += count;
                                new_lines.push(replaced.into_owned());
                            }
                        } else {
                            new_lines.push(line.to_string());
                        }
                    }
                    
                    // Preserve original trailing newline
                    let mut new_content = new_lines.join("\n");
                    if content.ends_with('\n') {
                        new_content.push('\n');
                    }
                    
                    total_skipped += skipped_count;
                    
                    if replacement_count == 0 {
                        results.push(serde_json::json!({
                            "file": file_path,
                            "lines": lines,
                            "status": "no_matches",
                            "skipped_external": skipped_count,
                            "note": if skipped_count > 0 {
                                "All matches were qualified external references (stdlib/package) -- skipped"
                            } else {
                                "Symbol found in index but not matched by word-boundary regex on target lines"
                            }
                        }));
                        continue;
                    }
                    
                    total_replacements += replacement_count;
                    
                    if dry_run {
                        results.push(serde_json::json!({
                            "file": file_path,
                            "lines": lines,
                            "replacements": replacement_count,
                            "skipped_external": skipped_count,
                            "status": "preview"
                        }));
                    } else {
                        // Store original for rollback
                        original_contents.insert(
                            file_path.clone(),
                            (resolved_path.clone(), content.clone()),
                        );
                        match crate::snapshot::atomic_write(&resolved_path, new_content.as_bytes()) {
                            Ok(()) => {
                                files_modified += 1;
                                rename_modified_files.push(file_path.clone());
                                modified_contents.push((file_path.clone(), new_content.clone()));
                                results.push(serde_json::json!({
                                    "file": file_path,
                                    "replacements": replacement_count,
                                    "skipped_external": skipped_count,
                                    "status": "applied"
                                }));
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "file": file_path,
                                    "error": e.to_string(),
                                    "status": "error"
                                }));
                            }
                        }
                    }
                }
                
                // Advisory: flag high replacement counts for user awareness but don't block.
                // Dry_run is for preview, delta-based rollback is for safety.
                if total_replacements > max_replacements {
                    warnings.push(format!(
                        "High replacement count: {} replacements across {} files. \
                         Consider using ClassName.MethodName syntax or scope parameter to narrow.",
                        total_replacements, files_modified
                    ));
                }

                // Post-write lint (reports but never blocks).
                // Uses syntax-only (tree-sitter) lint from in-memory content.
                // Renames are word-boundary text replacements â€” they cannot introduce
                // type errors or import issues, only structural syntax breakage.
                // syntax-only is 100x faster than full lint (no javac/csc/rustc invocations).
                let mut pre_existing_errors: usize = 0;
                let lint_summary = if !dry_run && !modified_contents.is_empty() {
                    let (lint_results, summary) = lint_file_contents(project_root, &modified_contents, true, false);
                    let post_error_count = lint_results.iter()
                        .filter(|r| r.severity == "error")
                        .count();
                    if post_error_count > 0 {
                        let original_for_lint: Vec<(String, String)> = original_contents.iter()
                            .map(|(path, (_, content))| (path.clone(), content.clone()))
                            .collect();
                        let (baseline_results, _) = lint_file_contents(project_root, &original_for_lint, true, false);
                        pre_existing_errors = baseline_results.iter()
                            .filter(|r| r.severity == "error")
                            .count();
                    }
                    summary
                } else {
                    None
                };
                
                // Lint reports but never blocks (no rollback)
                let rolled_back = false;
                let index_result = if !dry_run && !rename_modified_files.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), rename_modified_files.clone()).await
                } else {
                    serde_json::json!(null)
                };
                
                let mut rename_result = serde_json::json!({
                    "old_name": old_name,
                    "new_name": new_name,
                    "dry_run": dry_run,
                    "rolled_back": rolled_back,
                    "results": results,
                    "lints": lint_summary,
                    "index": index_result,
                    "cross_language_warnings": warnings,
                    "summary": {
                        "files_affected": files_to_update.len(),
                        "files_modified": if dry_run || rolled_back { 0 } else { files_modified },
                        "total_replacements": total_replacements,
                        "total_skipped_external": total_skipped,
                        "definitions": usage.definitions.len(),
                        "references": filtered_ref_count,
                        "references_total": usage.references.len(),
                        "references_filtered": usage.references.len() - filtered_ref_count,
                        "lints": lint_summary.as_ref().map(|s| s.total).unwrap_or(0),
                        "pre_existing_lint_errors": pre_existing_errors,
                        "language": def_language
                    },
                    "_next": if rolled_back {
                        "Rename rolled back due to excessive lint errors. Review warnings and fix the underlying issue."
                    } else if dry_run {
                        "Preview complete. Set dry_run:false to apply rename"
                    } else {
                        "Rename applied. Run q: v1 verify.typecheck to check for errors"
                    }
                });

                // Add class scope info if ClassName.MethodName was used
                if let Some(cls) = class_scope_name {
                    rename_result.as_object_mut().unwrap().insert(
                        "class_scope".to_string(),
                        serde_json::json!(cls),
                    );
                }

                // Advisory: flag high replacement counts in dry_run for user awareness
                if dry_run && total_replacements > 20 {
                    rename_result.as_object_mut().unwrap().insert(
                        "advisory".to_string(),
                        serde_json::json!(format!(
                            "{} replacements planned. Use ClassName.MethodName or scope parameter to narrow if this is broader than intended.",
                            total_replacements
                        )),
                    );
                }

                Ok(rename_result)
            }
            "create_and_edit" => {
                // Atomic operation: create files then apply edits
                let creates = params
                    .get("creates")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| {
                                let path = v.get("path")?.as_str()?.to_string();
                                let content = v.get("content")?.as_str()?.to_string();
                                Some((path, content))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                
                let ce_edits = params
                    .get("edits")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| {
                                let file = v.get("file")?.as_str()?.to_string();
                                let old = v.get("old")?.as_str()?.to_string();
                                let new_text = v.get("new")?.as_str()?.to_string();
                                Some((file, old, new_text))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                
                if creates.is_empty() && ce_edits.is_empty() {
                    return Err("At least one of creates or edits required for create_and_edit".to_string());
                }
                
                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                let mut created_files: Vec<String> = Vec::new();
                let mut edited_files: Vec<String> = Vec::new();
                let mut errors: Vec<serde_json::Value> = Vec::new();
                
                // In dry_run mode, just validate and preview
                if dry_run {
                    // Validate creates
                    for (path, _content) in &creates {
                        let resolved = resolve_project_path(project_root, path);
                        if resolved.exists() {
                            errors.push(serde_json::json!({
                                "operation": "create",
                                "path": path,
                                "error": "File already exists"
                            }));
                        } else {
                            created_files.push(path.clone());
                        }
                    }
                    
                    // Validate edits
                    for (file, old, _new) in &ce_edits {
                        let resolved = resolve_project_path(project_root, file);
                        match std::fs::read_to_string(&resolved).map(|c| normalize_line_endings(&c)) {
                            Ok(content) => {
                                let old_normalized = normalize_line_endings(old);
                                #[allow(deprecated)] // Read-only check, not a write path
                                if content.contains(&old_normalized) || flexible_replacen(&content, &old_normalized, "").is_some() {
                                    edited_files.push(file.clone());
                                } else {
                                    errors.push(serde_json::json!({
                                        "operation": "edit",
                                        "file": file,
                                        "error": "Pattern not found in file"
                                    }));
                                }
                            }
                            Err(e) => {
                                // Check if it's in creates list
                                if creates.iter().any(|(p, _)| p == file) {
                                    edited_files.push(file.clone());
                                } else {
                                    errors.push(serde_json::json!({
                                        "operation": "edit",
                                        "file": file,
                                        "error": format!("Cannot read: {}", e)
                                    }));
                                }
                            }
                        }
                    }
                    
                    return Ok(serde_json::json!({
                        "dry_run": true,
                        "creates_preview": created_files,
                        "edits_preview": edited_files,
                        "errors": errors,
                        "can_proceed": errors.is_empty(),
                        "_next": if errors.is_empty() {
                            "Validation passed. Set dry_run:false to apply"
                        } else {
                            "Fix errors before proceeding"
                        }
                    }));
                }
                
                // Apply creates first
                for (path, content) in &creates {
                    let resolved = resolve_project_path(project_root, path);
                    
                    // Create parent directories
                    if let Some(parent) = resolved.parent() {
                        if let Err(e) = std::fs::create_dir_all(parent) {
                            errors.push(serde_json::json!({
                                "operation": "create",
                                "path": path,
                                "error": format!("Failed to create directory: {}", e)
                            }));
                            continue;
                        }
                    }
                    let to_write = if is_js_ts_path(path) && content.contains("export ") {
                        dedupe_barrel_exports(content)
                    } else {
                        content.clone()
                    };
                    match std::fs::write(&resolved, &to_write) {
                        Ok(()) => created_files.push(path.clone()),
                        Err(e) => errors.push(serde_json::json!({
                            "operation": "create",
                            "path": path,
                            "error": e.to_string()
                        }))
                    }
                }
                
                // Apply edits
                for (file, old, new_text) in &ce_edits {
                    let resolved = resolve_project_path(project_root, file);
                    
                    // Normalize line endings for consistent matching
                    let content = match std::fs::read_to_string(&resolved).map(|c| normalize_line_endings(&c)) {
                        Ok(c) => c,
                        Err(e) => {
                            errors.push(serde_json::json!({
                                "operation": "edit",
                                "file": file,
                                "error": format!("Failed to read: {}", e)
                            }));
                            continue;
                        }
                    };
                    let old_normalized = normalize_line_endings(old);
                    let new_text_normalized = normalize_line_endings(new_text);
                    
                    let new_content = match exact_replacen_for_write(&content, &old_normalized, &new_text_normalized) {
                        Ok(Some((replaced, _line))) => replaced,
                        Ok(None) => {
                            let mut err = serde_json::json!({
                                "operation": "edit",
                                "file": file,
                                "error": "Pattern not found (exact match required)",
                                "error_class": "pattern_not_found",
                                "_next": "Re-read the file and retry with exact content from the fresh read"
                            });
                            if let Some(suggestion) = suggest_fuzzy_match(&content, &old_normalized, None) {
                                err["suggestion"] = suggestion;
                            }
                            errors.push(err);
                            continue;
                        }
                        Err(ambiguity) => {
                            errors.push(serde_json::json!({
                                "operation": "edit",
                                "file": file,
                                "error": ambiguity,
                                "error_class": "ambiguous_preimage"
                            }));
                            continue;
                        }
                    };
                    
                    match crate::snapshot::atomic_write(&resolved, new_content.as_bytes()) {
                        Ok(()) => edited_files.push(file.clone()),
                        Err(e) => errors.push(serde_json::json!({
                            "operation": "edit",
                            "file": file,
                            "error": e
                        }))
                    }
                }
                
                // Collect all modified files for lint + index
                let mut ce_all_modified: Vec<String> = Vec::new();
                for f in &created_files {
                    if !ce_all_modified.contains(f) { ce_all_modified.push(f.clone()); }
                }
                for f in &edited_files {
                    if !ce_all_modified.contains(f) { ce_all_modified.push(f.clone()); }
                }
                
                // Post-write linting and incremental indexing
                let lint_summary = if !ce_all_modified.is_empty() {
                    let (_, summary) = lint_written_files(project_root, &ce_all_modified);
                    summary
                } else {
                    None
                };
                let index_result = if !ce_all_modified.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), ce_all_modified.clone()).await
                } else {
                    serde_json::json!(null)
                };
                
                Ok(serde_json::json!({
                    "dry_run": false,
                    "created": created_files,
                    "edited": edited_files,
                    "errors": errors,
                    "lints": lint_summary,
                    "index": index_result,
                    "summary": {
                        "created_count": created_files.len(),
                        "edited_count": edited_files.len(),
                        "error_count": errors.len(),
                        "lints": lint_summary.as_ref().map(|s| s.total).unwrap_or(0)
                    },
                    "_next": if errors.is_empty() {
                        "All operations completed. Run q: v1 verify.typecheck to validate"
                    } else {
                        "Some operations failed. Check errors array"
                    }
                }))
            }
            "line_edits" => {
                let file_path = params.get("file").or_else(|| params.get("file_path"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "line_edits requires 'file' param".to_string())?
                    .to_string();
                let mut edits: Vec<LineEdit> = params.get("line_edits")
                    .or_else(|| params.get("edits"))
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                if edits.is_empty() {
                    return Err("line_edits requires non-empty line_edits array with {line, action, content?, count?}".to_string());
                }

                crate::resolve_line_edits_symbols_for_file(
                    project.query(),
                    project_root,
                    &file_path,
                    &mut edits,
                    false,
                )?;

                let lint_enabled = params.get("lint").and_then(|v| v.as_bool()).unwrap_or(true);
                let resolved_path = resolve_project_path(project_root, &file_path);
                let (content, file_format) = read_file_with_format(&resolved_path)
                    .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;

                let stale_policy = params.get("stale_policy")
                    .and_then(|v| v.as_str())
                    .unwrap_or("block");
                let mut edit_stale = false;
                let authority_warnings: Vec<serde_json::Value> = Vec::new();

                // Single hash derivation for staleness + old_hash via SnapshotService
                let ss_state = app.state::<crate::snapshot::SnapshotServiceState>();
                let mut snapshot_svc = ss_state.service.lock().await;
                let old_snap = snapshot_svc.snapshot_from_content(&file_path, &content, None);
                let old_hash = old_snap.snapshot_hash;

                if let Some(expected_hash) = params.get("content_hash").and_then(|v| v.as_str()) {
                    let authority_check = {
                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                        let registry = hr_state.registry.lock().await;
                        classify_snapshot_authority(&registry, &snapshot_svc, &file_path, expected_hash, &old_hash, &content)
                    };
                    match authority_check {
                        AuthorityCheck::Match => {}
                        AuthorityCheck::Forwarded => {
                            eprintln!(
                                "[edit] forwarded hash for {}: expected {}, actual {} — rejecting in mutation mode",
                                file_path, expected_hash, old_hash
                            );
                            return Ok(build_forwarded_hash_error(&file_path, expected_hash, &old_hash));
                        }
                        AuthorityCheck::AuthorityMismatch => {
                            eprintln!(
                                "[edit] authority_mismatch for {}: expected {}, actual {} — hard error",
                                file_path, expected_hash, old_hash
                            );
                            return Ok(build_authority_mismatch_error(
                                &file_path,
                                expected_hash,
                                &old_hash,
                                "current file bytes still match, but the caller supplied a non-canonical authority hash",
                            ));
                        }
                        AuthorityCheck::Stale => match stale_policy {
                            "follow_latest" | "warn" => {
                                eprintln!("[edit] Stale hash: expected {}, actual {} â€” proceeding per stale_policy={}",
                                    expected_hash, old_hash, stale_policy);
                                edit_stale = true;
                            }
                            _ => {
                                return Ok(serde_json::json!({
                                    "error": format!("stale_hash for {}: expected {}, actual {}. Re-read the file and retry.", file_path, expected_hash, old_hash),
                                    "error_class": "stale_hash",
                                    "expected_hash": canonicalize_expected_content_hash(expected_hash),
                                    "actual_hash": old_hash,
                                    "content_hash": old_hash,
                                    "stale_hash_root_cause": "file_bytes_changed",
                                    "_next": "Re-read the file with q: r1 read.context type:full file_paths:... to get a fresh hash, then retry",
                                }));
                            }
                        },
                    }
                }
                drop(snapshot_svc);

                // Shadow lookup for content-anchored edits when hash is stale
                let shadow_for_mutation: Option<String> = if edit_stale {
                    if let Some(expected_hash) = params.get("content_hash").and_then(|v| v.as_str()) {
                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                        let registry = hr_state.registry.lock().await;
                        let canonical = crate::snapshot::canonicalize_hash(expected_hash);
                        registry.get_original(&canonical).map(|entry| entry.content.clone())
                    } else {
                        None
                    }
                } else {
                    None
                };

                let (new_content, edit_warnings, line_edit_resolutions) = crate::apply_line_edits_with_shadow(
                    &edits,
                    &content,
                    shadow_for_mutation.as_deref(),
                )?;

                let strict_mode = params.get("refactor_validation_mode").and_then(|v| v.as_str()) == Some("strict");
                let structural_warnings: Vec<&String> = edit_warnings.iter()
                    .filter(|w| w.starts_with("move_structural_warning"))
                    .collect();
                if strict_mode && !structural_warnings.is_empty() {
                    return Ok(serde_json::json!({
                        "error": format!("Structural move warning (strict mode): {}", structural_warnings[0]),
                        "error_class": "move_structural_error",
                        "file": file_path,
                        "_next": "The move crosses a brace depth boundary and may silently break structure. Use explicit replace or refactor instead.",
                    }));
                }

                let mut written_content = new_content.clone();
                if is_js_ts_path(&file_path) && written_content.contains("export ") {
                    written_content = dedupe_barrel_exports(&written_content);
                }
                let mut snapshot_svc = ss_state.service.lock().await;
                let written_snap = snapshot_svc.snapshot_from_content(&file_path, &written_content, Some(&old_hash));
                let mut hash = written_snap.snapshot_hash;

                // Fix #9: Run behavior check before lint so warning is surfaced even when lint fails.
                let behavior_warning = if strict_mode {
                    check_behavior_change_heuristic(&content, &written_content)
                } else {
                    None
                };

                // Pre-write syntax gate: reject only NEW syntax errors introduced by the edit.
                // Baseline-aware: complex patterns (IIFE, destructuring defaults) that tree-sitter
                // already flagged in the original file are not counted against the edit.
                // Uses normalized message dedup (strips context suffix) so line-shifted
                // pre-existing errors are not falsely counted as new.
                if is_js_ts_path(&file_path) {
                    let root_str = project_root.to_string_lossy().to_string();
                    let post_errors = linter::syntax_check_ts_with_tsc_fallback(&file_path, &written_content, Some(&root_str));
                    if post_errors.iter().any(|e| e.severity == "error") {
                        let baseline_normalized: std::collections::HashSet<String> = linter::syntax_check_ts_with_tsc_fallback(&file_path, &content, Some(&root_str))
                            .iter()
                            .filter(|e| e.severity == "error")
                            .map(|e| linter::normalize_syntax_message_for_dedup(&e.message))
                            .collect();
                        let new_errors: Vec<&linter::LintResult> = post_errors.iter()
                            .filter(|e| e.severity == "error" && !baseline_normalized.contains(&linter::normalize_syntax_message_for_dedup(&e.message)))
                            .collect();
                        if !new_errors.is_empty() {
                            let msgs: Vec<String> = new_errors.iter()
                                .take(5)
                                .map(|e| e.message.to_string())
                                .collect();
                            let syntax_errors: Vec<&linter::LintResult> = new_errors.iter().take(5).copied().collect();
                            let mut err_json = serde_json::json!({
                                "error": format!("Syntax errors after edit in {}: {}", file_path, msgs.join("; ")),
                                "error_class": "syntax_error_after_edit",
                                "file": file_path,
                                "syntax_errors": syntax_errors,
                                "_next": "The edit produced invalid syntax. Fix the edit content and retry.",
                            });
                            if let Some(ref resolutions) = line_edit_resolutions {
                                let pre_bal = crate::syntax_error_bracket_hint(&content, &written_content, resolutions);
                                if let Some(hint) = pre_bal {
                                    err_json["_hint"] = serde_json::json!(hint);
                                }
                            }
                            return Ok(err_json);
                        }
                    }
                }

                // Pre-write check: disabled â€” writes are no longer blocked by lint errors
                // (was: abort on lint errors for brace languages; re-enable by restoring lint block)

                let bytes_to_write = serialize_with_format(&written_content, &file_format);
                crate::snapshot::atomic_write(&resolved_path, &bytes_to_write)
                    .map_err(|e| format!("Failed to write {}: {}", file_path, e))?;
                if let Some(formatted) = maybe_format_go_after_write(&resolved_path).await {
                    written_content = formatted;
                    let fmt_snap = snapshot_svc.record_write(&resolved_path, &file_path, &written_content, Some(&old_hash));
                    hash = fmt_snap.snapshot_hash;
                } else {
                    snapshot_svc.record_write(&resolved_path, &file_path, &written_content, Some(&old_hash));
                }
                drop(snapshot_svc);

                {
                    let hr_state = app.state::<hash_resolver::HashRegistryState>();
                    let mut registry = hr_state.registry.lock().await;
                    let lang = hash_resolver::detect_lang(Some(&file_path));
                    let line_count = written_content.lines().count();
                    registry.register(hash.clone(), hash_resolver::HashEntry {
                        source: Some(file_path.clone()),
                        content: written_content.clone(),
                        tokens: written_content.len() / 4,
                        lang,
                        line_count,
                        symbol_count: None,
                    });
                }
                let _ = app.emit(
                    "canonical_revision_changed",
                    serde_json::json!({
                        "path": file_path.replace('\\', "/"),
                        "revision": hash,
                        "previous_revision": old_hash
                    }),
                );

                let mut lint_summary = None;
                if lint_enabled {
                    let lint_options = linter::LintOptions {
                        root_path: project_root.to_string_lossy().to_string(),
                        use_native_parser: Some(true),
                        ..Default::default()
                    };
                    let mut lint_results = linter::lint_files(&[(file_path.clone(), written_content.clone())], &lint_options);
                    linter::enrich_lint_with_context(&mut lint_results, &file_path, &written_content);
                    if !lint_results.is_empty() {
                        lint_summary = Some(linter::create_lint_summary(&lint_results));
                    }
                }
                // Push to undo store for all successful line_edits (not just when lint errors)
                // so edit({undo:'h:HASH'}) can roll back even clean edits.
                let undo_state = app.state::<UndoStoreState>();
                let mut undo_store = undo_state.entries.lock().await;
                let stack = undo_store.entry(file_path.clone()).or_default();
                stack.push(UndoEntry {
                    hash: hash.clone(),
                    content: written_content.clone(),
                    parent_hash: None,
                    previous_content: Some(content.clone()),
                    previous_format: Some(file_format),
                    flushed_to_disk: true,
                    created_at: Instant::now(),
                });
                if stack.len() > UNDO_STORE_MAX_ENTRIES_PER_FILE {
                    stack.remove(0);
                }
                drop(undo_store);

                let hashes = vec![(hash.clone(), file_path.clone())];
                let next_hint = if let Some(ref summary) = lint_summary {
                    build_lint_fix_hint(summary, &hashes)
                } else {
                    "Applied. Run q: v1 verify.typecheck to validate".to_string()
                };
                let indexer = project.indexer().clone();
                // Lock already released at function entry
                let index_result = index_modified_files(&app, indexer.clone(), project_root_owned.clone(), vec![file_path.clone()]).await;
                let has_errors = lint_summary.as_ref()
                    .map(|s| s.by_severity.get("error").copied().unwrap_or(0) > 0)
                    .unwrap_or(false);
                let mut result = serde_json::json!({
                    "file": file_path,
                    "h": format!("h:{}", &hash[..hash_resolver::SHORT_HASH_LEN]),
                    "old_h": format!("h:{}", &old_hash[..hash_resolver::SHORT_HASH_LEN]),
                    "content_hash": hash,
                    "status": "applied",
                    "edits_applied": edits.len(),
                    "edits_resolved": serde_json::to_value(&line_edit_resolutions).unwrap_or_else(|_| serde_json::json!([])),
                    "lints": lint_summary,
                    "has_errors": has_errors,
                    "index": index_result,
                    "_next": next_hint
                });
                if let Some(ref warn) = behavior_warning {
                    result["_behavior_warning"] = serde_json::json!(warn);
                }
                if !structural_warnings.is_empty() {
                    result["_structural_warnings"] = serde_json::json!(
                        structural_warnings.iter().map(|w| w.as_str()).collect::<Vec<_>>()
                    );
                }
                if edit_stale {
                    result["stale"] = serde_json::json!(true);
                    result["edit_warnings"] = serde_json::json!([
                        build_draft_nonblocking_stale_warning(
                            &file_path,
                            params.get("content_hash").and_then(|v| v.as_str()).unwrap_or(""),
                            &old_hash,
                            "line_edits applied against current disk content despite stale hash",
                        )
                    ]);
                }
                if !authority_warnings.is_empty() {
                    result["authority_warnings"] = serde_json::json!(authority_warnings);
                }
                Ok(result)
            }
            "draft" => {
                let undo_state = app.state::<UndoStoreState>();
                let mut undo_store = undo_state.entries.lock().await;

                // Additive content collector: gather file pairs from all present input types.
                // Creates are collected first, then edits/line_edits layer on top.
                let mut file_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                let mut had_input = false;

                if let Some(creates) = params.get("creates").and_then(|v| v.as_array()) {
                    had_input = true;
                    let global_overwrite = params.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
                    for v in creates {
                        if let (Some(path), Some(content)) = (v.get("path").and_then(|p: &serde_json::Value| p.as_str()), v.get("content").and_then(|c| c.as_str())) {
                            let overwrite = v.get("overwrite").and_then(|ov| ov.as_bool()).unwrap_or(global_overwrite);
                            let resolved_path = resolve_project_path(project_root, path);
                            if resolved_path.exists() && !overwrite {
                                return Ok(serde_json::json!({
                                    "mode": "draft",
                                    "error": format!("create target already exists: {}", path),
                                    "error_class": "existing_file",
                                    "_next": "Choose a new path or retry with overwrite:true only if replacing the current file is intentional",
                                }));
                            }
                            let normalized_content = normalize_line_endings(content);
                            let to_insert = if is_js_ts_path(path) && normalized_content.contains("export ") {
                                dedupe_barrel_exports(&normalized_content)
                            } else {
                                normalized_content
                            };
                            file_map.insert(path.to_string(), to_insert);
                        }
                    }
                }

                let classify_draft_warning = |warning: &str| -> &'static str {
                    match warning {
                        "no_match" => "anchor_not_found",
                        "range_drifted" => "range_drifted",
                        "span_out_of_range" => "span_out_of_range",
                        "anchor_mismatch_after_refresh" => "anchor_mismatch_after_refresh",
                        "unresolved_hash" => "stale_hash",
                        _ => "unknown",
                    }
                };
                let classify_line_edit_error = |message: &str| -> &'static str {
                    if message.contains("invalid multiline anchor") {
                        "anchor_shape_invalid"
                    } else if message.contains("anchor is ambiguous") {
                        "anchor_ambiguous"
                    } else if message.contains("Overlapping line_edits") {
                        "overlapping_line_edits"
                    } else if message.contains("out of range") {
                        "line_out_of_range"
                    } else if message.contains("not found") {
                        "anchor_not_found"
                    } else {
                        "unknown"
                    }
                };
                let summarize_error_class = |warnings: &[serde_json::Value]| -> String {
                    let classes: Vec<&str> = warnings.iter()
                        .filter_map(|w| w.get("error_class").and_then(|v| v.as_str()))
                        .collect();
                    let has_anchor = classes.iter().any(|c| *c == "anchor_not_found");
                    let has_anchor_shape = classes.iter().any(|c| *c == "anchor_shape_invalid");
                    let has_anchor_ambiguous = classes.iter().any(|c| *c == "anchor_ambiguous");
                    let has_stale = classes.iter().any(|c| *c == "stale_hash");
                    let has_range_drifted = classes.iter().any(|c| *c == "range_drifted");
                    let has_span_out = classes.iter().any(|c| *c == "span_out_of_range");
                    let has_anchor_mismatch = classes.iter().any(|c| *c == "anchor_mismatch_after_refresh");
                    let has_overlap = classes.iter().any(|c| *c == "overlapping_line_edits");
                    let has_line_range = classes.iter().any(|c| *c == "line_out_of_range");
                    let mixed_classes = ["anchor_not_found", "anchor_shape_invalid", "anchor_ambiguous", "stale_hash", "range_drifted", "span_out_of_range", "anchor_mismatch_after_refresh", "overlapping_line_edits", "line_out_of_range"];
                    if (has_anchor && has_stale) || classes.iter().filter(|c| mixed_classes.contains(&**c)).count() > 1 {
                        "mixed".to_string()
                    } else if has_anchor_shape {
                        "anchor_shape_invalid".to_string()
                    } else if has_anchor_ambiguous {
                        "anchor_ambiguous".to_string()
                    } else if has_overlap {
                        "overlapping_line_edits".to_string()
                    } else if has_line_range {
                        "line_out_of_range".to_string()
                    } else if has_span_out {
                        "span_out_of_range".to_string()
                    } else if has_anchor_mismatch {
                        "anchor_mismatch_after_refresh".to_string()
                    } else if has_range_drifted {
                        "range_drifted".to_string()
                    } else if has_stale {
                        "stale_hash".to_string()
                    } else if has_anchor {
                        "anchor_not_found".to_string()
                    } else {
                        "unknown".to_string()
                    }
                };

                let mut edit_warnings: Vec<serde_json::Value> = Vec::new();
                if let Some(edits) = params.get("edits").and_then(|v| v.as_array()) {
                    had_input = true;
                    for edit_val in edits {
                        let mut file = edit_val.get("file")
                            .or_else(|| edit_val.get("file_path"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let old = normalize_line_endings(edit_val.get("old").and_then(|v| v.as_str()).unwrap_or(""));
                        let new_text = normalize_line_endings(edit_val.get("new").and_then(|v| v.as_str()).unwrap_or(""));
                        let edit_target_kind = edit_val.get("edit_target_kind").and_then(|v| v.as_str());
                        let edit_target_ref = edit_val.get("edit_target_ref").and_then(|v| v.as_str());
                        if file.is_empty() { continue; }
                        if edit_target_kind == Some("display_only") {
                            return Ok(serde_json::json!({
                                "mode": "draft",
                                "error": format!("edit target {} is display-only and not edit-safe", edit_target_ref.unwrap_or(&file)),
                                "error_class": "edit_target_not_edit_safe",
                                "_next": "Re-read an exact file or exact line span and retry with a file-backed edit target",
                            }));
                        }
                        let has_intermediate_base = file_map.contains_key(&file);
                        let expected_hash = edit_val.get("content_hash").and_then(|v| v.as_str());
                        let content_hash_refreshed = edit_val
                            .get("content_hash_refreshed")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        // Detect unresolved hash refs that slipped through resolution
                        if old.starts_with("h:") || new_text.starts_with("h:") || file.starts_with("h:") {
                            let warning = "unresolved_hash";
                            edit_warnings.push(serde_json::json!({
                                "file": file, "warning": warning,
                                "error_class": classify_draft_warning(warning),
                                "hint": "h: reference could not be resolved â€” hash may be evicted or stale"
                            }));
                        }
                        // For exact_span (explicit or inferred from edit_target_range), always resolve
                        // against full source from disk â€” spans are absolute line numbers in the real file buffer.
                        let mut base = if edit_target_kind == Some("exact_span") || edit_val.get("edit_target_range").is_some() {
                            match load_draft_base_content(project_root, &file) {
                                Ok((content, effective_path)) => {
                                    if effective_path != file { file = effective_path; }
                                    content
                                }
                                Err(err) => {
                                    return Ok(serde_json::json!({
                                        "mode": "draft",
                                        "error": err,
                                        "error_class": "target_read_failed",
                                        "_next": "Verify the file path still exists, then re-read the file before retrying the edit",
                                    }));
                                }
                            }
                        } else {
                            match file_map.get(&file).cloned() {
                                Some(existing) => existing,
                                None => match load_draft_base_content(project_root, &file) {
                                    Ok((content, effective_path)) => {
                                        if effective_path != file { file = effective_path; }
                                        content
                                    }
                                    Err(err) => {
                                        return Ok(serde_json::json!({
                                            "mode": "draft",
                                            "error": err,
                                            "error_class": "target_read_failed",
                                            "_next": "Verify the file path still exists, then re-read the file before retrying the edit",
                                        }));
                                    }
                                },
                            }
                        };
                        if !has_intermediate_base {
                            if let Some(expected_hash) = expected_hash {
                                let actual_hash = content_hash(&base);
                                let authority_check = {
                                    let ss_state = app.state::<crate::snapshot::SnapshotServiceState>();
                                    let snapshot_svc = ss_state.service.lock().await;
                                    let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                    let registry = hr_state.registry.lock().await;
                                    classify_snapshot_authority(&registry, &snapshot_svc, &file, expected_hash, &actual_hash, &base)
                                };
                                let edits_stale_policy = params.get("stale_policy")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("block");
                                if authority_check == AuthorityCheck::Forwarded {
                                    return Ok(build_forwarded_hash_error(&file, expected_hash, &actual_hash));
                                } else if authority_check == AuthorityCheck::AuthorityMismatch {
                                    return Ok(build_authority_mismatch_error(
                                        &file,
                                        expected_hash,
                                        &actual_hash,
                                        "draft rejected: the supplied hash referred to the same bytes through a non-canonical view",
                                    ));
                                } else if authority_check == AuthorityCheck::Stale && !content_hash_refreshed {
                                    match edits_stale_policy {
                                        "follow_latest" | "warn" => {
                                            edit_warnings.push(build_draft_nonblocking_stale_warning(
                                                &file,
                                                expected_hash,
                                                &actual_hash,
                                                "draft followed current file content instead of blocking on stale hash",
                                            ));
                                        }
                                        _ => {
                                            // Auto-retry: re-read from disk
                                            match load_draft_base_content(project_root, &file) {
                                                Ok((fresh, effective_path)) => {
                                                    if effective_path != file { file = effective_path; }
                                                    let fresh_hash = content_hash(&fresh);
                                                    if fresh_hash != actual_hash {
                                                        base = fresh;
                                                        edit_warnings.push(build_draft_nonblocking_stale_warning(
                                                            &file,
                                                            expected_hash,
                                                            &fresh_hash,
                                                            "stale_hash auto-retried: re-read file from disk and applying edits against fresh content",
                                                        ));
                                                    } else {
                                                        return Ok(serde_json::json!({
                                                            "mode": "draft",
                                                            "error": format!("stale_hash for {}: expected {}, actual {}. Re-read the file and retry.", file, expected_hash, actual_hash),
                                                            "error_class": "stale_hash",
                                                            "expected_hash": canonicalize_expected_content_hash(expected_hash),
                                                            "actual_hash": actual_hash,
                                                            "stale_hash_root_cause": "file_bytes_changed",
                                                            "_next": "Re-read the file with q: r1 read.context type:full file_paths:... to get a fresh hash, then retry",
                                                        }));
                                                    }
                                                }
                                                Err(_) => {
                                                    return Ok(serde_json::json!({
                                                        "mode": "draft",
                                                        "error": format!("stale_hash for {}: expected {}, actual {}. Re-read the file and retry.", file, expected_hash, actual_hash),
                                                        "error_class": "stale_hash",
                                                        "expected_hash": canonicalize_expected_content_hash(expected_hash),
                                                        "actual_hash": actual_hash,
                                                        "stale_hash_root_cause": "file_bytes_changed",
                                                        "_next": "Re-read the file with q: r1 read.context type:full file_paths:... to get a fresh hash, then retry",
                                                    }));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        let use_exact_span = edit_target_kind == Some("exact_span") || edit_val.get("edit_target_range").is_some();
                        let new_content = if use_exact_span {
                            let result = parse_exact_span_range(edit_val.get("edit_target_range"))
                                .map(|range| apply_exact_span_edit(&base, &old, &new_text, range));
                            match result {
                                Some(Ok(c)) => c,
                                Some(Err(ExactSpanError::SpanOutOfRange { start_line, end_line, line_count })) => {
                                    edit_warnings.push(serde_json::json!({
                                        "file": file, "warning": "span_out_of_range",
                                        "error_class": "span_out_of_range",
                                        "start_line": start_line, "end_line": end_line, "line_count": line_count,
                                        "hint": format!("span [{}-{}] outside file ({} lines) â€” re-read file and verify line numbers", start_line, end_line, line_count)
                                    }));
                                    base.to_string()
                                }
                                Some(Err(ExactSpanError::AnchorMismatch { hint })) => {
                                    let preview = if old.len() > 100 { format!("{}â€¦", &old[..100]) } else { old.to_string() };
                                    edit_warnings.push(serde_json::json!({
                                        "file": file, "warning": "anchor_mismatch_after_refresh",
                                        "error_class": "anchor_mismatch_after_refresh",
                                        "old_preview": preview,
                                        "hint": hint
                                    }));
                                    base.to_string()
                                }
                                None => {
                                    edit_warnings.push(serde_json::json!({
                                        "file": file, "warning": "span_out_of_range",
                                        "error_class": "span_out_of_range",
                                        "hint": "invalid or missing edit_target_range â€” provide [start_line, end_line] (1-based)"
                                    }));
                                    base.to_string()
                                }
                            }
                        } else {
                            match exact_replacen_for_write(&base, &old, &new_text) {
                                Ok(Some((replaced, _line))) => replaced,
                                Ok(None) => {
                                    let mut warn = serde_json::json!({
                                        "file": file,
                                        "warning": "pattern_not_found",
                                        "error_class": "pattern_not_found",
                                        "hint": "old text not found (exact match required)",
                                        "_next": "Re-read the file and retry with exact content"
                                    });
                                    if let Some(suggestion) = suggest_fuzzy_match(&base, &old, None) {
                                        warn["suggestion"] = suggestion;
                                    }
                                    edit_warnings.push(warn);
                                    base.to_string()
                                }
                                Err(ambiguity) => {
                                    edit_warnings.push(serde_json::json!({
                                        "file": file,
                                        "warning": "ambiguous_preimage",
                                        "error_class": "ambiguous_preimage",
                                        "hint": ambiguity,
                                    }));
                                    base.to_string()
                                }
                            }
                        };

                        if new_content == base {
                            // For exact_span, we may have already pushed a warning above (parse/apply failed).
                            if !use_exact_span {
                                let preview = if old.len() > 100 { format!("{}â€¦", &old[..100]) } else { old.to_string() };
                                let base_lines = base.lines().count();
                                let old_lines = old.lines().count();
                                let hint = format!(
                                    "old text ({} lines) not found in {} ({} lines). Content may have changed since hash was created. \
                                     Re-read the file and retry with current content.",
                                    old_lines, file, base_lines,
                                );
                                edit_warnings.push(serde_json::json!({
                                    "file": file,
                                    "warning": "no_match",
                                    "error_class": classify_draft_warning("no_match"),
                                    "old_preview": preview,
                                    "old_lines": old_lines,
                                    "file_lines": base_lines,
                                    "hint": hint,
                                }));
                            }
                            // Don't insert unchanged content â€” no draft for no-op edits
                        } else {
                            file_map.insert(file, new_content);
                        }
                    }
                }

                let mut symbol_errors: Vec<serde_json::Value> = Vec::new();
                let mut draft_line_edit_resolutions: Option<Vec<crate::EditResolution>> = None;
                if let Some(symbol_edits) = params.get("symbol_edits").and_then(|v| v.as_array()) {
                    had_input = true;
                    let lookup = QuerySymbolLookup { query: project.query() };
                    for se in symbol_edits {
                        let file = se.get("file").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let symbol = se.get("symbol").and_then(|v| v.as_str()).unwrap_or("");
                        let action = se.get("action").and_then(|v| v.as_str()).unwrap_or("replace");
                        let content = se.get("content").and_then(|v| v.as_str()).unwrap_or("");
                        if file.is_empty() || symbol.is_empty() {
                            symbol_errors.push(serde_json::json!({"file": file, "symbol": symbol, "error": "missing file or symbol param"}));
                            continue;
                        }
                        let resolved_path = resolve_project_path(project_root, &file);
                        let file_normalized = file.replace('\\', "/");
                        let file_lookup = normalize_for_lookup(&file, project_root);
                        let lookup_result = project.query().get_symbol_line_range(&file_lookup, symbol)
                            .or_else(|_| project.query().get_symbol_line_range(&file, symbol));
                        match lookup_result {
                            Ok(Some(range)) => {
                                let file_content = file_map.get(&file).cloned().unwrap_or_else(|| {
                                    std::fs::read_to_string(&resolved_path)
                                        .map(|c| normalize_line_endings(&c))
                                        .unwrap_or_default()
                                });
                                let lines: Vec<&str> = file_content.lines().collect();
                                let start_idx = (range.start_line as usize).saturating_sub(1);
                                let end_idx = std::cmp::min(range.end_line as usize, lines.len());
                                let symbol_lines: Vec<&str> = lines[start_idx..end_idx].to_vec();
                                let scope = se.get("scope").and_then(|v| v.as_str()).unwrap_or(
                                    match action { "wrap" => "inner", _ => "outer" }
                                );
                                let wrapper = se.get("wrapper").and_then(|v| v.as_str());
                                let target = se.get("target").and_then(|v| v.as_str());
                                match apply_symbol_edit_action(
                                    &symbol_lines, action, content, scope, wrapper, target,
                                    &lines, start_idx, end_idx,
                                    Some(&lookup as &dyn SymbolLookup), &file_normalized,
                                ) {
                                    Ok(symbol_result) => {
                                        let new_lines: Vec<String> = if action == "move" {
                                            symbol_result
                                        } else {
                                            let mut nl: Vec<String> = Vec::new();
                                            for line in lines.iter().take(start_idx) { nl.push(line.to_string()); }
                                            nl.extend(symbol_result);
                                            for line in lines.iter().skip(end_idx) { nl.push(line.to_string()); }
                                            nl
                                        };
                                        file_map.insert(file, new_lines.join("\n"));
                                    }
                                    Err(e) => {
                                        symbol_errors.push(serde_json::json!({"file": file, "symbol": symbol, "action": action, "error": e.to_string(), "hint": "use line_edits with symbol anchor instead"}));
                                        continue;
                                    }
                                }
                            }
                            Ok(None) => {
                                symbol_errors.push(serde_json::json!({"file": file, "symbol": symbol, "error": "symbol not found in index", "hint": "use line_edits with symbol anchor or re-index file"}));
                                continue;
                            }
                            Err(e) => {
                                symbol_errors.push(serde_json::json!({"file": file, "symbol": symbol, "error": format!("index lookup failed: {}", e), "hint": "use line_edits with symbol anchor instead"}));
                                continue;
                            }
                        }
                    }
                }

                if let Some(_le_arr) = params.get("line_edits").and_then(|v| v.as_array()) {
                    had_input = true;
                    let mut file_path = params.get("file").or_else(|| params.get("file_path"))
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "line_edits requires 'file' param".to_string())?
                        .to_string();
                    let edit_target_kind = params.get("edit_target_kind").and_then(|v| v.as_str());
                    let edit_target_ref = params.get("edit_target_ref").and_then(|v| v.as_str());
                    if edit_target_kind == Some("display_only") {
                        return Ok(serde_json::json!({
                            "mode": "draft",
                            "error": format!("line_edits target {} is display-only and not edit-safe", edit_target_ref.unwrap_or(&file_path)),
                            "error_class": "edit_target_not_edit_safe",
                            "_next": "Re-read an exact file or exact line span and retry with a file-backed edit target",
                        }));
                    }
                    let mut le: Vec<LineEdit> = params.get("line_edits")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    if le.is_empty() {
                        return Err("line_edits requires non-empty line_edits array".to_string());
                    }
                    crate::resolve_line_edits_symbols_for_file(
                        project.query(),
                        project_root,
                        &file_path,
                        &mut le,
                        true,
                    )?;
                    let draft_stale_policy = params.get("stale_policy")
                        .and_then(|v| v.as_str())
                        .unwrap_or("block");
                    let mut base = match file_map.get(&file_path).cloned() {
                        Some(existing) => existing,
                        None => match load_draft_base_content(project_root, &file_path) {
                            Ok((content, effective_path)) => {
                                if effective_path != file_path { file_path = effective_path; }
                                content
                            }
                            Err(err) => {
                                return Ok(serde_json::json!({
                                    "mode": "draft",
                                    "error": err,
                                    "error_class": "target_read_failed",
                                    "_next": "Verify the file path still exists, then re-read the file before retrying line_edits",
                                }));
                            }
                        },
                    };
                    if let Some(expected_hash) = params.get("content_hash").and_then(|v| v.as_str()) {
                        let actual_hash = content_hash(&base);
                        let authority_check = {
                            let ss_state = app.state::<crate::snapshot::SnapshotServiceState>();
                            let snapshot_svc = ss_state.service.lock().await;
                            let hr_state = app.state::<hash_resolver::HashRegistryState>();
                            let registry = hr_state.registry.lock().await;
                            classify_snapshot_authority(&registry, &snapshot_svc, &file_path, expected_hash, &actual_hash, &base)
                        };
                        match authority_check {
                            AuthorityCheck::Match => {}
                            AuthorityCheck::Forwarded => {
                                return Ok(build_forwarded_hash_error(&file_path, expected_hash, &actual_hash));
                            }
                            AuthorityCheck::AuthorityMismatch => {
                                return Ok(build_authority_mismatch_error(
                                    &file_path,
                                    expected_hash,
                                    &actual_hash,
                                    "draft rejected: the supplied hash referred to the same bytes through a non-canonical view",
                                ));
                            }
                            AuthorityCheck::Stale => match draft_stale_policy {
                                "follow_latest" | "warn" => {
                                    edit_warnings.push(build_draft_nonblocking_stale_warning(
                                        &file_path,
                                        expected_hash,
                                        &actual_hash,
                                        "draft followed current file content and applied line_edits against latest anchors",
                                    ));
                                }
                                _ => {
                                    // Auto-retry: re-read from disk and apply against fresh content
                                    match load_draft_base_content(project_root, &file_path) {
                                        Ok((fresh, effective_path)) => {
                                            if effective_path != file_path { file_path = effective_path; }
                                            let fresh_hash = content_hash(&fresh);
                                            if fresh_hash != actual_hash {
                                                base = fresh;
                                                edit_warnings.push(build_draft_nonblocking_stale_warning(
                                                    &file_path,
                                                    expected_hash,
                                                    &fresh_hash,
                                                    "stale_hash auto-retried: re-read file from disk and applying line_edits against fresh content",
                                                ));
                                            } else {
                                                return Ok(serde_json::json!({
                                                    "mode": "draft",
                                                    "error": format!("stale_hash for {}: expected {}, actual {}. Re-read the file and retry.", file_path, expected_hash, actual_hash),
                                                    "error_class": "stale_hash",
                                                    "expected_hash": canonicalize_expected_content_hash(expected_hash),
                                                    "actual_hash": actual_hash,
                                                    "stale_hash_root_cause": "file_bytes_changed",
                                                    "_next": "Re-read the file with q: r1 read.context type:full file_paths:... to get a fresh hash, then retry",
                                                }));
                                            }
                                        }
                                        Err(_) => {
                                            return Ok(serde_json::json!({
                                                "mode": "draft",
                                                "error": format!("stale_hash for {}: expected {}, actual {}. Re-read the file and retry.", file_path, expected_hash, actual_hash),
                                                "error_class": "stale_hash",
                                                "expected_hash": canonicalize_expected_content_hash(expected_hash),
                                                "actual_hash": actual_hash,
                                                "stale_hash_root_cause": "file_bytes_changed",
                                                "_next": "Re-read the file with q: r1 read.context type:full file_paths:... to get a fresh hash, then retry",
                                            }));
                                        }
                                    }
                                }
                            },
                        }
                    }
                    // Content-anchored edit path: when the model's content_hash is stale
                    // and we have the shadow (preimage) content, convert line edits into
                    // ExactReplace ops that EditSession matches by content, not position.
                    // This makes line-number rebasing irrelevant for correctness.
                    let content_hash_refreshed = params.get("content_hash_refreshed")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    let shadow_for_edit: Option<String> = if !content_hash_refreshed {
                        if let Some(expected_hash) = params.get("content_hash").and_then(|v| v.as_str()) {
                            let actual_hash = content_hash(&base);
                            let expected_canonical = crate::snapshot::canonicalize_hash(expected_hash);
                            if actual_hash != expected_canonical {
                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                let registry = hr_state.registry.lock().await;
                                let canonical = crate::snapshot::canonicalize_hash(expected_hash);
                                registry.get_original(&canonical)
                                    .map(|entry| entry.content.clone())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    let (new_content, edits_resolved) = match crate::apply_line_edits_with_shadow(
                        &le,
                        &base,
                        shadow_for_edit.as_deref(),
                    ) {
                        Ok((content, warnings, resolutions)) => {
                            for w in warnings {
                                edit_warnings.push(serde_json::json!({
                                    "file": file_path,
                                    "warning": "line_edit_notice",
                                    "error_class": "line_edit_notice",
                                    "hint": w,
                                }));
                            }
                            (content, resolutions)
                        }
                        Err(edit_err) => {
                            let error_class = classify_line_edit_error(&edit_err);
                            let next_hint = match error_class {
                                "overlapping_line_edits" => "Make line_edits non-overlapping, or re-read the file and retry with narrower anchors",
                                "line_out_of_range" => "Re-read the latest file content and retry with current anchors or line ranges",
                                "anchor_not_found" => "Re-read the target file with q: r1 read.context type:full file_paths:..., then retry with current anchors",
                                _ => "Re-read the target file and retry with current anchors or old text",
                            };
                            return Ok(serde_json::json!({
                                "mode": "draft",
                                "error": edit_err,
                                "error_class": error_class,
                                "_next": next_hint,
                                "_retry_payload": {
                                    "file_paths": [file_path],
                                    "strategy": "read_shaped_sig_then_retry",
                                }
                            }));
                        }
                    };
                    if let Some(resolutions) = edits_resolved {
                        draft_line_edit_resolutions = Some(resolutions);
                    }
                    let to_insert = if is_js_ts_path(&file_path) && new_content.contains("export ") {
                        dedupe_barrel_exports(&new_content)
                    } else {
                        new_content
                    };
                    file_map.insert(file_path, to_insert);
                }

                if !had_input {
                    return Err("edit requires creates, edits, or line_edits".to_string());
                }

                let files: Vec<(String, String)> = file_map.into_iter().collect();

                let edit_warnings = dedup_edit_warnings(edit_warnings);

                if files.is_empty() {
                    if !edit_warnings.is_empty() {
                        let error_class = summarize_error_class(&edit_warnings);
                        let retry_files: Vec<String> = edit_warnings.iter()
                            .filter_map(|w| w.get("file").and_then(|v| v.as_str()).map(|s| s.to_string()))
                            .collect();
                        return Ok(serde_json::json!({
                            "mode": "draft",
                            "error": "all_edits_failed",
                            "error_class": error_class,
                            "edit_warnings": edit_warnings,
                            "_next": "Re-read the target file with q: r1 read.context type:full file_paths:..., then retry with correct old text",
                            "_retry_payload": {
                                "file_paths": retry_files,
                                "strategy": "read_shaped_sig_then_retry",
                            }
                        }));
                    }
                    if !symbol_errors.is_empty() {
                        return Ok(serde_json::json!({
                            "mode": "draft",
                            "error": "symbol_edits_failed",
                            "error_class": "symbol_edit_failed",
                            "symbol_errors": symbol_errors,
                            "_next": "Use line_edits with exact symbol anchors or re-index the file before retrying symbol edits",
                        }));
                    }
                    return Ok(serde_json::json!({
                        "mode": "draft",
                        "error": "no_files_produced_for_draft",
                        "error_class": "no_files_produced_for_draft",
                        "_next": "No draft files were produced — all edits, creates, and line_edits either failed to match or were no-ops. \
                                  Re-read the target with read.shaped(sig) + read.lines for targeted edits, or q: r1 read.context type:full file_paths:... for broad changes, then retry with exact content from the fresh read.",
                    }));
                }

                let auto_flush = params.get("auto_flush").and_then(|v| v.as_bool()).unwrap_or(true);
                let deep_check = params.get("deep_check").and_then(|v| v.as_bool()).unwrap_or(false);

                let lint_options = linter::LintOptions {
                    root_path: project_root.to_string_lossy().to_string(),
                    syntax_only: Some(!deep_check),
                    use_native_parser: Some(deep_check),
                    ..Default::default()
                };
                let mut all_lint_results = linter::lint_files(&files.iter().map(|(p, c)| (p.clone(), c.clone())).collect::<Vec<_>>(), &lint_options);
                let mut draft_results: Vec<serde_json::Value> = Vec::new();
                let mut all_hashes: Vec<(String, String)> = Vec::new();
                let mut file_format_map: std::collections::HashMap<String, FileFormat> = std::collections::HashMap::new();

                // Single-pass hash derivation via SnapshotService (eliminates draft double-hash)
                let ss_state = app.state::<crate::snapshot::SnapshotServiceState>();
                let mut snapshot_svc = ss_state.service.lock().await;
                for (file_path, content) in &files {
                    let snap = snapshot_svc.snapshot_from_content(file_path, content, None);
                    let hash = snap.snapshot_hash;
                    linter::enrich_lint_with_context(&mut all_lint_results, file_path, content);
                    let (prev, prev_format) = {
                        let rp = resolve_project_path(project_root, file_path);
                        read_file_with_format(&rp).ok().map(|(s, f)| {
                            file_format_map.insert(file_path.clone(), f);
                            (Some(s), Some(f))
                        }).unwrap_or((None, None))
                    };
                    let old_hash = prev.as_ref().map(|p| {
                        let s = snapshot_svc.snapshot_from_content(file_path, p, None);
                        s.snapshot_hash
                    });
                    {
                        let stack = undo_store.entry(file_path.clone()).or_default();
                        stack.push(UndoEntry {
                            hash: hash.clone(),
                            content: content.clone(),
                            parent_hash: old_hash.clone(),
                            previous_content: prev,
                            previous_format: prev_format,
                            flushed_to_disk: false,
                            created_at: Instant::now(),
                        });
                        if stack.len() > UNDO_STORE_MAX_ENTRIES_PER_FILE {
                            stack.remove(0);
                        }
                    }
                    all_hashes.push((hash.clone(), file_path.clone()));
                    let mut entry = serde_json::json!({
                        "file": file_path,
                        "hash": hash,
                        "content_hash": hash,
                        "lines": content.lines().count(),
                    });
                    if let Some(ref oh) = old_hash {
                        if *oh != hash {
                            let old_short = format!("h:{}", &oh[..std::cmp::min(8, oh.len())]);
                            let new_short = format!("h:{}", &hash[..std::cmp::min(8, hash.len())]);
                            entry["old_h"] = serde_json::json!(old_short);
                            entry["h"] = serde_json::json!(new_short);
                            let diff_ref = format!("{}..{}", old_short, new_short);
                            entry["diff_ref"] = serde_json::json!(diff_ref);
                            entry["q"] = serde_json::json!(format!("\"Changes: {}\" — UI renders colored diff", diff_ref));
                        }
                    }
                    draft_results.push(entry);
                }
                drop(snapshot_svc);

                // Register hashes in HashRegistry so peek/chain work immediately
                {
                    let hr_state = app.state::<hash_resolver::HashRegistryState>();
                    let mut registry = hr_state.registry.lock().await;
                    for (file_path, content) in &files {
                        let hash = content_hash(content);
                        let lang = hash_resolver::detect_lang(Some(file_path.as_str()));
                        let line_count = content.lines().count();
                        let prev_rev = registry.get_current_revision(file_path);
                        registry.register(hash.clone(), hash_resolver::HashEntry {
                            source: Some(file_path.clone()),
                            content: content.clone(),
                            tokens: content.len() / 4,
                            lang,
                            line_count,
                            symbol_count: None,
                        });
                        if file_path.contains('/') || file_path.contains('\\') {
                            let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                "path": file_path,
                                "revision": hash,
                                "previous_revision": prev_rev
                            }));
                        }
                    }
                }

                let lint_summary = if !all_lint_results.is_empty() {
                    Some(linter::create_lint_summary(&all_lint_results))
                } else {
                    None
                };

                // Auto-flush: write to disk with pre-write syntax gate (baseline-aware + tsc fallback)
                if auto_flush {
                    let root_str = project_root.to_string_lossy().to_string();
                    for (fp_check, content_check) in &files {
                        if is_js_ts_path(fp_check) {
                            let post_errors = linter::syntax_check_ts_with_tsc_fallback(fp_check, content_check, Some(&root_str));
                            if post_errors.iter().any(|e| e.severity == "error") {
                                let resolved = resolve_project_path(project_root, fp_check);
                                let baseline_normalized: std::collections::HashSet<String> = std::fs::read_to_string(&resolved)
                                    .ok()
                                    .map(|orig| {
                                        linter::syntax_check_ts_with_tsc_fallback(fp_check, &orig, Some(&root_str))
                                            .iter()
                                            .filter(|e| e.severity == "error")
                                            .map(|e| linter::normalize_syntax_message_for_dedup(&e.message))
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let new_errors: Vec<String> = post_errors.iter()
                                    .filter(|e| e.severity == "error" && !baseline_normalized.contains(&linter::normalize_syntax_message_for_dedup(&e.message)))
                                    .take(5)
                                    .map(|e| e.message.to_string())
                                    .collect();
                                if !new_errors.is_empty() {
                                    return Ok(serde_json::json!({
                                        "error": format!("Syntax errors after edit in {}: {}", fp_check, new_errors.join("; ")),
                                        "error_class": "syntax_error_after_edit",
                                        "file": fp_check,
                                        "_next": "The edit produced invalid syntax. Fix the edit content and retry.",
                                    }));
                                }
                            }
                        }
                    }
                    let mut written: Vec<String> = Vec::new();
                    let mut write_errors: Vec<serde_json::Value> = Vec::new();
                    let mut formatted_updates: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();
                    let mut behavior_warnings: Vec<String> = Vec::new();
                    let strict_validation = params.get("refactor_validation_mode").and_then(|v| v.as_str()) == Some("strict");
                    for (file_path, content) in &files {
                        let resolved_path = resolve_project_path(project_root, file_path);
                        if strict_validation {
                            if let Ok(old_content) = std::fs::read_to_string(&resolved_path).map(|c| normalize_line_endings(&c)) {
                                if let Some(warn) = check_behavior_change_heuristic(&old_content, content) {
                                    behavior_warnings.push(format!("{}: {}", file_path, warn));
                                }
                            }
                        }
                        if let Some(parent) = resolved_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let bytes_to_write = file_format_map
                            .get(file_path)
                            .map(|fmt| serialize_with_format(content, fmt))
                            .or_else(|| {
                                if resolved_path.exists() {
                                    read_file_with_format(&resolved_path)
                                        .ok()
                                        .map(|(_, fmt)| serialize_with_format(content, &fmt))
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_else(|| content.as_bytes().to_vec());
                        match crate::snapshot::atomic_write(&resolved_path, &bytes_to_write) {
                            Ok(()) => {
                                if let Some(formatted) = maybe_format_go_after_write(&resolved_path).await {
                                    let formatted_hash = content_hash(&formatted);
                                    formatted_updates.insert(file_path.clone(), (formatted_hash, formatted));
                                }
                                written.push(file_path.clone());
                            }
                            Err(e) => {
                                write_errors.push(serde_json::json!({
                                    "file": file_path,
                                    "error": e,
                                }));
                            }
                        }
                    }
                    if !formatted_updates.is_empty() {
                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                        let mut registry = hr_state.registry.lock().await;
                        for (file_path, (formatted_hash, formatted_content)) in &formatted_updates {
                            let lang = hash_resolver::detect_lang(Some(file_path));
                            registry.register(formatted_hash.clone(), hash_resolver::HashEntry {
                                source: Some(file_path.clone()),
                                content: formatted_content.clone(),
                                tokens: formatted_content.len() / 4,
                                lang,
                                line_count: formatted_content.lines().count(),
                                symbol_count: None,
                            });
                        }
                    }
                    for (hash, fp) in &mut all_hashes {
                        if let Some((formatted_hash, _)) = formatted_updates.get(fp) {
                            *hash = formatted_hash.clone();
                        }
                    }
                    for draft in &mut draft_results {
                        let file = draft.get("file").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                        if let Some((formatted_hash, formatted_content)) = formatted_updates.get(&file) {
                            draft["hash"] = serde_json::json!(formatted_hash);
                            draft["lines"] = serde_json::json!(formatted_content.lines().count());
                            let new_short = format!("h:{}", &formatted_hash[..std::cmp::min(8, formatted_hash.len())]);
                            draft["h"] = serde_json::json!(new_short.clone());
                            if let Some(old_short) = draft.get("old_h").and_then(|v| v.as_str()) {
                                let diff_ref = format!("{}..{}", old_short, new_short);
                                draft["diff_ref"] = serde_json::json!(diff_ref.clone());
                                draft["q"] = serde_json::json!(format!("\"Changes: {}\" — UI renders colored diff", diff_ref));
                            }
                        }
                    }
                    // Mark flushed entries (retain for undo) — only files that actually wrote
                    let written_set: std::collections::HashSet<&String> = written.iter().collect();
                    for (_, fp) in &all_hashes {
                        if !written_set.contains(fp) {
                            continue;
                        }
                        if let Some(stack) = undo_store.get_mut(fp) {
                            if let Some(entry) = stack.last_mut() {
                                if let Some((formatted_hash, formatted_content)) = formatted_updates.get(fp) {
                                    entry.hash = formatted_hash.clone();
                                    entry.content = formatted_content.clone();
                                }
                                entry.flushed_to_disk = true;
                            }
                        }
                    }
                    drop(undo_store);
                    let index_result = if !written.is_empty() {
                        let indexer = project.indexer().clone();
                        // Lock already released at function entry
                        index_modified_files(&app, indexer.clone(), project_root_owned.clone(), written.clone()).await
                    } else {
                        serde_json::json!(null)
                    };
                    let mut has_errors = lint_summary.as_ref()
                        .map(|s| s.by_severity.get("error").copied().unwrap_or(0) > 0)
                        .unwrap_or(false);
                    if !write_errors.is_empty() {
                        has_errors = true;
                    }
                    let next_hint = if !write_errors.is_empty() && written.is_empty() {
                        format!(
                            "{} file write(s) failed. See write_errors.",
                            write_errors.len()
                        )
                    } else if !write_errors.is_empty() {
                        "Some files failed to write — see write_errors. Others written. Run verify when ready.".to_string()
                    } else {
                        "Written to disk. Run q: v1 verify.typecheck to validate".to_string()
                    };
                    let mut result = serde_json::json!({
                        "mode": "draft+written",
                        "drafts": draft_results,
                        "lints": lint_summary,
                        "has_errors": has_errors,
                        "written": written,
                        "index": index_result,
                        "_next": next_hint
                    });
                    if !write_errors.is_empty() {
                        result["write_errors"] = serde_json::json!(write_errors);
                    }
                    if !write_errors.is_empty() && written.is_empty() {
                        let msg = write_errors
                            .iter()
                            .filter_map(|v| v.get("error").and_then(|e| e.as_str()))
                            .take(3)
                            .collect::<Vec<_>>()
                            .join("; ");
                        result["error"] = serde_json::json!(format!(
                            "All {} file write(s) failed. {}",
                            write_errors.len(),
                            if msg.is_empty() { "See write_errors.".to_string() } else { msg }
                        ));
                        result["error_class"] = serde_json::json!("write_failed");
                    }
                    if !symbol_errors.is_empty() {
                        result["symbol_errors"] = serde_json::json!(symbol_errors);
                        result["_symbol_hint"] = serde_json::json!("symbol_edits are deprecated. Use line_edits with symbol anchors instead.");
                    }
                    if !edit_warnings.is_empty() {
                        result["edit_warnings"] = serde_json::json!(edit_warnings);
                    }
                    if let Some(ref er) = draft_line_edit_resolutions {
                        result["edits_resolved"] = serde_json::to_value(er).unwrap_or_else(|_| serde_json::json!([]));
                    }
                    if !behavior_warnings.is_empty() {
                        result["_behavior_warnings"] = serde_json::json!(behavior_warnings);
                    }
                    return Ok(result);
                }

                let next_hint = if let Some(ref summary) = lint_summary {
                    build_lint_fix_hint(summary, &all_hashes)
                } else {
                    "Clean (buffered). Use q: e1 change.edit flush:... to write".to_string()
                };

                let has_errors = lint_summary.as_ref()
                    .map(|s| s.by_severity.get("error").copied().unwrap_or(0) > 0)
                    .unwrap_or(false);
                let mut result = serde_json::json!({
                    "mode": "draft",
                    "drafts": draft_results,
                    "lints": lint_summary,
                    "has_errors": has_errors,
                    "buffer_size": undo_store.values().map(|s| s.len()).sum::<usize>(),
                    "_next": next_hint
                });
                if !symbol_errors.is_empty() {
                    result["symbol_errors"] = serde_json::json!(symbol_errors);
                    result["_symbol_hint"] = serde_json::json!("symbol_edits are deprecated. Use line_edits with symbol anchors instead.");
                }
                if !edit_warnings.is_empty() {
                    result["edit_warnings"] = serde_json::json!(edit_warnings);
                }
                if let Some(ref er) = draft_line_edit_resolutions {
                    result["edits_resolved"] = serde_json::to_value(er).unwrap_or_else(|_| serde_json::json!([]));
                }
                Ok(result)
            }
            "revise" => {
                let hash_ref_raw = params.get("hash").or_else(|| params.get("revise"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "revise requires 'hash' param (content hash from draft/revise)".to_string())?
                    .to_string();
                let hash_ref = extract_hash_for_edit_ref(&hash_ref_raw);
                let edits: Vec<LineEdit> = params.get("line_edits")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                if edits.is_empty() {
                    return Err("revise requires non-empty line_edits array".to_string());
                }

                let undo_state = app.state::<UndoStoreState>();
                let mut undo_store = undo_state.entries.lock().await;

                let (old_hash, entry_file_path, old_content, old_previous_content, old_previous_format) = {
                    let mut found = None;
                    for (_fp, stack) in undo_store.iter() {
                        for entry in stack.iter().rev() {
                            if entry.hash == hash_ref || entry.hash.starts_with(&hash_ref) || hash_ref.starts_with(&entry.hash) {
                                found = Some((
                                    entry.hash.clone(),
                                    _fp.clone(),
                                    entry.content.clone(),
                                    entry.previous_content.clone(),
                                    entry.previous_format.clone(),
                                ));
                                break;
                            }
                        }
                        if found.is_some() { break; }
                    }
                    found.ok_or_else(|| format!("Hash '{}' not found in undo store. Use draft to create content first. Pass only the hash (e.g. h:6169ed), not the full '[edit result] h:X â†’ path' string.", hash_ref_raw))?
                };

                let (new_content, _warnings, _resolutions) = apply_line_edits(&old_content, &edits)?;
                let mut written_content = new_content.clone();
                let mut new_hash = content_hash(&written_content);
                let file_path = entry_file_path.clone();
                let deep_check = params.get("deep_check").and_then(|v| v.as_bool()).unwrap_or(false);

                let lint_options = linter::LintOptions {
                    root_path: project_root.to_string_lossy().to_string(),
                    syntax_only: Some(!deep_check),
                    use_native_parser: Some(deep_check),
                    ..Default::default()
                };
                let mut lint_results = linter::lint_files(&[(file_path.clone(), written_content.clone())], &lint_options);
                linter::enrich_lint_with_context(&mut lint_results, &file_path, &written_content);

                let auto_flush = params.get("auto_flush").and_then(|v| v.as_bool()).unwrap_or(true);
                let lint_summary = if !lint_results.is_empty() {
                    Some(linter::create_lint_summary(&lint_results))
                } else {
                    None
                };
                let mut line_count = written_content.lines().count();

                // Auto-flush: write to disk with baseline-aware pre-write syntax gate
                // Uses normalized message dedup (strips context suffix) for consistency
                // with the line_edits syntax gate.
                if auto_flush {
                    if is_js_ts_path(&file_path) {
                        let root_str = project_root.to_string_lossy().to_string();
                        let post_errors = linter::syntax_check_ts_with_tsc_fallback(&file_path, &written_content, Some(&root_str));
                        if post_errors.iter().any(|e| e.severity == "error") {
                            let baseline_normalized: std::collections::HashSet<String> = linter::syntax_check_ts_with_tsc_fallback(&file_path, &old_content, Some(&root_str))
                                .iter()
                                .filter(|e| e.severity == "error")
                                .map(|e| linter::normalize_syntax_message_for_dedup(&e.message))
                                .collect();
                            let new_errors: Vec<String> = post_errors.iter()
                                .filter(|e| e.severity == "error" && !baseline_normalized.contains(&linter::normalize_syntax_message_for_dedup(&e.message)))
                                .take(5)
                                .map(|e| e.message.to_string())
                                .collect();
                            if !new_errors.is_empty() {
                                return Ok(serde_json::json!({
                                    "error": format!("Syntax errors after edit in {}: {}", file_path, new_errors.join("; ")),
                                    "error_class": "syntax_error_after_edit",
                                    "file": file_path,
                                    "_next": "The edit produced invalid syntax. Fix the edit content and retry.",
                                }));
                            }
                        }
                    }
                    let resolved_path = resolve_project_path(project_root, &file_path);
                    if let Some(parent) = resolved_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let fmt = old_previous_format.unwrap_or_else(|| {
                        read_file_with_format(&resolved_path)
                            .map(|(_, f)| f)
                            .unwrap_or_default()
                    });
                    let bytes_to_write = serialize_with_format(&written_content, &fmt);
                    let write_result = crate::snapshot::atomic_write(&resolved_path, &bytes_to_write);
                    let write_err_msg = write_result.err();
                    let write_ok = write_err_msg.is_none();
                    if write_ok {
                        if let Some(formatted) = maybe_format_go_after_write(&resolved_path).await {
                            written_content = formatted;
                            new_hash = content_hash(&written_content);
                            line_count = written_content.lines().count();
                        }
                    }
                    // Push new flushed entry onto undo stack (retain for undo)
                    {
                        let stack = undo_store.entry(entry_file_path.clone()).or_default();
                        stack.push(UndoEntry {
                            hash: new_hash.clone(),
                            content: written_content.clone(),
                            parent_hash: Some(old_hash.clone()),
                            previous_content: old_previous_content.clone(),
                            previous_format: old_previous_format,
                            flushed_to_disk: write_ok,
                            created_at: Instant::now(),
                        });
                        if stack.len() > UNDO_STORE_MAX_ENTRIES_PER_FILE {
                            stack.remove(0);
                        }
                    }
                    drop(undo_store);
                    if write_ok {
                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                        let mut registry = hr_state.registry.lock().await;
                        let lang = hash_resolver::detect_lang(Some(&file_path));
                        registry.register(new_hash.clone(), hash_resolver::HashEntry {
                            source: Some(file_path.clone()),
                            content: written_content.clone(),
                            tokens: written_content.len() / 4,
                            lang,
                            line_count,
                            symbol_count: None,
                        });
                        if file_path.contains('/') || file_path.contains('\\') {
                            let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                "path": file_path,
                                "revision": new_hash.clone(),
                                "previous_revision": old_hash.clone(),
                            }));
                        }
                    }
                    let index_result = if write_ok {
                        let indexer = project.indexer().clone();
                        // Lock already released at function entry
                        index_modified_files(&app, indexer.clone(), project_root_owned.clone(), vec![file_path.clone()]).await
                    } else {
                        serde_json::json!(null)
                    };
                    let new_short = format!("h:{}", &new_hash[..std::cmp::min(8, new_hash.len())]);
                    let old_short = format!("h:{}", &old_hash[..std::cmp::min(8, old_hash.len())]);
                    let diff_ref = format!("{}..{}", old_short, new_short);
                    let mut revise_obj = serde_json::json!({
                        "mode": "revise+written",
                        "hash": new_hash.clone(),
                        "parent_hash": old_hash.clone(),
                        "file": file_path,
                        "lines": line_count,
                        "lints": lint_summary,
                        "written": write_ok,
                        "content_hash": new_hash.clone(),
                        "source_revision": new_hash.clone(),
                        "h": new_short,
                        "old_h": old_short,
                        "diff_ref": diff_ref,
                        "index": index_result,
                        "_next": if write_ok {
                            "Written to disk. Run q: v1 verify.typecheck to validate"
                        } else {
                            "Disk write failed — see write_errors"
                        }
                    });
                    if !write_ok {
                        if let Some(ref err) = write_err_msg {
                            revise_obj["error"] = serde_json::json!(format!("Failed to write {}: {}", file_path, err));
                            revise_obj["error_class"] = serde_json::json!("write_failed");
                            revise_obj["write_errors"] = serde_json::json!(vec![serde_json::json!({
                                "file": file_path,
                                "error": err,
                            })]);
                        }
                    }
                    return Ok(revise_obj);
                }

                // Errors present or auto_flush disabled: keep in undo store for revision
                {
                    let stack = undo_store.entry(entry_file_path.clone()).or_default();
                    stack.push(UndoEntry {
                        hash: new_hash.clone(),
                        content: written_content.clone(),
                        parent_hash: Some(old_hash.clone()),
                        previous_content: old_previous_content,
                        previous_format: old_previous_format,
                        flushed_to_disk: false,
                        created_at: Instant::now(),
                    });
                    if stack.len() > UNDO_STORE_MAX_ENTRIES_PER_FILE {
                        stack.remove(0);
                    }
                }

                let hashes = vec![(new_hash.clone(), file_path.clone())];
                let next_hint = if let Some(ref summary) = lint_summary {
                    build_lint_fix_hint(summary, &hashes)
                } else {
                    "Clean (buffered). Use q: e1 change.edit flush:... to write".to_string()
                };
                let new_short = format!("h:{}", &new_hash[..std::cmp::min(8, new_hash.len())]);
                let old_short = format!("h:{}", &old_hash[..std::cmp::min(8, old_hash.len())]);
                let diff_ref = format!("{}..{}", old_short, new_short);

                Ok(serde_json::json!({
                    "mode": "revise",
                    "hash": new_hash.clone(),
                    "parent_hash": old_hash.clone(),
                    "file": file_path,
                    "lines": line_count,
                    "content_hash": new_hash.clone(),
                    "source_revision": new_hash.clone(),
                    "h": new_short,
                    "old_h": old_short,
                    "diff_ref": diff_ref,
                    "lints": lint_summary,
                    "_next": next_hint
                }))
            }
            "flush" => {
                let hash_list: Vec<String> = params.get("flush")
                    .or_else(|| params.get("hashes"))
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                if hash_list.is_empty() {
                    return Err("flush requires array of content hashes".to_string());
                }

                let undo_state = app.state::<UndoStoreState>();
                let mut undo_store = undo_state.entries.lock().await;
                let undo_store_entries: usize = undo_store.values().map(|s| s.len()).sum();

                let mut flushed: Vec<serde_json::Value> = Vec::new();
                let mut errors: Vec<serde_json::Value> = Vec::new();
                let mut modified_paths: Vec<String> = Vec::new();
                let mut formatted_updates: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();

                for hash_ref in &hash_list {
                    let clean_ref = extract_hash_for_edit_ref(hash_ref);
                    let mut found_entry: Option<(String, UndoEntry)> = None;
                    for (fp, stack) in undo_store.iter() {
                        for entry in stack.iter().rev() {
                            if entry.hash == clean_ref || entry.hash.starts_with(&clean_ref) || clean_ref.starts_with(&entry.hash) {
                                found_entry = Some((fp.clone(), entry.clone()));
                                break;
                            }
                        }
                        if found_entry.is_some() { break; }
                    }
                    match found_entry {
                        Some((fp, entry)) => {
                            // Pre-write lint check: disabled â€” flush no longer blocked by lint errors
                            let resolved_path = resolve_project_path(project_root, &fp);
                            if let Some(parent) = resolved_path.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            match crate::snapshot::atomic_write(&resolved_path, entry.content.as_bytes()) {
                                Ok(()) => {
                                    let resolved_hash = if let Some(formatted) = maybe_format_go_after_write(&resolved_path).await {
                                        let formatted_hash = content_hash(&formatted);
                                        formatted_updates.insert(fp.clone(), (formatted_hash.clone(), formatted));
                                        formatted_hash
                                    } else {
                                        entry.hash.clone()
                                    };
                                    let short_hash = format!("h:{}", &resolved_hash[..std::cmp::min(8, resolved_hash.len())]);
                                    let old_short = entry.parent_hash.as_ref().map(|p| format!("h:{}", &p[..std::cmp::min(8, p.len())]));
                                    let diff_ref = entry.parent_hash.as_ref().map(|p| format!(
                                        "h:{}..h:{}",
                                        &p[..std::cmp::min(8, p.len())],
                                        &resolved_hash[..std::cmp::min(8, resolved_hash.len())]
                                    ));
                                    modified_paths.push(fp.clone());
                                    flushed.push(serde_json::json!({
                                        "hash": hash_ref,
                                        "resolved_hash": resolved_hash.clone(),
                                        "file": fp,
                                        "parent_hash": entry.parent_hash.clone(),
                                        "content_hash": resolved_hash.clone(),
                                        "source_revision": resolved_hash,
                                        "h": short_hash,
                                        "old_h": old_short,
                                        "diff_ref": diff_ref,
                                        "status": "written"
                                    }));
                                }
                                Err(e) => {
                                    errors.push(serde_json::json!({
                                        "hash": hash_ref,
                                        "file": fp,
                                        "error": format!("Write failed: {}", e)
                                    }));
                                }
                            }
                        }
                        None => {
                            errors.push(serde_json::json!({
                                "hash": hash_ref,
                                "error": "Not found in undo store",
                                "_hint": "Entry may have been evicted or already undone. Use edit({undo:'list'}) to see available entries.",
                                "undo_store_entries": undo_store_entries
                            }));
                        }
                    }
                }

                // Mark flushed entries (retain for undo)
                for item in &flushed {
                    let hash_to_match = item.get("resolved_hash").and_then(|v| v.as_str())
                        .or_else(|| item.get("hash").and_then(|v| v.as_str()));
                    if let Some(hash) = hash_to_match {
                        let clean = extract_hash_for_edit_ref(hash);
                        for (_fp, stack) in undo_store.iter_mut() {
                            for entry in stack.iter_mut().rev() {
                                if entry.hash == clean || entry.hash.starts_with(&clean) || clean.starts_with(&entry.hash) {
                                    if let Some((formatted_hash, formatted_content)) = formatted_updates.get(_fp) {
                                        entry.hash = formatted_hash.clone();
                                        entry.content = formatted_content.clone();
                                    }
                                    entry.flushed_to_disk = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                drop(undo_store);
                if !flushed.is_empty() {
                    let hr_state = app.state::<hash_resolver::HashRegistryState>();
                    let mut registry = hr_state.registry.lock().await;
                    for item in &flushed {
                        let file = item.get("file").and_then(|v| v.as_str()).unwrap_or_default();
                        let resolved_hash = item.get("resolved_hash").and_then(|v| v.as_str()).unwrap_or_default();
                        if file.is_empty() || resolved_hash.is_empty() {
                            continue;
                        }
                        let resolved_path = resolve_project_path(project_root, file);
                        if let Ok(content) = std::fs::read_to_string(&resolved_path).map(|c| normalize_line_endings(&c)) {
                            let lang = hash_resolver::detect_lang(Some(file));
                            registry.register(resolved_hash.to_string(), hash_resolver::HashEntry {
                                source: Some(file.to_string()),
                                content: content.clone(),
                                tokens: content.len() / 4,
                                lang,
                                line_count: content.lines().count(),
                                symbol_count: None,
                            });
                            let previous_revision = item.get("parent_hash").and_then(|v| v.as_str());
                            if file.contains('/') || file.contains('\\') {
                                let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                    "path": file,
                                    "revision": resolved_hash,
                                    "previous_revision": previous_revision,
                                }));
                            }
                        }
                    }
                }

                let index_result = if !modified_paths.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), modified_paths.clone()).await
                } else {
                    serde_json::json!(null)
                };

                let mut flush_result = serde_json::json!({
                    "mode": "flush",
                    "flushed": flushed,
                    "errors": errors,
                    "index": index_result,
                    "_next": if errors.is_empty() {
                        "Files written. Run q: v1 verify.typecheck to validate"
                    } else {
                        "Some flushes failed. Check errors array"
                    }
                });
                if !errors.is_empty() {
                    flush_result["_hint"] = serde_json::json!("Entry may have been evicted or already undone. Use edit({undo:'list'}) to see available entries.");
                    flush_result["undo_store_entries"] = serde_json::json!(undo_store_entries);
                }
                Ok(flush_result)
            }
            "undo" => {
                let undo_val = params.get("undo")
                    .or_else(|| params.get("hash"))
                    .or_else(|| params.get("file_path"))
                    .and_then(|v| v.as_str());

                // undo({undo:"list"}) â€” show all available undo entries
                if undo_val == Some("list") {
                    let undo_state = app.state::<UndoStoreState>();
                    let undo_store = undo_state.entries.lock().await;
                    let mut entries: Vec<serde_json::Value> = Vec::new();
                    for (fp, stack) in undo_store.iter() {
                        for entry in stack.iter().rev() {
                            entries.push(serde_json::json!({
                                "hash": entry.hash,
                                "file": fp,
                                "has_previous": entry.previous_content.is_some(),
                                "parent_hash": entry.parent_hash,
                                "flushed": entry.flushed_to_disk,
                                "age_secs": entry.created_at.elapsed().as_secs(),
                                "lines": entry.content.lines().count()
                            }));
                        }
                    }
                    return Ok(serde_json::json!({
                        "mode": "undo_list",
                        "entries": entries,
                        "count": entries.len(),
                        "_next": "Use q: e1 change.edit undo:<hash> OR e2 change.edit undo:<file_path> to restore"
                    }));
                }

                let undo_ref = undo_val
                    .ok_or_else(|| "undo requires a content hash, file path, or 'list'".to_string())?
                    .to_string();

                let undo_state = app.state::<UndoStoreState>();
                let mut undo_store = undo_state.entries.lock().await;

                // Try file-path lookup first (exact, then normalized slashes)
                let undo_norm = undo_ref.replace('\\', "/");
                let path_key = if undo_store.contains_key(&undo_ref) {
                    Some(undo_ref.clone())
                } else if undo_store.contains_key(&undo_norm) {
                    Some(undo_norm.clone())
                } else {
                    undo_store.keys().find(|k| k.replace('\\', "/") == undo_norm).cloned()
                };
                let pop_result: Option<(String, UndoEntry)> = if let Some(key) = path_key {
                    let stack = undo_store.get_mut(&key).unwrap();
                    stack.pop().map(|e| (key, e))
                } else {
                    // Hash-based lookup: scan all stacks for matching hash
                    // Use extract_hash_for_edit_ref to handle "[edit result] h:6169ed â†’ path" etc.
                    let clean_ref = extract_hash_for_edit_ref(&undo_ref);
                    let mut target: Option<(String, usize)> = None;
                    for (fp, stack) in undo_store.iter() {
                        for (idx, entry) in stack.iter().enumerate().rev() {
                            if entry.hash == clean_ref || entry.hash.starts_with(&clean_ref) || clean_ref.starts_with(&entry.hash) {
                                target = Some((fp.clone(), idx));
                                break;
                            }
                        }
                        if target.is_some() { break; }
                    }
                    if let Some((fp, idx)) = target {
                        let stack = undo_store.get_mut(&fp).unwrap();
                        Some((fp, stack.remove(idx)))
                    } else {
                        None
                    }
                };

                match pop_result {
                    Some((file_path, entry)) => {
                        let resolved_path = resolve_project_path(project_root, &file_path);
                        match &entry.previous_content {
                            Some(prev) => {
                                let bytes = entry.previous_format
                                    .as_ref()
                                    .map(|fmt| serialize_with_format(prev, fmt))
                                    .unwrap_or_else(|| prev.as_bytes().to_vec());
                                match crate::snapshot::atomic_write(&resolved_path, &bytes) {
                                    Ok(()) => {
                                        let restored_hash = content_hash(prev);
                                        drop(undo_store);
                                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                        let mut registry = hr_state.registry.lock().await;
                                        let lang = hash_resolver::detect_lang(Some(&file_path));
                                        registry.register(restored_hash.clone(), hash_resolver::HashEntry {
                                            source: Some(file_path.clone()),
                                            content: prev.clone(),
                                            tokens: prev.len() / 4,
                                            lang,
                                            line_count: prev.lines().count(),
                                            symbol_count: None,
                                        });
                                        if file_path.contains('/') || file_path.contains('\\') {
                                            let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                                "path": file_path,
                                                "revision": restored_hash.clone(),
                                                "previous_revision": entry.hash.clone(),
                                            }));
                                        }
                                        let root_str = project_root.to_string_lossy().to_string();
                                        crate::file_ops::emit_file_tree_changed(&app, &root_str, &[&file_path]);
                                        let indexer = project.indexer().clone();
                                        let index_result = index_modified_files(
                                            &app, indexer.clone(), project_root_owned.clone(), vec![file_path.clone()]
                                        ).await;
                                        let restored_short = format!("h:{}", &restored_hash[..std::cmp::min(8, restored_hash.len())]);
                                        let undone_short = format!("h:{}", &entry.hash[..std::cmp::min(8, entry.hash.len())]);
                                        let diff_ref = format!("{}..{}", undone_short, restored_short);
                                        Ok(serde_json::json!({
                                            "mode": "undo",
                                            "file": file_path,
                                            "restored_hash": restored_hash.clone(),
                                            "undone_hash": entry.hash.clone(),
                                            "content_hash": restored_hash.clone(),
                                            "source_revision": restored_hash,
                                            "h": restored_short,
                                            "old_h": undone_short,
                                            "diff_ref": diff_ref,
                                            "status": "restored",
                                            "index": index_result,
                                            "_next": "File restored. Run q: v1 verify.typecheck to validate"
                                        }))
                                    }
                                    Err(e) => Ok(serde_json::json!({
                                        "error": format!("Failed to write restored content: {}", e),
                                        "file": file_path
                                    }))
                                }
                            }
                            None => {
                                // No previous content â€” try parent hash in undo store, then hash registry
                                let restored = if let Some(ref parent_hash) = entry.parent_hash {
                                    // 1) Check undo store for parent content
                                    let from_undo = undo_store.values().flatten()
                                        .find(|e| e.hash == *parent_hash || e.hash.starts_with(parent_hash.as_str()))
                                        .and_then(|e| e.previous_content.clone().or(Some(e.content.clone())));
                                    if from_undo.is_some() {
                                        from_undo
                                    } else {
                                        // 2) Check hash registry (content from context reads)
                                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                        let registry = hr_state.registry.lock().await;
                                        registry.get_original(parent_hash).map(|e| e.content.clone())
                                    }
                                } else {
                                    // No parent hash â€” try hash registry for any prior version of this file
                                    let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                    let registry = hr_state.registry.lock().await;
                                    let file_norm = file_path.replace('\\', "/");
                                    registry.get_by_source(&file_norm)
                                        .and_then(|hashes| {
                                            hashes.iter().rev()
                                                .filter(|h| **h != entry.hash)
                                                .find_map(|h| registry.get_original(h).map(|e| e.content.clone()))
                                        })
                                };

                                match restored {
                                    Some(content) => {
                                        match crate::snapshot::atomic_write(&resolved_path, content.as_bytes()) {
                                            Ok(()) => {
                                                let restored_hash = content_hash(&content);
                                                drop(undo_store);
                                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                                let mut registry = hr_state.registry.lock().await;
                                                let lang = hash_resolver::detect_lang(Some(&file_path));
                                                registry.register(restored_hash.clone(), hash_resolver::HashEntry {
                                                    source: Some(file_path.clone()),
                                                    content: content.clone(),
                                                    tokens: content.len() / 4,
                                                    lang,
                                                    line_count: content.lines().count(),
                                                    symbol_count: None,
                                                });
                                                if file_path.contains('/') || file_path.contains('\\') {
                                                    let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                                        "path": file_path,
                                                        "revision": restored_hash.clone(),
                                                        "previous_revision": entry.hash.clone(),
                                                    }));
                                                }
                                                let indexer = project.indexer().clone();
                                                let index_result = index_modified_files(
                                                    &app, indexer.clone(), project_root_owned.clone(), vec![file_path.clone()]
                                                ).await;
                                                let restored_short = format!("h:{}", &restored_hash[..std::cmp::min(8, restored_hash.len())]);
                                                let undone_short = format!("h:{}", &entry.hash[..std::cmp::min(8, entry.hash.len())]);
                                                let diff_ref = format!("{}..{}", undone_short, restored_short);
                                                Ok(serde_json::json!({
                                                    "mode": "undo",
                                                    "file": file_path,
                                                    "restored_hash": restored_hash.clone(),
                                                    "undone_hash": entry.hash.clone(),
                                                    "content_hash": restored_hash.clone(),
                                                    "source_revision": restored_hash,
                                                    "h": restored_short,
                                                    "old_h": undone_short,
                                                    "diff_ref": diff_ref,
                                                    "status": "restored_from_registry",
                                                    "index": index_result,
                                                    "_next": "Restored from hash registry. Run q: v1 verify.typecheck to validate"
                                                }))
                                            }
                                            Err(e) => Ok(serde_json::json!({
                                                "error": format!("Failed to write: {}", e),
                                                "file": file_path
                                            }))
                                        }
                                    }
                                    None => {
                                        Ok(serde_json::json!({
                                            "error": "No previous content available for undo",
                                            "hash": entry.hash,
                                            "parent_hash": entry.parent_hash,
                                            "hint": "File content was not captured before edit. Re-read the file and retry."
                                        }))
                                    }
                                }
                            }
                        }
                    }
                    None => {
                        let entry_count: usize = undo_store.values().map(|s| s.len()).sum();
                        Ok(serde_json::json!({
                            "error": "Not found in undo store. Use q: e1 change.edit undo:list to see available entries.",
                            "ref": undo_ref,
                            "_hint": "Entry may have been evicted or already undone. Use edit({undo:'list'}}) to see available entries.",
                            "undo_store_entries": entry_count
                        }))
                    }
                }
            }
            "list_drafts" => {
                let undo_state = app.state::<UndoStoreState>();
                let undo_store = undo_state.entries.lock().await;

                let drafts: Vec<serde_json::Value> = undo_store.iter().flat_map(|(fp, stack)| {
                    stack.iter().filter(|e| !e.flushed_to_disk).map(move |entry| {
                        serde_json::json!({
                            "hash": entry.hash,
                            "file_path": fp,
                            "created_secs_ago": entry.created_at.elapsed().as_secs(),
                            "parent_hash": entry.parent_hash,
                            "has_previous_content": entry.previous_content.is_some(),
                            "content_lines": entry.content.lines().count()
                        })
                    })
                }).collect();

                Ok(serde_json::json!({
                    "mode": "list_drafts",
                    "drafts": drafts,
                    "count": drafts.len(),
                    "_next": if drafts.is_empty() {
                        "No buffered drafts. Use q: e1 change.edit draft:true ... to create one."
                    } else {
                        "Use q: e1 change.edit revise:<hash> ... to patch, q: e2 change.edit flush:<hash> to write, or q: e3 change.edit undo:<hash> to rollback"
                    }
                }))
            }
            "diff" => {
                let hash = params.get("diff")
                    .or_else(|| params.get("hash"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "diff requires a content hash".to_string())?
                    .to_string();

                let undo_state = app.state::<UndoStoreState>();
                let undo_store = undo_state.entries.lock().await;

                let entry_opt: Option<(String, UndoEntry)> = {
                    let mut found = None;
                    for (fp, stack) in undo_store.iter() {
                        for entry in stack.iter().rev() {
                            if entry.hash == hash || entry.hash.starts_with(&hash) {
                                found = Some((fp.clone(), entry.clone()));
                                break;
                            }
                        }
                        if found.is_some() { break; }
                    }
                    found
                };
                drop(undo_store);

                match entry_opt {
                    Some((file_path, entry)) => {
                        let resolved_path = resolve_project_path(project_root, &file_path);
                        let disk_content = std::fs::read_to_string(&resolved_path)
                            .map(|c| normalize_line_endings(&c))
                            .unwrap_or_default();

                        let buf_lines: Vec<&str> = entry.content.lines().collect();
                        let disk_lines: Vec<&str> = disk_content.lines().collect();

                        // Build unified diff
                        let mut diff_output = Vec::new();
                        diff_output.push(format!("--- {} (disk)", file_path));
                        diff_output.push(format!("+++ {} (buffer: {})", file_path, hash));

                        let max_len = std::cmp::max(buf_lines.len(), disk_lines.len());
                        let mut changes = 0usize;
                        let mut i = 0;
                        while i < max_len {
                            let disk_line = disk_lines.get(i).copied().unwrap_or("");
                            let buf_line = buf_lines.get(i).copied().unwrap_or("");
                            if disk_line != buf_line {
                                diff_output.push(format!("@@ line {} @@", i + 1));
                                // Show context (up to 2 lines before)
                                if i > 0 { diff_output.push(format!(" {}", disk_lines.get(i - 1).unwrap_or(&""))); }
                                diff_output.push(format!("-{}", disk_line));
                                diff_output.push(format!("+{}", buf_line));
                                // Show context (up to 1 line after)
                                if i + 1 < max_len {
                                    let next_disk = disk_lines.get(i + 1).unwrap_or(&"");
                                    let next_buf = buf_lines.get(i + 1).unwrap_or(&"");
                                    if next_disk == next_buf {
                                        diff_output.push(format!(" {}", next_disk));
                                    }
                                }
                                changes += 1;
                            }
                            i += 1;
                        }

                        Ok(serde_json::json!({
                            "mode": "diff",
                            "file": file_path,
                            "hash": hash,
                            "disk_lines": disk_lines.len(),
                            "buffer_lines": buf_lines.len(),
                            "changes": changes,
                            "diff": diff_output.join("\n"),
                            "_next": if changes == 0 {
                                "No differences between buffer and disk"
                            } else {
                                "Use q: e1 change.edit flush:<hash> to write buffer to disk, or q: e2 change.edit undo:<hash> to discard"
                            }
                        }))
                    }
                    None => {
                        Ok(serde_json::json!({
                            "error": "Hash not found in buffer",
                            "hash": hash,
                            "hint": "Use q: e1 change.edit list_drafts:true to see available hashes"
                        }))
                    }
                }
            }
            "replace" => {
                // Enhanced text replacement with flexible matching and lint-on-write
                let edits = params
                    .get("edits")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| {
                                let file = v.get("file")?.as_str()?.to_string();
                                let old = v.get("old")?.as_str()?.to_string();
                                let new_text = v.get("new")?.as_str()?.to_string();
                                Some((file, old, new_text))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                
                if edits.is_empty() {
                    return Err("edits array required for replace. Each edit needs: file, old, new".to_string());
                }
                
                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                let flexible_match = params
                    .get("flexible_match")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                let replace_all = params
                    .get("replace_all")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                // Lint-on-write parameters
                let deep_check = params
                    .get("deep_check")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                let lint_enabled = params
                    .get("lint")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                let mut results: Vec<serde_json::Value> = Vec::new();
                let mut total_replacements = 0;
                let mut files_modified = 0;
                let mut lint_results: Vec<linter::LintResult> = Vec::new();
                
                // Track modified files for linting and indexing
                let mut modified_files_content: Vec<(String, String)> = Vec::new();
                let mut replace_modified_paths: Vec<String> = Vec::new();
                // Track simulated content for deep_check during dry_run
                let mut simulated_content: Vec<(String, String)> = Vec::new();
                
                for (file_path, old_text, new_text) in edits {
                    let resolved_path = resolve_project_path(project_root, &file_path);
                    
                    // Read file and normalize line endings for consistent cross-platform matching
                    let content = match std::fs::read_to_string(&resolved_path) {
                        Ok(c) => normalize_line_endings(&c),
                        Err(e) => {
                            results.push(serde_json::json!({
                                "file": file_path,
                                "error": format!("Failed to read: {}", e),
                                "error_class": "file_read_failed",
                                "status": "error",
                                "_next": "Verify the file path exists, then retry"
                            }));
                            continue;
                        }
                    };
                    let old_text = normalize_line_endings(&old_text);
                    let new_text = normalize_line_endings(&new_text);
                    
                    // Count occurrences (exact match)
                    let exact_count = content.matches(&old_text).count();
                    
                    let pattern_preview = if old_text.len() > 100 {
                        format!("{}...", &old_text[..100])
                    } else {
                        old_text.clone()
                    };

                    let (new_content, occurrence_count) = if replace_all {
                        if exact_count == 0 {
                            let mut err = serde_json::json!({
                                "file": file_path,
                                "error": "Pattern not found",
                                "error_class": "pattern_not_found",
                                "status": "not_found",
                                "pattern_preview": pattern_preview,
                                "_next": "Re-read the file and retry with exact content from a fresh read"
                            });
                            if let Some(suggestion) = suggest_fuzzy_match(&content, &old_text, None) {
                                err["suggestion"] = suggestion;
                            }
                            results.push(err);
                            continue;
                        }
                        (content.replace(&old_text, &new_text), exact_count)
                    } else if exact_count > 0 {
                        (content.replacen(&old_text, &new_text, 1), exact_count)
                    } else if flexible_match {
                        match exact_replacen_for_write(&content, &old_text, &new_text) {
                            Ok(Some((replaced, _line))) => (replaced, 1),
                            _ => {
                                let mut err = serde_json::json!({
                                    "file": file_path,
                                    "error": "Pattern not found (exact match required)",
                                    "error_class": "pattern_not_found",
                                    "status": "not_found",
                                    "pattern_preview": pattern_preview,
                                    "_next": "Re-read the file and retry with exact content from a fresh read"
                                });
                                if let Some(suggestion) = suggest_fuzzy_match(&content, &old_text, None) {
                                    err["suggestion"] = suggestion;
                                }
                                results.push(err);
                                continue;
                            }
                        }
                    } else {
                        let mut err = serde_json::json!({
                            "file": file_path,
                            "error": "Pattern not found",
                            "error_class": "pattern_not_found",
                            "status": "not_found",
                            "pattern_preview": pattern_preview,
                            "_next": "Re-read the file and retry with exact content from a fresh read"
                        });
                        if let Some(suggestion) = suggest_fuzzy_match(&content, &old_text, None) {
                            err["suggestion"] = suggestion;
                        }
                        results.push(err);
                        continue;
                    };
                    
                    let replacements = if replace_all { occurrence_count } else { 1 };
                    total_replacements += replacements;
                    
                    if dry_run {
                        // Store simulated content for deep_check linting
                        if deep_check {
                            simulated_content.push((file_path.clone(), new_content.clone()));
                        }
                        
                        results.push(serde_json::json!({
                            "file": file_path,
                            "status": "preview",
                            "replacements": replacements,
                            "preview": {
                                "old_snippet": if old_text.len() > 200 {
                                    format!("{}...", &old_text[..200])
                                } else {
                                    old_text
                                },
                                "new_snippet": if new_text.len() > 200 {
                                    format!("{}...", &new_text[..200])
                                } else {
                                    new_text
                                }
                            }
                        }));
                    } else {
                        // Write file
                        match crate::snapshot::atomic_write(&resolved_path, new_content.as_bytes()) {
                            Ok(()) => {
                                files_modified += 1;
                                replace_modified_paths.push(file_path.clone());
                                // Store for post-write linting
                                if lint_enabled && !deep_check {
                                    modified_files_content.push((file_path.clone(), new_content.clone()));
                                }
                                results.push(serde_json::json!({
                                    "file": file_path,
                                    "status": "applied",
                                    "replacements": replacements
                                }));
                            }
                            Err(e) => {
                                results.push(serde_json::json!({
                                    "file": file_path,
                                    "error": format!("Failed to write: {}", e),
                                    "error_class": "write_failed",
                                    "status": "error",
                                    "_next": "Check file permissions and disk space, then retry"
                                }));
                            }
                        }
                    }
                }
                
                // Deep check: lint simulated content during dry_run
                if dry_run && deep_check && !simulated_content.is_empty() {
                    let lint_options = linter::LintOptions {
                        root_path: project_root.to_string_lossy().to_string(),
                        use_native_parser: Some(true),
                        ..Default::default()
                    };
                    lint_results = linter::lint_files(&simulated_content, &lint_options);
                }
                
                // Post-write linting (only if lint enabled, not dry_run, and not already done via deep_check)
                if !dry_run && lint_enabled && !modified_files_content.is_empty() {
                    let lint_options = linter::LintOptions {
                        root_path: project_root.to_string_lossy().to_string(),
                        use_native_parser: Some(true),
                        ..Default::default()
                    };
                    lint_results = linter::lint_files(&modified_files_content, &lint_options);
                }
                
                let lint_summary = if !lint_results.is_empty() {
                    Some(linter::create_lint_summary(&lint_results))
                } else {
                    None
                };
                
                // Incremental indexing for modified files
                let index_result = if !dry_run && !replace_modified_paths.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), replace_modified_paths.clone()).await
                } else {
                    serde_json::json!(null)
                };
                
                Ok(serde_json::json!({
                    "results": results,
                    "mode": if dry_run { if deep_check { "dry_run+deep_check" } else { "dry_run" } } else { "applied" },
                    "lints": lint_summary,
                    "index": index_result,
                    "summary": {
                        "total_replacements": total_replacements,
                        "files_modified": if dry_run { 0 } else { files_modified },
                        "files_previewed": if dry_run { results.iter().filter(|r| r.get("status") == Some(&serde_json::json!("preview"))).count() } else { 0 },
                        "lints": lint_summary.as_ref().map(|s| s.total).unwrap_or(0)
                    },
                    "_next": if dry_run {
                        "Preview complete. Set dry_run:false to apply changes"
                    } else if lint_summary.as_ref().map(|s| s.by_severity.get("error").unwrap_or(&0) > &0).unwrap_or(false) {
                        "Replacements applied but lint errors found. Review lints.top_issues"
                    } else {
                        "Replacements applied successfully"
                    }
                }))
            }
            "delete_files" => {
                // Batch delete multiple files
                let file_paths: Vec<String> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                if file_paths.is_empty() {
                    return Err("file_paths required for delete_files operation".to_string());
                }
                
                let confirm = params
                    .get("confirm")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                // confirm:true implies dry_run:false for single-call destructive deletes
                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(if confirm { false } else { true });
                
                // Safety check: require confirmation for deleting many files
                if file_paths.len() > 5 && !dry_run && !confirm {
                    return Ok(serde_json::json!({
                        "error": "Deleting more than 5 files requires confirm:true",
                        "file_count": file_paths.len(),
                        "action_required": "Set confirm:true to proceed, or use dry_run:true to preview"
                    }));
                }
                
                let mut deleted: Vec<String> = Vec::new();
                let mut not_found: Vec<serde_json::Value> = Vec::new();
                let mut errors: Vec<serde_json::Value> = Vec::new();
                
                for path in file_paths {
                    let resolved_path = resolve_project_path(project_root, &path);
                    
                    // Try resolved path first, then raw path as fallback
                    let actual_path = if resolved_path.exists() {
                        resolved_path.clone()
                    } else {
                        let raw_path = PathBuf::from(&path);
                        if raw_path.exists() {
                            raw_path
                        } else {
                            not_found.push(serde_json::json!({
                                "path": path,
                                "resolved_as": resolved_path.to_string_lossy()
                            }));
                            continue;
                        }
                    };
                    
                    if dry_run {
                        deleted.push(path.clone());
                        continue;
                    }
                    
                    // Delete file or directory
                    let result = if actual_path.is_dir() {
                        std::fs::remove_dir_all(&actual_path)
                    } else {
                        std::fs::remove_file(&actual_path)
                    };
                    
                    match result {
                        Ok(()) => {
                            deleted.push(path.clone());
                        }
                        Err(e) => {
                            errors.push(serde_json::json!({
                                "path": path,
                                "error": e.to_string()
                            }));
                        }
                    }
                }
                
                // Remove deleted files from the index
                let index_result = if !dry_run && !deleted.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_deleted_files(&app, &indexer, &project_root_owned, &deleted).await
                } else {
                    serde_json::json!(null)
                };
                
                Ok(serde_json::json!({
                    "status": if dry_run { "preview" } else { "ok" },
                    "deleted": deleted,
                    "not_found": not_found,
                    "errors": errors,
                    "dry_run": dry_run,
                    "index": index_result,
                    "summary": {
                        "deleted_count": deleted.len(),
                        "not_found_count": not_found.len(),
                        "error_count": errors.len()
                    },
                    "_next": if dry_run {
                        "DRY RUN â€” no files were deleted. Set confirm:true to delete, or dry_run:false to delete (confirm:true required for >5 files)."
                    } else if !errors.is_empty() {
                        "Some files failed to delete. Check errors array"
                    } else {
                        "Files deleted successfully"
                    }
                }))
            }
            "create_files" => {
                // Batch create multiple files with lint-on-write support
                let files = params
                    .get("files")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| {
                                let path = v.get("path")?.as_str()?.to_string();
                                let content = v.get("content")?.as_str()?.to_string();
                                let per_file_overwrite = v.get("overwrite").and_then(|v| v.as_bool());
                                Some((path, content, per_file_overwrite))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                
                if files.is_empty() {
                    return Err("files array required for create_files. Each file needs: path, content".to_string());
                }
                
                let global_overwrite = params
                    .get("overwrite")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                let dry_run = params
                    .get("dry_run")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                // Lint-on-write parameters
                let deep_check = params
                    .get("deep_check")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                
                let lint_enabled = params
                    .get("lint")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                let mut created: Vec<String> = Vec::new();
                let mut skipped: Vec<String> = Vec::new();
                let mut errors: Vec<serde_json::Value> = Vec::new();
                let mut lint_results: Vec<linter::LintResult> = Vec::new();
                // Track content integrity for truncation diagnosis
                let mut file_integrity: Vec<serde_json::Value> = Vec::new();
                
                // Deep check: lint content before writing (works with dry_run)
                if deep_check {
                    let lint_options = linter::LintOptions {
                        root_path: project_root.to_string_lossy().to_string(),
                        use_native_parser: Some(true),
                        ..Default::default()
                    };
                    let files_to_lint: Vec<(String, String)> = files.iter()
                        .map(|(p, c, _)| (p.clone(), c.clone()))
                        .collect();
                    lint_results = linter::lint_files(&files_to_lint, &lint_options);
                }
                
                // If dry_run, return early with lint results
                if dry_run {
                    let lint_summary = if !lint_results.is_empty() || deep_check {
                        Some(linter::create_lint_summary(&lint_results))
                    } else {
                        None
                    };
                    
                    return Ok(serde_json::json!({
                        "mode": if deep_check { "dry_run+deep_check" } else { "dry_run" },
                        "would_create": files.iter().map(|(p, _, _)| p).collect::<Vec<_>>(),
                        "lints": lint_summary,
                        "summary": {
                            "would_create": files.len(),
                            "lints": lint_summary.as_ref().map(|s| s.total).unwrap_or(0)
                        },
                        "_next": "Preview complete. Set dry_run:false to create files"
                    }));
                }
                
                // Store files content for post-write linting
                let mut created_files_content: Vec<(String, String)> = Vec::new();
                
                for (path, content, per_file_overwrite) in files {
                    let resolved_path = resolve_project_path(project_root, &path);
                    let overwrite = per_file_overwrite.unwrap_or(global_overwrite);
                    
                    // Check if file exists
                    if resolved_path.exists() && !overwrite {
                        skipped.push(path.clone());
                        continue;
                    }
                    
                    // Create parent directories if needed
                    if let Some(parent) = resolved_path.parent() {
                        if let Err(e) = std::fs::create_dir_all(parent) {
                            errors.push(serde_json::json!({
                                "path": path,
                                "error": format!("Failed to create directory: {}", e)
                            }));
                            continue;
                        }
                    }
                    
                    // Record content integrity before write for truncation diagnosis
                    let content_len = content.len();
                    let content_digest = crate::content_hash(&content);

                    // Write file
                    match crate::snapshot::atomic_write(&resolved_path, content.as_bytes()) {
                        Ok(()) => {
                            // Verify written content matches what was sent
                            let written_len = std::fs::metadata(&resolved_path)
                                .map(|m| m.len() as usize)
                                .unwrap_or(0);
                            file_integrity.push(serde_json::json!({
                                "path": path,
                                "content_length": content_len,
                                "content_hash": content_digest,
                                "written_bytes": written_len,
                                "integrity_ok": written_len == content_len,
                            }));
                            created.push(path.clone());
                            if lint_enabled && !deep_check {
                                created_files_content.push((path.clone(), content.clone()));
                            }
                        }
                        Err(e) => {
                            errors.push(serde_json::json!({
                                "path": path,
                                "error": e.to_string()
                            }));
                        }
                    }
                }
                
                // Post-write linting (only if lint enabled and not already done via deep_check)
                if lint_enabled && !deep_check && !created_files_content.is_empty() {
                    let lint_options = linter::LintOptions {
                        root_path: project_root.to_string_lossy().to_string(),
                        use_native_parser: Some(true),
                        ..Default::default()
                    };
                    lint_results = linter::lint_files(&created_files_content, &lint_options);
                }
                
                let lint_summary = if !lint_results.is_empty() {
                    Some(linter::create_lint_summary(&lint_results))
                } else {
                    None
                };
                
                // Incremental indexing for created files
                let index_result = if !created.is_empty() {
                    let indexer = project.indexer().clone();
                    // Lock already released at function entry
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), created.clone()).await
                } else {
                    serde_json::json!(null)
                };
                
                Ok(serde_json::json!({
                    "created": created,
                    "skipped": skipped,
                    "errors": errors,
                    "lints": lint_summary,
                    "index": index_result,
                    "file_integrity": file_integrity,
                    "summary": {
                        "created_count": created.len(),
                        "skipped_count": skipped.len(),
                        "error_count": errors.len(),
                        "lints": lint_summary.as_ref().map(|s| s.total).unwrap_or(0),
                        "integrity_failures": file_integrity.iter()
                            .filter(|f| f.get("integrity_ok").and_then(|v| v.as_bool()) == Some(false))
                            .count()
                    },
                    "_next": if !errors.is_empty() {
                        "Some files failed. Check errors array for details".to_string()
                    } else if !skipped.is_empty() && created.is_empty() {
                        "All files skipped (already exist). Use overwrite:true to replace".to_string()
                    } else if !skipped.is_empty() {
                        format!("{} created, {} skipped (already exist). Use overwrite:true to replace", created.len(), skipped.len())
                    } else if lint_summary.as_ref().map(|s| s.by_severity.get("error").unwrap_or(&0) > &0).unwrap_or(false) {
                        "Files created but lint errors found. Review lints.top_issues".to_string()
                    } else {
                        "Files created successfully".to_string()
                    }
                }))
            }
            "mark_finding_as_noise" => {
                // Mark findings as noise (suppress false positives)
                let findings = params
                    .get("findings")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| {
                                let pattern_id = v.get("pattern_id")?.as_str()?.to_string();
                                let file_path = v.get("file_path")?.as_str()?.to_string();
                                let line = v.get("line")?.as_u64()? as u32;
                                let reason = v.get("reason").and_then(|r| r.as_str()).map(|s| s.to_string());
                                Some(atls_core::query::NoiseMarking {
                                    pattern_id,
                                    file_path,
                                    line,
                                    reason,
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                
                if findings.is_empty() {
                    return Err("findings array required for mark_finding_as_noise. Each finding needs: pattern_id, file_path, line".to_string());
                }
                
                match project.query().mark_findings_as_noise(&findings) {
                    Ok(result) => {
                        Ok(serde_json::json!({
                            "marked": result.marked,
                            "not_found": result.not_found,
                            "errors": result.errors,
                            "success": result.errors.is_empty(),
                            "_next": if result.marked > 0 {
                                "Findings suppressed. Run find_issues to see updated list"
                            } else {
                                "No findings matched. Check pattern_id, file_path, and line"
                            }
                        }))
                    }
                    Err(e) => {
                        Ok(serde_json::json!({
                            "error": e.to_string(),
                            "marked": 0
                        }))
                    }
                }
            }
            "change_impact" => {
                // Analyze impact of changing specified files
                let file_paths: Vec<String> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                if file_paths.is_empty() {
                    return Err("file_paths required for change_impact operation".to_string());
                }
                
                match project.query().get_change_impact(&file_paths) {
                    Ok(impact) => {
                        Ok(serde_json::json!({
                            "target_files": impact.target_files,
                            "direct_dependents": impact.direct_dependents,
                            "indirect_dependents": impact.indirect_dependents,
                            "affected_symbols": impact.affected_symbols,
                            "summary": impact.summary,
                            "_next": if impact.summary.risk_level == "high" {
                                "High impact! Review all dependents before making changes"
                            } else if impact.summary.risk_level == "medium" {
                                "Medium impact. Test affected files after changes"
                            } else {
                                "Low impact. Safe to proceed with changes"
                            }
                        }))
                    }
                    Err(e) => {
                        Ok(serde_json::json!({
                            "error": e.to_string(),
                            "direct_dependents": [],
                            "indirect_dependents": [],
                            "affected_symbols": []
                        }))
                    }
                }
            }
            "method_inventory" => {
                // List methods/functions with complexity for refactoring analysis
                let file_paths: Vec<String> = params
                    .get("file_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                
                if file_paths.is_empty() {
                    return Err("file_paths required for method_inventory operation".to_string());
                }
                
                let min_lines = params
                    .get("min_lines")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32);
                
                let min_complexity = params
                    .get("min_complexity")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32);
                
                let class_name = params
                    .get("class_name")
                    .and_then(|v| v.as_str());
                
                match project.query().get_method_inventory(&file_paths, min_lines, min_complexity, class_name) {
                    Ok(mut result) => {
                        // Regex fallback: detect test macros not indexed as symbols
                        if result.methods.is_empty() {
                            for fp in &file_paths {
                                let resolved = resolve_project_path(project_root, fp);
                                if let Ok(content) = std::fs::read_to_string(&resolved) {
                                    let ext = resolved.extension().and_then(|e| e.to_str()).unwrap_or("");
                                    let patterns: &[(&str, &str)] = match ext {
                                        "cpp" | "cc" | "cxx" | "c" | "h" | "hpp" =>
                                            &[("TEST_CASE", r"TEST_CASE\s*\("),
                                              ("TEST", r"(?m)^TEST\s*\("),
                                              ("TEST_F", r"TEST_F\s*\("),
                                              ("SCENARIO", r"SCENARIO\s*\(")],
                                        "py" =>
                                            &[("def test_", r"def\s+test_\w+"),
                                              ("@pytest", r"@pytest\.mark")],
                                        "go" =>
                                            &[("func Test", r"func\s+Test\w+"),
                                              ("func Benchmark", r"func\s+Benchmark\w+")],
                                        "js" | "ts" | "jsx" | "tsx" =>
                                            &[("describe", r#"describe\s*\("#),
                                              ("it", r#"\bit\s*\("#),
                                              ("test", r#"\btest\s*\("#)],
                                        _ => &[],
                                    };
                                    for (label, pattern) in patterns {
                                        if let Ok(re) = regex::Regex::new(pattern) {
                                            for mat in re.find_iter(&content) {
                                                let line_num = content[..mat.start()].matches('\n').count() as u32 + 1;
                                                let remaining = &content[mat.start()..];
                                                let est_lines = remaining.lines().count().min(50) as u32;
                                                result.methods.push(atls_core::query::symbols::MethodInventoryEntry {
                                                    name: format!("{}@L{}", label, line_num),
                                                    file: fp.clone(),
                                                    line: line_num,
                                                    end_line: line_num + est_lines,
                                                    lines: est_lines,
                                                    kind: "test_macro".to_string(),
                                                    complexity: None,
                                                    signature: None,
                                                    class_name: None,
                                                    visibility: None,
                                                    modifiers: None,
                                                    is_instance: None,
                                                    pattern: Some("test".to_string()),
                                                    extraction_resistance: None,
                                                    resistance_reasons: None,
                                                    overload_count: None,
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            result.stats.total_scanned += result.methods.len();
                        }

                        let total_complexity: i32 = result.methods.iter()
                            .filter_map(|m| m.complexity)
                            .sum();
                        let total_lines: u32 = result.methods.iter()
                            .map(|m| m.lines)
                            .sum();
                        let avg_complexity = if !result.methods.is_empty() {
                            total_complexity as f64 / result.methods.len() as f64
                        } else {
                            0.0
                        };
                        
                        let has_test_macros = result.methods.iter().any(|m| m.kind == "test_macro");
                        let mut resp = serde_json::json!({
                            "m": result.methods,
                            "n": result.methods.len(),
                            "s": {
                                "tot": result.methods.len(),
                                "tl": total_lines,
                                "tc": total_complexity,
                                "ac": avg_complexity
                            },
                            "d": {
                                "scn": result.stats.total_scanned,
                                "fl": result.stats.filtered_by_lines,
                                "fc": result.stats.filtered_by_complexity,
                                "fk": result.stats.filtered_by_class,
                                "fm": result.stats.files_matched,
                                "fnf": result.stats.files_not_found
                            },
                            "_next": "Use extract_methods to split large methods"
                        });
                        if has_test_macros {
                            resp["_note"] = serde_json::json!("test_macro entries detected via pattern, not indexed symbols");
                        }
                        Ok(resp)
                    }
                    Err(e) => {
                        Ok(serde_json::json!({
                            "error": e.to_string(),
                            "m": [],
                            "d": {
                                "error": e.to_string()
                            }
                        }))
                    }
                }
            }
            "context_stats" => {
                // Get database statistics for context management
                match project.query().get_database_stats() {
                    Ok(stats) => {
                        Ok(serde_json::json!({
                            "files": stats.file_count,
                            "symbols": stats.symbol_count,
                            "issues": stats.issue_count,
                            "relations": stats.relation_count,
                            "signatures": stats.signature_count,
                            "calls": stats.call_count,
                            "last_indexed": stats.last_indexed,
                            "db_size_bytes": stats.db_size_bytes,
                            "_help": "Database index statistics for context management"
                        }))
                    }
                    Err(e) => {
                        Ok(serde_json::json!({
                            "error": e.to_string()
                        }))
                    }
                }
            }
            "workspaces" => {
                let action = params
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or("list");

                match action {
                    "list" => {
                        let filter_type = params.get("filter").and_then(|v| v.as_str());
                        let filter_group = params.get("group").and_then(|v| v.as_str());
                        let filter_name = params.get("name").and_then(|v| v.as_str());

                        let roots_lock = state.roots.lock().await;
                        let all_ws: Vec<&WorkspaceEntry> = roots_lock.iter()
                            .flat_map(|r| r.sub_workspaces.iter())
                            .collect();
                        let filtered: Vec<&&WorkspaceEntry> = all_ws.iter()
                            .filter(|ws| {
                                if let Some(ft) = filter_type {
                                    if !ws.types.iter().any(|t| t == ft) { return false; }
                                }
                                if let Some(fg) = filter_group {
                                    if ws.group_name.as_deref() != Some(fg) { return false; }
                                }
                                if let Some(fn_) = filter_name {
                                    let lower = fn_.to_lowercase();
                                    if !ws.name.to_lowercase().contains(&lower) { return false; }
                                }
                                true
                            })
                            .collect();

                        Ok(serde_json::json!({
                            "count": filtered.len(),
                            "workspaces": filtered,
                            "_next": "Use workspace:'name' param in verify/exec/git to target a specific workspace"
                        }))
                    }
                    "search" => {
                        let query = params.get("query").and_then(|v| v.as_str())
                            .ok_or_else(|| "query param required for workspaces search".to_string())?;
                        let lower_q = query.to_lowercase();

                        let roots_lock = state.roots.lock().await;
                        let all_ws: Vec<&WorkspaceEntry> = roots_lock.iter()
                            .flat_map(|r| r.sub_workspaces.iter())
                            .collect();
                        let matches: Vec<&&WorkspaceEntry> = all_ws.iter()
                            .filter(|ws| {
                                ws.name.to_lowercase().contains(&lower_q)
                                    || ws.rel_path.to_lowercase().contains(&lower_q)
                                    || ws.types.iter().any(|t| t.to_lowercase().contains(&lower_q))
                                    || ws.group_name.as_ref().map_or(false, |g| g.to_lowercase().contains(&lower_q))
                            })
                            .collect();

                        Ok(serde_json::json!({
                            "count": matches.len(),
                            "workspaces": matches,
                        }))
                    }
                    "add" => {
                        let path_str = params.get("path").and_then(|v| v.as_str())
                            .ok_or_else(|| "path param required for workspaces add".to_string())?;
                        let ws_name = params.get("name").and_then(|v| v.as_str());

                        let abs = resolve_project_path(project_root, path_str);
                        if !abs.exists() {
                            return Err(format!("Path does not exist: {}", abs.display()));
                        }

                        // Scan this single directory
                        let mut detected = scan_workspaces(&abs, project_root, 0);
                        if detected.is_empty() {
                            // No build files found, add as a generic workspace
                            let rel = if abs.starts_with(project_root) {
                                abs.strip_prefix(project_root)
                                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                                    .unwrap_or_else(|_| abs.to_string_lossy().to_string())
                            } else {
                                abs.to_string_lossy().to_string()
                            };
                            detected.push(WorkspaceEntry {
                                id: None,
                                name: ws_name.map(|s| s.to_string())
                                    .unwrap_or_else(|| abs.file_name()
                                        .map(|n| n.to_string_lossy().to_string())
                                        .unwrap_or_else(|| "external".to_string())),
                                rel_path: rel,
                                abs_path: abs.to_string_lossy().to_string(),
                                types: Vec::new(),
                                build_files: Vec::new(),
                                group_name: None,
                                source: "manual".to_string(),
                                last_active_at: 0,
                            });
                        } else {
                            for ws in &mut detected {
                                ws.source = "manual".to_string();
                                if let Some(n) = ws_name {
                                    ws.name = n.to_string();
                                }
                            }
                        }

                        // Persist to DB
                        {
                            let conn = project.query().db().conn();
                            for ws in &detected {
                                conn.execute(
                                    "INSERT OR REPLACE INTO workspaces (name, rel_path, abs_path, types, build_files, group_name, source, last_active_at) \
                                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                                    rusqlite::params![
                                        ws.name, ws.rel_path, ws.abs_path,
                                        ws.types.join(","), ws.build_files.join(","),
                                        ws.group_name, ws.source, ws.last_active_at,
                                    ],
                                ).map_err(|e| format!("Failed to add workspace: {}", e))?;
                            }
                        }

                        // Reload sub-workspaces into root cache
                        let reloaded = {
                            let conn = project.query().db().conn();
                            load_workspaces_from_db(&conn).ok()
                        };
                        if let Some(all) = reloaded {
                            let mut roots_lock = state.roots.lock().await;
                            let norm = project_root.to_string_lossy().replace('\\', "/");
                            if let Some(rf) = roots_lock.iter_mut().find(|r| r.path.replace('\\', "/") == norm) {
                                rf.sub_workspaces = all;
                            }
                        }

                        Ok(serde_json::json!({
                            "status": "added",
                            "workspaces": detected,
                        }))
                    }
                    "remove" => {
                        let name = params.get("name").and_then(|v| v.as_str())
                            .ok_or_else(|| "name param required for workspaces remove".to_string())?;

                        let (deleted, reloaded) = {
                            let conn = project.query().db().conn();
                            let d = conn.execute(
                                "DELETE FROM workspaces WHERE name = ?1",
                                rusqlite::params![name],
                            ).map_err(|e| format!("Failed to remove workspace: {}", e))?;
                            let all = load_workspaces_from_db(&conn).ok();
                            (d, all)
                        };

                        if let Some(all) = reloaded {
                            let mut roots_lock = state.roots.lock().await;
                            let norm = project_root.to_string_lossy().replace('\\', "/");
                            if let Some(rf) = roots_lock.iter_mut().find(|r| r.path.replace('\\', "/") == norm) {
                                rf.sub_workspaces = all;
                            }
                        }

                        Ok(serde_json::json!({
                            "status": if deleted > 0 { "removed" } else { "not_found" },
                            "name": name,
                        }))
                    }
                    "set_active" => {
                        let name = params.get("name").and_then(|v| v.as_str())
                            .ok_or_else(|| "name param required for set_active".to_string())?;

                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);

                        {
                            let conn = project.query().db().conn();
                            conn.execute(
                                "UPDATE workspaces SET last_active_at = ?1 WHERE name = ?2",
                                rusqlite::params![now, name],
                            ).map_err(|e| format!("Failed to set active: {}", e))?;
                        }

                        {
                            let mut roots_lock = state.roots.lock().await;
                            for rf in roots_lock.iter_mut() {
                                if let Some(ws) = rf.sub_workspaces.iter_mut().find(|w| w.name == name) {
                                    ws.last_active_at = now;
                                }
                            }
                        }

                        Ok(serde_json::json!({ "status": "ok", "active": name }))
                    }
                    "rescan" => {
                        let root_for_scan = project_root.to_path_buf();
                        let detected = tokio::task::spawn_blocking(move || {
                            scan_workspaces(&root_for_scan, &root_for_scan, 6)
                        }).await.map_err(|e| format!("Rescan failed: {}", e))?;

                        let (all, count) = {
                            let conn = project.query().db().conn();
                            persist_workspaces_to_db(&conn, &detected)?;
                            let all = load_workspaces_from_db(&conn)?;
                            let c = all.len();
                            (all, c)
                        };
                        {
                            let mut roots_lock = state.roots.lock().await;
                            let norm = project_root.to_string_lossy().replace('\\', "/");
                            if let Some(rf) = roots_lock.iter_mut().find(|r| r.path.replace('\\', "/") == norm) {
                                rf.sub_workspaces = all;
                            }
                        }

                        Ok(serde_json::json!({
                            "status": "ok",
                            "count": count,
                            "detected": detected.len(),
                        }))
                    }
                    _ => Err(format!("Unknown workspaces action: {}. Use: list, search, add, remove, set_active, rescan", action))
                }
            }
            "read_lines" | "peek" => {
                let hash = params.get("hash").or_else(|| params.get("content_hash"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "read_lines requires 'hash' param (e.g. h:abc12345)".to_string())?
                    .trim_start_matches("h:")
                    .to_string();
                let lines = params.get("lines")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "read_lines requires 'lines' param (e.g. \"15-22\" or \"15-22,40-55\")".to_string())?
                    .to_string();
                let file_path_fallback = params.get("file_path")
                    .and_then(|v| v.as_str());
                let context_lines = crate::hash_resolver::normalize_context_lines(
                    params.get("context_lines").and_then(|v| v.as_u64()).map(|v| v as u32)
                );
                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                let registry = hr_state.registry.lock().await;
                let ss_state = app.state::<crate::snapshot::SnapshotServiceState>();
                let mut snapshot_svc = ss_state.service.lock().await;
                let mut result = hash_resolver::peek(&registry, project_root, &hash, &lines, file_path_fallback, context_lines, &mut snapshot_svc)?;
                let want_history = params.get("history").and_then(|v| v.as_bool()).unwrap_or(false);
                if want_history {
                    let source_file = result.get("file").and_then(|v| v.as_str()).map(String::from);
                    if let Some(fp) = source_file {
                        let undo_state = app.state::<UndoStoreState>();
                        let undo_store = undo_state.entries.lock().await;
                        if let Some(prev) = lookup_undo_history(&undo_store, &fp, Some(&hash)) {
                            result.as_object_mut().map(|o| o.insert("previous".to_string(), prev));
                        }
                    }
                }
                Ok(result)
            }
            "batch_edits" => {
                let edits_val = params.get("edits")
                    .ok_or_else(|| "batch_edits requires 'edits' array".to_string())?;
                let mut edits: Vec<hash_resolver::BatchEditEntry> = serde_json::from_value(edits_val.clone())
                    .map_err(|e| format!("Invalid batch_edits format: {}. Expected: [{{file, content_hash?, line_edits:[...]}}]", e))?;
                for entry in &mut edits {
                    crate::resolve_line_edits_symbols_for_file(
                        project.query(),
                        project_root,
                        &entry.file,
                        &mut entry.line_edits,
                        true,
                    )?;
                }
                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                let mut registry = hr_state.registry.lock().await;
                let ss_state = app.state::<crate::snapshot::SnapshotServiceState>();
                let mut snapshot_svc = ss_state.service.lock().await;
                let batch_result = hash_resolver::batch_edits(&mut registry, project_root, edits, &mut snapshot_svc)?;
                drop(registry);
                drop(snapshot_svc);

                for ue in &batch_result.undo_entries {
                    let previous_revision = content_hash(&ue.previous_content);
                    let resolved_path = resolve_project_path(project_root, &ue.file_path);
                    if let Ok(meta) = std::fs::metadata(&resolved_path) {
                        let fc_state = app.state::<hash_resolver::FileCacheState>();
                        let mut cache = fc_state.cache.lock().await;
                        cache.insert(
                            resolved_path.to_string_lossy().to_string(),
                            ue.new_hash.clone(),
                            metadata_modified_ns(&meta),
                            meta.len(),
                        );
                    }
                    let _ = app.emit("canonical_revision_changed", serde_json::json!({
                        "path": ue.file_path,
                        "revision": ue.new_hash,
                        "previous_revision": previous_revision,
                    }));
                }

                if !batch_result.undo_entries.is_empty() {
                    let undo_state = app.state::<UndoStoreState>();
                    let mut undo_store = undo_state.entries.lock().await;
                    for ue in batch_result.undo_entries {
                        let stack = undo_store.entry(ue.file_path).or_default();
                        stack.push(UndoEntry {
                            hash: ue.new_hash,
                            content: ue.new_content,
                            parent_hash: None,
                            previous_content: Some(ue.previous_content),
                            previous_format: ue.previous_format,
                            flushed_to_disk: true,
                            created_at: Instant::now(),
                        });
                        if stack.len() > UNDO_STORE_MAX_ENTRIES_PER_FILE {
                            stack.remove(0);
                        }
                    }
                }

                Ok(batch_result.json)
            }
            // ================================================================
            // HPP Refactoring Pipeline (impact_analysis, refactor_plan, refactor_rollback)
            // ================================================================
            "impact_analysis" => {
                // Compute full blast radius of a proposed refactoring operation.
                // Composes symbol_usage + dependency graph to return every affected
                // location as file:line pairs.
                let symbol_names: Vec<String> = params
                    .get("symbol_names")
                    .or_else(|| params.get("symbols"))
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                    .or_else(|| {
                        params.get("symbol").and_then(|v| v.as_str()).map(|s| vec![s.to_string()])
                    })
                    .unwrap_or_default();
                
                if symbol_names.is_empty() {
                    return Err("impact_analysis requires symbol_names (or symbol) to analyze".to_string());
                }
                
                let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("move");
                let from_file = params.get("from").or_else(|| params.get("file_path")).and_then(|v| v.as_str());
                let to_file = params.get("to").or_else(|| params.get("target_file")).and_then(|v| v.as_str());
                let filter_string_literals = params.get("filter_string_literals")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                
                let mut impact_results: Vec<serde_json::Value> = Vec::new();
                
                for symbol_name in &symbol_names {
                    let usage = match project.query().get_symbol_usage(symbol_name) {
                        Ok(u) => u,
                        Err(e) => {
                            impact_results.push(serde_json::json!({
                                "symbol": symbol_name,
                                "error": format!("Symbol usage lookup failed: {}", e)
                            }));
                            continue;
                        }
                    };
                    
                    let definitions: Vec<serde_json::Value> = usage.definitions.iter().map(|d| {
                        serde_json::json!({
                            "file": d.file,
                            "line": d.line,
                            "kind": d.kind,
                            "signature": d.signature
                        })
                    }).collect();
                    
                    let mut string_literal_filtered: usize = 0;
                    let references: Vec<serde_json::Value> = usage.references.iter().filter_map(|r| {
                        let context_line = {
                            let ref_path = resolve_project_path(project_root, &r.file);
                            std::fs::read_to_string(&ref_path).ok().and_then(|content| {
                                content.lines().nth((r.line as usize).saturating_sub(1)).map(|l| l.to_string())
                            }).unwrap_or_default()
                        };
                        // Filter out string-literal matches: lines where the symbol name
                        // appears only inside a quoted string, match arm pattern, or
                        // format!() macro. These are not real code references.
                        if filter_string_literals {
                            let trimmed_ctx = context_line.trim();
                            let is_string_literal_match = {
                                let in_quotes = trimmed_ctx.starts_with('"')
                                    || trimmed_ctx.starts_with("r\"")
                                    || trimmed_ctx.starts_with("r#\"");
                                let is_format_or_doc = trimmed_ctx.starts_with("format!(")
                                    || trimmed_ctx.starts_with("println!(")
                                    || trimmed_ctx.starts_with("eprintln!(")
                                    || trimmed_ctx.starts_with("///")
                                    || trimmed_ctx.starts_with("//!");
                                let quoted_symbol = context_line.contains(&format!("\"{}\"", symbol_name))
                                    || context_line.contains(&format!("\"{}\"", symbol_name.replace('_', "")));
                                // Match arm string patterns like `"symbol_name" =>`
                                let is_match_arm = trimmed_ctx.contains("=>")
                                    && (quoted_symbol || in_quotes);
                                in_quotes || is_format_or_doc || (quoted_symbol && !trimmed_ctx.contains("use ")) || is_match_arm
                            };
                            if is_string_literal_match {
                                string_literal_filtered += 1;
                                return None;
                            }
                        }
                        // Filter out substring matches: the symbol must appear as a whole
                        // word (not as part of a longer identifier like "string" matching "tri").
                        {
                            let ctx_bytes = context_line.as_bytes();
                            let sym_bytes = symbol_name.as_bytes();
                            let mut has_word_boundary_match = false;
                            let mut search_from = 0usize;
                            while let Some(pos) = context_line[search_from..].find(symbol_name.as_str()) {
                                let abs_pos = search_from + pos;
                                let before_ok = abs_pos == 0 || {
                                    let c = ctx_bytes[abs_pos - 1];
                                    !(c.is_ascii_alphanumeric() || c == b'_')
                                };
                                let after_pos = abs_pos + sym_bytes.len();
                                let after_ok = after_pos >= ctx_bytes.len() || {
                                    let c = ctx_bytes[after_pos];
                                    !(c.is_ascii_alphanumeric() || c == b'_')
                                };
                                if before_ok && after_ok {
                                    has_word_boundary_match = true;
                                    break;
                                }
                                search_from = abs_pos + 1;
                            }
                            if !has_word_boundary_match {
                                string_literal_filtered += 1;
                                return None;
                            }
                        }
                        let kind = if context_line.contains("::") {
                            "qualified_call"
                        } else if context_line.contains("use ") || context_line.contains("import ") {
                            "import"
                        } else {
                            "reference"
                        };
                        Some(serde_json::json!({
                            "file": r.file,
                            "line": r.line,
                            "kind": kind,
                            "context": context_line.trim()
                        }))
                    }).collect();
                    
                    let files_touched: Vec<String> = {
                        let mut files: std::collections::HashSet<String> = std::collections::HashSet::new();
                        for d in &usage.definitions { files.insert(d.file.clone()); }
                        for r in &usage.references { files.insert(r.file.clone()); }
                        files.into_iter().collect()
                    };
                    
                    // Check which imports in the source file are still needed by remaining code
                    let imports_affected: Vec<serde_json::Value> = if let Some(src) = from_file {
                        let resolved = resolve_project_path(project_root, src);
                        if let Ok(src_content) = std::fs::read_to_string(&resolved) {
                            let import_lines: Vec<String> = src_content.lines()
                                .filter(|l| {
                                    let trimmed = l.trim();
                                    trimmed.starts_with("use ") || trimmed.starts_with("import ")
                                        || trimmed.starts_with("from ") || trimmed.starts_with("#include")
                                })
                                .map(|l| l.to_string())
                                .collect();
                            import_lines.iter().map(|imp| {
                                let used_by_symbol = imp.contains(symbol_name);
                                serde_json::json!({
                                    "import": imp,
                                    "used_by_symbol": used_by_symbol,
                                    "file": src
                                })
                            }).collect()
                        } else { Vec::new() }
                    } else { Vec::new() };
                    
                    let mut entry = serde_json::json!({
                        "symbol": symbol_name,
                        "action": action,
                        "from": from_file,
                        "to": to_file,
                        "definitions": definitions,
                        "references": references,
                        "imports_affected": imports_affected,
                        "files_touched": files_touched,
                        "total_references": references.len(),
                        "total_definitions": definitions.len()
                    });
                    if string_literal_filtered > 0 {
                        entry.as_object_mut().unwrap().insert(
                            "string_literal_filtered".to_string(),
                            serde_json::json!(string_literal_filtered),
                        );
                    }
                    impact_results.push(entry);
                }
                
                let total_refs: usize = impact_results.iter()
                    .filter_map(|r| r.get("total_references").and_then(|v| v.as_u64()))
                    .map(|v| v as usize).sum();
                let total_filtered: usize = impact_results.iter()
                    .filter_map(|r| r.get("string_literal_filtered").and_then(|v| v.as_u64()))
                    .map(|v| v as usize).sum();
                let all_files: Vec<String> = impact_results.iter()
                    .filter_map(|r| r.get("files_touched").and_then(|v| v.as_array()))
                    .flat_map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())))
                    .collect::<std::collections::HashSet<String>>()
                    .into_iter().collect();
                
                let mut summary = serde_json::json!({
                    "symbols_analyzed": symbol_names.len(),
                    "total_references": total_refs,
                    "total_files_affected": all_files.len(),
                    "files_affected": all_files
                });
                if total_filtered > 0 {
                    summary.as_object_mut().unwrap().insert(
                        "string_literal_matches_filtered".to_string(),
                        serde_json::json!(total_filtered),
                    );
                }
                if total_refs > 100 {
                    summary.as_object_mut().unwrap().insert(
                        "warning".to_string(),
                        serde_json::json!(
                            "High reference count may include false positives. \
                             Cross-check with symbol_usage for precise counts."
                        ),
                    );
                }
                
                // Confidence signals: detect test files and flag low-confidence scenarios
                let is_test_file = from_file.map_or(false, |f| {
                    let fl = f.to_lowercase();
                    fl.contains("test") || fl.contains("spec") || fl.ends_with("_test.go")
                        || fl.starts_with("test_") || fl.contains("/tests/")
                });
                let confidence = if is_test_file && total_refs == 0 {
                    "high"
                } else if total_refs == 0 {
                    "medium"
                } else {
                    "high"
                };
                summary.as_object_mut().unwrap().insert("is_test".to_string(), serde_json::json!(is_test_file));
                summary.as_object_mut().unwrap().insert("confidence".to_string(), serde_json::json!(confidence));
                if is_test_file && total_refs == 0 {
                    summary.as_object_mut().unwrap().insert(
                        "_hint".to_string(),
                        serde_json::json!("Test functions invoked by runner, 0 refs expected."),
                    );
                } else if !is_test_file && total_refs == 0 {
                    summary.as_object_mut().unwrap().insert(
                        "_hint".to_string(),
                        serde_json::json!("0 refs found. May be invoked via reflection, macros, or dynamic dispatch â€” verify manually."),
                    );
                }

                let (risk_level, advisory) = if total_refs <= 5 {
                    ("low", "Safe to proceed with extraction.")
                } else if total_refs <= 15 {
                    ("medium", "Review all references before extraction. Consider phased approach.")
                } else {
                    ("high", "Decompose into sub-extractions first. Too many references for safe single-pass.")
                };
                summary.as_object_mut().unwrap().insert("risk_level".to_string(), serde_json::json!(risk_level));
                summary.as_object_mut().unwrap().insert("advisory".to_string(), serde_json::json!(advisory));

                Ok(serde_json::json!({
                    "impact": impact_results,
                    "summary": summary,
                    "_next": format!(
                        "[{}] {} references across {} files.{} {}",
                        risk_level.to_uppercase(), total_refs, all_files.len(),
                        if total_filtered > 0 {
                            format!(" ({} string-literal matches filtered.)", total_filtered)
                        } else {
                            String::new()
                        },
                        advisory
                    )
                }))
            }
            "refactor_plan" => {
                return Ok(serde_json::json!({
                    "status": "deprecated",
                    "_hint": "refactor_plan has been removed. Use refactor(action:'execute') directly â€” it now accepts an 'operations' array for batch refactoring with per-operation lint gates and resume_after support."
                }));
            }
            "refactor_rollback" => {
                // Try to acquire the refactor mutex with a bounded wait so rollback
                // fails fast when a long-running execute holds the lock.
                let refactor_state = app.state::<RefactorMutexState>();
                let _refactor_guard = {
                    const MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
                    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
                    let deadline = tokio::time::Instant::now() + MAX_WAIT;
                    loop {
                        match refactor_state.guard.try_lock() {
                            Ok(guard) => break guard,
                            Err(_) => {
                                if tokio::time::Instant::now() >= deadline {
                                    return Err(
                                        "refactor_rollback: a refactor operation is in progress. \
                                         Retry after it completes, or use system.git(action:'restore') as a fallback."
                                            .to_string(),
                                    );
                                }
                                tokio::time::sleep(POLL_INTERVAL).await;
                            }
                        }
                    }
                };
                let restore_entries: Vec<serde_json::Value> = params.get("restore")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .ok_or("refactor_rollback requires 'restore' array of {file, hash} entries")?;
                
                if restore_entries.is_empty() {
                    return Err("restore array is empty".to_string());
                }
                
                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                
                let mut restored: Vec<serde_json::Value> = Vec::new();
                let mut errors: Vec<serde_json::Value> = Vec::new();
                let mut modified_files: Vec<String> = Vec::new();
                
                for entry in &restore_entries {
                    let file_path = entry.get("file").and_then(|v| v.as_str())
                        .unwrap_or("");
                    let hash = entry.get("hash").and_then(|v| v.as_str())
                        .unwrap_or("").trim_start_matches("h:");
                    
                    if file_path.is_empty() || hash.is_empty() {
                        errors.push(serde_json::json!({
                            "file": file_path, "error": "file and hash are both required"
                        }));
                        continue;
                    }
                    
                    // Resolve content from per-entry registry lock (avoids holding lock across all I/O).
                    let content_from_registry = {
                        let registry = hr_state.registry.lock().await;
                        registry.resolve_content_original(hash).map(|c| c.to_string())
                    };
                    match content_from_registry {
                        Some(content) => {
                            let resolved = resolve_project_path(project_root, file_path);
                            let fmt = if resolved.exists() {
                                std::fs::read(&resolved)
                                    .map(|raw| detect_format(&raw))
                                    .unwrap_or_else(|_| FileFormat::default())
                            } else {
                                FileFormat::default()
                            };
                            let normalized = normalize_line_endings(&content);
                            let bytes = serialize_with_format(&normalized, &fmt);
                            match std::fs::write(&resolved, &bytes) {
                                Ok(()) => {
                                    modified_files.push(file_path.to_string());
                                    restored.push(serde_json::json!({
                                        "file": file_path,
                                        "hash": hash,
                                        "status": "restored",
                                        "lines": content.lines().count()
                                    }));
                                }
                                Err(e) => {
                                    errors.push(serde_json::json!({
                                        "file": file_path,
                                        "error": format!("Write failed: {}", e)
                                    }));
                                }
                            }
                        }
                        None => {
                            // Try undo store as fallback (registry lock already released).
                            let undo_state = app.state::<UndoStoreState>();
                            let undo_store = undo_state.entries.lock().await;
                            let undo_content: Option<String> = undo_store.values().flatten()
                                .find(|e| e.hash == hash || e.hash.starts_with(hash))
                                .map(|e| e.content.clone());
                            drop(undo_store);
                            match undo_content {
                                Some(content) => {
                                    let resolved = resolve_project_path(project_root, file_path);
                                    let fmt = if resolved.exists() {
                                        std::fs::read(&resolved)
                                            .map(|raw| detect_format(&raw))
                                            .unwrap_or_else(|_| FileFormat::default())
                                    } else {
                                        FileFormat::default()
                                    };
                                    let normalized = normalize_line_endings(&content);
                                    let bytes = serialize_with_format(&normalized, &fmt);
                                    match std::fs::write(&resolved, &bytes) {
                                        Ok(()) => {
                                            modified_files.push(file_path.to_string());
                                            restored.push(serde_json::json!({
                                                "file": file_path,
                                                "hash": hash,
                                                "status": "restored_from_undo_store"
                                            }));
                                        }
                                        Err(e) => {
                                            errors.push(serde_json::json!({
                                                "file": file_path,
                                                "error": format!("Write failed: {}", e)
                                            }));
                                        }
                                    }
                                }
                                None => {
                                    errors.push(serde_json::json!({
                                        "file": file_path,
                                        "hash": hash,
                                        "error": "Hash not found in registry or undo store"
                                    }));
                                }
                            }
                        }
                    }
                }

                // Delete files created during the refactor
                let delete_paths: Vec<String> = params.get("delete")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();

                let mut deleted: Vec<String> = Vec::new();
                for rel_path in &delete_paths {
                    let resolved = resolve_project_path(project_root, rel_path);
                    match std::fs::remove_file(&resolved) {
                        Ok(()) => deleted.push(rel_path.clone()),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            deleted.push(rel_path.clone());
                        }
                        Err(e) => {
                            errors.push(serde_json::json!({
                                "file": rel_path,
                                "error": format!("Delete failed: {}", e)
                            }));
                        }
                    }
                }

                // Re-index restored files
                let index_result = if !modified_files.is_empty() {
                    let indexer = project.indexer().clone();
                    index_modified_files(&app, indexer.clone(), project_root_owned.clone(), modified_files.clone()).await
                } else {
                    serde_json::json!(null)
                };
                
                Ok(serde_json::json!({
                    "restored": restored,
                    "deleted": deleted,
                    "errors": errors,
                    "index": index_result,
                    "summary": {
                        "files_restored": restored.len(),
                        "files_deleted": deleted.len(),
                        "files_failed": errors.len()
                    },
                    "_rollback_applied": format!("Applied {} restore and {} delete entries.", restored.len(), deleted.len()),
                    "_next": if errors.is_empty() {
                        "All files restored and created files deleted. Run q: v1 verify.typecheck to validate."
                    } else {
                        "Some files could not be restored. Check errors array."
                    }
                }))
            }
            "refactor" => {
                // Unified refactor dispatcher â€” routes to HPP pipeline (execute) or legacy operations.
                let action = params.get("action").and_then(|v| v.as_str())
                    .ok_or("refactor requires 'action' param (inventory, rename, move, extract, execute, impact_analysis, plan, rollback)")?;

                // â”€â”€ execute: hash-addressed line-edit refactoring pipeline â”€â”€
                // Accepts single op (flat params) or batch (operations array).
                // On lint error: pauses at failing op for model to revise, no auto-rollback.
                // Supports resume_after to continue a paused batch.
                if action == "execute" {
                    let refactor_state = app.state::<RefactorMutexState>();
                    let _refactor_guard = refactor_state.guard.lock().await;
                    let project_root_owned = project_root.to_path_buf();

                    // â”€â”€ normalize input: single op or batch â”€â”€
                    let operations: Vec<serde_json::Value> = if let Some(ops) = params.get("operations").and_then(|v| v.as_array()) {
                        ops.clone()
                    } else {
                        vec![serde_json::json!({
                            "create": params.get("create"),
                            "source": params.get("source"),
                            "file": params.get("file"),
                            "remove_lines": params.get("remove_lines"),
                            "import_updates": params.get("import_updates"),
                            "extract": params.get("extract"),
                            "from": params.get("from"),
                            "to": params.get("to")
                        })]
                    };

                    if operations.is_empty() {
                        return Err("refactor execute requires at least one operation".into());
                    }

                    // Batch extraction shortcut: when top-level params contain an
                    // `extractions` array (the batch format), convert each extraction
                    // into individual `extract` ops and process them sequentially.
                    // This bridges the gap between the batch `extractions:[{symbols, target}]`
                    // format and the single-op `extract:"fn(name)"` pipeline.
                    if let Some(extractions_arr) = params.get("extractions").and_then(|v| v.as_array()) {
                        if !extractions_arr.is_empty() {
                            let source_file = params.get("file_path")
                                .or_else(|| params.get("source_file"))
                                .or_else(|| params.get("file"))
                                .or_else(|| params.get("from"))
                                .and_then(|v| v.as_str());
                            if let Some(src) = source_file {
                                let mut converted_ops: Vec<serde_json::Value> = Vec::new();
                                for extraction in extractions_arr {
                                    let target_file = extraction.get("target_file")
                                        .or_else(|| extraction.get("target"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let symbols = extraction.get("symbols")
                                        .or_else(|| extraction.get("methods"))
                                        .and_then(|v| v.as_array());
                                    if let Some(syms) = symbols {
                                        for sym_val in syms {
                                            if let Some(sym_name) = sym_val.as_str() {
                                                converted_ops.push(serde_json::json!({
                                                    "extract": format!("fn({})", sym_name),
                                                    "from": src,
                                                    "to": target_file,
                                                }));
                                            }
                                        }
                                    }
                                }
                                if !converted_ops.is_empty() {
                                    let mut redirect = serde_json::json!({
                                        "action": "execute",
                                        "operations": converted_ops,
                                    });
                                    // Forward optional params
                                    for key in &["incremental", "resume_after", "dry_run"] {
                                        if let Some(v) = params.get(*key) {
                                            redirect[*key] = v.clone();
                                        }
                                    }
                                    return Box::pin(atls_batch_query(
                                        app.clone(),
                                        "refactor".to_string(),
                                        redirect,
                                    )).await;
                                }
                            }
                        }
                    }

                    let resume_after: i64 = params.get("resume_after")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(-1);

                    let incremental = params.get("incremental")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    // â”€â”€ snapshot ALL source/consumer files across ALL operations upfront â”€â”€
                    struct Snapshot { file: String, content: String }
                    let mut snapshots: Vec<Snapshot> = Vec::new();
                    let mut created_files: Vec<std::path::PathBuf> = Vec::new();
                    let mut all_results: Vec<serde_json::Value> = Vec::new();
                    let mut all_modified: Vec<String> = Vec::new();

                    let snapshot_file = |snapshots: &mut Vec<Snapshot>, root: &std::path::Path, file_path: &str| {
                        if snapshots.iter().any(|s| s.file == file_path) { return; }
                        let resolved = resolve_project_path(root, file_path);
                        if let Ok(content) = std::fs::read_to_string(&resolved).map(|c| normalize_line_endings(&c)) {
                            snapshots.push(Snapshot { file: file_path.to_string(), content });
                        }
                    };

                    // Collect all files that will be touched, snapshot them once.
                    // Check both `source` and `from` keys â€” declarative extract ops
                    // use `from` as the source reference before expansion.
                    for op in &operations {
                        for key in &["source", "from"] {
                            let source_hash = op.get(*key).and_then(|v| v.as_str()).unwrap_or("");
                            if !source_hash.is_empty() {
                                let clean = source_hash.strip_prefix("h:").unwrap_or(source_hash);
                                let sp = if clean.chars().all(|c| c.is_ascii_hexdigit()) && clean.len() >= 6 {
                                    let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                    let registry = hr_state.registry.lock().await;
                                    registry.get(clean).and_then(|e| e.source.clone())
                                } else {
                                    Some(source_hash.to_string())
                                };
                                if let Some(sp) = sp {
                                    snapshot_file(&mut snapshots, &project_root_owned, &sp);
                                }
                            }
                        }
                        if let Some(imports) = op.get("import_updates").and_then(|v| v.as_array()) {
                            let op_file = op.get("file").and_then(|v| v.as_str()).unwrap_or("");
                            for upd in imports {
                                let file_ref = upd.get("file").and_then(|v| v.as_str())
                                    .unwrap_or(op_file);
                                if file_ref.is_empty() { continue; }
                                let file_path = {
                                    let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                    let registry = hr_state.registry.lock().await;
                                    let clean = file_ref.strip_prefix("h:").unwrap_or(file_ref);
                                    registry.get(clean).and_then(|e| e.source.clone()).unwrap_or_else(|| file_ref.to_string())
                                };
                                snapshot_file(&mut snapshots, &project_root_owned, &file_path);
                            }
                        }
                    }

                    // Register snapshot hashes so _rollback refs resolve
                    for snap in &snapshots {
                        let h = content_hash(&snap.content);
                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                        let mut registry = hr_state.registry.lock().await;
                        let prev_rev = registry.get_current_revision(&snap.file);
                        registry.register(h.clone(), hash_resolver::HashEntry {
                            source: Some(snap.file.clone()),
                            content: snap.content.clone(),
                            tokens: snap.content.len() / 4,
                            lang: hash_resolver::detect_lang(Some(snap.file.as_str())),
                            line_count: snap.content.lines().count(),
                            symbol_count: None,
                        });
                        if snap.file.contains('/') || snap.file.contains('\\') {
                            let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                "path": snap.file,
                                "revision": h,
                                "previous_revision": prev_rev
                            }));
                        }
                    }

                    // In-memory source content: ops read from this instead of disk so
                    // sequential removals on the same file see prior edits. Updated after each remove_lines.
                    let mut source_content_map: std::collections::HashMap<String, String> = snapshots
                        .iter()
                        .map(|s| (s.file.clone(), s.content.clone()))
                        .collect();

                    // Accumulated target content: when multiple extract ops write to the
                    // same target file, subsequent ops merge into the accumulated content
                    // instead of overwriting. Updated after each create step.
                    let mut target_content_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

                    let build_rollback_data = |snapshots: &[Snapshot], created: &[std::path::PathBuf], root: &std::path::Path| -> serde_json::Value {
                        let restore: Vec<serde_json::Value> = snapshots.iter().map(|s| {
                            let h = content_hash(&s.content);
                            serde_json::json!({"file": s.file, "hash": format!("h:{}", &h[..hash_resolver::SHORT_HASH_LEN])})
                        }).collect();
                        let delete: Vec<String> = created.iter()
                            .filter_map(|p| p.to_str().map(|s| to_relative_path(root, s)))
                            .collect();
                        serde_json::json!({
                            "restore": restore,
                            "delete": delete,
                            "_rollback_hint": "When rolling back, pass the ENTIRE restore and delete arrays to refactor(action:'rollback'). Do not subset."
                        })
                    };

                    // Track cumulative line shifts per source file from prior remove_lines ops.
                    // Key = resolved file path, Value = Vec<(removed_start, removed_count)> sorted by line.
                    let mut line_shifts: std::collections::HashMap<String, Vec<(u32, u32)>> = std::collections::HashMap::new();

                    // Adjust an ORIGINAL line number to its current position after
                    // prior removals. Shifts are stored in original coordinates, so
                    // we accumulate total removed lines before the target rather than
                    // iteratively adjusting (which mis-compares adjusted values against
                    // original ranges).
                    fn adjust_line_for_shifts(line: u32, shifts: &[(u32, u32)]) -> u32 {
                        let mut total_removed_before = 0u32;
                        for &(removed_start, removed_count) in shifts {
                            if line >= removed_start + removed_count {
                                total_removed_before += removed_count;
                            } else if line >= removed_start {
                                return removed_start.saturating_sub(total_removed_before);
                            }
                        }
                        line.saturating_sub(total_removed_before)
                    }

                    /// Collect remove_lines specs: array of strings, or comma-separated string.
                    fn collect_remove_lines_specs(op: &serde_json::Value) -> Vec<String> {
                        match op.get("remove_lines") {
                            None => vec![],
                            Some(serde_json::Value::Array(arr)) => arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .filter(|s| !s.trim().is_empty())
                                .collect(),
                            Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s
                                .split(',')
                                .map(|p| p.trim().to_string())
                                .filter(|p| !p.is_empty())
                                .collect(),
                            _ => vec![],
                        }
                    }

                    /// Resolve symbol-anchor syntax in `remove_lines` to a (start, end) range.
                    /// Accepts all UHPP symbol kinds. Supports `#N` overload suffix.
                    /// Returns 1-based line range.
                    fn resolve_remove_lines_symbol_anchor(
                        remove_str: &str, content: &str, lang: Option<&str>,
                    ) -> Option<(u32, Option<u32>)> {
                        let (kind, name) = shape_ops::parse_symbol_anchor_str(remove_str)?;
                        let (start, end) = shape_ops::resolve_symbol_anchor_lines_lang(
                            content, kind, name, lang,
                        ).ok()?;
                        Some((start, Some(end)))
                    }

                    // â”€â”€ pre-scan: count removals per source file â”€â”€
                    // When multiple ops extract from the same source, intermediate
                    // lint checks see "undefined" errors for symbols removed by an
                    // earlier op but still referenced by a not-yet-removed sibling.
                    // We defer the lint check until the LAST removal for each source.
                    let mut source_removal_total: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
                    // Tracks extracted symbol names and their target files per source.
                    // Used after the last removal to add source-to-target imports when
                    // remaining code in the source still references extracted symbols.
                    let mut source_extract_info: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();
                    for op in &operations {
                        let has_remove = !collect_remove_lines_specs(op).is_empty()
                            || op.get("extract").is_some();
                        if !has_remove { continue; }
                        let source_ref = op.get("source").and_then(|v| v.as_str())
                            .or_else(|| op.get("from").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        if source_ref.is_empty() { continue; }
                        let resolved_source = {
                            let clean = source_ref.strip_prefix("h:").unwrap_or(source_ref);
                            if clean.chars().all(|c| c.is_ascii_hexdigit()) && clean.len() >= 6 {
                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                let registry = hr_state.registry.lock().await;
                                registry.get(clean).and_then(|e| e.source.clone())
                                    .unwrap_or_else(|| source_ref.to_string())
                            } else {
                                source_ref.to_string()
                            }
                        };
                        *source_removal_total.entry(resolved_source.clone()).or_insert(0) += 1;
                        if let Some(extract_sym) = op.get("extract").and_then(|v| v.as_str()) {
                            let target_path = op.get("to").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            if let (Some(open), Some(close)) = (extract_sym.find('('), extract_sym.rfind(')')) {
                                if close > open + 1 {
                                    source_extract_info.entry(resolved_source)
                                        .or_default()
                                        .push((extract_sym[open + 1..close].to_string(), target_path));
                                }
                            }
                        }
                    }
                    let mut source_removal_done: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

                    // â”€â”€ iterate operations â”€â”€
                    for (op_idx, op) in operations.iter().enumerate() {
                        if (op_idx as i64) <= resume_after { continue; }

                        // â”€â”€ pre-flight safety check for symbol-anchor removals â”€â”€
                        let remove_specs = collect_remove_lines_specs(op);
                        for rl in &remove_specs {
                            let source_ref = op.get("source").and_then(|v| v.as_str()).unwrap_or("");
                            if !source_ref.is_empty() {
                                let src_path = {
                                    let clean = source_ref.strip_prefix("h:").unwrap_or(source_ref);
                                    if clean.chars().all(|c| c.is_ascii_hexdigit()) && clean.len() >= 6 {
                                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                        let registry = hr_state.registry.lock().await;
                                        registry.get(clean).and_then(|e| e.source.clone())
                                    } else {
                                        Some(source_ref.to_string())
                                    }
                                };
                                if let Some(sp) = src_path {
                                    let src_content = source_content_map.get(&sp).cloned().or_else(|| {
                                        std::fs::read_to_string(&resolve_project_path(&project_root_owned, &sp))
                                            .ok().map(|c| normalize_line_endings(&c))
                                    });
                                    if let Some(src_content) = src_content {
                                        let src_lang = hash_resolver::detect_lang(Some(sp.as_str()));
                                        let (pf_warnings, pf_errors) = preflight_extract_check(
                                            &src_content, rl, src_lang.as_deref(),
                                        );
                                        if !pf_errors.is_empty() {
                                            return Ok(serde_json::json!({
                                                "status": "preflight_failed",
                                                "phase": "preflight",
                                                "failed_operation_index": op_idx,
                                                "file": sp,
                                                "remove_lines_spec": rl,
                                                "blocking_errors": pf_errors,
                                                "warnings": pf_warnings,
                                                "completed_operations": all_results,
                                                "_rollback": build_rollback_data(&snapshots, &created_files, &project_root_owned),
                                                "_hint": "Pre-flight check found blocking issues. The symbol may be inside a macro body or have other structural problems. Fix the source or adjust the extraction target before retrying."
                                            }));
                                        }
                                        if !pf_warnings.is_empty() {
                                            all_results.push(serde_json::json!({
                                                "op": op_idx,
                                                "phase": "preflight",
                                                "preflight_warnings": pf_warnings,
                                            }));
                                        }
                                    }
                                }
                            }
                        }

                        // â”€â”€ declarative extract expansion â”€â”€
                        // `extract: "fn(name)", from: "h:XXX", to: "target.ts"` compiles to
                        // `create + remove_lines + import_updates` using symbol resolution.
                        #[allow(unused_assignments)]
                        let mut expanded_op: Option<serde_json::Value> = None;
                        let op = if let Some(extract_sym) = op.get("extract").and_then(|v| v.as_str()) {
                            let from_source = op.get("from").and_then(|v| v.as_str())
                                .unwrap_or(op.get("source").and_then(|v| v.as_str()).unwrap_or(""));
                            let to_path = op.get("to").and_then(|v| v.as_str())
                                .unwrap_or("");
                            if from_source.is_empty() || to_path.is_empty() {
                                return Err(format!(
                                    "extract op {} requires 'from' (source hash/path) and 'to' (target path)",
                                    op_idx
                                ));
                            }
                            // Resolve source file content to extract the symbol
                            let source_file_path = {
                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                let registry = hr_state.registry.lock().await;
                                let clean = from_source.strip_prefix("h:").unwrap_or(from_source);
                                registry.get(clean).and_then(|e| e.source.clone())
                                    .unwrap_or_else(|| from_source.to_string())
                            };
                            let src_content = source_content_map.get(&source_file_path).cloned()
                                .or_else(|| std::fs::read_to_string(&resolve_project_path(&project_root_owned, &source_file_path))
                                    .ok().map(|c| normalize_line_endings(&c)))
                                .ok_or_else(|| format!("extract: cannot read source '{}'", source_file_path))?;

                            // Resolve symbol to content + line range
                            let (kind, sym_name) = shape_ops::parse_symbol_anchor_str(extract_sym)
                                .ok_or_else(|| format!(
                                    "extract op {}: invalid symbol syntax '{}', expected kind(name) e.g. fn(name)/cls(name)/sym(name)", op_idx, extract_sym
                                ))?;

                            let src_lang = hash_resolver::detect_lang(Some(&source_file_path));
                            let src_line_count = src_content.lines().count();

                            // For Rust files, prefer tree-sitter extraction — it correctly
                            // identifies full `function_item` nodes (signature + body) whereas
                            // the regex path can miscalculate block boundaries for complex
                            // Rust syntax (where clauses, turbofish, nested closures).
                            let is_rust_source = matches!(src_lang.as_deref(), Some("rust" | "rs"));
                            let ts_primary_result: Option<String> = if is_rust_source {
                                let language = src_lang.as_ref()
                                    .map(|l| atls_core::Language::from_str(l))
                                    .unwrap_or(atls_core::Language::Unknown);
                                if language != atls_core::Language::Unknown {
                                    let (base_name, _) = shape_ops::parse_overload_index(sym_name);
                                    find_symbol_by_parsing(&src_content, base_name, language, project.parser_registry())
                                        .and_then(|(start, end, _, _)| {
                                            let lines: Vec<&str> = src_content.lines().collect();
                                            let s = (start as usize).saturating_sub(1);
                                            let e = (end as usize).min(lines.len());
                                            if s < lines.len() && s < e {
                                                Some(lines[s..e].join("\n"))
                                            } else {
                                                None
                                            }
                                        })
                                } else {
                                    None
                                }
                            } else {
                                None
                            };

                            let extracted_content = if let Some(ts_result) = ts_primary_result {
                                Ok(ts_result)
                            } else {
                                shape_ops::resolve_symbol_anchor_lang(&src_content, kind, sym_name, src_lang.as_deref())
                                    .and_then(|regex_result| {
                                        // Cross-validate: if regex result spans >60% of source, the
                                        // brace counter may have been fooled (e.g. JS regex literals
                                        // like /[a-z]{2,4}/). Try tree-sitter and prefer the smaller result.
                                        let regex_lines = regex_result.lines().count();
                                        let threshold = (src_line_count as f64 * 0.6) as usize;
                                        if regex_lines > threshold && src_line_count > 30 {
                                            if let Some(ref l) = src_lang {
                                                let language = atls_core::Language::from_str(l);
                                                if language != atls_core::Language::Unknown {
                                                    let (base_name, _) = shape_ops::parse_overload_index(sym_name);
                                                    if let Some((start, end, _, _)) = find_symbol_by_parsing(&src_content, base_name, language, project.parser_registry()) {
                                                        let lines: Vec<&str> = src_content.lines().collect();
                                                        let s = (start as usize).saturating_sub(1);
                                                        let e = (end as usize).min(lines.len());
                                                        if s < lines.len() {
                                                            let ts_result = lines[s..e].join("\n");
                                                            if ts_result.lines().count() < regex_lines {
                                                                return Ok(ts_result);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        Ok(regex_result)
                                    })
                                    .or_else(|regex_err| {
                                        // Tree-sitter fallback when regex fails entirely
                                        if let Some(ref l) = src_lang {
                                            let language = atls_core::Language::from_str(l);
                                            if language != atls_core::Language::Unknown {
                                                let (base_name, _) = shape_ops::parse_overload_index(sym_name);
                                                if let Some((start, end, _, _)) = find_symbol_by_parsing(&src_content, base_name, language, project.parser_registry()) {
                                                    let lines: Vec<&str> = src_content.lines().collect();
                                                    let s = (start as usize).saturating_sub(1);
                                                    let e = (end as usize).min(lines.len());
                                                    if s < lines.len() {
                                                        return Ok(lines[s..e].join("\n"));
                                                    }
                                                }
                                            }
                                        }
                                        Err(regex_err)
                                    })
                            }.map_err(|e| format!("extract op {}: {}", op_idx, e))?;
                            // Let the create path handle dedent via auto_dedent (default true).
                            // User can override with "auto_dedent": false for templates/generics.
                            let auto_dedent = op.get("auto_dedent")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);
                            let code_body = if auto_dedent {
                                dedent_code_body(&extracted_content)
                            } else {
                                extracted_content
                            };

                            let skip_scaffold = op.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);
                            let content_for_create = if skip_scaffold {
                                code_body
                            } else {
                                build_extracted_target(
                                    &src_content,
                                    &source_file_path,
                                    &code_body,
                                    to_path,
                                    target_content_map.get(to_path).map(|s| s.as_str()),
                                    &project,
                                )
                            };

                            let mut expanded = serde_json::json!({
                                "create": {
                                    "path": to_path,
                                    "content": content_for_create,
                                    "auto_dedent": false,
                                },
                                "source": from_source,
                                "remove_lines": extract_sym,
                            });
                            if let Some(imports) = op.get("import_updates") {
                                expanded["import_updates"] = imports.clone();
                            }
                            if let Some(file) = op.get("file") {
                                expanded["file"] = file.clone();
                            }
                            expanded_op = Some(expanded);
                            expanded_op.as_ref().unwrap()
                        } else {
                            op
                        };

                        let create_spec = op.get("create").and_then(|v| v.as_object());
                        let source_hash = op.get("source").and_then(|v| v.as_str()).unwrap_or("");
                        let remove_specs_for_op = collect_remove_lines_specs(op);
                        let import_updates = op.get("import_updates")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();

                        if create_spec.is_none() && import_updates.is_empty() && remove_specs_for_op.is_empty() {
                            all_results.push(serde_json::json!({
                                "op": op_idx,
                                "status": "skipped",
                                "reason": "Operation has no create, remove_lines, or import_updates. Check param names and structure.",
                                "_received_keys": op.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
                            }));
                            continue;
                        }

                        let source_path: Option<String> = if !source_hash.is_empty() {
                            let clean = source_hash.strip_prefix("h:").unwrap_or(source_hash);
                            if clean.chars().all(|c| c.is_ascii_hexdigit()) && clean.len() >= 6 {
                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                let registry = hr_state.registry.lock().await;
                                registry.get(clean).and_then(|e| e.source.clone())
                            } else {
                                // Already resolved to a file path by resolve_hash_refs
                                Some(source_hash.to_string())
                            }
                        } else {
                            None
                        };

                        // â”€â”€ step 1: create target file â”€â”€
                        if let Some(spec) = create_spec {
                            let path = spec.get("path").and_then(|v| v.as_str())
                                .ok_or("create.path is required")?;
                            let auto_dedent = spec.get("auto_dedent")
                                .and_then(|v| v.as_bool()).unwrap_or(false);

                            // Resolve content: content (string) | from_ref (string) | from_refs (array)
                            let content_owned = if let Some(raw) = spec.get("content")
                                .or_else(|| spec.get("from_ref"))
                                .and_then(|v| v.as_str())
                            {
                                if auto_dedent { dedent_code_body(raw) } else { raw.to_string() }
                            } else if let Some(refs_arr) = spec.get("from_refs").and_then(|v| v.as_array()) {
                                let sep = spec.get("separator").and_then(|v| v.as_str()).unwrap_or("\n\n");
                                let parts: Vec<String> = refs_arr.iter()
                                    .filter_map(|v| v.as_str())
                                    .map(|s| if auto_dedent { dedent_code_body(s) } else { s.to_string() })
                                    .collect();
                                if parts.is_empty() {
                                    return Err("create.from_refs array resolved to zero content parts".into());
                                }
                                parts.join(sep)
                            } else {
                                return Err("create requires 'content', 'from_ref', or 'from_refs'".into());
                            };
                            let content: &str = &content_owned;

                            // Advisory: scan composed content for references to symbols
                            // not defined within it (transitive dependency detection).
                            let mut dep_warnings: Vec<String> = Vec::new();
                            if spec.get("from_refs").is_some() || spec.get("from_ref").is_some() {
                                let target_lang = hash_resolver::detect_lang(Some(path));
                                let is_rust = matches!(target_lang.as_deref(), Some("rust" | "rs"));
                                let is_ts_js = matches!(target_lang.as_deref(), Some("typescript" | "javascript" | "ts" | "js" | "tsx" | "jsx"));

                                // Collect type/trait/struct names defined in this content
                                let local_def_re = regex::Regex::new(
                                    r"(?m)^\s*(?:pub(?:\(crate\))?\s+)?(?:fn|struct|enum|trait|type|const|class|interface|function)\s+(\w+)"
                                ).unwrap();
                                let local_defs: std::collections::HashSet<String> = local_def_re.captures_iter(content)
                                    .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
                                    .collect();

                                // Scan for capitalized identifiers that look like type references
                                let type_ref_re = regex::Regex::new(r"\b([A-Z][a-zA-Z0-9_]{2,})\b").unwrap();
                                let mut referenced_types: std::collections::HashSet<String> = std::collections::HashSet::new();
                                for cap in type_ref_re.captures_iter(content) {
                                    if let Some(m) = cap.get(1) {
                                        let name = m.as_str().to_string();
                                        // Skip common builtins
                                        let builtins = ["String", "Vec", "Option", "Result", "Box", "Arc", "Mutex",
                                            "HashMap", "HashSet", "BTreeMap", "BTreeSet", "Cow", "Rc",
                                            "Promise", "Array", "Map", "Set", "Error", "Object", "Date",
                                            "Some", "None", "Ok", "Err", "Self", "Default", "Debug",
                                            "Clone", "Copy", "Send", "Sync", "Display", "Serialize", "Deserialize"];
                                        if !builtins.contains(&name.as_str()) && !local_defs.contains(&name) {
                                            referenced_types.insert(name);
                                        }
                                    }
                                }

                                // Check for use/import statements already present
                                let has_imports = if is_rust {
                                    content.contains("use ")
                                } else if is_ts_js {
                                    content.contains("import ")
                                } else {
                                    true
                                };

                                if !referenced_types.is_empty() {
                                    let missing: Vec<&String> = referenced_types.iter()
                                        .filter(|t| {
                                            if is_rust { !content.contains(&format!("use ")) || !content.contains(t.as_str()) }
                                            else if is_ts_js { !content.contains(&format!("import")) || !content.contains(t.as_str()) }
                                            else { true }
                                        })
                                        .collect();
                                    if !missing.is_empty() && !has_imports {
                                        dep_warnings.push(format!(
                                            "Composed content references {} type(s) not defined locally and has no import statements: {}. \
                                             Consider adding import_updates for these.",
                                            missing.len(),
                                            missing.iter().take(10).map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                                        ));
                                    }
                                }
                            }

                            let (lint_results, _) = lint_file_contents(
                                &project_root_owned,
                                &[(path.to_string(), content.to_string())],
                                true,
                                false,
                            );
                            let new_errors: usize = lint_results.iter()
                                .filter(|r| r.severity == "error").count();

                            if new_errors > 0 {
                                let broken_lines: Vec<serde_json::Value> = lint_results.iter()
                                    .filter(|r| r.severity == "error")
                                    .take(5)
                                    .map(|r| serde_json::json!({
                                        "line": r.line,
                                        "msg": &r.message,
                                        "context": extract_error_context(content, r.line, 5)
                                    }))
                                    .collect();

                                let rollback_data = build_rollback_data(&snapshots, &created_files, &project_root_owned);

                                if incremental {
                                    for snap in &snapshots {
                                        let r = resolve_project_path(&project_root_owned, &snap.file);
                                        if let Err(e) = std::fs::write(&r, &snap.content) {
                                            eprintln!("[refactor] rollback write failed for {}: {}", snap.file, e);
                                        }
                                    }
                                    for cf in &created_files {
                                        if let Err(e) = std::fs::remove_file(cf) {
                                            eprintln!("[refactor] rollback delete failed for {}: {}", cf.display(), e);
                                        }
                                    }
                                }

                                return Ok(serde_json::json!({
                                    "status": if incremental { "rolled_back" } else { "paused" },
                                    "auto_rolled_back": incremental,
                                    "phase": "create_lint",
                                    "failed_operation_index": op_idx,
                                    "file": path,
                                    "lint_errors": new_errors,
                                    "details": broken_lines,
                                    "completed_operations": all_results,
                                    "_rollback": rollback_data,
                                    "_hint": "Fix create.content for this operation and resubmit with resume_after set to the last successful index, or rollback."
                                }));
                            }

                            let resolved = resolve_project_path(&project_root_owned, path);
                            if let Some(parent) = resolved.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            std::fs::write(&resolved, content)
                                .map_err(|e| format!("Failed to create {}: {}", path, e))?;

                            if !resolved.exists() {
                                return Err(format!(
                                    "Refactor write verification failed: {} was not found on disk after write",
                                    path
                                ).into());
                            }
                            if let Ok(meta) = std::fs::metadata(&resolved) {
                                if (meta.len() as usize) != content.len() {
                                    eprintln!(
                                        "[refactor] write verification warning: {} expected {} bytes, found {} on disk",
                                        path, content.len(), meta.len()
                                    );
                                }
                            }

                            created_files.push(resolved);
                            target_content_map.insert(path.to_string(), content.to_string());

                            let new_hash = content_hash(content);
                            {
                                let path_str = path.to_string();
                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                let mut registry = hr_state.registry.lock().await;
                                let prev_rev = registry.get_current_revision(&path_str);
                                registry.register(new_hash.clone(), hash_resolver::HashEntry {
                                    source: Some(path_str.clone()),
                                    content: content.to_string(),
                                    tokens: content.len() / 4,
                                    lang: hash_resolver::detect_lang(Some(path)),
                                    line_count: content.lines().count(),
                                    symbol_count: None,
                                });
                                if path_str.contains('/') || path_str.contains('\\') {
                                    let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                        "path": path_str,
                                        "revision": new_hash,
                                        "previous_revision": prev_rev
                                    }));
                                }
                            }

                            let mut create_result = serde_json::json!({
                                "op": op_idx, "f": path, "h": format!("h:{}", &new_hash[..hash_resolver::SHORT_HASH_LEN]), "created": true
                            });
                            if !dep_warnings.is_empty() {
                                create_result["dependency_warnings"] = serde_json::json!(dep_warnings);
                            }
                            all_results.push(create_result);
                            if !all_modified.contains(&path.to_string()) {
                                all_modified.push(path.to_string());
                            }
                        }

                        // â”€â”€ step 2: remove lines from source â”€â”€
                        if let Some(ref sp) = source_path {
                            if !remove_specs_for_op.is_empty() {
                                let resolved = resolve_project_path(&project_root_owned, sp);
                                let current = source_content_map.get(sp).cloned()
                                    .or_else(|| std::fs::read_to_string(&resolved)
                                        .ok().map(|c| normalize_line_endings(&c)))
                                    .ok_or_else(|| format!("Failed to read source {} (not in snapshot and file missing)", sp))?;
                                let old_hash = content_hash(&current);

                                let source_lang = hash_resolver::detect_lang(Some(sp.as_str()));
                                // Resolve each spec to ranges; symbol anchors and line ranges supported.
                                // Symbol-anchor ranges are in current-content coordinates (no shift needed).
                                // Numeric ranges may be in original coordinates (shift needed).
                                let mut symbol_ranges: Vec<(u32, Option<u32>)> = Vec::new();
                                let mut numeric_ranges: Vec<(u32, Option<u32>)> = Vec::new();
                                let mut any_symbol_anchor = false;
                                for spec in &remove_specs_for_op {
                                    if let Some(anchor_range) = resolve_remove_lines_symbol_anchor(spec, &current, source_lang.as_deref()) {
                                        any_symbol_anchor = true;
                                        let (s, e_opt) = anchor_range;
                                        let e = e_opt.unwrap_or(s);
                                        let (exp_s, exp_e) = expand_removal_boundaries(&current, s, e, source_lang.as_deref());
                                        symbol_ranges.push((exp_s, Some(exp_e)));
                                    } else if let Some(parsed) = hash_resolver::parse_line_ranges(spec) {
                                        numeric_ranges.extend(parsed);
                                    }
                                }
                                let all_ranges: Vec<(u32, Option<u32>)> = symbol_ranges.iter().chain(numeric_ranges.iter()).copied().collect();
                                let ranges = if all_ranges.is_empty() { None } else { Some(all_ranges) };

                                // For numeric ranges, validate brace balance before applying
                                if !any_symbol_anchor {
                                    if let Some(ref parsed_ranges) = ranges {
                                        for &(s, e_opt) in parsed_ranges {
                                            let e = e_opt.unwrap_or(s);
                                            if let Err(diag) = crate::refactor_engine::validate_removal_boundaries(
                                                &current, s, e, source_lang.as_deref(),
                                            ) {
                                                let mut paused = serde_json::json!({
                                                    "status": "preflight_failed",
                                                    "phase": "boundary_validation",
                                                    "failed_operation_index": op_idx,
                                                    "file": sp,
                                                    "remove_lines": remove_specs_for_op,
                                                    "diagnostic": diag,
                                                    "_hint": "Use symbol-anchor syntax (e.g. fn(name)) instead of numeric line ranges for safer extraction.",
                                                    "_rollback": build_rollback_data(&snapshots, &created_files, &project_root_owned),
                                                });
                                                if incremental {
                                                    paused["auto_rolled_back"] = serde_json::json!(true);
                                                    for snap in &snapshots {
                                                        let r = resolve_project_path(&project_root_owned, &snap.file);
                                                        if let Err(e) = std::fs::write(&r, &snap.content) {
                                                            eprintln!("[refactor] rollback write failed for {}: {}", snap.file, e);
                                                        }
                                                    }
                                                    for cf in &created_files {
                                                        if let Err(e) = std::fs::remove_file(cf) {
                                                            eprintln!("[refactor] rollback delete failed for {}: {}", cf.display(), e);
                                                        }
                                                    }
                                                }
                                                return Ok(paused);
                                            }
                                        }
                                    }
                                }

                                // Stash first range for error enrichment
                                let original_remove_range: Option<(u32, u32)> = if any_symbol_anchor {
                                    ranges.as_ref().and_then(|r| r.first()).map(|&(s, e_opt)| (s, e_opt.unwrap_or(s)))
                                } else {
                                    None
                                };

                                if let Some(ranges) = ranges {
                                    let prior_shifts = line_shifts.get(sp.as_str()).cloned().unwrap_or_default();
                                    let sym_count = symbol_ranges.len();

                                    // Symbol-anchor ranges are already in current-content
                                    // coordinates; numeric ranges need shift adjustment.
                                    let delete_edits: Vec<LineEdit> = ranges.iter().enumerate().map(|(i, &(start, end))| {
                                        let is_symbol = i < sym_count;
                                        let adj_start = if is_symbol {
                                            start
                                        } else {
                                            adjust_line_for_shifts(start, &prior_shifts)
                                        };
                                        let adj_end = match end {
                                            Some(e) => {
                                                let span = e.saturating_sub(start);
                                                adj_start + span
                                            }
                                            None => current.lines().count() as u32,
                                        };
                                        LineEdit {
                                            line: crate::LineCoordinate::Abs(adj_start),
                                            action: "delete".to_string(),
                                            content: None,
                                            end_line: Some(adj_end),
                                            symbol: None,
                                            position: None,
                                            destination: None,
                                            reindent: false,
                                        }
                                    }).collect();

                                    // Only record numeric-range removals in line_shifts
                                    // (symbol ranges were resolved against current content)
                                    let shift_entry = line_shifts.entry(sp.clone()).or_default();
                                    for &(start, end) in &numeric_ranges {
                                        let count = match end {
                                            Some(e) => e.saturating_sub(start) + 1,
                                            None => 1,
                                        };
                                        shift_entry.push((start, count));
                                    }
                                    shift_entry.sort_by_key(|&(s, _)| s);

                                    let (mut new_content, _warnings, _resolutions) = apply_line_edits(&current, &delete_edits)
                                        .map_err(|e| format!("remove_lines failed on op {}: {}", op_idx, e))?;

                                    // Track removal progress for deferred lint
                                    let done_count = {
                                        let entry = source_removal_done.entry(sp.clone()).or_insert(0);
                                        *entry += 1;
                                        *entry
                                    };
                                    let total_for_source = source_removal_total.get(sp.as_str()).copied().unwrap_or(1);
                                    let is_last_removal = done_count >= total_for_source;

                                    // After the last removal, check if remaining source
                                    // code still references any extracted symbols. If so,
                                    // inject an import from the target file so the source
                                    // doesn't break with "undefined" errors.
                                    if is_last_removal {
                                        if let Some(extract_entries) = source_extract_info.get(sp.as_str()) {
                                            let src_lang = hash_resolver::detect_lang(Some(sp.as_str()));
                                            let language = src_lang.as_deref()
                                                .map(|l| atls_core::Language::from_str(l))
                                                .unwrap_or(atls_core::Language::Unknown);

                                            // Group extracted symbols by target path
                                            let mut by_target: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
                                            for (sym, target) in extract_entries {
                                                if !target.is_empty() {
                                                    by_target.entry(target.as_str()).or_default().push(sym.as_str());
                                                }
                                            }

                                            for (target_path, syms) in &by_target {
                                                // Only add import if remaining code references at least one extracted symbol
                                                let needed: Vec<String> = syms.iter()
                                                    .filter(|sym| {
                                                        let re_pattern = format!(r"\b{}\b", regex::escape(sym));
                                                        regex::Regex::new(&re_pattern)
                                                            .map(|re| re.is_match(&new_content))
                                                            .unwrap_or(false)
                                                    })
                                                    .map(|s| s.to_string())
                                                    .collect();
                                                if needed.is_empty() { continue; }

                                                if language != atls_core::Language::Unknown {
                                                    if let Some(import_line) = build_source_import_for_moved_symbols(
                                                        sp, target_path, &needed, language,
                                                    ) {
                                                        new_content = insert_import_line(&new_content, &import_line, language);
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // Only lint on the final removal for this source file.
                                    // Intermediate states may have "undefined" errors for
                                    // symbols that a later op will also remove.
                                    if is_last_removal {
                                        let (lint_results, _) = lint_file_contents(
                                            &project_root_owned,
                                            &[(sp.clone(), new_content.clone())],
                                            true,
                                            false,
                                        );
                                        let new_errors: usize = lint_results.iter()
                                            .filter(|r| r.severity == "error").count();

                                        if new_errors > 0 {
                                            let broken_lines: Vec<serde_json::Value> = lint_results.iter()
                                                .filter(|r| r.severity == "error")
                                                .take(5)
                                                .map(|r| serde_json::json!({
                                                    "line": r.line,
                                                    "msg": &r.message,
                                                    "context": extract_error_context(&new_content, r.line, 5)
                                                }))
                                                .collect();

                                            let mut paused_resp = serde_json::json!({
                                                "status": if incremental { "rolled_back" } else { "paused" },
                                                "auto_rolled_back": incremental,
                                                "phase": "source_lint",
                                                "failed_operation_index": op_idx,
                                                "file": sp,
                                                "lint_errors": new_errors,
                                                "details": broken_lines,
                                                "completed_operations": all_results,
                                                "_rollback": build_rollback_data(&snapshots, &created_files, &project_root_owned),
                                                "_hint": "Source file has lint errors after line removal. Fix remove_lines and resubmit with resume_after, or rollback."
                                            });

                                            // Enrich with removal context
                                            if let Some((orig_s, orig_e)) = original_remove_range {
                                                paused_resp["removed_range"] = serde_json::json!({
                                                    "start": orig_s, "end": orig_e
                                                });
                                                let lines: Vec<&str> = current.lines().collect();
                                                let total = lines.len() as u32;
                                                let ctx_before: Vec<String> = (orig_s.saturating_sub(4)..orig_s.saturating_sub(1))
                                                    .filter(|&i| i > 0 && i <= total)
                                                    .map(|i| format!("{}| {}", i, lines.get((i - 1) as usize).unwrap_or(&"")))
                                                    .collect();
                                                let ctx_after: Vec<String> = (orig_e + 1..=(orig_e + 3).min(total))
                                                    .map(|i| format!("{}| {}", i, lines.get((i - 1) as usize).unwrap_or(&"")))
                                                    .collect();
                                                paused_resp["adjacent_context"] = serde_json::json!({
                                                    "before": ctx_before,
                                                    "after": ctx_after,
                                                });
                                            }

                                            if incremental {
                                                for snap in &snapshots {
                                                    let r = resolve_project_path(&project_root_owned, &snap.file);
                                                    if let Err(e) = std::fs::write(&r, &snap.content) {
                                                        eprintln!("[refactor] rollback write failed for {}: {}", snap.file, e);
                                                    }
                                                }
                                                for cf in &created_files {
                                                    if let Err(e) = std::fs::remove_file(cf) {
                                                        eprintln!("[refactor] rollback delete failed for {}: {}", cf.display(), e);
                                                    }
                                                }
                                            }

                                            return Ok(paused_resp);
                                        }
                                    }

                                    source_content_map.insert(sp.clone(), new_content.clone());

                                    std::fs::write(&resolved, &new_content)
                                        .map_err(|e| format!("Failed to write source {}: {}", sp, e))?;

                                    if !resolved.exists() {
                                        return Err(format!(
                                            "Refactor write verification failed: {} was not found on disk after write", sp
                                        ).into());
                                    }

                                    let new_hash = content_hash(&new_content);
                                    {
                                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                        let mut registry = hr_state.registry.lock().await;
                                        let prev_rev = registry.get_current_revision(sp);
                                        registry.register(new_hash.clone(), hash_resolver::HashEntry {
                                            source: Some(sp.clone()),
                                            content: new_content,
                                            tokens: 0,
                                            lang: hash_resolver::detect_lang(Some(sp.as_str())),
                                            line_count: 0,
                                            symbol_count: None,
                                        });
                                        if sp.contains('/') || sp.contains('\\') {
                                            let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                                "path": sp,
                                                "revision": new_hash,
                                                "previous_revision": prev_rev
                                            }));
                                        }
                                    }

                                    all_results.push(serde_json::json!({
                                        "op": op_idx, "f": sp, "h": format!("h:{}", &new_hash[..hash_resolver::SHORT_HASH_LEN]),
                                        "old_h": format!("h:{}", &old_hash[..hash_resolver::SHORT_HASH_LEN]),
                                        "ok": delete_edits.len()
                                    }));
                                    if !all_modified.contains(sp) {
                                        all_modified.push(sp.clone());
                                    }
                                }
                            }
                        }

                        // â”€â”€ step 3: apply import_updates to consumer files â”€â”€
                        // Fall back to op-level "file" when individual entries omit it
                        let op_level_file = op.get("file").and_then(|v| v.as_str()).unwrap_or("");
                        let mut updates_by_file: std::collections::HashMap<String, Vec<LineEdit>> = std::collections::HashMap::new();
                        for upd in &import_updates {
                            let file_ref = upd.get("file").and_then(|v| v.as_str())
                                .unwrap_or(op_level_file);
                            if file_ref.is_empty() { continue; }
                            let file_path = {
                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                let registry = hr_state.registry.lock().await;
                                let clean = file_ref.strip_prefix("h:").unwrap_or(file_ref);
                                registry.get(clean).and_then(|e| e.source.clone()).unwrap_or_else(|| file_ref.to_string())
                            };
                            let raw_line = upd.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                            let adjusted_line = if raw_line > 0 {
                                if let Some(shifts) = line_shifts.get(file_path.as_str()) {
                                    adjust_line_for_shifts(raw_line, shifts)
                                } else {
                                    raw_line
                                }
                            } else {
                                raw_line
                            };
                            let edit = LineEdit {
                                line: crate::LineCoordinate::Abs(adjusted_line),
                                action: upd.get("action").and_then(|v| v.as_str()).unwrap_or("replace").to_string(),
                                content: upd.get("content").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                end_line: upd.get("end_line").and_then(|v| v.as_u64()).map(|n| n as u32),
                                symbol: None,
                                position: None,
                                destination: upd.get("destination").and_then(|v| v.as_u64()).map(|n| n as u32),
                                reindent: upd.get("reindent").and_then(|v| v.as_bool()).unwrap_or(false),
                            };
                            updates_by_file.entry(file_path).or_default().push(edit);
                        }

                        for (file_path, edits) in &updates_by_file {
                            let resolved = resolve_project_path(&project_root_owned, file_path);
                            let current = source_content_map.get(file_path).cloned()
                                .or_else(|| std::fs::read_to_string(&resolved).ok().map(|c| normalize_line_endings(&c)))
                                .ok_or_else(|| format!("Failed to read {} (not in snapshot and file missing)", file_path))?;
                            let old_hash = content_hash(&current);

                            let (new_content, anchor_warnings, _edits_resolved) = apply_line_edits(&current, edits)
                                .map_err(|e| {
                                    let attempted: Vec<String> = edits.iter().map(|ed| {
                                        format!("  line:{} end_line:{:?} action:{} content:\"{}\"",
                                            ed.line, ed.end_line, ed.action,
                                            ed.content.as_deref().unwrap_or("").chars().take(120).collect::<String>())
                                    }).collect();
                                    format!("import_update failed on {} (op {}):\n  error: {}\n  attempted edits:\n{}", file_path, op_idx, e, attempted.join("\n"))
                                })?;

                            let (lint_results, _) = lint_file_contents(
                                &project_root_owned,
                                &[(file_path.clone(), new_content.clone())],
                                true,
                                false,
                            );
                            let new_errors: usize = lint_results.iter()
                                .filter(|r| r.severity == "error").count();

                            if new_errors > 0 {
                                let attempted_edits: Vec<serde_json::Value> = edits.iter().map(|ed| {
                                    serde_json::json!({
                                        "line": ed.line,
                                        "action": ed.action,
                                        "end_line": ed.end_line,
                                        "content": ed.content.as_deref().unwrap_or("")
                                    })
                                }).collect();
                                let broken_lines: Vec<serde_json::Value> = lint_results.iter()
                                    .filter(|r| r.severity == "error")
                                    .take(5)
                                    .map(|r| serde_json::json!({
                                        "line": r.line,
                                        "msg": &r.message,
                                        "context": extract_error_context(&new_content, r.line, 5)
                                    }))
                                    .collect();

                                if incremental {
                                    for snap in &snapshots {
                                        let r = resolve_project_path(&project_root_owned, &snap.file);
                                        if let Err(e) = std::fs::write(&r, &snap.content) {
                                            eprintln!("[refactor] rollback write failed for {}: {}", snap.file, e);
                                        }
                                    }
                                    for cf in &created_files {
                                        if let Err(e) = std::fs::remove_file(cf) {
                                            eprintln!("[refactor] rollback delete failed for {}: {}", cf.display(), e);
                                        }
                                    }
                                }

                                return Ok(serde_json::json!({
                                    "status": if incremental { "rolled_back" } else { "paused" },
                                    "auto_rolled_back": incremental,
                                    "phase": "import_lint",
                                    "failed_operation_index": op_idx,
                                    "file": file_path,
                                    "lint_errors": new_errors,
                                    "details": broken_lines,
                                    "attempted_imports": attempted_edits,
                                    "completed_operations": all_results,
                                    "_rollback": build_rollback_data(&snapshots, &created_files, &project_root_owned),
                                    "_hint": "Import update caused lint errors. Fix import_updates for this operation and resubmit with resume_after, or rollback."
                                }));
                            }

                            std::fs::write(&resolved, &new_content)
                                .map_err(|e| format!("Failed to write {}: {}", file_path, e))?;

                            if !resolved.exists() {
                                return Err(format!(
                                    "Refactor write verification failed: {} was not found on disk after write", file_path
                                ).into());
                            }

                            source_content_map.insert(file_path.clone(), new_content.clone());

                            let new_hash = content_hash(&new_content);
                            {
                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                let mut registry = hr_state.registry.lock().await;
                                let prev_rev = registry.get_current_revision(&file_path);
                                registry.register(new_hash.clone(), hash_resolver::HashEntry {
                                    source: Some(file_path.clone()),
                                    content: new_content,
                                    tokens: 0,
                                    lang: hash_resolver::detect_lang(Some(file_path.as_str())),
                                    line_count: 0,
                                    symbol_count: None,
                                });
                                if file_path.contains('/') || file_path.contains('\\') {
                                    let _ = app.emit("canonical_revision_changed", serde_json::json!({
                                        "path": file_path,
                                        "revision": new_hash,
                                        "previous_revision": prev_rev
                                    }));
                                }
                            }

                            let mut entry = serde_json::json!({
                                "op": op_idx, "f": file_path, "h": format!("h:{}", &new_hash[..hash_resolver::SHORT_HASH_LEN]),
                                "old_h": format!("h:{}", &old_hash[..hash_resolver::SHORT_HASH_LEN]),
                                "ok": edits.len()
                            });
                            if !anchor_warnings.is_empty() {
                                entry["anchor_miss"] = serde_json::json!(anchor_warnings);
                                entry["_hint"] = serde_json::json!(format!(
                                    "{} anchor(s) did not match -- verify import placement",
                                    anchor_warnings.len()
                                ));
                            }
                            all_results.push(entry);
                            if !all_modified.contains(file_path) {
                                all_modified.push(file_path.clone());
                            }
                        }
                    } // end operations loop

                    // â”€â”€ Consumer import rewriting for declarative extract operations â”€â”€
                    // Batched by (source, target) pair so all symbols moving along
                    // the same route produce a single merged import line per consumer.
                    let mut consumer_fixes: Vec<serde_json::Value> = Vec::new();
                    {
                        // Group: (source_path, target_path) -> Vec<symbol_name>
                        let mut extract_groups: std::collections::HashMap<(String, String), Vec<String>> = std::collections::HashMap::new();
                        for op in &operations {
                            if let (Some(extract_sym), Some(from_ref), Some(to_path)) = (
                                op.get("extract").and_then(|v| v.as_str()),
                                op.get("from").and_then(|v| v.as_str()),
                                op.get("to").and_then(|v| v.as_str()),
                            ) {
                                let open = extract_sym.find('(').unwrap_or(0);
                                let close = extract_sym.rfind(')').unwrap_or(extract_sym.len());
                                if open < close {
                                    let sym_name = extract_sym[open + 1..close].to_string();
                                    let source_path = {
                                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                        let registry = hr_state.registry.lock().await;
                                        let clean = from_ref.strip_prefix("h:").unwrap_or(from_ref);
                                        registry.get(clean).and_then(|e| e.source.clone())
                                            .unwrap_or_else(|| from_ref.to_string())
                                    };
                                    extract_groups
                                        .entry((source_path, to_path.to_string()))
                                        .or_default()
                                        .push(sym_name);
                                }
                            }
                        }

                        // Snapshot consumer files BEFORE rewriting so rollback can
                        // restore them. Key = normalized path, Value = original content.
                        let mut consumer_snapshots: std::collections::HashMap<String, String> = std::collections::HashMap::new();

                        for ((source_path, target_path), sym_names) in &extract_groups {
                            let src_lang = hash_resolver::detect_lang(Some(source_path.as_str()))
                                .and_then(|l| Some(atls_core::Language::from_str(&l)))
                                .unwrap_or(atls_core::Language::Unknown);
                            if src_lang == atls_core::Language::Unknown { continue; }

                            // â”€â”€ source file also needs an import for extracted symbols â”€â”€
                            let source_abs = resolve_project_path(&project_root_owned, source_path);
                            if let Ok(src_content) = std::fs::read_to_string(&source_abs) {
                                if let Some(new_import) = build_source_import_for_moved_symbols(
                                    source_path, target_path, sym_names, src_lang,
                                ) {
                                    consumer_snapshots.entry(source_path.clone())
                                        .or_insert_with(|| src_content.clone());
                                    let updated = insert_import_line(&src_content, &new_import, src_lang);
                                    if updated != src_content {
                                        let _ = std::fs::write(&source_abs, &updated);
                                        consumer_fixes.push(serde_json::json!({
                                            "consumer": source_path,
                                            "symbols": sym_names,
                                            "action": "import_rewritten",
                                            "import": new_import,
                                        }));
                                        if !all_modified.contains(&source_path.to_string()) {
                                            all_modified.push(source_path.to_string());
                                        }
                                    }
                                }
                            }

                            // â”€â”€ other consumer files â”€â”€
                            let fixes = generate_consumer_import_updates_with_snapshots(
                                &project, source_path, target_path,
                                sym_names, src_lang, &project_root_owned, false,
                                Some(&mut consumer_snapshots),
                            );
                            for fix in &fixes {
                                if let Some(consumer) = fix["consumer"].as_str() {
                                    if !all_modified.contains(&consumer.to_string()) {
                                        all_modified.push(consumer.to_string());
                                    }
                                }
                            }
                            consumer_fixes.extend(fixes);
                        }

                        // Add consumer file snapshots to rollback data so
                        // refactor_rollback can also revert import rewrites.
                        for (cpath, ccontent) in &consumer_snapshots {
                            let already = snapshots.iter().any(|s| s.file == *cpath);
                            if !already {
                                let h = content_hash(ccontent);
                                let entry = hash_resolver::HashEntry {
                                    source: Some(cpath.clone()),
                                    content: ccontent.clone(),
                                    tokens: ccontent.split_whitespace().count(),
                                    lang: hash_resolver::detect_lang(Some(cpath.as_str())),
                                    line_count: ccontent.lines().count(),
                                    symbol_count: Some(0),
                                };
                                let hr_state = app.state::<hash_resolver::HashRegistryState>();
                                let mut reg = hr_state.registry.lock().await;
                                reg.register(h, entry);
                                drop(reg);
                                snapshots.push(Snapshot { file: cpath.clone(), content: ccontent.clone() });
                            }
                        }
                    }

                    // â”€â”€ re-index modified files â”€â”€
                    if !all_modified.is_empty() {
                        let indexer = project.indexer().clone();
                        let _ = index_modified_files(&app, indexer.clone(), project_root_owned.clone(), all_modified.clone()).await;
                    }

                    let skipped_count = all_results.iter()
                        .filter(|r| r.get("status").and_then(|v| v.as_str()) == Some("skipped"))
                        .count();
                    let effective_status = if all_modified.is_empty() && skipped_count > 0 {
                        "no_effect"
                    } else if all_modified.is_empty() {
                        "no_changes"
                    } else {
                        "success"
                    };
                    let mut response = serde_json::json!({
                        "status": effective_status,
                        "results": all_results,
                        "lint": "pass",
                        "operations": operations.len(),
                        "operations_skipped": skipped_count,
                        "files": all_modified.len(),
                        "_rollback": build_rollback_data(&snapshots, &created_files, &project_root_owned),
                        "_dispatched_from": "refactor",
                        "_action": "execute"
                    });
                    if effective_status == "no_effect" {
                        response["_warning"] = serde_json::json!(
                            "All operations were skipped â€” no files created or modified. Check that each operation has valid 'create', 'remove_lines', or 'import_updates' fields. For extraction use: extract:'fn(name)', from:'source_path', to:'target_path'."
                        );
                    }
                    if !consumer_fixes.is_empty() {
                        response["consumer_import_fixes"] = serde_json::json!(consumer_fixes);
                    }
                    return Ok(response);
                }

                // rewire_consumers: standalone consumer import rewriting for the hash-building path.
                // Bridges the gap between change.create + change.edit and refactor execute's
                // automatic consumer import updates.
                if action == "rewire_consumers" {
                    let source_file = params.get("source_file")
                        .or_else(|| params.get("from"))
                        .or_else(|| params.get("file_path"))
                        .and_then(|v| v.as_str())
                        .or_else(|| params.get("file_paths").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.as_str()))
                        .ok_or("rewire_consumers requires 'source_file' (the file symbols were extracted from)")?;
                    let target_file = params.get("target_file")
                        .or_else(|| params.get("to"))
                        .and_then(|v| v.as_str())
                        .ok_or("rewire_consumers requires 'target_file' (the file symbols were moved to)")?;
                    let symbol_names: Vec<String> = params.get("symbol_names")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default();
                    if symbol_names.is_empty() {
                        return Err("rewire_consumers requires 'symbol_names' array (symbols that moved from source to target)".into());
                    }
                    let dry_run = params.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(false);

                    let src_lang = hash_resolver::detect_lang(Some(source_file))
                        .and_then(|l| Some(atls_core::Language::from_str(&l)))
                        .unwrap_or(atls_core::Language::Unknown);
                    if src_lang == atls_core::Language::Unknown {
                        return Err(format!("rewire_consumers: cannot detect language for '{}'", source_file));
                    }

                    let mut consumer_snapshots: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                    let fixes = generate_consumer_import_updates_with_snapshots(
                        &project, source_file, target_file,
                        &symbol_names, src_lang, &project_root, dry_run,
                        Some(&mut consumer_snapshots),
                    );

                    // Also add import in source file for extracted symbols still referenced there
                    let mut source_fixes: Vec<serde_json::Value> = Vec::new();
                    if !dry_run {
                        let source_abs = resolve_project_path(&project_root, source_file);
                        if let Ok(src_content) = std::fs::read_to_string(&source_abs) {
                            let still_used: Vec<String> = symbol_names.iter()
                                .filter(|s| src_content.contains(s.as_str()))
                                .cloned()
                                .collect();
                            if !still_used.is_empty() {
                                if let Some(imp) = build_source_import_for_moved_symbols_with_root(
                                    source_file, target_file, &still_used, src_lang, Some(&project_root),
                                ) {
                                    consumer_snapshots.entry(source_file.to_string())
                                        .or_insert_with(|| src_content.clone());
                                    let updated = insert_import_line(&src_content, &imp, src_lang);
                                    if updated != src_content {
                                        let _ = std::fs::write(&source_abs, &updated);
                                        source_fixes.push(serde_json::json!({
                                            "consumer": source_file,
                                            "symbols": still_used,
                                            "action": "source_import_added",
                                            "import": imp,
                                        }));
                                    }
                                }
                            }
                        }
                    }

                    // Build rollback data from consumer snapshots
                    let rollback_restore: Vec<serde_json::Value> = consumer_snapshots.iter().map(|(path, content)| {
                        let h = content_hash(content);
                        serde_json::json!({"file": path, "hash": format!("h:{}", &h[..hash_resolver::SHORT_HASH_LEN])})
                    }).collect();

                    // Register snapshot hashes for rollback
                    for (path, content) in &consumer_snapshots {
                        let h = content_hash(content);
                        let hr_state = app.state::<hash_resolver::HashRegistryState>();
                        let mut registry = hr_state.registry.lock().await;
                        registry.register(h, hash_resolver::HashEntry {
                            source: Some(path.clone()),
                            content: content.clone(),
                            tokens: content.split_whitespace().count(),
                            lang: hash_resolver::detect_lang(Some(path.as_str())),
                            line_count: content.lines().count(),
                            symbol_count: None,
                        });
                    }

                    // Re-index modified files
                    let mut modified: Vec<String> = fixes.iter()
                        .filter_map(|f| f["consumer"].as_str().map(|s| s.to_string()))
                        .collect();
                    for sf in &source_fixes {
                        if let Some(c) = sf["consumer"].as_str() {
                            if !modified.contains(&c.to_string()) {
                                modified.push(c.to_string());
                            }
                        }
                    }
                    if !modified.is_empty() && !dry_run {
                        let indexer = project.indexer().clone();
                        let _ = index_modified_files(&app, indexer.clone(), project_root.to_path_buf(), modified.clone()).await;
                    }

                    let mut all_fixes = fixes;
                    all_fixes.extend(source_fixes);

                    let mut response = serde_json::json!({
                        "status": if dry_run { "dry_run" } else { "success" },
                        "consumer_import_fixes": all_fixes,
                        "files_modified": modified.len(),
                        "_dispatched_from": "refactor",
                        "_action": "rewire_consumers",
                    });
                    if !rollback_restore.is_empty() {
                        response["_rollback"] = serde_json::json!({
                            "restore": rollback_restore,
                            "delete": [],
                        });
                    }
                    return Ok(response);
                }

                // Route to the appropriate handler by rewriting the operation
                let delegated_op = match action {
                    "inventory" => "method_inventory",
                    "rename" => "rename_symbol",
                    "move" => "move_symbol",
                    "extract" => "extract_methods",
                    "impact_analysis" | "impact" => "impact_analysis",
                    "plan" => "refactor_plan",
                    "rollback" => "refactor_rollback",
                    other => return Err(format!(
                        "Unknown refactor action: '{}'. Use: inventory, impact_analysis, execute, rewire_consumers, rollback",
                        other
                    ))
                };
                
                // Recursive dispatch: call atls_batch_query with the delegated operation
                // We use Box::pin to allow the async recursion
                let result = Box::pin(atls_batch_query(
                    app.clone(),
                    delegated_op.to_string(),
                    params.clone(),
                )).await;
                
                // Wrap the result to indicate it came through the refactor dispatcher
                match result {
                    Ok(mut val) => {
                        if let Some(obj) = val.as_object_mut() {
                            obj.insert("_dispatched_from".to_string(), serde_json::json!("refactor"));
                            obj.insert("_action".to_string(), serde_json::json!(action));
                        }
                        Ok(val)
                    }
                    Err(e) => Err(e)
                }
            }
            _ => {
                Err(format!("batch_query operation '{}' not yet implemented in Rust core", operation))
            }
        };

    // Post-process: inject status field and hash warnings.
    // _next/hint/_hint are intentionally preserved — they provide state-dependent
    // workflow guidance that models rely on for chaining (e.g. "Run verify after edit").
    if let Ok(ref mut val) = result {
        if let Some(obj) = val.as_object_mut() {
            if !obj.contains_key("status") {
                let status = if obj.contains_key("error") { "error" }
                    else if obj.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(false) { "preview" }
                    else { "ok" };
                obj.insert("status".to_string(), serde_json::json!(status));
            }
            if !hash_resolve_warnings.is_empty() {
                obj.insert("_hash_warnings".to_string(), serde_json::json!(hash_resolve_warnings));
            }
        }
    }

    result
}

// ============================================================================
// Search Commands
// ============================================================================

#[cfg(test)]
mod batch_query_mod_tests {
    /// Guard: `atls_batch_query` uses `resolve_edit_operation` from helpers before dispatch.
    #[test]
    fn resolve_edit_undo_routes_to_undo() {
        use super::helpers::resolve_edit_operation;
        use serde_json::json;
        let (op, _) = resolve_edit_operation("edit".into(), json!({ "undo": "h:abc" }));
        assert_eq!(op, "undo");
    }
}
