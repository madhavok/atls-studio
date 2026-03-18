//! Hash Pointer Protocol (HPP) — output-side utilities.
//!
//! Scans model text output for `h:XXXX` references and annotates them
//! with resolved metadata (file path, line content) so the frontend can
//! render expandable inline code blocks.
//!
//! Also provides blackboard h:ref resolution for the UI layer.

use crate::hash_resolver::{
    self, parse_hash_ref, parse_diff_ref, HashModifier, HashRegistry, ShapeOp,
    clean_source_path,
};
use crate::diff_engine;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Type of reference found in model output.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefType {
    Code,
    Diff,
    Meta,
    Symbol,
    Blackboard,
}

/// A resolved hash reference found in model output text.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResolvedOutputRef {
    /// The raw h:ref string as it appeared in the text (e.g. "h:abc12345:15-22")
    pub raw: String,
    /// Byte offset in the original text where this ref starts
    pub offset: usize,
    /// Length of the raw ref string in bytes
    pub length: usize,
    /// Resolved source file path (if available)
    pub source: Option<String>,
    /// Resolved line content (if line range was specified)
    pub lines: Option<String>,
    /// Short hash for display
    pub short_hash: String,
    /// Whether the hash was found in the registry
    pub resolved: bool,
    /// Type of reference (code, diff, meta, symbol)
    pub ref_type: RefType,
    /// Shape modifier applied (e.g. "sig", "dedent")
    pub shape: Option<String>,
    /// Pre-resolved shaped content (for expanded view)
    pub content: Option<String>,
    /// Highlight line ranges for frontend rendering
    pub highlight_ranges: Option<Vec<(u32, Option<u32>)>>,
    /// Diff statistics (for diff refs)
    pub diff_stats: Option<diff_engine::DiffStats>,
    /// Detected language for syntax highlighting
    pub lang: Option<String>,
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/// Scan model text output for `h:XXXX` patterns and resolve them against the registry.
///
/// Returns a list of resolved references with their positions and metadata,
/// without modifying the original text. The frontend uses these annotations
/// to render expandable code blocks.
pub fn scan_output_refs(
    text: &str,
    registry: &HashRegistry,
) -> Vec<ResolvedOutputRef> {
    let mut results = Vec::new();
    let mut search_from = 0;

    while let Some(pos) = text[search_from..].find("h:") {
        let abs_pos = search_from + pos;
        let ref_start = abs_pos;
        let rest = &text[abs_pos..];

        // Extended token extraction: hex, colons, dashes, commas, dots, parens, underscores
        let mut ref_end = rest
            .find(|c: char| {
                !c.is_ascii_alphanumeric()
                    && c != ':' && c != '-' && c != ',' && c != '.'
                    && c != '(' && c != ')' && c != '_'
            })
            .map(|i| abs_pos + i)
            .unwrap_or(text.len());

        // Trim trailing punctuation that isn't part of the ref
        while ref_end > ref_start {
            let last = text.as_bytes()[ref_end - 1];
            if last == b',' || last == b'.' || last == b')' {
                // Keep ')' if there's a matching '(' in the ref
                if last == b')' {
                    let candidate = &text[ref_start..ref_end];
                    if candidate.matches('(').count() >= candidate.matches(')').count() {
                        break;
                    }
                }
                ref_end -= 1;
            } else {
                break;
            }
        }

        let raw_ref = &text[ref_start..ref_end];

        // Blackboard ref: h:bb:keyname — resolve on frontend, just mark position
        if raw_ref.starts_with("h:bb:") && raw_ref.len() > 5 {
            let bb_key = &raw_ref[5..]; // everything after "h:bb:"
            results.push(ResolvedOutputRef {
                raw: raw_ref.to_string(),
                offset: ref_start,
                length: raw_ref.len(),
                source: Some(format!("bb:{}", bb_key)),
                lines: None,
                short_hash: format!("bb:{}", bb_key),
                resolved: true, // Frontend resolves from BB store
                ref_type: RefType::Blackboard,
                shape: None,
                content: None, // Frontend fills this from blackboard store
                highlight_ranges: None,
                diff_stats: None,
                lang: None,
            });
            search_from = ref_end;
            continue;
        }

        if raw_ref.len() < 8 {
            search_from = abs_pos + 2;
            continue;
        }

        // Try diff ref first: h:OLD..h:NEW
        if let Some(diff) = parse_diff_ref(raw_ref) {
            let old_entry = registry.get(&diff.old_hash);
            let new_entry = registry.get(&diff.new_hash);
            let resolved = old_entry.is_some() && new_entry.is_some();

            let source = new_entry.and_then(|e| clean_source_path(e.source.as_deref()))
                .or_else(|| old_entry.and_then(|e| clean_source_path(e.source.as_deref())));

            let (diff_stats, content, lang) = if resolved {
                match diff_engine::compute_diff(registry, &diff.old_hash, &diff.new_hash, 3) {
                    Ok(result) => (
                        Some(result.stats),
                        Some(result.unified),
                        new_entry.and_then(|e| e.lang.clone()),
                    ),
                    Err(_) => (None, None, None),
                }
            } else {
                (None, None, None)
            };

            results.push(ResolvedOutputRef {
                raw: raw_ref.to_string(),
                offset: ref_start,
                length: raw_ref.len(),
                source,
                lines: None,
                short_hash: diff.old_hash[..8.min(diff.old_hash.len())].to_string(),
                resolved,
                ref_type: RefType::Diff,
                shape: None,
                content,
                highlight_ranges: None,
                diff_stats,
                lang,
            });

            search_from = ref_end;
            continue;
        }

        // Standard h:ref (with optional shape/symbol/meta modifiers)
        if let Some(href) = parse_hash_ref(raw_ref) {
            let short_hash = if href.hash.len() > hash_resolver::SHORT_HASH_LEN {
                href.hash[..hash_resolver::SHORT_HASH_LEN].to_string()
            } else {
                href.hash.clone()
            };

            let entry = registry.get(&href.hash);
            let resolved = entry.is_some();
            let source = entry.and_then(|e| clean_source_path(e.source.as_deref()));
            let lang = entry.and_then(|e| e.lang.clone());

            let (ref_type, shape, lines, content, highlight_ranges) =
                classify_modifier(&href.modifier, entry);

            results.push(ResolvedOutputRef {
                raw: raw_ref.to_string(),
                offset: ref_start,
                length: raw_ref.len(),
                source,
                lines,
                short_hash,
                resolved,
                ref_type,
                shape,
                content,
                highlight_ranges,
                diff_stats: None,
                lang,
            });
        }

        search_from = ref_end;
    }

    results
}

