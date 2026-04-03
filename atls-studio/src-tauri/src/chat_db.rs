// hash test
// Chat Database Module
// Per-project chat persistence using SQLite

use rusqlite::{Connection, params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const MEMORY_SNAPSHOT_KEY: &str = "__memory_snapshot_v2__";

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct DbSession {
    pub id: String,
    pub title: String,
    pub mode: String,
    pub created_at: String,
    pub updated_at: String,
    pub is_swarm: bool,
    pub swarm_status: Option<String>,
    pub context_usage: Option<ContextUsage>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ContextUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cost_cents: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DbMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub agent_id: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DbSegment {
    pub id: i64,
    pub message_id: String,
    pub seq: i64,
    #[serde(rename = "type")]
    pub segment_type: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<String>,
    pub tool_result: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DbBlackboardEntry {
    pub id: i64,
    pub session_id: String,
    pub hash: String,
    pub short_hash: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub source: Option<String>,
    pub content: String,
    pub tokens: i64,
    pub pinned: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DbTask {
    pub id: String,
    pub session_id: String,
    pub parent_task_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub assigned_model: Option<String>,
    pub assigned_role: Option<String>,
    pub context_hashes: Option<String>,
    pub file_claims: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub tokens_used: i64,
    pub cost_cents: i64,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DbAgentStats {
    pub id: i64,
    pub session_id: String,
    pub task_id: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_cents: i64,
    pub api_calls: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TotalStats {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_cents: i64,
    pub total_api_calls: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DbBlackboardNote {
    pub id: i64,
    pub session_id: String,
    pub key: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    pub state: Option<String>,
    pub file_path: Option<String>,
}

// ============================================================================
// Chat Database State
// ============================================================================

pub struct ChatDbState {
    pub conn: Mutex<Option<Connection>>,
    pub project_path: Mutex<Option<String>>,
}

impl Default for ChatDbState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
            project_path: Mutex::new(None),
        }
    }
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA: &str = r#"
-- Chat sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mode TEXT DEFAULT 'agent',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_swarm INTEGER DEFAULT 0,
    swarm_status TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost_cents REAL DEFAULT 0
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    agent_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Message segments (tool calls interleaved with text)
CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_args TEXT,
    tool_result TEXT,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- Blackboard (shared context for swarm)
CREATE TABLE IF NOT EXISTS blackboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    short_hash TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT,
    content TEXT NOT NULL,
    tokens INTEGER,
    pinned INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Swarm tasks
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_task_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    assigned_model TEXT,
    assigned_role TEXT,
    context_hashes TEXT,
    file_claims TEXT,
    result TEXT,
    error TEXT,
    tokens_used INTEGER DEFAULT 0,
    cost_cents INTEGER DEFAULT 0,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Token/cost tracking per agent
CREATE TABLE IF NOT EXISTS agent_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_cents INTEGER DEFAULT 0,
    api_calls INTEGER DEFAULT 1,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Blackboard notes (persistent key-value knowledge surface)
CREATE TABLE IF NOT EXISTS blackboard_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE(session_id, key)
);

-- HPP v3: Hash registry for chat-scoped persistence
CREATE TABLE IF NOT EXISTS hash_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    short_hash TEXT NOT NULL,
    source TEXT,
    tokens INTEGER DEFAULT 0,
    lang TEXT,
    line_count INTEGER DEFAULT 0,
    symbol_count INTEGER,
    chunk_type TEXT,
    subtask_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE(session_id, hash)
);

-- Archived chunks (persisted across restarts, recallable by hash)
CREATE TABLE IF NOT EXISTS archived_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    short_hash TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT,
    content TEXT NOT NULL,
    tokens INTEGER DEFAULT 0,
    digest TEXT,
    edit_digest TEXT,
    summary TEXT,
    pinned INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Session state (key-value per session for restorable ephemeral state)
CREATE TABLE IF NOT EXISTS session_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE(session_id, key)
);

-- Staged snippets (BP4 cached editor viewport, per session)
CREATE TABLE IF NOT EXISTS staged_snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    lines TEXT,
    tokens INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE(session_id, key)
);

-- Shadow versions: historical file content for hash forwarding rollback
CREATE TABLE IF NOT EXISTS shadow_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    hash TEXT NOT NULL,
    content TEXT NOT NULL,
    replaced_by TEXT,
    version_number INTEGER NOT NULL DEFAULT 1,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_segments_message ON segments(message_id);
CREATE INDEX IF NOT EXISTS idx_blackboard_session ON blackboard(session_id);
CREATE INDEX IF NOT EXISTS idx_blackboard_hash ON blackboard(short_hash);
CREATE INDEX IF NOT EXISTS idx_blackboard_notes_session ON blackboard_notes(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_stats_session ON agent_stats(session_id);
CREATE INDEX IF NOT EXISTS idx_hash_registry_session ON hash_registry(session_id);
CREATE INDEX IF NOT EXISTS idx_hash_registry_hash ON hash_registry(short_hash);
CREATE INDEX IF NOT EXISTS idx_hash_registry_source ON hash_registry(session_id, source);
CREATE INDEX IF NOT EXISTS idx_archived_chunks_session ON archived_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_archived_chunks_hash ON archived_chunks(short_hash);
CREATE INDEX IF NOT EXISTS idx_session_state_session ON session_state(session_id);
CREATE INDEX IF NOT EXISTS idx_staged_snippets_session ON staged_snippets(session_id);
CREATE INDEX IF NOT EXISTS idx_shadow_versions_session ON shadow_versions(session_id, source_path);
CREATE INDEX IF NOT EXISTS idx_shadow_versions_hash ON shadow_versions(hash);
"#;

// ============================================================================
// Database Operations
// ============================================================================

impl ChatDbState {
    /// Initialize database for a project
    pub fn init(&self, project_path: &str) -> Result<(), String> {
        let db_path = PathBuf::from(project_path)
            .join(".atls")
            .join("chat.db");
        
        // Ensure .atls directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .atls directory: {}", e))?;
        }
        
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open chat database: {}", e))?;
        
        // Enable foreign keys and WAL mode
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .map_err(|e| format!("Failed to configure database: {}", e))?;
        
        // Create schema
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("Failed to create schema: {}", e))?;

        // Schema versioning and migrations
        Self::run_migrations(&conn)?;

        // Store connection
        let mut conn_guard = self.conn.lock().map_err(|e| e.to_string())?;
        *conn_guard = Some(conn);
        
        let mut path_guard = self.project_path.lock().map_err(|e| e.to_string())?;
        *path_guard = Some(project_path.to_string());
        
        Ok(())
    }
    
    /// Close database connection
    pub fn close(&self) -> Result<(), String> {
        let mut conn_guard = self.conn.lock().map_err(|e| e.to_string())?;
        *conn_guard = None;
        
        let mut path_guard = self.project_path.lock().map_err(|e| e.to_string())?;
        *path_guard = None;
        
        Ok(())
    }
    
    /// Execute a function with the database connection
    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let conn_guard = self.conn.lock().map_err(|e| e.to_string())?;
        let conn = conn_guard.as_ref().ok_or("Chat database not initialized")?;
        f(conn).map_err(|e| e.to_string())
    }

    /// Run sequential schema migrations. Each migration bumps the version.
    fn run_migrations(conn: &Connection) -> Result<(), String> {
        let current_version: i64 = conn
            .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))
            .unwrap_or(0);

        if current_version < 1 {
            // v1: add cost_cents to sessions (legacy migration)
            let has_cost_cents: bool = conn
                .prepare("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='cost_cents'")
                .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
                .unwrap_or(0) > 0;
            if !has_cost_cents {
                conn.execute_batch("ALTER TABLE sessions ADD COLUMN cost_cents REAL DEFAULT 0;")
                    .map_err(|e| format!("Migration v1 cost_cents: {}", e))?;
            }
            conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])
                .map_err(|e| format!("Migration v1 version bump: {}", e))?;
        }

        // v2: new tables already created via SCHEMA (CREATE IF NOT EXISTS).
        // This migration marker ensures future migrations know the baseline.
        if current_version < 2 {
            conn.execute("INSERT INTO schema_version (version) VALUES (2)", [])
                .map_err(|e| format!("Migration v2 version bump: {}", e))?;
        }

        // v3: add source_revision and shape_spec to staged_snippets for provenance.
        if current_version < 3 {
            let has_source_revision: bool = conn
                .prepare("SELECT COUNT(*) FROM pragma_table_info('staged_snippets') WHERE name='source_revision'")
                .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
                .unwrap_or(0) > 0;
            if !has_source_revision {
                conn.execute_batch(
                    "ALTER TABLE staged_snippets ADD COLUMN source_revision TEXT;
                     ALTER TABLE staged_snippets ADD COLUMN shape_spec TEXT;"
                )
                .map_err(|e| format!("Migration v3 staged_snippets: {}", e))?;
            }
            conn.execute("INSERT INTO schema_version (version) VALUES (3)", [])
                .map_err(|e| format!("Migration v3 version bump: {}", e))?;
        }

        // v4: add state and file_path to blackboard_notes for reasoning freshness.
        if current_version < 4 {
            let has_state: bool = conn
                .prepare("SELECT COUNT(*) FROM pragma_table_info('blackboard_notes') WHERE name='state'")
                .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
                .unwrap_or(0) > 0;
            if !has_state {
                conn.execute_batch(
                    "ALTER TABLE blackboard_notes ADD COLUMN state TEXT DEFAULT 'active';
                     ALTER TABLE blackboard_notes ADD COLUMN file_path TEXT;"
                )
                .map_err(|e| format!("Migration v4 blackboard_notes: {}", e))?;
            }
            conn.execute("INSERT INTO schema_version (version) VALUES (4)", [])
                .map_err(|e| format!("Migration v4 version bump: {}", e))?;
        }

        Ok(())
    }
}

