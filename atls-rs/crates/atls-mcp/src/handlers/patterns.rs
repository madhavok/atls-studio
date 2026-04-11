use crate::project::ProjectManager;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn handle_get_patterns(
    project_manager: &Arc<Mutex<ProjectManager>>,
    args: Value,
) -> Result<serde_json::Value, String> {
    let root_path: Option<String> = args
        .get("root_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let detail: String = args
        .get("detail")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "summary".to_string());

    let pm = project_manager.lock().await;
    let project = pm
        .get_or_create_project(root_path.as_deref())
        .await
        .map_err(|e| format!("Failed to get project: {}", e))?;

    let project = project.lock().await;
    let detector_registry = project.detector_registry();

    // Group patterns by category
    let mut by_category: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();

    // We need to iterate through all languages to get all patterns
    use atls_core::types::Language;
    let languages = [
        Language::TypeScript,
        Language::JavaScript,
        Language::Python,
        Language::Rust,
        Language::Java,
        Language::Go,
        Language::Cpp,
        Language::CSharp,
    ];

    let mut seen_patterns = std::collections::HashSet::new();

    for lang in &languages {
        let patterns = detector_registry.get_patterns_for_language(*lang);
        for pattern in patterns {
            if seen_patterns.contains(&pattern.id) {
                continue;
            }
            seen_patterns.insert(pattern.id.clone());

            let category = pattern.category.clone();
            let pattern_json = if detail == "full" {
                serde_json::json!({
                    "id": pattern.id,
                    "title": pattern.title,
                    "description": pattern.description,
                    "severity": pattern.severity,
                    "category": pattern.category,
                    "languages": pattern.languages,
                    "tags": pattern.tags
                })
            } else {
                serde_json::json!({
                    "id": pattern.id,
                    "title": pattern.title,
                    "severity": pattern.severity,
                    "category": pattern.category
                })
            };

            by_category
                .entry(category)
                .or_insert_with(Vec::new)
                .push(pattern_json);
        }
    }

    let mut category_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for (category, patterns) in &by_category {
        category_counts.insert(category.clone(), patterns.len());
    }

    info!("Found {} patterns across {} categories", seen_patterns.len(), by_category.len());

    if detail == "summary" {
        Ok(serde_json::json!({
            "total": seen_patterns.len(),
            "by_category": category_counts
        }))
    } else {
        Ok(serde_json::json!({
            "total": seen_patterns.len(),
            "by_category": by_category
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::handle_get_patterns;
    use crate::project::ProjectManager;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn patterns_summary_nonzero_with_builtin() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let pm = Arc::new(Mutex::new(ProjectManager::new()));
        let v = handle_get_patterns(
            &pm,
            serde_json::json!({ "root_path": root, "detail": "summary" }),
        )
        .await
        .unwrap();
        let total = v["total"].as_u64().expect("total");
        assert!(total > 0, "builtin patterns should load");
    }
}