/// Classify a modifier into ref_type, shape label, and optionally resolve content.
fn classify_modifier(
    modifier: &HashModifier,
    entry: Option<&crate::hash_resolver::HashEntry>,
) -> (RefType, Option<String>, Option<String>, Option<String>, Option<Vec<(u32, Option<u32>)>>) {
    match modifier {
        HashModifier::Auto | HashModifier::Content | HashModifier::Source => {
            (RefType::Code, None, None, None, None)
        }

        HashModifier::Lines(ranges) => {
            let lines = entry.and_then(|e| extract_preview_lines(&e.content, ranges, 30));
            (RefType::Code, None, lines, None, None)
        }

        HashModifier::Shape(shape) => {
            let label = shape_label(shape);
            let content = entry.map(|e| crate::shape_ops::apply_shape(&e.content, shape));
            let hl = if let ShapeOp::Highlight(ranges) = shape {
                Some(ranges.clone())
            } else {
                None
            };
            (RefType::Code, Some(label), None, content, hl)
        }

        HashModifier::ShapedLines { ranges, shape } => {
            let label = shape_label(shape);
            let content = entry.and_then(|e| {
                let lines: Vec<&str> = e.content.lines().collect();
                let total = lines.len();
                let mut extracted = Vec::new();
                for &(start, end) in ranges.iter() {
                    let s = (start as usize).saturating_sub(1).min(total);
                    let end_idx = match end {
                        Some(e) => (e as usize).min(total),
                        None => total,
                    };
                    extracted.extend_from_slice(&lines[s..end_idx]);
                }
                let raw = extracted.join("\n");
                Some(crate::shape_ops::apply_shape(&raw, shape))
            });
            let hl = if let ShapeOp::Highlight(hl_ranges) = shape {
                Some(hl_ranges.clone())
            } else {
                None
            };
            (RefType::Code, Some(label), None, content, hl)
        }

        HashModifier::SymbolAnchor { kind, name, shape } => {
            let label = format!(
                "{}({})",
                kind.as_deref().unwrap_or("sym"),
                name,
            );
            let content = entry.and_then(|e| {
                crate::shape_ops::resolve_symbol_anchor_lang(&e.content, kind.as_deref(), name, e.lang.as_deref())
                    .ok()
                    .map(|extracted| match shape {
                        Some(s) => crate::shape_ops::apply_shape(&extracted, s),
                        None => extracted,
                    })
            });
            (RefType::Symbol, Some(label), None, content, None)
        }

        HashModifier::SymbolDeps { kind, name } => {
            let label = format!("{}({}):deps", kind.as_deref().unwrap_or("sym"), name);
            let content = entry.and_then(|e| {
                crate::shape_ops::analyze_symbol_deps(&e.content, kind.as_deref(), name, e.lang.as_deref()).ok()
            });
            (RefType::Meta, Some(label), None, content, None)
        }

        HashModifier::Tokens | HashModifier::Meta | HashModifier::Lang => {
            let content = entry.map(|e| match modifier {
                HashModifier::Tokens => e.tokens.to_string(),
                HashModifier::Meta => serde_json::json!({
                    "source": clean_source_path(e.source.as_deref()),
                    "tokens": e.tokens,
                    "lines": e.line_count,
                    "lang": e.lang,
                    "symbols": e.symbol_count,
                }).to_string(),
                HashModifier::Lang => e.lang.clone().unwrap_or_else(|| "unknown".to_string()),
                _ => unreachable!(),
            });
            (RefType::Meta, None, None, content, None)
        }
    }
}

