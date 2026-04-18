use crate::query::{QueryEngine, QueryError};
use crate::{FileInfo, Language};
use std::collections::HashSet;
use std::path::PathBuf;

/// Database statistics for context_stats operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DatabaseStats {
    pub file_count: usize,
    pub symbol_count: usize,
    pub issue_count: usize,
    pub relation_count: usize,
    pub signature_count: usize,
    pub call_count: usize,
    pub last_indexed: Option<String>,
    pub db_size_bytes: Option<u64>,
}

/// Module context information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModuleContext {
    pub main_file: String,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub test_files: Vec<String>,
    pub related_files: Vec<String>,
    /// Set when a directory path was auto-resolved to its entry file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_from_directory: Option<String>,
}

/// Component context (for React/UI components)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ComponentContext {
    pub component: String,
    pub test_files: Vec<String>,
    pub style_files: Vec<String>,
    pub related_components: Vec<String>,
}

fn is_false(v: &bool) -> bool { !v }

/// Smart context result for AI
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SmartContextResult {
    pub file: String,
    pub symbols: Vec<SymbolContext>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub symbols_capped: bool,
    pub imports: Vec<String>,
    pub related_files: Vec<FileContext>,
    pub issues: Vec<IssueContext>,
}

/// Symbol context information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymbolContext {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub signature: Option<String>,
}

/// File context information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileContext {
    pub path: String,
    pub language: String,
    pub relation: String,
}

/// Issue context information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IssueContext {
    pub pattern_id: String,
    pub message: String,
    pub line: u32,
    pub severity: String,
}

/// Pure scan: find module-level call statements in `source` past `after_line`.
///
/// A "module-level call" is a line that starts at column 0 (no leading
/// whitespace) with `<identifier>(` or `export const <ident> = (() =>`-style
/// IIFE patterns. These aren't stored in the `symbols` table because they
/// are expression statements, not declarations — yet they often carry the
/// most load-bearing wiring in a module (self-registration, plugin install,
/// side-effect imports).
///
/// The scan is intentionally language-agnostic and syntax-naive: it runs on
/// raw text and handles JS/TS/Rust/Python call-statement shapes uniformly.
/// False positives on rare grammar corners are acceptable — the agent sees
/// `kind: "module_init"` and can read the line if it cares.
///
/// Returns `(line, identifier)` pairs, capped at `MAX_MODULE_INIT_ENTRIES`.
pub fn scan_module_init_calls(source: &str, after_line: u32) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    for (idx, raw) in source.lines().enumerate() {
        let line_num = (idx as u32) + 1;
        if line_num <= after_line {
            continue;
        }
        if out.len() >= MAX_MODULE_INIT_ENTRIES {
            break;
        }
        // Must start at column 0 (no indent = module scope in brace/indent languages).
        if raw.is_empty() || raw.starts_with(' ') || raw.starts_with('\t') {
            continue;
        }
        if let Some(ident) = extract_module_init_identifier(raw) {
            out.push((line_num, ident));
        }
    }
    out
}

/// Extract the identifier that begins a module-init call on a raw source line.
///
/// Recognized shapes (identifier returned in parentheses):
///   `registerFoo(` → `registerFoo`
///   `export const __x: bool = (() => { ... registerFoo(...)` → no match here;
///     the outer `export const` is a declaration, so it's in the symbols table
///   `installPlugin(app, opts);` → `installPlugin`
///
/// Returns `None` for anything that is not a bare call-statement.
fn extract_module_init_identifier(line: &str) -> Option<String> {
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    // Reject lines that look like declarations — these already appear as
    // real symbols in the index.
    const DECL_PREFIXES: &[&str] = &[
        "export ", "import ", "const ", "let ", "var ", "fn ", "pub ",
        "function ", "class ", "interface ", "type ", "struct ", "enum ",
        "impl ", "mod ", "trait ", "async ", "static ", "def ",
        "//", "/*", "*", "#", "--",
    ];
    for p in DECL_PREFIXES {
        if trimmed.starts_with(p) {
            return None;
        }
    }

    // Accept: first token is a plain identifier (possibly qualified with `.`)
    // and the next non-identifier char is `(`.
    let mut end = 0;
    let bytes = trimmed.as_bytes();
    while end < bytes.len() {
        let c = bytes[end];
        let is_ident = (c.is_ascii_alphanumeric()) || c == b'_' || c == b'$' || c == b'.';
        if !is_ident {
            break;
        }
        end += 1;
    }
    if end == 0 {
        return None;
    }
    if end >= bytes.len() || bytes[end] != b'(' {
        return None;
    }
    let ident = &trimmed[..end];
    // Reject obvious control-flow / operator shapes.
    if matches!(ident, "if" | "while" | "for" | "switch" | "match" | "return" | "await") {
        return None;
    }
    Some(ident.to_string())
}

/// Append synthetic `module_init` symbol entries to a `SmartContextResult`.
///
/// Used by the MCP `context` handler after fetching the declaration-level
/// symbols from the index, to also surface trailing module-level call
/// statements that would otherwise be invisible in `smart`/`sig` views.
/// Idempotent: safe to call with empty `source`, which is a no-op.
pub fn append_module_init_symbols(result: &mut SmartContextResult, source: &str) {
    if source.is_empty() {
        return;
    }
    let last_symbol_line = result
        .symbols
        .iter()
        .map(|s| s.line)
        .max()
        .unwrap_or(0);
    let inits = scan_module_init_calls(source, last_symbol_line);
    for (line, ident) in inits {
        result.symbols.push(SymbolContext {
            name: ident.clone(),
            kind: "module_init".to_string(),
            line,
            signature: Some(format!("{}(...)  [module init]", ident)),
        });
    }
}

