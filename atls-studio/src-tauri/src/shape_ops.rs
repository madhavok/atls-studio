//! Shape Operations — content transformation pipeline for h:ref modifiers.
//!
//! Each `ShapeOp` variant is a pure function: content in, shaped content out.
//! Symbol anchor resolution uses regex fallback when the ATLS index is unavailable.

use crate::error::AtlsError;
use crate::hash_resolver::ShapeOp;

pub use atls_core::indexer::uhpp_extractor::UHPP_SYMBOL_KINDS;

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/// Apply a shape operation to content. Returns transformed content.
pub fn apply_shape(content: &str, op: &ShapeOp) -> String {
    match op {
        ShapeOp::Sig => extract_signatures(content),
        ShapeOp::Fold => {
            let folded = fold_nested(content);
            let input_lines = content.lines().count();
            let output_lines = folded.lines().count();
            if input_lines > 0 && output_lines > (input_lines * 4 / 5) {
                let mut result = String::from("[fold ineffective — fell back to sig]\n");
                result.push_str(&extract_signatures(content));
                result
            } else {
                folded
            }
        },
        ShapeOp::Dedent => dedent(content),
        ShapeOp::NoComment => strip_comments(content),
        ShapeOp::Head(n) => head(content, *n),
        ShapeOp::Tail(n) => tail(content, *n),
        ShapeOp::Grep(pat) => grep(content, pat),
        ShapeOp::Exclude(ranges) => exclude(content, ranges),
        ShapeOp::Imports => extract_imports(content),
        ShapeOp::Exports => extract_exports(content),
        ShapeOp::Highlight(_) => content.to_string(), // passthrough — frontend handles highlight
        ShapeOp::Concept(term) => extract_concept(content, term),
        ShapeOp::Pattern(name) => extract_pattern(content, name),
        ShapeOp::If(expr) => filter_if(content, expr),
        ShapeOp::Snap => content.to_string(), // handled at resolver level for ShapedLines
        ShapeOp::Refs => extract_refs(content),
    }
}

// ---------------------------------------------------------------------------
// Symbol Anchor Resolution (regex fallback)
// ---------------------------------------------------------------------------

// UHPP_SYMBOL_KINDS is re-exported from atls_core::indexer::uhpp_extractor
// (single source of truth for symbol kind regex patterns).

/// All UHPP symbol kind prefixes accepted in anchors like `kind(name)`.
/// Includes aliases (class→cls, ns→mod, namespace→mod, package→mod).
pub const UHPP_ANCHOR_PREFIXES: &[(&str, Option<&str>)] = &[
    ("fn", Some("fn")),
    ("sym", None),
    ("cls", Some("cls")),
    ("class", Some("cls")),
    ("struct", Some("struct")),
    ("trait", Some("trait")),
    ("interface", Some("trait")),
    ("protocol", Some("protocol")),
    ("enum", Some("enum")),
    ("record", Some("record")),
    ("extension", Some("extension")),
    ("mixin", Some("mixin")),
    ("impl", Some("impl")),
    ("type", Some("type")),
    ("const", Some("const")),
    ("static", Some("static")),
    ("mod", Some("mod")),
    ("ns", Some("mod")),
    ("namespace", Some("mod")),
    ("package", Some("mod")),
    ("macro", Some("macro")),
    ("ctor", Some("ctor")),
    ("property", Some("property")),
    ("field", Some("field")),
    ("enum_member", Some("enum_member")),
    ("variant", Some("enum_member")),
    ("operator", Some("operator")),
    ("event", Some("event")),
    ("object", Some("object")),
    ("actor", Some("actor")),
    ("union", Some("union")),
];

/// Resolve an anchor prefix string to its canonical kind.
pub fn resolve_anchor_kind(prefix: &str) -> Option<Option<&'static str>> {
    UHPP_ANCHOR_PREFIXES
        .iter()
        .find(|(p, _)| *p == prefix)
        .map(|(_, kind)| *kind)
}

/// Check if a string starts with any known symbol anchor prefix (e.g. "fn(", "cls(").
pub fn is_symbol_anchor_str(s: &str) -> bool {
    UHPP_ANCHOR_PREFIXES.iter().any(|(prefix, _)| {
        s.starts_with(prefix) && s[prefix.len()..].starts_with('(')
    })
}

/// Parse a symbol anchor string like "fn(name)" into (kind, name).
/// Returns (canonical_kind_option, symbol_name) or None if not a valid anchor.
pub fn parse_symbol_anchor_str(s: &str) -> Option<(Option<&'static str>, &str)> {
    let trimmed = s.trim();
    for (prefix, _) in UHPP_ANCHOR_PREFIXES {
        if trimmed.starts_with(prefix) && trimmed[prefix.len()..].starts_with('(') {
            let open = prefix.len();
            let close = trimmed.rfind(')')?;
            if close <= open + 1 { return None; }
            let name = &trimmed[open + 1..close];
            return Some((resolve_anchor_kind(prefix).flatten(), name));
        }
    }
    None
}

/// Extract symbol names from content (fn/def/class/etc declarations).
/// Scans line-by-line so large files do not run catastrophic backtracking over the whole buffer.
pub fn extract_symbol_names(content: &str, kind: Option<&str>) -> Vec<String> {
    let kind_pattern = match kind {
        Some(k) => {
            match UHPP_SYMBOL_KINDS.iter().find(|(name, _)| *name == k) {
                Some((_, pat)) => *pat,
                None => return vec![],
            }
        }
        _ => r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:unsafe\s+)?(?:const\s+)?(?:async\s+)?(?:extern\s+\S+\s+)?(?:fn|fun|function|def|func(?:\s+\([^)]*\))?|class|struct|interface|trait|enum|type|impl|macro_rules!\s|protocol|record|extension|mixin|object|actor|union)\s*(?:self\.)?(\w+)",
    };
    let re = match regex::Regex::new(kind_pattern) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let mut names = std::collections::HashSet::new();
    for line in content.lines() {
        // Skip extremely long lines (minified bundles) — regex cost is per-line.
        if line.len() > 16_384 {
            continue;
        }
        for cap in re.captures_iter(line) {
            if let Some(m) = cap.get(1) {
                names.insert(m.as_str().to_string());
            }
        }
    }
    names.into_iter().collect()
}

/// Find names similar to the search term (substring, prefix, or contains).
fn find_similar_names(names: &[String], search: &str) -> Vec<String> {
    let search_lower = search.to_lowercase();
    let mut scored: Vec<(i32, &str)> = names
        .iter()
        .filter_map(|n| {
            let nl = n.to_lowercase();
            let score = if nl == search_lower {
                100
            } else if nl.starts_with(&search_lower) || search_lower.starts_with(&nl) {
                50
            } else if nl.contains(&search_lower) || search_lower.contains(&nl) {
                25
            } else {
                0
            };
            if score > 0 {
                Some((score, n.as_str()))
            } else {
                None
            }
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().map(|(_, n)| n.to_string()).take(5).collect()
}

/// Resolve a named symbol to its content span.
/// Uses regex-based extraction (no ATLS index dependency).
/// Parse `#N` overload suffix from name (e.g. "toJson#2" -> ("toJson", Some(2)))
pub fn parse_overload_index(name: &str) -> (&str, Option<usize>) {
    if let Some(hash_pos) = name.rfind('#') {
        if let Ok(idx) = name[hash_pos + 1..].parse::<usize>() {
            return (&name[..hash_pos], Some(idx));
        }
    }
    (name, None)
}

fn kind_to_regex_prefix(kind: Option<&str>) -> &'static str {
    match kind {
        Some("fn") => r"(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:const\s+)?(?:async\s+)?(?:extern\s+\S+\s+)?(?:fn|fun|function|def|func(?:\s+\([^)]*\))?|method)\s+(?:self\.)?",
        Some("cls") | Some("class") => r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:abstract\s+)?\bclass\s+",
        Some("struct") => r"(?:pub(?:\([^)]*\))?\s+)?\bstruct\s+",
        Some("trait") | Some("interface") => r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:\btrait|\binterface)\s+",
        Some("protocol") => r"(?:public\s+|open\s+|internal\s+|fileprivate\s+|private\s+)?(?:@objc\s+)?\bprotocol\s+",
        Some("enum") => r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?\benum\s+",
        Some("record") => r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|sealed\s+)?(?:data\s+)?\brecord\s+",
        Some("extension") => r"(?:public\s+|open\s+|internal\s+|fileprivate\s+|private\s+)?\bextension\s+",
        Some("mixin") => r"\bmixin\s+",
        Some("macro") => r"(?:pub(?:\([^)]*\))?\s+)?(?:macro_rules!\s+|\bmacro\s+|#\s*define\s+)",
        Some("type") => r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:\btype|\btypedef)\s+",
        Some("impl") => r"(?:pub(?:\([^)]*\))?\s+)?impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?",
        Some("const") | Some("static") => r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:const|static|final)\s+(?:\w+\s+)?",
        Some("mod") | Some("ns") | Some("namespace") | Some("package") => r"(?:pub(?:\([^)]*\))?\s+)?(?:mod|module|namespace|package)\s+",
        Some("ctor") => r"(?:public|protected|private|internal)?\s*(?:constructor|new)\s*",
        Some("property") => r"(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:readonly\s+)?(?:get|set)\s+",
        Some("field") => r"(?:public\s+|private\s+|protected\s+|internal\s+)?(?:readonly\s+|static\s+)?(?:\w+\s+)+",
        Some("enum_member") | Some("variant") => r"^\s*",
        Some("operator") => r"\boperator\s*",
        Some("event") => r"\bevent\s+\w+\s+",
        Some("object") => r"(?:companion\s+)?\bobject\s+",
        Some("actor") => r"(?:public\s+|open\s+|internal\s+|fileprivate\s+|private\s+)?\bactor\s+",
        Some("union") => r"\bunion\s+",
        _ => r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:unsafe\s+)?(?:const\s+)?(?:async\s+)?(?:extern\s+\S+\s+)?(?:fn|fun|function|def|func(?:\s+\([^)]*\))?|class|struct|interface|trait|enum|type|impl|macro_rules!\s|protocol|record|extension|mixin|object|actor|union)\s*(?:self\.)?",
    }
}

/// Check if a single-line match is a bodyless declaration (re-export, type alias, etc.)
fn is_bodyless_line(line: &str) -> bool {
    is_bodyless_or_reexport_line(line)
}

/// Returns true if the symbol appears in content only on re-export/import lines
/// (export { X } from '...' or import { X } from '...'). Used for preflight before
/// index lookup so we can return a clear diagnostic instead of "symbol not found".
pub fn symbol_only_in_reexport_import_lines(content: &str, symbol: &str) -> bool {
    if symbol.is_empty() {
        return false;
    }
    let pattern = format!(r"\b{}\b", regex::escape(symbol));
    let re = match regex::Regex::new(&pattern) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let mut has_any_match = false;
    let mut has_non_reexport_match = false;
    for line in content.lines() {
        if re.is_match(line) {
            has_any_match = true;
            if !is_bodyless_or_reexport_line(line) {
                has_non_reexport_match = true;
                break;
            }
        }
    }
    has_any_match && !has_non_reexport_match
}

/// Public check for re-export/import-only lines. Use before extraction to reject
/// symbols that have no local definition (export { X } from '...', import { X } from '...').
pub fn is_bodyless_or_reexport_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.ends_with(';') && !trimmed.contains('{') {
        return true;
    }
    // JS/TS re-exports and imports: export { X } from '...' / import { X } from '...'
    // These bindings are not local definitions — extracting would fail.
    if (trimmed.starts_with("export {") || trimmed.starts_with("import {"))
        && trimmed.contains(" from ")
    {
        return true;
    }
    false
}

pub fn resolve_symbol_anchor(
    content: &str,
    kind: Option<&str>,
    name: &str,
) -> Result<String, AtlsError> {
    let (base_name, overload_idx) = parse_overload_index(name);
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    let kind_pattern = kind_to_regex_prefix(kind);
    let pattern = format!(r"{}{}(?:\s|[<({{:,;]|$)", kind_pattern, regex::escape(base_name));
    let re = match regex::Regex::new(&pattern) {
        Ok(r) => r,
        Err(_) => return Err(AtlsError::ValidationError {
            field: "symbol_anchor".into(),
            message: format!("invalid symbol name: {}", base_name),
        }),
    };

    // Cheap substring pre-filter: only run the expensive regex on lines containing the name.
    let matches: Vec<usize> = lines.iter().enumerate()
        .filter(|(_, line)| line.contains(base_name) && re.is_match(line))
        .map(|(i, _)| i)
        .collect();

    if matches.is_empty() {
        let names = extract_symbol_names(content, kind);
        let similar = find_similar_names(&names, base_name);
        let context = if similar.is_empty() {
            "not found in content via regex search".to_string()
        } else {
            format!("not found. Did you mean: {}?", similar.join(", "))
        };
        return Err(AtlsError::NotFound {
            resource: format!("symbol '{}'", base_name),
            context,
        });
    }

    // Overload selection: #N is 1-indexed; default picks first
    let target_idx = overload_idx.unwrap_or(1);
    if target_idx == 0 || target_idx > matches.len() {
        return Err(AtlsError::ValidationError {
            field: "symbol_anchor".into(),
            message: format!(
                "overload #{} out of range for '{}' ({} found). Use #1..#{}",
                target_idx, base_name, matches.len(), matches.len()
            ),
        });
    }
    let start = matches[target_idx - 1];

    // Bodyless declaration check (re-exports, type aliases, forward decls).
    // Skip for kinds that are inherently single-line (const, static, type, macro).
    let skip_bodyless = matches!(kind, Some("const") | Some("static") | Some("type") | Some("macro") | Some("field") | Some("property") | Some("enum_member") | Some("variant") | Some("event"));
    if !skip_bodyless && is_bodyless_line(lines[start]) {
        let end = find_block_end(&lines, start, total, None);
        if end == start {
            return Err(AtlsError::ValidationError {
                field: "symbol_anchor".into(),
                message: format!(
                    "symbol '{}' at line {} is a bodyless declaration (re-export/alias/forward-decl). \
                     Use line-range extraction instead: remove_lines: \"{}\"",
                    base_name, start + 1, start + 1
                ),
            });
        }
    }

    let end = find_block_end(&lines, start, total, None);
    let extracted: Vec<&str> = lines[start..=end].to_vec();
    Ok(extracted.join("\n"))
}

/// Like `resolve_symbol_anchor` but returns 1-based (start, end) line numbers
/// instead of the extracted content. Used by refactor pipeline for symbol-addressed
/// `remove_lines`.
pub fn resolve_symbol_anchor_lines(
    content: &str,
    kind: Option<&str>,
    name: &str,
) -> Result<(u32, u32), AtlsError> {
    let (base_name, overload_idx) = parse_overload_index(name);
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    let kind_pattern = kind_to_regex_prefix(kind);
    let pattern = format!(r"{}{}(?:\s|[<({{:,;]|$)", kind_pattern, regex::escape(base_name));
    let re = regex::Regex::new(&pattern).map_err(|_| AtlsError::ValidationError {
        field: "symbol_anchor".into(),
        message: format!("invalid symbol name: {}", base_name),
    })?;

    // Cheap substring pre-filter: only run the expensive regex on lines containing the name.
    let matches: Vec<usize> = lines.iter().enumerate()
        .filter(|(_, line)| line.contains(base_name) && re.is_match(line))
        .map(|(i, _)| i)
        .collect();

    if matches.is_empty() {
        let names = extract_symbol_names(content, kind);
        let similar = find_similar_names(&names, base_name);
        let context = if similar.is_empty() {
            "not found in content via regex search".to_string()
        } else {
            format!("not found. Did you mean: {}?", similar.join(", "))
        };
        return Err(AtlsError::NotFound {
            resource: format!("symbol '{}'", base_name),
            context,
        });
    }

    let target_idx = overload_idx.unwrap_or(1);
    if target_idx == 0 || target_idx > matches.len() {
        return Err(AtlsError::ValidationError {
            field: "symbol_anchor".into(),
            message: format!(
                "overload #{} out of range for '{}' ({} found). Use #1..#{}",
                target_idx, base_name, matches.len(), matches.len()
            ),
        });
    }
    let start = matches[target_idx - 1];
    let end = find_block_end(&lines, start, total, None);

    Ok((start as u32 + 1, end as u32 + 1))
}

/// Find the end of a block starting at `start_line`.
/// String/comment-aware brace tracking: ignores `{`/`}` inside string literals,
/// line comments, and block comments. Falls back to indentation for Python,
/// and `def...end` keyword tracking for Ruby/Elixir.
/// For C/C++, `lang` enables preprocessor handling: includes trailing `#endif`
/// when the block is inside `#if`/`#ifdef`/`#ifndef`.
fn find_block_end(lines: &[&str], start: usize, total: usize, lang: Option<&str>) -> usize {
    let start_trimmed = lines[start].trim();
    if start_trimmed.ends_with(';') && !start_trimmed.contains('{') {
        return start;
    }

    // Ruby/Elixir: keyword-block tracking (def...end)
    if is_ruby_like_block(start_trimmed) {
        return find_keyword_block_end(lines, start, total);
    }

    // Python blocks end with ':' and use indentation, not braces.
    // Skip brace tracking to avoid premature exit on dict/set literals like {}.
    let indent_only = start_trimmed.ends_with(':');

    let mut depth = 0i32;
    let mut found_open = false;
    let mut in_line_comment;
    let mut in_block_comment = false;
    let mut in_string: Option<char> = None;
    let mut in_raw_string: Option<usize> = None; // Some(hash_count) when inside r#"..."#

    let mut i = start;
    while i < total {
        in_line_comment = false;
        let chars: Vec<char> = lines[i].chars().collect();
        let len = chars.len();
        let mut j = 0;
        while j < len {
            // Inside a multi-line raw string — scan for closing "###
            if let Some(hashes) = in_raw_string {
                if chars[j] == '"' {
                    let mut trailing = 0;
                    while trailing < hashes && j + 1 + trailing < len && chars[j + 1 + trailing] == '#' {
                        trailing += 1;
                    }
                    if trailing == hashes {
                        j += 1 + hashes;
                        in_raw_string = None;
                        continue;
                    }
                }
                j += 1;
                continue;
            }
            if in_block_comment {
                if j + 1 < len && chars[j] == '*' && chars[j + 1] == '/' {
                    in_block_comment = false;
                    j += 2;
                    continue;
                }
                j += 1;
                continue;
            }
            if in_line_comment {
                j += 1;
                continue;
            }
            if let Some(quote) = in_string {
                if chars[j] == '\\' && j + 1 < len {
                    j += 2;
                    continue;
                }
                if chars[j] == quote {
                    in_string = None;
                }
                j += 1;
                continue;
            }
            if j + 1 < len && chars[j] == '/' && chars[j + 1] == '/' {
                in_line_comment = true;
                j += 2;
                continue;
            }
            if j + 1 < len && chars[j] == '/' && chars[j + 1] == '*' {
                in_block_comment = true;
                j += 2;
                continue;
            }
            // Rust raw strings: r"...", r#"..."#, r##"..."## etc.
            if chars[j] == 'r' && j + 1 < len && (chars[j + 1] == '#' || chars[j + 1] == '"') {
                let mut hashes = 0usize;
                let mut k = j + 1;
                while k < len && chars[k] == '#' { hashes += 1; k += 1; }
                if k < len && chars[k] == '"' {
                    k += 1;
                    // Scan remainder of this line for closing pattern
                    let mut closed = false;
                    while k < len {
                        if chars[k] == '"' {
                            let mut trailing = 0;
                            while trailing < hashes && k + 1 + trailing < len && chars[k + 1 + trailing] == '#' {
                                trailing += 1;
                            }
                            if trailing == hashes {
                                j = k + 1 + hashes;
                                closed = true;
                                break;
                            }
                        }
                        k += 1;
                    }
                    if !closed {
                        in_raw_string = Some(hashes);
                        j = len;
                    }
                    continue;
                }
            }
            if chars[j] == '"' || chars[j] == '\'' || chars[j] == '`' {
                in_string = Some(chars[j]);
                j += 1;
                continue;
            }
            if !indent_only {
                match chars[j] {
                    '{' => { depth += 1; found_open = true; }
                    '[' => {
                        // Skip empty [] (type annotations like SectionDef[])
                        if j + 1 < len && chars[j + 1] == ']' {
                            j += 2;
                            continue;
                        }
                        depth += 1; found_open = true;
                    }
                    '}' | ']' if found_open => {
                        depth -= 1;
                        if depth <= 0 { return i; }
                    }
                    _ => {}
                }
            }
            j += 1;
        }

        if !found_open && i > start && in_raw_string.is_none() {
            let trimmed_line = lines[i].trim();
            // Rust `where` clauses and trait bounds are continuation lines that
            // precede the opening brace — don't bail out on them.
            let is_rust_continuation = trimmed_line == "where"
                || trimmed_line.starts_with("where ")
                || trimmed_line.ends_with(',')
                || trimmed_line.ends_with('+');
            if !is_rust_continuation {
                let current_indent = lines[i].len() - lines[i].trim_start().len();
                let start_indent = lines[start].len() - lines[start].trim_start().len();
                if current_indent <= start_indent && !trimmed_line.is_empty() {
                    return i.saturating_sub(1).max(start);
                }
            }
        }
        i += 1;
    }

    let end = (start..total)
        .rev()
        .find(|&i| !lines[i].trim().is_empty())
        .unwrap_or(total.saturating_sub(1));

    // C/C++: include trailing #endif when the block was inside #if/#ifdef/#ifndef
    let is_cfam = matches!(lang, Some("c") | Some("cpp"));
    if is_cfam && end + 1 < total {
        let next = lines[end + 1].trim();
        if next == "#endif" || next.starts_with("#endif ") || next.starts_with("#endif\t") {
            return end + 1;
        }
    }

    end
}

/// Check if a line starts a Ruby/Elixir keyword block.
/// Excludes Python (always ends with ':') to avoid misrouting into end-keyword scanning.
fn is_ruby_like_block(trimmed: &str) -> bool {
    let first_word = trimmed.split_whitespace().next().unwrap_or("");
    matches!(first_word, "def" | "class" | "module" | "do" | "begin" | "if" | "unless" | "case")
        && !trimmed.contains('{')
        && !trimmed.ends_with(':')
}

/// Track Ruby/Elixir `def...end` keyword blocks.
fn find_keyword_block_end(lines: &[&str], start: usize, total: usize) -> usize {
    let openers = ["def", "class", "module", "do", "begin", "if", "unless", "case", "for", "while", "until"];
    let mut depth = 0i32;

    for i in start..total {
        let trimmed = lines[i].trim();
        let words: Vec<&str> = trimmed.split_whitespace().collect();
        if let Some(first) = words.first() {
            if openers.contains(first) && !trimmed.ends_with("end") {
                depth += 1;
            }
        }
        if trimmed == "end" || trimmed.starts_with("end ") || trimmed.starts_with("end;") || trimmed.starts_with("end)") {
            depth -= 1;
            if depth <= 0 { return i; }
        }
    }

    (start..total).rev()
        .find(|&i| !lines[i].trim().is_empty())
        .unwrap_or(total.saturating_sub(1))
}

// ---------------------------------------------------------------------------
// C-family Declaration Matching (Tier 2 — return-type syntax)
// ---------------------------------------------------------------------------

fn is_cfamily_lang(lang: &str) -> bool {
    matches!(lang, "c" | "cpp" | "java" | "csharp" | "go" | "kotlin" | "swift" | "dart" | "scala")
}

/// Match C-family function declarations that use return-type syntax
/// (e.g. `void parse_number(...)`, `public String toJson(...)`).
/// Returns 0-based line indices of matched declarations.
fn try_cfamily_fn_match(lines: &[&str], name: &str) -> Vec<usize> {
    let escaped = regex::escape(name);
    let name_re = match regex::Regex::new(&format!(r"\b{}\s*(?:<[^>]*>\s*)?\(", escaped)) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    // Reject expression contexts: name preceded by . -> = ( ,
    let reject_re = match regex::Regex::new(&format!(
        r"(?:\.|->|[=(,])\s*{}\s*(?:<[^>]*>\s*)?\(",
        escaped
    )) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let total = lines.len();
    lines.iter().enumerate()
        .filter(|(i, line)| {
            let trimmed = line.trim();
            if !name_re.is_match(trimmed) { return false; }
            if reject_re.is_match(trimmed) { return false; }
            let block_end = find_block_end(lines, *i, total, None);
            block_end > *i || trimmed.contains('{')
        })
        .map(|(i, _)| i)
        .collect()
}

// ---------------------------------------------------------------------------
// JS/TS Class Method Shorthand (Tier 1.5a)
// ---------------------------------------------------------------------------

/// Match JS/TS class method shorthand: `getUser()`, `async getUser()`,
/// `static create()`, `get name()`, `set name(v)`, `#privateMethod()`.
fn try_class_method_match(lines: &[&str], name: &str) -> Vec<usize> {
    let escaped = regex::escape(name);
    let re = match regex::Regex::new(&format!(
        r"^\s+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(?:#)?{}\s*(?:<[^>]*>\s*)?\(",
        escaped
    )) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let total = lines.len();
    lines.iter().enumerate()
        .filter(|(i, line)| {
            let trimmed = line.trim();
            if !re.is_match(line) { return false; }
            if trimmed.contains('=') && trimmed.find('=') < trimmed.find(&*escaped) { return false; }
            let block_end = find_block_end(lines, *i, total, None);
            block_end > *i || trimmed.contains('{')
        })
        .map(|(i, _)| i)
        .collect()
}

// ---------------------------------------------------------------------------
// Variable-Bound Functions (Tier 1.5b — arrow / assigned function)
// ---------------------------------------------------------------------------

