pub mod symbols;
pub mod files;
pub mod search;
pub mod structured;
pub mod grammar;
pub mod hybrid;
pub mod llm_query;
pub mod feedback;
pub mod issues;
pub mod context;
pub mod graph;

pub use files::parse_imports_from_content;
pub use structured::{parse_structured_query, StructuredFilters};
pub use issues::{CategoryStat, IssueFilterOptions, NoiseMarking};
pub use symbols::SymbolLineRange;

use crate::db::Database;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum QueryError {
    #[error("Database error: {0}")]
    Database(#[from] crate::db::DatabaseError),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Invalid query: {0}")]
    InvalidQuery(String),
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Symbol not found: {0}")]
    SymbolNotFound(String),
}

/// Main query engine for code search, symbol usage, file graphs, and issue queries
pub struct QueryEngine {
    db: Database,
}

impl QueryEngine {
    /// Access the underlying rusqlite connection for query helpers.
    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.conn()
    }
    /// Create a new QueryEngine with a database connection
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Get a reference to the underlying database
    pub fn db(&self) -> &Database {
        &self.db
    }
}

#[cfg(test)]
mod tests {
    use super::QueryEngine;
    use crate::db::Database;

    #[test]
    fn query_engine_new_uses_database() {
        let db = Database::open_in_memory().expect("in-memory db");
        let q = QueryEngine::new(db);
        let n: i64 = q
            .conn()
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'", [], |r| r.get(0))
            .expect("sqlite");
        assert!(n > 0);
    }
}
