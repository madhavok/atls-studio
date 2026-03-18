use super::*;
use crate::path_utils::to_relative_path;
use notify::RecommendedWatcher;
use notify_debouncer_mini::{Debouncer, new_debouncer};
use notify::RecursiveMode;
use std::sync::atomic::{AtomicBool, Ordering};

fn normalize_changed_path(root_path: &str, changed_path: &std::path::Path) -> String {
    to_relative_path(std::path::Path::new(root_path), &changed_path.to_string_lossy()).replace('\\', "/")
}

fn collect_changed_paths(root_path: &str, paths: &[std::path::PathBuf]) -> Vec<String> {
    let mut changed_paths: Vec<String> = paths
        .iter()
        .map(|path| normalize_changed_path(root_path, path))
        .filter(|path| !path.is_empty())
        .collect();
    changed_paths.sort();
    changed_paths.dedup();
    changed_paths
}

async fn invalidate_freshness_for_paths(app: &AppHandle, root_path: &str, changed_paths: &[String]) {
    if changed_paths.is_empty() {
        return;
    }

    let hr_state = app.state::<crate::hash_resolver::HashRegistryState>();
    let mut registry = hr_state.registry.lock().await;
    for path in changed_paths {
        registry.invalidate_source(path);
    }
    drop(registry);

    let fc_state = app.state::<crate::hash_resolver::FileCacheState>();
    let mut cache = fc_state.cache.lock().await;
    for path in changed_paths {
        cache.invalidate(path);
    }
    drop(cache);

    let snapshot_state = app.state::<crate::snapshot::SnapshotServiceState>();
    let mut snapshot_svc = snapshot_state.service.lock().await;
    for path in changed_paths {
        let resolved = std::path::Path::new(root_path).join(path);
        snapshot_svc.invalidate(&resolved);
    }
}

pub(crate) struct FileWatcherState {
    pub(crate) watchers: tokio::sync::Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>,
    pub(crate) watching: AtomicBool,
}

impl Default for FileWatcherState {
    fn default() -> Self {
        Self {
            watchers: tokio::sync::Mutex::new(HashMap::new()),
            watching: AtomicBool::new(false),
        }
    }
}

/// Start watching a directory for file changes (supports multiple roots).
#[tauri::command]
pub async fn start_file_watcher(
    app: AppHandle,
    root_path: String,
) -> Result<(), String> {
    let state = app.state::<FileWatcherState>();

    // If already watching this root, skip
    {
        let lock = state.watchers.lock().await;
        if lock.contains_key(&root_path) {
            return Ok(());
        }
    }

    let app_clone = app.clone();
    let root = PathBuf::from(&root_path);
    let root_path_clone = root_path.clone();

    let (tx, rx) = std::sync::mpsc::channel();

    let mut debouncer = new_debouncer(Duration::from_millis(500), tx)
        .map_err(|e| format!("Failed to create file watcher: {}", e))?;

    debouncer.watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    {
        let mut lock = state.watchers.lock().await;
        lock.insert(root_path.clone(), debouncer);
        state.watching.store(true, Ordering::SeqCst);
    }

    tokio::spawn(async move {
        loop {
            let state = app_clone.try_state::<FileWatcherState>();
            if let Some(state) = state {
                if !state.watching.load(Ordering::SeqCst) {
                    break;
                }
                // Check if this specific root was removed
                if let Ok(lock) = state.watchers.try_lock() {
                    if !lock.contains_key(&root_path_clone) {
                        break;
                    }
                }
            } else {
                break;
            }

            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(events)) => {
                    let relevant_events: Vec<_> = events.iter()
                        .filter(|e| {
                            let path_str = e.path.to_string_lossy();
                            // Allow .atlsignore changes through so the tree refreshes
                            if path_str.ends_with(".atlsignore") {
                                return true;
                            }
                            !path_str.contains(".atls") &&
                            !path_str.contains("node_modules") &&
                            !path_str.contains(".git") &&
                            !path_str.contains("target") &&
                            !path_str.contains("__pycache__")
                        })
                        .collect();

                    if !relevant_events.is_empty() {
                        let changed_paths_input = relevant_events
                            .iter()
                            .map(|event| event.path.clone())
                            .collect::<Vec<_>>();
                        let changed_paths = collect_changed_paths(&root_path_clone, &changed_paths_input);
                        invalidate_freshness_for_paths(&app_clone, &root_path_clone, &changed_paths).await;
                        let _ = app_clone.emit("file_tree_changed", serde_json::json!({
                            "root": root_path_clone,
                            "count": relevant_events.len(),
                            "paths": changed_paths
                        }));
                    }
                }
                Ok(Err(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    eprintln!("[FileWatcher] Started watching: {}", root_path);
    Ok(())
}

/// Stop file watcher(s). If root_path given, stop only that root; otherwise stop all.
#[tauri::command]
pub async fn stop_file_watcher(app: AppHandle, root_path: Option<String>) -> Result<(), String> {
    let state = app.state::<FileWatcherState>();

    let mut lock = state.watchers.lock().await;
    if let Some(rp) = root_path {
        if lock.remove(&rp).is_some() {
            eprintln!("[FileWatcher] Stopped watching: {}", rp);
        }
    } else {
        lock.clear();
        state.watching.store(false, Ordering::SeqCst);
        eprintln!("[FileWatcher] Stopped all watchers");
    }

    Ok(())
}

// ============================================================================
// ATLS Bridge Commands
// ============================================================================

#[cfg(test)]
mod tests {
    use super::{collect_changed_paths, normalize_changed_path};
    use std::path::PathBuf;

    #[test]
    fn normalizes_watcher_paths_relative_to_root() {
        let root = if cfg!(windows) { "C:/repo" } else { "/repo" };
        let changed = if cfg!(windows) {
            PathBuf::from(r"C:\repo\src\main.ts")
        } else {
            PathBuf::from("/repo/src/main.ts")
        };

        let normalized = normalize_changed_path(root, &changed);

        assert_eq!(normalized, "src/main.ts");
    }

    #[test]
    fn collects_sorted_unique_changed_paths() {
        let root = if cfg!(windows) { "C:/repo" } else { "/repo" };
        let first = if cfg!(windows) { r"C:\repo\src\b.ts" } else { "/repo/src/b.ts" };
        let second = if cfg!(windows) { r"C:\repo\src\a.ts" } else { "/repo/src/a.ts" };
        let events = vec![PathBuf::from(first), PathBuf::from(second), PathBuf::from(first)];

        let changed = collect_changed_paths(root, &events);

        assert_eq!(changed, vec!["src/a.ts".to_string(), "src/b.ts".to_string()]);
    }
}
