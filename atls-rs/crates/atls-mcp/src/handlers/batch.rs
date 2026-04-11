use crate::project::ProjectManager;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::warn;

pub async fn handle_batch_query(
    project_manager: &Arc<Mutex<ProjectManager>>,
    args: Value,
) -> Result<serde_json::Value, String> {
    let operation: String = args
        .get("operation")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing required parameter: operation".to_string())?;

    let root_path: Option<String> = args
        .get("root_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let pm = project_manager.lock().await;
    let project = pm
        .get_or_create_project(root_path.as_deref())
        .await
        .map_err(|e| format!("Failed to get project: {}", e))?;

    let project = project.lock().await;
    let query_engine = project.query_engine();

    match operation.as_str() {
        "help" => {
            Ok(serde_json::json!({
                "operations": [
                    "inventory", "symbol_usage", "code_search", "context", "help"
                ],
                "description": "Primary unified tool for all code operations. Use arrays to batch operations.",
                "inventory": {
                    "description": "List all methods/functions in specified files with metrics",
                    "params": {
                        "file_paths": "Required: Array of file paths to scan",
                        "min_lines": "Optional: Filter methods with fewer lines (default: show all)",
                        "min_complexity": "Optional: Filter methods with lower complexity (default: show all)",
                        "class_name": "Optional: Filter to methods of a specific class"
                    }
                },
                "symbol_usage": {
                    "description": "Find definitions and references for symbols",
                    "params": { "symbol_names": "Required: Array of symbol names to look up" }
                },
                "code_search": {
                    "description": "Search code using FTS5 full-text search",
                    "params": { "queries": "Required: Array of search queries", "limit": "Optional: Max results (default: 20)" }
                },
                "context": {
                    "description": "Get smart context for files",
                    "params": { "file_paths": "Required: Array of file paths", "type": "Optional: 'smart' or 'raw'" }
                }
            }))
        }
        "symbol_usage" => {
            let symbol_names: Vec<String> = args
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

            let verbose = args
                .get("verbose")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let mut results = Vec::new();
            for symbol_name in symbol_names {
                if verbose {
                    match query_engine.get_symbol_usage(&symbol_name) {
                        Ok(usage) => {
                            results.push(serde_json::json!({
                                "symbol": symbol_name,
                                "usage": usage
                            }));
                        }
                        Err(e) => {
                            warn!("Failed to get symbol usage for {}: {}", symbol_name, e);
                        }
                    }
                } else {
                    match query_engine.get_symbol_usage_compact(&symbol_name, None, 15) {
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
                            warn!("Failed to get symbol usage for {}: {}", symbol_name, e);
                        }
                    }
                }
            }

            Ok(serde_json::json!({ "results": results }))
        }
        "code_search" => {
            let queries: Vec<String> = args
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

            let limit: usize = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(20);

            let context_lines: usize = args
                .get("context_lines")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(1);

            let grouped = args
                .get("grouped")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let mut results = Vec::new();
            for query_str in &queries {
                if grouped {
                    match query_engine.search_code_grouped(query_str, limit, None, context_lines) {
                        Ok(grouped_result) => {
                            results.push(serde_json::json!({
                                "query": query_str,
                                "groups": grouped_result.groups,
                                "total": grouped_result.total_matches
                            }));
                        }
                        Err(e) => {
                            warn!("Failed to search code for {}: {}", query_str, e);
                        }
                    }
                } else {
                    match query_engine.search_code_full(query_str, limit, None, context_lines) {
                        Ok(search_results) => {
                            results.push(serde_json::json!({
                                "query": query_str,
                                "results": search_results
                            }));
                        }
                        Err(e) => {
                            warn!("Failed to search code for {}: {}", query_str, e);
                        }
                    }
                }
            }

            Ok(serde_json::json!({ "results": results }))
        }
        "context" => {
            let file_paths: Vec<String> = args
                .get("file_paths")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();

            if file_paths.is_empty() {
                return Err("file_paths required for context operation".to_string());
            }

            let context_type: String = args
                .get("type")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "smart".to_string());

            let mut results = Vec::new();
            for file_path in file_paths {
                match context_type.as_str() {
                    "smart" => {
                        match query_engine.get_smart_context(&file_path) {
                            Ok(context) => {
                                results.push(serde_json::json!({
                                    "file": file_path,
                                    "context": context
                                }));
                            }
                            Err(e) => {
                                warn!("Failed to get smart context for {}: {}", file_path, e);
                            }
                        }
                    }
                    "raw" => {
                        // For raw context, we'd read the file directly
                        // This is a simplified version
                        results.push(serde_json::json!({
                            "file": file_path,
                            "note": "raw context not yet implemented"
                        }));
                    }
                    _ => {
                        return Err(format!("Unknown context type: {}", context_type));
                    }
                }
            }

            Ok(serde_json::json!({ "results": results }))
        }
        "find_symbol" => {
            let query: String = args
                .get("query")
                .and_then(|v| v.as_str())
                .or_else(|| args.get("name").and_then(|v| v.as_str()))
                .or_else(|| {
                    args.get("symbol_names")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|v| v.as_str())
                })
                .map(|s| s.to_string())
                .ok_or_else(|| "query required for find_symbol (also accepts: name, symbol_names)".to_string())?;

            let limit: usize = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(20);

            match query_engine.find_symbol(&query) {
                Ok(symbols) => {
                    let file_ids: Vec<i64> = symbols.iter().map(|s| s.file_id).collect();
                    let file_path_map: HashMap<i64, String> = if file_ids.is_empty() {
                        HashMap::new()
                    } else {
                        let conn = query_engine.db().conn();
                        let placeholders = file_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                        let sql = format!("SELECT id, path FROM files WHERE id IN ({})", placeholders);
                        let mut stmt = conn.prepare(&sql).map_err(|e| format!("Failed to prepare: {}", e))?;
                        let params: Vec<i64> = file_ids.clone();
                        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                        }).map_err(|e| format!("Failed to query: {}", e))?;
                        rows.filter_map(|r| r.ok()).collect()
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
                        let suggestions = query_engine
                            .find_symbol_suggestions(&query, 3)
                            .unwrap_or_default();
                        Ok(serde_json::json!({
                            "query": query,
                            "results": [],
                            "suggestions": suggestions
                                .into_iter()
                                .map(|(name, kind, score)| serde_json::json!({
                                    "name": name,
                                    "kind": kind,
                                    "score": format!("{:.2}", score)
                                }))
                                .collect::<Vec<_>>()
                        }))
                    } else {
                        Ok(serde_json::json!({
                            "query": query,
                            "results": results
                        }))
                    }
                }
                Err(e) => Err(format!("Symbol search failed: {}", e)),
            }
        }
        "inventory" => {
            let file_paths: Vec<String> = args
                .get("file_paths")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();

            if file_paths.is_empty() {
                return Err("file_paths required for inventory operation".to_string());
            }

            // Optional filters - default to showing everything
            let min_lines: Option<u32> = args
                .get("min_lines")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);

            let min_complexity: Option<i32> = args
                .get("min_complexity")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);

            let class_name: Option<String> = args
                .get("class_name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            match query_engine.get_method_inventory(&file_paths, min_lines, min_complexity, class_name.as_deref()) {
                Ok(inventory) => {
                    Ok(serde_json::json!({
                        "methods": inventory.methods,
                        "stats": inventory.stats
                    }))
                }
                Err(e) => {
                    Err(format!("Failed to get method inventory: {}", e))
                }
            }
        }
        _ => {
            warn!("Unimplemented batch_query operation: {}", operation);
            Ok(serde_json::json!({
                "error": format!("Operation '{}' not yet implemented", operation),
                "available_operations": [
                    "help", "inventory", "symbol_usage", "code_search", "context"
                ]
            }))
        }
    }
}

