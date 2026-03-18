use crate::file::{FileInfo, Language};
use crate::issue::ParsedIssue;
use crate::detector::registry::DetectorRegistry;
use crate::detector::treesitter::TreeSitterDetector;
use crate::parser::languages::create_parser;
use tree_sitter::{Parser, Tree};
use thiserror::Error;

/// Errors that can occur during detection
#[derive(Debug, Error)]
pub enum DetectionError {
    #[error("Failed to create parser: {0}")]
    ParserError(String),
    #[error("Failed to parse source: {0}")]
    ParseError(String),
    #[error("Detection error: {0}")]
    DetectorError(String),
}

/// Detection runner that orchestrates pattern detection
pub struct DetectionRunner {
    registry: DetectorRegistry,
    parser_cache: std::collections::HashMap<Language, Parser>,
}

impl DetectionRunner {
    /// Create a new detection runner with a registry
    pub fn new(registry: DetectorRegistry) -> Self {
        Self {
            registry,
            parser_cache: std::collections::HashMap::new(),
        }
    }

    /// Detect issues in a file using tree-sitter patterns
    pub fn detect_file(
        &mut self,
        file: &FileInfo,
        source: &str,
    ) -> Result<Vec<ParsedIssue>, DetectionError> {
        // Get parser for the file's language
        let parser = self.get_or_create_parser(file.language)?;
        
        // Parse the source code
        let tree = parser.parse(source, None)
            .ok_or_else(|| DetectionError::ParseError(
                format!("Failed to parse {}", file.path.display())
            ))?;

        // Get tree-sitter patterns for this language
        let patterns = self.registry.get_treesitter_patterns(file.language);

        // Run detection for each pattern
        let mut all_issues = Vec::new();
        for pattern in patterns {
            let detector = TreeSitterDetector::new(pattern.clone(), file.language);
            
            match detector.detect(source, &tree) {
                Ok(mut issues) => {
                    // Set file path for all issues
                    for issue in &mut issues {
                        issue.file_path = Some(file.path.to_string_lossy().to_string());
                    }
                    all_issues.extend(issues);
                }
                Err(e) => {
                    // Log error but continue with other patterns
                    tracing::debug!(
                        "Pattern {} detection failed: {}",
                        pattern.id,
                        e
                    );
                }
            }
        }

        Ok(all_issues)
    }

    /// Detect issues in source code with a pre-parsed tree
    pub fn detect_with_tree(
        &self,
        language: Language,
        source: &str,
        tree: &Tree,
    ) -> Result<Vec<ParsedIssue>, DetectionError> {
        // Get tree-sitter patterns for this language
        let patterns = self.registry.get_treesitter_patterns(language);

        // Run detection for each pattern
        let mut all_issues = Vec::new();
        for pattern in patterns {
            let detector = TreeSitterDetector::new(pattern.clone(), language);
            
            match detector.detect(source, tree) {
                Ok(issues) => {
                    all_issues.extend(issues);
                }
                Err(e) => {
                    // Log error but continue with other patterns
                    tracing::debug!(
                        "Pattern {} detection failed: {}",
                        pattern.id,
                        e
                    );
                }
            }
        }

        Ok(all_issues)
    }

    /// Get or create a parser for a language (with caching)
    fn get_or_create_parser(
        &mut self,
        language: Language,
    ) -> Result<&mut Parser, DetectionError> {
        use crate::parser::languages::is_supported;
        
        if !is_supported(language) {
            return Err(DetectionError::ParserError(
                format!("Unsupported language: {}", language.as_str())
            ));
        }

        if !self.parser_cache.contains_key(&language) {
            let parser = create_parser(language)
                .map_err(|e| DetectionError::ParserError(e.to_string()))?;
            self.parser_cache.insert(language, parser);
        }

        Ok(self.parser_cache.get_mut(&language).unwrap())
    }

    /// Get the registry (mutable)
    pub fn registry_mut(&mut self) -> &mut DetectorRegistry {
        &mut self.registry
    }

    /// Get the registry (immutable)
    pub fn registry(&self) -> &DetectorRegistry {
        &self.registry
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_detection_runner() {
        let registry = DetectorRegistry::new();
        let mut runner = DetectionRunner::new(registry);
        
        let file = FileInfo {
            id: 1,
            path: PathBuf::from("test.py"),
            hash: "test".to_string(),
            language: Language::Python,
            last_indexed: chrono::Utc::now(),
            line_count: Some(10),
        };

        let source = "x = 1";
        // This will return empty since registry is empty, but shouldn't error
        let result = runner.detect_file(&file, source);
        assert!(result.is_ok());
    }
}