// ============================================================================
// Session Operations
// ============================================================================

pub fn create_session(state: &ChatDbState, id: &str, title: &str, mode: &str, is_swarm: bool) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "INSERT INTO sessions (id, title, mode, is_swarm) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, mode, is_swarm as i32],
        )?;
        Ok(())
    })
}

pub fn get_sessions(state: &ChatDbState, limit: i64) -> Result<Vec<DbSession>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, mode, created_at, updated_at, is_swarm, swarm_status, 
                    input_tokens, output_tokens, total_tokens, cost_cents
             FROM sessions ORDER BY updated_at DESC LIMIT ?1"
        )?;
        
        let sessions = stmt.query_map([limit], |row| {
            Ok(DbSession {
                id: row.get(0)?,
                title: row.get(1)?,
                mode: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                is_swarm: row.get::<_, i32>(5)? != 0,
                swarm_status: row.get(6)?,
                context_usage: Some(ContextUsage {
                    input_tokens: row.get(7)?,
                    output_tokens: row.get(8)?,
                    total_tokens: row.get(9)?,
                    cost_cents: row.get(10)?,
                }),
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        
        Ok(sessions)
    })
}

pub fn get_session(state: &ChatDbState, session_id: &str) -> Result<Option<DbSession>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, mode, created_at, updated_at, is_swarm, swarm_status,
                    input_tokens, output_tokens, total_tokens, cost_cents
             FROM sessions WHERE id = ?1"
        )?;
        
        let session = stmt.query_row([session_id], |row| {
            Ok(DbSession {
                id: row.get(0)?,
                title: row.get(1)?,
                mode: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                is_swarm: row.get::<_, i32>(5)? != 0,
                swarm_status: row.get(6)?,
                context_usage: Some(ContextUsage {
                    input_tokens: row.get(7)?,
                    output_tokens: row.get(8)?,
                    total_tokens: row.get(9)?,
                    cost_cents: row.get(10)?,
                }),
            })
        }).optional()?;
        
        Ok(session)
    })
}

