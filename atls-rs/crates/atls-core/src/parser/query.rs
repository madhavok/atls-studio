use crate::parser::captures::QueryMatch;
use crate::file::Language;
use tree_sitter::{Query, Tree};
use thiserror::Error;

/// Per-query timeout: 5 seconds in microseconds.
/// Prevents any single tree-sitter query from hanging the scan.
const QUERY_TIMEOUT_MICROS: u64 = 5_000_000;

/// Max in-progress matches per query. Bounds memory and CPU for
/// overly-broad patterns that produce thousands of partial matches.
const QUERY_MATCH_LIMIT: u32 = 10_000;

/// Errors that can occur when compiling or executing queries
#[derive(Debug, Error)]
pub enum QueryError {
    #[error("Failed to compile query: {0}")]
    CompilationError(String),
    #[error("Query execution error: {0}")]
    ExecutionError(String),
    #[error("Unsupported language: {0}")]
    UnsupportedLanguage(String),
    #[error("Query timed out after {0}ms")]
    Timeout(u64),
}

/// Result of a query execution that may have been truncated by limits
pub struct QueryResult {
    pub matches: Vec<QueryMatch>,
    pub timed_out: bool,
    pub exceeded_match_limit: bool,
}

/// Compile a tree-sitter query string for a given language
pub fn compile_query(
    lang: Language,
    query_str: &str,
) -> Result<Query, QueryError> {
    use crate::parser::languages::load_language;
    
    let ts_lang = load_language(lang)
        .map_err(|e| QueryError::UnsupportedLanguage(e.to_string()))?;
    
    Query::new(&ts_lang, query_str)
        .map_err(|e| QueryError::CompilationError(format!("{:?}", e)))
}

/// Execute a compiled query against a tree with timeout and match limits.
/// Returns partial results if the query is halted by timeout or match limit.
pub fn execute_query(
    query: &Query,
    tree: &Tree,
    source: &[u8],
) -> Result<QueryResult, QueryError> {
    use crate::parser::captures::extract_matches_with_options;
    
    let root_node = tree.root_node();
    let mut cursor = tree_sitter::QueryCursor::new();
    cursor.set_match_limit(QUERY_MATCH_LIMIT);
    
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_micros(QUERY_TIMEOUT_MICROS);
    let mut timed_out = false;
    // progress_callback returns true to continue, false to halt.
    let mut cb = |_state: &tree_sitter::QueryCursorState| -> bool {
        if start.elapsed() >= timeout {
            timed_out = true;
            false
        } else {
            true
        }
    };
    let options = tree_sitter::QueryCursorOptions {
        progress_callback: Some(&mut cb),
    };

    let matches = extract_matches_with_options(query, &mut cursor, root_node, source, options);
    
    Ok(QueryResult {
        matches,
        timed_out,
        exceeded_match_limit: cursor.did_exceed_match_limit(),
    })
}

/// Execute a query string directly (compile + execute)
pub fn execute_query_string(
    lang: Language,
    query_str: &str,
    tree: &Tree,
    source: &[u8],
) -> Result<QueryResult, QueryError> {
    let query = compile_query(lang, query_str)?;
    execute_query(&query, tree, source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file::Language;
    use crate::parser::registry::ParserRegistry;

    #[test]
    fn compile_query_rejects_invalid_syntax() {
        let err = compile_query(Language::Rust, "(((not valid ts query").unwrap_err();
        assert!(matches!(err, QueryError::CompilationError(_)));
    }

    #[test]
    fn execute_query_string_finds_function_in_rust() {
        let src = "fn hello() -> i32 { 1 }";
        let reg = ParserRegistry::new();
        let tree = reg.parse(Language::Rust, src).unwrap();
        let res = execute_query_string(Language::Rust, "(function_item) @f", &tree, src.as_bytes()).unwrap();
        assert!(!res.matches.is_empty());
        assert!(res.matches[0].get_capture("f").is_some());
    }
}
