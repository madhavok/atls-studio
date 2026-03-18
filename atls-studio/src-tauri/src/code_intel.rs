use super::*;

/// Search code semantically via ATLS (with snippets)
#[tauri::command]
pub async fn atls_search_code(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        resolve_project(&roots, &ar, None)?
    };
    let search_cache = app.state::<SearchCacheState>();
    let results = project.query()
        .search_code_full(&query, limit.unwrap_or(20) as usize, Some(&search_cache.file_cache), 1)
        .map_err(|e| format!("Failed to search code: {}", e))?;

    Ok(serde_json::json!({
        "results": results,
    }))
}

/// Get symbol usage (definitions and references) via ATLS
/// 
/// match_type can be: "exact" (default), "exact_nocase", "contains"
#[tauri::command]
pub async fn atls_get_symbol_usage(
    app: AppHandle,
    symbol_name: String,
    match_type: Option<String>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        resolve_project(&roots, &ar, None)?
    };
    let match_type_str = match_type.as_deref().unwrap_or("exact");
    let usage = project.query()
        .get_symbol_usage_with_options(&symbol_name, match_type_str)
        .map_err(|e| format!("Failed to get symbol usage: {}", e))?;
    
    let definitions: Vec<serde_json::Value> = usage.definitions.into_iter().map(|d| {
        serde_json::json!({
            "file": d.file,
            "line": d.line,
            "kind": d.kind,
            "signature": d.signature,
        })
    }).collect();
    
    let references: Vec<serde_json::Value> = usage.references.into_iter().map(|r| {
        serde_json::json!({
            "file": r.file,
            "line": r.line,
        })
    }).collect();
    
    Ok(serde_json::json!({
        "symbol": symbol_name,
        "match_type": match_type_str,
        "definitions": definitions,
        "references": references,
    }))
}

/// Diagnostic: Query symbols with flexible matching options
/// 
/// search_type can be: "exact", "exact_nocase", "contains", "prefix", "suffix"
#[tauri::command]
pub async fn atls_diagnose_symbols(
    app: AppHandle,
    query: String,
    search_type: String,
    file_filter: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        resolve_project(&roots, &ar, None)?
    };
    let result = project.query()
        .diagnose_symbols(&query, &search_type, file_filter.as_deref(), limit)
        .map_err(|e| format!("Failed to diagnose symbols: {}", e))?;
    
    Ok(serde_json::to_value(&result)
        .map_err(|e| format!("Failed to serialize result: {}", e))?)
}

/// Get file context via ATLS
#[tauri::command]
pub async fn atls_get_file_context(
    app: AppHandle,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        resolve_project(&roots, &ar, None)?
    };
    let file_graph = project.query().get_file_graph(&file_path, 20)
        .map_err(|e| format!("Failed to get file context: {}", e))?;
    
    if let Some(graph) = file_graph {
        Ok(serde_json::to_value(&graph)
            .map_err(|e| format!("Failed to serialize file context: {}", e))?)
    } else {
        Err(format!("File not found: {}", file_path))
    }
}

