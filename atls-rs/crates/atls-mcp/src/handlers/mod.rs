mod batch;
mod issues;
mod scan;
mod overview;
mod patterns;
mod export;

use crate::project::ProjectManager;

/// Valid MCP tool names for "Did you mean?" suggestions.
const VALID_TOOLS: &[&str] = &[
    "batch_query", "batch", "find_issues", "scan_project",
    "get_codebase_overview", "get_patterns", "export",
];

/// Levenshtein distance for typo correction.
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut costs: Vec<usize> = (0..=a.len()).collect();
    for (j, bj) in b.iter().enumerate() {
        let mut prev = j;
        for (i, ai) in a.iter().enumerate() {
            let cur = if ai == bj {
                costs[i]
            } else {
                costs[i].min(prev).min(costs[i + 1]) + 1
            };
            costs[i] = prev;
            prev = cur;
        }
        costs[a.len()] = prev;
    }
    costs[a.len()]
}

/// Return nearest valid tool name for typo hints.
fn find_nearest_valid_tool(name: &str) -> Option<&'static str> {
    let lower: String = name.to_lowercase();
    let mut best: Option<&str> = None;
    let mut best_dist = usize::MAX;
    for &t in VALID_TOOLS {
        let d = levenshtein(&lower, &t.to_lowercase());
        if d < best_dist {
            best_dist = d;
            best = Some(t);
        }
    }
    if best_dist <= 4 {
        best
    } else {
        None
    }
}
use crate::protocol::*;
use std::sync::Arc;
use tokio::sync::Mutex;



pub struct Handlers {
    project_manager: Arc<Mutex<ProjectManager>>,
}

impl Handlers {
    pub fn new() -> Self {
        Self {
            project_manager: Arc::new(Mutex::new(ProjectManager::new())),
        }
    }

