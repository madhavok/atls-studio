//! UHPP regex-based symbol extraction.
//!
//! Replaces tree-sitter `SymbolExtractor` with language-agnostic regex matching
//! using the UHPP 5-tier cascade. Produces `ParsedSymbol` records suitable for
//! direct insertion into the index.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use crate::symbol::{ParsedSymbol, SymbolKind, SymbolMetadata, SymbolParameter};

// ---------------------------------------------------------------------------
// UHPP symbol kind patterns — single source of truth
// ---------------------------------------------------------------------------

/// Canonical UHPP symbol kind -> regex mapping (with capture group for the name).
pub const UHPP_SYMBOL_KINDS: &[(&str, &str)] = &[
    ("fn",          r"(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:const\s+)?(?:async\s+)?(?:extern\s+\S+\s+)?(?:fn|fun|function|def|func(?:\s+\([^)]*\))?|method)\s+(?:self\.)?(\w+)"),
    ("cls",         r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:abstract\s+)?\bclass\s+(\w+)"),
    ("struct",      r"(?:pub(?:\([^)]*\))?\s+)?\bstruct\s+(\w+)"),
    ("trait",       r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:\btrait|\binterface)\s+(\w+)"),
    ("interface",   r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:\btrait|\binterface)\s+(\w+)"),
    ("protocol",    r"(?:public\s+|open\s+|internal\s+|fileprivate\s+|private\s+)?(?:@objc\s+)?\bprotocol\s+(\w+)"),
    ("enum",        r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?\benum\s+(\w+)"),
    ("record",      r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|sealed\s+)?(?:data\s+)?\brecord\s+(\w+)"),
    ("extension",   r"(?:public\s+|open\s+|internal\s+|fileprivate\s+|private\s+)?\bextension\s+(\w+)"),
    ("mixin",       r"\bmixin\s+(\w+)"),
    ("impl",        r"(?:pub(?:\([^)]*\))?\s+)?impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)"),
    ("type",        r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:\btype|\btypedef)\s+(\w+)"),
    ("const",       r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:const|static|final)\s+(?:\w+\s+)?(\w+)"),
    ("static",      r"(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:const|static|final)\s+(?:\w+\s+)?(\w+)"),
    ("mod",         r"(?:pub(?:\([^)]*\))?\s+)?(?:mod|module|namespace)\s+(\w+)"),
    ("macro",       r"(?:pub(?:\([^)]*\))?\s+)?(?:macro_rules!\s+|\bmacro\s+|#\s*define\s+)(\w+)"),
    ("ctor",        r"(?:public|protected|private|internal)?\s*(?:constructor|new)\s*(\()"),
    ("property",    r"(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:readonly\s+)?(?:get|set)\s+(\w+)"),
    ("field",       r"(?:public\s+|private\s+|protected\s+|internal\s+)?(?:readonly\s+|static\s+)?(?:\w+\s+)+(\w+)\s*[;=]"),
    ("enum_member", r"^\s*(\w+)\s*[({,=]"),
    ("operator",    r"\boperator\s*(\S+)\s*\("),
    ("event",       r"\bevent\s+\w+\s+(\w+)"),
    ("object",      r"(?:companion\s+)?\bobject\s+(\w+)"),
    ("actor",       r"(?:public\s+|open\s+|internal\s+|fileprivate\s+|private\s+)?\bactor\s+(\w+)"),
    ("union",       r"\bunion\s+(\w+)"),
];

/// Kinds that are too noisy for full-file scanning and must be restricted
/// to specific parent scopes (e.g. `enum_member` only inside `enum` blocks,
/// `field` only inside class/struct blocks).
const SCOPED_KINDS: &[&str] = &["enum_member", "field"];

/// Kinds that produce duplicate patterns (`trait` and `interface` share a regex,
/// `const` and `static` share a regex). We skip the alias during the primary
/// scan and let the canonical kind win.
const SKIP_ALIAS_KINDS: &[&str] = &["interface", "static"];

// ---------------------------------------------------------------------------
// Compiled regex cache
// ---------------------------------------------------------------------------

struct CompiledPatterns {
    patterns: Vec<(&'static str, Regex)>,
}

fn compiled_patterns() -> &'static CompiledPatterns {
    static CACHE: OnceLock<CompiledPatterns> = OnceLock::new();
    CACHE.get_or_init(|| {
        let patterns = UHPP_SYMBOL_KINDS
            .iter()
            .filter_map(|(kind, pat)| {
                Regex::new(pat).ok().map(|re| (*kind, re))
            })
            .collect();
        CompiledPatterns { patterns }
    })
}

// ---------------------------------------------------------------------------
// Block-end detection (string/comment-aware brace tracking)
// ---------------------------------------------------------------------------

fn is_ruby_like_block(trimmed: &str) -> bool {
    let first_word = trimmed.split_whitespace().next().unwrap_or("");
    matches!(first_word, "def" | "class" | "module" | "do" | "begin" | "if" | "unless" | "case")
        && !trimmed.contains('{')
        && !trimmed.ends_with(':')
}

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

/// Find the end of a code block starting at `start`.
/// Handles braces (C-family), indentation (Python), and keyword blocks (Ruby/Elixir).
pub fn find_block_end(lines: &[&str], start: usize, total: usize) -> usize {
    let start_trimmed = lines[start].trim();
    if start_trimmed.ends_with(';') && !start_trimmed.contains('{') {
        return start;
    }
    if is_ruby_like_block(start_trimmed) {
        return find_keyword_block_end(lines, start, total);
    }

    let indent_only = start_trimmed.ends_with(':');
    let mut depth = 0i32;
    let mut found_open = false;
    let mut in_line_comment;
    let mut in_block_comment = false;
    let mut in_string: Option<char> = None;
    let mut in_raw_string: Option<usize> = None;

    let mut i = start;
    while i < total {
        in_line_comment = false;
        let chars: Vec<char> = lines[i].chars().collect();
        let len = chars.len();
        let mut j = 0;
        while j < len {
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
            if in_line_comment { j += 1; continue; }
            if let Some(quote) = in_string {
                if chars[j] == '\\' && j + 1 < len { j += 2; continue; }
                if chars[j] == quote { in_string = None; }
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
            if chars[j] == 'r' && j + 1 < len && (chars[j + 1] == '#' || chars[j + 1] == '"') {
                let mut hashes = 0usize;
                let mut k = j + 1;
                while k < len && chars[k] == '#' { hashes += 1; k += 1; }
                if k < len && chars[k] == '"' {
                    k += 1;
                    let mut closed = false;
                    while k < len {
                        if chars[k] == '"' {
                            let mut t = 0;
                            while t < hashes && k + 1 + t < len && chars[k + 1 + t] == '#' { t += 1; }
                            if t == hashes {
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
                    '}' if found_open => {
                        depth -= 1;
                        if depth <= 0 { return i; }
                    }
                    _ => {}
                }
            }
            j += 1;
        }

        if !found_open && i > start && in_raw_string.is_none() {
            let current_indent = lines[i].len() - lines[i].trim_start().len();
            let start_indent = lines[start].len() - lines[start].trim_start().len();
            if current_indent <= start_indent && !lines[i].trim().is_empty() {
                return i.saturating_sub(1).max(start);
            }
        }
        i += 1;
    }

    (start..total).rev()
        .find(|&i| !lines[i].trim().is_empty())
        .unwrap_or(total.saturating_sub(1))
}

/// Walk backward from `match_line` to include contiguous attribute/decorator lines.
///
/// Also absorbs a preceding `/** ... */` JSDoc block when present — the block
/// closes with `*/` on some line `start - 1`, and everything from the matching
/// `/**` opener is considered part of the symbol's attribution.
pub fn expand_to_attributes(lines: &[&str], match_line: usize) -> usize {
    let mut start = match_line;
    loop {
        if start == 0 { break; }
        let prev = lines[start - 1].trim();
        if prev.starts_with('@')
            || prev.starts_with("#[")
            || prev.starts_with("///") || prev.starts_with("//!")
            || prev.starts_with("template")
            || prev.starts_with("__attribute__")
            || prev.starts_with("[[")
            || (prev.starts_with('[') && !prev.starts_with("[//"))
        {
            start -= 1;
            continue;
        }
        // TS/JS / Java / C-family block-comment doc: walk back over `/** ... */`
        // (or plain `/* ... */`) so the docblock belongs to the symbol.
        if prev.ends_with("*/") {
            let mut j = start.saturating_sub(1);
            let mut found_open = false;
            loop {
                let t = lines[j].trim_start();
                if t.starts_with("/*") {
                    found_open = true;
                    break;
                }
                if j == 0 { break; }
                j -= 1;
            }
            if found_open {
                start = j;
                continue;
            }
        }
        break;
    }
    start
}

/// Returns a per-line mask where `mask[i]` is true when line `i` sits inside
/// a `/* ... */` block comment (including `/**` JSDoc variants) — used to
/// filter out spurious symbol matches that land inside doc text like
/// `* this function popValidEvictedOldest does X`.
fn compute_block_comment_mask(lines: &[&str]) -> Vec<bool> {
    let mut mask = vec![false; lines.len()];
    let mut in_block = false;
    for (i, line) in lines.iter().enumerate() {
        // Walk the line char-by-char; a match inside a block comment taints
        // this line even if the block closes mid-line.
        let line_was_in_block_at_start = in_block;
        let bytes = line.as_bytes();
        let mut j = 0;
        let mut touched_code = !line_was_in_block_at_start;
        while j < bytes.len() {
            if in_block {
                if j + 1 < bytes.len() && bytes[j] == b'*' && bytes[j + 1] == b'/' {
                    in_block = false;
                    j += 2;
                    continue;
                }
                j += 1;
            } else {
                if j + 1 < bytes.len() && bytes[j] == b'/' && bytes[j + 1] == b'*' {
                    in_block = true;
                    j += 2;
                    touched_code = false;
                    continue;
                }
                // `//` line comment: rest of line is comment but does not
                // carry state; break out.
                if j + 1 < bytes.len() && bytes[j] == b'/' && bytes[j + 1] == b'/' {
                    break;
                }
                j += 1;
            }
        }
        // Line is "comment-only" when it started inside a block AND never
        // transitioned to code, OR the whole line was consumed by a block
        // comment (it opened and never closed cleanly before EOL).
        if line_was_in_block_at_start && !touched_code {
            mask[i] = true;
        } else if in_block && !line_was_in_block_at_start {
            // Opened a block this line; check if any code precedes the `/*`.
            // Conservative: only mark if the line's trimmed prefix starts
            // with `/*` — otherwise the line has real code followed by a
            // trailing block comment, which we do want to scan.
            let trimmed = line.trim_start();
            if trimmed.starts_with("/*") {
                mask[i] = true;
            }
        }
    }
    mask
}

// ---------------------------------------------------------------------------
// Language-aware secondary tiers
// ---------------------------------------------------------------------------

fn is_cfamily_lang(lang: &str) -> bool {
    matches!(lang, "c" | "cpp" | "java" | "csharp" | "go" | "kotlin" | "swift" | "dart" | "scala")
}

/// C-family return-type function declarations (Tier 2).
fn try_cfamily_fn_lines(lines: &[&str], total: usize) -> Vec<(String, usize)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let name_re = RE.get_or_init(|| {
        Regex::new(r"(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|final|inline|extern|const|volatile|async|synchronized|default)\s+)*[\w:*&<>\[\]?,]+(?:\s+[\w:*&<>\[\]?,]+)*\s+(\w+)\s*(?:<[^>]*>\s*)?\(").unwrap()
    });
    static REJECT_RE: OnceLock<Regex> = OnceLock::new();
    let reject_re = REJECT_RE.get_or_init(|| {
        Regex::new(r"(?:\.|->|[=(,])\s*\w+\s*(?:<[^>]*>\s*)?\(").unwrap()
    });
    static KW_RE: OnceLock<Regex> = OnceLock::new();
    let kw_re = KW_RE.get_or_init(|| {
        Regex::new(r"\b(?:fn|fun|function|def|func|class|struct|interface|trait|enum|type|impl|macro_rules!|protocol|record|extension|mixin|object|actor|union)\s").unwrap()
    });

    let mut results = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        if kw_re.is_match(trimmed) { continue; }
        if let Some(caps) = name_re.captures(trimmed) {
            if reject_re.is_match(trimmed) { continue; }
            if let Some(m) = caps.get(1) {
                let name = m.as_str().to_string();
                if matches!(name.as_str(), "if" | "for" | "while" | "switch" | "catch" | "return" | "new" | "throw" | "sizeof" | "typeof" | "alignof") {
                    continue;
                }
                let block_end = find_block_end(lines, i, total);
                if block_end > i || trimmed.contains('{') {
                    results.push((name, i));
                }
            }
        }
    }
    results
}

/// JS/TS class method shorthand (Tier 1.5a).
fn try_class_method_lines(lines: &[&str], total: usize) -> Vec<(String, usize)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^\s+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(?:#)?(\w+)\s*(?:<[^>]*>\s*)?\(").unwrap()
    });
    let mut results = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(caps) = re.captures(line) {
            if let Some(m) = caps.get(1) {
                let name = m.as_str().to_string();
                if matches!(name.as_str(), "if" | "for" | "while" | "switch" | "catch" | "return" | "new") {
                    continue;
                }
                let trimmed = line.trim();
                if trimmed.contains('=') && trimmed.find('=') < trimmed.find(&*name) { continue; }
                let block_end = find_block_end(lines, i, total);
                if block_end > i || trimmed.contains('{') {
                    results.push((name, i));
                }
            }
        }
    }
    results
}