/// Per-language index health diagnostics for the Health panel.
#[tauri::command]
pub async fn atls_get_language_health(
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        resolve_project(&roots, &ar, None)?
    };
    {
        let conn = project.query().db().conn();

        // 1. Per-language file + LOC counts
        let lang_files: Vec<(String, i64, i64)> = conn
            .prepare(
                "SELECT language, COUNT(*) as files, COALESCE(SUM(line_count),0) as loc
                 FROM files GROUP BY language ORDER BY loc DESC",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default();

        // 2. Per-language symbol counts grouped by kind
        let sym_counts: Vec<(String, String, i64)> = conn
            .prepare(
                "SELECT f.language, s.kind, COUNT(*) as cnt
                 FROM symbols s JOIN files f ON s.file_id = f.id
                 GROUP BY f.language, s.kind",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get(2)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default();

        // 3. Per-language call counts
        let call_counts: Vec<(String, i64)> = conn
            .prepare(
                "SELECT f.language, COUNT(*) FROM calls c
                 JOIN files f ON c.file_id = f.id GROUP BY f.language",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get(1)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default();

        // 4. Per-language issue counts (unsuppressed only)
        let issue_counts: Vec<(String, i64)> = conn
            .prepare(
                "SELECT f.language, COUNT(*) FROM issues i
                 JOIN files f ON i.file_id = f.id
                 WHERE i.suppressed = 0 GROUP BY f.language",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get(1)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default();

        // Build lookup maps
        let mut sym_map: std::collections::HashMap<String, std::collections::HashMap<String, i64>> =
            std::collections::HashMap::new();
        for (lang, kind, cnt) in &sym_counts {
            sym_map
                .entry(lang.clone())
                .or_default()
                .insert(kind.clone(), *cnt);
        }
        let call_map: std::collections::HashMap<String, i64> =
            call_counts.into_iter().collect();
        let issue_map: std::collections::HashMap<String, i64> =
            issue_counts.into_iter().collect();

        // Static capability matrix per language
        fn capabilities_for(lang: &str) -> serde_json::Value {
            let (inv, ren, mov, ext, fs, su, vt, vtest) = match lang {
                "Rust"       => (true, true, true, true, true, true, true, false),
                "TypeScript" => (true, true, true, true, true, true, true, true),
                "JavaScript" => (true, true, true, true, true, true, true, true),
                "Python"     => (true, true, true, true, true, true, false, false),
                "Java"       => (true, true, true, true, true, true, true, true),
                "Go"         => (true, true, true, true, true, true, false, false),
                "C"          => (true, true, false, false, true, true, false, false),
                "C++"        => (true, true, false, false, true, true, false, false),
                "CSharp"     => (true, true, true, true, true, true, true, true),
                _            => (false, false, false, false, false, false, false, false),
            };
            serde_json::json!({
                "inventory": inv,
                "rename": ren,
                "move": mov,
                "extract": ext,
                "find_symbol": fs,
                "symbol_usage": su,
                "verify_typecheck": vt,
                "verify_test": vtest,
            })
        }

        let results: Vec<serde_json::Value> = lang_files
            .iter()
            .map(|(lang, files, loc)| {
                let kinds = sym_map.get(lang);
                let get = |k: &str| kinds.and_then(|m| m.get(k).copied()).unwrap_or(0);
                let sym_total: i64 = kinds.map(|m| m.values().sum()).unwrap_or(0);
                serde_json::json!({
                    "language": lang,
                    "files": files,
                    "loc": loc,
                    "symbols": {
                        "total": sym_total,
                        "functions": get("function"),
                        "structs": get("struct") + get("class"),
                        "methods": get("method"),
                        "traits": get("interface") + get("trait"),
                        "types": get("type"),
                        "constants": get("constant"),
                        "other": sym_total
                            - get("function") - get("struct") - get("class")
                            - get("method") - get("interface") - get("trait")
                            - get("type") - get("constant"),
                    },
                    "calls": call_map.get(lang).copied().unwrap_or(0),
                    "issues": issue_map.get(lang).copied().unwrap_or(0),
                    "capabilities": capabilities_for(lang),
                })
            })
            .collect();

        Ok(serde_json::json!({ "languages": results }))
    }
}

/// Get project profile for AI context (TOON-optimized)
#[tauri::command]
pub async fn atls_get_project_profile(
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        resolve_project(&roots, &ar, None)?
    };
    {
        use atls_core::IssueFilterOptions;
        
        // Get project statistics - use separate scope for DB lock
        let (file_count, _symbol_count, total_lines, languages) = {
            let conn = project.query().db().conn();
            
            // File count
            let file_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM files",
                [],
                |row| row.get(0),
            ).unwrap_or(0);
            
            // Symbol count
            let symbol_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM symbols",
                [],
                |row| row.get(0),
            ).unwrap_or(0);
            
            // Total line count (actual, not estimate)
            let total_lines: i64 = conn.query_row(
                "SELECT COALESCE(SUM(line_count), 0) FROM files",
                [],
                |row| row.get(0),
            ).unwrap_or(0);
            
            // Language distribution with line counts
            let languages: Vec<(String, i64, i64)> = conn.prepare(
                "SELECT language, COUNT(*) as file_cnt, COALESCE(SUM(line_count), 0) as line_cnt 
                 FROM files GROUP BY language ORDER BY line_cnt DESC LIMIT 10"
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
                })?;
                let mut result = Vec::new();
                for row in rows {
                    result.push(row?);
                }
                Ok(result)
            })
            .unwrap_or_default();
            
            (file_count, symbol_count, total_lines, languages)
        }; // conn lock released here
        
        // Issue counts - now safe to call find_issues
        let filter = IssueFilterOptions::default();
        let issues = project.query().find_issues(&filter)
            .unwrap_or_default();
        
        let mut high = 0;
        let mut medium = 0;
        let mut low = 0;
        for issue in &issues {
            match issue.severity {
                atls_core::types::IssueSeverity::High => high += 1,
                atls_core::types::IssueSeverity::Medium => medium += 1,
                atls_core::types::IssueSeverity::Low => low += 1,
            }
        }
        
        // Convert languages to Record<string, number> (line counts per language)
        let mut langs_map: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
        for (lang, _file_cnt, line_cnt) in languages {
            langs_map.insert(lang, serde_json::json!(line_cnt));
        }
        
        // Get subsystem/module names from file structure
        let mods: Vec<String> = project.query().get_subsystems(2)
            .map(|subs| subs.into_iter().map(|s| s.name).collect())
            .unwrap_or_default();
        
        // Group issues by category for health.cats
        let mut cats_map: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
        for issue in &issues {
            let counter = cats_map
                .entry(issue.category.clone())
                .or_insert_with(|| serde_json::json!(0));
            if let Some(n) = counter.as_i64() {
                *counter = serde_json::json!(n + 1);
            }
        }
        
        // Build workspaces summary from all roots' sub-workspaces
        let ws_json: Vec<serde_json::Value> = {
            let roots = state.roots.lock().await;
            roots.iter()
                .flat_map(|r| r.sub_workspaces.iter())
                .map(|w| serde_json::json!({
                    "name": w.name,
                    "path": w.rel_path,
                    "abs_path": w.abs_path,
                    "types": w.types,
                    "build_files": w.build_files,
                    "group": w.group_name,
                    "source": w.source,
                }))
                .collect()
        };

        // Detect entry point files and extract signatures
        let (entry_paths, entry_manifest) = {
            let conn = project.query().db().conn();
            let root = project.root_path().to_string_lossy().replace('\\', "/");

            // Naming heuristic: well-known entry point file patterns
            let entry_patterns: &[&str] = &[
                "main.ts", "main.tsx", "main.rs", "main.go", "main.py", "main.java",
                "index.ts", "index.tsx", "index.js", "index.jsx",
                "App.tsx", "App.ts", "App.jsx", "App.js",
                "lib.rs", "mod.rs",
                "app.py", "__main__.py",
                "src/main.ts", "src/main.tsx", "src/main.rs", "src/main.go", "src/main.py",
                "src/index.ts", "src/index.tsx", "src/index.js",
                "src/App.tsx", "src/App.ts", "src/App.jsx",
                "src/lib.rs",
            ];

            let mut entry_files: Vec<(String, f64, String)> = Vec::new(); // (path, importance, method)
            let mut seen_paths = std::collections::HashSet::new();

            // Query naming-heuristic matches
            for pattern in entry_patterns {
                let full_pattern = format!("%/{}", pattern);
                let short_pattern = pattern.to_string();
                let mut stmt = conn.prepare(
                    "SELECT f.path, COALESCE(fi.importance_score, 1.0)
                     FROM files f
                     LEFT JOIN file_importance fi ON fi.file_id = f.id
                     WHERE f.path LIKE ?1 OR f.path = ?2
                     LIMIT 5"
                ).unwrap();
                let rows = stmt.query_map(
                    rusqlite::params![full_pattern, short_pattern],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
                ).unwrap();
                for row in rows.flatten() {
                    if seen_paths.insert(row.0.clone()) {
                        entry_files.push((row.0, row.1, "naming".to_string()));
                    }
                }
            }

            // Graph signal: top files by importance_score not already matched
            let placeholders: String = (0..seen_paths.len())
                .map(|i| format!("?{}", i + 1))
                .collect::<Vec<_>>()
                .join(",");
            let graph_query = if seen_paths.is_empty() {
                "SELECT f.path, fi.importance_score
                 FROM file_importance fi
                 JOIN files f ON f.id = fi.file_id
                 ORDER BY fi.importance_score DESC
                 LIMIT 10".to_string()
            } else {
                format!(
                    "SELECT f.path, fi.importance_score
                     FROM file_importance fi
                     JOIN files f ON f.id = fi.file_id
                     WHERE f.path NOT IN ({})
                     ORDER BY fi.importance_score DESC
                     LIMIT 10",
                    placeholders
                )
            };

            if let Ok(mut stmt) = conn.prepare(&graph_query) {
                let seen_vec: Vec<String> = seen_paths.iter().cloned().collect();
                let params: Vec<&dyn rusqlite::types::ToSql> = seen_vec.iter()
                    .map(|s| s as &dyn rusqlite::types::ToSql)
                    .collect();
                if let Ok(rows) = stmt.query_map(params.as_slice(), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                }) {
                    for row in rows.flatten() {
                        if row.1 > 1.0 && seen_paths.insert(row.0.clone()) {
                            entry_files.push((row.0, row.1, "graph".to_string()));
                        }
                    }
                }
            }

            // Sort by importance descending
            entry_files.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

            // Extract signatures with 5k token budget (~4 chars/token)
            const TOKEN_BUDGET: usize = 5000;
            const CHARS_PER_TOKEN: usize = 4;
            const CHAR_BUDGET: usize = TOKEN_BUDGET * CHARS_PER_TOKEN;
            let mut total_chars: usize = 0;
            let mut manifest: Vec<serde_json::Value> = Vec::new();
            let mut paths: Vec<String> = Vec::new();

            for (file_path, importance, method) in &entry_files {
                let abs_path = if std::path::Path::new(file_path).is_absolute() {
                    std::path::PathBuf::from(file_path)
                } else {
                    std::path::PathBuf::from(&root).join(file_path)
                };

                let content = match std::fs::read_to_string(&abs_path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let line_count = content.lines().count();
                let sig = shape_ops::apply_shape(&content, &hash_resolver::ShapeOp::Sig);
                let sig_chars = sig.len();
                let est_tokens = sig_chars / CHARS_PER_TOKEN.max(1);

                // Tiered scaling: if over budget, emit one-liner instead
                let (final_sig, final_tokens, tier) = if total_chars + sig_chars <= CHAR_BUDGET {
                    (sig, est_tokens, "full")
                } else if total_chars < CHAR_BUDGET {
                    let one_liner = format!("{} | {}L | importance:{:.1}", file_path, line_count, importance);
                    let ol_tokens = one_liner.len() / CHARS_PER_TOKEN.max(1);
                    if total_chars + one_liner.len() <= CHAR_BUDGET {
                        (one_liner, ol_tokens, "summary")
                    } else {
                        break;
                    }
                } else {
                    break;
                };

                total_chars += final_sig.len();
                let rel_path = file_path.replace('\\', "/");
                paths.push(rel_path.clone());

                manifest.push(serde_json::json!({
                    "path": rel_path,
                    "sig": final_sig,
                    "tokens": final_tokens,
                    "lines": line_count,
                    "importance": importance,
                    "method": method,
                    "tier": tier,
                }));
            }

            (paths, manifest)
        };

        Ok(serde_json::json!({
            "proj": project.root_path().to_string_lossy(),
            "stats": {
                "files": file_count,
                "loc": total_lines,
                "langs": langs_map,
            },
            "stack": Vec::<String>::new(),
            "arch": {
                "mods": mods,
                "entry": entry_paths,
            },
            "health": {
                "issues": {
                    "h": high,
                    "m": medium,
                    "l": low,
                },
                "hotspots": Vec::<String>::new(),
                "cats": cats_map,
            },
            "patterns": Vec::<String>::new(),
            "deps": {
                "prod": Vec::<String>::new(),
                "dev": Vec::<String>::new(),
            },
            "workspaces": ws_json,
            "entryManifest": entry_manifest,
        }))
    }
}

