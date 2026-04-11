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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsed_issue_round_trip_json() {
        let p = ParsedIssue {
            pattern_id: "p1".to_string(),
            severity: IssueSeverity::High,
            message: "msg".to_string(),
            line: 3,
            col: 0,
            end_line: Some(4),
            end_col: Some(10),
            file_path: Some("a.kt".to_string()),
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: ParsedIssue = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pattern_id, "p1");
        assert_eq!(back.severity, IssueSeverity::High);
        assert_eq!(back.file_path.as_deref(), Some("a.kt"));
    }

    #[test]
    fn from_parsed_issue_copies_fields_and_zeroes_ids() {
        let parsed = ParsedIssue {
            pattern_id: "x".to_string(),
            severity: IssueSeverity::Low,
            message: "m".to_string(),
            line: 1,
            col: 2,
            end_line: None,
            end_col: None,
            file_path: None,
        };
        let issue = Issue::from(parsed);
        assert_eq!(issue.id, 0);
        assert_eq!(issue.file_id, 0);
        assert_eq!(issue.pattern_id, "x");
        assert_eq!(issue.severity, IssueSeverity::Low);
        assert_eq!(issue.line, 1);
        assert_eq!(issue.col, 2);
        assert_eq!(issue.category, "");
        assert!(!issue.suppressed);
    }
}
