use crate::project::ProjectManager;
use atls_core::types::IssueSeverity;
use rusqlite::params;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn handle_export(
    project_manager: &Arc<Mutex<ProjectManager>>,
    args: Value,
) -> Result<serde_json::Value, String> {
    let format: String = args
        .get("format")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing required parameter: format".to_string())?;

    let root_path: Option<String> = args
        .get("root_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let output_file: Option<String> = args
        .get("output_file")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let category: Option<String> = args
        .get("category")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let severity: Option<String> = args
        .get("severity")
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

    // Build filter
    let filter = atls_core::query::issues::IssueFilterOptions {
        category: category.clone(),
        severity: severity.as_ref().and_then(|s| match s.as_str() {
            "high" => Some(IssueSeverity::High),
            "medium" => Some(IssueSeverity::Medium),
            "low" => Some(IssueSeverity::Low),
            _ => None,
        }),
        ..Default::default()
    };

    let mut issues = query_engine
        .find_issues(&filter)
        .map_err(|e| format!("Failed to find issues: {}", e))?;

    // Apply limit
    if let Some(lim) = limit {
        issues.truncate(lim);
    } else if output_file.is_none() {
        issues.truncate(50); // Default limit when no output file
    }

    match format.as_str() {
        "json" => {
            let result = serde_json::json!({
                "summary": {
                    "total": issues.len(),
                    "by_category": {
                        // Calculate category counts
                    }
                },
                "issues": issues.iter().map(|issue| {
                    // Get file path
                    let file_path = query_engine.db().conn()
                        .query_row(
                            "SELECT path FROM files WHERE id = ?1",
                            params![issue.file_id],
                            |row| row.get::<_, String>(0)
                        )
                        .unwrap_or_else(|_| "unknown".to_string());

                    serde_json::json!({
                        "pattern_id": issue.pattern_id,
                        "severity": format!("{:?}", issue.severity).to_lowercase(),
                        "category": issue.category,
                        "message": issue.message,
                        "file": file_path,
                        "line": issue.line,
                        "column": issue.col
                    })
                }).collect::<Vec<_>>()
            });

            if let Some(output_path) = output_file {
                std::fs::write(&output_path, serde_json::to_string_pretty(&result).unwrap())
                    .map_err(|e| format!("Failed to write output file: {}", e))?;
                info!("Exported {} issues to {}", issues.len(), output_path);
                Ok(serde_json::json!({ "status": "exported", "file": output_path, "count": issues.len() }))
            } else {
                Ok(result)
            }
        }
        "sarif" => {
            // SARIF format (simplified)
            let sarif = serde_json::json!({
                "version": "2.1.0",
                "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
                "runs": [{
                    "tool": {
                        "driver": {
                            "name": "atls",
                            "version": "1.2.0"
                        }
                    },
                    "results": issues.iter().map(|issue| {
                        let file_path = query_engine.db().conn()
                            .query_row(
                                "SELECT path FROM files WHERE id = ?1",
                                params![issue.file_id],
                                |row| row.get::<_, String>(0)
                            )
                            .unwrap_or_else(|_| "unknown".to_string());

                        serde_json::json!({
                            "ruleId": issue.pattern_id,
                            "level": match issue.severity {
                                IssueSeverity::High => "error",
                                IssueSeverity::Medium => "warning",
                                IssueSeverity::Low => "note"
                            },
                            "message": {
                                "text": issue.message
                            },
                            "locations": [{
                                "physicalLocation": {
                                    "artifactLocation": {
                                        "uri": file_path
                                    },
                                    "region": {
                                        "startLine": issue.line,
                                        "startColumn": issue.col
                                    }
                                }
                            }]
                        })
                    }).collect::<Vec<_>>()
                }]
            });

            if let Some(output_path) = output_file {
                std::fs::write(&output_path, serde_json::to_string_pretty(&sarif).unwrap())
                    .map_err(|e| format!("Failed to write SARIF file: {}", e))?;
                info!("Exported {} issues to SARIF: {}", issues.len(), output_path);
                Ok(serde_json::json!({ "status": "exported", "file": output_path, "count": issues.len() }))
            } else {
                Ok(sarif)
            }
        }
        _ => Err(format!("Unsupported export format: {}", format)),
    }
}