/// Map unified OperationKind dotted name to legacy batch_query operation name.
/// Note: some operations require param remapping (handled in remap_params_for_op).
fn op_kind_to_batch_op(use_val: &str) -> Option<&'static str> {
    match use_val {
        "search.code" => Some("code_search"),
        "search.symbol" => Some("find_symbol"),
        "search.usage" => Some("symbol_usage"),
        // search.similar is resolved per-type in remap_params_for_op
        "search.similar" => Some("find_similar_code"),
        "search.issues" => Some("find_issues"),
        "search.patterns" => Some("detect_patterns"),
        "read.context" | "read.file" => Some("context"),
        "read.lines" => Some("read_lines"),
        "analyze.deps" => Some("dependencies"),
        "analyze.calls" => Some("call_hierarchy"),
        "analyze.structure" => Some("symbol_dep_graph"),
        "analyze.impact" => Some("change_impact"),
        "analyze.blast_radius" => Some("impact_analysis"),
        // change.edit needs sub-routing (draft/batch_edits/undo); best-effort: draft
        "change.edit" => Some("draft"),
        "change.create" => Some("draft"),
        "change.refactor" => Some("refactor"),
        "verify.build" | "verify.test" | "verify.lint" | "verify.typecheck" => Some("verify"),
        _ => None,
    }
}

