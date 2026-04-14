//! Graph traversal over `file_relations` (imports) and `symbol_relations` (calls).

use crate::query::{QueryEngine, QueryError};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

/// One hop in the file import graph.
#[derive(Debug, Clone, Serialize)]
pub struct FileGraphEdge {
    pub from_path: String,
    pub to_path: String,
    pub relation_type: String,
}

/// A symbol node in the call graph.
#[derive(Debug, Clone, Serialize)]
pub struct SymbolGraphNode {
    pub symbol_id: i64,
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: u32,
}

/// An edge in the symbol call graph.
#[derive(Debug, Clone, Serialize)]
pub struct SymbolGraphEdge {
    pub from_id: i64,
    pub from_name: String,
    pub to_id: i64,
    pub to_name: String,
}

impl QueryEngine {
    /// Files reachable via `IMPORTS` from `start_path` up to `max_depth` (inclusive).
    pub fn graph_transitive_imports(
        &self,
        start_path: &str,
        max_depth: u32,
    ) -> Result<Vec<String>, QueryError> {
        let conn = self.conn();
        let depth_cap = max_depth.max(1).min(50) as i64;
        let norm = start_path.replace('\\', "/");
        let mut stmt = conn.prepare(
            r#"
            WITH RECURSIVE r(to_id, depth) AS (
                SELECT fr.to_file_id, 1
                FROM file_relations fr
                JOIN files f ON f.id = fr.from_file_id
                WHERE f.path = ?1 COLLATE NOCASE
                  AND fr.type = 'IMPORTS'
                UNION ALL
                SELECT fr.to_file_id, r.depth + 1
                FROM file_relations fr
                JOIN r ON fr.from_file_id = r.to_id
                WHERE fr.type = 'IMPORTS'
                  AND r.depth < ?2
            )
            SELECT DISTINCT f.path FROM r JOIN files f ON f.id = r.to_id
            "#,
        )?;
        let rows = stmt.query_map(params![norm.as_str(), depth_cap], |row| {
            row.get::<_, String>(0)
        })?;
        let mut out: Vec<String> = rows.filter_map(|r| r.ok()).collect();
        out.sort();
        out.dedup();
        Ok(out)
    }

    /// Files that transitively import `start_path` up to `max_depth`.
    pub fn graph_transitive_dependents(
        &self,
        start_path: &str,
        max_depth: u32,
    ) -> Result<Vec<String>, QueryError> {
        let conn = self.conn();
        let depth_cap = max_depth.max(1).min(50) as i64;
        let norm = start_path.replace('\\', "/");
        let mut stmt = conn.prepare(
            r#"
            WITH RECURSIVE r(from_id, depth) AS (
                SELECT fr.from_file_id, 1
                FROM file_relations fr
                JOIN files f ON f.id = fr.to_file_id
                WHERE f.path = ?1 COLLATE NOCASE
                  AND fr.type = 'IMPORTS'
                UNION ALL
                SELECT fr.from_file_id, r.depth + 1
                FROM file_relations fr
                JOIN r ON fr.to_file_id = r.from_id
                WHERE fr.type = 'IMPORTS'
                  AND r.depth < ?2
            )
            SELECT DISTINCT f.path FROM r JOIN files f ON f.id = r.from_id
            "#,
        )?;
        let rows = stmt.query_map(params![norm.as_str(), depth_cap], |row| {
            row.get::<_, String>(0)
        })?;
        let mut out: Vec<String> = rows.filter_map(|r| r.ok()).collect();
        out.sort();
        out.dedup();
        Ok(out)
    }

