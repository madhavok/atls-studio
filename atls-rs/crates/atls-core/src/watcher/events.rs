use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc as tokio_mpsc;
use tracing::{debug, error, warn};

fn normalize_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let path_str = path.to_string_lossy();
        if let Some(stripped) = path_str.strip_prefix("\\\\?\\") {
            PathBuf::from(stripped)
        } else {
            path.to_path_buf()
        }
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

use super::WatcherError;

/// File system event types
#[derive(Debug, Clone)]
pub enum WatcherEvent {
    /// File was created
    Create(PathBuf),
    /// File was modified
    Modify(PathBuf),
    /// File was deleted
    Delete(PathBuf),
    /// Config file changed (e.g., .atls/config.json)
    ConfigChange(PathBuf),
    /// Ignore patterns changed (e.g., .atlsignore)
    IgnoreChange(PathBuf),
}

/// Handle to control a file watcher
pub struct WatcherHandle {
    stop_tx: tokio_mpsc::Sender<()>,
    event_rx: tokio_mpsc::Receiver<WatcherEvent>,
}

impl WatcherHandle {
    /// Get the next event (async)
    pub async fn next_event(&mut self) -> Option<WatcherEvent> {
        self.event_rx.recv().await
    }

    /// Stop the watcher
    pub async fn stop(self) {
        let _ = self.stop_tx.send(()).await;
    }
}

/// Event-driven file watcher with debouncing
pub struct Watcher {
    root_path: PathBuf,
    debounce_ms: u64,
    event_tx: tokio_mpsc::Sender<WatcherEvent>,
    stop_rx: tokio_mpsc::Receiver<()>,
}

impl Watcher {
    /// Create a new watcher for the given root path
    pub fn new<P: AsRef<Path>>(root_path: P, debounce_ms: u64) -> Result<(Self, WatcherHandle), WatcherError> {
        let root_path = root_path
            .as_ref()
            .canonicalize()
            .map_err(|e| WatcherError::Path(format!("Failed to canonicalize path: {}", e)))?;
        
        let (event_tx, event_rx) = tokio_mpsc::channel(1000);
        let (stop_tx, stop_rx) = tokio_mpsc::channel(1);
        
        let handle = WatcherHandle {
            stop_tx,
            event_rx,
        };
        
        Ok((
            Self {
                root_path,
                debounce_ms,
                event_tx,
                stop_rx,
            },
            handle,
        ))
    }

    /// Start watching for file changes
    pub async fn watch(mut self) -> Result<(), WatcherError> {
        // Use tokio mpsc channel for async compatibility
        let (tx, mut async_rx) = tokio::sync::mpsc::unbounded_channel::<Event>();
        
        // Create notify watcher
        let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => {
                    if let Err(e) = tx.send(event) {
                        error!("Failed to send watcher event: {}", e);
                    }
                }
                Err(e) => {
                    error!("Watcher error: {}", e);
                }
            }
        })?;

        // Start watching the root path
        watcher.watch(&self.root_path, RecursiveMode::Recursive)?;
        debug!("Started watching: {:?}", self.root_path);

        // Debounce state
        let mut pending_events: std::collections::HashMap<PathBuf, WatcherEvent> = std::collections::HashMap::new();
        let mut debounce_timer: Option<tokio::time::Sleep> = None;
        let debounce_duration = Duration::from_millis(self.debounce_ms);

        loop {
            tokio::select! {
                // Check for stop signal
                _ = self.stop_rx.recv() => {
                    debug!("Watcher stopped");
                    // Emit any pending events before stopping
                    if !pending_events.is_empty() {
                        let _ = self.emit_pending_events(&mut pending_events).await;
                    }
                    break;
                }
                
                // Process notify events via async channel
                Some(event) = async_rx.recv() => {
                    self.process_notify_event(event, &mut pending_events, &mut debounce_timer, debounce_duration).await?;
                }
                
                // Debounce timeout - emit pending events
                _ = async {
                    if let Some(timer) = debounce_timer.as_ref() {
                        tokio::time::sleep_until(timer.deadline()).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                }, if debounce_timer.is_some() => {
                    debounce_timer = None;
                    self.emit_pending_events(&mut pending_events).await?;
                }
            }
        }

        Ok(())
    }

    async fn process_notify_event(
        &self,
        event: Event,
        pending_events: &mut std::collections::HashMap<PathBuf, WatcherEvent>,
        debounce_timer: &mut Option<tokio::time::Sleep>,
        debounce_duration: Duration,
    ) -> Result<(), WatcherError> {
        let root_norm = normalize_path(&self.root_path);
        for path in event.paths {

            let path = normalize_path(&path);
            // Skip if path is not under root
            if !path.starts_with(&root_norm) {
                continue;
            }

            // Determine event type
            let watcher_event = match event.kind {
                EventKind::Create(_) => WatcherEvent::Create(path.clone()),
                EventKind::Modify(notify::event::ModifyKind::Name(_)) => WatcherEvent::Create(path.clone()),
                EventKind::Modify(_) => {
                    // Check if it's a config or ignore file
                    let path_str = path.to_string_lossy();
                    if path_str.contains(".atls/config.json") || path_str.contains(".atls/config") {
                        WatcherEvent::ConfigChange(path.clone())
                    } else if path_str.ends_with(".atlsignore") {
                        WatcherEvent::IgnoreChange(path.clone())
                    } else {
                        WatcherEvent::Modify(path.clone())
                    }
                }
                EventKind::Remove(_) => WatcherEvent::Delete(path.clone()),
                EventKind::Other => continue, // Ignore other event types
                _ => continue,
            };

            // Update pending events while preserving Create over same-path Modify
            match pending_events.get(&path) {
                Some(WatcherEvent::Create(_)) if matches!(watcher_event, WatcherEvent::Modify(_)) => {}
                _ => {
                    pending_events.insert(path, watcher_event);
                }
            }

            // Reset debounce timer
            *debounce_timer = Some(tokio::time::sleep(debounce_duration));
        }
        Ok(())
    }

    async fn emit_pending_events(
        &self,
        pending_events: &mut std::collections::HashMap<PathBuf, WatcherEvent>,
    ) -> Result<(), WatcherError> {
        for (_, event) in pending_events.drain() {
            if let Err(e) = self.event_tx.send(event).await {
                warn!("Failed to send watcher event: {}", e);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::fs;

    #[tokio::test]
    async fn test_watcher_create_event() {
        let temp_dir = TempDir::new().unwrap();
        let test_file = temp_dir.path().join("test.txt");

        let (watcher, mut handle) = Watcher::new(temp_dir.path(), 100).unwrap();

        let watcher_handle = tokio::spawn(async move { watcher.watch().await });

        // RecommendedWatcher needs time to attach; Windows is slower than Unix.
        tokio::time::sleep(Duration::from_millis(300)).await;

        fs::write(&test_file, "test").unwrap();

        // Debounce (100ms) + filesystem latency (especially on Windows).
        tokio::time::sleep(Duration::from_millis(600)).await;

        let event = tokio::time::timeout(Duration::from_secs(10), handle.next_event())
            .await
            .expect("Timed out waiting for watcher event")
            .expect("No event received");

        let got_path = match event {
            WatcherEvent::Create(p) | WatcherEvent::Modify(p) => p,
            other => panic!("Expected Create or Modify event, got {:?}", other),
        };
        let expected_path = normalize_path(&fs::canonicalize(&test_file).unwrap());
        assert_eq!(got_path, expected_path);
        handle.stop().await;
        let _ = watcher_handle.await;
    }
}
