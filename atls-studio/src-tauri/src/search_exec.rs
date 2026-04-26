use super::*;
use crate::pty::resolve_working_dir;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    file: String,
    line: u32,
    column: Option<u32>,
    snippet: String,
}

/// Build the regex used by [`search_text`] from user options.
pub(crate) fn build_search_regex(
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
) -> Result<Regex, String> {
    if use_regex {
        if case_sensitive {
            Regex::new(query)
        } else {
            Regex::new(&format!("(?i){}", query))
        }
    } else {
        let escaped = regex::escape(query);
        if case_sensitive {
            Regex::new(&escaped)
        } else {
            Regex::new(&format!("(?i){}", escaped))
        }
    }
    .map_err(|e| format!("Invalid pattern: {}", e))
}

pub(crate) const SEARCH_TEXT_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs",
    "rb", "php", "swift", "kt", "sql", "json", "yaml", "yml", "md", "txt", "html", "css", "scss",
    "xml", "toml", "lock", "sh", "ps1",
];

pub(crate) fn is_skipped_search_entry_name(name: &str) -> bool {
    name.starts_with('.')
        || name == "node_modules"
        || name == "target"
        || name == "__pycache__"
        || name == "dist"
        || name == "build"
}

pub(crate) fn is_searchable_text_extension(ext: &str) -> bool {
    if ext.is_empty() {
        return true;
    }
    let lower = ext.to_lowercase();
    SEARCH_TEXT_EXTENSIONS.iter().any(|e| *e == lower.as_str())
}

/// Walk `root` up to depth 10 and collect lines matching `pattern` (max `max_results` hits).
pub(crate) fn search_directory_for_text_matches(
    root: &Path,
    pattern: &Regex,
    max_results: usize,
) -> std::io::Result<Vec<SearchResult>> {
    let mut results = Vec::new();
    search_dir(root, pattern, &mut results, max_results, 0)?;
    Ok(results)
}

fn search_dir(
    dir: &Path,
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
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if is_skipped_search_entry_name(&name) {
            continue;
        }

        if path.is_dir() {
            search_dir(&path, pattern, results, max_results, depth + 1)?;
        } else if path.is_file() {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            if !is_searchable_text_extension(&ext) {
                continue;
            }

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

    let max_results = 500;
    let pattern = build_search_regex(&query, case_sensitive, use_regex)?;

    search_directory_for_text_matches(&root_path, &pattern, max_results)
        .map_err(|e| format!("Search failed: {}", e))
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
        let usage = project
            .query()
            .get_symbol_usage(&symbol)
            .map_err(|e| format!("Failed to get symbol usage: {}", e))?;

        let definitions: Vec<SymbolLocation> = usage
            .definitions
            .into_iter()
            .map(|d| SymbolLocation {
                file: d.file,
                line: d.line,
                kind: Some(d.kind),
            })
            .collect();

        let references: Vec<SymbolLocation> = usage
            .references
            .into_iter()
            .map(|r| SymbolLocation {
                file: r.file,
                line: r.line,
                kind: None,
            })
            .collect();

        Ok(SymbolUsage {
            symbol,
            definitions,
            references,
        })
    } else {
        Ok(SymbolUsage {
            symbol,
            definitions: vec![],
            references: vec![],
        })
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
pub async fn execute_command(
    app: AppHandle,
    command: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let working_dir = resolve_working_dir(&app, cwd);

    let result = tokio::task::spawn_blocking(move || {
        let (shell, shell_arg) = super::resolve_shell();
        let mut cmd = std::process::Command::new(shell);
        cmd.arg(shell_arg).arg(&command).current_dir(&working_dir);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        cmd.output()
    })
    .await;

    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("Failed to execute command: {}", e)),
        Err(e) => return Err(format!("Command task panicked: {}", e)),
    };

    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));

    if !stderr.is_empty() && !output.status.success() {
        return Err(stderr);
    }

    Ok(if stderr.is_empty() {
        stdout
    } else {
        format!("{}{}", stdout, stderr)
    })
}

pub(crate) fn search_files_by_name_inner(
    root: &Path,
    query: &str,
    max_results: usize,
) -> std::io::Result<Vec<String>> {
    let mut results = Vec::new();
    let query_lower = query.to_lowercase();
    search_files_recursive(root, &query_lower, &mut results, max_results, 0)?;
    Ok(results)
}

fn search_files_recursive(
    dir: &Path,
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
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if is_skipped_search_entry_name(&name) {
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

/// Search for files by name
#[tauri::command]
pub async fn search_files(query: String, path: String) -> Result<Vec<String>, String> {
    let root_path = PathBuf::from(&path);

    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let max_results = 100;
    search_files_by_name_inner(&root_path, &query, max_results).map_err(|e| format!("Search failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn build_search_regex_literal_case_insensitive() {
        let re = build_search_regex("Foo", false, false).unwrap();
        assert!(re.is_match("foo"));
        assert!(re.is_match("FOO"));
    }

    #[test]
    fn build_search_regex_literal_escapes_metacharacters() {
        let re = build_search_regex("a+b", false, false).unwrap();
        assert!(re.is_match("a+b"));
        assert!(!re.is_match("aab"));
    }

    #[test]
    fn build_search_regex_user_regex_invalid() {
        assert!(build_search_regex("(", true, true).is_err());
    }

    #[test]
    fn skipped_names_match_ignored_dirs() {
        assert!(is_skipped_search_entry_name(".git"));
        assert!(is_skipped_search_entry_name("node_modules"));
        assert!(!is_skipped_search_entry_name("src"));
    }

    #[test]
    fn text_extension_filter() {
        assert!(is_searchable_text_extension("rs"));
        assert!(is_searchable_text_extension(""));
        assert!(!is_searchable_text_extension("exe"));
    }

    #[test]
    fn search_directory_finds_matches() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("src");
        std::fs::create_dir(&sub).unwrap();
        let mut f = std::fs::File::create(sub.join("hello.rs")).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();
        writeln!(f, "let needle = 1;").unwrap();

        let re = Regex::new("needle").unwrap();
        let hits = search_directory_for_text_matches(dir.path(), &re, 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].file.ends_with("hello.rs"));
        assert_eq!(hits[0].line, 2);
        assert!(hits[0].snippet.contains("needle"));
    }

    #[test]
    fn search_files_by_name_finds_basename() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("FooBar.rs"), "").unwrap();
        let paths = search_files_by_name_inner(dir.path(), "bar", 20).unwrap();
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("FooBar.rs"));
    }
}
