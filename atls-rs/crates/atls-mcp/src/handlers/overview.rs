use crate::project::ProjectManager;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn handle_get_codebase_overview(
    project_manager: &Arc<Mutex<ProjectManager>>,
    args: Value,
) -> Result<serde_json::Value, String> {
    let root_path: Option<String> = args
        .get("root_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let pm = {
        let pm = project_manager.lock().await;
        pm.clone()
    };
    let project = pm
        .get_or_create_project(root_path.as_deref())
        .await
        .map_err(|e| format!("Failed to get project: {}", e))?;

    let (query_engine, db) = {
        let project = project.lock().await;
        (project.query_engine_handle(), project.db_handle())
    };

    // Get file stats
    let file_count: i64 = db
        .with_conn(|conn| conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0)))
        .map_err(|e| format!("Failed to query file count: {}", e))?;

    let total_lines: i64 = db
        .with_conn(|conn| {
            conn.query_row("SELECT COALESCE(SUM(line_count), 0) FROM files", [], |row| {
                row.get(0)
            })
        })
        .map_err(|e| format!("Failed to query total line count: {}", e))?;

    // Get language distribution
    let langs: HashMap<String, i64> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT COALESCE(language, 'unknown'), COUNT(*) FROM files GROUP BY language",
            )?;
            let lang_rows =
                stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;

            let mut result = HashMap::new();
            for row in lang_rows {
                let (lang, count) = row?;
                result.insert(lang, count);
            }
            Ok(result)
        })
        .map_err(|e| format!("Failed to query language distribution: {}", e))?;

    // Get issue stats
    let issue_stats = query_engine
        .get_category_stats()
        .map_err(|e| format!("Failed to query issue category stats: {}", e))?;

    let mut issue_counts = HashMap::new();
    for stat in issue_stats {
        issue_counts.insert(stat.category, stat.count);
    }

    // Get subsystems (top-level directories)
    let subsystems = query_engine
        .get_subsystems(1)
        .map_err(|e| format!("Failed to query subsystems: {}", e))?;

    let subsystem_names: Vec<String> = subsystems
        .iter()
        .take(10)
        .map(|s| s.name.clone())
        .collect();

    info!("Generated codebase overview: {} files, {} lines", file_count, total_lines);

    Ok(serde_json::json!({
        "stats": {
            "files": file_count,
            "lines": total_lines,
            "languages": langs
        },
        "issues": {
            "by_category": issue_counts
        },
        "architecture": {
            "subsystems": subsystem_names
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::handle_get_codebase_overview;
    use crate::project::ProjectManager;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn overview_reports_zero_files_for_empty_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let pm = Arc::new(Mutex::new(ProjectManager::new()));
        let v = handle_get_codebase_overview(&pm, serde_json::json!({ "root_path": root }))
            .await
            .unwrap();
        assert_eq!(v["stats"]["files"], 0);
    }
}
