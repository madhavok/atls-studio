use crate::query::{QueryEngine, QueryError};
use crate::file::FileInfo;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// File graph information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileGraph {
    pub file: FileInfo,
    pub incoming: Vec<FileRelationInfo>,
    pub outgoing: Vec<FileRelationInfo>,
    pub symbols: Vec<SymbolInfo>,
}

/// File relation information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileRelationInfo {
    pub path: String,
    pub relation_type: String,
}

/// Symbol information for file graph
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymbolInfo {
    pub name: String,
    pub kind: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
}

/// Subsystem/module information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SubsystemInfo {
    pub name: String,
    pub description: String,
    pub files: usize,
    pub internal_coupling: f64,
    pub internal_edges: usize,
    pub external_edges: usize,
    pub sample_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross_deps: Option<Vec<CrossSubsystemDep>>,
}

/// Cross-subsystem dependency
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CrossSubsystemDep {
    pub from: String,
    pub to: String,
    pub count: usize,
}

/// Related file information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RelatedFile {
    pub path: String,
    pub relation: String,
    pub depth: u32,
}

/// Change impact analysis result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChangeImpact {
    pub target_files: Vec<String>,
    pub direct_dependents: Vec<ImpactedFile>,
    pub indirect_dependents: Vec<ImpactedFile>,
    pub affected_symbols: Vec<AffectedSymbol>,
    pub summary: ImpactSummary,
}

/// A file affected by the change
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImpactedFile {
    pub path: String,
    pub impact_type: String,
    pub symbols_affected: usize,
}

/// A symbol affected by the change
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AffectedSymbol {
    pub name: String,
    pub file: String,
    pub kind: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
}

/// Summary of change impact
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImpactSummary {
    pub direct_files: usize,
    pub indirect_files: usize,
    pub total_files: usize,
    pub symbols_affected: usize,
    pub risk_level: String,
}

const MAX_QUERY_LIMIT: usize = 1000;
const DEFAULT_RELATED_FILES_LIMIT: usize = 10;
const MAX_CONTEXT_DEPTH: u32 = 8;

