use super::*;

/// Context extracted from a source file for generating language-complete helper files.
/// Contains the package/namespace declaration and import statements needed to produce
/// syntactically valid extracted files.
pub(crate) struct FileContext {
    /// Package/namespace declaration line (e.g. `package chi`, `namespace Humanizer`, etc.)
    pub package_decl: Option<String>,
    /// Raw import lines from the source file (full text of each import statement)
    pub import_lines: Vec<String>,
    /// Detected language
    pub language: atls_core::Language,
}

/// Extract file context (package/namespace declarations and imports) from a source file.
/// Uses tree-sitter to parse the source and reuses `RelationTracker::extract_imports`
/// for structured import data, while also capturing raw import text for faithful reproduction.
pub(crate) fn extract_file_context(
    source_content: &str,
    file_path: &str,
    project: &atls_core::AtlsProject,
) -> FileContext {
    let ext = std::path::Path::new(file_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let language = atls_core::Language::from_extension(ext);

    // For TS/JS, prefer raw line-based extraction which preserves the original
    // import syntax (named imports, default imports, etc.) exactly as written.
    // reconstruct_import_line() loses named imports when ImportInfo.symbols is
    // empty, producing bare side-effect imports like `import '@tauri-apps/api/core'`
    // instead of `import { invoke } from '@tauri-apps/api/core'`.
    let mut import_lines: Vec<String> = Vec::new();
    if matches!(language, atls_core::Language::TypeScript | atls_core::Language::JavaScript) {
        import_lines = extract_imports_by_line(source_content, language);
    }
    if import_lines.is_empty() {
        if let Ok(tree) = project.parser_registry().parse(language, source_content) {
            let imports = atls_core::indexer::RelationTracker::extract_imports(&tree, source_content, language);
            for imp in &imports {
                let raw_line = reconstruct_import_line(language, imp);
                if !raw_line.is_empty() {
                    import_lines.push(raw_line);
                }
            }
        }
    }
    // If tree-sitter parsing fails or produced no imports, fall back to line-based extraction
    if import_lines.is_empty() {
        import_lines = extract_imports_by_line(source_content, language);
    }
    // Deduplicate exact-duplicate import lines
    {
        let mut seen = std::collections::HashSet::new();
        import_lines.retain(|line| seen.insert(line.clone()));
    }

    // C# global usings: modern C# projects (SDK-style, .NET 6+) use `global using`
    // directives in a separate file (typically GlobalUsings.cs) that apply to all files
    // in the project. When a C# file has 0 explicit usings, search for GlobalUsings.cs
    // and include those, otherwise types like IComparable, DateTime, etc. will be undefined.
    if matches!(language, atls_core::Language::CSharp) && import_lines.is_empty() {
        import_lines = discover_csharp_global_usings(file_path, project);
    }

    // Strip UTF-8 BOM for line-based processing. Windows C# files often have a BOM
    // (EF BB BF) that corrupts `starts_with("namespace ")` checks on the first line.
    let source_no_bom = source_content.trim_start_matches('\u{FEFF}');

    // Extract package/namespace declaration (line-based — always near top of file)
    let package_decl = extract_package_declaration(source_no_bom, language);


    FileContext {
        package_decl,
        import_lines,
        language,
    }
}

/// Discover C# global usings from the project's GlobalUsings.cs file.
/// Walks up from the source file's directory looking for GlobalUsings.cs,
/// then converts `global using X;` directives into regular `using X;` lines.
/// Falls back to standard .NET 6+ implicit usings if no file is found.
pub(crate) fn discover_csharp_global_usings(
    file_path: &str,
    project: &atls_core::AtlsProject,
) -> Vec<String> {
    let project_root = project.root_path();
    let resolved = resolve_project_path(project_root, file_path);

    // Walk up from source file directory, looking for GlobalUsings.cs
    let mut search_dir = resolved.parent().map(|p| p.to_path_buf());
    let root = project_root;

    while let Some(dir) = search_dir {
        let candidate = dir.join("GlobalUsings.cs");
        if candidate.exists() {
            if let Ok(content) = std::fs::read_to_string(&candidate) {
                let usings: Vec<String> = content.lines()
                    .filter_map(|line| {
                        let trimmed = line.trim();
                        // Convert `global using System;` → `using System;`
                        trimmed.strip_prefix("global using ")
                            .map(|rest| format!("using {}", rest))
                    })
                    .collect();
                if !usings.is_empty() {
                    return usings;
                }
            }
        }

        // Stop at project root
        if dir == root || dir.parent().is_none() {
            break;
        }
        search_dir = dir.parent().map(|p| p.to_path_buf());
    }

    // Fallback: standard .NET 6+ implicit usings (enabled by default in SDK-style projects)
    vec![
        "using System;".to_string(),
        "using System.Collections.Generic;".to_string(),
        "using System.IO;".to_string(),
        "using System.Linq;".to_string(),
        "using System.Net.Http;".to_string(),
        "using System.Threading;".to_string(),
        "using System.Threading.Tasks;".to_string(),
    ]
}

/// Reconstruct a raw import/using/include line from structured ImportInfo.
pub(crate) fn reconstruct_import_line(
    language: atls_core::Language,
    imp: &atls_core::indexer::ImportInfo,
) -> String {
    match language {
        atls_core::Language::Go => {
            format!("    \"{}\"", imp.module)
        }
        atls_core::Language::Java => {
            format!("import {};", imp.module)
        }
        atls_core::Language::CSharp => {
            format!("using {};", imp.module)
        }
        atls_core::Language::Python => {
            if imp.symbols.is_empty() {
                format!("import {}", imp.module)
            } else {
                format!("from {} import {}", imp.module, imp.symbols.join(", "))
            }
        }
        atls_core::Language::Rust => {
            let prefix = if imp.is_pub { "pub use" } else { "use" };
            if imp.symbols.is_empty() {
                format!("{} {};", prefix, imp.module)
            } else if imp.symbols.len() == 1 {
                format!("{} {}::{};", prefix, imp.module, imp.symbols[0])
            } else {
                format!("{} {}::{{{}}};", prefix, imp.module, imp.symbols.join(", "))
            }
        }
        atls_core::Language::C | atls_core::Language::Cpp => {
            if imp.is_system {
                format!("#include <{}>", imp.module)
            } else {
                format!("#include \"{}\"", imp.module)
            }
        }
        atls_core::Language::TypeScript | atls_core::Language::JavaScript => {
            if imp.is_default && !imp.symbols.is_empty() {
                format!("import {} from '{}';", imp.symbols[0], imp.module)
            } else if !imp.symbols.is_empty() {
                format!("import {{ {} }} from '{}';", imp.symbols.join(", "), imp.module)
            } else {
                format!("import '{}';", imp.module)
            }
        }
        _ => String::new(),
    }
}

/// Fallback: extract import lines by simple line-based pattern matching.
pub(crate) fn extract_imports_by_line(source: &str, language: atls_core::Language) -> Vec<String> {
    let mut imports = Vec::new();

    // Go: multi-line import blocks require stateful parsing
    if matches!(language, atls_core::Language::Go) {
        let mut in_import_block = false;
        for line in source.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("import (") {
                in_import_block = true;
                continue;
            }
            if in_import_block {
                if trimmed == ")" {
                    in_import_block = false;
                    continue;
                }
                // Each line inside import (...) is an import spec, e.g. `    "net/http"`
                if !trimmed.is_empty() {
                    imports.push(format!("    {}", trimmed));
                }
                continue;
            }
            // Single-line import: `import "fmt"`
            if trimmed.starts_with("import \"") || trimmed.starts_with("import '") {
                let path = trimmed.trim_start_matches("import").trim();
                imports.push(format!("    {}", path));
            }
        }
        return imports;
    }

    let all_lines: Vec<&str> = source.lines().collect();
    let mut idx = 0;
    while idx < all_lines.len() {
        let line = all_lines[idx];
        let trimmed = line.trim();
        // Skip indented lines — they're inner-scope use/import statements
        if (line.starts_with(' ') || line.starts_with('\t'))
            && matches!(language, atls_core::Language::Rust)
        {
            idx += 1;
            continue;
        }
        let is_import = match language {
            atls_core::Language::Go => unreachable!(), // handled above
            atls_core::Language::Java => trimmed.starts_with("import "),
            atls_core::Language::CSharp => trimmed.starts_with("using ") && trimmed.ends_with(';'),
            atls_core::Language::Python => trimmed.starts_with("import ") || trimmed.starts_with("from "),
            atls_core::Language::Rust => trimmed.starts_with("use ") || trimmed.starts_with("pub use "),
            atls_core::Language::C | atls_core::Language::Cpp => trimmed.starts_with("#include"),
            atls_core::Language::TypeScript | atls_core::Language::JavaScript => trimmed.starts_with("import "),
            _ => false,
        };
        if is_import {
            // Multi-line import: TS/JS `import {` without `}`
            let is_ts_js_multiline = matches!(
                language,
                atls_core::Language::TypeScript | atls_core::Language::JavaScript
            ) && trimmed.contains('{') && !trimmed.contains('}');

            // Multi-line import: Python `from X import (` without `)`
            let is_py_multiline = matches!(language, atls_core::Language::Python)
                && trimmed.starts_with("from ")
                && trimmed.contains('(')
                && !trimmed.contains(')');

            if is_ts_js_multiline || is_py_multiline {
                let close_char = if is_ts_js_multiline { '}' } else { ')' };
                let mut joined = trimmed.to_string();
                idx += 1;
                while idx < all_lines.len() {
                    let cont = all_lines[idx].trim();
                    joined.push(' ');
                    joined.push_str(cont);
                    if cont.contains(close_char) {
                        idx += 1;
                        break;
                    }
                    idx += 1;
                }
                imports.push(joined);
                continue;
            }

            imports.push(line.to_string());
        }
        idx += 1;
    }
    imports
}

/// Extract the package/namespace declaration from the top of a source file.
pub(crate) fn extract_package_declaration(source: &str, language: atls_core::Language) -> Option<String> {
    // Only scan the first 50 lines — declarations are always near the top
    for line in source.lines().take(50) {
        let trimmed = line.trim();
        match language {
            atls_core::Language::Go => {
                if trimmed.starts_with("package ") {
                    return Some(trimmed.to_string());
                }
            }
            atls_core::Language::Java => {
                if trimmed.starts_with("package ") && trimmed.ends_with(';') {
                    return Some(trimmed.to_string());
                }
            }
            atls_core::Language::CSharp => {
                // Match both block-scoped `namespace X {` and file-scoped `namespace X;`
                if trimmed.starts_with("namespace ") {
                    return Some(trimmed.trim_end_matches('{').trim().to_string());
                }
            }
            atls_core::Language::Cpp => {
                if trimmed.starts_with("namespace ") {
                    return Some(trimmed.trim_end_matches('{').trim().to_string());
                }
            }
            // Python, Rust, TS, JS, C, Go — no top-level package declaration needed
            // (Rust uses `mod` in parent, Python uses directory structure)
            _ => {}
        }
    }
    None
}

/// Filter import lines to include only those referenced by the extracted method code.
/// Uses simple word-boundary matching: for each import, checks whether any of its
/// key symbols appear in the extracted code text.
///
/// For C# and Java, includes ALL imports conservatively — unused imports are only
/// IDE warnings in these languages, but missing imports cause compilation errors.
/// The aggressive token-matching filter was incorrectly removing essential imports
/// (e.g., `using System;` was filtered out even when code used `IComparable`).
pub(crate) fn filter_imports_for_code(
    import_lines: &[String],
    extracted_code: &str,
    language: atls_core::Language,
) -> Vec<String> {
    // C# and Java: include ALL imports. Unused imports are only warnings in these
    // languages, but missing imports cause compilation errors (CS0246, etc.).
    // Token-based filtering can't reliably determine which namespaces provide which
    // types (e.g., "System" namespace provides IComparable, IFormattable, etc.).
    if matches!(language,
        atls_core::Language::CSharp | atls_core::Language::Java
        | atls_core::Language::C | atls_core::Language::Cpp
    ) {
        return import_lines.to_vec();
    }

    let filtered: Vec<String> = import_lines
        .iter()
        .filter(|line| import_is_referenced(line, extracted_code, language))
        .cloned()
        .collect();

    filtered
}

/// Rewrite Rust `use` imports so they compile in a new sibling module.
///
/// - `use crate::...` paths are kept as-is (absolute, valid everywhere).
/// - `use self::...` is rewritten to `use crate::{source_module}::...`.
/// - `use super::...` is rewritten to `use crate::{parent_of_source}::...`
///   (or `use crate::...` when the source is a direct child of the crate root).
/// - Imports that resolve to the *target* module itself are dropped.
/// - A catch-all `use crate::{source_module}::*;` is prepended so that
///   non-extracted siblings (types, helper fns) remain accessible.
pub(crate) fn rewrite_rust_imports_for_new_module(
    filtered_imports: &[String],
    source_module: &str,
    target_module: &str,
    extracted_symbol_names: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // NOTE: no catch-all `use crate::{source_module}::*;` — the caller
    // adds specific imports for source-module symbols via AST analysis.

    for line in filtered_imports {
        let trimmed = line.trim();
        let (prefix, inner) = if trimmed.starts_with("pub use ") {
            ("pub use ", trimmed.strip_prefix("pub use ").unwrap_or(""))
        } else if trimmed.starts_with("use ") {
            ("use ", trimmed.strip_prefix("use ").unwrap_or(""))
        } else {
            out.push(line.clone());
            continue;
        };
        let inner = inner.trim_end_matches(';').trim();

        // Drop imports of the target module itself
        if inner == format!("crate::{}", target_module)
            || inner.starts_with(&format!("crate::{}::", target_module))
        {
            continue;
        }

        // Drop imports of symbols we're extracting (they'll be local)
        let last_segment = inner.rsplit("::").next().unwrap_or("");
        if extracted_symbol_names.iter().any(|n| n == last_segment) {
            let path_prefix = inner.trim_end_matches(last_segment).trim_end_matches("::");
            if path_prefix.is_empty()
                || path_prefix == "crate"
                || path_prefix == format!("crate::{}", source_module)
                || path_prefix == "self"
                || path_prefix == "super"
            {
                continue;
            }
        }

        // Rewrite relative paths
        if inner.starts_with("self::") {
            let rest = &inner["self::".len()..];
            if !source_module.is_empty() {
                out.push(format!("{}crate::{}::{};", prefix, source_module, rest));
            } else {
                out.push(format!("{}crate::{};", prefix, rest));
            }
        } else if inner.starts_with("super::") {
            let rest = &inner["super::".len()..];
            // super:: from a module goes to its parent.
            // For a direct child of crate root, super:: == crate::
            if let Some(parent) = source_module.rsplit_once("::").map(|(p, _)| p) {
                out.push(format!("{}crate::{}::{};", prefix, parent, rest));
            } else {
                out.push(format!("{}crate::{};", prefix, rest));
            }
        } else {
            // crate::..., std::..., extern crate paths — keep as-is
            out.push(line.clone());
        }
    }

    out
}

/// Rewrite TS/JS relative import paths for a different-directory extraction.
///
/// When extracting from `src/services/aiService.ts` to `src/utils/aiService_utils.ts`,
/// relative import paths like `'../stores/appStore'` need recomputing from the
/// target file's location.
pub(crate) fn rewrite_ts_import_paths(
    import_lines: &[String],
    source_dir: &std::path::Path,
    target_dir: &std::path::Path,
) -> Vec<String> {
    if source_dir == target_dir {
        return import_lines.to_vec();
    }

    let from_re = regex::Regex::new(r#"(from\s+['"])([^'"]+)(['"])"#).unwrap();

    import_lines.iter().map(|line| {
        if let Some(caps) = from_re.captures(line) {
            let prefix = &caps[1];
            let path = &caps[2];
            let suffix = &caps[3];

            // Only rewrite relative paths (starting with . or ..)
            if !path.starts_with('.') {
                return line.clone();
            }

            // Resolve the imported path relative to source directory
            let resolved = source_dir.join(path);
            // Normalize the resolved path
            let normalized = normalize_path(&resolved);

            // Compute the relative path from target directory
            let relative = compute_relative_path(target_dir, &normalized);
            let relative_str = relative.to_string_lossy().replace('\\', "/");
            let new_path = if relative_str.starts_with('.') {
                relative_str.to_string()
            } else {
                format!("./{}", relative_str)
            };
            return line.replace(&format!("{}{}{}", prefix, path, suffix),
                                &format!("{}{}{}", prefix, new_path, suffix));
        }
        line.clone()
    }).collect()
}

/// Compute a relative path from `from` directory to `to` path (no filesystem access).
fn compute_relative_path(from: &std::path::Path, to: &std::path::Path) -> std::path::PathBuf {
    let from_parts: Vec<_> = from.components().collect();
    let to_parts: Vec<_> = to.components().collect();

    // Find common prefix length
    let common = from_parts.iter().zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let ups = from_parts.len() - common;
    let mut result = std::path::PathBuf::new();
    for _ in 0..ups {
        result.push("..");
    }
    for part in &to_parts[common..] {
        result.push(part.as_os_str());
    }
    if result.as_os_str().is_empty() {
        result.push(".");
    }
    result
}

/// Normalize a path by resolving `.` and `..` components without filesystem access.
fn normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                if !components.is_empty() {
                    components.pop();
                }
            }
            std::path::Component::CurDir => {}
            c => components.push(c.as_os_str().to_owned()),
        }
    }
    components.iter().collect()
}

/// Build a mapping of module aliases from the source file's imports.
/// e.g. `use core::fmt;`          → `fmt`  → `core::fmt`
///      `use core::fmt::{self, Display}` → `fmt` → `core::fmt`
pub(crate) fn build_rust_module_alias_map(imports: &[String]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in imports {
        let trimmed = line.trim()
            .trim_start_matches("pub ")
            .trim_start_matches("use ")
            .trim_end_matches(';')
            .trim();
        // `use core::fmt;`  →  alias "fmt" = "core::fmt"
        if !trimmed.contains('{') && !trimmed.contains('*') {
            if let Some(last) = trimmed.rsplit("::").next() {
                if last.chars().next().map(|c| c.is_lowercase()).unwrap_or(false) {
                    map.insert(last.to_string(), trimmed.to_string());
                }
            }
        }
        // `use core::fmt::{self, ...}`  →  alias "fmt" = "core::fmt"
        if let Some(brace_start) = trimmed.find('{') {
            if let Some(brace_end) = trimmed.find('}') {
                let items: Vec<&str> = trimmed[brace_start + 1..brace_end]
                    .split(',')
                    .map(|s| s.trim())
                    .collect();
                if items.contains(&"self") {
                    let module_path = trimmed[..brace_start].trim_end_matches("::").trim();
                    if let Some(last) = module_path.rsplit("::").next() {
                        if last.chars().next().map(|c| c.is_lowercase()).unwrap_or(false) {
                            map.insert(last.to_string(), module_path.to_string());
                        }
                    }
                }
            }
        }
    }
    map
}