pub fn update_session_title(state: &ChatDbState, session_id: &str, title: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE sessions SET title = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![title, session_id],
        )?;
        Ok(())
    })
}

pub fn update_session_mode(state: &ChatDbState, session_id: &str, mode: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE sessions SET mode = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![mode, session_id],
        )?;
        Ok(())
    })
}

pub fn update_swarm_status(state: &ChatDbState, session_id: &str, status: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE sessions SET swarm_status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![status, session_id],
        )?;
        Ok(())
    })
}

pub fn update_context_usage(state: &ChatDbState, session_id: &str, input_tokens: i64, output_tokens: i64, total_tokens: i64, cost_cents: f64) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE sessions SET input_tokens = ?1, output_tokens = ?2, total_tokens = ?3, cost_cents = ?4, updated_at = CURRENT_TIMESTAMP WHERE id = ?5",
            params![input_tokens, output_tokens, total_tokens, cost_cents, session_id],
        )?;
        Ok(())
    })
}

pub fn delete_session(state: &ChatDbState, session_id: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
        Ok(())
    })
}

// ============================================================================
// Message Operations
// ============================================================================

pub fn add_message(state: &ChatDbState, id: &str, session_id: &str, role: &str, content: &str, agent_id: Option<&str>) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, agent_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, session_id, role, content, agent_id],
        )?;
        // Update session timestamp
        conn.execute(
            "UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [session_id],
        )?;
        Ok(())
    })
}

pub fn get_messages(state: &ChatDbState, session_id: &str) -> Result<Vec<DbMessage>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, agent_id, timestamp 
             FROM messages WHERE session_id = ?1 ORDER BY timestamp ASC"
        )?;
        
        let messages = stmt.query_map([session_id], |row| {
            Ok(DbMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                agent_id: row.get(4)?,
                timestamp: row.get(5)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        
        Ok(messages)
    })
}

// ============================================================================
// Segment Operations
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct SegmentInput {
    /// Present in JSON payload for context; actual message_id is passed separately to add_segments.
    pub message_id: String,
    pub seq: i64,
    #[serde(rename = "type")]
    pub segment_type: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<String>,
    pub tool_result: Option<String>,
}

pub fn add_segments(state: &ChatDbState, message_id: &str, segments: Vec<SegmentInput>) -> Result<(), String> {
    state.with_conn(|conn| {
        for seg in segments {
            conn.execute(
                "INSERT INTO segments (message_id, seq, type, content, tool_name, tool_args, tool_result) 
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![message_id, seg.seq, seg.segment_type, seg.content, seg.tool_name, seg.tool_args, seg.tool_result],
            )?;
        }
        Ok(())
    })
}

pub fn delete_segments(state: &ChatDbState, message_id: &str) -> Result<i64, String> {
    state.with_conn(|conn| {
        let deleted = conn.execute(
            "DELETE FROM segments WHERE message_id = ?1",
            params![message_id],
        )?;
        Ok(deleted as i64)
    })
}

pub fn replace_segments(state: &ChatDbState, message_id: &str, segments: Vec<SegmentInput>) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "DELETE FROM segments WHERE message_id = ?1",
            params![message_id],
        )?;
        for seg in segments {
            conn.execute(
                "INSERT INTO segments (message_id, seq, type, content, tool_name, tool_args, tool_result) 
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![message_id, seg.seq, seg.segment_type, seg.content, seg.tool_name, seg.tool_args, seg.tool_result],
            )?;
        }
        Ok(())
    })
}

