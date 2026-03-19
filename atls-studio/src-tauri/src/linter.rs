// Lint-on-Write Module
// Provides real-time linting for file operations (create_files, replace, refactoring)
// Returns lint results immediately so AI can fix issues in the next iteration

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use tree_sitter::{Parser, Language};

/// Windows CREATE_NO_WINDOW flag (0x08000000) - prevents console window flash when spawning subprocesses.
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Get the null device path for the current platform
#[cfg(windows)]
fn get_null_device() -> &'static str {
    "NUL"
}

#[cfg(not(windows))]
fn get_null_device() -> &'static str {
    "/dev/null"
}

/// A single lint result/diagnostic
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LintResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_col: Option<u32>,
    pub severity: String, // "error" | "warning" | "info"
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Vec<String>>,
}

impl LintResult {
    pub fn new(file: String, line: u32, column: u32, severity: String, code: String, message: String) -> Self {
        Self { file, line, column, end_line: None, end_col: None, severity, code, message, context: None }
    }
}

pub fn enrich_lint_with_context(results: &mut [LintResult], file_path: &str, content: &str) {
    let lines: Vec<&str> = content.lines().collect();
    for result in results.iter_mut() {
        if result.file != file_path { continue; }
        let idx = (result.line as usize).saturating_sub(1);
        let mut ctx = Vec::new();
        if idx > 0 {
            if let Some(line) = lines.get(idx - 1) {
                ctx.push(format!("  {}| {}", idx, line));
            }
        }
        ctx.push(format!(">>{}| {}", idx + 1, lines.get(idx).unwrap_or(&"")));
        if let Some(line) = lines.get(idx + 1) {
            ctx.push(format!("  {}| {}", idx + 2, line));
        }
        result.context = Some(ctx);
    }
}

/// Summary of lint results for token-efficient AI consumption
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LintSummary {
    pub total: u32,
    pub files_with_issues: u32,
    pub by_severity: HashMap<String, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_issues: Option<Vec<LintResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filtered_out: Option<u32>,
}

/// Options for linting
#[derive(Debug, Clone, Default)]
pub struct LintOptions {
    /// Root path for resolving relative paths
    pub root_path: String,
    /// Maximum errors to return per file (default: 50)
    pub max_errors_per_file: Option<usize>,
    /// Include warnings (default: true). Reserved for future filtering support.
    #[allow(dead_code)]
    pub include_warnings: Option<bool>,
    /// Timeout in ms for CLI linters (default: 10000)
    pub timeout_ms: Option<u64>,
    /// Use tree-sitter syntax-only check instead of full compilation.
    /// Catches syntax errors (malformed braces, missing tokens) without
    /// requiring type resolution or external compiler tools.
    pub syntax_only: Option<bool>,
    /// When true, use only each language's native parser/tooling (tsc, py_compile,
    /// gofmt, javac, rustc, etc.) — skip built-in tree-sitter for TS/JS.
    pub use_native_parser: Option<bool>,
}

/// Default timeout for external linter commands (15 seconds)
const DEFAULT_LINT_TIMEOUT_MS: u64 = 15000;

/// Extended timeout for compiler-based linters (C#/dotnet, Java/javac) that
/// may need to resolve dependencies and build entire projects.
const COMPILER_LINT_TIMEOUT_MS: u64 = 30000;

/// Run an external command with a timeout. Returns None if the command
/// times out or fails to spawn, preventing hangs from missing tools or
/// Windows Defender delays.
fn run_lint_command(mut cmd: Command, timeout_ms: u64) -> Option<std::process::Output> {
    use std::time::Duration;

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = match cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Linter] Failed to spawn command: {}", e);
            return None;
        }
    };

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(Ok(output)) => Some(output),
        Ok(Err(_)) => None,
        Err(_) => {
            eprintln!("[Linter] Command timed out after {}ms", timeout_ms);
            None
        }
    }
}

// ============================================================================
// Main API
// ============================================================================

/// Lint multiple files and return results
/// Automatically detects language from file extension
pub fn lint_files(
    files: &[(String, String)], // (path, content)
    options: &LintOptions,
) -> Vec<LintResult> {
    let mut results = Vec::new();
    
    for (path, content) in files {
        let file_results = lint_file(path, content, options);
        results.extend(file_results);
    }
    
    results
}

/// Lint a single file
pub fn lint_file(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    // Syntax-only mode: use tree-sitter for all supported languages.
    // When use_native_parser is true, skip this — we use native tooling instead.
    if options.syntax_only.unwrap_or(false) && !options.use_native_parser.unwrap_or(false) {
        return lint_treesitter(path, content, options);
    }

    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    match ext.as_str() {
        // TypeScript/JavaScript - use tree-sitter
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => {
            lint_typescript(path, content, options)
        }
        // Python - use python -m py_compile
        "py" | "pyw" => {
            lint_python(path, content, options)
        }
        // Go - use gofmt
        "go" => {
            lint_go(path, content, options)
        }
        // Java - use javac
        "java" => {
            lint_java(path, content, options)
        }
        // Rust - use rustc
        "rs" => {
            lint_rust(path, content, options)
        }
        // C# - use csc/mcs
        "cs" => {
            lint_csharp(path, content, options)
        }
        // PHP - use php -l
        "php" => {
            lint_php(path, content, options)
        }
        // Swift - use swiftc -parse
        "swift" => {
            lint_swift(path, content, options)
        }
        // C/C++ - tree-sitter syntax-only (lint_treesitter already supports these)
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" | "c" | "h" => {
            lint_treesitter(path, content, options)
        }
        // Ruby - use ruby -c
        "rb" | "rake" | "gemspec" => {
            lint_ruby(path, content, options)
        }
        // Scala - tree-sitter syntax-only
        "scala" | "sc" => {
            lint_treesitter(path, content, options)
        }
        // Kotlin - kotlinc
        "kt" | "kts" => {
            lint_kotlin(path, content, options)
        }
        // Dart - dart analyze
        "dart" => {
            lint_dart(path, content, options)
        }
        // Unsupported language - no linting
        _ => Vec::new(),
    }
}

/// Create a summary from lint results
pub fn create_lint_summary(results: &[LintResult]) -> LintSummary {
    let mut by_severity: HashMap<String, u32> = HashMap::new();
    by_severity.insert("error".to_string(), 0);
    by_severity.insert("warning".to_string(), 0);
    by_severity.insert("info".to_string(), 0);
    
    let mut files_set = std::collections::HashSet::new();
    
    for result in results {
        *by_severity.entry(result.severity.clone()).or_insert(0) += 1;
        files_set.insert(result.file.clone());
    }
    
    // Get top 10 issues (errors first, then by file/line)
    let mut sorted_results: Vec<_> = results.to_vec();
    sorted_results.sort_by(|a, b| {
        let severity_order = |s: &str| match s {
            "error" => 0,
            "warning" => 1,
            _ => 2,
        };
        let a_order = severity_order(&a.severity);
        let b_order = severity_order(&b.severity);
        if a_order != b_order {
            return a_order.cmp(&b_order);
        }
        let file_cmp = a.file.cmp(&b.file);
        if file_cmp != std::cmp::Ordering::Equal {
            return file_cmp;
        }
        a.line.cmp(&b.line)
    });
    
    let top_issues = if !sorted_results.is_empty() {
        Some(sorted_results.into_iter().take(10).collect())
    } else {
        None
    };
    
    LintSummary {
        total: results.len() as u32,
        files_with_issues: files_set.len() as u32,
        by_severity,
        top_issues,
        filtered_out: None,
    }
}

