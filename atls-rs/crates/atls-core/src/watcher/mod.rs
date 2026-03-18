pub mod events;
pub mod filter;

pub use events::{Watcher, WatcherEvent, WatcherHandle};
pub use filter::{FileFilter, FilterError, SKIP_DIRS, is_skip_dir};

use thiserror::Error;

#[derive(Error, Debug)]
pub enum WatcherError {
    #[error("Notify error: {0}")]
    Notify(#[from] notify::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Path error: {0}")]
    Path(String),
}

/// File watcher configuration
#[derive(Debug, Clone)]
pub struct WatcherConfig {
    /// Debounce delay in milliseconds
    pub debounce_ms: u64,
    /// Whether to watch recursively
    pub recursive: bool,
}

impl Default for WatcherConfig {
    fn default() -> Self {
        Self {
            debounce_ms: 2000,
            recursive: true,
        }
    }
}