/// Resolve `self::X::Y` imports through the source file's module alias map.
/// e.g. if `fmt` → `core::fmt`, then `use self::fmt::Write;` → `use core::fmt::Write;`
pub(crate) fn resolve_self_imports_through_aliases(
    imports: &[String],
    alias_map: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    imports.iter().map(|line| {
        let trimmed = line.trim();
        let (prefix, inner) = if trimmed.starts_with("pub use ") {
            ("pub use ", trimmed.strip_prefix("pub use ").unwrap_or(""))
        } else if trimmed.starts_with("use ") {
            ("use ", trimmed.strip_prefix("use ").unwrap_or(""))
        } else {
            return line.clone();
        };
        let inner = inner.trim_end_matches(';').trim();
        if !inner.starts_with("self::") {
            return line.clone();
        }
        let rest = inner.strip_prefix("self::").unwrap_or(inner);
        let first_seg = rest.split("::").next().unwrap_or("");
        if let Some(resolved) = alias_map.get(first_seg) {
            let after_first = rest.strip_prefix(first_seg)
                .unwrap_or("")
                .trim_start_matches("::");
            if after_first.is_empty() {
                format!("{}{};", prefix, resolved)
            } else {
                format!("{}{}::{};", prefix, resolved, after_first)
            }
        } else {
            line.clone()
        }
    }).collect()
}

/// Detect `macro_rules!` macro invocations in extracted code that originate
/// from the crate root and cannot be imported via `use`. Returns warning
/// entries for each detected macro.
pub(crate) fn detect_rust_macro_deps(
    extracted_code: &str,
    crate_root_path: &std::path::Path,
) -> Vec<serde_json::Value> {
    let mut warnings = Vec::new();

    // Collect macro_rules! names defined in the crate root
    let root_content = match std::fs::read_to_string(crate_root_path) {
        Ok(c) => c,
        Err(_) => return warnings,
    };

    let mut root_macros: Vec<String> = Vec::new();
    for line in root_content.lines() {
        let trimmed = line.trim();
        // macro_rules! name { ...
        if let Some(rest) = trimmed.strip_prefix("macro_rules!") {
            let macro_name = rest.trim().split(|c: char| !c.is_alphanumeric() && c != '_').next().unwrap_or("");
            if !macro_name.is_empty() {
                root_macros.push(macro_name.to_string());
            }
        }
    }

    // Check if extracted code invokes any of these macros (pattern: macro_name!)
    for macro_name in &root_macros {
        let pattern = format!("{}!", macro_name);
        if extracted_code.contains(&pattern) {
            warnings.push(serde_json::json!({
                "symbol": macro_name,
                "kind": "macro_rules",
                "issue": format!(
                    "macro '{}!' is defined in the crate root via macro_rules! and cannot be \
                     imported with `use`. Options: (1) add #[macro_export] to the macro and \
                     use crate::{} in the new module, (2) convert it to a function, or \
                     (3) keep this code in the source module.",
                    macro_name, macro_name
                )
            }));
        }
    }

    warnings
}

/// Expand symbol-removal line range to include orphaned trailing syntax.
/// Adjusts start/end (1-based) so that decorators, attributes, trailing commas,
/// empty separator lines, and orphaned closing braces are cleaned up.
pub(crate) fn expand_removal_boundaries(content: &str, start: u32, end: u32, lang: Option<&str>) -> (u32, u32) {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as u32;
    if start == 0 || end == 0 || start > total {
        return (start, end);
    }

    let mut new_start = start;
    let mut new_end = end.min(total);

    let is_rust_like = matches!(lang, Some("rust" | "rs"));
    let is_py = matches!(lang, Some("python" | "py"));

    // Expand upward: include preceding attributes/decorators that apply only to this symbol.
    // e.g. #[tauri::command], @decorator, /// doc comments
    loop {
        if new_start <= 1 { break; }
        let prev = lines[(new_start - 2) as usize].trim();
        let is_attr = prev.starts_with("#[") || prev.starts_with("#![");
        let is_decorator = prev.starts_with('@');
        let is_doc = prev.starts_with("///") || prev.starts_with("//!") || prev.starts_with("/** ");
        let is_py_decorator = is_py && prev.starts_with('@');
        if is_attr || is_decorator || is_doc || is_py_decorator {
            new_start -= 1;
        } else {
            break;
        }
    }

    // Expand downward: include trailing empty lines and orphaned syntax
    loop {
        if new_end >= total { break; }
        let next = lines[new_end as usize].trim();
        if next.is_empty() {
            new_end += 1;
        } else if next == "," || next == ")," || next == "}," {
            // Orphaned trailing comma from match arm or argument list removal
            new_end += 1;
        } else {
            break;
        }
    }

    // For Rust: check if the line before new_start is a lone `/// ---` or similar
    // separator that only made sense between two items
    if is_rust_like && new_start > 1 {
        let prev = lines[(new_start - 2) as usize].trim();
        if prev.starts_with("// --") || prev.starts_with("// ==") || prev.starts_with("// ──") {
            new_start -= 1;
        }
    }

    (new_start, new_end)
}

/// Validate that a numeric line range doesn't clip adjacent syntactic blocks.
/// Returns `Ok(())` if boundaries are clean, or `Err(diagnostic)` with a
/// human-readable message explaining the problem and suggesting symbol anchors.
pub(crate) fn validate_removal_boundaries(
    content: &str,
    start: u32,
    end: u32,
    lang: Option<&str>,
) -> Result<(), String> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as u32;
    if start == 0 || end == 0 || start > total || end > total || start > end {
        return Ok(());
    }

    let is_py = matches!(lang, Some("python" | "py"));
    if is_py {
        return Ok(());
    }

    // Check brace balance across the removal range. If the range starts or ends
    // mid-block, the brace depth will be non-zero.
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut string_char: char = '"';
    let mut in_block_comment = false;

    for line_idx in (start - 1)..end.min(total) {
        let line = lines[line_idx as usize];
        let chars: Vec<char> = line.chars().collect();
        let len = chars.len();
        let mut i = 0;
        while i < len {
            if in_block_comment {
                if i + 1 < len && chars[i] == '*' && chars[i + 1] == '/' {
                    in_block_comment = false;
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }
            if in_string {
                if chars[i] == '\\' {
                    i += 2;
                    continue;
                }
                if chars[i] == string_char {
                    in_string = false;
                }
                i += 1;
                continue;
            }
            if i + 1 < len && chars[i] == '/' && chars[i + 1] == '/' {
                break;
            }
            if i + 1 < len && chars[i] == '/' && chars[i + 1] == '*' {
                in_block_comment = true;
                i += 2;
                continue;
            }
            if chars[i] == '"' || chars[i] == '\'' || chars[i] == '`' {
                in_string = true;
                string_char = chars[i];
                i += 1;
                continue;
            }
            if chars[i] == '{' {
                depth += 1;
            } else if chars[i] == '}' {
                depth -= 1;
            }
            i += 1;
        }
    }

    // C/C++: check preprocessor balance (#if/#endif) and block macro overlap
    let is_c_cpp = matches!(lang, Some("c") | Some("cpp") | Some("cc") | Some("h") | Some("hpp"));
    if is_c_cpp {
        let start0 = (start - 1) as usize;
        let end0 = end.min(total) as usize;
        let mut in_define = false;
        for line_idx in 0..end0 {
            let line = lines.get(line_idx).map(|l| l.trim()).unwrap_or("");
            if line.starts_with("#define ") || (line.starts_with("#define\t") && line.len() > 8) {
                in_define = line.ends_with('\\');
                if line_idx >= start0 {
                    return Err(format!(
                        "Cannot safely extract: range overlaps macro #define (line {}). Use manual line-range or narrow the selection.",
                        line_idx + 1
                    ));
                }
            } else if in_define {
                if line_idx >= start0 {
                    return Err(format!(
                        "Cannot safely extract: range overlaps macro body (line {}). Use manual line-range or narrow the selection.",
                        line_idx + 1
                    ));
                }
                in_define = line.ends_with('\\');
            } else {
                in_define = false;
            }
        }
        let mut pp_depth: i32 = 0;
        for line_idx in (start - 1)..end.min(total) {
            let line = lines[line_idx as usize].trim();
            if line.starts_with("#if ") || line.starts_with("#ifdef ") || line.starts_with("#ifndef ") {
                pp_depth += 1;
            } else if line.starts_with("#endif") {
                pp_depth -= 1;
            }
        }
        if pp_depth != 0 {
            let pp_dir = if pp_depth > 0 { "unclosed #if/#ifdef" } else { "extra #endif" };
            return Err(format!(
                "Removal range L{}-L{} has unbalanced preprocessor (depth={}, {}). Use manual line-range or narrow the selection.",
                start, end, pp_depth, pp_dir,
            ));
        }
    }

    if depth != 0 {
        let direction = if depth > 0 { "unclosed '{'" } else { "extra '}'" };
        let context_before = if start > 1 {
            lines[(start.saturating_sub(3) as usize)..((start - 1) as usize)]
                .iter()
                .enumerate()
                .map(|(i, l)| format!("  {}| {}", start as usize - 2 + i, l))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            String::new()
        };
        let context_after = if end < total {
            lines[(end as usize)..(end.min(total).saturating_add(2).min(total) as usize)]
                .iter()
                .enumerate()
                .map(|(i, l)| format!("  {}| {}", end as usize + 1 + i, l))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            String::new()
        };

        return Err(format!(
            "Removal range L{}-L{} has unbalanced braces (depth={}, {}). \
             This would clip an adjacent block. Use symbol-anchor syntax \
             (e.g. remove_lines:\"fn(name)\") for safer extraction.\n\
             Before:\n{}\n  --removed L{}-L{}--\n\
             After:\n{}",
            start, end, depth, direction,
            context_before, start, end, context_after,
        ));
    }

    // Additional check: if the line just before `start` is an unmatched closing
    // brace (meaning the range starts inside a block opened above)
    if start > 1 {
        let prev_trimmed = lines[(start - 2) as usize].trim();
        if prev_trimmed == "}" || prev_trimmed == "};" {
            // Scan above to see if there's an open block: count braces from
            // line 1 to start-1
            let mut pre_depth: i32 = 0;
            for li in 0..(start - 1) as usize {
                for ch in lines[li].chars() {
                    match ch {
                        '{' => pre_depth += 1,
                        '}' => pre_depth -= 1,
                        _ => {}
                    }
                }
            }
            if pre_depth != 0 {
                return Err(format!(
                    "Removal range starts at L{} right after a closing brace (L{}). \
                     The preceding block may be clipped. Use symbol-anchor syntax \
                     (e.g. remove_lines:\"fn(name)\") for safer extraction.",
                    start, start - 1,
                ));
            }
        }
    }

    Ok(())
}

/// Pre-flight check for extraction safety. Analyzes the source content around
/// a symbol-anchor removal to detect issues that would cause syntax errors.
/// Returns (warnings, blocking_errors). Blocking errors should prevent extraction.
pub(crate) fn preflight_extract_check(
    content: &str,
    remove_str: &str,
    lang: Option<&str>,
) -> (Vec<String>, Vec<String>) {
    let mut warnings = Vec::new();
    let mut errors = Vec::new();

    let trimmed = remove_str.trim();
    if !shape_ops::is_symbol_anchor_str(trimmed) {
        return (warnings, errors);
    }

    // Resolve the symbol range
    let range = {
        let (kind, name) = match shape_ops::parse_symbol_anchor_str(trimmed) {
            Some(pair) => pair,
            None => return (warnings, errors),
        };
        match shape_ops::resolve_symbol_anchor_lines_lang(content, kind, name, lang) {
            Ok(r) => r,
            Err(e) => {
                // Surface re-export/bodyless diagnostic: symbol has no local definition
                let msg = format!("{}", e);
                if msg.contains("bodyless") || msg.contains("re-export") || msg.contains("alias") {
                    errors.push(format!(
                        "Symbol '{}' is re-exported/imported only, not locally defined. Use line-range extraction or define locally first.",
                        name
                    ));
                }
                return (warnings, errors);
            }
        }
    };

    let (start, end) = range; // 1-based
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as u32;

    // Check 1: Trailing syntax hazard — line after range
    if end < total {
        let next_line = lines[end as usize].trim();
        if next_line == "," || next_line == ")," || next_line == "}," {
            warnings.push(format!(
                "Line {} after symbol is orphaned trailing syntax '{}'. \
                 expand_removal_boundaries will auto-include it.",
                end + 1, next_line
            ));
        }
        if next_line == "}" || next_line == ");" || next_line == "};" {
            let opens_before: usize = lines[..start.saturating_sub(1) as usize].iter()
                .flat_map(|l| l.chars())
                .filter(|&c| c == '{' || c == '(')
                .count();
            let closes_before: usize = lines[..start.saturating_sub(1) as usize].iter()
                .flat_map(|l| l.chars())
                .filter(|&c| c == '}' || c == ')')
                .count();
            if opens_before > closes_before {
                // Removing this symbol might leave an unmatched brace
                warnings.push(format!(
                    "Line {} after symbol is '{}' which may become orphaned if the \
                     symbol is inside a parent block. Verify parent block boundaries.",
                    end + 1, next_line
                ));
            }
        }
    }

    // Check 2: Macro span — is this symbol inside a macro invocation?
    if start > 1 {
        let mut depth: i32 = 0;
        for i in (0..start.saturating_sub(1) as usize).rev() {
            let line = lines[i].trim();
            // Count brace depth going upward to detect if we're inside a macro body
            for ch in line.chars().rev() {
                match ch {
                    '}' => depth += 1,
                    '{' => depth -= 1,
                    _ => {}
                }
            }
            if depth < 0 {
                // We're inside a block that opened before our symbol
                if line.contains("macro_rules!") || (line.contains('!') && line.contains('{')) {
                    errors.push(format!(
                        "Symbol at lines {}-{} appears to be inside a macro body (line {}): '{}'. \
                         Extracting individual items from inside a macro invocation will break the macro.",
                        start, end, i + 1, line.chars().take(80).collect::<String>()
                    ));
                }
                break;
            }
        }
    }

    // Check 3: Shared type definitions referenced in the symbol body
    let symbol_body: String = lines[start.saturating_sub(1) as usize..end.min(total) as usize]
        .join("\n");
    let type_def_re = regex::Regex::new(
        r"(?m)^\s*(?:pub(?:\(crate\))?\s+)?(?:struct|enum|type|trait)\s+(\w+)"
    ).unwrap();
    let all_type_names: Vec<(String, u32)> = type_def_re.captures_iter(content)
        .filter_map(|cap| {
            let name = cap.get(1)?.as_str().to_string();
            let pos = cap.get(0)?.start();
            let line_num = content[..pos].matches('\n').count() as u32 + 1;
            Some((name, line_num))
        })
        .collect();

    for (type_name, def_line) in &all_type_names {
        let inside_range = *def_line >= start && *def_line <= end;
        if !inside_range && symbol_body.contains(type_name.as_str()) {
            warnings.push(format!(
                "Symbol body references type '{}' (defined at line {}) which is outside \
                 the extraction range. Ensure the target file imports or re-defines it.",
                type_name, def_line
            ));
        }
    }

    (warnings, errors)
}

/// Extract context lines around an error location from in-memory content.
/// Returns a vec of formatted lines with line numbers, marking the error line with `>>`.
pub(crate) fn extract_error_context(content: &str, error_line: u32, radius: u32) -> Vec<String> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as u32;
    let line_idx = error_line.saturating_sub(1);
    let ctx_start = line_idx.saturating_sub(radius);
    let ctx_end = (line_idx + radius + 1).min(total);

    let mut ctx = Vec::new();
    for i in ctx_start..ctx_end {
        let marker = if i == line_idx { ">>" } else { "  " };
        ctx.push(format!("{}{}| {}", marker, i + 1, lines.get(i as usize).unwrap_or(&"")));
    }
    ctx
}

/// Derive the Rust module name from a source file path relative to the crate root.
/// e.g. "src/read.rs" → "read", "src/de/mod.rs" → "de"
pub(crate) fn derive_rust_module_name(source_file: &str, project_root: &std::path::Path) -> String {
    let resolved = resolve_project_path(project_root, source_file);
    // Find the nearest lib.rs or main.rs to determine crate root dir
    let src_dir = resolved.parent().unwrap_or(project_root);
    let crate_root_dir = if src_dir.join("lib.rs").is_file() || src_dir.join("main.rs").is_file() {
        src_dir.to_path_buf()
    } else if let Some(parent) = src_dir.parent() {
        if parent.join("lib.rs").is_file() || parent.join("main.rs").is_file() {
            parent.to_path_buf()
        } else {
            src_dir.to_path_buf()
        }
    } else {
        src_dir.to_path_buf()
    };

    let stem = resolved.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if stem == "lib" || stem == "main" {
        return String::new(); // crate root has no module name
    }
    if stem == "mod" {
        // mod.rs — module name is the parent directory name
        return resolved.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
    }

    // For nested modules, build a path relative to the crate root dir
    if let Ok(rel) = resolved.strip_prefix(&crate_root_dir) {
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let without_ext = rel_str.trim_end_matches(".rs");
        return without_ext.replace('/', "::");
    }

    stem.to_string()
}

/// Build a complete target file header with namespace/package and imports for moved code.
/// Mirrors the language-aware header logic used in extract_methods but as a reusable helper
/// for move_symbol and any future operations that create new files from existing code.
/// Derive a Java `package ...;` declaration from a file path.
/// Looks for standard Java source roots (src/main/java/, src/, java/) and
/// converts the directory structure after that root into a dotted package name.
pub(crate) fn derive_java_package_from_path(file_path: &str) -> Option<String> {
    let normalized = file_path.replace('\\', "/");
    // Known Java source roots, ordered by specificity
    let roots = ["src/main/java/", "src/test/java/", "src/", "java/"];
    for root in &roots {
        if let Some(idx) = normalized.find(root) {
            let after_root = &normalized[idx + root.len()..];
            // Take everything before the last '/' (strip filename)
            if let Some(last_slash) = after_root.rfind('/') {
                let pkg = after_root[..last_slash].replace('/', ".");
                if !pkg.is_empty() {
                    return Some(format!("package {};", pkg));
                }
            }
        }
    }
    None
}