pub fn shape_label(shape: &ShapeOp) -> String {
    match shape {
        ShapeOp::Sig => "sig".to_string(),
        ShapeOp::Fold => "fold".to_string(),
        ShapeOp::Dedent => "dedent".to_string(),
        ShapeOp::NoComment => "nocomment".to_string(),
        ShapeOp::Head(n) => format!("head({})", n),
        ShapeOp::Tail(n) => format!("tail({})", n),
        ShapeOp::Grep(p) => format!("grep({})", p),
        ShapeOp::Exclude(_) => "exclude".to_string(),
        ShapeOp::Imports => "imports".to_string(),
        ShapeOp::Exports => "exports".to_string(),
        ShapeOp::Highlight(_) => "highlight".to_string(),
        ShapeOp::Concept(t) => format!("concept({})", t),
        ShapeOp::Pattern(p) => format!("pattern({})", p),
        ShapeOp::If(e) => format!("if({})", e),
        ShapeOp::Snap => "snap".to_string(),
        ShapeOp::Refs => "refs".to_string(),
    }
}

/// Extract a limited number of lines for preview display.
/// Caps at `max_lines` to prevent huge expansions in the UI.
fn extract_preview_lines(
    content: &str,
    ranges: &[(u32, Option<u32>)],
    max_lines: usize,
) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let mut output = Vec::new();

    for &(start, end) in ranges {
        if start == 0 || (start as usize) > total {
            continue;
        }
        let start_idx = (start as usize).saturating_sub(1);
        let end_idx = match end {
            Some(e) => std::cmp::min(e as usize, total),
            None => total,
        };
        for (i, &line) in lines[start_idx..end_idx].iter().enumerate() {
            if output.len() >= max_lines {
                output.push(format!("  ... ({} more lines)", end_idx - start_idx - i));
                break;
            }
            let line_num = start_idx + i + 1;
            output.push(format!("{:>4}|{}", line_num, line));
        }
    }

    if output.is_empty() {
        None
    } else {
        Some(output.join("\n"))
    }
}

