//! Regex-based symbol and import extraction when tree-sitter parse fails.
//! Used for Kotlin (tree-sitter crate requires older tree-sitter version).
//!
//! **DEPRECATED**: Replaced by `uhpp_extractor::uhpp_extract_symbols` and
//! `relations::extract_imports_regex` which provide unified regex extraction
//! across all languages. This module will be removed once validation confirms
//! full parity.

use crate::indexer::ImportInfo;
use crate::file::Language;
use crate::symbol::{ParsedSymbol, SymbolKind, SymbolMetadata};
use regex::Regex;
use std::collections::HashMap;

/// Extract symbols via regex when tree-sitter parse fails.
#[deprecated(note = "Use uhpp_extractor::uhpp_extract_symbols instead")]
pub fn extract_symbols_fallback(content: &str, language: Language) -> Vec<ParsedSymbol> {
    match language {
        Language::Kotlin => extract_kotlin_symbols(content),
        _ => Vec::new(),
    }
}

/// Extract imports via line scanning when tree-sitter parse fails.
#[deprecated(note = "Use relations::extract_imports_regex instead")]
pub fn extract_imports_fallback(content: &str, language: Language) -> Vec<ImportInfo> {
    match language {
        Language::Kotlin => extract_kotlin_imports(content),
        _ => Vec::new(),
    }
}

fn find_block_end(lines: &[&str], start: usize, total: usize) -> usize {
    let mut depth: i32 = 0;
    let mut found_open = false;
    for i in start..total {
        let line = lines[i];
        for c in line.chars() {
            if c == '{' {
                depth += 1;
                found_open = true;
            } else if c == '}' {
                depth -= 1;
                if found_open && depth == 0 {
                    return i;
                }
            }
        }
    }
    total.saturating_sub(1)
}

fn empty_metadata() -> SymbolMetadata {
    SymbolMetadata {
        parameters: None,
        return_type: None,
        visibility: None,
        modifiers: None,
        parent_symbol: None,
        extends: None,
        implements: None,
    }
}

fn extract_kotlin_symbols(content: &str) -> Vec<ParsedSymbol> {
    let mut symbols = Vec::new();
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    let patterns: &[(&str, SymbolKind)] = &[
        (r"^\s*(?:override\s+|private\s+|protected\s+|internal\s+|open\s+|final\s+)*fun\s+(\w+)", SymbolKind::Method),
        (r"^\s*fun\s+(\w+)", SymbolKind::Function),
        (r"^\s*(?:data\s+)?class\s+(\w+)", SymbolKind::Class),
        (r"^\s*interface\s+(\w+)", SymbolKind::Interface),
        (r"^\s*object\s+(\w+)", SymbolKind::Class),
        (r"^\s*enum\s+class\s+(\w+)", SymbolKind::Enum),
    ];

    for (pat, kind) in patterns {
        if let Ok(re) = Regex::new(pat) {
            for (idx, line) in lines.iter().enumerate() {
                if let Some(caps) = re.captures(line) {
                    if let Some(name) = caps.get(1) {
                        let name = name.as_str().to_string();
                        let end_line = find_block_end(&lines, idx, total);
                        let end_line_u32 = (end_line as u32).saturating_add(1);
                        let line_u32 = (idx as u32).saturating_add(1);
                        let complexity = if matches!(kind, SymbolKind::Function | SymbolKind::Method) {
                            Some(0)
                        } else {
                            None
                        };
                        symbols.push(ParsedSymbol {
                            name,
                            kind: kind.clone(),
                            line: line_u32,
                            end_line: Some(end_line_u32),
                            scope_id: None,
                            signature: None,
                            complexity,
                            body_preview: None,
                            metadata: empty_metadata(),
                        });
                    }
                }
            }
        }
    }

    // Deduplicate by (line, name) - same symbol may match multiple patterns
    let mut seen: HashMap<(u32, String), ()> = HashMap::new();
    symbols.retain(|s| seen.insert((s.line, s.name.clone()), ()).is_none());
    symbols.sort_by_key(|s| s.line);
    symbols
}

fn extract_kotlin_imports(content: &str) -> Vec<ImportInfo> {
    let mut imports = Vec::new();
    let re = match Regex::new(r"^\s*import\s+(.+)") {
        Ok(r) => r,
        Err(_) => return imports,
    };
    for line in content.lines() {
        if let Some(caps) = re.captures(line) {
            let inner = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            let inner = inner.trim_end_matches(';').trim();
            if inner.is_empty() {
                continue;
            }
            let module = inner.to_string();
            let last_segment = module.rsplit('.').next().unwrap_or(&module);
            let symbols = vec![last_segment.to_string()];
            imports.push(ImportInfo {
                module,
                symbols,
                is_default: false,
                is_pub: false,
                is_system: false,
            });
        }
    }
    imports
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file::Language;

    #[test]
    #[allow(deprecated)]
    fn kotlin_symbols_and_imports_non_kotlin_empty() {
        let kt = r#"
            import foo.Bar
            class C {
                fun hello() {}
            }
        "#;
        let syms = extract_symbols_fallback(kt, Language::Kotlin);
        assert!(!syms.is_empty());
        let imports = extract_imports_fallback(kt, Language::Kotlin);
        assert!(imports.iter().any(|i| i.module == "foo.Bar"));

        assert!(extract_symbols_fallback(kt, Language::Rust).is_empty());
        assert!(extract_imports_fallback(kt, Language::Rust).is_empty());
    }
}