/// Find the `export default` statement in a JS/TS source and return its line range.
/// Handles: `export default function name(...)`, `export default function(...)`,
/// `export default class`, `export default <expression>`.
/// Uses brace counting to find the end of the exported block.
pub(crate) fn find_export_default_range(source: &str) -> Option<atls_core::query::SymbolLineRange> {
    let lines: Vec<&str> = source.lines().collect();
    let mut start_line: Option<usize> = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("export default ") || trimmed == "export default" {
            start_line = Some(i);
            break;
        }
    }
    let start = start_line?;

    // Detect the actual kind from the export default statement
    let start_trimmed = lines[start].trim();
    let after_export_default = start_trimmed.strip_prefix("export default ").unwrap_or("");
    let kind = if after_export_default.starts_with("function ") || after_export_default.starts_with("function(") || after_export_default.starts_with("async function") {
        "function"
    } else if after_export_default.starts_with("class ") || after_export_default.starts_with("class{") {
        "class"
    } else {
        "function" // default to function for expressions (arrow fns, object literals, etc.)
    };

    // Find the end by tracking brace depth
    let mut depth: i32 = 0;
    let mut end = start;
    let mut found_open_brace = false;
    for i in start..lines.len() {
        for ch in lines[i].chars() {
            if ch == '{' { depth += 1; found_open_brace = true; }
            if ch == '}' { depth -= 1; }
        }
        end = i;
        if found_open_brace && depth <= 0 {
            break;
        }
        // Single-line export default (no braces), e.g. `export default myVar;`
        if !found_open_brace && lines[i].trim().ends_with(';') {
            break;
        }
    }

    Some(atls_core::query::SymbolLineRange {
        file: String::new(), // same file
        name: "default".to_string(),
        kind: kind.to_string(),
        start_line: (start + 1) as u32,
        end_line: (end + 1) as u32,
        signature: None,
    })
}

/// Find the longest common underscore-delimited prefix among a set of symbol names.
/// Returns None if no meaningful common prefix exists (length < 3 or only 1 name).
pub(crate) fn find_common_prefix(names: &[String]) -> Option<String> {
    if names.len() < 2 { return None; }
    let parts: Vec<Vec<&str>> = names.iter().map(|n| n.split('_').collect()).collect();
    let min_parts = parts.iter().map(|p| p.len()).min().unwrap_or(0);
    let mut common = Vec::new();
    for i in 0..min_parts {
        let first = parts[0][i];
        if parts.iter().all(|p| p[i] == first) {
            common.push(first);
        } else {
            break;
        }
    }
    let prefix = common.join("_");
    if prefix.len() >= 3 { Some(prefix) } else { None }
}

/// Collapse runs of 3+ consecutive blank lines down to at most 2 blank lines.
/// Used after removing symbols from source files to avoid large whitespace gaps.
pub(crate) fn collapse_blank_lines(code: &str) -> String {
    let mut result = Vec::new();
    let mut consecutive_blanks = 0;
    for line in code.lines() {
        if line.trim().is_empty() {
            consecutive_blanks += 1;
            if consecutive_blanks <= 2 {
                result.push(line);
            }
        } else {
            consecutive_blanks = 0;
            result.push(line);
        }
    }
    // Preserve trailing newline if original had one
    let mut out = result.join("\n");
    if code.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Auto-fix imports in consumer files after symbols are moved from source to target.
/// Scans all files referencing the moved symbols and rewrites their imports.
/// Returns a list of files modified with details of import changes.
pub(crate) fn generate_consumer_import_updates(
    project: &atls_core::AtlsProject,
    source_file: &str,
    target_file: &str,
    symbol_names: &[String],
    language: atls_core::Language,
    project_root: &std::path::Path,
    dry_run: bool,
) -> Vec<serde_json::Value> {
    generate_consumer_import_updates_with_snapshots(
        project, source_file, target_file, symbol_names,
        language, project_root, dry_run, None,
    )
}

/// Same as `generate_consumer_import_updates` but optionally captures the
/// pre-modification content of each consumer file into `pre_snapshots`
/// for rollback purposes (key = normalized path, value = original content).
pub(crate) fn generate_consumer_import_updates_with_snapshots(
    project: &atls_core::AtlsProject,
    source_file: &str,
    target_file: &str,
    symbol_names: &[String],
    language: atls_core::Language,
    project_root: &std::path::Path,
    dry_run: bool,
    mut pre_snapshots: Option<&mut std::collections::HashMap<String, String>>,
) -> Vec<serde_json::Value> {
    let mut results = Vec::new();
    let source_stem = std::path::Path::new(source_file)
        .file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let normalized_source = source_file.replace('\\', "/");
    let normalized_target = target_file.replace('\\', "/");

    // Collect which symbols each consumer needs updated.
    // Key = normalized consumer path, Value = set of symbol names.
    let mut consumer_symbols: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for sym_name in symbol_names {
        let usage = match project.query().get_symbol_usage_compact(sym_name, None, 50) {
            Ok(u) => u,
            Err(_) => continue,
        };
        for (consumer_path, _scopes) in &usage.used_by {
            let normalized_consumer = consumer_path.replace('\\', "/");
            if normalized_consumer == normalized_source || normalized_consumer == normalized_target {
                continue;
            }
            consumer_symbols
                .entry(normalized_consumer)
                .or_default()
                .push(sym_name.clone());
        }
    }

    // Process each consumer once: remove moved symbols from old import if present,
    // then add a new import for the target module.
    for (normalized_consumer, syms) in &consumer_symbols {
        // Skip cross-language consumers: a Python extract should not inject
        // Python imports into TypeScript files (or vice versa).
        let consumer_lang = hash_resolver::detect_lang(Some(normalized_consumer.as_str()))
            .map(|l| atls_core::Language::from_str(&l))
            .unwrap_or(atls_core::Language::Unknown);
        if consumer_lang != atls_core::Language::Unknown && consumer_lang != language {
            continue;
        }

        let consumer_abs = resolve_project_path(project_root, normalized_consumer);
        let content = match std::fs::read_to_string(&consumer_abs) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let has_source_import = content.contains(&source_stem);

        // Deduplicate symbol names (in case index reports the same symbol twice)
        let mut unique_syms: Vec<String> = Vec::with_capacity(syms.len());
        for s in syms {
            if !unique_syms.contains(s) { unique_syms.push(s.clone()); }
        }

        // Rust: skip consumers that only reference the symbol via external crates
        // (e.g. tokio::runtime::block_on) — adding our import would shadow/conflict.
        if language == atls_core::Language::Rust
            && unique_syms.iter().all(|sym| rust_consumer_refs_only_external(&content, sym))
        {
            continue;
        }

        let new_import = match build_source_import_for_moved_symbols_with_root(
            normalized_consumer, target_file, &unique_syms, language,
            Some(project_root),
        ) {
            Some(imp) => imp,
            None => continue,
        };

        if dry_run {
            results.push(serde_json::json!({
                "consumer": normalized_consumer,
                "symbols": unique_syms,
                "action": "would_add_import",
                "import": new_import,
                "had_source_import": has_source_import,
            }));
            continue;
        }

        let mut updated = content.clone();
        if has_source_import {
            for sym in &unique_syms {
                updated = remove_symbol_from_import_line(&updated, sym, &source_stem, language);
            }
        }
        updated = insert_import_line(&updated, &new_import, language);
        if updated != content {
            if let Some(ref mut snaps) = pre_snapshots {
                snaps.entry(normalized_consumer.clone())
                    .or_insert_with(|| content.clone());
            }
            let _ = std::fs::write(&consumer_abs, &updated);
            results.push(serde_json::json!({
                "consumer": normalized_consumer,
                "symbols": unique_syms,
                "action": if has_source_import { "import_rewritten" } else { "import_added" },
                "new_import": new_import,
            }));
        }
    }
    results
}

/// For Rust: returns true if every reference to `symbol` in `content` is qualified with an
/// external crate path (tokio::, std::, core::, alloc::, etc.). Used to skip consumer
/// import updates when the file already uses the symbol from an external crate
/// (e.g. tokio::runtime::block_on) — adding our import would shadow or conflict.
pub(crate) fn rust_consumer_refs_only_external(content: &str, symbol: &str) -> bool {
    let external_prefixes: &[&str] = &[
        "tokio::", "std::", "core::", "alloc::", "io::", "fmt::",
        "serde::", "async_std::", "futures::", "rayon::",
    ];
    let word_re = match regex::Regex::new(&format!(r"\b{}\b", regex::escape(symbol))) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let mut has_any_ref = false;
    for line in content.lines() {
        for mat in word_re.find_iter(line) {
            has_any_ref = true;
            let start = mat.start();
            if start >= 2 && line.as_bytes()[start - 1] == b':' && line.as_bytes()[start - 2] == b':' {
                let path_before = &line[..start - 2];
                let first_segment = path_before.split("::").next().unwrap_or(path_before).trim();
                let is_external = external_prefixes
                    .iter()
                    .any(|prefix| first_segment == prefix.trim_end_matches(':'));
                if !is_external {
                    return false;
                }
            } else {
                return false; /* bare ref needs our import */
            }
        }
    }
    has_any_ref
}

/// Remove a single symbol name from an import line that references the given module.
/// If the symbol was the only import, removes the entire line.
pub(crate) fn remove_symbol_from_import_line(
    content: &str,
    symbol: &str,
    source_module: &str,
    language: atls_core::Language,
) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result = Vec::new();
    for line in &lines {
        let trimmed = line.trim();
        let is_relevant_import = match language {
            atls_core::Language::TypeScript | atls_core::Language::JavaScript => {
                trimmed.contains("import") && trimmed.contains(source_module) && trimmed.contains(symbol)
            }
            atls_core::Language::Rust => {
                trimmed.starts_with("use ") && trimmed.contains(symbol)
                    && (trimmed.contains(source_module) || trimmed.contains("self"))
            }
            atls_core::Language::Python => {
                (trimmed.starts_with("from ") || trimmed.starts_with("import "))
                    && trimmed.contains(source_module) && trimmed.contains(symbol)
            }
            _ => false,
        };
        if !is_relevant_import {
            result.push(line.to_string());
            continue;
        }
        // Try to remove just the symbol from a multi-import line
        match language {
            atls_core::Language::TypeScript | atls_core::Language::JavaScript => {
                if let (Some(open), Some(close)) = (trimmed.find('{'), trimmed.find('}')) {
                    let inner = &trimmed[open + 1..close];
                    let parts: Vec<&str> = inner.split(',')
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty() && *s != symbol)
                        .collect();
                    if parts.is_empty() {
                        // Was the only import — drop the line
                        continue;
                    }
                    let new_inner = parts.join(", ");
                    let new_line = format!("{}{{ {} }}{}", &trimmed[..open], new_inner, &trimmed[close + 1..]);
                    result.push(new_line);
                } else {
                    continue; // default import of just this symbol — drop
                }
            }
            atls_core::Language::Rust => {
                if let (Some(open), Some(close)) = (trimmed.find('{'), trimmed.rfind('}')) {
                    let inner = &trimmed[open + 1..close];
                    let parts: Vec<&str> = inner.split(',')
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty() && *s != symbol)
                        .collect();
                    if parts.is_empty() {
                        continue;
                    }
                    let new_inner = parts.join(", ");
                    let new_line = format!("{}{{{}}};", &trimmed[..open], new_inner);
                    result.push(new_line);
                } else if trimmed.ends_with(&format!("{}::{};", source_module, symbol))
                       || trimmed.ends_with(&format!("::{};", symbol)) {
                    continue;
                } else {
                    result.push(line.to_string());
                }
            }
            atls_core::Language::Python => {
                if trimmed.contains("import") {
                    let import_part = trimmed.splitn(2, "import").nth(1).unwrap_or("");
                    let cleaned = import_part.trim()
                        .trim_start_matches('(')
                        .trim_end_matches(')')
                        .trim();
                    let parts: Vec<&str> = cleaned.split(',')
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty() && *s != symbol && s.split(" as ").next().unwrap_or("").trim() != symbol)
                        .collect();
                    if parts.is_empty() {
                        continue;
                    }
                    let prefix = trimmed.splitn(2, "import").next().unwrap_or("");
                    let was_parenthesized = import_part.trim().starts_with('(');
                    if was_parenthesized {
                        result.push(format!("{}import ({})", prefix, parts.join(", ")));
                    } else {
                        result.push(format!("{}import {}", prefix, parts.join(", ")));
                    }
                } else {
                    result.push(line.to_string());
                }
            }
            _ => { result.push(line.to_string()); }
        }
    }
    result.join("\n")
}

