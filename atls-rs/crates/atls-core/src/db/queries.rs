use rusqlite::{Connection, Result as SqliteResult};
use crate::file::{FileInfo, FileRelationType, Language};
use crate::symbol::SymbolRelationType;
use crate::types::*;
use std::path::PathBuf;

/// Prepared query helpers for common database operations
pub struct Queries;

impl Queries {
    /// Insert a file record and return its ID
    pub fn insert_file(
        conn: &Connection,
        path: &PathBuf,
        hash: &str,
        language: &Language,
        line_count: Option<u32>,
    ) -> SqliteResult<i64> {
        let mut stmt = conn.prepare(
            "INSERT INTO files (path, hash, language, line_count) VALUES (?, ?, ?, ?)"
        )?;
        let path_str = path.to_string_lossy();
        let language_str = language.as_str();
        stmt.execute(rusqlite::params![path_str, hash, language_str, line_count])?;
        Ok(conn.last_insert_rowid())
    }

    /// Get a file by path (handles both forward and backward slashes)
    /// Also handles Windows extended-length path prefix (\\?\)
    pub fn get_file_by_path(conn: &Connection, path: &PathBuf) -> SqliteResult<Option<FileInfo>> {
        let path_str = path.to_string_lossy();
        // Strip Windows extended-length path prefix (\\?\) if present
        let clean_str = path_str.strip_prefix(r"\\?\").unwrap_or(&path_str);
        // Try both slash variants for cross-platform compatibility
        let path_forward = clean_str.replace('\\', "/");
        let path_backward = clean_str.replace('/', "\\");
        
        let mut stmt = conn.prepare(
            "SELECT id, path, hash, language, last_indexed, line_count FROM files WHERE path = ? OR path = ? OR path = ?"
        )?;
        
        let mut rows = stmt.query_map([clean_str, path_forward.as_str(), path_backward.as_str()], |row| {
            Ok(FileInfo {
                id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
                hash: row.get(2)?,
                language: Language::from_str(&row.get::<_, String>(3)?),
                last_indexed: {
                    let dt_str = row.get::<_, String>(4)?;
                    chrono::NaiveDateTime::parse_from_str(&dt_str, "%Y-%m-%d %H:%M:%S")
                        .map(|dt| chrono::DateTime::from_naive_utc_and_offset(dt, chrono::Utc))
                        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&dt_str)
                            .map(|dt| dt.with_timezone(&chrono::Utc)))
                        .unwrap_or_else(|_| chrono::Utc::now())
                },
                line_count: row.get(5)?,
            })
        })?;

