use serde::{Deserialize, Serialize};

/// Pattern severity levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatternSeverity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

/// Pattern category
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatternCategory {
    Correctness,
    Security,
    Performance,
    Maintainability,
    DesignSmell,
    Style,
}

/// External source reference for a pattern
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternSource {
    /// Tool or catalog name: "ruff", "clippy", "staticcheck", "semgrep", "pylint", etc.
    pub source: String,
    /// Tool-specific rule id: e.g. "PLR1722", "S1481", "SA4006"
    pub rule_id: String,
    /// URL to external docs, if available
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Structural hints for AST/graph engine
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralHints {
    /// Node kinds this pattern targets
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_kinds: Option<Vec<String>>,
    /// Whether data flow analysis is needed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_data_flow: Option<bool>,
    /// Whether call graph analysis is needed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_call_graph: Option<bool>,
    /// Whether inter-file analysis is needed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_inter_file_analysis: Option<bool>,
    /// Tree-sitter query (S-expression) to execute this pattern
    /// Can be a single query string or a map of language -> query
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree_sitter_query: Option<serde_json::Value>,
}

/// Structural fix definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixDefinition {
    #[serde(rename = "type")]
    pub fix_type: String, // Always "replace"
    pub replace: String,
    #[serde(rename = "with")]
    pub replace_with: String,
}

/// Pattern example
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternExample {
    pub bad: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub good: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Pattern metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternMetadata {
    /// Links to docs, blog posts, or standards (CERT, OWASP, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
}

/// ATLS Pattern definition (matches schema.ts)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pattern {
    /// Stable, human-readable ID (e.g., "PY_MUTABLE_DEFAULT_ARG")
    pub id: String,
    /// Languages this applies to: ["python"], ["typescript"], ["java", "kotlin"], etc.
    pub languages: Vec<String>,
    /// High-level category
    pub category: String,
    /// Optional subcategory (e.g., "Nullability", "Concurrency", "SQLInjection")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subcategory: Option<String>,
    /// Severity of violating this pattern
    pub severity: PatternSeverity,
    /// Short one-line description
    pub title: String,
    /// Multi-line description and rationale
    pub description: String,
    /// Tags for filtering/searching (e.g. ["null", "bug", "async"])
    pub tags: Vec<String>,
    /// External sources that contributed to this pattern
    pub sources: Vec<PatternSource>,
    /// Structural hints (for ATLS AST/graph engine)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structural_hints: Option<StructuralHints>,
    /// Structural fix definition
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<FixDefinition>,
    /// Example(s) pulled from real code (sanitized)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<PatternExample>>,
    /// Version of the pattern (e.g., "2024.11.30") for stability
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// ISO timestamp of when the pattern was last updated
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Optional metadata used in UI / reporting
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<PatternMetadata>,
}