/// Parse the first N lines of a file for import/include/use statements across all supported
/// languages: JS/TS, Rust, Python, Go, C/C++, Java, C#.  Returns deduplicated module strings.
pub fn parse_imports_from_content(content: &str, max_lines: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut modules = Vec::new();
    let mut in_go_import_block = false;
    // Rust `use path::{…};` that opens `{` on one line and closes on another:
    // collect all lines until the matching `}` (with `;`), then parse once.
    let mut rust_use_buf: Option<String> = None;
    let mut rust_use_depth: i32 = 0;

    for line in content.lines().take(max_lines) {
        let trimmed = line.trim();

        // Continuation of a multi-line Rust `use`: accumulate until braces balance.
        if let Some(buf) = rust_use_buf.as_mut() {
            buf.push(' ');
            buf.push_str(trimmed);
            for c in trimmed.chars() {
                match c {
                    '{' => rust_use_depth += 1,
                    '}' => rust_use_depth -= 1,
                    _ => {}
                }
            }
            if rust_use_depth <= 0 && trimmed.ends_with(';') {
                let full = rust_use_buf.take().unwrap_or_default();
                rust_use_depth = 0;
                let body = full.trim().trim_start_matches("use").trim().trim_end_matches(';').trim();
                let module_str = if let Some(open) = body.find('{') {
                    body[..open].trim_end_matches("::").trim().to_string()
                } else {
                    body.to_string()
                };
                if !module_str.is_empty() && seen.insert(module_str.clone()) {
                    modules.push(module_str);
                }
            }
            continue;
        }

        // Track Go multi-line import blocks: import ( ... )
        if in_go_import_block {
            if trimmed == ")" {
                in_go_import_block = false;
                continue;
            }
            let m = trimmed.trim_matches(|c: char| c == '"' || c == ' ' || c == '\t');
            if !m.is_empty() && m != "(" {
                let s = m.to_string();
                if seen.insert(s.clone()) {
                    modules.push(s);
                }
            }
            continue;
        }

        if trimmed == "import (" {
            in_go_import_block = true;
            continue;
        }

        // Rust: open a multi-line `use` buffer when the statement starts here
        // but `{` does not close on this line (no matching `}` with `;`).
        if trimmed.starts_with("use ") && !trimmed.starts_with("use strict") {
            let opens = trimmed.chars().filter(|&c| c == '{').count() as i32;
            let closes = trimmed.chars().filter(|&c| c == '}').count() as i32;
            if opens > closes || (opens > 0 && !trimmed.ends_with(';')) {
                rust_use_buf = Some(trimmed.to_string());
                rust_use_depth = opens - closes;
                continue;
            }
        }

        let module = if (trimmed.starts_with("import ") || trimmed.starts_with("import{")) && trimmed.contains("from ") {
            // JS/TS: import ... from 'module'
            trimmed.rfind("from ").map(|idx| {
                trimmed[idx + 5..].trim_matches(|c: char| c == '\'' || c == '"' || c == ';' || c == ' ').to_string()
            })
        } else if trimmed.starts_with("import \"") {
            // Go single import: import "fmt"
            trimmed.strip_prefix("import \"")
                .and_then(|s| s.strip_suffix('"'))
                .map(|s| s.to_string())
        } else if trimmed.starts_with("use ") && !trimmed.starts_with("use strict") {
            // Rust: use crate::module;
            Some(trimmed["use ".len()..].trim_end_matches(';').trim().to_string())
        } else if trimmed.starts_with("from ") && trimmed.contains(" import ") {
            // Python: from module import name
            trimmed.splitn(3, ' ').nth(1).map(|s| s.to_string())
        } else if trimmed.starts_with("#include \"") {
            // C/C++ local include: #include "header.h"
            trimmed.strip_prefix("#include \"")
                .and_then(|s| s.strip_suffix('"'))
                .map(|s| s.to_string())
        } else if trimmed.starts_with("import ") && !trimmed.contains("from ") && trimmed.contains('.') {
            // Java: import com.example.Class;
            Some(trimmed["import ".len()..].trim_end_matches(';').trim().to_string())
        } else if trimmed.starts_with("using ") && trimmed.contains('.') && !trimmed.contains('(') {
            // C#: using System.Collections.Generic;  (exclude using statements with parens)
            Some(trimmed["using ".len()..].trim_end_matches(';').trim().to_string())
        } else {
            None
        };

        if let Some(m) = module {
            if !m.is_empty() && seen.insert(m.clone()) {
                modules.push(m);
            }
        }
    }

    modules
}

impl QueryEngine {
    /// Get file graph (incoming/outgoing relations and symbols)
    pub fn get_file_graph(
        &self,
        file_path: &str,
        limit: usize,
    ) -> Result<Option<FileGraph>, QueryError> {
        let conn = self.db.conn();
        let normalized_path = file_path.replace('\\', "/");

        // Get file info
        let file = crate::db::queries::Queries::get_file_by_path(&*conn, &PathBuf::from(&normalized_path))?;
        let file = match file {
            Some(f) => f,
            None => return Ok(None),
        };

        let safe_limit = limit.min(MAX_QUERY_LIMIT).max(1);

        // Get incoming relations
        let mut incoming_stmt = conn.prepare(
            "SELECT f.path, fr.type
             FROM file_relations fr
             JOIN files f ON fr.from_file_id = f.id
             WHERE fr.to_file_id = ?
             LIMIT ?"
        )?;

        let incoming_rows = incoming_stmt.query_map([file.id, safe_limit as i64], |row| {
            Ok(FileRelationInfo {
                path: row.get(0)?,
                relation_type: row.get(1)?,
            })
        })?;

        let mut incoming = Vec::new();
        for row in incoming_rows {
            incoming.push(row?);
        }

        // Get outgoing relations
        let mut outgoing_stmt = conn.prepare(
            "SELECT f.path, fr.type
             FROM file_relations fr
             JOIN files f ON fr.to_file_id = f.id
             WHERE fr.from_file_id = ?
             LIMIT ?"
        )?;

        let outgoing_rows = outgoing_stmt.query_map([file.id, safe_limit as i64], |row| {
            Ok(FileRelationInfo {
                path: row.get(0)?,
                relation_type: row.get(1)?,
            })
        })?;

        let mut outgoing = Vec::new();
        for row in outgoing_rows {
            outgoing.push(row?);
        }

        // Fallback: if no file_relations, derive outgoing edges from import statements in file content
        if incoming.is_empty() && outgoing.is_empty() {
            let full_path = std::path::PathBuf::from(&normalized_path);
            if let Ok(content) = std::fs::read_to_string(&full_path) {
                for m in parse_imports_from_content(&content, 150) {
                    outgoing.push(FileRelationInfo {
                        path: m,
                        relation_type: "IMPORTS".to_string(),
                    });
                }
            }
        }

        // Get symbols (DISTINCT to avoid duplicate entries from multiple index passes)
        let mut symbols_stmt = conn.prepare(
            "SELECT DISTINCT name, kind, line, end_line FROM symbols WHERE file_id = ?"
        )?;

        let symbols_rows = symbols_stmt.query_map([file.id], |row| {
            Ok(SymbolInfo {
                name: row.get(0)?,
                kind: row.get(1)?,
                line: row.get(2)?,
                end_line: row.get(3)?,
            })
        })?;

        let mut symbols = Vec::new();
        for row in symbols_rows {
            symbols.push(row?);
        }

        Ok(Some(FileGraph {
            file,
            incoming,
            outgoing,
            symbols,
        }))
    }