    /// List all available tools
    pub fn list_tools(&self) -> Vec<Tool> {
        vec![
            Tool {
                name: "batch_query".to_string(),
                description: "⚡ PRIMARY METHOD for ALL code operations. 10-100x faster than individual calls. Supports: dependencies, find_similar, context, edit, refactor (inventory, impact_analysis, execute, plan, rollback), symbol_usage, call_hierarchy, code_search, ast_query, detect_patterns, help, suggest_operations. Note: file_paths must be literal paths — h:refs (UHPP) not supported in MCP context.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "operation": {
                            "type": "string",
                            "enum": [
                                "dependencies", "find_similar", "context", "edit", "refactor",
                                "symbol_usage", "call_hierarchy", "code_search", "ast_query",
                                "detect_patterns", "help", "suggest_operations"
                            ]
                        },
                        "root_path": { "type": "string" },
                        "file_paths": { "type": "array", "items": { "type": "string" }, "description": "Literal file paths only — h:refs not supported in MCP" },
                        "symbol_names": { "type": "array", "items": { "type": "string" } },
                        "queries": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["operation"]
                }),
            },
            Tool {
                name: "find_issues".to_string(),
                description: "Find issues (detection only, no auto-fix). No args = ALL issues (token-optimized: top 20, high+medium severity, grouped by file).".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "root_path": { "type": "string" },
                        "category": { "type": "string" },
                        "file_paths": { "type": "array", "items": { "type": "string" }, "description": "Literal file paths only — h:refs not supported in MCP" },
                        "severity_filter": { "type": "string", "enum": ["high", "medium", "low", "all"] },
                        "limit": { "type": "number" }
                    }
                }),
            },
            Tool {
                name: "scan_project".to_string(),
                description: "Force rescan of codebase. Usually unnecessary - auto-scan handles this.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "root_path": { "type": "string" },
                        "full_rescan": { "type": "boolean" }
                    }
                }),
            },
            Tool {
                name: "get_codebase_overview".to_string(),
                description: "Get a high-level overview of the codebase (stats, entry points, subsystems).".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "root_path": { "type": "string" }
                    }
                }),
            },
            Tool {
                name: "get_patterns".to_string(),
                description: "List pattern categories and their patterns.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "root_path": { "type": "string" },
                        "detail": { "type": "string", "enum": ["summary", "full"] }
                    }
                }),
            },
            Tool {
                name: "export".to_string(),
                description: "Export issues to SARIF (GitHub) or JSON format.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "root_path": { "type": "string" },
                        "format": { "type": "string", "enum": ["sarif", "json"] },
                        "output_file": { "type": "string" },
                        "category": { "type": "string" },
                        "severity": { "type": "string", "enum": ["high", "medium", "low"] },
                        "limit": { "type": "number" }
                    },
                    "required": ["format"]
                }),
            },
            Tool {
                name: "batch".to_string(),
                description: "Unified ATLS batch execution. One schema for all operations: discover, understand, change, verify, session. Steps execute sequentially with typed dataflow. Wraps batch_query for individual ops, adds step composition and execution policy.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "version": { "type": "string", "const": "1.0" },
                        "goal": { "type": "string", "description": "Semantic intent for this batch run" },
                        "root_path": { "type": "string", "description": "Project root path" },
                        "policy": {
                            "type": "object",
                            "description": "Optional constraints (verify_after_change, max_steps, etc.). Execution mode is app-controlled — omit mode.",
                            "properties": {
                                "verify_after_change": { "type": "boolean" },
                                "rollback_on_failure": { "type": "boolean" },
                                "max_steps": { "type": "integer" },
                                "stop_on_verify_failure": { "type": "boolean" }
                            }
                        },
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": { "type": "string" },
                                    "use": { "type": "string", "description": "Operation kind (e.g. search.code, read.context, change.edit)" },
                                    "with": { "type": "object", "description": "Operation-specific parameters" },
                                    "in": { "type": "object", "description": "Input bindings from prior steps" },
                                    "out": { "description": "Named output(s) for downstream steps" },
                                    "if": { "type": "object", "description": "Conditional execution" },
                                    "on_error": { "type": "string", "enum": ["stop", "continue", "rollback"] }
                                },
                                "required": ["id", "use"]
                            }
                        }
                    },
                    "required": ["version", "steps"]
                }),
            },
        ]
    }

    /// Call a tool by name
    pub async fn call_tool(
        &mut self,
        name: &str,
        args: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let args = args.unwrap_or_else(|| serde_json::json!({}));
        let name_trimmed = name.trim();
        if name_trimmed.is_empty() || name_trimmed.len() < 2 {
            let hint = if !name_trimmed.is_empty() {
                find_nearest_valid_tool(name_trimmed)
                    .map(|n| format!(" Did you mean: {}? Example: {{\"name\":\"{}\",\"args\":{{...}}}}", n, n))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            return Err(format!(
                "Invalid tool name.{} Available: batch_query, batch, find_issues, scan_project, get_codebase_overview, get_patterns, export",
                hint
            ));
        }
        match name_trimmed {
            "batch_query" => batch::handle_batch_query(&self.project_manager, args).await,
            "batch" => batch::handle_unified_batch(&self.project_manager, args).await,
            "find_issues" => issues::handle_find_issues(&self.project_manager, args).await,
            "scan_project" => scan::handle_scan_project(&self.project_manager, args).await,
            "get_codebase_overview" => overview::handle_get_codebase_overview(&self.project_manager, args).await,
            "get_patterns" => patterns::handle_get_patterns(&self.project_manager, args).await,
            "export" => export::handle_export(&self.project_manager, args).await,
            _ => {
                let hint = find_nearest_valid_tool(name_trimmed)
                    .map(|n| format!(" Did you mean: {}? Example: {{\"name\":\"{}\",\"args\":{{...}}}}", n, n))
                    .unwrap_or_default();
                Err(format!(
                    "Unknown tool: {}.{} Available: batch_query, batch, find_issues, scan_project, get_codebase_overview, get_patterns, export",
                    name_trimmed, hint
                ))
            }
        }
    }
}

impl Default for Handlers {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levenshtein_identical_is_zero() {
        assert_eq!(levenshtein("batch", "batch"), 0);
    }

    #[test]
    fn find_nearest_tool_typo_hint() {
        assert_eq!(find_nearest_valid_tool("batch_qury"), Some("batch_query"));
    }