    /// BFS shortest import chain from `from_path` to `to_path` (ordered list of file paths).
    pub fn graph_shortest_import_path(
        &self,
        from_path: &str,
        to_path: &str,
    ) -> Result<Option<Vec<String>>, QueryError> {
        let conn = self.conn();
        let from = from_path.replace('\\', "/");
        let to = to_path.replace('\\', "/");

        let mut stmt = conn.prepare(
            r#"
            WITH RECURSIVE bfs(curr_path, chain, depth) AS (
                SELECT REPLACE(f.path, CHAR(92), '/'),
                       '>' || REPLACE(f.path, CHAR(92), '/') || '>',
                       0
                FROM files f
                WHERE REPLACE(f.path, CHAR(92), '/') = ?1 COLLATE NOCASE
                UNION ALL
                SELECT REPLACE(f2.path, CHAR(92), '/'),
                       b.chain || REPLACE(f2.path, CHAR(92), '/') || '>',
                       b.depth + 1
                FROM bfs b
                JOIN files fcur ON REPLACE(fcur.path, CHAR(92), '/') = b.curr_path COLLATE NOCASE
                JOIN file_relations fr ON fr.from_file_id = fcur.id AND fr.type = 'IMPORTS'
                JOIN files f2 ON f2.id = fr.to_file_id
                WHERE b.depth < 40
                  AND instr(b.chain, '>' || REPLACE(f2.path, CHAR(92), '/') || '>') = 0
            )
            SELECT chain, depth FROM bfs
            WHERE REPLACE(curr_path, CHAR(92), '/') = ?2 COLLATE NOCASE
            ORDER BY depth ASC
            LIMIT 1
            "#,
        )?;

        let found: Option<(String, i64)> = stmt
            .query_row(params![from.as_str(), to.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()?;

        Ok(found.map(|(chain, _)| {
            chain
                .trim_matches('>')
                .split('>')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        }))
    }

    /// Direct import edges from or to a file (one hop).
    pub fn graph_file_neighbors(&self, path: &str) -> Result<Vec<FileGraphEdge>, QueryError> {
        let conn = self.conn();
        let norm = path.replace('\\', "/");
        let mut out = Vec::new();

        let mut stmt = conn.prepare(
            r#"
            SELECT f1.path, f2.path, fr.type
            FROM file_relations fr
            JOIN files f1 ON f1.id = fr.from_file_id
            JOIN files f2 ON f2.id = fr.to_file_id
            WHERE REPLACE(f1.path, '\', '/') = ?1 COLLATE NOCASE
            "#,
        )?;
        for row in stmt.query_map(params![norm.as_str()], |row| {
            Ok(FileGraphEdge {
                from_path: row.get(0)?,
                to_path: row.get(1)?,
                relation_type: row.get(2)?,
            })
        })? {
            out.push(row?);
        }

        let mut stmt2 = conn.prepare(
            r#"
            SELECT f1.path, f2.path, fr.type
            FROM file_relations fr
            JOIN files f1 ON f1.id = fr.from_file_id
            JOIN files f2 ON f2.id = fr.to_file_id
            WHERE REPLACE(f2.path, CHAR(92), '/') = ?1 COLLATE NOCASE
            "#,
        )?;
        for row in stmt2.query_map(params![norm.as_str()], |row| {
            Ok(FileGraphEdge {
                from_path: row.get(0)?,
                to_path: row.get(1)?,
                relation_type: row.get(2)?,
            })
        })? {
            out.push(row?);
        }

        Ok(out)
    }

    // -----------------------------------------------------------------------
    // Symbol call graph (traverses `symbol_relations` WHERE type = 'CALLS')
    // -----------------------------------------------------------------------

    /// Resolve a symbol name to its ID (first match by name, optionally scoped to a file).
    pub fn resolve_symbol_id(
        &self,
        name: &str,
        file_hint: Option<&str>,
    ) -> Result<Option<i64>, QueryError> {
        let conn = self.conn();
        if let Some(fh) = file_hint {
            let norm = fh.replace('\\', "/");
            let id: Option<i64> = conn
                .query_row(
                    "SELECT s.id FROM symbols s JOIN files f ON s.file_id = f.id
                     WHERE s.name = ?1 AND REPLACE(f.path, CHAR(92), '/') = ?2 COLLATE NOCASE
                     LIMIT 1",
                    params![name, norm],
                    |row| row.get(0),
                )
                .optional()?;
            if id.is_some() {
                return Ok(id);
            }
        }
        Ok(conn
            .query_row(
                "SELECT id FROM symbols WHERE name = ?1 LIMIT 1",
                params![name],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Symbols transitively called by `symbol_id` up to `max_depth`.
    pub fn graph_symbol_callees(
        &self,
        symbol_id: i64,
        max_depth: u32,
    ) -> Result<Vec<SymbolGraphNode>, QueryError> {
        let conn = self.conn();
        let cap = max_depth.max(1).min(30) as i64;
        let mut stmt = conn.prepare(
            r#"
            WITH RECURSIVE callees(sid, depth) AS (
                SELECT sr.to_symbol_id, 1
                FROM symbol_relations sr
                WHERE sr.from_symbol_id = ?1 AND sr.type = 'CALLS'
                UNION
                SELECT sr.to_symbol_id, c.depth + 1
                FROM symbol_relations sr
                JOIN callees c ON sr.from_symbol_id = c.sid
                WHERE sr.type = 'CALLS' AND c.depth < ?2
            )
            SELECT DISTINCT s.id, s.name, s.kind, f.path, s.line
            FROM callees c
            JOIN symbols s ON s.id = c.sid
            JOIN files f ON f.id = s.file_id
            ORDER BY s.name
            "#,
        )?;
        let rows = stmt.query_map(params![symbol_id, cap], |row| {
            Ok(SymbolGraphNode {
                symbol_id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                file: row.get(3)?,
                line: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(QueryError::from)
    }

    /// Symbols that transitively call `symbol_id` up to `max_depth`.
    pub fn graph_symbol_callers(
        &self,
        symbol_id: i64,
        max_depth: u32,
    ) -> Result<Vec<SymbolGraphNode>, QueryError> {
        let conn = self.conn();
        let cap = max_depth.max(1).min(30) as i64;
        let mut stmt = conn.prepare(
            r#"
            WITH RECURSIVE callers(sid, depth) AS (
                SELECT sr.from_symbol_id, 1
                FROM symbol_relations sr
                WHERE sr.to_symbol_id = ?1 AND sr.type = 'CALLS'
                UNION
                SELECT sr.from_symbol_id, c.depth + 1
                FROM symbol_relations sr
                JOIN callers c ON sr.to_symbol_id = c.sid
                WHERE sr.type = 'CALLS' AND c.depth < ?2
            )
            SELECT DISTINCT s.id, s.name, s.kind, f.path, s.line
            FROM callers c
            JOIN symbols s ON s.id = c.sid
            JOIN files f ON f.id = s.file_id
            ORDER BY s.name
            "#,
        )?;
        let rows = stmt.query_map(params![symbol_id, cap], |row| {
            Ok(SymbolGraphNode {
                symbol_id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                file: row.get(3)?,
                line: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(QueryError::from)
    }

    /// Subgraph of nodes and edges reachable from a set of seed symbol IDs
    /// (both callers and callees up to `max_depth`).
    pub fn graph_symbol_subgraph(
        &self,
        seed_ids: &[i64],
        max_depth: u32,
    ) -> Result<(Vec<SymbolGraphNode>, Vec<SymbolGraphEdge>), QueryError> {
        use std::collections::HashSet;

        let mut node_ids = HashSet::new();
        let mut nodes = Vec::new();

        for &sid in seed_ids {
            node_ids.insert(sid);
            for n in self.graph_symbol_callees(sid, max_depth)? {
                if node_ids.insert(n.symbol_id) {
                    nodes.push(n);
                }
            }
            for n in self.graph_symbol_callers(sid, max_depth)? {
                if node_ids.insert(n.symbol_id) {
                    nodes.push(n);
                }
            }
        }

        // Add seed nodes themselves if not already present from traversal
        let conn = self.conn();
        for &sid in seed_ids {
            if !nodes.iter().any(|n| n.symbol_id == sid) {
                if let Some(n) = conn
                    .query_row(
                        "SELECT s.id, s.name, s.kind, f.path, s.line
                         FROM symbols s JOIN files f ON f.id = s.file_id
                         WHERE s.id = ?1",
                        params![sid],
                        |row| {
                            Ok(SymbolGraphNode {
                                symbol_id: row.get(0)?,
                                name: row.get(1)?,
                                kind: row.get(2)?,
                                file: row.get(3)?,
                                line: row.get(4)?,
                            })
                        },
                    )
                    .optional()?
                {
                    nodes.push(n);
                }
            }
        }

        // Collect edges between all discovered nodes
        let id_list: Vec<String> = node_ids.iter().map(|id| id.to_string()).collect();
        if id_list.is_empty() {
            return Ok((nodes, Vec::new()));
        }
        let placeholders = id_list.join(",");
        let sql = format!(
            "SELECT sr.from_symbol_id, s1.name, sr.to_symbol_id, s2.name
             FROM symbol_relations sr
             JOIN symbols s1 ON s1.id = sr.from_symbol_id
             JOIN symbols s2 ON s2.id = sr.to_symbol_id
             WHERE sr.type = 'CALLS'
               AND sr.from_symbol_id IN ({p})
               AND sr.to_symbol_id IN ({p})",
            p = placeholders,
        );
        let mut stmt = conn.prepare(&sql)?;
        let edges: Vec<SymbolGraphEdge> = stmt
            .query_map([], |row| {
                Ok(SymbolGraphEdge {
                    from_id: row.get(0)?,
                    from_name: row.get(1)?,
                    to_id: row.get(2)?,
                    to_name: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok((nodes, edges))
    }
}