    /// Get subsystems using import cluster analysis
    pub fn get_subsystems(&self, depth: u32) -> Result<Vec<SubsystemInfo>, QueryError> {
        let conn = self.db.conn();
        let depth = depth.min(3).max(1);

        // Get all files with their IDs
        let mut files_stmt = conn.prepare("SELECT id, path FROM files")?;
        let files_rows = files_stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut file_id_to_path = HashMap::new();
        for row in files_rows {
            let (id, path) = row?;
            file_id_to_path.insert(id, path);
        }
        // Get all import relations
        let mut relations_stmt = conn.prepare(
            "SELECT from_file_id, to_file_id FROM file_relations WHERE type = 'IMPORTS'"
        )?;
        let relations_rows = relations_stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;

        let mut relations = Vec::new();
        for row in relations_rows {
            relations.push(row?);
        }

        // Group files by top-level directory
        let mut clusters: HashMap<String, HashSet<i64>> = HashMap::new();

        for (file_id, path) in &file_id_to_path {
            let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
            
            // Skip files at root level or in common non-subsystem directories
            if parts.len() < 2 {
                continue;
            }
            if parts[0] == "node_modules" || parts[0] == "dist" || parts[0] == "build" {
                continue;
            }

            // Use src/X or top-level X as subsystem name
            let key = if parts[0] == "src" && parts.len() >= 2 {
                parts[..(depth as usize + 1).min(parts.len() - 1)].join("/")
            } else {
                parts[..(depth as usize).min(parts.len() - 1)].join("/")
            };

            clusters.entry(key).or_insert_with(HashSet::new).insert(*file_id);
        }

        // Filter out tiny clusters (less than 3 files)
        let significant_clusters: Vec<_> = clusters
            .into_iter()
            .filter(|(_, file_ids)| file_ids.len() >= 3)
            .collect();

        // Calculate metrics for each subsystem
        let mut subsystems = Vec::new();

        for (name, file_ids) in &significant_clusters {
            let mut internal_edges = 0;
            let mut external_edges = 0;
            let mut external_deps: HashMap<String, usize> = HashMap::new();

            for (from_id, to_id) in &relations {
                let from_in_cluster = file_ids.contains(from_id);
                let to_in_cluster = file_ids.contains(to_id);

                if from_in_cluster && to_in_cluster {
                    internal_edges += 1;
                } else if from_in_cluster && !to_in_cluster {
                    external_edges += 1;
                    // Find which subsystem this goes to
                    if let Some(_to_path) = file_id_to_path.get(to_id) {
                        for (other_name, other_file_ids) in &significant_clusters {
                            if other_name != name && other_file_ids.contains(to_id) {
                                *external_deps.entry(other_name.clone()).or_insert(0) += 1;
                                break;
                            }
                        }
                    }
                }
            }

            // Calculate coupling ratio
            let total_edges = internal_edges + external_edges;
            let internal_coupling = if total_edges > 0 {
                (internal_edges as f64 / total_edges as f64 * 100.0).round() / 100.0
            } else {
                1.0
            };

            // Get sample files
            let sample_files: Vec<String> = file_ids
                .iter()
                .take(DEFAULT_RELATED_FILES_LIMIT)
                .filter_map(|id| file_id_to_path.get(id).cloned())
                .collect();

            // Generate description
            let description = self.generate_subsystem_description(name, &sample_files);

            // Track cross-subsystem dependencies
            let mut cross_deps = Vec::new();
            for (to_subsystem, count) in external_deps {
                if count >= 2 {
                    cross_deps.push(CrossSubsystemDep {
                        from: name.clone(),
                        to: to_subsystem,
                        count,
                    });
                }
            }

            subsystems.push(SubsystemInfo {
                name: name.clone(),
                description,
                files: file_ids.len(),
                internal_coupling,
                internal_edges,
                external_edges,
                sample_files,
                cross_deps: if cross_deps.is_empty() {
                    None
                } else {
                    Some(cross_deps)
                },
            });
        }

        // Sort by file count
        subsystems.sort_by(|a, b| b.files.cmp(&a.files));

        Ok(subsystems)
    }