// ============================================================================
// TypeScript/JavaScript Linting (tree-sitter)
// ============================================================================

/// Get tree-sitter language for TypeScript
fn get_typescript_language() -> Language {
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}

/// Get tree-sitter language for TSX
fn get_tsx_language() -> Language {
    tree_sitter_typescript::LANGUAGE_TSX.into()
}

/// Get tree-sitter language for JavaScript
fn get_javascript_language() -> Language {
    tree_sitter_javascript::LANGUAGE.into()
}

/// Lint TypeScript/JavaScript.
/// When use_native_parser: use only tsc (or tsc --allowJs for JS) — skip tree-sitter.
/// In syntax_only mode (and not use_native_parser): tree-sitter parse only.
/// In full mode (default): tree-sitter first, then tsc for type errors on TS/TSX.
pub fn lint_typescript(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let max_errors = options.max_errors_per_file.unwrap_or(50);
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Native parser only: skip tree-sitter, use only tsc (with --allowJs for JS/JSX)
    if options.use_native_parser.unwrap_or(false) {
        return lint_typescript_tsc(path, content, options, max_errors, ext.as_str());
    }

    let mut results = Vec::new();

    // Determine language based on extension
    let (language, code_prefix) = match ext.as_str() {
        "tsx" => (get_tsx_language(), "TSX"),
        "ts" | "mts" | "cts" => (get_typescript_language(), "TS"),
        "jsx" => (get_javascript_language(), "JSX"),
        "js" | "mjs" | "cjs" | _ => (get_javascript_language(), "JS"),
    };

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        eprintln!("[Linter] Failed to set tree-sitter language for {} (ext: {})", path, ext);
        return results;
    }

    // Parse the content
    let tree = match parser.parse(content, None) {
        Some(tree) => tree,
        None => {
            results.push(LintResult::new(path.to_string(), 1, 1, "error".to_string(), format!("{}_PARSE", code_prefix), "Failed to parse file".to_string()));
            return results;
        }
    };

    // Check if the root node itself has errors
    let root = tree.root_node();
    if root.has_error() {
        collect_tree_sitter_errors(&root, content, path, &mut results, max_errors, code_prefix);
    }

    // Full mode: run tsc for type checking on TS/TSX files (skip JS)
    if !options.syntax_only.unwrap_or(false) && matches!(ext.as_str(), "ts" | "tsx" | "mts" | "cts") {
        results.extend(lint_typescript_tsc(path, content, options, max_errors, ext.as_str()));
    }

    results
}

/// Lightweight in-memory syntax check using tree-sitter only.
/// Returns syntax errors without requiring temp files or external tools.
/// Used as a pre-commit gate for edit sessions.
pub fn syntax_check_ts(path: &str, content: &str) -> Vec<LintResult> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let (language, code_prefix) = match ext.as_str() {
        "tsx" => (get_tsx_language(), "TSX"),
        "ts" | "mts" | "cts" => (get_typescript_language(), "TS"),
        "jsx" => (get_javascript_language(), "JSX"),
        "js" | "mjs" | "cjs" => (get_javascript_language(), "JS"),
        _ => return Vec::new(),
    };

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }

    let tree = match parser.parse(content, None) {
        Some(tree) => tree,
        None => {
            return vec![LintResult::new(
                path.to_string(), 1, 1, "error".to_string(),
                format!("{}_PARSE", code_prefix),
                "Failed to parse file".to_string(),
            )];
        }
    };

    let root = tree.root_node();
    if !root.has_error() {
        return Vec::new();
    }

    let mut results = Vec::new();
    collect_tree_sitter_errors(&root, content, path, &mut results, 10, code_prefix);
    results
}

