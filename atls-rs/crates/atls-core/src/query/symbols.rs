use crate::query::{QueryEngine, QueryError};
use crate::symbol::{Symbol, SymbolKind, SymbolMetadata};
use rusqlite::Row;
use std::collections::{HashMap, HashSet};

/// UHPP symbol anchor prefixes: fn, cls, sym, etc. Used to strip kind(name) → name for DB lookups.
const ANCHOR_PREFIXES: &[&str] = &[
    "fn", "sym", "cls", "class", "struct", "trait", "interface", "protocol",
    "enum", "record", "extension", "mixin", "impl", "type", "const", "macro",
    "ctor", "property", "field", "operator", "event", "object", "actor", "union",
];

/// Extract bare symbol name from fn(name)/cls(name) style. Returns original if not anchor format.
fn extract_bare_symbol_for_lookup(s: &str) -> &str {
    let trimmed = s.trim();
    for prefix in ANCHOR_PREFIXES {
        if trimmed.len() > prefix.len() + 2
            && trimmed.starts_with(prefix)
            && trimmed.as_bytes().get(prefix.len()) == Some(&b'(')
        {
            if let Some(close) = trimmed.rfind(')') {
                let start = prefix.len() + 1;
                if close > start {
                    return trimmed[start..close].trim();
                }
            }
        }
    }
    trimmed
}

/// Split an identifier into component words (handles camelCase, PascalCase, snake_case, kebab-case).
fn split_identifier_words(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in s.chars() {
        if ch == '_' || ch == '-' {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else if ch.is_uppercase() && !current.is_empty() && current.chars().last().map_or(false, |c| c.is_lowercase()) {
            words.push(std::mem::take(&mut current));
            current.push(ch);
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

/// Symbol usage information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymbolUsage {
    pub definitions: Vec<SymbolDefinition>,
    pub references: Vec<SymbolReference>,
}

/// Symbol definition location
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymbolDefinition {
    pub file: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub kind: String,
    pub signature: Option<String>,
    /// Language of the file containing this definition (e.g. "rust", "go", "typescript")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// Symbol reference location
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymbolReference {
    pub file: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Language of the file containing this reference
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// Compact symbol usage: scope-grouped references for token-efficient AI consumption.
/// ~120 tokens vs ~4,800+ tokens for flat reference lists.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompactSymbolUsage {
    pub definitions: Vec<SymbolDefinition>,
    /// References grouped by file path, each containing caller scope names (bounded + filterable)
    pub used_by: HashMap<String, Vec<String>>,
    pub total_refs: usize,
    pub file_count: usize,
    pub files_shown: usize,
    pub has_more: bool,
}

/// Compact call hierarchy: flat scope-grouped callers/callees for token-efficient AI consumption.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompactCallHierarchy {
    pub name: String,
    pub file: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub kind: String,
    /// Functions that call this symbol, grouped by file (bounded + filterable)
    pub callers: HashMap<String, Vec<String>>,
    /// Functions this symbol calls, grouped by file (bounded + filterable)
    pub callees: HashMap<String, Vec<String>>,
    pub total_callers: usize,
    pub total_callees: usize,
    pub callers_files: usize,
    pub callees_files: usize,
    pub has_more_callers: bool,
    pub has_more_callees: bool,
}

/// Symbol line range information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymbolLineRange {
    pub file: String,
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
}

/// Call hierarchy node with bidirectional relationships
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CallHierarchyNode {
    pub name: String,
    pub file: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub kind: String,
    pub depth: u32,
    /// 1.0 = symbol_relations match, 0.7 = same-language fallback, 0.3 = cross-language fallback
    pub confidence: f64,
    /// Functions that call this symbol (incoming)
    pub callers: Vec<CallHierarchyNode>,
    /// Functions that this symbol calls (outgoing)
    pub callees: Vec<CallHierarchyNode>,
}

/// Method inventory entry - used for refactoring analysis.
/// Field names shortened via serde(rename) for TOON token efficiency.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MethodInventoryEntry {
    #[serde(rename = "n")]
    pub name: String,
    #[serde(rename = "f")]
    pub file: String,
    #[serde(rename = "l")]
    pub line: u32,
    #[serde(rename = "el")]
    pub end_line: u32,
    #[serde(rename = "k")]
    pub kind: String,
    #[serde(rename = "cplx", skip_serializing_if = "Option::is_none")]
    pub complexity: Option<i32>,
    #[serde(rename = "ln")]
    pub lines: u32,
    #[serde(rename = "sig", skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(rename = "cls", skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(rename = "vis", skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(rename = "mods", skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<String>>,
    #[serde(rename = "inst", skip_serializing_if = "Option::is_none")]
    pub is_instance: Option<bool>,
    #[serde(rename = "pat", skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(rename = "xres", skip_serializing_if = "Option::is_none")]
    pub extraction_resistance: Option<u8>,
    #[serde(rename = "reas", skip_serializing_if = "Option::is_none")]
    pub resistance_reasons: Option<Vec<String>>,
    #[serde(rename = "ov", skip_serializing_if = "Option::is_none")]
    pub overload_count: Option<u32>,
}

/// Method inventory result with diagnostic stats
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MethodInventoryResult {
    pub methods: Vec<MethodInventoryEntry>,
    pub stats: InventoryStats,
}

/// Diagnostic stats for method inventory
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InventoryStats {
    pub total_scanned: usize,
    pub filtered_by_lines: usize,
    pub filtered_by_complexity: usize,
    pub filtered_by_class: usize,
    pub files_matched: usize,
    pub files_not_found: usize,
}

/// Detect structural pattern from method name, kind, and modifiers.
fn detect_method_pattern(name: &str, kind: &str, modifiers: &Option<Vec<String>>) -> Option<String> {
    let lower = name.to_lowercase();

    if kind == "constructor" || lower == "new" || lower == "init" || lower == "__init__" || lower == "constructor" {
        return Some("constructor".into());
    }

    let has = |m: &str| modifiers.as_ref().map_or(false, |v| v.iter().any(|s| s == m));

    if has("abstract") || has("virtual") {
        return Some("polymorphic".into());
    }

    if lower.starts_with("get_") || lower.starts_with("get") && name.chars().nth(3).map_or(false, |c| c.is_uppercase()) {
        return Some("getter".into());
    }
    if lower.starts_with("set_") || lower.starts_with("set") && name.chars().nth(3).map_or(false, |c| c.is_uppercase()) {
        return Some("setter".into());
    }

    if lower.starts_with("on_") || lower.starts_with("handle_") || lower.starts_with("on") && name.chars().nth(2).map_or(false, |c| c.is_uppercase()) {
        return Some("handler".into());
    }

    None
}

/// Compute extraction resistance score (0-10) and reason tags.
fn compute_extraction_resistance(
    entry: &MethodInventoryEntry,
    overload_count: u32,
) -> (u8, Vec<String>) {
    let mut score: u8 = 0;
    let mut reasons = Vec::new();

    // Rule 1: public API surface
    if entry.visibility.as_deref() == Some("public") {
        score = score.saturating_add(3);
        reasons.push("public-api".into());
    }

    // Rule 2: constructor
    if entry.pattern.as_deref() == Some("constructor") {
        score = score.saturating_add(4);
        reasons.push("constructor".into());
    }

    // Rule 3: static binding
    if entry.modifiers.as_ref().map_or(false, |m| m.iter().any(|s| s == "static")) {
        score = score.saturating_add(1);
        reasons.push("static-binding".into());
    }

    // Rule 4: polymorphic dispatch
    if entry.pattern.as_deref() == Some("polymorphic") {
        score = score.saturating_add(3);
        reasons.push("polymorphic".into());
    }

    // Rule 5: overload family
    if overload_count > 1 {
        score = score.saturating_add(2);
        reasons.push("overload-family".into());
    }

    // Rule 6: instance method with heavy this-coupling
    if entry.is_instance == Some(true) && entry.lines > 50 {
        score = score.saturating_add(1);
        reasons.push("this-coupled".into());
    }

    // Rule 7: accessor pattern
    if matches!(entry.pattern.as_deref(), Some("getter") | Some("setter")) {
        score = score.saturating_add(2);
        reasons.push("accessor".into());
    }

    (score.min(10), reasons)
}

/// Similar function match result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SimilarFunctionMatch {
    pub source: String,
    pub target: String,
    pub file: String,
    pub line: u32,
    pub similarity: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// "body_hash" for exact duplicates, "signature" for Jaccard, "name" for name-based fallback
    pub match_type: String,
}

/// Symbol diagnostic entry - detailed info about stored symbols
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymbolDiagnostic {
    pub id: i64,
    pub name: String,
    pub file: String,
    pub line: u32,
    pub end_line: Option<u32>,
    pub kind: String,
    pub complexity: Option<i32>,
    pub signature: Option<String>,
}

/// Symbol diagnostic result with search info
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymbolDiagnosticResult {
    pub symbols: Vec<SymbolDiagnostic>,
    pub search_type: String,
    pub query: String,
    pub total_found: usize,
}

impl QueryEngine {
    /// Find symbols by name (fuzzy search).
    /// Supports fn(name)/cls(name) style: strips kind prefix and looks up bare name.
    pub fn find_symbol(&self, query: &str) -> Result<Vec<Symbol>, QueryError> {
        let bare = extract_bare_symbol_for_lookup(query);
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.file_id, s.name, s.kind, s.line, s.scope_id, s.rank, 
                    s.signature, s.complexity, s.metadata
             FROM symbols s
             WHERE s.name LIKE ? ESCAPE '\\'
             ORDER BY s.rank DESC, s.name
             LIMIT 50"
        )?;

