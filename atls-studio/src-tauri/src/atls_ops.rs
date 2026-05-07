use super::*;

fn resolve_bundled_patterns(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir()
        .ok()
        .map(|d| d.join("patterns"))
        .filter(|p| p.exists())
        .or_else(|| {
            let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..").join("..").join("atls-rs").join("patterns");
            dev_path.canonicalize().ok().filter(|p| p.exists())
        })
}

/// Open an AtlsProject for a root path and scan sub-workspaces.
/// Returns the new RootFolder (does NOT insert it into state).
pub(crate) async fn open_root_folder(app: &AppHandle, root_path: &str) -> Result<RootFolder, String> {
    let bundled_patterns = resolve_bundled_patterns(app);
    if let Some(ref bp) = bundled_patterns {
        eprintln!("[ATLS] Bundled patterns fallback: {:?}", bp);
    }

    eprintln!("[ATLS] Opening project at: {}", root_path);
    let project = AtlsProject::open_with_patterns_fallback(
        root_path,
        bundled_patterns.as_deref(),
    )
        .await
        .map_err(|e| {
            eprintln!("[ATLS] Failed to open project: {}", e);
            format!("Failed to initialize ATLS project: {}", e)
        })?;
    eprintln!("[ATLS] Project opened successfully");

    let project_arc = Arc::new(project);

    // Scan sub-workspaces and persist to DB
    let root_pb = PathBuf::from(root_path);
    let proj_clone = Arc::clone(&project_arc);
    let sub_ws = tokio::task::spawn_blocking(move || {
        let detected = scan_workspaces(&root_pb, &root_pb, 6);
        if !detected.is_empty() {
            let conn = proj_clone.query().db().conn();
            if let Err(e) = persist_workspaces_to_db(&conn, &detected) {
                eprintln!("[ATLS] Failed to persist workspaces: {}", e);
            }
        }
        let conn = proj_clone.query().db().conn();
        load_workspaces_from_db(&conn).unwrap_or_default()
    }).await.map_err(|e| format!("Workspace scan failed: {}", e))?;

    eprintln!("[ATLS] Loaded {} sub-workspace(s) for {}", sub_ws.len(), root_path);

    Ok(RootFolder {
        path: root_path.to_string(),
        project: project_arc,
        sub_workspaces: sub_ws,
    })
}

/// Initialize ATLS — opens a single-folder workspace (clears existing roots).
#[tauri::command]
pub async fn atls_init(
    app: AppHandle,
    root_path: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let mut roots = state.roots.lock().await;

    // If already initialized for this exact path, return early
    let norm_new = root_path.replace('\\', "/");
    if roots.len() == 1 && roots[0].path.replace('\\', "/") == norm_new {
        return Ok(serde_json::json!({
            "status": "initialized",
            "rootPath": root_path,
        }));
    }

    // Clear existing roots
    roots.clear();

    let rf = open_root_folder(&app, &root_path).await?;
    roots.push(rf);

    // Set as active root
    if let Ok(mut ar) = state.active_root.write() {
        *ar = Some(root_path.clone());
    }
    // Clear workspace file (this is a plain folder open, not a workspace file)
    if let Ok(mut wf) = state.workspace_file.write() {
        *wf = None;
    }

    Ok(serde_json::json!({
        "status": "initialized",
        "rootPath": root_path,
    }))
}

/// Dispose all roots (close workspace).
#[tauri::command]
pub async fn atls_dispose(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AtlsProjectState>();
    let mut roots = state.roots.lock().await;
    roots.clear();
    if let Ok(mut ar) = state.active_root.write() {
        *ar = None;
    }
    if let Ok(mut wf) = state.workspace_file.write() {
        *wf = None;
    }
    Ok(())
}

/// Add a root folder to the workspace.
#[tauri::command]
pub async fn atls_add_root(app: AppHandle, root_path: String) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let mut roots = state.roots.lock().await;

    let norm = root_path.replace('\\', "/");
    if roots.iter().any(|r| r.path.replace('\\', "/") == norm) {
        return Ok(serde_json::json!({ "status": "already_exists" }));
    }

    let rf = open_root_folder(&app, &root_path).await?;
    roots.push(rf);

    // If this is the first root, set it active
    if roots.len() == 1 {
        if let Ok(mut ar) = state.active_root.write() {
            *ar = Some(root_path.clone());
        }
    }

    Ok(serde_json::json!({ "status": "added", "rootPath": root_path }))
}