/// Run tsc --noEmit on a temp file to catch TypeScript/JavaScript errors.
/// Uses standalone flags (--strict, --esModuleInterop) when no tsconfig is present.
/// For JS/JSX, adds --allowJs so tsc can parse JavaScript natively.
fn lint_typescript_tsc(path: &str, content: &str, options: &LintOptions, max_errors: usize, ext: &str) -> Vec<LintResult> {
    let mut results = Vec::new();
    let root = Path::new(&options.root_path);

    // Find the best working directory for tsc.
    // When syntax_only (e.g. pre-write lint): always use root_path so temp file and cwd match
    // the project being edited — avoids tsconfig from a different project (e.g. atls-studio)
    // affecting the check. Use npx for tsc when not in project.
    // For full lint: prefer directory with local typescript for faster runs.
    let syntax_only = options.syntax_only.unwrap_or(false);
    let mut tsc_cwd = root.to_path_buf();
    let mut has_local_ts = root.join("node_modules").join("typescript").exists();
    let root_in_system_temp = root
        .canonicalize()
        .ok()
        .and_then(|r| std::env::temp_dir().canonicalize().ok().map(|t| r.starts_with(&t)))
        .unwrap_or(false);
    if !has_local_ts && !root_in_system_temp {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() && p.join("node_modules").join("typescript").exists() {
                    tsc_cwd = p;
                    has_local_ts = true;
                    break;
                }
            }
        }
        // Also check near the running executable (the atls-studio app dir
        // may have node_modules/typescript even when the indexed project doesn't).
        if !has_local_ts {
            if let Ok(exe) = std::env::current_exe() {
                if let Some(exe_dir) = exe.parent() {
                    // Walk up from e.g. src-tauri/target/debug/ to the app root
                    for ancestor in exe_dir.ancestors().take(5) {
                        if ancestor.join("node_modules").join("typescript").exists() {
                            tsc_cwd = ancestor.to_path_buf();
                            has_local_ts = true;
                            break;
                        }
                        // Check immediate children (e.g. the frontend dir next to src-tauri)
                        if let Ok(siblings) = std::fs::read_dir(ancestor) {
                            for sib in siblings.flatten() {
                                let sp = sib.path();
                                if sp.is_dir() && sp.join("node_modules").join("typescript").exists() {
                                    tsc_cwd = sp;
                                    has_local_ts = true;
                                    break;
                                }
                            }
                        }
                        if has_local_ts { break; }
                    }
                }
            }
        }
        if !has_local_ts {
            eprintln!("[Linter] no local node_modules/typescript found; will try npx --yes tsc");
        }
    } else if syntax_only && !has_local_ts {
        eprintln!("[Linter] syntax_only: using project root for tsc (npx --yes if needed)");
    }

    // Place the temp file INSIDE tsc_cwd so we can pass just the filename
    // to tsc — no absolute path, no quoting issues across shells.
    let temp_filename = format!("__atls_check_{}.{}", std::process::id(), ext);
    let temp_file = tsc_cwd.join(&temp_filename);

    if std::fs::write(&temp_file, content).is_err() {
        eprintln!("[Linter] failed to write temp file {:?}", temp_file);
        return results;
    }
    let _cleanup = scopeguard_file(&temp_file);

    // For JS/JSX, add --allowJs so tsc can parse JavaScript natively.
    // When syntax_only: skip --strict/--isolatedModules to avoid rejecting valid JS (e.g. CommonJS)
    // that strict mode flags — we only need parse/syntax errors for pre-write gate.
    let allow_js = matches!(ext, "js" | "jsx" | "mjs" | "cjs");
    let tsc_flags = if allow_js {
        if syntax_only {
            format!(
                "--noEmit --pretty false --allowJs --esModuleInterop --moduleResolution node --target es2020 --skipLibCheck {}",
                temp_filename
            )
        } else {
            format!(
                "--noEmit --pretty false --allowJs --strict --isolatedModules --esModuleInterop --moduleResolution node --target es2020 {}",
                temp_filename
            )
        }
    } else {
        if syntax_only {
            format!(
                "--noEmit --pretty false --esModuleInterop --moduleResolution node --target es2020 --skipLibCheck {}",
                temp_filename
            )
        } else {
            format!(
                "--noEmit --pretty false --strict --isolatedModules --esModuleInterop --moduleResolution node --target es2020 {}",
                temp_filename
            )
        }
    };

    let (shell, shell_arg) = crate::resolve_shell();

    // Use -p typescript to avoid npm's deprecated "tsc" package; fallback to tsc in PATH
    let commands_to_try = [
        format!("npx --yes -p typescript tsc {}", tsc_flags),
        format!("npx --yes tsc {}", tsc_flags),
        format!("tsc {}", tsc_flags),
    ];

    let mut output = None;
    for cmd_str in &commands_to_try {
        eprintln!("[Linter] trying: {} {} {} (cwd={:?})", shell, shell_arg, &cmd_str[..cmd_str.len().min(120)], tsc_cwd);
        let mut tsc_cmd = Command::new(shell);
        tsc_cmd.arg(shell_arg).arg(cmd_str).current_dir(&tsc_cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        tsc_cmd.creation_flags(CREATE_NO_WINDOW);
        match tsc_cmd.output()
        {
            Ok(o) => {
                let code = o.status.code().unwrap_or(-1);
                let stdout_str = String::from_utf8_lossy(&o.stdout);
                let stderr_str = String::from_utf8_lossy(&o.stderr);
                eprintln!("[Linter] tsc exit={}, stdout_len={}, stderr_len={}", code, stdout_str.len(), stderr_str.len());
                if !stdout_str.is_empty() {
                    eprintln!("[Linter] tsc stdout preview: {}", &stdout_str[..stdout_str.len().min(200)]);
                }
                if !stderr_str.is_empty() {
                    eprintln!("[Linter] tsc stderr preview: {}", &stderr_str[..stderr_str.len().min(200)]);
                }
                let is_not_found = code == 127 || code == 9009
                    || stderr_str.contains("not found")
                    || stderr_str.contains("not recognized")
                    || stderr_str.contains("is not recognized as");
                if !is_not_found {
                    output = Some(o);
                    break;
                }
            }
            Err(e) => {
                eprintln!("[Linter] tsc spawn error: {}", e);
                continue;
            }
        }
    }

    let output = match output {
        Some(o) => o,
        None => {
            eprintln!("[Linter] tsc not found in {:?} (tried npx tsc, tsc)", tsc_cwd);
            return results;
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);

    // Parse: file(line,col): error TSxxxx: message
    for line in combined.lines() {
        if results.len() >= max_errors { break; }
        if line.contains("): error TS") {
            if let Some(paren_pos) = line.find('(') {
                let rest = &line[paren_pos + 1..];
                if let Some(close_paren) = rest.find(')') {
                    let coords = &rest[..close_paren];
                    let parts: Vec<&str> = coords.split(',').collect();
                    let line_num = parts.first().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                    let col = parts.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);

                    let msg_start = rest.find(": error ").map(|i| i + 8).unwrap_or(close_paren + 2);
                    let message = &rest[msg_start..];
                    let code = message.split(':').next().unwrap_or("").trim().to_string();
                    let msg_text = message.split(':').skip(1).collect::<Vec<&str>>().join(":").trim().to_string();

                    results.push(LintResult::new(
                        path.to_string(),
                        line_num,
                        col,
                        "error".to_string(),
                        code,
                        msg_text,
                    ));
                }
            }
        }
    }

    // If tsc failed but we got no parsed errors, treat as syntax/check failure (e.g. wrong tsc, spawn error)
    if !output.status.success() && results.is_empty() {
        let combined_trim = combined.trim();
        let preview = if combined_trim.len() > 200 {
            format!("{}...", &combined_trim[..200])
        } else {
            combined_trim.to_string()
        };
        eprintln!("[Linter] tsc failed with no parseable errors: {}", preview);
        results.push(LintResult::new(
            path.to_string(),
            1,
            1,
            "error".to_string(),
            "TSC".to_string(),
            format!("TypeScript check failed: {}", preview),
        ));
    }

    results
}

/// RAII cleanup: remove temp file on drop
struct FileCleanup(std::path::PathBuf);
impl Drop for FileCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn scopeguard_file(path: &Path) -> FileCleanup {
    FileCleanup(path.to_path_buf())
}

/// Recursively collect ERROR nodes from tree-sitter parse tree
fn collect_tree_sitter_errors(
    node: &tree_sitter::Node,
    content: &str,
    path: &str,
    results: &mut Vec<LintResult>,
    max_errors: usize,
    code_prefix: &str,
) {
    if results.len() >= max_errors {
        return;
    }
    
    // Check if this node is an error
    if node.is_error() || node.is_missing() {
        let start = node.start_position();
        
        // Get context around the error for better messages
        let error_text = node.utf8_text(content.as_bytes())
            .unwrap_or("<unknown>")
            .chars()
            .take(50)
            .collect::<String>();
        
        let message = if node.is_missing() {
            format!("Missing expected token near: {}", error_text.trim())
        } else {
            format!("Syntax error: unexpected token near: {}", error_text.trim())
        };
        
        results.push(LintResult::new(path.to_string(), (start.row + 1) as u32, (start.column + 1) as u32, "error".to_string(), format!("{}_SYNTAX", code_prefix), message));
    }
    
    // Recursively check children (only if they might have errors)
    if node.has_error() {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            collect_tree_sitter_errors(&child, content, path, results, max_errors, code_prefix);
        }
    }
}

// C/C++ macro preprocessing moved to atls_core::preprocess (shared with scanner).

// ============================================================================
// Generic tree-sitter syntax-only linting (all supported languages)
// ============================================================================