/// Centralized param normalization — mirrors atls-studio/src/services/batch/paramNorm.ts.
/// Resolves global + op-specific aliases to canonical names before backend dispatch.
fn normalize_step_params(use_val: &str, params: &mut Value) {
    let obj = match params.as_object_mut() {
        Some(o) => o,
        None => return,
    };

    // Global aliases: source → canonical
    let global_aliases: &[(&str, &str)] = &[
        ("file", "file_path"),
        ("f", "file_path"),
        ("path", "file_path"),
        ("target_file", "file_path"),
        ("source_file", "file_path"),
        ("symbol", "symbol_names"),
        ("symbol_name", "symbol_names"),
        ("old_str", "old"),
        ("old_string", "old"),
        ("new_str", "new"),
        ("new_string", "new"),
        ("original_lines", "old"),
        ("updated_lines", "new"),
        ("command", "cmd"),
        ("contents", "content"),
        ("refs", "hashes"),
    ];

    for &(alias, canonical) in global_aliases {
        if obj.contains_key(canonical) { continue; }
        if let Some(val) = obj.remove(alias) {
            obj.insert(canonical.to_string(), val);
        }
    }

    // Op-specific aliases
    match use_val {
        "search.code" => {
            if !obj.contains_key("queries") {
                if let Some(q) = obj.remove("query") {
                    let arr = match q {
                        Value::Array(_) => q,
                        Value::String(s) if !s.is_empty() => Value::Array(vec![Value::String(s)]),
                        _ => return,
                    };
                    obj.insert("queries".to_string(), arr);
                }
            }
        }
        "search.symbol" => {
            if !obj.contains_key("symbol_names") {
                if let Some(val) = obj.remove("name").or_else(|| obj.remove("query")) {
                    let arr = match val {
                        Value::Array(_) => val,
                        Value::String(s) => Value::Array(vec![Value::String(s)]),
                        _ => return,
                    };
                    obj.insert("symbol_names".to_string(), arr);
                }
            }
        }
        "analyze.impact" | "analyze.blast_radius" => {
            if !obj.contains_key("file_paths") {
                if let Some(from_val) = obj.remove("from") {
                    let paths = if from_val.is_array() { from_val } else { Value::Array(vec![from_val]) };
                    obj.insert("file_paths".to_string(), paths);
                }
            }
        }
        _ => {}
    }

    // Scalar-to-array coercion: file_path → file_paths (for non-singular ops)
    let singular_ops = ["change.edit", "change.create", "change.split_module", "read.lines", "read.shaped", "analyze.extract_plan"];
    if !singular_ops.contains(&use_val) && !obj.contains_key("file_paths") {
        if let Some(fp) = obj.remove("file_path") {
            if fp.is_string() {
                obj.insert("file_paths".to_string(), Value::Array(vec![fp]));
            }
        }
    }

    // Wrap scalar file_paths
    if let Some(fp) = obj.get("file_paths") {
        if fp.is_string() {
            let val = obj.remove("file_paths").unwrap();
            obj.insert("file_paths".to_string(), Value::Array(vec![val]));
        }
    }

    // Wrap scalar symbol_names
    if let Some(sn) = obj.get("symbol_names") {
        if sn.is_string() {
            let val = obj.remove("symbol_names").unwrap();
            obj.insert("symbol_names".to_string(), Value::Array(vec![val]));
        }
    }

    // key → keys for bb ops
    if (use_val == "session.bb.read" || use_val == "session.bb.delete") && !obj.contains_key("keys") {
        if let Some(k) = obj.remove("key") {
            if k.is_string() {
                obj.insert("keys".to_string(), Value::Array(vec![k]));
            }
        }
    }
}