    /// Get related files by dependencies up to specified depth
    pub fn get_related_files(
        &self,
        file_path: &str,
        depth: u32,
    ) -> Result<Vec<RelatedFile>, QueryError> {
        let conn = self.db.conn();
        let normalized_path = file_path.replace('\\', "/");

        // Get file ID
        let file = crate::db::queries::Queries::get_file_by_path(&*conn, &PathBuf::from(&normalized_path))?;
        let file_id = match file {
            Some(f) => f.id,
            None => return Ok(Vec::new()),
        };

        let max_depth = depth.min(MAX_CONTEXT_DEPTH);
        let per_level_cap: usize = 20;
        let mut visited = HashSet::new();
        let mut result = Vec::new();

        self.traverse_related_files(&*conn, file_id, 0, max_depth, per_level_cap, &mut visited, &mut result)?;

        // Fallback: if file_relations yielded nothing, parse file content for imports
        // Fallback: if file_relations yielded nothing, parse file content for imports
        if result.is_empty() {
            match std::fs::read_to_string(&normalized_path) {
                Ok(content) => {
                    for m in parse_imports_from_content(&content, 150) {
                        result.push(RelatedFile {
                            path: m,
                            relation: "IMPORTS".to_string(),
                            depth: 1,
                        });
                    }
                }
                Err(e) => {
                    tracing::debug!(path = %normalized_path, error = %e, "fallback file read failed in get_related_files");
                }
            }
        }
        Ok(result)
    }

