use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Programming language enum
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    TypeScript,
    JavaScript,
    Python,
    Rust,
    Java,
    Go,
    C,
    Cpp,
    CSharp,
    Swift,
    Php,
    Ruby,
    Kotlin,
    Scala,
    Dart,
    Unknown,
}

impl Language {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "typescript" | "ts" => Self::TypeScript,
            "javascript" | "js" => Self::JavaScript,
            "python" | "py" => Self::Python,
            "rust" | "rs" => Self::Rust,
            "java" => Self::Java,
            "go" | "golang" => Self::Go,
            "c" => Self::C,
            "cpp" | "c++" | "cxx" => Self::Cpp,
            "csharp" | "c#" | "cs" => Self::CSharp,
            "swift" => Self::Swift,
            "php" => Self::Php,
            "ruby" | "rb" => Self::Ruby,
            "kotlin" | "kt" => Self::Kotlin,
            "scala" => Self::Scala,
            "dart" => Self::Dart,
            _ => Self::Unknown,
        }
    }

    pub fn from_extension(ext: &str) -> Self {
        match ext.trim_start_matches('.').to_lowercase().as_str() {
            // TypeScript
            "ts" | "tsx" | "mts" | "cts" => Self::TypeScript,
            // JavaScript
            "js" | "jsx" | "mjs" | "cjs" => Self::JavaScript,
            // Python
            "py" | "pyi" | "pyw" | "pyx" => Self::Python,
            // Rust
            "rs" => Self::Rust,
            // Java
            "java" => Self::Java,
            // Go
            "go" => Self::Go,
            // C (headers are ambiguous - treat .h as C, .hpp/.hxx as C++)
            "c" | "h" => Self::C,
            // C++
            "cpp" | "cc" | "cxx" | "c++" | "hpp" | "hxx" | "hh" | "h++" => Self::Cpp,
            // C#
            "cs" | "csx" => Self::CSharp,
            // Swift
            "swift" => Self::Swift,
            // PHP
            "php" | "phtml" | "php3" | "php4" | "php5" => Self::Php,
            // Ruby
            "rb" | "rake" | "gemspec" => Self::Ruby,
            // Kotlin
            "kt" | "kts" => Self::Kotlin,
            // Scala
            "scala" | "sc" => Self::Scala,
            // Dart
            "dart" => Self::Dart,
            _ => Self::Unknown,
        }
    }

    pub fn extensions(&self) -> &'static [&'static str] {
        match self {
            Self::TypeScript => &["ts", "tsx", "mts", "cts"],
            Self::JavaScript => &["js", "jsx", "mjs", "cjs"],
            Self::Python => &["py", "pyi", "pyw", "pyx"],
            Self::Rust => &["rs"],
            Self::Java => &["java"],
            Self::Go => &["go"],
            Self::C => &["c", "h"],
            Self::Cpp => &["cpp", "cc", "cxx", "hpp", "hxx", "hh"],
            Self::CSharp => &["cs", "csx"],
            Self::Swift => &["swift"],
            Self::Php => &["php", "phtml"],
            Self::Ruby => &["rb", "rake", "gemspec"],
            Self::Kotlin => &["kt", "kts"],
            Self::Scala => &["scala", "sc"],
            Self::Dart => &["dart"],
            Self::Unknown => &[],
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Rust => "rust",
            Self::Java => "java",
            Self::Go => "go",
            Self::C => "c",
            Self::Cpp => "cpp",
            Self::CSharp => "csharp",
            Self::Swift => "swift",
            Self::Php => "php",
            Self::Ruby => "ruby",
            Self::Kotlin => "kotlin",
            Self::Scala => "scala",
            Self::Dart => "dart",
            Self::Unknown => "unknown",
        }
    }

    /// Returns all known languages (excluding Unknown)
    /// Used for patterns that apply to "all" languages
    pub fn all_known() -> &'static [Language] {
        &[
            Language::TypeScript,
            Language::JavaScript,
            Language::Python,
            Language::Rust,
            Language::Java,
            Language::Go,
            Language::C,
            Language::Cpp,
            Language::CSharp,
            Language::Swift,
            Language::Php,
            Language::Ruby,
            Language::Kotlin,
            Language::Scala,
            Language::Dart,
        ]
    }
}