pub fn get_segments(state: &ChatDbState, message_id: &str) -> Result<Vec<DbSegment>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, message_id, seq, type, content, tool_name, tool_args, tool_result 
             FROM segments WHERE message_id = ?1 ORDER BY seq ASC"
        )?;
        
        let segments = stmt.query_map([message_id], |row| {
            Ok(DbSegment {
                id: row.get(0)?,
                message_id: row.get(1)?,
                seq: row.get(2)?,
                segment_type: row.get(3)?,
                content: row.get(4)?,
                tool_name: row.get(5)?,
                tool_args: row.get(6)?,
                tool_result: row.get(7)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        
        Ok(segments)
    })
}

// ============================================================================
// Blackboard Operations
// ============================================================================

pub fn add_blackboard_entry(
    state: &ChatDbState, 
    session_id: &str, 
    hash: &str, 
    short_hash: &str,
    entry_type: &str,
    source: Option<&str>,
    content: &str,
    tokens: i64,
    pinned: bool
) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "INSERT INTO blackboard (session_id, hash, short_hash, type, source, content, tokens, pinned) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![session_id, hash, short_hash, entry_type, source, content, tokens, pinned as i32],
        )?;
        Ok(())
    })
}

pub fn get_blackboard_entries(state: &ChatDbState, session_id: &str) -> Result<Vec<DbBlackboardEntry>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, hash, short_hash, type, source, content, tokens, pinned, created_at 
             FROM blackboard WHERE session_id = ?1 ORDER BY created_at ASC"
        )?;
        
        let entries = stmt.query_map([session_id], |row| {
            Ok(DbBlackboardEntry {
                id: row.get(0)?,
                session_id: row.get(1)?,
                hash: row.get(2)?,
                short_hash: row.get(3)?,
                entry_type: row.get(4)?,
                source: row.get(5)?,
                content: row.get(6)?,
                tokens: row.get(7)?,
                pinned: row.get::<_, i32>(8)? != 0,
                created_at: row.get(9)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        
        Ok(entries)
    })
}

/// Look up blackboard content by hash (full or short) for a session.
/// Returns (content, source) if found.
pub fn get_content_by_hash(
    state: &ChatDbState,
    session_id: &str,
    hash: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    let hash_clean = hash.trim_start_matches("h:");
    let prefix = format!("{}%", hash_clean);
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT content, source FROM blackboard 
             WHERE session_id = ?1 AND (hash = ?2 OR short_hash = ?2 OR hash LIKE ?3)
             LIMIT 1",
        )?;
        let row = stmt
            .query_row(
                params![session_id, hash_clean, &prefix],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(row)
    })
}

pub fn update_blackboard_pinned(state: &ChatDbState, session_id: &str, short_hash: &str, pinned: bool) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE blackboard SET pinned = ?1 WHERE session_id = ?2 AND short_hash = ?3",
            params![pinned as i32, session_id, short_hash],
        )?;
        Ok(())
    })
}

pub fn remove_blackboard_entries(state: &ChatDbState, session_id: &str, short_hashes: Vec<String>) -> Result<(), String> {
    state.with_conn(|conn| {
        for hash in short_hashes {
            conn.execute(
                "DELETE FROM blackboard WHERE session_id = ?1 AND short_hash = ?2",
                params![session_id, hash],
            )?;
        }
        Ok(())
    })
}

pub fn clear_blackboard(state: &ChatDbState, session_id: &str, keep_pinned: bool) -> Result<(), String> {
    state.with_conn(|conn| {
        if keep_pinned {
            conn.execute(
                "DELETE FROM blackboard WHERE session_id = ?1 AND pinned = 0",
                [session_id],
            )?;
        } else {
            conn.execute(
                "DELETE FROM blackboard WHERE session_id = ?1",
                [session_id],
            )?;
        }
        Ok(())
    })
}

// ============================================================================
// HPP v3: Hash Registry Operations (chat-scoped persistence)
// ============================================================================

#[derive(Debug, Clone, serde::Serialize)]
pub struct DbHashRegistryEntry {
    pub hash: String,
    pub short_hash: String,
    pub source: Option<String>,
    pub tokens: i64,
    pub lang: Option<String>,
    pub line_count: i64,
    pub symbol_count: Option<i64>,
    pub chunk_type: Option<String>,
    pub subtask_id: Option<String>,
}

pub fn register_hash(
    state: &ChatDbState,
    session_id: &str,
    hash: &str,
    short_hash: &str,
    source: Option<&str>,
    tokens: i64,
    lang: Option<&str>,
    line_count: i64,
    symbol_count: Option<i64>,
    chunk_type: Option<&str>,
    subtask_id: Option<&str>,
) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "INSERT INTO hash_registry (session_id, hash, short_hash, source, tokens, lang, line_count, symbol_count, chunk_type, subtask_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(session_id, hash) DO UPDATE SET
               source = COALESCE(?4, source),
               tokens = ?5,
               lang = COALESCE(?6, lang),
               line_count = ?7,
               symbol_count = COALESCE(?8, symbol_count),
               chunk_type = COALESCE(?9, chunk_type),
               subtask_id = COALESCE(?10, subtask_id)",
            params![session_id, hash, short_hash, source, tokens, lang, line_count, symbol_count, chunk_type, subtask_id],
        )?;
        Ok(())
    })
}

