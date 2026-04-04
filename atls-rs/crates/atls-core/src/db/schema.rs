use rusqlite::Connection;
use thiserror::Error;

// Database configuration constants
const DB_BUSY_TIMEOUT_MS: u32 = 5000; // Wait up to 5 seconds if database is locked
const DB_WAL_AUTOCHECKPOINT_PAGES: u32 = 1000; // Auto-checkpoint WAL every 1000 pages

#[derive(Error, Debug)]
pub enum SchemaError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Database schema utilities
/// Handles table creation and configuration
pub struct DatabaseSchema<'a> {
    conn: &'a Connection,
}

impl<'a> DatabaseSchema<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Configure database pragmas
    pub fn configure(&self) -> Result<(), SchemaError> {
        self.conn.pragma_update(None, "journal_mode", "WAL")?;
        self.conn.pragma_update(None, "synchronous", "NORMAL")?;
        self.conn.pragma_update(None, "busy_timeout", DB_BUSY_TIMEOUT_MS)?;
        self.conn.pragma_update(None, "wal_autocheckpoint", DB_WAL_AUTOCHECKPOINT_PAGES)?;
        self.conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    }

    /// Create all tables from scratch
    pub fn create_tables(&self) -> Result<(), SchemaError> {
        // Drop any partial/old tables first
        self.conn.execute_batch(
            r#"
            DROP TABLE IF EXISTS symbols_fts;
            DROP TABLE IF EXISTS symbols_trigram;
            DROP TABLE IF EXISTS file_importance;
            DROP TABLE IF EXISTS symbol_relations;
            DROP TABLE IF EXISTS file_relations;
            DROP TABLE IF EXISTS calls;
            DROP TABLE IF EXISTS code_signatures;
            DROP TABLE IF EXISTS symbols;
            DROP TABLE IF EXISTS code_issues;
            DROP TABLE IF EXISTS files;
            "#,
        )?;

        self.configure()?;

        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                hash TEXT NOT NULL,
                language TEXT NOT NULL,
                last_indexed DATETIME DEFAULT CURRENT_TIMESTAMP,
                line_count INTEGER DEFAULT NULL
            );

            CREATE TABLE IF NOT EXISTS symbols (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                line INTEGER NOT NULL,
                end_line INTEGER,
                scope_id INTEGER,
                rank REAL DEFAULT 0.0,
                signature TEXT,
                complexity INTEGER DEFAULT 0,
                metadata TEXT,
                body_preview TEXT DEFAULT '',
                FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS code_issues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                severity TEXT NOT NULL,
                message TEXT NOT NULL,
                line INTEGER NOT NULL,
                col INTEGER DEFAULT 0,
                category TEXT NOT NULL DEFAULT 'performance',
                data TEXT,
                first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                suppressed INTEGER DEFAULT 0,
                suppression_reason TEXT,
                suppression_expires DATETIME,
                FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                line INTEGER NOT NULL,
                scope_name TEXT
            );

            CREATE TABLE IF NOT EXISTS file_relations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_file_id INTEGER NOT NULL,
                to_file_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                UNIQUE(from_file_id, to_file_id, type),
                FOREIGN KEY(from_file_id) REFERENCES files(id) ON DELETE CASCADE,
                FOREIGN KEY(to_file_id) REFERENCES files(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS symbol_relations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_symbol_id INTEGER NOT NULL,
                to_symbol_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                UNIQUE(from_symbol_id, to_symbol_id, type),
                FOREIGN KEY(from_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
                FOREIGN KEY(to_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
            CREATE INDEX IF NOT EXISTS idx_files_line_count ON files(line_count);
            CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
            CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
            CREATE INDEX IF NOT EXISTS idx_symbols_file_name ON symbols(file_id, name);
            CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
            CREATE INDEX IF NOT EXISTS idx_symbols_complexity ON symbols(complexity);
            CREATE INDEX IF NOT EXISTS idx_code_issues_file ON code_issues(file_id);
            CREATE INDEX IF NOT EXISTS idx_code_issues_file_type ON code_issues(file_id, type);
            CREATE INDEX IF NOT EXISTS idx_code_issues_category_type ON code_issues(category, type, severity);
            CREATE INDEX IF NOT EXISTS idx_code_issues_file_category ON code_issues(file_id, category);
            CREATE INDEX IF NOT EXISTS idx_code_issues_first_seen ON code_issues(first_seen);
            CREATE INDEX IF NOT EXISTS idx_file_relations_from ON file_relations(from_file_id);
            CREATE INDEX IF NOT EXISTS idx_file_relations_to ON file_relations(to_file_id);
            CREATE INDEX IF NOT EXISTS idx_symbol_relations_from ON symbol_relations(from_symbol_id);
            CREATE INDEX IF NOT EXISTS idx_symbol_relations_to ON symbol_relations(to_symbol_id);
            CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(file_id);
            CREATE INDEX IF NOT EXISTS idx_calls_name ON calls(name);
            CREATE INDEX IF NOT EXISTS idx_calls_scope ON calls(scope_name);

            CREATE TABLE IF NOT EXISTS code_signatures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_id INTEGER,
                normalized_signature TEXT,
                hash TEXT,
                FOREIGN KEY(symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_code_signatures_hash ON code_signatures(hash);
            CREATE INDEX IF NOT EXISTS idx_code_signatures_symbol ON code_signatures(symbol_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
                name,
                signature,
                kind,
                body_preview,
                content='',
                contentless_delete=1,
                tokenize='porter unicode61'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS symbols_trigram USING fts5(
                name,
                content='',
                contentless_delete=1,
                tokenize='trigram'
            );

            CREATE TABLE IF NOT EXISTS file_importance (
                file_id INTEGER PRIMARY KEY,
                import_count INTEGER DEFAULT 0,
                is_entry_point INTEGER DEFAULT 0,
                importance_score REAL DEFAULT 1.0,
                FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_file_importance_score ON file_importance(importance_score DESC);

            CREATE TABLE IF NOT EXISTS workspaces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                rel_path TEXT NOT NULL,
                abs_path TEXT NOT NULL,
                types TEXT NOT NULL DEFAULT '',
                build_files TEXT NOT NULL DEFAULT '',
                group_name TEXT,
                source TEXT NOT NULL DEFAULT 'auto',
                last_active_at INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_workspaces_name ON workspaces(name);
            CREATE INDEX IF NOT EXISTS idx_workspaces_source ON workspaces(source);
            "#,
        )?;

        // Migration: add body_preview column if missing (existing DBs)
        let _ = self.conn.execute(
            "ALTER TABLE symbols ADD COLUMN body_preview TEXT DEFAULT ''",
            [],
        );

        // Migrate FTS: if it lacks body_preview column, rebuild it.
        // Detect by attempting a no-op query on the new column.
        let needs_fts_rebuild = self.conn
            .prepare("SELECT body_preview FROM symbols_fts LIMIT 0")
            .is_err();
        if needs_fts_rebuild {
            let _ = self.conn.execute_batch(
                r#"
                DROP TRIGGER IF EXISTS symbols_ai;
                DROP TRIGGER IF EXISTS symbols_ad;
                DROP TRIGGER IF EXISTS symbols_au;
                DROP TABLE IF EXISTS symbols_fts;
                CREATE VIRTUAL TABLE symbols_fts USING fts5(
                    name, signature, kind, body_preview,
                    content='', contentless_delete=1,
                    tokenize='porter unicode61'
                );
                "#,
            );
            // Repopulate FTS from existing symbol data
            let _ = self.conn.execute_batch(
                r#"
                INSERT INTO symbols_fts(rowid, name, signature, kind, body_preview)
                SELECT id, name, COALESCE(signature, ''), kind, COALESCE(body_preview, '')
                FROM symbols;
                "#,
            );
        }

        // Drop and recreate triggers to ensure they match current schema
        self.conn.execute_batch(
            r#"
            DROP TRIGGER IF EXISTS symbols_ai;
            DROP TRIGGER IF EXISTS symbols_ad;
            DROP TRIGGER IF EXISTS symbols_au;

            CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
                INSERT INTO symbols_fts(rowid, name, signature, kind, body_preview) 
                VALUES (new.id, new.name, COALESCE(new.signature, ''), new.kind, COALESCE(new.body_preview, ''));
                INSERT INTO symbols_trigram(rowid, name) VALUES (new.id, new.name);
            END;

            CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
                DELETE FROM symbols_fts WHERE rowid = old.id;
                DELETE FROM symbols_trigram WHERE rowid = old.id;
            END;

            CREATE TRIGGER symbols_au AFTER UPDATE ON symbols BEGIN
                DELETE FROM symbols_fts WHERE rowid = old.id;
                DELETE FROM symbols_trigram WHERE rowid = old.id;
                INSERT INTO symbols_fts(rowid, name, signature, kind, body_preview) 
                VALUES (new.id, new.name, COALESCE(new.signature, ''), new.kind, COALESCE(new.body_preview, ''));
                INSERT INTO symbols_trigram(rowid, name) VALUES (new.id, new.name);
            END;
            "#,
        )?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn create_tables_in_memory_succeeds() {
        let conn = Connection::open_in_memory().unwrap();
        let schema = DatabaseSchema::new(&conn);
        schema.create_tables().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n >= 5);
    }
}
