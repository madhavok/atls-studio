use super::*;
use crate::path_utils::to_relative_path;
use notify::RecommendedWatcher;
use notify_debouncer_mini::{Debouncer, new_debouncer};
use notify::RecursiveMode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
    pub(crate) watching: Arc<AtomicBool>,
}

impl Default for FileWatcherState {
    fn default() -> Self {
        Self {
            watchers: tokio::sync::Mutex::new(HashMap::new()),
            watching: Arc::new(AtomicBool::new(false)),
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

    // Bridge: blocking recv in a dedicated thread, async processing in a tokio task.
    let (async_tx, mut async_rx) = tokio::sync::mpsc::channel::<Vec<std::path::PathBuf>>(64);
    let watching_flag = Arc::clone(&state.watching);
    let root_for_recv = root_path.clone();

    std::thread::spawn(move || {
        loop {
            if !watching_flag.load(Ordering::SeqCst) {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(events)) => {
                    let relevant: Vec<_> = events.into_iter()
                        .filter(|e| {
                            let path_str = e.path.to_string_lossy();
                            if path_str.ends_with(".atlsignore") {
                                return true;
                            }
                            !path_str.contains(".atls") &&
                            !path_str.contains("node_modules") &&
                            !path_str.contains(".git") &&
                            !path_str.contains("target") &&
                            !path_str.contains("__pycache__")
                        })
                        .map(|e| e.path)
                        .collect();
                    if !relevant.is_empty() {
                        if async_tx.blocking_send(relevant).is_err() {
                            break;
                        }
                    }
                }
                Ok(Err(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        eprintln!("[FileWatcher] Recv thread exiting for: {}", root_for_recv);
    });

    tokio::spawn(async move {
        while let Some(paths) = async_rx.recv().await {
            let changed_paths = collect_changed_paths(&root_path_clone, &paths);
            if !changed_paths.is_empty() {
                invalidate_freshness_for_paths(&app_clone, &root_path_clone, &changed_paths).await;
                let _ = app_clone.emit("file_tree_changed", serde_json::json!({
                    "root": root_path_clone,
                    "count": paths.len(),
                    "paths": changed_paths
                }));
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