pub fn get_hash_registry_entry(
    state: &ChatDbState,
    session_id: &str,
    hash: &str,
) -> Result<Option<DbHashRegistryEntry>, String> {
    let hash_clean = hash.trim_start_matches("h:");
    let prefix = format!("{}%", hash_clean);
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT hash, short_hash, source, tokens, lang, line_count, symbol_count, chunk_type, subtask_id
             FROM hash_registry
             WHERE session_id = ?1 AND (hash = ?2 OR short_hash = ?2 OR hash LIKE ?3)
             LIMIT 1",
        )?;
        let row = stmt
            .query_row(params![session_id, hash_clean, &prefix], |row| {
                Ok(DbHashRegistryEntry {
                    hash: row.get(0)?,
                    short_hash: row.get(1)?,
                    source: row.get(2)?,
                    tokens: row.get(3)?,
                    lang: row.get(4)?,
                    line_count: row.get(5)?,
                    symbol_count: row.get(6)?,
                    chunk_type: row.get(7)?,
                    subtask_id: row.get(8)?,
                })
            })
            .optional()?;
        Ok(row)
    })
}

pub fn get_session_hash_registry(
    state: &ChatDbState,
    session_id: &str,
) -> Result<Vec<DbHashRegistryEntry>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT hash, short_hash, source, tokens, lang, line_count, symbol_count, chunk_type, subtask_id
             FROM hash_registry
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let entries = stmt
            .query_map([session_id], |row| {
                Ok(DbHashRegistryEntry {
                    hash: row.get(0)?,
                    short_hash: row.get(1)?,
                    source: row.get(2)?,
                    tokens: row.get(3)?,
                    lang: row.get(4)?,
                    line_count: row.get(5)?,
                    symbol_count: row.get(6)?,
                    chunk_type: row.get(7)?,
                    subtask_id: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    })
}

// ============================================================================
// Shadow Version Operations (hash forwarding rollback)
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct DbShadowVersion {
    pub id: i64,
    pub session_id: String,
    pub source_path: String,
    pub hash: String,
    pub content: String,
    pub replaced_by: Option<String>,
    pub version_number: i64,
    pub registered_at: String,
}

/// Persist a shadow copy before hash forwarding overwrites it.
/// Bounded to 5 versions per source path; prunes oldest on insert.
pub fn insert_shadow_version(
    state: &ChatDbState,
    session_id: &str,
    source_path: &str,
    hash: &str,
    content: &str,
    replaced_by: Option<&str>,
) -> Result<(), String> {
    state.with_conn(|conn| {
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version_number), 0) FROM shadow_versions WHERE session_id = ?1 AND source_path = ?2",
                params![session_id, source_path],
                |row| row.get(0),
            )
            .unwrap_or(0)
            + 1;

        conn.execute(
            "INSERT INTO shadow_versions (session_id, source_path, hash, content, replaced_by, version_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, source_path, hash, content, replaced_by, version],
        )?;

        // Prune: keep only 5 most recent per source path
        conn.execute(
            "DELETE FROM shadow_versions WHERE session_id = ?1 AND source_path = ?2
             AND id NOT IN (
               SELECT id FROM shadow_versions
               WHERE session_id = ?1 AND source_path = ?2
               ORDER BY version_number DESC LIMIT 5
             )",
            params![session_id, source_path],
        )?;

        Ok(())
    })
}

/// List shadow versions for a source path (newest first).
pub fn list_shadow_versions(
    state: &ChatDbState,
    session_id: &str,
    source_path: &str,
) -> Result<Vec<DbShadowVersion>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, source_path, hash, content, replaced_by, version_number, registered_at
             FROM shadow_versions
             WHERE session_id = ?1 AND source_path = ?2
             ORDER BY version_number DESC",
        )?;
        let rows = stmt
            .query_map(params![session_id, source_path], |row| {
                Ok(DbShadowVersion {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    source_path: row.get(2)?,
                    hash: row.get(3)?,
                    content: row.get(4)?,
                    replaced_by: row.get(5)?,
                    version_number: row.get(6)?,
                    registered_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Get a specific shadow version by hash.
pub fn get_shadow_version(
    state: &ChatDbState,
    session_id: &str,
    hash: &str,
) -> Result<Option<DbShadowVersion>, String> {
    let hash_clean = hash.trim_start_matches("h:");
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, source_path, hash, content, replaced_by, version_number, registered_at
             FROM shadow_versions
             WHERE session_id = ?1 AND (hash = ?2 OR hash LIKE ?3)
             ORDER BY version_number DESC LIMIT 1",
        )?;
        let prefix = format!("{}%", hash_clean);
        let row = stmt
            .query_row(params![session_id, hash_clean, &prefix], |row| {
                Ok(DbShadowVersion {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    source_path: row.get(2)?,
                    hash: row.get(3)?,
                    content: row.get(4)?,
                    replaced_by: row.get(5)?,
                    version_number: row.get(6)?,
                    registered_at: row.get(7)?,
                })
            })
            .optional()?;
        Ok(row)
    })
}

// ============================================================================
// Task Operations
// ============================================================================

pub fn create_task(
    state: &ChatDbState,
    id: &str,
    session_id: &str,
    parent_task_id: Option<&str>,
    title: &str,
    description: Option<&str>,
    assigned_model: Option<&str>,
    assigned_role: Option<&str>,
    context_hashes: Option<&str>,
    file_claims: Option<&str>,
) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tasks (id, session_id, parent_task_id, title, description, assigned_model, assigned_role, context_hashes, file_claims) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, session_id, parent_task_id, title, description, assigned_model, assigned_role, context_hashes, file_claims],
        )?;
        Ok(())
    })
}