    #[test]
    fn list_tools_includes_primary_tools() {
        let h = Handlers::new();
        let names: Vec<String> = h.list_tools().into_iter().map(|t| t.name).collect();
        assert!(names.iter().any(|n| n == "batch_query"));
        assert!(names.iter().any(|n| n == "scan_project"));
    }

    #[tokio::test]
    async fn call_tool_rejects_unknown_name() {
        let mut h = Handlers::new();
        let err = h
            .call_tool("not_a_real_tool", Some(serde_json::json!({})))
            .await
            .unwrap_err();
        assert!(err.contains("Unknown tool"), "{}", err);
    }

    #[tokio::test]
    async fn call_tool_batch_query_help_ok() {
        let mut h = Handlers::new();
        let v = h
            .call_tool(
                "batch_query",
                Some(serde_json::json!({ "operation": "help" })),
            )
            .await
            .expect("batch_query help");
        assert!(
            v.get("operations").is_some() || v.get("details").is_some() || v.get("inventory").is_some(),
            "expected help payload keys, got: {:?}",
            v
        );
    }

    #[tokio::test]
    async fn call_tool_find_issues_ok() {
        let mut h = Handlers::new();
        let v = h
            .call_tool("find_issues", Some(serde_json::json!({})))
            .await
            .expect("find_issues");
        assert!(v.get("issues").is_some() || v.get("summary").is_some() || v.is_array());
    }

    #[tokio::test]
    async fn call_tool_scan_project_ok() {
        let mut h = Handlers::new();
        let v = h
            .call_tool("scan_project", Some(serde_json::json!({})))
            .await
            .expect("scan_project");
        assert_eq!(v.get("status").and_then(|x| x.as_str()), Some("complete"));
    }

    #[tokio::test]
    async fn call_tool_get_codebase_overview_ok() {
        let mut h = Handlers::new();
        let v = h
            .call_tool("get_codebase_overview", Some(serde_json::json!({})))
            .await
            .expect("overview");
        assert!(v.get("file_count").is_some() || v.get("stats").is_some());
    }

    #[tokio::test]
    async fn call_tool_get_patterns_ok() {
        let mut h = Handlers::new();
        let v = h
            .call_tool(
                "get_patterns",
                Some(serde_json::json!({ "detail": "summary" })),
            )
            .await
            .expect("get_patterns");
        assert!(v.is_object());
    }

    #[tokio::test]
    async fn call_tool_export_json_ok() {
        let mut h = Handlers::new();
        let v = h
            .call_tool(
                "export",
                Some(serde_json::json!({ "format": "json" })),
            )
            .await
            .expect("export json");
        assert!(v.get("issues").is_some() || v.get("summary").is_some());
    }

    #[tokio::test]
    async fn call_tool_unified_batch_runs_step() {
        let mut h = Handlers::new();
        let v = h
            .call_tool(
                "batch",
                Some(serde_json::json!({
                    "version": "1.0",
                    "steps": [{
                        "id": "s1",
                        "use": "search.code",
                        "with": { "queries": ["fn"] }
                    }]
                })),
            )
            .await
            .expect("unified batch");
        let steps = v
            .get("step_results")
            .and_then(|s| s.as_array())
            .expect("step_results");
        assert_eq!(steps.len(), 1);
    }

    #[tokio::test]
    async fn list_tools_names_are_dispatchable() {
        let mut h = Handlers::new();
        let names: Vec<String> = h.list_tools().into_iter().map(|t| t.name).collect();
        for name in &names {
            let minimal = match name.as_str() {
                "batch_query" => serde_json::json!({ "operation": "help" }),
                "batch" => serde_json::json!({
                    "version": "1.0",
                    "steps": [{ "id": "h", "use": "search.code", "with": { "queries": ["fn"] } }]
                }),
                "find_issues" => serde_json::json!({}),
                "scan_project" => serde_json::json!({}),
                "get_codebase_overview" => serde_json::json!({}),
                "get_patterns" => serde_json::json!({ "detail": "summary" }),
                "export" => serde_json::json!({ "format": "json" }),
                other => panic!("unexpected tool in list_tools: {}", other),
            };
            let res = h.call_tool(name, Some(minimal)).await;
            assert!(res.is_ok(), "tool {} failed: {:?}", name, res.err());
        }
    }
}