/// Remap params for operations where the unified schema differs from the legacy backend.
fn remap_params_for_op(use_val: &str, params: &mut Value) -> Option<&'static str> {
    match use_val {
        "search.symbol" => {
            // Normalize fn(name)/cls(name) style to bare symbol names.
            fn normalize_symbol_value(v: Value) -> Value {
                match v {
                    Value::String(s) => {
                        let trimmed = s.trim();
                        let prefixes = [
                            "fn", "sym", "cls", "class", "struct", "trait", "interface", "protocol",
                            "enum", "record", "extension", "mixin", "impl", "type", "const", "macro",
                            "ctor", "property", "field", "operator", "event", "object", "actor", "union",
                        ];
                        for prefix in prefixes {
                            if trimmed.len() > prefix.len() + 2
                                && trimmed.starts_with(prefix)
                                && trimmed.as_bytes().get(prefix.len()) == Some(&b'(')
                                && trimmed.ends_with(')')
                            {
                                return Value::String(trimmed[prefix.len() + 1..trimmed.len() - 1].trim().to_string());
                            }
                        }
                        Value::String(trimmed.to_string())
                    }
                    Value::Array(arr) => Value::Array(arr.into_iter().map(normalize_symbol_value).collect()),
                    other => other,
                }
            }

            if let Some(obj) = params.as_object_mut() {
                if let Some(q) = obj.remove("query") {
                    if !obj.contains_key("name") && !obj.contains_key("symbol_names") {
                        obj.insert("query".to_string(), normalize_symbol_value(q));
                    }
                }
                if let Some(name) = obj.remove("name") {
                    obj.insert("name".to_string(), normalize_symbol_value(name));
                }
                if let Some(symbol_names) = obj.remove("symbol_names") {
                    obj.insert("symbol_names".to_string(), normalize_symbol_value(symbol_names));
                }
            }
            None
        }
        "search.similar" => {
            let sim_type = params.get("type").and_then(|v| v.as_str()).unwrap_or("code");
            let op = match sim_type {
                "code" => "find_similar_code",
                "function" => "find_similar_functions",
                "concept" => "find_conceptual_matches",
                "pattern" => "find_pattern_implementations",
                _ => "find_similar_code",
            };
            if op == "find_similar_functions" {
                if let Some(obj) = params.as_object_mut() {
                    if !obj.contains_key("function_names") && !obj.contains_key("functions") {
                        if let Some(q) = obj.remove("query") {
                            let arr = match q {
                                Value::Array(a) => a
                                    .into_iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect::<Vec<_>>(),
                                Value::String(s) if !s.is_empty() => vec![s],
                                _ => vec![],
                            };
                            obj.insert("function_names".to_string(), Value::Array(
                                arr.into_iter().map(Value::String).collect(),
                            ));
                        }
                    }
                }
            }
            // concept mode: map query → concept/concepts when only query provided
            if op == "find_conceptual_matches" {
                if let Some(obj) = params.as_object_mut() {
                    if !obj.contains_key("concepts") && !obj.contains_key("concept") {
                        if let Some(q) = obj.remove("query") {
                            let arr = match q {
                                Value::Array(a) => a
                                    .into_iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect::<Vec<_>>(),
                                Value::String(s) if !s.is_empty() => vec![s],
                                _ => vec![],
                            };
                            if !arr.is_empty() {
                                obj.insert("concepts".to_string(), Value::Array(
                                    arr.into_iter().map(Value::String).collect(),
                                ));
                            }
                        }
                    }
                }
            }
            Some(op)
        }
        "analyze.impact" | "analyze.blast_radius" => {
            if let Some(obj) = params.as_object_mut() {
                // Remap from -> file_paths
                if let Some(from_val) = obj.remove("from") {
                    if !obj.contains_key("file_paths") {
                        let paths = if from_val.is_array() {
                            from_val
                        } else {
                            Value::Array(vec![from_val])
                        };
                        obj.insert("file_paths".to_string(), paths);
                    }
                }
                // Remap symbol -> symbol_names for blast_radius
                if use_val == "analyze.blast_radius" {
                    if let Some(sym) = obj.remove("symbol") {
                        if !obj.contains_key("symbol_names") {
                            obj.insert("symbol_names".to_string(), Value::Array(vec![sym]));
                        }
                    }
                }
            }
            None
        }
        "change.edit" => {
            // Route to correct backend op based on params
            if params.get("undo").is_some() {
                return Some("undo");
            }
            if params.get("revise").is_some() {
                if let Some(obj) = params.as_object_mut() {
                    if let Some(rev) = obj.get("revise").cloned() {
                        obj.insert("hash".to_string(), rev);
                    }
                }
                return Some("revise");
            }
            if params.get("deletes").is_some() {
                if let Some(obj) = params.as_object_mut() {
                    if let Some(del) = obj.get("deletes").cloned() {
                        obj.insert("file_paths".to_string(), del);
                    }
                }
                return Some("delete_files");
            }
            if params.get("mode").and_then(|v| v.as_str()) == Some("batch_edits") {
                return Some("batch_edits");
            }
            Some("draft")
        }
        _ => None,
    }
}

