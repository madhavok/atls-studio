use serde::{Deserialize, Serialize};

/// Issue severity levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    High,
    Medium,
    Low,
}

/// Parsed issue from pattern detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedIssue {
    /// Pattern ID that triggered this issue
    pub pattern_id: String,
    /// Severity level
    pub severity: IssueSeverity,
    /// Human-readable message
    pub message: String,
    /// Line number (1-indexed)
    pub line: u32,
    /// Column number (0-indexed)
    pub col: u32,
    /// End line number (1-indexed)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// End column number (0-indexed)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_col: Option<u32>,
    /// File path where the issue was detected (optional, may be set during deduplication)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

/// Issue stored in database (with database ID and file reference)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    /// Database ID
    pub id: i64,
    /// File ID (foreign key to files table)
    pub file_id: i64,
    /// Pattern ID (type)
    pub pattern_id: String,
    /// Severity level
    pub severity: IssueSeverity,
    /// Human-readable message
    pub message: String,
    /// Line number (1-indexed)
    pub line: u32,
    /// Column number (0-indexed)
    pub col: u32,
    /// End line number (1-indexed)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// End column number (0-indexed)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_col: Option<u32>,
    /// Category (e.g., "performance", "security")
    pub category: String,
    /// Additional JSON data (remediation, context, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Timestamp when issue was first seen
    pub first_seen: chrono::DateTime<chrono::Utc>,
    /// Whether this issue is suppressed
    pub suppressed: bool,
    /// Reason for suppression
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppression_reason: Option<String>,
    /// When suppression expires
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppression_expires: Option<chrono::DateTime<chrono::Utc>>,
}

impl From<ParsedIssue> for Issue {
    fn from(parsed: ParsedIssue) -> Self {
        Self {
            id: 0, // Will be set by database
            file_id: 0, // Will be set when inserting
            pattern_id: parsed.pattern_id,
            severity: parsed.severity,
            message: parsed.message,
            line: parsed.line,
            col: parsed.col,
            end_line: parsed.end_line,
            end_col: parsed.end_col,
            category: String::new(), // Will be set from pattern
            data: None,
            first_seen: chrono::Utc::now(),
            suppressed: false,
            suppression_reason: None,
            suppression_expires: None,
        }
    }
}
