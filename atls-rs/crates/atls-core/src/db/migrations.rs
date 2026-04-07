use rusqlite::{Connection, OptionalExtension};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum MigrationError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Migration failed: {0}")]
    Failed(String),
}

/// Database migration utilities
/// Handles all database schema migrations
pub struct DatabaseMigrations<'a> {
    conn: &'a Connection,
}

impl<'a> DatabaseMigrations<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Run all database migrations
    pub fn run_all(&self) -> Result<(), MigrationError> {
        self.migrate_code_issues_category()?;
        self.migrate_symbols_signature()?;
        self.migrate_symbols_complexity()?;
        self.migrate_symbols_metadata()?;
        self.migrate_symbols_end_line()?;
        self.migrate_code_issues_history()?;
        self.migrate_code_issues_end_line()?;
        self.migrate_suppressions_table()?;
        self.migrate_code_signatures_table()?;
        self.migrate_files_line_count()?;
        self.drop_history_tables()?;
        self.migrate_enhanced_fts5()?;
        self.migrate_workspaces_table()?;
        self.migrate_files_language_index()?;
        Ok(())
    }

    /// Index `files(language)` for rename auto-scope and language-filtered symbol queries.
    fn migrate_files_language_index(&self) -> Result<(), MigrationError> {
        self.conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);",
        )?;
        Ok(())
    }

    /// Migration: Add end_line column to symbols
    fn migrate_symbols_end_line(&self) -> Result<(), MigrationError> {
        let columns: Vec<String> = self.conn.prepare("PRAGMA table_info(symbols)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<_, _>>()?;
        
        let has_end_line = columns.iter().any(|name| name == "end_line");

        if !has_end_line {
            self.conn.execute("ALTER TABLE symbols ADD COLUMN end_line INTEGER", [])?;
        }
        Ok(())
    }

    /// Migration: Add category column to code_issues
    fn migrate_code_issues_category(&self) -> Result<(), MigrationError> {
        let code_issues_info: Option<String> = self.conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='code_issues'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if let Some(sql) = code_issues_info {
            if !sql.contains("category") {
                self.conn.execute_batch(
                    r#"
                    ALTER TABLE code_issues ADD COLUMN category TEXT NOT NULL DEFAULT 'performance';
                    CREATE INDEX IF NOT EXISTS idx_code_issues_category_type ON code_issues(category, type, severity);
                    CREATE INDEX IF NOT EXISTS idx_code_issues_file_category ON code_issues(file_id, category);
                    CREATE INDEX IF NOT EXISTS idx_code_issues_file_type ON code_issues(file_id, type);
                    CREATE INDEX IF NOT EXISTS idx_symbols_file_name ON symbols(file_id, name);
                    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
                    "#,
                )?;
            }
        }
        Ok(())
    }

    /// Migration: Add signature column to symbols
    fn migrate_symbols_signature(&self) -> Result<(), MigrationError> {
        let symbols_info: Option<String> = self.conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='symbols'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if let Some(sql) = symbols_info {
            if !sql.contains("signature") {
                self.conn.execute("ALTER TABLE symbols ADD COLUMN signature TEXT", [])?;
            }
        }
        Ok(())
    }

    /// Migration: Add complexity column to symbols
    fn migrate_symbols_complexity(&self) -> Result<(), MigrationError> {
        let symbols_info: Option<String> = self.conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='symbols'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if let Some(sql) = symbols_info {
            if !sql.contains("complexity") {
                self.conn.execute("ALTER TABLE symbols ADD COLUMN complexity INTEGER DEFAULT 0", [])?;
            }
        }
        Ok(())
    }

    /// Migration: Add metadata column to symbols
    fn migrate_symbols_metadata(&self) -> Result<(), MigrationError> {
        let columns: Vec<String> = self.conn.prepare("PRAGMA table_info(symbols)")?
            .query_map([], |row| row.get::<_, String>(1))? // Column 1 is the name
            .collect::<Result<_, _>>()?;
        
        let has_metadata = columns.iter().any(|name| name == "metadata");

        if !has_metadata {
            self.conn.execute("ALTER TABLE symbols ADD COLUMN metadata TEXT", [])?;
        }
        Ok(())
    }

    /// Migration: Add end_line and end_col columns to code_issues
    fn migrate_code_issues_end_line(&self) -> Result<(), MigrationError> {
        let columns: Vec<String> = self.conn.prepare("PRAGMA table_info(code_issues)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<_, _>>()?;

        if !columns.iter().any(|name| name == "end_line") {
            self.conn.execute("ALTER TABLE code_issues ADD COLUMN end_line INTEGER", [])?;
        }
        if !columns.iter().any(|name| name == "end_col") {
            self.conn.execute("ALTER TABLE code_issues ADD COLUMN end_col INTEGER", [])?;
        }
        Ok(())
    }

    /// Migration: Add historical tracking columns to code_issues
    fn migrate_code_issues_history(&self) -> Result<(), MigrationError> {
        let issues_info: Option<String> = self.conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='code_issues'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if let Some(sql) = issues_info {
            if !sql.contains("first_seen") {
                self.conn.execute_batch(
                    r#"
                    ALTER TABLE code_issues ADD COLUMN first_seen DATETIME;
                    UPDATE code_issues SET first_seen = CURRENT_TIMESTAMP WHERE first_seen IS NULL;
                    CREATE INDEX IF NOT EXISTS idx_code_issues_first_seen ON code_issues(first_seen);
                    "#,
                )?;
            }
            if !sql.contains("suppressed") {
                self.conn.execute_batch(
                    r#"
                    ALTER TABLE code_issues ADD COLUMN suppressed INTEGER;
                    ALTER TABLE code_issues ADD COLUMN suppression_reason TEXT;
                    ALTER TABLE code_issues ADD COLUMN suppression_expires DATETIME;
                    UPDATE code_issues SET suppressed = 0 WHERE suppressed IS NULL;
                    "#,
                )?;
            }
        }
        Ok(())
    }

    /// Migration: Add suppressions table
    fn migrate_suppressions_table(&self) -> Result<(), MigrationError> {
        let suppressions_exist: Option<String> = self.conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='suppressions'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if suppressions_exist.is_none() {
            self.conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS suppressions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT,
                    pattern_id TEXT,
                    reason TEXT,
                    expires_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    created_by TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_suppressions_file ON suppressions(file_path);
                CREATE INDEX IF NOT EXISTS idx_suppressions_pattern ON suppressions(pattern_id);
                "#,
            )?;
        }
        Ok(())
    }

    /// Migration: Drop unused history tables
    fn drop_history_tables(&self) -> Result<(), MigrationError> {
        self.conn.execute("DROP TABLE IF EXISTS issue_history", [])?;
        self.conn.execute("DROP TABLE IF EXISTS scan_snapshots", [])?;
        Ok(())
    }

    /// Migration: Add or update code_signatures table
    fn migrate_code_signatures_table(&self) -> Result<(), MigrationError> {
        let code_signatures_exist: Option<String> = self.conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='code_signatures'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if code_signatures_exist.is_none() {
            self.conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS code_signatures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol_id INTEGER,
                    normalized_signature TEXT,
                    hash TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_code_signatures_hash ON code_signatures(hash);
                CREATE INDEX IF NOT EXISTS idx_code_signatures_symbol ON code_signatures(symbol_id);
                "#,
            )?;
        } else {
            self.remove_foreign_keys_from_code_signatures()?;
        }
        Ok(())
    }

    /// Remove foreign keys from code_signatures table
    fn remove_foreign_keys_from_code_signatures(&self) -> Result<(), MigrationError> {
        let code_signatures_info: Option<String> = self.conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='code_signatures'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if let Some(sql) = code_signatures_info {
            if sql.contains("FOREIGN KEY") {
                self.conn.execute_batch(
                    r#"
                    CREATE TABLE code_signatures_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        symbol_id INTEGER,
                        normalized_signature TEXT,
                        hash TEXT
                    );
                    INSERT INTO code_signatures_new SELECT * FROM code_signatures;
                    DROP TABLE code_signatures;
                    ALTER TABLE code_signatures_new RENAME TO code_signatures;
                    CREATE INDEX IF NOT EXISTS idx_code_signatures_hash ON code_signatures(hash);
                    CREATE INDEX IF NOT EXISTS idx_code_signatures_symbol ON code_signatures(symbol_id);
                    "#,
                )?;
            }
        }
        Ok(())
    }

    /// Migration: Add line_count column to files table
    fn migrate_files_line_count(&self) -> Result<(), MigrationError> {
        let columns: Vec<String> = self.conn.prepare("PRAGMA table_info(files)")?
            .query_map([], |row| row.get::<_, String>(1))? // Column 1 is the name
            .collect::<Result<_, _>>()?;
        
        let has_line_count = columns.iter().any(|name| name == "line_count");

        if !has_line_count {
            self.conn.execute_batch(
                r#"
                ALTER TABLE files ADD COLUMN line_count INTEGER DEFAULT NULL;
                CREATE INDEX IF NOT EXISTS idx_files_line_count ON files(line_count);
                "#,
            )?;
        }
        Ok(())
    }

    /// Migration: Upgrade to enhanced FTS5 tables for code search
    fn migrate_enhanced_fts5(&self) -> Result<(), MigrationError> {
        let trigram_exists: Option<String> = self.conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='symbols_trigram'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if trigram_exists.is_some() {
            // Already migrated, ensure file_importance exists
            self.ensure_file_importance_table()?;
            return Ok(());
        }

        // Check current FTS5 schema
        let fts_info: Option<String> = self.conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='symbols_fts'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        let needs_upgrade = fts_info.as_ref().map_or(true, |sql| !sql.contains("body_preview"));

        if needs_upgrade {
            // Drop old triggers first
            self.conn.execute_batch(
                r#"
                DROP TRIGGER IF EXISTS symbols_ai;
                DROP TRIGGER IF EXISTS symbols_ad;
                DROP TRIGGER IF EXISTS symbols_au;
                "#,
            )?;

            // Drop old FTS table
            self.conn.execute("DROP TABLE IF EXISTS symbols_fts", [])?;

            // Ensure body_preview column exists before rebuilding FTS
            let _ = self.conn.execute(
                "ALTER TABLE symbols ADD COLUMN body_preview TEXT DEFAULT ''",
                [],
            );

            // Create enhanced FTS5 with porter stemmer (4 columns matching schema.rs)
            self.conn.execute_batch(
                r#"
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
                "#,
            )?;

            // Populate FTS tables from existing symbols
            self.conn.execute_batch(
                r#"
                INSERT INTO symbols_fts(rowid, name, signature, kind, body_preview)
                SELECT id, name, COALESCE(signature, ''), kind, COALESCE(body_preview, '')
                FROM symbols;

                INSERT INTO symbols_trigram(rowid, name)
                SELECT id, name FROM symbols;
                "#,
            )?;

            // Create new triggers
            self.conn.execute_batch(
                r#"
                CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
                    INSERT INTO symbols_fts(rowid, name, signature, kind, body_preview)
                    VALUES (new.id, new.name, COALESCE(new.signature, ''), new.kind, COALESCE(new.body_preview, ''));
                    INSERT INTO symbols_trigram(rowid, name) VALUES (new.id, new.name);
                END;

                CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
                    DELETE FROM symbols_fts WHERE rowid = old.id;
                    DELETE FROM symbols_trigram WHERE rowid = old.id;
                END;

                CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
                    DELETE FROM symbols_fts WHERE rowid = old.id;
                    DELETE FROM symbols_trigram WHERE rowid = old.id;
                    INSERT INTO symbols_fts(rowid, name, signature, kind, body_preview)
                    VALUES (new.id, new.name, COALESCE(new.signature, ''), new.kind, COALESCE(new.body_preview, ''));
                    INSERT INTO symbols_trigram(rowid, name) VALUES (new.id, new.name);
                END;
                "#,
            )?;
        }

        // Create file_importance table
        self.ensure_file_importance_table()?;
        Ok(())
    }

    /// Migration: Add workspaces table for multi-root project support
    fn migrate_workspaces_table(&self) -> Result<(), MigrationError> {
        let exists: Option<String> = self.conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if exists.is_none() {
            self.conn.execute_batch(
                r#"
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
        }
        Ok(())
    }

    /// Ensure file_importance table exists and is populated
    fn ensure_file_importance_table(&self) -> Result<(), MigrationError> {
        let importance_exists: Option<String> = self.conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='file_importance'",
            [],
            |row| row.get::<_, String>(0),
        ).optional()?;

        if importance_exists.is_none() {
            self.conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS file_importance (
                    file_id INTEGER PRIMARY KEY,
                    import_count INTEGER DEFAULT 0,
                    is_entry_point INTEGER DEFAULT 0,
                    importance_score REAL DEFAULT 1.0,
                    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_file_importance_score ON file_importance(importance_score DESC);
                "#,
            )?;
        }

        // Check if table needs population
        let row_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM file_importance",
            [],
            |row| row.get(0),
        )?;
        let file_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM files",
            [],
            |row| row.get(0),
        )?;

        if row_count < file_count && file_count > 0 {
            // Populate from file_relations
            self.conn.execute_batch(
                r#"
                INSERT OR IGNORE INTO file_importance (file_id, import_count, importance_score)
                SELECT 
                    f.id,
                    COALESCE(import_counts.cnt, 0),
                    1.0 + (COALESCE(import_counts.cnt, 0) * 0.1)
                FROM files f
                LEFT JOIN (
                    SELECT to_file_id, COUNT(*) as cnt 
                    FROM file_relations 
                    WHERE type = 'IMPORTS' 
                    GROUP BY to_file_id
                ) import_counts ON f.id = import_counts.to_file_id;
                "#,
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::DatabaseMigrations;

    #[test]
    fn run_all_succeeds_on_initialized_database() {
        let db = crate::db::Database::open_in_memory().expect("db");
        let conn = db.conn();
        DatabaseMigrations::new(&*conn)
            .run_all()
            .expect("migrations");
    }
}

