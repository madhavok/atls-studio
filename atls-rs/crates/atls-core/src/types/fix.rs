use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Represents a code fix (used by refactoring operations)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeFix {
    /// Unique identifier for selective application
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_col: u32,
    pub end_col: u32,
    pub old_text: String,
    pub new_text: String,
    pub description: String,
    /// Whether the fix is guaranteed safe
    pub safe: bool,
    /// Confidence score 0-1 (1 = highest confidence)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// Pattern ID that triggered this fix
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern_id: Option<String>,
    /// Original issue line number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_line: Option<u32>,
    /// New files to create as part of this fix
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_to_create: Option<Vec<FileToCreate>>,
    /// True if this is a pure insertion (oldText should be empty)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_insertion: Option<bool>,
}

/// File to create as part of a fix
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileToCreate {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FixPayload {
    Single(CodeFix),
    Batch(Vec<CodeFix>),
    Metadata(Value),
}