/// Unified batch handler: decomposes steps into individual batch_query calls,
/// collects results, and returns them as a structured batch result.
pub async fn handle_unified_batch(
    project_manager: &Arc<Mutex<ProjectManager>>,
    args: Value,
) -> Result<serde_json::Value, String> {
    let steps = args.get("steps")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing required parameter: steps".to_string())?;

    let goal = args.get("goal").and_then(|v| v.as_str()).unwrap_or("batch");
    let root_path: Option<String> = args
        .get("root_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut step_results: Vec<Value> = Vec::new();
    let mut step_outputs: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut all_ok = true;

    let start = std::time::Instant::now();

    for step in steps {
        let step_id = step.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let use_val = step.get("use").and_then(|v| v.as_str()).unwrap_or("?");
        let params = step.get("with").cloned().unwrap_or_else(|| serde_json::json!({}));
        let step_start = std::time::Instant::now();

        // Check on_error for stop-on-failure
        let on_error = step.get("on_error").and_then(|v| v.as_str()).unwrap_or("continue");

        // Session ops are frontend-only; skip in MCP context with a marker
        if use_val.starts_with("session.") || use_val.starts_with("annotate.") || use_val.starts_with("delegate.") {
            let result = serde_json::json!({
                "id": step_id,
                "use": use_val,
                "ok": false,
                "summary": format!("{}: not available in MCP context (session ops are frontend-only)", use_val),
                "error": "frontend_only",
                "duration_ms": step_start.elapsed().as_millis()
            });
            step_results.push(result.clone());
            step_outputs.insert(step_id.to_string(), result);
            if on_error == "stop" { all_ok = false; break; }
            continue;
        }

        // Map to batch_query operation
        let default_op = match op_kind_to_batch_op(use_val) {
            Some(op) => op,
            None => {
                let err = if use_val.eq_ignore_ascii_case("use") {
                    format!(
                        r#"unknown operation: {} — "USE" in batch docs labels the q: line operation column; set use to a real operation (e.g. read.shaped, session.plan, verify.typecheck, or short codes like rs, spl, vk)"#,
                        use_val
                    )
                } else {
                    format!("unknown operation: {}", use_val)
                };
                let result = serde_json::json!({
                    "id": step_id,
                    "use": use_val,
                    "ok": false,
                    "error": err,
                    "duration_ms": step_start.elapsed().as_millis()
                });
                step_results.push(result.clone());
                step_outputs.insert(step_id.to_string(), result);
                all_ok = false;
                if on_error == "stop" { break; }
                continue;
            }
        };

        // Normalize aliases, then remap for legacy backend
        let mut query_args = params;
        normalize_step_params(use_val, &mut query_args);
        let batch_op = remap_params_for_op(use_val, &mut query_args)
            .unwrap_or(default_op);

        if let Some(rp) = &root_path {
            if let Some(obj) = query_args.as_object_mut() {
                obj.entry("root_path".to_string()).or_insert_with(|| Value::String(rp.clone()));
            }
        }
        if let Some(obj) = query_args.as_object_mut() {
            obj.insert("operation".to_string(), Value::String(batch_op.to_string()));
        }

        // Execute
        match handle_batch_query(project_manager, query_args).await {
            Ok(output) => {
                let result = serde_json::json!({
                    "id": step_id,
                    "use": use_val,
                    "ok": true,
                    "output": output,
                    "duration_ms": step_start.elapsed().as_millis()
                });
                step_results.push(result.clone());
                step_outputs.insert(step_id.to_string(), result);
            }
            Err(e) => {
                let result = serde_json::json!({
                    "id": step_id,
                    "use": use_val,
                    "ok": false,
                    "error": e,
                    "duration_ms": step_start.elapsed().as_millis()
                });
                step_results.push(result.clone());
                step_outputs.insert(step_id.to_string(), result);
                all_ok = false;
                if on_error == "stop" { break; }
            }
        }
    }

    let ok_count = step_results.iter().filter(|r| r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)).count();

    Ok(serde_json::json!({
        "ok": all_ok,
        "summary": format!("{}: {}/{} steps ok ({}ms)", goal, ok_count, step_results.len(), start.elapsed().as_millis()),
        "step_results": step_results,
        "duration_ms": start.elapsed().as_millis()
    }))
}

#[cfg(test)]
mod tests {
    use super::handle_batch_query;
    use crate::project::ProjectManager;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn help_operation_lists_operations() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let pm = Arc::new(Mutex::new(ProjectManager::new()));
        let args = serde_json::json!({
            "operation": "help",
            "root_path": root,
        });
        let v = handle_batch_query(&pm, args).await.unwrap();
        let ops = v["operations"].as_array().expect("operations array");
        assert!(ops.iter().any(|x| x.as_str() == Some("code_search")));
    }

    #[tokio::test]
    async fn symbol_usage_requires_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let pm = Arc::new(Mutex::new(ProjectManager::new()));
        let args = serde_json::json!({
            "operation": "symbol_usage",
            "root_path": root,
            "symbol_names": [],
        });
        let err = handle_batch_query(&pm, args).await.unwrap_err();
        assert!(err.contains("symbol_names"));
    }
}
