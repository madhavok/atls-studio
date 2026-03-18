use crate::file::Language;
use crate::pattern::{Pattern, PatternSeverity, StructuralHints};
use crate::detector::loader::PatternLoader;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use thiserror::Error;

/// Focus matrix: maps category name -> set of enabled severity strings (e.g. "high", "medium", "low")
pub type FocusMatrix = HashMap<String, HashSet<String>>;

/// Errors that can occur in the detector registry
#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("Failed to load patterns: {0}")]
    LoadError(String),
}

/// Registry for managing pattern detectors organized by language
pub struct DetectorRegistry {
    /// Patterns organized by language
    patterns_by_language: HashMap<Language, Vec<Pattern>>,
    /// All loaded patterns (for quick lookup by ID)
    patterns_by_id: HashMap<String, Pattern>,
    /// Whether patterns have been loaded
    loaded: bool,
}

impl DetectorRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            patterns_by_language: HashMap::new(),
            patterns_by_id: HashMap::new(),
            loaded: false,
        }
    }

    /// Load patterns from a catalog directory
    pub fn load_from_dir(&mut self, catalog_dir: &Path) -> Result<(), RegistryError> {
        let patterns = PatternLoader::load_all(catalog_dir).map_err(|e| {
            RegistryError::LoadError(e.to_string())
        })?;

        self.add_patterns(patterns);
        self.loaded = true;
        Ok(())
    }

    /// Load patterns for specific languages (lazy loading)
    pub fn load_for_languages(
        &mut self,
        catalog_dir: &Path,
        languages: &[Language],
    ) -> Result<(), RegistryError> {
        // Convert Language enum to string slice
        let lang_strings: Vec<&str> = languages.iter().map(|l| l.as_str()).collect();
        
        let patterns = PatternLoader::load_for_languages(catalog_dir, &lang_strings)
            .map_err(|e| RegistryError::LoadError(e.to_string()))?;

        self.add_patterns(patterns);
        self.loaded = true;
        Ok(())
    }

    /// Add patterns to the registry (deduplicates by pattern ID per language)
    fn add_patterns(&mut self, patterns: Vec<Pattern>) {
        for pattern in patterns {
            let pattern_id = pattern.id.clone();
            self.patterns_by_id.insert(pattern_id.clone(), pattern.clone());

            let is_all_language = pattern.languages.iter()
                .any(|l| l.eq_ignore_ascii_case("all"));

            let target_langs: Vec<Language> = if is_all_language {
                Language::all_known().to_vec()
            } else {
                pattern.languages.iter()
                    .map(|s| Language::from_str(s))
                    .filter(|l| *l != Language::Unknown)
                    .collect()
            };

            for lang in target_langs {
                let vec = self.patterns_by_language.entry(lang).or_insert_with(Vec::new);
                if !vec.iter().any(|p| p.id == pattern_id) {
                    vec.push(pattern.clone());
                }
            }
        }
    }

    /// Get all patterns for a specific language
    pub fn get_patterns_for_language(&self, lang: Language) -> Vec<&Pattern> {
        self.patterns_by_language
            .get(&lang)
            .map(|v| v.iter().collect())
            .unwrap_or_default()
    }

    /// Get a pattern by ID
    pub fn get_pattern(&self, pattern_id: &str) -> Option<&Pattern> {
        self.patterns_by_id.get(pattern_id)
    }

    /// Get patterns for a language filtered by a focus matrix (category -> enabled severities).
    /// Only returns patterns whose category is in the matrix AND whose severity is in that category's set.
    pub fn get_patterns_for_language_filtered(
        &self,
        lang: Language,
        matrix: &FocusMatrix,
    ) -> Vec<&Pattern> {
        self.get_patterns_for_language(lang)
            .into_iter()
            .filter(|p| {
                let cat_lower = p.category.to_lowercase();
                matrix.get(&cat_lower).map_or(false, |sevs| {
                    sevs.contains(&format!("{:?}", p.severity).to_lowercase())
                })
            })
            .collect()
    }

    /// Get all patterns that have tree-sitter queries for a language
    pub fn get_treesitter_patterns(&self, lang: Language) -> Vec<&Pattern> {
        self.get_patterns_for_language(lang)
            .into_iter()
            .filter(|p| {
                p.structural_hints
                    .as_ref()
                    .and_then(|h| h.tree_sitter_query.as_ref())
                    .is_some()
            })
            .collect()
    }

    /// Check if patterns have been loaded
    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// Get total number of patterns
    pub fn pattern_count(&self) -> usize {
        self.patterns_by_id.len()
    }

    /// Load built-in patterns (hardcoded common patterns)
    pub fn load_builtin_patterns(&mut self) {
        
        // Helper to create a pattern with default fields
        fn make_pattern(
            id: &str,
            languages: Vec<&str>,
            category: &str,
            subcategory: &str,
            severity: PatternSeverity,
            title: &str,
            description: &str,
            tags: Vec<&str>,
            query: &str,
        ) -> Pattern {
            Pattern {
                id: id.to_string(),
                languages: languages.into_iter().map(String::from).collect(),
                category: category.to_string(),
                subcategory: Some(subcategory.to_string()),
                severity,
                title: title.to_string(),
                description: description.to_string(),
                tags: tags.into_iter().map(String::from).collect(),
                sources: vec![],
                structural_hints: Some(StructuralHints {
                    node_kinds: None,
                    needs_data_flow: None,
                    needs_call_graph: None,
                    needs_inter_file_analysis: None,
                    tree_sitter_query: Some(serde_json::json!(query)),
                }),
                fix: None,
                examples: None,
                version: Some("1.0.0".to_string()),
                updated_at: None,
                metadata: None,
            }
        }
        
        let patterns = vec![
            // TypeScript/JavaScript: Explicit any
            make_pattern(
                "TS_EXPLICIT_ANY",
                vec!["typescript", "javascript"],
                "code_quality",
                "type_safety",
                PatternSeverity::Medium,
                "Explicit 'any' type",
                "Using 'any' disables type checking. Consider using a more specific type.",
                vec!["typescript", "types"],
                "(type_annotation (predefined_type) @offender (#eq? @offender \"any\"))",
            ),
            // TypeScript/JavaScript: console.log in production code
            make_pattern(
                "TS_CONSOLE_LOG",
                vec!["typescript", "javascript"],
                "code_quality",
                "cleanup",
                PatternSeverity::Low,
                "console.log left in code",
                "console.log statements should be removed before production. Use a structured logger instead.",
                vec!["typescript", "cleanup"],
                "(call_expression function: (member_expression object: (identifier) @obj property: (property_identifier) @prop) (#eq? @obj \"console\") (#match? @prop \"^(log|warn|error|info|debug|trace)$\")) @offender",
            ),
            // TypeScript: Non-null assertion operator
            make_pattern(
                "TS_NON_NULL_ASSERTION",
                vec!["typescript"],
                "code_quality",
                "type_safety",
                PatternSeverity::Medium,
                "Non-null assertion operator (!) used",
                "The non-null assertion operator bypasses null checks. Prefer optional chaining (?.) or explicit null guards.",
                vec!["typescript", "type_safety"],
                "(non_null_expression (_) @inner) @offender",
            ),
            // TypeScript/JavaScript: eval() usage
            make_pattern(
                "TS_EVAL_USAGE",
                vec!["typescript", "javascript"],
                "security",
                "injection",
                PatternSeverity::High,
                "eval() usage detected",
                "eval() executes arbitrary code and is a security risk. Use safer alternatives.",
                vec!["typescript", "security"],
                "(call_expression function: (identifier) @fn (#eq? @fn \"eval\")) @offender",
            ),
            // Python: Mutable default argument
            make_pattern(
                "PY_MUTABLE_DEFAULT",
                vec!["python"],
                "code_quality",
                "bugs",
                PatternSeverity::High,
                "Mutable default argument",
                "Using mutable default arguments can cause unexpected behavior.",
                vec!["python", "bugs"],
                "(default_parameter value: (list) @offender)",
            ),
            // Rust: Unwrap usage
            make_pattern(
                "RUST_UNWRAP",
                vec!["rust"],
                "error_handling",
                "panics",
                PatternSeverity::Medium,
                "Usage of unwrap()",
                "Consider using expect() or proper error handling instead of unwrap().",
                vec!["rust", "error_handling"],
                "(call_expression function: (field_expression field: (field_identifier) @offender (#eq? @offender \"unwrap\")))",
            ),
            // Java: Empty catch block
            make_pattern(
                "JAVA_EMPTY_CATCH",
                vec!["java"],
                "error_handling",
                "swallowed_exceptions",
                PatternSeverity::High,
                "Empty catch block",
                "Empty catch blocks swallow exceptions. At minimum, log the exception.",
                vec!["java", "exceptions"],
                "(catch_clause body: (block) @offender (#eq? @offender \"{}\"))",
            ),
            // Go: Error ignored
            make_pattern(
                "GO_ERROR_IGNORED",
                vec!["go"],
                "error_handling",
                "ignored_errors",
                PatternSeverity::High,
                "Error value ignored",
                "Error return value is being ignored with blank identifier.",
                vec!["go", "errors"],
                "(short_var_declaration left: (expression_list (blank_identifier) @offender))",
            ),
            // Java: Factory method pattern (static method returning interface/abstract type)
            make_pattern(
                "JAVA_FACTORY_METHOD",
                vec!["java"],
                "architecture",
                "creational_patterns",
                PatternSeverity::Low,
                "Factory method pattern",
                "Static method that creates and returns object instances — factory pattern detected.",
                vec!["java", "patterns", "factory"],
                "(method_declaration (modifiers (modifier) @mod (#eq? @mod \"static\")) type: (_) @ret_type body: (block (return_statement (object_creation_expression) @offender)))",
            ),
            // Java: Builder pattern (method chaining via return this)
            make_pattern(
                "JAVA_BUILDER_PATTERN",
                vec!["java"],
                "architecture",
                "creational_patterns",
                PatternSeverity::Low,
                "Builder pattern",
                "Method returns 'this' for fluent chaining — builder pattern detected.",
                vec!["java", "patterns", "builder"],
                "(method_declaration body: (block (return_statement (this) @offender)))",
            ),
            // Java: Singleton pattern (private constructor + static instance)
            make_pattern(
                "JAVA_SINGLETON",
                vec!["java"],
                "architecture",
                "creational_patterns",
                PatternSeverity::Low,
                "Singleton pattern",
                "Class with private constructor and static instance field — singleton pattern detected.",
                vec!["java", "patterns", "singleton"],
                "(constructor_declaration (modifiers (modifier) @mod (#eq? @mod \"private\")) parameters: (formal_parameters)) @offender",
            ),
            // Java: Interface implementation (adapter/strategy pattern indicator)
            make_pattern(
                "JAVA_IMPLEMENTS_INTERFACE",
                vec!["java"],
                "architecture",
                "structural_patterns",
                PatternSeverity::Low,
                "Interface implementation",
                "Class implements an interface — potential adapter or strategy pattern.",
                vec!["java", "patterns", "adapter", "strategy"],
                "(class_declaration interfaces: (super_interfaces (type_list (type_identifier) @offender)))",
            ),
            // Java: Abstract class (template method pattern indicator)
            make_pattern(
                "JAVA_ABSTRACT_CLASS",
                vec!["java"],
                "architecture",
                "structural_patterns",
                PatternSeverity::Low,
                "Abstract class",
                "Abstract class declaration — potential template method pattern.",
                vec!["java", "patterns", "template_method"],
                "(class_declaration (modifiers (modifier) @mod (#eq? @mod \"abstract\"))) @offender",
            ),
            // Java: Observer/Listener pattern (addEventListener/addListener methods)
            make_pattern(
                "JAVA_LISTENER_PATTERN",
                vec!["java"],
                "architecture",
                "behavioral_patterns",
                PatternSeverity::Low,
                "Observer/Listener pattern",
                "Method for registering listeners — observer pattern detected.",
                vec!["java", "patterns", "observer"],
                "(method_declaration name: (identifier) @offender (#match? @offender \"^(add|remove|register|unregister).*(Listener|Observer|Handler|Callback)$\"))",
            ),
        ];
        
        self.add_patterns(patterns);
        self.loaded = true;
        tracing::info!("Loaded {} built-in patterns", self.pattern_count());
    }

}

impl Default for DetectorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn test_registry_load() {
        let temp_dir = std::env::temp_dir().join("atls_test_registry");
        fs::create_dir_all(&temp_dir).unwrap();

        let test_pattern = r#"[{
            "id": "TEST_PATTERN",
            "languages": ["python"],
            "category": "Style",
            "severity": "medium",
            "title": "Test Pattern",
            "description": "A test pattern",
            "tags": ["test"],
            "sources": [],
            "structuralHints": {
                "treeSitterQuery": "(identifier) @offender"
            }
        }]"#;
        
        fs::write(temp_dir.join("python.json"), test_pattern).unwrap();

        let mut registry = DetectorRegistry::new();
        registry.load_from_dir(&temp_dir).unwrap();

        assert!(registry.is_loaded());
        assert_eq!(registry.pattern_count(), 1);
        
        let patterns = registry.get_patterns_for_language(Language::Python);
        assert_eq!(patterns.len(), 1);
        
        let ts_patterns = registry.get_treesitter_patterns(Language::Python);
        assert_eq!(ts_patterns.len(), 1);

        fs::remove_dir_all(&temp_dir).ok();
    }
}
