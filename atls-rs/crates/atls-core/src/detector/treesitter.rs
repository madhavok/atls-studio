use crate::file::Language;
use crate::issue::{IssueSeverity, ParsedIssue};
use crate::pattern::{Pattern, PatternSeverity};
use crate::parser::{compile_query, execute_query};
use tree_sitter::Tree;
use thiserror::Error;

/// Errors that can occur during tree-sitter detection
#[derive(Debug, Error)]
pub enum TreeSitterDetectorError {
    #[error("Pattern has no tree-sitter query")]
    NoQuery,
    #[error("Failed to compile query: {0}")]
    QueryCompilationError(String),
    #[error("Failed to execute query: {0}")]
    QueryExecutionError(String),
    #[error("Unsupported language: {0}")]
    UnsupportedLanguage(String),
}

/// Tree-sitter based pattern detector
pub struct TreeSitterDetector {
    pattern: Pattern,
    language: Language,
}

impl TreeSitterDetector {
    /// Create a new detector for a pattern
    pub fn new(pattern: Pattern, language: Language) -> Self {
        Self { pattern, language }
    }

    /// Detect issues in source code using tree-sitter queries.
    /// Uses per-query timeout and match limits to prevent hangs on
    /// pathological queries or very large files.
    pub fn detect(&self, source: &str, tree: &Tree) -> Result<Vec<ParsedIssue>, TreeSitterDetectorError> {
        let query_str = self.get_query_string()?;

        if Self::is_placeholder_query(&query_str) {
            return Ok(Vec::new());
        }

        let query = compile_query(self.language, &query_str)
            .map_err(|e| TreeSitterDetectorError::QueryCompilationError(e.to_string()))?;

        let result = execute_query(&query, tree, source.as_bytes())
            .map_err(|e| TreeSitterDetectorError::QueryExecutionError(e.to_string()))?;

        if result.timed_out {
            tracing::warn!(
                "TIMEOUT: pattern {:?} timed out on current file (query halted by tree-sitter)",
                self.pattern.id
            );
        }
        if result.exceeded_match_limit {
            tracing::warn!(
                "MATCH_LIMIT: pattern {:?} exceeded match limit on current file ({} matches collected)",
                self.pattern.id, result.matches.len()
            );
        }

        let mut issues = Vec::new();
        for m in result.matches {
            if let Some(offender) = m.get_offender() {
                if Self::is_in_import_context(tree, offender.start_row, offender.start_column) {
                    continue;
                }

                let severity = self.pattern_to_severity(&self.pattern.severity);
                
                let issue = ParsedIssue {
                    pattern_id: self.pattern.id.clone(),
                    severity,
                    message: self.pattern.title.clone(),
                    line: (offender.start_row + 1) as u32,
                    col: offender.start_column as u32,
                    end_line: Some((offender.end_row + 1) as u32),
                    end_col: Some(offender.end_column as u32),
                    file_path: None,
                };

                issues.push(issue);
            }
        }

        Ok(issues)
    }

    /// Get the query string for this pattern and language
    fn get_query_string(&self) -> Result<String, TreeSitterDetectorError> {
        let hints = self.pattern.structural_hints.as_ref()
            .ok_or(TreeSitterDetectorError::NoQuery)?;

        let query_value = hints.tree_sitter_query.as_ref()
            .ok_or(TreeSitterDetectorError::NoQuery)?;

        match query_value {
            serde_json::Value::String(s) => {
                // Single query string - check if it applies to this language
                let lang_str = self.language.as_str();
                let pattern_langs: Vec<&str> = self.pattern.languages.iter().map(|s| s.as_str()).collect();
                
                if pattern_langs.iter().any(|&l| {
                    l.eq_ignore_ascii_case(lang_str) ||
                    (lang_str == "typescript" && l.eq_ignore_ascii_case("ts")) ||
                    (lang_str == "javascript" && l.eq_ignore_ascii_case("js")) ||
                    (lang_str == "python" && l.eq_ignore_ascii_case("py")) ||
                    (lang_str == "rust" && l.eq_ignore_ascii_case("rs")) ||
                    (lang_str == "csharp" && l.eq_ignore_ascii_case("cs"))
                }) {
                    Ok(s.clone())
                } else {
                    Err(TreeSitterDetectorError::NoQuery)
                }
            }
            serde_json::Value::Object(map) => {
                // Map of language -> query
                let lang_str = self.language.as_str();
                
                // Try exact match first
                if let Some(serde_json::Value::String(query)) = map.get(lang_str) {
                    return Ok(query.clone());
                }
                
                // Try aliases
                let query = match lang_str {
                    "typescript" => map.get("ts"),
                    "javascript" => map.get("js"),
                    "python" => map.get("py"),
                    "rust" => map.get("rs"),
                    "csharp" => map.get("cs"),
                    _ => None,
                };

                if let Some(serde_json::Value::String(query_str)) = query {
                    Ok(query_str.clone())
                } else {
                    Err(TreeSitterDetectorError::NoQuery)
                }
            }
            _ => Err(TreeSitterDetectorError::NoQuery),
        }
    }

