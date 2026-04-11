use crate::project::ProjectManager;
use atls_core::types::IssueSeverity;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn handle_find_issues(
    project_manager: &Arc<Mutex<ProjectManager>>,
    args: Value,
) -> Result<serde_json::Value, String> {
    let root_path: Option<String> = args
        .get("root_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let category: Option<String> = args
        .get("category")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let file_paths: Option<Vec<String>> = args
        .get("file_paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        });

    let severity_filter: Option<String> = args
        .get("severity_filter")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let limit: Option<usize> = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);

    let pm = project_manager.lock().await;
    let project = pm
        .get_or_create_project(root_path.as_deref())
        .await
        .map_err(|e| format!("Failed to get project: {}", e))?;

    let project = project.lock().await;
    let query_engine = project.query_engine();

    // Build filter options
    let mut filter = atls_core::query::issues::IssueFilterOptions {
        category: category.clone(),
        file_pattern: file_paths.as_ref().map(|paths| {
            // Build LIKE pattern for multiple files
            if paths.len() == 1 {
                format!("%{}%", paths[0])
            } else {
                // For multiple files, we'll need to handle this differently
                // For now, use first file
                format!("%{}%", paths[0])
            }
        }),
        severity: None,
        ..Default::default()
    };

    // Parse severity filter
    if let Some(ref sev_str) = severity_filter {
        filter.severity = match sev_str.as_str() {
            "high" => Some(IssueSeverity::High),
            "medium" => Some(IssueSeverity::Medium),
            "low" => Some(IssueSeverity::Low),
            "all" => None,
            _ => None,
        };
    } else {
        // Default: high and medium only - we'll filter after query
        filter.severity = None;
    }

    let mut issues = query_engine
        .find_issues(&filter)
        .map_err(|e| format!("Failed to find issues: {}", e))?;

    // Apply severity filter if needed (when not "all")
    if severity_filter.as_deref() != Some("all") && severity_filter.is_some() {
        // Already filtered by severity in query
    } else if severity_filter.is_none() {
        // Default: high and medium only
        issues.retain(|i| matches!(i.severity, IssueSeverity::High | IssueSeverity::Medium));
    }

    // Apply limit
    if let Some(lim) = limit {
        issues.truncate(lim);
    } else {
        issues.truncate(20); // Default limit
    }

    info!("Found {} issues", issues.len());

    if issues.is_empty() {
        return Ok(serde_json::json!({
"_hint": if !query_engine.get_category_stats().unwrap_or_default().is_empty() {
                "No issues found for the current filters."
            } else {
                "No issues found."
            },
"likely_next_steps": if !query_engine.get_category_stats().unwrap_or_default().is_empty() {
                vec![
                    "Retry without filters to verify whether exclusions removed all findings.",
                    "Inspect category stats to see whether issues exist in nearby categories.",
                    "Use code search or shaped reads for behavioral mismatches outside the issue registry."
                ]
            } else {
                vec![
                    "Run manage({action:'scan'}) to index files if the workspace is new or stale.",
                    "Check whether the issue registry is disabled or empty for this project.",
                    "Use detect_patterns or code search if the target behavior is outside indexed issue coverage."
                ]
            },
            "issues": {},
            "total": 0,
            "_next": "Retry without filters or run manage({action:'scan'}) to refresh the index — see hint above"
        }));
    }
    // Batch resolve file IDs to paths (avoids N+1 queries)
    let file_ids: Vec<i64> = issues.iter().map(|i| i.file_id).collect();
    let file_path_map: std::collections::HashMap<i64, String> = if !file_ids.is_empty() {
        let conn = query_engine.db().conn();
        let unique_ids: std::collections::HashSet<i64> = file_ids.iter().cloned().collect();
        let placeholders = unique_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("SELECT id, path FROM files WHERE id IN ({})", placeholders);
        let mut stmt = conn.prepare(&sql).unwrap();
        let id_params: Vec<Box<dyn rusqlite::ToSql>> = unique_ids.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::ToSql>).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(id_params.iter().map(|b| b.as_ref())), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        }).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    } else {
        std::collections::HashMap::new()
    };

    // Group by file, then condense repeated patterns within each file
    let mut by_file: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut pattern_counts: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();

    for issue in &issues {
        let file_path = file_path_map.get(&issue.file_id).cloned().unwrap_or_else(|| "unknown".to_string());
        let key = (file_path.clone(), issue.pattern_id.clone());
        *pattern_counts.entry(key).or_insert(0) += 1;
    }

    // Track which (file, pattern) combos have already emitted a condensed entry
    let mut emitted: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    for issue in &issues {
        let file_path = file_path_map.get(&issue.file_id).cloned().unwrap_or_else(|| "unknown".to_string());
        let key = (file_path.clone(), issue.pattern_id.clone());
        let count = *pattern_counts.get(&key).unwrap_or(&1);

        if count > 2 {
            if !emitted.insert(key) { continue; }
            by_file.entry(file_path).or_default().push(serde_json::json!({
                "pattern_id": issue.pattern_id,
                "severity": format!("{:?}", issue.severity).to_lowercase(),
                "count": count,
                "sample_line": issue.line,
                "message": issue.message,
                "category": issue.category,
            }));
        } else {
            by_file.entry(file_path).or_default().push(serde_json::json!({
                "pattern_id": issue.pattern_id,
                "severity": format!("{:?}", issue.severity).to_lowercase(),
                "line": issue.line,
                "message": issue.message,
                "category": issue.category,
            }));
        }
    }

    let total: usize = by_file.values().map(|v| v.len()).sum();

    Ok(serde_json::json!({
        "issues": by_file,
        "total": total,
        "_next": "Use find_issues with file_paths narrowed to specific files to drill down"
    }))
}

#[cfg(test)]
mod tests {
    use super::handle_find_issues;
    use crate::project::ProjectManager;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn find_issues_empty_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let pm = Arc::new(Mutex::new(ProjectManager::new()));
        let args = serde_json::json!({ "root_path": root });
        let v = handle_find_issues(&pm, args).await.unwrap();
        assert_eq!(v["total"], 0);
    }
}