/// Find the Rust crate/package name for a file by walking up to Cargo.toml.
/// Returns the [package] name from Cargo.toml, normalized for Rust (e.g. "atls-core" -> "atls_core").
fn rust_crate_name_for_path(file_path: &str, project_root: &std::path::Path) -> Option<String> {
    let resolved = resolve_project_path(project_root, file_path);
    let mut dir = resolved.parent()?.to_path_buf();
    loop {
        let cargo = dir.join("Cargo.toml");
        if cargo.exists() {
            if let Ok(content) = std::fs::read_to_string(&cargo) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("name = ") {
                        let name = trimmed[7..]
                            .trim_matches(|c| c == '"' || c == '\'')
                            .trim()
                            .to_string();
                        return Some(name.replace('-', "_"));
                    }
                }
            }
            return None;
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// True if both files belong to the same Rust crate (same Cargo.toml).
fn rust_same_crate(
    file_a: &str,
    file_b: &str,
    project_root: &std::path::Path,
) -> bool {
    match (rust_crate_name_for_path(file_a, project_root), rust_crate_name_for_path(file_b, project_root)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Build an import statement for `source_file` to import `symbol_names` from `target_file`.
/// `source_file` is the file that needs the import (consumer or original source).
/// For Rust, when project_root is provided and consumer is in a different crate than target,
/// generates `crate_name::path::symbol` instead of `crate::path::symbol`.
/// Returns None if no import is needed (same package in Go, or unsupported language).
pub(crate) fn build_source_import_for_moved_symbols(
    source_file: &str,
    target_file: &str,
    symbol_names: &[String],
    language: atls_core::Language,
) -> Option<String> {
    build_source_import_for_moved_symbols_with_root(source_file, target_file, symbol_names, language, None)
}

pub(crate) fn build_source_import_for_moved_symbols_with_root(
    source_file: &str,
    target_file: &str,
    symbol_names: &[String],
    language: atls_core::Language,
    project_root: Option<&std::path::Path>,
) -> Option<String> {
    let target_stem = std::path::Path::new(target_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let source_dir = std::path::Path::new(source_file).parent();
    let target_dir = std::path::Path::new(target_file).parent();

    match language {
        atls_core::Language::Go => {
            // Same directory = same Go package — no import needed
            if source_dir == target_dir {
                return None;
            }
            // Different directory: need an import. Symbols must be exported (capitalized)
            // to be importable. Derive path relative to the go.mod module root.
            let target_dir_path = std::path::Path::new(target_file).parent()?;

            // Try to find go.mod by walking up from the target directory.
            // Handles both absolute paths and paths relative to cwd.
            let abs_target_dir = if target_dir_path.is_absolute() {
                target_dir_path.to_path_buf()
            } else {
                std::env::current_dir().unwrap_or_default().join(target_dir_path)
            };
            let abs_target_dir_str = abs_target_dir.to_string_lossy().replace('\\', "/");

            let mut search = abs_target_dir.clone();
            let mut module_prefix: Option<String> = None;
            loop {
                let go_mod = search.join("go.mod");
                if go_mod.exists() {
                    if let Ok(content) = std::fs::read_to_string(&go_mod) {
                        for line in content.lines() {
                            let trimmed = line.trim();
                            if trimmed.starts_with("module ") {
                                module_prefix = Some(trimmed[7..].trim().to_string());
                                break;
                            }
                        }
                    }
                    break;
                }
                if !search.pop() { break; }
            }
            if let Some(mod_path) = module_prefix {
                let mod_root = {
                    let mut s = search.to_string_lossy().replace('\\', "/");
                    if !s.ends_with('/') { s.push('/'); }
                    s
                };
                let rel = if abs_target_dir_str.starts_with(&mod_root) {
                    &abs_target_dir_str[mod_root.len()..]
                } else {
                    ""
                };
                let import_path = if rel.is_empty() {
                    mod_path
                } else {
                    format!("{}/{}", mod_path, rel)
                };
                Some(format!("import \"{}\"", import_path))
            } else {
                // No go.mod found — compute relative path from source to target dir
                let target_dir_name = target_dir_path
                    .to_string_lossy()
                    .replace('\\', "/");
                if target_dir_name.is_empty() {
                    None
                } else {
                    Some(format!("import \"./{}\"", target_dir_name))
                }
            }
        }
        atls_core::Language::Java => {
            let new_pkg = derive_java_package_from_path(target_file);
            if let Some(pkg) = new_pkg {
                let pkg_name = pkg.trim_start_matches("package ").trim_end_matches(';').trim();
                let imports: Vec<String> = symbol_names.iter()
                    .map(|name| format!("import {}.{};", pkg_name, name))
                    .collect();
                Some(imports.join("\n"))
            } else {
                None
            }
        }
        atls_core::Language::Python => {
            let names = symbol_names.join(", ");
            if source_dir == target_dir {
                Some(format!("from .{} import {}", target_stem, names))
            } else {
                let rel = compute_relative_import_path(source_file, target_file);
                Some(format!("from {} import {}", rel, names))
            }
        }
        atls_core::Language::TypeScript | atls_core::Language::JavaScript => {
            let rel = if source_dir == target_dir {
                format!("./{}", target_stem)
            } else {
                let src_dir = std::path::Path::new(source_file).parent().unwrap_or(std::path::Path::new(""));
                let target_path = std::path::Path::new(target_file);
                let rel_path = compute_relative_path(src_dir, target_path);
                let rel_str = rel_path.to_string_lossy().replace('\\', "/");
                let without_ext = rel_str
                    .trim_end_matches(".ts")
                    .trim_end_matches(".tsx")
                    .trim_end_matches(".js")
                    .trim_end_matches(".jsx")
                    .trim_end_matches(".mjs")
                    .to_string();
                if without_ext.starts_with('.') { without_ext } else { format!("./{}", without_ext) }
            };
            Some(format!("import {{ {} }} from '{}';", symbol_names.join(", "), rel))
        }
        atls_core::Language::Rust => {
            let normalized = target_file.replace('\\', "/");
            let after_src = if let Some(pos) = normalized.rfind("/src/") {
                &normalized[pos + 5..]
            } else if normalized.starts_with("src/") {
                &normalized[4..]
            } else {
                return None;
            };
            let stem = after_src
                .trim_end_matches(".rs")
                .trim_end_matches("/mod");
            let crate_prefix = if let Some(root) = project_root {
                if rust_same_crate(source_file, target_file, root) {
                    "crate".to_string()
                } else {
                    rust_crate_name_for_path(target_file, root).unwrap_or_else(|| "crate".to_string())
                }
            } else {
                "crate".to_string()
            };
            let imports: Vec<String> = if stem == "lib" || stem == "main" {
                symbol_names.iter()
                    .map(|name| format!("use {}::{};", crate_prefix, name))
                    .collect()
            } else {
                let mod_path = stem.replace('/', "::");
                if mod_path.is_empty() {
                    return None;
                }
                symbol_names.iter()
                    .map(|name| format!("use {}::{}::{};", crate_prefix, mod_path, name))
                    .collect()
            };
            Some(imports.join("\n"))
        }
        atls_core::Language::CSharp => {
            None
        }
        _ => None,
    }
}

/// Compute a Python relative import path from source_file to target_file.
/// PEP 328: one dot = current package, each additional dot = one parent.
/// e.g. "src/services/foo.py" → "src/utils/bar.py" becomes "..utils.bar"
fn compute_relative_import_path(source_file: &str, target_file: &str) -> String {
    let src_dir = std::path::Path::new(source_file).parent().unwrap_or(std::path::Path::new(""));
    let target_path = std::path::Path::new(target_file);
    let target_stem = target_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let target_dir = target_path.parent().unwrap_or(std::path::Path::new(""));

    let rel = compute_relative_path(src_dir, target_dir);
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    if rel_str == "." {
        return format!(".{}", target_stem);
    }

    let parts: Vec<&str> = rel_str.split('/').collect();
    let up_count = parts.iter().filter(|&&p| p == "..").count();
    let down_parts: Vec<&str> = parts.iter().filter(|&&p| p != "..").copied().collect();

    let prefix = ".".repeat(up_count + 1);
    let mut segments: Vec<&str> = down_parts;
    segments.push(target_stem);
    format!("{}{}", prefix, segments.join("."))
}

/// Insert an import line into source code after the last existing
/// **module-level** import statement.  Inner-scope `use` statements
/// (indented inside fn/impl/mod blocks) are deliberately ignored so
/// the new import lands at the top of the file where it's visible
/// to the entire module.
pub(crate) fn insert_import_line(
    source: &str,
    import_line: &str,
    language: atls_core::Language,
) -> String {
    // Skip insertion if the import already exists (prevents duplicate imports)
    let trimmed_new = import_line.trim();
    if source.lines().any(|l| l.trim() == trimmed_new) {
        return source.to_string();
    }

    let lines: Vec<&str> = source.lines().collect();
    let mut last_import_idx: Option<usize> = None;
    // Track multi-line import blocks (Python `from X import (\n...\n)`,
    // Go `import (\n...\n)`, JS multi-line imports)
    let mut in_multiline_import = false;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        // If we're inside a multi-line import block, track until closing paren/brace
        if in_multiline_import {
            last_import_idx = Some(i);
            if trimmed.contains(')') || trimmed.contains('}') {
                in_multiline_import = false;
            }
            continue;
        }

        // Skip indented lines — they're inside fn/impl/mod blocks.
        // Module-level imports start at column 0 (no leading whitespace).
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }

        // Stop at first top-level code definition — imports/use statements
        // that appear after this point are inside function bodies or inline
        // modules and must not shift the insertion point.
        let is_code_def = trimmed.starts_with("fn ")
            || trimmed.starts_with("pub fn ")
            || trimmed.starts_with("pub(crate) fn ")
            || trimmed.starts_with("async fn ")
            || trimmed.starts_with("pub async fn ")
            || trimmed.starts_with("pub(crate) async fn ")
            || trimmed.starts_with("impl ")
            || trimmed.starts_with("struct ")
            || trimmed.starts_with("pub struct ")
            || trimmed.starts_with("pub(crate) struct ")
            || trimmed.starts_with("enum ")
            || trimmed.starts_with("pub enum ")
            || trimmed.starts_with("trait ")
            || trimmed.starts_with("pub trait ")
            || trimmed.starts_with("const ")
            || trimmed.starts_with("pub const ")
            || trimmed.starts_with("static ")
            || trimmed.starts_with("pub static ")
            || trimmed.starts_with("#[tauri::command")
            || trimmed.starts_with("type ")
            || trimmed.starts_with("pub type ");
        if is_code_def {
            break;
        }

        let is_import = match language {
            atls_core::Language::Go => {
                trimmed.starts_with("import ") || trimmed == "import (" || trimmed == ")"
                    || (trimmed.starts_with('"') && trimmed.ends_with('"'))
            }
            atls_core::Language::Java => trimmed.starts_with("import "),
            atls_core::Language::CSharp => trimmed.starts_with("using ") && trimmed.ends_with(';'),
            atls_core::Language::Python => {
                trimmed.starts_with("import ") || trimmed.starts_with("from ")
            }
            atls_core::Language::Rust => trimmed.starts_with("use ") || trimmed.starts_with("pub use "),
            atls_core::Language::TypeScript | atls_core::Language::JavaScript => {
                trimmed.starts_with("import ")
            }
            atls_core::Language::C | atls_core::Language::Cpp => {
                trimmed.starts_with("#include ")
            }
            _ => false,
        };
        if is_import {
            last_import_idx = Some(i);
            // Detect multi-line imports: line has `(` but no closing `)`
            let has_open = trimmed.contains('(');
            let has_close = trimmed.contains(')');
            if has_open && !has_close {
                in_multiline_import = true;
            }
        }
    }

    // Insert after the last import, or at the top if no imports found
    let insert_at = last_import_idx.map(|i| i + 1).unwrap_or(0);
    let mut result: Vec<&str> = Vec::with_capacity(lines.len() + 2);
    result.extend_from_slice(&lines[..insert_at]);
    // Add the import line(s) — may contain multiple lines for multi-symbol imports
    let import_lines: Vec<&str> = import_line.lines().collect();
    for il in &import_lines {
        result.push(il);
    }
    if insert_at < lines.len() {
        result.extend_from_slice(&lines[insert_at..]);
    }
    result.join("\n")
}

/// Strip common leading indentation from a code block.
/// Useful for Python methods extracted from a class: their 4-space indent becomes invalid
/// at module level. Computes the minimum indent of non-empty lines and strips that prefix.
pub(crate) fn dedent_code_body(code: &str) -> String {
    let lines: Vec<&str> = code.lines().collect();
    let min_indent = lines.iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    if min_indent == 0 {
        return code.to_string();
    }
    lines.iter()
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else if line.len() >= min_indent {
                line[min_indent..].to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn build_target_file_header(
    target_ext: &str,
    package_decl: Option<&str>,
    raw_imports: &[String],
    code_body: &str,
    target_path: &str,
) -> String {
    let filtered_imports = strip_self_referencing_imports(raw_imports, target_path);
    let filtered_imports = &filtered_imports;
    match target_ext {
        "cs" | "csx" => {
            let usings_block = if filtered_imports.is_empty() {
                String::new()
            } else {
                format!("{}\n\n", filtered_imports.join("\n"))
            };
            let ns = package_decl.unwrap_or("namespace Extracted;");
            // Detect if the code body is already a class/struct/interface declaration
            let body_trimmed = code_body.trim();
            let already_has_class = body_trimmed.contains("class ") 
                || body_trimmed.contains("struct ")
                || body_trimmed.contains("interface ")
                || body_trimmed.contains("enum ");
            if already_has_class {
                // Code already has its own type declaration, just add namespace
                if ns.ends_with(';') {
                    format!("{}{}\n\n{}", usings_block, ns, code_body)
                } else {
                    let indented = code_body.lines()
                        .map(|line| if line.trim().is_empty() { String::new() } else { format!("    {}", line) })
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("{}{}\n{{\n{}\n}}", usings_block, ns, indented)
                }
            } else {
                // Code is bare method(s) -- wrap in a class.
                // Generate class name from the first method name or use "ExtractedMembers"
                let class_name = {
                    // Try to extract method name from first line (e.g., "protected string GetTens")
                    let first_meaningful = body_trimmed.lines()
                        .find(|l| !l.trim().is_empty() && !l.trim().starts_with("//") && !l.trim().starts_with('#'));
                    first_meaningful
                        .and_then(|line| {
                            // Find method name: last identifier before '(' 
                            line.find('(').and_then(|paren_idx| {
                                let before_paren = line[..paren_idx].trim();
                                before_paren.split_whitespace().last().map(|s| s.to_string())
                            })
                        })
                        .map(|method| format!("{}Helpers", method))
                        .unwrap_or_else(|| "ExtractedMembers".to_string())
                };
                let is_file_scoped = ns.ends_with(';');
                let indent = if is_file_scoped { "    " } else { "        " };
                let indented = code_body.lines()
                    .map(|line| if line.trim().is_empty() { String::new() } else { format!("{}{}", indent, line) })
                    .collect::<Vec<_>>()
                    .join("\n");
                if is_file_scoped {
                    format!("{}{}\n\npublic class {}\n{{\n{}\n}}", usings_block, ns, class_name, indented)
                } else {
                    format!("{}{}\n{{\n    public class {}\n    {{\n{}\n    }}\n}}", usings_block, ns, class_name, indented)
                }
            }
        }
        "java" => {
            let pkg_line = package_decl
                .map(|p| format!("{}\n\n", p))
                .unwrap_or_default();
            let imports_block = if filtered_imports.is_empty() {
                String::new()
            } else {
                format!("{}\n\n", filtered_imports.join("\n"))
            };
            // Detect if code body already has a class declaration
            let body_trimmed = code_body.trim();
            let already_has_class = body_trimmed.contains("class ")
                || body_trimmed.contains("interface ")
                || body_trimmed.contains("enum ");
            if already_has_class {
                format!("{}{}{}", pkg_line, imports_block, code_body)
            } else {
                // Bare method(s) -- wrap in a class
                let class_name = {
                    let first_meaningful = body_trimmed.lines()
                        .find(|l| !l.trim().is_empty() && !l.trim().starts_with("//") && !l.trim().starts_with('#'));
                    first_meaningful
                        .and_then(|line| {
                            line.find('(').and_then(|paren_idx| {
                                let before_paren = line[..paren_idx].trim();
                                before_paren.split_whitespace().last().map(|s| s.to_string())
                            })
                        })
                        .map(|method| format!("{}Helpers", method))
                        .unwrap_or_else(|| "ExtractedMembers".to_string())
                };
                let indented = code_body.lines()
                    .map(|line| if line.trim().is_empty() { String::new() } else { format!("    {}", line) })
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("{}{}public class {} {{\n{}\n}}", pkg_line, imports_block, class_name, indented)
            }
        }
        "go" => {
            let pkg = package_decl.unwrap_or("package main");
            let imports_block = if filtered_imports.is_empty() {
                String::new()
            } else {
                format!("\nimport (\n{}\n)\n", filtered_imports.join("\n"))
            };
            let dedented = dedent_code_body(code_body);
            format!("{}\n{}\n{}", pkg, imports_block, dedented)
        }
        "rs" => {
            let imports_block = if filtered_imports.is_empty() {
                String::new()
            } else {
                format!("{}\n\n", filtered_imports.join("\n"))
            };
            let dedented = dedent_code_body(code_body);
            format!("{}{}", imports_block, dedented)
        }
        "py" | "pyi" | "pyw" => {
            let imports_block = if filtered_imports.is_empty() {
                String::new()
            } else {
                format!("{}\n\n", filtered_imports.join("\n"))
            };
            // Auto-dedent: if code body has uniform leading indentation (e.g., method
            // extracted from a class), strip the common indent to make it valid top-level.
            let dedented = dedent_code_body(code_body);
            format!("{}{}", imports_block, dedented)
        }
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            let imports_block = if filtered_imports.is_empty() {
                String::new()
            } else {
                format!("{}\n\n", filtered_imports.join("\n"))
            };
            let dedented = dedent_code_body(code_body);
            format!("{}{}", imports_block, dedented)
        }
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" | "h" | "c" => {
            let includes_block = if filtered_imports.is_empty() {
                String::new()
            } else {
                format!("{}\n\n", filtered_imports.join("\n"))
            };
            let dedented = dedent_code_body(code_body);
            if let Some(ns) = package_decl {
                let ns_name = ns.trim_start_matches("namespace ")
                    .trim_end_matches('{')
                    .trim();
                format!(
                    "{}namespace {} {{\n\n{}\n\n}} // namespace {}",
                    includes_block, ns_name, dedented, ns_name
                )
            } else {
                format!("{}{}", includes_block, dedented)
            }
        }
        _ => dedent_code_body(code_body),
    }
}

/// High-level entry point for building extracted target file content.
/// Internalizes all import/export handling:
///  1. Extracts imports from the source file via `extract_file_context`
///  2. Filters imports to only those referenced by the code body
///  3. Strips self-referencing imports (pointing at the target file)
///  4. Deduplicates against existing target content (merge path)
///  5. Auto-adds export/pub visibility to extracted declarations
///  6. Builds language-aware scaffolding (package/namespace/class wrappers)
pub(crate) fn build_extracted_target(
    source_content: &str,
    source_path: &str,
    code_body: &str,
    target_path: &str,
    existing_target: Option<&str>,
    project: &atls_core::AtlsProject,
) -> String {
    let target_ext = std::path::Path::new(target_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("ts");

    let ctx = extract_file_context(source_content, source_path, project);
    let filtered_imports = filter_imports_for_code(&ctx.import_lines, code_body, ctx.language);

    let exported_body = ensure_exported(code_body, target_ext);

    if let Some(existing) = existing_target {
        merge_into_existing_target(existing, &filtered_imports, &exported_body, target_ext, target_path)
    } else {
        build_target_file_header(target_ext, ctx.package_decl.as_deref(), &filtered_imports, &exported_body, target_path)
    }
}

/// Add visibility/export keywords to extracted declarations when missing.
///
/// JS/TS: `function foo` → `export function foo`, `const x` → `export const x`, etc.
/// Rust: `fn foo` → `pub fn foo`, `struct Foo` → `pub struct Foo`, etc.
/// Go: already uses capitalization (handled by `promote_go_symbol_visibility`).
/// Java/C#/C++: wrapped in class by `build_target_file_header`, visibility on class is enough.
fn ensure_exported(code_body: &str, target_ext: &str) -> String {
    match target_ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => ensure_exported_js(code_body),
        "rs" => ensure_exported_rust(code_body),
        "py" | "pyi" | "pyw" => code_body.to_string(), // Python: all top-level is public
        "go" => code_body.to_string(), // Go: capitalization-based, handled separately
        _ => code_body.to_string(), // Java/C#/C++: class wrapper handles visibility
    }
}

/// For JS/TS: prefix top-level declarations with `export` if not already exported.
fn ensure_exported_js(code_body: &str) -> String {
    code_body
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
                return line.to_string();
            }
            if trimmed.starts_with("export ") || trimmed.starts_with("import ") {
                return line.to_string();
            }
            let leading_len = line.len() - trimmed.len();
            // Only export declarations at column 0 (top-level); anything indented
            // is a local variable/function inside a block and must NOT be exported.
            if leading_len > 0 {
                return line.to_string();
            }
            let decl_prefixes = [
                "function ", "async function ",
                "class ", "abstract class ",
                "interface ", "type ",
                "const ", "let ", "var ",
                "enum ",
            ];
            for prefix in &decl_prefixes {
                if trimmed.starts_with(prefix) {
                    return format!("export {}", trimmed);
                }
            }
            if trimmed.starts_with("default ") {
                return format!("export {}", trimmed);
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// For Rust: prefix top-level items with `pub` if not already pub.
fn ensure_exported_rust(code_body: &str) -> String {
    code_body
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') || trimmed.starts_with('#') {
                return line.to_string();
            }
            if trimmed.starts_with("pub ") || trimmed.starts_with("pub(") {
                return line.to_string();
            }
            let leading_len = line.len() - trimmed.len();
            // Only add pub to declarations at column 0 (top-level); anything
            // indented is inside a block (impl, fn body, etc.) and must stay private.
            if leading_len > 0 {
                return line.to_string();
            }
            let decl_prefixes = [
                "fn ", "async fn ", "unsafe fn ",
                "struct ", "enum ", "trait ", "type ",
                "const ", "static ",
                "mod ", "use ",
                "impl ",
            ];
            for prefix in &decl_prefixes {
                if trimmed.starts_with(prefix) {
                    if prefix == &"impl " || prefix == &"use " {
                        return line.to_string();
                    }
                    return format!("pub {}", trimmed);
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Remove imports that reference the target file itself.
/// Covers Rust (`use crate::…::stem::`), JS/TS (`from './stem'`), and
/// Python (`from .stem import`).
fn strip_self_referencing_imports(imports: &[String], target_path: &str) -> Vec<String> {
    let target_stem = std::path::Path::new(target_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if target_stem.is_empty() {
        return imports.to_vec();
    }
    imports.iter().filter(|imp| {
        let t = imp.trim();
        if t.starts_with("use ") && t.contains(&format!("::{}::", target_stem)) {
            return false;
        }
        if t.contains(&format!("from './{}'", target_stem))
            || t.contains(&format!("from \"./{}\"", target_stem)) {
            return false;
        }
        if t.starts_with(&format!("from .{} import", target_stem)) {
            return false;
        }
        true
    }).cloned().collect()
}

/// Merge a newly extracted function into an existing target file that was
/// already written by a prior extract op in the same batch.  Handles:
///  - Self-referencing import removal (imports pointing at the target file)
///  - Line-level import deduplication against existing content
///  - Go `import ( … )` block insertion
///  - Java / C# class-wrapper insertion (code goes inside the class)
///  - C++ namespace-wrapper insertion
///  - Flat languages (TS/JS/Rust/Python/Go-without-block/fallback): append
pub(crate) fn merge_into_existing_target(
    existing: &str,
    raw_imports: &[String],
    code_body: &str,
    target_ext: &str,
    target_path: &str,
) -> String {
    let mut merged = existing.to_string();

    // ── 1. Clean imports: strip self-refs, then dedup against existing ──
    let cleaned = strip_self_referencing_imports(raw_imports, target_path);
    let existing_line_set: std::collections::HashSet<&str> = existing
        .lines().map(|l| l.trim()).collect();
    let unique: Vec<String> = cleaned.into_iter()
        .filter(|imp| !existing_line_set.contains(imp.trim()))
        .collect();

    // ── 2. Import insertion ─────────────────────────────────────────────
    if !unique.is_empty() {
        match target_ext {
            "go" => merge_imports_go(&mut merged, &unique),
            _    => merge_imports_generic(&mut merged, &unique),
        }
    }

    // ── 2. Code-body insertion ──────────────────────────────────────────
    match target_ext {
        "java" => insert_before_wrapper(&mut merged, code_body),
        "cs" | "csx" => insert_before_wrapper(&mut merged, code_body),
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" | "h" | "c" => {
            if has_namespace_wrapper(&merged) {
                insert_before_wrapper(&mut merged, code_body);
            } else {
                append_flat(&mut merged, code_body);
            }
        }
        _ => append_flat(&mut merged, code_body),
    }

    merged
}

/// Returns `true` if the file looks like it has a `namespace … { … }` wrapper
/// (C++ style, including `} // namespace …` closers).
fn has_namespace_wrapper(content: &str) -> bool {
    let has_ns_open = content.lines().any(|l| {
        let t = l.trim();
        t.starts_with("namespace ") && t.ends_with('{')
    });
    let has_ns_close = content.lines().rev().take(5).any(|l| {
        let t = l.trim();
        t.starts_with("} //") && t.contains("namespace")
    });
    has_ns_open || has_ns_close
}

fn is_import_line(trimmed: &str) -> bool {
    trimmed.starts_with("import ")
        || trimmed.starts_with("use ")
        || trimmed.starts_with("pub use ")
        || trimmed.starts_with("from ")
        || trimmed.starts_with("require ")
        || trimmed.starts_with("require(")
        || trimmed.starts_with("require_once")
        || trimmed.starts_with("#include")
        || trimmed.starts_with("#import")
        || trimmed.starts_with("using ")
        || trimmed.starts_with("@import")
}

/// Insert new imports into a Go file, respecting the `import ( … )` block.
fn merge_imports_go(merged: &mut String, new_imports: &[String]) {
    // Find the closing `)` of the import block.
    let lines: Vec<&str> = merged.lines().collect();
    let mut import_block_close: Option<usize> = None;
    let mut in_import_block = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.starts_with("import (") || t == "import (" {
            in_import_block = true;
        }
        if in_import_block && t == ")" {
            import_block_close = Some(i);
            break;
        }
    }

    if let Some(close_idx) = import_block_close {
        let import_text = new_imports.join("\n");
        let mut new_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        new_lines.insert(close_idx, import_text);
        *merged = new_lines.join("\n");
    } else {
        // No import block found. Create one after the `package` line.
        let mut pkg_idx = 0;
        for (i, line) in lines.iter().enumerate() {
            if line.trim().starts_with("package ") {
                pkg_idx = i + 1;
                break;
            }
        }
        let block = format!("\nimport (\n{}\n)", new_imports.join("\n"));
        let mut new_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        new_lines.insert(pkg_idx, block);
        *merged = new_lines.join("\n");
    }
}

/// Insert new imports after the last import line for non-Go languages.
fn merge_imports_generic(merged: &mut String, new_imports: &[String]) {
    let lines: Vec<&str> = merged.lines().collect();
    let mut last_import_idx: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if is_import_line(line.trim()) {
            last_import_idx = Some(i);
        }
    }
    let insert_at = match last_import_idx {
        Some(idx) => idx + 1,
        None => {
            // No imports found; insert after package/namespace declaration or at top.
            let mut decl_end = 0;
            for (i, line) in lines.iter().enumerate() {
                let t = line.trim();
                if t.starts_with("package ") || t.starts_with("namespace ") {
                    decl_end = i + 1;
                    // Skip a blank line after the declaration if present.
                    if decl_end < lines.len() && lines[decl_end].trim().is_empty() {
                        decl_end += 1;
                    }
                    break;
                }
            }
            decl_end
        }
    };
    let import_block = new_imports.join("\n");
    let mut new_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    new_lines.insert(insert_at, import_block);
    *merged = new_lines.join("\n");
}

/// Append a code body at the end of a flat (non-wrapped) file.
fn append_flat(merged: &mut String, code_body: &str) {
    let trimmed_end = merged.trim_end();
    merged.truncate(trimmed_end.len());
    merged.push_str("\n\n");
    merged.push_str(code_body);
    merged.push('\n');
}

/// Insert a code body before the innermost closing `}` wrapper brace,
/// with indentation matching the existing code inside that block.
/// Works for Java class wrappers, C# namespace+class, and C++ namespace.
fn insert_before_wrapper(merged: &mut String, code_body: &str) {
    let lines: Vec<&str> = merged.lines().collect();
    if lines.is_empty() {
        append_flat(merged, code_body);
        return;
    }

    // Walk backwards to find the innermost `}` that closes a structural block.
    // Skip trailing empty lines first.
    let mut cursor = lines.len();
    while cursor > 0 && lines[cursor - 1].trim().is_empty() {
        cursor -= 1;
    }

    // Walk backwards through consecutive closing braces.  We always keep
    // updating `insert_line` so we end up with the *innermost* closer
    // (closest to actual code).  For C# / Java with namespace + class:
    //     }   ← class   (inner, line N-1) — we insert before THIS
    //   }     ← namespace (outer, line N)
    let mut insert_line: Option<usize> = None;
    while cursor > 0 {
        cursor -= 1;
        let t = lines[cursor].trim();
        if t.starts_with('}') {
            insert_line = Some(cursor);
        } else {
            break;
        }
    }

    let insert_idx = match insert_line {
        Some(idx) => idx,
        None => {
            // No trailing `}` found — treat as flat.
            append_flat(merged, code_body);
            return;
        }
    };

    // Detect indentation: look at the last non-empty content line above
    // the closing braces. Its leading whitespace is the indent level.
    let indent = {
        let mut probe = insert_idx;
        let mut detected = "";
        while probe > 0 {
            probe -= 1;
            let line = lines[probe];
            if !line.trim().is_empty() && !line.trim().starts_with('}') && !line.trim().starts_with('{') {
                let stripped = line.trim_start();
                let leading = &line[..line.len() - stripped.len()];
                detected = leading;
                break;
            }
        }
        detected.to_string()
    };

    // Indent the new code body to match.
    let indented_body: String = code_body.lines()
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else {
                format!("{}{}", indent, line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut new_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    // Insert blank line + indented code before the closing brace.
    new_lines.insert(insert_idx, format!("\n{}", indented_body));
    *merged = new_lines.join("\n");
}

/// Check whether `token` appears in `code` as a whole identifier
/// (surrounded by non-alphanumeric, non-underscore characters).
pub(crate) fn is_identifier_match(code: &str, token: &str) -> bool {
    let bytes = code.as_bytes();
    for (idx, _) in code.match_indices(token) {
        let before_ok = idx == 0 || {
            let b = bytes[idx - 1];
            !b.is_ascii_alphanumeric() && b != b'_'
        };
        let after_idx = idx + token.len();
        let after_ok = after_idx >= bytes.len() || {
            let b = bytes[after_idx];
            !b.is_ascii_alphanumeric() && b != b'_'
        };
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

/// Check whether a single import line is referenced by the extracted code.
pub(crate) fn import_is_referenced(
    import_line: &str,
    code: &str,
    language: atls_core::Language,
) -> bool {
    let tokens = extract_import_tokens(import_line, language);
    if tokens.is_empty() {
        // Side-effect-only imports (CSS, polyfills) — exclude by default.
        // These rarely belong in extracted files. Known side-effect patterns
        // like CSS imports are intentional and should be added manually.
        return false;
    }
    for token in &tokens {
        if token.len() < 2 {
            continue;
        }
        if is_identifier_match(code, token) {
            return true;
        }
    }
    false
}

// ── Tree-sitter AST-based reference collection for Rust ──

pub(crate) fn ts_node_text(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let s = node.start_byte();
    let e = node.end_byte();
    if s <= e && e <= source.len() {
        Some(source[s..e].to_string())
    } else {
        None
    }
}

/// Walk a `scoped_identifier` / `scoped_type_identifier` to find the
/// leftmost (root) path segment.  `io::Result<()>` → `"io"`.
pub(crate) fn ts_root_path_segment(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut current = *node;
    loop {
        if let Some(path) = current.child_by_field_name("path") {
            match path.kind() {
                "identifier" | "type_identifier" | "crate" | "super" | "self" => {
                    return ts_node_text(&path, source);
                }
                "scoped_identifier" | "scoped_type_identifier" => {
                    current = path;
                    continue;
                }
                _ => return ts_node_text(&path, source),
            }
        }
        break;
    }
    ts_node_text(node, source)
        .map(|t| t.split("::").next().unwrap_or("").to_string())
}

/// Map well-known trait method names (as they appear in `Type::method()` calls)
/// to the trait name that must be in scope.
pub(crate) fn trait_name_for_method(method: &str) -> Option<&'static str> {
    match method {
        "from_str" => Some("FromStr"),
        "from" => Some("From"),
        "into" => Some("Into"),
        "try_from" => Some("TryFrom"),
        "try_into" => Some("TryInto"),
        "as_ref" => Some("AsRef"),
        "as_mut" => Some("AsMut"),
        "default" => Some("Default"),
        "clone" => Some("Clone"),
        "to_string" => Some("ToString"),
        "to_owned" => Some("ToOwned"),
        "fmt" => Some("Display"),
        "hash" => Some("Hash"),
        "partial_cmp" => Some("PartialOrd"),
        "cmp" => Some("Ord"),
        _ => None,
    }
}

/// Recursively walk the AST, collecting every externally-referenced
/// identifier (types, functions, modules, macros).
pub(crate) fn collect_rust_refs_walk(
    node: &tree_sitter::Node,
    source: &str,
    refs: &mut std::collections::HashSet<String>,
) {
    match node.kind() {
        "type_identifier" => {
            if let Some(text) = ts_node_text(node, source) {
                if text.len() > 1 {
                    refs.insert(text);
                }
            }
        }
        "scoped_type_identifier" | "scoped_identifier" => {
            // Only collect the ROOT path segment — that's what determines
            // the import.  Inner segments (e.g. `Write` in `io::Write`)
            // don't need standalone imports; the root (`io`) provides access.
            // Bare type_identifiers are already handled by the case above.
            // MUST return to prevent general recursion from also collecting
            // the leaf type_identifier child (e.g. `Write` from `io::Write`),
            // which would cause spurious imports like `use core::fmt::Write;`.
            if let Some(root) = ts_root_path_segment(node, source) {
                if root.len() > 1 {
                    refs.insert(root);
                }
            }
            return;
        }
        "call_expression" => {
            if let Some(func) = node.child_by_field_name("function") {
                match func.kind() {
                    "identifier" => {
                        if let Some(t) = ts_node_text(&func, source) {
                            refs.insert(t);
                        }
                    }
                    "scoped_identifier" => {
                        if let Some(root) = ts_root_path_segment(&func, source) {
                            if root.len() > 1 { refs.insert(root); }
                        }
                        // Trait-method resolution: check the leaf
                        // function name for well-known trait methods.
                        if let Some(full) = ts_node_text(&func, source) {
                            let segments: Vec<&str> = full.split("::").collect();
                            if let Some(last) = segments.last() {
                                let method_name = last.trim();
                                if let Some(trait_name) = trait_name_for_method(method_name) {
                                    refs.insert(trait_name.to_string());
                                }
                            }
                        }
                    }
                    "field_expression" => {
                        if let Some(field) = func.child_by_field_name("field") {
                            if let Some(method_name) = ts_node_text(&field, source) {
                                if let Some(trait_name) = trait_name_for_method(&method_name) {
                                    refs.insert(trait_name.to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                collect_rust_refs_walk(&child, source, refs);
            }
            return;
        }
        "macro_invocation" => {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "identifier" {
                    if let Some(t) = ts_node_text(&child, source) {
                        refs.insert(t);
                    }
                    break;
                }
            }
        }
        "token_tree" => {
            // Inside macro arguments, tree-sitter doesn't produce structured
            // AST (call_expression, etc.) — only flat tokens.  Collect
            // identifier/type_identifier tokens so references to functions
            // and types inside macros (e.g. `tri!(func(a, b))`) are visible
            // for import resolution and visibility upgrades.
            fn collect_token_tree_refs(
                node: &tree_sitter::Node,
                source: &str,
                refs: &mut std::collections::HashSet<String>,
            ) {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    match child.kind() {
                        "identifier" | "type_identifier" => {
                            if let Some(t) = ts_node_text(&child, source) {
                                if t.len() > 1 {
                                    refs.insert(t);
                                }
                            }
                        }
                        "token_tree" => collect_token_tree_refs(&child, source, refs),
                        _ => {}
                    }
                }
            }
            collect_token_tree_refs(node, source, refs);
            return;
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_rust_refs_walk(&child, source, refs);
    }
}

/// Parse Rust code with tree-sitter and return every externally-referenced
/// identifier (types, functions, modules, macros) as a set.
pub(crate) fn collect_rust_ast_references(
    code: &str,
    parser_registry: &atls_core::parser::ParserRegistry,
) -> std::collections::HashSet<String> {
    let mut refs = std::collections::HashSet::new();

    let tree = match parser_registry.parse(atls_core::Language::Rust, code) {
        Ok(t) => t,
        Err(_) => return refs,
    };

    collect_rust_refs_walk(&tree.root_node(), code, &mut refs);

    // Only strip true keywords and primitive types that NEVER need imports.
    // Do NOT strip String, Vec, Box, Option, Result, etc. — in no_std/alloc
    // crates these require explicit imports from `alloc` or `core`.
    for kw in &[
        "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128",
        "isize", "u8", "u16", "u32", "u64", "u128", "usize", "str",
        "Self", "self", "super", "crate", "true", "false",
    ] {
        refs.remove(*kw);
    }

    refs
}

/// Keep only the source-file imports whose symbols appear in `ast_refs`.
/// For brace-group imports (`use foo::{A, B, C};`), prune individual
/// items that are not referenced, collapsing to a single-item import
/// when only one remains.
pub(crate) fn filter_rust_imports_by_ast(
    import_lines: &[String],
    ast_refs: &std::collections::HashSet<String>,
) -> Vec<String> {
    if ast_refs.is_empty() {
        return import_lines.to_vec();
    }
    let mut out = Vec::new();
    for line in import_lines {
        let trimmed = line.trim();

        let (prefix, inner) = if trimmed.starts_with("pub use ") {
            ("pub use ", trimmed.strip_prefix("pub use ").unwrap_or(""))
        } else if trimmed.starts_with("use ") {
            ("use ", trimmed.strip_prefix("use ").unwrap_or(""))
        } else {
            out.push(line.clone());
            continue;
        };
        let inner = inner.trim_end_matches(';').trim();

        if inner.contains('*') {
            out.push(line.clone());
            // Glob imports (`use Foo::*`) bring child items into scope
            // but NOT the parent type name itself.  If the parent type
            // (e.g. `CharEscape` in `use crate::ser::CharEscape::*`)
            // is referenced as a type, emit an explicit import for it.
            let glob_parent = inner.trim_end_matches("::*");
            if let Some(parent_name) = glob_parent.rsplit("::").next() {
                if ast_refs.contains(parent_name) {
                    let parent_import = format!("{}{};", prefix, glob_parent);
                    if !out.contains(&parent_import) {
                        out.push(parent_import);
                    }
                }
            }
            continue;
        }

        if let Some(brace_start) = inner.find('{') {
            if let Some(brace_end) = inner.find('}') {
                let module_path = inner[..brace_start].trim_end_matches("::").trim();
                let items: Vec<&str> = inner[brace_start + 1..brace_end]
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();

                // `self` in a brace group (e.g. `use core::fmt::{self, Display}`)
                // brings the module itself into scope.  Only keep it when
                // the module name is actually referenced (e.g. `fmt::Write`).
                let mod_name = module_path.rsplit("::").next().unwrap_or(module_path);
                let keep_self = ast_refs.contains(mod_name);

                let kept: Vec<&str> = items.into_iter().filter(|item| {
                    let sym = item.split(" as ").next().unwrap_or(item).trim();
                    if sym == "self" { keep_self } else { ast_refs.contains(sym) }
                }).collect();

                if kept.is_empty() {
                    continue;
                }
                if kept.len() == 1 && kept[0] != "self" {
                    let sym = kept[0];
                    out.push(format!("{}{}::{};", prefix, module_path, sym));
                } else {
                    out.push(format!("{}{}::{{{}}};", prefix, module_path, kept.join(", ")));
                }
                continue;
            }
        }

        let tokens = extract_import_tokens(line, atls_core::Language::Rust);
        if tokens.is_empty() {
            out.push(line.clone());
            continue;
        }
        if tokens.iter().any(|tok| ast_refs.contains(tok.as_str())) {
            out.push(line.clone());
        }
    }
    out
}

/// Parse the source file and find the `impl` block or `trait` definition
/// enclosing `target_line` (1-based).
/// Returns `(type_name, is_trait)`:
///   - impl block: `("CompactFormatter", false)`
///   - trait definition: `("Formatter", true)`
pub(crate) fn find_rust_impl_type_for_line(
    source: &str,
    target_line: u32,
    parser_registry: &atls_core::parser::ParserRegistry,
) -> Option<(String, bool)> {
    let tree = parser_registry.parse(atls_core::Language::Rust, source).ok()?;
    find_enclosing_self_context(&tree.root_node(), source, target_line)
}

pub(crate) fn find_enclosing_self_context(
    node: &tree_sitter::Node,
    source: &str,
    target_line: u32,
) -> Option<(String, bool)> {
    let start = node.start_position().row as u32 + 1;
    let end = node.end_position().row as u32 + 1;

    if start <= target_line && target_line <= end {
        if node.kind() == "impl_item" {
            if let Some(type_node) = node.child_by_field_name("type") {
                let name = match type_node.kind() {
                    "type_identifier" => ts_node_text(&type_node, source),
                    "generic_type" => {
                        type_node.child_by_field_name("type")
                            .and_then(|base| ts_node_text(&base, source))
                            .or_else(|| ts_node_text(&type_node, source))
                    }
                    _ => ts_node_text(&type_node, source),
                };
                if let Some(n) = name {
                    return Some((n, false));
                }
            }
        }

        if node.kind() == "trait_item" {
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Some(n) = ts_node_text(&name_node, source) {
                    return Some((n, true));
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(result) = find_enclosing_self_context(&child, source, target_line) {
            return Some(result);
        }
    }
    None
}

/// Tree-sitter fallback: find a named function/method in Rust source by
/// parsing the AST directly.  Returns `(start_line_1based, end_line_1based, name, kind)`.
/// Used when the symbol database is stale.
pub(crate) fn find_rust_symbol_by_parsing(
    source: &str,
    symbol_name: &str,
    parser_registry: &atls_core::parser::ParserRegistry,
) -> Option<(u32, u32, String, String)> {
    let tree = parser_registry.parse(atls_core::Language::Rust, source).ok()?;
    find_rust_symbol_walk(&tree.root_node(), source, symbol_name)
}

pub(crate) fn find_rust_symbol_walk(
    node: &tree_sitter::Node,
    source: &str,
    symbol_name: &str,
) -> Option<(u32, u32, String, String)> {
    match node.kind() {
        "function_item" | "function_signature_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Some(name) = ts_node_text(&name_node, source) {
                    if name == symbol_name {
                        let start = node.start_position().row as u32 + 1;
                        let end = node.end_position().row as u32 + 1;
                        return Some((start, end, name, "function".to_string()));
                    }
                }
            }
        }
        "struct_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Some(name) = ts_node_text(&name_node, source) {
                    if name == symbol_name {
                        let start = node.start_position().row as u32 + 1;
                        let end = node.end_position().row as u32 + 1;
                        return Some((start, end, name, "struct".to_string()));
                    }
                }
            }
        }
        "enum_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Some(name) = ts_node_text(&name_node, source) {
                    if name == symbol_name {
                        let start = node.start_position().row as u32 + 1;
                        let end = node.end_position().row as u32 + 1;
                        return Some((start, end, name, "enum".to_string()));
                    }
                }
            }
        }
        "type_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Some(name) = ts_node_text(&name_node, source) {
                    if name == symbol_name {
                        let start = node.start_position().row as u32 + 1;
                        let end = node.end_position().row as u32 + 1;
                        return Some((start, end, name, "type".to_string()));
                    }
                }
            }
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(result) = find_rust_symbol_walk(&child, source, symbol_name) {
            return Some(result);
        }
    }
    None
}

/// Find a named symbol in any supported language using UHPP regex extraction.
/// Returns `(start_line_1based, end_line_1based, name, kind)`.
/// Falls back to language-specific Rust tree-sitter helper for Rust (for
/// complexity/scope precision).
pub(crate) fn find_symbol_by_parsing(
    source: &str,
    symbol_name: &str,
    language: atls_core::Language,
    parser_registry: &atls_core::parser::ParserRegistry,
) -> Option<(u32, u32, String, String)> {
    if language == atls_core::Language::Rust {
        return find_rust_symbol_by_parsing(source, symbol_name, parser_registry);
    }
    let lang_str = language.as_str();
    let symbols = atls_core::indexer::uhpp_extract_symbols(source, Some(lang_str));
    symbols.into_iter()
        .filter(|s| s.name == symbol_name)
        .max_by_key(|s| {
            let span = s.end_line.unwrap_or(s.line).saturating_sub(s.line);
            let kind_priority: u32 = match s.kind.as_str() {
                "function" | "method" | "constructor" => 2,
                "class" | "struct" | "interface" | "enum" | "record" | "protocol" | "actor" | "union" => 1,
                _ => 0,
            };
            (kind_priority, span)
        })
        .map(|s| {
            let end = s.end_line.unwrap_or(s.line);
            (s.line, end, s.name, s.kind.as_str().to_string())
        })
}

/// Extract parameter names from a Rust function's signature using tree-sitter.
/// Returns names in declaration order, excluding `self` variants.
pub(crate) fn extract_rust_fn_param_names(
    code: &str,
    parser_registry: &atls_core::parser::ParserRegistry,
) -> Vec<String> {
    let tree = match parser_registry.parse(atls_core::Language::Rust, code) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let root = tree.root_node();
    fn find_fn_params(node: &tree_sitter::Node, source: &str) -> Option<Vec<String>> {
        match node.kind() {
            "function_item" | "function_signature_item" => {
                if let Some(params) = node.child_by_field_name("parameters") {
                    let mut names = Vec::new();
                    let mut cursor = params.walk();
                    for child in params.children(&mut cursor) {
                        match child.kind() {
                            "self_parameter" | "reference_self_parameter"
                            | "mut_self_parameter" => continue,
                            "parameter" => {
                                if let Some(pat) = child.child_by_field_name("pattern") {
                                    if let Some(name) = ts_node_text(&pat, source) {
                                        names.push(name);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    return Some(names);
                }
            }
            _ => {}
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(result) = find_fn_params(&child, source) {
                return Some(result);
            }
        }
        None
    }
    find_fn_params(&root, code).unwrap_or_default()
}

/// Emit `use` lines for well-known std/core types that `ast_refs` references
/// but `existing_imports` doesn't already cover.
///
/// `source_module_symbols` — symbol names defined in the source module.
/// When a referenced identifier exists in the source module we SKIP the
/// std/core fallback because the source-module import has already been
/// added by the caller (prevents e.g. emitting `use core::fmt::Formatter`
/// when the crate defines its own `Formatter` trait).
pub(crate) fn discover_missing_rust_imports(
    ast_refs: &std::collections::HashSet<String>,
    existing_imports: &[String],
    source_module_symbols: &std::collections::HashSet<String>,
) -> Vec<String> {
    static KNOWN_PATHS: &[(&str, &str)] = &[
        ("FromStr",     "use core::str::FromStr;"),
        ("ToString",    "use alloc::string::ToString;"),
        ("ToOwned",     "use alloc::borrow::ToOwned;"),
        ("Display",     "use core::fmt::Display;"),
        ("Formatter",   "use core::fmt::Formatter;"),
        ("Debug",       "use core::fmt::Debug;"),
        ("Write",       "use core::fmt::Write;"),
        ("From",        "use core::convert::From;"),
        ("Into",        "use core::convert::Into;"),
        ("TryFrom",     "use core::convert::TryFrom;"),
        ("TryInto",     "use core::convert::TryInto;"),
        ("AsRef",       "use core::convert::AsRef;"),
        ("AsMut",       "use core::convert::AsMut;"),
        ("Iterator",    "use core::iter::Iterator;"),
        ("IntoIterator","use core::iter::IntoIterator;"),
        ("Default",     "use core::default::Default;"),
        ("Hash",        "use core::hash::Hash;"),
        ("Hasher",      "use core::hash::Hasher;"),
        ("Ord",         "use core::cmp::Ord;"),
        ("PartialOrd",  "use core::cmp::PartialOrd;"),
        ("Eq",          "use core::cmp::Eq;"),
        ("PartialEq",   "use core::cmp::PartialEq;"),
        ("Ordering",    "use core::cmp::Ordering;"),
        ("Error",       "use std::error::Error;"),
        ("HashMap",     "use std::collections::HashMap;"),
        ("HashSet",     "use std::collections::HashSet;"),
        ("BTreeMap",    "use std::collections::BTreeMap;"),
        ("BTreeSet",    "use std::collections::BTreeSet;"),
        ("VecDeque",    "use std::collections::VecDeque;"),
        ("BinaryHeap",  "use std::collections::BinaryHeap;"),
        ("Path",        "use std::path::Path;"),
        ("PathBuf",     "use std::path::PathBuf;"),
        ("File",        "use std::fs::File;"),
        ("Read",        "use std::io::Read;"),
        ("BufRead",     "use std::io::BufRead;"),
        ("Seek",        "use std::io::Seek;"),
        ("BufReader",   "use std::io::BufReader;"),
        ("BufWriter",   "use std::io::BufWriter;"),
        ("Cow",         "use std::borrow::Cow;"),
        ("Arc",         "use std::sync::Arc;"),
        ("Mutex",       "use std::sync::Mutex;"),
        ("RwLock",      "use std::sync::RwLock;"),
        ("Rc",          "use std::rc::Rc;"),
        ("RefCell",     "use std::cell::RefCell;"),
        ("Cell",        "use std::cell::Cell;"),
        ("Pin",         "use core::pin::Pin;"),
        ("PhantomData", "use core::marker::PhantomData;"),
        ("NonZeroUsize","use core::num::NonZeroUsize;"),
    ];

    let existing_joined = existing_imports.join("\n");
    let mut extra: Vec<String> = Vec::new();

    for &(ident, use_line) in KNOWN_PATHS {
        if !ast_refs.contains(ident) {
            continue;
        }
        // Symbol is defined in the source module — a crate-level import
        // was already added; don't shadow it with a std/core path.
        if source_module_symbols.contains(ident) {
            continue;
        }
        if existing_joined.contains(ident) {
            continue;
        }
        extra.push(use_line.to_string());
    }
    extra
}

/// Analyze extracted code for references to symbols defined in the source file
/// that are NOT being extracted. Returns a list of missing dependency descriptions.
/// This helps detect: private fields (Java), unexported types (Go), local types (Rust), etc.
pub(crate) fn analyze_missing_dependencies(
    extracted_code: &str,
    source_file: &str,
    extracted_symbol_names: &[String],
    project: &atls_core::AtlsProject,
    language: atls_core::Language,
    project_root: Option<&std::path::Path>,
) -> Vec<serde_json::Value> {
    let mut missing = Vec::new();

    // Get all symbols defined in the source file via method inventory
    let source_symbols = match project.query().get_method_inventory(
        &[source_file.to_string()],
        Some(0),  // no min lines filter
        Some(0),  // no min complexity filter
        None,     // no class filter
    ) {
        Ok(inv) => inv.methods,
        Err(_) => return missing,
    };

    // Build lookup: symbol name -> kind
    let mut source_symbol_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut symbol_kind: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for method in &source_symbols {
        source_symbol_names.insert(method.name.clone());
        symbol_kind.insert(method.name.clone(), method.kind.clone());
    }

    // Check which source-file symbols appear in the extracted code but aren't being extracted
    for sym_name in &source_symbol_names {
        // Skip symbols that are being extracted
        if extracted_symbol_names.iter().any(|n| n == sym_name) {
            continue;
        }
        // Skip very short names (high false-positive rate)
        if sym_name.len() < 3 {
            continue;
        }
        // Check if the symbol name appears in the extracted code
        if !extracted_code.contains(sym_name.as_str()) {
            continue;
        }
        // This symbol is referenced but not being extracted
        let kind = symbol_kind.get(sym_name)
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());

        let is_problematic = match language {
            atls_core::Language::Go => {
                // Go: unexported symbols (lowercase first char) can't be accessed cross-package
                sym_name.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
            }
            atls_core::Language::Java | atls_core::Language::CSharp => {
                // Fields and methods in the same class are likely private/instance members
                kind == "field" || kind == "method"
            }
            atls_core::Language::Rust => {
                // Functions/types that aren't pub are module-private
                kind == "function" || kind == "type" || kind == "struct"
            }
            _ => false,
        };

        if is_problematic {
            missing.push(serde_json::json!({
                "symbol": sym_name,
                "kind": kind,
                "issue": match language {
                    atls_core::Language::Go => "unexported symbol referenced in extracted code",
                    atls_core::Language::Java | atls_core::Language::CSharp =>
                        "same-class member referenced in extracted code - may need field access",
                    atls_core::Language::Rust => "module-local symbol referenced in extracted code",
                    _ => "symbol may not be accessible in target file",
                }
            }));
        }
    }

    // UHPP enhancement: scan for types, enums, consts, interfaces that the DB-based
    // inventory might miss (get_method_inventory only returns functions/methods).
    // Use regex-based symbol extraction from shape_ops for broader coverage.
    if let Some(root) = project_root {
        let source_resolved = resolve_project_path(root, source_file);
        if let Ok(source_content) = std::fs::read_to_string(&source_resolved) {
            let additional_kinds: &[Option<&str>] = &[
                Some("type"), Some("enum"), Some("const"),
            ];
            for kind in additional_kinds {
                let names = crate::shape_ops::extract_symbol_names(&source_content, *kind);
                for sym_name in &names {
                    if sym_name.len() < 3 { continue; }
                    if extracted_symbol_names.iter().any(|n| n == sym_name) { continue; }
                    if source_symbol_names.contains(sym_name) { continue; }
                    if !extracted_code.contains(sym_name.as_str()) { continue; }
                    let kind_str = kind.unwrap_or("symbol");
                    missing.push(serde_json::json!({
                        "symbol": sym_name,
                        "kind": kind_str,
                        "issue": format!("{} '{}' referenced in extracted code — ensure it's exported or co-moved", kind_str, sym_name),
                    }));
                }
            }
        }
    }

    // Language-specific: detect Rust `self.` references and macro_rules! dependencies
    if matches!(language, atls_core::Language::Rust) {
        for cap in extracted_code.split("self.") {
            if let Some(field_name) = cap.split(|c: char| !c.is_alphanumeric() && c != '_').next() {
                if !field_name.is_empty()
                    && field_name.len() >= 2
                    && !extracted_symbol_names.iter().any(|n| n == field_name)
                    && !missing.iter().any(|m| m.get("symbol").and_then(|s| s.as_str()) == Some(field_name))
                {
                    missing.push(serde_json::json!({
                        "symbol": field_name,
                        "kind": "self_reference",
                        "issue": "self.* call will be auto-transformed to struct parameter in extracted code"
                    }));
                }
            }
        }

        // Detect macro_rules! macros from the crate root that can't be imported
        if let Some(root) = project_root {
            let source_resolved = resolve_project_path(root, source_file);
            let src_dir = source_resolved.parent().unwrap_or(root);
            let crate_root_candidates = ["lib.rs", "main.rs"];
            for candidate in &crate_root_candidates {
                let crate_root = src_dir.join(candidate);
                if crate_root.is_file() {
                    let macro_warnings = detect_rust_macro_deps(extracted_code, &crate_root);
                    missing.extend(macro_warnings);
                    break;
                }
            }
        }
    }

    // Language-specific: detect Java `this.field` references
    if matches!(language, atls_core::Language::Java) {
        for cap in extracted_code.split("this.") {
            if let Some(field_name) = cap.split(|c: char| !c.is_alphanumeric() && c != '_').next() {
                if !field_name.is_empty()
                    && field_name.len() >= 3
                    && !extracted_symbol_names.iter().any(|n| n == field_name)
                    && !missing.iter().any(|m| m.get("symbol").and_then(|s| s.as_str()) == Some(field_name))
                {
                    missing.push(serde_json::json!({
                        "symbol": field_name,
                        "kind": "field",
                        "issue": "instance field accessed via this.field in extracted code"
                    }));
                }
            }
        }
    }

    missing
}

/// Remove unused imports from a source file after extraction/move.
/// For Rust, uses AST-based reference tracking. For other languages, uses identifier scanning.
pub(crate) fn cleanup_unused_imports(
    file_path: &std::path::Path,
    language: atls_core::Language,
    parser_registry: &atls_core::parser::ParserRegistry,
) -> bool {
    let src = match std::fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let all_lines: Vec<&str> = src.lines().collect();
    if all_lines.is_empty() {
        return false;
    }

    let import_predicate: Box<dyn Fn(&str, &str) -> bool> = match language {
        atls_core::Language::Rust => Box::new(|_line: &str, t: &str| {
            (t.starts_with("use ") || t.starts_with("pub use ")) && t.ends_with(';')
        }),
        atls_core::Language::TypeScript | atls_core::Language::JavaScript => Box::new(|_line: &str, t: &str| {
            t.starts_with("import ") && (t.contains(" from ") || t.contains(" from\""))
        }),
        atls_core::Language::Python => Box::new(|_line: &str, t: &str| {
            t.starts_with("from ") && t.contains(" import ")
        }),
        atls_core::Language::Java => Box::new(|_line: &str, t: &str| {
            t.starts_with("import ") && t.ends_with(';') && !t.starts_with("import static")
        }),
        atls_core::Language::Go => Box::new(|_line: &str, t: &str| {
            t.starts_with("\"") && t.ends_with("\"")
        }),
        atls_core::Language::CSharp => Box::new(|_line: &str, t: &str| {
            t.starts_with("using ") && t.ends_with(';') && !t.starts_with("using (") && !t.contains('=')
        }),
        _ => return false,
    };

    let mut import_indices: Vec<usize> = Vec::new();
    let mut code_lines: Vec<&str> = Vec::new();
    for (i, line) in all_lines.iter().enumerate() {
        let t = line.trim();
        let is_module_level = !line.starts_with(' ') && !line.starts_with('\t');
        if is_module_level && import_predicate(line, t) {
            import_indices.push(i);
        } else {
            code_lines.push(line);
        }
    }
    if import_indices.is_empty() {
        return false;
    }

    let code_only = code_lines.join("\n");

    if language == atls_core::Language::Rust {
        let ast_refs = collect_rust_ast_references(&code_only, parser_registry);
        let mut replacements: std::collections::HashMap<usize, Option<String>> =
            std::collections::HashMap::new();
        for &idx in &import_indices {
            let orig = all_lines[idx].to_string();
            let filtered = filter_rust_imports_by_ast(
                std::slice::from_ref(&orig), &ast_refs,
            );
            if filtered.is_empty() {
                replacements.insert(idx, None);
            } else {
                replacements.insert(idx, Some(filtered[0].clone()));
            }
        }
        let cleaned: Vec<String> = all_lines.iter().enumerate()
            .filter_map(|(i, line)| {
                if let Some(replacement) = replacements.get(&i) {
                    replacement.clone()
                } else {
                    Some(line.to_string())
                }
            })
            .collect();
        let cleaned_src = collapse_blank_lines(&cleaned.join("\n"));
        let _ = std::fs::write(file_path, &cleaned_src);
        return true;
    }

    // For non-Rust: collect all identifiers from remaining code using simple word scanning
    let code_idents: std::collections::HashSet<&str> = code_only
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| s.len() >= 2)
        .collect();

    let mut changed = false;
    let mut result_lines: Vec<Option<String>> = all_lines.iter().map(|l| Some(l.to_string())).collect();

    for &idx in &import_indices {
        let line = all_lines[idx];
        let t = line.trim();
        match language {
            atls_core::Language::TypeScript | atls_core::Language::JavaScript => {
                // import { A, B, C } from './mod'; — check each named import
                if let Some(brace_start) = t.find('{') {
                    if let Some(brace_end) = t.find('}') {
                        let names: Vec<&str> = t[brace_start+1..brace_end]
                            .split(',')
                            .map(|s| s.trim())
                            .filter(|s| !s.is_empty())
                            .map(|s| {
                                // handle `A as B` — check the local alias B
                                if let Some(pos) = s.find(" as ") { s[pos+4..].trim() } else { s }
                            })
                            .collect();
                        let used: Vec<&str> = names.iter()
                            .copied()
                            .filter(|n| code_idents.contains(n))
                            .collect();
                        if used.is_empty() {
                            result_lines[idx] = None;
                            changed = true;
                        } else if used.len() < names.len() {
                            let from_part = &t[brace_end+1..];
                            let new_line = format!("import {{ {} }}{}", used.join(", "), from_part);
                            result_lines[idx] = Some(new_line);
                            changed = true;
                        }
                    }
                } else {
                    // default import: import X from '...'; — check X
                    let parts: Vec<&str> = t.splitn(3, ' ').collect();
                    if parts.len() >= 2 {
                        let name = parts[1].trim_end_matches(',');
                        if !code_idents.contains(name) {
                            result_lines[idx] = None;
                            changed = true;
                        }
                    }
                }
            }
            atls_core::Language::Python => {
                // from .mod import A, B, C
                if let Some(imp_pos) = t.find(" import ") {
                    let names_str = &t[imp_pos + 8..];
                    let names: Vec<&str> = names_str.split(',')
                        .map(|s| s.trim().trim_end_matches(')').trim())
                        .filter(|s| !s.is_empty())
                        .map(|s| {
                            if let Some(pos) = s.find(" as ") { s[pos+4..].trim() } else { s }
                        })
                        .collect();
                    let used: Vec<&str> = names.iter()
                        .copied()
                        .filter(|n| code_idents.contains(n))
                        .collect();
                    if used.is_empty() {
                        result_lines[idx] = None;
                        changed = true;
                    } else if used.len() < names.len() {
                        let prefix = &t[..imp_pos + 8];
                        result_lines[idx] = Some(format!("{}{}", prefix, used.join(", ")));
                        changed = true;
                    }
                }
            }
            atls_core::Language::Java => {
                // import com.pkg.ClassName;
                let class_name = t.trim_end_matches(';')
                    .rsplit('.')
                    .next()
                    .unwrap_or("");
                if !class_name.is_empty() && !code_idents.contains(class_name) {
                    result_lines[idx] = None;
                    changed = true;
                }
            }
            atls_core::Language::Go => {
                // "net/http" → last segment "http"
                let pkg = t.trim_matches('"');
                let alias = pkg.rsplit('/').next().unwrap_or(pkg);
                if !alias.is_empty() && !code_idents.contains(alias) {
                    result_lines[idx] = None;
                    changed = true;
                }
            }
            atls_core::Language::CSharp => {
                // using System.Collections.Generic;
                let ns = t.strip_prefix("using ")
                    .and_then(|s| s.strip_suffix(';'))
                    .unwrap_or("");
                let last_seg = ns.rsplit('.').next().unwrap_or("");
                if !last_seg.is_empty() && !code_idents.contains(last_seg) {
                    result_lines[idx] = None;
                    changed = true;
                }
            }
            _ => {}
        }
    }

    if changed {
        let cleaned: Vec<String> = result_lines.into_iter().filter_map(|l| l).collect();
        let cleaned_src = collapse_blank_lines(&cleaned.join("\n"));
        let _ = std::fs::write(file_path, &cleaned_src);
    }
    changed
}

/// Upgrade private Rust symbols to `pub(crate)` when they're referenced
/// by extracted/moved code but not themselves extracted.
pub(crate) fn upgrade_rust_visibility(
    source_path: &std::path::Path,
    referenced_symbols: &std::collections::HashSet<String>,
    extracted_symbols: &std::collections::HashSet<&str>,
) -> bool {
    if referenced_symbols.is_empty() {
        return false;
    }
    let src = match std::fs::read_to_string(source_path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let mut changed = false;
    let new_src: String = src.lines().map(|line| {
        let trimmed = line.trim();
        if line.starts_with(' ') || line.starts_with('\t') {
            return line.to_string();
        }
        if trimmed.starts_with("pub ") || trimmed.starts_with("pub(") {
            return line.to_string();
        }
        let def_prefixes = [
            "fn ", "async fn ", "unsafe fn ", "const fn ",
            "struct ", "enum ", "type ", "trait ",
            "static ", "const ",
        ];
        for pfx in &def_prefixes {
            if trimmed.starts_with(pfx) {
                let rest = &trimmed[pfx.len()..];
                let name_end = rest.find(|c: char| !c.is_alphanumeric() && c != '_')
                    .unwrap_or(rest.len());
                let name = &rest[..name_end];
                if !name.is_empty()
                    && referenced_symbols.contains(name)
                    && !extracted_symbols.contains(name)
                {
                    changed = true;
                    return format!("pub(crate) {}", trimmed);
                }
            }
        }
        line.to_string()
    }).collect::<Vec<_>>().join("\n");
    if changed {
        let _ = std::fs::write(source_path, &new_src);
    }
    changed
}

/// Add `pub(crate) mod <target_stem>;` declaration to the Rust crate root.
pub(crate) fn ensure_rust_mod_declaration(
    target_file: &str,
    source_dir: &std::path::Path,
    project_root: &std::path::Path,
) -> Option<String> {
    let target_stem = std::path::Path::new(target_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if target_stem.is_empty() || target_stem == "mod" {
        return None;
    }
    let crate_root_candidates = ["lib.rs", "main.rs"];
    for candidate in &crate_root_candidates {
        let crate_root = source_dir.join(candidate);
        if crate_root.is_file() {
            if let Ok(root_content) = std::fs::read_to_string(&crate_root) {
                let mod_line = format!("mod {};", target_stem);
                let pub_mod_line = format!("pub mod {};", target_stem);
                let pub_crate_mod_line = format!("pub(crate) mod {};", target_stem);
                if root_content.contains(&mod_line)
                    || root_content.contains(&pub_mod_line)
                    || root_content.contains(&pub_crate_mod_line)
                {
                    return None;
                }
                let decl = format!("pub(crate) mod {};", target_stem);
                let root_lines: Vec<&str> = root_content.lines().collect();
                let mut insert_after: Option<usize> = None;
                let mut in_macro_rules = false;
                let mut brace_depth: i32 = 0;
                for (i, line) in root_lines.iter().enumerate() {
                    let t = line.trim();
                    // Stop at first top-level code definition — anything after
                    // this point (e.g. inline test modules) is not a crate-root
                    // mod declaration and must not shift the insertion point.
                    if !line.starts_with(' ') && !line.starts_with('\t') && !in_macro_rules {
                        let is_code_def = t.starts_with("fn ")
                            || t.starts_with("pub fn ")
                            || t.starts_with("pub(crate) fn ")
                            || t.starts_with("async fn ")
                            || t.starts_with("pub async fn ")
                            || t.starts_with("pub(crate) async fn ")
                            || t.starts_with("impl ")
                            || t.starts_with("struct ")
                            || t.starts_with("pub struct ")
                            || t.starts_with("pub(crate) struct ")
                            || t.starts_with("enum ")
                            || t.starts_with("pub enum ")
                            || t.starts_with("pub(crate) enum ")
                            || t.starts_with("trait ")
                            || t.starts_with("pub trait ")
                            || t.starts_with("pub(crate) trait ")
                            || t.starts_with("const ")
                            || t.starts_with("pub const ")
                            || t.starts_with("pub(crate) const ")
                            || t.starts_with("static ")
                            || t.starts_with("pub static ")
                            || t.starts_with("pub(crate) static ")
                            || t.starts_with("#[tauri::command")
                            || t.starts_with("type ")
                            || t.starts_with("pub type ")
                            || t.starts_with("pub(crate) type ");
                        if is_code_def {
                            break;
                        }
                    }
                    if t.starts_with("mod ")
                        || t.starts_with("pub mod ")
                        || t.starts_with("pub(crate) mod ")
                    {
                        insert_after = Some(i);
                    }
                    if t.starts_with("macro_rules!") {
                        in_macro_rules = true;
                        brace_depth = 0;
                    }
                    if in_macro_rules {
                        for ch in t.chars() {
                            match ch {
                                '{' | '(' => brace_depth += 1,
                                '}' | ')' => {
                                    brace_depth -= 1;
                                    if brace_depth <= 0 {
                                        in_macro_rules = false;
                                        insert_after = Some(i);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                let insert_idx = insert_after
                    .map(|i| i + 1)
                    .unwrap_or_else(|| {
                        root_lines.iter().enumerate()
                            .rev()
                            .find(|(_, l)| {
                                let t = l.trim();
                                t.starts_with("use ") || t.starts_with("pub use ")
                            })
                            .map(|(i, _)| i + 1)
                            .unwrap_or(0)
                    });
                let mut result_lines: Vec<&str> = Vec::with_capacity(root_lines.len() + 1);
                result_lines.extend_from_slice(&root_lines[..insert_idx]);
                let decl_ref: &str = &decl;
                result_lines.push(decl_ref);
                if insert_idx < root_lines.len() {
                    result_lines.extend_from_slice(&root_lines[insert_idx..]);
                }
                let updated = result_lines.join("\n");
                if let Ok(()) = std::fs::write(&crate_root, &updated) {
                    let rel_root = crate_root.strip_prefix(project_root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| crate_root.to_string_lossy().to_string());
                    return Some(format!("pub(crate) mod {}; added to {}", target_stem, rel_root));
                }
            }
            break;
        }
    }
    None
}

/// Generate a delegation stub that forwards calls from the original location
/// to the new target module. Used by both extract and move operations.
pub(crate) fn generate_delegation_stub(
    original_code: &str,
    fn_name: &str,
    target_mod: &str,
    language: atls_core::Language,
    parser_registry: &atls_core::parser::ParserRegistry,
) -> Option<String> {
    match language {
        atls_core::Language::Rust => {
            let param_names = extract_rust_fn_param_names(original_code, parser_registry);
            let target_path = if target_mod.is_empty() {
                format!("crate::{}", fn_name)
            } else {
                format!("crate::{}::{}", target_mod, fn_name)
            };

            let mut args = Vec::new();
            let body_start = original_code.find('{').map(|p| p + 1).unwrap_or(0);
            let body = &original_code[body_start..];
            let body_no_self_path = body.replace("self::", "__SELFPATH__");
            if is_identifier_match(&body_no_self_path, "self") {
                args.push("self".to_string());
            }
            args.extend(param_names.iter().cloned());
            let call = format!("{}({})", target_path, args.join(", "));

            let lines: Vec<&str> = original_code.lines().collect();
            let mut sig_end = 0;
            let mut brace_depth = 0;
            for (li, line) in lines.iter().enumerate() {
                for ch in line.chars() {
                    if ch == '{' {
                        brace_depth += 1;
                        if brace_depth == 1 {
                            sig_end = li;
                            break;
                        }
                    }
                }
                if brace_depth > 0 { break; }
            }
            let sig_lines: Vec<&str> = lines[..=sig_end].to_vec();
            let indent = sig_lines.last()
                .map(|l| {
                    let trimmed = l.trim_start();
                    &l[..l.len() - trimmed.len()]
                })
                .unwrap_or("");
            Some(format!(
                "{}\n{}    {}\n{}}}",
                sig_lines.join("\n"),
                indent,
                call,
                indent,
            ))
        }
        atls_core::Language::Java | atls_core::Language::CSharp => {
            // Build a thin forwarding method for OOP languages
            let lines: Vec<&str> = original_code.lines().collect();
            let mut sig_end = 0;
            for (li, line) in lines.iter().enumerate() {
                if line.contains('{') {
                    sig_end = li;
                    break;
                }
            }
            let sig = lines[..=sig_end].join("\n");
            let target_class = target_mod.split(|c: char| c == '/' || c == '\\')
                .last()
                .and_then(|s| s.strip_suffix(".java").or_else(|| s.strip_suffix(".cs")))
                .unwrap_or(target_mod);
            // Extract parameter names from signature
            if let Some(paren_start) = sig.find('(') {
                if let Some(paren_end) = sig.rfind(')') {
                    let params_str = &sig[paren_start+1..paren_end];
                    let param_names: Vec<&str> = params_str.split(',')
                        .filter_map(|p| {
                            let trimmed = p.trim();
                            if trimmed.is_empty() { return None; }
                            trimmed.split_whitespace().last()
                        })
                        .collect();
                    let call = format!("new {}().{}({})",
                        target_class, fn_name, param_names.join(", "));
                    let has_return = !sig.contains("void ");
                    let body = if has_return {
                        format!("    return {};", call)
                    } else {
                        format!("    {};", call)
                    };
                    return Some(format!("{}\n{}\n}}", sig, body));
                }
            }
            None
        }
        atls_core::Language::TypeScript | atls_core::Language::JavaScript => {
            let target_stem = std::path::Path::new(target_mod)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(target_mod);
            let lines: Vec<&str> = original_code.lines().collect();
            let mut sig_end = 0;
            for (li, line) in lines.iter().enumerate() {
                if line.contains('{') {
                    sig_end = li;
                    break;
                }
            }
            let sig = lines[..=sig_end].join("\n");
            if let Some(paren_start) = sig.find('(') {
                if let Some(paren_end) = sig.rfind(')') {
                    let params_str = &sig[paren_start+1..paren_end];
                    let param_names: Vec<&str> = params_str.split(',')
                        .filter_map(|p| {
                            let trimmed = p.trim();
                            if trimmed.is_empty() { return None; }
                            // Handle TS type annotations: name: type
                            trimmed.split(':').next().map(|s| s.trim())
                        })
                        .collect();
                    let call = format!("{}.{}({})", target_stem, fn_name, param_names.join(", "));
                    let has_return = !sig.contains(": void");
                    let body = if has_return {
                        format!("  return {};", call)
                    } else {
                        format!("  {};", call)
                    };
                    return Some(format!("{}\n{}\n}}", sig, body));
                }
            }
            None
        }
        atls_core::Language::Python => {
            let target_stem = std::path::Path::new(target_mod)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(target_mod);
            let lines: Vec<&str> = original_code.lines().collect();
            if let Some(first) = lines.first() {
                let indent_len = first.len() - first.trim_start().len();
                let indent = &first[..indent_len];
                // Extract parameter names from def line
                if let Some(paren_start) = first.find('(') {
                    if let Some(paren_end) = first.rfind(')') {
                        let params_str = &first[paren_start+1..paren_end];
                        let param_names: Vec<&str> = params_str.split(',')
                            .filter_map(|p| {
                                let trimmed = p.trim();
                                if trimmed.is_empty() || trimmed == "self" || trimmed == "cls" {
                                    return None;
                                }
                                trimmed.split(':').next().map(|s| s.trim())
                            })
                            .collect();
                        let call = format!("{}.{}({})", target_stem, fn_name, param_names.join(", "));
                        return Some(format!("{}\n{}    return {}", first, indent, call));
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// Promote Go unexported symbols to exported by capitalizing the first letter.
/// Returns the list of promoted symbol names (new names after capitalization).
pub(crate) fn promote_go_symbol_visibility(
    source_path: &std::path::Path,
    symbol_names: &[String],
    _project_root: &std::path::Path,
) -> Vec<(String, String)> {
    let mut promotions = Vec::new();
    if symbol_names.is_empty() {
        return promotions;
    }
    let source_dir = match source_path.parent() {
        Some(d) => d,
        None => return promotions,
    };

    // Collect all .go files in the same directory (same package)
    let mut package_files: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(source_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("go") {
                package_files.push(path);
            }
        }
    }

    for sym_name in symbol_names {
        let first_char = match sym_name.chars().next() {
            Some(c) if c.is_lowercase() => c,
            _ => continue,
        };
        let new_name = format!("{}{}", first_char.to_uppercase(), &sym_name[first_char.len_utf8()..]);
        let pattern = format!(r"\b{}\b", regex::escape(sym_name));
        let re = match regex::Regex::new(&pattern) {
            Ok(r) => r,
            Err(_) => continue,
        };

        for file_path in &package_files {
            if let Ok(content) = std::fs::read_to_string(file_path) {
                let updated = re.replace_all(&content, new_name.as_str());
                if updated != content {
                    let _ = std::fs::write(file_path, updated.as_ref());
                }
            }
        }
        promotions.push((sym_name.clone(), new_name));
    }
    promotions
}

/// Extract meaningful tokens from an import line for matching against code.
pub(crate) fn extract_import_tokens(import_line: &str, language: atls_core::Language) -> Vec<String> {
    let trimmed = import_line.trim();
    match language {
        atls_core::Language::Go => {
            // `    "net/http"` → last path segment "http"
            let path = trimmed.trim_matches('"').trim();
            if let Some(last) = path.rsplit('/').next() {
                vec![last.to_string()]
            } else {
                vec![path.to_string()]
            }
        }
        atls_core::Language::Java => {
            // `import java.util.List;` → "List"
            let inner = trimmed
                .trim_start_matches("import ")
                .trim_start_matches("static ")
                .trim_end_matches(';')
                .trim();
            if let Some(last) = inner.rsplit('.').next() {
                if last == "*" {
                    // Wildcard import — always include
                    return vec![];
                }
                vec![last.to_string()]
            } else {
                vec![inner.to_string()]
            }
        }
        atls_core::Language::CSharp => {
            // `using System.Collections.Generic;` → last segment "Generic"
            // But also check for common types from that namespace
            let inner = trimmed
                .trim_start_matches("using ")
                .trim_end_matches(';')
                .trim();
            let mut tokens = Vec::new();
            if let Some(last) = inner.rsplit('.').next() {
                tokens.push(last.to_string());
            }
            tokens
        }
        atls_core::Language::Python => {
            // `from os.path import join, exists` → ["join", "exists"]
            // `from os.path import ( join, exists )` → ["join", "exists"]
            // `import os` → ["os"]
            if let Some(after_import) = trimmed.strip_prefix("from ") {
                if let Some(idx) = after_import.find(" import ") {
                    let symbols_raw = &after_import[idx + 8..];
                    let symbols_part = symbols_raw.trim()
                        .trim_start_matches('(')
                        .trim_end_matches(')')
                        .trim();
                    return symbols_part
                        .split(',')
                        .map(|s| s.trim().split(" as ").next().unwrap_or("").trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
            if let Some(module) = trimmed.strip_prefix("import ") {
                let module = module.trim().split(" as ").next().unwrap_or("").trim();
                if let Some(last) = module.rsplit('.').next() {
                    return vec![last.to_string()];
                }
                return vec![module.to_string()];
            }
            vec![]
        }
        atls_core::Language::Rust => {
            // `use crate::types::{A, B};` → ["A", "B"]
            // `pub use crate::re_export::Foo;` → ["Foo"]
            let inner = trimmed
                .trim_start_matches("pub ")
                .trim_start_matches("use ")
                .trim_end_matches(';')
                .trim();
            if let Some(brace_start) = inner.find('{') {
                if let Some(brace_end) = inner.find('}') {
                    return inner[brace_start + 1..brace_end]
                        .split(',')
                        .map(|s| s.trim().split(" as ").next().unwrap_or("").trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
            if let Some(last) = inner.rsplit("::").next() {
                vec![last.to_string()]
            } else {
                vec![inner.to_string()]
            }
        }
        atls_core::Language::C | atls_core::Language::Cpp => {
            // `#include <vector>` → "vector"
            // `#include "mylib.h"` → "mylib"
            let inner = trimmed
                .trim_start_matches("#include")
                .trim()
                .trim_matches('"')
                .trim_start_matches('<')
                .trim_end_matches('>')
                .trim();
            let stem = std::path::Path::new(inner)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(inner);
            vec![stem.to_string()]
        }
        atls_core::Language::TypeScript | atls_core::Language::JavaScript => {
            // `import { foo, bar } from './module';` → ["foo", "bar"]
            // `import { type Foo, bar } from './module';` → ["Foo", "bar"]
            // `import React from 'react';` → ["React"]
            // `import * as helpers from './helpers';` → ["helpers"]
            if let Some(brace_start) = trimmed.find('{') {
                if let Some(brace_end) = trimmed.find('}') {
                    return trimmed[brace_start + 1..brace_end]
                        .split(',')
                        .map(|s| {
                            let s = s.trim();
                            let s = s.strip_prefix("type ").unwrap_or(s);
                            s.split(" as ").last().unwrap_or("").trim().to_string()
                        })
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
            let after_import = trimmed
                .trim_start_matches("import ")
                .trim_start_matches("type ")
                .trim();
            // Namespace import: `import * as X from '...'`
            if after_import.starts_with("* as ") {
                if let Some(alias) = after_import[5..].split_whitespace().next() {
                    return vec![alias.to_string()];
                }
            }
            // Default import: `import Foo from '...'`
            if let Some(from_idx) = after_import.find(" from ") {
                let name = after_import[..from_idx].trim();
                if !name.starts_with('{') && !name.starts_with('*') {
                    return vec![name.to_string()];
                }
            }
            vec![]
        }
        _ => vec![],
    }
}

/// Deduplicate Rust `use` statements (including `pub use`).
/// Merges `use std::process::Command;` and `use std::process::{Command, Stdio};`
/// into `use std::process::{Command, Stdio};` and removes exact duplicates.
/// Keeps `pub use` and `use` groups separate so visibility is preserved.
pub(crate) fn deduplicate_rust_imports(imports: &[String]) -> Vec<String> {
    use std::collections::{HashMap, BTreeSet};

    // Track (module_path -> symbols) separately for `use` and `pub use`
    let mut use_symbols: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut pub_use_symbols: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut unparseable: Vec<String> = Vec::new();

    for line in imports {
        let trimmed = line.trim();

        // Detect and strip `pub use` vs `use` prefix
        let (is_pub, inner) = if trimmed.starts_with("pub use ") {
            (true, trimmed.trim_start_matches("pub use ").trim_end_matches(';').trim())
        } else if trimmed.starts_with("use ") {
            (false, trimmed.trim_start_matches("use ").trim_end_matches(';').trim())
        } else {
            // Not a use statement — keep as-is
            if !unparseable.contains(&trimmed.to_string()) {
                unparseable.push(trimmed.to_string());
            }
            continue;
        };

        let target = if is_pub { &mut pub_use_symbols } else { &mut use_symbols };

        if inner.is_empty() || inner.contains('*') {
            // Glob imports like `use std::io::*;` — keep as-is
            if !unparseable.contains(&trimmed.to_string()) {
                unparseable.push(trimmed.to_string());
            }
            continue;
        }

        if let Some(brace_start) = inner.find('{') {
            if let Some(brace_end) = inner.find('}') {
                let module_path = inner[..brace_start].trim_end_matches("::").to_string();
                let symbols: BTreeSet<String> = inner[brace_start + 1..brace_end]
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                target.entry(module_path).or_default().extend(symbols);
                continue;
            }
        }

        // Single-symbol import: `use foo::bar::Baz;`
        if let Some(last_sep) = inner.rfind("::") {
            let module_path = inner[..last_sep].to_string();
            let symbol = inner[last_sep + 2..].to_string();
            if !symbol.is_empty() {
                target.entry(module_path).or_default().insert(symbol);
                continue;
            }
        }

        // Can't parse — keep as-is
        if !unparseable.contains(&trimmed.to_string()) {
            unparseable.push(trimmed.to_string());
        }
    }

    // Reconstruct merged use statements for both `use` and `pub use`
    let mut result: Vec<String> = Vec::new();

    for (is_pub, module_map) in [(false, use_symbols), (true, pub_use_symbols)] {
        let prefix = if is_pub { "pub use" } else { "use" };
        let mut sorted_modules: Vec<_> = module_map.into_iter().collect();
        sorted_modules.sort_by(|a, b| a.0.cmp(&b.0));

        for (module_path, symbols) in sorted_modules {
            if symbols.len() == 1 {
                let sym = symbols.into_iter().next().unwrap();
                if sym.contains("self") || sym.contains('{') {
                    result.push(format!("{} {}::{{{}}};", prefix, module_path, sym));
                } else {
                    result.push(format!("{} {}::{};", prefix, module_path, sym));
                }
            } else {
                let syms: Vec<_> = symbols.into_iter().collect();
                result.push(format!("{} {}::{{{}}};", prefix, module_path, syms.join(", ")));
            }
        }
    }

    result.extend(unparseable);
    result
}

/// Generate language-aware delegation hints for the original source file.
pub(crate) fn generate_delegation_hint(
    target_ext: &str,
    class_name: &str,
    source_file: &str,
    target_file: &str,
    delegation_style: &str,
) -> String {
    if delegation_style != "composition" {
        return format!("// Extend {} from {}", class_name, source_file);
    }
    
    match target_ext {
        "go" => {
            // Go: no classes; import the package and call functions directly
            let pkg = std::path::Path::new(target_file)
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                .unwrap_or("helpers");
            format!(
                "// Import the helper package and call extracted functions directly:\n// import \"path/to/{pkg}\"\n// Then call: {pkg}.FunctionName(...)",
                pkg = pkg
            )
        }
        "java" => {
            format!(
                "// Add to original class:\n// private final {} {} = new {}();\n// Then delegate: {}.methodName(...)",
                class_name,
                to_camel_case(class_name),
                class_name,
                to_camel_case(class_name)
            )
        }
        "cs" | "csx" => {
            format!(
                "// Add to original class:\n// private readonly {} {} = new {}();\n// Then delegate: {}.MethodName(...)",
                class_name,
                to_camel_case(class_name),
                class_name,
                to_camel_case(class_name)
            )
        }
        "py" | "pyi" | "pyw" => {
            let module = std::path::Path::new(target_file)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("helpers");
            format!(
                "# Import from the helper module:\n# from .{} import {}\n# Then: helper = {}()\n# Or import functions directly",
                module,
                class_name,
                class_name
            )
        }
        "rs" => {
            let module = std::path::Path::new(target_file)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("helpers");
            format!(
                "// Add mod declaration in lib.rs/main.rs:\n// mod {};\n// Then call: {}::function_name(...)\n// Or re-export: pub use {}::*;",
                module,
                module,
                module
            )
        }
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" | "h" | "c" => {
            let header = std::path::Path::new(target_file)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("helpers.h");
            format!(
                "// Include the helper header:\n// #include \"{}\"\n// Then call extracted functions directly",
                header
            )
        }
        "ts" | "tsx" => {
            format!(
                "// Import from the helper module:\n// import {{ {} }} from './{}';\n// private {} = new {}();\n// Then delegate: this.{}.methodName(...args)",
                class_name,
                std::path::Path::new(target_file).file_stem().and_then(|s| s.to_str()).unwrap_or("helpers"),
                class_name.to_lowercase(),
                class_name,
                class_name.to_lowercase()
            )
        }
        "js" | "jsx" | "mjs" | "cjs" => {
            format!(
                "// Import from the helper module:\n// import {{ {} }} from './{}';\n// private {} = new {}();\n// Then delegate: this.{}.methodName(...args)",
                class_name,
                std::path::Path::new(target_file).file_stem().and_then(|s| s.to_str()).unwrap_or("helpers"),
                class_name.to_lowercase(),
                class_name,
                class_name.to_lowercase()
            )
        }
        _ => {
            format!(
                "// Add to original class:\n// private {} = new {}();\n// Then delegate: this.{}.methodName(...args)",
                class_name.to_lowercase(),
                class_name,
                class_name.to_lowercase()
            )
        }
    }
}

/// Convert PascalCase to camelCase for variable names.
pub(crate) fn to_camel_case(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) => c.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Deduplicate TS/JS barrel export lines. Keeps first occurrence of each symbol.
/// Detects `export { X, Y }` and `export * from`; removes duplicate symbol refs.
pub(crate) fn dedupe_barrel_exports(content: &str) -> String {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let export_curly = regex::Regex::new(r"export\s+\{\s*([^}]+)\s*\}").ok();
    let export_star = regex::Regex::new(r#"export\s+\*\s+from\s+["']([^"']+)["']"#).ok();
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(ref re) = export_curly {
            if let Some(caps) = re.captures(trimmed) {
                let items: Vec<String> = caps[1]
                    .split(',')
                    .map(|s| s.trim().split(" as ").next().unwrap_or(s.trim()).trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                let new_items: Vec<&str> = items
                    .iter()
                    .filter(|s| seen.insert(s.to_string()))
                    .map(|s| s.as_str())
                    .collect();
                if new_items.is_empty() {
                    continue;
                }
                if new_items.len() < items.len() {
                    let after_brace = trimmed.find('}').map(|i| trimmed[i + 1..].trim()).unwrap_or("");
                    let suffix = if after_brace.starts_with(" from ") {
                        after_brace.to_string()
                    } else {
                        String::new()
                    };
                    out.push(format!("export {{ {} }}{}", new_items.join(", "), suffix));
                } else {
                    out.push(line.to_string());
                }
                continue;
            }
        }
        if let Some(ref re) = export_star {
            if let Some(caps) = re.captures(trimmed) {
                let path = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
                let key = format!("*:{}", path);
                if !seen.insert(key) {
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }
    let result = out.join("\n");
    if content.ends_with('\n') && !result.ends_with('\n') {
        format!("{}\n", result)
    } else {
        result
    }
}

/// Lint a set of files and return (results, summary).
/// Re-reads content from disk for the given paths.
/// Uses use_native_parser: true for autolint (tsc, py_compile, gofmt, etc.).
pub(crate) fn lint_written_files(
    project_root: &std::path::Path,
    file_paths: &[String],
) -> (Vec<linter::LintResult>, Option<linter::LintSummary>) {
    lint_written_files_with_options(project_root, file_paths, false, true)
}

pub(crate) fn lint_written_files_with_options(
    project_root: &std::path::Path,
    file_paths: &[String],
    syntax_only: bool,
    use_native_parser: bool,
) -> (Vec<linter::LintResult>, Option<linter::LintSummary>) {
    if file_paths.is_empty() {
        return (vec![], None);
    }
    let files_content: Vec<(String, String)> = file_paths.iter()
        .filter_map(|p| {
            let abs = project_root.join(p);
            std::fs::read_to_string(&abs).ok().map(|c| (p.clone(), c))
        })
        .collect();
    if files_content.is_empty() {
        return (vec![], None);
    }
    let opts = linter::LintOptions {
        root_path: project_root.to_string_lossy().to_string(),
        syntax_only: Some(syntax_only),
        use_native_parser: Some(use_native_parser),
        ..Default::default()
    };
    let results = linter::lint_files(&files_content, &opts);
    let summary = if results.is_empty() { None } else { Some(linter::create_lint_summary(&results)) };
    (results, summary)
}

/// Lint file contents that are already in memory (avoids re-reading from disk).
/// Used by rename_symbol to eliminate double file reads.
pub(crate) fn lint_file_contents(
    project_root: &std::path::Path,
    files_content: &[(String, String)],
    syntax_only: bool,
    use_native_parser: bool,
) -> (Vec<linter::LintResult>, Option<linter::LintSummary>) {
    if files_content.is_empty() {
        return (vec![], None);
    }
    let opts = linter::LintOptions {
        root_path: project_root.to_string_lossy().to_string(),
        syntax_only: Some(syntax_only),
        use_native_parser: Some(use_native_parser),
        ..Default::default()
    };
    let results = linter::lint_files(files_content, &opts);
    let summary = if results.is_empty() { None } else { Some(linter::create_lint_summary(&results)) };
    (results, summary)
}

/// Collect `#define` macro definitions from a C/C++ source file and its local headers.
/// Returns Vec<(macro_name, full_define_text)> for macros referenced in `code_to_check`.
/// Handles multi-line defines (backslash continuation).
pub(crate) fn collect_c_macros_for_code(
    source_content: &str,
    source_path: &std::path::Path,
    code_to_check: &str,
) -> Vec<String> {
    let mut all_defines: Vec<(String, String)> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Collect #define lines from a block of text
    let collect_from_text = |text: &str, defs: &mut Vec<(String, String)>, seen: &mut std::collections::HashSet<String>| {
        let lines: Vec<&str> = text.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            let trimmed = lines[i].trim();
            if trimmed.starts_with("#define ") {
                let rest = trimmed.trim_start_matches("#define ").trim();
                let macro_name: String = rest.chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if macro_name.is_empty() || macro_name.starts_with('_') && macro_name.chars().nth(1).map_or(false, |c| c == '_') {
                    i += 1;
                    continue;
                }
                // Collect full define (with backslash continuations)
                let mut full_define = lines[i].to_string();
                while full_define.trim_end().ends_with('\\') && i + 1 < lines.len() {
                    i += 1;
                    full_define.push('\n');
                    full_define.push_str(lines[i]);
                }
                // Keep last definition (handles #ifdef/#else blocks)
                if seen.contains(&macro_name) {
                    defs.retain(|(n, _)| n != &macro_name);
                }
                seen.insert(macro_name.clone());
                defs.push((macro_name, full_define));
            }
            i += 1;
        }
    };

    // 1. Collect from source file
    collect_from_text(source_content, &mut all_defines, &mut seen_names);

    // 2. Collect from local #include "..." headers (scan all lines, not just first 100)
    if let Some(source_dir) = source_path.parent() {
        let mut scanned_headers: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
        for line in source_content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("#include \"") {
                let header = trimmed
                    .trim_start_matches("#include \"")
                    .trim_end_matches('"')
                    .trim();
                // Try same directory first, then parent directory
                let candidates = [
                    source_dir.join(header),
                    source_dir.join("..").join(header),
                ];
                for header_path in &candidates {
                    if header_path.is_file() && scanned_headers.insert(header_path.clone()) {
                        if let Ok(header_content) = std::fs::read_to_string(header_path) {
                            collect_from_text(&header_content, &mut all_defines, &mut seen_names);
                        }
                        break;
                    }
                }
            }
        }
    }

    // 3. Filter to only macros referenced in the extracted code
    all_defines.into_iter()
        .filter(|(name, _)| code_to_check.contains(name.as_str()))
        .map(|(_, define_text)| define_text)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_import_same_dir_ts() {
        let result = build_source_import_for_moved_symbols(
            "src/utils/hashResolver.ts",
            "src/utils/hashResolverTemporal.ts",
            &["resolveTemporalRef".to_string()],
            atls_core::Language::TypeScript,
        );
        assert_eq!(
            result.as_deref(),
            Some("import { resolveTemporalRef } from './hashResolverTemporal';")
        );
    }

    #[test]
    fn build_import_cross_dir_ts() {
        let result = build_source_import_for_moved_symbols(
            "src/services/aiService.ts",
            "src/utils/hashResolverTemporal.ts",
            &["resolveTemporalRef".to_string(), "parseTemporalRange".to_string()],
            atls_core::Language::TypeScript,
        );
        let import = result.unwrap();
        assert!(import.contains("../utils/hashResolverTemporal"), "expected relative path, got: {}", import);
        assert!(import.contains("resolveTemporalRef"));
        assert!(import.contains("parseTemporalRange"));
    }

    #[test]
    fn build_import_cross_dir_python() {
        let result = build_source_import_for_moved_symbols(
            "src/services/ai_service.py",
            "src/utils/hash_resolver_temporal.py",
            &["resolve_temporal_ref".to_string()],
            atls_core::Language::Python,
        );
        let import = result.unwrap();
        assert!(import.contains("resolve_temporal_ref"), "got: {}", import);
        assert!(!import.starts_with("from .hash_resolver_temporal"), "should not use same-dir path for cross-dir: {}", import);
    }

    #[test]
    fn python_relative_import_deep_cross_dir() {
        // Regression: compute_relative_import_path produced too many leading dots.
        // src/services/ai_service.py → _test_atls/extracted_cf.py
        // rel = ../../_test_atls → up_count=2, down=["_test_atls"], stem="extracted_cf"
        // PEP 328: 3 dots (2 ups + 1 base) then _test_atls.extracted_cf
        let result = build_source_import_for_moved_symbols(
            "src/services/ai_service.py",
            "_test_atls/extracted_cf.py",
            &["close_old_connections".to_string()],
            atls_core::Language::Python,
        );
        let import = result.unwrap();
        assert_eq!(import, "from ..._test_atls.extracted_cf import close_old_connections");
    }

    #[test]
    fn python_relative_import_sibling_subdir() {
        // src/a/foo.py → src/b/c/bar.py : up 1 from a → src, down into b/c
        let result = build_source_import_for_moved_symbols(
            "src/a/foo.py",
            "src/b/c/bar.py",
            &["helper".to_string()],
            atls_core::Language::Python,
        );
        let import = result.unwrap();
        assert_eq!(import, "from ..b.c.bar import helper");
    }

    #[test]
    fn remove_symbol_from_multi_import_ts() {
        let content = "import { foo, bar, baz } from './hashResolver';\n";
        let result = remove_symbol_from_import_line(content, "bar", "hashResolver", atls_core::Language::TypeScript);
        assert!(result.contains("foo"));
        assert!(result.contains("baz"));
        assert!(!result.contains("bar"));
        assert!(result.contains("hashResolver"));
    }

    #[test]
    fn remove_sole_symbol_drops_import_line_ts() {
        let content = "import { foo } from './hashResolver';\nconst x = 1;\n";
        let result = remove_symbol_from_import_line(content, "foo", "hashResolver", atls_core::Language::TypeScript);
        assert!(!result.contains("import"), "should drop entire import line");
        assert!(result.contains("const x = 1;"));
    }

    #[test]
    fn insert_import_after_last_existing_ts() {
        let content = "import { a } from './a';\nimport { b } from './b';\n\nconst x = 1;\n";
        let result = insert_import_line(content, "import { c } from './c';", atls_core::Language::TypeScript);
        assert!(result.contains("import { c } from './c';"));
        let c_pos = result.find("import { c }").unwrap();
        let x_pos = result.find("const x").unwrap();
        assert!(c_pos < x_pos, "new import should appear before code");
    }

    #[test]
    fn dedupe_barrel_exports_removes_duplicate_curly() {
        let content = "export { foo } from './a';\nexport { bar } from './b';\nexport { foo } from './c';\n";
        let result = dedupe_barrel_exports(content);
        assert_eq!(result.matches("export { foo }").count(), 1);
        assert!(result.contains("export { bar }"));
    }

    #[test]
    fn dedupe_barrel_exports_removes_duplicate_star() {
        let content = "export * from './a';\nexport * from './b';\nexport * from './a';\n";
        let result = dedupe_barrel_exports(content);
        assert_eq!(result.matches("export * from './a'").count(), 1);
    }

    #[test]
    fn dedupe_barrel_exports_preserves_unique() {
        let content = "export { a } from './a';\nexport { b } from './b';\n";
        let result = dedupe_barrel_exports(content);
        assert!(result.contains("export { a }"));
        assert!(result.contains("export { b }"));
    }
}