/// JS/TS arrow functions and const-bound functions (Tier 1.5b).
fn try_variable_bound_fn_lines(lines: &[&str], total: usize) -> Vec<(String, usize)> {
    static ARROW_RE: OnceLock<Regex> = OnceLock::new();
    let arrow_re = ARROW_RE.get_or_init(|| {
        Regex::new(r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*(?::\s*[^=\n]*)?\s*=>").unwrap()
    });
    static ASSIGNED_RE: OnceLock<Regex> = OnceLock::new();
    let assigned_fn_re = ASSIGNED_RE.get_or_init(|| {
        Regex::new(r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function").unwrap()
    });

    let mut results = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let name = if let Some(caps) = arrow_re.captures(line) {
            caps.get(1).map(|m| m.as_str().to_string())
        } else if let Some(caps) = assigned_fn_re.captures(line) {
            caps.get(1).map(|m| m.as_str().to_string())
        } else {
            None
        };
        if let Some(name) = name {
            let block_end = find_block_end(lines, i, total);
            if block_end > i || line.contains('{') {
                results.push((name, i));
            }
        }
    }
    results
}

/// JS/TS object literal method shorthand (Tier 1.5c).
/// Matches `name(params) {` patterns that appear inside object literals or
/// similar contexts but are NOT already caught by Tier 1 keywords or Tier 1.5a
/// class methods. Covers cases like `{ of(x) {}, set(k, v) {} }`.
fn try_object_method_lines(lines: &[&str], total: usize) -> Vec<(String, usize)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^\s+(?:async\s+)?(\w+)\s*(?:<[^>]*>\s*)?\([^)]*\)\s*(?::\s*[^{]*?)?\{").unwrap()
    });

    static KW_RE: OnceLock<Regex> = OnceLock::new();
    let kw_re = KW_RE.get_or_init(|| {
        Regex::new(r"\b(?:fn|fun|function|def|func|class|struct|interface|trait|enum|type|impl|macro_rules!|protocol|record|extension|mixin|object|actor|union)\s").unwrap()
    });

    let reject_names: &[&str] = &[
        "if", "for", "while", "switch", "catch", "return", "new", "throw",
        "else", "do", "try", "finally", "typeof", "instanceof", "delete", "void",
    ];

    let mut results = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        if kw_re.is_match(trimmed) { continue; }
        // Skip lines that look like variable declarations with `=` before the name
        if trimmed.contains('=') {
            if let Some(eq_pos) = trimmed.find('=') {
                if let Some(paren_pos) = trimmed.find('(') {
                    if eq_pos < paren_pos { continue; }
                }
            }
        }

        if let Some(caps) = re.captures(line) {
            if let Some(m) = caps.get(1) {
                let name = m.as_str();
                if reject_names.contains(&name) { continue; }
                let block_end = find_block_end(lines, i, total);
                if block_end > i || trimmed.contains('{') {
                    results.push((name.to_string(), i));
                }
            }
        }
    }
    results
}