pub fn get_tasks(state: &ChatDbState, session_id: &str) -> Result<Vec<DbTask>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, parent_task_id, title, description, status, assigned_model, assigned_role,
                    context_hashes, file_claims, result, error, tokens_used, cost_cents, started_at, completed_at
             FROM tasks WHERE session_id = ?1 ORDER BY rowid ASC"
        )?;
        
        let tasks = stmt.query_map([session_id], |row| {
            Ok(DbTask {
                id: row.get(0)?,
                session_id: row.get(1)?,
                parent_task_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                status: row.get(5)?,
                assigned_model: row.get(6)?,
                assigned_role: row.get(7)?,
                context_hashes: row.get(8)?,
                file_claims: row.get(9)?,
                result: row.get(10)?,
                error: row.get(11)?,
                tokens_used: row.get(12)?,
                cost_cents: row.get(13)?,
                started_at: row.get(14)?,
                completed_at: row.get(15)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        
        Ok(tasks)
    })
}

pub fn get_task(state: &ChatDbState, task_id: &str) -> Result<Option<DbTask>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, parent_task_id, title, description, status, assigned_model, assigned_role,
                    context_hashes, file_claims, result, error, tokens_used, cost_cents, started_at, completed_at
             FROM tasks WHERE id = ?1"
        )?;
        
        let task = stmt.query_row([task_id], |row| {
            Ok(DbTask {
                id: row.get(0)?,
                session_id: row.get(1)?,
                parent_task_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                status: row.get(5)?,
                assigned_model: row.get(6)?,
                assigned_role: row.get(7)?,
                context_hashes: row.get(8)?,
                file_claims: row.get(9)?,
                result: row.get(10)?,
                error: row.get(11)?,
                tokens_used: row.get(12)?,
                cost_cents: row.get(13)?,
                started_at: row.get(14)?,
                completed_at: row.get(15)?,
            })
        }).optional()?;
        
        Ok(task)
    })
}

pub fn update_task_status(state: &ChatDbState, task_id: &str, status: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        if status == "running" {
            conn.execute(
                "UPDATE tasks SET status = ?1, started_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![status, task_id],
            )?;
        } else if status == "completed" || status == "failed" || status == "cancelled" {
            conn.execute(
                "UPDATE tasks SET status = ?1, completed_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![status, task_id],
            )?;
        } else {
            conn.execute(
                "UPDATE tasks SET status = ?1 WHERE id = ?2",
                params![status, task_id],
            )?;
        };
        Ok(())
    })
}

pub fn update_task_result(state: &ChatDbState, task_id: &str, result: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE tasks SET result = ?1 WHERE id = ?2",
            params![result, task_id],
        )?;
        Ok(())
    })
}

pub fn update_task_error(state: &ChatDbState, task_id: &str, error: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE tasks SET error = ?1 WHERE id = ?2",
            params![error, task_id],
        )?;
        Ok(())
    })
}

pub fn update_task_stats(state: &ChatDbState, task_id: &str, tokens_used: i64, cost_cents: i64) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE tasks SET tokens_used = tokens_used + ?1, cost_cents = cost_cents + ?2 WHERE id = ?3",
            params![tokens_used, cost_cents, task_id],
        )?;
        Ok(())
    })
}

// ============================================================================
// Agent Stats Operations
// ============================================================================

pub fn record_agent_stats(
    state: &ChatDbState,
    session_id: &str,
    task_id: &str,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cost_cents: i64,
) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "INSERT INTO agent_stats (session_id, task_id, model, input_tokens, output_tokens, cost_cents) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, task_id, model, input_tokens, output_tokens, cost_cents],
        )?;
        Ok(())
    })
}

pub fn get_agent_stats(state: &ChatDbState, session_id: &str) -> Result<Vec<DbAgentStats>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, task_id, model, input_tokens, output_tokens, cost_cents, api_calls 
             FROM agent_stats WHERE session_id = ?1 ORDER BY id ASC"
        )?;
        
        let stats = stmt.query_map([session_id], |row| {
            Ok(DbAgentStats {
                id: row.get(0)?,
                session_id: row.get(1)?,
                task_id: row.get(2)?,
                model: row.get(3)?,
                input_tokens: row.get(4)?,
                output_tokens: row.get(5)?,
                cost_cents: row.get(6)?,
                api_calls: row.get(7)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        
        Ok(stats)
    })
}

pub fn get_session_total_stats(state: &ChatDbState, session_id: &str) -> Result<TotalStats, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), 
                    COALESCE(SUM(cost_cents), 0), COALESCE(SUM(api_calls), 0)
             FROM agent_stats WHERE session_id = ?1"
        )?;
        
        let stats = stmt.query_row([session_id], |row| {
            Ok(TotalStats {
                total_input_tokens: row.get(0)?,
                total_output_tokens: row.get(1)?,
                total_cost_cents: row.get(2)?,
                total_api_calls: row.get(3)?,
            })
        })?;
        
        Ok(stats)
    })
}

// ============================================================================
// Blackboard Notes Operations
// ============================================================================

pub fn set_blackboard_note(state: &ChatDbState, session_id: &str, key: &str, content: &str, note_state: Option<&str>, file_path: Option<&str>) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "INSERT INTO blackboard_notes (session_id, key, content, state, file_path) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, key) DO UPDATE SET content = ?3, state = COALESCE(?4, state), file_path = COALESCE(?5, file_path), updated_at = CURRENT_TIMESTAMP",
            params![session_id, key, content, note_state.unwrap_or("active"), file_path],
        )?;
        Ok(())
    })
}

