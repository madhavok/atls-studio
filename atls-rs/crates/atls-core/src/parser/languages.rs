use crate::file::Language;
use tree_sitter::{Language as TreeSitterLanguage, Parser};
use thiserror::Error;

/// Errors that can occur when loading or using tree-sitter languages
#[derive(Debug, Error)]
pub enum LanguageError {
    #[error("Unsupported language: {0}")]
    UnsupportedLanguage(String),
    #[error("Failed to load language grammar: {0}")]
    GrammarLoadError(String),
    #[error("Failed to create parser: {0}")]
    ParserCreationError(String),
}

/// Load tree-sitter language grammar for a given Language enum
pub fn load_language(lang: Language) -> Result<TreeSitterLanguage, LanguageError> {
    // The newer tree-sitter language crates expose LanguageFn
    // We need to convert it to tree_sitter::Language
    match lang {
        Language::TypeScript => {
            // Use TSX grammar (superset of TypeScript) so .tsx JSX is parsed correctly
            Ok(tree_sitter_typescript::LANGUAGE_TSX.into())
        }
        Language::JavaScript => {
            Ok(tree_sitter_javascript::LANGUAGE.into())
        }
        Language::Python => {
            Ok(tree_sitter_python::LANGUAGE.into())
        }
        Language::Rust => {
            Ok(tree_sitter_rust::LANGUAGE.into())
        }
        Language::Java => {
            Ok(tree_sitter_java::LANGUAGE.into())
        }
        Language::Go => {
            Ok(tree_sitter_go::LANGUAGE.into())
        }
        Language::C => {
            // C files use C++ parser (superset) - alternatively add tree-sitter-c
            Ok(tree_sitter_cpp::LANGUAGE.into())
        }
        Language::Cpp => {
            Ok(tree_sitter_cpp::LANGUAGE.into())
        }
        Language::CSharp => {
            Ok(tree_sitter_c_sharp::LANGUAGE.into())
        }
        Language::Swift => {
            Ok(tree_sitter_swift::LANGUAGE.into())
        }
        Language::Php => {
            Ok(tree_sitter_php::LANGUAGE_PHP.into())
        }
        Language::Ruby => {
            Ok(tree_sitter_ruby::LANGUAGE.into())
        }
        // Dart: tree-sitter-dart-orchard supports tree-sitter 0.25
        Language::Dart => {
            Ok(tree_sitter_dart_orchard::LANGUAGE.into())
        }
        // Kotlin: tree-sitter-kotlin requires tree-sitter <0.23; use regex fallback.
        Language::Kotlin => {
            Err(LanguageError::UnsupportedLanguage(lang.as_str().to_string()))
        }
        Language::Scala => {
            Ok(tree_sitter_scala::LANGUAGE.into())
        }
        Language::Unknown => {
            Err(LanguageError::UnsupportedLanguage(lang.as_str().to_string()))
        }
    }
}

/// Check if a language is supported by tree-sitter
pub fn is_supported(lang: Language) -> bool {
    matches!(
        lang,
        Language::TypeScript
            | Language::JavaScript
            | Language::Python
            | Language::Rust
            | Language::Java
            | Language::Go
            | Language::C
            | Language::Cpp
            | Language::CSharp
            | Language::Swift
            |         Language::Php
            | Language::Ruby
            | Language::Scala
            | Language::Dart
    )
}

/// Create a new parser instance for a language
pub fn create_parser(lang: Language) -> Result<Parser, LanguageError> {
    let ts_lang = load_language(lang)?;
    let mut parser = Parser::new();
    parser
        .set_language(&ts_lang)
        .map_err(|e| LanguageError::ParserCreationError(format!("{:?}", e)))?;
    Ok(parser)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_supported_false_for_unknown() {
        assert!(!is_supported(Language::Unknown));
    }

    #[test]
    fn load_language_kotlin_is_unsupported() {
        assert!(matches!(
            load_language(Language::Kotlin),
            Err(LanguageError::UnsupportedLanguage(_))
        ));
    }

    #[test]
    fn create_parser_rust_smoke() {
        assert!(create_parser(Language::Rust).is_ok());
    }
}
