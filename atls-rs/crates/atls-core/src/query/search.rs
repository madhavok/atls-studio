use crate::query::{QueryEngine, QueryError};
use crate::query::structured::StructuredFilters;
use crate::types::symbol::format_qualified_symbol_name;
use super::feedback;
use super::hybrid;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use lru::LruCache;
use std::num::NonZeroUsize;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// Round relevance to 2 decimals for compact JSON output (avoids ~15 decimal places).
fn serialize_relevance<S>(v: &f64, s: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let rounded = (*v * 100.0).round() / 100.0;
    s.serialize_f64(rounded)
}

/// Code search result with optional snippet context
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CodeSearchResult {
    pub symbol: String,
    pub file: String,
    pub line: u32,
    pub kind: String,
    #[serde(serialize_with = "serialize_relevance")]
    pub relevance: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_id: Option<i64>,
    /// Set when merging federated multi-DB search results.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Enclosing scope + symbol when `metadata.parent_symbol` is set (e.g. `Point.distance`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qualified_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_before: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_after: Option<Vec<String>>,
}

/// Compact search result for reduced token usage
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompactSearchResult {
    pub s: String,  // symbol
    pub f: String,  // file
    pub l: u32,     // line
    pub k: String,  // kind
    #[serde(serialize_with = "serialize_relevance")]
    pub r: f64,     // relevance
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<String>, // snippet context
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<String>, // qualified_name
}

/// Grouped search results by file (Phase 2)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GroupedSearchResults {
    pub query: String,
    pub groups: Vec<FileGroup>,
    pub total_matches: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileGroup {
    pub file: String,
    pub matches: Vec<GroupMatch>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GroupMatch {
    pub symbol: String,
    pub line: u32,
    pub kind: String,
    #[serde(serialize_with = "serialize_relevance")]
    pub relevance: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qualified_name: Option<String>,
}

/// Tiered search response (Phase 4)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TieredSearchResponse {
    pub query: String,
    pub high_confidence: Vec<CodeSearchResult>,
    pub medium_confidence: Vec<CodeSearchResult>,
    pub low_confidence_count: usize,
    pub total_matches: usize,
}

impl CodeSearchResult {
    pub fn to_compact(&self) -> CompactSearchResult {
        CompactSearchResult {
            s: self.symbol.clone(),
            f: self.file.clone(),
            l: self.line,
            k: self.kind.clone(),
            r: self.relevance,
            c: self.snippet.clone(),
            q: self.qualified_name.clone(),
        }
    }
}

impl CodeSearchResult {
    fn to_group_match(&self) -> GroupMatch {
        GroupMatch {
            symbol: self.symbol.clone(),
            line: self.line,
            kind: self.kind.clone(),
            relevance: self.relevance,
            snippet: self.snippet.clone(),
            signature: self.signature.clone(),
            qualified_name: self.qualified_name.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// File cache for snippet extraction (Phase 1.3)
// ---------------------------------------------------------------------------

/// LRU cache for file contents, keyed by (path, hash) for invalidation
pub struct FileCache {
    inner: Mutex<LruCache<String, Vec<String>>>,
}

impl FileCache {
    pub fn new(capacity: usize) -> Self {
        let normalized_capacity = capacity.max(1);
        let cap = NonZeroUsize::new(normalized_capacity)
            .expect("normalized file cache capacity must be non-zero");
        Self {
            inner: Mutex::new(LruCache::new(cap)),
        }
    }

    /// Get file lines, reading from disk if not cached. `hash` is used as
    /// part of the cache key so stale entries are never returned.
    pub fn get_lines(&self, path: &str, hash: &str, root: &Path) -> Option<Vec<String>> {
        let key = format!("{}:{}", path, hash);
        {
            let mut cache = self.inner.lock().ok()?;
            if let Some(lines) = cache.get(&key) {
                return Some(lines.clone());
            }
        }

        let full_path = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            root.join(path)
        };

        let content = std::fs::read_to_string(&full_path).ok()?;
        let lines: Vec<String> = content.lines().map(String::from).collect();

        if let Ok(mut cache) = self.inner.lock() {
            cache.put(key, lines.clone());
        }
        Some(lines)
    }
}

// ---------------------------------------------------------------------------
// Query pattern detection (Phase 3.3)
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum QueryPattern {
    ExactSymbol,
    CompoundWithGeneric,
    CommonKeyword,
    SemanticIntent,
    Generic,
}

const GENERIC_TERMS: &[&str] = &[
    "token", "data", "error", "file", "result", "value", "item", "config",
    "settings", "state", "list", "map", "set", "key", "name", "type", "id",
    "index", "count", "size", "length", "path", "url", "string", "number",
    "object", "array", "buffer", "handler", "callback", "response", "request",
];

const MODIFIER_TERMS: &[&str] = &[
    "refresh", "access", "auth", "session", "parse", "validate", "format",
    "serialize", "create", "update", "delete", "fetch", "load", "save",
    "init", "start", "stop", "open", "close", "read", "write", "send",
    "receive", "connect", "disconnect", "encode", "decode", "encrypt",
    "decrypt", "compress", "decompress", "hash", "sign", "verify",
];

const PROGRAMMING_KEYWORDS: &[&str] = &[
    "async", "await", "promise", "extends", "implements", "interface",
    "class", "function", "const", "let", "var", "struct", "enum", "trait",
    "impl", "pub", "fn", "mod", "use", "import", "export", "return",
    "yield", "match", "if", "else", "for", "while", "loop",
];

fn has_camel_case(s: &str) -> bool {
    let mut saw_lower = false;
    for c in s.chars() {
        if c.is_lowercase() {
            saw_lower = true;
        } else if c.is_uppercase() && saw_lower {
            return true;
        }
    }
    false
}

fn detect_query_pattern(query: &str) -> QueryPattern {
    let terms: Vec<&str> = query.split_whitespace().collect();

    if query.contains('_') || has_camel_case(query) {
        return QueryPattern::ExactSymbol;
    }

    let lower_terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();

    if terms.len() > 1
        && lower_terms.iter().any(|t| GENERIC_TERMS.contains(&t.as_str()))
    {
        return QueryPattern::CompoundWithGeneric;
    }

    if lower_terms
        .iter()
        .any(|t| PROGRAMMING_KEYWORDS.contains(&t.as_str()))
    {
        return QueryPattern::CommonKeyword;
    }

    if terms.len() >= 2 && !query.contains('_') && !has_camel_case(query) {
        return QueryPattern::SemanticIntent;
    }

    QueryPattern::Generic
}

// ---------------------------------------------------------------------------
// Heuristic reranking (Phase 3.1-3.2)
// ---------------------------------------------------------------------------

fn contextual_penalty(term: &str, query_terms: &[&str]) -> f64 {
    let lower = term.to_lowercase();

    if GENERIC_TERMS.contains(&lower.as_str()) {
        if query_terms
            .iter()
            .any(|t| MODIFIER_TERMS.contains(&t.to_lowercase().as_str()))
        {
            return 1.0; // don't penalise generic in compound context
        }
        return 0.3;
    }

    if term.contains('_') || has_camel_case(term) {
        if query_terms.len() > 1 {
            return 1.5;
        }
    }

    1.0
}

fn kind_boost(kind: &str, symbol: &str) -> f64 {
    match kind {
        "function" | "method" | "constructor" => 1.5,
        "class" | "struct" | "interface" | "enum" | "record" | "protocol" | "actor" | "union" => 1.4,
        "trait" | "mixin" | "extension" | "object" => 1.35,
        "impl" | "macro" => 1.3,
        "const" | "static" => 1.2,
        "type" | "typedef" | "operator" | "event" => 1.1,
        "module" | "namespace" => 1.15,
        "property" | "field" | "enum_member" => 1.05,
        "variable" | "let" => {
            if symbol.contains('_') || has_camel_case(symbol) {
                1.1
            } else if symbol.len() < 4 {
                0.5
            } else {
                0.7
            }
        }
        _ => 1.0,
    }
}

fn is_test_path(file: &str) -> bool {
    let p = file.replace('\\', "/").to_lowercase();
    p.contains("/tests/") || p.contains("/__tests__/")
        || p.contains("_test.") || p.contains(".test.")
        || p.contains(".spec.")
}

fn is_test_symbol(name: &str) -> bool {
    name.starts_with("test_") || name.ends_with("_test") || name.starts_with("Test")
}

/// Apply heuristic reranking adjustments to normalised relevance scores.
pub(crate) fn apply_heuristic_rerank(results: &mut [CodeSearchResult], query: &str) {
    let pattern = detect_query_pattern(query);
    let query_terms: Vec<&str> = query.split_whitespace().collect();

    for r in results.iter_mut() {
        let mut multiplier = 1.0_f64;

        // 3.1 Context-aware term weighting
        multiplier *= contextual_penalty(&r.symbol, &query_terms);

        // 3.2 Symbol kind hierarchy
        multiplier *= kind_boost(&r.kind, &r.symbol);

        // 3.3 Pattern-specific boosts
        match pattern {
            QueryPattern::ExactSymbol => {
                let q_lower = query.to_lowercase();
                let s_lower = r.symbol.to_lowercase();
                if s_lower == q_lower {
                    multiplier *= 2.0;
                } else if s_lower.contains(&q_lower) || q_lower.contains(&s_lower) {
                    multiplier *= 1.3;
                }
            }
            QueryPattern::CompoundWithGeneric => {
                // Boost symbols that contain multiple query terms
                let hits: usize = query_terms
                    .iter()
                    .filter(|t| {
                        r.symbol
                            .to_lowercase()
                            .contains(&t.to_lowercase())
                    })
                    .count();
                if hits > 1 {
                    multiplier *= 1.0 + (hits as f64) * 0.3;
                }
            }
            QueryPattern::SemanticIntent => {
                // Prefer functions/methods for intent-style queries
                if r.kind == "function" || r.kind == "method" {
                    multiplier *= 1.2;
                }
            }
            _ => {}
        }

        // Demote test files/functions so production code surfaces first
        if is_test_path(&r.file) || is_test_symbol(&r.symbol) {
            multiplier *= 0.3;
        }

        r.relevance = (r.relevance * multiplier).min(1.0);
    }

    results.sort_by(|a, b| b.relevance.partial_cmp(&a.relevance).unwrap_or(std::cmp::Ordering::Equal));
}

// ---------------------------------------------------------------------------
// Snippet extraction helpers (Phase 1.2)
// ---------------------------------------------------------------------------

fn extract_snippet_from_lines(
    lines: &[String],
    target_line: u32,
    context: usize,
) -> (Option<String>, Option<Vec<String>>, Option<Vec<String>>) {
    let idx = target_line.saturating_sub(1) as usize; // 1-based → 0-based
    if idx >= lines.len() {
        return (None, None, None);
    }

    let snippet = Some(lines[idx].clone());

    let before_start = idx.saturating_sub(context);
    let ctx_before: Vec<String> = if before_start < idx {
        lines[before_start..idx].to_vec()
    } else {
        Vec::new()
    };

    let after_end = (idx + 1 + context).min(lines.len());
    let ctx_after: Vec<String> = if idx + 1 < after_end {
        lines[idx + 1..after_end].to_vec()
    } else {
        Vec::new()
    };

    (
        snippet,
        if ctx_before.is_empty() { None } else { Some(ctx_before) },
        if ctx_after.is_empty() { None } else { Some(ctx_after) },
    )
}

fn extract_snippet_from_body_preview(
    body_preview: &str,
    symbol_line: u32,
    target_line: u32,
    context: usize,
) -> (Option<String>, Option<Vec<String>>, Option<Vec<String>>) {
    let offset = target_line.saturating_sub(symbol_line) as usize;
    let lines: Vec<String> = body_preview.lines().map(String::from).collect();
    if offset >= lines.len() {
        return (None, None, None);
    }
    // Reuse the generic helper with a virtual line number
    extract_snippet_from_lines(&lines, (offset + 1) as u32, context)
}

// ---------------------------------------------------------------------------
// Frequency-based auto-penalties (Phase 3.4)
// ---------------------------------------------------------------------------

fn compute_auto_penalties(conn: &rusqlite::Connection) -> HashMap<String, f64> {
    let mut penalties = HashMap::new();

    let query = "SELECT LOWER(name) as lname, COUNT(*) as cnt \
                 FROM symbols GROUP BY lname ORDER BY cnt DESC";
    let Ok(mut stmt) = conn.prepare(query) else {
        return penalties;
    };

    let Ok(rows) = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    }) else {
        return penalties;
    };

