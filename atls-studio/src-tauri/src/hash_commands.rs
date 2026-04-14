use super::*;

// ============================================================================
// Hash Pointer Protocol — output-side scanning
// ============================================================================

#[tauri::command]
pub async fn scan_output_hash_refs(
    text: String,
    state: tauri::State<'_, hash_resolver::HashRegistryState>,
) -> Result<Vec<hash_protocol::ResolvedOutputRef>, String> {
    let registry = state.registry.lock().await;
    Ok(hash_protocol::scan_output_refs(&text, &registry))
}

#[tauri::command]
pub async fn resolve_blackboard_display(
    value: String,
    state: tauri::State<'_, hash_resolver::HashRegistryState>,
) -> Result<String, String> {
    let registry = state.registry.lock().await;
    Ok(hash_protocol::resolve_blackboard_display(&value, &registry))
}

/// Result of register_hash_content: short ref and optional current revision for file source.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RegisterHashResult {
    pub short_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision_for_source: Option<String>,
}

/// Register arbitrary content in the in-memory hash registry.
/// Returns short_hash and, when source is a file path, current_revision_for_source.
/// Emits canonical_revision_changed when source is a file path and hash is new for that path.
#[tauri::command]
pub async fn register_hash_content(
    hash: String,
    content: String,
    source: Option<String>,
    lang: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, hash_resolver::HashRegistryState>,
) -> Result<RegisterHashResult, String> {
    let mut registry = state.registry.lock().await;
    let source_clone = source.clone();
    let prev_revision = source_clone
        .as_ref()
        .and_then(|s| registry.get_current_revision(s));
    let line_count = content.lines().count();
    let tokens = content.len() / 4;
    let detected_lang = lang.or_else(|| hash_resolver::detect_lang(source.as_deref()));
    let short_ref = registry.register(hash.clone(), hash_resolver::HashEntry {
        source,
        content,
        tokens,
        lang: detected_lang,
        line_count,
        symbol_count: None,
        spilled: false,
    });
    let current_revision_for_source = if source_clone.as_ref().map_or(false, |s| {
        s.contains('/') || s.contains('\\')
    }) {
        let _ = app.emit(
            "canonical_revision_changed",
            serde_json::json!({
                "path": source_clone.as_ref().unwrap(),
                "revision": hash,
                "previous_revision": prev_revision
            }),
        );
        Some(hash)
    } else {
        None
    };
    Ok(RegisterHashResult {
        short_hash: short_ref,
        current_revision_for_source,
    })
}