/// Remove a root folder from the workspace.
#[tauri::command]
pub async fn atls_remove_root(app: AppHandle, root_path: String) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let mut roots = state.roots.lock().await;

    let norm = root_path.replace('\\', "/");
    let before = roots.len();
    roots.retain(|r| r.path.replace('\\', "/") != norm);
    let removed = roots.len() < before;

    // Update active root if it was removed
    if removed {
        if let Ok(mut ar) = state.active_root.write() {
            if ar.as_ref().map(|a| a.replace('\\', "/")) == Some(norm) {
                *ar = roots.first().map(|r| r.path.clone());
            }
        }
    }

    Ok(serde_json::json!({ "status": if removed { "removed" } else { "not_found" } }))
}

/// Set the active root folder.
#[tauri::command]
pub async fn atls_set_active_root(app: AppHandle, root_path: String) -> Result<(), String> {
    let state = app.state::<AtlsProjectState>();
    if let Ok(mut ar) = state.active_root.write() {
        *ar = Some(root_path);
    }
    Ok(())
}

/// Get all root folders with metadata.
#[tauri::command]
pub async fn atls_get_roots(app: AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let roots = state.roots.lock().await;
    let active = state.active_root.read()
        .map(|a| a.clone())
        .unwrap_or(None);

    let entries: Vec<serde_json::Value> = roots.iter().map(|rf| {
        let name = PathBuf::from(&rf.path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rf.path.clone());
        serde_json::json!({
            "path": rf.path,
            "name": name,
            "isActive": active.as_ref().map(|a| a.replace('\\', "/")) == Some(rf.path.replace('\\', "/")),
            "subWorkspaces": rf.sub_workspaces,
        })
    }).collect();

    Ok(serde_json::json!({ "roots": entries }))
}

/// Save the current workspace to an .atls-workspace file.
#[tauri::command]
pub async fn atls_save_workspace(app: AppHandle, file_path: String) -> Result<(), String> {
    let state = app.state::<AtlsProjectState>();
    let roots = state.roots.lock().await;

    let folders: Vec<serde_json::Value> = roots.iter()
        .map(|rf| serde_json::json!({ "path": rf.path }))
        .collect();
    let ws_json = serde_json::json!({
        "folders": folders,
        "settings": {},
    });

    let contents = serde_json::to_string_pretty(&ws_json)
        .map_err(|e| format!("Failed to serialize workspace: {}", e))?;
    std::fs::write(&file_path, contents)
        .map_err(|e| format!("Failed to write workspace file: {}", e))?;

    if let Ok(mut wf) = state.workspace_file.write() {
        *wf = Some(PathBuf::from(&file_path));
    }

    Ok(())
}

/// Open a .atls-workspace file (disposes existing roots, loads all folders).
#[tauri::command]
pub async fn atls_open_workspace(app: AppHandle, file_path: String) -> Result<serde_json::Value, String> {
    let contents = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read workspace file: {}", e))?;
    let ws: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Invalid workspace file: {}", e))?;
    let folders = ws.get("folders")
        .and_then(|f| f.as_array())
        .ok_or("Workspace file missing 'folders' array")?;

    let state = app.state::<AtlsProjectState>();
    let mut roots = state.roots.lock().await;
    roots.clear();

    let mut first_root: Option<String> = None;
    for folder in folders {
        let path = folder.get("path")
            .and_then(|p| p.as_str())
            .ok_or("Each folder must have a 'path' string")?;
        let rf = open_root_folder(&app, path).await?;
        if first_root.is_none() {
            first_root = Some(rf.path.clone());
        }
        roots.push(rf);
    }

    if let Ok(mut ar) = state.active_root.write() {
        *ar = first_root.clone();
    }
    if let Ok(mut wf) = state.workspace_file.write() {
        *wf = Some(PathBuf::from(&file_path));
    }

    let root_paths: Vec<&str> = roots.iter().map(|r| r.path.as_str()).collect();
    Ok(serde_json::json!({
        "status": "opened",
        "roots": root_paths,
        "workspaceFile": file_path,
    }))
}

/// Get all sub-workspaces across all roots.
#[tauri::command]
pub async fn atls_get_workspaces(app: AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AtlsProjectState>();
    let roots = state.roots.lock().await;
    let all: Vec<&WorkspaceEntry> = roots.iter()
        .flat_map(|r| r.sub_workspaces.iter())
        .collect();
    Ok(serde_json::json!({ "workspaces": all }))
}