    let mut counts: Vec<(String, i64)> = rows.filter_map(|r| r.ok()).collect();
    if counts.is_empty() {
        return penalties;
    }

    // Penalize the most common symbols (top 5%) — ubiquitous names like
    // toString, render, constructor add noise to search results.
    counts.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
    let top_n = (counts.len() * 5) / 100;
    let top_n = top_n.max(1);

    for (term, count) in counts.iter().take(top_n) {
        let penalty = 1.0 / (1.0 + (*count as f64).ln() / 5.0);
        penalties.insert(term.clone(), penalty.max(0.2));
    }

    penalties
}

// ---------------------------------------------------------------------------
// FTS5 query building with NEAR() proximity (Phase 3.5)
// ---------------------------------------------------------------------------

/// FTS5 reserved words that must be quoted when used as search terms.
const FTS5_RESERVED: &[&str] = &["AND", "OR", "NOT", "NEAR"];

/// Strip characters that break FTS5 MATCH syntax. Keeps alphanumeric, underscore,
/// and hyphen (hyphen is handled downstream by quoting). Collapses runs of stripped
/// chars into a single space so `foo::bar` becomes `foo bar` rather than `foobar`.
fn sanitize_fts_input(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_was_stripped = false;
    for ch in raw.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            prev_was_stripped = false;
            out.push(ch);
        } else if !prev_was_stripped && !out.is_empty() {
            out.push(' ');
            prev_was_stripped = true;
        }
    }
    out.trim().to_string()
}

/// Escape a term for safe use in FTS5 MATCH. Quotes reserved words to avoid
/// SQLite "parse error" when code_search receives terms like "context AND auth".
/// Also quotes terms containing hyphen (-) since FTS5 treats - as the NOT operator.
fn escape_fts_term(t: &str) -> String {
    let upper = t.to_uppercase();
    let needs_quoting = FTS5_RESERVED.iter().any(|r| *r == upper) || t.contains('-');
    if needs_quoting {
        format!("\"{}\"", t.replace('"', "\"\""))
    } else {
        t.replace('"', "\"\"")
    }
}

fn build_fts_query(query: &str) -> String {
    let sanitized = sanitize_fts_input(query);
    let tokens: Vec<String> = sanitized
        .split_whitespace()
        .map(|s| escape_fts_term(s))
        .filter(|s| !s.is_empty())
        .collect();
    if tokens.is_empty() {
        return "name:''".to_string();
    }
    if tokens.len() > 1 {
        let joined = tokens.join(" ");
        let near_clause = format!("NEAR({}, 3)", joined);
        let phrase = format!("\"{}\"", sanitized.replace('"', "\"\""));
        let or_terms: Vec<String> = tokens
            .iter()
            .map(|t| format!("(name:{} OR signature:{} OR body_preview:{})", t, t, t))
            .collect();
        format!("{} OR {} OR {}", near_clause, phrase, or_terms.join(" OR "))
    } else {
        let t = &tokens[0];
        format!("name:{} OR signature:{} OR body_preview:{}", t, t, t)
    }
}

// ---------------------------------------------------------------------------
// Main search implementation
// ---------------------------------------------------------------------------

/// Internal raw result before snippet population
struct RawSearchHit {
    symbol_id: Option<i64>,
    symbol: String,
    file: String,
    line: u32,
    kind: String,
    relevance: f64,
    /// Original BM25 score before normalization (negative; lower = better match)
    raw_bm25: f64,
    reason: Option<String>,
    signature: Option<String>,
    parent_symbol: Option<String>,
}

