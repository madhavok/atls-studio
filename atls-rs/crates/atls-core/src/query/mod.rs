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
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
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

const AUTO_PENALTY_TTL_SECS: u64 = 60;
const VECTOR_INDEX_TTL_SECS: u64 = 120;

/// Main query engine for code search, symbol usage, file graphs, and issue queries
pub struct QueryEngine {
    db: Database,
    auto_penalty_cache: Mutex<Option<(Instant, HashMap<String, f64>)>>,
    vector_index_cache: Mutex<Option<(Instant, hybrid::VectorIndex)>>,
}

impl QueryEngine {
    /// Access the underlying rusqlite connection for query helpers.
    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.conn()
    }
    /// Create a new QueryEngine with a database connection
    pub fn new(db: Database) -> Self {
        Self {
            db,
            auto_penalty_cache: Mutex::new(None),
            vector_index_cache: Mutex::new(None),
        }
    }

    /// Get a reference to the underlying database
    pub fn db(&self) -> &Database {
        &self.db
    }

    /// Invalidate the cached auto-penalty map (call after reindexing).
    pub fn invalidate_penalty_cache(&self) {
        if let Ok(mut guard) = self.auto_penalty_cache.lock() {
            *guard = None;
        }
    }

    /// Invalidate the in-memory vector index (call after reindexing).
    pub fn invalidate_vector_index(&self) {
        if let Ok(mut guard) = self.vector_index_cache.lock() {
            *guard = None;
        }
    }

    /// Invalidate all search caches (convenience for post-reindex).
    pub fn invalidate_caches(&self) {
        self.invalidate_penalty_cache();
        self.invalidate_vector_index();
    }

    /// Return cached auto-penalties or recompute if stale / missing.
    pub(crate) fn get_auto_penalties(&self, conn: &rusqlite::Connection) -> HashMap<String, f64> {
        if let Ok(mut guard) = self.auto_penalty_cache.lock() {
            if let Some((ts, ref penalties)) = *guard {
                if ts.elapsed().as_secs() < AUTO_PENALTY_TTL_SECS {
                    return penalties.clone();
                }
            }
            let fresh = search::compute_auto_penalties(conn);
            *guard = Some((Instant::now(), fresh.clone()));
            fresh
        } else {
            search::compute_auto_penalties(conn)
        }
    }

    /// Search embeddings using an in-memory vector index when the corpus is large,
    /// falling back to brute-force scan for small tables.
    pub(crate) fn search_embedding_ids_cached(
        &self,
        conn: &rusqlite::Connection,
        query: &str,
        limit: usize,
        provider: &dyn hybrid::EmbeddingProvider,
    ) -> Result<Vec<i64>, QueryError> {
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM symbol_embeddings", [], |r| r.get(0))?;
        if n == 0 {
            return Ok(Vec::new());
        }

        let count = n as usize;
        if !hybrid::should_use_vector_index(count) {
            return search::search_embedding_ids_brute_force(conn, query, limit, provider);
        }

        let qv = provider.embed(query);
        if let Ok(mut guard) = self.vector_index_cache.lock() {
            let needs_rebuild = match &*guard {
                Some((ts, idx)) => ts.elapsed().as_secs() > VECTOR_INDEX_TTL_SECS
                    || idx.len() != count,
                None => true,
            };
            if needs_rebuild {
                let mut idx = hybrid::VectorIndex::new(provider.dim());
                idx.load_from_db(conn, provider.dim())?;
                let result = idx.search(&qv, limit);
                *guard = Some((Instant::now(), idx));
                return Ok(result);
            }
            if let Some((_, ref idx)) = *guard {
                return Ok(idx.search(&qv, limit));
            }
        }

        search::search_embedding_ids_brute_force(conn, query, limit, provider)
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