/// Get ATLS scan status from shared state (readable even during an active scan)
#[tauri::command]
pub async fn get_scan_status(app: AppHandle) -> Result<ScanStatus, String> {
    let state = app.state::<AtlsProjectState>();
    let status = state.scan_status.read()
        .map_err(|e| format!("Failed to read scan status: {}", e))?;
    Ok(ScanStatus {
        is_scanning: status.is_scanning,
        progress: status.progress,
        current_file: status.current_file.clone(),
        files_processed: status.files_processed,
        files_total: status.files_total,
    })
}

/// Get issue counts using efficient SQL COUNT GROUP BY
#[tauri::command]
pub async fn get_issue_counts(
    app: AppHandle,
    categories: Option<Vec<String>>,
    severities: Option<Vec<String>>,
) -> Result<IssueCounts, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _root_path) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        resolve_project(&roots, &ar, None)?
    };
    {
        let conn = project.query().db().conn();
        
        // Build SQL with optional filters
        let mut sql = String::from(
            "SELECT severity, COUNT(*) as cnt FROM code_issues WHERE suppressed = 0
               AND id IN (
                   SELECT MIN(id) FROM code_issues
                   WHERE suppressed = 0
                   GROUP BY file_id, line, type
               )"
        );
        let mut param_values: Vec<String> = Vec::new();
        
        if let Some(ref cats) = categories {
            if !cats.is_empty() {
                let placeholders: Vec<String> = cats.iter().enumerate()
                    .map(|(i, _)| format!("?{}", param_values.len() + i + 1))
                    .collect();
                sql.push_str(&format!(" AND category IN ({})", placeholders.join(",")));
                param_values.extend(cats.iter().cloned());
            }
        }
        if let Some(ref sevs) = severities {
            if !sevs.is_empty() {
                let placeholders: Vec<String> = sevs.iter().enumerate()
                    .map(|(i, _)| format!("?{}", param_values.len() + i + 1))
                    .collect();
                sql.push_str(&format!(" AND severity IN ({})", placeholders.join(",")));
                param_values.extend(sevs.iter().cloned());
            }
        }
        sql.push_str(" GROUP BY severity");
        
        let mut stmt = conn.prepare(&sql)
            .map_err(|e| format!("Failed to prepare count query: {}", e))?;
        
        let params_ref: Vec<&dyn rusqlite::types::ToSql> = param_values.iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();
        
        let rows = stmt.query_map(params_ref.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        }).map_err(|e| format!("Failed to count issues: {}", e))?;
        
        let mut high = 0u32;
        let mut medium = 0u32;
        let mut low = 0u32;
        
        for row in rows {
            let (sev, cnt) = row.map_err(|e| format!("Row error: {}", e))?;
            match sev.as_str() {
                "high" => high = cnt,
                "medium" => medium = cnt,
                "low" => low = cnt,
                _ => {}
            }
        }
        
        Ok(IssueCounts {
            high,
            medium,
            low,
            total: high + medium + low,
        })
    }
}

// ============================================================================
// Focus Profile Commands
// ============================================================================

/// Default focus profiles JSON with built-in templates
fn default_focus_profiles_json() -> serde_json::Value {
    serde_json::json!({
        "profiles": {
            "Full Scan": {
                "matrix": {
                    "performance": ["high", "medium", "low"],
                    "security": ["high", "medium", "low"],
                    "maintainability": ["high", "medium", "low"],
                    "style": ["high", "medium", "low"],
                    "correctness": ["high", "medium", "low"],
                    "code_quality": ["high", "medium", "low"],
                    "error_handling": ["high", "medium", "low"]
                }
            },
            "Security Audit": {
                "matrix": {
                    "security": ["high", "medium"],
                    "correctness": ["high", "medium"]
                }
            },
            "Performance Focus": {
                "matrix": {
                    "performance": ["high", "medium", "low"]
                }
            },
            "Code Quality": {
                "matrix": {
                    "maintainability": ["high", "medium"],
                    "style": ["high", "medium"],
                    "code_quality": ["high", "medium"]
                }
            }
        },
        "activeProfile": "Full Scan"
    })
}