/// JS/TS object-literal arrow-property methods (Tier 1.5d).
///
/// Matches `name: (args) => {` or `name: (args) => identifier(` patterns at
/// any indent level, which is how Zustand store actions and React callback
/// properties are commonly declared. Intentionally does not match type
/// annotations (`foo: (n: number) => void`) — those end the arrow with a
/// bare type keyword, not executable code.
fn try_object_arrow_property_lines(lines: &[&str]) -> Vec<(String, usize)> {
    // Capture: indent + name + `:` + optional `async` + `(...)` + `=>` + `{` or identifier+`(`
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"^\s+(\w+)\s*:\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=\n]*)?\s*=>\s*(?:\{|[A-Za-z_$][\w$]*\s*\()"
        ).unwrap()
    });

    // Reject identifiers that are reserved words or known type-only keywords —
    // these never mean "method here" even on a match.
    let reject_names: &[&str] = &[
        "if", "for", "while", "switch", "catch", "return", "new", "throw",
        "else", "do", "try", "finally", "typeof", "instanceof", "delete", "void",
        "type", "interface",
    ];

    let mut results = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        if let Some(caps) = re.captures(line) {
            if let Some(m) = caps.get(1) {
                let name = m.as_str();
                if reject_names.contains(&name) { continue; }
                results.push((name.to_string(), i));
            }
        }
    }
    results
}