/// Syntax-only lint using tree-sitter grammars. Checks for parse errors
/// (ERROR/MISSING nodes) without invoking external compilers. Works for
/// Rust, Java, Go, C#, Python, C/C++ — and falls back to the existing
/// TS/JS lint_typescript for those extensions.
pub fn lint_treesitter(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let max_errors = options.max_errors_per_file.unwrap_or(50);
    let mut results = Vec::new();

    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let (language, code_prefix): (Language, &str) = match ext.as_str() {
        // TS/JS already handled by lint_typescript; include here for completeness
        "ts" | "mts" | "cts" => (get_typescript_language(), "TS"),
        "tsx" => (get_tsx_language(), "TSX"),
        "js" | "mjs" | "cjs" => (get_javascript_language(), "JS"),
        "jsx" => (get_javascript_language(), "JSX"),
        // Languages that previously required external compilers
        "rs" => (tree_sitter_rust::LANGUAGE.into(), "RUST"),
        "java" => (tree_sitter_java::LANGUAGE.into(), "JAVA"),
        "go" => (tree_sitter_go::LANGUAGE.into(), "GO"),
        "cs" | "csx" => (tree_sitter_c_sharp::LANGUAGE.into(), "CS"),
        "py" | "pyw" | "pyi" => (tree_sitter_python::LANGUAGE.into(), "PY"),
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => (tree_sitter_cpp::LANGUAGE.into(), "CPP"),
        "c" | "h" => (tree_sitter_cpp::LANGUAGE.into(), "C"),
        "swift" => (tree_sitter_swift::LANGUAGE.into(), "SWIFT"),
        "php" | "phtml" => (tree_sitter_php::LANGUAGE_PHP.into(), "PHP"),
        "rb" | "rake" | "gemspec" => (tree_sitter_ruby::LANGUAGE.into(), "RUBY"),
        "scala" | "sc" => (tree_sitter_scala::LANGUAGE.into(), "SCALA"),
        "dart" => (tree_sitter_dart_orchard::LANGUAGE.into(), "DART"),
        _ => return results,
    };

    // For C/C++ files, preprocess to expand common macro wrappers that
    // tree-sitter cannot parse. Patterns like `CJSON_PUBLIC(cJSON *)` are
    // replaced with their inner argument so the parser sees valid C syntax.
    let is_c_family = atls_core::preprocess::is_c_family(&ext);
    let preprocessed: Option<String> = if is_c_family {
        atls_core::preprocess::preprocess_c_macros(content, Some(path))
    } else {
        None
    };
    let parse_content = preprocessed.as_deref().unwrap_or(content);

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        eprintln!("[Linter] Failed to set tree-sitter language for {} (ext: {})", path, ext);
        return results;
    }

    let tree = match parser.parse(parse_content, None) {
        Some(tree) => tree,
        None => {
            results.push(LintResult::new(path.to_string(), 1, 1, "error".to_string(), format!("{}_PARSE", code_prefix), "Failed to parse file".to_string()));
            return results;
        }
    };

    let root = tree.root_node();
    if root.has_error() {
        // Use original content for error messages (not preprocessed) so line
        // text in diagnostics matches what the user sees in their editor.
        collect_tree_sitter_errors(&root, parse_content, path, &mut results, max_errors, code_prefix);
    }

    results
}

// ============================================================================
// Python Linting (via CLI)
// ============================================================================

/// Lint Python using python -m py_compile
pub fn lint_python(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(DEFAULT_LINT_TIMEOUT_MS);
    
    // Write content to temp file
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("atls_lint_{}.py", std::process::id()));
    
    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }
    
    // Try python3 first, then python (Windows often uses python, Unix uses python3)
    let python_cmds = ["python3", "python", "py"];
    let mut output_result = None;
    
    for python_cmd in python_cmds {
        let mut cmd = Command::new(python_cmd);
        cmd.args(["-m", "py_compile", temp_file.to_str().unwrap_or("")]);
        if let Some(output) = run_lint_command(cmd, timeout) {
            output_result = Some(output);
            break;
        }
    }
    
    // Clean up temp file
    let _ = std::fs::remove_file(&temp_file);
    
    match output_result {
        Some(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{}\n{}", stderr, stdout);
            
            // Parse syntax errors from output
            // Format: File "...", line N
            //           ^
            // SyntaxError: message
            for line in combined.lines() {
                if let Some(caps) = parse_python_error(line) {
                    results.push(LintResult::new(path.to_string(), caps.0, caps.1, "error".to_string(), "PY_SYNTAX".to_string(), caps.2));
                }
            }
        }
        None => {
            eprintln!("[Linter] Python not available (tried python3, python, py)");
        }
    }
    
    results
}

fn parse_python_error(text: &str) -> Option<(u32, u32, String)> {
    // Try to find "line N" pattern
    if let Some(line_match) = text.find("line ") {
        let rest = &text[line_match + 5..];
        let line_num: u32 = rest
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .ok()?;
        
        // Look for SyntaxError message
        if text.contains("SyntaxError:") {
            let msg = text.split("SyntaxError:").nth(1)?.trim().to_string();
            return Some((line_num, 1, format!("SyntaxError: {}", msg)));
        }
        
        return Some((line_num, 1, "Syntax error".to_string()));
    }
    None
}

// ============================================================================
// Go Linting (via CLI)
// ============================================================================

/// Lint Go using gofmt -e (syntax check) or go build
pub fn lint_go(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(DEFAULT_LINT_TIMEOUT_MS);
    
    // Write content to temp file in a temp directory (Go needs proper file structure)
    let temp_dir = std::env::temp_dir().join(format!("atls_go_{}", std::process::id()));
    let _ = std::fs::create_dir_all(&temp_dir);
    // Use actual package name for the temp file so go build doesn't get confused
    let go_filename = extract_go_package_name(content).unwrap_or_else(|| "main".to_string());
    let temp_file = temp_dir.join(format!("{}.go", go_filename));
    
    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }
    
    // Try gofmt -e first (fast syntax check)
    let mut gofmt_cmd = Command::new("gofmt");
    gofmt_cmd.args(["-e", temp_file.to_str().unwrap_or("")]);
    let gofmt_output = run_lint_command(gofmt_cmd, timeout);
    
    let mut found_errors = false;
    
    if let Some(output) = gofmt_output {
        let stderr = String::from_utf8_lossy(&output.stderr);
        
        // Parse errors: filename:line:col: message
        for line in stderr.lines() {
            if line.contains(":") && (line.contains("expected") || line.contains("syntax") || line.contains("illegal")) {
                if let Some((line_num, col, msg)) = parse_colon_format(line) {
                    results.push(LintResult::new(path.to_string(), line_num, col, "error".to_string(), "GO_SYNTAX".to_string(), msg));
                    found_errors = true;
                }
            }
        }
    } else {
        eprintln!("[Linter] gofmt not available, trying go build");
    }
    
    // If gofmt didn't find errors, try go build for more thorough check
    if !found_errors {
        let mut go_cmd = Command::new("go");
        go_cmd.args(["build", "-o", get_null_device(), temp_file.to_str().unwrap_or("")])
            .current_dir(&temp_dir);
        let go_output = run_lint_command(go_cmd, timeout);
        
        if let Some(output) = go_output {
            let stderr = String::from_utf8_lossy(&output.stderr);
            
            for line in stderr.lines() {
                // Go build errors: ./main.go:line:col: message or main.go:line:col: message
                if let Some((line_num, col, msg)) = parse_colon_format(line) {
                    results.push(LintResult::new(path.to_string(), line_num, col, "error".to_string(), "GO_BUILD".to_string(), msg));
                }
            }
        } else if !found_errors {
            eprintln!("[Linter] go not available");
        }
    }
    
    // Clean up temp directory
    let _ = std::fs::remove_dir_all(&temp_dir);
    
    results
}