pub fn get_blackboard_notes(state: &ChatDbState, session_id: &str) -> Result<Vec<DbBlackboardNote>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, key, content, created_at, updated_at, state, file_path
             FROM blackboard_notes WHERE session_id = ?1 ORDER BY created_at ASC"
        )?;
        
        let notes = stmt.query_map([session_id], |row| {
            Ok(DbBlackboardNote {
                id: row.get(0)?,
                session_id: row.get(1)?,
                key: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                state: row.get(6)?,
                file_path: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
        
        Ok(notes)
    })
}

pub fn delete_blackboard_note(state: &ChatDbState, session_id: &str, key: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "DELETE FROM blackboard_notes WHERE session_id = ?1 AND key = ?2",
            params![session_id, key],
        )?;
        Ok(())
    })
}

pub fn clear_blackboard_notes(state: &ChatDbState, session_id: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "DELETE FROM blackboard_notes WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    })
}

// ============================================================================
// Archived Chunks Operations
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct DbArchivedChunk {
    pub id: i64,
    pub session_id: String,
    pub hash: String,
    pub short_hash: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub source: Option<String>,
    pub content: String,
    pub tokens: i64,
    pub digest: Option<String>,
    pub edit_digest: Option<String>,
    pub summary: Option<String>,
    pub pinned: bool,
    pub created_at: String,
}

pub fn save_archived_chunks(
    state: &ChatDbState,
    session_id: &str,
    chunks: Vec<ArchivedChunkInput>,
) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute("DELETE FROM archived_chunks WHERE session_id = ?1", [session_id])?;
        for chunk in chunks {
            conn.execute(
                "INSERT INTO archived_chunks (session_id, hash, short_hash, type, source, content, tokens, digest, edit_digest, summary, pinned)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    session_id, chunk.hash, chunk.short_hash, chunk.entry_type,
                    chunk.source, chunk.content, chunk.tokens,
                    chunk.digest, chunk.edit_digest, chunk.summary,
                    chunk.pinned as i32
                ],
            )?;
        }
        Ok(())
    })
}

#[derive(Debug, Deserialize)]
pub struct ArchivedChunkInput {
    pub hash: String,
    pub short_hash: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub source: Option<String>,
    pub content: String,
    pub tokens: i64,
    pub digest: Option<String>,
    pub edit_digest: Option<String>,
    pub summary: Option<String>,
    pub pinned: bool,
}

pub fn get_archived_chunks(state: &ChatDbState, session_id: &str) -> Result<Vec<DbArchivedChunk>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, hash, short_hash, type, source, content, tokens, digest, edit_digest, summary, pinned, created_at
             FROM archived_chunks WHERE session_id = ?1 ORDER BY created_at ASC"
        )?;
        let entries = stmt.query_map([session_id], |row| {
            Ok(DbArchivedChunk {
                id: row.get(0)?,
                session_id: row.get(1)?,
                hash: row.get(2)?,
                short_hash: row.get(3)?,
                entry_type: row.get(4)?,
                source: row.get(5)?,
                content: row.get(6)?,
                tokens: row.get(7)?,
                digest: row.get(8)?,
                edit_digest: row.get(9)?,
                summary: row.get(10)?,
                pinned: row.get::<_, i32>(11)? != 0,
                created_at: row.get(12)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    })
}

pub fn clear_archived_chunks(state: &ChatDbState, session_id: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute("DELETE FROM archived_chunks WHERE session_id = ?1", [session_id])?;
        Ok(())
    })
}

// ============================================================================
// Session State Operations (key-value per session)
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct DbSessionState {
    pub session_id: String,
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

pub fn set_session_state(state: &ChatDbState, session_id: &str, key: &str, value: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "INSERT INTO session_state (session_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id, key) DO UPDATE SET value = ?3, updated_at = CURRENT_TIMESTAMP",
            params![session_id, key, value],
        )?;
        Ok(())
    })
}

pub fn get_session_state(state: &ChatDbState, session_id: &str, key: &str) -> Result<Option<String>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT value FROM session_state WHERE session_id = ?1 AND key = ?2"
        )?;
        let value = stmt.query_row(params![session_id, key], |row| row.get::<_, String>(0)).optional()?;
        Ok(value)
    })
}

pub fn get_all_session_state(state: &ChatDbState, session_id: &str) -> Result<Vec<DbSessionState>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT session_id, key, value, updated_at FROM session_state WHERE session_id = ?1"
        )?;
        let entries = stmt.query_map([session_id], |row| {
            Ok(DbSessionState {
                session_id: row.get(0)?,
                key: row.get(1)?,
                value: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    })
}

pub fn set_session_state_batch(state: &ChatDbState, session_id: &str, entries: Vec<(String, String)>) -> Result<(), String> {
    state.with_conn(|conn| {
        for (key, value) in entries {
            conn.execute(
                "INSERT INTO session_state (session_id, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id, key) DO UPDATE SET value = ?3, updated_at = CURRENT_TIMESTAMP",
                params![session_id, key, value],
            )?;
        }
        Ok(())
    })
}

pub fn save_memory_snapshot(state: &ChatDbState, session_id: &str, snapshot_json: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")?;
        let write_result: Result<(), rusqlite::Error> = (|| {
            conn.execute(
            "INSERT INTO session_state (session_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id, key) DO UPDATE SET value = ?3, updated_at = CURRENT_TIMESTAMP",
            params![session_id, MEMORY_SNAPSHOT_KEY, snapshot_json],
            )?;
            conn.execute(
            "UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![session_id],
            )?;
            Ok(())
        })();
        match write_result {
            Ok(()) => {
                conn.execute_batch("COMMIT;")?;
                Ok(())
            }
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    })
}