        let pattern = format!("%{}%", bare.replace('%', "\\%").replace('_', "\\_"));
        let rows = stmt.query_map([pattern], |row| {
            Ok(self.row_to_symbol(row)?)
        })?;

        let mut symbols = Vec::new();
        for row in rows {
            symbols.push(row?);
        }
        Ok(symbols)
    }

    /// Fuzzy suggestions when find_symbol returns nothing.
    /// Strategy: substring shrinking, then individual word matching from camelCase/snake_case.
    /// Supports fn(name) style: strips kind prefix before lookup.
    pub fn find_symbol_suggestions(&self, query: &str, limit: usize) -> Result<Vec<(String, String, f64)>, QueryError> {
        let bare = extract_bare_symbol_for_lookup(query);
        let conn = self.db.conn();
        let query_lower = bare.to_lowercase();
        let limit = limit.min(5).max(1);
        let fetch_limit = (limit * 3) as i64;

        let mut suggestions: Vec<(String, String, f64)> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        let do_like = |conn: &rusqlite::Connection, pattern: &str, fetch_limit: i64| -> Result<Vec<(String, String)>, QueryError> {
            let mut stmt = conn.prepare(
                "SELECT s.name, s.kind FROM symbols s
                 WHERE LOWER(s.name) LIKE ? ESCAPE '\\'
                 ORDER BY s.rank DESC
                 LIMIT ?"
            )?;
            let rows = stmt.query_map(rusqlite::params![pattern, fetch_limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        };

        // Phase 1: progressively shorter substrings of the full query
        let query_len = bare.len();
        let min_len = (query_len / 2).max(2);
        for substr_len in (min_len..=query_len).rev() {
            if suggestions.len() >= limit { break; }
            let substr = &query_lower[..substr_len];
            let pattern = format!("%{}%", substr.replace('%', "\\%").replace('_', "\\_"));
            for (name, kind) in do_like(&conn, &pattern, fetch_limit)? {
                if seen.contains(&name) { continue; }
                let score = substr_len as f64 / query_len.max(1) as f64;
                seen.insert(name.clone());
                suggestions.push((name, kind, score));
                if suggestions.len() >= limit { break; }
            }
        }

        // Phase 2: split camelCase/snake_case into words and search each
        if suggestions.len() < limit {
            let words = split_identifier_words(bare);
            for word in &words {
                if word.len() < 2 || suggestions.len() >= limit { continue; }
                let pattern = format!("%{}%", word.to_lowercase().replace('%', "\\%").replace('_', "\\_"));
                for (name, kind) in do_like(&conn, &pattern, fetch_limit)? {
                    if seen.contains(&name) { continue; }
                    let matched_words = split_identifier_words(&name);
                    let overlap = words.iter()
                        .filter(|w| matched_words.iter().any(|mw| mw.to_lowercase() == w.to_lowercase()))
                        .count();
                    let score = overlap as f64 / words.len().max(1) as f64 * 0.8;
                    seen.insert(name.clone());
                    suggestions.push((name, kind, score));
                    if suggestions.len() >= limit { break; }
                }
            }
        }

        suggestions.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
        suggestions.truncate(limit);
        Ok(suggestions)
    }

    /// Get symbol usage (definitions and references)
    /// 
    /// match_type can be:
    /// - "exact" (default): exact case-sensitive match
    /// - "exact_nocase": exact case-insensitive match  
    /// - "contains": substring match (case-insensitive)
    pub fn get_symbol_usage(&self, symbol_name: &str) -> Result<SymbolUsage, QueryError> {
        self.get_symbol_usage_with_options(symbol_name, "exact")
    }

    /// Get symbol usage filtered to a specific language.
    /// Uses SQL-level filtering (same as unscoped query + in-memory retain was O(all calls in DB)).
    pub fn get_symbol_usage_for_language(
        &self,
        symbol_name: &str,
        language: &str,
    ) -> Result<SymbolUsage, QueryError> {
        self.get_symbol_usage_with_options_inner(symbol_name, "exact", Some(language))
    }

    /// Get symbol usage with flexible matching options
    pub fn get_symbol_usage_with_options(
        &self, 
        symbol_name: &str,
        match_type: &str,
    ) -> Result<SymbolUsage, QueryError> {
        self.get_symbol_usage_with_options_inner(symbol_name, match_type, None)
    }

    /// `language_filter`: when set, adds `AND f.language = ?` (matches indexer lowercase) so the
    /// `calls` query does not scan every call site in the repo (rename was timing out on large monorepos).
    fn get_symbol_usage_with_options_inner(
        &self, 
        symbol_name: &str,
        match_type: &str,
        language_filter: Option<&str>,
    ) -> Result<SymbolUsage, QueryError> {
        let conn = self.db.conn();
        // Indexer stores `files.language` as Language::as_str() (lowercase). Equality allows
        // SQLite to use idx_files_language on joins; LOWER() would defeat the index.
        let lang_pred = if language_filter.is_some() {
            " AND f.language = ?"
        } else {
            ""
        };
        
        // Build WHERE clause based on match type
        let (where_clause, pattern) = match match_type {
            "exact_nocase" => ("LOWER(s.name) = LOWER(?)", symbol_name.to_string()),
            "contains" => ("LOWER(s.name) LIKE '%' || LOWER(?) || '%'", symbol_name.to_string()),
            _ => ("s.name = ?", symbol_name.to_string()), // default: exact
        };
        
        // For calls, match both exact name and dotted suffix (e.g. "obj.method" for "method")
        let (call_where, call_pattern, call_pattern2) = match match_type {
            "exact_nocase" => (
                "(LOWER(c.name) = LOWER(?1) OR LOWER(c.name) LIKE '%.' || LOWER(?2))",
                symbol_name.to_string(), symbol_name.to_string(),
            ),
            "contains" => (
                "LOWER(c.name) LIKE '%' || LOWER(?1) || '%'",
                symbol_name.to_string(), symbol_name.to_string(),
            ),
            _ => (
                "(c.name = ?1 OR c.name LIKE '%.' || ?2)",
                symbol_name.to_string(), symbol_name.to_string(),
            ),
        };
        
        let (rel_where, rel_pattern) = match match_type {
            "exact_nocase" => ("LOWER(s2.name) = LOWER(?)", symbol_name.to_string()),
            "contains" => ("LOWER(s2.name) LIKE '%' || LOWER(?) || '%'", symbol_name.to_string()),
            _ => ("s2.name = ?", symbol_name.to_string()),
        };
        
        // Get definitions (DISTINCT to avoid dupes from export+declaration dual indexing)
        let def_sql = format!(
            "SELECT DISTINCT f.path, s.line, s.end_line, s.kind, s.signature, f.language
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE ({}){}
             ORDER BY s.line",
            where_clause,
            lang_pred
        );
        let mut def_stmt = conn.prepare(&def_sql)?;

        let mut definitions = Vec::new();
        if let Some(lang) = language_filter {
            let def_rows = def_stmt.query_map(rusqlite::params![&pattern, lang], |row| {
                Ok(SymbolDefinition {
                    file: row.get(0)?,
                    line: row.get(1)?,
                    end_line: row.get(2)?,
                    kind: row.get(3)?,
                    signature: row.get(4)?,
                    language: row.get(5)?,
                })
            })?;
            for row in def_rows {
                definitions.push(row?);
            }
        } else {
            let def_rows = def_stmt.query_map([&pattern], |row| {
                Ok(SymbolDefinition {
                    file: row.get(0)?,
                    line: row.get(1)?,
                    end_line: row.get(2)?,
                    kind: row.get(3)?,
                    signature: row.get(4)?,
                    language: row.get(5)?,
                })
            })?;
            for row in def_rows {
                definitions.push(row?);
            }
        }

        // Get references from calls table (direct call-site matches)
        let calls_sql = format!(
            "SELECT DISTINCT f.path, c.line, f.language
             FROM calls c
             JOIN files f ON c.file_id = f.id
             WHERE ({}){}
             ORDER BY f.path, c.line",
            call_where,
            lang_pred
        );
        let mut ref_stmt = conn.prepare(&calls_sql)?;
        let mut references = Vec::new();
        if let Some(lang) = language_filter {
            let ref_rows = ref_stmt.query_map(
                rusqlite::params![&call_pattern, &call_pattern2, lang],
                |row| {
                    Ok(SymbolReference {
                        file: row.get(0)?,
                        line: row.get(1)?,
                        end_line: None,
                        language: row.get(2)?,
                    })
                },
            )?;
            for row in ref_rows {
                references.push(row?);
            }
        } else {
            let ref_rows = ref_stmt.query_map(
                rusqlite::params![&call_pattern, &call_pattern2],
                |row| {
                    Ok(SymbolReference {
                        file: row.get(0)?,
                        line: row.get(1)?,
                        end_line: None,
                        language: row.get(2)?,
                    })
                },
            )?;
            for row in ref_rows {
                references.push(row?);
            }
        }

        // Supplement with symbol_relations (callers that resolved to this symbol)
        // Use the calls table to recover actual call-site lines
        let rel_sql = format!(
            "SELECT DISTINCT f.path, c.line, f.language
             FROM symbol_relations sr
             JOIN symbols s2 ON sr.to_symbol_id = s2.id
             JOIN symbols s ON sr.from_symbol_id = s.id
             JOIN files f ON s.file_id = f.id
             JOIN calls c ON c.file_id = s.file_id AND c.scope_name = s.name
             WHERE {} AND sr.type = 'CALLS'{}
             ORDER BY f.path, c.line
             LIMIT 500",
            rel_where,
            lang_pred
        );
        if let Ok(mut rel_stmt) = conn.prepare(&rel_sql) {
            let map_row = |row: &rusqlite::Row<'_>| {
                Ok(SymbolReference {
                    file: row.get(0)?,
                    line: row.get(1)?,
                    end_line: None,
                    language: row.get(2)?,
                })
            };
            // O(1) dedup vs O(n) linear scan per row (was ~125k string compares at LIMIT 500).
            let mut rel_seen: std::collections::HashSet<(String, u32)> = references
                .iter()
                .map(|r| (r.file.clone(), r.line))
                .collect();
            if let Some(lang) = language_filter {
                if let Ok(rel_rows) = rel_stmt.query_map(rusqlite::params![&rel_pattern, lang], map_row) {
                    for row in rel_rows {
                        if let Ok(r) = row {
                            if rel_seen.insert((r.file.clone(), r.line)) {
                                references.push(r);
                            }
                        }
                    }
                }
            } else if let Ok(rel_rows) = rel_stmt.query_map([&rel_pattern], map_row) {
                for row in rel_rows {
                    if let Ok(r) = row {
                        if rel_seen.insert((r.file.clone(), r.line)) {
                            references.push(r);
                        }
                    }
                }
            }
        }

        // Text-search fallback: if no references found via calls/relations,
        // search for the symbol name appearing in signatures of other symbols
        // (catches indirect usage through store hooks, re-exports, type aliases)
        if references.is_empty() && symbol_name.len() >= 3 {
            let sig_pattern = format!("%{}%", symbol_name);
            let sig_sql = format!(
                "SELECT DISTINCT f.path, s.line, s.end_line, f.language
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE s.signature LIKE ?1 AND s.name != ?2{}
                 ORDER BY f.path, s.line
                 LIMIT 50",
                lang_pred
            );
            let mut sig_stmt = conn.prepare(&sig_sql)?;

            let map_sig_row = |row: &rusqlite::Row<'_>| {
                Ok(SymbolReference {
                    file: row.get(0)?,
                    line: row.get(1)?,
                    end_line: row.get(2)?,
                    language: row.get(3)?,
                })
            };
            if let Some(lang) = language_filter {
                let sig_rows = sig_stmt.query_map(
                    rusqlite::params![&sig_pattern, symbol_name, lang],
                    map_sig_row,
                )?;
                for row in sig_rows {
                    references.push(row?);
                }
            } else {
                let sig_rows = sig_stmt.query_map(
                    rusqlite::params![&sig_pattern, symbol_name],
                    map_sig_row,
                )?;
                for row in sig_rows {
                    references.push(row?);
                }
            }
        }

        Ok(SymbolUsage {
            definitions,
            references,
        })
    }

    /// Token-efficient symbol usage: returns scope-grouped callers instead of flat line lists.
    /// Produces ~120 tokens per symbol vs ~4,800+ for the full reference dump.
    /// `filter`: optional substring match on file paths and scope names.
    /// `limit`: max files to return. 0 = no limit.
    pub fn get_symbol_usage_compact(&self, symbol_name: &str, filter: Option<&str>, limit: usize) -> Result<CompactSymbolUsage, QueryError> {
        let conn = self.db.conn();

        // Definitions — same as full version
        let mut def_stmt = conn.prepare(
            "SELECT DISTINCT f.path, s.line, s.end_line, s.kind, s.signature, f.language
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE s.name = ?
             ORDER BY s.line"
        )?;
        let def_rows = def_stmt.query_map([symbol_name], |row| {
            Ok(SymbolDefinition {
                file: row.get(0)?,
                line: row.get(1)?,
                end_line: row.get(2)?,
                kind: row.get(3)?,
                signature: row.get(4)?,
                language: row.get(5)?,
            })
        })?;
        let mut definitions = Vec::new();
        for row in def_rows {
            definitions.push(row?);
        }

        // Scope-grouped references from calls table
        let mut scope_stmt = conn.prepare(
            "SELECT f.path, COALESCE(c.scope_name, '<module>') as scope, COUNT(*) as cnt
             FROM calls c
             JOIN files f ON c.file_id = f.id
             WHERE c.name = ?1 OR c.name LIKE '%.' || ?2
             GROUP BY f.path, scope
             ORDER BY f.path, cnt DESC"
        )?;
        let scope_rows = scope_stmt.query_map(
            rusqlite::params![symbol_name, symbol_name],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, usize>(2)?)),
        )?;

        let mut used_by: HashMap<String, Vec<String>> = HashMap::new();
        let mut total_refs: usize = 0;
        for row in scope_rows {
            let (file, scope, count) = row?;
            total_refs += count;
            used_by.entry(file).or_default().push(scope);
        }

        // Supplement with symbol_relations callers (same grouping)
        let mut rel_stmt = conn.prepare(
            "SELECT f.path, COALESCE(c.scope_name, '<module>') as scope, COUNT(*) as cnt
             FROM symbol_relations sr
             JOIN symbols s2 ON sr.to_symbol_id = s2.id
             JOIN symbols s ON sr.from_symbol_id = s.id
             JOIN files f ON s.file_id = f.id
             JOIN calls c ON c.file_id = s.file_id AND c.scope_name = s.name
             WHERE s2.name = ? AND sr.type = 'CALLS'
             GROUP BY f.path, scope
             ORDER BY f.path, cnt DESC"
        );
        if let Ok(ref mut stmt) = rel_stmt {
            if let Ok(rows) = stmt.query_map([symbol_name], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, usize>(2)?))
            }) {
                for row in rows {
                    if let Ok((file, scope, count)) = row {
                        let scopes = used_by.entry(file).or_default();
                        if !scopes.contains(&scope) {
                            scopes.push(scope);
                            total_refs += count;
                        }
                    }
                }
            }
        }

        // Signature-based fallback for indirect usage (only if no call refs found)
        if used_by.is_empty() && symbol_name.len() >= 3 {
            let sig_pattern = format!("%{}%", symbol_name);
            let mut sig_stmt = conn.prepare(
                "SELECT f.path, s.name
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE s.signature LIKE ?1 AND s.name != ?2
                 ORDER BY f.path, s.name
                 LIMIT 50"
            )?;
            let sig_rows = sig_stmt.query_map(
                rusqlite::params![&sig_pattern, symbol_name],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?;
            for row in sig_rows {
                let (file, scope) = row?;
                total_refs += 1;
                let scopes = used_by.entry(file).or_default();
                if !scopes.contains(&scope) {
                    scopes.push(scope);
                }
            }
        }

        // Apply filter: retain only files/scopes matching substring
        if let Some(f) = filter {
            let fl = f.to_lowercase();
            used_by.retain(|file, scopes| {
                file.to_lowercase().contains(&fl)
                || scopes.iter().any(|s| s.to_lowercase().contains(&fl))
            });
        }

        let file_count = used_by.len();

        // Sort by scope count descending (most-referenced files first), cap to limit
        let has_more;
        let files_shown;
        if limit > 0 && used_by.len() > limit {
            let mut sorted: Vec<String> = used_by.keys().cloned().collect();
            sorted.sort_by(|a, b| used_by[b].len().cmp(&used_by[a].len()));
            has_more = true;
            sorted.truncate(limit);
            let kept: std::collections::HashSet<String> = sorted.into_iter().collect();
            used_by.retain(|k, _| kept.contains(k));
            files_shown = limit;
        } else {
            has_more = false;
            files_shown = used_by.len();
        }

        Ok(CompactSymbolUsage {
            definitions,
            used_by,
            total_refs,
            file_count,
            files_shown,
            has_more,
        })
    }

    /// Get call hierarchy for a symbol (bidirectional: callers + callees)
    pub fn get_call_hierarchy(
        &self,
        symbol_name: &str,
        depth: u32,
    ) -> Result<Vec<CallHierarchyNode>, QueryError> {
        let conn = self.db.conn();
        
        // Find the symbol definition
        let mut stmt = conn.prepare(
            "SELECT s.id, f.path, s.line, s.end_line, s.kind
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE s.name = ?
             LIMIT 1"
        )?;

        let symbol_row = stmt.query_row([symbol_name], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, u32>(2)?, row.get::<_, Option<u32>>(3)?, row.get::<_, String>(4)?))
        }).optional()?;

        let (symbol_id, file, line, end_line, kind) = match symbol_row {
            Some((id, f, l, el, k)) => (id, f, l, el, k),
            None => return Ok(Vec::new()),
        };

        // Build both directions
        let callers = self.build_callers_recursive(&*conn, symbol_id, symbol_name, 0, depth)?;
        let callees = self.build_callees_recursive(&*conn, symbol_id, symbol_name, 0, depth)?;

        Ok(vec![CallHierarchyNode {
            name: symbol_name.to_string(),
            file,
            line,
            end_line,
            kind,
            depth: 0,
            confidence: 1.0,
            callers,
            callees,
        }])
    }

    /// Token-efficient call hierarchy: flat scope-grouped callers/callees.
    /// Filters out variable references, groups by file instead of recursive nesting.
    /// depth>1 expands callers-of-callers (capped at 30 fan-out for safety).
    /// `filter`: optional substring match on file paths and scope names.
    /// `limit`: max files to return per direction (callers/callees). 0 = no limit.
    pub fn get_call_hierarchy_compact(
        &self,
        symbol_name: &str,
        depth: u32,
        filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CompactCallHierarchy>, QueryError> {
        // Scope DB access so MutexGuard drops before any recursive call (depth>1).
        // Without this, self.db.conn() deadlocks on re-entry.
        let (file, line, end_line, kind, mut callers, mut total_callers, mut callees, total_callees) = {
            let conn = self.db.conn();

            let mut stmt = conn.prepare(
                "SELECT s.id, f.path, s.line, s.end_line, s.kind
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE s.name = ?
                 LIMIT 1"
            )?;

            let symbol_row = stmt.query_row([symbol_name], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, u32>(2)?, row.get::<_, Option<u32>>(3)?, row.get::<_, String>(4)?))
            }).optional()?;

            let (symbol_id, file, line, end_line, kind) = match symbol_row {
                Some((id, f, l, el, k)) => (id, f, l, el, k),
                None => return Ok(Vec::new()),
            };

            let mut callers: HashMap<String, Vec<String>> = HashMap::new();
            let mut total_callers: usize = 0;

            // Callers from symbol_relations (high confidence)
            let mut caller_stmt = conn.prepare(
                "SELECT DISTINCT f.path, s.name
                 FROM symbol_relations sr
                 JOIN symbols s ON sr.from_symbol_id = s.id
                 JOIN files f ON s.file_id = f.id
                 WHERE sr.to_symbol_id = ? AND sr.type = 'CALLS'"
            )?;
            let caller_rows = caller_stmt.query_map([symbol_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in caller_rows {
                let (cfile, cname) = row?;
                total_callers += 1;
                let names = callers.entry(cfile).or_default();
                if !names.contains(&cname) { names.push(cname); }
            }

            // Fallback: calls table, scoped to callable symbol kinds
            if callers.is_empty() {
                let mut fb_stmt = conn.prepare(
                    "SELECT DISTINCT f.path, s.name
                     FROM calls c
                     JOIN symbols s ON s.file_id = c.file_id AND s.name = c.scope_name
                        AND s.kind IN ('function', 'method', 'arrow_function', 'constructor', 'variable')
                     JOIN files f ON s.file_id = f.id
                     WHERE c.name = ?1 OR c.name LIKE '%.' || ?2
                     LIMIT 40"
                )?;
                let fb_rows = fb_stmt.query_map(
                    rusqlite::params![symbol_name, symbol_name],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                for row in fb_rows {
                    let (cfile, cname) = row?;
                    total_callers += 1;
                    let names = callers.entry(cfile).or_default();
                    if !names.contains(&cname) { names.push(cname); }
                }
            }

            let mut callees: HashMap<String, Vec<String>> = HashMap::new();
            let mut total_callees: usize = 0;

            // Callees from symbol_relations (high confidence)
            let mut callee_stmt = conn.prepare(
                "SELECT DISTINCT f.path, s.name
                 FROM symbol_relations sr
                 JOIN symbols s ON sr.to_symbol_id = s.id
                 JOIN files f ON s.file_id = f.id
                 WHERE sr.from_symbol_id = ? AND sr.type = 'CALLS'"
            )?;
            let callee_rows = callee_stmt.query_map([symbol_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in callee_rows {
                let (cfile, cname) = row?;
                total_callees += 1;
                let names = callees.entry(cfile).or_default();
                if !names.contains(&cname) { names.push(cname); }
            }

            // Fallback: calls table, filter to function/method symbols only
            if callees.is_empty() {
                let mut fb_stmt = conn.prepare(
                    "SELECT DISTINCT f.path, s.name
                     FROM calls c
                     JOIN symbols s ON s.name = c.name
                        AND s.kind IN ('function', 'method', 'class', 'struct', 'interface', 'enum')
                     JOIN files f ON s.file_id = f.id
                     WHERE c.scope_name = ?
                     LIMIT 40"
                )?;
                let fb_rows = fb_stmt.query_map([symbol_name], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                for row in fb_rows {
                    let (cfile, cname) = row?;
                    total_callees += 1;
                    let names = callees.entry(cfile).or_default();
                    if !names.contains(&cname) { names.push(cname); }
                }
            }

            (file, line, end_line, kind, callers, total_callers, callees, total_callees)
        }; // conn (MutexGuard) dropped here — safe to recurse

        if depth > 1 {
            let caller_names: Vec<String> = callers.values()
                .flatten()
                .take(30)
                .cloned()
                .collect();
            for cn in &caller_names {
                if let Ok(sub) = self.get_call_hierarchy_compact(cn, 1, None, 0) {
                    for s in sub {
                        for (f, names) in &s.callers {
                            let entry = callers.entry(f.clone()).or_default();
                            for n in names {
                                if !entry.contains(n) {
                                    entry.push(n.clone());
                                    total_callers += 1;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Apply filter: retain only files/scopes matching substring
        if let Some(f) = filter {
            let fl = f.to_lowercase();
            callers.retain(|file, names| {
                file.to_lowercase().contains(&fl)
                || names.iter().any(|n| n.to_lowercase().contains(&fl))
            });
            callees.retain(|file, names| {
                file.to_lowercase().contains(&fl)
                || names.iter().any(|n| n.to_lowercase().contains(&fl))
            });
        }

        let callers_files = callers.len();
        let callees_files = callees.len();

        // Sort by connectivity (most connections first), cap to limit
        let has_more_callers;
        let has_more_callees;
        if limit > 0 {
            let mut sorted: Vec<String> = callers.keys().cloned().collect();
            sorted.sort_by(|a, b| callers[b].len().cmp(&callers[a].len()));
            has_more_callers = sorted.len() > limit;
            sorted.truncate(limit);
            let kept: std::collections::HashSet<String> = sorted.into_iter().collect();
            callers.retain(|k, _| kept.contains(k));

            let mut sorted: Vec<String> = callees.keys().cloned().collect();
            sorted.sort_by(|a, b| callees[b].len().cmp(&callees[a].len()));
            has_more_callees = sorted.len() > limit;
            sorted.truncate(limit);
            let kept: std::collections::HashSet<String> = sorted.into_iter().collect();
            callees.retain(|k, _| kept.contains(k));
        } else {
            has_more_callers = false;
            has_more_callees = false;
        }

        Ok(vec![CompactCallHierarchy {
            name: symbol_name.to_string(),
            file,
            line,
            end_line,
            kind,
            callers,
            callees,
            total_callers,
            total_callees,
            callers_files,
            callees_files,
            has_more_callers,
            has_more_callees,
        }])
    }

    /// Get symbol line range by name and file
    pub fn get_symbol_line_range(
        &self,
        file_path: &str,
        symbol_name: &str,
    ) -> Result<Option<SymbolLineRange>, QueryError> {
        let conn = self.db.conn();
        
        // Step 1: Find the file using flexible path matching (handles slash variants)
        let path_forward = file_path.replace('\\', "/");
        let path_backward = file_path.replace('/', "\\");
        let pattern_forward = format!("%{}", path_forward);
        let pattern_backward = format!("%{}", path_backward);
        
        // Get file_id first using flexible path matching (handles slash variants)
        let file_id: Option<i64> = conn.query_row(
            "SELECT id FROM files WHERE path = ? OR path = ? OR path LIKE ? OR path LIKE ? LIMIT 1",
            rusqlite::params![&path_forward, &path_backward, &pattern_forward, &pattern_backward],
            |row| row.get(0)
        ).optional()?;
        
        let file_id = match file_id {
            Some(id) => id,
            None => return Ok(None), // File not found
        };
        
        // Step 2: Find symbol in that file by file_id.
        // Prefer exact name match first, fall back to LIKE for partial/signature matching.
        // This prevents short names (e.g., "cW") from matching unrelated symbols.
        let mut stmt_exact = conn.prepare(
            "SELECT s.name, s.kind, s.line, s.end_line, s.signature, f.path
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE s.name = ? AND s.file_id = ?
             ORDER BY s.line
             LIMIT 1"
        )?;
        let row = stmt_exact.query_row(rusqlite::params![symbol_name, file_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, Option<u32>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        }).optional()?;

        // Fall back to case-insensitive exact match if exact match not found.
        // Previously used LIKE '%name%' which was too aggressive — "default" matched
        // "default_email_options". Now only does case-insensitive exact match.
        let row = if row.is_some() { row } else {
            let mut stmt_ci = conn.prepare(
                "SELECT s.name, s.kind, s.line, s.end_line, s.signature, f.path
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE s.name = ? COLLATE NOCASE AND s.file_id = ?
                 ORDER BY s.line
                 LIMIT 1"
            )?;
            stmt_ci.query_row(rusqlite::params![symbol_name, file_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, Option<u32>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            }).optional()?
        };

        match row {
            Some((name, kind, line, end_line_opt, signature, path)) => {
                let end_line = end_line_opt.unwrap_or(line);

                Ok(Some(SymbolLineRange {
                    file: path,
                    name,
                    kind,
                    start_line: line,
                    end_line,
                    signature,
                }))
            }
            None => Ok(None),
        }
    }

    /// Search for a symbol by name across ALL indexed files (no file filter).
    /// Returns the first exact match found, preferring function/method kinds.
    pub fn get_symbol_line_range_global(
        &self,
        symbol_name: &str,
    ) -> Result<Option<SymbolLineRange>, QueryError> {
        let conn = self.db.conn();

        // Prefer exact name match in function/method kinds first
        let mut stmt = conn.prepare(
            "SELECT s.name, s.kind, s.line, s.end_line, s.signature, f.path
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE s.name = ?
             ORDER BY CASE s.kind
                 WHEN 'function' THEN 0
                 WHEN 'method' THEN 1
                 ELSE 2
             END, s.line
             LIMIT 1"
        )?;
        let row = stmt.query_row(rusqlite::params![symbol_name], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, Option<u32>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        }).optional()?;

        match row {
            Some((name, kind, line, end_line_opt, signature, path)) => {
                let end_line = end_line_opt.unwrap_or(line);
                Ok(Some(SymbolLineRange {
                    file: path,
                    name,
                    kind,
                    start_line: line,
                    end_line,
                    signature,
                }))
            }
            None => Ok(None),
        }
    }

    /// Search for a symbol by name across ALL indexed files with disambiguation.
    /// Returns all candidates ordered by span size (largest first), with optional
    /// kind filter, minimum line count threshold, and file extension filter.
    /// When `preferred_kind` is Some, candidates matching that kind are prioritized.
    /// When `min_lines` is Some, candidates smaller than that threshold are deprioritized.
    /// When `file_extensions` is Some, only candidates from files with matching extensions
    /// are included (prevents cross-language false positives).
    pub fn get_symbol_line_range_global_disambiguated(
        &self,
        symbol_name: &str,
        preferred_kind: Option<&str>,
        min_lines: Option<u32>,
        file_extensions: Option<&[&str]>,
    ) -> Result<Vec<SymbolLineRange>, QueryError> {
        let conn = self.db.conn();

        let mut stmt = conn.prepare(
            "SELECT s.name, s.kind, s.line, s.end_line, s.signature, f.path
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE s.name = ?
             ORDER BY COALESCE(s.end_line, s.line) - s.line DESC, s.line"
        )?;
        let rows = stmt.query_map(rusqlite::params![symbol_name], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, Option<u32>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;

        let mut candidates: Vec<SymbolLineRange> = Vec::new();
        for row in rows {
            let (name, kind, line, end_line_opt, signature, path) = row?;
            if let Some(exts) = file_extensions {
                let file_ext = std::path::Path::new(&path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if !exts.iter().any(|e| *e == file_ext) {
                    continue;
                }
            }
            let end_line = end_line_opt.unwrap_or(line);
            candidates.push(SymbolLineRange {
                file: path,
                name,
                kind,
                start_line: line,
                end_line,
                signature,
            });
        }

        // Apply preferred_kind: move matching candidates to front
        if let Some(pk) = preferred_kind {
            candidates.sort_by(|a, b| {
                let a_match = a.kind == pk;
                let b_match = b.kind == pk;
                match (a_match, b_match) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => {
                        let a_span = a.end_line.saturating_sub(a.start_line);
                        let b_span = b.end_line.saturating_sub(b.start_line);
                        b_span.cmp(&a_span)
                    }
                }
            });
        }

        // Apply min_lines: move candidates below threshold to end
        if let Some(ml) = min_lines {
            candidates.sort_by(|a, b| {
                let a_span = a.end_line.saturating_sub(a.start_line) + 1;
                let b_span = b.end_line.saturating_sub(b.start_line) + 1;
                let a_ok = a_span >= ml;
                let b_ok = b_span >= ml;
                match (a_ok, b_ok) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => b_span.cmp(&a_span),
                }
            });
        }

        Ok(candidates)
    }

    /// Get line ranges for multiple symbols (batch query)
    pub fn get_symbol_line_ranges(
        &self,
        requests: &[(String, String)], // (file_path, symbol_name)
    ) -> Result<HashMap<String, SymbolLineRange>, QueryError> {
        let mut results = HashMap::new();
        
        // Group by file for efficiency
        let mut by_file: HashMap<String, Vec<String>> = HashMap::new();
        for (file_path, symbol_name) in requests {
            by_file
                .entry(file_path.clone())
                .or_insert_with(Vec::new)
                .push(symbol_name.clone());
        }

        for (file_path, symbol_names) in by_file {
            let normalized_path = file_path.replace('\\', "/");
            let placeholders = symbol_names.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            
            let conn = self.db.conn();
            let mut stmt = conn.prepare(&format!(
                "SELECT s.name, s.kind, s.line, s.end_line, s.signature, f.path
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE s.name IN ({}) AND (f.path = ? OR f.path LIKE ?)",
                placeholders
            ))?;

            let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
            for name in &symbol_names {
                params.push(name);
            }
            params.push(&normalized_path);
            let pattern = format!("%{}", normalized_path);
            params.push(&pattern);

            let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, Option<u32>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?;

            for row in rows {
                let (name, kind, line, end_line_opt, signature, path) = row?;
                let end_line = end_line_opt.unwrap_or(line);

                let key = format!("{}:{}", file_path, name);
                results.insert(key, SymbolLineRange {
                    file: path,
                    name,
                    kind,
                    start_line: line,
                    end_line,
                    signature,
                });
            }
        }

        Ok(results)
    }

    /// Helper: Convert database row to Symbol
    fn row_to_symbol(&self, row: &Row) -> Result<Symbol, rusqlite::Error> {
        let metadata_str: Option<String> = row.get(9)?;
        let metadata = metadata_str
            .and_then(|s| serde_json::from_str::<SymbolMetadata>(&s).ok());

        Ok(Symbol {
            id: row.get(0)?,
            file_id: row.get(1)?,
            name: row.get(2)?,
            kind: SymbolKind::from_str(&row.get::<_, String>(3)?),
            line: row.get(4)?,
            scope_id: row.get(5)?,
            rank: row.get(6)?,
            signature: row.get(7)?,
            complexity: row.get(8)?,
            metadata,
        })
    }

    /// Build caller chain recursively (incoming: who calls this symbol).
    /// Primary: `symbol_relations` WHERE to_symbol_id = ? (confidence 1.0).
    /// Fallback: `calls` table with name-based matching, same-language preferred (0.7) over cross-language (0.3).
    fn build_callers_recursive(
        &self,
        conn: &rusqlite::Connection,
        symbol_id: i64,
        symbol_name: &str,
        current_depth: u32,
        max_depth: u32,
    ) -> Result<Vec<CallHierarchyNode>, QueryError> {
        if current_depth >= max_depth {
            return Ok(Vec::new());
        }

        let mut stmt = conn.prepare(
            "SELECT DISTINCT s.id, s.name, f.path, s.line, s.end_line, s.kind
             FROM symbol_relations sr
             JOIN symbols s ON sr.from_symbol_id = s.id
             JOIN files f ON s.file_id = f.id
             WHERE sr.to_symbol_id = ? AND sr.type = 'CALLS'
             LIMIT 20"
        )?;

        let rows: Vec<_> = stmt.query_map([symbol_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, Option<u32>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?.filter_map(|r| r.ok()).collect();

        let mut callers = Vec::new();

        if rows.is_empty() {
            // Fallback: name-based matching via calls table, with language awareness
            let mut fallback_stmt = conn.prepare(
                "SELECT DISTINCT s.id, s.name, f.path, s.line, s.end_line, s.kind, f.language
                 FROM calls c
                 JOIN symbols s ON s.file_id = c.file_id AND s.name = c.scope_name
                 JOIN files f ON s.file_id = f.id
                 WHERE c.name = ?1 OR c.name LIKE '%.' || ?2
                 LIMIT 20"
            )?;

            // Determine the target symbol's language for confidence scoring
            let target_lang: Option<String> = conn.query_row(
                "SELECT f.language FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.id = ? LIMIT 1",
                [symbol_id],
                |row| row.get(0),
            ).ok();

            let fallback_rows: Vec<_> = fallback_stmt.query_map(rusqlite::params![symbol_name, symbol_name], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, Option<u32>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?.filter_map(|r| r.ok()).collect();

            for (cid, cname, cfile, cline, cend_line, ckind, clang) in fallback_rows {
                let same_lang = target_lang.as_deref() == Some(&clang);
                let confidence = if same_lang { 0.7 } else { 0.3 };
                let nested = self.build_callers_recursive(conn, cid, &cname, current_depth + 1, max_depth)?;
                callers.push(CallHierarchyNode {
                    name: cname, file: cfile, line: cline, end_line: cend_line, kind: ckind,
                    depth: current_depth + 1, confidence, callers: nested, callees: Vec::new(),
                });
            }
            // Sort same-language results first
            callers.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
        } else {
            for (cid, cname, cfile, cline, cend_line, ckind) in rows {
                let nested = self.build_callers_recursive(conn, cid, &cname, current_depth + 1, max_depth)?;
                callers.push(CallHierarchyNode {
                    name: cname, file: cfile, line: cline, end_line: cend_line, kind: ckind,
                    depth: current_depth + 1, confidence: 1.0, callers: nested, callees: Vec::new(),
                });
            }
        }

        Ok(callers)
    }

    /// Build callee chain recursively (outgoing: what does this symbol call).
    /// Primary: `symbol_relations` WHERE from_symbol_id = ? (confidence 1.0).
    /// Fallback: `calls` table scoped to the calling function, same-language preferred (0.7) over cross-language (0.3).
    fn build_callees_recursive(
        &self,
        conn: &rusqlite::Connection,
        symbol_id: i64,
        symbol_name: &str,
        current_depth: u32,
        max_depth: u32,
    ) -> Result<Vec<CallHierarchyNode>, QueryError> {
        if current_depth >= max_depth {
            return Ok(Vec::new());
        }

        let mut stmt = conn.prepare(
            "SELECT DISTINCT s.id, s.name, f.path, s.line, s.end_line, s.kind
             FROM symbol_relations sr
             JOIN symbols s ON sr.to_symbol_id = s.id
             JOIN files f ON s.file_id = f.id
             WHERE sr.from_symbol_id = ? AND sr.type = 'CALLS'
             LIMIT 20"
        )?;

        let rows: Vec<_> = stmt.query_map([symbol_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, Option<u32>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?.filter_map(|r| r.ok()).collect();

        let mut callees = Vec::new();

        if rows.is_empty() {
            // Fallback: find calls made from this function via the calls table, with language awareness
            let mut fallback_stmt = conn.prepare(
                "SELECT DISTINCT s.id, s.name, f.path, s.line, s.end_line, s.kind, f.language
                 FROM calls c
                 JOIN symbols s ON s.name = c.name
                 JOIN files f ON s.file_id = f.id
                 WHERE c.scope_name = ?
                 LIMIT 40"
            )?;

            // Determine the calling symbol's language for confidence scoring
            let caller_lang: Option<String> = conn.query_row(
                "SELECT f.language FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.id = ? LIMIT 1",
                [symbol_id],
                |row| row.get(0),
            ).ok();

            let fallback_rows: Vec<_> = fallback_stmt.query_map([symbol_name], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, Option<u32>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?.filter_map(|r| r.ok()).collect();

            for (cid, cname, cfile, cline, cend_line, ckind, clang) in fallback_rows {
                let same_lang = caller_lang.as_deref() == Some(&clang);
                let confidence = if same_lang { 0.7 } else { 0.3 };
                let nested = self.build_callees_recursive(conn, cid, &cname, current_depth + 1, max_depth)?;
                callees.push(CallHierarchyNode {
                    name: cname, file: cfile, line: cline, end_line: cend_line, kind: ckind,
                    depth: current_depth + 1, confidence, callers: Vec::new(), callees: nested,
                });
            }
            // Sort same-language results first
            callees.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
        } else {
            for (cid, cname, cfile, cline, cend_line, ckind) in rows {
                let nested = self.build_callees_recursive(conn, cid, &cname, current_depth + 1, max_depth)?;
                callees.push(CallHierarchyNode {
                    name: cname, file: cfile, line: cline, end_line: cend_line, kind: ckind,
                    depth: current_depth + 1, confidence: 1.0, callers: Vec::new(), callees: nested,
                });
            }
        }

        Ok(callees)
    }

    /// Return every symbol name defined in `file_path` (all kinds).
    /// Used by the extraction tool to determine which referenced identifiers
    /// belong to the source module vs external crates.
    pub fn get_all_symbol_names_for_file(&self, file_path: &str) -> Result<HashSet<String>, QueryError> {
        let conn = self.db.conn();
        let normalized = file_path.replace('\\', "/");
        let normalized = normalized.trim_start_matches("./").trim_start_matches('/');
        let normalized = if let Some(colon_pos) = normalized.find(":/") {
            normalized[(colon_pos + 2)..].trim_start_matches('/')
        } else {
            normalized
        };
        let suffix = format!("%/{}", normalized);
        let contains = format!("%{}%", normalized);
        let mut stmt = conn.prepare(
            "SELECT DISTINCT s.name
             FROM symbols s JOIN files f ON s.file_id = f.id
             WHERE f.path = ?1 OR f.path LIKE ?2 OR f.path LIKE ?3"
        )?;
        let rows = stmt.query_map(rusqlite::params![normalized, &suffix, &contains], |row| {
            row.get::<_, String>(0)
        })?;
        let mut names = HashSet::new();
        for r in rows { names.insert(r?); }
        Ok(names)
    }

    /// Get intra-file symbol dependency graph for extraction planning.
    /// Returns every symbol in the file with its calls/called_by edges
    /// limited to symbols within the same file.
    /// Hub detection: auto-identifies high-connectivity symbols (dispatchers/routers)
    /// and excludes them from clustering so natural domain groups emerge.
    pub fn get_file_symbol_deps(
        &self,
        file_path: &str,
        kind_filter: Option<&[&str]>,
        hub_threshold: Option<usize>,
        exclude_hubs: bool,
    ) -> Result<serde_json::Value, QueryError> {
        let conn = self.db.conn();
        let normalized = file_path.replace('\\', "/");

        let file_id: i64 = conn.query_row(
            "SELECT id FROM files WHERE path = ?1 OR path LIKE ?2 LIMIT 1",
            rusqlite::params![&normalized, format!("%{}", normalized)],
            |row| row.get(0),
        ).map_err(|_| QueryError::FileNotFound(file_path.to_string()))?;

        let mut sym_stmt = conn.prepare(
            "SELECT s.id, s.name, s.kind, s.line, s.end_line, s.complexity, s.signature
             FROM symbols s WHERE s.file_id = ?
             ORDER BY s.line"
        )?;
        let sym_rows: Vec<(i64, String, String, u32, Option<u32>, Option<i32>, Option<String>)> =
            sym_stmt.query_map([file_id], |row| {
                Ok((
                    row.get(0)?, row.get(1)?, row.get(2)?,
                    row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?,
                ))
            })?.filter_map(|r| r.ok()).collect();

        let sym_names: HashSet<&str> = sym_rows.iter().map(|r| r.1.as_str()).collect();

        // Intra-file call edges from symbol_relations
        let mut rel_stmt = conn.prepare(
            "SELECT s_from.name, s_to.name
             FROM symbol_relations sr
             JOIN symbols s_from ON sr.from_symbol_id = s_from.id
             JOIN symbols s_to ON sr.to_symbol_id = s_to.id
             WHERE sr.type = 'CALLS' AND s_from.file_id = ?1 AND s_to.file_id = ?1"
        )?;
        let rel_edges: Vec<(String, String)> = rel_stmt.query_map([file_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?.filter_map(|r| r.ok()).collect();

        // Fallback: calls table for edges not in symbol_relations
        let mut call_stmt = conn.prepare(
            "SELECT c.scope_name, c.name
             FROM calls c WHERE c.file_id = ?"
        )?;
        let call_rows: Vec<(String, String)> = call_stmt.query_map([file_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?.filter_map(|r| r.ok()).collect();

        let mut edge_set: HashSet<(String, String)> = rel_edges.into_iter().collect();
        for (scope, name) in call_rows {
            if sym_names.contains(scope.as_str()) && sym_names.contains(name.as_str()) && scope != name {
                edge_set.insert((scope, name));
            }
        }

        let mut calls_map: HashMap<String, Vec<String>> = HashMap::new();
        let mut called_by_map: HashMap<String, Vec<String>> = HashMap::new();
        for (from, to) in &edge_set {
            calls_map.entry(from.clone()).or_default().push(to.clone());
            called_by_map.entry(to.clone()).or_default().push(from.clone());
        }

        // --- Hub detection via IQR outlier method ---
        let mut degree_list: Vec<(&str, usize, usize)> = Vec::new();
        for (_, name, kind, _, _, _, _) in &sym_rows {
            if let Some(filter) = kind_filter {
                if !filter.iter().any(|k| *k == kind.as_str()) { continue; }
            }
            let out = calls_map.get(name.as_str()).map_or(0, |v| v.len());
            let in_ = called_by_map.get(name.as_str()).map_or(0, |v| v.len());
            degree_list.push((name.as_str(), out, in_));
        }

        let auto_threshold = {
            let mut degrees: Vec<usize> = degree_list.iter().map(|(_, o, i)| o + i).collect();
            degrees.sort();
            if degrees.len() < 4 {
                usize::MAX
            } else {
                let q1 = degrees[degrees.len() / 4];
                let q3 = degrees[3 * degrees.len() / 4];
                let iqr = q3.saturating_sub(q1);
                // Standard IQR outlier: Q3 + 1.5*IQR, minimum 10 connections
                (q3 + iqr * 3 / 2).max(10)
            }
        };
        let threshold = hub_threshold.unwrap_or(auto_threshold);

        let hub_set: HashSet<&str> = degree_list.iter()
            .filter(|(_, o, i)| o + i > threshold)
            .map(|(name, _, _)| *name)
            .collect();

        let mut hubs: Vec<serde_json::Value> = degree_list.iter()
            .filter(|(_, o, i)| o + i > threshold)
            .map(|(name, out, in_)| serde_json::json!({
                "name": name,
                "connections": out + in_,
                "calls": out,
                "called_by": in_,
            }))
            .collect();
        hubs.sort_by(|a, b|
            b["connections"].as_u64().unwrap_or(0).cmp(&a["connections"].as_u64().unwrap_or(0))
        );

        // --- Build symbol entries ---
        let mut symbols = Vec::new();
        let mut max_fan_out: usize = 0;
        for (id, name, kind, line, end_line, complexity, signature) in &sym_rows {
            if let Some(filter) = kind_filter {
                if !filter.iter().any(|k| *k == kind.as_str()) { continue; }
            }
            let calls = calls_map.get(name.as_str()).cloned().unwrap_or_default();
            let called_by = called_by_map.get(name.as_str()).cloned().unwrap_or_default();
            max_fan_out = max_fan_out.max(calls.len());
            let mut entry = serde_json::json!({
                "name": name, "kind": kind, "line": line,
                "calls": calls, "called_by": called_by,
            });
            if hub_set.contains(name.as_str()) { entry["is_hub"] = serde_json::json!(true); }
            if let Some(el) = end_line { entry["end_line"] = serde_json::json!(el); }
            if let Some(c) = complexity { entry["complexity"] = serde_json::json!(c); }
            if let Some(s) = signature { entry["signature"] = serde_json::json!(s); }
            let _ = id;
            symbols.push(entry);
        }

        let edges: Vec<serde_json::Value> = edge_set.iter()
            .map(|(f, t)| serde_json::json!([f, t]))
            .collect();

        // --- Clustering with hub exclusion ---
        let filtered_names: Vec<&str> = symbols.iter()
            .filter_map(|s| s["name"].as_str())
            .collect();
        let empty_set: HashSet<&str> = HashSet::new();
        let exclude_set = if exclude_hubs { &hub_set } else { &empty_set };
        let clusters = Self::compute_clusters(&filtered_names, &edge_set, exclude_set);

        Ok(serde_json::json!({
            "file": file_path,
            "symbols": symbols,
            "edges": edges,
            "hubs": hubs,
            "clusters": clusters,
            "stats": {
                "total_symbols": symbols.len(),
                "total_edges": edge_set.len(),
                "hub_count": hub_set.len(),
                "hub_threshold": threshold,
                "max_fan_out": max_fan_out,
            }
        }))
    }

    /// Compute connected components with optional symbol exclusion.
    /// Excluded symbols (hubs) are removed from the graph before traversal,
    /// letting natural domain clusters emerge from the remaining topology.
    fn compute_clusters(
        names: &[&str],
        edges: &HashSet<(String, String)>,
        exclude: &HashSet<&str>,
    ) -> Vec<serde_json::Value> {
        let name_set: HashSet<&str> = names.iter().copied()
            .filter(|n| !exclude.contains(n))
            .collect();
        let mut adj: HashMap<&str, HashSet<&str>> = HashMap::new();
        for (from, to) in edges {
            let f = from.as_str();
            let t = to.as_str();
            if name_set.contains(f) && name_set.contains(t) {
                adj.entry(f).or_default().insert(t);
                adj.entry(t).or_default().insert(f);
            }
        }
        let mut visited: HashSet<&str> = HashSet::new();
        let mut clusters = Vec::new();
        for &name in names {
            if exclude.contains(name) || visited.contains(name) { continue; }
            let mut component = Vec::new();
            let mut stack = vec![name];
            while let Some(n) = stack.pop() {
                if !visited.insert(n) { continue; }
                component.push(n);
                if let Some(neighbors) = adj.get(n) {
                    for &nb in neighbors {
                        if !visited.contains(nb) { stack.push(nb); }
                    }
                }
            }
            if component.len() > 1 {
                let internal_edges = edges.iter()
                    .filter(|(f, t)| component.contains(&f.as_str()) && component.contains(&t.as_str()))
                    .count();
                let max_edges = component.len() * (component.len() - 1);
                let cohesion = if max_edges > 0 { internal_edges as f64 / max_edges as f64 } else { 0.0 };
                clusters.push(serde_json::json!({
                    "symbols": component,
                    "cohesion": (cohesion * 100.0).round() / 100.0,
                }));
            }
        }
        clusters.sort_by(|a, b| {
            let a_len = a["symbols"].as_array().map_or(0, |v| v.len());
            let b_len = b["symbols"].as_array().map_or(0, |v| v.len());
            b_len.cmp(&a_len)
        });
        clusters
    }

    /// Get method inventory for refactoring analysis
    /// Lists all methods/functions with their complexity and line counts
    /// Returns diagnostic stats showing why results may be empty
    pub fn get_method_inventory(
        &self,
        file_paths: &[String],
        min_lines: Option<u32>,
        min_complexity: Option<i32>,
        class_name: Option<&str>,
    ) -> Result<MethodInventoryResult, QueryError> {
        let conn = self.db.conn();
        
        let mut results = Vec::new();
        let min_lines_val = min_lines.unwrap_or(0);
        let min_complexity_val = min_complexity.unwrap_or(0);
        // Guard against duplicates from overlapping path patterns
        let mut seen: HashSet<(String, u32)> = HashSet::new();
        
        // Diagnostic counters
        let mut total_scanned = 0usize;
        let mut filtered_by_lines = 0usize;
        let mut filtered_by_complexity = 0usize;
        let mut filtered_by_class = 0usize;
        let mut files_matched = 0usize;
        let mut files_not_found = 0usize;
        
        for file_path in file_paths {
            let normalized = file_path.replace('\\', "/");
            let normalized = normalized.trim_start_matches("./").trim_start_matches('/');
            // Strip Windows drive letter prefix (e.g. "F:/source/project/src/file.rs" -> "source/project/src/file.rs")
            let normalized = if let Some(colon_pos) = normalized.find(":/") {
                normalized[(colon_pos + 2)..].trim_start_matches('/')
            } else {
                normalized
            };
            
            // Try multiple path patterns for flexible matching
            let exact_match = normalized.to_string();
            let suffix_pattern = format!("%/{}", normalized);
            let contains_pattern = format!("%{}%", normalized);
            
            // Query methods/functions with flexible path matching (DISTINCT avoids
            // duplicate rows when multiple OR-patterns match the same file).
            // Reads s.metadata (JSON) instead of broken s.scope_id for parent/visibility/modifiers.
            let mut stmt = conn.prepare(
                "SELECT DISTINCT s.name, f.path, s.line, s.end_line, s.kind,
                        s.complexity, s.signature, s.metadata
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE (f.path = ? OR f.path LIKE ? OR f.path LIKE ?)
                   AND s.kind IN ('function', 'method', 'arrow_function', 'generator_function', 'variable', 'property', 'constant')
                 ORDER BY s.line"
            )?;
            
            let rows = stmt.query_map(rusqlite::params![&exact_match, &suffix_pattern, &contains_pattern], |row| {
                Ok((
                    row.get::<_, String>(0)?,         // name
                    row.get::<_, String>(1)?,         // file
                    row.get::<_, u32>(2)?,            // line
                    row.get::<_, Option<u32>>(3)?,    // end_line
                    row.get::<_, String>(4)?,         // kind
                    row.get::<_, Option<i32>>(5)?,    // complexity
                    row.get::<_, Option<String>>(6)?, // signature
                    row.get::<_, Option<String>>(7)?, // metadata JSON
                ))
            })?;
            
            let mut file_had_results = false;
            for row in rows {
                file_had_results = true;
                total_scanned += 1;
                
                let (name, file, line, end_line_opt, kind, complexity, signature, metadata_json) = row?;
                let end_line = end_line_opt.unwrap_or(line);
                let lines = end_line.saturating_sub(line) + 1;
                
                // Apply filters with tracking
                if lines < min_lines_val {
                    filtered_by_lines += 1;
                    continue;
                }
                if let Some(c) = complexity {
                    if c < min_complexity_val {
                        filtered_by_complexity += 1;
                        continue;
                    }
                }
                
                // Parse metadata JSON for parent_symbol, visibility, modifiers
                let meta: Option<serde_json::Value> = metadata_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());
                
                let method_class_name = meta.as_ref()
                    .and_then(|m| m.get("parent_symbol"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                
                let visibility = meta.as_ref()
                    .and_then(|m| m.get("visibility"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                
                let modifiers: Option<Vec<String>> = meta.as_ref()
                    .and_then(|m| m.get("modifiers"))
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect());
                
                // Filter by class name if specified
                if let Some(filter_class) = class_name {
                    if method_class_name.as_deref() != Some(filter_class) {
                        filtered_by_class += 1;
                        continue;
                    }
                }
                
                // Skip if already seen (overlapping path patterns can produce dupes)
                let dedup_key = (file.clone(), line);
                if !seen.insert(dedup_key) {
                    continue;
                }

                let is_instance = if kind == "method" {
                    let is_static = modifiers.as_ref()
                        .map(|m| m.iter().any(|s| s == "static"))
                        .unwrap_or(false);
                    Some(!is_static)
                } else {
                    None
                };

                let pattern = detect_method_pattern(&name, &kind, &modifiers);

                results.push(MethodInventoryEntry {
                    name,
                    file,
                    line,
                    end_line,
                    kind,
                    complexity,
                    lines,
                    signature,
                    class_name: method_class_name,
                    visibility,
                    modifiers,
                    is_instance,
                    pattern,
                    extraction_resistance: None,
                    resistance_reasons: None,
                    overload_count: None,
                });
            }
            
            if file_had_results {
                files_matched += 1;
            } else {
                files_not_found += 1;
            }
        }
        
        // Overload detection: count same-name methods within (file, class, name)
        let mut overload_counts: HashMap<(String, Option<String>, String), u32> = HashMap::new();
        for entry in &results {
            let key = (entry.file.clone(), entry.class_name.clone(), entry.name.clone());
            *overload_counts.entry(key).or_insert(0) += 1;
        }

        // Apply overload counts + extraction resistance scoring
        for entry in &mut results {
            let key = (entry.file.clone(), entry.class_name.clone(), entry.name.clone());
            let ov = overload_counts.get(&key).copied().unwrap_or(1);
            if ov > 1 {
                entry.overload_count = Some(ov);
            }
            let (score, reasons) = compute_extraction_resistance(entry, ov);
            if score > 0 {
                entry.extraction_resistance = Some(score);
                entry.resistance_reasons = Some(reasons);
            }
        }

        // Sort by complexity descending, then by lines descending
        results.sort_by(|a, b| {
            let complexity_cmp = b.complexity.unwrap_or(0).cmp(&a.complexity.unwrap_or(0));
            if complexity_cmp == std::cmp::Ordering::Equal {
                b.lines.cmp(&a.lines)
            } else {
                complexity_cmp
            }
        });
        
        Ok(MethodInventoryResult {
            methods: results,
            stats: InventoryStats {
                total_scanned,
                filtered_by_lines,
                filtered_by_complexity,
                filtered_by_class,
                files_matched,
                files_not_found,
            },
        })
    }

    /// Find functions with similar signatures, body hashes, and names.
    /// Phase 1: exact body-hash duplicates (similarity=1.0).
    /// Phase 2: structural signature comparison (Jaccard + param count + return type).
    /// Phase 3: name-based fallback for remaining candidates.
    pub fn find_similar_functions(
        &self,
        function_names: &[String],
        threshold: f64,
        limit: usize,
    ) -> Result<Vec<SimilarFunctionMatch>, QueryError> {
        let conn = self.db.conn();
        let mut all_matches = Vec::new();
        let limit = limit.min(100).max(1);
        
        for func_name in function_names {
            // Get source function's signature, normalized signature, and body hash
            let source: Option<(i64, String, Option<String>, Option<String>, Option<String>)> = conn.query_row(
                "SELECT s.id, f.path, s.signature, cs.normalized_signature, cs.hash
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 LEFT JOIN code_signatures cs ON cs.symbol_id = s.id
                 WHERE s.name = ? AND s.kind IN ('function', 'method', 'arrow_function', 'generator_function')
                 LIMIT 1",
                [func_name],
                |row| Ok((
                    row.get(0)?, 
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            ).optional()?;
            
            let (source_id, compare_sig_owned, source_hash) = if let Some((id, _file, sig, norm, hash)) = source {
                let sig_str = norm.or(sig).unwrap_or_else(|| func_name.to_string());
                let sig_str = if sig_str.is_empty() { func_name.to_string() } else { sig_str };
                (id, sig_str, hash)
            } else {
                (-1i64, func_name.to_string(), None)
            };
            let compare_sig = compare_sig_owned.as_str();

            let mut matches_for_func = Vec::new();
            let mut seen_ids = std::collections::HashSet::new();

            // Phase 1: Body-hash exact duplicates
            if let Some(ref hash) = source_hash {
                if !hash.is_empty() {
                    let mut hash_stmt = conn.prepare(
                        "SELECT s.name, f.path, s.line, s.signature
                         FROM code_signatures cs
                         JOIN symbols s ON cs.symbol_id = s.id
                         JOIN files f ON s.file_id = f.id
                         WHERE cs.hash = ? AND s.id != ?
                           AND s.kind IN ('function', 'method', 'arrow_function', 'generator_function')
                         LIMIT 50"
                    )?;
                    let hash_rows = hash_stmt.query_map(rusqlite::params![hash, source_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, u32>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })?;
                    for row in hash_rows {
                        let (name, file, line, sig) = row?;
                        seen_ids.insert(format!("{}:{}", &file, line));
                        matches_for_func.push(SimilarFunctionMatch {
                            source: func_name.clone(),
                            target: name,
                            file,
                            line,
                            similarity: 1.0,
                            signature: sig,
                            match_type: "body_hash".to_string(),
                        });
                    }
                }
            }

            // Phase 2: Signature comparison
            let mut stmt = conn.prepare(
                "SELECT s.name, f.path, s.line, s.signature, cs.normalized_signature
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 LEFT JOIN code_signatures cs ON cs.symbol_id = s.id
                 WHERE s.id != ? 
                   AND s.kind IN ('function', 'method', 'arrow_function', 'generator_function')
                 ORDER BY s.id DESC
                 LIMIT 2000"
            )?;
            
            let rows = stmt.query_map([source_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?;
            
            for row in rows {
                let (name, file, line, sig, norm_sig) = row?;
                let key = format!("{}:{}", &file, line);
                if seen_ids.contains(&key) { continue; }
                
                let target_sig = norm_sig.as_deref()
                    .or(sig.as_deref())
                    .unwrap_or(&name);
                
                if target_sig.is_empty() { continue; }
                
                let mut similarity = Self::signature_similarity(compare_sig, target_sig);
                let mut match_type = "signature";
                
                // Fallback: boost with sub-word name similarity when signatures are weak
                if similarity < threshold {
                    let name_sim = Self::name_similarity(func_name, &name);
                    if name_sim * 0.7 > similarity {
                        similarity = name_sim * 0.7;
                        match_type = "name";
                    }
                }
                
                if similarity >= threshold {
                    matches_for_func.push(SimilarFunctionMatch {
                        source: func_name.clone(),
                        target: name,
                        file,
                        line,
                        similarity,
                        signature: sig,
                        match_type: match_type.to_string(),
                    });
                }
            }
            
            matches_for_func.sort_by(|a, b| {
                b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal)
            });
            
            all_matches.extend(matches_for_func.into_iter().take(limit));
        }
        
        all_matches.sort_by(|a, b| {
            b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal)
        });
        
        Ok(all_matches.into_iter().take(limit).collect())
    }

    /// Structural signature similarity: Jaccard on tokens + param-count bonus + return-type bonus.
    fn signature_similarity(sig1: &str, sig2: &str) -> f64 {
        if sig1.is_empty() || sig2.is_empty() { 
            return 0.0; 
        }
        
        let tokens1: std::collections::HashSet<&str> = sig1
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();
        let tokens2: std::collections::HashSet<&str> = sig2
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();
        
        if tokens1.is_empty() || tokens2.is_empty() {
            return 0.0;
        }
        
        let intersection = tokens1.intersection(&tokens2).count();
        let union = tokens1.union(&tokens2).count();
        let jaccard = if union == 0 { 0.0 } else { intersection as f64 / union as f64 };

        // Parameter count similarity: count commas between parens as proxy for arity
        let count_params = |s: &str| -> usize {
            if let Some(start) = s.find('(') {
                if let Some(end) = s[start..].find(')') {
                    let inner = &s[start + 1..start + end];
                    if inner.trim().is_empty() { 0 } else { inner.split(',').count() }
                } else { 0 }
            } else { 0 }
        };
        let p1 = count_params(sig1);
        let p2 = count_params(sig2);
        let param_bonus = if p1 == p2 && p1 > 0 { 0.1 } else if (p1 as i32 - p2 as i32).unsigned_abs() <= 1 { 0.03 } else { 0.0 };

        // Return type similarity: extract text after "->" or ":"
        fn extract_return_type(s: &str) -> &str {
            if let Some(i) = s.rfind("->") {
                return s[i + 2..].trim();
            }
            if let Some(p) = s.rfind(')') {
                if let Some(i) = s[p..].find(':') {
                    return s[p + i + 1..].trim();
                }
            }
            ""
        }
        let r1 = extract_return_type(sig1);
        let r2 = extract_return_type(sig2);
        let return_bonus = if !r1.is_empty() && !r2.is_empty() && r1 == r2 { 0.1 } else { 0.0 };

        (jaccard + param_bonus + return_bonus).min(1.0)
    }

    /// Sub-word similarity between two identifiers.
    /// Splits camelCase/snake_case into sub-words and computes Jaccard overlap.
    fn name_similarity(name1: &str, name2: &str) -> f64 {
        fn split_subwords(s: &str) -> std::collections::HashSet<String> {
            let mut words = std::collections::HashSet::new();
            // Split on underscores first, then camelCase boundaries
            for part in s.split('_') {
                if part.is_empty() { continue; }
                let mut current = String::new();
                for ch in part.chars() {
                    if ch.is_uppercase() && !current.is_empty() {
                        words.insert(current.to_lowercase());
                        current = String::new();
                    }
                    current.push(ch);
                }
                if !current.is_empty() {
                    words.insert(current.to_lowercase());
                }
            }
            words
        }

        let w1 = split_subwords(name1);
        let w2 = split_subwords(name2);
        if w1.is_empty() || w2.is_empty() {
            return 0.0;
        }
        let intersection = w1.intersection(&w2).count();
        let union = w1.union(&w2).count();
        if union == 0 { 0.0 } else { intersection as f64 / union as f64 }
    }

    /// Diagnostic: Query symbols with flexible matching options
    /// 
    /// search_type can be:
    /// - "exact": exact case-sensitive match
    /// - "exact_nocase": exact case-insensitive match
    /// - "contains": substring match (case-insensitive)
    /// - "prefix": prefix match (case-insensitive)
    /// - "suffix": suffix match (case-insensitive)
    pub fn diagnose_symbols(
        &self,
        query: &str,
        search_type: &str,
        file_filter: Option<&str>,
        limit: Option<u32>,
    ) -> Result<SymbolDiagnosticResult, QueryError> {
        let conn = self.db.conn();
        let limit_val = limit.unwrap_or(100);
        
        // Build WHERE clause based on search type
        let (where_clause, params): (String, Vec<String>) = match search_type {
            "exact" => (
                "s.name = ?1".to_string(),
                vec![query.to_string()]
            ),
            "exact_nocase" => (
                "LOWER(s.name) = LOWER(?1)".to_string(),
                vec![query.to_string()]
            ),
            "contains" => (
                "LOWER(s.name) LIKE '%' || LOWER(?1) || '%'".to_string(),
                vec![query.to_string()]
            ),
            "prefix" => (
                "LOWER(s.name) LIKE LOWER(?1) || '%'".to_string(),
                vec![query.to_string()]
            ),
            "suffix" => (
                "LOWER(s.name) LIKE '%' || LOWER(?1)".to_string(),
                vec![query.to_string()]
            ),
            _ => (
                "s.name LIKE '%' || ?1 || '%'".to_string(),
                vec![query.to_string()]
            ),
        };
        
        // Add file filter if provided
        let file_clause = if file_filter.is_some() {
            format!(" AND f.path LIKE '%' || ?{} || '%'", params.len() + 1)
        } else {
            String::new()
        };
        
        let sql = format!(
            "SELECT s.id, s.name, f.path, s.line, s.end_line, s.kind, s.complexity, s.signature
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE {}{}
             ORDER BY f.path, s.line
             LIMIT {}",
            where_clause, file_clause, limit_val
        );
        
        let mut stmt = conn.prepare(&sql)?;
        
        // Build params slice
        let mut all_params = params.clone();
        if let Some(file) = file_filter {
            all_params.push(file.to_string());
        }
        
        let param_refs: Vec<&dyn rusqlite::ToSql> = all_params
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            Ok(SymbolDiagnostic {
                id: row.get(0)?,
                name: row.get(1)?,
                file: row.get(2)?,
                line: row.get(3)?,
                end_line: row.get(4)?,
                kind: row.get(5)?,
                complexity: row.get(6)?,
                signature: row.get(7)?,
            })
        })?;
        
        let mut symbols = Vec::new();
        for row in rows {
            symbols.push(row?);
        }
        
        let total_found = symbols.len();
        
        Ok(SymbolDiagnosticResult {
            symbols,
            search_type: search_type.to_string(),
            query: query.to_string(),
            total_found,
        })
    }
}

// Helper trait for optional query results
trait OptionalResult<T> {
    fn optional(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalResult<T> for rusqlite::Result<T> {
    fn optional(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