/// Extract the Go package name from source content (e.g. "package chi" -> "chi")
fn extract_go_package_name(content: &str) -> Option<String> {
    for line in content.lines().take(20) {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("package ") {
            let name = name.trim().trim_end_matches(';');
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

// ============================================================================
// Java Linting (via CLI)
// ============================================================================

/// Lint Java using javac
pub fn lint_java(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(COMPILER_LINT_TIMEOUT_MS);
    
    // Try to extract class name from content to match filename requirement
    let class_name = extract_java_class_name(content).unwrap_or_else(|| "TempClass".to_string());
    
    // Write content to temp file with correct class name
    let temp_dir = std::env::temp_dir().join(format!("atls_java_{}", std::process::id()));
    let _ = std::fs::create_dir_all(&temp_dir);
    let temp_file = temp_dir.join(format!("{}.java", class_name));
    
    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }
    
    let mut cmd = Command::new("javac");
    cmd.args([
        "-Xlint:all",
        "-d", temp_dir.to_str().unwrap_or(""),
        temp_file.to_str().unwrap_or("")
    ]).current_dir(&temp_dir);
    let output = run_lint_command(cmd, timeout);
    
    // Clean up temp directory
    let _ = std::fs::remove_dir_all(&temp_dir);
    
    match output {
        Some(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{}\n{}", stderr, stdout);
            
            // Parse errors: filename:line: error: message or filename:line: warning: message
            for line in combined.lines() {
                if let Some((line_num, severity, msg)) = parse_java_error(line) {
                    results.push(LintResult::new(path.to_string(), line_num, 1, severity, "JAVAC".to_string(), msg));
                }
            }
        }
        None => {
            eprintln!("[Linter] javac not available or timed out");
        }
    }
    
    results
}

/// Extract public class name from Java source
fn extract_java_class_name(content: &str) -> Option<String> {
    // Look for "public class ClassName" or "class ClassName"
    let re = regex::Regex::new(r"(?:public\s+)?class\s+(\w+)").ok()?;
    re.captures(content)?.get(1).map(|m| m.as_str().to_string())
}

fn parse_java_error(text: &str) -> Option<(u32, String, String)> {
    // Format: filename:line: error: message or filename:line: warning: message
    // Also handles: filename:line: message (without error/warning prefix)
    let re = regex::Regex::new(r":(\d+):\s*(?:(error|warning):\s*)?(.+)").ok()?;
    let caps = re.captures(text)?;
    
    let line: u32 = caps.get(1)?.as_str().parse().ok()?;
    let severity = caps.get(2)
        .map(|m| m.as_str().to_lowercase())
        .unwrap_or_else(|| "error".to_string());
    let message = caps.get(3)?.as_str().trim().to_string();
    
    // Skip pointer lines (just ^)
    if message.chars().all(|c| c == '^' || c.is_whitespace()) {
        return None;
    }
    
    Some((line, severity, message))
}

// ============================================================================
// Rust Linting (via CLI)
// ============================================================================

/// Detect Rust edition from the nearest Cargo.toml by walking up from the file path.
/// Returns "2021" by default if no Cargo.toml is found or edition is unspecified.
fn detect_rust_edition(file_path: &str, root_path: &str) -> String {
    let start = if Path::new(file_path).is_absolute() {
        Path::new(file_path).parent().map(|p| p.to_path_buf())
    } else {
        Path::new(root_path).join(file_path).parent().map(|p| p.to_path_buf())
    };

    let mut dir = match start {
        Some(d) => d,
        None => return "2021".to_string(),
    };

    // Walk up directory tree looking for Cargo.toml
    loop {
        let cargo_toml = dir.join("Cargo.toml");
        if cargo_toml.exists() {
            if let Ok(contents) = std::fs::read_to_string(&cargo_toml) {
                // Simple TOML parse: look for edition = "YYYY"
                for line in contents.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("edition") {
                        if let Some(val) = trimmed.split('=').nth(1) {
                            let edition = val.trim().trim_matches('"').trim_matches('\'').trim();
                            if !edition.is_empty() {
                                return edition.to_string();
                            }
                        }
                    }
                }
            }
            // Cargo.toml found but no edition specified — default to 2021
            return "2021".to_string();
        }

        if !dir.pop() {
            break;
        }
    }

    "2021".to_string()
}

/// Lint Rust using rustc with proper edition detection
pub fn lint_rust(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(DEFAULT_LINT_TIMEOUT_MS);
    
    // Detect Rust edition from Cargo.toml
    let edition = detect_rust_edition(path, &options.root_path);
    
    // Write content to temp file
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("atls_lint_{}.rs", std::process::id()));
    
    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }
    
    let mut cmd = Command::new("rustc");
    cmd.args([
        "--edition", &edition,
        "--error-format=short",
        "--emit=metadata",
        "-o", get_null_device(),
        temp_file.to_str().unwrap_or("")
    ]);
    let output = run_lint_command(cmd, timeout);
    
    // Clean up temp file
    let _ = std::fs::remove_file(&temp_file);
    
    match output {
        Some(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            
            // Parse errors: filename:line:col: error[EXXXX]: message
            for line in stderr.lines() {
                if let Some((line_num, col, severity, code, msg)) = parse_rust_error(line) {
                    results.push(LintResult::new(path.to_string(), line_num, col, severity, code, msg));
                }
            }
        }
        None => {
            eprintln!("[Linter] rustc not available or timed out");
        }
    }
    
    results
}

fn parse_rust_error(text: &str) -> Option<(u32, u32, String, String, String)> {
    // Format: filename:line:col: error[E0XXX]: message
    let re = regex::Regex::new(r":(\d+):(\d+):\s*(error|warning)(?:\[([^\]]+)\])?:\s*(.+)").ok()?;
    let caps = re.captures(text)?;
    
    let line: u32 = caps.get(1)?.as_str().parse().ok()?;
    let col: u32 = caps.get(2)?.as_str().parse().ok()?;
    let severity = caps.get(3)?.as_str().to_lowercase();
    let code = caps.get(4).map(|m| m.as_str().to_string()).unwrap_or_else(|| "RUSTC".to_string());
    let message = caps.get(5)?.as_str().to_string();
    
    Some((line, col, severity, code, message))
}

// ============================================================================
// C# Linting (via CLI)
// ============================================================================