        match rows.next() {
            Some(row) => row.map(Some),
            None => Ok(None),
        }
    }

    /// Insert a symbol record and return its ID
    pub fn insert_symbol(
        conn: &Connection,
        file_id: i64,
        symbol: &ParsedSymbol,
    ) -> SqliteResult<i64> {
        let metadata_json = serde_json::to_string(&symbol.metadata).ok();
        let mut stmt = conn.prepare(
            "INSERT INTO symbols (file_id, name, kind, line, end_line, signature, complexity, metadata, body_preview) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )?;
        stmt.execute(rusqlite::params![
            file_id,
            symbol.name,
            symbol.kind.as_str(),
            symbol.line,
            symbol.end_line,
            symbol.signature,
            symbol.complexity.unwrap_or(0),
            metadata_json,
            symbol.body_preview.as_deref().unwrap_or("")
        ])?;
        Ok(conn.last_insert_rowid())
    }

    /// Insert an issue record and return its ID
    pub fn insert_issue(
        conn: &Connection,
        file_id: i64,
        issue: &ParsedIssue,
        category: &str,
        data: Option<&serde_json::Value>,
    ) -> SqliteResult<i64> {
        let data_json = data.and_then(|d| serde_json::to_string(d).ok());
        let mut stmt = conn.prepare(
            "INSERT INTO code_issues (file_id, type, severity, message, line, col, end_line, end_col, category, data) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )?;
        stmt.execute(rusqlite::params![
            file_id,
            issue.pattern_id,
            format!("{:?}", issue.severity).to_lowercase(),
            issue.message,
            issue.line,
            issue.col,
            issue.end_line,
            issue.end_col,
            category,
            data_json
        ])?;
        Ok(conn.last_insert_rowid())
    }

    /// Insert a file relation
    pub fn insert_file_relation(
        conn: &Connection,
        from_file_id: i64,
        to_file_id: i64,
        relation_type: &FileRelationType,
    ) -> SqliteResult<i64> {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO file_relations (from_file_id, to_file_id, type) 
             VALUES (?, ?, ?)"
        )?;
        stmt.execute(rusqlite::params![
            from_file_id,
            to_file_id,
            relation_type.as_str()
        ])?;
        Ok(conn.last_insert_rowid())
    }

    /// Insert a symbol relation
    pub fn insert_symbol_relation(
        conn: &Connection,
        from_symbol_id: i64,
        to_symbol_id: i64,
        relation_type: &SymbolRelationType,
    ) -> SqliteResult<i64> {
        let mut stmt = conn.prepare(
            "INSERT INTO symbol_relations (from_symbol_id, to_symbol_id, type) 
             VALUES (?, ?, ?)"
        )?;
        stmt.execute(rusqlite::params![
            from_symbol_id,
            to_symbol_id,
            format!("{:?}", relation_type).to_uppercase()
        ])?;
        Ok(conn.last_insert_rowid())
    }

    /// Delete a file and all its related records (cascade)
    pub fn delete_file(conn: &Connection, file_id: i64) -> SqliteResult<()> {
        conn.execute("DELETE FROM files WHERE id = ?", [file_id])?;
        Ok(())
    }

    /// Update file's last_indexed timestamp
    pub fn update_file_indexed(conn: &Connection, file_id: i64) -> SqliteResult<()> {
        conn.execute(
            "UPDATE files SET last_indexed = CURRENT_TIMESTAMP WHERE id = ?",
            [file_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Queries;
    use crate::db::Database;
    use crate::file::FileRelationType;
    use crate::symbol::SymbolRelationType;
    use crate::types::{IssueSeverity, Language, ParsedIssue, ParsedSymbol, SymbolKind, SymbolMetadata};
    use std::path::PathBuf;

    fn sample_symbol() -> ParsedSymbol {
        ParsedSymbol {
            name: "foo".into(),
            kind: SymbolKind::Function,
            line: 1,
            end_line: None,
            scope_id: None,
            signature: Some("fn foo()".into()),
            complexity: Some(1),
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility: None,
                modifiers: None,
                parent_symbol: None,
                extends: None,
                implements: None,
            },
        }
    }

    #[test]
    fn insert_get_file_path_slash_variants() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let path = PathBuf::from("src/a/b.rs");
        let id = Queries::insert_file(&conn, &path, "deadbeef", &Language::Rust, Some(10)).unwrap();
        assert_eq!(id, 1);

        let back = Queries::get_file_by_path(&conn, &PathBuf::from("src\\a\\b.rs"))
            .unwrap()
            .expect("row");
        assert_eq!(back.hash, "deadbeef");
        assert_eq!(back.language, Language::Rust);
        assert_eq!(back.line_count, Some(10));
    }

    #[test]
    fn insert_symbol_issue_relations_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let fid = Queries::insert_file(
            &conn,
            &PathBuf::from("lib.rs"),
            "abc",
            &Language::Rust,
            None,
        )
        .unwrap();
        let sid1 = Queries::insert_symbol(&conn, fid, &sample_symbol()).unwrap();
        let mut sym2 = sample_symbol();
        sym2.name = "bar".into();
        sym2.line = 3;
        let sid2 = Queries::insert_symbol(&conn, fid, &sym2).unwrap();

        let issue = ParsedIssue {
            pattern_id: "p1".into(),
            severity: IssueSeverity::Medium,
            message: "m".into(),
            line: 2,
            col: 0,
            end_line: None,
            end_col: None,
            file_path: None,
        };
        let iid = Queries::insert_issue(&conn, fid, &issue, "cat", None).unwrap();
        assert!(iid > 0);

        let fid2 = Queries::insert_file(&conn, &PathBuf::from("dep.rs"), "def", &Language::Rust, None).unwrap();
        Queries::insert_file_relation(&conn, fid, fid2, &FileRelationType::Imports).unwrap();
        Queries::insert_symbol_relation(&conn, sid1, sid2, &SymbolRelationType::Calls).unwrap();

        Queries::update_file_indexed(&conn, fid).unwrap();
        Queries::delete_file(&conn, fid2).unwrap();
    }
}
