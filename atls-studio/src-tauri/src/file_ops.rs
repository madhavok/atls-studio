use super::*;
use crate::path_utils::{
    detect_format, normalize_line_endings, read_file_with_format, serialize_with_format, to_relative_path,
};

fn path_modified_ns(metadata: &std::fs::Metadata) -> u128 {
    metadata.modified().ok()
        .and_then(|mtime| mtime.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn normalized_tree_change_paths(root: &str, paths: &[&str]) -> Vec<String> {
    let root_path = std::path::Path::new(root);
    let mut normalized: Vec<String> = paths
        .iter()
        .map(|path| to_relative_path(root_path, path).replace('\\', "/"))
        .filter(|path| !path.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

pub(crate) fn emit_file_tree_changed(app: &tauri::AppHandle, root: &str, paths: &[&str]) {
    let normalized_paths = normalized_tree_change_paths(root, paths);
    let _ = app.emit("file_tree_changed", serde_json::json!({
        "root": root,
        "count": normalized_paths.len(),
        "paths": normalized_paths,
    }));
}

async fn register_written_file(
    app: &tauri::AppHandle,
    source_path: &str,
    resolved_path: &std::path::Path,
    content: &str,
) -> Option<String> {
    let revision = content_hash(content);
    let hr_state = app.state::<crate::hash_resolver::HashRegistryState>();
    let mut registry = hr_state.registry.lock().await;
    let previous_revision = registry.get_current_revision(source_path);
    let lang = crate::hash_resolver::detect_lang(Some(source_path));
    registry.register(revision.clone(), crate::hash_resolver::HashEntry {
        source: Some(source_path.to_string()),
        content: content.to_string(),
        tokens: content.len() / 4,
        lang,
        line_count: content.lines().count(),
        symbol_count: None,
    });
    drop(registry);

    if let Ok(metadata) = std::fs::metadata(resolved_path) {
        let fc_state = app.state::<crate::hash_resolver::FileCacheState>();
        let mut cache = fc_state.cache.lock().await;
        cache.insert(
            source_path.to_string(),
            revision.clone(),
            path_modified_ns(&metadata),
            metadata.len(),
        );
    }

    let path_norm = source_path.replace('\\', "/");
    let _ = app.emit(
        "canonical_revision_changed",
        serde_json::json!({
            "path": path_norm,
            "revision": revision,
            "previous_revision": previous_revision
        }),
    );

    Some(path_norm)
}

async fn invalidate_path_state(app: &tauri::AppHandle, path: &str) {
    let hr_state = app.state::<crate::hash_resolver::HashRegistryState>();
    let mut registry = hr_state.registry.lock().await;
    registry.invalidate_source(path);
    drop(registry);

    let fc_state = app.state::<crate::hash_resolver::FileCacheState>();
    let mut cache = fc_state.cache.lock().await;
    cache.invalidate(path);
}

fn common_tree_change_root(paths: &[PathBuf]) -> Option<String> {
    let first = paths.first()?;
    let base = first.parent().unwrap_or(first.as_path());
    let mut ancestors = base.ancestors().map(|path| path.to_path_buf()).collect::<Vec<_>>();
    ancestors.retain(|ancestor| paths.iter().all(|path| path.starts_with(ancestor)));
    ancestors
        .into_iter()
        .next()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn emit_file_tree_changed_for_paths(app: &tauri::AppHandle, paths: &[PathBuf]) {
    let Some(root) = common_tree_change_root(paths) else { return; };
    let path_refs = paths
        .iter()
        .filter_map(|path| path.to_str())
        .collect::<Vec<_>>();
    if path_refs.is_empty() {
        return;
    }
    emit_file_tree_changed(app, &root, &path_refs);
}

#[tauri::command]
pub async fn get_file_tree(path: String) -> Result<Vec<FileNode>, String> {
    tokio::task::spawn_blocking(move || {
        let root_path = PathBuf::from(&path);
        
        if !root_path.exists() {
            return Err(format!("Path does not exist: {}", path));
        }
        
        let atlsignore = load_atlsignore(root_path.as_path());
        let has_atlsignore = atlsignore.is_some();
        
        fn build_tree(
            path: &PathBuf,
            depth: u32,
            root_path: &std::path::Path,
            atlsignore: &Option<ignore::gitignore::Gitignore>,
            has_atlsignore: bool,
        ) -> Option<FileNode> {
            if depth > 10 {
                return None;
            }
            
            let name = path.file_name()?.to_string_lossy().to_string();
            
            // .git is always hidden (not shown in tree at all)
            if name == ".git" {
                return None;
            }
            
            // .atlsignore is the single source of truth for the ignored icon.
            // gi.matched() handles negation (!) patterns natively.
            // For directories we also probe a dummy child because patterns like
            // **/node_modules/** match contents but not the dir itself.
            let atlsignore_matches = path.strip_prefix(root_path).ok()
                .zip(atlsignore.as_ref())
                .map(|(rel, gi)| {
                    if gi.matched(rel, path.is_dir()).is_ignore() {
                        return true;
                    }
                    if path.is_dir() {
                        return gi.matched(rel.join("__probe__"), false).is_ignore();
                    }
                    false
                })
                .unwrap_or(false);

            // Icon: when .atlsignore exists, only it drives the icon.
            // When no .atlsignore, fall back to the hardcoded list.
            let show_ignored_icon = if has_atlsignore {
                atlsignore_matches
            } else {
                should_ignore_path(&name)
            };
            // Traversal: skip recursing into heavy dirs for performance.
            // Uses both .atlsignore and hardcoded list so we never walk node_modules/.cursor even
            // if .atlsignore doesn't mention them.
            let dont_recurse = atlsignore_matches || should_ignore_path(&name);
            
            let node_type = if path.is_dir() { "directory" } else { "file" };
            let language = if path.is_file() {
                get_language_from_extension(path)
            } else {
                None
            };
            
            // For dirs: recurse only if not in hardcoded/atlsignore list (avoids lag from .cursor etc.)
            let children = if path.is_dir() && !dont_recurse {
                let mut children: Vec<FileNode> = std::fs::read_dir(path)
                    .ok()?
                    .filter_map(|entry| entry.ok())
                    .filter_map(|entry| build_tree(&entry.path(), depth + 1, root_path, atlsignore, has_atlsignore))
                    .collect();
                
                children.sort_by(|a, b| {
                    match (&a.node_type[..], &b.node_type[..]) {
                        ("directory", "file") => std::cmp::Ordering::Less,
                        ("file", "directory") => std::cmp::Ordering::Greater,
                        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                    }
                });
                
                Some(children)
            } else if path.is_dir() && dont_recurse {
                Some(vec![]) // Don't recurse into huge dirs; show with children: []
            } else {
                None
            };
            
            Some(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                node_type: node_type.to_string(),
                children,
                language,
                ignored: if show_ignored_icon { Some(true) } else { None },
            })
        }
        
        fn get_language_from_extension(path: &PathBuf) -> Option<String> {
            let ext = path.extension()?.to_string_lossy().to_lowercase();
            match ext.as_str() {
                // TypeScript
                "ts" | "tsx" | "mts" | "cts" => Some("typescript".to_string()),
                // JavaScript
                "js" | "jsx" | "mjs" | "cjs" => Some("javascript".to_string()),
                // Python
                "py" | "pyi" | "pyw" | "pyx" => Some("python".to_string()),
                // Rust
                "rs" => Some("rust".to_string()),
                // Go
                "go" => Some("go".to_string()),
                // Java
                "java" => Some("java".to_string()),
                // C#
                "cs" | "csx" => Some("csharp".to_string()),
                // C++
                "cpp" | "cc" | "cxx" | "c++" | "hpp" | "hxx" | "hh" | "h++" => Some("cpp".to_string()),
                // C
                "c" | "h" => Some("c".to_string()),
                // PHP
                "php" | "phtml" => Some("php".to_string()),
                // Ruby
                "rb" | "rake" | "gemspec" => Some("ruby".to_string()),
                // Swift
                "swift" => Some("swift".to_string()),
                // Kotlin
                "kt" | "kts" => Some("kotlin".to_string()),
                // Scala
                "scala" | "sc" => Some("scala".to_string()),
                // Dart
                "dart" => Some("dart".to_string()),
                // Other common formats
                "sql" => Some("sql".to_string()),
                "json" => Some("json".to_string()),
                "yaml" | "yml" => Some("yaml".to_string()),
                "toml" => Some("toml".to_string()),
                "md" => Some("markdown".to_string()),
                "html" | "htm" => Some("html".to_string()),
                "css" | "scss" | "sass" | "less" => Some("css".to_string()),
                "xml" => Some("xml".to_string()),
                "sh" | "bash" | "zsh" => Some("shell".to_string()),
                _ => None,
            }
        }
        
        // Build tree from root children (not including root itself)
        let mut children: Vec<FileNode> = std::fs::read_dir(&root_path)
            .map_err(|e| format!("Failed to read directory: {}", e))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| build_tree(&entry.path(), 0, root_path.as_path(), &atlsignore, has_atlsignore))
            .collect();
        
        // Sort root level: directories first, then alphabetically
        children.sort_by(|a, b| {
            match (&a.node_type[..], &b.node_type[..]) {
                ("directory", "file") => std::cmp::Ordering::Less,
                ("file", "directory") => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });
        
        Ok(children)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Read file contents (non-blocking)
/// Resolves relative paths using: explicit project_root > AtlsProjectState active root > raw path.
#[tauri::command]
pub async fn read_file_contents(
    path: String,
    project_root: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use crate::error::IoResultExt;

    let effective_root: Option<String> = if project_root.is_some() {
        project_root
    } else {
        let state = app.try_state::<crate::AtlsProjectState>();
        if let Some(s) = state {
            let roots = s.roots.lock().await;
            let ar = s.active_root.read().map(|a| a.clone()).unwrap_or(None);
            match crate::resolve_project(&roots, &ar, None) {
                Ok((project, _)) => Some(project.root_path().to_string_lossy().to_string()),
                Err(_) => None,
            }
        } else {
            None
        }
    };

    tokio::task::spawn_blocking(move || {
        let resolved_path = if let Some(ref root) = effective_root {
            let root_path = std::path::Path::new(root);
            let direct = resolve_project_path(root_path, &path);
            if direct.exists() {
                direct
            } else if let Some((found, _)) = crate::path_utils::resolve_source_file_with_fallback(root_path, &path) {
                found
            } else {
                direct
            }
        } else {
            PathBuf::from(&path)
        };
        if resolved_path.is_dir() {
            return Err(format!(
                "Path is a directory: {}. read_shaped/read expects file paths. Use h:@file=*.ts or list files first.",
                resolved_path.display()
            ));
        }
        std::fs::read_to_string(&resolved_path)
            .with_path(resolved_path.display().to_string())
            .map_err(|e| {
                let msg = e.to_user_message();
                if effective_root.is_some() && msg.contains("File not found:") {
                    format!(
                        "{} Path did not resolve under project_root. Add workspace or use absolute path if repo is outside project.",
                        msg
                    )
                } else {
                    msg
                }
            })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Expand a glob pattern against the filesystem, returning matching relative paths.
/// Used by the frontend to resolve h:@file=GLOB set refs against disk (not just chunk store).
#[tauri::command]
pub async fn expand_file_glob(project_root: String, pattern: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let root = std::path::Path::new(&project_root);
        if !root.is_dir() {
            return Err(format!("Project root not a directory: {}", project_root));
        }
        let glob = globset::Glob::new(&pattern)
            .map_err(|e| format!("Invalid glob '{}': {}", pattern, e))?;
        let matcher = glob.compile_matcher();
        let mut hits: Vec<(String, String, usize)> = Vec::new();
        glob_collect(root, root, &matcher, &mut hits, 0, None, true);
        let paths: Vec<String> = hits
            .into_iter()
            .map(|(dir, name, _)| {
                if dir.is_empty() { name } else { format!("{}/{}", dir, name) }
            })
            .collect();
        Ok(paths)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Write file contents (non-blocking)
/// Optionally resolves relative paths using project_root
/// Emits file_tree_changed when .atlsignore is written so Explorer stays in sync.
/// Emits canonical_revision_changed for any file write so derived shapes can invalidate.
#[tauri::command]
pub async fn write_file_contents(
    path: String,
    contents: String,
    project_root: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use crate::error::IoResultExt;
    let normalized = normalize_line_endings(&contents);
    let root_opt = project_root.clone();
    let path_for_emit = path.clone();
    let normalized_for_spawn = normalized.clone();
    tokio::task::spawn_blocking(move || {
        let resolved_path = if let Some(ref root) = project_root {
            resolve_project_path(std::path::Path::new(root), &path)
        } else {
            PathBuf::from(&path)
        };
        let bytes: Vec<u8> = if resolved_path.exists() {
            read_file_with_format(&resolved_path)
                .map(|(_, fmt)| serialize_with_format(&normalized_for_spawn, &fmt))
                .unwrap_or_else(|_| {
                    let fmt = detect_format(normalized_for_spawn.as_bytes());
                    serialize_with_format(&normalized_for_spawn, &fmt)
                })
        } else {
            let fmt = detect_format(normalized_for_spawn.as_bytes());
            serialize_with_format(&normalized_for_spawn, &fmt)
        };
        std::fs::write(&resolved_path, bytes)
            .with_path(resolved_path.display().to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_user_message())?;

    let resolved_path = if let Some(ref root) = root_opt {
        resolve_project_path(std::path::Path::new(root), &path_for_emit)
    } else {
        PathBuf::from(&path_for_emit)
    };
    register_written_file(&app, &path_for_emit, &resolved_path, &normalized).await;

    // When .atlsignore is written, refresh file tree and scan filter so both UI and scan respect changes
    let is_atlsignore = path_for_emit.ends_with(".atlsignore") || path_for_emit.replace('\\', "/").ends_with(".atls/.atlsignore");
    if is_atlsignore {
        if let Some(ref root) = root_opt {
            emit_file_tree_changed(&app, root, &[&path_for_emit]);
            reload_scan_filter(&app, root).await;
        }
    }
    Ok(())
}

/// Write design doc to .atls/design/design-{timestamp}.md
/// Creates .atls/design if needed. Returns the relative path written.
#[tauri::command]
pub async fn write_design_file(project_root: String, contents: String) -> Result<String, String> {
    use crate::error::IoResultExt;
    tokio::task::spawn_blocking(move || -> Result<String, crate::error::AtlsError> {
        let root = std::path::Path::new(&project_root);
        let design_dir = root.join(".atls").join("design");
        std::fs::create_dir_all(&design_dir)
            .with_path(design_dir.display().to_string())?;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| crate::error::AtlsError::ValidationError {
                field: "timestamp".into(),
                message: format!("System time error: {}", e),
            })?;
        let filename = format!("design-{}.md", timestamp.as_secs());
        let file_path = design_dir.join(&filename);
        std::fs::write(&file_path, contents)
            .with_path(file_path.display().to_string())?;
        Ok(format!(".atls/design/{}", filename))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_user_message())
}

/// Delete a file or directory (non-blocking)
#[tauri::command]
pub async fn delete_path(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use crate::error::{AtlsError, IoResultExt};
    let path_for_emit = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AtlsError> {
        let path_buf = PathBuf::from(&path);
        if !path_buf.exists() {
            return Err(AtlsError::file_not_found(&path));
        }
        if path_buf.is_dir() {
            std::fs::remove_dir_all(&path).with_path(&path)
        } else {
            std::fs::remove_file(&path).with_path(&path)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_user_message())?;
    invalidate_path_state(&app, &path_for_emit).await;
    emit_file_tree_changed_for_paths(&app, &[PathBuf::from(path_for_emit)]);
    Ok(())
}

/// Rename a file or folder. If dest_dir is provided, moves it there with the new name.
#[tauri::command]
pub async fn rename_path(old_path: String, new_name: String, dest_dir: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
    use crate::error::{AtlsError, IoResultExt};
    let old_path_for_emit = old_path.clone();
    let new_path = tokio::task::spawn_blocking(move || -> Result<PathBuf, AtlsError> {
        let old = PathBuf::from(&old_path);
        if !old.exists() {
            return Err(AtlsError::file_not_found(&old_path));
        }
        let parent = if let Some(ref dir) = dest_dir {
            PathBuf::from(dir)
        } else {
            old.parent()
                .ok_or_else(|| AtlsError::ValidationError {
                    field: "old_path".into(),
                    message: "cannot determine parent directory".into(),
                })?
                .to_path_buf()
        };
        let new_path = parent.join(&new_name);
        std::fs::rename(&old, &new_path)
            .with_path(format!("{} -> {}", old_path, new_path.display()))?;
        Ok(new_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_user_message())?;
    invalidate_path_state(&app, &old_path_for_emit).await;
    if let Some(new_path_str) = new_path.to_str() {
        invalidate_path_state(&app, new_path_str).await;
    }
    emit_file_tree_changed_for_paths(&app, &[PathBuf::from(old_path_for_emit), new_path]);
    Ok(())
}

/// Create an empty file at the given path.
#[tauri::command]
pub async fn create_file(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use crate::error::{AtlsError, IoResultExt};
    let path_for_emit = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AtlsError> {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Err(AtlsError::IoError {
                path: path.clone(),
                source: std::io::Error::new(std::io::ErrorKind::AlreadyExists, "path already exists"),
            });
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).with_path(parent.display().to_string())?;
        }
        std::fs::File::create(&p).with_path(&path)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_user_message())?;
    invalidate_path_state(&app, &path_for_emit).await;
    emit_file_tree_changed_for_paths(&app, &[PathBuf::from(path_for_emit)]);
    Ok(())
}

/// Create project directory (and parents). Idempotent: no error if exists.
#[tauri::command]
pub async fn create_project_directory(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create project directory: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Create a directory (and parents) at the given path.
#[tauri::command]
pub async fn create_folder(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use crate::error::{AtlsError, IoResultExt};
    let path_for_emit = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AtlsError> {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Err(AtlsError::IoError {
                path: path.clone(),
                source: std::io::Error::new(std::io::ErrorKind::AlreadyExists, "path already exists"),
            });
        }
        std::fs::create_dir_all(&p).with_path(&path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_user_message())?;
    emit_file_tree_changed_for_paths(&app, &[PathBuf::from(path_for_emit)]);
    Ok(())
}

/// Reload the scan filter for a root so the next scan respects .atlsignore changes.
/// Best-effort: if the project isn't initialized yet we silently skip.
async fn reload_scan_filter(app: &tauri::AppHandle, root_path: &str) {
    let state = app.state::<AtlsProjectState>();
    let roots = state.roots.lock().await;
    let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
    if let Ok((project, _)) = resolve_project(&roots, &ar, Some(root_path)) {
        let indexer = project.indexer().clone();
        if let Ok(guard) = indexer.try_lock() {
            let _ = guard.reload_ignore_filter().await;
        };
    }
}

/// Add a file or folder pattern to .atls/.atlsignore. Creates the file if missing.
/// Patterns use gitignore syntax; directories get trailing `/**`.
#[tauri::command]
pub async fn add_to_atlsignore(
    path: String,
    root_path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_clone = app.clone();
    let root_for_reload = root_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path_buf = std::path::PathBuf::from(&path);
        let root_buf = std::path::PathBuf::from(&root_path);
        let root = root_buf
            .canonicalize()
            .map_err(|e| format!("Failed to resolve root: {}", e))?;
        let path_abs = path_buf
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {}", e))?;
        let rel = path_abs
            .strip_prefix(&root)
            .map_err(|_| "Path is not under project root".to_string())?;
        let pattern = if path_abs.is_dir() {
            format!("{}/**", rel.to_string_lossy().replace('\\', "/"))
        } else {
            rel.to_string_lossy().replace('\\', "/")
        };
        let atls_dir = root.join(".atls");
        std::fs::create_dir_all(&atls_dir)
            .map_err(|e| format!("Failed to create .atls: {}", e))?;
        let ignore_path = atls_dir.join(".atlsignore");
        let mut content = std::fs::read_to_string(&ignore_path).unwrap_or_default();
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&pattern);
        content.push('\n');
        std::fs::write(&ignore_path, content).map_err(|e| format!("Failed to write .atlsignore: {}", e))?;
        let ignore_emit_path = ignore_path.to_string_lossy().replace('\\', "/");
        emit_file_tree_changed(&app_clone, &root_path, &[&ignore_emit_path]);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    reload_scan_filter(&app, &root_for_reload).await;
    Ok(())
}

/// Remove a file or folder from ignore by removing matching patterns from .atls/.atlsignore.
#[tauri::command]
pub async fn remove_from_atlsignore(
    path: String,
    root_path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_clone = app.clone();
    let root_for_reload = root_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path_buf = std::path::PathBuf::from(&path);
        let root_buf = std::path::PathBuf::from(&root_path);
        let root = root_buf
            .canonicalize()
            .map_err(|e| format!("Failed to resolve root: {}", e))?;
        let path_abs = path_buf
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {}", e))?;
        let rel = path_abs
            .strip_prefix(&root)
            .map_err(|_| "Path is not under project root".to_string())?;
        let rel_normalized = rel.to_string_lossy().replace('\\', "/");
        let patterns_to_remove: Vec<String> = if path_abs.is_dir() {
            vec![
                rel_normalized.clone(),
                format!("{}/", rel_normalized),
                format!("{}/**", rel_normalized),
                format!("**/{}", rel_normalized),
                format!("**/{}/", rel_normalized),
                format!("**/{}/**", rel_normalized),
                format!("!{}/", rel_normalized),
                format!("!{}", rel_normalized),
            ]
        } else {
            vec![
                rel_normalized.clone(),
                format!("**/{}", rel_normalized),
                format!("!{}", rel_normalized),
            ]
        };
        let ignore_path = root.join(".atls").join(".atlsignore");
        let content = std::fs::read_to_string(&ignore_path)
            .map_err(|e| format!("Failed to read .atlsignore: {}", e))?;
        let new_lines: Vec<&str> = content
            .lines()
            .filter(|line| {
                let t = line.trim();
                if t.is_empty() || t.starts_with('#') {
                    return true;
                }
                !patterns_to_remove.iter().any(|p| t == p)
            })
            .collect();
        let new_content = new_lines.join("\n");
        let new_content = if !new_content.is_empty() && !new_content.ends_with('\n') {
            format!("{}\n", new_content)
        } else {
            new_content
        };
        std::fs::write(&ignore_path, new_content)
            .map_err(|e| format!("Failed to write .atlsignore: {}", e))?;
        let ignore_emit_path = ignore_path.to_string_lossy().replace('\\', "/");
        emit_file_tree_changed(&app_clone, &root_path, &[&ignore_emit_path]);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    reload_scan_filter(&app, &root_for_reload).await;
    Ok(())
}

/// Copy a file or folder to a destination directory.
#[tauri::command]
pub async fn copy_path(src: String, dest_dir: String) -> Result<(), String> {
    use crate::error::{AtlsError, IoResultExt};
    tokio::task::spawn_blocking(move || -> Result<(), AtlsError> {
        let src_path = PathBuf::from(&src);
        if !src_path.exists() {
            return Err(AtlsError::file_not_found(&src));
        }
        let name = src_path.file_name()
            .ok_or_else(|| AtlsError::ValidationError {
                field: "src".into(),
                message: "cannot determine file name".into(),
            })?;
        let dest = PathBuf::from(&dest_dir).join(name);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest)
        } else {
            std::fs::copy(&src_path, &dest)
                .map(|_| ())
                .with_path(format!("{} -> {}", src, dest.display()))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_user_message())
}

#[cfg(test)]
mod tests {
    use super::{common_tree_change_root, normalized_tree_change_paths};
    use std::path::PathBuf;

    #[test]
    fn normalizes_tree_change_paths_relative_to_root() {
        let root = if cfg!(windows) { "C:/repo" } else { "/repo" };
        let path = if cfg!(windows) {
            r"C:\repo\.atls\.atlsignore"
        } else {
            "/repo/.atls/.atlsignore"
        };

        let normalized = normalized_tree_change_paths(root, &[path]);

        assert_eq!(normalized, vec![".atls/.atlsignore".to_string()]);
    }

    #[test]
    fn computes_common_tree_root_for_multiple_paths() {
        let first = if cfg!(windows) {
            PathBuf::from(r"C:\repo\src\old.ts")
        } else {
            PathBuf::from("/repo/src/old.ts")
        };
        let second = if cfg!(windows) {
            PathBuf::from(r"C:\repo\src\new.ts")
        } else {
            PathBuf::from("/repo/src/new.ts")
        };

        let root = common_tree_change_root(&[first, second]);

        assert_eq!(root.as_deref(), Some(if cfg!(windows) { "C:/repo/src" } else { "/repo/src" }));
    }
}

fn copy_dir_recursive(src: &PathBuf, dest: &PathBuf) -> Result<(), error::AtlsError> {
    use crate::error::IoResultExt;
    std::fs::create_dir_all(dest).with_path(dest.display().to_string())?;
    for entry in std::fs::read_dir(src).with_path(src.display().to_string())? {
        let entry = entry.map_err(|e| error::AtlsError::io_error(src.display().to_string(), e))?;
        let src_child = entry.path();
        let dest_child = dest.join(entry.file_name());
        if src_child.is_dir() {
            copy_dir_recursive(&src_child, &dest_child)?;
        } else {
            std::fs::copy(&src_child, &dest_child)
                .with_path(format!("{} -> {}", src_child.display(), dest_child.display()))?;
        }
    }
    Ok(())
}

/// Read a file and return its contents as base64 with the detected media type.
#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("File does not exist: {}", path));
        }
        let ext = p.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let media_type = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            _ => "application/octet-stream",
        };
        let mut file = std::fs::File::open(&p)
            .map_err(|e| format!("Failed to open file: {}", e))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read file: {}", e))?;

        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf);
        Ok(serde_json::json!({
            "data": encoded,
            "media_type": media_type,
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