/// Find csc.exe on Windows (search in .NET Framework paths)
#[cfg(windows)]
fn find_csc() -> Option<String> {
    // Common .NET Framework paths on Windows
    let framework_paths = [
        r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe",
        r"C:\Windows\Microsoft.NET\Framework64\v3.5\csc.exe",
        r"C:\Windows\Microsoft.NET\Framework\v3.5\csc.exe",
    ];
    
    for path in framework_paths {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    
    // Try PATH
    if Command::new("csc").arg("-help").output().is_ok() {
        return Some("csc".to_string());
    }
    
    None
}

#[cfg(not(windows))]
fn find_csc() -> Option<String> {
    // On Unix, try mcs (Mono) or csc in PATH
    if Command::new("csc").arg("-help").output().is_ok() {
        return Some("csc".to_string());
    }
    if Command::new("mcs").arg("-help").output().is_ok() {
        return Some("mcs".to_string());
    }
    None
}

/// Lint C# using csc, mcs, or dotnet build
pub fn lint_csharp(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(COMPILER_LINT_TIMEOUT_MS);
    
    // Write content to temp file
    let temp_dir = std::env::temp_dir().join(format!("atls_csharp_{}", std::process::id()));
    let _ = std::fs::create_dir_all(&temp_dir);
    let temp_file = temp_dir.join("Program.cs");
    
    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }
    
    let mut found_compiler = false;
    
    // Try to find and use csc
    if let Some(csc_path) = find_csc() {
        found_compiler = true;
        let mut cmd = Command::new(&csc_path);
        cmd.args([
            "-t:library",
            "-nologo",
            "-out:temp.dll",
            temp_file.to_str().unwrap_or("")
        ]).current_dir(&temp_dir);
        let output = run_lint_command(cmd, timeout);
        
        if let Some(output) = output {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{}\n{}", stdout, stderr);
            
            for line in combined.lines() {
                if let Some((line_num, col, severity, code, msg)) = parse_csharp_error(line) {
                    results.push(LintResult::new(path.to_string(), line_num, col, severity, code, msg));
                }
            }
        }
    }
    
    // If no csc found or no errors detected, try dotnet build
    if !found_compiler || results.is_empty() {
        // Create minimal .csproj for dotnet build
        let csproj_content = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net6.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#;
        let csproj_file = temp_dir.join("temp.csproj");
        let _ = std::fs::write(&csproj_file, csproj_content);
        
        let mut dotnet_cmd = Command::new("dotnet");
        dotnet_cmd.args(["build", "--nologo", "-v", "q"])
            .current_dir(&temp_dir);
        let output = run_lint_command(dotnet_cmd, timeout);
        
        if let Some(output) = output {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{}\n{}", stdout, stderr);
            
            for line in combined.lines() {
                if let Some((line_num, col, severity, code, msg)) = parse_csharp_error(line) {
                    results.push(LintResult::new(path.to_string(), line_num, col, severity, code, msg));
                }
            }
        } else {
            if !found_compiler {
                eprintln!("[Linter] No C# compiler available (csc, mcs, or dotnet)");
            }
        }
    }
    
    // Clean up temp directory
    let _ = std::fs::remove_dir_all(&temp_dir);
    
    results
}

fn parse_csharp_error(text: &str) -> Option<(u32, u32, String, String, String)> {
    // Format 1: filename(line,col): error CSxxxx: message
    let re1 = regex::Regex::new(r"\((\d+),(\d+)\):\s*(error|warning)\s+(CS\d+):\s*(.+)").ok()?;
    if let Some(caps) = re1.captures(text) {
        let line: u32 = caps.get(1)?.as_str().parse().ok()?;
        let col: u32 = caps.get(2)?.as_str().parse().ok()?;
        let severity = caps.get(3)?.as_str().to_lowercase();
        let code = caps.get(4)?.as_str().to_string();
        let message = caps.get(5)?.as_str().to_string();
        return Some((line, col, severity, code, message));
    }
    
    // Format 2: filename(line,col): error: message (without CS code)
    let re2 = regex::Regex::new(r"\((\d+),(\d+)\):\s*(error|warning):\s*(.+)").ok()?;
    if let Some(caps) = re2.captures(text) {
        let line: u32 = caps.get(1)?.as_str().parse().ok()?;
        let col: u32 = caps.get(2)?.as_str().parse().ok()?;
        let severity = caps.get(3)?.as_str().to_lowercase();
        let message = caps.get(4)?.as_str().to_string();
        return Some((line, col, severity, "CSC".to_string(), message));
    }
    
    None
}

// ============================================================================
// PHP Linting (via CLI)
// ============================================================================

/// Lint PHP using php -l
pub fn lint_php(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(DEFAULT_LINT_TIMEOUT_MS);
    
    // Write content to temp file
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("atls_lint_{}.php", std::process::id()));
    
    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }
    
    let mut cmd = Command::new("php");
    cmd.args(["-l", temp_file.to_str().unwrap_or("")]);
    let output = run_lint_command(cmd, timeout);
    
    // Clean up temp file
    let _ = std::fs::remove_file(&temp_file);
    
    match output {
        Some(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{}\n{}", stdout, stderr);
            
            // Parse all PHP errors from output
            for error in parse_php_errors(&combined) {
                results.push(LintResult::new(path.to_string(), error.0, 1, error.1, "PHP_SYNTAX".to_string(), error.2));
            }
        }
        None => {
            eprintln!("[Linter] php not available or timed out");
        }
    }
    
    results
}

fn parse_php_errors(text: &str) -> Vec<(u32, String, String)> {
    let mut errors = Vec::new();
    
    // Format 1: PHP Parse error: message in filename on line N
    let re1 = regex::Regex::new(r"PHP\s+(?:(Parse|Fatal|Warning)\s+)?(error|warning):\s*(.+?)\s+in\s+.+?\s+on line\s+(\d+)").ok();
    
    if let Some(re) = re1 {
        for caps in re.captures_iter(text) {
            if let (Some(severity_match), Some(msg), Some(line_match)) = 
                (caps.get(2), caps.get(3), caps.get(4)) 
            {
                if let Ok(line) = line_match.as_str().parse::<u32>() {
                    let severity = severity_match.as_str().to_lowercase();
                    errors.push((line, severity, msg.as_str().to_string()));
                }
            }
        }
    }
    
    // Format 2: Simple "on line N" detection
    if errors.is_empty() {
        let re2 = regex::Regex::new(r"on line\s+(\d+)").ok();
        if let Some(re) = re2 {
            if let Some(caps) = re.captures(text) {
                if let Some(line_match) = caps.get(1) {
                    if let Ok(line) = line_match.as_str().parse::<u32>() {
                        // Extract message from the line
                        let msg = text.lines()
                            .find(|l| l.contains("error") || l.contains("Error"))
                            .unwrap_or("Syntax error")
                            .to_string();
                        errors.push((line, "error".to_string(), msg));
                    }
                }
            }
        }
    }
    
    errors
}

// ============================================================================
// Ruby Linting (via CLI)
// ============================================================================

/// Lint Ruby using ruby -c
pub fn lint_ruby(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(DEFAULT_LINT_TIMEOUT_MS);

    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("atls_lint_{}.rb", std::process::id()));

    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }

    let mut cmd = Command::new("ruby");
    cmd.args(["-c", temp_file.to_str().unwrap_or("")]);
    let output = run_lint_command(cmd, timeout);

    let _ = std::fs::remove_file(&temp_file);

    match output {
        Some(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{}\n{}", stderr, stdout);

            for error in parse_ruby_errors(&combined) {
                results.push(LintResult::new(
                    path.to_string(),
                    error.0,
                    error.1,
                    error.2,
                    "RUBY_SYNTAX".to_string(),
                    error.3,
                ));
            }
        }
        None => {
            eprintln!("[Linter] ruby not available or timed out");
        }
    }

    results
}

fn parse_ruby_errors(text: &str) -> Vec<(u32, u32, String, String)> {
    let mut errors = Vec::new();
    // Format: filename:line: message  or  -:line: message
    let re = regex::Regex::new(r"[-.\w\\/]+:(\d+):\s*(.+)").ok();
    if let Some(re) = re {
        for line in text.lines() {
            if let Some(caps) = re.captures(line) {
                if let (Some(line_match), Some(msg_match)) = (caps.get(1), caps.get(2)) {
                    if let Ok(line_num) = line_match.as_str().parse::<u32>() {
                        let msg = msg_match.as_str().trim().to_string();
                        if msg.contains("syntax error") || msg.contains("SyntaxError") {
                            errors.push((line_num, 1, "error".to_string(), msg));
                        }
                    }
                }
            }
        }
    }
    errors
}