    /// Convert pattern severity to issue severity
    fn pattern_to_severity(&self, severity: &PatternSeverity) -> IssueSeverity {
        match severity {
            PatternSeverity::Critical | PatternSeverity::High => {
                IssueSeverity::High
            }
            PatternSeverity::Medium => IssueSeverity::Medium,
            PatternSeverity::Low | PatternSeverity::Info => {
                IssueSeverity::Low
            }
        }
    }

    /// Returns true if the query is a known placeholder that matches nearly
    /// every node (e.g. `(identifier) @offender`).  These stubs exist in the
    /// pattern JSON files where a real tree-sitter query has not yet been
    /// authored and must be skipped to avoid flooding the issue database.
    ///
    /// Catches any `(single_node_type) @offender` pattern — a bare node
    /// capture with no nested children, field constraints, or predicates.
    /// There are hundreds of these across the pattern JSON files.
    fn is_placeholder_query(query: &str) -> bool {
        let trimmed = query.trim();

        // Fast-path: match the general shape `(word_chars) @offender`
        // with no nested parens, predicates (#eq?, #match?), or field names (field:).
        if let Some(inner_start) = trimmed.strip_prefix('(') {
            if let Some(node_and_rest) = inner_start.strip_suffix("@offender") {
                let node_and_rest = node_and_rest.trim();
                if let Some(node_type) = node_and_rest.strip_suffix(')') {
                    let node_type = node_type.trim();
                    // Must be a single word (no spaces, no nested parens, no predicates)
                    if !node_type.is_empty()
                        && node_type.chars().all(|c| c.is_alphanumeric() || c == '_')
                    {
                        return true;
                    }
                }
            }
        }

        false
    }

    /// Walk the AST upward from a position and return true if the match
    /// sits inside an import/use declaration.  This prevents false positives
    /// where a broad query fires on nodes that are part of module imports.
    fn is_in_import_context(tree: &Tree, row: usize, col: usize) -> bool {
        use tree_sitter::Point;

        const IMPORT_NODE_KINDS: &[&str] = &[
            // Rust
            "use_declaration",
            "use_as_clause",
            "use_list",
            "scoped_use_list",
            "use_wildcard",
            "mod_item",
            // TypeScript / JavaScript
            "import_statement",
            "import_clause",
            "export_statement",
            // Python
            "import_statement",
            "import_from_statement",
            // Go
            "import_declaration",
            "import_spec",
            // Java / C#
            "import_declaration",
            "using_directive",
            // C / C++
            "preproc_include",
        ];

        let point = Point::new(row, col);
        let mut node = tree.root_node().descendant_for_point_range(point, point);

        while let Some(n) = node {
            if IMPORT_NODE_KINDS.contains(&n.kind()) {
                return true;
            }
            node = n.parent();
        }

        false
    }

    /// Get the pattern ID
    pub fn pattern_id(&self) -> &str {
        &self.pattern.id
    }

    /// Get the language this detector works with
    pub fn language(&self) -> Language {
        self.language
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PatternSeverity, StructuralHints};

    /// Create a test pattern with a real (non-placeholder) query
    fn create_test_pattern() -> Pattern {
        Pattern {
            id: "TEST_PATTERN".to_string(),
            languages: vec!["python".to_string()],
            category: "Style".to_string(),
            subcategory: None,
            severity: PatternSeverity::Medium,
            title: "Test Pattern".to_string(),
            description: "A test pattern".to_string(),
            tags: vec!["test".to_string()],
            sources: vec![],
            structural_hints: Some(StructuralHints {
                node_kinds: None,
                needs_data_flow: None,
                needs_call_graph: None,
                needs_inter_file_analysis: None,
                tree_sitter_query: Some(serde_json::Value::String(
                    "(assignment (identifier) @offender)".to_string(),
                )),
            }),
            fix: None,
            examples: None,
            version: None,
            updated_at: None,
            metadata: None,
        }
    }

    /// Create a pattern with a placeholder query for testing the skip logic
    fn create_placeholder_pattern() -> Pattern {
        Pattern {
            id: "PLACEHOLDER_PATTERN".to_string(),
            languages: vec!["python".to_string()],
            category: "Style".to_string(),
            subcategory: None,
            severity: PatternSeverity::High,
            title: "Placeholder".to_string(),
            description: "Should be skipped".to_string(),
            tags: vec![],
            sources: vec![],
            structural_hints: Some(StructuralHints {
                node_kinds: None,
                needs_data_flow: None,
                needs_call_graph: None,
                needs_inter_file_analysis: None,
                tree_sitter_query: Some(serde_json::Value::String(
                    "(identifier) @offender".to_string(),
                )),
            }),
            fix: None,
            examples: None,
            version: None,
            updated_at: None,
            metadata: None,
        }
    }

