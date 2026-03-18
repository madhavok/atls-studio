use crate::types::Pattern;
use serde_json;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Errors that can occur when loading patterns
#[derive(Debug, Error)]
pub enum PatternLoadError {
    #[error("Failed to read catalog directory: {0}")]
    DirectoryError(String),
    #[error("Failed to read catalog file {0}: {1}")]
    FileReadError(String, String),
    #[error("Failed to parse JSON in {0}: {1}")]
    JsonParseError(String, String),
    #[error("Invalid pattern schema: {0}")]
    SchemaError(String),
}

/// Loads patterns from JSON catalog files
pub struct PatternLoader;

impl PatternLoader {
    /// Load patterns for specific languages from the catalog directory
    /// Implements lazy loading to avoid parsing huge JSONs for unused languages
    pub fn load_for_languages(
        catalog_dir: &Path,
        languages: &[&str],
    ) -> Result<Vec<Pattern>, PatternLoadError> {
        let mut results = Vec::new();

        // Check if catalog directory exists
        if !catalog_dir.exists() {
            return Ok(results); // Return empty if catalog doesn't exist
        }

        // Always load core/shared patterns if they exist
        Self::load_catalog_file(catalog_dir.join("core.json"), &mut results)?;
        Self::load_catalog_file(catalog_dir.join("all.json"), &mut results)?;

        // Load language-specific catalogs
        for lang in languages {
            let filename = format!("{}.json", lang.to_lowercase());
            Self::load_catalog_file(catalog_dir.join(filename), &mut results)?;
        }

        Ok(results)
    }

    /// Load patterns from a single catalog file
    fn load_catalog_file(
        file_path: PathBuf,
        results: &mut Vec<Pattern>,
    ) -> Result<(), PatternLoadError> {
        if !file_path.exists() {
            return Ok(()); // Skip missing files
        }

        let content = fs::read_to_string(&file_path).map_err(|e| {
            PatternLoadError::FileReadError(
                file_path.display().to_string(),
                e.to_string(),
            )
        })?;

        let patterns: Vec<Pattern> = serde_json::from_str(&content).map_err(|e| {
            PatternLoadError::JsonParseError(
                file_path.display().to_string(),
                e.to_string(),
            )
        })?;

        results.extend(patterns);
        Ok(())
    }

    /// Load all patterns from a catalog directory
    pub fn load_all(catalog_dir: &Path) -> Result<Vec<Pattern>, PatternLoadError> {
        if !catalog_dir.exists() {
            return Ok(Vec::new());
        }

        let mut results = Vec::new();
        let entries = fs::read_dir(catalog_dir).map_err(|e| {
            PatternLoadError::DirectoryError(e.to_string())
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| {
                PatternLoadError::DirectoryError(e.to_string())
            })?;
            
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                Self::load_catalog_file(path, &mut results)?;
            }
        }

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_load_patterns() {
        let temp_dir = std::env::temp_dir().join("atls_test_patterns");
        fs::create_dir_all(&temp_dir).unwrap();

        // Create a test pattern file
        let test_pattern = r#"[{
            "id": "TEST_PATTERN",
            "languages": ["python"],
            "category": "Style",
            "severity": "medium",
            "title": "Test Pattern",
            "description": "A test pattern",
            "tags": ["test"],
            "sources": []
        }]"#;
        
        fs::write(temp_dir.join("python.json"), test_pattern).unwrap();

        let patterns = PatternLoader::load_for_languages(&temp_dir, &["python"]).unwrap();
        assert_eq!(patterns.len(), 1);
        assert_eq!(patterns[0].id, "TEST_PATTERN");

        // Cleanup
        fs::remove_dir_all(&temp_dir).ok();
    }
}