/// Go `type Name struct/interface` declarations.
fn try_go_type_lines(lines: &[&str], total: usize) -> Vec<(String, usize, &'static str)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^\s*type\s+(\w+)\s+(struct|interface)\b").unwrap()
    });
    let mut results = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(caps) = re.captures(line) {
            if let (Some(name_m), Some(type_m)) = (caps.get(1), caps.get(2)) {
                let block_end = find_block_end(lines, i, total);
                if block_end >= i {
                    let kind = match type_m.as_str() {
                        "struct" => "struct",
                        "interface" => "interface",
                        _ => "type",
                    };
                    results.push((name_m.as_str().to_string(), i, kind));
                }
            }
        }
    }
    results
}

// ---------------------------------------------------------------------------
// Core extraction function
// ---------------------------------------------------------------------------

/// Best-effort `return_type` / `parameters` from a single declaration line (explicit types).
fn enrich_metadata_from_signature(lang: &str, sig: Option<&String>, md: &mut SymbolMetadata) {
    let Some(s) = sig else {
        return;
    };
    let t = s.trim();
    if t.is_empty() {
        return;
    }
    let l = lang.to_lowercase();

    if let Some(open) = t.find('(') {
        if let Some(rel_close) = t[open + 1..].find(')') {
            let close = open + 1 + rel_close;
            let inside = t[open + 1..close].trim();
            if !inside.is_empty() && inside != "self" && inside != "mut self" {
                if l == "rust"
                    || l.is_empty() && t.contains("fn ")
                    || matches!(l.as_str(), "typescript" | "javascript" | "ts" | "js")
                {
                    let mut params: Vec<SymbolParameter> = Vec::new();
                    for part in split_top_level_commas(inside) {
                        let part = part.trim();
                        if part.is_empty() {
                            continue;
                        }
                        if let Some(c) = part.rfind(':') {
                            let name = part[..c]
                                .trim()
                                .trim_start_matches('&')
                                .trim_start_matches("mut ")
                                .trim()
                                .to_string();
                            let ty = part[c + 1..].trim().to_string();
                            if !name.is_empty() && !ty.is_empty() {
                                params.push(SymbolParameter {
                                    name,
                                    param_type: Some(ty),
                                    optional: None,
                                    default_value: None,
                                });
                            }
                        }
                    }
                    if !params.is_empty() {
                        md.parameters = Some(params);
                    }
                }
            }
        }
    }

    if l == "rust" || (l.is_empty() && t.contains("fn ")) {
        if let Some(pos) = t.rfind("->") {
            let mut rt = t[pos + 2..].trim().to_string();
            if let Some(b) = rt.find('{') {
                rt = rt[..b].trim().to_string();
            }
            if !rt.is_empty() {
                md.return_type = Some(rt);
            }
        }
    } else if matches!(
        l.as_str(),
        "typescript" | "javascript" | "ts" | "js"
    ) || (l.is_empty() && (t.contains("function") || t.contains("=>")))
    {
        if let Some(pos) = t.rfind("):") {
            let after = t[pos + 2..].trim();
            let mut rt = after                .split('{')
                .next()
                .unwrap_or(after)
                .split("=>")
                .next()
                .unwrap_or(after)
                .trim()
                .to_string();
            if rt.ends_with(';') {
                rt.pop();
                rt = rt.trim().to_string();
            }
            if !rt.is_empty() && !rt.starts_with('(') {
                md.return_type = Some(rt);
            }
        }
    }
}