    #[test]
    fn test_get_query_string() {
        let pattern = create_test_pattern();
        let detector = TreeSitterDetector::new(pattern, Language::Python);
        
        let query = detector.get_query_string().unwrap();
        assert_eq!(query, "(assignment (identifier) @offender)");
    }

    #[test]
    fn test_detect_issues() {
        let pattern = create_test_pattern();
        let detector = TreeSitterDetector::new(pattern, Language::Python);
        
        let mut parser = crate::parser::create_parser(Language::Python).unwrap();
        let source = "x = 1\ny = 2";
        let tree = parser.parse(source, None).unwrap();
        
        let issues = detector.detect(source, &tree).unwrap();
        assert!(!issues.is_empty(), "Expected to find assignment identifiers");
    }

    #[test]
    fn test_placeholder_query_is_skipped() {
        let pattern = create_placeholder_pattern();
        let detector = TreeSitterDetector::new(pattern, Language::Python);
        
        let mut parser = crate::parser::create_parser(Language::Python).unwrap();
        let source = "x = 1\ny = 2\nz = x + y";
        let tree = parser.parse(source, None).unwrap();
        
        let issues = detector.detect(source, &tree).unwrap();
        assert!(issues.is_empty(), "Placeholder queries must produce zero issues");
    }

    #[test]
    fn test_is_placeholder_query() {
        // Single-node captures are placeholders
        assert!(TreeSitterDetector::is_placeholder_query("(identifier) @offender"));
        assert!(TreeSitterDetector::is_placeholder_query("  (identifier) @offender  "));
        assert!(TreeSitterDetector::is_placeholder_query("(string_literal) @offender"));
        assert!(TreeSitterDetector::is_placeholder_query("(call_expression) @offender"));
        assert!(TreeSitterDetector::is_placeholder_query("(function_declaration) @offender"));
        // Nested or constrained queries are NOT placeholders
        assert!(!TreeSitterDetector::is_placeholder_query(
            "(assignment (identifier) @offender)"
        ));
        assert!(!TreeSitterDetector::is_placeholder_query(
            "(type_annotation (predefined_type) @offender (#eq? @offender \"any\"))"
        ));
    }

    #[test]
    fn test_detect_typescript_any() {
        // Create a pattern that detects "any" type in TypeScript
        let pattern = Pattern {
            id: "TS_NO_EXPLICIT_ANY".to_string(),
            languages: vec!["typescript".to_string()],
            category: "CodeQuality".to_string(),
            severity: PatternSeverity::Medium,
            title: "No explicit any".to_string(),
            description: "Avoid using any type".to_string(),
            tags: vec![],
            sources: vec![],
            structural_hints: Some(StructuralHints {
                node_kinds: None,
                needs_data_flow: None,
                needs_call_graph: None,
                needs_inter_file_analysis: None,
                tree_sitter_query: Some(serde_json::json!(
                    "(type_annotation (predefined_type) @offender (#eq? @offender \"any\"))"
                )),
            }),
            fix: None,
            subcategory: None,
            examples: None,
            version: None,
            updated_at: None,
            metadata: None,
        };
        
        let detector = TreeSitterDetector::new(pattern, Language::TypeScript);
        
        // Parse TypeScript code with 'any' type
        let mut parser = crate::parser::create_parser(Language::TypeScript).unwrap();
        let source = "const x: any = 5;\nlet y: string = 'hello';";
        let tree = parser.parse(source, None).unwrap();
        
        // Detect issues
        let issues = detector.detect(source, &tree).unwrap();
        
        println!("Found {} issues", issues.len());
        for issue in &issues {
            println!("  - {} at line {}", issue.message, issue.line);
        }
        
        // Should find exactly one 'any' usage
        assert_eq!(issues.len(), 1, "Expected exactly one 'any' issue");
        assert_eq!(issues[0].line, 1, "Issue should be on line 1");
    }

    /// Ensures ported catalog queries compile for gap languages (Dart/Ruby/Scala).
    #[test]
    fn repo_gap_language_pattern_queries_compile() {
        use std::fs;
        use std::path::Path;
        use crate::types::Pattern;

        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../patterns");
        for (file, lang) in [
            ("dart.json", Language::Dart),
            ("ruby.json", Language::Ruby),
            ("scala.json", Language::Scala),
        ] {
            let path = base.join(file);
            let text =
                fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
            let patterns: Vec<Pattern> =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {}", file, e));
            for p in patterns {
                let Some(ref hints) = p.structural_hints else {
                    continue;
                };
                let Some(ref qv) = hints.tree_sitter_query else {
                    continue;
                };
                let q = match qv {
                    serde_json::Value::String(s) => s.as_str(),
                    _ => continue,
                };
                if TreeSitterDetector::is_placeholder_query(q) {
                    continue;
                }
                compile_query(lang, q)
                    .unwrap_or_else(|e| panic!("pattern {} in {} failed: {}", p.id, file, e));
            }
        }
    }
}