/// Match JS/TS arrow functions and const-bound functions:
/// `const handler = async (req) => {`, `export const foo = () => {`,
/// `const bar = function(x) {`
fn try_variable_bound_fn_match(lines: &[&str], name: &str) -> Vec<usize> {
    let escaped = regex::escape(name);
    let arrow_re = match regex::Regex::new(&format!(
        r"^\s*(?:export\s+)?(?:const|let|var)\s+{}\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*(?::\s*[^=\n]*)?\s*=>",
        escaped
    )) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let assigned_fn_re = match regex::Regex::new(&format!(
        r"^\s*(?:export\s+)?(?:const|let|var)\s+{}\s*=\s*(?:async\s+)?function",
        escaped
    )) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let total = lines.len();
    lines.iter().enumerate()
        .filter(|(i, line)| {
            if !arrow_re.is_match(line) && !assigned_fn_re.is_match(line) { return false; }
            let block_end = find_block_end(lines, *i, total, None);
            block_end > *i || line.contains('{')
        })
        .map(|(i, _)| i)
        .collect()
}

// ---------------------------------------------------------------------------
// Go Type Declarations
// ---------------------------------------------------------------------------

/// Match Go `type Name struct/interface` declarations.
fn try_go_type_match(lines: &[&str], name: &str, kind: Option<&str>) -> Vec<usize> {
    let escaped = regex::escape(name);
    let type_suffix = match kind {
        Some("struct") => r"\s+struct\b",
        Some("trait") | Some("interface") => r"\s+interface\b",
        _ => r"(?:\s+(?:struct|interface)\b)?",
    };
    let re = match regex::Regex::new(&format!(r"^\s*type\s+{}{}", escaped, type_suffix)) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let total = lines.len();
    lines.iter().enumerate()
        .filter(|(i, line)| {
            if !re.is_match(line) { return false; }
            let block_end = find_block_end(lines, *i, total, None);
            block_end >= *i
        })
        .map(|(i, _)| i)
        .collect()
}

// ---------------------------------------------------------------------------
// Universal Attribute/Decorator Expansion
// ---------------------------------------------------------------------------

/// Walk backward from `match_line` to include contiguous attribute/decorator lines.
/// Handles: @decorators (Python/Java/Kotlin), #[attrs] (Rust), [Attrs] (C#),
/// template<> (C++), __attribute__ (GCC), /// doc comments (Rust).
fn expand_to_attributes(lines: &[&str], match_line: usize) -> usize {
    let mut start = match_line;
    while start > 0 {
        let prev = lines[start - 1].trim();
        if prev.starts_with('@') ||
           prev.starts_with("#[") ||
           prev.starts_with("///") || prev.starts_with("//!") ||
           prev.starts_with("template") ||
           prev.starts_with("namespace ") ||
           prev.starts_with("__attribute__") ||
           prev.starts_with("[[") ||
           (prev.starts_with('[') && !prev.starts_with("[//")) {
            start -= 1;
            continue;
        }
        break;
    }
    start
}

// ---------------------------------------------------------------------------
// Qualified Symbol Paths (fn(Class.method) / fn(Class::method))
// ---------------------------------------------------------------------------

/// If name contains `.` or `::`, resolve as a qualified path by first finding
/// the scope (class/struct/impl/namespace), then searching within it.
fn resolve_qualified_symbol(
    lines: &[&str], kind: Option<&str>, name: &str, lang: Option<&str>,
) -> Option<(usize, usize)> {
    let (scope, local) = if let Some(pos) = name.find("::") {
        (&name[..pos], &name[pos + 2..])
    } else if let Some(pos) = name.rfind('.') {
        (&name[..pos], &name[pos + 1..])
    } else {
        return None;
    };

    let total = lines.len();
    let scope_re = match regex::Regex::new(&format!(
        r"(?:class|struct|impl|namespace|interface|trait|object|module)\s+(?:<[^>]*>\s+)?(?:\w+\s+for\s+)?{}",
        regex::escape(scope)
    )) {
        Ok(r) => r,
        Err(_) => return None,
    };
    let go_scope_re = match regex::Regex::new(&format!(r"type\s+{}\s+(?:struct|interface)", regex::escape(scope))) {
        Ok(r) => r,
        Err(_) => return None,
    };

    for (i, line) in lines.iter().enumerate() {
        if !scope_re.is_match(line) && !go_scope_re.is_match(line) { continue; }
        let scope_end = find_block_end(lines, i, total, None);
        let scoped_lines: Vec<&str> = lines[i..=scope_end].to_vec();
        let (base_local, overload_idx) = parse_overload_index(local);

        let kind_prefix = kind_to_regex_prefix(kind);
        let pattern = format!(r"{}{}(?:\s|[<({{:,;]|$)", kind_prefix, regex::escape(base_local));
        let inner_re = match regex::Regex::new(&pattern) { Ok(r) => r, Err(_) => continue };
        let inner_matches: Vec<usize> = scoped_lines.iter().enumerate()
            .filter(|(_, l)| inner_re.is_match(l))
            .map(|(j, _)| j)
            .collect();
        if inner_matches.is_empty() {
            if let Some(lang_str) = lang {
                if is_cfamily_lang(lang_str) {
                    let cm = try_cfamily_fn_match(&scoped_lines, base_local);
                    if !cm.is_empty() {
                        let ti = overload_idx.unwrap_or(1);
                        if ti >= 1 && ti <= cm.len() {
                            let raw = cm[ti - 1];
                            let start = expand_to_attributes(&lines, i + raw) ;
                            let end = find_block_end(lines, i + raw, total, None);
                            return Some((start, end));
                        }
                    }
                }
            }
            let cm = try_class_method_match(&scoped_lines, base_local);
            if !cm.is_empty() {
                let ti = overload_idx.unwrap_or(1);
                if ti >= 1 && ti <= cm.len() {
                    let raw = cm[ti - 1];
                    let start = expand_to_attributes(&lines, i + raw);
                    let end = find_block_end(lines, i + raw, total, None);
                    return Some((start, end));
                }
            }
            continue;
        }
        let ti = overload_idx.unwrap_or(1);
        if ti >= 1 && ti <= inner_matches.len() {
            let raw = inner_matches[ti - 1];
            let start = expand_to_attributes(&lines, i + raw);
            let end = find_block_end(lines, i + raw, total, None);
            return Some((start, end));
        }
    }
    None
}

fn enhance_not_found_error(err: AtlsError, lang: Option<&str>) -> AtlsError {
    let hint = match lang {
        Some(l) if is_cfamily_lang(l) => format!(
            ". For {} functions, ensure the hash has lang metadata. \
             Hint: use shape:\"sig\" to list all symbols, or try sym(NAME) for kind-agnostic search",
            l
        ),
        _ => ". Hint: use shape:\"sig\" to list all symbols, or try sym(NAME) for kind-agnostic search".to_string(),
    };
    match err {
        AtlsError::NotFound { resource, context } => {
            AtlsError::NotFound { resource, context: format!("{}{}", context, hint) }
        }
        other => other,
    }
}

/// Language-aware symbol resolution with full tier cascade:
/// Tier 1: keyword regex, Tier 1.5a: class method shorthand,
/// Tier 1.5b: arrow/const-bound functions, Tier 2: C-family return-type,
/// plus Go type declarations and qualified path support.
pub fn resolve_symbol_anchor_lang(
    content: &str,
    kind: Option<&str>,
    name: &str,
    lang: Option<&str>,
) -> Result<String, AtlsError> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let (base_name, overload_idx) = parse_overload_index(name);

    // Qualified path resolution: fn(Class.method) / fn(Class::method)
    if base_name.contains('.') || base_name.contains("::") {
        if let Some((start, end)) = resolve_qualified_symbol(&lines, kind, name, lang) {
            return Ok(lines[start..=end].join("\n"));
        }
    }

    // Tier 1: keyword regex
    match resolve_symbol_anchor(content, kind, name) {
        Ok(result) => {
            // Apply attribute expansion to Tier 1 results
            let kind_prefix = kind_to_regex_prefix(kind);
            let pattern = format!(r"{}{}(?:\s|[<({{:,;]|$)", kind_prefix, regex::escape(base_name));
            if let Ok(re) = regex::Regex::new(&pattern) {
                let target = overload_idx.unwrap_or(1);
                let m_lines: Vec<usize> = lines.iter().enumerate()
                    .filter(|(_, l)| l.contains(base_name) && re.is_match(l)).map(|(i, _)| i).collect();
                if target >= 1 && target <= m_lines.len() {
                    let raw = m_lines[target - 1];
                    let attr_start = expand_to_attributes(&lines, raw);
                    if attr_start < raw {
                        let end = find_block_end(&lines, raw, total, lang);
                        return Ok(lines[attr_start..=end].join("\n"));
                    }
                }
            }
            return Ok(result);
        }
        Err(tier1_err) => {
            // Tier 1.5a: JS/TS class method shorthand
            if matches!(kind, Some("fn") | None) {
                let cm = try_class_method_match(&lines, base_name);
                if !cm.is_empty() {
                    let ti = overload_idx.unwrap_or(1);
                    if ti >= 1 && ti <= cm.len() {
                        let raw = cm[ti - 1];
                        let start = expand_to_attributes(&lines, raw);
                        let end = find_block_end(&lines, raw, total, lang);
                        return Ok(lines[start..=end].join("\n"));
                    }
                    return Err(AtlsError::ValidationError {
                        field: "symbol_anchor".into(),
                        message: format!(
                            "overload #{} out of range for '{}' ({} found via class method match). Use #1..#{}",
                            ti, base_name, cm.len(), cm.len()
                        ),
                    });
                }

                // Tier 1.5b: arrow / const-bound functions
                let vb = try_variable_bound_fn_match(&lines, base_name);
                if !vb.is_empty() {
                    let ti = overload_idx.unwrap_or(1);
                    if ti >= 1 && ti <= vb.len() {
                        let raw = vb[ti - 1];
                        let start = expand_to_attributes(&lines, raw);
                        let end = find_block_end(&lines, raw, total, lang);
                        return Ok(lines[start..=end].join("\n"));
                    }
                }
            }

            // Tier 2: C-family return-type syntax
            if let Some(lang_str) = lang {
                if is_cfamily_lang(lang_str) && matches!(kind, Some("fn") | None) {
                    let matches = try_cfamily_fn_match(&lines, base_name);
                    if !matches.is_empty() {
                        let ti = overload_idx.unwrap_or(1);
                        if ti >= 1 && ti <= matches.len() {
                            let raw = matches[ti - 1];
                            let start = expand_to_attributes(&lines, raw);
                            let end = find_block_end(&lines, raw, total, lang);
                            return Ok(lines[start..=end].join("\n"));
                        }
                        return Err(AtlsError::ValidationError {
                            field: "symbol_anchor".into(),
                            message: format!(
                                "overload #{} out of range for '{}' ({} found via C-family match). Use #1..#{}",
                                ti, base_name, matches.len(), matches.len()
                            ),
                        });
                    }
                }

                // Go type declarations: struct(Name) / trait(Name) on `type Name struct/interface`
                if lang_str == "go" && matches!(kind, Some("struct") | Some("trait") | Some("interface") | Some("type") | None) {
                    let gm = try_go_type_match(&lines, base_name, kind);
                    if !gm.is_empty() {
                        let ti = overload_idx.unwrap_or(1);
                        if ti >= 1 && ti <= gm.len() {
                            let raw = gm[ti - 1];
                            let end = find_block_end(&lines, raw, total, lang);
                            return Ok(lines[raw..=end].join("\n"));
                        }
                    }
                }
            }

            Err(enhance_not_found_error(tier1_err, lang))
        }
    }
}

/// Language-aware variant of `resolve_symbol_anchor_lines`.
/// Same tier cascade as `resolve_symbol_anchor_lang` but returns 1-based line range.
pub fn resolve_symbol_anchor_lines_lang(
    content: &str,
    kind: Option<&str>,
    name: &str,
    lang: Option<&str>,
) -> Result<(u32, u32), AtlsError> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let (base_name, overload_idx) = parse_overload_index(name);

    if base_name.contains('.') || base_name.contains("::") {
        if let Some((start, end)) = resolve_qualified_symbol(&lines, kind, name, lang) {
            return Ok((start as u32 + 1, end as u32 + 1));
        }
    }

    match resolve_symbol_anchor_lines(content, kind, name) {
        Ok((start, end)) => {
            let start0 = (start as usize).saturating_sub(1);
            let attr_start = expand_to_attributes(&lines, start0);
            if attr_start < start0 {
                return Ok((attr_start as u32 + 1, end));
            }
            Ok((start, end))
        }
        Err(tier1_err) => {
            if matches!(kind, Some("fn") | None) {
                let cm = try_class_method_match(&lines, base_name);
                if !cm.is_empty() {
                    let ti = overload_idx.unwrap_or(1);
                    if ti >= 1 && ti <= cm.len() {
                            let raw = cm[ti - 1];
                            let start = expand_to_attributes(&lines, raw);
                            let end = find_block_end(&lines, raw, total, lang);
                            return Ok((start as u32 + 1, end as u32 + 1));
                    }
                }
                let vb = try_variable_bound_fn_match(&lines, base_name);
                if !vb.is_empty() {
                    let ti = overload_idx.unwrap_or(1);
                    if ti >= 1 && ti <= vb.len() {
                        let raw = vb[ti - 1];
                        let start = expand_to_attributes(&lines, raw);
                        let end = find_block_end(&lines, raw, total, lang);
                        return Ok((start as u32 + 1, end as u32 + 1));
                    }
                }
            }

            if let Some(lang_str) = lang {
                if is_cfamily_lang(lang_str) && matches!(kind, Some("fn") | None) {
                    let matches = try_cfamily_fn_match(&lines, base_name);
                    if !matches.is_empty() {
                        let ti = overload_idx.unwrap_or(1);
                        if ti >= 1 && ti <= matches.len() {
                            let raw = matches[ti - 1];
                            let start = expand_to_attributes(&lines, raw);
                            let end = find_block_end(&lines, raw, total, lang);
                            return Ok((start as u32 + 1, end as u32 + 1));
                        }
                    }
                }
                if lang_str == "go" && matches!(kind, Some("struct") | Some("trait") | Some("interface") | Some("type") | None) {
                    let gm = try_go_type_match(&lines, base_name, kind);
                    if !gm.is_empty() {
                        let ti = overload_idx.unwrap_or(1);
                        if ti >= 1 && ti <= gm.len() {
                            let raw = gm[ti - 1];
                            let end = find_block_end(&lines, raw, total, lang);
                            return Ok((raw as u32 + 1, end as u32 + 1));
                        }
                    }
                }
            }

            Err(enhance_not_found_error(tier1_err, lang))
        }
    }
}

/// Snap line ranges to enclosing function/block boundaries.
/// Searches backward from each range start for a function declaration,
/// then uses `find_block_end` to find the complete block.
pub fn snap_lines_to_block(content: &str, ranges: &[(u32, Option<u32>)]) -> Vec<(u32, Option<u32>)> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    if ranges.is_empty() || total == 0 { return ranges.to_vec(); }

    let fn_re = regex::Regex::new(
        r"^\s*(?:(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:unsafe\s+)?(?:const\s+)?(?:async\s+)?(?:extern\s+\S+\s+)?(?:fn|fun|function|def|func(?:\s+\([^)]*\))?|class|struct|interface|trait|method|macro_rules!)\s+(?:self\.)?\w+)"
    ).unwrap();

    let cfamily_re = regex::Regex::new(
        r"^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|final|inline|extern|const|volatile|async)\s+)*[\w:*&<>\[\]?,\s]+\s+\w+\s*(?:<[^>]*>\s*)?\("
    ).unwrap();

    let mut snapped = Vec::new();
    for &(start, end) in ranges {
        let s = (start as usize).saturating_sub(1).min(total.saturating_sub(1));
        let e = end.map(|v| (v as usize).saturating_sub(1).min(total.saturating_sub(1)))
            .unwrap_or(total.saturating_sub(1));

        let mut block_start = s;
        for i in (0..=s).rev() {
            if fn_re.is_match(lines[i]) || cfamily_re.is_match(lines[i]) {
                block_start = i;
                break;
            }
        }

        let block_end = find_block_end(&lines, block_start, total, None);
        if block_end >= e {
            snapped.push((block_start as u32 + 1, Some(block_end as u32 + 1)));
        } else {
            snapped.push((start, end));
        }
    }
    snapped
}

// ---------------------------------------------------------------------------
// Shape Implementations
// ---------------------------------------------------------------------------

/// Capture the full signature of a declaration, including multi-line parameter lists.
/// Scans from `start_line` forward until parentheses balance and return type is captured.
fn capture_full_signature(lines: &[&str], start_line: usize) -> String {
    let first = lines[start_line].trim_end();
    let mut sig = first.to_string();

    let mut paren_depth = 0i32;
    let mut found_open_paren = false;
    for c in first.chars() {
        if c == '(' { paren_depth += 1; found_open_paren = true; }
        if c == ')' { paren_depth -= 1; }
    }

    // Multi-line params: emit first line + (...) instead of joining all continuation lines
    if found_open_paren && paren_depth > 0 {
        sig.push_str("(...)");
    }

    // Truncate multi-line type alias bodies: `type X = A | B | ...` -> `type X = ...`
    let type_alias_re = regex::Regex::new(r"^(\s*(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=\s*)").unwrap();
    if let Some(m) = type_alias_re.find(&sig) {
        let after_eq = &sig[m.end()..];
        if after_eq.contains('|') || after_eq.contains('&') || after_eq.len() > 80 {
            sig = format!("{}...", &sig[..m.end()]);
        }
    }

    // Trim the body portion if { is on the signature line
    if let Some(brace_pos) = sig.find('{') {
        sig.truncate(brace_pos);
    }
    sig.trim_end().to_string()
}

/// Extract function/class/struct signatures, collapsing bodies to `{ ... }`.
/// Scans keyword declarations, C-family return-type functions, class method
/// shorthand, arrow functions, and Go type declarations.
fn extract_signatures(content: &str) -> String {
    // Use [^\S\n]* instead of \s* to prevent matching across line boundaries
    let sig_re = regex::Regex::new(
        r"(?m)^([^\S\n]*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:const\s+)?(?:async\s+)?(?:extern\s+\S+\s+)?(?:fn|fun|function|def|func(?:\s+\([^)]*\))?|class|struct|interface|trait|enum|type|impl)\s+(?:self\.)?\w+[^\n]*)"
    ).unwrap();

    let cfamily_re = regex::Regex::new(
        r"(?m)^([^\S\n]*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|final|inline|extern|const|volatile|async|synchronized|default)\s+)*[\w:*&<>\[\]?,]+(?:[^\S\n]+[\w:*&<>\[\]?,]+)*[^\S\n]+\w+[^\S\n]*(?:<[^>]*>[^\S\n]*)?\([^\n]*)"
    ).unwrap();

    let method_re = regex::Regex::new(
        r"(?m)^([^\S\n]+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(?:#)?\w+[^\S\n]*(?:<[^>]*>[^\S\n]*)?\([^\n]*)"
    ).unwrap();

    let arrow_re = regex::Regex::new(
        r"(?m)^([^\S\n]*(?:export\s+)?(?:const|let|var)\s+\w+[^\S\n]*(?::\s*[^=]+)?[^\S\n]*=[^\S\n]*(?:async\s+)?(?:function|\([^\n]*=>)[^\n]*)"
    ).unwrap();

    let go_type_re = regex::Regex::new(
        r"(?m)^([^\S\n]*type\s+\w+\s+(?:struct|interface|func)\b[^\n]*)"
    ).unwrap();

    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let mut covered: Vec<bool> = vec![false; total];
    let mut entries: Vec<(usize, String, usize)> = Vec::new();

    let reject_call_re = regex::Regex::new(r"(?:\.|->|[=(,])\s*\w+\s*(?:<[^>]*>\s*)?\(").unwrap();

    // Collect all regex matches with their source pass
    let mut candidates: Vec<(usize, bool, bool)> = Vec::new(); // (byte_offset, reject_calls, is_method)

    for m in sig_re.find_iter(content) { candidates.push((m.start(), false, false)); }
    for m in go_type_re.find_iter(content) { candidates.push((m.start(), false, false)); }
    for m in cfamily_re.find_iter(content) { candidates.push((m.start(), true, false)); }
    for m in method_re.find_iter(content) { candidates.push((m.start(), false, true)); }
    for m in arrow_re.find_iter(content) { candidates.push((m.start(), false, false)); }

    for (byte_start, reject_calls, is_method) in candidates {
        let match_start = content[..byte_start].chars().filter(|&c| c == '\n').count();
        if match_start >= total || covered[match_start] { continue; }

        let trimmed = lines[match_start].trim();
        if trimmed.is_empty() { continue; }
        if reject_calls && reject_call_re.is_match(trimmed) { continue; }
        if is_method && trimmed.contains('=') { continue; }

        let end_of_block = find_block_end(&lines, match_start, total, None);
        if is_method && end_of_block <= match_start && !trimmed.contains('{') { continue; }
        if end_of_block < match_start { continue; }

        let sig = capture_full_signature(&lines, match_start);
        entries.push((match_start, sig, end_of_block));
        for j in match_start..=end_of_block.min(total - 1) {
            covered[j] = true;
        }
    }

    entries.sort_by_key(|(line, _, _)| *line);

    let mut output = Vec::new();
    for (line_num_0, sig, end_of_block) in &entries {
        let line_num = line_num_0 + 1;
        let span = end_of_block.saturating_sub(*line_num_0) + 1;
        if span <= 2 {
            // Short block (1-2 lines): emit inline verbatim instead of sig + fold
            for j in *line_num_0..=(*end_of_block).min(total - 1) {
                output.push(format!("{:>4}|{}", j + 1, lines[j]));
            }
        } else if *end_of_block > *line_num_0 + 1 {
            output.push(format!("{:>4}|{} {{ ... }}  [{} lines]", line_num, sig.trim(), span));
        } else {
            output.push(format!("{:>4}|{}", line_num, sig.trim()));
        }
    }

    if output.is_empty() {
        head(content, 20)
    } else {
        output.join("\n")
    }
}

/// Fold nested blocks deeper than one level.
fn fold_nested(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut output = Vec::new();
    let mut depth = 0i32;
    let mut folding = false;
    let mut fold_start_depth = 0;

    for (i, line) in lines.iter().enumerate() {
        let open_count = line.chars().filter(|&c| c == '{').count() as i32;
        let close_count = line.chars().filter(|&c| c == '}').count() as i32;

        if !folding {
            if depth >= 2 && open_count > 0 {
                folding = true;
                fold_start_depth = depth;
                output.push(format!("{:>4}|{} // ... folded", i + 1, line.trim_end()));
            } else {
                output.push(format!("{:>4}|{}", i + 1, line));
            }
        }

        depth += open_count - close_count;

        if folding && depth <= fold_start_depth {
            folding = false;
            if close_count > 0 {
                output.push(format!("{:>4}|{}", i + 1, line));
            }
        }
    }

    output.join("\n")
}