// ============================================================================
// Swift Linting (via CLI)
// ============================================================================

/// Lint Swift using swiftc -parse or swift -parse
pub fn lint_swift(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(DEFAULT_LINT_TIMEOUT_MS);
    
    // Write content to temp file
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("atls_lint_{}.swift", std::process::id()));
    
    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }
    
    // Try swiftc first (faster, parse-only mode)
    let mut swiftc_cmd = Command::new("swiftc");
    swiftc_cmd.args(["-parse", temp_file.to_str().unwrap_or("")]);
    let output = match run_lint_command(swiftc_cmd, timeout) {
        Some(output) => Some(output),
        None => {
            // Try swift command as fallback
            let mut swift_cmd = Command::new("swift");
            swift_cmd.args(["-parse", temp_file.to_str().unwrap_or("")]);
            run_lint_command(swift_cmd, timeout)
        }
    };
    
    // Clean up temp file
    let _ = std::fs::remove_file(&temp_file);
    
    match output {
        Some(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{}\n{}", stderr, stdout);
            
            // Parse errors: filename:line:col: error: message
            for line in combined.lines() {
                if let Some((line_num, col, severity, msg)) = parse_swift_error(line) {
                    results.push(LintResult::new(path.to_string(), line_num, col, severity, "SWIFT".to_string(), msg));
                }
            }
        }
        None => {
            eprintln!("[Linter] Swift compiler (swiftc) not available");
        }
    }
    
    results
}

fn parse_swift_error(text: &str) -> Option<(u32, u32, String, String)> {
    // Format: filename:line:col: error: message or warning: message
    let re = regex::Regex::new(r":(\d+):(\d+):\s*(error|warning|note):\s*(.+)").ok()?;
    let caps = re.captures(text)?;
    
    let severity_str = caps.get(3)?.as_str();
    if severity_str == "note" {
        return None; // Skip notes
    }
    
    let line: u32 = caps.get(1)?.as_str().parse().ok()?;
    let col: u32 = caps.get(2)?.as_str().parse().ok()?;
    let severity = severity_str.to_lowercase();
    let message = caps.get(4)?.as_str().to_string();
    
    Some((line, col, severity, message))
}

// ============================================================================
// Kotlin Linting (via CLI)
// ============================================================================

/// Lint Kotlin using kotlinc
pub fn lint_kotlin(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(DEFAULT_LINT_TIMEOUT_MS);

    let temp_dir = std::env::temp_dir();
    let is_script = path.ends_with(".kts");
    let temp_ext = if is_script { "kts" } else { "kt" };
    let temp_file = temp_dir.join(format!("atls_lint_{}.{}", std::process::id(), temp_ext));

    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }

    let out_dir = if is_script {
        None
    } else {
        Some(temp_dir.join(format!("atls_kotlin_out_{}", std::process::id())))
    };
    let mut cmd = Command::new("kotlinc");
    if is_script {
        cmd.args(["-script", temp_file.to_str().unwrap_or("")]);
    } else if let Some(ref d) = out_dir {
        let _ = std::fs::create_dir_all(d);
        cmd.args(["-d", d.to_str().unwrap_or(""), temp_file.to_str().unwrap_or("")]);
    }
    let output = run_lint_command(cmd, timeout);

    let _ = std::fs::remove_file(&temp_file);
    if let Some(d) = out_dir {
        let _ = std::fs::remove_dir_all(d);
    }

    match output {
        Some(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{}\n{}", stderr, stdout);
            for error in parse_kotlin_errors(&combined) {
                results.push(LintResult::new(
                    path.to_string(),
                    error.0,
                    error.1,
                    error.2,
                    "KOTLIN".to_string(),
                    error.3,
                ));
            }
        }
        None => {
            eprintln!("[Linter] kotlinc not available or timed out");
        }
    }

    results
}

fn parse_kotlin_errors(text: &str) -> Vec<(u32, u32, String, String)> {
    let mut errors = Vec::new();
    // Format: path:line:column: error: message or e: path:line:column: message
    let re = regex::Regex::new(r"(?:e:\s+)?[^:]+:(\d+):(\d+):\s*(?:(error|warning):\s*)?(.+)").ok();
    if let Some(re) = re {
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Some(caps) = re.captures(line) {
                if let (Some(line_num), Some(col)) = (
                    caps.get(1).and_then(|m| m.as_str().parse::<u32>().ok()),
                    caps.get(2).and_then(|m| m.as_str().parse::<u32>().ok()),
                ) {
                    let severity = caps
                        .get(3)
                        .map(|m| m.as_str().to_lowercase())
                        .unwrap_or_else(|| "error".to_string());
                    let msg = caps.get(4).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
                    if !msg.is_empty() {
                        errors.push((line_num, col, severity, msg));
                    }
                }
            }
        }
    }
    errors
}

// ============================================================================
// Dart Linting (via CLI)
// ============================================================================

/// Lint Dart using dart analyze
pub fn lint_dart(path: &str, content: &str, options: &LintOptions) -> Vec<LintResult> {
    let mut results = Vec::new();
    let timeout = options.timeout_ms.unwrap_or(DEFAULT_LINT_TIMEOUT_MS);

    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("atls_lint_{}.dart", std::process::id()));

    if let Err(e) = std::fs::write(&temp_file, content) {
        eprintln!("[Linter] Failed to write temp file: {}", e);
        return results;
    }

    let mut cmd = Command::new("dart");
    cmd.args(["analyze", "--no-fatal-infos", "--no-fatal-warnings", temp_file.to_str().unwrap_or("")]);
    let output = run_lint_command(cmd, timeout);

    let _ = std::fs::remove_file(&temp_file);

    match output {
        Some(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{}\n{}", stderr, stdout);
            for error in parse_dart_errors(&combined) {
                results.push(LintResult::new(
                    path.to_string(),
                    error.0,
                    error.1,
                    error.2,
                    "DART".to_string(),
                    error.3,
                ));
            }
        }
        None => {
            eprintln!("[Linter] dart not available or timed out");
        }
    }

    results
}

fn parse_dart_errors(text: &str) -> Vec<(u32, u32, String, String)> {
    let mut errors = Vec::new();
    // Format: "  error • message at path:line:col" or "path:line:col: message"
    let re_at = regex::Regex::new(r"(?:error|warning|info)\s*•\s*(.+?)\s+at\s+[^:]+:(\d+):(\d+)").ok();
    let re_colon = regex::Regex::new(r"[^:]+:(\d+):(\d+):\s*(.+)").ok();
    if let Some(re) = re_at {
        for line in text.lines() {
            if let Some(caps) = re.captures(line) {
                let msg = caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
                if let (Some(line_num), Some(col)) = (
                    caps.get(2).and_then(|m| m.as_str().parse::<u32>().ok()),
                    caps.get(3).and_then(|m| m.as_str().parse::<u32>().ok()),
                ) {
                    let severity = if line.contains("error") { "error" } else { "warning" };
                    errors.push((line_num, col, severity.to_string(), msg));
                }
            }
        }
    }
    if errors.is_empty() {
        if let Some(re) = re_colon {
            for line in text.lines() {
                if line.contains("Error") || line.contains("error") {
                    if let Some(caps) = re.captures(line) {
                        if let (Some(line_num), Some(col)) = (
                            caps.get(1).and_then(|m| m.as_str().parse::<u32>().ok()),
                            caps.get(2).and_then(|m| m.as_str().parse::<u32>().ok()),
                        ) {
                            let msg = caps.get(3).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
                            if !msg.is_empty() {
                                errors.push((line_num, col, "error".to_string(), msg));
                            }
                        }
                    }
                }
            }
        }
    }
    errors
}