impl QueryEngine {
    /// Search code by intent/meaning using FTS5 with heuristic reranking and snippet extraction.
    pub fn search_code(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<CodeSearchResult>, QueryError> {
        self.search_code_full(query, limit, None, 1)
    }

    /// Full search with optional file cache and configurable context lines.
    /// `path_prefix`: when set, restricts FTS + fuzzy to files whose path starts with this prefix.
    pub fn search_code_full(
        &self,
        query: &str,
        limit: usize,
        file_cache: Option<&FileCache>,
        context_lines: usize,
    ) -> Result<Vec<CodeSearchResult>, QueryError> {
        self.search_code_full_inner(query, limit, file_cache, context_lines, None)
    }

    pub fn search_code_full_scoped(
        &self,
        query: &str,
        limit: usize,
        file_cache: Option<&FileCache>,
        context_lines: usize,
        path_prefix: &str,
    ) -> Result<Vec<CodeSearchResult>, QueryError> {
        let norm = path_prefix.replace('\\', "/");
        self.search_code_full_inner(query, limit, file_cache, context_lines, Some(norm))
    }

    fn search_code_full_inner(
        &self,
        query: &str,
        limit: usize,
        file_cache: Option<&FileCache>,
        context_lines: usize,
        path_prefix: Option<String>,
    ) -> Result<Vec<CodeSearchResult>, QueryError> {
        let structured = crate::query::structured::parse_structured_query(query);
        if structured.has_structured_fields() {
            return self.search_code_structured(&structured, limit, file_cache, context_lines);
        }

        let conn = self.conn();
        let fetch_limit = limit.min(100).max(1);
        let fetch_count = (fetch_limit * 3).min(150);

        let mut seen: HashSet<(String, String)> = HashSet::new();

        let fts_query = build_fts_query(query);

        let path_like = path_prefix.as_ref().map(|p| format!("{}%", p.trim_end_matches('/')));
        let path_clause = if path_like.is_some() {
            " AND REPLACE(f.path, CHAR(92), '/') LIKE ?3"
        } else {
            ""
        };

        let fts_sql = format!(
            "SELECT s.id, s.name, f.path, s.line, s.kind,
                    (bm25(symbols_fts, 10.0, 5.0, 0.01, 2.0)
                     - COALESCE(fi.importance_score, 0) * 0.1
                     - COALESCE(s.rank, 0) * 0.01) as rank,
                    json_extract(s.metadata, '$.parent_symbol'),
                    s.signature
             FROM symbols_fts
             JOIN symbols s ON symbols_fts.rowid = s.id
             JOIN files f ON s.file_id = f.id
             LEFT JOIN file_importance fi ON fi.file_id = f.id
             WHERE symbols_fts MATCH ?1{path_clause}
             ORDER BY rank
             LIMIT ?2"
        );
        let mut stmt = conn.prepare(&fts_sql)?;

        let map_row = |row: &rusqlite::Row| {
            let score = row.get::<_, f64>(5)?;
            Ok(RawSearchHit {
                symbol_id: Some(row.get(0)?),
                symbol: row.get(1)?,
                file: row.get(2)?,
                line: row.get(3)?,
                kind: row.get(4)?,
                relevance: score,
                raw_bm25: score,
                reason: Some(format!("FTS match: {}", query)),
                parent_symbol: row.get(6)?,
                signature: row.get(7)?,
            })
        };

        let mut raw_hits: Vec<RawSearchHit> = Vec::new();
        {
            let rows = if let Some(ref pl) = path_like {
                stmt.query_map(rusqlite::params![&fts_query, fetch_count as i64, pl], map_row)?
            } else {
                stmt.query_map(rusqlite::params![&fts_query, fetch_count as i64], map_row)?
            };
            for row in rows {
                let hit = row?;
                let key = (hit.file.clone(), hit.symbol.clone());
                if seen.insert(key) {
                    raw_hits.push(hit);
                }
            }
        }

        // Fuzzy fallback if FTS returned insufficient results.
        // Only for queries >= 4 chars to avoid overly broad substring matches
        // (e.g. "log" matching "dialog", "catalog", "prologue").
        let query_trimmed = query.trim();
        if raw_hits.len() < fetch_limit && query_trimmed.len() >= 4 {
            let remaining = fetch_limit - raw_hits.len();
            let escaped = query_trimmed.replace('%', "\\%").replace('_', "\\_");
            let pattern_prefix = format!("{}%", escaped);
            let pattern_word = format!("%\\_{}", escaped);
            let pattern_substr = format!("%{}%", escaped);

            let fuzzy_path_clause = if path_like.is_some() {
                " AND REPLACE(f.path, CHAR(92), '/') LIKE ?6"
            } else {
                ""
            };
            let fuzzy_sql = format!(
                "SELECT DISTINCT s.id, s.name, f.path, s.line, s.kind, s.rank,
                        json_extract(s.metadata, '$.parent_symbol'),
                        s.signature,
                        CASE
                            WHEN LOWER(s.name) LIKE LOWER(?1) ESCAPE '\\' THEN 0.3
                            WHEN LOWER(s.name) LIKE LOWER(?2) ESCAPE '\\' THEN 0.25
                            ELSE 0.15
                        END as fuzzy_weight
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE LOWER(s.name) LIKE LOWER(?3) ESCAPE '\\'
                    AND s.id NOT IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?4){fuzzy_path_clause}
                 ORDER BY fuzzy_weight DESC, s.rank DESC, s.name
                 LIMIT ?5"
            );
            let mut fuzzy_stmt = conn.prepare(&fuzzy_sql)?;

            let fuzzy_map = |row: &rusqlite::Row| {
                let fuzzy_weight: f64 = row.get(8)?;
                Ok(RawSearchHit {
                    symbol_id: Some(row.get(0)?),
                    symbol: row.get(1)?,
                    file: row.get(2)?,
                    line: row.get(3)?,
                    kind: row.get(4)?,
                    relevance: row.get::<_, f64>(5)? * fuzzy_weight,
                    raw_bm25: f64::MAX,
                    reason: Some(format!("Fuzzy match: {}", query)),
                    parent_symbol: row.get(6)?,
                    signature: row.get(7)?,
                })
            };

            let fuzzy_rows = if let Some(ref pl) = path_like {
                fuzzy_stmt.query_map(
                    rusqlite::params![&pattern_prefix, &pattern_word, &pattern_substr, &fts_query, (remaining * 2) as i64, pl],
                    fuzzy_map,
                )?
            } else {
                fuzzy_stmt.query_map(
                    rusqlite::params![&pattern_prefix, &pattern_word, &pattern_substr, &fts_query, (remaining * 2) as i64],
                    fuzzy_map,
                )?
            };

            for row in fuzzy_rows {
                let hit = row?;
                let key = (hit.file.clone(), hit.symbol.clone());
                if seen.insert(key) {
                    raw_hits.push(hit);
                }
            }
        }

        // Hybrid RRF: merge FTS order with deterministic vector ranking when embeddings exist.
        if query_trimmed.len() >= 3 {
            if let Ok(vec_ids) = Self::search_embedding_ids_with_conn(&conn, query_trimmed, fetch_count) {
                if !vec_ids.is_empty() && !raw_hits.is_empty() {
                    let fts_ids: Vec<i64> = raw_hits.iter().filter_map(|h| h.symbol_id).collect();
                    if !fts_ids.is_empty() {
                        let fused = hybrid::reciprocal_rank_fusion_ids(&[fts_ids, vec_ids], 60.0);
                        let rank_map: HashMap<i64, usize> = fused
                            .into_iter()
                            .enumerate()
                            .map(|(i, (id, _))| (id, i))
                            .collect();
                        raw_hits.sort_by_key(|h| {
                            h.symbol_id
                                .and_then(|id| rank_map.get(&id).copied())
                                .unwrap_or(10_000)
                        });
                    }
                }
            }
        }

        // Normalise BM25 scores to 0.0-1.0
        if raw_hits.len() > 1 {
            let min_s = raw_hits.iter().map(|r| r.relevance).fold(f64::INFINITY, f64::min);
            let max_s = raw_hits.iter().map(|r| r.relevance).fold(f64::NEG_INFINITY, f64::max);
            let range = max_s - min_s;
            if range > 1e-9 {
                for h in &mut raw_hits {
                    h.relevance = 1.0 - (h.relevance - min_s) / range;
                }
            } else {
                for h in &mut raw_hits {
                    h.relevance = 1.0;
                }
            }
        } else if raw_hits.len() == 1 {
            raw_hits[0].relevance = 1.0;
        }

        // Absolute quality floor: if the best raw BM25 score is very weak,
        // cap all normalized relevances. BM25 is negative (lower = better).
        // Best score close to 0 means even the top match barely matched.
        let best_raw = raw_hits.iter()
            .filter(|h| h.raw_bm25 < f64::MAX)
            .map(|h| h.raw_bm25)
            .fold(f64::INFINITY, f64::min);
        // If the best FTS match has a raw BM25 score worse than -2.0,
        // the query had very weak signal — cap relevance at 0.5 for all results.
        // For individual hits much worse than the best, further cap at 0.3.
        if best_raw > -2.0 && best_raw < f64::INFINITY {
            for h in &mut raw_hits {
                h.relevance = (h.relevance * 0.5).min(0.5);
            }
        } else if best_raw < f64::INFINITY {
            // Good top match exists — still cap hits that are 5x worse than the best
            for h in &mut raw_hits {
                if h.raw_bm25 < f64::MAX && h.raw_bm25 > best_raw * 0.2 {
                    h.relevance = h.relevance.min(0.3);
                }
            }
        }

        // Phase 3.4: frequency-based auto-penalties
        let auto_penalties = compute_auto_penalties(&conn);

        // Convert to CodeSearchResult (without snippets yet)
        let mut results: Vec<CodeSearchResult> = raw_hits
            .into_iter()
            .map(|h| {
                let mut relevance = h.relevance;
                if let Some(penalty) = auto_penalties.get(&h.symbol.to_lowercase()) {
                    relevance *= penalty;
                }
                let qualified_name = h.parent_symbol.as_ref().map(|p| {
                    format_qualified_symbol_name(&h.symbol, Some(p.as_str()))
                });
                CodeSearchResult {
                    symbol: h.symbol,
                    file: h.file,
                    line: h.line,
                    kind: h.kind,
                    relevance,
                    symbol_id: h.symbol_id,
                    source_workspace: None,
                    reason: h.reason,
                    signature: h.signature,
                    qualified_name,
                    snippet: None,
                    context_before: None,
                    context_after: None,
                }
            })
            .collect();

        // Phase 3: heuristic reranking
        apply_heuristic_rerank(&mut results, query);

        let ids: Vec<i64> = results.iter().filter_map(|r| r.symbol_id).collect();
        let boosts = feedback::load_boosts_with_conn(&conn, &ids);
        for r in &mut results {
            if let Some(sid) = r.symbol_id {
                if let Some(b) = boosts.get(&sid) {
                    r.relevance *= (1.0 + b * 0.08).min(2.0);
                }
            }
        }

        // Trim to requested limit
        results.truncate(fetch_limit);

        // Phase 1.2: populate snippets — collect body_preview data
        // We need body_preview info again; re-query just for the winning results.
        // Build a lookup map from the raw hits we already have.
        // Actually, we need to re-fetch body_preview for the final results.
        // To avoid a second query, reconstruct from the raw data.
        // Since we already consumed raw_hits, we do a batched snippet lookup.
        self.populate_snippets(&conn, &mut results, file_cache, context_lines)?;

        Ok(results)
    }

