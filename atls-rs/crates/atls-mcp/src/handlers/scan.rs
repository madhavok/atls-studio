use crate::project::ProjectManager;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn handle_scan_project(
    project_manager: &Arc<Mutex<ProjectManager>>,
    args: Value,
) -> Result<serde_json::Value, String> {
    let root_path: Option<String> = args
        .get("root_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let full_rescan = args
        .get("full_rescan")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let pm = project_manager.lock().await;
    let project = pm
        .get_or_create_project(root_path.as_deref())
        .await
        .map_err(|e| format!("Failed to get project: {}", e))?;

    info!("Starting scan (full_rescan={})", full_rescan);

    let project = project.lock().await;
    let mut indexer = project.indexer().await;

    let stats = indexer
        .scan(full_rescan)
        .await
        .map_err(|e| format!("Scan failed: {}", e))?;

    info!(
        "Scan complete: {} files indexed, {} errors",
        stats.files_indexed, stats.errors
    );

    Ok(serde_json::json!({
        "status": "complete",
        "files_indexed": stats.files_indexed,
        "files_scanned": stats.files_scanned,
        "errors": stats.errors,
        "error_details": stats.error_details.iter().map(|(path, msg)| {
            serde_json::json!({
                "path": path.to_string_lossy(),
                "message": msg
            })
        }).collect::<Vec<_>>()
    }))
}
