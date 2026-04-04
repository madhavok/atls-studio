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
}