/// Expand a concept to related search terms
pub(crate) fn expand_concept(concept: &str) -> String {
    let concept_lower = concept.to_lowercase();
    
    // Map concepts to related terms
    let expansions: &[(&str, &str)] = &[
        ("auth", "auth authenticate authentication login logout session token jwt"),
        ("authentication", "auth authenticate login logout session token jwt password"),
        ("cache", "cache caching cached memoize memoization redis memcache ttl"),
        ("caching", "cache cached memoize memoization redis memcache ttl expire"),
        ("database", "database db sql query model repository dao orm"),
        ("db", "database sql query model repository dao orm sqlite postgres"),
        ("validation", "validate validation validator check verify schema"),
        ("error", "error exception throw catch try finally handle handler"),
        ("logging", "log logger logging debug info warn error trace"),
        ("api", "api endpoint route handler controller rest graphql"),
        ("test", "test spec describe it expect assert mock stub"),
        ("config", "config configuration settings environment env options"),
        ("security", "security secure auth encrypt decrypt hash salt"),
        ("performance", "performance perf optimize optimization cache batch async"),
        ("async", "async await promise future concurrent parallel thread"),
        ("state", "state store redux zustand context provider reducer"),
        ("routing", "route router routing navigate navigation path url"),
        ("storage", "storage store persist save load file disk"),
    ];
    
    for (key, expansion) in expansions {
        if concept_lower.contains(key) || key.contains(&concept_lower) {
            return expansion.to_string();
        }
    }
    
    // Default: just return the concept
    concept.to_string()
}