/// Strip common leading indentation from all non-empty lines.
fn dedent(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let min_indent = lines.iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);

    if min_indent == 0 {
        return content.to_string();
    }

    lines.iter()
        .map(|l| {
            if l.len() >= min_indent {
                &l[min_indent..]
            } else {
                l.trim()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Comment/String Neutralization (for :refs identifier scanning)
// ---------------------------------------------------------------------------

/// Replace the interior of comments and string literals with spaces,
/// preserving line structure and character positions. Template literal
/// `${expr}` interiors are kept intact (they contain real code).
pub fn neutralize_comments_and_strings(content: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(content.len());
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    let mut in_block_comment = false;
    let mut in_line_comment = false;
    let mut in_string: Option<u8> = None; // b'"', b'\'', b'`'
    let mut in_raw_string: Option<usize> = None; // Rust r#"..."# hash count
    let mut template_depth: i32 = 0; // depth of ${} inside template literals

    while i < len {
        // Newline resets line comment
        if bytes[i] == b'\n' {
            in_line_comment = false;
            out.push(b'\n');
            i += 1;
            continue;
        }

        // Inside Rust raw string
        if let Some(hashes) = in_raw_string {
            if bytes[i] == b'"' {
                let mut trailing = 0;
                while trailing < hashes && i + 1 + trailing < len && bytes[i + 1 + trailing] == b'#' {
                    trailing += 1;
                }
                if trailing == hashes {
                    out.push(b' ');
                    for _ in 0..hashes { out.push(b' '); }
                    i += 1 + hashes;
                    in_raw_string = None;
                    continue;
                }
            }
            out.push(b' ');
            i += 1;
            continue;
        }

        // Inside block comment
        if in_block_comment {
            if i + 1 < len && bytes[i] == b'*' && bytes[i + 1] == b'/' {
                out.push(b' ');
                out.push(b' ');
                i += 2;
                in_block_comment = false;
                continue;
            }
            out.push(b' ');
            i += 1;
            continue;
        }

        // Inside line comment
        if in_line_comment {
            out.push(b' ');
            i += 1;
            continue;
        }

        // Inside string literal
        if let Some(quote) = in_string {
            // Template literal ${expr} — keep the expression content
            if quote == b'`' && bytes[i] == b'$' && i + 1 < len && bytes[i + 1] == b'{' {
                template_depth += 1;
                out.push(bytes[i]);
                out.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if quote == b'`' && template_depth > 0 {
                if bytes[i] == b'{' {
                    template_depth += 1;
                } else if bytes[i] == b'}' {
                    template_depth -= 1;
                }
                out.push(bytes[i]);
                i += 1;
                continue;
            }
            // Escape sequence
            if bytes[i] == b'\\' && i + 1 < len {
                out.push(b' ');
                out.push(b' ');
                i += 2;
                continue;
            }
            // End of string
            if bytes[i] == quote {
                in_string = None;
                out.push(b' ');
                i += 1;
                continue;
            }
            out.push(b' ');
            i += 1;
            continue;
        }

        // Detect line comment start: //
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            in_line_comment = true;
            out.push(b' ');
            out.push(b' ');
            i += 2;
            continue;
        }

        // Detect block comment start: /*
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            in_block_comment = true;
            out.push(b' ');
            out.push(b' ');
            i += 2;
            continue;
        }

        // Detect Python/Ruby/shell line comment: #
        // Only when # is at start of token position (not inside an identifier)
        if bytes[i] == b'#' && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
            // Avoid matching Rust raw strings r#"..."#
            if i > 0 && bytes[i - 1] == b'r' {
                out.push(bytes[i]);
                i += 1;
                continue;
            }
            in_line_comment = true;
            out.push(b' ');
            i += 1;
            continue;
        }

        // Detect Rust raw string: r"..." or r#"..."#
        if bytes[i] == b'r' && i + 1 < len && (bytes[i + 1] == b'#' || bytes[i + 1] == b'"') {
            let mut hash_count = 0usize;
            let mut k = i + 1;
            while k < len && bytes[k] == b'#' { hash_count += 1; k += 1; }
            if k < len && bytes[k] == b'"' {
                // Replace r, hashes, opening quote with spaces
                for _ in 0..=(k - i) { out.push(b' '); }
                i = k + 1;
                // Try to close on same line-segment
                let mut closed = false;
                while i < len && bytes[i] != b'\n' {
                    if bytes[i] == b'"' {
                        let mut trailing = 0;
                        while trailing < hash_count && i + 1 + trailing < len && bytes[i + 1 + trailing] == b'#' {
                            trailing += 1;
                        }
                        if trailing == hash_count {
                            out.push(b' ');
                            for _ in 0..hash_count { out.push(b' '); }
                            i += 1 + hash_count;
                            closed = true;
                            break;
                        }
                    }
                    out.push(b' ');
                    i += 1;
                }
                if !closed {
                    in_raw_string = Some(hash_count);
                }
                continue;
            }
        }

        // Detect string literal start
        if bytes[i] == b'"' || bytes[i] == b'\'' || bytes[i] == b'`' {
            in_string = Some(bytes[i]);
            out.push(b' ');
            i += 1;
            continue;
        }

        // Normal character — keep as-is
        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8(out).unwrap_or_else(|_| content.to_string())
}

// ---------------------------------------------------------------------------
// :refs — Identifier Scanning
// ---------------------------------------------------------------------------

/// Language keyword sets for filtering :refs output. Using a merged universal
/// set when language cannot be detected ensures no false negatives (at worst
/// a few extra keywords are excluded, which is harmless).
fn universal_keywords() -> &'static std::collections::HashSet<&'static str> {
    use std::sync::OnceLock;
    static KW: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();
    KW.get_or_init(|| {
        [
            // ── JavaScript / TypeScript (ES2024 + TS 5.x) ──────────────
            // Reserved words (ECMA-262 §12.6.2)
            "break", "case", "catch", "continue", "debugger", "default",
            "delete", "do", "else", "finally", "for", "function", "if",
            "in", "instanceof", "new", "return", "switch", "this",
            "throw", "try", "typeof", "var", "void", "while", "with",
            // Strict-mode reserved
            "class", "const", "enum", "export", "extends", "import",
            "super", "implements", "interface", "let", "package",
            "private", "protected", "public", "static", "yield",
            // Contextual keywords & future reserved
            "async", "await", "of", "from", "as", "get", "set",
            // Literals
            "true", "false", "null", "undefined",
            // TypeScript keywords
            "type", "declare", "module", "namespace", "abstract",
            "readonly", "keyof", "infer", "satisfies", "override",
            "accessor", "is", "asserts", "out", "using",
            // TS built-in type names (excluded because they're keywords, not user symbols)
            "string", "number", "boolean", "bigint", "symbol", "object",
            "any", "never", "unknown", "void",

            // ── Rust (edition 2021 + reserved) ─────────────────────────
            "fn", "let", "mut", "pub", "use", "mod", "struct", "impl",
            "trait", "where", "self", "crate", "match", "loop", "move",
            "ref", "box", "dyn", "unsafe", "extern", "macro_rules",
            "macro", "Self", "async", "await", "return", "if", "else",
            "for", "while", "break", "continue", "in", "as", "enum",
            "type", "const", "static", "true", "false", "super",
            // Rust primitive types
            "i8", "i16", "i32", "i64", "i128", "isize",
            "u8", "u16", "u32", "u64", "u128", "usize",
            "f32", "f64", "bool", "char", "str",

            // ── Python (3.12 keywords module) ──────────────────────────
            "def", "class", "return", "if", "elif", "else", "for",
            "while", "break", "continue", "pass", "import", "from",
            "as", "try", "except", "finally", "raise", "with",
            "assert", "yield", "lambda", "global", "nonlocal",
            "del", "and", "or", "not", "is", "in", "True", "False",
            "None", "async", "await",
            // Python builtins commonly misidentified
            "self", "cls", "print",

            // ── Go (spec §Keywords) ────────────────────────────────────
            "func", "package", "import", "return", "if", "else", "for",
            "range", "switch", "case", "default", "break", "continue",
            "goto", "fallthrough", "select", "chan", "go", "defer",
            "var", "const", "type", "struct", "interface", "map",
            "true", "false", "nil", "iota", "append", "len", "cap",
            "make", "new", "delete", "copy", "close", "panic",
            "recover", "complex", "real", "imag",
            // Go built-in types
            "int", "int8", "int16", "int32", "int64",
            "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
            "float32", "float64", "complex64", "complex128",
            "byte", "rune", "string", "bool", "error",

            // ── C / C++ (C23 + C++23 keywords) ────────────────────────
            "auto", "break", "case", "char", "const", "continue",
            "default", "do", "double", "else", "enum", "extern",
            "float", "for", "goto", "if", "inline", "int", "long",
            "register", "restrict", "return", "short", "signed",
            "sizeof", "static", "struct", "switch", "typedef",
            "union", "unsigned", "void", "volatile", "while",
            // C++ additional
            "alignas", "alignof", "and", "and_eq", "asm", "bitand",
            "bitor", "bool", "catch", "char8_t", "char16_t", "char32_t",
            "class", "compl", "concept", "const_cast", "consteval",
            "constexpr", "constinit", "co_await", "co_return",
            "co_yield", "decltype", "delete", "dynamic_cast",
            "explicit", "export", "false", "friend", "mutable",
            "namespace", "new", "noexcept", "not", "not_eq",
            "nullptr", "operator", "or", "or_eq", "private",
            "protected", "public", "reinterpret_cast",
            "requires", "static_assert", "static_cast", "template",
            "this", "thread_local", "throw", "true", "try", "typeid",
            "typename", "using", "virtual", "wchar_t", "xor", "xor_eq",
            "NULL", "size_t",

            // ── Java (SE 21 keywords) ──────────────────────────────────
            "abstract", "assert", "boolean", "break", "byte", "case",
            "catch", "char", "class", "const", "continue", "default",
            "do", "double", "else", "enum", "extends", "final",
            "finally", "float", "for", "goto", "if", "implements",
            "import", "instanceof", "int", "interface", "long",
            "native", "new", "package", "private", "protected",
            "public", "return", "short", "static", "strictfp",
            "super", "switch", "synchronized", "this", "throw",
            "throws", "transient", "try", "void", "volatile", "while",
            // Java contextual / reserved literals
            "true", "false", "null", "var", "yield", "record",
            "sealed", "permits", "non_sealed", "when",

            // ── C# (12.0 keywords) ─────────────────────────────────────
            "abstract", "as", "base", "bool", "break", "byte", "case",
            "catch", "char", "checked", "class", "const", "continue",
            "decimal", "default", "delegate", "do", "double", "else",
            "enum", "event", "explicit", "extern", "false", "finally",
            "fixed", "float", "for", "foreach", "goto", "if",
            "implicit", "in", "int", "interface", "internal", "is",
            "lock", "long", "namespace", "new", "null", "object",
            "operator", "out", "override", "params", "private",
            "protected", "public", "readonly", "ref", "return",
            "sbyte", "sealed", "short", "sizeof", "stackalloc",
            "static", "string", "struct", "switch", "this", "throw",
            "true", "try", "typeof", "uint", "ulong", "unchecked",
            "unsafe", "ushort", "using", "virtual", "void", "volatile",
            "while",
            // C# contextual keywords
            "add", "alias", "ascending", "async", "await", "by",
            "descending", "dynamic", "equals", "from", "get",
            "global", "group", "into", "join", "let", "managed",
            "nameof", "notnull", "on", "orderby", "partial",
            "remove", "select", "set", "unmanaged", "value", "var",
            "when", "where", "with", "yield", "init", "record",
            "required", "scoped", "file",

            // ── Ruby (3.3 keywords) ────────────────────────────────────
            "alias", "and", "begin", "break", "case", "class", "def",
            "defined", "do", "else", "elsif", "end", "ensure",
            "false", "for", "if", "in", "module", "next", "nil",
            "not", "or", "redo", "rescue", "retry", "return", "self",
            "super", "then", "true", "undef", "unless", "until",
            "when", "while", "yield",
            // Ruby common builtins
            "require", "require_relative", "include", "extend", "puts",
            "attr_reader", "attr_writer", "attr_accessor", "raise",
            "block_given", "proc", "lambda",

            // ── Swift (5.10 keywords) ──────────────────────────────────
            // Declarations
            "associatedtype", "class", "deinit", "enum", "extension",
            "fileprivate", "func", "import", "init", "inout", "internal",
            "let", "open", "operator", "private", "precedencegroup",
            "protocol", "public", "rethrows", "static", "struct",
            "subscript", "typealias", "var",
            // Statements
            "break", "case", "catch", "continue", "default", "defer",
            "do", "else", "fallthrough", "for", "guard", "if", "in",
            "repeat", "return", "switch", "throw", "where", "while",
            // Expressions & types
            "as", "any", "await", "catch", "false", "is", "nil",
            "self", "Self", "super", "throw", "throws", "true", "try",
            // Context-sensitive
            "async", "convenience", "dynamic", "final", "indirect",
            "lazy", "mutating", "nonmutating", "optional", "override",
            "required", "some", "weak", "willSet", "didSet",
            "unowned", "actor", "nonisolated", "isolated",

            // ── PHP (8.3 keywords) ─────────────────────────────────────
            "abstract", "and", "array", "as", "break", "callable",
            "case", "catch", "class", "clone", "const", "continue",
            "declare", "default", "die", "do", "echo", "else",
            "elseif", "empty", "enddeclare", "endfor", "endforeach",
            "endif", "endswitch", "endwhile", "enum", "eval", "exit",
            "extends", "false", "final", "finally", "fn", "for",
            "foreach", "function", "global", "goto", "if", "implements",
            "include", "include_once", "instanceof", "insteadof",
            "interface", "isset", "list", "match", "namespace", "new",
            "null", "or", "print", "private", "protected", "public",
            "readonly", "require", "require_once", "return", "static",
            "switch", "throw", "trait", "true", "try", "unset", "use",
            "var", "while", "xor", "yield",
            // PHP built-in types
            "int", "float", "string", "bool", "void", "never",
            "mixed", "iterable", "object", "self", "parent",

            // ── Kotlin (2.0 keywords) ──────────────────────────────────
            // Hard keywords
            "as", "break", "class", "continue", "do", "else", "false",
            "for", "fun", "if", "in", "interface", "is", "null",
            "object", "package", "return", "super", "this", "throw",
            "true", "try", "typealias", "typeof", "val", "var",
            "when", "while",
            // Soft keywords
            "by", "catch", "constructor", "delegate", "dynamic",
            "field", "file", "finally", "get", "import", "init",
            "param", "property", "receiver", "set", "setparam",
            "where", "actual", "abstract", "annotation", "companion",
            "const", "crossinline", "data", "enum", "expect",
            "external", "final", "infix", "inline", "inner",
            "internal", "lateinit", "noinline", "open", "operator",
            "out", "override", "private", "protected", "public",
            "reified",             "sealed", "suspend", "tailrec", "vararg",

            // ── Scala (3.4 keywords) ───────────────────────────────────
            "abstract", "case", "catch", "class", "def", "do", "else",
            "enum", "export", "extends", "false", "final", "finally",
            "for", "forSome", "given", "if", "implicit", "import",
            "infix", "inline", "lazy", "match", "new", "null",
            "object", "opaque", "open", "override", "package",
            "private", "protected", "return", "sealed", "super",
            "then", "this", "throw", "trait", "transparent", "true",
            "try", "type", "using", "val", "var", "while", "with",
            "yield",

            // ── Dart (3.3 keywords) ────────────────────────────────────
            "abstract", "as", "assert", "async", "await", "base",
            "break", "case", "catch", "class", "const", "continue",
            "covariant", "default", "deferred", "do", "dynamic",
            "else", "enum", "export", "extends", "extension",
            "external", "factory", "false", "final", "finally", "for",
            "get", "hide", "if", "implements", "import", "in",
            "interface", "is", "late", "library", "mixin", "new",
            "null", "of", "on", "operator", "part", "required",
            "rethrow", "return", "sealed", "set", "show", "static",
            "super", "switch", "sync", "this", "throw", "true", "try",
            "type", "typedef", "var", "void", "when", "while", "with",
            "yield",
        ]
        .into_iter()
        .collect()
    })
}

/// Extract all referenced identifiers from content, excluding language keywords.
/// Returns a deduplicated, sorted, newline-separated identifier list.
pub fn extract_refs(content: &str) -> String {
    let neutralized = neutralize_comments_and_strings(content);
    let keywords = universal_keywords();

    let re = regex::Regex::new(r"\b[A-Za-z_$][A-Za-z0-9_$]*\b").unwrap();

    let mut refs = std::collections::BTreeSet::new();
    for m in re.find_iter(&neutralized) {
        let ident = m.as_str();
        if ident.len() < 2 {
            continue;
        }
        if keywords.contains(ident) {
            continue;
        }
        refs.insert(ident.to_string());
    }

    refs.into_iter().collect::<Vec<_>>().join("\n")
}

// ---------------------------------------------------------------------------
// :deps — Symbol Dependency Analysis Orchestrator
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct CoMoveCandidate {
    pub kind: String,
    pub name: String,
    pub start_line: u32,
    pub end_line: u32,
    pub shared: bool,
}

#[derive(Debug)]
pub enum ScopeInfo {
    Module,
    Nested {
        parent_kind: String,
        parent_name: String,
        parent_start: u32,
        parent_end: u32,
        captured: Vec<String>,
    },
}

/// Extract import lines from content as a Vec<String> (raw lines, no line numbers).
fn extract_import_lines(content: &str) -> Vec<String> {
    let import_re = regex::Regex::new(
        r"(?m)^(?:\s*(?:import|use|require|from|include|#include|using)\b[^\n]*)"
    ).unwrap();

    let mut imports = Vec::new();
    let mut in_multiline = false;
    let mut current = String::new();

    for line in content.lines() {
        if in_multiline {
            current.push(' ');
            current.push_str(line.trim());
            if line.contains('}') || line.contains(')') {
                imports.push(current.clone());
                current.clear();
                in_multiline = false;
            }
            continue;
        }
        if import_re.is_match(line) {
            let trimmed = line.trim();
            // Detect multi-line import: TS/JS { without }, Python from...(, Go import (
            if (trimmed.contains('{') && !trimmed.contains('}'))
                || (trimmed.contains('(') && !trimmed.contains(')') &&
                    (trimmed.starts_with("from ") || trimmed == "import ("))
            {
                current = trimmed.to_string();
                in_multiline = true;
                continue;
            }
            imports.push(trimmed.to_string());
        }
    }
    if !current.is_empty() {
        imports.push(current);
    }
    imports
}

/// Extract tokens from an import line for cross-referencing.
/// Returns identifiers that the import provides (e.g. named imports, default, namespace).
/// Covers: Rust, Python, TS/JS, C/C++, C#, Go, Java, Kotlin, Scala, Swift, Dart, PHP, Ruby.
fn extract_import_tokens_local(import_line: &str) -> Vec<String> {
    let trimmed = import_line.trim();

    // Ruby: require 'json' / require_relative 'user_serializer'
    if trimmed.starts_with("require_relative ") || trimmed.starts_with("require ") {
        let inner = trimmed
            .trim_start_matches("require_relative ")
            .trim_start_matches("require ")
            .trim_matches('\'')
            .trim_matches('"');
        if let Some(last) = inner.rsplit(|c: char| c == '/' || c == '.').next() {
            if !last.is_empty() {
                return vec![last.to_string()];
            }
        }
        return vec![inner.to_string()];
    }

    // PHP: use App\Models\User; / use App\Models\{User, Post};
    // Must check before Rust `use` since both start with "use "
    if trimmed.starts_with("use ") && trimmed.contains('\\') {
        let inner = trimmed
            .trim_start_matches("use ")
            .trim_end_matches(';')
            .trim();
        if let Some(brace_start) = inner.find('{') {
            if let Some(brace_end) = inner.find('}') {
                return inner[brace_start + 1..brace_end]
                    .split(',')
                    .map(|s| s.trim().split(" as ").last().unwrap_or("").trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
        if let Some(last) = inner.rsplit('\\').next() {
            let last = last.split(" as ").last().unwrap_or(last).trim();
            return vec![last.to_string()];
        }
        return vec![inner.to_string()];
    }

    // Rust: use crate::types::{A, B};
    if trimmed.starts_with("use ") || trimmed.starts_with("pub use ") {
        let inner = trimmed
            .trim_start_matches("pub ")
            .trim_start_matches("use ")
            .trim_end_matches(';')
            .trim();
        if let Some(brace_start) = inner.find('{') {
            if let Some(brace_end) = inner.find('}') {
                return inner[brace_start + 1..brace_end]
                    .split(',')
                    .map(|s| s.trim().split(" as ").last().unwrap_or("").trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
        if let Some(last) = inner.rsplit("::").next() {
            return vec![last.to_string()];
        }
        return vec![inner.to_string()];
    }

    // Python: from X import Y, Z
    if trimmed.starts_with("from ") {
        if let Some(idx) = trimmed.find(" import ") {
            return trimmed[idx + 8..]
                .split(',')
                .map(|s| s.trim().split(" as ").last().unwrap_or("").trim().to_string())
                .filter(|s| !s.is_empty() && s != "(")
                .collect();
        }
    }
    // Go multi-line: import ( "fmt" "net/http" ) — joined into single line
    if trimmed.starts_with("import (") || trimmed.starts_with("import(") {
        let inner = trimmed
            .trim_start_matches("import")
            .trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .trim();
        let mut tokens = Vec::new();
        for part in inner.split_whitespace() {
            let pkg = part.trim_matches('"').trim_matches('\'').trim_end_matches(';');
            if let Some(last) = pkg.rsplit('/').next() {
                if !last.is_empty() {
                    tokens.push(last.to_string());
                }
            }
        }
        if !tokens.is_empty() {
            return tokens;
        }
    }

    if trimmed.starts_with("import ") && !trimmed.contains(" from ") && !trimmed.contains('{') {
        // Generic import: Java, Kotlin, Scala, Swift, Dart, Python, Go (single-line)
        let module = trimmed.trim_start_matches("import ").trim()
            .trim_end_matches(';')
            .split(" as ").next().unwrap_or("").trim();
        let module = module.trim_matches('"').trim_matches('\'');
        let module = module.strip_suffix(".dart").unwrap_or(module);
        if let Some(last) = module.rsplit(|c: char| c == '.' || c == '/' || c == ':').next() {
            if !last.is_empty() {
                return vec![last.to_string()];
            }
        }
        return vec![module.to_string()];
    }

    // TS/JS: import { A, B } from '...'
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

    // TS/JS: import * as X from '...'
    let after_import = trimmed.strip_prefix("import ").unwrap_or("").trim();
    if after_import.starts_with("* as ") {
        if let Some(alias) = after_import[5..].split_whitespace().next() {
            return vec![alias.to_string()];
        }
    }

    // TS/JS: import Default from '...'
    if let Some(from_idx) = after_import.find(" from ") {
        let name = after_import[..from_idx].trim();
        if !name.starts_with('{') && !name.starts_with('*') && !name.starts_with("type ") {
            return vec![name.to_string()];
        }
    }

    // C/C++: #include <vector> or #include "mylib.h"
    if trimmed.starts_with("#include") {
        let inner = trimmed.trim_start_matches("#include").trim()
            .trim_matches('"').trim_start_matches('<').trim_end_matches('>').trim();
        if let Some(stem) = std::path::Path::new(inner).file_stem().and_then(|s| s.to_str()) {
            return vec![stem.to_string()];
        }
    }

    // C#: using System.Collections.Generic;
    if trimmed.starts_with("using ") {
        let inner = trimmed.trim_start_matches("using ").trim_end_matches(';').trim();
        if let Some(last) = inner.rsplit('.').next() {
            return vec![last.to_string()];
        }
    }

    vec![]
}

/// Analyze dependencies of a symbol within file content.
/// Returns structured output: needed imports, co-move candidates, scope info, warnings.
pub fn analyze_symbol_deps(
    content: &str,
    kind: Option<&str>,
    name: &str,
    lang: Option<&str>,
) -> Result<String, crate::error::AtlsError> {
    // Step 1: Resolve symbol body + line range
    let (sym_start, sym_end) = resolve_symbol_anchor_lines_lang(content, kind, name, lang)?;
    let lines: Vec<&str> = content.lines().collect();
    let body = lines[(sym_start as usize - 1)..=(sym_end as usize - 1)].join("\n");

    // Step 2: Extract file imports
    let import_lines = extract_import_lines(content);

    // Step 3: Scan symbol body for refs
    let refs_str = extract_refs(&body);
    let refs: std::collections::HashSet<&str> = refs_str.lines().collect();

    // Step 4: Cross-reference refs against import tokens
    let mut needed_imports = Vec::new();
    for import in &import_lines {
        let tokens = extract_import_tokens_local(import);
        if tokens.iter().any(|t| refs.contains(t.as_str())) {
            needed_imports.push(import.clone());
        }
    }

    // Step 5: Cross-reference remaining refs against same-file symbols
    let all_symbol_kinds: &[Option<&str>] = &[
        Some("fn"), Some("cls"), Some("struct"), Some("trait"),
        Some("interface"), Some("protocol"), Some("enum"), Some("record"),
        Some("extension"), Some("mixin"), Some("impl"), Some("type"),
        Some("const"), Some("static"), Some("mod"), Some("macro"),
        Some("ctor"), Some("property"), Some("field"),
        Some("object"), Some("actor"), Some("union"),
    ];

    let mut file_symbols: Vec<(String, String, u32, u32)> = Vec::new(); // (kind, name, start, end)
    for sk in all_symbol_kinds {
        let names = extract_symbol_names(content, *sk);
        for sym_name in &names {
            if sym_name == name { continue; }
            if !refs.contains(sym_name.as_str()) { continue; }
            if let Ok((s, e)) = resolve_symbol_anchor_lines_lang(content, *sk, sym_name, lang) {
                let kind_label = sk.unwrap_or("sym").to_string();
                file_symbols.push((kind_label, sym_name.clone(), s, e));
            }
        }
    }

    // Determine if co-move candidates are shared (used outside extracted symbol AND candidate itself)
    let mut co_move: Vec<CoMoveCandidate> = Vec::new();
    for (sk, sn, ss, se) in &file_symbols {
        let mut rest_parts = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            let ln = (i + 1) as u32;
            if ln >= sym_start && ln <= sym_end { continue; }
            if ln >= *ss && ln <= *se { continue; }
            rest_parts.push(*line);
        }
        let rest_text = rest_parts.join("\n");
        let rest_clean = neutralize_comments_and_strings(&rest_text);
        let word_re = regex::Regex::new(&format!(r"\b{}\b", regex::escape(sn))).unwrap();
        let shared = word_re.is_match(&rest_clean);
        co_move.push(CoMoveCandidate {
            kind: sk.clone(),
            name: sn.clone(),
            start_line: *ss,
            end_line: *se,
            shared,
        });
    }

    // Step 6: Scope nesting check
    let scope = detect_scope_nesting(content, sym_start, sym_end, lang);

    // Step 7: Assemble warnings
    let mut warnings = Vec::new();
    if let ScopeInfo::Nested { parent_kind, parent_name, .. } = &scope {
        warnings.push(format!(
            "Cannot cleanly extract {}({}) -- captures local variables from {}({}).\n\
             Suggestion: lift to module scope with captured vars as parameters.",
            kind.unwrap_or("fn"), name, parent_kind, parent_name
        ));
    }

    // Format structured output
    format_deps_output(&needed_imports, &co_move, &scope, &warnings)
}

/// Detect whether a symbol at the given line range is nested inside another symbol.
fn detect_scope_nesting(
    content: &str,
    target_start: u32,
    target_end: u32,
    lang: Option<&str>,
) -> ScopeInfo {
    let enclosing_kinds: &[Option<&str>] = &[Some("fn"), Some("cls")];
    let lines: Vec<&str> = content.lines().collect();

    let mut best_parent: Option<(String, String, u32, u32)> = None;

    for sk in enclosing_kinds {
        let names = extract_symbol_names(content, *sk);
        for sym_name in &names {
            if let Ok((s, e)) = resolve_symbol_anchor_lines_lang(content, *sk, sym_name, lang) {
                if s < target_start && e > target_end {
                    // target is inside this symbol
                    let is_tighter = best_parent.as_ref().map_or(true, |p| s > p.2);
                    if is_tighter {
                        best_parent = Some((
                            sk.unwrap_or("sym").to_string(),
                            sym_name.clone(),
                            s,
                            e,
                        ));
                    }
                }
            }
        }
    }

    match best_parent {
        None => ScopeInfo::Module,
        Some((pk, pn, ps, pe)) => {
            // Identify captured variables: identifiers defined between parent start and target start
            let between = if (ps as usize) < lines.len() && (target_start as usize - 1) > (ps as usize) {
                lines[ps as usize..target_start as usize - 1].join("\n")
            } else {
                String::new()
            };
            let captured = extract_local_bindings(&between);
            // Filter to only those actually referenced in the target body
            let target_body = lines[(target_start as usize - 1)..=(target_end as usize - 1)].join("\n");
            let target_refs_str = extract_refs(&target_body);
            let target_refs: std::collections::HashSet<&str> = target_refs_str.lines().collect();
            let captured: Vec<String> = captured.into_iter()
                .filter(|c| target_refs.contains(c.as_str()))
                .collect();

            ScopeInfo::Nested {
                parent_kind: pk,
                parent_name: pn,
                parent_start: ps,
                parent_end: pe,
                captured,
            }
        }
    }
}

/// Extract local variable/const binding names from a code snippet.
fn extract_local_bindings(code: &str) -> Vec<String> {
    let binding_re = regex::Regex::new(
        r"(?m)^\s*(?:const|let|var|val|mut\s+let)\s+(\w+)"
    ).unwrap();
    let mut names = Vec::new();
    for cap in binding_re.captures_iter(code) {
        if let Some(m) = cap.get(1) {
            names.push(m.as_str().to_string());
        }
    }
    names
}

/// Format the deps analysis result as structured text output.
fn format_deps_output(
    needed_imports: &[String],
    co_move: &[CoMoveCandidate],
    scope: &ScopeInfo,
    warnings: &[String],
) -> Result<String, crate::error::AtlsError> {
    let mut out = String::new();

    out.push_str("[needed_imports]\n");
    if needed_imports.is_empty() {
        out.push_str("(none)\n");
    } else {
        for imp in needed_imports {
            out.push_str(imp);
            out.push('\n');
        }
    }

    out.push_str("\n[co_move]\n");
    if co_move.is_empty() {
        out.push_str("(none)\n");
    } else {
        for cm in co_move {
            let shared_label = if cm.shared { "shared" } else { "exclusive" };
            out.push_str(&format!("{}|{}|{}|{}|{}\n", cm.kind, cm.name, cm.start_line, cm.end_line, shared_label));
        }
    }

    out.push_str("\n[scope]\n");
    match scope {
        ScopeInfo::Module => out.push_str("module\n"),
        ScopeInfo::Nested { parent_kind, parent_name, parent_start, parent_end, captured } => {
            out.push_str(&format!("nested|{}({})|{}|{}\n", parent_kind, parent_name, parent_start, parent_end));
            if !captured.is_empty() {
                out.push_str("\n[captured]\n");
                for c in captured {
                    out.push_str(c);
                    out.push('\n');
                }
            }
        }
    }

    out.push_str("\n[warnings]\n");
    if warnings.is_empty() {
        out.push_str("(none)\n");
    } else {
        for w in warnings {
            out.push_str(w);
            out.push('\n');
        }
    }

    Ok(out)
}

/// Strip comment-only lines (single-line and block comment markers).
fn strip_comments(content: &str) -> String {
    let comment_re = regex::Regex::new(
        r"^\s*(?://|#|/\*|\*/|\*|--|///|//!|#!)\s?"
    ).unwrap();

    content.lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !comment_re.is_match(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// First N lines of content.
fn head(content: &str, n: u32) -> String {
    content.lines()
        .take(n as usize)
        .enumerate()
        .map(|(i, l)| format!("{:>4}|{}", i + 1, l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Last N lines of content.
fn tail(content: &str, n: u32) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let start = total.saturating_sub(n as usize);
    lines[start..]
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{:>4}|{}", start + i + 1, l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Filter lines matching pattern, with 1 line of context above and below.
fn grep(content: &str, pattern: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let re = match regex::Regex::new(pattern) {
        Ok(r) => r,
        Err(_) => {
            // Fallback to literal substring match
            let mut included = vec![false; total];
            for (i, line) in lines.iter().enumerate() {
                if line.contains(pattern) {
                    if i > 0 { included[i - 1] = true; }
                    included[i] = true;
                    if i + 1 < total { included[i + 1] = true; }
                }
            }
            return format_included_lines(&lines, &included);
        }
    };

    let mut included = vec![false; total];
    for (i, line) in lines.iter().enumerate() {
        if re.is_match(line) {
            if i > 0 { included[i - 1] = true; }
            included[i] = true;
            if i + 1 < total { included[i + 1] = true; }
        }
    }

    format_included_lines(&lines, &included)
}

fn format_included_lines(lines: &[&str], included: &[bool]) -> String {
    let mut output = Vec::new();
    let mut prev_included = false;
    for (i, (&line, &inc)) in lines.iter().zip(included.iter()).enumerate() {
        if inc {
            if !prev_included && i > 0 {
                output.push("    |...".to_string());
            }
            output.push(format!("{:>4}|{}", i + 1, line));
            prev_included = true;
        } else {
            prev_included = false;
        }
    }
    output.join("\n")
}

/// Exclude specified line ranges, inserting `... (N lines omitted)` placeholders.
fn exclude(content: &str, exclude_ranges: &[(u32, Option<u32>)]) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let mut excluded = vec![false; total];

    for &(start, end) in exclude_ranges {
        let s = (start as usize).saturating_sub(1);
        let e = match end {
            Some(e) => std::cmp::min(e as usize, total),
            None => total,
        };
        for idx in s..e {
            if idx < total {
                excluded[idx] = true;
            }
        }
    }

    let mut output = Vec::new();
    let mut omit_count = 0;
    for (i, (&line, &is_excluded)) in lines.iter().zip(excluded.iter()).enumerate() {
        if is_excluded {
            omit_count += 1;
        } else {
            if omit_count > 0 {
                output.push(format!("    |... ({} lines omitted)", omit_count));
                omit_count = 0;
            }
            output.push(format!("{:>4}|{}", i + 1, line));
        }
    }
    if omit_count > 0 {
        output.push(format!("    |... ({} lines omitted)", omit_count));
    }

    output.join("\n")
}

/// Extract import/use/require statements.
fn extract_imports(content: &str) -> String {
    let import_re = regex::Regex::new(
        r"(?m)^(?:\s*(?:import|use|require|from|include|#include|using)\b[^\n]*)"
    ).unwrap();

    let lines: Vec<&str> = content.lines().collect();
    let mut output = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if import_re.is_match(line) {
            let trimmed = line.trim();
            // Multi-line import: TS/JS `import {` without `}`, Python `from X import (` without `)`
            let is_multiline_brace = trimmed.contains('{') && !trimmed.contains('}');
            let is_multiline_paren = trimmed.starts_with("from ") && trimmed.contains('(') && !trimmed.contains(')');
            if is_multiline_brace || is_multiline_paren {
                let close_char = if is_multiline_brace { '}' } else { ')' };
                let start_line = i;
                let mut joined = trimmed.to_string();
                i += 1;
                while i < lines.len() {
                    let cont = lines[i].trim();
                    joined.push(' ');
                    joined.push_str(cont);
                    if cont.contains(close_char) {
                        break;
                    }
                    i += 1;
                }
                output.push(format!("{:>4}|{}", start_line + 1, joined));
            } else {
                output.push(format!("{:>4}|{}", i + 1, line));
            }
        }
        i += 1;
    }

    if output.is_empty() {
        "  (no imports found)".to_string()
    } else {
        output.join("\n")
    }
}

/// Extract exported/public symbols.
fn extract_exports(content: &str) -> String {
    let export_re = regex::Regex::new(
        r"(?m)^(\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+\w+|pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+\w+)[^\n]*)"
    ).unwrap();

    let mut output = Vec::new();
    for m in export_re.find_iter(content) {
        let line_num = content[..m.start()].chars().filter(|&c| c == '\n').count();
        output.push(format!("{:>4}|{}", line_num + 1, m.as_str().trim()));
    }

    if output.is_empty() {
        "  (no exports found)".to_string()
    } else {
        output.join("\n")
    }
}

// ---------------------------------------------------------------------------
// Semantic Modifiers
// ---------------------------------------------------------------------------

/// Extract blocks related to a named concept by searching for the term
/// in identifiers, comments, and string literals. Returns matching blocks
/// with 2 lines of context on each side.
fn extract_concept(content: &str, term: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    if total == 0 { return String::new(); }

    let lower_term = term.to_lowercase();
    let mut matched_lines: Vec<bool> = vec![false; total];

    for (i, line) in lines.iter().enumerate() {
        if line.to_lowercase().contains(&lower_term) {
            // Mark this line + 2 lines of context on each side
            let start = i.saturating_sub(2);
            let end = (i + 3).min(total);
            for j in start..end {
                matched_lines[j] = true;
            }
        }
    }

    // Also expand to full block boundaries for matched lines
    let mut output = Vec::new();
    let mut in_block = false;
    let mut last_end = 0;

    for (i, &matched) in matched_lines.iter().enumerate() {
        if matched && !in_block {
            if !output.is_empty() && i > last_end + 1 {
                output.push("  // ...");
            }
            in_block = true;
        }
        if matched {
            output.push(lines[i]);
            last_end = i;
        } else if in_block {
            in_block = false;
        }
    }

    if output.is_empty() {
        format!("// concept '{}': no matches found", term)
    } else {
        output.join("\n")
    }
}

/// Extract code matching a named structural pattern.
/// Supported patterns: "error-handling", "state-mutation", "async", "io", "logging", "validation".
fn extract_pattern(content: &str, pattern_name: &str) -> String {
    let indicators: Vec<&str> = match pattern_name {
        "error-handling" | "error" => vec![
            "catch", "throw", "Error", "error", "Err(", "err(", "unwrap",
            "expect(", "Result<", "try ", "except", "raise", "panic!",
            "bail!", "anyhow!", "?;", ".ok()", ".map_err",
        ],
        "state-mutation" | "state" | "mutation" => vec![
            "mut ", "&mut", "set(", "setState", "useState", "store.",
            "dispatch", "commit(", "assign(", "splice(", "push(",
            "pop(", "shift(", "delete ", "remove(", "insert(",
        ],
        "async" | "concurrency" => vec![
            "async ", "await ", ".then(", "Promise", "Future",
            "tokio::", "spawn", "join!", "select!", "Mutex",
            "RwLock", "channel", "mpsc", "oneshot",
        ],
        "io" | "filesystem" => vec![
            "fs::", "std::fs", "read_to_string", "write(", "File::",
            "open(", "create(", "read_dir", "Path::", "PathBuf",
            "stdin", "stdout", "stderr", "BufReader", "BufWriter",
        ],
        "logging" | "log" => vec![
            "log::", "println!", "eprintln!", "console.log", "console.warn",
            "console.error", "debug!", "info!", "warn!", "error!",
            "trace!", "tracing::", "slog", "log4rs",
        ],
        "validation" | "input" => vec![
            "validate", "assert", "check", "verify", "ensure",
            "is_empty", "is_none", "is_some", "is_ok", "is_err",
            "len()", "parse(", "from_str", "TryFrom", "sanitize",
        ],
        _ => {
            // Fallback: treat pattern name as a grep term
            return grep(content, pattern_name);
        }
    };

    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let mut matched_lines: Vec<bool> = vec![false; total];

    for (i, line) in lines.iter().enumerate() {
        if indicators.iter().any(|ind| line.contains(ind)) {
            let start = i.saturating_sub(1);
            let end = (i + 2).min(total);
            for j in start..end {
                matched_lines[j] = true;
            }
        }
    }

    let mut output = Vec::new();
    let mut last_end = 0;

    for (i, &matched) in matched_lines.iter().enumerate() {
        if matched {
            if !output.is_empty() && i > last_end + 1 {
                output.push("  // ...");
            }
            output.push(lines[i]);
            last_end = i;
        }
    }

    if output.is_empty() {
        format!("// pattern '{}': no matches found", pattern_name)
    } else {
        output.join("\n")
    }
}

/// Conditional filter: include lines/blocks matching a boolean expression.
/// Supports: "has(term)", "!has(term)", "len>N", "len<N", "depth>N", "depth<N".
fn filter_if(content: &str, expr: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();

    // Parse expression
    if let Some(term) = expr.strip_prefix("has(").and_then(|s| s.strip_suffix(')')) {
        return lines.iter()
            .filter(|l| l.contains(term))
            .copied()
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(inner) = expr.strip_prefix("!has(").and_then(|s| s.strip_suffix(')')) {
        return lines.iter()
            .filter(|l| !l.contains(inner))
            .copied()
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(n_str) = expr.strip_prefix("len>") {
        if let Ok(n) = n_str.parse::<usize>() {
            return lines.iter()
                .filter(|l| l.trim().len() > n)
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    if let Some(n_str) = expr.strip_prefix("len<") {
        if let Ok(n) = n_str.parse::<usize>() {
            return lines.iter()
                .filter(|l| l.trim().len() < n)
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    if let Some(n_str) = expr.strip_prefix("depth>") {
        if let Ok(n) = n_str.parse::<usize>() {
            return lines.iter()
                .filter(|l| indent_depth(l) > n)
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    if let Some(n_str) = expr.strip_prefix("depth<") {
        if let Ok(n) = n_str.parse::<usize>() {
            return lines.iter()
                .filter(|l| indent_depth(l) < n)
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
        }
    }

    format!("// if({}): unrecognized expression", expr)
}

fn indent_depth(line: &str) -> usize {
    let trimmed = line.trim_start();
    if trimmed.is_empty() { return 0; }
    let spaces = line.len() - trimmed.len();
    // Normalize: 1 tab = 4 spaces
    let tabs = line.chars().take_while(|c| *c == '\t').count();
    (spaces - tabs) + tabs * 4
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash_resolver::ShapeOp;

    #[test]
    fn test_dedent_strips_common_indent() {
        let content = "    fn foo() {\n        bar();\n    }";
        let result = dedent(content);
        assert!(result.starts_with("fn foo()"));
        assert!(result.contains("    bar();"));
    }

    #[test]
    fn test_head_limits_lines() {
        let content = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
        let result = head(content, 3);
        assert!(result.contains("a"));
        assert!(result.contains("c"));
        assert!(!result.contains("d"));
    }

    #[test]
    fn test_tail_limits_lines() {
        let content = "a\nb\nc\nd\ne";
        let result = tail(content, 2);
        assert!(!result.contains("c"));
        assert!(result.contains("d"));
        assert!(result.contains("e"));
    }

    #[test]
    fn test_grep_with_context() {
        let content = "line1\nline2\nfoo bar\nline4\nline5";
        let result = grep(content, "foo");
        assert!(result.contains("line2")); // context before
        assert!(result.contains("foo bar")); // match
        assert!(result.contains("line4")); // context after
    }

    #[test]
    fn test_strip_comments() {
        let content = "// comment\ncode();\n# python comment\nmore_code();";
        let result = strip_comments(content);
        assert!(result.contains("code();"));
        assert!(result.contains("more_code();"));
        assert!(!result.contains("// comment"));
        assert!(!result.contains("# python"));
    }

    #[test]
    fn test_exclude_ranges() {
        let content = "a\nb\nc\nd\ne\nf\ng";
        let result = exclude(content, &[(3, Some(5))]);
        assert!(result.contains("a"));
        assert!(result.contains("b"));
        assert!(result.contains("omitted"));
        assert!(result.contains("f"));
        assert!(result.contains("g"));
        assert!(!result.contains("|c"));
    }

    #[test]
    fn test_extract_imports_ts() {
        let content = "import { foo } from './foo';\nimport bar from 'bar';\n\nfunction main() {}";
        let result = extract_imports(content);
        assert!(result.contains("import { foo }"));
        assert!(result.contains("import bar"));
        assert!(!result.contains("function"));
    }

    #[test]
    fn test_extract_imports_rust() {
        let content = "use std::path::Path;\nuse crate::error::AtlsError;\n\npub fn main() {}";
        let result = extract_imports(content);
        assert!(result.contains("use std::path"));
        assert!(result.contains("use crate::error"));
    }

    #[test]
    fn test_extract_exports_ts() {
        let content = "export function foo() {}\nexport class Bar {}\nconst internal = 1;";
        let result = extract_exports(content);
        assert!(result.contains("export function foo"));
        assert!(result.contains("export class Bar"));
        assert!(!result.contains("internal"));
    }

    #[test]
    fn test_extract_signatures() {
        let content = "fn foo(x: i32) -> bool {\n    x > 0\n}\n\nfn bar() {\n    println!(\"hi\");\n}";
        let result = extract_signatures(content);
        assert!(result.contains("fn foo"));
        assert!(result.contains("fn bar"));
        assert!(result.contains("..."));
    }

    // ── Shape ops per language (sig, fold, dedent, nocomment, imports, exports) ──

    #[test]
    fn test_sig_typescript() {
        let content = r#"export function processData(input: string): Promise<Result> {
  return fetch(input).then(r => r.json());
}

class UserService {
  getUser(id: number): User {
    return this.repo.find(id);
  }
}"#;
        let result = apply_shape(content, &ShapeOp::Sig);
        assert!(!result.is_empty());
        assert!(result.contains("function") || result.contains("processData") || result.contains("UserService"));
    }

    #[test]
    fn test_sig_python() {
        let content = r#"def process_request(data: dict) -> dict:
    return {"status": "ok"}

class UserService:
    def get_user(self, id: int) -> User:
        return self.repo.find(id)"#;
        let result = apply_shape(content, &ShapeOp::Sig);
        assert!(!result.is_empty());
        assert!(result.contains("def") || result.contains("process_request") || result.contains("UserService"));
    }

    #[test]
    fn test_sig_go() {
        let content = r#"func (s *Server) HandleRequest(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(s.data)
}"#;
        let result = apply_shape(content, &ShapeOp::Sig);
        assert!(!result.is_empty());
        assert!(result.contains("func") || result.contains("HandleRequest") || result.contains("Server"));
    }

    #[test]
    fn test_sig_java() {
        let content = r#"public List<User> findActiveUsers() throws ServiceException {
    return repo.findAll().stream().filter(User::isActive).collect(toList());
}"#;
        let result = apply_shape(content, &ShapeOp::Sig);
        assert!(!result.is_empty());
        assert!(result.contains("findActiveUsers") || result.contains("List") || result.contains("User"));
    }

    #[test]
    fn test_sig_csharp() {
        let content = r#"public async Task<ActionResult<UserDto>> GetUser(int id) {
    var user = await _userService.FindAsync(id);
    return user != null ? Ok(user) : NotFound();
}"#;
        let result = apply_shape(content, &ShapeOp::Sig);
        assert!(!result.is_empty());
        assert!(result.contains("GetUser") || result.contains("Task") || result.contains("ActionResult"));
    }

    #[test]
    fn test_sig_c() {
        let content = r#"void process_data(const char* path) {
    FILE* f = fopen(path, "r");
    fclose(f);
}"#;
        let result = apply_shape(content, &ShapeOp::Sig);
        assert!(!result.is_empty());
        assert!(result.contains("process_data") || result.contains("void"));
    }

    #[test]
    fn test_fold_returns_structure() {
        let ts = "function outer() {\n  function inner() {\n    return 1;\n  }\n  return inner();\n}";
        let py = "def outer():\n    def inner():\n        return 1\n    return inner()";
        let rust = "fn outer() {\n    fn inner() { 1 }\n    inner()\n}";
        for content in [ts, py, rust] {
            let result = apply_shape(content, &ShapeOp::Fold);
            assert!(!result.is_empty(), "fold should return non-empty for content with nesting");
        }
    }

    #[test]
    fn test_dedent_python_and_ts() {
        let py = "    def foo():\n        return 1";
        let ts = "    function foo() {\n        return 1;\n    }";
        for content in [py, ts] {
            let result = apply_shape(content, &ShapeOp::Dedent);
            assert!(!result.is_empty());
            assert!(!result.starts_with("    "), "dedent should strip leading indent");
        }
    }

    #[test]
    fn test_nocomment_preserves_code() {
        let ts = "// comment\nconst x = 1;";
        let py = "# comment\ndef foo(): pass";
        let rust = "// comment\nfn main() {}";
        for content in [ts, py, rust] {
            let result = apply_shape(content, &ShapeOp::NoComment);
            assert!(!result.is_empty());
            assert!(!result.contains("// comment") && !result.contains("# comment"));
        }
    }

    #[test]
    fn test_imports_python() {
        let content = "from typing import List, Dict\nfrom .utils import helper\n\ndef main(): pass";
        let result = apply_shape(content, &ShapeOp::Imports);
        assert!(!result.is_empty());
        assert!(result.contains("from") || result.contains("import"));
    }

    #[test]
    fn test_exports_rust() {
        let content = "pub fn public_api() {}\npub struct PublicStruct {}\nfn private_fn() {}";
        let result = apply_shape(content, &ShapeOp::Exports);
        assert!(!result.is_empty());
        assert!(result.contains("pub") || result.contains("public") || result.contains("Public"));
    }

    #[test]
    fn test_resolve_symbol_anchor() {
        let content = "fn first() {\n    1\n}\n\nfn target(x: i32) {\n    x + 1\n}\n\nfn last() {}";
        let result = resolve_symbol_anchor(content, Some("fn"), "target").unwrap();
        assert!(result.contains("fn target"));
        assert!(result.contains("x + 1"));
        assert!(!result.contains("fn first"));
    }

    #[test]
    fn test_resolve_symbol_anchor_suggests_similar() {
        let content = r#"def parse_json_safe(data: str) -> Any | None:
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None

def serialize_json(obj: Any) -> str:
    return json.dumps(obj, indent=2)

def merge_json(base: dict, override: dict) -> dict:
    result = base.copy()
    return result"#;
        let err = resolve_symbol_anchor(content, Some("fn"), "parse_json").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("parse_json_safe"), "error should suggest parse_json_safe: {}", msg);
        assert!(msg.contains("Did you mean"), "error should include did you mean: {}", msg);
    }

    #[test]
    fn test_resolve_symbol_anchor_lines_returns_1based() {
        let content = "fn first() {\n    1\n}\n\nfn target(x: i32) {\n    x + 1\n}\n\nfn last() {}";
        let (start, end) = resolve_symbol_anchor_lines(content, Some("fn"), "target").unwrap();
        // target is at 0-based lines 4-6, so 1-based = 5-7
        assert_eq!(start, 5, "start should be 1-based line 5");
        assert_eq!(end, 7, "end should be 1-based line 7");
    }

    #[test]
    fn test_resolve_symbol_anchor_lines_not_found() {
        let content = "fn alpha() { 1 }\nfn beta() { 2 }";
        let result = resolve_symbol_anchor_lines(content, Some("fn"), "gamma");
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // HPP v4: Semantic modifier tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_extract_concept() {
        let content = "fn login(user: &str) {\n    validate(user);\n    create_session(user);\n}\n\nfn logout() {\n    destroy_session();\n}\n\nfn render_page() {\n    html()\n}";
        let result = extract_concept(content, "session");
        assert!(result.contains("create_session"));
        assert!(result.contains("destroy_session"));
        assert!(!result.contains("render_page"));
    }

    #[test]
    fn test_extract_concept_no_match() {
        let content = "fn hello() { println!(\"hi\"); }";
        let result = extract_concept(content, "database");
        assert!(result.contains("no matches found"));
    }

    #[test]
    fn test_extract_pattern_error_handling() {
        let content = "fn safe() -> Result<(), Error> {\n    let x = try_op()?;\n    Ok(())\n}\n\nfn pure() -> i32 {\n    42\n}";
        let result = extract_pattern(content, "error-handling");
        assert!(result.contains("Result<(), Error>"));
        assert!(result.contains("try_op()?"));
        assert!(!result.contains("fn pure"));
    }

    #[test]
    fn test_extract_pattern_unknown_falls_back_to_grep() {
        let content = "line1\nfoo_bar\nline3";
        let result = extract_pattern(content, "foo_bar");
        assert!(result.contains("foo_bar"));
    }

    #[test]
    fn test_filter_if_has() {
        let content = "line1\n// TODO: fix this\nline3\n// TODO: refactor\nline5";
        let result = filter_if(content, "has(TODO)");
        assert!(result.contains("TODO: fix this"));
        assert!(result.contains("TODO: refactor"));
        assert!(!result.contains("line1"));
        assert!(!result.contains("line3"));
    }

    #[test]
    fn test_filter_if_not_has() {
        let content = "code();\n// comment\nmore_code();";
        let result = filter_if(content, "!has(//)");
        assert!(result.contains("code();"));
        assert!(result.contains("more_code();"));
        assert!(!result.contains("comment"));
    }

    #[test]
    fn test_filter_if_len() {
        let content = "x\nlong_variable_name = something_complex()\ny";
        let result = filter_if(content, "len>10");
        assert!(result.contains("long_variable_name"));
        assert!(!result.contains("\nx\n"));
    }

    #[test]
    fn test_filter_if_unrecognized() {
        let result = filter_if("content", "unknown_expr");
        assert!(result.contains("unrecognized expression"));
    }

    // -----------------------------------------------------------------------
    // Macro symbol resolution
    // -----------------------------------------------------------------------

    #[test]
    fn test_resolve_macro_rules_by_kind() {
        let content = r#"
fn helper() -> bool { true }

macro_rules! tri {
    ($expr:expr) => {
        match $expr {
            Ok(v) => v,
            Err(e) => return Err(e.into()),
        }
    };
}

fn other() { helper(); }
"#;
        let result = resolve_symbol_anchor(content, Some("macro"), "tri").unwrap();
        assert!(result.contains("macro_rules! tri"), "should find macro_rules! tri");
        assert!(result.contains("Ok(v) => v"), "should include macro body");
        assert!(!result.contains("fn helper"), "should not include unrelated fn");
    }

    #[test]
    fn test_resolve_macro_lines() {
        // Content: line 1: fn a, line 2: empty, line 3: macro_rules!, line 4: body, line 5: closing };
        let content = "fn a() { 1 }\n\nmacro_rules! my_vec {\n    () => { Vec::new() };\n}\n\nfn b() { 2 }";
        let (start, end) = resolve_symbol_anchor_lines(content, Some("macro"), "my_vec").unwrap();
        assert_eq!(start, 3, "macro starts on line 3");
        assert_eq!(end, 5, "macro ends on line 5 (closing brace)");
    }

    #[test]
    fn test_macro_not_found() {
        let content = "fn a() {}\nmacro_rules! foo { () => {}; }";
        let err = resolve_symbol_anchor(content, Some("macro"), "bar");
        assert!(err.is_err(), "should error when macro not found");
    }

    // -----------------------------------------------------------------------
    // Overload disambiguation (#N)
    // -----------------------------------------------------------------------

    #[test]
    fn test_overload_first_by_default() {
        let content = "function toJson(obj: any): string {\n  return JSON.stringify(obj);\n}\n\nfunction toJson(obj: any, pretty: boolean): string {\n  return JSON.stringify(obj, null, pretty ? 2 : 0);\n}";
        let result = resolve_symbol_anchor(content, Some("fn"), "toJson").unwrap();
        assert!(result.contains("JSON.stringify(obj);"), "default should pick first overload");
        assert!(!result.contains("pretty"), "should not include second overload");
    }

    #[test]
    fn test_overload_select_second() {
        let content = "function toJson(obj: any): string {\n  return JSON.stringify(obj);\n}\n\nfunction toJson(obj: any, pretty: boolean): string {\n  return JSON.stringify(obj, null, pretty ? 2 : 0);\n}";
        let result = resolve_symbol_anchor(content, Some("fn"), "toJson#2").unwrap();
        assert!(result.contains("pretty"), "should pick second overload");
    }

    #[test]
    fn test_overload_out_of_range() {
        let content = "function foo() { 1 }\nfunction foo() { 2 }";
        let err = resolve_symbol_anchor(content, Some("fn"), "foo#3");
        assert!(err.is_err(), "should error on out-of-range overload");
        let msg = err.unwrap_err().to_string();
        assert!(msg.contains("#1..#2"), "should indicate valid range");
    }

    #[test]
    fn test_overload_zero_is_error() {
        let content = "function foo() {}";
        let err = resolve_symbol_anchor(content, Some("fn"), "foo#0");
        assert!(err.is_err(), "overload #0 should error (1-indexed)");
    }

    #[test]
    fn test_overload_lines_select_second() {
        let content = "function toJson(obj: any): string {\n  return JSON.stringify(obj);\n}\n\nfunction toJson(obj: any, pretty: boolean): string {\n  return JSON.stringify(obj, null, pretty ? 2 : 0);\n}";
        let (start, _end) = resolve_symbol_anchor_lines(content, Some("fn"), "toJson#2").unwrap();
        assert_eq!(start, 5, "second overload starts on line 5");
    }

    // -----------------------------------------------------------------------
    // Bodyless symbol detection
    // -----------------------------------------------------------------------

    #[test]
    fn test_bodyless_reexport_errors() {
        let content = "import { z } from './zod';\n\nexport default z;";
        let err = resolve_symbol_anchor(content, None, "z");
        assert!(err.is_err(), "bodyless re-export should error");
        let msg = err.unwrap_err().to_string();
        assert!(msg.contains("bodyless") || msg.contains("not found"), "should mention bodyless or not found: {}", msg);
    }

    #[test]
    fn test_bodyless_export_from_errors() {
        // is_bodyless_line should detect export { X } from and import { X } from
        assert!(is_bodyless_line("export { ESLint } from 'eslint';"));
        assert!(is_bodyless_line("import { foo } from './bar';"));
        assert!(is_bodyless_line("export { type Foo } from './types';"));
        assert!(!is_bodyless_line("export function foo() {}"));
    }

    #[test]
    fn test_bodyless_type_alias_errors() {
        let content = "type UserId = string;\n\nfunction getUser(id: UserId) {\n  return db.find(id);\n}";
        let err = resolve_symbol_anchor(content, None, "UserId");
        assert!(err.is_err(), "bodyless type alias should error");
        let msg = err.unwrap_err().to_string();
        assert!(msg.contains("bodyless"), "should indicate bodyless: {}", msg);
    }

    #[test]
    fn test_single_line_fn_with_body_works() {
        let content = "fn compact() { 42 }";
        let result = resolve_symbol_anchor(content, Some("fn"), "compact").unwrap();
        assert!(result.contains("42"), "single-line fn with braces should work");
    }

    // -----------------------------------------------------------------------
    // Template / generic extraction safety
    // -----------------------------------------------------------------------

    #[test]
    fn test_cpp_namespace_template_included() {
        let content = r#"namespace detail {
template<typename T>
void thousands_sep_impl(T& out) {
    out = ' ';
}
}"#;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "thousands_sep_impl", Some("cpp")).unwrap();
        assert!(result.contains("namespace detail"), "should include namespace: {}", result);
        assert!(result.contains("template"), "should include template: {}", result);
        assert!(result.contains("thousands_sep_impl"), "should include function: {}", result);
    }

    #[test]
    fn test_cpp_template_fn_not_matched_by_keyword_regex() {
        // C++ functions use return-type syntax — keyword regex (Tier 1) rejects them
        let content = r#"template<typename T>
void serialize(const T& obj) {
    std::vector<T> items;
    items.push_back(obj);
}"#;
        let err = resolve_symbol_anchor(content, Some("fn"), "serialize");
        assert!(err.is_err(), "C++ return-type functions should not match fn() keyword regex");
    }

    #[test]
    fn test_cpp_template_fn_matched_by_lang_variant() {
        // The lang-aware variant (Tier 2) handles C++ return-type syntax
        let content = r#"template<typename T>
void serialize(const T& obj) {
    std::vector<T> items;
    items.push_back(obj);
}"#;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "serialize", Some("cpp")).unwrap();
        assert!(result.contains("void serialize"), "should extract C++ function declaration");
        assert!(result.contains("push_back"), "should include function body");
        assert!(result.contains("template<typename T>"), "should include template prefix");
    }

    #[test]
    fn test_c_function_matched_by_lang_variant() {
        let content = r#"#include <stdio.h>

static cJSON_bool parse_number(cJSON * const item, parse_buffer * const input_buffer) {
    double number = 0;
    unsigned char *after_end = NULL;
    number = strtod((const char*)buffer_at_offset(input_buffer), (char**)&after_end);
    item->valuedouble = number;
    return true;
}

void other_func(void) {
    printf("hello");
}"#;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "parse_number", Some("c")).unwrap();
        assert!(result.contains("parse_number"), "should find C function");
        assert!(result.contains("valuedouble"), "should include body");
        assert!(result.contains("return true"), "should include full body");
    }

    #[test]
    fn test_java_method_matched_by_lang_variant() {
        let content = r#"package com.google.gson;

public class Gson {
    public <T> String toJson(T src) {
        StringWriter writer = new StringWriter();
        toJson(src, writer);
        return writer.toString();
    }

    public void fromJson(String json) {
        parse(json);
    }
}"#;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "toJson", Some("java")).unwrap();
        assert!(result.contains("toJson"), "should find Java method");
        assert!(result.contains("writer.toString()"), "should include method body");
    }

    #[test]
    fn test_csharp_method_matched_by_lang_variant() {
        let content = r#"namespace Humanizer {
    public class EnglishNumberToWordsConverter {
        private static string Convert(int number, bool addAnd) {
            if (number == 0) return "zero";
            var parts = new List<string>();
            return string.Join(" ", parts);
        }

        public override string Convert(long input) {
            return Convert((int)input, true);
        }
    }
}"#;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "Convert", Some("csharp")).unwrap();
        assert!(result.contains("Convert"), "should find C# method");
        assert!(result.contains("zero"), "should include method body");
    }

    #[test]
    fn test_go_receiver_method_matched_by_keyword_regex() {
        let content = r#"package chi

func NewRouter() *Mux {
    return &Mux{}
}

func (mx *Mux) parseRoute(pattern string) (string, error) {
    if pattern == "" {
        return "", errors.New("empty pattern")
    }
    return pattern, nil
}

func (mx *Mux) Mount(pattern string, handler http.Handler) {
    mx.handle(pattern, handler)
}"#;
        // Go receiver methods should work with Tier 1 keyword regex
        let result = resolve_symbol_anchor(content, Some("fn"), "parseRoute").unwrap();
        assert!(result.contains("parseRoute"), "should find Go receiver method via keyword regex");
        assert!(result.contains("errors.New"), "should include method body");
    }

    #[test]
    fn test_go_receiver_method_lines() {
        let content = "func (mx *Mux) parseRoute(p string) error {\n    return nil\n}";
        let (start, end) = resolve_symbol_anchor_lines(content, Some("fn"), "parseRoute").unwrap();
        assert_eq!(start, 1, "receiver method starts on line 1");
        assert_eq!(end, 3, "receiver method ends on line 3");
    }

    #[test]
    fn test_cfamily_rejects_function_calls() {
        let content = r#"void setup(void) {
    result = parse_number(item, buf);
    if (parse_number(a, b)) {
        return;
    }
}"#;
        // parse_number appears only as calls, not declarations — should not match
        let lines: Vec<&str> = content.lines().collect();
        let matches = try_cfamily_fn_match(&lines, "parse_number");
        assert!(matches.is_empty(), "should not match function calls: {:?}", matches);
    }

    #[test]
    fn test_cfamily_overload_selection() {
        let content = r#"public String convert(int number) {
    return Integer.toString(number);
}

public String convert(long number, boolean flag) {
    return Long.toString(number);
}"#;
        let r1 = resolve_symbol_anchor_lang(content, Some("fn"), "convert", Some("java")).unwrap();
        assert!(r1.contains("Integer.toString"), "default picks first overload");
        let r2 = resolve_symbol_anchor_lang(content, Some("fn"), "convert#2", Some("java")).unwrap();
        assert!(r2.contains("Long.toString"), "should pick second overload");
    }

    #[test]
    fn test_snap_lines_to_block() {
        let content = "fn outer() {\n    let x = 1;\n    let y = 2;\n    let z = x + y;\n    return z;\n}\n\nfn other() { 42 }";
        // Request lines 3-4 (inside outer), should snap to full function 1-6
        let snapped = snap_lines_to_block(content, &[(3, Some(4))]);
        assert_eq!(snapped.len(), 1);
        assert_eq!(snapped[0].0, 1, "should snap start to fn declaration");
        assert_eq!(snapped[0].1, Some(6), "should snap end to closing brace");
    }

    #[test]
    fn test_snap_lines_preserves_when_no_enclosing_block() {
        let content = "line1\nline2\nline3\nline4";
        let snapped = snap_lines_to_block(content, &[(2, Some(3))]);
        assert_eq!(snapped[0], (2, Some(3)), "should preserve original range when no function found");
    }

    // -----------------------------------------------------------------------
    // Rust function extraction: where clauses, closures, complex bodies
    // -----------------------------------------------------------------------

    #[test]
    fn test_resolve_rust_fn_with_where_clause() {
        let content = r#"pub fn process<T>(input: T) -> Result<(), Error>
where
    T: Display + Debug,
{
    println!("{:?}", input);
    Ok(())
}"#;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "process", Some("rust")).unwrap();
        assert!(result.contains("pub fn process"), "should find function declaration");
        assert!(result.contains("where"), "should include where clause");
        assert!(result.contains("Ok(())"), "should include full body");
    }

    #[test]
    fn test_resolve_rust_fn_with_closure() {
        let content = r#"pub fn transform(items: Vec<i32>) -> Vec<String> {
    items.iter()
        .map(|x| {
            let s = x.to_string();
            format!("item: {}", s)
        })
        .collect()
}"#;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "transform", Some("rust")).unwrap();
        assert!(result.contains("pub fn transform"), "should find function");
        assert!(result.contains(".collect()"), "should include full body with nested closure");
    }

    #[test]
    fn test_resolve_rust_fn_with_raw_string() {
        let content = r##"pub fn template() -> &'static str {
    r#"
    {
        "key": "value",
        "nested": { "a": 1 }
    }
    "#
}"##;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "template", Some("rust")).unwrap();
        assert!(result.contains("pub fn template"), "should find function");
        assert!(result.contains("nested"), "should include raw string content without brace confusion");
    }

    #[test]
    fn test_resolve_rust_fn_impl_trait_return() {
        let content = r#"pub fn make_handler() -> impl Fn(Request) -> Response + Send + Sync {
    |req| {
        Response::ok(req.body())
    }
}

fn other() { 42 }"#;
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "make_handler", Some("rust")).unwrap();
        assert!(result.contains("make_handler"), "should find function");
        assert!(result.contains("Response::ok"), "should include full body");
        assert!(!result.contains("fn other"), "should not include next function");
    }

    #[test]
    fn test_enhanced_error_includes_hint() {
        let content = "void mystery_function(int x) { return x; }";
        let err = resolve_symbol_anchor_lang(content, Some("fn"), "nonexistent", Some("c"));
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(msg.contains("sig") || msg.contains("Hint"), "error should include sig hint: {}", msg);
    }

    #[test]
    fn test_brace_tracking_ignores_angle_brackets() {
        // Angle brackets in generics/templates should not confuse brace depth tracking
        let content = "function parse<T extends Record<string, unknown>>(input: string): T {\n  const result: Map<string, T> = new Map();\n  return JSON.parse(input) as T;\n}";
        let result = resolve_symbol_anchor(content, Some("fn"), "parse").unwrap();
        assert!(result.contains("JSON.parse"), "should include full body despite <> in generics");
    }

    #[test]
    fn test_nested_generics_dont_break_braces() {
        let content = "function parse<T extends Record<string, unknown>>(input: string): T {\n  return JSON.parse(input) as T;\n}";
        let result = resolve_symbol_anchor(content, Some("fn"), "parse").unwrap();
        assert!(result.contains("JSON.parse"), "should include full body despite nested <>");
    }

    // -----------------------------------------------------------------------
    // X-Ray Vision: Kotlin fun + Rust qualifiers
    // -----------------------------------------------------------------------

    #[test]
    fn test_kotlin_fun_matched() {
        let content = "fun processData(input: String): Result {\n    return parse(input)\n}";
        let result = resolve_symbol_anchor(content, Some("fn"), "processData").unwrap();
        assert!(result.contains("processData"), "should find Kotlin fun");
        assert!(result.contains("parse(input)"), "should include body");
    }

    #[test]
    fn test_rust_unsafe_const_extern_fn() {
        let content = "unsafe fn dangerous() {\n    core::ptr::null()\n}\n\nconst fn compute() -> u32 {\n    42\n}\n\npub(crate) extern \"C\" fn callback(x: i32) -> i32 {\n    x + 1\n}";
        let r1 = resolve_symbol_anchor(content, Some("fn"), "dangerous").unwrap();
        assert!(r1.contains("unsafe fn dangerous"), "should match unsafe fn");
        let r2 = resolve_symbol_anchor(content, Some("fn"), "compute").unwrap();
        assert!(r2.contains("const fn compute"), "should match const fn");
        let r3 = resolve_symbol_anchor(content, Some("fn"), "callback").unwrap();
        assert!(r3.contains("extern"), "should match extern fn");
    }

    // -----------------------------------------------------------------------
    // X-Ray Vision: JS/TS class method shorthand (Tier 1.5a)
    // -----------------------------------------------------------------------

    #[test]
    fn test_js_class_method_shorthand() {
        let content = "class UserService {\n    async getUser(id: string) {\n        return this.db.find(id);\n    }\n}";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "getUser", Some("typescript")).unwrap();
        assert!(result.contains("getUser"), "should find class method shorthand");
        assert!(result.contains("db.find"), "should include method body");
    }

    #[test]
    fn test_js_getter_setter() {
        let content = "class Foo {\n    get name() {\n        return this._name;\n    }\n    set name(v) {\n        this._name = v;\n    }\n}";
        let r1 = resolve_symbol_anchor_lang(content, Some("fn"), "name", Some("typescript")).unwrap();
        assert!(r1.contains("get name") || r1.contains("_name"), "should find getter");
    }

    #[test]
    fn test_js_static_method() {
        let content = "class Factory {\n    static create(opts) {\n        return new Factory(opts);\n    }\n}";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "create", Some("javascript")).unwrap();
        assert!(result.contains("static create"), "should find static method");
    }

    #[test]
    fn test_js_private_method() {
        let content = "class Secure {\n    #validate(token) {\n        return token.length > 0;\n    }\n}";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "validate", Some("javascript")).unwrap();
        assert!(result.contains("validate"), "should find private method");
    }

    // -----------------------------------------------------------------------
    // X-Ray Vision: Arrow / const-bound functions (Tier 1.5b)
    // -----------------------------------------------------------------------

    #[test]
    fn test_arrow_function_const() {
        let content = "const handler = async (req, res) => {\n    const data = await fetch(req.url);\n    res.send(data);\n};";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "handler", Some("typescript")).unwrap();
        assert!(result.contains("handler"), "should find arrow function");
        assert!(result.contains("fetch"), "should include body");
    }

    #[test]
    fn test_arrow_function_export() {
        let content = "export const multiply = (a: number, b: number) => {\n    return a * b;\n};";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "multiply", Some("typescript")).unwrap();
        assert!(result.contains("multiply"), "should find exported arrow");
    }

    #[test]
    fn test_const_bound_function() {
        let content = "const validate = function(input) {\n    return input != null;\n};";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "validate", Some("javascript")).unwrap();
        assert!(result.contains("validate"), "should find const-bound function expression");
    }

    // -----------------------------------------------------------------------
    // X-Ray Vision: Go type declarations
    // -----------------------------------------------------------------------

    #[test]
    fn test_go_type_struct() {
        let content = "type Router struct {\n    routes map[string]Handler\n    prefix string\n}";
        let result = resolve_symbol_anchor_lang(content, Some("struct"), "Router", Some("go")).unwrap();
        assert!(result.contains("type Router struct"), "should find Go struct");
        assert!(result.contains("routes"), "should include fields");
    }

    #[test]
    fn test_go_type_interface() {
        let content = "type Reader interface {\n    Read(p []byte) (n int, err error)\n}";
        let result = resolve_symbol_anchor_lang(content, Some("trait"), "Reader", Some("go")).unwrap();
        assert!(result.contains("type Reader interface"), "should find Go interface");
    }

    // -----------------------------------------------------------------------
    // X-Ray Vision: Decorator / attribute expansion
    // -----------------------------------------------------------------------

    #[test]
    fn test_python_decorator_included() {
        let content = "@app.route(\"/api\")\n@login_required\ndef handle_request():\n    return process()";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "handle_request", Some("python")).unwrap();
        assert!(result.contains("@app.route"), "should include Python decorator");
        assert!(result.contains("@login_required"), "should include all decorators");
    }

    #[test]
    fn test_java_annotation_included() {
        let content = "@Override\n@Transactional\npublic void save(Entity e) {\n    em.persist(e);\n}";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "save", Some("java")).unwrap();
        assert!(result.contains("@Override"), "should include Java annotation");
        assert!(result.contains("@Transactional"), "should include all annotations");
    }

    #[test]
    fn test_rust_attribute_included() {
        let content = "#[test]\n#[should_panic]\nfn test_overflow() {\n    panic!(\"boom\");\n}";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "test_overflow", Some("rust")).unwrap();
        assert!(result.contains("#[test]"), "should include Rust attribute");
        assert!(result.contains("#[should_panic]"), "should include all attributes");
    }

    #[test]
    fn test_csharp_attribute_included() {
        let content = "[HttpGet(\"api/users\")]\n[Authorize]\npublic IActionResult GetUsers() {\n    return Ok(users);\n}";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "GetUsers", Some("csharp")).unwrap();
        assert!(result.contains("[HttpGet"), "should include C# attribute");
        assert!(result.contains("[Authorize]"), "should include all attributes");
    }

    // -----------------------------------------------------------------------
    // Python cls() sequential extraction (batch extract regression)
    // -----------------------------------------------------------------------

    const PYTHON_4_CLASSES: &str = r#""""Parsing strategy implementations."""