/// Split on commas not inside nested `(...)`, `[...]`, `{...}` (best-effort).
fn split_top_level_commas(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut depth = 0i32;
    let mut bracket = 0i32;
    let mut brace = 0i32;
    for (i, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            '[' => bracket += 1,
            ']' => bracket -= 1,
            '{' => brace += 1,
            '}' => brace -= 1,
            ',' if depth == 0 && bracket == 0 && brace == 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

/// Extract all symbols from source content using UHPP regex patterns.
///
/// This replaces `SymbolExtractor::extract_symbols` (tree-sitter based).
/// The `lang` parameter enables language-aware secondary tiers (C-family
/// return-type, Go type decls, JS/TS arrow functions & class methods).
pub fn uhpp_extract_symbols(content: &str, lang: Option<&str>) -> Vec<ParsedSymbol> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    if total == 0 {
        return Vec::new();
    }

    // (line, name) -> (kind, attr_start) — dedup key, keep most specific kind
    let mut seen: HashMap<(usize, String), (&str, usize)> = HashMap::new();
    let compiled = compiled_patterns();
    let lang_str = lang.unwrap_or("");
    // Pre-compute block-comment mask so all tiers skip matches inside
    // `/* ... */` / JSDoc blocks (e.g. `* this function popValidEvictedOldest …`).
    let comment_mask = compute_block_comment_mask(&lines);

    // --- Tier 1: keyword regex scan ---
    for (kind, re) in &compiled.patterns {
        if SKIP_ALIAS_KINDS.contains(kind) { continue; }
        if SCOPED_KINDS.contains(kind) { continue; }

        for (i, line) in lines.iter().enumerate() {
            if comment_mask[i] { continue; }
            if let Some(caps) = re.captures(line) {
                let name = if *kind == "ctor" {
                    "constructor".to_string()
                } else if let Some(m) = caps.get(1) {
                    m.as_str().to_string()
                } else {
                    continue;
                };

                let key = (i, name.clone());
                let existing_specificity = seen.get(&key).map(|(k, _)| kind_specificity(k)).unwrap_or(0);
                let new_specificity = kind_specificity(kind);
                if new_specificity > existing_specificity {
                    let attr_start = expand_to_attributes(&lines, i);
                    seen.insert(key, (kind, attr_start));
                }
            }
        }
    }

    // --- Tier 1.5a: JS/TS class method shorthand ---
    if matches!(lang_str, "typescript" | "javascript" | "ts" | "js" | "") {
        for (name, line_idx) in try_class_method_lines(&lines, total) {
            if comment_mask[line_idx] { continue; }
            let key = (line_idx, name);
            seen.entry(key).or_insert_with_key(|_| {
                let attr_start = expand_to_attributes(&lines, line_idx);
                ("fn", attr_start)
            });
        }
    }

    // --- Tier 1.5b: variable-bound functions (arrow/assigned) ---
    if matches!(lang_str, "typescript" | "javascript" | "ts" | "js" | "") {
        for (name, line_idx) in try_variable_bound_fn_lines(&lines, total) {
            if comment_mask[line_idx] { continue; }
            let key = (line_idx, name);
            seen.entry(key).or_insert_with_key(|_| {
                let attr_start = expand_to_attributes(&lines, line_idx);
                ("fn", attr_start)
            });
        }
    }

    // --- Tier 1.5c: object literal method shorthand ---
    if matches!(lang_str, "typescript" | "javascript" | "ts" | "js" | "") {
        for (name, line_idx) in try_object_method_lines(&lines, total) {
            if comment_mask[line_idx] { continue; }
            let key = (line_idx, name);
            seen.entry(key).or_insert_with_key(|_| {
                let attr_start = expand_to_attributes(&lines, line_idx);
                ("fn", attr_start)
            });
        }
    }

    // --- Tier 1.5d: object literal arrow-property methods ---
    //
    // Catches Zustand store actions and similar patterns:
    //   `addInputCompressionSavings: (tokensSaved) => set(...)`
    //   `handleClick: async (e) => { ... }`
    //
    // These were invisible to the symbol index, which is why
    // `sy addInputCompressionSavings` returned 0 hits during the A/B
    // investigation. Distinguished from type-annotation shapes
    // (`foo: (n: number) => void`) by requiring the arrow to be followed by
    // executable code (`{` or `identifier(`), never by a bare type keyword.
    if matches!(lang_str, "typescript" | "javascript" | "ts" | "js" | "") {
        for (name, line_idx) in try_object_arrow_property_lines(&lines) {
            if comment_mask[line_idx] { continue; }
            let key = (line_idx, name);
            seen.entry(key).or_insert_with_key(|_| {
                let attr_start = expand_to_attributes(&lines, line_idx);
                ("fn", attr_start)
            });
        }
    }

    // --- Tier 2: C-family return-type ---
    if is_cfamily_lang(lang_str) || lang_str.is_empty() {
        for (name, line_idx) in try_cfamily_fn_lines(&lines, total) {
            if comment_mask[line_idx] { continue; }
            let key = (line_idx, name);
            seen.entry(key).or_insert_with_key(|_| {
                let attr_start = expand_to_attributes(&lines, line_idx);
                ("fn", attr_start)
            });
        }
    }

    // --- Tier 2+: Go type declarations ---
    if matches!(lang_str, "go" | "golang" | "") {
        for (name, line_idx, go_kind) in try_go_type_lines(&lines, total) {
            if comment_mask[line_idx] { continue; }
            let key = (line_idx, name);
            seen.entry(key).or_insert_with_key(|_| {
                let attr_start = expand_to_attributes(&lines, line_idx);
                (go_kind, attr_start)
            });
        }
    }

    // --- Scoped kinds: enum_member inside enum blocks, field inside class/struct ---
    let primary_snapshot = seen.clone();
    extract_scoped_members(&lines, total, &primary_snapshot, &mut seen);

    // Enclosing scopes (innermost parent wins): class/struct/enum/impl/mod/etc. blocks
    let mut containers: Vec<(u32, u32, String)> = Vec::new();
    for ((line_idx, name), (kind, attr_start)) in &seen {
        if is_scope_container_kind(kind) {
            let end = find_block_end(&lines, *line_idx, total);
            let start_1 = *attr_start as u32 + 1;
            let end_1 = end as u32 + 1;
            containers.push((start_1, end_1, name.clone()));
        }
    }

    // --- Build ParsedSymbol records ---
    let mut symbols: Vec<ParsedSymbol> = Vec::with_capacity(seen.len());
    for ((line_idx, name), (kind, attr_start)) in &seen {
        let end_line = find_block_end(&lines, *line_idx, total);
        let signature = lines.get(*line_idx).map(|l| l.trim().to_string());
        let body_preview = build_body_preview(&lines, *line_idx, end_line);
        let sym_line = *attr_start as u32 + 1;
        let parent_symbol = innermost_parent_for_line(sym_line, name, &containers);

        let mut metadata = SymbolMetadata {
            parameters: None,
            return_type: None,
            visibility: None,
            modifiers: None,
            parent_symbol,
            extends: None,
            implements: None,
        };
        enrich_metadata_from_signature(lang_str, signature.as_ref(), &mut metadata);

        symbols.push(ParsedSymbol {
            name: name.clone(),
            kind: SymbolKind::from_uhpp_kind(kind),
            line: sym_line, // 1-based
            end_line: Some(end_line as u32 + 1),
            scope_id: None,
            signature,
            complexity: None,
            body_preview: Some(body_preview),
            metadata,
        });
    }

    symbols.sort_by_key(|s| s.line);
    symbols
}

// ---------------------------------------------------------------------------
// Scoped member extraction (enum_member, field)
// ---------------------------------------------------------------------------

fn is_scope_container_kind(kind: &str) -> bool {
    matches!(
        kind,
        "cls" | "struct" | "interface" | "trait" | "enum" | "impl" | "mod" | "protocol"
            | "record" | "actor" | "object" | "extension" | "mixin" | "union"
    )
}

/// Smallest enclosing container for this 1-based line (by declaration line).
fn innermost_parent_for_line(
    line_1based: u32,
    symbol_name: &str,
    containers: &[(u32, u32, String)],
) -> Option<String> {
    let mut best: Option<(u32, String)> = None;
    for (start, end, pname) in containers {
        if *start <= line_1based && line_1based <= *end && pname.as_str() != symbol_name {
            let replace = match &best {
                None => true,
                Some((best_start, _)) => *start > *best_start,
            };
            if replace {
                best = Some((*start, pname.clone()));
            }
        }
    }
    best.map(|(_, n)| n)
}

fn extract_scoped_members(
    lines: &[&str],
    total: usize,
    primary: &HashMap<(usize, String), (&str, usize)>,
    out: &mut HashMap<(usize, String), (&str, usize)>,
) {
    let compiled = compiled_patterns();

    let enum_re = compiled.patterns.iter().find(|(k, _)| *k == "enum_member").map(|(_, r)| r);
    let field_re = compiled.patterns.iter().find(|(k, _)| *k == "field").map(|(_, r)| r);

    // Collect parent blocks where scoped kinds should be extracted
    let mut enum_ranges: Vec<(usize, usize)> = Vec::new();
    let mut class_ranges: Vec<(usize, usize)> = Vec::new();

    for ((line_idx, _), (kind, _)) in primary {
        let end = find_block_end(lines, *line_idx, total);
        match *kind {
            "enum" => enum_ranges.push((*line_idx, end)),
            "cls" | "struct" | "interface" | "trait" | "record" | "protocol" | "actor" | "object" => {
                class_ranges.push((*line_idx, end));
            }
            _ => {}
        }
    }

    // enum_member inside enum blocks
    if let Some(re) = enum_re {
        for &(start, end) in &enum_ranges {
            let body_start = start + 1;
            if body_start > end { continue; }
            for i in body_start..=end {
                let trimmed = lines[i].trim();
                if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed == "}" {
                    continue;
                }
                if let Some(caps) = re.captures(trimmed) {
                    if let Some(m) = caps.get(1) {
                        let name = m.as_str().to_string();
                        let key = (i, name);
                        out.entry(key).or_insert(("enum_member", i));
                    }
                }
            }
        }
    }

    // field inside class/struct blocks
    if let Some(re) = field_re {
        for &(start, end) in &class_ranges {
            let body_start = start + 1;
            if body_start > end { continue; }
            for i in body_start..=end {
                let trimmed = lines[i].trim();
                if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed == "}" {
                    continue;
                }
                // Skip lines already claimed by a primary kind
                if primary.keys().any(|(l, _)| *l == i) { continue; }
                if let Some(caps) = re.captures(trimmed) {
                    if let Some(m) = caps.get(1) {
                        let name = m.as_str().to_string();
                        let key = (i, name);
                        out.entry(key).or_insert(("field", i));
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Higher = more specific kind. Used to resolve conflicts when multiple
/// patterns match the same (line, name).
fn kind_specificity(kind: &str) -> u8 {
    match kind {
        "cls" | "struct" | "trait" | "enum" | "protocol" | "record" | "actor" | "union" | "object" | "extension" | "mixin" => 10,
        "impl" => 9,
        "fn" | "macro" | "ctor" | "operator" | "event" | "property" => 8,
        "type" => 7,
        "const" => 6,
        "mod" => 5,
        "field" | "enum_member" => 3,
        _ => 1,
    }
}

fn build_body_preview(lines: &[&str], start: usize, end: usize) -> String {
    let preview_end = (start + 50).min(end + 1).min(lines.len());
    lines[start..preview_end].join("\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- Store-action / arrow-property indexing (PR5) --
    // Zustand store actions (`name: (args) => set(...)`) were invisible to
    // `sy` because `try_object_method_lines` only handles shorthand method
    // syntax, not arrow-property syntax. These tests guard the new Tier 1.5d.

    #[test]
    fn extracts_zustand_store_action() {
        let content = r#"import { create } from 'zustand';

export const useAppStore = create((set) => ({
  count: 0,
  addInputCompressionSavings: (tokensSaved) => set((state) => ({
    count: state.count + tokensSaved,
  })),
  resetCount: () => set({ count: 0 }),
}));
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(
            names.contains(&"addInputCompressionSavings"),
            "store action not indexed: {:?}",
            names,
        );
        assert!(
            names.contains(&"resetCount"),
            "zero-arg arrow property not indexed: {:?}",
            names,
        );
    }

    #[test]
    fn indexes_async_arrow_property() {
        // `async (args) => { ... }` is a valid store action shape and must
        // be recognized as a method.
        let content = r#"const handlers = {
  onSubmit: async (event) => {
    await submitForm(event);
  },
};
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"onSubmit"), "async arrow property missed: {:?}", names);
    }

    #[test]
    fn skips_type_annotation_arrow_properties() {
        // `name: (args) => void` in an interface/type is NOT a method —
        // the arrow is followed by a type keyword, not executable code.
        // Indexing these as symbols would flood search results with phantom
        // "methods" that have no implementation.
        let content = r#"interface Handlers {
  onSubmit: (event: Event) => void;
  onChange: (value: string) => Promise<number>;
  onReset: () => never;
}
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        // The interface `Handlers` itself is fine to index — we only want
        // to make sure the type-annotation arrow properties did NOT sneak in.
        assert!(!names.contains(&"onSubmit"), "type annotation indexed: {:?}", names);
        assert!(!names.contains(&"onChange"), "type annotation indexed: {:?}", names);
        assert!(!names.contains(&"onReset"), "type annotation indexed: {:?}", names);
    }

    #[test]
    fn arrow_property_must_be_indented() {
        // Arrow property at column 0 is usually a module-level const decl
        // caught by Tier 1.5b, not an object literal member. Don't double-index.
        let content = "name: (args) => set()\n";
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        // Column 0 `name: (...) => ...` is not valid JS syntax outside an
        // object literal, so either nothing or an unrelated match is OK —
        // just assert we don't produce a spurious `name` entry.
        assert!(!names.contains(&"name"), "column-0 arrow property indexed: {:?}", names);
    }

    #[test]
    fn test_rust_symbols() {
        let content = r#"
pub fn hello(x: i32) -> String {
    format!("hello {}", x)
}

struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn distance(&self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

pub enum Color {
    Red,
    Green,
    Blue,
}

trait Drawable {
    fn draw(&self);
}
"#;
        let symbols = uhpp_extract_symbols(content, Some("rust"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"hello"), "missing fn hello: {:?}", names);
        assert!(names.contains(&"Point"), "missing struct Point: {:?}", names);
        assert!(names.contains(&"distance"), "missing fn distance: {:?}", names);
        let distance = symbols.iter().find(|s| s.name == "distance").expect("distance symbol");
        assert_eq!(
            distance.metadata.parent_symbol.as_deref(),
            Some("Point"),
            "method should record enclosing type as parent_symbol"
        );
        assert!(names.contains(&"Color"), "missing enum Color: {:?}", names);
        assert!(names.contains(&"Drawable"), "missing trait Drawable: {:?}", names);
        assert!(names.contains(&"draw"), "missing fn draw: {:?}", names);
    }

    #[test]
    fn test_typescript_symbols() {
        let content = r#"
export class UserService {
    private db: Database;

    async getUser(id: string): Promise<User> {
        return this.db.find(id);
    }

    static create(): UserService {
        return new UserService();
    }
}

export const handler = async (req: Request) => {
    return new Response("ok");
};

interface UserRepository {
    findById(id: string): Promise<User>;
}

export function processData(data: Data[]): Result {
    return data.map(transform);
}

enum Status {
    Active,
    Inactive,
    Pending,
}
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"UserService"), "missing class: {:?}", names);
        assert!(names.contains(&"getUser"), "missing method getUser: {:?}", names);
        assert!(names.contains(&"create"), "missing static create: {:?}", names);
        assert!(names.contains(&"handler"), "missing arrow fn: {:?}", names);
        assert!(names.contains(&"UserRepository"), "missing interface: {:?}", names);
        assert!(names.contains(&"processData"), "missing function: {:?}", names);
        assert!(names.contains(&"Status"), "missing enum: {:?}", names);
    }

    #[test]
    fn test_python_symbols() {
        let content = r#"
class DataProcessor:
    def __init__(self, config):
        self.config = config

    def process(self, data):
        return self.transform(data)

def main():
    processor = DataProcessor({})
    processor.process([1, 2, 3])
"#;
        let symbols = uhpp_extract_symbols(content, Some("python"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"DataProcessor"), "missing class: {:?}", names);
        assert!(names.contains(&"__init__"), "missing __init__: {:?}", names);
        assert!(names.contains(&"process"), "missing method: {:?}", names);
        assert!(names.contains(&"main"), "missing function: {:?}", names);
    }

    #[test]
    fn test_go_symbols() {
        let content = r#"
type Router struct {
    routes map[string]Handler
}

func (r *Router) Handle(path string, handler Handler) {
    r.routes[path] = handler
}

type Reader interface {
    Read(p []byte) (n int, err error)
}

func NewRouter() *Router {
    return &Router{routes: make(map[string]Handler)}
}
"#;
        let symbols = uhpp_extract_symbols(content, Some("go"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Router"), "missing struct Router: {:?}", names);
        assert!(names.contains(&"Handle"), "missing method Handle: {:?}", names);
        assert!(names.contains(&"Reader"), "missing interface Reader: {:?}", names);
        assert!(names.contains(&"NewRouter"), "missing func NewRouter: {:?}", names);
    }

    #[test]
    fn test_java_cfamily_symbols() {
        let content = r#"
public class UserService {
    private final Database db;

    public String toJson(User user) {
        return gson.toJson(user);
    }

    void parseNumber(String s) {
        Integer.parseInt(s);
    }
}
"#;
        let symbols = uhpp_extract_symbols(content, Some("java"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"UserService"), "missing class: {:?}", names);
        assert!(names.contains(&"toJson"), "missing toJson: {:?}", names);
        assert!(names.contains(&"parseNumber"), "missing parseNumber: {:?}", names);
    }

    #[test]
    fn test_dedup_same_line() {
        let content = "pub fn hello() { }\n";
        let symbols = uhpp_extract_symbols(content, Some("rust"));
        let hello_count = symbols.iter().filter(|s| s.name == "hello").count();
        assert_eq!(hello_count, 1, "should dedup: got {}", hello_count);
    }

    #[test]
    fn test_body_preview_included() {
        let content = "fn example() {\n    line1;\n    line2;\n}\n";
        let symbols = uhpp_extract_symbols(content, Some("rust"));
        let sym = symbols.iter().find(|s| s.name == "example").expect("missing example");
        assert!(sym.body_preview.is_some());
        let preview = sym.body_preview.as_ref().unwrap();
        assert!(preview.contains("fn example()"));
        assert!(preview.contains("line1"));
    }

    #[test]
    fn test_attributes_expanded() {
        let content = "#[derive(Debug)]\npub struct Foo {\n    x: i32,\n}\n";
        let symbols = uhpp_extract_symbols(content, Some("rust"));
        let sym = symbols.iter().find(|s| s.name == "Foo").expect("missing Foo");
        assert_eq!(sym.line, 1, "should expand to include #[derive] attr at line 1");
    }

    #[test]
    fn test_jsdoc_no_duplicate_symbol() {
        // Repro of smart-shape duplicate line bug: a function name that
        // also appears in its JSDoc comment text must not produce two
        // `ParsedSymbol` entries.
        let content = r#"
/**
 * Pop the oldest valid evicted entry. This function popValidEvictedOldest
 * drains the eviction queue while preserving insertion order.
 * @returns {Entry | null}
 */
export async function popValidEvictedOldest(): Promise<Entry | null> {
    return null;
}
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let count = symbols.iter().filter(|s| s.name == "popValidEvictedOldest").count();
        assert_eq!(
            count, 1,
            "JSDoc block must not yield a second symbol for popValidEvictedOldest: got {:?}",
            symbols.iter().map(|s| (s.name.clone(), s.line)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_jsdoc_absorbed_into_attribution_line() {
        // The JSDoc block above the function belongs to the symbol, so the
        // reported `line` should point at the `/**` opener, not the
        // `export async function …` signature line.
        let content = r#"/**
 * Docblock for foo.
 */
export function foo(): void {}
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let sym = symbols.iter().find(|s| s.name == "foo").expect("missing foo");
        assert_eq!(sym.line, 1, "attribution should start at JSDoc opener (line 1)");
    }

    #[test]
    fn test_block_comment_does_not_yield_phantom_symbols() {
        // `/* ... */` block comment containing `class` / `function` keywords
        // must not produce symbols.
        let content = r#"
/*
 * See also: class OldThing, function legacyImpl.
 */
export class RealThing {}
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"RealThing"), "missing RealThing: {:?}", names);
        assert!(!names.contains(&"OldThing"), "block comment text leaked as symbol: {:?}", names);
        assert!(!names.contains(&"legacyImpl"), "block comment text leaked as symbol: {:?}", names);
    }

    #[test]
    fn test_empty_content() {
        let symbols = uhpp_extract_symbols("", Some("rust"));
        assert!(symbols.is_empty());
    }

    #[test]
    fn test_object_literal_methods_typescript() {
        let content = r#"
const handlers = {
    of(x: number) {
        return x;
    },
    set(key: string, v: unknown) {
        cache[key] = v;
    },
    delete(key: string) {
        delete cache[key];
    },
    process(data: Data[]) {
        return data;
    },
};
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"of"), "missing of: {:?}", names);
        assert!(names.contains(&"set"), "missing set: {:?}", names);
        assert!(names.contains(&"process"), "missing process: {:?}", names);
    }

    #[test]
    fn test_object_literal_methods_no_false_positives() {
        let content = r#"
function example() {
    if (x) {
        doSomething();
    }
    for (const item of items) {
        process(item);
    }
    while (true) {
        break;
    }
}
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"example"), "missing function example: {:?}", names);
        assert!(!names.contains(&"if"), "false positive 'if': {:?}", names);
        assert!(!names.contains(&"for"), "false positive 'for': {:?}", names);
        assert!(!names.contains(&"while"), "false positive 'while': {:?}", names);
    }

    #[test]
    fn test_object_method_async_shorthand() {
        let content = r#"
const api = {
    async fetch(url: string) {
        return await http.get(url);
    },
    async save(data: any) {
        return await http.post('/save', data);
    },
};
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"fetch"), "missing async method fetch: {:?}", names);
        assert!(names.contains(&"save"), "missing async method save: {:?}", names);
    }

    #[test]
    fn test_object_method_mixed_with_class() {
        let content = r#"
export class Store {
    get(key: string) {
        return this.data[key];
    }
    set(key: string, val: unknown) {
        this.data[key] = val;
    }
}

const utils = {
    of(items: any[]) {
        return new Collection(items);
    },
    from(source: any) {
        return parse(source);
    },
};
"#;
        let symbols = uhpp_extract_symbols(content, Some("typescript"));
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Store"), "missing class Store: {:?}", names);
        assert!(names.contains(&"get"), "missing class method get: {:?}", names);
        assert!(names.contains(&"set"), "missing set (class or object): {:?}", names);
        assert!(names.contains(&"of"), "missing object method of: {:?}", names);
        assert!(names.contains(&"from"), "missing object method from: {:?}", names);
    }

    #[test]
    fn uhpp_symbol_kind_patterns_compile() {
        for (kind, pat) in UHPP_SYMBOL_KINDS {
            regex::Regex::new(pat).unwrap_or_else(|e| {
                panic!("invalid UHPP regex for kind {kind}: {e}");
            });
        }
    }
}