    /// Populate snippet fields on results using body_preview or file cache.
    pub(crate) fn populate_snippets(
        &self,
        conn: &rusqlite::Connection,
        results: &mut [CodeSearchResult],
        file_cache: Option<&FileCache>,
        context_lines: usize,
    ) -> Result<(), QueryError> {
        if results.is_empty() {
            return Ok(());
        }

        // Batch query: fetch body_preview, end_line, hash for each result
        // Group by file for efficiency
        let mut file_results: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, r) in results.iter().enumerate() {
            file_results.entry(r.file.clone()).or_default().push(i);
        }

        // For each file, fetch all symbol body_previews at once
        for (file_path, indices) in &file_results {
            // Try body_preview first for function-like symbols
            let mut need_file_read: Vec<usize> = Vec::new();

            for &idx in indices {
                let r = &results[idx];
                if matches!(r.kind.as_str(), "function" | "method" | "constructor" | "macro") {
                    // Try to get body_preview from DB
                    let bp_query = "SELECT s.body_preview, s.line, s.end_line FROM symbols s \
                                    JOIN files f ON s.file_id = f.id \
                                    WHERE f.path = ? AND s.name = ? AND s.line = ? LIMIT 1";
                    if let Ok(row) = conn.query_row(
                        bp_query,
                        rusqlite::params![file_path, r.symbol, r.line],
                        |row| {
                            Ok((
                                row.get::<_, Option<String>>(0)?,
                                row.get::<_, u32>(1)?,
                                row.get::<_, Option<u32>>(2)?,
                            ))
                        },
                    ) {
                        if let (Some(ref bp), sym_line, _) = row {
                            if !bp.trim().is_empty() {
                                let (snippet, before, after) =
                                    extract_snippet_from_body_preview(bp, sym_line, r.line, context_lines);
                                if snippet.is_some() {
                                    results[idx].snippet = snippet;
                                    results[idx].context_before = before;
                                    results[idx].context_after = after;
                                    continue;
                                }
                            }
                        }
                    }
                }
                need_file_read.push(idx);
            }

            if need_file_read.is_empty() {
                continue;
            }

            // Get file hash for cache key
            let hash: String = conn
                .query_row(
                    "SELECT hash FROM files WHERE path = ? LIMIT 1",
                    [file_path.as_str()],
                    |row| row.get(0),
                )
                .unwrap_or_default();

            // Try file cache or read from disk
            let root = self.root_path_from_db(conn);
            let lines = if let Some(cache) = file_cache {
                cache.get_lines(file_path, &hash, &root)
            } else {
                // Direct read
                let full = if Path::new(file_path).is_absolute() {
                    PathBuf::from(file_path)
                } else {
                    root.join(file_path)
                };
                std::fs::read_to_string(&full)
                    .ok()
                    .map(|c| c.lines().map(String::from).collect())
            };

            if let Some(lines) = lines {
                for idx in need_file_read {
                    let r = &results[idx];
                    let (snippet, before, after) =
                        extract_snippet_from_lines(&lines, r.line, context_lines);
                    results[idx].snippet = snippet;
                    results[idx].context_before = before;
                    results[idx].context_after = after;
                }
            }
        }