const MAX_CONTEXT_DEPTH: u32 = 8;
const DEFAULT_CONTEXT_DEPTH: u32 = 3;
const MAX_RELATED_FILES_LIMIT: usize = 100;
const MAX_TOTAL_IMPORTS: usize = 1000;
const MAX_IMPORTS_PER_LEVEL: i64 = 200;
const DEFAULT_MODULE_DEPTH: u32 = 5;

/// Max module-init entries surfaced per file in smart context.
///
/// Trailing module-level call statements (IIFEs, self-registrations, plugin
/// installs) are emitted as synthetic `SymbolContext` entries with kind
/// `module_init` so `rs shape:sig` and `rc type:smart` surface them alongside
/// real declarations. Without this, bare module-level calls at the tail of a
/// file are invisible to the shape view — that was the original cause of the
/// "UNWIRED" false-negative during the compression A/B investigation.
const MAX_MODULE_INIT_ENTRIES: usize = 8;

/// True when a file is essentially a re-export scaffold — every non-comment
/// line is `pub use`, `mod`, `pub mod`, `use`, `export { … } from …`,
/// `export *`, or similar. These files accumulate high import counts in the
/// importance scorer but hold no logic, crowding out real modules when
/// ranking siblings / entry points. Used as a cheap content-level predicate
/// when a symbol-table check is not available.
pub fn is_reexport_only_module(content: &str) -> bool {
    let mut saw_reexport = false;
    let mut in_block_comment = false;
    for raw in content.lines() {
        let mut line = raw.trim();
        if line.is_empty() { continue; }
        // Strip trailing `// …` line comments so `pub use X; // note` still passes.
        if let Some(pos) = line.find("//") {
            line = line[..pos].trim_end();
            if line.is_empty() { continue; }
        }
        if in_block_comment {
            if line.contains("*/") { in_block_comment = false; }
            continue;
        }
        if line.starts_with("/*") {
            if !line.contains("*/") { in_block_comment = true; }
            continue;
        }
        if line.starts_with("///") || line.starts_with("//!") || line.starts_with('#') {
            // Doc comments and preprocessor-ish directives — ignore.
            continue;
        }
        // Absorb attributes like `#[path = "…"]` that precede `mod` declarations.
        if line.starts_with("#[") || line.starts_with("#![") { continue; }

        let is_reexport_like = line.starts_with("pub use ")
            || line.starts_with("pub(crate) use ")
            || line.starts_with("pub(super) use ")
            || line.starts_with("use ")
            || line.starts_with("pub mod ")
            || line.starts_with("pub(crate) mod ")
            || line.starts_with("pub(super) mod ")
            || line.starts_with("mod ")
            || line.starts_with("export * ")
            || line.starts_with("export *;")
            || line.starts_with("export {")
            || line.starts_with("export type {")
            || (line.starts_with("export ") && line.contains(" from "))
            || line == "};"
            || line == "}";
        if !is_reexport_like {
            return false;
        }
        saw_reexport = true;
    }
    saw_reexport
}