/// Batch-resolve multiple hash refs in one IPC call. Returns source + content
/// for each ref, or null if not found. Avoids N+1 for set expansions.
fn batch_resolve_hash_refs_inner(
    registry: &hash_resolver::HashRegistry,
    refs: &[String],
) -> Vec<Option<BatchResolvedEntry>> {
    refs
        .iter()
        .map(|raw_ref| {
            let clean = raw_ref.strip_prefix("h:").unwrap_or(raw_ref);
            let lookup_key = hash_resolver::parse_hash_ref(raw_ref)
                .map(|href| href.hash)
                .unwrap_or_else(|| clean.to_string());
            registry.get(&lookup_key).map(|entry| BatchResolvedEntry {
                source: entry.source.clone(),
                content: entry.content.clone(),
                tokens: entry.tokens,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn batch_resolve_hash_refs(
    refs: Vec<String>,
    state: tauri::State<'_, hash_resolver::HashRegistryState>,
) -> Result<Vec<Option<BatchResolvedEntry>>, String> {
    let registry = state.registry.lock().await;
    Ok(batch_resolve_hash_refs_inner(&registry, &refs))
}

/// Bulk-lookup current canonical revisions (content hashes) for source paths.
/// Returns a map of path -> Option<hash>. Read-only registry lock, no file I/O.
#[tauri::command]
pub async fn get_current_revisions(
    paths: Vec<String>,
    state: tauri::State<'_, hash_resolver::HashRegistryState>,
) -> Result<std::collections::HashMap<String, Option<String>>, String> {
    let registry = state.registry.lock().await;
    let mut result = std::collections::HashMap::with_capacity(paths.len());
    for path in paths {
        let rev = registry.get_current_revision(&path);
        result.insert(path, rev);
    }
    Ok(result)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchResolvedEntry {
    pub source: Option<String>,
    pub content: String,
    pub tokens: usize,
}

/// Resolved content for a single h:ref (including shapes, diffs, symbols).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResolvedHashContent {
    pub source: Option<String>,
    pub snapshot_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    pub content: String,
    pub total_lines: usize,
    pub lang: Option<String>,
    pub shape_applied: Option<String>,
    pub highlight_ranges: Option<Vec<(u32, Option<u32>)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_range: Option<Vec<(u32, Option<u32>)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_range: Option<Vec<(u32, Option<u32>)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_lines: Option<u32>,
    pub is_diff: bool,
    pub diff_stats: Option<diff_engine::DiffStats>,
}

fn resolved_hash_content(
    snapshot_hash: String,
    selector: Option<String>,
    source: Option<String>,
    content: String,
    total_lines: usize,
    lang: Option<String>,
    shape_applied: Option<String>,
    highlight_ranges: Option<Vec<(u32, Option<u32>)>>,
    target_range: Option<Vec<(u32, Option<u32>)>>,
    actual_range: Option<Vec<(u32, Option<u32>)>>,
    context_lines: Option<u32>,
    is_diff: bool,
    diff_stats: Option<diff_engine::DiffStats>,
) -> ResolvedHashContent {
    ResolvedHashContent {
        source,
        snapshot_hash,
        selector,
        content,
        total_lines,
        lang,
        shape_applied,
        highlight_ranges,
        target_range,
        actual_range,
        context_lines,
        is_diff,
        diff_stats,
    }
}

/// Run `git show REF:path` and return stdout on success.
fn run_git_show(git_ref: &str, git_path: &str, git_root: &std::path::Path) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["show", &format!("{}:{}", git_ref, git_path)])
        .current_dir(git_root)
        .output()
        .map_err(|e| format!("Failed to run git show: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git show {}:{} failed: {}", git_ref, git_path, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Try `git show REF:path` against a single project root.
/// Discovers the git root, computes the monorepo prefix, and runs the command.
/// Falls back to `git ls-tree` search when the direct path isn't found.
fn try_git_show(
    git_ref: &str,
    path: &str,
    project_root: &std::path::Path,
) -> Result<String, String> {
    let git_root = {
        let out = std::process::Command::new("git")
            .args(["rev-parse", "--show-toplevel"])
            .current_dir(project_root)
            .output()
            .map_err(|e| format!("Failed to discover git root: {}", e))?;
        if !out.status.success() {
            project_root.to_path_buf()
        } else {
            std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
    };

    let prefix = project_root
        .strip_prefix(&git_root)
        .unwrap_or(std::path::Path::new(""))
        .to_string_lossy()
        .replace('\\', "/");

    let resolved_path = if std::path::Path::new(path).is_relative() {
        path.to_string()
    } else {
        std::path::Path::new(path)
            .strip_prefix(project_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string())
    };

    let git_path = if prefix.is_empty() {
        resolved_path.replace('\\', "/")
    } else {
        format!("{}/{}", prefix.trim_end_matches('/'), resolved_path.replace('\\', "/"))
    };

    // Try direct path first
    if let Ok(content) = run_git_show(git_ref, &git_path, &git_root) {
        return Ok(content);
    }

    // Fallback: use ls-tree to find a unique file matching the relative path suffix
    let norm_suffix = resolved_path.replace('\\', "/");
    if norm_suffix.is_empty() {
        return Err(format!("git show {}:{} not found", git_ref, git_path));
    }
    let suffix_with_sep = format!("/{}", norm_suffix);
    let ls_output = std::process::Command::new("git")
        .args(["ls-tree", "-r", "--name-only", git_ref])
        .current_dir(&git_root)
        .output()
        .map_err(|e| format!("git ls-tree failed: {}", e))?;
    if ls_output.status.success() {
        let tree = String::from_utf8_lossy(&ls_output.stdout);
        let matches: Vec<&str> = tree.lines()
            .filter(|line| line.ends_with(&suffix_with_sep) || *line == norm_suffix)
            .collect();
        match matches.len() {
            1 => return run_git_show(git_ref, matches[0], &git_root),
            n if n > 1 => return Err(format!(
                "git show {}:{} ambiguous — {} matches: {}",
                git_ref, git_path, n, matches.join(", ")
            )),
            _ => {}
        }
    }

    Err(format!("git show {}:{} not found (also tried ls-tree suffix match)", git_ref, git_path))
}

/// Resolve a temporal ref (h:@HEAD:path, h:@tag:name:path, h:@commit:sha:path)
/// by reading file content from git at the specified revision.
/// Tries all workspace roots (active first) until one succeeds.
#[tauri::command]
pub async fn resolve_temporal_ref(
    git_ref: String,
    path: String,
    shape: Option<String>,
    app: AppHandle,
    hr_state: tauri::State<'_, hash_resolver::HashRegistryState>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();

    let candidate_roots: Vec<std::path::PathBuf> = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        let mut candidates = Vec::new();
        if let Ok((project, _)) = resolve_project(&roots, &ar, None) {
            candidates.push(project.root_path().to_path_buf());
        }
        for rf in roots.iter() {
            let rp = rf.project.root_path().to_path_buf();
            if !candidates.iter().any(|c| c == &rp) {
                candidates.push(rp);
            }
        }
        candidates
    };

    if candidate_roots.is_empty() {
        return Err("ATLS project not initialized".to_string());
    }

    let mut last_err = String::new();
    for project_root in &candidate_roots {
        match try_git_show(&git_ref, &path, project_root) {
            Ok(content) => {
                let normalized = normalize_line_endings(&content);
                let hash = content_hash(&normalized);

                {
                    let mut registry = hr_state.registry.lock().await;
                    let lang = hash_resolver::detect_lang(Some(&path));
                    let line_count = normalized.lines().count();
                    registry.register(hash.clone(), hash_resolver::HashEntry {
                        source: Some(format!("{}@{}", path, git_ref)),
                        content: normalized.to_string(),
                        tokens: content.len() / 4,
                        lang,
                        line_count,
                        symbol_count: None,
                        spilled: false,
                    });
                }

                let final_content = if let Some(ref shape_str) = shape {
                    let registry = hr_state.registry.lock().await;
                    match hash_resolver::apply_shape_to_content(&normalized, shape_str, &registry, &hash) {
                        Ok(shaped) => shaped,
                        Err(_) => normalized.to_string(),
                    }
                } else {
                    normalized.to_string()
                };

                return Ok(serde_json::json!({
                    "content": final_content,
                    "hash": hash,
                }));
            }
            Err(e) => {
                last_err = e;
            }
        }
    }

    Err(last_err)
}

#[tauri::command]
pub async fn resolve_hash_ref(
    raw_ref: String,
    session_id: Option<String>,
    hr_state: tauri::State<'_, hash_resolver::HashRegistryState>,
    chat_state: tauri::State<'_, ChatDbState>,
) -> Result<ResolvedHashContent, String> {
    let registry = hr_state.registry.lock().await;

    // Try diff ref first
    if let Some(diff) = hash_resolver::parse_diff_ref(&raw_ref) {
        let result = diff_engine::compute_diff(&registry, &diff.old_hash, &diff.new_hash, 3)?;
        let lang = registry.get(&diff.new_hash)
            .or_else(|| registry.get(&diff.old_hash))
            .and_then(|e| e.lang.clone());
        return Ok(resolved_hash_content(
            diff.new_hash,
            Some("diff".to_string()),
            result.source,
            result.unified,
            result.hunks.iter().map(|h| h.lines.len()).sum(),
            lang,
            Some("diff".to_string()),
            None,
            None,
            None,
            None,
            true,
            Some(result.stats),
        ));
    }

    // Standard h:ref
    let href = hash_resolver::parse_hash_ref(&raw_ref)
        .ok_or_else(|| format!("Invalid h:ref syntax: {}", raw_ref))?;
    let selector = hash_resolver::modifier_selector(&href.modifier);

    let entry_opt = registry.get(&href.hash);
    let entry = match &entry_opt {
        Some(e) => (*e).clone(),
        None => {
            // Fallback: try chat DB blackboard when hash not in registry (e.g. loaded session)
            if let Some(ref sid) = session_id {
                if let Ok(Some((content, source))) = chat_db::get_content_by_hash(&chat_state, sid, &href.hash) {
                    let line_count = content.lines().count();
                    let lang = hash_resolver::detect_lang(source.as_deref());
                    let (extracted, applied_shape) = match &href.modifier {
                        hash_resolver::HashModifier::Auto | hash_resolver::HashModifier::Content => (content, None),
                        hash_resolver::HashModifier::Source => {
                            let src = source.as_ref().map(|s| s.clone()).unwrap_or_else(|| content);
                            return Ok(resolved_hash_content(
                                href.hash.clone(),
                                selector.clone(),
                                Some(src.clone()),
                                src,
                                0,
                                lang.clone(),
                                Some("source".to_string()),
                                None,
                                None,
                                None,
                                None,
                                false,
                                None,
                            ));
                        }
                        hash_resolver::HashModifier::Lines(ranges) => {
                            let extracted = hash_resolver::extract_lines_for_display_with_context(&content, ranges, 0)
                                .map_err(|e| e.to_string())?;
                            return Ok(resolved_hash_content(
                                href.hash.clone(),
                                selector.clone(),
                                hash_resolver::clean_source_path(source.as_deref()),
                                extracted.content,
                                line_count,
                                lang,
                                None,
                                None,
                                Some(extracted.target_range),
                                Some(extracted.actual_range),
                                Some(extracted.context_lines),
                                false,
                                None,
                            ));
                        }
                        hash_resolver::HashModifier::Shape(shape) => {
                            let shaped = shape_ops::apply_shape(&content, shape);
                            (shaped.clone(), Some(hash_protocol::shape_label(shape)))
                        }
                        hash_resolver::HashModifier::ShapedLines { ranges, shape } => {
                            if matches!(shape, hash_resolver::ShapeOp::Snap) {
                                let snapped = shape_ops::snap_lines_to_block(&content, ranges);
                                let extracted = hash_resolver::extract_lines_for_display(&content, &snapped);
                                (extracted, Some("snap".to_string()))
                            } else {
                                let extracted = hash_resolver::extract_lines_for_display(&content, ranges);
                                let shaped = shape_ops::apply_shape(&extracted, shape);
                                (shaped, Some(hash_protocol::shape_label(shape)))
                            }
                        }
                        hash_resolver::HashModifier::SymbolAnchor { kind, name, shape } => {
                            match shape_ops::resolve_symbol_anchor_lang(
                                &content, kind.as_deref(), name, lang.as_deref(),
                            ) {
                                Ok(extracted) => match shape {
                                    Some(s) => (shape_ops::apply_shape(&extracted, s), Some(hash_protocol::shape_label(s))),
                                    None => (extracted, None),
                                },
                                Err(_) => (content, None),
                            }
                        }
                        hash_resolver::HashModifier::Tokens => {
                            let tokens = content.split_whitespace().count();
                            (tokens.to_string(), Some("tokens".to_string()))
                        }
                        hash_resolver::HashModifier::Meta => {
                            let meta = serde_json::json!({
                                "source": source,
                                "tokens": content.split_whitespace().count(),
                                "lines": line_count,
                                "lang": lang,
                            });
                            (serde_json::to_string_pretty(&meta).unwrap_or_default(), Some("meta".to_string()))
                        }
                        hash_resolver::HashModifier::Lang => {
                            (lang.clone().unwrap_or_else(|| "unknown".to_string()), Some("lang".to_string()))
                        }
                        hash_resolver::HashModifier::SymbolDeps { kind, name } => {
                            match shape_ops::analyze_symbol_deps(
                                &content, kind.as_deref(), name, lang.as_deref(),
                            ) {
                                Ok(result) => (result, Some("deps".to_string())),
                                Err(_) => (content, None),
                            }
                        }
                    };
                    let source_clean = hash_resolver::clean_source_path(source.as_deref());
                    return Ok(resolved_hash_content(
                        href.hash.clone(),
                        selector.clone(),
                        source_clean,
                        extracted,
                        line_count,
                        lang,
                        applied_shape,
                        None,
                        None,
                        None,
                        None,
                        false,
                        None,
                    ));
                }
            }
            return Err(format!("Hash {} not found in registry", href.hash));
        }
    };

    let source = hash_resolver::clean_source_path(entry.source.as_deref());
    let lang = entry.lang.clone();

    match &href.modifier {
        hash_resolver::HashModifier::Auto | hash_resolver::HashModifier::Content => {
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                source,
                entry.content.clone(),
                entry.line_count,
                lang,
                None,
                None,
                None,
                None,
                None,
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::Source => {
            let src = source.ok_or("No source path available")?;
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                Some(src.clone()),
                src,
                0,
                lang,
                Some("source".to_string()),
                None,
                None,
                None,
                None,
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::Lines(ranges) => {
            let extracted = hash_resolver::extract_lines_for_display_with_context(&entry.content, ranges, 0)
                .map_err(|e| e.to_string())?;
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                source,
                extracted.content,
                entry.line_count,
                lang,
                None,
                None,
                Some(extracted.target_range),
                Some(extracted.actual_range),
                Some(extracted.context_lines),
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::Shape(shape) => {
            let shaped = shape_ops::apply_shape(&entry.content, shape);
            let hl = if let hash_resolver::ShapeOp::Highlight(r) = shape {
                Some(r.clone())
            } else {
                None
            };
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                source,
                shaped.clone(),
                shaped.lines().count(),
                lang,
                Some(hash_protocol::shape_label(shape)),
                hl,
                None,
                None,
                None,
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::ShapedLines { ranges, shape } => {
            let effective_ranges = if matches!(shape, hash_resolver::ShapeOp::Snap) {
                shape_ops::snap_lines_to_block(&entry.content, ranges)
            } else {
                ranges.clone()
            };
            let lines: Vec<&str> = entry.content.lines().collect();
            let total = lines.len();
            let mut extracted_lines = Vec::new();
            for &(start, end) in effective_ranges.iter() {
                let s = (start as usize).saturating_sub(1).min(total);
                let e = match end { Some(e) => (e as usize).min(total), None => total };
                extracted_lines.extend_from_slice(&lines[s..e]);
            }
            let raw = extracted_lines.join("\n");
            let shaped = if matches!(shape, hash_resolver::ShapeOp::Snap) {
                raw.clone()
            } else {
                shape_ops::apply_shape(&raw, shape)
            };
            let hl = if let hash_resolver::ShapeOp::Highlight(r) = shape {
                Some(r.clone())
            } else {
                None
            };
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                source,
                shaped.clone(),
                shaped.lines().count(),
                lang,
                Some(hash_protocol::shape_label(shape)),
                hl,
                None,
                None,
                None,
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::SymbolAnchor { kind, name, shape } => {
            let extracted = shape_ops::resolve_symbol_anchor_lang(
                &entry.content, kind.as_deref(), name, lang.as_deref(),
            ).map_err(|e| e.to_string())?;
            let content = match shape {
                Some(s) => shape_ops::apply_shape(&extracted, s),
                None => extracted,
            };
            let shape_label = shape.as_ref().map(|s| hash_protocol::shape_label(s));
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                source,
                content.clone(),
                content.lines().count(),
                lang,
                shape_label,
                None,
                None,
                None,
                None,
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::Tokens => {
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                source,
                entry.tokens.to_string(),
                0,
                lang,
                Some("tokens".to_string()),
                None,
                None,
                None,
                None,
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::Meta => {
            let meta = serde_json::json!({
                "source": source,
                "tokens": entry.tokens,
                "lines": entry.line_count,
                "lang": entry.lang,
                "symbols": entry.symbol_count,
            });
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                None,
                serde_json::to_string_pretty(&meta).unwrap_or_default(),
                0,
                Some("json".to_string()),
                Some("meta".to_string()),
                None,
                None,
                None,
                None,
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::Lang => {
            let detected = entry.lang.clone().unwrap_or_else(|| "unknown".to_string());
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                source,
                detected,
                0,
                lang,
                Some("lang".to_string()),
                None,
                None,
                None,
                None,
                false,
                None,
            ))
        }
        hash_resolver::HashModifier::SymbolDeps { kind, name } => {
            let result = shape_ops::analyze_symbol_deps(
                &entry.content, kind.as_deref(), name, lang.as_deref(),
            ).map_err(|e| e.to_string())?;
            Ok(resolved_hash_content(
                href.hash.clone(),
                selector.clone(),
                source,
                result.clone(),
                result.lines().count(),
                lang,
                Some("deps".to_string()),
                None,
                None,
                None,
                None,
                false,
                None,
            ))
        }
    }
}

// ============================================================================
// HPP-Native Search — resolve h:@search(query) to hash-registered results
// ============================================================================

fn serialize_relevance<S>(v: &f64, s: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let rounded = (*v * 100.0).round() / 100.0;
    s.serialize_f64(rounded)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchSelectorResult {
    pub hash: String,
    pub source: String,
    pub line: u32,
    pub symbol: String,
    pub kind: String,
    #[serde(serialize_with = "serialize_relevance")]
    pub relevance: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[tauri::command]
pub async fn resolve_search_selector(
    query: String,
    limit: Option<usize>,
    tier: Option<String>,
    app: AppHandle,
    hr_state: tauri::State<'_, hash_resolver::HashRegistryState>,
) -> Result<Vec<SearchSelectorResult>, String> {
    let state = app.state::<AtlsProjectState>();
    let projects: Vec<(std::sync::Arc<crate::AtlsProject>, String)> = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        let mut out = Vec::new();
        // Active root first
        if let Ok(pair) = resolve_project(&roots, &ar, None) {
            out.push(pair);
        }
        for rf in roots.iter() {
            if !out.iter().any(|(_, p)| *p == rf.path) {
                out.push((std::sync::Arc::clone(&rf.project), rf.path.clone()));
            }
        }
        out
    };

    if projects.is_empty() {
        return Err("ATLS project not initialized".to_string());
    }

    let search_cache = app.state::<SearchCacheState>();
    let file_cache = &search_cache.file_cache;
    let effective_limit = limit.unwrap_or(10).min(50).max(1);

    let sanitized: String = query.chars()
        .map(|c| if "#[]{}().:;*\"'^".contains(c) { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    let search_query = if sanitized.trim().is_empty() { &query } else { &sanitized };

    let mut registry = hr_state.registry.lock().await;
    let mut results = Vec::new();

    for (project, _) in &projects {
        let project_root = project.root_path().to_path_buf();
        let remaining = effective_limit.saturating_sub(results.len());
        if remaining == 0 { break; }

        let raw_results = match tier.as_deref() {
            Some("high") => {
                match project.query().search_code_tiered(search_query, remaining, Some(file_cache)) {
                    Ok(tiered) => tiered.high_confidence,
                    Err(_) => continue,
                }
            }
            Some("medium") => {
                match project.query().search_code_tiered(search_query, remaining, Some(file_cache)) {
                    Ok(tiered) => {
                        let mut combined = tiered.high_confidence;
                        combined.extend(tiered.medium_confidence);
                        combined.truncate(remaining);
                        combined
                    }
                    Err(_) => continue,
                }
            }
            _ => {
                match project.query().search_code_full(search_query, remaining, Some(file_cache), 1) {
                    Ok(r) => r,
                    Err(_) => continue,
                }
            }
        };

        for r in raw_results {
            let full_path = if std::path::Path::new(&r.file).is_absolute() {
                std::path::PathBuf::from(&r.file)
            } else {
                project_root.join(&r.file)
            };

            let content = match std::fs::read_to_string(&full_path) {
                Ok(c) => normalize_line_endings(&c).into_owned(),
                Err(_) => continue,
            };

            let hash = content_hash(&content);
            let lang = hash_resolver::detect_lang(Some(&r.file));
            let line_count = content.lines().count();

            if registry.get(&hash).is_none() {
                registry.register(hash.clone(), hash_resolver::HashEntry {
                    source: Some(r.file.clone()),
                    content,
                    tokens: line_count * 5,
                    lang,
                    line_count,
                    symbol_count: None,
                    spilled: false,
                });
            }

            results.push(SearchSelectorResult {
                hash,
                source: r.file,
                line: r.line,
                symbol: r.symbol,
                kind: r.kind,
                relevance: r.relevance,
                signature: r.signature,
            });
        }
    }

    Ok(results)
}

#[cfg(test)]
mod temporal_ref_tests {
    use super::{batch_resolve_hash_refs_inner, try_git_show};
    use crate::hash_resolver::{HashEntry, HashRegistry};

    #[test]
    fn batch_resolve_hash_refs_handles_shaped_refs() {
        let mut registry = HashRegistry::new();
        registry.register(
            "abc12345".to_string(),
            HashEntry {
                source: Some("src/demo.ts".to_string()),
                content: "function demo() {\n  return 1;\n}\n".to_string(),
                tokens: 6,
                lang: Some("ts".to_string()),
                line_count: 3,
                symbol_count: None,
                spilled: false,
            },
        );

        let refs = vec!["h:abc12345:10-12".to_string(), "h:abc12345:fn(demo):sig".to_string()];
        let resolved = batch_resolve_hash_refs_inner(&registry, &refs);

        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].as_ref().and_then(|entry| entry.source.as_deref()), Some("src/demo.ts"));
        assert_eq!(resolved[1].as_ref().and_then(|entry| entry.source.as_deref()), Some("src/demo.ts"));
    }

    /// Test that try_git_show resolves paths correctly when project root is a subdir of git root.
    /// Creates temp repo: repo/atls-studio/src/foo.ts, project_root=repo/atls-studio.
    #[test]
    fn test_temporal_ref_project_in_subdir() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo_root = dir.path();

        // Init git repo
        let status = std::process::Command::new("git")
            .args(["init"])
            .current_dir(repo_root)
            .status();
        if status.as_ref().map(|s| !s.success()).unwrap_or(true) {
            return; // skip if git not available
        }

        // Create subdir structure: atls-studio/src/foo.ts
        let subdir = repo_root.join("atls-studio").join("src");
        std::fs::create_dir_all(&subdir).expect("create subdir");
        let file_path = subdir.join("foo.ts");
        std::fs::write(&file_path, "export function hello() { return 42; }\n").expect("write file");

        // Git add and commit
        std::process::Command::new("git")
            .args(["add", "atls-studio/src/foo.ts"])
            .current_dir(repo_root)
            .output()
            .expect("git add");
        std::process::Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(repo_root)
            .output()
            .ok();
        std::process::Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(repo_root)
            .output()
            .ok();
        let commit = std::process::Command::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(repo_root)
            .output();
        if commit.as_ref().map(|o| !o.status.success()).unwrap_or(true) {
            return; // skip if commit failed (e.g. no user config)
        }

        let project_root = repo_root.join("atls-studio");
        let path = "src/foo.ts";
        let result = try_git_show("HEAD", path, &project_root);

        assert!(
            result.is_ok(),
            "try_git_show should succeed when project in subdir: {:?}",
            result.err()
        );
        let content = result.unwrap();
        assert!(
            content.contains("hello"),
            "content should contain file body: {}",
            content
        );
    }
}