/// File information stored in database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    /// Database ID
    pub id: i64,
    /// File path (relative to project root)
    pub path: PathBuf,
    /// Content hash (for change detection)
    pub hash: String,
    /// Programming language
    pub language: Language,
    /// Timestamp of last indexing
    pub last_indexed: chrono::DateTime<chrono::Utc>,
    /// Line count
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_count: Option<u32>,
}

/// File relation type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileRelationType {
    Imports,
    Exports,
}

impl FileRelationType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Imports => "IMPORTS",
            Self::Exports => "EXPORTS",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "IMPORTS" => Some(Self::Imports),
            "EXPORTS" => Some(Self::Exports),
            _ => None,
        }
    }
}

/// File relation stored in database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRelation {
    pub id: i64,
    pub from_file_id: i64,
    pub to_file_id: i64,
    pub relation_type: FileRelationType,
}

/// File node for dependency graphs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub path: PathBuf,
    pub language: Language,
    pub line_count: Option<u32>,
    pub imports: Vec<PathBuf>,
    pub exports: Vec<PathBuf>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn language_from_str_aliases() {
        assert_eq!(Language::from_str("TS"), Language::TypeScript);
        assert_eq!(Language::from_str("typescript"), Language::TypeScript);
        assert_eq!(Language::from_str("golang"), Language::Go);
        assert_eq!(Language::from_str("c++"), Language::Cpp);
        assert_eq!(Language::from_str("c#"), Language::CSharp);
        assert_eq!(Language::from_str("rb"), Language::Ruby);
        assert_eq!(Language::from_str("not-a-lang"), Language::Unknown);
    }

    #[test]
    fn language_from_extension_strips_dot_and_case() {
        assert_eq!(Language::from_extension(".TS"), Language::TypeScript);
        assert_eq!(Language::from_extension("MTS"), Language::TypeScript);
        assert_eq!(Language::from_extension("pyi"), Language::Python);
        assert_eq!(Language::from_extension("hpp"), Language::Cpp);
        assert_eq!(Language::from_extension("csx"), Language::CSharp);
        assert_eq!(Language::from_extension("xyz"), Language::Unknown);
    }

    #[test]
    fn language_as_str_extensions_roundtrip_for_known() {
        for lang in Language::all_known() {
            let s = lang.as_str();
            assert_eq!(Language::from_str(s), *lang);
            let exts = lang.extensions();
            assert!(!exts.is_empty(), "{s} should list extensions");
            for ext in exts {
                assert_eq!(Language::from_extension(ext), *lang);
            }
        }
    }

    #[test]
    fn all_known_excludes_unknown() {
        assert!(!Language::all_known().contains(&Language::Unknown));
        assert_eq!(Language::all_known().len(), 15);
    }

    #[test]
    fn file_relation_type_roundtrip() {
        assert_eq!(FileRelationType::from_str("IMPORTS"), Some(FileRelationType::Imports));
        assert_eq!(FileRelationType::from_str("EXPORTS"), Some(FileRelationType::Exports));
        assert_eq!(FileRelationType::from_str("other"), None);
        assert_eq!(FileRelationType::Imports.as_str(), "IMPORTS");
        assert_eq!(FileRelationType::Exports.as_str(), "EXPORTS");
    }

    #[test]
    fn file_info_serde_roundtrip() {
        let info = FileInfo {
            id: 42,
            path: PathBuf::from("src/lib.rs"),
            hash: "abc".into(),
            language: Language::Rust,
            last_indexed: chrono::Utc.with_ymd_and_hms(2024, 6, 1, 12, 0, 0).unwrap(),
            line_count: Some(100),
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: FileInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, info.id);
        assert_eq!(back.path, info.path);
        assert_eq!(back.hash, info.hash);
        assert_eq!(back.language, info.language);
        assert_eq!(back.line_count, info.line_count);
        assert_eq!(back.last_indexed, info.last_indexed);
    }
}