impl QueryEngine {
    /// Get module context (file + imports + exports + tests + related)
    pub fn get_module_context(
        &self,
        file_path: &str,
        depth: u32,
    ) -> Result<ModuleContext, QueryError> {
        let conn = self.db.conn();
        // Strip Windows extended-length path prefix (\\?\) and normalize slashes
        let clean_path = file_path.strip_prefix(r"\\?\").unwrap_or(file_path);
        let normalized_path = clean_path.replace('\\', "/");

        // Auto-resolve directories to their canonical entry file
        let dir_resolved: Option<String>;
        let normalized_path = {
            let p = std::path::Path::new(&normalized_path);
            let looks_like_dir = p.extension().is_none()
                || normalized_path.ends_with('/');
            if looks_like_dir {
                let base = normalized_path.trim_end_matches('/');
                let candidates = [
                    "index.ts", "index.tsx", "index.js", "index.mjs",
                    "mod.rs", "lib.rs",
                    "__init__.py",
                    "main.go",
                ];
                let found = candidates.iter().find_map(|c| {
                    let candidate = format!("{}/{}", base, c);
                    let exists: bool = conn.query_row(
                        "SELECT COUNT(*) FROM files WHERE path = ? OR path LIKE ?",
                        rusqlite::params![&candidate, format!("%/{}", candidate)],
                        |row| row.get::<_, i64>(0),
                    ).unwrap_or(0) > 0;
                    if exists { Some(candidate) } else { None }
                });
                if let Some(ref resolved) = found {
                    dir_resolved = Some(normalized_path.clone());
                    resolved.clone()
                } else {
                    dir_resolved = None;
                    normalized_path
                }
            } else {
                dir_resolved = None;
                normalized_path
            }
        };

        let file = crate::db::queries::Queries::get_file_by_path(&*conn, &PathBuf::from(&normalized_path))?;
        
        // Fallback: if exact match fails, try LIKE suffix match on the filename
        let file = match file {
            Some(f) => Some(f),
            None => {
                let like_pattern = format!("%/{}", normalized_path.split('/').last().unwrap_or(&normalized_path));
                let mut fallback_stmt = conn.prepare(
                    "SELECT id, path, hash, language, last_indexed, line_count FROM files WHERE path LIKE ? LIMIT 5"
                )?;
                let mut candidates: Vec<FileInfo> = fallback_stmt.query_map(
                    rusqlite::params![like_pattern],
                    |row| {
                        Ok(FileInfo {
                            id: row.get(0)?,
                            path: PathBuf::from(row.get::<_, String>(1)?),
                            hash: row.get(2)?,
                            language: Language::from_str(&row.get::<_, String>(3)?),
                            last_indexed: {
                                let dt_str = row.get::<_, String>(4)?;
                                chrono::NaiveDateTime::parse_from_str(&dt_str, "%Y-%m-%d %H:%M:%S")
                                    .map(|dt| chrono::DateTime::from_naive_utc_and_offset(dt, chrono::Utc))
                                    .or_else(|_| chrono::DateTime::parse_from_rfc3339(&dt_str)
                                        .map(|dt| dt.with_timezone(&chrono::Utc)))
                                    .unwrap_or_else(|_| chrono::Utc::now())
                            },
                            line_count: row.get(5)?,
                        })
                    }
                )?.filter_map(|r| r.ok()).collect();
                // Prefer the candidate whose path most closely matches the input
                candidates.sort_by_key(|f| {
                    let fp = f.path.to_string_lossy().replace('\\', "/");
                    if fp == normalized_path { 0 }
                    else if fp.ends_with(&normalized_path) { 1 }
                    else { 2 + fp.len() }
                });
                candidates.into_iter().next()
            }
        };
        
        let (file_id, main_file) = match file {
            Some(f) => (f.id, normalized_path),
            None => {
                return Ok(ModuleContext {
                    main_file: normalized_path,
                    imports: Vec::new(),
                    exports: Vec::new(),
                    test_files: Vec::new(),
                    related_files: Vec::new(),
                    resolved_from_directory: dir_resolved,
                });
            }
        };

        let max_depth = depth.min(DEFAULT_MODULE_DEPTH).max(1);
        let mut visited = HashSet::new();
        let mut imports = Vec::new();

        // Recursively collect imports (bounded by depth, fan-out, and total cap)
        self.collect_imports(&*conn, file_id, 1, max_depth, &mut visited, &mut imports)?;

        // Get exports (files that import this file), bounded
        let mut exports_stmt = conn.prepare(
            "SELECT DISTINCT f.path
             FROM file_relations fr
             JOIN files f ON fr.from_file_id = f.id
             WHERE fr.to_file_id = ? AND fr.type = 'IMPORTS'
             LIMIT ?"
        )?;

        let exports_rows = exports_stmt.query_map(rusqlite::params![file_id, MAX_IMPORTS_PER_LEVEL], |row| {
            Ok(row.get::<_, String>(0)?)
        })?;

        let mut exports = Vec::new();
        for row in exports_rows {
            exports.push(row?);
        }

        // Fallback: if both imports/exports are empty, populate from symbols table
        if imports.is_empty() && exports.is_empty() {
            // Get exported symbols (public/exported functions, classes, types)
            let mut sym_stmt = conn.prepare(
                "SELECT name, kind, signature FROM symbols WHERE file_id = ? ORDER BY line LIMIT 50"
            )?;
            let sym_rows = sym_stmt.query_map(rusqlite::params![file_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            for row in sym_rows {
                if let Ok((name, kind, sig)) = row {
                    let label = if let Some(s) = sig {
                        format!("{} ({})", s.chars().take(100).collect::<String>(), kind)
                    } else {
                        format!("{} ({})", name, kind)
                    };
                    exports.push(label);
                }
            }

            // Get imports by reading the file and scanning for import statements.
            // This is the fallback when file_relations are empty (import resolution failed).
            let file_path_str: Option<String> = conn.query_row(
                "SELECT path FROM files WHERE id = ?",
                rusqlite::params![file_id],
                |row| row.get::<_, String>(0),
            ).ok();
            if let Some(ref fp) = file_path_str {
                // Try the path as-is (may be absolute or relative from CWD)
                let content = std::fs::read_to_string(fp)
                    .or_else(|_| std::fs::read_to_string(&PathBuf::from(fp)));
                if let Ok(content) = content {
                    for line in content.lines().take(150) {
                        let trimmed = line.trim();
                        // JS/TS: import ... from 'module'
                        if (trimmed.starts_with("import ") || trimmed.starts_with("import{")) && trimmed.contains("from ") {
                            if let Some(from_idx) = trimmed.rfind("from ") {
                                let module_part = &trimmed[from_idx + 5..];
                                let module = module_part.trim_matches(|c: char| c == '\'' || c == '"' || c == ';' || c == ' ');
                                if !module.is_empty() {
                                    imports.push(module.to_string());
                                }
                            }
                        }
                        // Python: from X import Y  /  import X
                        else if trimmed.starts_with("from ") && trimmed.contains(" import ") {
                            let parts: Vec<&str> = trimmed.splitn(3, ' ').collect();
                            if parts.len() >= 2 {
                                imports.push(parts[1].to_string());
                            }
                        }
                        // Rust: use crate::X
                        else if trimmed.starts_with("use ") {
                            let module = trimmed["use ".len()..].trim_end_matches(';').trim();
                            if !module.is_empty() {
                                imports.push(module.to_string());
                            }
                        }
                    }
                }
            }
        }

        // Find test files (pass conn to avoid re-locking the Mutex)
        let test_files = self.find_test_files(&*conn, &main_file)?;

        // Find related files (pass conn to avoid re-locking the Mutex)
        let related_files = self.find_related_files(&*conn, &main_file)?;

        Ok(ModuleContext {
            main_file: main_file.to_string(),
            imports,
            exports,
            test_files,
            related_files,
            resolved_from_directory: dir_resolved,
        })
    }

    /// Get component context (for React/UI components)
    pub fn get_component_context(
        &self,
        component_path: &str,
        depth: u32,
    ) -> Result<ComponentContext, QueryError> {
        let conn = self.db.conn();
        // Strip Windows extended-length path prefix (\\?\) and normalize slashes
        let clean_path = component_path.strip_prefix(r"\\?\").unwrap_or(component_path);
        let normalized_path = clean_path.replace('\\', "/");

        let file = crate::db::queries::Queries::get_file_by_path(&*conn, &PathBuf::from(&normalized_path))?;
        
        if file.is_none() {
            return Ok(ComponentContext {
                component: normalized_path,
                test_files: Vec::new(),
                style_files: Vec::new(),
                related_components: Vec::new(),
            });
        }

        let file_id = file.unwrap().id;
        let max_depth = depth.min(MAX_CONTEXT_DEPTH).max(1);

        // Find test files (pass conn to avoid re-locking the Mutex)
        let test_files = self.find_test_files(&*conn, &normalized_path)?;

        // Find style files (pass conn to avoid re-locking the Mutex)
        let style_files = self.find_style_files(&*conn, &normalized_path)?;

        // Find related components (pass conn to avoid re-locking the Mutex)
        let mut related_components = self.find_related_components(&*conn, &normalized_path)?;

        // If depth > 1, include components imported by this component
        if max_depth > 1 {
            let mut visited = HashSet::new();
            visited.insert(normalized_path.clone());
            self.collect_related_components(&*conn, file_id, DEFAULT_CONTEXT_DEPTH, max_depth, &mut visited, &mut related_components)?;
        }

        Ok(ComponentContext {
            component: normalized_path,
            test_files,
            style_files,
            related_components: related_components.into_iter().take(MAX_RELATED_FILES_LIMIT).collect(),
        })
    }

    /// Get smart context for AI (symbols + imports + related files + issues)
    pub fn get_smart_context(
        &self,
        file_path: &str,
    ) -> Result<SmartContextResult, QueryError> {
        let conn = self.db.conn();
        // Strip Windows extended-length path prefix (\\?\) and normalize slashes
        let clean_path = file_path.strip_prefix(r"\\?\").unwrap_or(file_path);
        let normalized_path = clean_path.replace('\\', "/");

        let file = crate::db::queries::Queries::get_file_by_path(&*conn, &PathBuf::from(&normalized_path))?;
        let file_id = match file {
            Some(f) => f.id,
            None => {
                return Ok(SmartContextResult {
                    file: normalized_path,
                    symbols: Vec::new(),
                    symbols_capped: false,
                    imports: Vec::new(),
                    related_files: Vec::new(),
                    issues: Vec::new(),
                });
            }
        };

        // Get symbols (capped to prevent token bloat on large files)
        const MAX_SYMBOLS: usize = 300;
        const MAX_SIGNATURE_LEN: usize = 240;
        let mut symbols_stmt = conn.prepare(
            "SELECT name, kind, line, signature FROM symbols WHERE file_id = ? ORDER BY line LIMIT ?"
        )?;

        let symbols_rows = symbols_stmt.query_map(rusqlite::params![file_id, MAX_SYMBOLS as i64 + 1], |row| {
            Ok(SymbolContext {
                name: row.get(0)?,
                kind: row.get(1)?,
                line: row.get(2)?,
                signature: row.get(3)?,
            })
        })?;

        let mut symbols: Vec<SymbolContext> = Vec::new();
        for row in symbols_rows {
            symbols.push(row?);
        }
        let symbols_capped = symbols.len() > MAX_SYMBOLS;
        symbols.truncate(MAX_SYMBOLS);
        for sym in &mut symbols {
            if let Some(ref mut sig) = sym.signature {
                if sig.len() > MAX_SIGNATURE_LEN {
                    sig.truncate(MAX_SIGNATURE_LEN);
                    sig.push_str("...");
                }
            }
        }

        // Get imports
        let mut imports_stmt = conn.prepare(
            "SELECT DISTINCT f.path
             FROM file_relations fr
             JOIN files f ON fr.to_file_id = f.id
             WHERE fr.from_file_id = ? AND fr.type = 'IMPORTS'"
        )?;

        let imports_rows = imports_stmt.query_map([file_id], |row| {
            Ok(row.get::<_, String>(0)?)
        })?;

        let mut imports = Vec::new();
        for row in imports_rows {
            imports.push(row?);
        }

        // Get related files: imports (outgoing) + reverse-imports (incoming) + directory siblings
        let mut related_files: Vec<FileContext> = Vec::new();
        let mut seen_paths: HashSet<String> = HashSet::new();

        // 1. Files this file imports (outgoing)
        for imp in &imports {
            if seen_paths.insert(imp.clone()) {
                related_files.push(FileContext {
                    path: imp.clone(),
                    language: String::new(),
                    relation: "IMPORTS".to_string(),
                });
            }
        }

        // 2. Files that import this file (reverse / incoming)
        let mut reverse_stmt = conn.prepare(
            "SELECT DISTINCT f.path, f.language
             FROM file_relations fr
             JOIN files f ON fr.from_file_id = f.id
             WHERE fr.to_file_id = ? AND fr.type = 'IMPORTS'
             LIMIT ?"
        )?;
        let reverse_rows = reverse_stmt.query_map(
            rusqlite::params![file_id, MAX_RELATED_FILES_LIMIT as i64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        for row in reverse_rows {
            let (path, lang) = row?;
            if seen_paths.insert(path.clone()) {
                related_files.push(FileContext {
                    path,
                    language: lang,
                    relation: "IMPORTED_BY".to_string(),
                });
            }
        }

        // 3. Directory siblings (same parent directory, different file)
        let parent_dir = {
            let p = std::path::Path::new(&normalized_path);
            p.parent().map(|d| d.to_string_lossy().replace('\\', "/"))
        };
        if let Some(dir) = parent_dir {
            let pattern = format!("{}/%", dir);
            let mut sibling_stmt = conn.prepare(
                "SELECT path, language FROM files
                 WHERE path LIKE ?1
                 AND path NOT LIKE ?2
                 AND id != ?3
                 LIMIT ?4"
            )?;
            // Exclude deeper nested files: only direct children (no extra '/' after dir/)
            let exclude_pattern = format!("{}/%/%", dir);
            let sibling_rows = sibling_stmt.query_map(
                rusqlite::params![pattern, exclude_pattern, file_id, MAX_RELATED_FILES_LIMIT as i64],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?;
            for row in sibling_rows {
                let (path, lang) = row?;
                if seen_paths.insert(path.clone()) {
                    related_files.push(FileContext {
                        path,
                        language: lang,
                        relation: "SIBLING".to_string(),
                    });
                }
            }
        }

        if related_files.len() > MAX_RELATED_FILES_LIMIT {
            tracing::warn!(file = %normalized_path, count = related_files.len(), cap = MAX_RELATED_FILES_LIMIT, "MAX_RELATED_FILES_LIMIT cap reached");
            related_files.truncate(MAX_RELATED_FILES_LIMIT);
        }

        // Get issues
        let mut issues_stmt = conn.prepare(
            "SELECT type, message, line, severity
             FROM code_issues
             WHERE file_id = ? AND suppressed = 0
             ORDER BY severity DESC, line
             LIMIT 10"
        )?;

        let issues_rows = issues_stmt.query_map([file_id], |row| {
            Ok(IssueContext {
                pattern_id: row.get(0)?,
                message: row.get(1)?,
                line: row.get(2)?,
                severity: row.get(3)?,
            })
        })?;

        let mut issues = Vec::new();
        for row in issues_rows {
            issues.push(row?);
        }

        Ok(SmartContextResult {
            file: normalized_path,
            symbols,
            symbols_capped,
            imports,
            related_files,
            issues,
        })
    }

    /// Get database statistics for context_stats operation
    pub fn get_database_stats(&self) -> Result<DatabaseStats, QueryError> {
        let conn = self.db.conn();
        
        let file_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM files", [], |r| r.get(0)
        ).unwrap_or(0);
        
        let symbol_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM symbols", [], |r| r.get(0)
        ).unwrap_or(0);
        
        let issue_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM code_issues WHERE suppressed = 0", [], |r| r.get(0)
        ).unwrap_or(0);
        
        let relation_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM file_relations", [], |r| r.get(0)
        ).unwrap_or(0);
        
        let signature_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM code_signatures", [], |r| r.get(0)
        ).unwrap_or(0);
        
        let call_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM calls", [], |r| r.get(0)
        ).unwrap_or(0);
        
        let last_indexed: Option<String> = conn.query_row(
            "SELECT MAX(last_indexed) FROM files", [], |r| r.get(0)
        ).ok();
        
        // Get database file size if available
        let db_size_bytes: Option<u64> = conn.query_row(
            "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()", 
            [], 
            |r| r.get(0)
        ).ok();
        
        Ok(DatabaseStats {
            file_count: file_count as usize,
            symbol_count: symbol_count as usize,
            issue_count: issue_count as usize,
            relation_count: relation_count as usize,
            signature_count: signature_count as usize,
            call_count: call_count as usize,
            last_indexed,
            db_size_bytes,
        })
    }

    /// Check if file needs re-indexing (hash mismatch)
    pub fn needs_reindex(&self, file_path: &str) -> Result<bool, QueryError> {
        use sha2::{Sha256, Digest};
        
        let conn = self.db.conn();
        // Strip Windows extended-length path prefix (\\?\) and normalize slashes
        let clean_path = file_path.strip_prefix(r"\\?\").unwrap_or(file_path);
        let normalized_path = clean_path.replace('\\', "/");
        
        // Get stored hash
        let stored_hash: Option<String> = conn.query_row(
            "SELECT hash FROM files WHERE path = ? OR path LIKE ?",
            rusqlite::params![&normalized_path, format!("%{}", normalized_path)],
            |row| row.get(0)
        ).optional()?;
        
        let Some(stored) = stored_hash else { 
            return Ok(true); // File not indexed yet
        };
        
        // Compute current hash from file (use clean path without \\?\ prefix)
        let path = std::path::Path::new(clean_path);
        if let Ok(content) = std::fs::read(path) {
            let mut hasher = Sha256::new();
            hasher.update(&content);
            let current = format!("{:x}", hasher.finalize());
            // Compare first 16 chars (stored hash may be truncated)
            let stored_prefix = &stored[..stored.len().min(16)];
            let current_prefix = &current[..current.len().min(16)];
            Ok(current_prefix != stored_prefix)
        } else {
            Ok(false) // File doesn't exist, don't re-index
        }
    }

    /// Helper: Recursively collect imports with bounded fan-out and total cap
    fn collect_imports(
        &self,
        conn: &rusqlite::Connection,
        file_id: i64,
        current_depth: u32,
        max_depth: u32,
        visited: &mut HashSet<i64>,
        imports: &mut Vec<String>,
    ) -> Result<(), QueryError> {
        if current_depth > max_depth {
            if current_depth == max_depth + 1 && !visited.contains(&file_id) {
                tracing::warn!(file_id, depth = current_depth, max_depth, "MAX_CONTEXT_DEPTH reached in import traversal");
            }
            return Ok(());
        }
        if visited.contains(&file_id) {
            return Ok(());
        }
        if imports.len() >= MAX_TOTAL_IMPORTS {
            tracing::warn!(file_id, depth = current_depth, total = imports.len(), "MAX_TOTAL_IMPORTS cap reached");
            return Ok(());
        }
        visited.insert(file_id);

        let mut stmt = conn.prepare(
            "SELECT f.id, f.path
             FROM file_relations fr
             JOIN files f ON fr.to_file_id = f.id
             WHERE fr.from_file_id = ? AND fr.type = 'IMPORTS'
             LIMIT ?"
        )?;

        let rows = stmt.query_map(rusqlite::params![file_id, MAX_IMPORTS_PER_LEVEL], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        for row in rows {
            if imports.len() >= MAX_TOTAL_IMPORTS {
                tracing::warn!(file_id, depth = current_depth, total = imports.len(), "MAX_TOTAL_IMPORTS cap reached");
                break;
            }
            let (import_id, import_path) = row?;
            if !imports.contains(&import_path) {
                imports.push(import_path.clone());
            }
            if current_depth < max_depth {
                self.collect_imports(conn, import_id, current_depth + 1, max_depth, visited, imports)?;
            }
        }

        Ok(())
    }

    /// Helper: Find test files
    /// Accepts a borrowed Connection to avoid re-locking the Mutex.
    fn find_test_files(&self, conn: &rusqlite::Connection, file_path: &str) -> Result<Vec<String>, QueryError> {
        let base_path = file_path.replace('\\', "/");
        let path_buf = PathBuf::from(&base_path);
        let stem = path_buf.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let ext = path_buf.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        if stem.is_empty() {
            return Ok(Vec::new());
        }

        let patterns = vec![
            format!("%/{}.test.{}", stem, ext),        // src/App.test.tsx
            format!("%/{}.spec.{}", stem, ext),        // src/App.spec.tsx
            format!("%/__tests__/{}.{}", stem, ext),   // __tests__/App.tsx
            format!("%/tests/{}.{}", stem, ext),       // tests/App.tsx
            format!("%/{}_test.{}", stem, ext),        // Rust: app_test.rs
            format!("tests/%{}.{}", stem, ext),        // Rust: tests/app.rs
        ];

        let mut test_files = Vec::new();
        for pattern in patterns {
            let mut stmt = conn.prepare(
                "SELECT path FROM files WHERE path LIKE ? LIMIT 5"
            )?;
            let rows = stmt.query_map([&pattern], |row| {
                Ok(row.get::<_, String>(0)?)
            })?;
            for row in rows {
                let path = row?;
                if path != base_path && !test_files.contains(&path) {
                    test_files.push(path);
                }
            }
        }

        Ok(test_files)
    }

    /// Helper: Find related files
    /// Accepts a borrowed Connection to avoid re-locking the Mutex.
    fn find_related_files(&self, conn: &rusqlite::Connection, file_path: &str) -> Result<Vec<String>, QueryError> {
        let base_path = file_path.replace('\\', "/");
        let dir = PathBuf::from(&base_path).parent()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .replace('\\', "/");

        let mut stmt = conn.prepare(
            "SELECT path FROM files WHERE path LIKE ? AND path != ? LIMIT ?"
        )?;

        let pattern = format!("{}%", dir);
        let rows = stmt.query_map(rusqlite::params![&pattern, &base_path, DEFAULT_RELATED_FILES_LIMIT as i64], |row| {
            Ok(row.get::<_, String>(0)?)
        })?;

        let mut related = Vec::new();
        for row in rows {
            related.push(row?);
        }

        Ok(related)
    }

    /// Helper: Find style files
    /// Accepts a borrowed Connection to avoid re-locking the Mutex.
    fn find_style_files(&self, conn: &rusqlite::Connection, component_path: &str) -> Result<Vec<String>, QueryError> {
        let base_path = component_path.replace('\\', "/");
        let base_name = PathBuf::from(&base_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let dir = PathBuf::from(&base_path).parent()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .replace('\\', "/");

        let patterns = vec![
            format!("{}/{}.css", dir, base_name),
            format!("{}/{}.scss", dir, base_name),
            format!("{}/{}.module.css", dir, base_name),
            format!("{}/{}.module.scss", dir, base_name),
        ];

        let mut style_files = Vec::new();
        for pattern in patterns {
            let mut stmt = conn.prepare(
                "SELECT path FROM files WHERE path = ? LIMIT 1"
            )?;
            if let Ok(Some(path)) = stmt.query_row([&pattern], |row| Ok(row.get::<_, String>(0)?)).optional() {
                style_files.push(path);
            }
        }

        Ok(style_files)
    }

    /// Helper: Find related components
    /// Accepts a borrowed Connection to avoid re-locking the Mutex.
    fn find_related_components(&self, conn: &rusqlite::Connection, component_path: &str) -> Result<Vec<String>, QueryError> {
        self.find_related_files(conn, component_path)
    }

    /// Helper: Collect related components recursively
    fn collect_related_components(
        &self,
        conn: &rusqlite::Connection,
        file_id: i64,
        current_depth: u32,
        max_depth: u32,
        visited: &mut HashSet<String>,
        related: &mut Vec<String>,
    ) -> Result<(), QueryError> {
        if current_depth > max_depth {
            return Ok(());
        }

        let mut stmt = conn.prepare(
            "SELECT f.path
             FROM file_relations fr
             JOIN files f ON fr.to_file_id = f.id
             WHERE fr.from_file_id = ? AND fr.type = 'IMPORTS'
               AND (f.path LIKE '%.tsx' OR f.path LIKE '%.jsx' OR f.path LIKE '%.ts' OR f.path LIKE '%.js')"
        )?;

        let rows = stmt.query_map([file_id], |row| {
            Ok(row.get::<_, String>(0)?)
        })?;

        for row in rows {
            let import_path = row?;
            if !visited.contains(&import_path) && !import_path.contains("test") {
                visited.insert(import_path.clone());
                if !related.contains(&import_path) {
                    related.push(import_path.clone());
                }
                
                // Get imported file ID and recurse
                if let Ok(Some(imported_file)) = crate::db::queries::Queries::get_file_by_path(conn, &PathBuf::from(&import_path)) {
                    if current_depth < max_depth {
                        self.collect_related_components(&*conn, imported_file.id, current_depth + 1, max_depth, visited, related)?;
                    }
                }
            }
        }

        Ok(())
    }
}

// Helper trait for optional query results
trait OptionalResult<T> {
    fn optional(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalResult<T> for rusqlite::Result<T> {
    fn optional(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

const DEFAULT_RELATED_FILES_LIMIT: usize = 10;

#[cfg(test)]
mod tests {
    use super::{is_reexport_only_module, scan_module_init_calls, append_module_init_symbols};
    use super::{SmartContextResult, SymbolContext};
    use crate::db::queries::Queries;
    use crate::db::Database;
    use crate::query::QueryEngine;
    use crate::types::{Language, ParsedSymbol, SymbolKind, SymbolMetadata};
    use std::path::PathBuf;

    // -- Module-init scanning (PR4) --
    // Reproduces the toolResultCompression.ts case where a trailing
    // `registerCompressionProvider(...)` at module scope was invisible in
    // `smart`/`sig` shape views, causing the "UNWIRED" false-negative.

    #[test]
    fn scan_finds_bare_module_level_call() {
        let source = r#"function foo() { return 1; }

registerFoo(options);
"#;
        let inits = scan_module_init_calls(source, 1);
        assert_eq!(inits.len(), 1);
        assert_eq!(inits[0].0, 3);
        assert_eq!(inits[0].1, "registerFoo");
    }

    #[test]
    fn scan_skips_indented_calls() {
        // Indented = not module scope. These are already inside a declaration
        // and will appear in the symbol index via the enclosing function.
        let source = "function outer() {\n    registerFoo(options);\n}\n";
        let inits = scan_module_init_calls(source, 0);
        assert!(inits.is_empty(), "indented calls must not be picked up: {:?}", inits);
    }

    #[test]
    fn scan_skips_declaration_prefixes() {
        // `export const`, `function`, `class`, etc. are declarations — already
        // in the symbols table. We only want bare expression statements.
        let source = r#"export const foo = (() => {})();
function bar() {}
class Baz {}
const x = 1;
import { y } from './y';
"#;
        let inits = scan_module_init_calls(source, 0);
        assert!(inits.is_empty(), "declaration prefixes must be skipped: {:?}", inits);
    }

    #[test]
    fn scan_skips_control_flow_keywords() {
        // `if`, `while`, etc. at column 0 are legal but not meaningful
        // "module inits" — skip them to keep the output signal-to-noise high.
        let source = "if (cond) { doThing(); }\nwhile (x) { y(); }\n";
        let inits = scan_module_init_calls(source, 0);
        assert!(inits.is_empty());
    }

    #[test]
    fn scan_honors_after_line_boundary() {
        // Caller passes the max line of declared symbols. Calls on or before
        // that boundary are already part of some declaration body and are
        // visible via normal symbol lookup.
        let source = "registerA();\nfunction f() {}\nregisterB();\n";
        let inits = scan_module_init_calls(source, 2);
        assert_eq!(inits.len(), 1);
        assert_eq!(inits[0].0, 3);
        assert_eq!(inits[0].1, "registerB");
    }

    #[test]
    fn scan_caps_at_max_entries() {
        let mut src = String::new();
        for i in 0..20 {
            src.push_str(&format!("call{}();\n", i));
        }
        let inits = scan_module_init_calls(&src, 0);
        assert_eq!(inits.len(), super::MAX_MODULE_INIT_ENTRIES);
    }

    #[test]
    fn scan_handles_self_registration_pattern() {
        // End-to-end case matching the A/B run that motivated this fix.
        // Declaration-heavy file with a trailing registration call — the call
        // must surface as `module_init` kind with line 5 on this fixture.
        let source = r#"export function encodeFoo() {}
export function decodeFoo() {}
export function helper() {}

registerCompressionProvider(isEnabled, encode, record);
"#;
        let mut result = SmartContextResult {
            file: "fixture.ts".into(),
            symbols: vec![
                SymbolContext { name: "encodeFoo".into(), kind: "function".into(), line: 1, signature: None },
                SymbolContext { name: "decodeFoo".into(), kind: "function".into(), line: 2, signature: None },
                SymbolContext { name: "helper".into(),   kind: "function".into(), line: 3, signature: None },
            ],
            symbols_capped: false,
            imports: vec![],
            related_files: vec![],
            issues: vec![],
        };
        append_module_init_symbols(&mut result, source);
        let init_entries: Vec<_> = result.symbols.iter().filter(|s| s.kind == "module_init").collect();
        assert_eq!(init_entries.len(), 1);
        assert_eq!(init_entries[0].name, "registerCompressionProvider");
        assert_eq!(init_entries[0].line, 5);
        assert!(init_entries[0].signature.as_deref().unwrap().contains("module init"));
    }

    #[test]
    fn append_is_noop_on_empty_source() {
        let mut result = SmartContextResult {
            file: "empty.ts".into(),
            symbols: vec![],
            symbols_capped: false,
            imports: vec![],
            related_files: vec![],
            issues: vec![],
        };
        append_module_init_symbols(&mut result, "");
        assert!(result.symbols.is_empty());
    }


    #[test]
    fn reexport_only_module_detects_rust_mod_rs_stub() {
        let content = r#"
// Re-exports for foo subsystem.
pub mod foo;
pub mod bar;

pub use foo::Thing;
pub use bar::{Other, Another};
"#;
        assert!(is_reexport_only_module(content));
    }

    #[test]
    fn reexport_only_module_detects_index_ts_barrel() {
        let content = r#"
// Barrel file for the `utils` directory.
export { helper } from './helper';
export type { Config } from './config';
export * from './constants';
"#;
        assert!(is_reexport_only_module(content));
    }

    #[test]
    fn reexport_only_module_rejects_real_module() {
        let content = r#"
pub mod foo;

pub fn real_work() -> i32 { 42 }
"#;
        assert!(!is_reexport_only_module(content));
    }

    #[test]
    fn reexport_only_module_rejects_empty_file() {
        // Empty files carry no signal — treat as non-stub so we do not
        // silently downrank genuinely new / unwritten modules.
        assert!(!is_reexport_only_module(""));
        assert!(!is_reexport_only_module("\n\n// just a comment\n"));
    }

    #[test]
    fn importance_scorer_downweights_mod_rs_stub() {
        // mod.rs stub: only `mod` symbols → low importance + not entry point.
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let stub_id = Queries::insert_file(&conn, &PathBuf::from("src/foo/mod.rs"), "h1", &Language::Rust, None).unwrap();
        let real_id = Queries::insert_file(&conn, &PathBuf::from("src/foo/logic.rs"), "h2", &Language::Rust, None).unwrap();
        let lib_id = Queries::insert_file(&conn, &PathBuf::from("src/lib.rs"), "h3", &Language::Rust, None).unwrap();

        // Stub: only `mod` symbol declarations.
        for name in ["bar", "baz"] {
            let sym = ParsedSymbol {
                name: name.into(), kind: SymbolKind::Module, line: 1, end_line: None,
                scope_id: None, signature: None, complexity: None, body_preview: None,
                metadata: SymbolMetadata { parameters: None, return_type: None, visibility: None, modifiers: None, parent_symbol: None, extends: None, implements: None },
            };
            Queries::insert_symbol(&conn, stub_id, &sym).unwrap();
        }
        // Real module: a real fn.
        let real_sym = ParsedSymbol {
            name: "compute".into(), kind: SymbolKind::Function, line: 1, end_line: Some(5),
            scope_id: None, signature: Some("fn compute() -> i32".into()), complexity: None, body_preview: None,
            metadata: SymbolMetadata { parameters: None, return_type: None, visibility: None, modifiers: None, parent_symbol: None, extends: None, implements: None },
        };
        Queries::insert_symbol(&conn, real_id, &real_sym).unwrap();
        // lib.rs is also a real module (has fns, not just mods).
        let lib_sym = ParsedSymbol {
            name: "run".into(), kind: SymbolKind::Function, line: 1, end_line: Some(5),
            scope_id: None, signature: Some("fn run()".into()), complexity: None, body_preview: None,
            metadata: SymbolMetadata { parameters: None, return_type: None, visibility: None, modifiers: None, parent_symbol: None, extends: None, implements: None },
        };
        Queries::insert_symbol(&conn, lib_id, &lib_sym).unwrap();

        // Run the same Phase-4-style refresh as the scanner.
        conn.execute_batch(r#"
            DELETE FROM file_importance;
            INSERT INTO file_importance (file_id, import_count, is_entry_point, importance_score)
            SELECT
                f.id,
                0,
                CASE WHEN (
                    f.path LIKE '%/main.rs' OR f.path LIKE '%/lib.rs' OR f.path LIKE '%/main.ts'
                    OR f.path LIKE '%/index.ts' OR f.path LIKE '%/App.ts'
                ) AND EXISTS (
                    SELECT 1 FROM symbols s
                    WHERE s.file_id = f.id
                      AND s.kind NOT IN ('mod', 'ns', 'namespace', 'module')
                ) THEN 1 ELSE 0 END,
                CASE WHEN NOT EXISTS (
                    SELECT 1 FROM symbols s
                    WHERE s.file_id = f.id
                      AND s.kind NOT IN ('mod', 'ns', 'namespace', 'module')
                ) THEN 0.1
                ELSE 1.0
                END
            FROM files f;
        "#).unwrap();

        let (stub_entry, stub_score): (i64, f64) = conn.query_row(
            "SELECT is_entry_point, importance_score FROM file_importance WHERE file_id = ?",
            [stub_id], |r| Ok((r.get(0)?, r.get(1)?))
        ).unwrap();
        let (real_entry, real_score): (i64, f64) = conn.query_row(
            "SELECT is_entry_point, importance_score FROM file_importance WHERE file_id = ?",
            [real_id], |r| Ok((r.get(0)?, r.get(1)?))
        ).unwrap();
        let (lib_entry, lib_score): (i64, f64) = conn.query_row(
            "SELECT is_entry_point, importance_score FROM file_importance WHERE file_id = ?",
            [lib_id], |r| Ok((r.get(0)?, r.get(1)?))
        ).unwrap();

        assert_eq!(stub_entry, 0, "stub mod.rs must not be marked entry_point");
        assert_eq!(lib_entry, 1, "lib.rs with real fns stays entry_point");
        assert_eq!(real_entry, 0, "logic.rs is not a conventional entry");
        assert!(stub_score < real_score, "stub {} should rank below real {}", stub_score, real_score);
        assert!(stub_score < lib_score, "stub {} should rank below lib {}", stub_score, lib_score);
    }

    #[test]
    fn get_database_stats_zeros_on_empty() {
        let db = Database::open_in_memory().unwrap();
        let q = QueryEngine::new(db);
        let s = q.get_database_stats().unwrap();
        assert_eq!(s.file_count, 0);
        assert_eq!(s.symbol_count, 0);
        assert_eq!(s.issue_count, 0);
    }

    #[test]
    fn get_database_stats_counts_rows() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let fid = Queries::insert_file(&conn, &PathBuf::from("m.rs"), "hh", &Language::Rust, None).unwrap();
        let sym = ParsedSymbol {
            name: "main".into(),
            kind: SymbolKind::Function,
            line: 1,
            end_line: None,
            scope_id: None,
            signature: None,
            complexity: None,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility: None,
                modifiers: None,
                parent_symbol: None,
                extends: None,
                implements: None,
            },
        };
        Queries::insert_symbol(&conn, fid, &sym).unwrap();
        drop(conn);
        let q = QueryEngine::new(db);
        let s = q.get_database_stats().unwrap();
        assert_eq!(s.file_count, 1);
        assert_eq!(s.symbol_count, 1);
    }
}