pub fn get_memory_snapshot(state: &ChatDbState, session_id: &str) -> Result<Option<String>, String> {
    get_session_state(state, session_id, MEMORY_SNAPSHOT_KEY)
}

pub fn delete_messages_after(state: &ChatDbState, session_id: &str, message_id: &str) -> Result<i64, String> {
    state.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")?;
        let result: Result<i64, rusqlite::Error> = (|| {
            conn.execute(
                "DELETE FROM segments WHERE message_id IN (
                    SELECT id FROM messages WHERE session_id = ?1 AND timestamp > (
                        SELECT timestamp FROM messages WHERE id = ?2
                    )
                )",
                params![session_id, message_id],
            )?;
            let deleted = conn.execute(
                "DELETE FROM messages WHERE session_id = ?1 AND timestamp > (
                    SELECT timestamp FROM messages WHERE id = ?2
                )",
                params![session_id, message_id],
            )?;
            conn.execute(
                "DELETE FROM session_state WHERE session_id = ?1
                 AND key LIKE '__restore_point__%'
                 AND key NOT IN (
                     SELECT '__restore_point__' || id FROM messages WHERE session_id = ?1
                 )",
                params![session_id],
            )?;
            Ok(deleted as i64)
        })();
        match result {
            Ok(count) => {
                conn.execute_batch("COMMIT;")?;
                Ok(count)
            }
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    })
}

pub fn delete_messages_from(state: &ChatDbState, session_id: &str, message_id: &str) -> Result<i64, String> {
    state.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")?;
        let result: Result<i64, rusqlite::Error> = (|| {
            conn.execute(
                "DELETE FROM segments WHERE message_id IN (
                    SELECT id FROM messages WHERE session_id = ?1 AND timestamp >= (
                        SELECT timestamp FROM messages WHERE id = ?2
                    )
                )",
                params![session_id, message_id],
            )?;
            let deleted = conn.execute(
                "DELETE FROM messages WHERE session_id = ?1 AND timestamp >= (
                    SELECT timestamp FROM messages WHERE id = ?2
                )",
                params![session_id, message_id],
            )?;
            conn.execute(
                "DELETE FROM session_state WHERE session_id = ?1
                 AND key LIKE '__restore_point__%'
                 AND key NOT IN (
                     SELECT '__restore_point__' || id FROM messages WHERE session_id = ?1
                 )",
                params![session_id],
            )?;
            Ok(deleted as i64)
        })();
        match result {
            Ok(count) => {
                conn.execute_batch("COMMIT;")?;
                Ok(count)
            }
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    })
}

pub fn update_message_content(state: &ChatDbState, message_id: &str, content: &str) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute(
            "UPDATE messages SET content = ?2 WHERE id = ?1",
            params![message_id, content],
        )?;
        Ok(())
    })
}

// ============================================================================
// Staged Snippets Operations
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct DbStagedSnippet {
    pub id: i64,
    pub session_id: String,
    pub key: String,
    pub content: String,
    pub source: Option<String>,
    pub lines: Option<String>,
    pub tokens: i64,
    pub source_revision: Option<String>,
    pub shape_spec: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct StagedSnippetInput {
    pub key: String,
    pub content: String,
    pub source: Option<String>,
    pub lines: Option<String>,
    pub tokens: i64,
    pub source_revision: Option<String>,
    pub shape_spec: Option<String>,
}

pub fn save_staged_snippets(
    state: &ChatDbState,
    session_id: &str,
    snippets: Vec<StagedSnippetInput>,
) -> Result<(), String> {
    state.with_conn(|conn| {
        conn.execute("DELETE FROM staged_snippets WHERE session_id = ?1", [session_id])?;
        for s in snippets {
            conn.execute(
                "INSERT INTO staged_snippets (session_id, key, content, source, lines, tokens, source_revision, shape_spec)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    session_id,
                    s.key,
                    s.content,
                    s.source,
                    s.lines,
                    s.tokens,
                    s.source_revision,
                    s.shape_spec,
                ],
            )?;
        }
        Ok(())
    })
}

pub fn get_staged_snippets(state: &ChatDbState, session_id: &str) -> Result<Vec<DbStagedSnippet>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, key, content, source, lines, tokens, source_revision, shape_spec, created_at
             FROM staged_snippets WHERE session_id = ?1 ORDER BY created_at ASC"
        )?;
        let entries = stmt.query_map([session_id], |row| {
            Ok(DbStagedSnippet {
                id: row.get(0)?,
                session_id: row.get(1)?,
                key: row.get(2)?,
                content: row.get(3)?,
                source: row.get(4)?,
                lines: row.get(5)?,
                tokens: row.get(6)?,
                source_revision: row.get(7).ok().flatten(),
                shape_spec: row.get(8).ok().flatten(),
                created_at: row.get(9)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    })
}

