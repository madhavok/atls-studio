use super::*;
use crate::git_ops::run_shell_cmd_async;
use crate::snapshot;
use crate::hash_resolver;
use crate::linter;

/// Tail-biased output truncation: keeps first `head` lines + last `tail` lines.
/// Returns (text, was_truncated, total_lines).
pub(crate) fn truncate_output_tail_biased(text: &str, max_bytes: usize, head_lines: usize, tail_lines: usize) -> (String, bool, usize) {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    if text.len() <= max_bytes {
        return (text.to_string(), false, total);
    }
    if total <= head_lines + tail_lines {
        return (format!("{}\n...[truncated at {} bytes, {} total]", &text[..max_bytes.min(text.len())], text.len(), total), true, total);
    }
    let head: String = lines[..head_lines].join("\n");
    let tail: String = lines[total - tail_lines..].join("\n");
    let omitted = total - head_lines - tail_lines;
    (format!("{}\n\n... [{} lines omitted, {} total] ...\n\n{}", head, omitted, total, tail), true, total)
}

/// Combine stdout + stderr, filtering PowerShell boilerplate on Windows.
pub(crate) fn combine_output(stdout: &str, stderr: &str) -> String {
    #[cfg(windows)]
    let filtered_stderr = crate::git_ops::filter_powershell_stderr(stderr);
    #[cfg(not(windows))]
    let filtered_stderr = stderr.to_string();
    if filtered_stderr.trim().is_empty() {
        stdout.to_string()
    } else {
        format!("{}\n{}", stdout, filtered_stderr)
    }
}

/// Routes `operation == "edit"` to concrete backend ops (`draft`, `batch_edits`, `delete_files`, etc.).
pub(crate) fn resolve_edit_operation(
    operation: String,
    mut params: serde_json::Value,
) -> (String, serde_json::Value) {
    if operation.as_str() != "edit" {
        return (operation, params);
    }
    let Some(obj) = params.as_object_mut() else {
        return (operation, params);
    };
    let deletes = obj.get("deletes").and_then(|v| v.as_array()).cloned();
    let mode = obj.get("mode").and_then(|v| v.as_str());
    let edits = obj.get("edits").and_then(|v| v.as_array());
    let resolved = if obj.get("undo").is_some() {
        String::from("undo")
    } else if obj.get("revise").is_some() {
        if let Some(h) = obj.remove("revise") {
            obj.insert("hash".to_string(), h);
        }
        String::from("revise")
    } else if let Some(d) = &deletes {
        if !d.is_empty() {
            obj.insert("file_paths".to_string(), serde_json::Value::Array(d.clone()));
            obj.remove("deletes");
            String::from("delete_files")
        } else {
            String::from("draft")
        }
    } else if mode == Some("delete_files") && obj.contains_key("file_paths") {
        String::from("delete_files")
    } else if mode == Some("batch_edits") && edits.map(|e| !e.is_empty()).unwrap_or(false) {
        String::from("batch_edits")
    } else {
        String::from("draft")
    };
    (resolved, serde_json::Value::Object(std::mem::take(obj)))
}

/// Extract raw hash for undo/revise/flush lookup from various formats the model may pass.
/// Handles: "h:6169ed", "[edit result] h:6169ed → path", "6169ed", "6169ed_edit", etc.
/// Returns the hash suitable for matching entry.hash (which has no "h:" prefix).
pub(crate) fn extract_hash_for_edit_ref(s: &str) -> String {
    let trimmed = s.trim();
    // Extract h:XXX from "[edit result] h:6169ed → path" or similar
    if let Some(idx) = trimmed.find("h:") {
        let after_h = &trimmed[idx + 2..];
        let hash_part: String = after_h
            .chars()
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        if !hash_part.is_empty() {
            return hash_part;
        }
    }
    // Already bare hash or h:XXX — strip prefix and suffixes
    let base = trimmed
        .trim_start_matches("h:")
        .trim_end_matches("_edit")
        .trim_end_matches("_draft")
        .trim_end_matches("_create")
        .trim_end_matches("_revise");
    base.to_string()
}

pub(crate) fn is_js_ts_path(path: &str) -> bool {
    path.ends_with(".js")
        || path.ends_with(".ts")
        || path.ends_with(".jsx")
        || path.ends_with(".tsx")
        || path.ends_with(".mjs")
        || path.ends_with(".cjs")
        || path.ends_with(".mts")
        || path.ends_with(".cts")
}