from abc import ABC, abstractmethod
from typing import Any, Dict
import json


class ParseStrategy(ABC):
    """Abstract base class for parsing strategies."""

    @abstractmethod
    def parse(self, content: str) -> Any:
        """Parse content and return structured data."""
        pass

    @abstractmethod
    def validate(self, data: Any) -> bool:
        """Validate parsed data."""
        pass


class JSONParseStrategy(ParseStrategy):
    """JSON parsing strategy."""

    def parse(self, content: str) -> Dict:
        """Parse JSON content."""
        try:
            return json.loads(content)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON: {e}")

    def validate(self, data: Any) -> bool:
        """Validate JSON data structure."""
        return isinstance(data, (dict, list))


class INIParseStrategy(ParseStrategy):
    """INI file parsing strategy."""

    def parse(self, content: str) -> Dict[str, Any]:
        """Parse INI content."""
        result: Dict[str, Any] = {}
        current_section = ''
        for line in content.split('\n'):
            stripped = line.strip()
            if not stripped or stripped.startswith('#'):
                continue
            if stripped.startswith('[') and stripped.endswith(']'):
                current_section = stripped[1:-1]
                result[current_section] = {}
            elif '=' in stripped and current_section:
                key, value = stripped.split('=', 1)
                result[current_section][key.strip()] = value.strip()
        return result

    def validate(self, data: Any) -> bool:
        """Validate INI data structure."""
        return isinstance(data, dict)