/// Get the path to focus-profiles.json in the user's ATLS config dir
fn focus_profiles_path() -> PathBuf {
    // Use ~/.atls/focus-profiles.json (cross-platform home dir)
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".atls").join("focus-profiles.json")
}

/// Read focus profiles from disk (returns defaults if file doesn't exist)
#[tauri::command]
pub async fn get_focus_profiles() -> Result<serde_json::Value, String> {
    let path = focus_profiles_path();
    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read focus profiles: {}", e))?;
        let data: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse focus profiles: {}", e))?;
        Ok(data)
    } else {
        Ok(default_focus_profiles_json())
    }
}

/// Save focus profiles to disk
#[tauri::command]
pub async fn save_focus_profiles(data: serde_json::Value) -> Result<(), String> {
    let path = focus_profiles_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize focus profiles: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write focus profiles: {}", e))?;
    Ok(())
}

/// Find issues in project with pagination
#[tauri::command]
pub async fn find_issues(
    app: AppHandle,
    _root_path: String,
    category: Option<String>,
    severity: Option<String>,
    categories: Option<Vec<String>>,
    severities: Option<Vec<String>>,
    limit: Option<u32>,
    offset: Option<u32>,
    _include_snippets: Option<bool>,
    file_paths: Option<Vec<String>>,
    target_directory: Option<String>,
    issue_mode: Option<String>,
) -> Result<Vec<Issue>, String> {
    let state = app.state::<AtlsProjectState>();
    let (project, _root_path_resolved) = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        resolve_project(&roots, &ar, None)?
    };
    {
        use atls_core::{types::IssueSeverity, IssueFilterOptions};
        
        let mut filter = IssueFilterOptions::default();
        if let Some(cat) = category {
            filter.category = Some(cat);
        }
        if let Some(cats) = categories {
            if !cats.is_empty() {
                filter.categories = Some(cats);
            }
        }
        if let Some(sev_str) = severity {
            filter.severity = Some(match sev_str.as_str() {
                "high" => IssueSeverity::High,
                "medium" => IssueSeverity::Medium,
                "low" => IssueSeverity::Low,
                _ => IssueSeverity::Medium,
            });
        }
        if let Some(sevs) = severities {
            if !sevs.is_empty() {
                filter.severities = Some(sevs);
            }
        }
        filter.limit = limit;
        filter.offset = offset;

        // Apply file path filtering (directory-prefix matching)
        if let Some(ref dir) = target_directory {
            let normalized = dir.replace('\\', "/");
            let dir_prefix = if normalized.ends_with('/') { normalized } else { format!("{}/", normalized) };
            filter.file_patterns = Some(vec![format!("{}%", dir_prefix)]);
        } else if let Some(ref paths) = file_paths {
            let patterns: Vec<String> = paths.iter().map(|p| {
                let normalized = p.replace('\\', "/");
                if normalized.ends_with('/') {
                    format!("{}%", normalized)
                } else {
                    format!("%{}", normalized)
                }
            }).collect();
            filter.file_patterns = Some(patterns);
        }
        
        let mut issues = project.query().find_issues(&filter)
            .map_err(|e| format!("Failed to query issues: {}", e))?;
        let mode = issue_mode.as_deref().unwrap_or("correctness");
        if mode == "correctness" || mode == "security" {
            issues.retain(|i| !i.category.eq_ignore_ascii_case("style"));
        }

        // Preload file ID -> path mapping to avoid repeated DB locks
        let file_path_map: std::collections::HashMap<i64, String> = {
            let conn = project.query().db().conn();
            let mut stmt = conn.prepare("SELECT id, path FROM files")
                .map_err(|e| format!("Failed to prepare query: {}", e))?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            }).map_err(|e| format!("Failed to query files: {}", e))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        
        // Convert to Tauri Issue format
        let tauri_issues: Vec<Issue> = issues.into_iter().map(|i| {
            // Get file path from preloaded map and normalize separators
            let file_path = file_path_map.get(&i.file_id)
                .cloned()
                .unwrap_or_else(|| "unknown".to_string())
                .replace('\\', "/"); // Normalize to forward slashes
            
            Issue {
                id: i.id.to_string(),
                pattern_id: i.pattern_id.clone(),
                file: file_path,
                line: i.line,
                message: i.message,
                severity: format!("{:?}", i.severity).to_lowercase(),
                category: i.category,
            }
        }).collect();
        
        Ok(tauri_issues)
    }
}