/// Brace languages that get pre-write syntax check (JS/TS, Rust). Preserved for re-enable.
#[allow(dead_code)]
pub(crate) fn is_brace_lang_for_prewrite(path: &str) -> bool {
    is_js_ts_path(path) || path.ends_with(".rs")
}

/// Optional behavior-change guardrail: flags edits that add inheritance, mixins, or global includes.
/// Returns a warning message if the diff suggests non-refactor behavior changes.
pub(crate) fn check_behavior_change_heuristic(old_content: &str, new_content: &str) -> Option<String> {
    let old_extends = old_content.matches(" extends ").count();
    let new_extends = new_content.matches(" extends ").count();
    let old_implements = old_content.matches(" implements ").count();
    let new_implements = new_content.matches(" implements ").count();
    let old_mixin = old_content.matches(" mixin ").count() + old_content.matches(" with ").count();
    let new_mixin = new_content.matches(" mixin ").count() + new_content.matches(" with ").count();
    let old_include = old_content.matches("#include").count();
    let new_include = new_content.matches("#include").count();
    let old_using = old_content.matches("using ").count();
    let new_using = new_content.matches("using ").count();
    let added = (new_extends > old_extends) || (new_implements > old_implements)
        || (new_mixin > old_mixin) || (new_include > old_include) || (new_using > old_using);
    if added {
        Some("Potential non-refactor: edit adds inheritance/mixin/global include — review required.".to_string())
    } else {
        None
    }
}

#[allow(dead_code)]
pub(crate) fn is_barrel_like_file(file_path: &str, content: &str) -> bool {
    let normalized = file_path.replace('\\', "/").to_lowercase();
    let export_count = content.matches("export ").count();
    let module_exports = content.matches("module.exports").count();
    normalized.ends_with("/index.js")
        || normalized.ends_with("/index.ts")
        || normalized.ends_with("/index.mjs")
        || normalized.ends_with("/index.cjs")
        || export_count >= 3
        || module_exports > 0
}

#[allow(dead_code)]
pub(crate) fn build_barrel_recovery(
    file_path: &str,
    old_hash: &str,
    errors: &[&linter::LintResult],
) -> serde_json::Value {
    let first = errors[0];
    let line_start = first.line.max(1);
    let line_end = errors
        .iter()
        .map(|err| err.line.max(line_start))
        .max()
        .unwrap_or(line_start);
    serde_json::json!({
        "error": format!(
            "Pre-write lint failed for {}: {} at L{}:{}",
            file_path, first.message, first.line, first.column
        ),
        "_recovery": {
            "kind": "barrel_edit_retry",
            "file": file_path,
            "from_hash": format!("h:{}", old_hash),
            "line_range": [line_start, line_end],
            "hint": "Retry with multiple small line_edits instead of a whole-barrel rewrite. Change one export/property at a time and preserve exact JS object/export syntax."
        }
    })
}