class KVParseStrategy(ParseStrategy):
    """Key-value parsing strategy."""

    def __init__(self, delimiter: str = '=', comment_char: str = '#'):
        self.delimiter = delimiter
        self.comment_char = comment_char

    def parse(self, content: str) -> Dict[str, str]:
        """Parse key-value content."""
        result = {}
        for line in content.split('\n'):
            line = line.strip()
            if not line or line.startswith(self.comment_char):
                continue
            if self.delimiter in line:
                key, value = line.split(self.delimiter, 1)
                result[key.strip()] = value.strip()
        return result

    def validate(self, data: Any) -> bool:
        """Validate key-value data structure."""
        return isinstance(data, dict)
"#;

    #[test]
    fn test_python_cls_all_four_classes_resolve() {
        let content = PYTHON_4_CLASSES;
        for name in &["ParseStrategy", "JSONParseStrategy", "INIParseStrategy", "KVParseStrategy"] {
            let result = resolve_symbol_anchor_lang(content, Some("cls"), name, Some("python"));
            assert!(result.is_ok(), "cls({}) not found in original content: {:?}", name, result.err());
            let body = result.unwrap();
            assert!(body.contains(&format!("class {}", name)),
                "cls({}) body missing class keyword", name);
        }
    }

    #[test]
    fn test_python_cls_lines_all_four() {
        let content = PYTHON_4_CLASSES;
        for name in &["ParseStrategy", "JSONParseStrategy", "INIParseStrategy", "KVParseStrategy"] {
            let result = resolve_symbol_anchor_lines_lang(content, Some("cls"), name, Some("python"));
            assert!(result.is_ok(), "cls({}) lines not found: {:?}", name, result.err());
            let (start, end) = result.unwrap();
            assert!(start >= 1 && end >= start,
                "cls({}) invalid range {}-{}", name, start, end);
        }
    }

    #[test]
    fn test_python_cls_sequential_extraction_simulation() {
        let mut content = PYTHON_4_CLASSES.to_string();
        let classes = ["ParseStrategy", "JSONParseStrategy", "INIParseStrategy", "KVParseStrategy"];
        let expected_methods: [&[&str]; 4] = [
            &["def parse", "def validate"],
            &["def parse", "def validate"],
            &["def parse", "def validate"],
            &["def __init__", "def parse", "def validate"],
        ];

        for (i, name) in classes.iter().enumerate() {
            let result = resolve_symbol_anchor_lang(&content, Some("cls"), name, Some("python"));
            assert!(result.is_ok(),
                "op {}: cls({}) not found after {} prior removals. Content len={}",
                i, name, i, content.len());
            let body = result.unwrap();

            // Verify extracted body contains all expected methods
            for method in expected_methods[i] {
                assert!(body.contains(method),
                    "op {}: cls({}) body missing '{}'. Body:\n{}", i, name, method, body);
            }

            let (start, end) = resolve_symbol_anchor_lines_lang(
                &content, Some("cls"), name, Some("python")
            ).unwrap();

            let lines: Vec<&str> = content.lines().collect();
            let mut new_lines: Vec<&str> = Vec::new();
            for (idx, line) in lines.iter().enumerate() {
                let line_num = (idx + 1) as u32;
                if line_num >= start && line_num <= end {
                    continue;
                }
                new_lines.push(line);
            }
            content = new_lines.join("\n");

            for remaining in &classes[i + 1..] {
                let check = resolve_symbol_anchor_lang(&content, Some("cls"), remaining, Some("python"));
                assert!(check.is_ok(),
                    "After removing cls({}), cls({}) not found. Remaining content ({} lines):\n{}",
                    name, remaining, content.lines().count(), &content);
            }
        }

        let remaining_classes: Vec<&str> = content.lines()
            .filter(|l| l.trim_start().starts_with("class "))
            .collect();
        assert!(remaining_classes.is_empty(),
            "Classes still in content after all removals: {:?}", remaining_classes);
    }

    // -----------------------------------------------------------------------
    // X-Ray Vision: :sig shows C-family + class methods + arrow functions
    // -----------------------------------------------------------------------

    #[test]
    fn test_sig_shows_cfamily_functions() {
        let content = "#include <stdio.h>\n\nstatic int parse_number(const char *input) {\n    return atoi(input);\n}\n\nvoid process(char *buf) {\n    printf(\"%s\", buf);\n}";
        let sigs = extract_signatures(content);
        assert!(sigs.contains("parse_number"), "sig should show C function parse_number");
        assert!(sigs.contains("process"), "sig should show C function process");
    }

    #[test]
    fn test_sig_shows_class_methods() {
        let content = "class UserService {\n    async getUser(id: string) {\n        return this.db.find(id);\n    }\n    static create() {\n        return new UserService();\n    }\n}";
        let sigs = extract_signatures(content);
        assert!(sigs.contains("getUser") || sigs.contains("UserService"), "sig should show class or method: {}", sigs);
    }

    #[test]
    fn test_sig_multiline_params() {
        let content = "pub fn process(\n    input: &str,\n    config: &Config,\n) -> Result<Output, Error> {\n    todo!()\n}";
        let sigs = extract_signatures(content);
        assert!(sigs.contains("process"), "sig should capture multi-line fn");
    }

    // -----------------------------------------------------------------------
    // X-Ray Vision: String/comment-aware braces
    // -----------------------------------------------------------------------

    #[test]
    fn test_find_block_end_string_brace() {
        let content = "fn test() {\n    let x = \"}\";\n    let y = 42;\n}";
        let lines: Vec<&str> = content.lines().collect();
        let end = find_block_end(&lines, 0, lines.len(), None);
        assert_eq!(end, 3, "closing brace in string should not end block prematurely");
    }

    #[test]
    fn test_find_block_end_comment_brace() {
        let content = "fn test() {\n    // }\n    let y = 42;\n}";
        let lines: Vec<&str> = content.lines().collect();
        let end = find_block_end(&lines, 0, lines.len(), None);
        assert_eq!(end, 3, "closing brace in comment should not end block");
    }

    #[test]
    fn test_ruby_def_end_block() {
        let content = "def process(data)\n  result = transform(data)\n  validate(result)\nend\n\ndef other\n  42\nend";
        let lines: Vec<&str> = content.lines().collect();
        let end = find_block_end(&lines, 0, lines.len(), None);
        assert_eq!(end, 3, "Ruby def...end should be tracked correctly");
    }

    // -----------------------------------------------------------------------
    // X-Ray Vision: New selectors
    // -----------------------------------------------------------------------

    #[test]
    fn test_type_selector() {
        let content = "type UserId = string;\n\ntype Config = {\n    host: string;\n    port: number;\n};";
        let result = resolve_symbol_anchor(content, Some("type"), "Config").unwrap();
        assert!(result.contains("Config"), "type() should find type declaration");
    }

    #[test]
    fn test_impl_selector() {
        let content = "impl Display for Foo {\n    fn fmt(&self) -> String {\n        format!(\"{}\", self.0)\n    }\n}";
        let result = resolve_symbol_anchor(content, Some("impl"), "Foo").unwrap();
        assert!(result.contains("impl Display for Foo"), "impl() should find impl block");
        assert!(result.contains("fmt"), "impl() should include methods");
    }

    #[test]
    fn test_const_selector() {
        let content = "pub const MAX_SIZE: usize = 1024;\n\npub const CONFIG: Config = Config {\n    host: \"localhost\",\n    port: 8080,\n};";
        let r1 = resolve_symbol_anchor(content, Some("const"), "CONFIG").unwrap();
        assert!(r1.contains("CONFIG"), "const() should find const declaration with body");
        assert!(r1.contains("localhost"), "const() should include const body");
    }

    #[test]
    fn test_mod_ns_selector() {
        let content = "pub mod tests {\n    use super::*;\n    fn test_it() { assert!(true); }\n}";
        let result = resolve_symbol_anchor(content, Some("mod"), "tests").unwrap();
        assert!(result.contains("pub mod tests"), "mod() should find module");
        assert!(result.contains("test_it"), "mod() should include contents");
    }

    #[test]
    fn test_c_define_macro() {
        let content = "#define MAX(a, b) ((a) > (b) ? (a) : (b))\n#define MIN(a, b) ((a) < (b) ? (a) : (b))";
        let result = resolve_symbol_anchor(content, Some("macro"), "MAX").unwrap();
        assert!(result.contains("MAX"), "macro() should find C #define");
    }

    // -----------------------------------------------------------------------
    // Fix: Arrow functions with return type annotations
    // -----------------------------------------------------------------------

    #[test]
    fn test_arrow_function_with_return_type() {
        let content = "export const formatError = (code: number, msg: string): string => {\n    return `E${code}: ${msg}`;\n};";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "formatError", Some("typescript")).unwrap();
        assert!(result.contains("formatError"), "should find exported arrow with return type");
        assert!(result.contains("E${code}"), "should include body");
    }

    // -----------------------------------------------------------------------
    // Fix: Bodyless const/static declarations
    // -----------------------------------------------------------------------

    #[test]
    fn test_const_bodyless_single_line() {
        let content = "pub const MAX_RETRIES: u32 = 3;\n\nfn other() { 1 }";
        let result = resolve_symbol_anchor(content, Some("const"), "MAX_RETRIES").unwrap();
        assert!(result.contains("MAX_RETRIES"), "single-line const should resolve without bodyless error");
        assert!(result.contains("= 3"), "should include the value");
    }

    #[test]
    fn test_static_bodyless_single_line() {
        let content = "static COUNTER: AtomicU32 = AtomicU32::new(0);";
        let result = resolve_symbol_anchor(content, Some("static"), "COUNTER").unwrap();
        assert!(result.contains("COUNTER"), "single-line static should resolve");
    }

    #[test]
    fn test_const_multiline_array_literal() {
        let content = "export const SECTIONS: SectionDef[] = [\n  { id: 'hpp', title: 'HPP' },\n  { id: 'bb', title: 'Blackboard' },\n  { id: 'ctx', title: 'Context' },\n];";
        let result = resolve_symbol_anchor(content, Some("const"), "SECTIONS").unwrap();
        assert!(result.contains("SECTIONS"), "const() should find multi-line array constant");
        assert!(result.contains("ctx"), "const() should include all array elements");
        assert!(result.contains("];"), "const() should include closing bracket");
    }

    #[test]
    fn test_find_block_end_array_with_objects() {
        let content = "const ITEMS = [\n  { a: 1 },\n  { b: 2 },\n];";
        let lines: Vec<&str> = content.lines().collect();
        let end = find_block_end(&lines, 0, lines.len(), None);
        assert_eq!(end, 3, "block end should be at closing ]; not at first }}");
    }

    #[test]
    fn test_find_block_end_rust_where_clause() {
        let content = "pub fn process<T>(input: T) -> Result<(), Error>\nwhere\n    T: Display + Debug,\n{\n    println!(\"{:?}\", input);\n    Ok(())\n}";
        let lines: Vec<&str> = content.lines().collect();
        let end = find_block_end(&lines, 0, lines.len(), None);
        assert_eq!(end, 6, "where clause should not cause premature block end");
    }

    #[test]
    fn test_find_block_end_rust_where_multiline_bounds() {
        let content = "pub fn transform<T, U>(a: T, b: U) -> Vec<U>\nwhere\n    T: Into<U> +\n        Clone,\n    U: Default,\n{\n    vec![b]\n}";
        let lines: Vec<&str> = content.lines().collect();
        let end = find_block_end(&lines, 0, lines.len(), None);
        assert_eq!(end, 7, "multi-line where bounds with trailing + should not bail early");
    }

    #[test]
    fn test_find_block_end_rust_trailing_comma_params() {
        let content = "pub fn create(\n    name: &str,\n    value: u32,\n) -> Self {\n    Self { name, value }\n}";
        let lines: Vec<&str> = content.lines().collect();
        let end = find_block_end(&lines, 0, lines.len(), None);
        assert_eq!(end, 5, "trailing comma in params should not bail early");
    }

    // -----------------------------------------------------------------------
    // Fix: Ruby def self.method syntax
    // -----------------------------------------------------------------------

    #[test]
    fn test_ruby_self_method() {
        let content = "module StringHelpers\n  def self.titleize(str)\n    str.split(' ').map(&:capitalize).join(' ')\n  end\n\n  def self.truncate(str, length)\n    str[0, length]\n  end\nend";
        let result = resolve_symbol_anchor_lang(content, Some("fn"), "titleize", Some("ruby")).unwrap();
        assert!(result.contains("titleize"), "should find Ruby def self.method");
        assert!(result.contains("capitalize"), "should include method body");
    }

    #[test]
    fn test_ruby_self_method_names_discovered() {
        let content = "module Helpers\n  def self.titleize(str)\n    str.capitalize\n  end\n  def self.truncate(str, n)\n    str[0, n]\n  end\nend";
        let names = extract_symbol_names(content, Some("fn"));
        assert!(names.contains(&"titleize".to_string()), "should discover self.titleize: {:?}", names);
        assert!(names.contains(&"truncate".to_string()), "should discover self.truncate: {:?}", names);
    }

    #[test]
    fn test_qualified_path() {
        let content = "class AuthService {\n    validate(token: string) {\n        return token.length > 0;\n    }\n}\n\nclass InputService {\n    validate(input: any) {\n        return input != null;\n    }\n}";
        let r1 = resolve_symbol_anchor_lang(content, Some("fn"), "AuthService.validate", Some("typescript")).unwrap();
        assert!(r1.contains("token.length"), "qualified path should find method in AuthService");
        let r2 = resolve_symbol_anchor_lang(content, Some("fn"), "InputService.validate", Some("typescript")).unwrap();
        assert!(r2.contains("input != null"), "qualified path should find method in InputService");
    }

    // -----------------------------------------------------------------------
    // :refs — Identifier Scanning Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_refs_typescript() {
        let content = r#"async function expandFilePathRefs(
  rawPaths: string[],
  hashLookup: HashLookup,
  setLookup: SetRefLookup,
): Promise<{ items: ExpandedFilePath[]; notes: string[] }> {
  const items: ExpandedFilePath[] = [];
  const parsed = parseHashRef(fp);
  const entry = await hashLookup(parsed.hash);
  const projectPath = useAppStore.getState().projectPath;
  const result = await invoke<string[]>('expand_file_glob', { projectRoot: projectPath });
  return { items, notes };
}"#;
        let refs = extract_refs(content);
        // Types (PascalCase) should be found
        assert!(refs.lines().any(|l| l == "HashLookup"), "should find HashLookup type");
        assert!(refs.lines().any(|l| l == "SetRefLookup"), "should find SetRefLookup type");
        assert!(refs.lines().any(|l| l == "ExpandedFilePath"), "should find ExpandedFilePath type");
        assert!(refs.lines().any(|l| l == "Promise"), "should find Promise type");
        // Function calls
        assert!(refs.lines().any(|l| l == "parseHashRef"), "should find parseHashRef call");
        assert!(refs.lines().any(|l| l == "useAppStore"), "should find useAppStore store access");
        assert!(refs.lines().any(|l| l == "invoke"), "should find invoke call");
        // Keywords should NOT be present
        assert!(!refs.lines().any(|l| l == "const"), "should exclude keyword const");
        assert!(!refs.lines().any(|l| l == "async"), "should exclude keyword async");
        assert!(!refs.lines().any(|l| l == "function"), "should exclude keyword function");
        assert!(!refs.lines().any(|l| l == "await"), "should exclude keyword await");
        assert!(!refs.lines().any(|l| l == "return"), "should exclude keyword return");
        assert!(!refs.lines().any(|l| l == "string"), "should exclude keyword string");
    }

    #[test]
    fn test_refs_rust() {
        let content = r#"pub fn process_data(input: &str) -> Result<HashMap<String, Vec<u8>>, AtlsError> {
    let mut map = HashMap::new();
    let entries = parse_entries(input)?;
    for entry in entries {
        let key = entry.name.clone();
        let value = serialize_value(&entry.data);
        map.insert(key, value);
    }
    Ok(map)
}"#;
        let refs = extract_refs(content);
        assert!(refs.lines().any(|l| l == "Result"), "should find Result");
        assert!(refs.lines().any(|l| l == "HashMap"), "should find HashMap");
        assert!(refs.lines().any(|l| l == "String"), "should find String");
        assert!(refs.lines().any(|l| l == "Vec"), "should find Vec");
        assert!(refs.lines().any(|l| l == "AtlsError"), "should find AtlsError");
        assert!(refs.lines().any(|l| l == "parse_entries"), "should find parse_entries");
        assert!(refs.lines().any(|l| l == "serialize_value"), "should find serialize_value");
        assert!(refs.lines().any(|l| l == "Ok"), "should find Ok");
        // Keywords
        assert!(!refs.lines().any(|l| l == "fn"), "should exclude fn");
        assert!(!refs.lines().any(|l| l == "let"), "should exclude let");
        assert!(!refs.lines().any(|l| l == "mut"), "should exclude mut");
        assert!(!refs.lines().any(|l| l == "pub"), "should exclude pub");
        assert!(!refs.lines().any(|l| l == "for"), "should exclude for");
    }

    #[test]
    fn test_refs_python() {
        let content = r#"def process_request(self, request: HttpRequest) -> JsonResponse:
    validator = RequestValidator(request.body)
    if not validator.is_valid():
        raise ValidationError("invalid payload")
    result = transform_data(validator.cleaned_data)
    return JsonResponse({"status": "ok", "data": result})
"#;
        let refs = extract_refs(content);
        assert!(refs.lines().any(|l| l == "HttpRequest"), "should find HttpRequest");
        assert!(refs.lines().any(|l| l == "JsonResponse"), "should find JsonResponse");
        assert!(refs.lines().any(|l| l == "RequestValidator"), "should find RequestValidator");
        assert!(refs.lines().any(|l| l == "ValidationError"), "should find ValidationError");
        assert!(refs.lines().any(|l| l == "transform_data"), "should find transform_data");
        assert!(!refs.lines().any(|l| l == "def"), "should exclude def");
        assert!(!refs.lines().any(|l| l == "self"), "should exclude self");
        assert!(!refs.lines().any(|l| l == "not"), "should exclude not");
        assert!(!refs.lines().any(|l| l == "return"), "should exclude return");
        assert!(!refs.lines().any(|l| l == "if"), "should exclude if");
    }

    #[test]
    fn test_refs_go() {
        let content = r#"func (s *Server) handleRequest(w http.ResponseWriter, r *http.Request) error {
    ctx := context.Background()
    user, err := s.userRepo.FindByID(ctx, r.URL.Query().Get("id"))
    if err != nil {
        return fmt.Errorf("user lookup: %w", err)
    }
    return json.NewEncoder(w).Encode(user)
}"#;
        let refs = extract_refs(content);
        assert!(refs.lines().any(|l| l == "Server"), "should find Server");
        assert!(refs.lines().any(|l| l == "http"), "should find http package");
        assert!(refs.lines().any(|l| l == "ResponseWriter"), "should find ResponseWriter");
        assert!(refs.lines().any(|l| l == "Request"), "should find Request");
        assert!(refs.lines().any(|l| l == "context"), "should find context");
        assert!(refs.lines().any(|l| l == "json"), "should find json");
        assert!(refs.lines().any(|l| l == "fmt"), "should find fmt");
        assert!(!refs.lines().any(|l| l == "func"), "should exclude func");
        assert!(!refs.lines().any(|l| l == "nil"), "should exclude nil");
        assert!(!refs.lines().any(|l| l == "return"), "should exclude return");
    }

    #[test]
    fn test_refs_java() {
        let content = r#"public List<UserDTO> findActiveUsers(UserRepository repo) throws ServiceException {
    List<User> users = repo.findAll();
    return users.stream()
        .filter(User::isActive)
        .map(UserMapper::toDTO)
        .collect(Collectors.toList());
}"#;
        let refs = extract_refs(content);
        assert!(refs.lines().any(|l| l == "List"), "should find List");
        assert!(refs.lines().any(|l| l == "UserDTO"), "should find UserDTO");
        assert!(refs.lines().any(|l| l == "UserRepository"), "should find UserRepository");
        assert!(refs.lines().any(|l| l == "ServiceException"), "should find ServiceException");
        assert!(refs.lines().any(|l| l == "User"), "should find User");
        assert!(refs.lines().any(|l| l == "UserMapper"), "should find UserMapper");
        assert!(refs.lines().any(|l| l == "Collectors"), "should find Collectors");
        assert!(!refs.lines().any(|l| l == "public"), "should exclude public");
        assert!(!refs.lines().any(|l| l == "throws"), "should exclude throws");
        assert!(!refs.lines().any(|l| l == "return"), "should exclude return");
    }

    #[test]
    fn test_refs_csharp() {
        let content = r#"public async Task<ActionResult<UserDto>> GetUser(int id, IUserService userService) {
    var user = await userService.FindAsync(id);
    if (user == null) return NotFound();
    return Ok(new UserDto(user.Name, user.Email));
}"#;
        let refs = extract_refs(content);
        assert!(refs.lines().any(|l| l == "Task"), "should find Task");
        assert!(refs.lines().any(|l| l == "ActionResult"), "should find ActionResult");
        assert!(refs.lines().any(|l| l == "UserDto"), "should find UserDto");
        assert!(refs.lines().any(|l| l == "IUserService"), "should find IUserService");
        assert!(refs.lines().any(|l| l == "NotFound"), "should find NotFound");
        assert!(!refs.lines().any(|l| l == "public"), "should exclude public");
        assert!(!refs.lines().any(|l| l == "async"), "should exclude async");
        assert!(!refs.lines().any(|l| l == "var"), "should exclude var");
    }

    #[test]
    fn test_refs_cpp() {
        let content = r#"template<typename T>
std::vector<T> merge_sorted(const std::vector<T>& left, const std::vector<T>& right) {
    std::vector<T> result;
    auto it_l = left.begin();
    auto it_r = right.begin();
    while (it_l != left.end() && it_r != right.end()) {
        if (*it_l <= *it_r) result.push_back(*it_l++);
        else result.push_back(*it_r++);
    }
    return result;
}"#;
        let refs = extract_refs(content);
        assert!(refs.lines().any(|l| l == "std"), "should find std");
        assert!(refs.lines().any(|l| l == "vector"), "should find vector");
        assert!(refs.lines().any(|l| l == "result"), "should find result");
        assert!(!refs.lines().any(|l| l == "template"), "should exclude template");
        assert!(!refs.lines().any(|l| l == "typename"), "should exclude typename");
        assert!(!refs.lines().any(|l| l == "while"), "should exclude while");
        assert!(!refs.lines().any(|l| l == "return"), "should exclude return");
    }

    #[test]
    fn test_refs_comment_stripping() {
        let content = r#"function process(data: InputData): OutputData {
  // Uses HashLookup for resolution
  const result = transform(data);
  /* This calls parseHashRef internally
     and also uses SetRefLookup */
  const name = "parseHashRef failed";
  return result;
}"#;
        let refs = extract_refs(content);
        // HashLookup is ONLY in a comment — should NOT appear
        assert!(!refs.lines().any(|l| l == "HashLookup"), "should not find identifier from // comment");
        // parseHashRef appears in comment AND string — should NOT appear
        assert!(!refs.lines().any(|l| l == "parseHashRef"), "should not find identifier from /* comment */ or string");
        // SetRefLookup is ONLY in block comment — should NOT appear
        assert!(!refs.lines().any(|l| l == "SetRefLookup"), "should not find identifier from block comment");
        // Real identifiers should still be found
        assert!(refs.lines().any(|l| l == "InputData"), "should find InputData (real type)");
        assert!(refs.lines().any(|l| l == "OutputData"), "should find OutputData (real type)");
        assert!(refs.lines().any(|l| l == "transform"), "should find transform (real call)");
    }

    #[test]
    fn test_refs_template_literal() {
        let content = r#"function buildMessage(user: UserInfo, count: number): string {
  const greeting = `Hello ${formatName(user.name)}, you have ${count} items`;
  return greeting;
}"#;
        let refs = extract_refs(content);
        // formatName is inside ${...} in a template literal — should be found
        assert!(refs.lines().any(|l| l == "formatName"), "should find identifier inside template expression");
        assert!(refs.lines().any(|l| l == "UserInfo"), "should find UserInfo type");
        // "Hello" text should NOT produce identifiers
        assert!(!refs.lines().any(|l| l == "Hello"), "should not find string literal text");
        assert!(!refs.lines().any(|l| l == "you"), "should not find string literal text");
    }

    #[test]
    fn test_neutralize_preserves_structure() {
        let content = "let x = 1; // comment\nlet y = \"hello world\";\nlet z = x + y;";
        let neutralized = neutralize_comments_and_strings(content);
        assert_eq!(neutralized.lines().count(), content.lines().count(), "line count must match");
        assert!(neutralized.contains("let x"), "real code preserved");
        assert!(neutralized.contains("let z"), "real code preserved");
        assert!(!neutralized.contains("comment"), "comment text neutralized");
        assert!(!neutralized.contains("hello"), "string content neutralized");
    }

    // -----------------------------------------------------------------------
    // :deps — Dependency Analysis Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_simple_extraction() {
        let content = r#"import { HashLookup } from '../utils/hashResolver';