/// Scan progress event payload
#[derive(Clone, Serialize)]
struct ScanProgressEvent {
    processed: usize,
    total: usize,
    current_file: Option<String>,
    progress: f64,
}

/// Trigger project scan
#[tauri::command]
pub async fn scan_project(
    app: AppHandle,
    root_path: String,
    full_rescan: bool,
    matrix: Option<HashMap<String, Vec<String>>>,
) -> Result<serde_json::Value, String> {
    println!("[SCAN] scan_project called for: {}", root_path);
    let state = app.state::<AtlsProjectState>();

    // Resolve project (auto-init if no roots open yet)
    let project = {
        let roots = state.roots.lock().await;
        if roots.is_empty() {
            drop(roots);
            println!("[SCAN] No roots — initializing project first...");
            atls_init(app.clone(), root_path.clone()).await?;
            let roots = state.roots.lock().await;
            let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
            resolve_project(&roots, &ar, Some(&root_path))?.0
        } else {
            let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
            resolve_project(&roots, &ar, Some(&root_path))?.0
        }
    };

    {
        let indexer = project.indexer().clone();
        println!("[SCAN] Acquiring indexer lock...");
        let mut indexer_guard = indexer.lock().await;
        
        // Mark scan as in-progress in shared state
        let scan_status_ref = Arc::clone(&state.scan_status);
        if let Ok(mut status) = scan_status_ref.write() {
            status.is_scanning = true;
            status.progress = 0;
            status.current_file = None;
            status.files_processed = 0;
            status.files_total = 0;
        }
        
        // Set up progress callback to emit Tauri events and update shared state
        let app_handle = app.clone();
        let scan_status_for_cb = Arc::clone(&state.scan_status);
        indexer_guard.set_progress_callback(Some(Box::new(move |progress| {
            let progress_pct = if progress.total > 0 {
                (progress.processed as f64 / progress.total as f64) * 100.0
            } else {
                0.0
            };
            
            let current_file_str = progress.current_file.as_ref().map(|p| p.to_string_lossy().to_string());
            
            // Update shared scan status (lock-free read from get_scan_status)
            if let Ok(mut status) = scan_status_for_cb.write() {
                status.is_scanning = true;
                status.progress = progress_pct as u32;
                status.current_file = current_file_str.clone();
                status.files_processed = progress.processed as u32;
                status.files_total = progress.total as u32;
            }
            
            let event = ScanProgressEvent {
                processed: progress.processed,
                total: progress.total,
                current_file: current_file_str,
                progress: progress_pct,
            };
            
            // Emit progress event (ignore errors as UI may not be listening)
            let _ = app_handle.emit("scan_progress", event);
        })));
        
        println!("[SCAN] Got indexer lock, starting scan...");
        // Build ScanFilter from optional focus-profile matrix
        let scan_filter = {
            use std::collections::HashSet;
            use atls_core::ScanFilter;
            let focus_matrix = matrix.as_ref().map(|m| {
                m.iter()
                    .map(|(cat, sevs)| (cat.clone(), sevs.iter().cloned().collect::<HashSet<String>>()))
                    .collect()
            });
            ScanFilter { matrix: focus_matrix }
        };
        let stats = indexer_guard.scan_filtered(full_rescan, &scan_filter).await
            .map_err(|e| format!("Failed to scan project: {}", e))?;
        
        // Clear progress callback and mark scan as complete
        indexer_guard.set_progress_callback(None);
        if let Ok(mut status) = scan_status_ref.write() {
            status.is_scanning = false;
            status.progress = 100;
            status.current_file = None;
        }
        
        println!("[SCAN] Scan complete: {} files", stats.files_scanned);
        
        Ok(serde_json::json!({
            "filesScanned": stats.files_scanned,
            "filesIndexed": stats.files_indexed,
            "errors": stats.errors,
        }))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_focus_profiles_has_expected_shape() {
        let v = super::default_focus_profiles_json();
        assert!(v.get("profiles").is_some());
        assert_eq!(
            v.get("activeProfile").and_then(|x| x.as_str()),
            Some("Full Scan")
        );
    }

    #[test]
    fn focus_profiles_path_ends_with_json() {
        let p = super::focus_profiles_path();
        assert_eq!(p.file_name().and_then(|n| n.to_str()), Some("focus-profiles.json"));
    }
}