/// Deprecated: use `snapshot::canonicalize_hash` for new code paths.
pub(crate) fn canonicalize_expected_content_hash(value: &str) -> String {
    snapshot::canonicalize_hash(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthorityCheck {
    Match,
    Forwarded,
    AuthorityMismatch,
    Stale,
}

pub(crate) fn classify_snapshot_authority(
    registry: &hash_resolver::HashRegistry,
    snapshot_svc: &snapshot::SnapshotService,
    file_path: &str,
    expected_hash: &str,
    actual_hash: &str,
    current_content: &str,
) -> AuthorityCheck {
    let expected_clean = canonicalize_expected_content_hash(expected_hash);
    if actual_hash == expected_clean {
        return AuthorityCheck::Match;
    }
    if snapshot_svc.resolve_forward(&expected_clean)
        .map(|forwarded| forwarded == actual_hash)
        .unwrap_or(false)
    {
        return AuthorityCheck::Forwarded;
    }
    if registry.matches_authoritative_content(file_path, &expected_clean, current_content) {
        return AuthorityCheck::AuthorityMismatch;
    }
    AuthorityCheck::Stale
}

#[cfg(test)]
pub(crate) fn build_authority_mismatch_diagnostic(
    file: &str,
    expected_hash: &str,
    actual_hash: &str,
    hint: &str,
) -> serde_json::Value {
    serde_json::json!({
        "file": file,
        "warning": "authority_mismatch",
        "error_class": "authority_mismatch",
        "expected_hash": canonicalize_expected_content_hash(expected_hash),
        "actual_hash": actual_hash,
        "stale_hash_root_cause": "authority_mismatch",
        "hint": hint,
    })
}

/// Hard-error variant: returns an error JSON that callers should return early.
pub(crate) fn build_authority_mismatch_error(
    file: &str,
    expected_hash: &str,
    actual_hash: &str,
    hint: &str,
) -> serde_json::Value {
    serde_json::json!({
        "error": format!(
            "authority_mismatch for {}: expected {}, actual {}. The supplied hash refers to the same bytes through a non-canonical view. Perform a fresh canonical full read before retrying.",
            file,
            canonicalize_expected_content_hash(expected_hash),
            actual_hash
        ),
        "error_class": "authority_mismatch",
        "expected_hash": canonicalize_expected_content_hash(expected_hash),
        "actual_hash": actual_hash,
        "content_hash": actual_hash,
        "stale_hash_root_cause": "authority_mismatch",
        "hint": hint,
        "_next": "Run read.shaped(sig) + read.lines on the target range for targeted edits, or q: r1 read.context type:full file_paths:... for broad changes, then rebuild the edit from current content",
    })
}

/// Hard-error variant for forwarded hashes in mutation mode.
pub(crate) fn build_forwarded_hash_error(
    file: &str,
    expected_hash: &str,
    actual_hash: &str,
) -> serde_json::Value {
    serde_json::json!({
        "error": format!(
            "stale_hash (forwarded) for {}: expected {}, actual {}. The hash was forwarded from a prior edit but is no longer canonical. Perform a fresh canonical full read before retrying.",
            file,
            canonicalize_expected_content_hash(expected_hash),
            actual_hash
        ),
        "error_class": "stale_hash",
        "expected_hash": canonicalize_expected_content_hash(expected_hash),
        "actual_hash": actual_hash,
        "content_hash": actual_hash,
        "stale_hash_root_cause": "forwarded_hash",
        "_next": "Run read.shaped(sig) + read.lines on the target range for targeted edits, or q: r1 read.context type:full file_paths:... for broad changes, then rebuild the edit from current content",
    })
}

pub(crate) fn metadata_modified_ns(metadata: &std::fs::Metadata) -> u128 {
    metadata.modified().ok()
        .and_then(|mtime| mtime.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

pub(crate) fn build_draft_nonblocking_stale_warning(
    file: &str,
    expected_hash: &str,
    actual_hash: &str,
    hint: &str,
) -> serde_json::Value {
    serde_json::json!({
        "file": file,
        "warning": "stale_hash_followed_latest",
        "error_class": "stale_hash",
        "expected_hash": canonicalize_expected_content_hash(expected_hash),
        "actual_hash": actual_hash,
        "hint": hint,
        "applied_against_latest": true,
    })
}

pub(crate) fn parse_exact_span_range(value: Option<&serde_json::Value>) -> Option<(usize, usize)> {
    let value = value?;
    let arr = value.as_array()?;
    if arr.len() >= 2 && arr[0].is_number() && arr[1].is_number() {
        let start = arr[0].as_u64()? as usize;
        let end = arr[1].as_u64()? as usize;
        return (start > 0 && end >= start).then_some((start, end));
    }
    let nested = arr.first()?.as_array()?;
    if nested.len() < 2 {
        return None;
    }
    let start = nested[0].as_u64()? as usize;
    let end = nested[1].as_u64()? as usize;
    (start > 0 && end >= start).then_some((start, end))
}

pub(crate) fn trim_single_trailing_newline(value: &str) -> &str {
    value.strip_suffix('\n').unwrap_or(value)
}

/// Error variants for exact-span edits, for distinct recovery hints.
#[derive(Debug)]
pub(crate) enum ExactSpanError {
    SpanOutOfRange {
        start_line: usize,
        end_line: usize,
        line_count: usize,
    },
    AnchorMismatch {
        hint: String,
    },
}

pub(crate) fn apply_exact_span_edit(
    base: &str,
    old: &str,
    new_text: &str,
    range: (usize, usize),
) -> Result<String, ExactSpanError> {
    let mut lines: Vec<String> = base.lines().map(|line| line.to_string()).collect();
    if base.ends_with('\n') {
        lines.push(String::new());
    }
    let line_count = lines.len();

    let start_idx = range
        .0
        .checked_sub(1)
        .filter(|i| *i < line_count)
        .ok_or_else(|| ExactSpanError::SpanOutOfRange {
            start_line: range.0,
            end_line: range.1,
            line_count,
        })?;
    let end_idx = range.1.min(line_count);
    if end_idx <= start_idx {
        return Err(ExactSpanError::SpanOutOfRange {
            start_line: range.0,
            end_line: range.1,
            line_count,
        });
    }

    let old_normalized = normalize_line_endings(old);
    let new_normalized = normalize_line_endings(new_text);
    let targeted = lines[start_idx..end_idx].join("\n");

    // When old is provided, validate it matches the span (safety check).
    // When old is empty, skip validation — pure line-range splice.
    if !old_normalized.is_empty()
        && trim_single_trailing_newline(&targeted) != trim_single_trailing_newline(&old_normalized)
    {
        return Err(ExactSpanError::AnchorMismatch {
            hint: "exact span no longer matches current file content — content may have changed since hash was created".to_string(),
        });
    }

    let replacement: Vec<String> = if new_normalized.is_empty() {
        Vec::new()
    } else {
        new_normalized.split('\n').map(|line| line.to_string()).collect()
    };
    lines.splice(start_idx..end_idx, replacement);
    Ok(lines.join("\n"))
}

#[cfg(test)]
pub(crate) fn should_emit_line_edit_stale_warning(
    _content_hash_refreshed: bool,
    expected_hash: Option<&str>,
    actual_hash: &str,
) -> bool {
    let Some(expected_hash) = expected_hash else {
        return false;
    };
    canonicalize_expected_content_hash(expected_hash) != actual_hash
}

/// Returns `(content, effective_relative_path)`. When the direct path doesn't
/// exist but a workspace-aware fallback finds the file under a sub-workspace
/// prefix, `effective_relative_path` is the prefixed path (e.g.
/// `atls-studio/src/foo.ts` instead of bare `src/foo.ts`), ensuring downstream
/// writes target the correct location.
pub(crate) fn load_draft_base_content(project_root: &std::path::Path, file: &str) -> Result<(String, String), String> {
    let trimmed = file.trim();
    if trimmed.is_empty() || trimmed.starts_with("h:") {
        return Err(format!("Edit target file not found: {}", file));
    }
    let resolved_path = resolve_project_path(project_root, trimmed);
    if let Ok(content) = std::fs::read_to_string(&resolved_path) {
        return Ok((normalize_line_endings(&content), trimmed.to_string()));
    }
    if let Some((fallback_path, effective_rel)) = crate::path_utils::resolve_source_file_with_fallback(project_root, trimmed) {
        return std::fs::read_to_string(&fallback_path)
            .map(|content| (normalize_line_endings(&content), effective_rel))
            .map_err(|err| format!("Failed to read edit target {}: {}", trimmed, err));
    }
    Err(format!("Edit target file not found: {}", file))
}

pub(crate) async fn maybe_format_go_after_write(
    resolved_path: &std::path::Path,
) -> Option<String> {
    let path_str = resolved_path.to_string_lossy().to_string();
    if !path_str.ends_with(".go") {
        return None;
    }

    let working_dir = resolved_path.parent()?.to_path_buf();
    let cmd = if cfg!(windows) {
        format!(
            "$ErrorActionPreference='SilentlyContinue'; goimports -w \"{}\"; if ($LASTEXITCODE -ne 0) {{ gofmt -w \"{}\" }}",
            path_str, path_str
        )
    } else {
        format!("goimports -w \"{}\" 2>/dev/null || gofmt -w \"{}\"", path_str, path_str)
    };

    match run_shell_cmd_async(cmd, working_dir, 10).await {
        Ok(output) if output.status.success() => std::fs::read_to_string(resolved_path)
            .ok()
            .map(|content| normalize_line_endings(&content)),
        _ => None,
    }
}

#[cfg(test)]
mod draft_hash_tests {
    use super::{
        apply_exact_span_edit, build_authority_mismatch_diagnostic, build_draft_nonblocking_stale_warning,
        canonicalize_expected_content_hash,
        parse_exact_span_range, should_emit_line_edit_stale_warning,
    };

    #[test]
    fn canonicalizes_hash_refs_for_draft_matching() {
        assert_eq!(canonicalize_expected_content_hash("h:aabbccdd:10-12"), "aabbccdd");
    }

    #[test]
    fn stale_warning_uses_canonical_hash_comparison() {
        assert!(should_emit_line_edit_stale_warning(false, Some("h:aabbccdd"), "aabbccddeeff0011"));
    }

    #[test]
    fn returns_nonblocking_warning_for_stale_draft_hash() {
        let warning = build_draft_nonblocking_stale_warning(
            "src/demo.ts",
            "h:deadbeef",
            "aabbccddeeff0011",
            "draft followed current file content instead of blocking on stale hash",
        );

        assert_eq!(warning["warning"].as_str(), Some("stale_hash_followed_latest"));
        assert_eq!(warning["error_class"].as_str(), Some("stale_hash"));
        assert_eq!(warning["expected_hash"].as_str(), Some("deadbeef"));
        assert_eq!(warning["actual_hash"].as_str(), Some("aabbccddeeff0011"));
        assert_eq!(warning["applied_against_latest"].as_bool(), Some(true));
    }

    #[test]
    fn returns_authority_mismatch_diagnostic() {
        let warning = build_authority_mismatch_diagnostic(
            "src/demo.ts",
            "h:deadbeef:sig",
            "aabbccddeeff0011",
            "same bytes, different authority",
        );

        assert_eq!(warning["warning"].as_str(), Some("authority_mismatch"));
        assert_eq!(warning["error_class"].as_str(), Some("authority_mismatch"));
        assert_eq!(warning["expected_hash"].as_str(), Some("deadbeef"));
        assert_eq!(warning["actual_hash"].as_str(), Some("aabbccddeeff0011"));
        assert_eq!(warning["stale_hash_root_cause"].as_str(), Some("authority_mismatch"));
    }

    #[test]
    fn parses_nested_exact_span_ranges() {
        let value = serde_json::json!([[10, 12]]);
        assert_eq!(parse_exact_span_range(Some(&value)), Some((10, 12)));
    }

    #[test]
    fn exact_span_edits_only_replace_the_targeted_range() {
        let base = "first\nshared\nmiddle\nshared\nlast\n";
        let replaced = apply_exact_span_edit(base, "shared\nmiddle", "updated", (2, 3))
            .expect("expected exact span replace");
        assert_eq!(replaced, "first\nupdated\nshared\nlast\n");
    }

    #[test]
    fn exact_span_edits_fail_when_old_text_only_matches_outside_the_target_range() {
        let base = "first\nshared\nmiddle\nshared\nlast\n";
        assert!(matches!(
            apply_exact_span_edit(base, "shared\nlast", "updated", (2, 3)),
            Err(_)
        ));
    }

    #[test]
    fn always_emits_stale_warning_regardless_of_refresh() {
        assert!(should_emit_line_edit_stale_warning(
            true,
            Some("stale-hash"),
            "fresh-hash"
        ), "should emit even when content_hash_refreshed is true");
        assert!(should_emit_line_edit_stale_warning(
            false,
            Some("stale-hash"),
            "fresh-hash"
        ));
        assert!(!should_emit_line_edit_stale_warning(
            true,
            Some("matching-hash"),
            "matching-hash"
        ), "should not emit when hashes match");
    }
}

#[cfg(test)]
mod edit_dispatch_tests {
    use super::resolve_edit_operation;
    use serde_json::json;

    #[test]
    fn non_edit_passthrough() {
        let (op, p) = resolve_edit_operation("context".into(), json!({}));
        assert_eq!(op, "context");
        assert_eq!(p, json!({}));
    }

    #[test]
    fn edit_non_object_unchanged() {
        let (op, p) = resolve_edit_operation("edit".into(), json!("raw"));
        assert_eq!(op, "edit");
        assert_eq!(p, json!("raw"));
    }

    #[test]
    fn edit_undo() {
        let (op, p) = resolve_edit_operation("edit".into(), json!({"undo": "h:x"}));
        assert_eq!(op, "undo");
        assert!(p.get("undo").is_some());
    }

    #[test]
    fn edit_revise_moves_hash() {
        let (op, p) = resolve_edit_operation(
            "edit".into(),
            json!({"revise": "h:abc", "line_edits": []}),
        );
        assert_eq!(op, "revise");
        assert_eq!(p.get("hash"), Some(&json!("h:abc")));
        assert!(p.get("revise").is_none());
    }

    #[test]
    fn edit_deletes_to_delete_files() {
        let (op, p) = resolve_edit_operation("edit".into(), json!({"deletes": ["a.ts"]}));
        assert_eq!(op, "delete_files");
        assert_eq!(p.get("file_paths"), Some(&json!(["a.ts"])));
        assert!(p.get("deletes").is_none());
    }

    #[test]
    fn edit_empty_deletes_is_draft() {
        let (op, _) = resolve_edit_operation("edit".into(), json!({"deletes": []}));
        assert_eq!(op, "draft");
    }

    #[test]
    fn edit_batch_edits_mode() {
        let (op, _) = resolve_edit_operation(
            "edit".into(),
            json!({"mode": "batch_edits", "edits": [{"f": 1}]}),
        );
        assert_eq!(op, "batch_edits");
    }
}