/// Resolve h:refs within a blackboard value string for UI display.
///
/// Unlike scan_output_refs which annotates, this *replaces* h:refs with
/// a compact display form: `[src/auth.ts:15-22]` or `[h:abc12345]` if unresolved.
pub fn resolve_blackboard_display(
    value: &str,
    registry: &HashRegistry,
) -> String {
    let refs = scan_output_refs(value, registry);
    if refs.is_empty() {
        return value.to_string();
    }

    let mut result = String::with_capacity(value.len());
    let mut last_end = 0;

    for r in &refs {
        result.push_str(&value[last_end..r.offset]);
        if let Some(ref src) = r.source {
            // Extract line spec from raw ref if present
            let line_spec = r.raw
                .rfind(':')
                .and_then(|pos| {
                    let after = &r.raw[pos + 1..];
                    if after.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                        Some(after)
                    } else {
                        None
                    }
                });
            if let Some(spec) = line_spec {
                result.push_str(&format!("[{}:{}]", src, spec));
            } else {
                result.push_str(&format!("[{}]", src));
            }
        } else {
            result.push_str(&format!("[h:{}]", r.short_hash));
        }
        last_end = r.offset + r.length;
    }
    result.push_str(&value[last_end..]);

    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash_resolver::{HashEntry, HashRegistry, detect_lang};

    fn make_registry() -> HashRegistry {
        let mut reg = HashRegistry::new();
        let content = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8";
        reg.register(
            "abc12345def67890".to_string(),
            HashEntry {
                source: Some("src/auth.ts".to_string()),
                content: content.to_string(),
                tokens: 50,
                lang: detect_lang(Some("src/auth.ts")),
                line_count: content.lines().count(),
                symbol_count: None,
            },
        );
        reg
    }

    #[test]
    fn test_scan_simple_ref() {
        let reg = make_registry();
        let text = "Bug at h:abc12345 in the auth module";
        let refs = scan_output_refs(text, &reg);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].raw, "h:abc12345");
        assert_eq!(refs[0].source, Some("src/auth.ts".to_string()));
        assert!(refs[0].resolved);
    }

    #[test]
    fn test_scan_ref_with_lines() {
        let reg = make_registry();
        let text = "Check h:abc12345:2-4 for the race condition";
        let refs = scan_output_refs(text, &reg);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].raw, "h:abc12345:2-4");
        assert!(refs[0].lines.is_some());
        let lines = refs[0].lines.as_ref().unwrap();
        assert!(lines.contains("line2"));
        assert!(lines.contains("line4"));
    }

    #[test]
    fn test_scan_multiple_refs() {
        let reg = make_registry();
        let text = "Flow: h:abc12345:1-2 then h:abc12345:5-6";
        let refs = scan_output_refs(text, &reg);
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn test_scan_unresolved_ref() {
        let reg = make_registry();
        let text = "Missing h:deadbeef somewhere";
        let refs = scan_output_refs(text, &reg);
        assert_eq!(refs.len(), 1);
        assert!(!refs[0].resolved);
    }

    #[test]
    fn test_resolve_blackboard_display() {
        let reg = make_registry();
        let value = "race condition at h:abc12345:3-5, fix needed";
        let display = resolve_blackboard_display(value, &reg);
        assert!(display.contains("[src/auth.ts:3-5]"));
        assert!(display.contains("race condition at"));
        assert!(display.contains(", fix needed"));
    }

    #[test]
    fn test_no_refs_passthrough() {
        let reg = make_registry();
        let text = "No references here, just plain text";
        let refs = scan_output_refs(text, &reg);
        assert!(refs.is_empty());
    }
}