        Ok(())
    }

    /// Best-effort project root derivation from file paths in the DB.
    fn root_path_from_db(&self, conn: &rusqlite::Connection) -> PathBuf {
        let path: String = conn
            .query_row("SELECT path FROM files LIMIT 1", [], |row| row.get(0))
            .unwrap_or_default();
        // Heuristic: walk up to find a plausible root (parent of src/)
        let p = Path::new(&path);
        if p.is_absolute() {
            for ancestor in p.ancestors() {
                if ancestor.join("Cargo.toml").exists()
                    || ancestor.join("package.json").exists()
                    || ancestor.join(".git").exists()
                {
                    return ancestor.to_path_buf();
                }
            }
            p.parent().unwrap_or(p).to_path_buf()
        } else {
            PathBuf::from(".")
        }
    }

    /// Search with snippet extraction using the provided root path and file cache.
    pub fn search_code_with_context(
        &self,
        query: &str,
        limit: usize,
        root_path: &Path,
        file_cache: &FileCache,
        context_lines: usize,
    ) -> Result<Vec<CodeSearchResult>, QueryError> {
        let mut results = self.search_code_full(query, limit, Some(file_cache), context_lines)?;
        // Ensure we tried snippet population with explicit root
        for r in &mut results {
            if r.snippet.is_none() {
                let full = if Path::new(&r.file).is_absolute() {
                    PathBuf::from(&r.file)
                } else {
                    root_path.join(&r.file)
                };
                if let Some(lines) = file_cache.get_lines(&r.file, &r.file, root_path) {
                    let (snippet, before, after) =
                        extract_snippet_from_lines(&lines, r.line, context_lines);
                    r.snippet = snippet;
                    r.context_before = before;
                    r.context_after = after;
                } else if let Ok(content) = std::fs::read_to_string(&full) {
                    let lines: Vec<String> = content.lines().map(String::from).collect();
                    let (snippet, before, after) =
                        extract_snippet_from_lines(&lines, r.line, context_lines);
                    r.snippet = snippet;
                    r.context_before = before;
                    r.context_after = after;
                }
            }
        }
        Ok(results)
    }

    /// Group search results by file (Phase 2).
    pub fn search_code_grouped(
        &self,
        query: &str,
        limit: usize,
        file_cache: Option<&FileCache>,
        context_lines: usize,
    ) -> Result<GroupedSearchResults, QueryError> {
        let results = self.search_code_full(query, limit, file_cache, context_lines)?;
        let total = results.len();

        // Preserve insertion order using Vec + HashMap for index lookup
        let mut order: Vec<String> = Vec::new();
        let mut groups_map: HashMap<String, Vec<GroupMatch>> = HashMap::new();
        for r in &results {
            if !groups_map.contains_key(&r.file) {
                order.push(r.file.clone());
            }
            groups_map
                .entry(r.file.clone())
                .or_default()
                .push(r.to_group_match());
        }

        let groups = order
            .into_iter()
            .filter_map(|file| {
                groups_map.remove(&file).map(|matches| FileGroup { file, matches })
            })
            .collect();

        Ok(GroupedSearchResults {
            query: query.to_string(),
            groups,
            total_matches: total,
        })
    }

    /// Return tiered results: high/medium/low confidence buckets (Phase 4).
    pub fn search_code_tiered(
        &self,
        query: &str,
        limit: usize,
        file_cache: Option<&FileCache>,
    ) -> Result<TieredSearchResponse, QueryError> {
        // Fetch more than requested so we can tier
        let expanded_limit = (limit * 2).min(50);
        let mut results = self.search_code_full(query, expanded_limit, file_cache, 1)?;
        let total = results.len();

        let mut high: Vec<CodeSearchResult> = Vec::new();
        let mut medium: Vec<CodeSearchResult> = Vec::new();
        let mut low_count: usize = 0;

        for mut r in results.drain(..) {
            if r.relevance > 0.8 && high.len() < 5 {
                // Full snippet + context already populated
                high.push(r);
            } else if r.relevance >= 0.5 && medium.len() < 5 {
                // Strip context, keep snippet only
                r.context_before = None;
                r.context_after = None;
                medium.push(r);
            } else {
                low_count += 1;
            }
        }

        Ok(TieredSearchResponse {
            query: query.to_string(),
            high_confidence: high,
            medium_confidence: medium,
            low_confidence_count: low_count,
            total_matches: total,
        })
    }

    /// Rank symbol IDs by cosine similarity of deterministic embeddings (empty if table unused).
    pub fn search_symbol_ids_by_embedding(&self, query: &str, limit: usize) -> Result<Vec<i64>, QueryError> {
        let conn = self.conn();
        Self::search_embedding_ids_with_conn(&conn, query, limit)
    }

    fn search_embedding_ids_with_conn(conn: &rusqlite::Connection, query: &str, limit: usize) -> Result<Vec<i64>, QueryError> {
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM symbol_embeddings", [], |r| r.get(0))?;
        if n == 0 {
            return Ok(Vec::new());
        }
        let qv = hybrid::deterministic_embed(query);
        let cap = limit.min(200).max(1);
        let mut stmt = conn.prepare("SELECT symbol_id, vec FROM symbol_embeddings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut scored: Vec<(i64, f32)> = Vec::new();
        for row in rows {
            let (id, blob) = row?;
            let v = hybrid::blob_to_vec(&blob);
            if v.len() != hybrid::EMBEDDING_DIM {
                continue;
            }
            let s = hybrid::cosine_similarity(&qv, &v);
            scored.push((id, s));
        }
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored.into_iter().take(cap).map(|(id, _)| id).collect())
    }

    /// Multi-DB search: merge by relevance (read-only connections; label → `source_workspace`).
    pub fn search_code_federated(
        db_paths: &[(String, std::path::PathBuf)],
        query: &str,
        per_db_limit: usize,
        total_limit: usize,
    ) -> Result<Vec<CodeSearchResult>, QueryError> {
        use crate::db::Database;
        use rusqlite::OpenFlags;

        let mut all: Vec<CodeSearchResult> = Vec::new();
        for (label, path) in db_paths {
            let conn = rusqlite::Connection::open_with_flags(path.as_path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(QueryError::Sqlite)?;
            let db = Database::from_connection_skip_init(conn);
            let qe = QueryEngine::new(db);
            let mut chunk = qe.search_code_full(query, per_db_limit, None, 1)?;
            for r in &mut chunk {
                r.source_workspace = Some(label.clone());
            }
            all.extend(chunk);
        }
        all.sort_by(|a, b| {
            b.relevance
                .partial_cmp(&a.relevance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        all.truncate(total_limit.min(100).max(1));
        Ok(all)
    }

    /// Structured `key:value` filters with optional FTS on free-text remainder.
    pub fn search_code_structured(
        &self,
        filters: &StructuredFilters,
        limit: usize,
        file_cache: Option<&FileCache>,
        context_lines: usize,
    ) -> Result<Vec<CodeSearchResult>, QueryError> {
        let conn = self.conn();
        let fetch_limit = limit.min(100).max(1);

        let mut sql = String::from(
            "SELECT s.id, s.name, f.path, s.line, s.kind, s.rank, s.signature,
                    json_extract(s.metadata, '$.parent_symbol')
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE 1=1",
        );
        let mut qp: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(ref k) = filters.kind {
            let kl = k.to_lowercase();
            match kl.as_str() {
                "fn" | "function" => {
                    sql.push_str(
                        " AND s.kind IN ('function', 'method', 'arrow_function', 'generator_function')",
                    );
                }
                "class" | "cls" => sql.push_str(" AND s.kind = 'class'"),
                "method" => sql.push_str(" AND s.kind = 'method'"),
                "struct" => sql.push_str(" AND s.kind = 'struct'"),
                "enum" => sql.push_str(" AND s.kind = 'enum'"),
                "interface" | "trait" => {
                    sql.push_str(" AND s.kind IN ('interface', 'trait')");
                }
                _ => {
                    sql.push_str(" AND s.kind = ?");
                    qp.push(Box::new(k.clone()));
                }
            }
        }

        if let Some(ref n) = filters.name {
            let pat = if n.contains('*') {
                n.replace('*', "%")
            } else {
                format!("%{}%", n)
            };
            sql.push_str(" AND s.name LIKE ? ESCAPE '\\'");
            qp.push(Box::new(pat));
        }

        if let Some(ref path) = filters.file {
            let pat = if path.contains('*') {
                path.replace('*', "%")
            } else {
                format!("%{}%", path.replace('\\', "/"))
            };
            sql.push_str(" AND f.path LIKE ? ESCAPE '\\'");
            qp.push(Box::new(pat.replace('\\', "/")));
        }

        if let Some(ref lang) = filters.lang {
            sql.push_str(" AND LOWER(f.language) = LOWER(?)");
            qp.push(Box::new(lang.clone()));
        }

        if let Some(ref r) = filters.returns {
            sql.push_str(
                " AND LOWER(COALESCE(json_extract(s.metadata, '$.return_type'), '')) LIKE LOWER(?) ESCAPE '\\'",
            );
            let pat = format!("%{}%", r.replace('%', "\\%").replace('_', "\\_"));
            qp.push(Box::new(pat));
        }

        if let Some(cmin) = filters.complexity_min {
            sql.push_str(" AND s.complexity >= ?");
            qp.push(Box::new(cmin));
        }
        if let Some(cmax) = filters.complexity_max {
            sql.push_str(" AND s.complexity <= ?");
            qp.push(Box::new(cmax));
        }

        if let Some(pmin) = filters.params_min {
            sql.push_str(
                " AND COALESCE(json_array_length(json_extract(s.metadata, '$.parameters')), 0) >= ?",
            );
            qp.push(Box::new(pmin));
        }
        if let Some(pmax) = filters.params_max {
            sql.push_str(
                " AND COALESCE(json_array_length(json_extract(s.metadata, '$.parameters')), 0) <= ?",
            );
            qp.push(Box::new(pmax));
        }

        if let Some(ref callee) = filters.calls {
            sql.push_str(
                " AND EXISTS (SELECT 1 FROM symbol_relations sr JOIN symbols s2 ON sr.to_symbol_id = s2.id
                     WHERE sr.from_symbol_id = s.id AND sr.type = 'CALLS' AND s2.name = ?)",
            );
            qp.push(Box::new(callee.clone()));
        }

        if let Some(ref ft) = filters.free_text {
            if !ft.trim().is_empty() {
                let fts_q = build_fts_query(ft.trim());
                sql.push_str(" AND s.id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?)");
                qp.push(Box::new(fts_q));
            }
        }

        sql.push_str(" ORDER BY s.rank DESC, s.name LIMIT ?");
        qp.push(Box::new((fetch_limit * 2) as i64));

        let mut stmt = conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = qp.iter().map(|p| p.as_ref()).collect();
        let mut seen: HashSet<(String, String)> = HashSet::new();
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            let parent: Option<String> = row.get(7)?;
            let symbol: String = row.get(1)?;
            let qualified_name = parent
                .as_ref()
                .map(|p| format_qualified_symbol_name(&symbol, Some(p.as_str())));
            Ok(CodeSearchResult {
                symbol,
                file: row.get(2)?,
                line: row.get(3)?,
                kind: row.get(4)?,
                relevance: (row.get::<_, f64>(5)?).max(0.01),
                symbol_id: Some(row.get(0)?),
                source_workspace: None,
                reason: Some("structured query".into()),
                signature: row.get(6)?,
                qualified_name,
                snippet: None,
                context_before: None,
                context_after: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            let r = row?;
            let key = (r.file.clone(), r.symbol.clone());
            if seen.insert(key) {
                results.push(r);
                if results.len() >= fetch_limit {
                    break;
                }
            }
        }

        let q_for_rerank = filters
            .free_text
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("");
        if !q_for_rerank.is_empty() {
            apply_heuristic_rerank(&mut results, q_for_rerank);
        }
        results.truncate(fetch_limit);
        self.populate_snippets(&conn, &mut results, file_cache, context_lines)?;
        Ok(results)
    }

    /// Search by symbol kind (e.g., "class User")
    pub fn search_by_kind(
        &self,
        kind: &str,
        query: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CodeSearchResult>, QueryError> {
        let conn = self.db.conn();
        let limit = limit.min(100).max(1);

        let mut seen: HashSet<(String, String)> = HashSet::new();

        let mut sql = String::from(
            "SELECT s.id, s.name, f.path, s.line, s.kind, s.rank,
                    json_extract(s.metadata, '$.parent_symbol'), s.signature
             FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE s.kind = ?"
        );

        let kind_str = kind.to_string();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(kind_str.clone())];

        if let Some(q) = query {
            sql.push_str(" AND s.name LIKE ? ESCAPE '\\'");
            let pattern = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
            params.push(Box::new(pattern));
        }

        sql.push_str(" ORDER BY s.rank DESC, s.name LIMIT ?");
        params.push(Box::new((limit * 2) as i64));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            let parent: Option<String> = row.get(6)?;
            let symbol: String = row.get(1)?;
            let qualified_name = parent
                .as_ref()
                .map(|p| format_qualified_symbol_name(&symbol, Some(p.as_str())));
            Ok(CodeSearchResult {
                symbol,
                file: row.get(2)?,
                line: row.get(3)?,
                kind: row.get(4)?,
                relevance: row.get::<_, f64>(5)?,
                symbol_id: Some(row.get(0)?),
                source_workspace: None,
                reason: Some(format!("Kind: {}, query: {:?}", kind_str, query)),
                signature: row.get(7)?,
                qualified_name,
                snippet: None,
                context_before: None,
                context_after: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            let result = row?;
            let key = (result.file.clone(), result.symbol.clone());
            if seen.insert(key) {
                results.push(result);
                if results.len() >= limit {
                    break;
                }
            }
        }

        Ok(results)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- Unit tests for query pattern detection --

    #[test]
    fn test_detect_exact_symbol() {
        assert_eq!(detect_query_pattern("refresh_token"), QueryPattern::ExactSymbol);
        assert_eq!(detect_query_pattern("camelCase"), QueryPattern::ExactSymbol);
        assert_eq!(detect_query_pattern("getUserById"), QueryPattern::ExactSymbol);
    }

    #[test]
    fn test_detect_compound_with_generic() {
        assert_eq!(
            detect_query_pattern("authentication token refresh"),
            QueryPattern::CompoundWithGeneric
        );
        assert_eq!(
            detect_query_pattern("error handling"),
            QueryPattern::CompoundWithGeneric
        );
    }

    #[test]
    fn test_detect_common_keyword() {
        assert_eq!(detect_query_pattern("async"), QueryPattern::CommonKeyword);
        assert_eq!(detect_query_pattern("interface"), QueryPattern::CommonKeyword);
    }

    #[test]
    fn test_detect_semantic_intent() {
        assert_eq!(
            detect_query_pattern("user login"),
            QueryPattern::SemanticIntent
        );
        assert_eq!(
            detect_query_pattern("database connection"),
            QueryPattern::SemanticIntent
        );
    }

    #[test]
    fn test_detect_generic() {
        assert_eq!(detect_query_pattern("x"), QueryPattern::Generic);
    }

    // -- Unit tests for heuristic functions --

    #[test]
    fn test_has_camel_case() {
        assert!(has_camel_case("camelCase"));
        assert!(has_camel_case("getUserById"));
        assert!(!has_camel_case("lowercase"));
        assert!(!has_camel_case("UPPERCASE"));
        assert!(!has_camel_case("snake_case"));
    }

    #[test]
    fn test_contextual_penalty_generic_alone() {
        let penalty = contextual_penalty("token", &["token"]);
        assert!(penalty < 0.5, "Generic term alone should be penalised, got {}", penalty);
    }

    #[test]
    fn test_contextual_penalty_generic_with_modifier() {
        let penalty = contextual_penalty("token", &["refresh", "token"]);
        assert!(
            (penalty - 1.0).abs() < 1e-9,
            "Generic term with modifier should not be penalised, got {}",
            penalty
        );
    }

    #[test]
    fn test_contextual_penalty_compound_symbol() {
        let boost = contextual_penalty("refresh_token", &["refresh", "token"]);
        assert!(boost > 1.0, "Compound identifier should be boosted, got {}", boost);
    }

    #[test]
    fn test_kind_boost_function_higher_than_variable() {
        let fn_boost = kind_boost("function", "authenticate");
        let var_boost = kind_boost("variable", "x");
        assert!(fn_boost > var_boost, "Functions should rank higher than short variables");
    }

    #[test]
    fn test_kind_boost_class_higher_than_variable() {
        let cls = kind_boost("class", "UserService");
        let var = kind_boost("variable", "tmp");
        assert!(cls > var);
    }

    // -- Unit tests for snippet extraction --

    #[test]
    fn test_extract_snippet_from_lines_middle() {
        let lines: Vec<String> = vec![
            "line 0".into(),
            "line 1".into(),
            "line 2 target".into(),
            "line 3".into(),
            "line 4".into(),
        ];
        let (snippet, before, after) = extract_snippet_from_lines(&lines, 3, 1); // 1-based line 3
        assert_eq!(snippet.as_deref(), Some("line 2 target"));
        assert_eq!(before, Some(vec!["line 1".to_string()]));
        assert_eq!(after, Some(vec!["line 3".to_string()]));
    }

    #[test]
    fn test_extract_snippet_from_lines_first_line() {
        let lines: Vec<String> = vec!["first".into(), "second".into()];
        let (snippet, before, after) = extract_snippet_from_lines(&lines, 1, 1);
        assert_eq!(snippet.as_deref(), Some("first"));
        assert_eq!(before, None);
        assert_eq!(after, Some(vec!["second".to_string()]));
    }

    #[test]
    fn test_extract_snippet_from_lines_last_line() {
        let lines: Vec<String> = vec!["first".into(), "last".into()];
        let (snippet, before, after) = extract_snippet_from_lines(&lines, 2, 1);
        assert_eq!(snippet.as_deref(), Some("last"));
        assert_eq!(before, Some(vec!["first".to_string()]));
        assert_eq!(after, None);
    }

    #[test]
    fn test_extract_snippet_from_lines_out_of_bounds() {
        let lines: Vec<String> = vec!["only".into()];
        let (snippet, _, _) = extract_snippet_from_lines(&lines, 99, 1);
        assert!(snippet.is_none());
    }

    #[test]
    fn test_extract_snippet_from_body_preview() {
        let body = "  let x = 1;\n  let y = 2;\n  return x + y;";
        let (snippet, before, after) = extract_snippet_from_body_preview(body, 10, 11, 1);
        assert_eq!(snippet.as_deref(), Some("  let y = 2;"));
        assert_eq!(before, Some(vec!["  let x = 1;".to_string()]));
        assert_eq!(after, Some(vec!["  return x + y;".to_string()]));
    }

    // -- Unit tests for FTS query building --

    #[test]
    fn test_build_fts_query_single_word() {
        let q = build_fts_query("token");
        assert!(q.contains("name:token"), "Single word should be scoped to name column, got: {}", q);
        assert!(q.contains("signature:token"), "Single word should also search signature, got: {}", q);
    }

    #[test]
    fn test_build_fts_query_multi_word() {
        let q = build_fts_query("refresh token");
        assert!(q.contains("NEAR(refresh token, 3)"), "Should contain NEAR clause, got: {}", q);
        assert!(q.contains("\"refresh token\""), "Should contain phrase, got: {}", q);
        // OR fallback should be scoped to name+signature columns
        assert!(q.contains("name:refresh"), "OR terms should be column-scoped, got: {}", q);
        assert!(q.contains("name:token"), "OR terms should be column-scoped, got: {}", q);
    }

    // -- Unit tests for FTS input sanitization --

    #[test]
    fn test_sanitize_fts_angle_brackets() {
        assert_eq!(sanitize_fts_input("<CloseIcon>"), "CloseIcon");
        assert_eq!(sanitize_fts_input("<div>"), "div");
        assert_eq!(sanitize_fts_input("<<nested>>"), "nested");
    }

    #[test]
    fn test_sanitize_fts_colons() {
        assert_eq!(sanitize_fts_input("foo::bar"), "foo bar");
        assert_eq!(sanitize_fts_input("std::collections::HashMap"), "std collections HashMap");
    }

    #[test]
    fn test_sanitize_fts_brackets() {
        assert_eq!(sanitize_fts_input("[Symbol]"), "Symbol");
        assert_eq!(sanitize_fts_input("Vec<T>"), "Vec T");
        assert_eq!(sanitize_fts_input("Map{key}"), "Map key");
    }

    #[test]
    fn test_sanitize_fts_preserves_identifiers() {
        assert_eq!(sanitize_fts_input("snake_case"), "snake_case");
        assert_eq!(sanitize_fts_input("camelCase"), "camelCase");
        assert_eq!(sanitize_fts_input("kebab-case"), "kebab-case");
    }

    #[test]
    fn test_sanitize_fts_mixed_special_chars() {
        assert_eq!(sanitize_fts_input("@Component({selector: 'app'})"), "Component selector app");
        assert_eq!(sanitize_fts_input("#include <stdio.h>"), "include stdio h");
    }

    #[test]
    fn test_sanitize_fts_empty_after_strip() {
        assert_eq!(sanitize_fts_input("<>"), "");
        assert_eq!(sanitize_fts_input("::"), "");
        assert_eq!(sanitize_fts_input(""), "");
    }

    #[test]
    fn test_build_fts_query_with_angle_brackets() {
        let q = build_fts_query("<CloseIcon>");
        assert!(q.contains("name:CloseIcon"), "Angle brackets should be stripped, got: {}", q);
        assert!(!q.contains("<"), "No angle brackets in FTS query, got: {}", q);
    }

    #[test]
    fn test_build_fts_query_with_colons() {
        let q = build_fts_query("foo::bar");
        assert!(q.contains("name:foo"), "Double-colon should split into tokens, got: {}", q);
        assert!(q.contains("name:bar"), "Double-colon should split into tokens, got: {}", q);
    }

    // -- Unit tests for heuristic reranking --

    #[test]
    fn test_reranking_boosts_compound_match() {
        let mut results = vec![
            CodeSearchResult {
                symbol: "token".into(),
                file: "a.ts".into(),
                line: 1,
                kind: "variable".into(),
                relevance: 0.9,
                symbol_id: None,
                source_workspace: None,
                reason: None,
                signature: None,
                qualified_name: None,
                snippet: None,
                context_before: None,
                context_after: None,
            },
            CodeSearchResult {
                symbol: "refresh_token".into(),
                file: "b.ts".into(),
                line: 5,
                kind: "function".into(),
                relevance: 0.8,
                symbol_id: None,
                source_workspace: None,
                reason: None,
                signature: None,
                qualified_name: None,
                snippet: None,
                context_before: None,
                context_after: None,
            },
        ];
        apply_heuristic_rerank(&mut results, "refresh token");
        assert_eq!(
            results[0].symbol, "refresh_token",
            "Compound function should rank above generic variable after reranking"
        );
    }

    #[test]
    fn test_reranking_exact_symbol_match() {
        let mut results = vec![
            CodeSearchResult {
                symbol: "getUserById".into(),
                file: "a.ts".into(),
                line: 1,
                kind: "function".into(),
                relevance: 0.7,
                symbol_id: None,
                source_workspace: None,
                reason: None,
                signature: None,
                qualified_name: None,
                snippet: None,
                context_before: None,
                context_after: None,
            },
            CodeSearchResult {
                symbol: "user".into(),
                file: "b.ts".into(),
                line: 5,
                kind: "variable".into(),
                relevance: 0.9,
                symbol_id: None,
                source_workspace: None,
                reason: None,
                signature: None,
                qualified_name: None,
                snippet: None,
                context_before: None,
                context_after: None,
            },
        ];
        apply_heuristic_rerank(&mut results, "getUserById");
        assert_eq!(
            results[0].symbol, "getUserById",
            "Exact symbol match should rank first"
        );
    }

    // -- File cache tests --

    #[test]
    fn test_file_cache_creation() {
        let cache = FileCache::new(10);
        let result = cache.get_lines("nonexistent.txt", "abc", Path::new("."));
        assert!(result.is_none());
    }

    // -- Grouped results test --

    #[test]
    fn test_group_match_conversion() {
        let result = CodeSearchResult {
            symbol: "foo".into(),
            file: "test.rs".into(),
            line: 42,
            kind: "function".into(),
            relevance: 0.95,
            symbol_id: None,
            source_workspace: None,
            reason: None,
            signature: Some("fn foo()".into()),
            qualified_name: None,
            snippet: Some("fn foo() { }".into()),
            context_before: None,
            context_after: None,
        };
        let gm = result.to_group_match();
        assert_eq!(gm.symbol, "foo");
        assert_eq!(gm.line, 42);
        assert_eq!(gm.snippet.as_deref(), Some("fn foo() { }"));
    }

    // -- Compact result test --

    #[test]
    fn test_compact_includes_snippet() {
        let result = CodeSearchResult {
            symbol: "bar".into(),
            file: "test.rs".into(),
            line: 10,
            kind: "method".into(),
            relevance: 0.8,
            symbol_id: None,
            source_workspace: None,
            reason: None,
            signature: None,
            qualified_name: None,
            snippet: Some("fn bar()".into()),
            context_before: None,
            context_after: None,
        };
        let compact = result.to_compact();
        assert_eq!(compact.c.as_deref(), Some("fn bar()"));
        assert_eq!(compact.s, "bar");
    }

    // -- 33 test queries for benchmarking --
    // These are golden queries from the search accuracy analysis.
    // In a real integration test these would run against an indexed project.

    #[test]
    fn test_golden_query_list() {
        let queries = golden_test_queries();
        assert_eq!(queries.len(), 33, "Must have exactly 33 golden queries");
        for q in &queries {
            assert!(!q.is_empty(), "No empty queries allowed");
        }
    }

    /// Returns the 33 diverse test queries from the search accuracy analysis.
    pub fn golden_test_queries() -> Vec<&'static str> {
        vec![
            // General concepts (5)
            "authentication",
            "error handling",
            "database connection",
            "file upload",
            "user management",
            // Technical features (5)
            "rate limiting",
            "caching strategy",
            "websocket connection",
            "api versioning",
            "middleware pipeline",
            // Compound queries (7)
            "authentication token refresh",
            "database query optimization",
            "file upload validation",
            "user session management",
            "api error response format",
            "request body parsing",
            "config environment variables",
            // Specific technical (8)
            "async await pattern",
            "stream processing",
            "hash map lookup",
            "binary search implementation",
            "dependency injection",
            "event emitter",
            "state machine transitions",
            "retry with backoff",
            // Common patterns (8)
            "singleton pattern",
            "factory method",
            "observer pattern",
            "builder pattern",
            "decorator pattern",
            "command pattern",
            "strategy pattern",
            "adapter pattern",
        ]
    }

    /// Diagnostic: time each phase of search against a real DB.
    /// Run with: cargo test -p atls-core -- --nocapture diagnose_search_perf --ignored
    #[test]
    #[ignore]
    fn diagnose_search_perf() {
        use std::time::Instant;

        let db_path = std::path::Path::new("F:/source/atls-studio/.atls/atls.db");
        if !db_path.exists() {
            eprintln!("SKIP: no DB at {:?}", db_path);
            return;
        }

        // Use a raw connection for diagnostics (not wrapped in Database/Mutex)
        let raw = rusqlite::Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ).expect("open DB");
        raw.pragma_update(None, "busy_timeout", 30000u32).unwrap();

        let sym_count: i64 = raw.query_row("SELECT COUNT(*) FROM symbols", [], |r| r.get(0)).unwrap();
        let emb_count: i64 = raw.query_row("SELECT COUNT(*) FROM symbol_embeddings", [], |r| r.get(0)).unwrap();
        let file_count: i64 = raw.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0)).unwrap();
        eprintln!("DB stats: {} symbols, {} embeddings, {} files", sym_count, emb_count, file_count);

        let queries = ["parser", "parse", "parsing"];

        for q in &queries {
            eprintln!("\n=== Query: '{}' ===", q);

            let fts_q = build_fts_query(q);
            eprintln!("  FTS query: '{}'", fts_q);

            // Phase 1: FTS
            let t = Instant::now();
            let fts_count: i64 = raw.query_row(
                "SELECT COUNT(*) FROM symbols_fts WHERE symbols_fts MATCH ?",
                [&fts_q],
                |r| r.get(0),
            ).unwrap_or(-1);
            let fts_ms = t.elapsed().as_millis();
            eprintln!("  FTS MATCH: {} hits in {}ms", fts_count, fts_ms);

            // Phase 1b: FTS with JOIN (what search_code_full actually does)
            let t = Instant::now();
            let mut stmt = raw.prepare(
                "SELECT COUNT(*) FROM symbols_fts
                 JOIN symbols s ON symbols_fts.rowid = s.id
                 JOIN files f ON s.file_id = f.id
                 LEFT JOIN file_importance fi ON fi.file_id = f.id
                 WHERE symbols_fts MATCH ?"
            ).unwrap();
            let fts_join_count: i64 = stmt.query_row([&fts_q], |r| r.get(0)).unwrap_or(-1);
            let fts_join_ms = t.elapsed().as_millis();
            eprintln!("  FTS+JOIN: {} hits in {}ms", fts_join_count, fts_join_ms);

            // Phase 1c: FTS with path scope
            let t = Instant::now();
            let mut stmt2 = raw.prepare(
                "SELECT COUNT(*) FROM symbols_fts
                 JOIN symbols s ON symbols_fts.rowid = s.id
                 JOIN files f ON s.file_id = f.id
                 WHERE symbols_fts MATCH ?
                   AND REPLACE(f.path, CHAR(92), '/') LIKE 'atls-rs/crates/atls-core/src%'"
            ).unwrap();
            let scoped_count: i64 = stmt2.query_row([&fts_q], |r| r.get(0)).unwrap_or(-1);
            let scoped_ms = t.elapsed().as_millis();
            eprintln!("  FTS+JOIN+scope: {} hits in {}ms", scoped_count, scoped_ms);

            // Phase 2: Fuzzy LIKE
            let t = Instant::now();
            let pat = format!("%{}%", q);
            let fuzzy_count: i64 = raw.query_row(
                "SELECT COUNT(*) FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 WHERE LOWER(s.name) LIKE LOWER(?)",
                [&pat],
                |r| r.get(0),
            ).unwrap_or(-1);
            let fuzzy_ms = t.elapsed().as_millis();
            eprintln!("  Fuzzy LIKE: {} hits in {}ms", fuzzy_count, fuzzy_ms);

            // Phase 3: Embedding scan
            let t = Instant::now();
            let mut emb_stmt = raw.prepare("SELECT symbol_id, vec FROM symbol_embeddings").unwrap();
            let mut emb_scanned = 0i64;
            let rows = emb_stmt.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            }).unwrap();
            for row in rows {
                let (_id, blob) = row.unwrap();
                let v = super::hybrid::blob_to_vec(&blob);
                if v.len() == super::hybrid::EMBEDDING_DIM {
                    emb_scanned += 1;
                }
            }
            let emb_ms = t.elapsed().as_millis();
            eprintln!("  Embedding scan: {} vectors in {}ms", emb_scanned, emb_ms);
        }

        drop(raw);

        // Phase 4: Full search_code_full (separate Database instance — own Mutex)
        eprintln!("\n=== Full search_code_full('parser', 15) ===");
        let conn2 = rusqlite::Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ).unwrap();
        conn2.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn2.pragma_update(None, "busy_timeout", 30000u32).unwrap();
        let db2 = crate::db::Database::from_connection_skip_init(conn2);
        let qe = QueryEngine::new(db2);
        let t = Instant::now();
        let results = qe.search_code_full("parser", 15, None, 1);
        let full_ms = t.elapsed().as_millis();
        eprintln!("  search_code_full: {} results in {}ms", results.as_ref().map(|r| r.len()).unwrap_or(0), full_ms);

        // Phase 5: Full scoped
        eprintln!("\n=== Full search_code_full_scoped('parser', 15, 'atls-rs/') ===");
        let t = Instant::now();
        let scoped = qe.search_code_full_scoped("parser", 15, None, 1, "atls-rs/");
        let scoped_ms = t.elapsed().as_millis();
        eprintln!("  scoped: {} results in {}ms", scoped.as_ref().map(|r| r.len()).unwrap_or(0), scoped_ms);
    }
}