import { invoke } from '@tauri-apps/api/core';

function stripGitLabelPrefix(source: string): string {
  const m = source.match(/^(?:HEAD):(.+)$/);
  return m ? m[1] : source;
}

async function expandFilePathRefs(rawPaths: string[], hashLookup: HashLookup): Promise<string[]> {
  const items: string[] = [];
  for (const fp of rawPaths) {
    const entry = await hashLookup(fp);
    const expanded = await invoke('expand_file_glob', { path: fp });
    items.push(fp);
  }
  return items;
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "expandFilePathRefs", Some("typescript")).unwrap();
        assert!(result.contains("[needed_imports]"), "should have needed_imports section");
        assert!(result.contains("HashLookup"), "should need HashLookup import");
        assert!(result.contains("invoke"), "should need invoke import");
        assert!(result.contains("[scope]"), "should have scope section");
        assert!(result.contains("module"), "should be module-scoped");
    }

    #[test]
    fn test_deps_same_file_type() {
        let content = r#"import { invoke } from '@tauri-apps/api/core';

type ExpandedFilePath =
  | { kind: 'path'; path: string }
  | { kind: 'content'; content: string; source: string };

function expandFilePathRefs(rawPaths: string[]): ExpandedFilePath[] {
  const items: ExpandedFilePath[] = [];
  for (const fp of rawPaths) {
    items.push({ kind: 'path', path: fp });
  }
  return items;
}

function otherFunction(): void {
  console.log("does not use ExpandedFilePath");
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "expandFilePathRefs", Some("typescript")).unwrap();
        assert!(result.contains("[co_move]"), "should have co_move section");
        assert!(result.contains("ExpandedFilePath"), "should flag ExpandedFilePath as co-move");
        assert!(result.contains("exclusive"), "ExpandedFilePath should be exclusive (not used by otherFunction)");
    }

    #[test]
    fn test_deps_no_dependencies() {
        let content = r#"function stripGitLabelPrefix(source: string): string {
  const m = source.match(/^(?:HEAD):(.+)$/);
  return m ? m[1] : source;
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "stripGitLabelPrefix", Some("typescript")).unwrap();
        assert!(result.contains("[needed_imports]"), "should have needed_imports section");
        assert!(result.contains("(none)"), "should have no needed imports");
        assert!(result.contains("module"), "should be module-scoped");
    }

    #[test]
    fn test_deps_multiple_imports() {
        let content = r#"import { parseHashRef, parseSetRef } from '../utils/hashResolver';
import { useAppStore } from '../stores/appStore';
import { invoke } from '@tauri-apps/api/core';
import { formatChunkRef } from '../utils/contextHash';

function complexFunction(refs: string[]): void {
  for (const ref of refs) {
    const parsed = parseHashRef(ref);
    const setRef = parseSetRef(ref);
    const path = useAppStore.getState().projectPath;
    invoke('resolve', { ref: parsed });
  }
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "complexFunction", Some("typescript")).unwrap();
        assert!(result.contains("parseHashRef"), "should need hashResolver import");
        assert!(result.contains("useAppStore"), "should need appStore import");
        assert!(result.contains("invoke"), "should need invoke import");
        // formatChunkRef is NOT used by complexFunction
        assert!(!result.contains("formatChunkRef"), "should NOT need unused import");
    }

    #[test]
    fn test_deps_shared_type() {
        let content = r#"type Config = { timeout: number; retries: number };

function createClient(config: Config): void {
  console.log(config.timeout);
}

function validateConfig(config: Config): boolean {
  return config.timeout > 0;
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "createClient", Some("typescript")).unwrap();
        assert!(result.contains("Config"), "should flag Config as co-move");
        assert!(result.contains("shared"), "Config should be marked shared (used by validateConfig too)");
    }

    // -----------------------------------------------------------------------
    // Scope Nesting Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_scope_module_level() {
        let content = r#"function topLevel(): void {
  console.log("hello");
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "topLevel", Some("typescript")).unwrap();
        assert!(result.contains("module"), "top-level function should be module-scoped");
        assert!(!result.contains("nested"), "should not be nested");
    }

    #[test]
    fn test_scope_nested_in_function() {
        let content = r#"function outerFunction(): void {
  const syncLookup = createHashLookup(sessionId);
  const hashLookup = async (hash: string) => {
    const r = syncLookup(hash);
    return r;
  };
  hashLookup("test");
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "hashLookup", Some("typescript")).unwrap();
        assert!(result.contains("nested"), "nested function should be detected as nested");
        assert!(result.contains("outerFunction"), "should identify parent function");
    }

    #[test]
    fn test_scope_deeply_nested() {
        let content = r#"function level1(): void {
  function level2(): void {
    function level3(): void {
      console.log("deep");
    }
    level3();
  }
  level2();
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "level3", Some("typescript")).unwrap();
        assert!(result.contains("nested"), "deeply nested function should be detected");
        assert!(result.contains("level2"), "should identify immediate parent (level2)");
    }

    #[test]
    fn test_deps_nested_captures_variables() {
        let content = r#"function executeManageBatch(): void {
  const sessionId = getCurrentSessionId();
  const syncLookup = createHashLookup(sessionId);
  const hashLookup = async (hash: string) => {
    const r = syncLookup(hash);
    return r;
  };
  hashLookup("test");
}"#;
        let result = analyze_symbol_deps(content, Some("fn"), "hashLookup", Some("typescript")).unwrap();
        assert!(result.contains("[captured]"), "should have captured section");
        assert!(result.contains("syncLookup"), "should capture syncLookup");
        assert!(result.contains("Cannot cleanly extract"), "should warn about extraction difficulty");
    }

    // -----------------------------------------------------------------------
    // Multi-line Import Tests (shape_ops extract_imports)
    // -----------------------------------------------------------------------

    #[test]
    fn test_multiline_import_ts() {
        let content = "import {\n  HashLookup,\n  SetRefLookup,\n  ParsedSetRef,\n} from '../utils/hashResolver';\n\nfunction foo() { HashLookup; }";
        let result = extract_imports(content);
        assert!(result.contains("HashLookup"), "should join multi-line TS import");
        assert!(result.contains("SetRefLookup"), "should contain SetRefLookup");
        assert!(result.contains("ParsedSetRef"), "should contain ParsedSetRef");
        assert!(result.contains("hashResolver"), "should contain module path");
        // Should be a single joined line
        let import_lines: Vec<&str> = result.lines().filter(|l| l.contains("import")).collect();
        assert_eq!(import_lines.len(), 1, "multi-line import should be joined into one line");
    }

    #[test]
    fn test_multiline_import_python() {
        let content = "from typing import (\n    List,\n    Dict,\n    Optional,\n)\n\ndef foo(): pass";
        let result = extract_imports(content);
        assert!(result.contains("List"), "should join multi-line Python import");
        assert!(result.contains("Dict"), "should contain Dict");
        assert!(result.contains("Optional"), "should contain Optional");
    }

    #[test]
    fn test_import_type_preservation() {
        let content = "import type { HashLookup, SetRefLookup } from '../utils/hashResolver';\nimport { invoke } from '@tauri-apps/api/core';\n\nfunction foo(h: HashLookup) { invoke('cmd'); }";
        let result = extract_imports(content);
        assert!(result.contains("import type"), "should preserve import type keyword");
        assert!(result.contains("HashLookup"), "should contain type import names");
    }

    #[test]
    fn test_wildcard_import_in_deps() {
        let content = "import * as helpers from './helpers';\n\nfunction foo(): void {\n  helpers.doSomething();\n}";
        let result = analyze_symbol_deps(content, Some("fn"), "foo", Some("typescript")).unwrap();
        assert!(result.contains("[needed_imports]"), "should have needed_imports");
        assert!(result.contains("helpers"), "should detect namespace import usage");
    }

    // -----------------------------------------------------------------------
    // Integration Test: aiService.ts Extraction Scenario
    // -----------------------------------------------------------------------

    #[test]
    fn test_aiservice_extraction_scenario() {
        let content = r#"import type { HashLookup, SetRefLookup } from '../utils/hashResolver';
import { parseHashRef, parseSetRef } from '../utils/hashResolver';
import { useAppStore } from '../stores/appStore';
import { invoke } from '@tauri-apps/api/core';

type ExpandedFilePath =
  | { kind: 'path'; path: string }
  | { kind: 'content'; content: string; source: string };

function stripGitLabelPrefix(source: string): string {
  const m = source.match(/^(?:HEAD):(.+)$/);
  return m ? m[1] : source;
}

async function expandFilePathRefs(rawPaths: string[], hashLookup: HashLookup, setLookup: SetRefLookup): Promise<string[]> {
  const items: string[] = [];
  for (const fp of rawPaths) {
    const stripped = stripGitLabelPrefix(fp);
    const parsed = parseHashRef(stripped);
    const entry = await hashLookup(parsed.hash);
    const projectPath = useAppStore.getState().projectPath;
    const expanded = await invoke('expand_file_glob', { path: stripped, root: projectPath });
    items.push(fp);
  }
  return items;
}

async function executeManageBatch(sessionId: string): Promise<void> {
  const syncLookup = createHashLookup(sessionId);
  const hashLookup = async (hash: string): Promise<string> => {
    const r = syncLookup(hash);
    return r;
  };
  const rawPaths = ['file1.ts', 'file2.ts'];
  const result = await expandFilePathRefs(rawPaths, hashLookup, null);
  console.log(result);
}

function unusedFunction(): void {
  console.log("I am not used by any extracted function");
}"#;

        // Test 1: expandFilePathRefs:deps should detect needed imports
        let deps1 = analyze_symbol_deps(content, Some("fn"), "expandFilePathRefs", Some("typescript")).unwrap();
        assert!(deps1.contains("HashLookup"), "expandFilePathRefs needs HashLookup import");
        assert!(deps1.contains("SetRefLookup"), "expandFilePathRefs needs SetRefLookup import");
        assert!(deps1.contains("parseHashRef"), "expandFilePathRefs needs parseHashRef import");
        assert!(deps1.contains("useAppStore"), "expandFilePathRefs needs useAppStore import");
        assert!(deps1.contains("invoke"), "expandFilePathRefs needs invoke import");
        assert!(deps1.contains("module"), "expandFilePathRefs should be module-scoped");

        // Test 2: expandFilePathRefs should flag stripGitLabelPrefix as co-move
        assert!(deps1.contains("[co_move]"), "should have co-move section");
        assert!(deps1.contains("stripGitLabelPrefix"), "should co-move stripGitLabelPrefix");

        // Test 3: stripGitLabelPrefix:deps should be simple (no deps)
        let deps2 = analyze_symbol_deps(content, Some("fn"), "stripGitLabelPrefix", Some("typescript")).unwrap();
        assert!(deps2.contains("[needed_imports]"), "should have needed_imports section");
        let needed_section: String = deps2.lines()
            .skip_while(|l| !l.contains("[needed_imports]"))
            .skip(1)
            .take_while(|l| !l.starts_with('['))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(needed_section.contains("(none)"), "stripGitLabelPrefix should have no needed imports");

        // Test 4: hashLookup (nested) should be detected as scope=nested
        let deps3 = analyze_symbol_deps(content, Some("fn"), "hashLookup", Some("typescript")).unwrap();
        assert!(deps3.contains("nested"), "hashLookup should be detected as nested");
        assert!(deps3.contains("executeManageBatch"), "hashLookup parent should be executeManageBatch");
        assert!(deps3.contains("[captured]"), "should identify captured variables");
        assert!(deps3.contains("syncLookup"), "should capture syncLookup");
        assert!(deps3.contains("Cannot cleanly extract"), "should warn about extraction difficulty");
    }

    // -----------------------------------------------------------------------
    // Import Token Extraction: per-language coverage
    // -----------------------------------------------------------------------

    #[test]
    fn test_import_tokens_php() {
        let tokens = super::extract_import_tokens_local("use App\\Models\\User;");
        assert_eq!(tokens, vec!["User"]);
        let tokens = super::extract_import_tokens_local("use App\\Models\\{User, Post};");
        assert!(tokens.contains(&"User".to_string()));
        assert!(tokens.contains(&"Post".to_string()));
        let tokens = super::extract_import_tokens_local("use App\\Services\\AuthService as Auth;");
        assert_eq!(tokens, vec!["Auth"]);
    }

    #[test]
    fn test_import_tokens_ruby() {
        let tokens = super::extract_import_tokens_local("require 'json'");
        assert_eq!(tokens, vec!["json"]);
        let tokens = super::extract_import_tokens_local("require_relative 'user_serializer'");
        assert_eq!(tokens, vec!["user_serializer"]);
        let tokens = super::extract_import_tokens_local("require 'active_support/core_ext'");
        assert_eq!(tokens, vec!["core_ext"]);
    }

    #[test]
    fn test_import_tokens_dart() {
        let tokens = super::extract_import_tokens_local("import 'package:flutter/material.dart';");
        assert_eq!(tokens, vec!["material"]);
        let tokens = super::extract_import_tokens_local("import 'package:provider/provider.dart';");
        assert_eq!(tokens, vec!["provider"]);
    }

    #[test]
    fn test_import_tokens_go_multiline() {
        let joined = r#"import ( "context" "fmt" "net/http" "encoding/json" )"#;
        let tokens = super::extract_import_tokens_local(joined);
        assert!(tokens.contains(&"context".to_string()));
        assert!(tokens.contains(&"fmt".to_string()));
        assert!(tokens.contains(&"http".to_string()));
        assert!(tokens.contains(&"json".to_string()));
    }

    #[test]
    fn test_import_tokens_go_single() {
        let tokens = super::extract_import_tokens_local(r#"import "fmt""#);
        assert_eq!(tokens, vec!["fmt"]);
        let tokens = super::extract_import_tokens_local(r#"import "net/http""#);
        assert_eq!(tokens, vec!["http"]);
    }

    #[test]
    fn test_import_tokens_java() {
        let tokens = super::extract_import_tokens_local("import java.util.List;");
        assert_eq!(tokens, vec!["List"]);
        let tokens = super::extract_import_tokens_local("import java.util.stream.Collectors;");
        assert_eq!(tokens, vec!["Collectors"]);
        let tokens = super::extract_import_tokens_local("import com.example.dto.UserDTO;");
        assert_eq!(tokens, vec!["UserDTO"]);
    }

    #[test]
    fn test_import_tokens_kotlin() {
        let tokens = super::extract_import_tokens_local("import kotlinx.coroutines.flow.Flow");
        assert_eq!(tokens, vec!["Flow"]);
        let tokens = super::extract_import_tokens_local("import kotlinx.coroutines.flow.map");
        assert_eq!(tokens, vec!["map"]);
    }

    #[test]
    fn test_import_tokens_scala() {
        let tokens = super::extract_import_tokens_local("import scala.concurrent.Future");
        assert_eq!(tokens, vec!["Future"]);
    }

    #[test]
    fn test_import_tokens_swift() {
        let tokens = super::extract_import_tokens_local("import Foundation");
        assert_eq!(tokens, vec!["Foundation"]);
        let tokens = super::extract_import_tokens_local("import UIKit");
        assert_eq!(tokens, vec!["UIKit"]);
    }

    #[test]
    fn test_import_tokens_csharp() {
        let tokens = super::extract_import_tokens_local("using Microsoft.AspNetCore.Mvc;");
        assert_eq!(tokens, vec!["Mvc"]);
        let tokens = super::extract_import_tokens_local("using System.Threading.Tasks;");
        assert_eq!(tokens, vec!["Tasks"]);
    }

    #[test]
    fn test_import_tokens_c_cpp() {
        let tokens = super::extract_import_tokens_local("#include <vector>");
        assert_eq!(tokens, vec!["vector"]);
        let tokens = super::extract_import_tokens_local("#include \"config.h\"");
        assert_eq!(tokens, vec!["config"]);
    }

    #[test]
    fn test_import_tokens_rust() {
        let tokens = super::extract_import_tokens_local("use std::collections::HashMap;");
        assert_eq!(tokens, vec!["HashMap"]);
        let tokens = super::extract_import_tokens_local("use crate::types::{AtlsError, ProjectConfig};");
        assert!(tokens.contains(&"AtlsError".to_string()));
        assert!(tokens.contains(&"ProjectConfig".to_string()));
    }

    // -----------------------------------------------------------------------
    // :deps per-language: Go
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_go() {
        let content = r#"package service

import (
    "context"
    "fmt"
    "net/http"
    "encoding/json"
)

type Server struct {
    Port int
    Name string
}

type Response struct {
    Status string
    Data   interface{}
}

func (s *Server) HandleRequest(w http.ResponseWriter, r *http.Request) error {
    ctx := context.Background()
    user, err := s.findUser(ctx, r.URL.Query().Get("id"))
    if err != nil {
        return fmt.Errorf("user lookup: %w", err)
    }
    resp := Response{Status: "ok", Data: user}
    return json.NewEncoder(w).Encode(resp)
}

func (s *Server) findUser(ctx context.Context, id string) (string, error) {
    return id, nil
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "HandleRequest", Some("go")).unwrap();
        assert!(result.contains("context") || result.contains("fmt") || result.contains("json"),
            "Go :deps should detect needed imports: {}", result);
        assert!(result.contains("Response"), "should detect co-move Response: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: Java
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_java() {
        let content = r#"import java.util.List;
import java.util.stream.Collectors;
import com.example.dto.UserDTO;
import com.example.service.UserMapper;

public class UserService {
    private final UserRepository repo;

    public List<UserDTO> findActiveUsers() {
        List<User> users = repo.findAll();
        return users.stream()
            .filter(User::isActive)
            .map(UserMapper::toDTO)
            .collect(Collectors.toList());
    }

    public void unusedMethod() {
        System.out.println("nothing");
    }
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "findActiveUsers", Some("java")).unwrap();
        assert!(result.contains("List") || result.contains("java.util.List"),
            "Java should detect List import: {}", result);
        assert!(result.contains("Collectors") || result.contains("stream"),
            "Java should detect Collectors import: {}", result);
        assert!(result.contains("UserMapper") || result.contains("UserMapper"),
            "Java should detect UserMapper import: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: C#
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_csharp() {
        // Top-level C# function (outside class) to test import detection
        let content = r#"using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

UserDto CreateDto(string name, string email) {
    return new UserDto(name, email);
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "CreateDto", Some("csharp")).unwrap();
        assert!(result.contains("module"), "C# top-level fn should be module scope: {}", result);
    }

    #[test]
    fn test_deps_csharp_nested_in_class() {
        let content = r#"using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

public class UserController : ControllerBase {
    public async Task<ActionResult> GetUser(int id) {
        return Ok(id);
    }
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "GetUser", Some("csharp")).unwrap();
        assert!(result.contains("nested"), "C# method should be nested in class: {}", result);
        assert!(result.contains("UserController"), "parent should be UserController: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: C++
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_cpp() {
        let content = r#"#include <vector>
#include <algorithm>
#include <string>

struct Config {
    int timeout;
    std::string name;
};

std::vector<Config> merge_configs(const std::vector<Config>& left, const std::vector<Config>& right) {
    std::vector<Config> result;
    result.reserve(left.size() + right.size());
    std::merge(left.begin(), left.end(), right.begin(), right.end(), std::back_inserter(result));
    return result;
}

void unused_func() {}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "merge_configs", Some("cpp")).unwrap();
        assert!(result.contains("vector") || result.contains("<vector>"),
            "C++ should detect vector include: {}", result);
        assert!(result.contains("Config"), "C++ should detect co-move Config: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: Swift
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_swift() {
        let content = r#"import Foundation
import UIKit

struct Item {
    let id: String
    let name: String
}

protocol ItemRepository {
    func fetchAll() async throws -> [Item]
}

class ViewModel: ObservableObject {
    var items: [Item] = []
    private let repository: ItemRepository

    func loadItems() async throws {
        items = try await repository.fetchAll()
    }
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "loadItems", Some("swift")).unwrap();
        assert!(result.contains("module") || result.contains("nested"),
            "Swift should detect scope: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: Kotlin
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_kotlin() {
        let content = r#"import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

data class User(val name: String, val active: Boolean)

interface UserRepository {
    fun findAll(): Flow<User>
}

class UserViewModel(private val repo: UserRepository) {
    fun activeUsers(): Flow<User> {
        return repo.findAll().map { it }
    }

    fun unusedFun(): Unit {}
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "activeUsers", Some("kotlin")).unwrap();
        assert!(result.contains("Flow") || result.contains("flow"),
            "Kotlin should detect Flow import: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: Ruby
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_ruby() {
        let content = r#"require 'json'
require_relative 'user_serializer'

class ApplicationController
  def hello
    "hello"
  end
end

class UsersController < ApplicationController
  def index
    users = UserRepository.all
    serializer = UserSerializer.new(users)
    render json: serializer.as_json
  end
end"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "index", Some("ruby")).unwrap();
        assert!(result.contains("json") || result.contains("user_serializer"),
            "Ruby should detect require deps: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: PHP
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_php() {
        let content = r#"<?php
namespace App\Controllers;

use App\Models\User;
use App\Services\AuthService;
use Illuminate\Http\Request;

class UserController extends Controller {
    private AuthService $authService;

    public function show(Request $request, int $id) {
        $user = User::findOrFail($id);
        $this->authService->authorize($request, $user);
        return response()->json($user->toArray());
    }
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "show", Some("php")).unwrap();
        assert!(result.contains("User") || result.contains("Models"),
            "PHP should detect User import: {}", result);
        assert!(result.contains("Request") || result.contains("Http"),
            "PHP should detect Request import: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: Scala
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_scala() {
        let content = r#"import scala.concurrent.Future
import scala.concurrent.ExecutionContext.Implicits.global

case class Config(timeout: Int, retries: Int)

class DataService(config: Config) {
  def fetchData(id: String): Future[Option[String]] = Future {
    Some(id)
  }

  def unusedMethod(): Unit = {}
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "fetchData", Some("scala")).unwrap();
        assert!(result.contains("Future") || result.contains("concurrent"),
            "Scala should detect Future import: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: Dart
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_dart() {
        // Dart namespace imports don't enumerate individual symbols, so import
        // token matching relies on the package stem. Co-move + scope still work.
        let content = r#"import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class HomeViewModel {
  final List<String> items = [];
}

Widget buildHomePage(BuildContext context) {
  final viewModel = Provider.of<HomeViewModel>(context);
  return Scaffold(
    body: ListView.builder(
      itemCount: viewModel.items.length,
      itemBuilder: (ctx, i) => ListTile(title: Text(viewModel.items[i])),
    ),
  );
}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "buildHomePage", Some("dart")).unwrap();
        assert!(result.contains("HomeViewModel"), "Dart should detect co-move HomeViewModel: {}", result);
        assert!(result.contains("exclusive"), "HomeViewModel should be exclusive co-move: {}", result);
        assert!(result.contains("module"), "Dart top-level fn should be module scope: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: C
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_c() {
        // C struct detection + include token extraction
        let content = r#"#include <stdio.h>
#include <stdlib.h>
#include "mylib.h"

struct Point {
    int x;
    int y;
};

void print_point(struct Point p) {
    int z = p.x + p.y;
}

void unused() {}"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "print_point", Some("c")).unwrap();
        assert!(result.contains("Point"), "C should detect co-move struct Point: {}", result);
        assert!(result.contains("module"), "C top-level fn should be module scope: {}", result);
    }

    // -----------------------------------------------------------------------
    // :deps per-language: JavaScript (distinct from TS)
    // -----------------------------------------------------------------------

    #[test]
    fn test_deps_javascript() {
        let content = r#"import { createApp } from 'vue';
import { useStore } from './store';
const axios = require('axios');

function fetchUsers(store) {
  const app = createApp({});
  const s = useStore();
  return axios.get('/api/users');
}

function unusedFn() { return 42; }"#;
        let result = super::analyze_symbol_deps(content, Some("fn"), "fetchUsers", Some("javascript")).unwrap();
        assert!(result.contains("createApp") || result.contains("vue"),
            "JS should detect vue import: {}", result);
        assert!(result.contains("useStore") || result.contains("store"),
            "JS should detect store import: {}", result);
        assert!(result.contains("axios"),
            "JS should detect axios require: {}", result);
    }

    // -----------------------------------------------------------------------
    // Go multi-line import joining test
    // -----------------------------------------------------------------------

    #[test]
    fn test_go_multiline_import_joining() {
        let content = "package main\n\nimport (\n    \"fmt\"\n    \"net/http\"\n)\n\nfunc main() { fmt.Println(http.StatusOK) }";
        let imports = super::extract_import_lines(content);
        assert!(!imports.is_empty(), "should extract Go multi-line import");
        let joined = imports.join(" ");
        assert!(joined.contains("fmt"), "joined should have fmt");
        assert!(joined.contains("http"), "joined should have http");
    }

    #[test]
    fn uhpp_capability_report() {
        fn check_refs(content: &str, _lang: &str, expect_found: &[&str], expect_excluded: &[&str]) -> (usize, Vec<String>, bool) {
            let refs_output = super::extract_refs(content);
            let refs: Vec<&str> = refs_output.lines().collect();
            let mut lines = Vec::new();
            let mut ok = true;
            for &e in expect_found {
                if refs.contains(&e) {
                    lines.push(format!("      + {}", e));
                } else {
                    lines.push(format!("      MISS {}", e));
                    ok = false;
                }
            }
            for &e in expect_excluded {
                if !refs.contains(&e) {
                    lines.push(format!("      - {} (excluded)", e));
                } else {
                    lines.push(format!("      LEAK {} (should be excluded!)", e));
                    ok = false;
                }
            }
            (refs.len(), lines, ok)
        }

        let mut rpt = String::new();
        let (mut total, mut passed): (u32, u32) = (0, 0);

        rpt.push_str("\n\n");
        rpt.push_str("================================================================\n");
        rpt.push_str("  UHPP Extraction Dependency Detection - Capability Report\n");
        rpt.push_str("================================================================\n\n");

        // ── 1. NEUTRALIZE ──────────────────────────────────────────────
        rpt.push_str("  1. Comment/String Neutralization\n");
        rpt.push_str("  ────────────────────────────────\n");
        let neut_cases: Vec<(&str, &str, bool)> = vec![
            ("// line comment with HashLookup", "HashLookup", false),
            ("/* block comment with HashMap */", "HashMap", false),
            (r#"let x = "string with parseHashRef";"#, "parseHashRef", false),
            ("let y = `template ${realIdent} text`;", "realIdent", true),
            ("let z = 'single quote with SetRef';", "SetRef", false),
        ];
        for (input, ident, expect_present) in &neut_cases {
            total += 1;
            let n = super::neutralize_comments_and_strings(input);
            let ok = if *expect_present { n.contains(ident) } else { !n.contains(ident) };
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} neutralize {:50} ident={:15} {}\n",
                if ok {"PASS"} else {"FAIL"}, &input[..input.len().min(50)], ident, if *expect_present {"preserved"} else {"stripped"}));
        }
        rpt.push('\n');

        // ── 2. :refs PER LANGUAGE ──────────────────────────────────────
        rpt.push_str("  2. :refs - Per-Language Identifier Scanning\n");
        rpt.push_str("  ───────────────────────────────────────────\n");

        let ts_src = r#"import type { HashLookup, SetRefLookup } from '../utils/hashResolver';
import { parseHashRef } from '../utils/hashResolver';
import { useAppStore } from '../stores/appStore';
import { invoke } from '@tauri-apps/api/core';
import * as helpers from './helpers';

type ExpandedFilePath = { kind: string; path: string };

function stripGitLabelPrefix(source: string): string {
  const m = source.match(/^(?:HEAD):(.+)$/);
  return m ? m[1] : source;
}

async function expandFilePathRefs(rawPaths: string[], hashLookup: HashLookup, setLookup: SetRefLookup): Promise<string[]> {
  const items: string[] = [];
  for (const fp of rawPaths) {
    const stripped = stripGitLabelPrefix(fp);
    const parsed = parseHashRef(stripped);
    const entry = await hashLookup(parsed.hash);
    const projectPath = useAppStore.getState().projectPath;
    const expanded = await invoke('expand_file_glob', { path: stripped, root: projectPath });
    const h = helpers.format(expanded);
    items.push(h);
  }
  return items;
}

async function executeManageBatch(sessionId: string): Promise<void> {
  const syncLookup = createHashLookup(sessionId);
  const hashLookup = async (hash: string): Promise<string> => {
    const r = syncLookup(hash);
    return r;
  };
  const rawPaths = ['file1.ts', 'file2.ts'];
  const result = await expandFilePathRefs(rawPaths, hashLookup, null);
  console.log(result);
}

function unusedFunction(): void {
  console.log("not used by anyone extracted");
}"#;

        let rust_src = r#"use std::collections::HashMap;
use crate::types::{AtlsError, ProjectConfig};
use crate::utils::parse_entries;

pub struct IndexResult {
    pub entries: HashMap<String, Vec<u8>>,
    pub stats: IndexStats,
}
pub struct IndexStats { pub total: usize, pub skipped: usize }

pub fn process_data(input: &str, config: &ProjectConfig) -> Result<IndexResult, AtlsError> {
    let entries = parse_entries(input)?;
    let mut map = HashMap::new();
    for entry in entries {
        let key = entry.name.clone();
        let value = serialize_value(&entry.data);
        map.insert(key, value);
    }
    Ok(IndexResult { entries: map, stats: IndexStats { total: map.len(), skipped: 0 } })
}
fn serialize_value(data: &[u8]) -> Vec<u8> { data.to_vec() }"#;

        let py_src = r#"from typing import List, Dict, Optional
from dataclasses import dataclass
from .validators import RequestValidator, ValidationError
from .transformers import transform_data

@dataclass
class UserProfile:
    name: str
    email: str
    active: bool = True

def process_request(request: Dict, profile: UserProfile) -> Dict:
    validator = RequestValidator(request)
    if not validator.is_valid():
        raise ValidationError("invalid payload")
    result = transform_data(validator.cleaned_data, profile)
    return {"status": "ok", "data": result}"#;

        let go_src = r#"package service

import (
    "context"
    "fmt"
    "net/http"
    "encoding/json"
)

type Server struct { Port int; Name string }
type Response struct { Status string; Data interface{} }

func (s *Server) HandleRequest(w http.ResponseWriter, r *http.Request) error {
    ctx := context.Background()
    user, err := s.findUser(ctx, r.URL.Query().Get("id"))
    if err != nil { return fmt.Errorf("user lookup: %w", err) }
    resp := Response{Status: "ok", Data: user}
    return json.NewEncoder(w).Encode(resp)
}
func (s *Server) findUser(ctx context.Context, id string) (string, error) { return id, nil }"#;

        let java_src = r#"import java.util.List;
import java.util.stream.Collectors;
import com.example.dto.UserDTO;
import com.example.service.UserMapper;
import com.example.exception.ServiceException;

public class UserService {
    private final UserRepository repo;
    public UserService(UserRepository repo) { this.repo = repo; }
    public List<UserDTO> findActiveUsers() throws ServiceException {
        List<User> users = repo.findAll();
        return users.stream()
            .filter(User::isActive)
            .map(UserMapper::toDTO)
            .collect(Collectors.toList());
    }
}"#;

        let cs_src = r#"using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

public class UserController : ControllerBase {
    private readonly IUserService _userService;
    public UserController(IUserService userService) { _userService = userService; }
    public async Task<ActionResult<UserDto>> GetUser(int id) {
        var user = await _userService.FindAsync(id);
        if (user == null) return NotFound();
        return Ok(new UserDto(user.Name, user.Email));
    }
}"#;

        let cpp_src = r#"#include <vector>
#include <algorithm>
#include <string>
#include "config.h"
template<typename T>
std::vector<T> merge_sorted(const std::vector<T>& left, const std::vector<T>& right) {
    std::vector<T> result;
    result.reserve(left.size() + right.size());
    std::merge(left.begin(), left.end(), right.begin(), right.end(), std::back_inserter(result));
    return result;
}"#;

        let c_src = r#"#include <stdio.h>

struct Point { int x; int y; };

void show(struct Point p) {
    int z = p.x;
}"#;

        let js_src = r#"import { createApp } from 'vue';
const axios = require('axios');

function fetchData() {
  const app = createApp({});
  return axios.get('/api');
}"#;

        let swift_src = r#"import Foundation
import UIKit

class ViewModel: ObservableObject {
    @Published var items: [Item] = []
    private let repository: ItemRepository

    func loadItems() async throws {
        items = try await repository.fetchAll()
    }
}"#;

        let kotlin_src = r#"import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

data class User(val name: String, val active: Boolean)
interface UserRepository { fun findAll(): Flow<User> }

class UserViewModel(private val repo: UserRepository) {
    fun activeUsers(): Flow<User> = repo.findAll().map { it }.let { flow -> flow }
}"#;

        let ruby_src = r#"require 'json'
require_relative 'user_serializer'

class UsersController < ApplicationController
  def index
    users = UserRepository.all
    serializer = UserSerializer.new(users)
    render json: serializer.as_json
  end
end"#;

        let php_src = r#"<?php
namespace App\Controllers;

use App\Models\User;
use App\Services\AuthService;
use Illuminate\Http\Request;

class UserController extends Controller {
    private AuthService $authService;

    public function show(Request $request, int $id): JsonResponse {
        $user = User::findOrFail($id);
        $this->authService->authorize($request, $user);
        return response()->json($user->toArray());
    }
}"#;

        let scala_src = r#"import scala.concurrent.Future
import scala.concurrent.ExecutionContext.Implicits.global

case class Config(timeout: Int, retries: Int)

class DataService(config: Config) {
  def fetchData(id: String): Future[Option[String]] = Future {
    Some(id)
  }
}"#;

        let dart_src = r#"import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class HomePage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final viewModel = Provider.of<HomeViewModel>(context);
    return Scaffold(
      body: ListView.builder(
        itemCount: viewModel.items.length,
        itemBuilder: (ctx, i) => ListTile(title: Text(viewModel.items[i].name)),
      ),
    );
  }
}"#;

        struct LangCheck { lang: &'static str, src: &'static str, found: &'static [&'static str], excl: &'static [&'static str] }
        let lang_checks = vec![
            LangCheck { lang: "TypeScript", src: ts_src,
                found: &["HashLookup", "SetRefLookup", "parseHashRef", "useAppStore", "invoke", "helpers", "ExpandedFilePath"],
                excl: &["const", "async", "function", "await", "return", "for", "import"] },
            LangCheck { lang: "Rust", src: rust_src,
                found: &["HashMap", "String", "Vec", "AtlsError", "ProjectConfig", "parse_entries", "IndexResult", "IndexStats"],
                excl: &["fn", "pub", "let", "mut", "use", "for", "struct"] },
            LangCheck { lang: "Python", src: py_src,
                found: &["List", "Dict", "Optional", "RequestValidator", "ValidationError", "transform_data", "UserProfile"],
                excl: &["def", "class", "return", "if", "not", "from", "import"] },
            LangCheck { lang: "Go", src: go_src,
                found: &["Server", "Response", "http", "ResponseWriter", "Request", "json", "fmt"],
                excl: &["func", "package", "import", "return", "if", "nil", "for"] },
            LangCheck { lang: "Java", src: java_src,
                found: &["List", "UserDTO", "UserRepository", "ServiceException", "User", "UserMapper", "Collectors"],
                excl: &["public", "class", "return", "throws", "import"] },
            LangCheck { lang: "C#", src: cs_src,
                found: &["Task", "ActionResult", "UserDto", "IUserService", "ControllerBase", "NotFound"],
                excl: &["public", "async", "var", "return", "await", "using", "class"] },
            LangCheck { lang: "C++", src: cpp_src,
                found: &["vector", "std", "merge_sorted", "back_inserter"],
                excl: &["template", "typename", "const", "return"] },
            LangCheck { lang: "C", src: c_src,
                found: &["Point"],
                excl: &["struct", "void", "int", "return", "include"] },
            LangCheck { lang: "JavaScript", src: js_src,
                found: &["createApp", "axios", "fetchData"],
                excl: &["const", "function", "return", "import"] },
            LangCheck { lang: "Swift", src: swift_src,
                found: &["Foundation", "UIKit", "ViewModel", "ObservableObject", "Item", "ItemRepository"],
                excl: &["import", "class", "func", "var", "let", "async", "try", "await"] },
            LangCheck { lang: "Kotlin", src: kotlin_src,
                found: &["Flow", "User", "UserRepository", "UserViewModel"],
                excl: &["import", "class", "fun", "val", "data", "interface"] },
            LangCheck { lang: "Ruby", src: ruby_src,
                found: &["UserRepository", "UserSerializer", "ApplicationController", "UsersController"],
                excl: &["require", "class", "def", "end"] },
            LangCheck { lang: "PHP", src: php_src,
                found: &["User", "AuthService", "Request", "UserController", "Controller", "JsonResponse"],
                excl: &["namespace", "use", "class", "public", "function", "return"] },
            LangCheck { lang: "Scala", src: scala_src,
                found: &["Future", "Config", "DataService", "Option"],
                excl: &["import", "class", "def", "case", "val"] },
            LangCheck { lang: "Dart", src: dart_src,
                found: &["HomePage", "StatelessWidget", "Widget", "BuildContext", "HomeViewModel", "Scaffold", "ListView", "ListTile", "Text", "Provider"],
                excl: &["import", "class", "return", "final", "override"] },
        ];

        for lc in &lang_checks {
            total += 1;
            let (count, lines, ok) = check_refs(lc.src, lc.lang, lc.found, lc.excl);
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} {:12} ({} identifiers)\n", if ok {"PASS"} else {"FAIL"}, lc.lang, count));
            for l in &lines { rpt.push_str(&format!("{}\n", l)); }
            rpt.push('\n');
        }

        // ── 3. :deps DEPENDENCY ANALYSIS ───────────────────────────────
        rpt.push_str("  3. :deps - Symbol Dependency Analysis\n");
        rpt.push_str("  ─────────────────────────────────────\n");

        // 3a: TS expandFilePathRefs
        {
            total += 1;
            let r = super::analyze_symbol_deps(ts_src, Some("fn"), "expandFilePathRefs", Some("typescript")).unwrap();
            let checks: Vec<(&str, bool)> = vec![
                ("needs HashLookup import", r.contains("HashLookup")),
                ("needs SetRefLookup import", r.contains("SetRefLookup")),
                ("needs parseHashRef import", r.contains("parseHashRef")),
                ("needs useAppStore import", r.contains("useAppStore")),
                ("needs invoke import", r.contains("invoke")),
                ("needs helpers import", r.contains("helpers")),
                ("co-moves stripGitLabelPrefix", r.contains("stripGitLabelPrefix")),
                ("scope = module", r.contains("module")),
            ];
            let ok = checks.iter().all(|(_, v)| *v);
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} TS expandFilePathRefs:deps\n", if ok {"PASS"} else {"FAIL"}));
            for (label, v) in &checks { rpt.push_str(&format!("      {} {}\n", if *v {"+"} else {"X"}, label)); }
            rpt.push('\n');
        }

        // 3b: TS pure function (no deps)
        {
            total += 1;
            let r = super::analyze_symbol_deps(ts_src, Some("fn"), "stripGitLabelPrefix", Some("typescript")).unwrap();
            let no_imports = r.lines().skip_while(|l| !l.contains("[needed_imports]")).nth(1).map(|l| l.contains("(none)")).unwrap_or(false);
            let ok = no_imports && r.contains("module");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} TS stripGitLabelPrefix:deps - pure, no imports needed\n", if ok {"PASS"} else {"FAIL"}));
        }

        // 3c: Nested + captured variables
        {
            total += 1;
            let r = super::analyze_symbol_deps(ts_src, Some("fn"), "hashLookup", Some("typescript")).unwrap();
            let checks: Vec<(&str, bool)> = vec![
                ("scope = nested", r.contains("nested")),
                ("parent = executeManageBatch", r.contains("executeManageBatch")),
                ("captures syncLookup", r.contains("syncLookup")),
                ("warns cannot extract", r.contains("Cannot cleanly extract")),
            ];
            let ok = checks.iter().all(|(_, v)| *v);
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} TS hashLookup:deps - nested + captured vars\n", if ok {"PASS"} else {"FAIL"}));
            for (label, v) in &checks { rpt.push_str(&format!("      {} {}\n", if *v {"+"} else {"X"}, label)); }
            rpt.push('\n');
        }

        // 3d: Rust deps
        {
            total += 1;
            let r = super::analyze_symbol_deps(rust_src, Some("fn"), "process_data", Some("rust")).unwrap();
            let checks: Vec<(&str, bool)> = vec![
                ("needs HashMap", r.contains("HashMap")),
                ("needs AtlsError/types", r.contains("AtlsError") || r.contains("types")),
                ("needs parse_entries", r.contains("parse_entries")),
                ("co-moves serialize_value", r.contains("serialize_value")),
            ];
            let ok = checks.iter().all(|(_, v)| *v);
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} Rust process_data:deps\n", if ok {"PASS"} else {"FAIL"}));
            for (label, v) in &checks { rpt.push_str(&format!("      {} {}\n", if *v {"+"} else {"X"}, label)); }
            rpt.push('\n');
        }

        // 3e: Python deps
        {
            total += 1;
            let r = super::analyze_symbol_deps(py_src, Some("fn"), "process_request", Some("python")).unwrap();
            let checks: Vec<(&str, bool)> = vec![
                ("needs RequestValidator", r.contains("RequestValidator") || r.contains("validators")),
                ("needs transform_data", r.contains("transform_data") || r.contains("transformers")),
                ("co-moves UserProfile", r.contains("UserProfile")),
            ];
            let ok = checks.iter().all(|(_, v)| *v);
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} Python process_request:deps\n", if ok {"PASS"} else {"FAIL"}));
            for (label, v) in &checks { rpt.push_str(&format!("      {} {}\n", if *v {"+"} else {"X"}, label)); }
            rpt.push('\n');
        }

        // ── 3f-3q: Per-language :deps (remaining 12 languages)
        rpt.push_str("    Per-language :deps coverage:\n");
        {
            struct DepCheck { lang: &'static str, content: &'static str, kind: &'static str, name: &'static str, lang_id: &'static str, expect_any: &'static [&'static str] }
            let dep_checks = vec![
                DepCheck { lang: "Go", content: "package svc\n\nimport (\n    \"context\"\n    \"fmt\"\n)\n\ntype Server struct { Port int }\n\nfunc (s *Server) Handle() error {\n    ctx := context.Background()\n    return fmt.Errorf(\"x\")\n}\n",
                    kind: "fn", name: "Handle", lang_id: "go", expect_any: &["Server", "context", "fmt"] },
                DepCheck { lang: "Java", content: "import java.util.List;\nimport com.example.dto.UserDTO;\n\npublic class Svc {\n    public List<UserDTO> findAll() {\n        return null;\n    }\n}\n",
                    kind: "fn", name: "findAll", lang_id: "java", expect_any: &["List", "UserDTO"] },
                DepCheck { lang: "C#", content: "using System;\nusing System.Threading.Tasks;\n\nUserDto CreateDto(string n) {\n    return new UserDto(n);\n}\n",
                    kind: "fn", name: "CreateDto", lang_id: "csharp", expect_any: &["module"] },
                DepCheck { lang: "C++", content: "#include <vector>\n#include <string>\n\nstruct Config { int t; };\n\nstd::vector<Config> merge(const std::vector<Config>& a, const std::vector<Config>& b) {\n    std::vector<Config> r;\n    return r;\n}\n",
                    kind: "fn", name: "merge", lang_id: "cpp", expect_any: &["Config", "vector"] },
                DepCheck { lang: "C", content: "#include <stdio.h>\n\nstruct Point { int x; int y; };\n\nvoid show(struct Point p) {\n    int z = p.x;\n}\n",
                    kind: "fn", name: "show", lang_id: "c", expect_any: &["Point", "module"] },
                DepCheck { lang: "Swift", content: "import Foundation\n\nfunc loadItems() {\n    let x = 1\n}\n",
                    kind: "fn", name: "loadItems", lang_id: "swift", expect_any: &["module"] },
                DepCheck { lang: "Kotlin", content: "import kotlinx.coroutines.flow.Flow\n\ndata class User(val name: String)\n\nfun activeUsers(): Flow<User> {\n    return emptyFlow()\n}\n",
                    kind: "fn", name: "activeUsers", lang_id: "kotlin", expect_any: &["Flow", "User"] },
                DepCheck { lang: "Ruby", content: "require 'json'\n\ndef index\n  data = JSON.parse('{}')\n  data\nend\n",
                    kind: "fn", name: "index", lang_id: "ruby", expect_any: &["module"] },
                DepCheck { lang: "PHP", content: "<?php\nuse App\\Models\\User;\nuse App\\Services\\AuthService;\n\nfunction show(int $id) {\n    $user = User::findOrFail($id);\n    return $user;\n}\n",
                    kind: "fn", name: "show", lang_id: "php", expect_any: &["User"] },
                DepCheck { lang: "Scala", content: "import scala.concurrent.Future\n\ndef fetchData(id: String): Future[Option[String]] = Future {\n    Some(id)\n}\n",
                    kind: "fn", name: "fetchData", lang_id: "scala", expect_any: &["Future"] },
                DepCheck { lang: "Dart", content: "import 'package:flutter/material.dart';\n\nclass VM { final List<String> items = []; }\n\nWidget buildPage(BuildContext ctx) {\n    final vm = VM();\n    return Scaffold();\n}\n",
                    kind: "fn", name: "buildPage", lang_id: "dart", expect_any: &["VM", "module"] },
                DepCheck { lang: "JavaScript", content: "import { createApp } from 'vue';\nconst axios = require('axios');\n\nfunction fetchData() {\n  const app = createApp({});\n  return axios.get('/api');\n}\n",
                    kind: "fn", name: "fetchData", lang_id: "javascript", expect_any: &["createApp", "axios"] },
            ];
            for dc in &dep_checks {
                total += 1;
                match super::analyze_symbol_deps(dc.content, Some(dc.kind), dc.name, Some(dc.lang_id)) {
                    Ok(r) => {
                        let ok = dc.expect_any.iter().any(|e| r.contains(e));
                        if ok { passed += 1; }
                        rpt.push_str(&format!("    {} {:12} :deps({})\n", if ok {"PASS"} else {"FAIL"}, dc.lang, dc.name));
                    }
                    Err(e) => {
                        rpt.push_str(&format!("    FAIL {:12} :deps({}) -> ERR: {}\n", dc.lang, dc.name, e));
                    }
                }
            }
            rpt.push('\n');
        }

        // ── 3r: Import Token Extraction (all formats)
        rpt.push_str("    Import token extraction:\n");
        {
            struct TokCheck { label: &'static str, line: &'static str, expect: &'static str }
            let tok_checks = vec![
                TokCheck { label: "Rust use::{}", line: "use crate::types::{A, B};", expect: "A" },
                TokCheck { label: "Python from..import", line: "from .utils import helper", expect: "helper" },
                TokCheck { label: "TS/JS import{}", line: "import { Foo, Bar } from './x';", expect: "Foo" },
                TokCheck { label: "TS/JS import*as", line: "import * as utils from './u';", expect: "utils" },
                TokCheck { label: "TS/JS default", line: "import React from 'react';", expect: "React" },
                TokCheck { label: "C/C++ #include<>", line: "#include <vector>", expect: "vector" },
                TokCheck { label: "C/C++ #include\"\"", line: "#include \"config.h\"", expect: "config" },
                TokCheck { label: "C# using", line: "using Microsoft.AspNetCore.Mvc;", expect: "Mvc" },
                TokCheck { label: "Java import", line: "import java.util.List;", expect: "List" },
                TokCheck { label: "Kotlin import", line: "import kotlinx.coroutines.flow.Flow", expect: "Flow" },
                TokCheck { label: "Swift import", line: "import Foundation", expect: "Foundation" },
                TokCheck { label: "Scala import", line: "import scala.concurrent.Future", expect: "Future" },
                TokCheck { label: "Go single", line: "import \"net/http\"", expect: "http" },
                TokCheck { label: "Go multi", line: "import ( \"fmt\" \"net/http\" )", expect: "http" },
                TokCheck { label: "Dart package", line: "import 'package:provider/provider.dart';", expect: "provider" },
                TokCheck { label: "PHP use\\", line: "use App\\Models\\User;", expect: "User" },
                TokCheck { label: "PHP use\\{}", line: "use App\\Models\\{User, Post};", expect: "User" },
                TokCheck { label: "Ruby require", line: "require 'json'", expect: "json" },
                TokCheck { label: "Ruby require_rel", line: "require_relative 'user_serializer'", expect: "user_serializer" },
            ];
            for tc in &tok_checks {
                total += 1;
                let tokens = super::extract_import_tokens_local(tc.line);
                let ok = tokens.iter().any(|t| t == tc.expect);
                if ok { passed += 1; }
                rpt.push_str(&format!("    {} {:20} -> {}\n", if ok {"PASS"} else {"FAIL"}, tc.label, tc.expect));
            }
            rpt.push('\n');
        }

        // ── 4. MULTI-LINE IMPORTS ──────────────────────────────────────
        rpt.push_str("  4. Multi-line Import Handling\n");
        rpt.push_str("  ────────────────────────────\n");
        {
            total += 1;
            let content = "import {\n  HashLookup,\n  SetRefLookup,\n  ParsedSetRef,\n} from '../utils/hashResolver';\n\nfunction foo() { HashLookup; }";
            let result = super::apply_shape(content, &crate::hash_resolver::ShapeOp::Imports);
            let ok = result.lines().any(|l| l.contains("HashLookup") && l.contains("SetRefLookup"));
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} TS multi-line import joined\n", if ok {"PASS"} else {"FAIL"}));
        }
        {
            total += 1;
            let content = "from typing import (\n    List,\n    Dict,\n    Optional,\n)\n\ndef foo(): pass";
            let result = super::apply_shape(content, &crate::hash_resolver::ShapeOp::Imports);
            let ok = result.contains("List") && result.contains("Dict") && result.contains("Optional");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} Python multi-line import joined\n", if ok {"PASS"} else {"FAIL"}));
        }
        {
            total += 1;
            let content = "package main\n\nimport (\n    \"fmt\"\n    \"net/http\"\n)\n\nfunc main() {}";
            let imports = super::extract_import_lines(content);
            let joined = imports.join(" ");
            let ok = joined.contains("fmt") && joined.contains("http");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} Go multi-line import ( ) joined\n", if ok {"PASS"} else {"FAIL"}));
        }
        rpt.push('\n');

        // ── 5. WILDCARD / NAMESPACE IMPORTS ────────────────────────────
        rpt.push_str("  5. Wildcard/Namespace Import Detection\n");
        rpt.push_str("  ──────────────────────────────────────\n");
        {
            total += 1;
            let content = "import * as helpers from './helpers';\n\nfunction foo(): void {\n  helpers.doSomething();\n}";
            let r = super::analyze_symbol_deps(content, Some("fn"), "foo", Some("typescript")).unwrap();
            let ok = r.contains("helpers");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} import * as helpers detected via :deps\n", if ok {"PASS"} else {"FAIL"}));
        }
        rpt.push('\n');

        // ── 6. import type PRESERVATION ────────────────────────────────
        rpt.push_str("  6. import type Preservation\n");
        rpt.push_str("  ──────────────────────────\n");
        {
            total += 1;
            let content = "import type { HashLookup } from '../utils/hashResolver';\nimport { invoke } from '@tauri-apps/api/core';\n\nfunction foo(h: HashLookup) { invoke('cmd'); }";
            let result = super::apply_shape(content, &crate::hash_resolver::ShapeOp::Imports);
            let ok = result.contains("import type");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} import type keyword preserved\n", if ok {"PASS"} else {"FAIL"}));
        }
        rpt.push('\n');

        // ── 7. SCOPE NESTING ───────────────────────────────────────────
        rpt.push_str("  7. Scope Nesting Detection\n");
        rpt.push_str("  ─────────────────────────\n");
        {
            total += 1;
            let content = "function topLevel(): void {\n  console.log('hello');\n}";
            let r = super::analyze_symbol_deps(content, Some("fn"), "topLevel", Some("typescript")).unwrap();
            let ok = r.contains("module") && !r.contains("nested");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} top-level -> scope=module\n", if ok {"PASS"} else {"FAIL"}));
        }
        {
            total += 1;
            let content = "function outer(): void {\n  const x = 1;\n  function inner(): void {\n    console.log(x);\n  }\n  inner();\n}";
            let r = super::analyze_symbol_deps(content, Some("fn"), "inner", Some("typescript")).unwrap();
            let ok = r.contains("nested") && r.contains("outer");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} nested -> scope=nested, parent=outer\n", if ok {"PASS"} else {"FAIL"}));
        }
        {
            total += 1;
            let content = "function l1(): void {\n  function l2(): void {\n    function l3(): void {\n      console.log('deep');\n    }\n    l3();\n  }\n  l2();\n}";
            let r = super::analyze_symbol_deps(content, Some("fn"), "l3", Some("typescript")).unwrap();
            let ok = r.contains("nested") && r.contains("l2");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} deep nest -> immediate parent l2\n", if ok {"PASS"} else {"FAIL"}));
        }
        rpt.push('\n');

        // ── 8. CO-MOVE: SHARED vs EXCLUSIVE ────────────────────────────
        rpt.push_str("  8. Co-Move: Shared vs Exclusive\n");
        rpt.push_str("  ───────────────────────────────\n");
        {
            total += 1;
            let content = "type Config = { timeout: number };\n\nfunction useConfig(c: Config): void { console.log(c.timeout); }\n\nfunction other(): void { console.log('no config'); }";
            let r = super::analyze_symbol_deps(content, Some("fn"), "useConfig", Some("typescript")).unwrap();
            let ok = r.contains("Config") && r.contains("exclusive");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} exclusive co-move (Config only used by useConfig)\n", if ok {"PASS"} else {"FAIL"}));
        }
        {
            total += 1;
            let content = "type Config = { timeout: number };\n\nfunction useConfig(c: Config): void { console.log(c.timeout); }\n\nfunction validateConfig(c: Config): boolean { return c.timeout > 0; }";
            let r = super::analyze_symbol_deps(content, Some("fn"), "useConfig", Some("typescript")).unwrap();
            let ok = r.contains("Config") && r.contains("shared");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} shared co-move (Config used by both)\n", if ok {"PASS"} else {"FAIL"}));
        }
        rpt.push('\n');

        // ── 9. :refs VIA SHAPE DISPATCH ────────────────────────────────
        rpt.push_str("  9. :refs via ShapeOp::Refs Dispatch\n");
        rpt.push_str("  ───────────────────────────────────\n");
        {
            total += 1;
            let content = "function foo(bar: Baz): Qux { return transform(bar); }";
            let result = super::apply_shape(content, &crate::hash_resolver::ShapeOp::Refs);
            let ok = result.contains("Baz") && result.contains("Qux") && result.contains("transform")
                && !result.contains("function") && !result.contains("return");
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} ShapeOp::Refs dispatches correctly\n", if ok {"PASS"} else {"FAIL"}));
        }
        rpt.push('\n');

        // ── 10. AISERVICE.TS REAL-WORLD SCENARIO ───────────────────────
        rpt.push_str("  10. Real-World: aiService.ts Extraction Scenario\n");
        rpt.push_str("  ────────────────────────────────────────────────\n");
        {
            total += 1;
            let r = super::analyze_symbol_deps(ts_src, Some("fn"), "expandFilePathRefs", Some("typescript")).unwrap();
            let co_strip = r.contains("stripGitLabelPrefix");
            let import_hash = r.contains("hashResolver") || r.contains("HashLookup");
            let import_invoke = r.contains("invoke");
            let import_store = r.contains("useAppStore");
            let no_unused = !r.contains("unusedFunction");
            let ok = co_strip && import_hash && import_invoke && import_store && no_unused;
            if ok { passed += 1; }
            rpt.push_str(&format!("    {} Full extraction scenario:\n", if ok {"PASS"} else {"FAIL"}));
            rpt.push_str(&format!("      {} co-moves stripGitLabelPrefix\n", if co_strip {"+"} else {"X"}));
            rpt.push_str(&format!("      {} detects hashResolver imports\n", if import_hash {"+"} else {"X"}));
            rpt.push_str(&format!("      {} detects invoke import\n", if import_invoke {"+"} else {"X"}));
            rpt.push_str(&format!("      {} detects useAppStore import\n", if import_store {"+"} else {"X"}));
            rpt.push_str(&format!("      {} does NOT include unusedFunction\n", if no_unused {"+"} else {"X"}));
        }
        rpt.push('\n');

        // ── SUMMARY ────────────────────────────────────────────────────
        rpt.push_str("================================================================\n");
        let status = if passed == total { "ALL CLEAR" } else { "FAILURES DETECTED" };
        rpt.push_str(&format!("  RESULT: {}/{} checks passed  -  {}\n", passed, total, status));
        rpt.push_str("================================================================\n");

        rpt.push_str("\n  Capabilities Verified:\n");
        rpt.push_str("    [1]  Comment/string neutralization (5 cases)\n");
        rpt.push_str("    [2]  :refs identifier scanning (13 languages)\n");
        rpt.push_str("    [3]  :deps dependency analysis (15 languages)\n");
        rpt.push_str("    [3+] Import token extraction (19 formats)\n");
        rpt.push_str("    [4]  Multi-line import handling (TS + Python + Go)\n");
        rpt.push_str("    [5]  Wildcard/namespace imports (import * as)\n");
        rpt.push_str("    [6]  import type preservation\n");
        rpt.push_str("    [7]  Scope nesting detection (module/nested/deep)\n");
        rpt.push_str("    [8]  Co-move: shared vs exclusive\n");
        rpt.push_str("    [9]  ShapeOp::Refs dispatch\n");
        rpt.push_str("   [10]  Real-world aiService.ts scenario\n\n");

        println!("{}", rpt);

        assert_eq!(passed, total, "{}/{} checks passed", passed, total);
    }

    #[test]
    fn test_fn_symbol_on_large_file_with_prefilter() {
        // Generates a large file (10K lines) where the target function is near the end.
        // Verifies the pre-filter optimization doesn't break correctness.
        let mut lines = Vec::with_capacity(10_100);
        for i in 0..10_000 {
            lines.push(format!("const placeholder_{} = {};", i, i));
        }
        lines.push("export function targetFunction(x: number): number {".to_string());
        lines.push("  return x * 2;".to_string());
        lines.push("}".to_string());
        let content = lines.join("\n");

        let result = resolve_symbol_anchor(&content, Some("fn"), "targetFunction");
        assert!(result.is_ok(), "should find function in large file: {:?}", result.err());
        assert!(result.unwrap().contains("targetFunction"));
    }

    #[test]
    fn test_interface_symbol_on_large_file_with_prefilter() {
        let mut lines = Vec::with_capacity(10_100);
        for i in 0..10_000 {
            lines.push(format!("const filler_{} = {};", i, i));
        }
        lines.push("export interface MyConfig {".to_string());
        lines.push("  name: string;".to_string());
        lines.push("  value: number;".to_string());
        lines.push("}".to_string());
        let content = lines.join("\n");

        let result = resolve_symbol_anchor(&content, Some("interface"), "MyConfig");
        assert!(result.is_ok(), "should find interface in large file: {:?}", result.err());
        assert!(result.unwrap().contains("MyConfig"));
    }
}