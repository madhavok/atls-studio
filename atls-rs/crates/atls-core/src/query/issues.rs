use crate::query::{QueryEngine, QueryError};
use crate::issue::{Issue, IssueSeverity};
use std::collections::HashMap;

/// Issue filter options
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct IssueFilterOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_pattern: Option<String>,
    /// Multiple file path suffix patterns (OR-ed together in SQL)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_patterns: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<IssueSeverity>,
    /// Multiple severities (OR-ed, applied as SQL IN clause)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Multiple categories (OR-ed, applied as SQL IN clause)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

/// Issue group (grouped by pattern ID)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IssueGroup {
    pub pattern_id: String,
    pub count: usize,
    pub severity: IssueSeverity,
    pub category: String,
    pub issues: Vec<Issue>,
}

/// Category statistics
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct CategoryStat {
    pub category: String,
    pub count: usize,
}

/// A finding to mark as noise (false positive)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NoiseMarking {
    pub pattern_id: String,
    pub file_path: String,
    pub line: u32,
    pub reason: Option<String>,
}

/// Result of marking findings as noise
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NoiseMarkingResult {
    pub marked: usize,
    pub not_found: usize,
    pub errors: Vec<String>,
}

impl QueryEngine {
    /// Find issues with optional filters and pagination
    pub fn find_issues(
        &self,
        options: &IssueFilterOptions,
    ) -> Result<Vec<Issue>, QueryError> {
        let conn = self.db.conn();
        
        let mut sql = String::from(
            "SELECT i.id, i.file_id, i.type, i.severity, i.message, i.line, i.col,
                    i.category, i.data, i.first_seen, i.suppressed, 
                    i.suppression_reason, i.suppression_expires,
                    i.end_line, i.end_col
             FROM code_issues i
             WHERE i.suppressed = 0
               AND i.id IN (
                   SELECT MIN(id) FROM code_issues
                   WHERE suppressed = 0
                   GROUP BY file_id, line, type
               )"
        );

        // Pre-compute string values that need to outlive params
        let severity_str: Option<String> = options.severity.as_ref().map(|s| format!("{:?}", s).to_lowercase());
        
        let mut params: Vec<String> = Vec::new();

        if let Some(ref file_pattern) = options.file_pattern {
            sql.push_str(" AND EXISTS (SELECT 1 FROM files f WHERE f.id = i.file_id AND f.path LIKE ?)");
            params.push(file_pattern.clone());
        }

        if let Some(ref file_patterns) = options.file_patterns {
            if !file_patterns.is_empty() {
                let placeholders: Vec<&str> = file_patterns.iter().map(|_| "f.path LIKE ?").collect();
                sql.push_str(&format!(
                    " AND EXISTS (SELECT 1 FROM files f WHERE f.id = i.file_id AND ({}))",
                    placeholders.join(" OR ")
                ));
                for pat in file_patterns {
                    params.push(pat.clone());
                }
            }
        }

        if let Some(ref exclude_pattern) = options.exclude_pattern {
            sql.push_str(" AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id = i.file_id AND f.path LIKE ?)");
            params.push(exclude_pattern.clone());
        }

        if let Some(ref sev_str) = severity_str {
            sql.push_str(" AND i.severity = ?");
            params.push(sev_str.clone());
        }

        if let Some(ref sevs) = options.severities {
            if !sevs.is_empty() {
                let placeholders: Vec<String> = sevs.iter().map(|_| "?".to_string()).collect();
                sql.push_str(&format!(" AND i.severity IN ({})", placeholders.join(",")));
                params.extend(sevs.iter().cloned());
            }
        }

        if let Some(ref category) = options.category {
            sql.push_str(" AND i.category = ?");
            params.push(category.clone());
        }

        if let Some(ref cats) = options.categories {
            if !cats.is_empty() {
                let placeholders: Vec<String> = cats.iter().map(|_| "?".to_string()).collect();
                sql.push_str(&format!(" AND i.category IN ({})", placeholders.join(",")));
                params.extend(cats.iter().cloned());
            }
        }

        sql.push_str(" ORDER BY CASE i.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, i.line");

        // Add pagination
        if let Some(limit) = options.limit {
            sql.push_str(&format!(" LIMIT {}", limit));
        }
        if let Some(offset) = options.offset {
            sql.push_str(&format!(" OFFSET {}", offset));
        }

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(self.row_to_issue(row)?)
        })?;

        let mut issues = Vec::new();
        for row in rows {
            issues.push(row?);
        }

        Ok(issues)
    }

    /// Get issues grouped by pattern ID
    pub fn get_issues_by_category(
        &self,
        category: &str,
        file_filter: Option<&str>,
        severity_filter: Option<IssueSeverity>,
        filter_options: &IssueFilterOptions,
    ) -> Result<Vec<IssueGroup>, QueryError> {
        let mut options = filter_options.clone();
        options.category = Some(category.to_string());
        if let Some(severity) = severity_filter {
            options.severity = Some(severity);
        }
        if let Some(file) = file_filter {
            options.file_pattern = Some(format!("%{}%", file));
        }

        let issues = self.find_issues(&options)?;

        // Group by pattern_id
        let mut groups: HashMap<String, Vec<Issue>> = HashMap::new();
        for issue in issues {
            groups
                .entry(issue.pattern_id.clone())
                .or_insert_with(Vec::new)
                .push(issue);
        }

        let mut result = Vec::new();
        for (pattern_id, group_issues) in groups {
            if group_issues.is_empty() {
                continue;
            }

            // Get severity and category from first issue (they should be consistent)
            let severity = group_issues[0].severity;
            let category = group_issues[0].category.clone();

            result.push(IssueGroup {
                pattern_id,
                count: group_issues.len(),
                severity,
                category,
                issues: group_issues,
            });
        }

        // Sort by count descending
        result.sort_by(|a, b| b.count.cmp(&a.count));

        Ok(result)
    }

    /// Get category statistics
    pub fn get_category_stats(&self) -> Result<Vec<CategoryStat>, QueryError> {
        let conn = self.db.conn();
        
        let mut stmt = conn.prepare(
            "SELECT category, COUNT(*) as count
             FROM code_issues
             WHERE suppressed = 0
             GROUP BY category
             ORDER BY count DESC"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(CategoryStat {
                category: row.get(0)?,
                count: row.get(1)?,
            })
        })?;

        let mut stats = Vec::new();
        for row in rows {
            stats.push(row?);
        }

        Ok(stats)
    }

    /// Get performance issues
    pub fn get_performance_issues(
        &self,
        file_filter: Option<&str>,
        filter_options: &IssueFilterOptions,
    ) -> Result<Vec<Issue>, QueryError> {
        let mut options = filter_options.clone();
        options.category = Some("performance".to_string());
        if let Some(file) = file_filter {
            options.file_pattern = Some(format!("%{}%", file));
        }
        self.find_issues(&options)
    }

    /// Mark findings as noise (suppress false positives)
    pub fn mark_findings_as_noise(
        &self,
        findings: &[NoiseMarking],
    ) -> Result<NoiseMarkingResult, QueryError> {
        let mut conn = self.db.conn();
        let tx = conn.transaction()?;

        let mut marked = 0;
        let mut not_found = 0;
        let mut errors: Vec<String> = Vec::new();
        
        for finding in findings {
            let normalized_path = finding.file_path.replace('\\', "/");
            let pattern = format!("%{}", normalized_path);
            
            // Find the issue by pattern_id, file path, and line
            let result = tx.execute(
                "UPDATE code_issues 
                 SET suppressed = 1, suppression_reason = ?
                 WHERE type = ? 
                   AND line = ?
                   AND file_id IN (
                       SELECT id FROM files WHERE path = ? OR path LIKE ?
                   )",
                rusqlite::params![
                    &finding.reason.as_deref().unwrap_or("Marked as false positive"),
                    &finding.pattern_id,
                    finding.line,
                    &normalized_path,
                    &pattern
                ]
            );
            
            match result {
                Ok(rows_affected) => {
                    if rows_affected > 0 {
                        marked += rows_affected;
                    } else {
                        not_found += 1;
                    }
                }
                Err(e) => {
                    errors.push(format!("{}:{}: {}", finding.file_path, finding.line, e));
                }
            }
        }
        
        if errors.is_empty() {
            tx.commit()?;
        } else {
            tx.rollback()?;
        }

        Ok(NoiseMarkingResult {
            marked: marked as usize,
            not_found,
            errors,
        })
    }

    /// Helper: Convert database row to Issue
    fn row_to_issue(&self, row: &rusqlite::Row) -> Result<Issue, rusqlite::Error> {
        let data_str: Option<String> = row.get(8)?;
        let data = data_str.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

        let first_seen_str: String = row.get(9)?;
        let first_seen = chrono::NaiveDateTime::parse_from_str(&first_seen_str, "%Y-%m-%d %H:%M:%S")
            .map(|dt| chrono::DateTime::from_naive_utc_and_offset(dt, chrono::Utc))
            .or_else(|_| chrono::DateTime::parse_from_rfc3339(&first_seen_str)
                .map(|dt| dt.with_timezone(&chrono::Utc)))
            .unwrap_or_else(|_| chrono::Utc::now());

        let suppression_expires_str: Option<String> = row.get(12)?;
        let suppression_expires = suppression_expires_str.and_then(|s| {
            chrono::NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S")
                .map(|dt| chrono::DateTime::from_naive_utc_and_offset(dt, chrono::Utc))
                .or_else(|_| chrono::DateTime::parse_from_rfc3339(&s)
                    .map(|dt| dt.with_timezone(&chrono::Utc)))
                .ok()
        });

        Ok(Issue {
            id: row.get(0)?,
            file_id: row.get(1)?,
            pattern_id: row.get(2)?,
            severity: IssueSeverity::from_str(&row.get::<_, String>(3)?),
            message: row.get(4)?,
            line: row.get(5)?,
            col: row.get(6)?,
            end_line: row.get(13)?,
            end_col: row.get(14)?,
            category: row.get(7)?,
            data,
            first_seen,
            suppressed: row.get::<_, i32>(10)? != 0,
            suppression_reason: row.get(11)?,
            suppression_expires,
        })
    }
}

impl IssueSeverity {
    fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "high" => Self::High,
            "medium" => Self::Medium,
            "low" => Self::Low,
            _ => Self::Medium,
        }
    }
}
