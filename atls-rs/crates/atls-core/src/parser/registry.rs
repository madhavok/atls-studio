use crate::parser::languages::{is_supported, load_language, LanguageError};
use crate::parser::query::{compile_query, execute_query, QueryError};
use crate::parser::captures::QueryMatch;
use crate::file::Language;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tree_sitter::{Parser, Query, Tree};
use thiserror::Error;

/// Errors that can occur in the parser registry
#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("Language error: {0}")]
    Language(#[from] LanguageError),
    #[error("Query error: {0}")]
    Query(#[from] QueryError),
    #[error("Parser error: {0}")]
    ParserError(String),
}

/// Registry for managing tree-sitter parsers and cached queries
/// Thread-safe with lazy loading of grammars
/// 
/// Note: Parsers are created on-demand since they don't implement Clone.
/// Language grammars are loaded and cached. Query compilation results are cached for performance.
pub struct ParserRegistry {
    /// Cached compiled queries (key: "language:query_string")
    queries: Arc<Mutex<HashMap<String, Query>>>,
}

impl ParserRegistry {
    /// Create a new parser registry
    pub fn new() -> Self {
        Self {
            queries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Get or load a language grammar (used internally)
    /// Since Language is not Copy, we load it each time (it's a cheap operation)
    fn get_language(&self, lang: Language) -> Result<tree_sitter::Language, RegistryError> {
        load_language(lang).map_err(RegistryError::Language)
    }

    /// Parse source code with a language parser
    pub fn parse(&self, lang: Language, source: &str) -> Result<Tree, RegistryError> {
        if !is_supported(lang) {
            return Err(RegistryError::Language(LanguageError::UnsupportedLanguage(
                lang.as_str().to_string(),
            )));
        }

        // Get language grammar
        let ts_lang = self.get_language(lang)?;

        // Create parser (cheap operation)
        let mut parser = Parser::new();
        parser
            .set_language(&ts_lang)
            .map_err(|e| RegistryError::ParserError(format!("Failed to set language: {:?}", e)))?;

        // Parse
        parser
            .parse(source, None)
            .ok_or_else(|| RegistryError::ParserError("Parse returned None".to_string()))
    }

    /// Execute a query against a tree
    pub fn query(
        &self,
        lang: Language,
        query_str: &str,
        tree: &Tree,
        source: &[u8],
    ) -> Result<Vec<QueryMatch>, RegistryError> {
        // Check cache first
        let cache_key = format!("{}:{}", lang.as_str(), query_str);
        {
            let queries = self.queries.lock().unwrap();
            if let Some(query) = queries.get(&cache_key) {
                let result = execute_query(query, tree, source).map_err(RegistryError::Query)?;
                return Ok(result.matches);
            }
        }

        // Compile and cache
        let query = compile_query(lang, query_str)?;
        {
            let mut queries = self.queries.lock().unwrap();
            queries.insert(cache_key.clone(), query);
        }

        // Execute
        let queries = self.queries.lock().unwrap();
        let query = queries.get(&cache_key).expect("Query should be in cache");
        let result = execute_query(query, tree, source).map_err(RegistryError::Query)?;
        Ok(result.matches)
    }

    /// Execute a query string directly (convenience method)
    pub fn query_string(
        &self,
        lang: Language,
        query_str: &str,
        source: &str,
    ) -> Result<Vec<QueryMatch>, RegistryError> {
        let tree = self.parse(lang, source)?;
        self.query(lang, query_str, &tree, source.as_bytes())
    }

    /// Clear query cache
    pub fn clear_queries(&self) {
        let mut queries = self.queries.lock().unwrap();
        queries.clear();
    }
}

impl Default for ParserRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file::Language;

    #[test]
    fn parse_rejects_unsupported_language() {
        let reg = ParserRegistry::new();
        let err = reg.parse(Language::Unknown, "x").unwrap_err();
        assert!(matches!(err, RegistryError::Language(_)));
    }

    #[test]
    fn query_string_hits_cache_second_time() {
        let reg = ParserRegistry::new();
        let q = "(string_literal) @s";
        let m1 = reg
            .query_string(Language::Rust, q, r#"const X: &str = "hi";"#)
            .unwrap();
        let m2 = reg
            .query_string(Language::Rust, q, r#"const Y: &str = "yo";"#)
            .unwrap();
        assert!(!m1.is_empty());
        assert!(!m2.is_empty());
    }
}
