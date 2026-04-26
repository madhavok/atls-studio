use crate::parser::captures::QueryMatch;
use crate::file::Language;
use tree_sitter::{Query, Tree};
use thiserror::Error;

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
}

/// Result of a query execution that may have been truncated by limits.
pub struct QueryResult {
    pub matches: Vec<QueryMatch>,
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

/// Execute a compiled query against a tree with match limits.
/// Returns partial results if the query is halted by the match limit.
pub fn execute_query(
    query: &Query,
    tree: &Tree,
    source: &[u8],
) -> Result<QueryResult, QueryError> {
    use crate::parser::captures::extract_matches_from_cursor;
    
    let root_node = tree.root_node();
    let mut cursor = tree_sitter::QueryCursor::new();
    cursor.set_match_limit(QUERY_MATCH_LIMIT);

    let matches = extract_matches_from_cursor(query, &mut cursor, root_node, source);
    
    Ok(QueryResult {
        matches,
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