// ============================================================================
// Utility Functions
// ============================================================================

/// Parse common colon-separated error format: filename:line:col: message
fn parse_colon_format(text: &str) -> Option<(u32, u32, String)> {
    // Format: something:line:col: message
    let re = regex::Regex::new(r":(\d+):(\d+):\s*(.+)").ok()?;
    let caps = re.captures(text)?;
    
    let line: u32 = caps.get(1)?.as_str().parse().ok()?;
    let col: u32 = caps.get(2)?.as_str().parse().ok()?;
    let message = caps.get(3)?.as_str().to_string();
    
    Some((line, col, message))
}

/// Check if a file can be linted based on extension
#[allow(dead_code)]
pub fn can_lint_file(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    matches!(ext.as_str(), 
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" |
        "py" | "pyw" |
        "go" |
        "java" |
        "rs" |
        "cs" |
        "php" |
        "swift" |
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" | "c" | "h" |
        "rb" | "rake" | "gemspec" |
        "scala" | "sc" |
        "kt" | "kts" |
        "dart"
    )
}

/// Get the language name from file extension
#[allow(dead_code)]
pub fn get_language(path: &str) -> Option<&'static str> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    match ext.as_str() {
        "ts" | "tsx" | "mts" | "cts" => Some("typescript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "py" | "pyw" => Some("python"),
        "go" => Some("go"),
        "java" => Some("java"),
        "rs" => Some("rust"),
        "cs" => Some("csharp"),
        "php" => Some("php"),
        "swift" => Some("swift"),
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => Some("cpp"),
        "c" | "h" => Some("c"),
        "rb" | "rake" | "gemspec" => Some("ruby"),
        "scala" | "sc" => Some("scala"),
        "kt" | "kts" => Some("kotlin"),
        "dart" => Some("dart"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_lint_typescript_syntax_error() {
        let content = r#"
const x: number = "hello";
function foo( {
    return 1;
}
"#;
        let options = LintOptions::default();
        let results = lint_typescript("test.ts", content, &options);
        
        // Should catch the missing closing paren
        assert!(!results.is_empty(), "Expected syntax errors but found none");
        assert_eq!(results[0].severity, "error");
        assert!(results[0].code.starts_with("TS"), "Expected TS error code");
    }
    
    #[test]
    fn test_lint_javascript_syntax_error() {
        let content = r#"
const x = "hello"
function foo( {
    return 1;
}
"#;
        let options = LintOptions::default();
        let results = lint_typescript("test.js", content, &options);
        
        // Should catch the missing closing paren
        assert!(!results.is_empty(), "Expected syntax errors but found none");
        assert_eq!(results[0].severity, "error");
        assert!(results[0].code.starts_with("JS"), "Expected JS error code");
    }
    
    #[test]
    fn test_lint_typescript_valid() {
        let content = "const x: number = 42;\nfunction foo(): number {\n    return x + 1;\n}\n";
        let temp = std::env::temp_dir().join(format!("atls_lint_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp);
        let options = LintOptions {
            root_path: temp.to_string_lossy().to_string(),
            ..Default::default()
        };
        let results = lint_typescript("test.ts", content, &options);
        let _ = std::fs::remove_dir_all(&temp);
        // Should have no syntax errors
        assert!(results.is_empty(), "Expected no errors but found: {:?}", results);
    }
    
    #[test]
    fn test_lint_javascript_valid() {
        let content = r#"
const x = 42;
function foo() {
    return x + 1;
}
"#;
        let options = LintOptions::default();
        let results = lint_typescript("test.js", content, &options);
        
        // Should have no syntax errors
        assert!(results.is_empty(), "Expected no errors but found: {:?}", results);
    }
    
    #[test]
    fn test_create_lint_summary() {
        let results = vec![
            LintResult::new("a.ts".to_string(), 1, 1, "error".to_string(), "E1".to_string(), "Error 1".to_string()),
            LintResult::new("a.ts".to_string(), 2, 1, "warning".to_string(), "W1".to_string(), "Warning 1".to_string()),
            LintResult::new("b.ts".to_string(), 1, 1, "error".to_string(), "E2".to_string(), "Error 2".to_string()),
        ];
        
        let summary = create_lint_summary(&results);
        
        assert_eq!(summary.total, 3);
        assert_eq!(summary.files_with_issues, 2);
        assert_eq!(summary.by_severity.get("error"), Some(&2));
        assert_eq!(summary.by_severity.get("warning"), Some(&1));
    }
    
    #[test]
    fn test_can_lint_file() {
        assert!(can_lint_file("test.ts"));
        assert!(can_lint_file("test.tsx"));
        assert!(can_lint_file("test.js"));
        assert!(can_lint_file("test.jsx"));
        assert!(can_lint_file("test.mjs"));
        assert!(can_lint_file("test.cjs"));
        assert!(can_lint_file("test.py"));
        assert!(can_lint_file("test.go"));
        assert!(can_lint_file("test.java"));
        assert!(can_lint_file("test.rs"));
        assert!(can_lint_file("test.cs"));
        assert!(can_lint_file("test.php"));
        assert!(can_lint_file("test.swift"));
        assert!(can_lint_file("test.c"));
        assert!(can_lint_file("test.cpp"));
        assert!(can_lint_file("test.rb"));
        assert!(can_lint_file("test.scala"));
        assert!(can_lint_file("test.kt"));
        assert!(can_lint_file("test.dart"));
        assert!(!can_lint_file("test.txt"));
        assert!(!can_lint_file("test.md"));
    }
    
    #[test]
    fn test_language_detection() {
        assert_eq!(get_language("test.ts"), Some("typescript"));
        assert_eq!(get_language("test.tsx"), Some("typescript"));
        assert_eq!(get_language("test.js"), Some("javascript"));
        assert_eq!(get_language("test.jsx"), Some("javascript"));
        assert_eq!(get_language("test.py"), Some("python"));
        assert_eq!(get_language("test.go"), Some("go"));
        assert_eq!(get_language("test.java"), Some("java"));
        assert_eq!(get_language("test.rs"), Some("rust"));
        assert_eq!(get_language("test.cs"), Some("csharp"));
        assert_eq!(get_language("test.php"), Some("php"));
        assert_eq!(get_language("test.swift"), Some("swift"));
        assert_eq!(get_language("test.scala"), Some("scala"));
        assert_eq!(get_language("test.kt"), Some("kotlin"));
        assert_eq!(get_language("test.dart"), Some("dart"));
        assert_eq!(get_language("test.txt"), None);
    }
}
