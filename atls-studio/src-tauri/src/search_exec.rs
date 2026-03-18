use super::*;
use crate::pty::resolve_working_dir;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    file: String,
    line: u32,
    column: Option<u32>,
    snippet: String,
}

/// Search for text in files
#[tauri::command]
pub async fn search_text(
    query: String,
    path: String,
    case_sensitive: bool,
    use_regex: bool,
) -> Result<Vec<SearchResult>, String> {
    let root_path = PathBuf::from(&path);
    
    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    let mut results = Vec::new();
    let max_results = 500;
    
    // Build regex pattern
    let pattern = if use_regex {
        if case_sensitive {
            Regex::new(&query)
        } else {
            Regex::new(&format!("(?i){}", query))
        }
    } else {
        let escaped = regex::escape(&query);
        if case_sensitive {
            Regex::new(&escaped)
        } else {
            Regex::new(&format!("(?i){}", escaped))
        }
    }.map_err(|e| format!("Invalid pattern: {}", e))?;
    
    // Walk the directory
    fn search_dir(
        dir: &PathBuf,
        pattern: &Regex,
        results: &mut Vec<SearchResult>,
        max_results: usize,
        depth: u32,
    ) -> std::io::Result<()> {
        if depth > 10 || results.len() >= max_results {
            return Ok(());
        }
        
        for entry in std::fs::read_dir(dir)? {
            if results.len() >= max_results {
                break;
            }
            
            let entry = entry?;
            let path = entry.path();
            let name = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            
            // Skip hidden and common ignore patterns
            if name.starts_with('.') 
                || name == "node_modules" 
                || name == "target" 
                || name == "__pycache__"
                || name == "dist"
                || name == "build"
            {
                continue;
            }
            
            if path.is_dir() {
                search_dir(&path, pattern, results, max_results, depth + 1)?;
            } else if path.is_file() {
                // Only search text files
                let ext = path.extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                
                let text_extensions = [
                    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java",
                    "c", "cpp", "h", "hpp", "cs", "rb", "php", "swift", "kt",
                    "sql", "json", "yaml", "yml", "md", "txt", "html", "css",
                    "scss", "xml", "toml", "lock", "sh", "ps1",
                ];
                
                if !text_extensions.contains(&ext.as_str()) && !ext.is_empty() {
                    continue;
                }
                
                // Search the file
                if let Ok(file) = File::open(&path) {
                    let reader = BufReader::new(file);
                    for (line_num, line_result) in reader.lines().enumerate() {
                        if results.len() >= max_results {
                            break;
                        }
                        
                        if let Ok(line) = line_result {
                            if pattern.is_match(&line) {
                                results.push(SearchResult {
                                    file: path.to_string_lossy().to_string(),
                                    line: (line_num + 1) as u32,
                                    column: None,
                                    snippet: line.trim().chars().take(200).collect(),
                                });
                            }
                        }
                    }
                }
            }
        }
        
        Ok(())
    }
    
    search_dir(&root_path, &pattern, &mut results, max_results, 0)
        .map_err(|e| format!("Search failed: {}", e))?;
    
    Ok(results)
}

/// Get symbol usage (definitions and references) - uses ATLS QueryEngine
#[tauri::command]
pub async fn get_symbol_usage(
    app: AppHandle,
    symbol: String,
    _path: String,
) -> Result<SymbolUsage, String> {
    let state = app.state::<AtlsProjectState>();
    let project = {
        let roots = state.roots.lock().await;
        let ar = state.active_root.read().map(|a| a.clone()).unwrap_or(None);
        match resolve_project(&roots, &ar, None) {
            Ok((p, _)) => Some(p),
            Err(_) => None,
        }
    };

    if let Some(project) = project {
        let usage = project.query().get_symbol_usage(&symbol)
            .map_err(|e| format!("Failed to get symbol usage: {}", e))?;
        
        let definitions: Vec<SymbolLocation> = usage.definitions.into_iter().map(|d| {
            SymbolLocation {
                file: d.file,
                line: d.line,
                kind: Some(d.kind),
            }
        }).collect();
        
        let references: Vec<SymbolLocation> = usage.references.into_iter().map(|r| {
            SymbolLocation {
                file: r.file,
                line: r.line,
                kind: None,
            }
        }).collect();
        
        Ok(SymbolUsage { symbol, definitions, references })
    } else {
        Ok(SymbolUsage { symbol, definitions: vec![], references: vec![] })
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct SymbolUsage {
    symbol: String,
    definitions: Vec<SymbolLocation>,
    references: Vec<SymbolLocation>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct SymbolLocation {
    file: String,
    line: u32,
    kind: Option<String>,
}

/// Execute a shell command
#[tauri::command]
pub async fn execute_command(app: AppHandle, command: String, cwd: Option<String>) -> Result<String, String> {
    let working_dir = resolve_working_dir(&app, cwd);
    
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            let (shell, shell_arg) = super::resolve_shell();
            let mut cmd = std::process::Command::new(shell);
            cmd.arg(shell_arg)
                .arg(&command)
                .current_dir(&working_dir);
            #[cfg(windows)]
            cmd.creation_flags(0x08000000);
            cmd.output()
        }),
    )
    .await;
    
    let output = match result {
        Ok(Ok(Ok(output))) => output,
        Ok(Ok(Err(e))) => return Err(format!("Failed to execute command: {}", e)),
        Ok(Err(e)) => return Err(format!("Command task panicked: {}", e)),
        Err(_) => return Err("Command timed out after 30s".to_string()),
    };
    
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    
    if !stderr.is_empty() && !output.status.success() {
        return Err(stderr);
    }
    
    Ok(if stderr.is_empty() { stdout } else { format!("{}{}", stdout, stderr) })
}

/// Search for files by name
#[tauri::command]
pub async fn search_files(query: String, path: String) -> Result<Vec<String>, String> {
    let root_path = PathBuf::from(&path);
    
    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    let mut results = Vec::new();
    let max_results = 100;
    let query_lower = query.to_lowercase();
    
    fn search_files_recursive(
        dir: &PathBuf,
        query: &str,
        results: &mut Vec<String>,
        max_results: usize,
        depth: u32,
    ) -> std::io::Result<()> {
        if depth > 10 || results.len() >= max_results {
            return Ok(());
        }
        
        for entry in std::fs::read_dir(dir)? {
            if results.len() >= max_results {
                break;
            }
            
            let entry = entry?;
            let path = entry.path();
            let name = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            
            // Skip hidden and common ignore patterns
            if name.starts_with('.') 
                || name == "node_modules" 
                || name == "target" 
                || name == "__pycache__"
                || name == "dist"
                || name == "build"
            {
                continue;
            }
            
            if path.is_dir() {
                search_files_recursive(&path, query, results, max_results, depth + 1)?;
            } else if name.to_lowercase().contains(query) {
                results.push(path.to_string_lossy().to_string());
            }
        }
        
        Ok(())
    }
    
    search_files_recursive(&root_path, &query_lower, &mut results, max_results, 0)
        .map_err(|e| format!("Search failed: {}", e))?;
    
    Ok(results)
}
