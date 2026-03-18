pub mod fallback_extractor;
pub mod relations;
pub mod scanner;
pub mod symbols;
pub mod uhpp_extractor;

pub use scanner::{Indexer, ScanFilter, ScanProgress, ScanStats};
pub use relations::RelationTracker;
pub use uhpp_extractor::uhpp_extract_symbols;
pub use relations::extract_imports_regex;

use crate::types::ParsedSymbol;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum IndexerError {
    #[error("Database error: {0}")]
    Database(#[from] crate::db::DatabaseError),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Watcher error: {0}")]
    Watcher(#[from] crate::watcher::WatcherError),
    #[error("Filter error: {0}")]
    Filter(#[from] crate::watcher::FilterError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Parser error: {0}")]
    Parser(String),
    #[error("Path error: {0}")]
    Path(String),
}

/// Parse result from a file
#[derive(Debug, Clone)]
pub struct ParseResult {
    pub symbols: Vec<ParsedSymbol>,
    pub imports: Vec<ImportInfo>,
    pub calls: Vec<CallInfo>,
    pub issues: Vec<crate::types::ParsedIssue>,
}

/// Import information
#[derive(Debug, Clone)]
pub struct ImportInfo {
    pub module: String,
    pub symbols: Vec<String>,
    pub is_default: bool,
    /// Whether this import has `pub` visibility (Rust `pub use`)
    pub is_pub: bool,
    /// C/C++ only: true for `#include <...>` (system header), false for `#include "..."` (local)
    pub is_system: bool,
}

/// Call information
#[derive(Debug, Clone)]
pub struct CallInfo {
    pub name: String,
    pub line: u32,
    pub scope_name: Option<String>,
}