    /// Helper: Traverse related files recursively with per-level cap to prevent fan-out explosion
    fn traverse_related_files(
        &self,
        conn: &rusqlite::Connection,
        file_id: i64,
        current_depth: u32,
        max_depth: u32,
        per_level_cap: usize,
        visited: &mut HashSet<i64>,
        result: &mut Vec<RelatedFile>,
    ) -> Result<(), QueryError> {
        if current_depth >= max_depth {
            if !visited.contains(&file_id) {
                tracing::warn!(file_id, depth = current_depth, max_depth, "MAX_CONTEXT_DEPTH reached in related-files traversal");
            }
            return Ok(());
        }
        if visited.contains(&file_id) {
            return Ok(());
        }
        visited.insert(file_id);

        let mut stmt = conn.prepare(
            "SELECT f.id, f.path, fr.type
             FROM file_relations fr
             JOIN files f ON fr.to_file_id = f.id
             WHERE fr.from_file_id = ?
             LIMIT ?"
        )?;

        let rows = stmt.query_map(rusqlite::params![file_id, per_level_cap as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;

        for row in rows {
            let (related_id, path, relation_type) = row?;
            result.push(RelatedFile {
                path,
                relation: relation_type,
                depth: current_depth + 1,
            });

            if current_depth < max_depth {
                self.traverse_related_files(
                    conn,
                    related_id,
                    current_depth + 1,
                    max_depth,
                    per_level_cap,
                    visited,
                    result,
                )?;
            }
        }

        Ok(())
    }

    /// Helper: Generate subsystem description
    fn generate_subsystem_description(&self, name: &str, _sample_files: &[String]) -> String {
        // Simple heuristic-based description
        if name.contains("mcp") {
            "MCP (Model Context Protocol) integration layer".to_string()
        } else if name.contains("indexer") {
            "Code indexing and symbol extraction".to_string()
        } else if name.contains("detector") {
            "Pattern detection and issue identification".to_string()
        } else if name.contains("fixer") {
            "Code fix generation and application".to_string()
        } else if name.contains("graph") {
            "Code graph and dependency analysis".to_string()
        } else if name.contains("server") {
            "Server and API layer".to_string()
        } else {
            format!("{} subsystem", name)
        }
    }

    /// Analyze the impact of changing specified files
    /// Returns direct dependents, indirect dependents, and affected symbols
    pub fn get_change_impact(
        &self,
        file_paths: &[String],
    ) -> Result<ChangeImpact, QueryError> {
        let conn = self.db.conn();
        
        let mut target_file_ids: HashSet<i64> = HashSet::new();
        let mut target_files_normalized: Vec<String> = Vec::new();
        
        // Get file IDs for all target files
        for file_path in file_paths {
            let normalized = file_path.replace('\\', "/");
            let file = crate::db::queries::Queries::get_file_by_path(&*conn, &PathBuf::from(&normalized))?;
            if let Some(f) = file {
                target_file_ids.insert(f.id);
                target_files_normalized.push(normalized);
            }
        }
        
        if target_file_ids.is_empty() {
            return Ok(ChangeImpact {
                target_files: file_paths.iter().map(|s| s.clone()).collect(),
                direct_dependents: Vec::new(),
                indirect_dependents: Vec::new(),
                affected_symbols: Vec::new(),
                summary: ImpactSummary {
                    direct_files: 0,
                    indirect_files: 0,
                    total_files: 0,
                    symbols_affected: 0,
                    risk_level: "low".to_string(),
                },
            });
        }
        
        // Find direct dependents (files that import target files)
        let mut direct_dependents: Vec<ImpactedFile> = Vec::new();
        let mut direct_ids: HashSet<i64> = HashSet::new();
        
        for target_id in &target_file_ids {
            let mut stmt = conn.prepare(
                "SELECT f.id, f.path, fr.type,
                        (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id) as symbol_count
                 FROM file_relations fr
                 JOIN files f ON fr.from_file_id = f.id
                 WHERE fr.to_file_id = ? AND fr.type = 'IMPORTS'"
            )?;
            
            let rows = stmt.query_map([*target_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?;
            
            for row in rows {
                let (file_id, path, relation_type, symbol_count) = row?;
                if !target_file_ids.contains(&file_id) && !direct_ids.contains(&file_id) {
                    direct_ids.insert(file_id);
                    direct_dependents.push(ImpactedFile {
                        path,
                        impact_type: format!("direct_{}", relation_type.to_lowercase()),
                        symbols_affected: symbol_count as usize,
                    });
                }
            }
        }
        
        // Find indirect dependents (files that import direct dependents)
        let mut indirect_dependents: Vec<ImpactedFile> = Vec::new();
        let mut indirect_ids: HashSet<i64> = HashSet::new();
        
        for direct_id in &direct_ids {
            let mut stmt = conn.prepare(
                "SELECT f.id, f.path, fr.type,
                        (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id) as symbol_count
                 FROM file_relations fr
                 JOIN files f ON fr.from_file_id = f.id
                 WHERE fr.to_file_id = ? AND fr.type = 'IMPORTS'"
            )?;
            
            let rows = stmt.query_map([*direct_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?;
            
            for row in rows {
                let (file_id, path, _relation_type, symbol_count) = row?;
                if !target_file_ids.contains(&file_id) 
                   && !direct_ids.contains(&file_id) 
                   && !indirect_ids.contains(&file_id) 
                {
                    indirect_ids.insert(file_id);
                    indirect_dependents.push(ImpactedFile {
                        path,
                        impact_type: "indirect_import".to_string(),
                        symbols_affected: symbol_count as usize,
                    });
                }
            }
        }
        
        // Find affected symbols: only exported/public symbols referenced from
        // *other* files.  Restrict to high-signal kinds and require at least 2
        // external call sites to filter out name-collision noise.
        let mut affected_symbols: Vec<AffectedSymbol> = Vec::new();
        
        for target_id in &target_file_ids {
            let mut stmt = conn.prepare(
                "SELECT s.name, f.path, s.kind, s.line, s.end_line
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE s.file_id = ?
                   AND s.kind IN ('function', 'class', 'interface', 'type')
                   AND (s.metadata LIKE '%export%' OR s.metadata LIKE '%pub%'
                   ) >= 2
                   AND (
                       SELECT COUNT(DISTINCT c.file_id) FROM calls c
                       WHERE c.name = s.name AND c.file_id != s.file_id
                   ) >= 1
                 ORDER BY s.line
                 LIMIT 20"
            )?;
            
            let rows = stmt.query_map([*target_id], |row| {
                Ok(AffectedSymbol {
                    name: row.get(0)?,
                    file: row.get(1)?,
                    kind: row.get(2)?,
                    line: row.get(3)?,
                    end_line: row.get(4)?,
                })
            })?;
            
            for row in rows {
                affected_symbols.push(row?);
            }
        }
        
        // Calculate risk level
        let total_files = direct_dependents.len() + indirect_dependents.len();
        let risk_level = if total_files > 20 || affected_symbols.len() > 30 {
            "high"
        } else if total_files > 5 || affected_symbols.len() > 10 {
            "medium"
        } else {
            "low"
        }.to_string();
        
        // Compute length before moving
        let symbols_affected = affected_symbols.len();
        
        Ok(ChangeImpact {
            target_files: target_files_normalized,
            direct_dependents,
            indirect_dependents,
            affected_symbols,
            summary: ImpactSummary {
                direct_files: direct_ids.len(),
                indirect_files: indirect_ids.len(),
                total_files,
                symbols_affected,
                risk_level,
            },
        })
    }
}

#[cfg(test)]
mod parse_import_tests {
    use super::parse_imports_from_content;

    #[test]
    fn parses_ts_rust_python_cpp_java_cs_and_go_block() {
        let src = r#"
import { x } from 'react';
use std::fmt;
from os.path import join
#include "local.h"
import com.example.Widget;
using System.Linq;
import (
 "fmt"
    "strings"
)
"#;
        let m = parse_imports_from_content(src, 50);
        assert!(m.contains(&"react".to_string()));
        assert!(m.contains(&"std::fmt".to_string()));
        assert!(m.contains(&"os.path".to_string()));
        assert!(m.contains(&"local.h".to_string()));
        assert!(m.contains(&"com.example.Widget".to_string()));
        assert!(m.contains(&"System.Linq".to_string()));
        assert!(m.contains(&"fmt".to_string()));
        assert!(m.contains(&"strings".to_string()));
    }

    #[test]
    fn dedupes_and_respects_max_lines() {
        let src = "import { a } from 'dup'\nimport { b } from 'dup'\nimport { c } from 'other'\n";
        let m = parse_imports_from_content(src, 3);
        assert_eq!(m, vec!["dup", "other"]);
    }

    #[test]
    fn rust_multiline_use_block_not_truncated() {
        // Smart-shape import truncation repro: pre-fix, the single-line parser
        // would see only `use crate::{` and drop the import entirely.
        let src = r#"
use std::path::Path;
use crate::{
    foo::Bar,
    baz::{Qux, Quux},
    plain,
};
use other;
"#;
        let m = parse_imports_from_content(src, 50);
        assert!(m.iter().any(|s| s.contains("std::path")),
            "missing std::path: {:?}", m);
        assert!(m.iter().any(|s| s == "crate"),
            "multi-line `use crate::{{...}}` should surface the `crate` prefix: {:?}", m);
        assert!(m.iter().any(|s| s == "other"),
            "subsequent single-line `use other;` should still be captured: {:?}", m);
    }
}
