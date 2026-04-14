pub mod schema;
pub mod migrations;
pub mod queries;

pub use schema::{DatabaseSchema, SchemaError};
pub use migrations::{DatabaseMigrations, MigrationError};

use rusqlite::{Connection, OptionalExtension, Result as SqliteResult};
use std::path::Path;
use std::sync::Mutex;
use thiserror::Error;

const SCHEMA_VERSION: i32 = 3;

#[derive(Error, Debug)]
pub enum DatabaseError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Schema error: {0}")]
    Schema(#[from] SchemaError),
    #[error("Migration error: {0}")]
    Migration(#[from] MigrationError),
    #[error("Schema version mismatch: have {have}, need {need}")]
    SchemaVersionMismatch { have: i32, need: i32 },
    #[error("Lock error: {0}")]
    Lock(String),
}

/// Thread-safe database wrapper with connection management
/// Uses Mutex to make rusqlite::Connection safe for multi-threaded access
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Wrap an open connection without running `init` (for read-only federation on migrated DBs).
    pub fn from_connection_skip_init(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Open or create a database at the given path
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, DatabaseError> {
        let conn = Connection::open(path)?;
        let db = Self { conn: Mutex::new(conn) };
        db.init()?;
        Ok(db)
    }

    /// Open an in-memory database (for testing)
    pub fn open_in_memory() -> Result<Self, DatabaseError> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn: Mutex::new(conn) };
        db.init()?;
        Ok(db)
    }

    /// Execute a function with the database connection
    /// This is the primary way to access the connection in a thread-safe manner
    pub fn with_conn<F, T>(&self, f: F) -> Result<T, DatabaseError>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let conn = self.conn.lock()
            .map_err(|e| DatabaseError::Lock(e.to_string()))?;
        f(&conn).map_err(DatabaseError::from)
    }

    /// Execute a function with mutable access to the database connection
    pub fn with_conn_mut<F, T>(&self, f: F) -> Result<T, DatabaseError>
    where
        F: FnOnce(&mut Connection) -> Result<T, rusqlite::Error>,
    {
        let mut conn = self.conn.lock()
            .map_err(|e| DatabaseError::Lock(e.to_string()))?;
        f(&mut conn).map_err(DatabaseError::from)
    }

    /// Get a reference to the underlying connection (acquires lock).
    /// Holds the lock for the lifetime of the returned guard.
    /// Panics after 60s to prevent silent hangs from lock contention.
    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        let start = std::time::Instant::now();
        loop {
            match self.conn.try_lock() {
                Ok(guard) => return guard,
                Err(std::sync::TryLockError::Poisoned(e)) => panic!("Database lock poisoned: {}", e),
                Err(std::sync::TryLockError::WouldBlock) => {
                    if start.elapsed() > std::time::Duration::from_secs(60) {
                        panic!("Database lock acquisition timed out after 60s — probable deadlock or long-held lock");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }
    }

    /// Initialize the database (create tables, run migrations)
    fn init(&self) -> Result<(), DatabaseError> {
        let conn = self.conn();
        let schema = DatabaseSchema::new(&conn);
        let migrations = DatabaseMigrations::new(&conn);

        // Check if tables exist
        let tables_exist: bool = OptionalExtension::optional(conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='files'",
            [],
            |_| Ok(()),
        ))?.is_some();

        if !tables_exist {
            // Fresh database - create tables and set version
            schema.create_tables()?;
            drop(schema);
            drop(migrations);
            drop(conn);
            self.set_schema_version(SCHEMA_VERSION)?;
            // Run migrations to populate derived tables
            let conn = self.conn();
            let migrations = DatabaseMigrations::new(&conn);
            migrations.run_all()?;
            return Ok(());
        }

        drop(schema);
        drop(migrations);
        drop(conn);

        // Existing database - check schema version
        let current_version = self.get_schema_version()?;

        if current_version < SCHEMA_VERSION {
            // Schema version mismatch - recreate database to avoid SQL errors
            tracing::info!(
                "Schema version mismatch (have: {}, need: {}). Recreating database...",
                current_version,
                SCHEMA_VERSION
            );
            let conn = self.conn();
            let schema = DatabaseSchema::new(&conn);
            schema.create_tables()?; // This drops and recreates all tables
            drop(schema);
            drop(conn);
            self.set_schema_version(SCHEMA_VERSION)?;
            // Run migrations to populate derived tables
            let conn = self.conn();
            let migrations = DatabaseMigrations::new(&conn);
            migrations.run_all()?;
            return Ok(());
        }

        // Same version - just configure and run incremental migrations
        let conn = self.conn();
        let schema = DatabaseSchema::new(&conn);
        let migrations = DatabaseMigrations::new(&conn);
        schema.configure()?;
        migrations.run_all()?;
        Ok(())
    }

    /// Get the current schema version from the database
    fn get_schema_version(&self) -> Result<i32, DatabaseError> {
        let conn = self.conn();
        
        // Check if schema_version table exists
        let table_exists: bool = OptionalExtension::optional(conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
            [],
            |_| Ok(()),
        ))?.is_some();

        if !table_exists {
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
                [],
            )?;
            // Legacy DB without version tracking — return 0 to trigger full recreation
            conn.execute(
                "INSERT INTO schema_version (version) VALUES (0)",
                [],
            )?;
            return Ok(0);
        }

        // Get version
        let version: i32 = conn.query_row(
            "SELECT version FROM schema_version LIMIT 1",
            [],
            |row| row.get(0),
        )?;
        Ok(version)
    }

    /// Set the schema version in the database
    fn set_schema_version(&self, version: i32) -> Result<(), DatabaseError> {
        let conn = self.conn();
        
        // Ensure table exists
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
            [],
        )?;
        // Update or insert version
        conn.execute(
            "DELETE FROM schema_version",
            [],
        )?;
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?)",
            [version],
        )?;
        Ok(())
    }
}

// Helper trait for optional query results (superseded by rusqlite::OptionalExtension)
#[allow(dead_code)]
trait OptionalResult<T> {
    fn optional(self) -> SqliteResult<Option<T>>;
}

impl<T> OptionalResult<T> for SqliteResult<T> {
    fn optional(self) -> SqliteResult<Option<T>> {
        match self {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
