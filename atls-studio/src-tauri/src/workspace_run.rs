//! Workspace run scripts — lists runnable commands per workspace for Start/Stop UI.
//! Reads package.json, Cargo.toml, etc. and returns all scripts with a smart default.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceScript {
    pub name: String,
    pub cmd: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceScriptsResult {
    pub scripts: Vec<WorkspaceScript>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

pub(crate) fn package_json_has_tauri_dep(pkg: &serde_json::Value) -> bool {
    let deps = pkg.get("dependencies").or_else(|| pkg.get("devDependencies"));
    deps.and_then(|d| d.as_object())
        .map(|o| o.keys().any(|k| k.starts_with("@tauri-apps/")))
        .unwrap_or(false)
}

pub(crate) fn npm_script_sort_key(name: &str) -> u8 {
    if name == "tauri:dev" || name == "tauri dev" {
        0
    } else if name == "dev" {
        1
    } else if name == "start" {
        2
    } else {
        3
    }
}

/// List all runnable scripts for a workspace directory.
/// Returns scripts with optional default (smart detection for Tauri, dev, etc.).
#[tauri::command]
pub async fn atls_get_workspace_scripts(abs_path: String) -> Result<WorkspaceScriptsResult, String> {
    let path = Path::new(&abs_path);
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", abs_path));
    }

    // Node/TS: package.json
    let pkg_path = path.join("package.json");
    if pkg_path.exists() {
        return node_scripts(&pkg_path);
    }

    // Rust: Cargo.toml
    let cargo_path = path.join("Cargo.toml");
    if cargo_path.exists() {
        return Ok(WorkspaceScriptsResult {
            scripts: vec![
                WorkspaceScript { name: "run".to_string(), cmd: "cargo run".to_string() },
                WorkspaceScript { name: "build".to_string(), cmd: "cargo build".to_string() },
                WorkspaceScript { name: "test".to_string(), cmd: "cargo test".to_string() },
                WorkspaceScript { name: "check".to_string(), cmd: "cargo check".to_string() },
            ],
            default: Some("run".to_string()),
        });
    }

    // Python: pyproject.toml or requirements.txt
    if path.join("pyproject.toml").exists() {
        return Ok(WorkspaceScriptsResult {
            scripts: vec![
                WorkspaceScript { name: "run".to_string(), cmd: "uv run .".to_string() },
                WorkspaceScript { name: "dev".to_string(), cmd: "uv run --reload .".to_string() },
            ],
            default: Some("dev".to_string()),
        });
    }
    if path.join("requirements.txt").exists() {
        return Ok(WorkspaceScriptsResult {
            scripts: vec![
                WorkspaceScript { name: "run".to_string(), cmd: "python -m .".to_string() },
            ],
            default: Some("run".to_string()),
        });
    }

    // Go
    if path.join("go.mod").exists() {
        return Ok(WorkspaceScriptsResult {
            scripts: vec![
                WorkspaceScript { name: "run".to_string(), cmd: "go run .".to_string() },
                WorkspaceScript { name: "build".to_string(), cmd: "go build ./...".to_string() },
                WorkspaceScript { name: "test".to_string(), cmd: "go test ./...".to_string() },
            ],
            default: Some("run".to_string()),
        });
    }

    // Java/Gradle
    let gradlew = path.join("gradlew");
    let gradlew_bat = path.join("gradlew.bat");
    if gradlew.exists() || gradlew_bat.exists() {
        #[cfg(windows)]
        let run_cmd = ".\\gradlew.bat run";
        #[cfg(not(windows))]
        let run_cmd = "./gradlew run";
        return Ok(WorkspaceScriptsResult {
            scripts: vec![
                WorkspaceScript { name: "run".to_string(), cmd: run_cmd.to_string() },
                WorkspaceScript { name: "build".to_string(), cmd: format!("{} build", if cfg!(windows) { ".\\gradlew.bat" } else { "./gradlew" }) },
            ],
            default: Some("run".to_string()),
        });
    }

    // C# / .NET
    let (has_csproj, sln_path) = std::fs::read_dir(path)
        .map(|entries| {
            let mut csproj = false;
            let mut sln: Option<std::path::PathBuf> = None;
            for e in entries.filter_map(|e| e.ok()) {
                let n: String = e.file_name().to_string_lossy().into_owned();
                if n.ends_with(".csproj") { csproj = true; }
                if n.ends_with(".sln") { sln = Some(e.path()); }
            }
            (csproj || sln.is_some(), sln)
        })
        .unwrap_or((false, None));
    if has_csproj || sln_path.is_some() {
        let run_cmd = "dotnet run".to_string();
        return Ok(WorkspaceScriptsResult {
            scripts: vec![
                WorkspaceScript { name: "run".to_string(), cmd: run_cmd },
                WorkspaceScript { name: "build".to_string(), cmd: "dotnet build".to_string() },
            ],
            default: Some("run".to_string()),
        });
    }

    Err(format!("No supported project found in {}", abs_path))
}

fn node_scripts(pkg_path: &std::path::Path) -> Result<WorkspaceScriptsResult, String> {
    let contents = std::fs::read_to_string(pkg_path)
        .map_err(|e| format!("Failed to read package.json: {}", e))?;
    let pkg: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Invalid package.json: {}", e))?;
    let scripts = pkg.get("scripts")
        .and_then(|s| s.as_object())
        .ok_or("package.json missing 'scripts'")?;

    let mut list: Vec<WorkspaceScript> = scripts.iter()
        .map(|(name, _val)| {
            WorkspaceScript {
                name: name.clone(),
                cmd: format!("npm run {}", name),
            }
        })
        .collect();

    // Sort for consistent order: dev-like first, then alphabetical
    list.sort_by(|a, b| {
        let pa = npm_script_sort_key(&a.name);
        let pb = npm_script_sort_key(&b.name);
        if pa != pb {
            pa.cmp(&pb)
        } else {
            a.name.cmp(&b.name)
        }
    });

    // Smart default: Tauri project -> tauri:dev; else dev; else start; else first
    let has_tauri = package_json_has_tauri_dep(&pkg);

    let default = if has_tauri {
        list.iter().find(|s| s.name == "tauri:dev" || s.name == "tauri dev")
            .or_else(|| list.iter().find(|s| s.name == "dev"))
    } else {
        list.iter().find(|s| s.name == "dev")
            .or_else(|| list.iter().find(|s| s.name == "start"))
    };
    let default_name = default.map(|s| s.name.clone());
    let fallback = list.first().map(|s| s.name.clone());

    Ok(WorkspaceScriptsResult {
        scripts: list,
        default: default_name.or(fallback),
    })
}

#[cfg(test)]
mod tests {
    use super::{npm_script_sort_key, package_json_has_tauri_dep};

    #[test]
    fn sort_key_prefers_tauri_dev() {
        assert!(npm_script_sort_key("tauri:dev") < npm_script_sort_key("build"));
        assert!(npm_script_sort_key("dev") < npm_script_sort_key("z"));
    }

    #[test]
    fn detects_tauri_from_dev_dependencies() {
        let pkg: serde_json::Value = serde_json::json!({
            "devDependencies": { "@tauri-apps/api": "2.0.0" }
        });
        assert!(package_json_has_tauri_dep(&pkg));
    }

    #[test]
    fn no_false_positive_without_tauri() {
        let pkg: serde_json::Value = serde_json::json!({
            "devDependencies": { "react": "^18" }
        });
        assert!(!package_json_has_tauri_dep(&pkg));
    }
}
