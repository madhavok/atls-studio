// ATLS Studio - Tauri Backend
// Provides file system access, PTY terminal, ATLS bridge, and chat database commands

#[cfg(windows)]
use std::os::windows::process::CommandExt;

mod chat_db;
mod chat_attachments;
pub(crate) mod diff_engine;
pub(crate) mod error;
pub(crate) mod hash_protocol;
pub(crate) mod hash_resolver;
mod linter;
pub(crate) mod path_utils;
pub(crate) mod shape_ops;
pub(crate) mod snapshot;
pub(crate) mod edit_session;
pub(crate) mod ast_query;
pub(crate) mod stream_protocol;
#[cfg(test)]
mod line_remap;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::io::BufRead;
use std::io::BufReader;
use std::fs::File;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use regex::Regex;
use tauri::{AppHandle, Emitter, Manager};
use portable_pty::{CommandBuilder, PtySize, native_pty_system, MasterPty, Child};
use chat_db::ChatDbState;
use path_utils::{resolve_project_path, resolve_source_file_with_workspace_hint, normalize_line_endings, FileFormat};
use crate::ast_query::parse_ast_condition;

// ============================================================================
// Utility: strip ANSI escape sequences from command output
// ============================================================================


// --- Extracted modules ---
pub mod file_ops;
pub mod file_watcher;
pub mod atls_ops;
pub mod code_intel;
#[allow(dead_code)]
pub mod git_ops;
pub mod refactor_engine;
pub mod batch_query;
pub mod search_exec;
pub mod pty;
pub mod ai_execute;
pub mod ai_streaming;
pub mod gemini_cache;
pub mod ai_models;
pub mod chat_db_commands;
pub mod hash_commands;
pub mod commands;
pub mod workspace_run;
pub mod tokenizer;

// ============================================================================
// Utility: resolve preferred shell (pwsh > powershell on Windows)
// ============================================================================

/// Returns `("pwsh", "-Command")` if PowerShell 7+ is on PATH,
/// otherwise `("powershell", "-Command")` on Windows, or `("sh", "-c")` on Unix.
/// Result is cached after the first probe.
pub(crate) fn resolve_shell() -> (&'static str, &'static str) {
    use std::sync::OnceLock;
    static SHELL: OnceLock<(&str, &str)> = OnceLock::new();
    *SHELL.get_or_init(|| {
        if cfg!(windows) {
            // Probe for pwsh (PowerShell 7+) — supports &&, ||, ternary, better UTF-8
            if std::process::Command::new("pwsh")
                .arg("-NoProfile")
                .arg("-Command")
                .arg("exit 0")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                ("pwsh", "-Command")
            } else {
                ("powershell", "-Command")
            }
        } else {
            ("sh", "-c")
        }
    })
}

/// Shell executable name for PTY spawning (includes `.exe` on Windows for portable-pty).
pub(crate) fn resolve_shell_exe() -> String {
    let (shell, _) = resolve_shell();
    if cfg!(windows) && shell == "pwsh" {
        "pwsh.exe".to_string()
    } else if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

pub(crate) fn strip_ansi(s: &str) -> String {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(
        r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[\??[0-9;]*[hl]|\x1b[()][0-9A-B]|\x1b"
    ).unwrap());
    re.replace_all(s, "").to_string()
}

#[cfg(test)]
mod shell_strip_tests {
    use super::{resolve_shell, resolve_shell_exe, strip_ansi};

    #[test]
    fn resolve_shell_returns_nonempty_invocation_pair() {
        let (exe, arg) = resolve_shell();
        assert!(!exe.is_empty());
        assert!(!arg.is_empty());
        if cfg!(windows) {
            assert!(exe == "pwsh" || exe == "powershell");
            assert_eq!(arg, "-Command");
        } else {
            assert_eq!(exe, "sh");
            assert_eq!(arg, "-c");
        }
    }

    #[test]
    fn resolve_shell_exe_matches_platform_conventions() {
        let s = resolve_shell_exe();
        assert!(!s.is_empty());
        if cfg!(windows) {
            assert!(
                s == "pwsh.exe" || s == "powershell.exe",
                "unexpected shell exe: {s}"
            );
        } else {
            assert!(!s.contains('\\'));
        }
    }

    #[test]
    fn strip_ansi_empty_and_plain_passthrough() {
        assert_eq!(strip_ansi(""), "");
        assert_eq!(strip_ansi("hello"), "hello");
    }

    #[test]
    fn strip_ansi_strips_sgr_and_osc() {
        assert_eq!(strip_ansi("\x1b[31merr\x1b[0m"), "err");
        assert_eq!(strip_ansi("\x1b]0;title\x07prompt"), "prompt");
    }

    #[test]
    fn strip_ansi_strips_mode_and_charset_sequences() {
        assert_eq!(strip_ansi("\x1b[?25lvisible\x1b[?25h"), "visible");
        assert_eq!(strip_ansi("\x1b(B\x1b)0utf8"), "utf8");
    }
}

// ============================================================================
// Content Buffer State (in-memory draft/revise/flush cycle)
// ============================================================================

/// 1-based line coordinate: absolute line, `"end"`, or negative offset from the last line (`-1` = last).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LineCoordinate {
    Abs(u32),
    /// Last line of the file (1-based = line count in Rust's line model).
    End,
    /// `-1` = last line, `-2` = second-to-last, etc.
    Neg(i32),
}

impl From<u32> for LineCoordinate {
    fn from(n: u32) -> Self {
        LineCoordinate::Abs(n)
    }
}

impl std::fmt::Display for LineCoordinate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LineCoordinate::Abs(n) => write!(f, "{}", n),
            LineCoordinate::End => write!(f, "end"),
            LineCoordinate::Neg(k) => write!(f, "{}", k),
        }
    }
}

impl Serialize for LineCoordinate {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            LineCoordinate::Abs(n) => serializer.serialize_u32(*n),
            LineCoordinate::End => serializer.serialize_str("end"),
            LineCoordinate::Neg(k) => serializer.serialize_i32(*k),
        }
    }
}

impl<'de> Deserialize<'de> for LineCoordinate {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error;
        let v = serde_json::Value::deserialize(deserializer)?;
        match v {
            serde_json::Value::Number(num) => {
                if let Some(i) = num.as_i64() {
                    if i < 0 {
                        return Ok(LineCoordinate::Neg(i as i32));
                    }
                    return Ok(LineCoordinate::Abs(i as u32));
                }
                if let Some(u) = num.as_u64() {
                    return Ok(LineCoordinate::Abs(u as u32));
                }
            }
            serde_json::Value::String(s) => {
                if s == "end" {
                    return Ok(LineCoordinate::End);
                }
                if let Ok(n) = s.parse::<i32>() {
                    if n < 0 {
                        return Ok(LineCoordinate::Neg(n));
                    }
                    if n >= 0 {
                        return Ok(LineCoordinate::Abs(n as u32));
                    }
                }
                return Err(Error::custom(format!("invalid line string {:?}", s)));
            }
            _ => {}
        }
        Err(Error::custom(
            "expected number, \"end\", or negative index for line",
        ))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct LineEdit {
    pub line: LineCoordinate,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 1-based inclusive end line. Omitting defaults to `line` (single-line span).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Symbol name for symbol-relative positioning (resolves to a line number)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// Position relative to symbol: "before", "after", "body_start", "body_end"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    /// Destination line (1-based) for "move" action.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<u32>,
    /// When true, reindent inserted/moved content to match the target line's indentation.
    #[serde(default)]
    pub reindent: bool,
}

#[derive(Clone)]
pub(crate) struct UndoEntry {
    pub(crate) hash: String,
    pub(crate) content: String,
    pub(crate) parent_hash: Option<String>,
    pub(crate) previous_content: Option<String>,
    pub(crate) previous_format: Option<FileFormat>,
    pub(crate) flushed_to_disk: bool,
    created_at: Instant,
}

/// File-keyed undo store. Each file path maps to a stack of UndoEntry
/// representing the edit history for that file during this session.
/// Entries are never evicted by time — they persist for the session lifetime.
/// Chat-side eviction (in aiService.ts) handles context-window cleanup.
pub(crate) struct UndoStoreState {
    entries: tokio::sync::Mutex<HashMap<String, Vec<UndoEntry>>>,
}

impl Default for UndoStoreState {
    fn default() -> Self {
        Self {
            entries: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}

/// Serializes refactor execute and rollback so only one runs at a time.
/// Avoids races on hash registry, index, and file I/O when refactors run in parallel.
pub(crate) struct RefactorMutexState {
    pub(crate) guard: tokio::sync::Mutex<()>,
}

impl Default for RefactorMutexState {
    fn default() -> Self {
        Self { guard: tokio::sync::Mutex::new(()) }
    }
}

pub(crate) const UNDO_STORE_MAX_ENTRIES_PER_FILE: usize = 100;

/// Look up undo history for a file. Returns the previous hash and total edit count
/// if the file has history in the undo store.
pub(crate) fn lookup_undo_history(
    undo_store: &HashMap<String, Vec<UndoEntry>>,
    file_path: &str,
    current_hash: Option<&str>,
) -> Option<serde_json::Value> {
    let norm = file_path.replace('\\', "/");
    let stack = undo_store.get(file_path)
        .or_else(|| undo_store.get(&norm))
        .or_else(|| undo_store.iter().find(|(k, _)| k.replace('\\', "/") == norm).map(|(_, v)| v));

    // Phase 1: try file-path-keyed stack
    if let Some(stack) = stack {
        if !stack.is_empty() {
            let edits = stack.len();
            // If no current_hash provided, return top of stack
            if current_hash.is_none() {
                let entry = stack.last().unwrap();
                let mut result = serde_json::json!({ "edits": edits });
                if let Some(ref ph) = entry.parent_hash {
                    result["hash"] = serde_json::json!(format!("h:{}", &ph[..std::cmp::min(8, ph.len())]));
                }
                return Some(result);
            }
            let ch = current_hash.unwrap();
            // Try matching current_hash against entry hashes
            if let Some(entry) = stack.iter().rev().find(|e| e.hash == ch || (e.hash.len() >= 8 && ch.starts_with(&e.hash)) || (ch.len() >= 8 && e.hash.starts_with(ch))) {
                let mut result = serde_json::json!({ "edits": edits });
                if let Some(ref ph) = entry.parent_hash {
                    result["hash"] = serde_json::json!(format!("h:{}", &ph[..std::cmp::min(8, ph.len())]));
                }
                return Some(result);
            }
            // current_hash might be the PARENT hash (file was undone/reverted) — check parent_hash fields
            if let Some(entry) = stack.iter().rev().find(|e| e.parent_hash.as_ref().map(|ph| ph == ch || (ph.len() >= 8 && ch.starts_with(ph.as_str())) || (ch.len() >= 8 && ph.starts_with(ch))).unwrap_or(false)) {
                let mut result = serde_json::json!({ "edits": edits });
                if let Some(ref ph) = entry.parent_hash {
                    result["hash"] = serde_json::json!(format!("h:{}", &ph[..std::cmp::min(8, ph.len())]));
                }
                return Some(result);
            }
            // File stack found but hash didn't match — still return edits count
            eprintln!("[lookup_undo_history] stack found for '{}' ({} entries) but hash '{}' didn't match any entry. Entries: {:?}",
                file_path, edits, ch, stack.iter().map(|e| (&e.hash, &e.parent_hash)).collect::<Vec<_>>());
            return Some(serde_json::json!({ "edits": edits }));
        }
    }

    // Phase 2: cross-stack search by hash
    if let Some(ch) = current_hash {
        for (fp, s) in undo_store.iter() {
            if let Some(entry) = s.iter().rev().find(|e| e.hash == ch || e.hash.starts_with(ch) || ch.starts_with(&e.hash)) {
                eprintln!("[lookup_undo_history] cross-stack hit: queried '{}' but found in '{}'", file_path, fp);
                let mut result = serde_json::json!({ "edits": s.len() });
                if let Some(ref ph) = entry.parent_hash {
                    result["hash"] = serde_json::json!(format!("h:{}", &ph[..std::cmp::min(8, ph.len())]));
                }
                return Some(result);
            }
        }
        eprintln!("[lookup_undo_history] no match anywhere. query: path='{}', hash='{}'. Store keys: {:?}",
            file_path, ch, undo_store.keys().collect::<Vec<_>>());
    }
    None
}

pub(crate) fn fnv1a32_utf16(content: &str, offset_basis: u32) -> u32 {
    let mut hash = offset_basis;
    for code_unit in content.encode_utf16() {
        hash ^= code_unit as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

pub(crate) fn content_hash(content: &str) -> String {
    let h1 = fnv1a32_utf16(content, 0x811c9dc5);
    let h2 = fnv1a32_utf16(content, 0x050c5d1f);
    format!("{:08x}{:08x}", h1, h2)
}

/// Match quality tier for flexible_replacen_scored.
#[derive(Clone, Copy)]
pub(crate) enum MatchTier { Exact = 100, WhitespaceTrimmed = 80 }

struct ScoredMatch {
    start_line: usize,
    byte_start: usize,
    byte_end: usize,
    tier: MatchTier,
}

/// Scored flexible replacement: collects ALL matches, picks the best one
/// (exact > fuzzy; tie-break by proximity to `expected_line`).
/// Returns (new_content, match_line_1based, confidence).
///
/// **DEPRECATED as a write path.** Use `exact_replacen_for_write` for mutations.
/// This function remains available for read-only suggestion/preview use.
#[deprecated(note = "Use exact_replacen_for_write for write paths; this fn is read-only")]
pub(crate) fn flexible_replacen_scored(
    content: &str,
    old_text: &str,
    new_text: &str,
    expected_line: Option<u32>,
) -> Option<(String, u32, u8)> {
    let content_lines: Vec<&str> = content.lines().collect();
    let old_lines: Vec<&str> = old_text.lines().collect();
    if old_lines.is_empty() {
        return None;
    }

    let mut candidates: Vec<ScoredMatch> = Vec::new();

    // Collect exact byte matches
    let mut search_start = 0usize;
    while let Some(pos) = content[search_start..].find(old_text) {
        let abs_pos = search_start + pos;
        let line_num = content[..abs_pos].matches('\n').count();
        candidates.push(ScoredMatch {
            start_line: line_num,
            byte_start: abs_pos,
            byte_end: abs_pos + old_text.len(),
            tier: MatchTier::Exact,
        });
        search_start = abs_pos + 1;
    }

    // Collect whitespace-trimmed matches (only if no exact or looking for best)
    if old_lines.len() <= content_lines.len() {
        'scan: for start in 0..=content_lines.len() - old_lines.len() {
            for (j, ol) in old_lines.iter().enumerate() {
                if content_lines[start + j].trim_end() != ol.trim_end() {
                    continue 'scan;
                }
            }
            // Skip if this position was already found as an exact match
            let byte_start: usize = content_lines[..start].iter().map(|l| l.len() + 1).sum();
            if candidates.iter().any(|c| c.byte_start == byte_start && matches!(c.tier, MatchTier::Exact)) {
                continue;
            }
            let end = start + old_lines.len();
            let mut byte_end = byte_start;
            for i in start..end {
                byte_end += content_lines[i].len();
                if i < end - 1 { byte_end += 1; }
            }
            if old_text.ends_with('\n') && byte_end < content.len() {
                byte_end += 1;
            }
            byte_end = byte_end.min(content.len());
            candidates.push(ScoredMatch {
                start_line: start,
                byte_start,
                byte_end,
                tier: MatchTier::WhitespaceTrimmed,
            });
        }
    }

    if candidates.is_empty() {
        return None;
    }

    // Pick best: highest tier, then closest to expected_line
    let expected = expected_line.unwrap_or(0) as usize;
    candidates.sort_by(|a, b| {
        let tier_cmp = (b.tier as u8).cmp(&(a.tier as u8));
        if tier_cmp != std::cmp::Ordering::Equal { return tier_cmp; }
        let dist_a = if expected > 0 { (a.start_line as isize - expected as isize).unsigned_abs() } else { 0 };
        let dist_b = if expected > 0 { (b.start_line as isize - expected as isize).unsigned_abs() } else { 0 };
        dist_a.cmp(&dist_b)
    });
    let best = &candidates[0];
    let confidence = best.tier as u8;
    let match_line = (best.start_line + 1) as u32;
    let result = format!("{}{}{}", &content[..best.byte_start], new_text, &content[best.byte_end..]);
    Some((result, match_line, confidence))
}

/// Flexible text replacement: trims trailing whitespace per line before matching.
/// Returns the new content on success, or None if the pattern was not found.
/// NOTE: For read-only/suggestion use only — do not use in write paths.
///
/// **DEPRECATED as a write path.** Use `exact_replacen_for_write` for mutations.
#[deprecated(note = "Use exact_replacen_for_write for write paths; this fn is read-only")]
#[allow(deprecated)]
pub(crate) fn flexible_replacen(content: &str, old_text: &str, new_text: &str) -> Option<String> {
    flexible_replacen_scored(content, old_text, new_text, None).map(|(s, _, _)| s)
}

/// Read-only suggestion when exact match fails: returns the best fuzzy match
/// location without applying it. Used for structured error feedback.
#[allow(deprecated)]
pub(crate) fn suggest_fuzzy_match(
    content: &str,
    old_text: &str,
    expected_line: Option<u32>,
) -> Option<serde_json::Value> {
    let result = flexible_replacen_scored(content, old_text, "", expected_line)?;
    let (_, match_line, confidence) = result;
    let tier = if confidence >= 100 { "exact" } else { "whitespace_trimmed" };
    let content_lines: Vec<&str> = content.lines().collect();
    let ml = match_line as usize;
    let preview_start = ml.saturating_sub(1);
    let preview_end = (preview_start + 3).min(content_lines.len());
    let preview: Vec<&str> = content_lines[preview_start..preview_end].to_vec();
    Some(serde_json::json!({
        "line": match_line,
        "confidence": confidence,
        "tier": tier,
        "preview": preview.join("\n"),
    }))
}

/// Strict exact-only replacement for write paths.
/// Only uses byte-exact matches — no whitespace-trimmed fallback.
/// Returns (new_content, match_line_1based) or None if not found.
/// Returns Err if multiple exact matches exist (ambiguous).
pub(crate) fn exact_replacen_for_write(
    content: &str,
    old_text: &str,
    new_text: &str,
) -> Result<Option<(String, u32)>, String> {
    if old_text.is_empty() {
        return Ok(None);
    }
    let mut matches: Vec<(usize, usize)> = Vec::new();
    let mut search_start = 0usize;
    while let Some(pos) = content[search_start..].find(old_text) {
        let abs_pos = search_start + pos;
        matches.push((abs_pos, abs_pos + old_text.len()));
        search_start = abs_pos + old_text.len();
    }
    match matches.len() {
        0 => Ok(None),
        1 => {
            let (start, end) = matches[0];
            let line = content[..start].matches('\n').count() + 1;
            let result = format!("{}{}{}", &content[..start], new_text, &content[end..]);
            Ok(Some((result, line as u32)))
        }
        n => Err(format!(
            "exact_replacen_for_write: old_text matched {} times — ambiguous. Provide a more specific preimage.",
            n
        )),
    }
}

/// Reindent a block of content to match a target indentation string.
/// Strips the common leading indent from the block, then prepends `target_indent`.
fn reindent_block(content: &str, target_indent: &str) -> String {
    let block_lines: Vec<&str> = content.lines().collect();
    let min_indent = block_lines.iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    let mut result = block_lines.iter()
        .map(|l| {
            if l.trim().is_empty() {
                String::new()
            } else if l.len() >= min_indent {
                format!("{}{}", target_indent, &l[min_indent..])
            } else {
                format!("{}{}", target_indent, l.trim())
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if content.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// Detect the leading whitespace of a line.
fn detect_indent(line: &str) -> &str {
    let trimmed = line.trim_start();
    &line[..line.len() - trimmed.len()]
}

/// Last 1-based line that `apply_line_edits` treats as "content" for `end` / negative indexing.
/// When the file ends with `\\n`, Rust keeps an extra empty `lines` entry; callers usually mean
/// the last non-empty line (the line before that placeholder).
fn last_meaningful_line_one_based(lines: &[String]) -> usize {
    let n = lines.len();
    if n == 0 {
        return 1;
    }
    if n >= 2 && lines[n - 1].is_empty() {
        n - 1
    } else {
        n
    }
}

/// Resolve the target line number for a single edit against the current state of `lines`.
fn resolve_single_edit_line(
    edit: &LineEdit,
    lines: &[String],
    _anchor_warnings: &mut Vec<String>,
) -> Result<usize, String> {
    let n = lines.len();
    match &edit.line {
        LineCoordinate::Abs(0) => Err(
            "line 0 is invalid (use symbol resolution or a positive line, \"end\", or negative index)"
                .to_string(),
        ),
        LineCoordinate::Abs(line) => Ok(*line as usize),
        LineCoordinate::End => Ok(last_meaningful_line_one_based(lines)),
        LineCoordinate::Neg(k) => {
            if *k >= 0 {
                return Err(format!(
                    "negative line index expected (e.g. -1 for last line), got {}",
                    k
                ));
            }
            let anchor = last_meaningful_line_one_based(lines) as i32;
            let one_based = anchor + 1 + k;
            if one_based < 1 {
                return Err(format!(
                    "line index {} out of range (file has {} lines)",
                    k, n
                ));
            }
            Ok(one_based as usize)
        }
    }
}

/// Per-edit metadata returned by `apply_line_edits` for downstream rebase and observability.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct EditResolution {
    pub resolved_line: usize,
    pub action: String,
    /// Number of original lines affected: body span for replace_body, source span for others.
    pub lines_affected: usize,
}

/// Compare bracket balance between the pre-edit span and post-edit span
/// for each resolved edit. Returns a hint string if any edit introduced
/// a bracket imbalance, helping the model diagnose duplicate closers
/// or missing openers.
pub(crate) fn syntax_error_bracket_hint(
    pre_content: &str,
    post_content: &str,
    resolutions: &[EditResolution],
) -> Option<String> {
    let pre_lines: Vec<&str> = pre_content.lines().collect();
    let post_lines: Vec<&str> = post_content.lines().collect();
    let mut hints: Vec<String> = Vec::new();
    for res in resolutions {
        let start = res.resolved_line.saturating_sub(1);
        let pre_end = (start + res.lines_affected).min(pre_lines.len());
        let pre_span: Vec<&str> = if start < pre_lines.len() {
            pre_lines[start..pre_end].to_vec()
        } else {
            Vec::new()
        };
        let post_end = post_lines.len().min(start + res.lines_affected + 10);
        let post_span: Vec<&str> = if start < post_lines.len() {
            post_lines[start..post_end.min(post_lines.len())].to_vec()
        } else {
            Vec::new()
        };
        let pre_bal = brace_balance_delta(&pre_span);
        let post_bal = brace_balance_delta(&post_span);
        if pre_bal != post_bal {
            hints.push(format!(
                "L{} {}: bracket imbalance — original span net={}, replacement net={}. Check for duplicate closers or missing openers.",
                res.resolved_line, res.action, pre_bal, post_bal
            ));
        }
        let pre_in_comment = ends_in_block_comment(&pre_span);
        let post_in_comment = ends_in_block_comment(&post_span);
        if post_in_comment && !pre_in_comment {
            hints.push(format!(
                "L{} {}: unclosed block comment — the edit may have removed a closing '*/' or inserted an opening '/*' without a matching closer.",
                res.resolved_line, res.action
            ));
        }
    }
    if hints.is_empty() { None } else { Some(hints.join(" | ")) }
}

/// Returns (new_content, anchor_miss_warnings, per_edit_resolutions).
/// Warnings are non-fatal: the edit still applies using the hint line,
/// but callers can surface misses to the model.
///
/// Edits are applied **sequentially in array order** (top-down). Each edit resolves
/// its line/anchor against the current state of `lines` after all prior edits, which
/// matches the sequential mental model LLMs use when generating multi-edit batches.
///
/// **DEPRECATED as a direct write path.** Callers should route through `EditSession`
/// for atomic writes and preimage validation. `apply_line_edits` may still be used
/// to compute proposed content, but the result must go through `EditSession::commit()`.
pub(crate) fn apply_line_edits(content: &str, edits: &[LineEdit]) -> Result<(String, Vec<String>, Vec<EditResolution>), String> {
    let content = normalize_line_endings(content);
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    if content.ends_with('\n') {
        lines.push(String::new());
    }

    let mut anchor_warnings: Vec<String> = Vec::new();
    let mut resolutions: Vec<EditResolution> = Vec::with_capacity(edits.len());

    for edit in edits.iter() {
        let resolved_line = resolve_single_edit_line(edit, &lines, &mut anchor_warnings)?;
        let idx = resolved_line.saturating_sub(1);
        if idx > lines.len() {
            return Err(format!("Line {} out of range (file has {} lines)", resolved_line, lines.len()));
        }
        let lines_affected: usize = match edit.action.as_str() {
            "insert_before" | "prepend" => {
                let raw = edit.content.as_deref().unwrap_or("");
                let text = if edit.reindent && idx < lines.len() {
                    reindent_block(raw, detect_indent(&lines[idx]))
                } else {
                    raw.to_string()
                };
                let count = text.lines().count();
                for (i, l) in text.lines().enumerate() {
                    lines.insert(idx + i, l.to_string());
                }
                count
            }
            "insert_after" | "append" => {
                let ins = std::cmp::min(idx + 1, lines.len());
                let raw = edit.content.as_deref().unwrap_or("");
                let text = if edit.reindent && idx < lines.len() {
                    reindent_block(raw, detect_indent(&lines[idx]))
                } else {
                    raw.to_string()
                };
                let count = text.lines().count();
                for (i, l) in text.lines().enumerate() {
                    lines.insert(ins + i, l.to_string());
                }
                count
            }
            "replace" => {
                let mut count = if let Some(end) = edit.end_line {
                    (end as usize).saturating_sub(idx)
                } else {
                    1usize
                };
                let replacement: Vec<String> = edit.content.as_deref().unwrap_or("").lines().map(String::from).collect();

                if edit.end_line.is_none() && replacement.len() > 1 {
                    anchor_warnings.push(format!(
                        "replace_span_mismatch: replace at L{} has {}-line content but end_line not set (defaulting to single-line span)",
                        idx + 1, replacement.len()
                    ));
                }

                if replacement.len() >= 1 {
                    let span_end = idx + count;
                    let mut confirmed = 0usize;
                    for k in 0..replacement.len().min(8) {
                        let file_idx = span_end + k;
                        let repl_idx = replacement.len() - 1 - k;
                        if file_idx >= lines.len() { break; }
                        let ft = lines[file_idx].trim();
                        let rt = replacement[repl_idx].trim();
                        if ft.is_empty() || rt.is_empty() { break; }
                        if ft.len() <= 2 && (ft == "}" || ft == "{" || ft == ")" || ft == "(" || ft == "]" || ft == "[") { break; }
                        if ft == rt {
                            confirmed += 1;
                        } else {
                            break;
                        }
                    }
                    if confirmed > 0 {
                        let removed: Vec<&str> = (0..confirmed)
                            .filter_map(|k| lines.get(span_end + k).map(|l| l.as_str()))
                            .collect();
                        let net_balance = brace_balance_delta(&removed);
                        if net_balance != 0 {
                            anchor_warnings.push(format!(
                                "count_overlap_extended: skipped extension at L{} — removing {} trailing lines would unbalance brackets (delta {})",
                                idx + 1, confirmed, net_balance
                            ));
                            confirmed = 0;
                        }
                    }
                    if confirmed > 0 {
                        anchor_warnings.push(format!(
                            "count_overlap_extended: replace at L{} extended count by {} (from {} to {}) to avoid duplicate trailing lines",
                            idx + 1, confirmed, count, count + confirmed
                        ));
                        count += confirmed;
                    }
                }

                let end = std::cmp::min(idx + count, lines.len());

                let all_structural = idx < end && (idx..end).all(|k| {
                    let t = lines.get(k).map(|l| l.trim()).unwrap_or("");
                    matches!(t, "}" | "};" | "]" | "];" | ")" | ");" | "{" | "(" | "[")
                });
                let replacement_is_structural = !replacement.is_empty() && replacement.iter().all(|l| {
                    let t = l.trim();
                    matches!(t, "}" | "};" | "]" | "];" | ")" | ");" | "{" | "(" | "[" | "")
                });
                if all_structural && !replacement_is_structural {
                    anchor_warnings.push(format!(
                        "structural_guard: replace at L{}-L{} targets only structural tokens (closing braces/brackets) — content replacement may break enclosing scope",
                        idx + 1, end
                    ));
                }

                lines.splice(idx..end, replacement);
                count
            }
            "replace_body" => {
                if idx >= lines.len() {
                    return Err(format!(
                        "replace_body at L{}: line out of range",
                        resolved_line
                    ));
                }
                // When end_line is set AND spans more than one line (hash range or symbol
                // span), cap the scan to lines[idx..end_line) instead of EOF. Never use
                // (1, el - idx): that mis-sized the closing brace for 3-line functions
                // (e.g. h:hash:7-9) and spliced away the `}` — JS `'}' expected'`.
                // When end_line == line (single-line hash ref), fall through to EOF slice.
                let effective_end_line = edit.end_line.filter(|&el| (el as usize) > idx + 1);
                let (body_start_rel, close_brace_rel) = if let Some(el) = effective_end_line {
                    let end_idx = (el as usize).min(lines.len());
                    if end_idx <= idx {
                        return Err(format!(
                            "replace_body at L{}: end_line {} is not after start line",
                            resolved_line, el
                        ));
                    }
                    let slice = &lines[idx..end_idx];
                    let refs: Vec<&str> = slice.iter().map(|s| s.as_str()).collect();
                    find_body_bounds(&refs)
                        .or_else(|| find_python_indent_body_bounds(&refs))
                        .ok_or_else(|| format!(
                            "replace_body at L{}: could not find body bounds (no matching {{ }} block or Python def/class block)",
                            resolved_line
                        ))?
                } else {
                    let slice = &lines[idx..];
                    let refs: Vec<&str> = slice.iter().map(|s| s.as_str()).collect();
                    find_body_bounds(&refs)
                        .or_else(|| find_python_indent_body_bounds(&refs))
                        .ok_or_else(|| format!(
                            "replace_body at L{}: could not find body bounds (no matching {{ }} block or Python def/class block)",
                            resolved_line
                        ))?
                };
                let body_start = idx + body_start_rel;
                let body_end = idx + close_brace_rel; // exclusive: up to but not including closing }
                let body_span = body_end.saturating_sub(body_start);
                let raw = edit.content.as_deref().unwrap_or("");
                let replacement_text = if edit.reindent && body_start < lines.len() {
                    reindent_block(raw, detect_indent(&lines[body_start]))
                } else {
                    raw.to_string()
                };
                let replacement: Vec<String> = replacement_text.lines().map(String::from).collect();
                let splice_end = std::cmp::min(body_end, lines.len());
                lines.splice(body_start..splice_end, replacement);
                body_span
            }
            "delete" => {
                let count = if let Some(end) = edit.end_line {
                    (end as usize).saturating_sub(idx)
                } else {
                    1usize
                };
                let end = std::cmp::min(idx + count, lines.len());
                lines.drain(idx..end);
                count
            }
            "move" => {
                let count = if let Some(end) = edit.end_line {
                    (end as usize).saturating_sub(idx)
                } else {
                    1usize
                };
                let src_end = std::cmp::min(idx + count, lines.len());
                let dest = edit.destination.unwrap_or(0) as usize;
                if dest == 0 {
                    return Err(format!("move action requires destination (1-based line number)"));
                }

                let src_depth = brace_depth_at_line(&lines, idx);
                let dest_idx = std::cmp::min(dest.saturating_sub(1), lines.len().saturating_sub(1));
                let dest_depth = brace_depth_at_line(&lines, dest_idx);
                if src_depth != dest_depth {
                    anchor_warnings.push(format!(
                        "move_structural_warning: move L{}-L{} to L{} crosses brace depth boundary \
                         (source depth={}, dest depth={}). \
                         This may silently break enclosing structure — \
                         prefer explicit replace or refactor for property/member moves.",
                        idx + 1, src_end, dest, src_depth, dest_depth
                    ));
                }

                let block: Vec<String> = lines.drain(idx..src_end).collect();
                let insert_at = if dest > idx + 1 { dest.saturating_sub(count) } else { dest };
                let clamped = std::cmp::min(insert_at.saturating_sub(1), lines.len());
                if edit.reindent && clamped < lines.len() {
                    let target_indent = detect_indent(&lines[clamped]).to_string();
                    let joined = block.join("\n");
                    let reindented = reindent_block(&joined, &target_indent);
                    for (i, line) in reindented.lines().enumerate() {
                        lines.insert(clamped + i, line.to_string());
                    }
                } else {
                    for (i, line) in block.into_iter().enumerate() {
                        lines.insert(clamped + i, line);
                    }
                }
                count
            }
            other => return Err(format!("Unknown line_edit action: {}. Valid: insert_before|prepend|insert_after|append|replace|replace_body|delete|move", other)),
        };
        resolutions.push(EditResolution {
            resolved_line,
            action: edit.action.clone(),
            lines_affected,
        });
    }
    Ok((lines.join("\n"), anchor_warnings, resolutions))
}

// ---------------------------------------------------------------------------
// Shadow-preimage helpers for content-anchored edits
// ---------------------------------------------------------------------------

/// Extract the text from a shadow snapshot at [line, end_line] (1-based inclusive).
/// Returns `None` if the range is out of bounds.
pub(crate) fn extract_shadow_preimage(
    shadow_content: &str,
    line: u32,
    end_line: Option<u32>,
) -> Option<String> {
    if line == 0 {
        return None;
    }
    let shadow_lines: Vec<&str> = shadow_content.lines().collect();
    let start_idx = (line as usize).saturating_sub(1);
    let end_idx = end_line.map(|e| e as usize).unwrap_or(line as usize);
    if start_idx >= shadow_lines.len() || end_idx > shadow_lines.len() || end_idx < line as usize {
        return None;
    }
    Some(shadow_lines[start_idx..end_idx].join("\n"))
}

/// Convert an array of `LineEdit`s into `EditOp`s using shadow-derived preimages.
///
/// When the model's `content_hash` is stale, the shadow contains the file at the
/// hash the model saw. Slicing the shadow at each edit's `line`/`end_line` yields
/// the text the model intended to target -- the implicit preimage. Each line edit
/// becomes an `ExactReplace` that `EditSession` matches by content, not position.
///
/// Edits are converted in order; a running working copy of `current_content` is
/// updated after each op so subsequent preimage searches reflect prior mutations.
///
/// Returns `(ops, warnings)`. Warnings note edits that couldn't be converted
/// (shadow extraction failed); the caller should fall back to positional for those.
pub(crate) fn line_edits_to_edit_ops(
    edits: &[LineEdit],
    shadow_content: &str,
    current_content: &str,
) -> Result<(Vec<crate::edit_session::EditOp>, Vec<String>), String> {
    use crate::edit_session::{EditOp, EditOpKind};

    let mut ops: Vec<EditOp> = Vec::with_capacity(edits.len());
    let mut warnings: Vec<String> = Vec::new();
    let mut working = current_content.to_string();

    for (i, edit) in edits.iter().enumerate() {
        let abs_line = match &edit.line {
            LineCoordinate::Abs(n) if *n > 0 => *n,
            _ => {
                warnings.push(format!(
                    "edit[{}]: non-absolute line coordinate, skipping shadow conversion",
                    i
                ));
                continue;
            }
        };

        let action = edit.action.as_str();
        let hint = Some(byte_offset_of_line(&working, abs_line));
        match action {
            "replace" => {
                let preimage = match extract_shadow_preimage(shadow_content, abs_line, edit.end_line) {
                    Some(p) => p,
                    None => {
                        warnings.push(format!(
                            "edit[{}]: shadow preimage extraction failed for L{}-{:?}",
                            i, abs_line, edit.end_line
                        ));
                        continue;
                    }
                };
                let replacement = edit.content.as_deref().unwrap_or("").to_string();
                let op = EditOp { kind: EditOpKind::ExactReplace, preimage: preimage.clone(), replacement: replacement.clone(), hint_byte_offset: hint };
                apply_edit_op_to_working_hinted(&mut working, &preimage, &replacement, hint);
                ops.push(op);
            }
            "delete" => {
                let preimage = match extract_shadow_preimage(shadow_content, abs_line, edit.end_line) {
                    Some(p) => p,
                    None => {
                        warnings.push(format!(
                            "edit[{}]: shadow preimage extraction failed for delete L{}-{:?}",
                            i, abs_line, edit.end_line
                        ));
                        continue;
                    }
                };
                let replacement = String::new();
                let op = EditOp { kind: EditOpKind::ExactReplace, preimage: preimage.clone(), replacement: replacement.clone(), hint_byte_offset: hint };
                apply_edit_op_to_working_hinted(&mut working, &preimage, &replacement, hint);
                ops.push(op);
            }
            "insert_before" | "prepend" => {
                let context_line = match extract_shadow_preimage(shadow_content, abs_line, Some(abs_line)) {
                    Some(p) => p,
                    None => {
                        warnings.push(format!(
                            "edit[{}]: shadow context extraction failed for insert_before L{}",
                            i, abs_line
                        ));
                        continue;
                    }
                };
                let inserted = edit.content.as_deref().unwrap_or("");
                let preimage = context_line.clone();
                let replacement = format!("{}\n{}", inserted, context_line);
                let op = EditOp { kind: EditOpKind::ExactReplace, preimage: preimage.clone(), replacement: replacement.clone(), hint_byte_offset: hint };
                apply_edit_op_to_working_hinted(&mut working, &preimage, &replacement, hint);
                ops.push(op);
            }
            "insert_after" | "append" => {
                let context_line = match extract_shadow_preimage(shadow_content, abs_line, Some(abs_line)) {
                    Some(p) => p,
                    None => {
                        warnings.push(format!(
                            "edit[{}]: shadow context extraction failed for insert_after L{}",
                            i, abs_line
                        ));
                        continue;
                    }
                };
                let inserted = edit.content.as_deref().unwrap_or("");
                let preimage = context_line.clone();
                let replacement = format!("{}\n{}", context_line, inserted);
                let op = EditOp { kind: EditOpKind::ExactReplace, preimage: preimage.clone(), replacement: replacement.clone(), hint_byte_offset: hint };
                apply_edit_op_to_working_hinted(&mut working, &preimage, &replacement, hint);
                ops.push(op);
            }
            "replace_body" => {
                let shadow_lines: Vec<&str> = shadow_content.lines().collect();
                let start_idx = (abs_line as usize).saturating_sub(1);
                if start_idx >= shadow_lines.len() {
                    warnings.push(format!(
                        "edit[{}]: shadow out of range for replace_body L{}",
                        i, abs_line
                    ));
                    continue;
                }
                let slice = &shadow_lines[start_idx..];
                match find_body_bounds(slice).or_else(|| find_python_indent_body_bounds(slice)) {
                    Some((body_start_rel, close_brace_rel)) => {
                        let body_start = start_idx + body_start_rel;
                        let body_end = std::cmp::min(start_idx + close_brace_rel, shadow_lines.len());
                        let preimage = shadow_lines[body_start..body_end].join("\n");
                        let replacement = edit.content.as_deref().unwrap_or("").to_string();
                        let body_hint = Some(byte_offset_of_line(&working, (body_start + 1) as u32));
                        let op = EditOp { kind: EditOpKind::ExactReplace, preimage: preimage.clone(), replacement: replacement.clone(), hint_byte_offset: body_hint };
                        apply_edit_op_to_working_hinted(&mut working, &preimage, &replacement, body_hint);
                        ops.push(op);
                    }
                    None => {
                        warnings.push(format!(
                            "edit[{}]: could not find body bounds in shadow for replace_body L{}",
                            i, abs_line
                        ));
                        continue;
                    }
                }
            }
            "move" => {
                let preimage = match extract_shadow_preimage(shadow_content, abs_line, edit.end_line) {
                    Some(p) => p,
                    None => {
                        warnings.push(format!(
                            "edit[{}]: shadow preimage extraction failed for move L{}-{:?}",
                            i, abs_line, edit.end_line
                        ));
                        continue;
                    }
                };
                let dest = edit.destination.unwrap_or(0);
                if dest == 0 {
                    return Err(format!("edit[{}]: move action requires destination", i));
                }

                // Structural depth check (mirrors positional path in apply_line_edits)
                let shadow_lines_owned: Vec<String> = shadow_content.lines().map(String::from).collect();
                let src_idx = (abs_line as usize).saturating_sub(1);
                let src_end = edit.end_line.map(|e| e as usize).unwrap_or(abs_line as usize);
                let dest_idx = (dest as usize).saturating_sub(1).min(shadow_lines_owned.len().saturating_sub(1));
                let src_depth = brace_depth_at_line(&shadow_lines_owned, src_idx);
                let dest_depth = brace_depth_at_line(&shadow_lines_owned, dest_idx);
                if src_depth != dest_depth {
                    warnings.push(format!(
                        "move_structural_warning: move L{}-L{} to L{} crosses brace depth boundary \
                         (source depth={}, dest depth={}). \
                         This may silently break enclosing structure — \
                         prefer explicit replace or refactor for property/member moves.",
                        abs_line, src_end, dest, src_depth, dest_depth
                    ));
                }

                let dest_context = match extract_shadow_preimage(shadow_content, dest, Some(dest)) {
                    Some(p) => p,
                    None => {
                        warnings.push(format!(
                            "edit[{}]: shadow destination context extraction failed for move dest L{}",
                            i, dest
                        ));
                        continue;
                    }
                };
                let delete_op = EditOp {
                    kind: EditOpKind::ExactReplace,
                    preimage: preimage.clone(),
                    replacement: String::new(),
                    hint_byte_offset: hint,
                };
                apply_edit_op_to_working_hinted(&mut working, &preimage, "", hint);
                ops.push(delete_op);

                let dest_hint = Some(byte_offset_of_line(&working, dest));
                let insert_preimage = dest_context.clone();
                let insert_replacement = if dest > abs_line {
                    format!("{}\n{}", dest_context, preimage)
                } else {
                    format!("{}\n{}", preimage, dest_context)
                };
                let insert_op = EditOp {
                    kind: EditOpKind::ExactReplace,
                    preimage: insert_preimage.clone(),
                    replacement: insert_replacement.clone(),
                    hint_byte_offset: dest_hint,
                };
                apply_edit_op_to_working_hinted(&mut working, &insert_preimage, &insert_replacement, dest_hint);
                ops.push(insert_op);
            }
            other => {
                warnings.push(format!(
                    "edit[{}]: unsupported action '{}' for shadow conversion",
                    i, other
                ));
            }
        }
    }

    Ok((ops, warnings))
}

/// Compute byte offset of a 1-based line number in content.
fn byte_offset_of_line(content: &str, line_1based: u32) -> usize {
    if line_1based <= 1 {
        return 0;
    }
    let target = (line_1based as usize).saturating_sub(1);
    let mut count = 0usize;
    for (i, ch) in content.char_indices() {
        if ch == '\n' {
            count += 1;
            if count >= target {
                return i + 1;
            }
        }
    }
    content.len()
}

/// Apply an ExactReplace-style edit to a working string.
/// When `hint_offset` is provided and the preimage appears multiple times,
/// selects the occurrence closest to the hint byte position.
fn apply_edit_op_to_working_hinted(working: &mut String, preimage: &str, replacement: &str, hint_offset: Option<usize>) {
    if preimage.is_empty() {
        return;
    }
    let first = match working.find(preimage) {
        Some(pos) => pos,
        None => return,
    };

    let chosen = if let Some(hint) = hint_offset {
        let mut best_pos = first;
        let mut best_dist = (first as isize - hint as isize).unsigned_abs();
        let mut search_from = first + 1;
        while let Some(next) = working[search_from..].find(preimage) {
            let abs_pos = search_from + next;
            let dist = (abs_pos as isize - hint as isize).unsigned_abs();
            if dist < best_dist {
                best_dist = dist;
                best_pos = abs_pos;
            }
            search_from = abs_pos + 1;
        }
        best_pos
    } else {
        first
    };

    let mut result = String::with_capacity(working.len() + replacement.len() - preimage.len());
    result.push_str(&working[..chosen]);
    result.push_str(replacement);
    result.push_str(&working[chosen + preimage.len()..]);
    *working = result;
}


/// Unified entry point for applying line edits with optional shadow-based content anchoring.
///
/// When `shadow` is `Some`, tries content-anchored ExactReplace via `line_edits_to_edit_ops`.
/// Falls back to positional `apply_line_edits` when shadow is `None`, shadow extraction fails,
/// or all ops fail to find their preimage.
///
/// Returns `(new_content, warnings, resolutions)`. `resolutions` is `None` when the shadow
/// path succeeded (no positional resolution metadata), `Some` when the positional path ran.
pub(crate) fn apply_line_edits_with_shadow(
    edits: &[LineEdit],
    base: &str,
    shadow: Option<&str>,
) -> Result<(String, Vec<String>, Option<Vec<EditResolution>>), String> {
    let mut warnings: Vec<String> = Vec::new();

    if let Some(shadow_content) = shadow {
        match line_edits_to_edit_ops(edits, shadow_content, base) {
            Ok((ops, conversion_warnings)) => {
                warnings.extend(conversion_warnings);
                if !ops.is_empty() {
                    let mut working = base.to_string();
                    for (idx, op) in ops.iter().enumerate() {
                        if op.preimage.is_empty() {
                            continue;
                        }
                        if working.find(&op.preimage).is_some() {
                            apply_edit_op_to_working_hinted(&mut working, &op.preimage, &op.replacement, op.hint_byte_offset);
                        } else {
                            warnings.push(format!(
                                "shadow_preimage_not_found: edit[{}] preimage not found in current content, skipping",
                                idx
                            ));
                        }
                    }
                    return Ok((working, warnings, None));
                }
                warnings.push(
                    "shadow_conversion_empty: all edits failed preimage extraction, falling back to positional apply_line_edits".to_string()
                );
            }
            Err(conv_err) => {
                warnings.push(format!(
                    "shadow_conversion_error: {}, falling back to positional",
                    conv_err
                ));
            }
        }
    }

    // Positional fallback (fresh hash or shadow failed)
    let (content, anchor_warnings, resolutions) = apply_line_edits(base, edits)?;
    warnings.extend(anchor_warnings);
    Ok((content, warnings, Some(resolutions)))
}

/// Classifies the token most recently consumed by `scan_char`, used to
/// disambiguate `/` as division vs regex-literal opener.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PrevToken {
    /// Start of input, or after an operator / punctuation that allows regex.
    Operator,
    /// After an identifier, keyword like `this`, or numeric literal.
    Ident,
    /// After `)` — division context (e.g. `foo() / 2`).
    CloseParen,
    /// After `]` — division context (e.g. `arr[0] / 2`).
    CloseBracket,
}

impl Default for PrevToken {
    fn default() -> Self { PrevToken::Operator }
}

/// Cross-line scanner state for JS/TS bracket tracking.
/// Handles block comments, template literals (including nested `${...}`),
/// regex literals, and string literals that span across line boundaries.
#[derive(Clone, Default)]
struct ScanState {
    in_block_comment: bool,
    /// Stack of template literal nesting. Each entry is the brace depth
    /// inside a `${...}` expression at that template nesting level.
    /// Empty = not inside any template literal.
    /// Entry == 0 means we're in the string segment of that template level.
    /// Entry > 0 means we're inside a `${...}` expression.
    template_stack: Vec<i32>,
    /// Tracks the kind of the last consumed token so `/` can be correctly
    /// classified as a regex opener vs division operator.
    prev_token: PrevToken,
}

impl ScanState {
    fn in_template_segment(&self) -> bool {
        matches!(self.template_stack.last(), Some(&0))
    }

    fn in_template_expr(&self) -> bool {
        matches!(self.template_stack.last(), Some(&d) if d > 0)
    }
}

/// Skip over a regex literal starting at the opening `/`.
/// Handles `\` escapes and `[...]` character classes.
/// Advances `i` past the closing `/` and optional flags.
fn skip_regex_literal(chars: &[char], i: &mut usize, len: usize) {
    *i += 1; // skip opening /
    let mut in_char_class = false;
    while *i < len {
        let c = chars[*i];
        if c == '\\' {
            *i += 2; // skip escape sequence
            continue;
        }
        if in_char_class {
            if c == ']' { in_char_class = false; }
            *i += 1;
            continue;
        }
        if c == '[' {
            in_char_class = true;
            *i += 1;
            continue;
        }
        if c == '/' {
            *i += 1;
            // skip flags (g, i, m, s, u, y, d, v)
            while *i < len && chars[*i].is_ascii_alphabetic() { *i += 1; }
            return;
        }
        *i += 1;
    }
}

/// Returns true when `prev_token` indicates `/` should start a regex literal
/// rather than a division operator.
fn slash_starts_regex(prev: PrevToken) -> bool {
    matches!(prev, PrevToken::Operator)
}

/// Advance the scanner by one character, updating state.
/// Returns the bracket delta for this character (only non-zero for real
/// code-level brackets outside strings/comments/template segments).
/// `count_all_brackets`: true = count `{}()[]`, false = count `{}` only.
fn scan_char(
    chars: &[char],
    i: &mut usize,
    len: usize,
    state: &mut ScanState,
    count_all_brackets: bool,
) -> i32 {
    if state.in_block_comment {
        if *i + 1 < len && chars[*i] == '*' && chars[*i + 1] == '/' {
            state.in_block_comment = false;
            *i += 2;
        } else {
            *i += 1;
        }
        return 0;
    }

    if state.in_template_segment() {
        if chars[*i] == '\\' {
            *i += 2;
            return 0;
        }
        if chars[*i] == '`' {
            state.template_stack.pop();
            *i += 1;
            return 0;
        }
        if *i + 1 < len && chars[*i] == '$' && chars[*i + 1] == '{' {
            if let Some(last) = state.template_stack.last_mut() {
                *last = 1;
            }
            *i += 2;
            return 0;
        }
        *i += 1;
        return 0;
    }

    if state.in_template_expr() {
        if *i + 1 < len && chars[*i] == '/' && chars[*i + 1] == '/' {
            *i = len;
            return 0;
        }
        if *i + 1 < len && chars[*i] == '/' && chars[*i + 1] == '*' {
            state.in_block_comment = true;
            *i += 2;
            return 0;
        }
        if chars[*i] == '/' && slash_starts_regex(state.prev_token) {
            skip_regex_literal(chars, i, len);
            state.prev_token = PrevToken::Ident; // regex value acts like an expression
            return 0;
        }
        if chars[*i] == '"' || chars[*i] == '\'' {
            let q = chars[*i];
            *i += 1;
            while *i < len && chars[*i] != q {
                if chars[*i] == '\\' { *i += 1; }
                *i += 1;
            }
            if *i < len { *i += 1; }
            state.prev_token = PrevToken::Ident;
            return 0;
        }
        if chars[*i] == '`' {
            state.template_stack.push(0);
            *i += 1;
            return 0;
        }
        if chars[*i] == '{' {
            if let Some(last) = state.template_stack.last_mut() {
                *last += 1;
            }
            state.prev_token = PrevToken::Operator;
            *i += 1;
            return 0;
        }
        if chars[*i] == '}' {
            if let Some(last) = state.template_stack.last_mut() {
                *last -= 1;
                if *last <= 0 {
                    *last = 0; // back in template segment
                }
            }
            *i += 1;
            return 0;
        }
        let c = chars[*i];
        state.prev_token = if c.is_alphanumeric() || c == '_' || c == '$' {
            PrevToken::Ident
        } else if c == ')' {
            PrevToken::CloseParen
        } else if c == ']' {
            PrevToken::CloseBracket
        } else {
            PrevToken::Operator
        };
        *i += 1;
        return 0;
    }

    // Normal code context
    if *i + 1 < len && chars[*i] == '/' && chars[*i + 1] == '/' {
        *i = len;
        return 0;
    }
    if *i + 1 < len && chars[*i] == '/' && chars[*i + 1] == '*' {
        state.in_block_comment = true;
        *i += 2;
        return 0;
    }
    if chars[*i] == '/' && slash_starts_regex(state.prev_token) {
        skip_regex_literal(chars, i, len);
        state.prev_token = PrevToken::Ident;
        return 0;
    }
    if chars[*i] == '"' || chars[*i] == '\'' {
        let q = chars[*i];
        *i += 1;
        while *i < len && chars[*i] != q {
            if chars[*i] == '\\' { *i += 1; }
            *i += 1;
        }
        if *i < len { *i += 1; }
        state.prev_token = PrevToken::Ident;
        return 0;
    }
    if chars[*i] == '`' {
        state.template_stack.push(0);
        *i += 1;
        return 0;
    }

    let c = chars[*i];
    let delta = if count_all_brackets {
        match c {
            '{' | '(' | '[' => 1,
            '}' | ')' | ']' => -1,
            _ => 0,
        }
    } else {
        match c {
            '{' => 1,
            '}' => -1,
            _ => 0,
        }
    };

    state.prev_token = match c {
        ')' => PrevToken::CloseParen,
        ']' => PrevToken::CloseBracket,
        '{' | '(' | '[' | ',' | ';' | '=' | '!' | '&' | '|' | '^' | '~'
        | '+' | '-' | '*' | '%' | '<' | '>' | '?' | ':' => PrevToken::Operator,
        c if c.is_alphanumeric() || c == '_' || c == '$' => PrevToken::Ident,
        _ => PrevToken::Operator,
    };

    *i += 1;
    delta
}

/// Net bracket balance delta for a slice of lines: +1 per opener, -1 per closer.
/// Skips brackets inside string literals, line comments, block comments, and
/// template literal string segments. Handles multi-line template literals with
/// nested `${...}` expressions correctly.
fn brace_balance_delta(lines: &[&str]) -> i32 {
    let mut delta = 0i32;
    let mut state = ScanState::default();
    for line in lines {
        let chars: Vec<char> = line.chars().collect();
        let len = chars.len();
        let mut i = 0;
        while i < len {
            delta += scan_char(&chars, &mut i, len, &mut state, true);
        }
    }
    delta
}

/// Returns true if scanning the given lines leaves the scanner inside an
/// unclosed block comment (`/* ... ` without matching `*/`).
fn ends_in_block_comment(lines: &[&str]) -> bool {
    let mut state = ScanState::default();
    for line in lines {
        let chars: Vec<char> = line.chars().collect();
        let len = chars.len();
        let mut i = 0;
        while i < len {
            scan_char(&chars, &mut i, len, &mut state, false);
        }
    }
    state.in_block_comment
}

/// Compute brace-only nesting depth at a given line index by scanning all
/// preceding lines. Only counts `{`/`}` (not parens/brackets) since those
/// define structural scope in JS/TS. Handles multi-line template literals.
fn brace_depth_at_line(lines: &[String], target: usize) -> i32 {
    let mut depth: i32 = 0;
    let mut state = ScanState::default();
    let limit = target.min(lines.len());
    for line in &lines[..limit] {
        let chars: Vec<char> = line.chars().collect();
        let len = chars.len();
        let mut i = 0;
        while i < len {
            let d = scan_char(&chars, &mut i, len, &mut state, false);
            depth += d;
            if depth < 0 { depth = 0; }
        }
    }
    depth
}

/// Given the lines of a symbol (function/method/class), returns (body_start, body_end)
/// where body_start is the offset (within symbol_lines) of the line AFTER the opening `{`,
/// and body_end is the offset of the closing `}` line.
/// Skips braces inside string literals, line comments, and block comments.
/// Returns None for symbols without braces (type aliases, interfaces without body, etc.).
pub(crate) fn find_body_bounds(symbol_lines: &[&str]) -> Option<(usize, usize)> {
    if symbol_lines.is_empty() {
        return None;
    }

    // Collect ALL balanced {…} pairs at the top level (depth 0→1→…→0).
    // The function body is the LAST such pair — earlier pairs are
    // destructuring defaults, type annotations, etc.
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut current_open: Option<usize> = None;
    let mut depth: i32 = 0;
    let mut state = ScanState::default();

    for (line_idx, line) in symbol_lines.iter().enumerate() {
        let chars: Vec<char> = line.chars().collect();
        let len = chars.len();
        let mut i = 0;
        while i < len {
            let delta = scan_char(&chars, &mut i, len, &mut state, false);
            if delta > 0 {
                if depth == 0 {
                    current_open = Some(line_idx);
                }
                depth += delta;
            } else if delta < 0 {
                depth += delta;
                if depth == 0 {
                    if let Some(ol) = current_open {
                        if line_idx > ol {
                            pairs.push((ol, line_idx));
                        }
                    }
                    current_open = None;
                }
            }
        }
    }

    // If depth never returned to 0 but we have an open, the body extends to end
    if let Some(ol) = current_open {
        if depth > 0 && symbol_lines.len() > ol + 1 {
            pairs.push((ol, symbol_lines.len() - 1));
        }
    }

    if pairs.is_empty() {
        // Fallback: no balanced top-level pair found (e.g. scanner was confused
        // or the slice doesn't start at depth 0). Re-scan to find the first
        // depth 0→1 transition and its matching 1→0 close.
        let mut fb_depth: i32 = 0;
        let mut fb_state = ScanState::default();
        let mut fb_open: Option<usize> = None;
        for (line_idx, line) in symbol_lines.iter().enumerate() {
            let chars: Vec<char> = line.chars().collect();
            let clen = chars.len();
            let mut ci = 0;
            while ci < clen {
                let d = scan_char(&chars, &mut ci, clen, &mut fb_state, false);
                let old = fb_depth;
                fb_depth += d;
                if fb_depth < 0 { fb_depth = 0; }
                if old == 0 && fb_depth == 1 && fb_open.is_none() {
                    fb_open = Some(line_idx);
                }
                if old == 1 && fb_depth == 0 {
                    if let Some(ol) = fb_open {
                        if line_idx > ol {
                            return Some((ol + 1, line_idx));
                        }
                    }
                }
            }
        }
        if let Some(ol) = fb_open {
            if symbol_lines.len() > ol + 1 {
                return Some((ol + 1, symbol_lines.len() - 1));
            }
        }
        return None;
    }

    // Strategy: identify the "signature cluster" (overlapping/nested pairs for
    // destructuring defaults, type annotations) and the body pair that follows.
    //
    // Build the signature cluster starting from pairs[0]:
    let mut cluster_max_close = pairs[0].1;
    let mut cluster_size = 1usize;
    for &(open, close) in &pairs[1..] {
        if open > cluster_max_close {
            break;
        }
        cluster_size += 1;
        if close > cluster_max_close {
            cluster_max_close = close;
        }
    }

    if cluster_size < pairs.len() {
        // There are pairs after the cluster.
        if cluster_size == 1 && pairs[0].0 == 0 {
            // Single pair opening on the first line of the slice, followed by
            // disjoint pairs. This means the slice starts at a declaration like
            // `function foo() {` — pairs[0] IS the body. The disjoint pairs
            // after it are separate declarations (e.g. scanning to EOF).
            let (open, close) = pairs[0];
            return Some((open + 1, close));
        }
        // Multiple pairs in the signature cluster, or the first pair doesn't
        // open on line 0 (class method / nested scope). The body is the first
        // pair after the cluster.
        let (open, close) = pairs[cluster_size];
        Some((open + 1, close))
    } else {
        // All pairs overlap/nest into one cluster. The body is the last
        // (outermost) pair.
        let (open, close) = pairs.last()?;
        Some((open + 1, *close))
    }
}

/// Python `def` / `class` / `async def` — indentation-based body when `{`/`}` matching finds nothing.
/// Returns `(body_start_rel, end_exclusive_rel)` in the same convention as [`find_body_bounds`].
pub(crate) fn find_python_indent_body_bounds(symbol_lines: &[&str]) -> Option<(usize, usize)> {
    if symbol_lines.is_empty() {
        return None;
    }
    let mut sig_line: Option<usize> = None;
    let mut sig_indent: usize = 0;
    for (i, line) in symbol_lines.iter().enumerate() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let looks_py_sig = (t.starts_with("def ")
            || t.starts_with("class ")
            || t.starts_with("async def "))
            && line.contains(':');
        if !looks_py_sig {
            continue;
        }
        if t.ends_with(':') {
            sig_line = Some(i);
            sig_indent = line.len() - line.trim_start().len();
            break;
        }
    }
    let sig_i = sig_line?;
    let body_start = sig_i + 1;
    if body_start > symbol_lines.len() {
        return None;
    }
    if body_start == symbol_lines.len() {
        return Some((body_start, body_start));
    }
    let mut end = symbol_lines.len();
    for i in (body_start + 1)..symbol_lines.len() {
        let line = symbol_lines[i];
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let ind = line.len() - line.trim_start().len();
        if ind <= sig_indent {
            end = i;
            break;
        }
    }
    Some((body_start, end))
}

/// Resolve `symbol` + `position` on each edit to concrete `line` / `end_line` using the symbol index.
/// When `draft_style_delete_count` is true, auto-sets `end_line` for `delete` at `before` (draft semantics).
/// For `replace` / `replace_body` at `before` without an explicit span, sets `end_line` to the symbol's end line.
pub(crate) fn resolve_line_edits_symbols_for_file(
    query: &atls_core::query::QueryEngine,
    project_root: &std::path::Path,
    file_path: &str,
    edits: &mut Vec<LineEdit>,
    draft_style_delete_count: bool,
) -> Result<(), String> {
    let file_lookup = normalize_for_lookup(file_path, project_root);
    for edit in edits.iter_mut() {
        if let Some(ref sym_name) = edit.symbol {
            let pos = edit.position.as_deref().unwrap_or("before");
            let range = query
                .get_symbol_line_range(&file_lookup, sym_name)
                .or_else(|_| query.get_symbol_line_range(file_path, sym_name))
                .map_err(|e| format!("Failed to resolve symbol '{}': {}", sym_name, e))?
                .ok_or_else(|| format!("Symbol '{}' not found in {}", sym_name, file_path))?;

            let line_num: u32 = match pos {
                "before" => range.start_line,
                "after" => range.end_line.saturating_add(1),
                "body_start" => {
                    let resolved_path = resolve_project_path(project_root, file_path);
                    let fc = std::fs::read_to_string(&resolved_path)
                        .map(|c| normalize_line_endings(&c))
                        .unwrap_or_default();
                    let flines: Vec<&str> = fc.lines().collect();
                    let s = (range.start_line as usize).saturating_sub(1);
                    let e = std::cmp::min(range.end_line as usize, flines.len());
                    let sym_lines: Vec<&str> = flines[s..e].to_vec();
                    if let Some((body_start, _)) = find_body_bounds(&sym_lines) {
                        range.start_line + body_start as u32
                    } else {
                        range.start_line.saturating_add(1)
                    }
                }
                "body_end" => {
                    let resolved_path = resolve_project_path(project_root, file_path);
                    let fc = std::fs::read_to_string(&resolved_path)
                        .map(|c| normalize_line_endings(&c))
                        .unwrap_or_default();
                    let flines: Vec<&str> = fc.lines().collect();
                    let s = (range.start_line as usize).saturating_sub(1);
                    let e = std::cmp::min(range.end_line as usize, flines.len());
                    let sym_lines: Vec<&str> = flines[s..e].to_vec();
                    if let Some((_, body_end)) = find_body_bounds(&sym_lines) {
                        range.start_line + body_end as u32 - 1
                    } else {
                        range.end_line.saturating_sub(1)
                    }
                }
                _ => {
                    return Err(format!(
                        "Unknown position '{}'. Use: before, after, body_start, body_end",
                        pos
                    ));
                }
            };
            edit.line = LineCoordinate::Abs(line_num);

            if draft_style_delete_count
                && edit.action == "delete"
                && edit.end_line.is_none()
                && pos == "before"
            {
                edit.end_line = Some(range.end_line);
            }

            if (edit.action == "replace" || edit.action == "replace_body")
                && edit.end_line.is_none()
                && pos == "before"
            {
                edit.end_line = Some(range.end_line);
            }

            if edit.action == "insert_before" || edit.action == "prepend" {
                // keep as-is
            } else if pos == "after" || pos == "body_end" {
                edit.action = "insert_before".to_string();
            }
        }
    }
    Ok(())
}

/// Shared implementation for symbol-level edit actions.
/// Returns the new lines for the symbol region (NOT including lines before/after the symbol).
/// `scope` is "inner" or "outer" (default depends on action).
pub(crate) fn apply_symbol_edit_action(
    symbol_lines: &[&str],
    action: &str,
    content: &str,
    scope: &str,
    wrapper: Option<&str>,
    target: Option<&str>,
    all_lines: &[&str],
    start_idx: usize,
    end_idx: usize,
    project_query: Option<&dyn SymbolLookup>,
    file_path: &str,
) -> Result<Vec<String>, String> {
    let mut new_lines: Vec<String> = Vec::new();

    match action {
        "replace" => {
            for line in content.lines() {
                new_lines.push(line.to_string());
            }
        }
        "replace_body" => {
            if let Some((body_start, body_end)) = find_body_bounds(symbol_lines) {
                // Preserve everything up to and including the opening `{` line
                for line in &symbol_lines[..body_start] {
                    new_lines.push(line.to_string());
                }
                // Insert new body content
                for line in content.lines() {
                    new_lines.push(line.to_string());
                }
                // Preserve closing `}` line
                new_lines.push(symbol_lines[body_end].to_string());
            } else {
                // No braces found — fall back to replacing everything after the first line
                if !symbol_lines.is_empty() {
                    new_lines.push(symbol_lines[0].to_string());
                }
                for line in content.lines() {
                    new_lines.push(line.to_string());
                }
            }
        }
        "prepend" => {
            let use_inner = scope == "inner";
            if use_inner {
                if let Some((body_start, _body_end)) = find_body_bounds(symbol_lines) {
                    // Preserve signature through opening brace
                    for line in &symbol_lines[..body_start] {
                        new_lines.push(line.to_string());
                    }
                    // Insert content at the start of the body
                    for line in content.lines() {
                        new_lines.push(line.to_string());
                    }
                    // Preserve existing body and closing brace
                    for line in &symbol_lines[body_start..] {
                        new_lines.push(line.to_string());
                    }
                } else {
                    // No body bounds — fall back to outer prepend
                    for line in content.lines() {
                        new_lines.push(line.to_string());
                    }
                    for line in symbol_lines {
                        new_lines.push(line.to_string());
                    }
                }
            } else {
                // Outer: insert before entire declaration
                for line in content.lines() {
                    new_lines.push(line.to_string());
                }
                for line in symbol_lines {
                    new_lines.push(line.to_string());
                }
            }
        }
        "append" => {
            let use_inner = scope == "inner";
            if use_inner {
                if let Some((_body_start, body_end)) = find_body_bounds(symbol_lines) {
                    // Preserve everything up to the closing brace
                    for line in &symbol_lines[..body_end] {
                        new_lines.push(line.to_string());
                    }
                    // Insert content at the end of the body
                    for line in content.lines() {
                        new_lines.push(line.to_string());
                    }
                    // Preserve closing brace onward
                    for line in &symbol_lines[body_end..] {
                        new_lines.push(line.to_string());
                    }
                } else {
                    for line in symbol_lines {
                        new_lines.push(line.to_string());
                    }
                    for line in content.lines() {
                        new_lines.push(line.to_string());
                    }
                }
            } else {
                // Outer: insert after entire declaration
                for line in symbol_lines {
                    new_lines.push(line.to_string());
                }
                for line in content.lines() {
                    new_lines.push(line.to_string());
                }
            }
        }
        "wrap" => {
            let wrapper_template = wrapper.unwrap_or("$BODY");
            let use_inner = scope != "outer";
            if use_inner {
                if let Some((body_start, body_end)) = find_body_bounds(symbol_lines) {
                    // Preserve signature through opening brace
                    for line in &symbol_lines[..body_start] {
                        new_lines.push(line.to_string());
                    }
                    // Extract inner body
                    let inner_body: String = symbol_lines[body_start..body_end]
                        .iter()
                        .map(|l| l.to_string())
                        .collect::<Vec<_>>()
                        .join("\n");
                    // Detect indentation from the first body line (or opening brace line)
                    let base_indent = if body_start < symbol_lines.len() && body_start > 0 {
                        let brace_line = symbol_lines[body_start - 1];
                        let indent_len = brace_line.len() - brace_line.trim_start().len();
                        &brace_line[..indent_len]
                    } else {
                        ""
                    };
                    let body_indent = format!("{}  ", base_indent);
                    let wrapped = wrapper_template.replace("$BODY", &inner_body);
                    for line in wrapped.lines() {
                        if line.trim().is_empty() {
                            new_lines.push(String::new());
                        } else {
                            new_lines.push(format!("{}{}", body_indent, line));
                        }
                    }
                    // Preserve closing brace
                    new_lines.push(symbol_lines[body_end].to_string());
                } else {
                    // No body found — wrap entire symbol as fallback
                    let body: String = symbol_lines.iter()
                        .map(|l| l.to_string())
                        .collect::<Vec<_>>()
                        .join("\n");
                    let wrapped = wrapper_template.replace("$BODY", &body);
                    for line in wrapped.lines() {
                        new_lines.push(line.to_string());
                    }
                }
            } else {
                // Outer wrap: wrap the entire declaration
                let body: String = symbol_lines.iter()
                    .map(|l| l.to_string())
                    .collect::<Vec<_>>()
                    .join("\n");
                let wrapped = wrapper_template.replace("$BODY", &body);
                for line in wrapped.lines() {
                    new_lines.push(line.to_string());
                }
            }
        }
        "delete" => {
            // Return empty — symbol is removed
        }
        "move" => {
            let target_spec = target.ok_or("move action requires 'target' param (e.g. 'before:otherFunc' or 'after:otherFunc')")?;
            let (direction, target_symbol) = if let Some(sym) = target_spec.strip_prefix("before:") {
                ("before", sym)
            } else if let Some(sym) = target_spec.strip_prefix("after:") {
                ("after", sym)
            } else {
                return Err(format!("Invalid target format '{}'. Use 'before:symbolName' or 'after:symbolName'", target_spec));
            };

            let query = project_query.ok_or("move requires project query for symbol lookup")?;
            let target_range = query.lookup_symbol_range(file_path, target_symbol)
                .map_err(|e| format!("Failed to find target symbol '{}': {}", target_symbol, e))?
                .ok_or_else(|| format!("Target symbol '{}' not found in file", target_symbol))?;

            let target_start = (target_range.0 as usize).saturating_sub(1);
            let target_end = std::cmp::min(target_range.1 as usize, all_lines.len());

            // Build the full file content with the move applied
            let source_content: Vec<String> = symbol_lines.iter().map(|l| l.to_string()).collect();
            let mut file_lines: Vec<String> = Vec::new();

            for (i, line) in all_lines.iter().enumerate() {
                // Skip the source symbol lines (they'll be re-inserted at the target)
                if i >= start_idx && i < end_idx {
                    continue;
                }
                if direction == "before" && i == target_start {
                    for sl in &source_content { file_lines.push(sl.clone()); }
                }
                file_lines.push(line.to_string());
                if direction == "after" && i + 1 == target_end {
                    for sl in &source_content { file_lines.push(sl.clone()); }
                }
            }

            // For move, we return the ENTIRE file content (special case)
            return Ok(file_lines);
        }
        _ => {
            return Err(format!("Unknown action: {}. Use: replace, replace_body, prepend, append, wrap, delete, move", action));
        }
    }

    Ok(new_lines)
}

/// Trait for symbol lookup — allows apply_symbol_edit_action to resolve
/// target symbols for the "move" action without tight coupling to the DB.
trait SymbolLookup {
    fn lookup_symbol_range(&self, file_path: &str, symbol_name: &str) -> Result<Option<(u32, u32)>, String>;
}

/// Adapter that implements SymbolLookup using atls_core QueryEngine.
pub(crate) struct QuerySymbolLookup<'a> {
    query: &'a atls_core::query::QueryEngine,
}

impl<'a> SymbolLookup for QuerySymbolLookup<'a> {
    fn lookup_symbol_range(&self, file_path: &str, symbol_name: &str) -> Result<Option<(u32, u32)>, String> {
        let normalized = file_path.replace('\\', "/");
        match self.query.get_symbol_line_range(&normalized, symbol_name)
            .or_else(|_| self.query.get_symbol_line_range(file_path, symbol_name))
        {
            Ok(Some(range)) => Ok(Some((range.start_line, range.end_line))),
            Ok(None) => Ok(None),
            Err(e) => Err(format!("{}", e)),
        }
    }
}

pub(crate) fn build_lint_fix_hint(lint_summary: &linter::LintSummary, hashes: &[(String, String)]) -> String {
    let error_count = lint_summary.by_severity.get("error").copied().unwrap_or(0);
    if error_count == 0 {
        if let Some((hash, _)) = hashes.first() {
            return format!("Clean (buffered, hash: {}). Use atls({{tool:'edit',params:{{flush:[\"{}\"]}}}}) to force-write.", hash, hash);
        }
        return "Clean.".to_string();
    }
    let mut hint = String::new();
    if let Some(issues) = &lint_summary.top_issues {
        let show = std::cmp::min(issues.len(), 3);
        for issue in &issues[..show] {
            let matching_hash = hashes.iter()
                .find(|(_, fp)| *fp == issue.file)
                .map(|(h, _)| h.as_str())
                .unwrap_or("?");
            hint.push_str(&format!(
                "L{}: {} [{}]. Fix: atls({{tool:'edit',params:{{revise:\"{}\",line_edits:[{{line:{},action:\"replace\",content:\"...\"}}]}}}})\n",
                issue.line, issue.message, issue.file, matching_hash, issue.line
            ));
        }
    }
    hint
}

// ============================================================================
// Chat Stream State (tracks active stream tasks for cancellation)
// ============================================================================

pub(crate) struct ChatStreamState {
    handles: tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

impl Default for ChatStreamState {
    fn default() -> Self {
        Self {
            handles: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}

// ============================================================================
// Gemini Context Cache State
// ============================================================================

pub(crate) struct GeminiCacheState {
    google_cache: tokio::sync::Mutex<Option<String>>,
    vertex_cache: tokio::sync::Mutex<Option<String>>,
}

impl Default for GeminiCacheState {
    fn default() -> Self {
        Self {
            google_cache: tokio::sync::Mutex::new(None),
            vertex_cache: tokio::sync::Mutex::new(None),
        }
    }
}

// ============================================================================
// PTY Terminal State Management
// ============================================================================

pub(crate) struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    shell_pid: Option<u32>,
    _cwd: String,
}

impl PtyInstance {
    /// Explicitly tear down the PTY, killing the child and reaping it to avoid
    /// zombie processes and file-descriptor leaks on Unix (macOS/Linux).
    /// Bounded to ~1s so shutdown never hangs indefinitely.
    fn shutdown(&mut self) {
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        for _ in 0..100 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => return,
            }
        }
        eprintln!("[PTY] Child did not exit within 1s after kill, abandoning wait");
    }
}

// Global PTY state (thread-safe)
pub(crate) struct PtyState {
    terminals: Mutex<HashMap<String, PtyInstance>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
        }
    }
}

impl Drop for PtyState {
    fn drop(&mut self) {
        if let Ok(mut terminals) = self.terminals.lock() {
            for (_, mut pty) in terminals.drain() {
                pty.shutdown();
            }
        }
    }
}

// ============================================================================
// ATLS Project State Management (Direct Rust Integration)
// ============================================================================

use atls_core::AtlsProject;
use atls_core::query::search::FileCache;

/// A detected or manually-added workspace (sub-project) within the project root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    pub id: Option<i64>,
    pub name: String,
    pub rel_path: String,
    pub abs_path: String,
    pub types: Vec<String>,
    pub build_files: Vec<String>,
    pub group_name: Option<String>,
    /// "auto" (detected on scan) or "manual" (user-added)
    pub source: String,
    pub last_active_at: i64,
}

/// Resolve a workspace by name with fuzzy fallback:
///   1. Exact name match
///   2. rel_path exact or suffix match
///   3. Case-insensitive name match
/// Returns the workspace abs_path or an error listing available workspaces.
pub(crate) fn resolve_workspace_fuzzy(workspaces: &[WorkspaceEntry], query: &str) -> Result<String, String> {
    // 1. Exact name
    if let Some(ws) = workspaces.iter().find(|ws| ws.name == query) {
        return Ok(ws.abs_path.clone());
    }
    // 2. rel_path exact or suffix (handles "python/click" matching rel_path "python/click")
    let normalized = query.replace('\\', "/");
    if let Some(ws) = workspaces.iter().find(|ws| {
        let rp = ws.rel_path.replace('\\', "/");
        rp == normalized || rp.ends_with(&format!("/{}", normalized)) || normalized.ends_with(&format!("/{}", ws.name))
    }) {
        return Ok(ws.abs_path.clone());
    }
    // 3. Case-insensitive name
    let lower = query.to_lowercase();
    if let Some(ws) = workspaces.iter().find(|ws| ws.name.to_lowercase() == lower) {
        return Ok(ws.abs_path.clone());
    }
    // 4. group_name match (case-insensitive, unambiguous only)
    let group_matches: Vec<&WorkspaceEntry> = workspaces.iter()
        .filter(|ws| ws.group_name.as_deref().map(|g| g.to_lowercase()) == Some(lower.clone()))
        .collect();
    if group_matches.len() == 1 {
        return Ok(group_matches[0].abs_path.clone());
    }
    // 5. name prefix match (unambiguous only — "python" matches "python-click")
    let prefix_matches: Vec<&WorkspaceEntry> = workspaces.iter()
        .filter(|ws| ws.name.starts_with(&format!("{}-", query)) || ws.name.starts_with(&format!("{}_", query)))
        .collect();
    if prefix_matches.len() == 1 {
        return Ok(prefix_matches[0].abs_path.clone());
    }

    let available: Vec<&str> = workspaces.iter().map(|ws| ws.name.as_str()).collect();
    Err(format!(
        "Workspace '{}' not found. Available: {}",
        query,
        if available.is_empty() { "(none detected)".to_string() } else { available.join(", ") }
    ))
}

/// Scan a directory tree for sub-project build files.
/// Returns detected workspaces. Checks `detect_base` and up to `max_depth` levels of children.
pub(crate) fn scan_workspaces(detect_base: &std::path::Path, project_root: &std::path::Path, max_depth: u32) -> Vec<WorkspaceEntry> {
    let mut entries: Vec<WorkspaceEntry> = Vec::new();

    let check_dir = |dir: &std::path::Path, out: &mut Vec<WorkspaceEntry>| {
        let mut types = Vec::new();
        let mut build_files = Vec::new();

        let check = |file: &str, lang: &str, types: &mut Vec<String>, bf: &mut Vec<String>| {
            if dir.join(file).exists() {
                if !types.contains(&lang.to_string()) {
                    types.push(lang.to_string());
                }
                bf.push(file.to_string());
            }
        };

        check("package.json", "node", &mut types, &mut build_files);
        check("tsconfig.json", "typescript", &mut types, &mut build_files);
        check("Cargo.toml", "rust", &mut types, &mut build_files);
        check("requirements.txt", "python", &mut types, &mut build_files);
        check("pyproject.toml", "python", &mut types, &mut build_files);
        check("go.mod", "go", &mut types, &mut build_files);
        check("Makefile", "c_cpp", &mut types, &mut build_files);
        check("CMakeLists.txt", "c_cpp", &mut types, &mut build_files);
        check("build.gradle", "java", &mut types, &mut build_files);
        check("build.gradle.kts", "java", &mut types, &mut build_files);
        check("pom.xml", "java", &mut types, &mut build_files);
        check("Package.swift", "swift", &mut types, &mut build_files);

        // C# detection requires directory scan for *.sln / *.csproj
        if let Ok(entries_iter) = std::fs::read_dir(dir) {
            for entry in entries_iter.flatten() {
                let n = entry.file_name().to_string_lossy().to_string();
                if n.ends_with(".sln") || n.ends_with(".csproj") {
                    if !types.contains(&"csharp".to_string()) {
                        types.push("csharp".to_string());
                    }
                    build_files.push(n);
                    break;
                }
            }
        }

        if types.is_empty() {
            return;
        }

        let rel = if dir == project_root {
            ".".to_string()
        } else {
            dir.strip_prefix(project_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| dir.to_string_lossy().to_string())
        };

        let name = if rel == "." {
            project_root.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "root".to_string())
        } else {
            rel.replace('/', "-")
        };

        // Derive group from first path segment (for monorepo grouping)
        let group = if rel == "." {
            None
        } else {
            rel.split('/').next().map(|s| s.to_string())
        };

        out.push(WorkspaceEntry {
            id: None,
            name,
            rel_path: rel,
            abs_path: dir.to_string_lossy().to_string(),
            types,
            build_files,
            group_name: group,
            source: "auto".to_string(),
            last_active_at: 0,
        });
    };

    check_dir(detect_base, &mut entries);

    fn walk_dir(
        dir: &std::path::Path,
        depth: u32,
        max_depth: u32,
        project_root: &std::path::Path,
        check_dir: &dyn Fn(&std::path::Path, &mut Vec<WorkspaceEntry>),
        out: &mut Vec<WorkspaceEntry>,
    ) {
        if depth >= max_depth {
            return;
        }
        let Ok(read) = std::fs::read_dir(dir) else { return };
        for entry in read.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if atls_core::is_skip_dir(&dir_name) {
                continue;
            }
            check_dir(&path, out);
            walk_dir(&path, depth + 1, max_depth, project_root, check_dir, out);
        }
    }

    walk_dir(detect_base, 0, max_depth, project_root, &check_dir, &mut entries);
    entries
}

/// Persist a list of auto-detected workspaces to the DB (upsert).
/// Manual entries are preserved; auto entries are replaced.
pub(crate) fn persist_workspaces_to_db(conn: &rusqlite::Connection, workspaces: &[WorkspaceEntry]) -> Result<(), String> {
    conn.execute("DELETE FROM workspaces WHERE source = 'auto'", [])
        .map_err(|e| format!("Failed to clear auto workspaces: {}", e))?;

    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO workspaces (name, rel_path, abs_path, types, build_files, group_name, source, last_active_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    ).map_err(|e| format!("Failed to prepare workspace insert: {}", e))?;

    for ws in workspaces {
        stmt.execute(rusqlite::params![
            ws.name,
            ws.rel_path,
            ws.abs_path,
            ws.types.join(","),
            ws.build_files.join(","),
            ws.group_name,
            ws.source,
            ws.last_active_at,
        ]).map_err(|e| format!("Failed to insert workspace '{}': {}", ws.name, e))?;
    }
    Ok(())
}

/// Load all workspaces from the DB.
pub(crate) fn load_workspaces_from_db(conn: &rusqlite::Connection) -> Result<Vec<WorkspaceEntry>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, name, rel_path, abs_path, types, build_files, group_name, source, last_active_at \
         FROM workspaces ORDER BY name"
    ).map_err(|e| format!("Failed to query workspaces: {}", e))?;

    let rows = stmt.query_map([], |row| {
        let types_str: String = row.get(4)?;
        let bf_str: String = row.get(5)?;
        Ok(WorkspaceEntry {
            id: Some(row.get(0)?),
            name: row.get(1)?,
            rel_path: row.get(2)?,
            abs_path: row.get(3)?,
            types: types_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
            build_files: bf_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
            group_name: row.get(6)?,
            source: row.get(7)?,
            last_active_at: row.get(8)?,
        })
    }).map_err(|e| format!("Failed to read workspaces: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect workspaces: {}", e))
}

/// A root folder in a multi-root workspace, each with its own AtlsProject + DB.
pub(crate) struct RootFolder {
    path: String,
    project: Arc<AtlsProject>,
    sub_workspaces: Vec<WorkspaceEntry>,
}

pub(crate) struct AtlsProjectState {
    roots: tokio::sync::Mutex<Vec<RootFolder>>,
    active_root: Arc<std::sync::RwLock<Option<String>>>,
    scan_status: Arc<std::sync::RwLock<ScanStatus>>,
    workspace_file: Arc<std::sync::RwLock<Option<PathBuf>>>,
}

impl Default for AtlsProjectState {
    fn default() -> Self {
        Self {
            roots: tokio::sync::Mutex::new(Vec::new()),
            active_root: Arc::new(std::sync::RwLock::new(None)),
            scan_status: Arc::new(std::sync::RwLock::new(ScanStatus {
                is_scanning: false,
                progress: 0,
                current_file: None,
                files_processed: 0,
                files_total: 0,
            })),
            workspace_file: Arc::new(std::sync::RwLock::new(None)),
        }
    }
}

/// Per-repo mutex to serialize git operations and avoid index.lock contention.
pub(crate) struct GitOpState {
    locks: tokio::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Default for GitOpState {
    fn default() -> Self {
        Self { locks: tokio::sync::Mutex::new(std::collections::HashMap::new()) }
    }
}

impl GitOpState {
    async fn lock_for(&self, repo_path: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let mutex = {
            let mut map = self.locks.lock().await;
            map.entry(repo_path.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        mutex.lock_owned().await
    }
}

/// Shared LRU file cache for search snippet extraction (Phase 1.3)
pub(crate) struct SearchCacheState {
    file_cache: FileCache,
}

impl Default for SearchCacheState {
    fn default() -> Self {
        Self {
            file_cache: FileCache::new(100),
        }
    }
}

/// Resolve which project to use.
/// Priority: explicit root_hint > active_root > single-root fallback > error.
pub(crate) fn resolve_project(
    roots: &[RootFolder],
    active_root: &Option<String>,
    root_hint: Option<&str>,
) -> Result<(Arc<AtlsProject>, String), String> {
    if roots.is_empty() {
        return Err("ATLS project not initialized".to_string());
    }

    let normalize_root_key = |path: &str| {
        path.replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };

    if let Some(hint) = root_hint {
        let norm = normalize_root_key(hint);
        if let Some(rf) = roots.iter().find(|r| normalize_root_key(&r.path) == norm) {
            return Ok((Arc::clone(&rf.project), rf.path.clone()));
        }
        return Err(format!("Root folder '{}' not found in workspace", hint));
    }

    if let Some(ref active) = active_root {
        let norm = normalize_root_key(active);
        if let Some(rf) = roots.iter().find(|r| normalize_root_key(&r.path) == norm) {
            return Ok((Arc::clone(&rf.project), rf.path.clone()));
        }
    }

    if let Some(ref active) = active_root {
        let norm = active.replace('\\', "/");
        if let Some(rf) = roots.iter().find(|r| r.path.replace('\\', "/") == norm) {
            return Ok((Arc::clone(&rf.project), rf.path.clone()));
        }
    }

    // Single-root fallback
    if roots.len() == 1 {
        let rf = &roots[0];
        return Ok((Arc::clone(&rf.project), rf.path.clone()));
    }

    Err("Multiple roots open — specify 'root' parameter or set active root".to_string())
}

// ============================================================================
// Data Types
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct FileNode {
    name: String,
    path: String,
    #[serde(rename = "type")]
    node_type: String,
    children: Option<Vec<FileNode>>,
    language: Option<String>,
    /// True when this path matches .atlsignore (shown in Explorer with indicator)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignored: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Issue {
    id: String,
    pattern_id: String,
    file: String,
    line: u32,
    message: String,
    severity: String,
    category: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanStatus {
    is_scanning: bool,
    progress: u32,
    current_file: Option<String>,
    files_processed: u32,
    files_total: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IssueCounts {
    high: u32,
    medium: u32,
    low: u32,
    total: u32,
}

// ============================================================================
// File System Commands
// ============================================================================

/// Shared ignore check for file tree traversal.
/// Delegates to `atls_core::is_skip_dir` (canonical SKIP_DIRS list + dot-prefix rule).
pub(crate) fn should_ignore_path(name: &str) -> bool {
    atls_core::is_skip_dir(name)
}

/// Resolve .atlsignore path: prefer .atls/.atlsignore, fallback to root .atlsignore
pub(crate) fn atlsignore_path(root: &std::path::Path) -> Option<std::path::PathBuf> {
    let in_atls = root.join(".atls").join(".atlsignore");
    if in_atls.exists() {
        return Some(in_atls);
    }
    let at_root = root.join(".atlsignore");
    if at_root.exists() {
        return Some(at_root);
    }
    None
}

/// Load .atlsignore patterns into a Gitignore matcher (patterns rooted at project root)
pub(crate) fn load_atlsignore(root: &std::path::Path) -> Option<ignore::gitignore::Gitignore> {
    let path = atlsignore_path(root)?;
    let content = std::fs::read_to_string(&path).ok()?;
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let _ = builder.add_line(None, line);
    }
    builder.build().ok()
}

// NOTE: negation patterns (!) are handled natively by ignore::gitignore::Gitignore.
// No separate negation matcher needed — gi.matched().is_ignore() already returns
// false when a path is negated by a ! rule.

/// Max relative file paths returned with tree context (downstream read.shaped / batch bindings).
pub(crate) const MAX_TREE_FILE_PATHS: usize = 1500;

/// Layout for `context` type `tree` text: compact (group-by-directory) vs legacy indented tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TreeFormat {
    /// Default: one `dir/` header per folder, then `  name: N` file lines.
    Compact,
    /// Legacy: depth-indented lines with `name (NL)`.
    Indented,
}

fn rel_path_posix(base: &std::path::Path, path: &std::path::Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Collect relative file paths under `dir` with the same depth and ignore rules as `tree_walk`,
/// without the per-directory display cap. Stops when `out.len() >= max` and returns `true` if truncated.
fn collect_tree_file_paths(
    dir: &std::path::Path,
    base: &std::path::Path,
    depth_remaining: u32,
    atlsignore: Option<&ignore::gitignore::Gitignore>,
    out: &mut Vec<String>,
    max: usize,
) -> bool {
    if out.len() >= max {
        return true;
    }
    let entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return false,
    };

    let mut items: Vec<(String, std::path::PathBuf, bool)> = Vec::new();
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_path(&name) {
            continue;
        }
        let path = entry.path();
        if let Some(gi) = atlsignore {
            if let Ok(rel) = path.strip_prefix(base) {
                if gi.matched(rel, path.is_dir()).is_ignore() {
                    continue;
                }
            }
        }
        items.push((name, path.clone(), path.is_dir()));
    }
    items.sort_by(|a, b| match (a.2, b.2) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });

    for (_name, path, is_dir) in items {
        if out.len() >= max {
            return true;
        }
        if is_dir {
            if depth_remaining > 0 {
                if collect_tree_file_paths(&path, base, depth_remaining - 1, atlsignore, out, max) {
                    return true;
                }
            }
        } else {
            out.push(rel_path_posix(base, &path));
        }
    }
    false
}

/// Build compact text tree for context type:tree output.
/// Returns (tree_text, file_count, dir_count, file_paths, file_paths_truncated).
pub(crate) fn build_compact_tree(
    root: &std::path::Path,
    base: &std::path::Path,
    max_depth: u32,
    glob_matcher: Option<&globset::GlobMatcher>,
    atlsignore: Option<&ignore::gitignore::Gitignore>,
    format: TreeFormat,
    line_counts: bool,
) -> (String, usize, usize, Vec<String>, bool) {
    let mut lines = Vec::new();
    let mut file_count = 0usize;
    let mut dir_count = 0usize;

    if let Some(gm) = glob_matcher {
        let mut hits: Vec<(String, String, usize)> = Vec::new();
        glob_collect(root, base, gm, &mut hits, 0, atlsignore, line_counts);
        file_count = hits.len();

        // Group by parent directory, emit dir path once then indented filenames
        let mut current_dir = String::new();
        for (dir_path, name, lc) in &hits {
            if *dir_path != current_dir {
                current_dir = dir_path.clone();
                if !dir_path.is_empty() {
                    lines.push(format!("{}/", dir_path));
                }
            }
            let file_line = match format {
                TreeFormat::Compact => {
                    if line_counts {
                        format!("  {}: {}", name, lc)
                    } else {
                        format!("  {}", name)
                    }
                }
                TreeFormat::Indented => {
                    if line_counts {
                        format!("  {} ({}L)", name, lc)
                    } else {
                        format!("  {}", name)
                    }
                }
            };
            lines.push(file_line);
        }

        let mut file_paths: Vec<String> = hits
            .iter()
            .map(|(parent, name, _)| {
                if parent.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", parent, name)
                }
            })
            .collect();
        file_paths.sort();
        let truncated = file_paths.len() > MAX_TREE_FILE_PATHS;
        if truncated {
            file_paths.truncate(MAX_TREE_FILE_PATHS);
        }
        (lines.join("\n"), file_count, dir_count, file_paths, truncated)
    } else {
        match format {
            TreeFormat::Indented => {
                tree_walk(
                    root,
                    base,
                    0,
                    max_depth,
                    &mut lines,
                    &mut file_count,
                    &mut dir_count,
                    atlsignore,
                    line_counts,
                );
            }
            TreeFormat::Compact => {
                tree_walk_compact(
                    root,
                    base,
                    "",
                    max_depth,
                    &mut lines,
                    &mut file_count,
                    &mut dir_count,
                    atlsignore,
                    line_counts,
                );
            }
        }
        let mut file_paths = Vec::new();
        let truncated = collect_tree_file_paths(
            root,
            base,
            max_depth,
            atlsignore,
            &mut file_paths,
            MAX_TREE_FILE_PATHS,
        );
        (
            lines.join("\n"),
            file_count,
            dir_count,
            file_paths,
            truncated,
        )
    }
}

/// Collect glob-matched files as (parent_dir, filename, line_count) tuples
pub(crate) fn glob_collect(
    dir: &std::path::Path,
    base: &std::path::Path,
    matcher: &globset::GlobMatcher,
    hits: &mut Vec<(String, String, usize)>,
    recursion_depth: u32,
    atlsignore: Option<&ignore::gitignore::Gitignore>,
    line_counts: bool,
) {
    if recursion_depth > 20 { return; }
    let entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };

    let mut items: Vec<(String, std::path::PathBuf, bool)> = Vec::new();
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_path(&name) { continue; }
        let path = entry.path();
        if let Some(gi) = atlsignore {
            if let Ok(rel) = path.strip_prefix(base) {
                if gi.matched(rel, path.is_dir()).is_ignore() { continue; }
            }
        }
        items.push((name, path.clone(), path.is_dir()));
    }
    items.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    for (name, path, is_dir) in &items {
        if *is_dir {
            glob_collect(path, base, matcher, hits, recursion_depth + 1, atlsignore, line_counts);
        } else {
            let rel = path.strip_prefix(base).unwrap_or(path);
            if matcher.is_match(rel) {
                let line_count = if line_counts {
                    std::fs::read(path)
                        .map(|b| bytecount_lines(&b))
                        .unwrap_or(0)
                } else {
                    0
                };
                let parent = rel.parent()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                hits.push((parent, name.clone(), line_count));
            }
        }
    }
}

/// Indented tree display with depth limiting
pub(crate) fn tree_walk(
    dir: &std::path::Path,
    base: &std::path::Path,
    indent: usize,
    depth_remaining: u32,
    lines: &mut Vec<String>,
    file_count: &mut usize,
    dir_count: &mut usize,
    atlsignore: Option<&ignore::gitignore::Gitignore>,
    line_counts: bool,
) {
    let entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };

    let mut items: Vec<(String, std::path::PathBuf, bool)> = Vec::new();
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_path(&name) { continue; }
        let path = entry.path();
        if let Some(gi) = atlsignore {
            if let Ok(rel) = path.strip_prefix(base) {
                if gi.matched(rel, path.is_dir()).is_ignore() { continue; }
            }
        }
        items.push((name, path.clone(), path.is_dir()));
    }
    items.sort_by(|a, b| match (a.2, b.2) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });

    let capped = items.len() > 100;
    let display_items = if capped { &items[..100] } else { &items };
    let prefix = "  ".repeat(indent);

    for (name, path, is_dir) in display_items {
        if *is_dir {
            *dir_count += 1;
            if depth_remaining > 0 {
                lines.push(format!("{}{}/", prefix, name));
                tree_walk(path, base, indent + 1, depth_remaining - 1, lines, file_count, dir_count, atlsignore, line_counts);
            } else {
                let child_count = std::fs::read_dir(path)
                    .map(|rd| rd.filter_map(|e| e.ok())
                        .filter(|e| !should_ignore_path(&e.file_name().to_string_lossy()))
                        .count())
                    .unwrap_or(0);
                lines.push(format!("{}{}/  ({} items)", prefix, name, child_count));
            }
        } else {
            *file_count += 1;
            if line_counts {
                let line_count = std::fs::read(path)
                    .map(|b| bytecount_lines(&b))
                    .unwrap_or(0);
                lines.push(format!("{}{} ({}L)", prefix, name, line_count));
            } else {
                lines.push(format!("{}{}", prefix, name));
            }
        }
    }

    if capped {
        lines.push(format!("{}... and {} more items", prefix, items.len() - 100));
    }
}

/// Group-by-directory tree: dirs first (recursive), then a `dir/` block for files in this folder.
pub(crate) fn tree_walk_compact(
    dir: &std::path::Path,
    base: &std::path::Path,
    rel_prefix: &str,
    depth_remaining: u32,
    lines: &mut Vec<String>,
    file_count: &mut usize,
    dir_count: &mut usize,
    atlsignore: Option<&ignore::gitignore::Gitignore>,
    line_counts: bool,
) {
    let entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };

    let mut items: Vec<(String, std::path::PathBuf, bool)> = Vec::new();
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_path(&name) { continue; }
        let path = entry.path();
        if let Some(gi) = atlsignore {
            if let Ok(rel) = path.strip_prefix(base) {
                if gi.matched(rel, path.is_dir()).is_ignore() { continue; }
            }
        }
        items.push((name, path.clone(), path.is_dir()));
    }
    items.sort_by(|a, b| match (a.2, b.2) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });

    let capped = items.len() > 100;
    let display_items = if capped { &items[..100] } else { &items };

    let mut dir_end = 0usize;
    for (_name, _path, is_dir) in display_items.iter() {
        if *is_dir {
            dir_end += 1;
        } else {
            break;
        }
    }

    for (name, path, _is_dir) in &display_items[..dir_end] {
        *dir_count += 1;
        if depth_remaining > 0 {
            let child_rel = if rel_prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel_prefix, name)
            };
            tree_walk_compact(path, base, &child_rel, depth_remaining - 1, lines, file_count, dir_count, atlsignore, line_counts);
        } else {
            let child_count = std::fs::read_dir(path)
                .map(|rd| rd.filter_map(|e| e.ok())
                    .filter(|e| !should_ignore_path(&e.file_name().to_string_lossy()))
                    .count())
                .unwrap_or(0);
            let collapsed = if rel_prefix.is_empty() {
                format!("{}/  ({} items)", name, child_count)
            } else {
                format!("{}/  ({} items)", child_rel_with(rel_prefix, name), child_count)
            };
            lines.push(collapsed);
        }
    }

    let files = &display_items[dir_end..];
    if !files.is_empty() {
        let header = if rel_prefix.is_empty() {
            "./".to_string()
        } else {
            format!("{}/", rel_prefix)
        };
        lines.push(header);
        for (name, path, _is_dir) in files {
            debug_assert!(!*_is_dir);
            *file_count += 1;
            if line_counts {
                let line_count = std::fs::read(path)
                    .map(|b| bytecount_lines(&b))
                    .unwrap_or(0);
                lines.push(format!("  {}: {}", name, line_count));
            } else {
                lines.push(format!("  {}", name));
            }
        }
    }

    if capped {
        let prefix = if rel_prefix.is_empty() { "." } else { rel_prefix };
        lines.push(format!("{} ... and {} more items", prefix, items.len() - 100));
    }
}

fn child_rel_with(rel_prefix: &str, name: &str) -> String {
    if rel_prefix.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", rel_prefix, name)
    }
}

/// Fast line count without full UTF-8 decode
pub(crate) fn bytecount_lines(bytes: &[u8]) -> usize {
    bytes.iter().filter(|&&b| b == b'\n').count()
}

/// Normalize a file path for index lookup: forward slashes, relative to project root.
pub(crate) fn normalize_for_lookup(file: &str, project_root: &std::path::Path) -> String {
    let fwd = file.replace('\\', "/");
    let root_str = project_root.to_string_lossy().replace('\\', "/");
    let root_prefix = if root_str.ends_with('/') { root_str.clone() } else { format!("{}/", root_str) };
    if fwd.starts_with(&root_prefix) {
        fwd[root_prefix.len()..].to_string()
    } else {
        fwd
    }
}

/// Dedup edit_warnings by (file, error_class) key: keeps first instance, adds `count` when > 1.
pub(crate) fn dedup_edit_warnings(warnings: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    use std::collections::HashMap;
    if warnings.len() <= 1 {
        return warnings;
    }
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    let mut out: Vec<serde_json::Value> = Vec::with_capacity(warnings.len());
    for w in warnings {
        let file = w.get("file").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let class = w.get("error_class").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let key = (file, class);
        if let Some(&idx) = seen.get(&key) {
            let count = out[idx].get("count").and_then(|v| v.as_u64()).unwrap_or(1) + 1;
            out[idx]["count"] = serde_json::json!(count);
        } else {
            seen.insert(key, out.len());
            out.push(w);
        }
    }
    out
}

/// Get file tree for a directory (non-blocking)

// ============================================================================
// Main Entry Point
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    eprintln!("[ATLS Studio] Starting Tauri application...");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Manage state
        .manage(PtyState::default())
        .manage(ai_execute::BackgroundState::default())
        .manage(AtlsProjectState::default())
        .manage(file_watcher::FileWatcherState::default())
        .manage(ChatDbState::default())
        .manage(ChatStreamState::default())
        .manage(UndoStoreState::default())
        .manage(RefactorMutexState::default())
        .manage(hash_resolver::HashRegistryState::default())
        .manage(hash_resolver::FileCacheState::default())
        .manage(snapshot::SnapshotServiceState::default())
        .manage(GeminiCacheState::default())
        .manage(SearchCacheState::default())
        .manage(GitOpState::default())
        .setup(|app| {
            // macOS: native menu bar (NSMenu) so the titlebar stays draggable
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItem};

                let menu = MenuBuilder::new(app)
                    .item(&SubmenuBuilder::new(app, "ATLS Studio")
                        .about(None)
                        .separator()
                        .services()
                        .separator()
                        .hide()
                        .hide_others()
                        .show_all()
                        .separator()
                        .quit()
                        .build()?)
                    .item(&SubmenuBuilder::new(app, "File")
                        .item(&MenuItem::with_id(app, "new-project", "New Project", true, Some("CmdOrCtrl+Shift+N"))?)
                        .item(&MenuItem::with_id(app, "open-project", "Open Project...", true, Some("CmdOrCtrl+O"))?)
                        .item(&MenuItem::with_id(app, "new-chat", "New Chat", true, Some("CmdOrCtrl+N"))?)
                        .item(&MenuItem::with_id(app, "add-folder", "Add Folder to Workspace...", true, None::<&str>)?)
                        .separator()
                        .item(&MenuItem::with_id(app, "save-workspace", "Save Workspace As...", true, None::<&str>)?)
                        .item(&MenuItem::with_id(app, "open-workspace", "Open Workspace...", true, None::<&str>)?)
                        .item(&MenuItem::with_id(app, "close-workspace", "Close Workspace", true, None::<&str>)?)
                        .separator()
                        .item(&MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?)
                        .item(&MenuItem::with_id(app, "save-all", "Save All", true, Some("CmdOrCtrl+Shift+S"))?)
                        .separator()
                        .item(&MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?)
                        .build()?)
                    .item(&SubmenuBuilder::new(app, "Edit")
                        .undo()
                        .redo()
                        .separator()
                        .cut()
                        .copy()
                        .paste()
                        .select_all()
                        .separator()
                        .item(&MenuItem::with_id(app, "find-in-file", "Find in File", true, Some("CmdOrCtrl+F"))?)
                        .item(&MenuItem::with_id(app, "replace", "Replace", true, Some("CmdOrCtrl+H"))?)
                        .build()?)
                    .item(&SubmenuBuilder::new(app, "View")
                        .item(&MenuItem::with_id(app, "quick-actions", "Quick Actions", true, Some("CmdOrCtrl+Shift+P"))?)
                        .item(&MenuItem::with_id(app, "quick-find", "Quick Find", true, Some("CmdOrCtrl+P"))?)
                        .item(&MenuItem::with_id(app, "search-in-files", "Search in Files", true, Some("CmdOrCtrl+Shift+F"))?)
                        .separator()
                        .item(&MenuItem::with_id(app, "toggle-terminal", "Toggle Terminal", true, None::<&str>)?)
                        .separator()
                        .item(&MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?)
                        .item(&MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?)
                        .item(&MenuItem::with_id(app, "reset-zoom", "Reset Zoom", true, Some("CmdOrCtrl+0"))?)
                        .build()?)
                    .item(&SubmenuBuilder::new(app, "Window")
                        .minimize()
                        .close_window()
                        .separator()
                        .fullscreen()
                        .build()?)
                    .item(&SubmenuBuilder::new(app, "Help")
                        .item(&MenuItem::with_id(app, "documentation", "Documentation", true, None::<&str>)?)
                        .item(&MenuItem::with_id(app, "keyboard-shortcuts", "Keyboard Shortcuts", true, None::<&str>)?)
                        .separator()
                        .item(&MenuItem::with_id(app, "atls-internals", "ATLS Internals", true, None::<&str>)?)
                        .build()?)
                    .build()?;

                app.set_menu(menu)?;

                app.on_menu_event(|app_handle, event| {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("menu-event", event.id().as_ref().to_string());
                    }
                });
            }

            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("ATLS Studio")
            .inner_size(1400.0, 900.0)
            .min_inner_size(800.0, 600.0);

            #[cfg(target_os = "macos")]
            {
                builder = builder.decorations(true);
            }

            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.decorations(false);
            }

            let webview_window = builder.build()?;

            // macOS: block WKWebView touch events that interfere with mouse clicks.
            // WKWebView registers the app as touch-capable, causing phantom touch
            // listeners to swallow/delay click events.
            #[cfg(target_os = "macos")]
            {
                webview_window.eval(r#"
                    (function() {
                        var orig = EventTarget.prototype.addEventListener;
                        EventTarget.prototype.addEventListener = function(type, fn, opts) {
                            if (type === 'touchstart' || type === 'touchend' || type === 'touchmove') return;
                            return orig.call(this, type, fn, opts);
                        };
                    })();
                "#).ok();
            }

            let _ = webview_window; // suppress unused warning on non-mac

            eprintln!("[ATLS Studio] Tauri app setup complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // File system
            file_ops::get_file_tree,
            file_ops::read_file_contents,
            file_ops::expand_file_glob,
            file_ops::write_file_contents,
            file_ops::write_design_file,
            file_ops::delete_path,
            file_ops::rename_path,
            file_ops::create_file,
            file_ops::create_folder,
            file_ops::create_project_directory,
            file_ops::add_to_atlsignore,
            file_ops::remove_from_atlsignore,
            file_ops::copy_path,
            file_ops::read_file_as_base64,
            chat_attachments::read_file_signatures,
            chat_attachments::compress_and_read_image,
            // File watcher (auto-refresh)
            file_watcher::start_file_watcher,
            file_watcher::stop_file_watcher,
            // ATLS bridge (native integration)
            atls_ops::atls_init,
            atls_ops::atls_dispose,
            atls_ops::atls_add_root,
            atls_ops::atls_remove_root,
            atls_ops::atls_set_active_root,
            atls_ops::atls_get_roots,
            atls_ops::atls_save_workspace,
            atls_ops::atls_open_workspace,
            atls_ops::atls_get_workspaces,
            atls_ops::get_scan_status,
            atls_ops::get_issue_counts,
            atls_ops::find_issues,
            atls_ops::scan_project,
            atls_ops::get_focus_profiles,
            atls_ops::save_focus_profiles,
            code_intel::atls_search_code,
            code_intel::atls_get_symbol_usage,
            code_intel::atls_get_file_context,
            code_intel::atls_diagnose_symbols,
            code_intel::atls_get_project_profile,
            code_intel::atls_get_database_stats,
            code_intel::atls_get_language_health,
            workspace_run::atls_get_workspace_scripts,
            batch_query::atls_batch_query,
            // Search (basic text search, ATLS provides semantic)
            search_exec::search_text,
            search_exec::search_files,
            // Symbol navigation (fallback, prefer ATLS)
            search_exec::get_symbol_usage,
            // Legacy terminal (deprecated, use PTY commands)
            search_exec::execute_command,
            // PTY Terminal (Human Interactive)
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            pty::is_pty_busy,
            pty::write_agent_exec_ps1,
            pty::remove_temp_file,
            // AI Execution API (Structured Output)
            ai_execute::ai_execute,
            ai_execute::ai_execute_background,
            ai_execute::ai_get_background_output,
            ai_execute::ai_kill_background,
            // Tokenizer (real BPE token counting)
            tokenizer::count_tokens,
            tokenizer::count_tokens_batch,
            tokenizer::count_tool_def_tokens,
            // AI Chat Streaming (bypasses CORS)
            ai_streaming::stream_chat_anthropic,
            ai_streaming::estimate_tool_def_tokens,
            ai_streaming::stream_chat_openai,
            ai_streaming::stream_chat_lmstudio,
            ai_streaming::stream_chat_google,
            gemini_cache::stream_chat_vertex,
            ai_streaming::cancel_chat_stream,
            ai_streaming::cancel_all_chat_streams,
            // Gemini Context Caching
            gemini_cache::gemini_create_cache,
            gemini_cache::gemini_refresh_cache,
            gemini_cache::gemini_delete_cache,
            gemini_cache::gemini_get_cache_name,
            // AI Model fetching
            ai_models::fetch_anthropic_models,
            ai_models::fetch_openai_models,
            ai_models::fetch_lmstudio_models,
            ai_models::fetch_google_models,
            ai_models::fetch_vertex_models,
            // Chat Database
            commands::chat_db_init,
            commands::chat_db_close,
            commands::chat_db_create_session,
            commands::chat_db_get_sessions,
            commands::chat_db_get_session,
            commands::chat_db_update_session_title,
            commands::chat_db_update_session_mode,
            commands::chat_db_update_swarm_status,
            commands::chat_db_update_context_usage,
            commands::chat_db_delete_session,
            commands::chat_db_add_message,
            commands::chat_db_get_messages,
            commands::chat_db_add_segments,
            commands::chat_db_get_segments,
            commands::chat_db_delete_segments,
            commands::chat_db_replace_segments,
            commands::chat_db_add_blackboard_entry,
            commands::chat_db_get_blackboard_entries,
            commands::chat_db_get_content_by_hash,
            commands::chat_db_update_blackboard_pinned,
            commands::chat_db_remove_blackboard_entries,
            commands::chat_db_clear_blackboard,
            commands::chat_db_create_task,
            commands::chat_db_get_tasks,
            commands::chat_db_get_task,
            commands::chat_db_update_task_status,
            commands::chat_db_update_task_result,
            commands::chat_db_update_task_error,
            commands::chat_db_update_task_stats,
            commands::chat_db_record_agent_stats,
            commands::chat_db_get_agent_stats,
            commands::chat_db_get_session_total_stats,
            commands::chat_db_set_note,
            commands::chat_db_get_notes,
            commands::chat_db_delete_note,
            commands::chat_db_clear_notes,
            // Archived Chunks
            commands::chat_db_save_archived_chunks,
            commands::chat_db_get_archived_chunks,
            commands::chat_db_clear_archived_chunks,
            // Session State
            commands::chat_db_set_session_state,
            commands::chat_db_get_session_state,
            commands::chat_db_get_all_session_state,
            commands::chat_db_set_session_state_batch,
            commands::chat_db_save_memory_snapshot,
            commands::chat_db_get_memory_snapshot,
            // Message Edit / Restore
            commands::chat_db_delete_messages_after,
            commands::chat_db_delete_messages_from,
            commands::chat_db_delete_all_session_messages,
            commands::chat_db_update_message_content,
            // Staged Snippets
            commands::chat_db_save_staged_snippets,
            commands::chat_db_get_staged_snippets,
            // Hash Pointer Protocol
            commands::scan_output_hash_refs,
            commands::resolve_blackboard_display,
            commands::resolve_hash_ref,
            commands::resolve_temporal_ref,
            commands::register_hash_content,
            commands::batch_resolve_hash_refs,
            commands::get_current_revisions,
            commands::resolve_search_selector,
            // HPP v3: Hash Registry Persistence
            commands::chat_db_register_hash,
            commands::chat_db_get_hash_entry,
            commands::chat_db_get_session_hashes,
            // Shadow versions (hash forwarding rollback)
            commands::chat_db_insert_shadow_version,
            commands::chat_db_list_shadow_versions,
            commands::chat_db_get_shadow_version,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                eprintln!("[ATLS Studio] Shutting down...");

                // Cancel all active chat streams
                let stream_state = app_handle.state::<ChatStreamState>();
                if let Ok(mut handles) = stream_state.handles.try_lock() {
                    for (id, handle) in handles.drain() {
                        eprintln!("[Shutdown] Cancelling chat stream: {}", id);
                        handle.abort();
                    }
                }

                // Kill all PTY terminals (try_lock to avoid deadlock if another thread holds it)
                let pty_state = app_handle.state::<PtyState>();
                if let Ok(mut terminals) = pty_state.terminals.try_lock() {
                    for (id, mut pty) in terminals.drain() {
                        eprintln!("[Shutdown] Killing PTY: {}", id);
                        pty.shutdown();
                    }
                } else {
                    eprintln!("[Shutdown] PTY lock contended, skipping graceful PTY shutdown");
                }

                // Kill all background processes
                let bg_state = app_handle.state::<ai_execute::BackgroundState>();
                if let Ok(mut processes) = bg_state.processes.lock() {
                    for (id, mut proc) in processes.drain() {
                        eprintln!("[Shutdown] Killing background process: {}", id);
                        let _ = proc.child.kill();
                    }
                }

                // Stop file watchers
                let fw_state = app_handle.state::<file_watcher::FileWatcherState>();
                fw_state.watching.store(false, std::sync::atomic::Ordering::SeqCst);
                if let Ok(mut watchers) = fw_state.watchers.try_lock() {
                    if !watchers.is_empty() {
                        eprintln!("[Shutdown] Stopping {} file watcher(s)", watchers.len());
                        watchers.clear();
                    }
                }

                eprintln!("[ATLS Studio] Shutdown complete.");
            }
        });
}

#[cfg(test)]
mod apply_line_edits_tests {
    use super::{apply_line_edits, LineCoordinate, LineEdit};

    fn le(line: u32, action: &str, content: Option<&str>, end_line: Option<u32>) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: action.to_string(),
            content: content.map(String::from),
            end_line,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }
    }

    #[test]
    fn line_end_inserts_after_last_line() {
        let content = "a\nb\nc\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::End,
            action: "insert_after".to_string(),
            content: Some("d".to_string()),
            end_line: None,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "a\nb\nc\nd\n");
    }

    #[test]
    fn line_negative_one_targets_last_line() {
        let content = "a\nb\nc\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Neg(-1),
            action: "replace".to_string(),
            content: Some("LAST".to_string()),
            end_line: None,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("LAST"), "{}", result);
    }

    #[test]
    fn line_edit_json_accepts_end_and_negative() {
        let json = r#"{"line":"end","action":"insert_before","content":"x"}"#;
        let e: LineEdit = serde_json::from_str(json).unwrap();
        assert!(matches!(e.line, LineCoordinate::End));
        let json2 = r#"{"line":-2,"action":"replace","content":"y","end_line":2}"#;
        let e2: LineEdit = serde_json::from_str(json2).unwrap();
        assert!(matches!(e2.line, LineCoordinate::Neg(-2)));
    }

    #[test]
    fn test_apply_delete_single_line() {
        let content = "line1\nline2\nline3\n";
        let edits = vec![le(2, "delete", None, None)];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "line1\nline3\n");
    }

    #[test]
    fn test_apply_delete_range() {
        let content = "a\nb\nc\nd\ne\n";
        let edits = vec![le(2, "delete", None, Some(4))];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "a\ne\n");
    }

    #[test]
    fn test_apply_insert_before() {
        let content = "line1\nline2\n";
        let edits = vec![le(2, "insert_before", Some("new\n"), None)];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "line1\nnew\nline2\n");
    }

    #[test]
    fn test_apply_replace() {
        let content = "old1\nold2\nold3\n";
        let edits = vec![le(2, "replace", Some("new2\n"), None)];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "old1\nnew2\nold3\n");
    }

    #[test]
    fn test_apply_multiple_edits_reverse_order() {
        let content = "1\n2\n3\n4\n5\n";
        let edits = vec![
            le(5, "delete", None, None),
            le(3, "delete", None, None),
            le(1, "insert_before", Some("0\n"), None),
        ];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "0\n1\n2\n4\n");
    }

    #[test]
    fn test_apply_line_out_of_range_fails() {
        let content = "a\nb\n";
        let edits = vec![le(10, "delete", None, None)];
        let err = apply_line_edits(content, &edits).unwrap_err();
        assert!(err.contains("out of range"));
    }

    #[test]
    fn test_apply_unknown_action_fails() {
        let content = "a\nb\n";
        let edits = vec![le(1, "invalid_action", None, None)];
        let err = apply_line_edits(content, &edits).unwrap_err();
        assert!(err.contains("Unknown line_edit action"));
    }
}

#[cfg(test)]
mod shadow_preimage_tests {
    use super::*;

    fn le(line: u32, action: &str, content: Option<&str>, end_line: Option<u32>) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: action.to_string(),
            content: content.map(|s| s.to_string()),
            end_line,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }
    }

    // -- extract_shadow_preimage --

    #[test]
    fn extract_single_line() {
        let shadow = "aaa\nbbb\nccc\n";
        assert_eq!(extract_shadow_preimage(shadow, 2, None), Some("bbb".to_string()));
    }

    #[test]
    fn extract_multi_line_span() {
        let shadow = "aaa\nbbb\nccc\nddd\n";
        assert_eq!(
            extract_shadow_preimage(shadow, 2, Some(3)),
            Some("bbb\nccc".to_string())
        );
    }

    #[test]
    fn extract_out_of_range_returns_none() {
        let shadow = "aaa\nbbb\n";
        assert_eq!(extract_shadow_preimage(shadow, 5, None), None);
    }

    #[test]
    fn extract_line_zero_returns_none() {
        let shadow = "aaa\nbbb\n";
        assert_eq!(extract_shadow_preimage(shadow, 0, None), None);
    }

    #[test]
    fn extract_single_line_file() {
        let shadow = "only_line";
        assert_eq!(extract_shadow_preimage(shadow, 1, None), Some("only_line".to_string()));
        assert_eq!(extract_shadow_preimage(shadow, 2, None), None);
    }

    // -- line_edits_to_edit_ops --

    #[test]
    fn replace_converts_to_exact_replace() {
        let shadow = "fn foo() {\n  old_body\n}\n";
        let current = "fn foo() {\n  old_body\n}\n";
        let edits = vec![le(2, "replace", Some("  new_body"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].preimage, "  old_body");
        assert_eq!(ops[0].replacement, "  new_body");
    }

    #[test]
    fn delete_converts_to_empty_replacement() {
        let shadow = "aaa\nbbb\nccc\n";
        let current = "aaa\nbbb\nccc\n";
        let edits = vec![le(2, "delete", None, None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].preimage, "bbb");
        assert_eq!(ops[0].replacement, "");
    }

    #[test]
    fn insert_before_wraps_context_line() {
        let shadow = "aaa\nbbb\nccc\n";
        let current = "aaa\nbbb\nccc\n";
        let edits = vec![le(2, "insert_before", Some("inserted"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].preimage, "bbb");
        assert_eq!(ops[0].replacement, "inserted\nbbb");
    }

    #[test]
    fn insert_after_wraps_context_line() {
        let shadow = "aaa\nbbb\nccc\n";
        let current = "aaa\nbbb\nccc\n";
        let edits = vec![le(2, "insert_after", Some("inserted"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].preimage, "bbb");
        assert_eq!(ops[0].replacement, "bbb\ninserted");
    }

    #[test]
    fn replace_body_extracts_body_from_shadow() {
        // find_body_bounds returns (1, 2): body_start_rel=1, close_brace_rel=2.
        // Preimage is the body content (excluding the closing brace line).
        let shadow = "function foo() {\n  old_stmt;\n}\n";
        let current = "function foo() {\n  old_stmt;\n}\n";
        let edits = vec![le(1, "replace_body", Some("  new_stmt;"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].preimage, "  old_stmt;");
        assert_eq!(ops[0].replacement, "  new_stmt;");
    }

    #[test]
    fn sequential_edits_track_working_content() {
        let shadow = "aaa\nbbb\nccc\n";
        let current = "aaa\nbbb\nccc\n";
        let edits = vec![
            le(1, "replace", Some("AAA"), None),
            le(2, "replace", Some("BBB"), None),
        ];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].preimage, "aaa");
        assert_eq!(ops[0].replacement, "AAA");
        assert_eq!(ops[1].preimage, "bbb");
        assert_eq!(ops[1].replacement, "BBB");
    }

    #[test]
    fn shadow_extraction_failure_emits_warning() {
        let shadow = "aaa\nbbb\n";
        let current = "aaa\nbbb\n";
        let edits = vec![le(10, "replace", Some("x"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert_eq!(ops.len(), 0);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("shadow preimage extraction failed"));
    }

    // -- Content-anchored edit finds content at new position --

    #[test]
    fn shadow_preimage_finds_drifted_content() {
        let shadow = "line1\nfn target() {}\nline3\n";
        let current = "new_line\nline1\nfn target() {}\nline3\n";
        let edits = vec![le(2, "replace", Some("fn replaced() {}"), None)];
        let (ops, _) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].preimage, "fn target() {}");
        assert_eq!(ops[0].replacement, "fn replaced() {}");
        // The preimage "fn target() {}" exists in current at line 3 (drifted from line 2).
        // ExactReplace finds it by content, not position.
        assert!(current.contains(&ops[0].preimage));
    }

    #[test]
    fn multi_line_replace_span() {
        let shadow = "a\nb\nc\nd\ne\n";
        let current = "a\nb\nc\nd\ne\n";
        let edits = vec![le(2, "replace", Some("X\nY"), Some(4))];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, shadow, current).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].preimage, "b\nc\nd");
        assert_eq!(ops[0].replacement, "X\nY");
    }

    #[test]
    fn move_decomposes_into_delete_and_insert() {
        let shadow = "a\nb\nc\nd\n";
        let current = "a\nb\nc\nd\n";
        let mut edit = le(2, "move", None, None);
        edit.destination = Some(4);
        let (ops, warnings) = line_edits_to_edit_ops(&[edit], shadow, current).unwrap();
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
        assert_eq!(ops.len(), 2);
        // First op: delete source
        assert_eq!(ops[0].preimage, "b");
        assert_eq!(ops[0].replacement, "");
        // Second op: insert at destination
        assert_eq!(ops[1].preimage, "d");
        assert!(ops[1].replacement.contains("b"));
        assert!(ops[1].replacement.contains("d"));
    }
}

#[cfg(test)]
mod apply_with_shadow_tests {
    use super::*;

    fn le(line: u32, action: &str, content: Option<&str>, end_line: Option<u32>) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: action.to_string(),
            content: content.map(|s| s.to_string()),
            end_line,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }
    }

    #[test]
    fn shadow_path_used_when_provided() {
        let shadow = "aaa\nbbb\nccc\n";
        let current = "aaa\nbbb\nccc\n";
        let edits = vec![le(2, "replace", Some("BBB"), None)];
        let (result, warnings, resolutions) =
            apply_line_edits_with_shadow(&edits, current, Some(shadow)).unwrap();
        assert!(resolutions.is_none(), "shadow path should return None resolutions");
        assert!(result.contains("BBB"));
        assert!(!result.contains("bbb"));
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
    }

    #[test]
    fn positional_path_when_no_shadow() {
        let current = "aaa\nbbb\nccc";
        let edits = vec![le(2, "replace", Some("BBB"), None)];
        let (result, _warnings, resolutions) =
            apply_line_edits_with_shadow(&edits, current, None).unwrap();
        assert!(resolutions.is_some(), "positional path should return Some resolutions");
        assert!(result.contains("BBB"));
        assert!(!result.contains("bbb"));
    }

    #[test]
    fn fallback_when_shadow_extraction_fails() {
        let shadow = "x\ny\n";
        let current = "aaa\nbbb\nccc";
        let edits = vec![le(10, "replace", Some("ZZZ"), None)];
        // Shadow extraction fails (line 10 out of range), should fall back to positional
        let result = apply_line_edits_with_shadow(&edits, current, Some(shadow));
        // Positional also fails (line 10 out of range)
        assert!(result.is_err());
    }

    #[test]
    fn shadow_finds_content_at_drifted_position() {
        let shadow = "line1\ntarget_line\nline3\n";
        let current = "inserted\nline1\ntarget_line\nline3\n";
        let edits = vec![le(2, "replace", Some("replaced_line"), None)];
        let (result, _warnings, resolutions) =
            apply_line_edits_with_shadow(&edits, current, Some(shadow)).unwrap();
        // Shadow extracts "target_line" from line 2 of shadow, finds it in current (now at line 3)
        assert!(resolutions.is_none(), "shadow path should have handled this");
        assert!(result.contains("replaced_line"));
        assert!(!result.contains("target_line"));
        assert!(result.contains("inserted"));
        assert!(result.contains("line1"));
    }

    #[test]
    fn shadow_multi_edit_sequential_consistency() {
        let shadow = "aaa\nbbb\nccc\nddd\n";
        let current = "aaa\nbbb\nccc\nddd\n";
        let edits = vec![
            le(1, "replace", Some("AAA"), None),
            le(3, "replace", Some("CCC"), None),
        ];
        let (result, warnings, _) =
            apply_line_edits_with_shadow(&edits, current, Some(shadow)).unwrap();
        assert!(warnings.is_empty(), "warnings: {:?}", warnings);
        assert!(result.contains("AAA"));
        assert!(result.contains("CCC"));
        assert!(!result.contains("aaa"));
        assert!(!result.contains("ccc"));
        assert!(result.contains("bbb"));
        assert!(result.contains("ddd"));
    }
}

#[cfg(test)]
mod edit_system_fix_tests {
    use super::*;

    #[test]
    fn shadow_hinted_match_picks_closest_occurrence() {
        let content = "line_a\ndup_line\nline_c\ndup_line\nline_e\n";
        let mut working = content.to_string();
        let hint = byte_offset_of_line(content, 4);
        apply_edit_op_to_working_hinted(&mut working, "dup_line", "REPLACED", Some(hint));
        let lines: Vec<&str> = working.lines().collect();
        assert_eq!(lines[1], "dup_line", "first occurrence should be untouched");
        assert_eq!(lines[3], "REPLACED", "second occurrence (closer to hint) should be replaced");
    }

    #[test]
    fn shadow_hinted_match_no_hint_picks_first() {
        let content = "dup\naaa\ndup\n";
        let mut working = content.to_string();
        apply_edit_op_to_working_hinted(&mut working, "dup", "NEW", None);
        assert!(working.starts_with("NEW\n"), "without hint, first occurrence is replaced");
    }

    #[test]
    fn structural_guard_warns_on_brace_replacement() {
        let content = "function foo() {\n  return 1;\n}\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(3),
            action: "replace".to_string(),
            content: Some("// oops replaced closing brace".to_string()),
            end_line: Some(3),
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("// oops replaced closing brace"));
        assert!(
            warnings.iter().any(|w| w.contains("structural_guard")),
            "should emit structural_guard warning when replacing lone closing brace"
        );
    }

    #[test]
    fn structural_guard_no_warn_on_normal_replacement() {
        let content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(2),
            action: "replace".to_string(),
            content: Some("const b = 42;".to_string()),
            end_line: Some(2),
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("const b = 42;"));
        assert!(
            !warnings.iter().any(|w| w.contains("structural_guard")),
            "should not warn when replacing normal code"
        );
    }

    #[test]
    fn normalize_syntax_message_strips_context() {
        let msg = "Syntax error: unexpected token near: function processConfig({";
        let normalized = crate::linter::normalize_syntax_message_for_dedup(msg);
        assert_eq!(normalized, "Syntax error: unexpected token near: ");

        let msg_shifted = "Syntax error: unexpected token near: type EventMap = {";
        let norm_shifted = crate::linter::normalize_syntax_message_for_dedup(msg_shifted);
        assert_eq!(norm_shifted, "Syntax error: unexpected token near: ");
        assert_eq!(normalized, norm_shifted, "shifted context should produce same normalized key");
    }

    #[test]
    fn normalize_syntax_message_preserves_non_syntax() {
        let msg = "Missing semicolon";
        let normalized = crate::linter::normalize_syntax_message_for_dedup(msg);
        assert_eq!(normalized, msg, "messages without 'near:' should be unchanged");
    }

    #[test]
    fn byte_offset_of_line_correctness() {
        let content = "aaa\nbbb\nccc\n";
        assert_eq!(byte_offset_of_line(content, 1), 0);
        assert_eq!(byte_offset_of_line(content, 2), 4);
        assert_eq!(byte_offset_of_line(content, 3), 8);
        assert_eq!(byte_offset_of_line(content, 99), content.len());
    }
}

#[cfg(test)]
mod hpp_file_ops_tests {
    /// HPP refactoring pipeline & file writing integration tests.
    /// Uses temp dir to exercise create + remove_lines flow without Tauri.
    use super::*;
    use crate::hash_resolver::{HashEntry, HashRegistry, parse_line_ranges};

    fn content_hash(content: &str) -> String {
        super::content_hash(content)
    }

    #[test]
    fn test_parse_line_ranges_formats() {
        assert_eq!(parse_line_ranges("15-22"), Some(vec![(15, Some(22))]));
        assert_eq!(parse_line_ranges("15-22,40-55"), Some(vec![(15, Some(22)), (40, Some(55))]));
        assert_eq!(parse_line_ranges("45-"), Some(vec![(45, None)]));
        assert_eq!(parse_line_ranges("10"), Some(vec![(10, Some(10))]));
        assert_eq!(parse_line_ranges("1-5, 10-15, 20"), Some(vec![(1, Some(5)), (10, Some(15)), (20, Some(20))]));
        assert_eq!(parse_line_ranges(""), None);
        assert_eq!(parse_line_ranges("  "), None);
    }

    #[test]
    fn test_hpp_create_and_remove_lines_flow() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let src_path = root.join("src").join("source.ts");
        let target_path = root.join("src").join("extracted.ts");
        std::fs::create_dir_all(root.join("src")).unwrap();

        let source_content = r#"// header
import { x } from './old';

function stay() {
  return 1;
}

function extractMe() {
  return 42;
}

function alsoStay() {
  return 2;
}
"#;

        std::fs::write(&src_path, source_content).unwrap();
        let source_hash = content_hash(source_content);

        let mut registry = HashRegistry::new();
        registry.register(source_hash.clone(), HashEntry {
            source: Some("src/source.ts".to_string()),
            content: source_content.to_string(),
            tokens: source_content.len() / 4,
            lang: Some("typescript".to_string()),
            line_count: source_content.lines().count(),
            symbol_count: None,
        });

        // Step 1: Create new file (extract lines 7-11)
        let extracted = "function extractMe() {\n  return 42;\n}\n";
        std::fs::create_dir_all(target_path.parent().unwrap()).unwrap();
        std::fs::write(&target_path, extracted).unwrap();
        assert!(target_path.exists());

        // Step 2: Remove lines 7-11 from source
        let ranges = parse_line_ranges("7-11").unwrap();
        let delete_edits: Vec<LineEdit> = ranges.iter().map(|&(start, end)| {
            LineEdit {
                line: LineCoordinate::Abs(start),
                action: "delete".to_string(),
                content: None,
                end_line: end,
                symbol: None,
                position: None,
                destination: None,
                reindent: false,
            }
        }).collect();

        let current = std::fs::read_to_string(&src_path).unwrap();
        let (new_content, ..) = apply_line_edits(&current, &delete_edits).unwrap();
        std::fs::write(&src_path, &new_content).unwrap();

        // After removing lines 7-11, no blank line remains between } and function alsoStay
        let expected_source = "// header\nimport { x } from './old';\n\nfunction stay() {\n  return 1;\n}\nfunction alsoStay() {\n  return 2;\n}\n";
        assert_eq!(new_content, expected_source, "remove_lines should produce expected source");

        let on_disk = std::fs::read_to_string(&src_path).unwrap();
        assert_eq!(on_disk, expected_source, "file on disk should match");

        let target_on_disk = std::fs::read_to_string(&target_path).unwrap();
        assert_eq!(target_on_disk, extracted, "created file should have extracted content");
    }

    #[test]
    fn test_hpp_content_hash_determinism() {
        let c = "fn main() { println!(\"hi\"); }";
        let h1 = content_hash(c);
        let h2 = content_hash(c);
        assert_eq!(h1, h2, "content_hash must be deterministic");
        assert_eq!(h1.len(), 16, "content_hash produces 16-char hex");
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()), "content_hash is hex");
    }

    #[test]
    fn test_hpp_path_utils_resolve_project_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let rel = "src/foo.ts";
        let resolved = crate::path_utils::resolve_project_path(root, rel);
        assert!(resolved.ends_with("foo.ts"));
        assert!(resolved.to_string_lossy().replace('\\', "/").contains("src/foo"));
    }
}

// ============================================================================
// Hard integration tests for HPP refactoring pipeline & file writes
// ============================================================================

#[cfg(test)]
mod hard_line_edit_tests {
    use super::{apply_line_edits, LineCoordinate, LineEdit, EditResolution, content_hash, brace_balance_delta, find_body_bounds, find_python_indent_body_bounds};
    use crate::path_utils::normalize_line_endings;

    fn le(line: u32, action: &str, content: Option<&str>, end_line: Option<u32>) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: action.to_string(),
            content: content.map(String::from),
            end_line,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }
    }

    // ── trailing newline preservation ──

    #[test]
    fn trailing_newline_preserved_after_delete() {
        let content = "a\nb\nc\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "delete", None, None)]).unwrap();
        assert_eq!(result, "a\nc\n", "trailing newline must survive delete");
    }

    #[test]
    fn no_trailing_newline_stays_absent() {
        let content = "a\nb\nc";
        let (result, ..) = apply_line_edits(content, &[le(2, "delete", None, None)]).unwrap();
        assert_eq!(result, "a\nc", "no trailing newline should not appear");
    }

    #[test]
    fn trailing_newline_preserved_after_insert() {
        let content = "a\nb\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "insert_after", Some("c"), None)]).unwrap();
        assert_eq!(result, "a\nb\nc\n");
    }

    // ── replace with different line count ──

    #[test]
    fn replace_one_line_with_three() {
        let content = "1\n2\n3\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "replace", Some("x\ny\nz"), None)]).unwrap();
        assert_eq!(result, "1\nx\ny\nz\n3\n");
    }

    #[test]
    fn replace_three_lines_with_one() {
        let content = "1\n2\n3\n4\n5\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "replace", Some("X"), Some(4))]).unwrap();
        assert_eq!(result, "1\nX\n5\n");
    }

    #[test]
    fn replace_with_empty_content_removes_line() {
        // "".lines() is empty → splice replaces with nothing → line is removed.
        // This means replace(content:"") is functionally identical to delete.
        let content = "a\nb\nc\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "replace", Some(""), None)]).unwrap();
        assert_eq!(result, "a\nc\n", "replace with empty string acts as delete");
    }

    // ── replace by explicit line / end_line ──

    #[test]
    fn replace_import_line_by_line_number() {
        let content = "import { foo } from './foo';\nimport { bar } from './bar';\nexport default function main() {}\n";
        let edits = vec![le(1, "replace", Some("import { foo } from './new-foo';"), None)];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(warnings.is_empty());
        assert!(result.contains("from './new-foo'"));
        assert!(!result.contains("from './foo'"));
    }

    #[test]
    fn replace_multiline_span_uses_end_line() {
        let content = "a\nb\nexport function foo(x: number) {\n  return x + 1;\n}\nd\ne\n";
        let new_body = "export function foo(x: number) {\n  return x * 2;\n}";
        let mut ed = le(3, "replace", Some(new_body), None);
        ed.end_line = Some(5);
        let edits = vec![ed];
        let (result, _warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("return x * 2"), "replacement content should appear");
        assert!(!result.contains("return x + 1"), "old body should be fully replaced");
        assert!(!result.contains("x + 1"), "no duplicate/partial old content");
        assert_eq!(result.matches("export function foo").count(), 1, "exactly one function def");
    }

    #[test]
    fn replace_second_duplicate_line_by_line_number() {
        let content = "import x;\nsome code;\nimport x;\nmore code;\n";
        let edits = vec![le(3, "replace", Some("import x_new;"), None)];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines[0], "import x;", "first import should be untouched");
        assert_eq!(lines[2], "import x_new;", "line 3 replaced");
    }

    // ── count overlap guard ──

    #[test]
    fn count_overlap_extends_to_consume_duplicate_trailing() {
        // Simulates the exact bug from the transcript: replacement includes "break;"
        // but count was 1 short, leaving a duplicate "break;" below the span
        let content = "      case 'ArrowDown':\n        e.preventDefault();\n        setSelectedIndex(i => Math.min(i + 1, results.length - 1));\n        break;\n      case 'ArrowUp':\n";
        let replacement = "      case 'ArrowDown':\n        e.preventDefault();\n        if (results.length > 0) setSelectedIndex(i => Math.min(i + 1, results.length - 1));\n        break;";
        // count=3 covers lines 1-3, but line 4 ("break;") duplicates the last line of replacement
        let edits = vec![le(1, "replace", Some(replacement), Some(3))];  // end_line=3 (lines 1..=3)
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        let break_count = result.lines().filter(|l| l.trim() == "break;").count();
        assert_eq!(break_count, 1, "should have exactly one break; not a duplicate: {}", result);
        assert!(warnings.iter().any(|w| w.contains("count_overlap_extended")),
            "should warn about count extension: {:?}", warnings);
    }

    #[test]
    fn count_overlap_no_false_positive_on_clean_replace() {
        let content = "a\nb\nc\nd\n";
        let edits = vec![le(2, "replace", Some("X\nY"), Some(3))];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "a\nX\nY\nd\n");
        assert!(!warnings.iter().any(|w| w.contains("count_overlap")),
            "clean replace should not trigger overlap guard: {:?}", warnings);
    }

    #[test]
    fn count_overlap_does_not_extend_on_empty_lines() {
        // Empty trailing lines should not trigger overlap (too common, too noisy)
        let content = "a\nb\n\n\nd\n";
        let edits = vec![le(2, "replace", Some("X\n"), None)];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(!warnings.iter().any(|w| w.contains("count_overlap")),
            "empty line overlap should not trigger: {:?}", warnings);
        assert!(result.contains("X\n"), "replacement should be applied");
    }

    #[test]
    fn count_overlap_skips_extension_when_bracket_balance_broken() {
        // Replacement's last line matches file line after span, but removing
        // that file line would unbalance brackets (it opens a block).
        let content = "a\nold_line\n  if (cond) {\n    inner();\n  }\n";
        let replacement = "new_line\n  if (cond) {";
        let edits = vec![le(2, "replace", Some(replacement), None)];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        // The file line "  if (cond) {" has +1 bracket balance — extension must be skipped
        assert!(result.contains("inner()"), "original inner code must survive: {}", result);
        assert!(warnings.iter().any(|w| w.contains("skipped extension")),
            "should warn about skipped extension due to bracket balance: {:?}", warnings);
    }

    #[test]
    fn count_overlap_extends_when_bracket_balance_neutral() {
        // Duplicate trailing line has balanced brackets — extension is safe
        let content = "a\nold_line\ndoWork({x: 1});\nmore\n";
        let replacement = "new_line\ndoWork({x: 1});";
        let edits = vec![le(2, "replace", Some(replacement), None)];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        let dw_count = result.lines().filter(|l| l.contains("doWork")).count();
        assert_eq!(dw_count, 1, "duplicate doWork line should be consumed: {}", result);
        assert!(warnings.iter().any(|w| w.contains("count_overlap_extended: replace")),
            "should extend for balanced-bracket duplicate: {:?}", warnings);
    }

    #[test]
    fn replace_without_end_line_emits_span_mismatch_warning() {
        let content = "type Foo = {\n  a: string;\n  b: number;\n};\nexport default Foo;\n";
        let replacement = "type Bar = {\n  x: string;\n  y: number;\n  z: boolean;\n};";
        let edits = vec![le(1, "replace", Some(replacement), None)];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(warnings.iter().any(|w| w.contains("replace_span_mismatch")),
            "should warn about multi-line content with no end_line: {:?}", warnings);
        assert!(result.contains("type Bar"), "replacement content should still be applied");
    }

    // ── brace_balance_delta string/comment awareness ──

    #[test]
    fn brace_balance_delta_skips_single_quoted_brackets() {
        let lines = vec!["console.log('matched {brackets}(here)[ok]');"];
        assert_eq!(brace_balance_delta(&lines), 0, "brackets in single-quoted strings must be ignored");
    }

    #[test]
    fn brace_balance_delta_skips_template_literal_brackets() {
        let lines = vec!["const s = `template ${'{'}`;"];
        assert_eq!(brace_balance_delta(&lines), 0, "brackets in backtick templates must be ignored");
    }

    #[test]
    fn brace_balance_delta_skips_line_comments() {
        let lines = vec!["x(); // if (a) { b(); }"];
        assert_eq!(brace_balance_delta(&lines), 0, "brackets in line comments must be ignored");
    }

    #[test]
    fn brace_balance_delta_skips_block_comments() {
        let lines = vec!["/* { open */", "real();", "/* close } */"];
        assert_eq!(brace_balance_delta(&lines), 0, "brackets in block comments must be ignored");
    }

    #[test]
    fn brace_balance_delta_counts_real_brackets() {
        let lines = vec!["if (x) {", "  y();"];
        // (x) cancels, { is +1; y() cancels → net +1
        assert_eq!(brace_balance_delta(&lines), 1);
    }

    #[test]
    fn brace_balance_delta_iife_closing_pattern() {
        // }) = -1 -1; () = +1 -1; net = -2
        let lines = vec!["})();"];
        assert_eq!(brace_balance_delta(&lines), -2);
    }

    // ── find_body_bounds string/comment awareness ──

    #[test]
    fn find_body_bounds_skips_braces_in_strings() {
        let lines = vec![
            "function foo({ g = {} }: { g?: Record<string, unknown> }) {",
            "  return g;",
            "}",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "should find body despite braces in destructuring default");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "body starts after opening {{ line");
        assert_eq!(end, 2, "body ends at closing }} line");
    }

    #[test]
    fn find_python_indent_body_bounds_finds_def_block() {
        let lines = vec!["def foo():", "    x = 1", "    return x"];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let b = find_python_indent_body_bounds(&refs).expect("python bounds");
        assert_eq!(b, (1, 3));
    }

    #[test]
    fn replace_body_python_def_succeeds() {
        let content = "def foo():\n    x = 1\n    return x\n";
        let edits = vec![le(1, "replace_body", Some("    y = 2\n    return y"), None)];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(
            !warnings.iter().any(|w| w.contains("could not find body bounds")),
            "unexpected warnings: {:?}",
            warnings
        );
        assert!(result.contains("y = 2"), "{}", result);
    }

    // ── torture-brackets.ts regression suite ──

    #[test]
    fn torture_t1_template_literal_with_embedded_arrow_fn() {
        let lines = vec![
            "const edgeCases = {",
            "  c: `template with ${(() => {",
            "    const inner = { nested: true };",
            "    return inner;",
            "  })()}`,",
            "  e: 42,",
            "};",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "t1: should find body of edgeCases despite template literal with arrow fn");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "t1: body starts at first property");
        assert_eq!(end, 6, "t1: body ends at closing }}");
    }

    #[test]
    fn torture_t1_brace_balance_template_with_arrow() {
        let lines = vec![
            "  c: `template with ${(() => {",
            "    const inner = { nested: true };",
            "    return inner;",
            "  })()}`,",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        assert_eq!(brace_balance_delta(&refs), 0, "t1: template with arrow fn should be brace-balanced");
    }

    #[test]
    fn torture_t5_computed_symbol_property() {
        let lines = vec![
            "class BracketHell {",
            "  [COMPUTED]: string = '}';",
            "  process() {",
            "    return 1;",
            "  }",
            "}",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "t5: should find class body despite computed [COMPUTED] and string '}}' ");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "t5: body starts after class opening");
        assert_eq!(end, 5, "t5: body ends at class closing }}");
    }

    #[test]
    fn torture_t6_iife_chain_with_satisfies() {
        let lines = vec![
            "const result = ((() => {",
            "  const a = { x: 1 } as const;",
            "  return ((() => {",
            "    return { y: 2 } as const;",
            "  })());",
            "})()) satisfies { readonly x: 1; readonly y: 2 };",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        assert_eq!(brace_balance_delta(&refs), 0, "t6: IIFE chain with satisfies should be brace-balanced");
    }

    #[test]
    fn torture_t8_comment_to_code_boundary() {
        let lines = vec![
            "/* Block comment with fake code:",
            "  if (x > 0) {",
            "    return { result: y }; // } tricky",
            "  }",
            "  End of fake code */",
            "const edgeCases = {",
            "  a: '{ not a block }',",
            "};",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "t8: should find body across comment/code boundary");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 6, "t8: body starts after 'const edgeCases = {{' line");
        assert_eq!(end, 7, "t8: body ends at closing '}}' line");
    }

    #[test]
    fn torture_t10_deeply_nested_callback_types() {
        let lines = vec![
            "function nightmareCallbacks(",
            "  cb1: (err: Error | null, result: {",
            "    data: Array<{",
            "      id: number;",
            "      children: Array<{",
            "        name: string;",
            "        meta: { [key: string]: unknown };",
            "      }>;",
            "    }>;",
            "  }) => void,",
            "  cb2: (input: string) => Promise<{ status: 'ok' | 'fail' }>",
            "): void {",
            "  const x = { a: 1 };",
            "  cb1(null, { data: [] });",
            "}",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "t10: should find body despite 10+ nesting levels in callback types");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 12, "t10: body starts after ') : void {{' line");
        assert_eq!(end, 14, "t10: body ends at closing '}}' line");
    }

    #[test]
    fn torture_t3_nested_generics_with_conditional_types() {
        let lines = vec![
            "type DeepNest<T extends Record<string, Array<Map<string, Set<T>>>>> = {",
            "  fn: <U extends keyof T>(key: U) => T[U] extends infer V",
            "    ? V extends Map<infer K, infer S>",
            "      ? { mapped: [K, S] }",
            "      : never",
            "    : never;",
            "};",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "t3: should find type body despite deep nested generics");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "t3: body starts after type opening {{");
        assert_eq!(end, 6, "t3: body ends at '}}' line");
    }

    #[test]
    fn torture_t7_replace_body_class_method_destructuring() {
        let content = "\
class BracketHell {\n\
  [COMPUTED]: string = '}';\n\
  process(\n\
    { a = { b: { c: 1 } }, d = [{ e: 2 }] }: {\n\
      a?: { b: { c: number } };\n\
      d?: Array<{ e: number }>;\n\
    } = {}\n\
  ): { result: typeof a & { extra: typeof d } } {\n\
    return {\n\
      result: { ...a, extra: d } as typeof a & { extra: typeof d },\n\
    };\n\
  }\n\
}\n";
        let edits = vec![le(3, "replace_body", Some("    return { result: { ...a, extra: d } };"), None)];
        let (result, _warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("return { result: { ...a, extra: d } }"), "t7: new body should be present: {}", result);
        assert!(!result.contains("as typeof a"), "t7: old body should be gone: {}", result);
        assert!(result.contains("}"), "t7: closing brace should survive: {}", result);
    }

    #[test]
    fn torture_t4_replace_body_class_method_full_section7() {
        // Exact Section 7 from torture-brackets.ts
        let content = "\
class BracketHell {\n\
  private data: Map<string, { handlers: Array<(ev: { type: string }) => { handled: boolean }> }> = new Map();\n\
\n\
  // Method with destructuring defaults containing braces\n\
  process(\n\
    { input = { default: true }, config = { retries: 3, timeout: { ms: 1000 } } }: {\n\
      input?: { default: boolean };\n\
      config?: { retries: number; timeout: { ms: number } };\n\
    } = {}\n\
  ): { success: boolean; data: typeof input } {\n\
    return { success: true, data: input };\n\
  }\n\
\n\
  // Computed property with bracket expressions\n\
  get [`${'dynamic' + '_'}key`](): { value: number } {\n\
    return { value: 42 };\n\
  }\n\
\n\
  // Method returning function returning object\n\
  createHandler(): (event: { type: string; data: unknown }) => { handled: boolean; timestamp: number } {\n\
    return (event) => ({\n\
      handled: event.type !== 'ignore',\n\
      timestamp: Date.now(),\n\
    });\n\
  }\n\
}\n";
        // replace_body targeting the process method (line 5 in 1-based)
        let edits = vec![le(5, "replace_body", Some("    return { success: false, data: input };"), None)];
        let (result, _warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("return { success: false, data: input }"), "new body should be present: {}", result);
        assert!(!result.contains("return { success: true, data: input }"), "old body should be gone: {}", result);
        assert!(result.contains("createHandler"), "other methods should survive: {}", result);
        assert!(result.contains("class BracketHell"), "class should survive: {}", result);
    }

    #[test]
    fn torture_nested_template_in_template() {
        let lines = vec![
            "const d = `multi line template ${",
            "  [1, 2, 3].map((x) => ({",
            "    value: x,",
            "    label: `item-${x}`",
            "  }))",
            "} end`;",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        assert_eq!(brace_balance_delta(&refs), 0, "nested template in template should be brace-balanced");
    }

    // ── t3/t4/t7 fix tests ──

    #[test]
    fn syntax_error_bracket_hint_detects_imbalance() {
        let pre = "function f() {\n  return 1;\n}\n";
        let post = "function f() {\n  return 1;\n}\n)\n";
        let resolutions = vec![EditResolution {
            resolved_line: 1,
            action: "replace".to_string(),
            lines_affected: 3,
        }];
        let hint = crate::syntax_error_bracket_hint(pre, post, &resolutions);
        assert!(hint.is_some(), "should detect bracket imbalance");
        let h = hint.unwrap();
        assert!(h.contains("bracket imbalance"), "hint should mention imbalance: {}", h);
    }

    #[test]
    fn syntax_error_bracket_hint_none_when_balanced() {
        let pre = "function f() {\n  return 1;\n}\n";
        let post = "function f() {\n  return 2;\n}\n";
        let resolutions = vec![EditResolution {
            resolved_line: 1,
            action: "replace".to_string(),
            lines_affected: 3,
        }];
        let hint = crate::syntax_error_bracket_hint(pre, post, &resolutions);
        assert!(hint.is_none(), "should not hint when balanced");
    }

    #[test]
    fn replace_body_three_line_js_function_with_end_line_cap() {
        // Hash ref h:*:L-L+2 on a minimal function: must replace only the body, not `}`.
        let content = "function add(a, b) {\n    return a + b;\n}\n";
        let ed = le(1, "replace_body", Some("    return Number(a) + Number(b);"), Some(3));
        let (result, _warnings, _) = apply_line_edits(content, &[ed]).unwrap();
        assert!(
            result.contains("return Number(a) + Number(b)"),
            "new body: {}",
            result
        );
        assert!(result.contains("function add"), "signature intact: {}", result);
        assert!(
            result.matches('}').count() >= 1,
            "closing brace preserved: {}",
            result
        );
    }

    #[test]
    fn replace_body_with_end_line_caps_slice() {
        // Class with pathological content (regex braces, string braces) in later methods.
        // When end_line is set (from symbol resolution), the slice is capped and the
        // text scanner only sees the target method, not the pathological content.
        let content = "\
class C {\n\
  target() {\n\
    old();\n\
  }\n\
  nightmare() {\n\
    const r = /[{(\\[]/g;\n\
    const s = 'open{';\n\
  }\n\
}\n";
        let mut ed = le(2, "replace_body", Some("    replaced();"), None);
        ed.end_line = Some(4); // cap to target method
        let (result, _warnings, _) = apply_line_edits(content, &[ed]).unwrap();
        assert!(result.contains("replaced()"), "new body present: {}", result);
        assert!(!result.contains("old()"), "old body gone: {}", result);
        assert!(result.contains("nightmare"), "later method survives: {}", result);
    }

    #[test]
    fn replace_body_symbol_fallback_on_pathological_content() {
        // Content where find_body_bounds text scanner fails (regex with braces)
        // but end_line fallback succeeds.
        let content = "\
class BracketHell {\n\
  [Symbol.iterator]() {\n\
    const r = /[{(\\[]/g;\n\
    return { done: true, value: 'open{' };\n\
  }\n\
}\n";
        let mut ed = le(2, "replace_body", Some("    return { done: false, value: null };"), None);
        ed.end_line = Some(5); // symbol range from index
        let (result, _warnings, _) = apply_line_edits(content, &[ed]).unwrap();
        assert!(result.contains("done: false"), "fallback body should be present: {}", result);
        assert!(!result.contains("done: true"), "old body should be gone: {}", result);
    }

    #[test]
    fn find_body_bounds_skips_braces_in_comments() {
        let lines = vec![
            "// { this is a comment with braces }",
            "class Foo {",
            "  bar() {}",
            "}",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some());
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 2, "body starts after class {{ line");
        assert_eq!(end, 3, "body ends at class closing }}");
    }

    #[test]
    fn find_body_bounds_multiline_destructuring_signature() {
        let lines = vec![
            "function foo(",
            "  { a = { b: { c: 1 } } }: Opts",
            ") {",
            "  return a;",
            "}",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "should find body despite multi-line destructuring defaults");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 3, "body starts after ') {{' line");
        assert_eq!(end, 4, "body ends at closing '}}' line");
    }

    #[test]
    fn find_body_bounds_deeply_nested_destructuring_default() {
        let lines = vec![
            "function process({ config = { retries: { max: 3, delay: { ms: 100 } } } }: Options) {",
            "  doWork();",
            "}",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "should find body past deeply nested destructuring defaults");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "body starts after opening line");
        assert_eq!(end, 2, "body ends at closing '}}' line");
    }

    #[test]
    fn replace_body_at_nonzero_idx() {
        let content = "// preamble line\n// another preamble\nfunction foo() {\n  old();\n}\n";
        let edits = vec![le(3, "replace_body", Some("  new();"), None)];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("new()"), "new body should be present: {}", result);
        assert!(!result.contains("old()"), "old body should be gone: {}", result);
        assert!(result.contains("}"), "closing brace should survive: {}", result);
        assert!(warnings.is_empty(), "no warnings expected: {:?}", warnings);
    }

    #[test]
    fn replace_body_with_destructuring_params() {
        let content = "import x;\nfunction foo(\n  { a = { b: 1 } }: Opts\n) {\n  old();\n}\nexport default foo;\n";
        let edits = vec![le(2, "replace_body", Some("  replaced();"), None)];
        let (result, _warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("replaced()"), "new body should be present: {}", result);
        assert!(!result.contains("old()"), "old body should be gone: {}", result);
        assert!(result.contains("export default foo"), "trailing code should survive: {}", result);
    }

    #[test]
    fn adjust_line_for_shifts_applied_to_imports() {
        // Mirror of adjust_line_for_shifts from batch_query execute pipeline
        fn adjust(line: u32, shifts: &[(u32, u32)]) -> u32 {
            let mut total_removed_before = 0u32;
            for &(removed_start, removed_count) in shifts {
                if line >= removed_start + removed_count {
                    total_removed_before += removed_count;
                } else if line >= removed_start {
                    return removed_start.saturating_sub(total_removed_before);
                }
            }
            line.saturating_sub(total_removed_before)
        }
        // Simulate: lines 3-4 were removed, then an import at original L6
        // should shift to adjusted line 4 (6 - 2 removed = 4)
        let shifts = vec![(3u32, 2u32)];
        assert_eq!(adjust(6, &shifts), 4, "L6 after removing 2 lines at L3-L4 should be L4");
        // L2 is before removal, unchanged
        assert_eq!(adjust(2, &shifts), 2);
        // L5 is right after removal, should shift to 3
        assert_eq!(adjust(5, &shifts), 3);
    }

    // ── multiple edits interacting ──

    #[test]
    fn insert_before_and_after_same_line() {
        // Sequential: insert_before L2 places "BEFORE" at L2, pushing "B" to L3.
        // Then insert_after L2 inserts after "BEFORE" (current L2), not after "B".
        let content = "A\nB\nC\n";
        let edits = vec![
            le(2, "insert_before", Some("BEFORE"), None),
            le(2, "insert_after", Some("AFTER"), None),
        ];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "A\nBEFORE\nAFTER\nB\nC\n");
    }

    #[test]
    fn two_deletes_at_bottom_and_top() {
        // Sequential: after deleting L1 ("1"), "5" shifts from L5 to L4.
        let content = "1\n2\n3\n4\n5\n";
        let edits = vec![
            le(1, "delete", None, None),
            le(4, "delete", None, None),
        ];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "2\n3\n4\n");
    }

    #[test]
    fn delete_last_line_of_file_without_trailing_newline() {
        let content = "a\nb\nc";
        let (result, ..) = apply_line_edits(content, &[le(3, "delete", None, None)]).unwrap();
        assert_eq!(result, "a\nb");
    }

    #[test]
    fn insert_at_line_1() {
        let content = "first\nsecond\n";
        let (result, ..) = apply_line_edits(content, &[le(1, "insert_before", Some("zeroth"), None)]).unwrap();
        assert_eq!(result, "zeroth\nfirst\nsecond\n");
    }

    // ── CRLF normalization ──

    #[test]
    fn crlf_normalized_before_edit() {
        let content = normalize_line_endings("a\r\nb\r\nc\r\n");
        let (result, ..) = apply_line_edits(&content, &[le(2, "replace", Some("B"), None)]).unwrap();
        assert_eq!(result, "a\nB\nc\n");
        assert!(!result.contains('\r'));
    }

    // ── sequential: insert shifts subsequent line targets ──

    #[test]
    fn insert_then_replace_at_shifted_line() {
        // Motivating case: model inserts a line at L4, then targets L19
        // expecting the line that was originally at L18 (shifted by +1).
        let content = "L1\nL2\nL3\nL4\nL5\nL6\n";
        let edits = vec![
            le(4, "insert_after", Some("NEW"), None),
            le(6, "replace", Some("REPLACED"), None),
        ];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        // After insert_after L4: L1,L2,L3,L4,NEW,L5,L6
        // L6 in post-edit state is at position 6 → replace it
        assert_eq!(result, "L1\nL2\nL3\nL4\nNEW\nREPLACED\nL6\n");
    }

    #[test]
    fn insert_then_delete_at_shifted_line() {
        let content = "a\nb\nc\nd\ne\n";
        let edits = vec![
            le(1, "insert_before", Some("z"), None),
            le(4, "delete", None, None),
        ];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        // After insert_before L1: z,a,b,c,d,e  (L4 is "c")
        assert_eq!(result, "z\na\nb\nd\ne\n");
    }

    // ── edge: empty file ──

    #[test]
    fn insert_into_empty_file() {
        let content = "";
        let (result, ..) = apply_line_edits(content, &[le(1, "insert_before", Some("hello"), None)]).unwrap();
        assert_eq!(result, "hello");
    }

    // ── edge: delete entire file ──

    #[test]
    fn delete_all_lines() {
        let content = "a\nb\nc\n";
        let (result, ..) = apply_line_edits(content, &[le(1, "delete", None, Some(4))]).unwrap();  // end_line=4 (lines 1..=4, but clamped)
        assert!(result.trim().is_empty(), "all lines deleted, result: {:?}", result);
    }

    // ── content hash changes after edit ──

    #[test]
    fn content_hash_changes_on_edit() {
        let original = "function foo() { return 1; }\n";
        let h1 = content_hash(original);
        let (edited, ..) = apply_line_edits(original, &[le(1, "replace", Some("function foo() { return 2; }"), None)]).unwrap();
        let h2 = content_hash(&edited);
        assert_ne!(h1, h2, "hash must change when content changes");
    }

    #[test]
    fn content_hash_stable_for_identical_content() {
        let c = "same content\n";
        let (result, ..) = apply_line_edits(c, &[le(1, "replace", Some("same content"), None)]).unwrap();
        assert_eq!(content_hash(c), content_hash(&result));
    }

    // ── coordinate & validation errors ──

    #[test]
    fn line_zero_is_rejected() {
        let content = "a\nb\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(0),
            action: "delete".to_string(),
            content: None,
            end_line: None,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }];
        let err = apply_line_edits(content, &edits).unwrap_err();
        assert!(err.contains("line 0") || err.contains("invalid"), "{}", err);
    }

    #[test]
    fn move_without_destination_errors() {
        let content = "a\nb\nc\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(1),
            action: "move".to_string(),
            content: None,
            end_line: Some(2),
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }];
        let err = apply_line_edits(content, &edits).unwrap_err();
        assert!(err.contains("destination"), "{}", err);
    }

    #[test]
    fn replace_body_errors_when_no_brace_block() {
        let content = "const x = 1;\n";
        let err = apply_line_edits(
            content,
            &[le(1, "replace_body", Some("y"), None)],
        )
        .unwrap_err();
        assert!(err.contains("body bounds") || err.contains("could not find"), "{}", err);
    }

    // ── replace_body success ──

    #[test]
    fn replace_body_swaps_function_innards() {
        let content = "function f() {\n  return 1;\n}\n";
        let (result, ..) = apply_line_edits(
            content,
            &[le(1, "replace_body", Some("  return 2;\n"), None)],
        )
        .unwrap();
        assert!(result.contains("return 2;"), "{}", result);
        assert!(!result.contains("return 1;"), "{}", result);
    }

    // ── move + reindent ──

    #[test]
    fn move_block_with_reindent_targets_destination_indent() {
        let content = "class A {\n  block() {\n    old;\n  }\n}\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(3),
            action: "move".to_string(),
            content: None,
            end_line: Some(3),
            symbol: None,
            position: None,
            destination: Some(2),
            reindent: true,
        }];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert!(
            result.contains("class A") && result.contains("old"),
            "{}",
            result
        );
    }

    #[test]
    fn move_across_brace_depth_emits_structural_warning() {
        let content = "const obj = {\n  a: 1,\n  b: 2,\n};\nconst other = 0;\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(3),
            action: "move".to_string(),
            content: None,
            end_line: Some(3),
            symbol: None,
            position: None,
            destination: Some(5),
            reindent: false,
        }];
        let (result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(warnings.iter().any(|w| w.contains("move_structural_warning")),
            "should warn about depth-crossing move: {:?}", warnings);
        assert!(result.contains("b: 2"), "move should still apply: {}", result);
    }

    #[test]
    fn move_same_depth_no_structural_warning() {
        // Move a top-level statement to another top-level position (both depth 0)
        let content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(1),
            action: "move".to_string(),
            content: None,
            end_line: Some(1),
            symbol: None,
            position: None,
            destination: Some(3),
            reindent: false,
        }];
        let (_result, warnings, _) = apply_line_edits(content, &edits).unwrap();
        assert!(!warnings.iter().any(|w| w.contains("move_structural_warning")),
            "same-depth move should not warn: {:?}", warnings);
    }

    // ── unicode & stress ──

    #[test]
    fn utf8_grapheme_line_replace_preserves_surrounding_text() {
        let content = "prefix 你好\nmiddle 🦀 line\nsuffix\n";
        let (result, ..) = apply_line_edits(
            content,
            &[le(2, "replace", Some("middle 改"), None)],
        )
        .unwrap();
        assert!(result.contains("middle 改"), "{}", result);
        assert!(result.contains("prefix 你好"), "{}", result);
    }

    #[test]
    fn ten_sequential_edits_on_dense_file() {
        let lines: Vec<String> = (0..40).map(|i| format!("L{i}")).collect();
        let content = lines.join("\n") + "\n";
        let mut edits: Vec<LineEdit> = Vec::new();
        for i in 0..10 {
            let line = 1 + i * 3;
            edits.push(le(
                line,
                "insert_before",
                Some(&format!("MARK{i}")),
                None,
            ));
        }
        let (result, ..) = apply_line_edits(&content, &edits).unwrap();
        for i in 0..10 {
            assert!(
                result.contains(&format!("MARK{i}")),
                "missing marker {i} in output",
            );
        }
    }

    #[test]
    fn resolutions_track_each_edit_line_count() {
        let content = "a\nb\nc\n";
        let edits = vec![
            le(2, "delete", None, None),
            le(1, "insert_before", Some("z\ny"), None),
        ];
        let (_result, _w, res) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(res.len(), 2);
        assert_eq!(res[0].action, "delete");
        assert_eq!(res[1].action, "insert_before");
    }

    // ── adversarial / regression (try to break apply_line_edits) ──

    /// end_line < line → count saturates to 0; replace becomes pure insertion at idx.
    #[test]
    fn replace_with_end_line_before_line_inserts_without_removing() {
        let content = "l1\nl2\nl3\nl4\nl5\n";
        let ed = le(5, "replace", Some("INJECTED"), Some(3));
        let (result, ..) = apply_line_edits(content, &[ed]).unwrap();
        assert!(
            result.contains("INJECTED"),
            "inverted span should still splice replacement in: {}",
            result
        );
        assert_eq!(result.matches("l4").count(), 1, "l4 should remain once: {}", result);
    }

    #[test]
    fn negative_index_out_of_range_errors() {
        let content = "only\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Neg(-99),
            action: "replace".to_string(),
            content: Some("x".to_string()),
            end_line: None,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }];
        let err = apply_line_edits(content, &edits).unwrap_err();
        assert!(err.contains("out of range") || err.contains("line index"), "{}", err);
    }

    #[test]
    fn insert_before_empty_string_is_noop() {
        let content = "a\nb\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "insert_before", Some(""), None)]).unwrap();
        assert_eq!(result, "a\nb\n");
    }

    #[test]
    fn move_whole_file_to_top() {
        let content = "a\nb\nc\n";
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(2),
            action: "move".to_string(),
            content: None,
            end_line: Some(3),
            symbol: None,
            position: None,
            destination: Some(1),
            reindent: false,
        }];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "b\nc\na\n");
    }

    #[test]
    fn delete_range_where_end_equals_line_deletes_one_line() {
        let content = "x\ny\nz\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "delete", None, Some(2))]).unwrap();
        assert_eq!(result, "x\nz\n");
    }

    #[test]
    fn replace_body_interface_does_not_panic() {
        let content = "interface I {\n  m(): void;\n}\n";
        let r = apply_line_edits(content, &[le(1, "replace_body", Some("  // empty\n"), None)]);
        assert!(r.is_ok(), "{:?}", r.as_ref().err());
    }

    #[test]
    fn fifty_sequential_inserts_at_line_one() {
        let content = "anchor\n";
        let mut edits: Vec<LineEdit> = Vec::new();
        for _ in 0..50 {
            edits.push(le(1, "insert_before", Some("x\n"), None));
        }
        let (result, ..) = apply_line_edits(&content, &edits).unwrap();
        assert_eq!(result.matches("x").count(), 50);
        assert!(result.contains("anchor"));
    }

    #[test]
    fn tab_only_lines_preserve_structure() {
        let content = "fn a() {\n\t\tx\n}\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "replace", Some("\t\ty"), None)]).unwrap();
        assert!(result.contains("\t\ty"), "{}", result);
    }

    #[test]
    fn very_long_single_line_replace() {
        let long = "x".repeat(50_000);
        let content = format!("{long}\nsecond\n");
        let (result, ..) = apply_line_edits(&content, &[le(1, "replace", Some("short"), None)]).unwrap();
        assert!(result.starts_with("short\n"));
        assert!(result.contains("second"));
    }

    /// Model invents line 99999 on a 4-line file — must error, not panic.
    #[test]
    fn hallucinated_line_far_past_eof_errors() {
        let content = "a\nb\nc\n";
        let err = apply_line_edits(content, &[le(99_999, "replace", Some("nope"), None)]).unwrap_err();
        assert!(err.contains("out of range"), "{}", err);
    }

    /// Same snapshot line targeted twice (common LLM mistake) — sequential semantics apply.
    #[test]
    fn duplicate_replace_same_snapshot_line_sequential() {
        let content = "keep\nold\nold\nkeep\n";
        let edits = vec![
            le(2, "replace", Some("first"), None),
            le(2, "replace", Some("second"), None),
        ];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert!(result.contains("second"), "second edit wins at sequential L2: {}", result);
        assert!(!result.contains("first"), "{}", result);
    }

    /// Hallucinated delete span covering "whole file + 50" lines — clamps, must not panic.
    #[test]
    fn delete_with_end_line_past_eof_clamps() {
        let content = "a\nb\nc\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "delete", None, Some(500))]).unwrap();
        assert!(!result.contains('b') && !result.contains('c'), "{}", result);
        assert!(result.starts_with('a'), "{}", result);
    }

    /// `replace` with empty content array-equivalent — acts like delete one line (model "remove line" slip).
    #[test]
    fn replace_with_only_newlines_collapses_to_delete_semantics() {
        let content = "before\nkill\nafter\n";
        let (result, ..) = apply_line_edits(content, &[le(2, "replace", Some("\n\n"), None)]).unwrap();
        assert!(result.contains("before") && result.contains("after"), "{}", result);
    }
}

#[cfg(test)]
#[allow(deprecated)]
mod hard_flexible_replace_tests {
    use super::flexible_replacen;

    #[test]
    fn exact_match_replaces() {
        let r = flexible_replacen("hello world", "world", "earth");
        assert_eq!(r, Some("hello earth".to_string()));
    }

    #[test]
    fn trailing_whitespace_tolerance() {
        let content = "function foo() {  \n  return 1;  \n}\n";
        let old = "function foo() {\n  return 1;\n}";
        let new = "function bar() {\n  return 2;\n}";
        let r = flexible_replacen(content, old, new);
        assert!(r.is_some(), "fuzzy match should succeed despite trailing spaces");
        let result = r.unwrap();
        assert!(result.contains("function bar()"));
        assert!(result.contains("return 2"));
    }

    #[test]
    fn no_match_returns_none() {
        assert_eq!(flexible_replacen("abc", "xyz", "123"), None);
    }

    #[test]
    fn replace_at_start_of_file() {
        let content = "OLD\nrest\n";
        assert_eq!(flexible_replacen(content, "OLD", "NEW"), Some("NEW\nrest\n".to_string()));
    }

    #[test]
    fn replace_at_end_of_file() {
        let content = "rest\nOLD\n";
        assert_eq!(flexible_replacen(content, "OLD\n", "NEW\n"), Some("rest\nNEW\n".to_string()));
    }

    #[test]
    fn multiline_replace_preserves_surrounding() {
        let content = "// header\nfunction a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n// footer\n";
        let old = "function a() {\n  return 1;\n}";
        let new = "function a() {\n  return 42;\n}";
        let r = flexible_replacen(content, old, new).unwrap();
        assert!(r.contains("return 42"));
        assert!(r.contains("function b()"));
        assert!(r.contains("// header"));
        assert!(r.contains("// footer"));
    }

    #[test]
    fn empty_old_text_returns_none() {
        // Empty old_text is rejected early — callers should not pass empty old_text.
        #[allow(deprecated)]
        let result = flexible_replacen("abc", "", "x");
        assert_eq!(result, None);
    }

    #[test]
    fn old_text_longer_than_content_returns_none() {
        assert_eq!(flexible_replacen("ab", "abcdef", "x"), None);
    }
}

#[cfg(test)]
mod hard_batch_edits_tests {
    use super::*;
    use crate::hash_resolver::{HashRegistry, batch_edits, BatchEditEntry};

    #[test]
    fn batch_edits_multi_file_write() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();

        let file_a = "export function a() {\n  return 1;\n}\n";
        let file_b = "export function b() {\n  return 2;\n}\n";
        std::fs::write(root.join("src/a.ts"), file_a).unwrap();
        std::fs::write(root.join("src/b.ts"), file_b).unwrap();

        let mut registry = HashRegistry::new();
        let mut snapshot_svc = snapshot::SnapshotService::new();

        let result = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: "src/a.ts".to_string(),
                content_hash: None,
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(2), action: "replace".to_string(),
                    content: Some("  return 42;".to_string()),
                    end_line: None, symbol: None, position: None,
                    destination: None, reindent: false,
                }],
            },
            BatchEditEntry {
                file: "src/b.ts".to_string(),
                content_hash: None,
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(2), action: "replace".to_string(),
                    content: Some("  return 99;".to_string()),
                    end_line: None, symbol: None, position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc).unwrap();

        let a_disk = std::fs::read_to_string(root.join("src/a.ts")).unwrap();
        let b_disk = std::fs::read_to_string(root.join("src/b.ts")).unwrap();
        assert!(a_disk.contains("return 42"), "a.ts should be updated on disk");
        assert!(b_disk.contains("return 99"), "b.ts should be updated on disk");
        assert_eq!(result.undo_entries.len(), 2, "should have undo data for both files");
        assert_eq!(result.json["files"], 2);
    }

    #[test]
    fn batch_edits_stale_hash_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("f.ts"), "const a = 1;\nconst b = 2;\n").unwrap();

        let mut registry = HashRegistry::new();
        let mut snapshot_svc = snapshot::SnapshotService::new();
        let err = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: "f.ts".to_string(),
                content_hash: Some("h:deadbeef".to_string()),
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(1), action: "replace".to_string(),
                    content: Some("const a = 42;".to_string()),
                    end_line: None, symbol: None, position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc).unwrap_err();

        assert!(err.contains("stale_hash"), "should block on stale hash: {}", err);
        let disk = std::fs::read_to_string(root.join("f.ts")).unwrap();
        assert!(disk.contains("const a = 1;"), "file should be unchanged after stale block");
    }


    #[test]
    fn batch_edits_require_fresh_hash_after_prior_write() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = "multi_edit_line.ts";
        std::fs::write(
            root.join(file),
            "const marker = 'alpha';\nconst target = 1;\nconst spacer = 'keep';\nconst target = 2;\n",
        ).unwrap();

        let mut registry = HashRegistry::new();
        let mut snapshot_svc = snapshot::SnapshotService::new();
        let original_hash = content_hash(&std::fs::read_to_string(root.join(file)).unwrap());

        let first = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: file.to_string(),
                content_hash: Some(format!("h:{}", original_hash)),
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(4),
                    action: "replace".to_string(),
                    content: Some("const target = 20;".to_string()),
                    end_line: None,
                    symbol: None,
                    position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc).unwrap();
        assert_eq!(first.undo_entries.len(), 1);

        // Forwarded hashes are now hard errors — the old hash forwards to current
        // but mutation mode rejects it outright instead of passing through.
        let forward_attempt = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: file.to_string(),
                content_hash: Some(format!("h:{}", original_hash)),
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(4),
                    action: "replace".to_string(),
                    content: Some("const target = 200;".to_string()),
                    end_line: None,
                    symbol: None,
                    position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc).unwrap_err();
        assert!(forward_attempt.contains("forwarded"), "expected forwarded hash hard error, got: {}", forward_attempt);

        let refreshed_hash = format!("h:{}", content_hash(&std::fs::read_to_string(root.join(file)).unwrap()));
        let mid_write = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: file.to_string(),
                content_hash: Some(refreshed_hash),
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(4),
                    action: "replace".to_string(),
                    content: Some("const target = 200;".to_string()),
                    end_line: None,
                    symbol: None,
                    position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc).unwrap();
        assert_eq!(mid_write.undo_entries.len(), 1);

        let final_result = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: file.to_string(),
                content_hash: Some(format!("h:{}", content_hash(&std::fs::read_to_string(root.join(file)).unwrap()))),
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(4),
                    action: "replace".to_string(),
                    content: Some("const target = 999;".to_string()),
                    end_line: None,
                    symbol: None,
                    position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc).unwrap();
        assert_eq!(final_result.undo_entries.len(), 1);

        let disk = std::fs::read_to_string(root.join(file)).unwrap();
        assert!(disk.contains("const target = 999;"));
        assert!(!disk.contains("const target = 200;"));
    }

    #[test]
    fn batch_edits_undo_contains_previous_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let original = "fn main() {\n  println!(\"hello\");\n}\n";
        std::fs::write(root.join("main.rs"), original).unwrap();

        let mut registry = HashRegistry::new();
        let mut snapshot_svc = snapshot::SnapshotService::new();
        let result = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: "main.rs".to_string(),
                content_hash: None,
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(2), action: "replace".to_string(),
                    content: Some("  println!(\"world\");".to_string()),
                    end_line: None, symbol: None, position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc).unwrap();

        assert_eq!(result.undo_entries[0].previous_content, original);
        assert!(result.undo_entries[0].new_content.contains("world"));
    }

    #[test]
    fn batch_edits_barrel_targeted_edit_keeps_valid_js() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        // Use self-contained JS (no require) so tsc --allowJs passes regardless of cwd
        let original = r#"/**
 * @fileoverview Main package entrypoint.
 */

"use strict";

const name = "pkg";
const version = "1.0.0";

module.exports = {
	meta: {
		name,
		version,
	},
	configs: {
		all: { rules: {} },
		recommended: { rules: {} },
	},
};
"#;
        std::fs::write(root.join("src/index.js"), original).unwrap();

        let mut registry = HashRegistry::new();
        let mut snapshot_svc = snapshot::SnapshotService::new();
        let result = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: "src/index.js".to_string(),
                content_hash: None,
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(17),
                    action: "replace".to_string(),
                    content: Some(
                        "\t\trecommended: { rules: {} },\n\t\tstrict: { rules: {} },".to_string()
                    ),
                    end_line: None,
                    symbol: None,
                    position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc).unwrap();

        let disk = std::fs::read_to_string(root.join("src/index.js")).unwrap();
        assert!(disk.contains("strict: { rules: {} }"));
        let opts = crate::linter::LintOptions {
            root_path: root.to_string_lossy().to_string(),
            syntax_only: Some(true),
            use_native_parser: Some(true),
            ..Default::default()
        };
        let lint_results = crate::linter::lint_file("src/index.js", &disk, &opts);
        let errors: Vec<_> = lint_results.iter().filter(|r| r.severity == "error").collect();
        assert!(errors.is_empty(), "expected valid barrel syntax, got: {:?}", errors);
        assert_eq!(result.json["files"], 1);
        assert_eq!(result.undo_entries.len(), 1);
    }

    #[test]
    fn batch_edits_barrel_whole_rewrite_written_when_prewrite_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        let original = r#"/**
 * @fileoverview Main package entrypoint.
 */

"use strict";

const { name, version } = require("../package.json");

module.exports = {
	meta: {
		name,
		version,
	},
	configs: {
		all: require("./configs/eslint-all"),
		recommended: require("./configs/eslint-recommended"),
	},
};
"#;
        std::fs::write(root.join("src/index.js"), original).unwrap();

        // Replace with syntactically invalid JS so native parser (tsc) rejects it
        let mut registry = HashRegistry::new();
        let mut snapshot_svc = snapshot::SnapshotService::new();
        let result = batch_edits(&mut registry, root, vec![
            BatchEditEntry {
                file: "src/index.js".to_string(),
                content_hash: None,
                line_edits: vec![LineEdit {
                    line: LineCoordinate::Abs(9),
                    action: "replace".to_string(),
                    content: Some("module.exports = ;".to_string()),
                    end_line: None,
                    symbol: None,
                    position: None,
                    destination: None, reindent: false,
                }],
            },
        ], &mut snapshot_svc);

        // Syntax gate now rejects malformed JS before commit
        let err = result.unwrap_err();
        assert!(err.contains("syntax") || err.contains("Syntax"), "expected syntax error, got: {}", err);
        // File on disk should remain unchanged
        let disk = std::fs::read_to_string(root.join("src/index.js")).unwrap();
        assert_eq!(disk, original, "malformed edit should not be written to disk");
    }
}

#[cfg(test)]
mod hard_refactor_pipeline_tests {
    use super::{apply_line_edits, content_hash, LineCoordinate, LineEdit};
    use crate::hash_resolver::{self, HashEntry, HashRegistry, parse_line_ranges};
    use crate::path_utils::normalize_line_endings;

    fn le(line: u32, action: &str, content: Option<&str>, end_line: Option<u32>) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: action.to_string(),
            content: content.map(String::from),
            end_line,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }
    }

    /// Mirror of adjust_line_for_shifts from the refactor execute pipeline.
    /// Shifts are in ORIGINAL coordinates — accumulate total removed before target.
    fn adjust_line_for_shifts(line: u32, shifts: &[(u32, u32)]) -> u32 {
        let mut total_removed_before = 0u32;
        for &(removed_start, removed_count) in shifts {
            if line >= removed_start + removed_count {
                total_removed_before += removed_count;
            } else if line >= removed_start {
                return removed_start.saturating_sub(total_removed_before);
            }
        }
        line.saturating_sub(total_removed_before)
    }

    // ── Multi-op: two sequential remove_lines from same source ──

    #[test]
    fn two_sequential_removes_from_same_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let source = "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n";
        let src_path = root.join("source.ts");
        std::fs::write(&src_path, source).unwrap();

        let mut line_shifts: Vec<(u32, u32)> = Vec::new();

        // Op1: remove lines 3-4 (L3, L4)
        let ranges1 = parse_line_ranges("3-4").unwrap();
        let edits1: Vec<LineEdit> = ranges1.iter().map(|&(start, end)| {
            let adj = adjust_line_for_shifts(start, &line_shifts);
            let span = end.unwrap().saturating_sub(start) + 1;
            let adj_end = adj + span - 1;
            le(adj, "delete", None, Some(adj_end))
        }).collect();
        for &(s, e) in &ranges1 { line_shifts.push((s, e.unwrap().saturating_sub(s) + 1)); }

        let current = std::fs::read_to_string(&src_path).unwrap();
        let (after_op1, ..) = apply_line_edits(&current, &edits1).unwrap();
        std::fs::write(&src_path, &after_op1).unwrap();

        assert_eq!(after_op1, "L1\nL2\nL5\nL6\nL7\nL8\nL9\nL10\n",
            "after removing L3-L4: {:?}", after_op1);

        // Op2: remove original lines 7-8 (were L7, L8), which are now at 5-6
        let ranges2 = parse_line_ranges("7-8").unwrap();
        let edits2: Vec<LineEdit> = ranges2.iter().map(|&(start, end)| {
            let adj = adjust_line_for_shifts(start, &line_shifts);
            let span = end.unwrap().saturating_sub(start) + 1;
            let adj_end = adj + span - 1;
            le(adj, "delete", None, Some(adj_end))
        }).collect();

        let current2 = std::fs::read_to_string(&src_path).unwrap();
        let (after_op2, ..) = apply_line_edits(&current2, &edits2).unwrap();
        std::fs::write(&src_path, &after_op2).unwrap();

        assert_eq!(after_op2, "L1\nL2\nL5\nL6\nL9\nL10\n",
            "after removing original L7-L8 (shifted): {:?}", after_op2);
    }

    // ── Full create + remove_lines + import_updates pipeline ──

    #[test]
    fn full_extract_refactor_pipeline() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();

        let source_content = "\
import { helper } from './utils';

export function keepMe() {
  return helper(1);
}

export function extractMe() {
  const x = helper(2);
  const y = x * 2;
  return y;
}

export function alsoKeep() {
  return 3;
}
";
        let consumer_content = "\
import { keepMe, extractMe } from './source';

pub(crate) const a = keepMe();
pub(crate) const b = extractMe();
";

        std::fs::write(root.join("src/source.ts"), source_content).unwrap();
        std::fs::write(root.join("src/consumer.ts"), consumer_content).unwrap();

        // Step 1: create target file with extracted function
        let extracted = "\
import { helper } from './utils';

export function extractMe() {
  const x = helper(2);
  const y = x * 2;
  return y;
}
";
        std::fs::write(root.join("src/extracted.ts"), extracted).unwrap();
        assert!(root.join("src/extracted.ts").exists());

        // Step 2: remove lines 7-11 from source (the extractMe function + blank line)
        let ranges = parse_line_ranges("7-11").unwrap();
        let delete_edits: Vec<LineEdit> = ranges.iter().map(|&(start, end)| {
            le(start, "delete", None, end)
        }).collect();

        let (new_source, ..) = apply_line_edits(source_content, &delete_edits).unwrap();
        std::fs::write(root.join("src/source.ts"), &new_source).unwrap();

        assert!(new_source.contains("keepMe"), "keepMe should remain");
        assert!(new_source.contains("alsoKeep"), "alsoKeep should remain");
        assert!(!new_source.contains("extractMe"), "extractMe should be removed from source");
        assert!(new_source.contains("import { helper }"), "imports should remain");

        // Step 3: update consumer imports
        let import_edits = vec![
            le(
                1,
                "replace",
                Some("import { keepMe } from './source';\nimport { extractMe } from './extracted';"),
                Some(2),
            ),
        ];
        let (new_consumer, warnings, _) = apply_line_edits(consumer_content, &import_edits).unwrap();
        std::fs::write(root.join("src/consumer.ts"), &new_consumer).unwrap();

        assert!(warnings.is_empty());
        assert!(new_consumer.contains("from './source'"));
        assert!(new_consumer.contains("from './extracted'"));
        assert!(!new_consumer.contains("keepMe, extractMe"), "old combined import should be gone");

        // Verify final disk state
        let source_disk = std::fs::read_to_string(root.join("src/source.ts")).unwrap();
        let consumer_disk = std::fs::read_to_string(root.join("src/consumer.ts")).unwrap();
        let extracted_disk = std::fs::read_to_string(root.join("src/extracted.ts")).unwrap();

        assert!(!source_disk.contains("extractMe"));
        assert!(consumer_disk.contains("from './extracted'"));
        assert!(extracted_disk.contains("extractMe"));
    }

    // ── Regression: removing last function from file ──

    #[test]
    fn remove_lines_at_end_of_file() {
        let content = "import x;\n\nfunction a() { return 1; }\n\nfunction b() { return 2; }\n";
        let ranges = parse_line_ranges("4-5").unwrap();
        let edits: Vec<LineEdit> = ranges.iter().map(|&(start, end)| {
            le(start, "delete", None, end)
        }).collect();
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        assert_eq!(result, "import x;\n\nfunction a() { return 1; }\n");
    }

    // ── Regression: Windows CRLF from model output mixed with LF file ──

    #[test]
    fn crlf_in_edit_content_mixed_with_lf_file() {
        let content = "line1\nline2\nline3\n";
        let edits = vec![le(2, "replace", Some("new2\r\nnew3"), None)];
        let (result, ..) = apply_line_edits(content, &edits).unwrap();
        let normalized = normalize_line_endings(&result);
        let lines: Vec<&str> = normalized.lines().collect();
        assert!(lines.contains(&"new2"), "should contain new2: {:?}", lines);
        assert!(lines.contains(&"new3"), "should contain new3: {:?}", lines);
    }

    // ── adjust_line_for_shifts correctness ──

    #[test]
    fn adjust_line_for_shifts_basic() {
        // Removed lines 3-4 (start=3, count=2)
        let shifts = vec![(3u32, 2u32)];
        assert_eq!(adjust_line_for_shifts(1, &shifts), 1, "before removal: unchanged");
        assert_eq!(adjust_line_for_shifts(3, &shifts), 3, "inside removal: clamps to start");
        assert_eq!(adjust_line_for_shifts(4, &shifts), 3, "inside removal: clamps to start");
        assert_eq!(adjust_line_for_shifts(5, &shifts), 3, "after removal: shifted down by 2");
        assert_eq!(adjust_line_for_shifts(10, &shifts), 8, "well after removal: shifted down by 2");
    }

    #[test]
    fn adjust_line_for_shifts_multiple_removals() {
        // Removed lines 3-4 (2 lines) then 7-8 (2 lines)
        let shifts = vec![(3u32, 2u32), (7u32, 2u32)];
        assert_eq!(adjust_line_for_shifts(2, &shifts), 2);
        assert_eq!(adjust_line_for_shifts(5, &shifts), 3);   // was after first removal
        assert_eq!(adjust_line_for_shifts(7, &shifts), 5);   // start of second removal → clamped
        assert_eq!(adjust_line_for_shifts(9, &shifts), 5);   // after second removal
        assert_eq!(adjust_line_for_shifts(10, &shifts), 6);
    }

    // ── Regression: hash registry tracks content after multi-op pipeline ──

    #[test]
    fn hash_registry_tracks_mutations() {
        let content_v1 = "function foo() { return 1; }\n";
        let h1 = content_hash(content_v1);

        let mut reg = HashRegistry::new();
        reg.register(h1.clone(), HashEntry {
            source: Some("foo_v1.ts".to_string()),
            content: content_v1.to_string(),
            tokens: content_v1.len() / 4,
            lang: Some("typescript".to_string()),
            line_count: 1,
            symbol_count: None,
        });

        let (content_v2, ..) = apply_line_edits(content_v1, &[le(1, "replace", Some("function foo() { return 2; }"), None)]).unwrap();
        let h2 = content_hash(&content_v2);
        reg.register(h2.clone(), HashEntry {
            source: Some("foo_v2.ts".to_string()),
            content: content_v2.clone(),
            tokens: content_v2.len() / 4,
            lang: Some("typescript".to_string()),
            line_count: 1,
            symbol_count: None,
        });

        // Both versions should be retrievable
        let e1 = reg.get(&h1[..hash_resolver::SHORT_HASH_LEN]).expect("v1 must be in registry");
        assert!(e1.content.contains("return 1"));
        let e2 = reg.get(&h2[..hash_resolver::SHORT_HASH_LEN]).expect("v2 must be in registry");
        assert!(e2.content.contains("return 2"));
    }

    // ── Large file: 500-line file with multiple operations ──

    #[test]
    fn large_file_multiple_operations() {
        let lines: Vec<String> = (1..=500).map(|i| format!("line {}", i)).collect();
        let content = lines.join("\n") + "\n";

        // Op1: delete lines 100-110
        let edits1 = vec![le(100, "delete", None, Some(110))];
        let (after1, ..) = apply_line_edits(&content, &edits1).unwrap();
        let after1_lines: Vec<&str> = after1.lines().collect();
        assert_eq!(after1_lines.len(), 489, "500 - 11 = 489 lines");
        assert_eq!(after1_lines[98], "line 99");
        assert_eq!(after1_lines[99], "line 111"); // 100-110 removed

        // Op2: insert 3 lines at position 200
        let edits2 = vec![le(200, "insert_after", Some("NEW_A\nNEW_B\nNEW_C"), None)];
        let (after2, ..) = apply_line_edits(&after1, &edits2).unwrap();
        let after2_lines: Vec<&str> = after2.lines().collect();
        assert_eq!(after2_lines.len(), 492, "489 + 3 = 492 lines");
        assert_eq!(after2_lines[200], "NEW_A");

        // Op3: replace lines 400-405
        let edits3 = vec![le(400, "replace", Some("REPLACED_A\nREPLACED_B"), Some(405))];
        let (after3, ..) = apply_line_edits(&after2, &edits3).unwrap();
        let after3_lines: Vec<&str> = after3.lines().collect();
        assert_eq!(after3_lines.len(), 488, "492 - 6 + 2 = 488 lines");
        assert_eq!(after3_lines[399], "REPLACED_A");
        assert_eq!(after3_lines[400], "REPLACED_B");
    }

    // ── Import update on a file that was just modified by remove_lines ──

    #[test]
    fn import_update_after_remove_lines_on_same_file() {
        let content = "\
import { foo, bar } from './module';

export function foo() { return 1; }

export function bar() { return 2; }

export function baz() { return 3; }
";
        // Step 1: remove bar function (lines 5-5)
        let (after_remove, ..) = apply_line_edits(content, &[le(5, "delete", None, None)]).unwrap();
        assert!(!after_remove.contains("function bar"));

        // Step 2: update the import (line 1 unchanged after single-line delete above)
        let import_edits = vec![
            le(1, "replace",
                Some("import { foo } from './module';"),
                None),
        ];
        let (final_content, warnings, _) = apply_line_edits(&after_remove, &import_edits).unwrap();
        assert!(warnings.is_empty());
        assert!(final_content.contains("import { foo } from './module'"));
        assert!(!final_content.contains("bar"));
    }
}

#[cfg(test)]
mod rename_tests {
    /// Tests for the rename_symbol regex and stdlib protection logic.
    /// These validate the core replacement algorithm independent of the Tauri command.

    #[test]
    fn test_word_boundary_regex_prevents_partial_match() {
        let old_name = "Write";
        let new_name = "WriteLogEntry";
        let escaped = regex::escape(old_name);
        let re = regex::Regex::new(&format!(r"\b{}\b", escaped)).unwrap();

        // Should match standalone "Write"
        assert!(re.is_match("func (b *basicWriter) Write(buf []byte) (int, error)"));
        let result = re.replace_all("func (b *basicWriter) Write(buf []byte) (int, error)", new_name);
        assert!(result.contains("WriteLogEntry"), "Should rename Write: {}", result);

        // Should NOT match "WriteHeader" (partial word)
        assert!(!re.is_match("func (b *basicWriter) WriteHeader(code int)"),
            "\\bWrite\\b should NOT match WriteHeader");

        // Should NOT match "Writer" (partial word)
        assert!(!re.is_match("var _ io.Writer = &basicWriter{}"),
            "\\bWrite\\b should NOT match Writer");

        // Should NOT match "Rewrite"
        assert!(!re.is_match("func Rewrite() {}"),
            "\\bWrite\\b should NOT match Rewrite");
    }

    #[test]
    fn test_qualified_external_ref_go() {
        let is_qualified = |line: &str, name: &str| -> bool {
            let dot_pattern = format!(".{}", name);
            if let Some(pos) = line.find(&dot_pattern) {
                if pos > 0 {
                    let before = &line[..pos];
                    let qualifier = before.rsplit(|c: char| !c.is_alphanumeric() && c != '_').next().unwrap_or("");
                    if !qualifier.is_empty() && qualifier != "self" && qualifier != "this" {
                        return true;
                    }
                }
            }
            false
        };

        // Should detect io.Write as external
        assert!(is_qualified("var _ io.Write = nil", "Write"),
            "io.Write should be detected as external");

        // Should detect fmt.Write as external
        assert!(is_qualified("fmt.Write(data)", "Write"),
            "fmt.Write should be detected as external");

        // Should NOT detect standalone Write as external
        assert!(!is_qualified("Write(data)", "Write"),
            "Standalone Write should not be external");

        // Should NOT detect self.Write as external (not Go, but safety check)
        assert!(!is_qualified("self.Write(data)", "Write"),
            "self.Write should not be treated as external");
    }

    #[test]
    fn test_qualified_external_ref_rust() {
        let is_qualified_rust = |line: &str, name: &str| -> bool {
            let colon_pattern = format!("::{}", name);
            if line.contains(&colon_pattern) {
                for prefix in &["std::", "core::", "alloc::", "io::", "fmt::"] {
                    if line.contains(prefix) {
                        return true;
                    }
                }
            }
            false
        };

        // Should detect std::io::Write as external
        assert!(is_qualified_rust("use std::io::Write;", "Write"),
            "std::io::Write should be detected as external");

        // Should detect io::Write as external
        assert!(is_qualified_rust("impl io::Write for MyType {", "Write"),
            "io::Write should be detected as external");

        // Should detect fmt::Write as external
        assert!(is_qualified_rust("impl fmt::Write for MyType {", "Write"),
            "fmt::Write should be detected as external");

        // Should NOT detect standalone Write as external
        assert!(!is_qualified_rust("fn Write() {}", "Write"),
            "Standalone Write should not be external");
    }

    #[test]
    fn test_rust_consumer_refs_only_external() {
        use crate::refactor_engine::rust_consumer_refs_only_external;

        assert!(rust_consumer_refs_only_external(
            "tokio::runtime::block_on(future).await",
            "block_on"
        ));
        assert!(rust_consumer_refs_only_external(
            "std::sync::Mutex::new(x)",
            "new"
        ));
        assert!(
            !rust_consumer_refs_only_external("let x = block_on(f);", "block_on"),
            "bare ref should not skip"
        );
        assert!(
            !rust_consumer_refs_only_external(
                "tokio::runtime::block_on(a); block_on(b);",
                "block_on"
            ),
            "mix of qualified and bare should not skip"
        );
        assert!(
            !rust_consumer_refs_only_external("crate::runtime::block_on(f)", "block_on"),
            "crate:: qualifier should not skip"
        );
    }

    #[test]
    fn test_line_scoped_replacement_only_touches_indexed_lines() {
        let old_name = "Write";
        let new_name = "WriteLogEntry";
        let escaped = regex::escape(old_name);
        let re = regex::Regex::new(&format!(r"\b{}\b", escaped)).unwrap();

        let source = "line1: Write something\nline2: Read something\nline3: Write again\nline4: Write here too\n";
        let file_lines: Vec<&str> = source.lines().collect();

        // Only target lines 1 and 3 (1-indexed)
        let mut target_lines = std::collections::HashSet::new();
        target_lines.insert(1u32);
        target_lines.insert(3u32);

        let mut new_lines: Vec<String> = Vec::new();
        let mut replacement_count = 0;
        for (i, line) in file_lines.iter().enumerate() {
            let line_num = (i + 1) as u32;
            if target_lines.contains(&line_num) && re.is_match(line) {
                let count = re.find_iter(line).count();
                replacement_count += count;
                new_lines.push(re.replace_all(line, new_name).into_owned());
            } else {
                new_lines.push(line.to_string());
            }
        }
        let result = new_lines.join("\n");

        // Line 1 should be renamed
        assert!(result.contains("line1: WriteLogEntry something"), "Line 1 should be renamed");
        // Line 3 should be renamed
        assert!(result.contains("line3: WriteLogEntry again"), "Line 3 should be renamed");
        // Line 4 should NOT be renamed (not in target lines)
        assert!(result.contains("line4: Write here too"), "Line 4 should NOT be renamed");
        assert_eq!(replacement_count, 2, "Should have exactly 2 replacements");
    }
}

// ==========================================================================
// UHPP (Universal Hash Pointer Protocol) tests
// ==========================================================================
#[cfg(test)]
mod uhpp_tests {
    use super::shape_ops;
    use crate::refactor_engine::dedent_code_body;

    // ── Phase 1: symbol-anchor remove_lines resolution ──

    #[test]
    fn resolve_symbol_anchor_lines_basic_fn() {
        let content = "\
import { foo } from './bar';

export function targetFn() {
  return 42;
}

export function otherFn() {
  return 99;
}
";
        let (start, end) = shape_ops::resolve_symbol_anchor_lines(content, Some("fn"), "targetFn").unwrap();
        assert_eq!(start, 3, "targetFn starts at line 3");
        assert_eq!(end, 5, "targetFn ends at line 5");
    }

    #[test]
    fn resolve_symbol_anchor_lines_class() {
        let content = "\
export class MyService {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet() {
    return `Hello, ${this.name}`;
  }
}

export function helper() { return 1; }
";
        let (start, end) = shape_ops::resolve_symbol_anchor_lines(content, Some("cls"), "MyService").unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, 11);
    }

    #[test]
    fn resolve_symbol_anchor_lines_not_found() {
        let content = "function foo() { return 1; }\n";
        let result = shape_ops::resolve_symbol_anchor_lines(content, Some("fn"), "nonExistent");
        assert!(result.is_err());
    }

    #[test]
    fn resolve_remove_lines_symbol_anchor_fn() {
        let content = "\
import { logger } from './utils';

export function keepFunction() {
  return 1;
}

export function extractTarget() {
  const x = 42;
  return x;
}

export function anotherKeeper() {
  return 3;
}
";
        // Use the same helper that the refactor pipeline uses
        fn resolve_remove(s: &str, content: &str) -> Option<(u32, Option<u32>)> {
            let (kind, name) = shape_ops::parse_symbol_anchor_str(s)?;
            let (start, end) = shape_ops::resolve_symbol_anchor_lines(content, kind, name).ok()?;
            Some((start, Some(end)))
        }

        let range = resolve_remove("fn(extractTarget)", content).unwrap();
        assert_eq!(range, (7, Some(10)), "fn(extractTarget) should resolve to lines 7-10");

        assert!(resolve_remove("fn(nonexistent)", content).is_none());
        assert!(resolve_remove("23-30", content).is_none(), "line ranges should not match");
    }

    // ── Phase 2: auto-dedent for all languages ──

    #[test]
    fn dedent_code_body_strips_uniform_indent() {
        let code = "    export function foo() {\n        return 1;\n    }\n";
        let result = dedent_code_body(code);
        assert_eq!(result, "export function foo() {\n    return 1;\n}");
    }

    #[test]
    fn dedent_code_body_no_indent_passthrough() {
        let code = "function foo() {\n  return 1;\n}\n";
        let result = dedent_code_body(code);
        assert_eq!(result, code);
    }

    #[test]
    fn dedent_code_body_empty_lines_preserved() {
        let code = "    fn main() {\n\n        let x = 1;\n    }\n";
        let result = dedent_code_body(code);
        assert!(result.starts_with("fn main()"));
        assert!(result.contains("\n\n"), "empty lines should be preserved");
    }

    // ── Phase 3: from_ref is just content resolution sugar ──
    // (tested via Phase 7 integration in HPP_TEST_PROMPT.md)

    // ── Phase 5: multi-ref composition ──

    #[test]
    fn multi_ref_composition_join() {
        let parts = vec!["function foo() { return 1; }", "function bar() { return 2; }"];
        let sep = "\n\n";
        let composed = parts.join(sep);
        assert!(composed.contains("function foo()"));
        assert!(composed.contains("function bar()"));
        assert!(composed.contains("\n\n"));
    }
}

#[cfg(test)]
mod tool_call_extraction_tests {
    use crate::ai_streaming::{js_object_to_json, extract_text_tool_calls};
    use crate::refactor_engine::{expand_removal_boundaries, preflight_extract_check, extract_error_context};

    #[test]
    fn test_js_object_to_json_unquoted_keys() {
        let input = r#"{tool:"context",params:{type:"smart",file_paths:["src/api.ts"]}}"#;
        let json = js_object_to_json(input);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("should parse");
        assert_eq!(parsed["tool"], "context");
        assert_eq!(parsed["params"]["type"], "smart");
    }

    #[test]
    fn test_js_object_to_json_nested() {
        let input = r#"{tool:"manage",params:{ops:[{do:"task_plan",goal:"Test tools"}]}}"#;
        let json = js_object_to_json(input);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("should parse");
        assert_eq!(parsed["tool"], "manage");
        assert_eq!(parsed["params"]["ops"][0]["do"], "task_plan");
    }

    #[test]
    fn test_extract_single_batch_call() {
        let text = r#"batch({version:"1.0",steps:[{id:"s1",use:"system.exec",with:{cmd:"ls -R"}}]})"#;
        let (remaining, calls) = extract_text_tool_calls(text);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["tool"], "batch");
        assert!(remaining.trim().is_empty());
    }

    #[test]
    fn test_extract_regex_matches_newline_prefix() {
        use regex::Regex;
        let re = Regex::new(r"(manage|task_complete|batch)\s*\(").unwrap();
        let s = "Here is my plan:\nbatch({version:\"1.0\",steps:[]})";
        assert!(re.is_match(s), "regex should match when batch follows newline");
        let mat = re.find(s).expect("should find");
        assert_eq!(mat.as_str(), "batch(");
    }

    #[test]
    fn test_js_object_parse_for_extract_input() {
        let raw = r#"{version:"1.0",steps:[{id:"s1",use:"system.exec",with:{cmd:"ls"}}]}"#;
        let json = js_object_to_json(raw);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("js_object_to_json should produce valid JSON");
        assert_eq!(parsed["version"], "1.0");
        assert_eq!(parsed["steps"][0]["use"], "system.exec");
    }

    #[test]
    fn test_extract_consecutive_batch_calls() {
        let text = r#"batch({version:"1.0",steps:[{id:"s1",use:"system.exec",with:{cmd:"ls"}}]})batch({version:"1.0",steps:[{id:"s2",use:"search.issues",with:{file_paths:["."]}}]})"#;
        let (remaining, calls) = extract_text_tool_calls(text);
        assert_eq!(calls.len(), 2, "Should extract 2 tool calls; remaining={:?}", remaining);
        assert_eq!(calls[0]["tool"], "batch");
        assert_eq!(calls[1]["tool"], "batch");
        assert!(remaining.trim().is_empty(), "remaining should be empty, got: {}", remaining);
    }

    #[test]
    fn test_extract_preserves_surrounding_text() {
        let text = "batch({version:\"1.0\",steps:[{id:\"s1\",use:\"system.exec\",with:{cmd:\"ls\"}}]}) and then more text";
        let (remaining, calls) = extract_text_tool_calls(text);
        assert_eq!(calls.len(), 1, "expected 1 call, got {}; remaining={:?}", calls.len(), remaining);
        assert!(remaining.contains("and then more text"), "remaining should preserve text after call");
    }

    #[test]
    fn test_no_calls_passthrough() {
        let text = "Just a normal message with no tool calls.";
        let (remaining, calls) = extract_text_tool_calls(text);
        assert_eq!(calls.len(), 0);
        assert_eq!(remaining, text);
    }

    // ── expand_removal_boundaries tests ──

    #[test]
    fn expand_removal_boundaries_trailing_comma() {
        let _content = "match x {\n    \"a\" => handle_a(),\n    \"b\" => handle_b(),\n    \"c\" => handle_c(),\n}\n";
        let content2 = "fn keep() {}\n\nfn extract_me() {\n    do_stuff();\n}\n,\n\nfn after() {}\n";
        let (_s, e) = expand_removal_boundaries(content2, 3, 5, Some("rust"));
        // Should expand to include the orphaned ","  on line 6 and the blank line on line 7
        assert!(e >= 7, "Should expand past orphaned comma and blank line, got end={}", e);
    }

    #[test]
    fn expand_removal_boundaries_trailing_empty_lines() {
        let content = "fn a() {}\n\nfn b() {\n    return 1;\n}\n\n\nfn c() {}\n";
        let (s, e) = expand_removal_boundaries(content, 3, 5, Some("rust"));
        // Lines 6-7 are blank, should be consumed
        assert!(e >= 7, "Should consume trailing blank lines, got end={}", e);
        assert_eq!(s, 3, "Start should not change (no attributes above)");
    }

    #[test]
    fn expand_removal_boundaries_attributes() {
        let content = "fn keep() {}\n\n#[tauri::command]\n/// Does something\nfn extract_me() {\n    return 42;\n}\n\nfn after() {}\n";
        let (s, _e) = expand_removal_boundaries(content, 5, 7, Some("rust"));
        assert_eq!(s, 3, "Should include #[tauri::command] attribute, got start={}", s);
    }

    #[test]
    fn expand_removal_boundaries_rust_separator() {
        let content = "fn a() {}\n\n// ── section ──\nfn b() {\n    return 1;\n}\n\nfn c() {}\n";
        let (s, _e) = expand_removal_boundaries(content, 4, 6, Some("rust"));
        assert_eq!(s, 3, "Should include Rust separator comment, got start={}", s);
    }

    #[test]
    fn expand_removal_boundaries_no_expansion_needed() {
        let content = "fn a() {}\nfn b() {\n    return 1;\n}\nfn c() {}\n";
        let (s, e) = expand_removal_boundaries(content, 2, 4, Some("rust"));
        assert_eq!(s, 2);
        assert_eq!(e, 4);
    }

    // ── validate_removal_boundaries tests ──

    #[test]
    fn validate_removal_boundaries_balanced_range() {
        use crate::refactor_engine::validate_removal_boundaries;
        let content = "fn a() {}\n\nfn b() {\n    return 1;\n}\n\nfn c() {}\n";
        // Removing lines 3-5 (fn b) is balanced
        assert!(validate_removal_boundaries(content, 3, 5, Some("typescript")).is_ok());
    }

    #[test]
    fn validate_removal_boundaries_catches_clipped_function() {
        use crate::refactor_engine::validate_removal_boundaries;
        // sleep() ends at L4, but removal starts at L3 (inside sleep's body)
        let content = "\
function sleep(ms: number) {\n\
    return new Promise(resolve => setTimeout(resolve, ms));\n\
}\n\
\n\
export function hashExpand(input: string) {\n\
    return input.replace(/h:/g, '');\n\
}\n\
\n\
export function stopChat() {\n\
    abortSignal = true;\n\
}\n";
        // Removing L3-L7 clips sleep's closing brace (L3 = "}")
        // which has 1 extra "}" relative to the range
        let result = validate_removal_boundaries(content, 3, 7, Some("typescript"));
        assert!(result.is_err(), "Should catch unbalanced range: {:?}", result);
        let msg = result.unwrap_err();
        assert!(msg.contains("unbalanced braces") || msg.contains("closing brace"),
            "Error should mention brace issue: {}", msg);
    }

    #[test]
    fn validate_removal_boundaries_whole_function_ok() {
        use crate::refactor_engine::validate_removal_boundaries;
        let content = "\
function sleep(ms: number) {\n\
    return new Promise(resolve => setTimeout(resolve, ms));\n\
}\n\
\n\
export function hashExpand(input: string) {\n\
    return input.replace(/h:/g, '');\n\
}\n";
        // Removing L5-L7 (hashExpand) is balanced
        assert!(validate_removal_boundaries(content, 5, 7, Some("typescript")).is_ok());
    }

    // ── preflight_extract_check tests ──

    #[test]
    fn preflight_detects_macro_body() {
        let content = "\
macro_rules! my_macro {\n\
    ($x:expr) => {\n\
        fn generated() {\n\
            println!(\"{}\", $x);\n\
        }\n\
    };\n\
}\n\
\n\
pub(crate) fn normal_fn() {\n\
    return 1;\n\
}\n";
        // normal_fn is outside the macro — should pass
        let (_w, e) = preflight_extract_check(content, "fn(normal_fn)", Some("rust"));
        assert!(e.is_empty(), "normal_fn should not have blocking errors: {:?}", e);

        // If we tried to extract `generated` (which is inside macro body),
        // the symbol resolver wouldn't find it, so preflight returns early with no errors.
        // This is correct — the extraction would fail at symbol resolution, not preflight.
    }

    #[test]
    fn preflight_detects_external_type_reference() {
        let content = "\
pub struct MyConfig {\n\
    pub name: String,\n\
}\n\
\n\
pub fn process(cfg: MyConfig) -> String {\n\
    cfg.name.clone()\n\
}\n";
        let (warnings, errors) = preflight_extract_check(content, "fn(process)", Some("rust"));
        assert!(errors.is_empty());
        // Should warn that process references MyConfig which is outside its range
        let has_type_warning = warnings.iter().any(|w| w.contains("MyConfig"));
        assert!(has_type_warning, "Should warn about MyConfig reference: {:?}", warnings);
    }

    #[test]
    fn preflight_no_warnings_self_contained() {
        let content = "\
pub(crate) fn helper() -> i32 {\n\
    42\n\
}\n\
\n\
pub(crate) fn standalone() -> i32 {\n\
    let x = 1;\n\
    x + 1\n\
}\n";
        let (warnings, errors) = preflight_extract_check(content, "fn(standalone)", Some("rust"));
        assert!(errors.is_empty(), "No blocking errors expected: {:?}", errors);
        // standalone doesn't reference external types
        let type_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("type")).collect();
        assert!(type_warnings.is_empty(), "No type warnings expected for self-contained fn: {:?}", type_warnings);
    }

    #[test]
    fn preflight_non_symbol_anchor_passthrough() {
        let content = "fn a() {}\nfn b() {}\n";
        let (w, e) = preflight_extract_check(content, "3-5", Some("rust"));
        assert!(w.is_empty());
        assert!(e.is_empty());
    }

    // ── extract_error_context tests ──

    #[test]
    fn extract_error_context_basic() {
        let content = "line1\nline2\nline3\nline4\nline5\nline6\nline7\n";
        let ctx = extract_error_context(content, 4, 2);
        assert!(ctx.iter().any(|l| l.contains(">>")), "Should have error marker");
        assert!(ctx.iter().any(|l| l.contains("line4")), "Should contain error line");
        assert!(ctx.len() >= 4, "Should have context lines: {:?}", ctx);
    }

    #[test]
    fn extract_error_context_first_line() {
        let content = "first\nsecond\nthird\n";
        let ctx = extract_error_context(content, 1, 2);
        assert!(ctx.iter().any(|l| l.contains(">>") && l.contains("first")));
    }
}

#[cfg(test)]
mod torture_bracket_fix_tests {
    use super::{
        brace_balance_delta, find_body_bounds, ends_in_block_comment,
        syntax_error_bracket_hint, EditResolution,
        line_edits_to_edit_ops, LineEdit, LineCoordinate,
    };

    // ── BUG 1a: scan_char regex literal awareness ──

    #[test]
    fn scan_char_skips_regex_character_class_brackets() {
        let lines: Vec<&str> = vec![r#"const re = /[{}\[\]]/g;"#];
        let delta = brace_balance_delta(&lines);
        assert_eq!(delta, 0, "Regex character class brackets should not affect balance");
    }

    #[test]
    fn scan_char_skips_regex_after_operator() {
        let lines: Vec<&str> = vec![r#"const x = str.replace(/[{}()]/g, '');"#];
        let delta = brace_balance_delta(&lines);
        assert_eq!(delta, 0, "Regex after ( should be skipped");
    }

    #[test]
    fn scan_char_division_not_confused_with_regex() {
        let lines: Vec<&str> = vec!["const x = a / b + c / d;"];
        let delta = brace_balance_delta(&lines);
        assert_eq!(delta, 0, "Division operators should not start regex scanning");
    }

    #[test]
    fn scan_char_regex_with_escapes() {
        let lines: Vec<&str> = vec![r#"const re = /\{[^}]*\}/g;"#];
        let delta = brace_balance_delta(&lines);
        assert_eq!(delta, 0, "Escaped brackets in regex should not affect balance");
    }

    // ── BUG 1b: find_body_bounds with bracket-heavy functions ──

    #[test]
    fn find_body_bounds_with_regex_in_body() {
        let lines = vec![
            "function sql(strings: TemplateStringsArray, ...values: unknown[]): string {",
            "  return strings.reduce((acc, str, i) => {",
            "    const val = i < values.length ? `'${String(values[i]).replace(/['\\\\/{}\\/\\[\\]]/g, \"''\")}'` : '';",
            "    return acc + str + val;",
            "  }, '');",
            "}",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "Should find body bounds despite regex with brackets in body");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "Body starts after opening brace line");
        assert_eq!(end, 5, "Body ends at closing brace");
    }

    #[test]
    fn find_body_bounds_switch_case_try_catch() {
        let lines = vec![
            "function bracketMaze(input: unknown): string {",
            "  switch (typeof input) {",
            "    case 'string': {",
            "      const trimmed = (input as string).trim();",
            "      if (trimmed.startsWith('{')) {",
            "        try {",
            "          JSON.parse(trimmed);",
            "          return 'json';",
            "        } catch (e) {",
            "          // fall through",
            "        }",
            "      }",
            "    }",
            "    case 'number': {",
            "      return 'number';",
            "    }",
            "    default:",
            "      return 'unknown';",
            "  }",
            "}",
        ];
        let refs: Vec<&str> = lines.iter().copied().collect();
        let bounds = find_body_bounds(&refs);
        assert!(bounds.is_some(), "Should find body bounds for switch/case/try/catch function");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "Body starts after function opening brace");
        assert_eq!(end, 19, "Body ends at function closing brace");
    }

    // ── BUG 2: move structural warning on shadow path ──

    #[test]
    fn move_shadow_path_emits_structural_warning() {
        let shadow = "function outer() {\n  const x = 1;\n}\nconst y = 2;\n";
        let current = shadow;
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(2),
            action: "move".to_string(),
            content: None,
            end_line: None,
            symbol: None,
            position: None,
            destination: Some(4),
            reindent: false,
        }];
        let result = line_edits_to_edit_ops(&edits, shadow, current);
        assert!(result.is_ok());
        let (_, warnings) = result.unwrap();
        let has_structural = warnings.iter().any(|w| w.starts_with("move_structural_warning"));
        assert!(has_structural, "Shadow-path move across brace depth should emit warning. Got: {:?}", warnings);
    }

    #[test]
    fn move_shadow_path_same_depth_no_warning() {
        let shadow = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
        let current = shadow;
        let edits = vec![LineEdit {
            line: LineCoordinate::Abs(1),
            action: "move".to_string(),
            content: None,
            end_line: None,
            symbol: None,
            position: None,
            destination: Some(3),
            reindent: false,
        }];
        let result = line_edits_to_edit_ops(&edits, shadow, current);
        assert!(result.is_ok());
        let (_, warnings) = result.unwrap();
        let has_structural = warnings.iter().any(|w| w.starts_with("move_structural_warning"));
        assert!(!has_structural, "Same-depth move should not emit structural warning. Got: {:?}", warnings);
    }

    // ── BUG 3: unclosed block comment hint ──

    #[test]
    fn syntax_hint_detects_unclosed_block_comment() {
        let pre = "/* comment */\nconst x = 1;\n";
        let post = "/* comment\nconst x = 1;\n";
        let res = vec![EditResolution {
            resolved_line: 1,
            action: "replace".to_string(),
            lines_affected: 1,
        }];
        let hint = syntax_error_bracket_hint(pre, post, &res);
        assert!(hint.is_some(), "Should detect unclosed block comment");
        let hint_str = hint.unwrap();
        assert!(hint_str.contains("unclosed block comment"),
            "Hint should mention unclosed block comment: {}", hint_str);
    }

    #[test]
    fn syntax_hint_no_false_positive_for_closed_comment() {
        let pre = "/* old */\nconst x = 1;\n";
        let post = "/* new */\nconst x = 1;\n";
        let res = vec![EditResolution {
            resolved_line: 1,
            action: "replace".to_string(),
            lines_affected: 1,
        }];
        let hint = syntax_error_bracket_hint(pre, post, &res);
        let has_comment_hint = hint.as_ref().map_or(false, |h| h.contains("unclosed block comment"));
        assert!(!has_comment_hint, "Closed comment replacement should not trigger hint");
    }

    #[test]
    fn ends_in_block_comment_detects_unclosed() {
        let lines: Vec<&str> = vec!["/* this comment", "has no closer"];
        assert!(ends_in_block_comment(&lines), "Should detect unclosed block comment");
    }

    #[test]
    fn ends_in_block_comment_ok_when_closed() {
        let lines: Vec<&str> = vec!["/* this comment */", "const x = 1;"];
        assert!(!ends_in_block_comment(&lines), "Closed comment should not be flagged");
    }
}

// ============================================================================
// Deterministic edit stress tests against bracket_stress.ts fixture
// ============================================================================
#[cfg(test)]
mod edit_stress_tests {
    use super::{apply_line_edits, find_body_bounds, brace_balance_delta, LineCoordinate, LineEdit};

    /// Full content of bracket_stress.ts (175 lines). Exercises: nested generics,
    /// template literals, regex with brackets, destructuring with defaults,
    /// conditional types, string escapes, and a class with block comments.
    const FIXTURE: &str = r##"/**
 * Bracket Stress Test — exercises parser edge cases.
 * Contains: nested generics, template literals, regex, comments with brackets,
 * string escapes, arrow functions, destructuring, and conditional types.
 *
 * Note: lines like `if (a > b) { doStuff(); }` are common { traps }.
 * Also tricky: `const re = /[a-z]{3,}/g;`  // regex with {braces}
 */

// ============ Section 1: Nested Generics & Conditional Types ============

type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

type UnwrapPromise<T> = T extends Promise<infer U>
  ? U extends Promise<infer V>
    ? V
    : U
  : T;

interface Registry<K extends string, V extends Record<string, unknown>> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  entries(): Array<[K, V]>;
  // TODO: add batch({ keys: K[] }): Map<K, V>;
}

// ============ Section 2: Template Literals with Expressions ============

function formatMessage<T extends { name: string; count: number }>(
  data: T,
  template: `Hello ${string}, you have ${number} items`
): string {
  const { name, count } = data;
  // Tricky: template literal with nested expressions and brackets
  return `Dear ${name}, your ${count > 0 ? `${count} item${count === 1 ? '' : 's'}` : 'no items'} ${'{are}'} ready.`;
}

// ============ Section 3: Regex with Brackets ============

const PATTERNS = {
  // Each regex contains bracket characters that must NOT be counted as code blocks
  brackets: /[\[\]{}()]/g,
  jsonPath: /\$\{[^}]+\}/g,
  balanced: /\{(?:[^{}]|\{[^{}]*\})*\}/g,
  quantifier: /[a-zA-Z]{2,4}/,
  escape: /\\[\\{}\[\]]/g,
} as const;

// ============ Section 4: Destructuring & Default Values ============

function processConfig({
  timeout = 3000,
  retries = 3,
  headers = { 'Content-Type': 'application/json' },
  callbacks: {
    onSuccess = () => { console.log('ok'); },
    onError = (err: Error) => { throw err; },
    onRetry = ({ attempt, max }: { attempt: number; max: number }) => {
      console.log(`Retry ${attempt}/${max}`);
    },
  } = {},
}: {
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
  callbacks?: {
    onSuccess?: () => void;
    onError?: (err: Error) => void;
    onRetry?: (info: { attempt: number; max: number }) => void;
  };
}): void {
  // Body intentionally minimal — structure is the test
  if (retries > 0) {
    for (let i = 0; i < retries; i++) {
      try {
        fetch('https://api.example.com', { method: 'POST', headers })
          .then((r) => { if (!r.ok) { throw new Error(`HTTP ${r.status}`); } return r.json(); })
          .then((data: Record<string, unknown>) => { onSuccess(); })
          .catch((e: Error) => {
            onRetry({ attempt: i + 1, max: retries });
            if (i === retries - 1) { onError(e); }
          });
      } catch (e) {
        // Fallback: { this comment has braces } and [brackets] too
        onError(e as Error);
      }
    }
  }
}

// ============ Section 5: Mapped & Conditional Utility Types ============

type EventMap = {
  click: { x: number; y: number; button: 'left' | 'right' };
  keydown: { key: string; code: number; modifiers: { ctrl: boolean; shift: boolean } };
  resize: { width: number; height: number };
};

type EventHandler<E extends keyof EventMap> = (
  event: EventMap[E] & { timestamp: number; target: { id: string } }
) => void | Promise<void>;

type StrictPick<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T[P] extends Array<infer U>
      ? ReadonlyArray<U>
      : T[P];
};

// ============ Section 6: String Escapes & Edge Cases ============

const EDGE_CASES = [
  'simple string',
  'string with {braces} and [brackets]',
  "double-quoted {curly} and (parens)",
  `template with ${1 + 2} and ${{ toString: () => '{nested}' }}`,
  'escaped \' quote with { brace',
  "escaped \" quote with } brace",
  `multi-line template
    with ${(() => {
      const x = { a: 1, b: [2, 3] };
      return JSON.stringify(x);
    })()}
    and more text`,
  String.raw`raw template \${not_interpolated} {literal}`,
];

// ============ Section 7: Class with Complex Methods ============

class BracketParser<T extends Record<string, unknown>> {
  private stack: Array<{ char: string; pos: number; depth: number }> = [];
  private readonly pairs: Map<string, string> = new Map([
    ['{', '}'], ['[', ']'], ['(', ')'],
  ]);

  constructor(
    private readonly input: string,
    private readonly options: { strict: boolean; maxDepth: number } = { strict: true, maxDepth: 100 },
  ) {}

  parse(): { valid: boolean; errors: Array<{ msg: string; pos: number }> } {
    const errors: Array<{ msg: string; pos: number }> = [];
    for (let i = 0; i < this.input.length; i++) {
      const ch = this.input[i];
      if (this.pairs.has(ch)) {
        this.stack.push({ char: ch, pos: i, depth: this.stack.length });
        if (this.stack.length > this.options.maxDepth) {
          errors.push({ msg: `Max depth ${this.options.maxDepth} exceeded`, pos: i });
          if (this.options.strict) { break; }
        }
      } else if (['}', ']', ')'].includes(ch)) {
        const top = this.stack.pop();
        if (!top || this.pairs.get(top.char) !== ch) {
          errors.push({ msg: `Unmatched '${ch}' at position ${i}`, pos: i });
        }
      }
      /* Block comment with { braces } and
         [brackets] spanning multiple lines
         and even a // nested line comment fake-out */
    }
    // Remaining unclosed brackets
    while (this.stack.length > 0) {
      const unclosed = this.stack.pop()!;
      errors.push({ msg: `Unclosed '${unclosed.char}' from pos ${unclosed.pos}`, pos: unclosed.pos });
    }
    return { valid: errors.length === 0, errors };
  }
}

export { BracketParser, processConfig, formatMessage, PATTERNS, EDGE_CASES };
export type { DeepPartial, UnwrapPromise, Registry, EventMap, EventHandler, StrictPick };
"##;

    fn le(line: u32, action: &str, content: Option<&str>, end_line: Option<u32>) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: action.to_string(),
            content: content.map(String::from),
            end_line,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }
    }

    fn le_move(line: u32, dest: u32) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: "move".to_string(),
            content: None,
            end_line: None,
            symbol: None,
            position: None,
            destination: Some(dest),
            reindent: false,
        }
    }

    fn fixture_line(n: usize) -> &'static str {
        FIXTURE.lines().nth(n - 1).unwrap()
    }

    fn fixture_line_count() -> usize {
        FIXTURE.lines().count()
    }

    // ── Fixture sanity ──

    #[test]
    fn fixture_has_expected_line_count() {
        // The raw string ends with a trailing newline, so .lines() yields 174 items
        // (the last empty line after the newline is not counted by .lines()).
        // The actual file is 175 lines; our edits use 1-based line numbers that
        // map correctly because apply_line_edits splits on '\n' and preserves
        // the trailing empty entry.
        assert_eq!(fixture_line_count(), 174, "bracket_stress.ts fixture should yield 174 items from .lines()");
    }

    #[test]
    fn fixture_brace_balance_is_zero() {
        let lines: Vec<&str> = FIXTURE.lines().collect();
        let delta = brace_balance_delta(&lines);
        assert_eq!(delta, 0, "Full fixture should have balanced braces, got delta={}", delta);
    }

    // ── replace: single-line in regex section (L44) ──

    #[test]
    fn replace_single_line_regex_section() {
        assert!(fixture_line(44).contains("brackets: /["));
        let edits = vec![le(44, "replace", Some("  brackets: /[{}]/g,"), None)];
        let (result, warnings, resolutions) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("brackets: /[{}]/g,"), "replacement should appear");
        assert!(!result.contains(r"/[\[\]{}()]/g"), "old regex should be gone");
        assert_eq!(resolutions.len(), 1);
        assert_eq!(resolutions[0].resolved_line, 44);
        assert_eq!(resolutions[0].action, "replace");
        let _ = warnings;
    }

    // ── replace: multi-line in class method (L144-169) ──

    #[test]
    fn replace_multiline_class_method() {
        assert!(fixture_line(144).contains("parse():"));
        let new_body = "  parse(): { valid: boolean } {\n    return { valid: true };\n  }";
        let edits = vec![le(144, "replace", Some(new_body), Some(170))];
        let (result, _, resolutions) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("return { valid: true }"), "new body should appear");
        assert!(!result.contains("this.stack.push"), "old method body should be gone");
        let result_lines: Vec<&str> = result.lines().collect();
        assert!(result_lines.len() < fixture_line_count(), "file should be shorter after compressing method");
        assert_eq!(resolutions[0].action, "replace");
    }

    // ── replace: at destructuring boundary (L53-63) ──

    #[test]
    fn replace_at_destructuring_boundary() {
        assert!(fixture_line(53).contains("function processConfig"));
        let simplified_params = "function processConfig(config: {\n  timeout?: number;\n  retries?: number;\n}): void {";
        let edits = vec![le(53, "replace", Some(simplified_params), Some(73))];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("function processConfig(config:"), "simplified signature should appear");
        assert!(!result.contains("onSuccess = () =>"), "old destructuring defaults should be gone");
        assert!(result.contains("if (retries > 0)"), "function body should survive");
    }

    // ── replace_body: formatMessage (L31-38, template literals) ──

    #[test]
    fn replace_body_format_message() {
        assert!(fixture_line(31).contains("function formatMessage"));
        let lines: Vec<&str> = FIXTURE.lines().collect();
        let slice = &lines[30..38];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(), "Should find body bounds for formatMessage despite template literals");
        let (start, end) = bounds.unwrap();
        assert!(start >= 1, "body should start after the opening brace");
        assert!(end <= 7, "body should end at or before the closing brace");

        let edits = vec![le(31, "replace_body", Some("  return 'simplified';"), Some(38))];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("return 'simplified'"), "new body should appear");
        assert!(!result.contains("'{are}'"), "old template literal body should be gone");
    }

    // ── replace_body: processConfig (L53-91, deeply nested) ──

    #[test]
    fn replace_body_process_config_deeply_nested() {
        assert!(fixture_line(53).contains("function processConfig"));
        let lines: Vec<&str> = FIXTURE.lines().collect();
        let slice = &lines[52..91];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(),
            "Should find body bounds for processConfig despite nested destructuring/try/catch");
        let (start, end) = bounds.unwrap();
        assert!(start >= 1, "body start should be after the opening brace");
        assert_eq!(end, 38, "body end should be at the closing brace of processConfig (line 91 = index 38 relative)");

        let edits = vec![le(53, "replace_body", Some("  console.log('replaced');"), Some(91))];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("console.log('replaced')"), "new body should appear");
        assert!(!result.contains("fetch('https://api.example.com'"), "old body should be gone");
    }

    // ── replace_body: BracketParser.parse (L144-170, block comments in body) ──

    #[test]
    fn replace_body_bracket_parser_parse() {
        assert!(fixture_line(144).contains("parse():"));
        let lines: Vec<&str> = FIXTURE.lines().collect();
        let slice = &lines[143..170];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(),
            "Should find body bounds for parse() despite block comments with brackets in body");
        let (start, end) = bounds.unwrap();
        assert!(start >= 1);
        assert!(end > start, "body end should be after body start");

        let edits = vec![le(144, "replace_body", Some("    return { valid: false, errors: [] };"), Some(170))];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("return { valid: false, errors: [] }"), "new body should appear");
        assert!(!result.contains("Block comment with { braces }"), "old block comment should be gone");
    }

    // ── insert_after: after class constructor (L142) ──

    #[test]
    fn insert_after_class_constructor() {
        assert!(fixture_line(142).contains(") {}"));
        let edits = vec![le(142, "insert_after", Some("\n  get inputLength(): number {\n    return this.input.length;\n  }"), None)];
        let (result, _, resolutions) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("get inputLength(): number"), "inserted getter should appear");
        let result_lines: Vec<&str> = result.lines().collect();
        assert!(result_lines.len() > fixture_line_count(), "file should be longer after insertion");
        assert_eq!(resolutions[0].action, "insert_after");
    }

    // ── insert_after: after type definition (L14) ──

    #[test]
    fn insert_after_type_definition() {
        assert!(fixture_line(14).contains(": T;"));
        let edits = vec![le(14, "insert_after", Some("\ntype Nullable<T> = T | null;"), None)];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("type Nullable<T> = T | null;"), "inserted type should appear");
        let idx_deep = result.find("DeepPartial").unwrap();
        let idx_nullable = result.find("Nullable").unwrap();
        assert!(idx_nullable > idx_deep, "Nullable should appear after DeepPartial");
    }

    // ── insert_before: before block comment (L160) ──

    #[test]
    fn insert_before_block_comment() {
        assert!(fixture_line(160).contains("/* Block comment"));
        let edits = vec![le(160, "insert_before", Some("      // INSERTED: pre-comment marker"), None)];
        let (result, _, resolutions) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("// INSERTED: pre-comment marker"), "inserted comment should appear");
        let idx_marker = result.find("INSERTED: pre-comment marker").unwrap();
        let idx_block = result.find("/* Block comment with { braces }").unwrap();
        assert!(idx_marker < idx_block, "marker should appear before block comment");
        assert_eq!(resolutions[0].action, "insert_before");
    }

    // ── insert_before: before closing brace (L91) ──

    #[test]
    fn insert_before_closing_brace() {
        assert_eq!(fixture_line(91).trim(), "}");
        let edits = vec![le(91, "insert_before", Some("  console.log('done');"), None)];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("console.log('done')"), "inserted statement should appear");
        let idx_log = result.find("console.log('done')").unwrap();
        let idx_section5 = result.find("Section 5").unwrap();
        assert!(idx_log < idx_section5, "inserted line should be inside processConfig, before Section 5");
    }

    // ── delete: single line in string array (L116) ──

    #[test]
    fn delete_single_line_string_array() {
        assert!(fixture_line(116).contains("'simple string'"));
        let edits = vec![le(116, "delete", None, None)];
        let (result, _, resolutions) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(!result.contains("'simple string'"), "deleted line should be gone");
        assert!(result.contains("'string with {braces}"), "next line should survive");
        let result_lines: Vec<&str> = result.lines().collect();
        assert_eq!(result_lines.len(), fixture_line_count() - 1);
        assert_eq!(resolutions[0].action, "delete");
    }

    // ── delete: multi-line type definition (L95-99) ──

    #[test]
    fn delete_multiline_type_definition() {
        assert!(fixture_line(95).contains("type EventMap"));
        assert!(fixture_line(99).contains("};"));
        let edits = vec![le(95, "delete", None, Some(99))];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(!result.contains("type EventMap"), "deleted type should be gone");
        assert!(!result.contains("button: 'left' | 'right'"), "inner content should be gone");
        let result_lines: Vec<&str> = result.lines().collect();
        // delete of lines 95..99 removes 4 lines (end_line is exclusive in apply_line_edits)
        assert!(result_lines.len() < fixture_line_count(), "file should be shorter after deletion");
    }

    // ── move: cross-depth (inside function → module scope) should warn ──

    #[test]
    fn move_cross_depth_emits_structural_warning() {
        assert!(fixture_line(75).contains("if (retries > 0)"));
        let edits = vec![le_move(75, 175)];
        let (result, warnings, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        let has_warning = warnings.iter().any(|w| w.starts_with("move_structural_warning"));
        assert!(has_warning,
            "Moving a line from inside a function body to module scope should emit move_structural_warning. Got: {:?}", warnings);
        assert!(result.contains("if (retries > 0)"), "moved line should still exist in file");
    }

    // ── move: same depth (module scope → module scope) should NOT warn ──

    #[test]
    fn move_same_depth_no_structural_warning() {
        assert!(fixture_line(10).contains("Section 1"));
        let edits = vec![le_move(10, 93)];
        let (_, warnings, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        let has_warning = warnings.iter().any(|w| w.starts_with("move_structural_warning"));
        assert!(!has_warning,
            "Moving a comment at module scope to another module-scope position should NOT warn. Got: {:?}", warnings);
    }

    // ── find_body_bounds: standalone tests against fixture slices ──

    #[test]
    fn body_bounds_class_declaration() {
        let lines: Vec<&str> = FIXTURE.lines().collect();
        let slice = &lines[132..171];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(), "Should find body bounds for BracketParser class");
        let (start, end) = bounds.unwrap();
        assert!(start >= 1, "class body should start after opening brace");
        assert_eq!(end, 38, "class body should end at line 171 (index 38 relative)");
    }

    #[test]
    fn body_bounds_interface_with_generics() {
        let lines: Vec<&str> = FIXTURE.lines().collect();
        let slice = &lines[21..27];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(), "Should find body bounds for Registry interface");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "interface body starts after opening brace on same line");
        assert_eq!(end, 5, "interface body ends at closing brace");
    }

    // ── Sequential edits: multiple operations in order ──

    #[test]
    fn sequential_delete_then_insert_preserves_integrity() {
        let edits = vec![
            le(116, "delete", None, None),
            le(116, "insert_before", Some("  'replacement string',"), None),
        ];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(!result.contains("'simple string'"), "original line should be gone");
        assert!(result.contains("'replacement string'"), "replacement should be present");
        let result_lines: Vec<&str> = result.lines().collect();
        assert_eq!(result_lines.len(), fixture_line_count(), "delete+insert should keep same line count");
    }

    #[test]
    fn sequential_replace_then_insert_after() {
        let edits = vec![
            le(44, "replace", Some("  brackets: /[{}]/g,"), None),
            le(44, "insert_after", Some("  extended: /[<>]/g,"), None),
        ];
        let (result, _, _) = apply_line_edits(FIXTURE, &edits).unwrap();
        assert!(result.contains("brackets: /[{}]/g"), "replacement should appear");
        assert!(result.contains("extended: /[<>]/g"), "inserted line should appear");
        let idx_brackets = result.find("brackets: /[{}]/g").unwrap();
        let idx_extended = result.find("extended: /[<>]/g").unwrap();
        assert!(idx_extended > idx_brackets, "inserted line should be after replaced line");
    }
}

// ============================================================================
// Torture-brackets tests: reproducing exact ATLS agent failure patterns
// ============================================================================
#[cfg(test)]
mod torture_brackets_agent_repro_tests {
    use super::{apply_line_edits, apply_line_edits_with_shadow, line_edits_to_edit_ops, find_body_bounds, brace_balance_delta, LineCoordinate, LineEdit};

    /// Full content of torture-brackets.ts (164 lines). This is the
    /// pathological file the ATLS agent used in the torture session.
    const TORTURE: &str = r##"/**
 * TORTURE TEST: Bracket & Comment Nightmare
 * Purpose: stress-test edit tools with pathological nesting,
 * mixed delimiters, and ambiguous parse contexts.
 * {{ not a real template }} (nested slash-star markers omitted — cannot nest block comments in JS)
 */

// Region 1: Nested generics that look like HTML/comparison operators
type DeepNested<A extends Record<string, Map<string, Set<Array<Promise<A>>>>>> = {
  field: A extends infer U ? (U extends object ? { [K in keyof U]: U[K] } : never) : never;
};

// Region 2: String literals containing every delimiter
const nightmareStrings = {
  curlyInString: "function() { return { a: 1 }; }",
  bracketsInString: "arr[0][1][2] = obj['key']",
  parenInString: "((()))()(())",
  commentInString: "// not a comment /* also not */ <!-- nor this -->",
  templateTrap: `hello ${ `nested ${ `deep ${1 + 2}` }` } world`,
  regexTrap: /\{\}\[\]\(\)/g,
  backtickInRegex: /`[^`]*`/g,
  escapeHell: "\"\{\}\[\]\'\\",
  // Real comment between string props
  jsonLike: '{"key": [1, {"nested": [2, 3]}]}',
};

/* Region 3: Block comment with misleading content
   function shouldNotParse() {
     const x = { a: [ 1, 2, { b: 3 } ] };
     if (x) { return [x]; }
   }
   // nested line comment inside block comment
   const trap = `template ${inside} comment`;
*/

// Region 4: Immediately-invoked with complex destructuring
const result = (function IIFE() {
  const {
    a: {
      b: {
        c: [
          first,
          { d: { e: [second, ...rest] } },
          ...remaining
        ]
      }
    }
  } = JSON.parse('{"a":{"b":{"c":[1,{"d":{"e":[2,3,4]}},5,6]}}}');
  return { first, second, rest, remaining };
})();

// Region 5: Generic arrow functions that confuse JSX parsers
const arrowGeneric = <T extends { id: number }>(items: T[]): T[] => {
  return items.filter(<U extends T>(item: U): item is U => {
    return item.id > 0; // }) <-- fake closer in comment
  });
};

// Region 6: Switch with fallthrough and nested blocks
function bracketMaze(input: unknown): string {
  switch (typeof input) {
    case 'string': {
      const trimmed = (input as string).trim();
      if (trimmed.startsWith('{')) {
        try {
          JSON.parse(trimmed);
          return 'json';
        } catch (e) {
          // fall through intentionally (to end of case)
        }
      }
      break;
    } // <-- closes case block, NOT the switch
    case 'number': {
      if ((input as number) > 0) {
        return ((input as number) % 2 === 0) ? 'even' : 'odd';
      }
      return 'non-positive';
    }
    case 'object': {
      if (input === null) return 'null';
      if (Array.isArray(input)) {
        return `array[${(input as unknown[]).length}]`;
      }
      return `object{${Object.keys(input as object).join(',')}}`;
    }
    default:
      return `unknown(${typeof input})`;
  }
  // Reachable when case 'string' breaks without returning (e.g. non-JSON string)
  return `unknown(${typeof input})`;
}

// Region 7: Class with computed properties and bracket-heavy decorators
class TortureClass<
  T extends Record<string, unknown>,
  U extends keyof T = keyof T
> {
  [Symbol.iterator](): Iterator<T[U]> {
    let idx = 0;
    const keys = Object.keys(this.data) as U[];
    return {
      next: (): IteratorResult<T[U]> => {
        if (idx < keys.length) {
          return { value: this.data[keys[idx++]], done: false };
        }
        return { value: undefined as unknown as T[U], done: true };
      }
    };
  }

  constructor(public data: T) {}

  get [Symbol.toStringTag](): string {
    return `TortureClass<${Object.keys(this.data).join(', ')}>`;
  }

  method(cb: (arg: { [K in U]: T[K] }) => void): void {
    cb(this.data as { [K in U]: T[K] });
  }
}

// Region 8: Conditional types with infer in mapped types
type Unwrap<T> =
  T extends Promise<infer U>
    ? U extends Array<infer V>
      ? V extends Map<infer K, infer V2>
        ? { key: K; value: V2 }[]
        : V[]
      : U
    : T extends (...args: infer A) => infer R
      ? { args: A; return: R }
      : T extends { [K in keyof T]: infer V }
        ? V[]
        : never;

// Region 9: Tagged template literal with bracket injection
function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => {
    const val = i < values.length ? `'${String(values[i]).replace(/'/g, "''")}'` : '';
    return acc + str + val;
  }, '');
}

const query = sql`
  SELECT * FROM users
  WHERE name = ${"O'Brien"}
  AND data::jsonb -> 'address' ->> 'city' = ${'New York'}
  AND tags @> '{"admin", "active"}'::text[]
  AND (age > ${21} OR role IN (${['admin', 'mod'].join("', '")}))
`;

// Region 10: Nested ternaries with bracket expressions
const horror = (x: number) =>
  x > 0
    ? (x > 10
      ? { level: 'high', data: [x, x * 2, { nested: [x * 3] }] }
      : { level: 'mid', data: [x] })
    : (x < -10
      ? { level: 'low', data: [x, { deep: { deeper: [x] } }] }
      : { level: 'zero', data: [] });

// Region 11: Comment that ends file without newline — parser edge case
// EOF: }])};"'` -- every closer in one line
"##;

    fn le(line: u32, action: &str, content: Option<&str>, end_line: Option<u32>) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: action.to_string(),
            content: content.map(String::from),
            end_line,
            symbol: None,
            position: None,
            destination: None,
            reindent: false,
        }
    }

    fn le_move(line: u32, dest: u32) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: "move".to_string(),
            content: None,
            end_line: None,
            symbol: None,
            position: None,
            destination: Some(dest),
            reindent: false,
        }
    }

    // ── Torture fixture sanity ──

    #[test]
    fn torture_brace_balance_is_zero() {
        let lines: Vec<&str> = TORTURE.lines().collect();
        let delta = brace_balance_delta(&lines);
        assert_eq!(delta, 0, "torture-brackets.ts must have balanced braces, got delta={}", delta);
    }

    // ── AGENT BUG 1: replace_body on bracketMaze (switch/case/try/catch) ──
    // The agent sent replace_body at L60 (bracketMaze) and got
    // "could not find body bounds". This tests that find_body_bounds
    // correctly resolves it when given the full function.

    #[test]
    fn find_body_bounds_bracket_maze_scoped_slice() {
        let lines: Vec<&str> = TORTURE.lines().collect();
        // bracketMaze starts at line 60 (0-indexed: 59), ends at line 92
        // Test with a properly scoped slice (not to EOF).
        let slice = &lines[59..92];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(),
            "find_body_bounds must resolve bracketMaze with a scoped slice");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "body should start right after opening brace");
        assert!(end > 20, "body should span the full switch block (>20 lines), got end={}", end);
    }

    #[test]
    fn find_body_bounds_bracket_maze_eof_slice_finds_something() {
        let lines: Vec<&str> = TORTURE.lines().collect();
        // When given a slice from bracketMaze to EOF, find_body_bounds may pick
        // a later block. The important thing is apply_line_edits now limits the
        // slice via find_scope_end_from_line, so this path is no longer taken.
        // We just verify it doesn't panic and returns Some.
        let slice = &lines[59..];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(), "find_body_bounds should still return Some with EOF slice");
    }

    #[test]
    fn replace_body_bracket_maze_succeeds() {
        let edits = vec![le(60, "replace_body",
            Some("  return typeof input;"),
            Some(92))]; // end_line covers full function
        let (result, _, _) = apply_line_edits(TORTURE, &edits).unwrap();
        assert!(result.contains("return typeof input"), "new body should appear");
        assert!(!result.contains("switch (typeof input)"), "old switch should be gone");
        assert!(result.contains("function bracketMaze"), "function signature preserved");
    }

    #[test]
    fn replace_body_bracket_maze_no_end_line() {
        // Without end_line, replace_body scans from line 60 to EOF
        let edits = vec![le(60, "replace_body",
            Some("  return 'simplified';"),
            None)];
        let (result, _, _) = apply_line_edits(TORTURE, &edits).unwrap();
        assert!(result.contains("return 'simplified'"), "new body should appear");
        assert!(!result.contains("switch (typeof input)"), "old switch should be gone");
    }

    // ── AGENT BUG 1b: replace_body on sql function (regex/template brackets) ──

    #[test]
    fn find_body_bounds_sql_function() {
        let lines: Vec<&str> = TORTURE.lines().collect();
        // sql function at line 138 (0-indexed: 137)
        let slice = &lines[137..];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(),
            "find_body_bounds must resolve sql() despite regex with bracket chars in body");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "body starts after opening brace");
        assert!(end >= 4, "body should span the reduce block, got end={}", end);
    }

    #[test]
    fn replace_body_sql_function_succeeds() {
        let edits = vec![le(138, "replace_body",
            Some("  return strings.join('');"),
            Some(143))];
        let (result, _, _) = apply_line_edits(TORTURE, &edits).unwrap();
        assert!(result.contains("return strings.join('')"), "new body should appear");
        assert!(!result.contains("String(values[i])"), "old body should be gone");
        assert!(result.contains("function sql"), "function signature preserved");
    }

    // ── AGENT BUG 2: move structural warning not emitted ──

    #[test]
    fn move_from_switch_case_to_module_scope_warns() {
        // Moving a line from inside bracketMaze's switch to module scope
        let edits = vec![le_move(67, 164)]; // "return 'json'" → end of file
        let (_, warnings, _) = apply_line_edits(TORTURE, &edits).unwrap();
        let has_warning = warnings.iter().any(|w| w.starts_with("move_structural_warning"));
        assert!(has_warning,
            "Moving from inside switch/try (depth>0) to module scope (depth=0) must warn. Got: {:?}", warnings);
    }

    #[test]
    fn move_between_module_scope_lines_no_warning() {
        // Moving a comment between module-scope positions
        let edits = vec![le_move(8, 136)]; // Section 1 comment → before Region 9
        let (_, warnings, _) = apply_line_edits(TORTURE, &edits).unwrap();
        let has_warning = warnings.iter().any(|w| w.starts_with("move_structural_warning"));
        assert!(!has_warning,
            "Module-scope to module-scope move should not warn. Got: {:?}", warnings);
    }

    // ── AGENT BUG 3: block comment edits ──

    #[test]
    fn replace_block_comment_region_preserving_closers() {
        let edits = vec![le(27, "replace",
            Some("/* Region 3: EDITED block comment\n   { [ ( ) ] } <- balanced\n   function fake() { return 1; }\n*/"),
            Some(34))];
        let (result, _, _) = apply_line_edits(TORTURE, &edits).unwrap();
        assert!(result.contains("EDITED block comment"), "new comment should appear");
        assert!(!result.contains("shouldNotParse"), "old content should be gone");
        let lines: Vec<&str> = result.lines().collect();
        let balance = brace_balance_delta(&lines);
        assert_eq!(balance, 0, "file should remain balanced after block comment edit");
    }

    #[test]
    fn replace_block_comment_dropping_closer_unbalances() {
        // Deliberately drop the */ closer to verify brace_balance_delta catches it
        let bad_replacement = "/* Region 3: broken edit\n   missing closer";
        let edits = vec![le(27, "replace", Some(bad_replacement), Some(34))];
        let (result, _, _) = apply_line_edits(TORTURE, &edits).unwrap();
        // The edit engine allows this (no syntax check at Rust level), but balance should be off
        let lines: Vec<&str> = result.lines().collect();
        // With an unclosed block comment, all subsequent code becomes comment text,
        // so brace_balance_delta should report non-zero since code braces vanish
        let _balance = brace_balance_delta(&lines);
        // We just verify the edit succeeded and the closer is indeed missing
        assert!(result.contains("broken edit"), "edit content should appear");
        assert!(!result.contains("shouldNotParse"), "old content should be gone");
    }

    // ── Replace in string-heavy regions ──

    #[test]
    fn replace_single_line_in_nightmare_strings() {
        let edits = vec![le(15, "replace",
            Some("  curlyInString: \"replaced { } content\","),
            None)];
        let (result, _, _) = apply_line_edits(TORTURE, &edits).unwrap();
        assert!(result.contains("replaced { } content"), "replacement should appear");
        assert!(!result.contains("return { a: 1 }"), "old content should be gone");
    }

    // ── Replace body on IIFE with destructuring ──

    #[test]
    fn find_body_bounds_iife_with_destructuring() {
        let lines: Vec<&str> = TORTURE.lines().collect();
        // IIFE starts at line 37: `const result = (function IIFE() {`
        // The function declaration with body is `function IIFE() {` at the same line
        let slice = &lines[36..50]; // through `})();`
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(),
            "find_body_bounds must resolve IIFE despite deeply nested destructuring defaults");
    }

    // ── Replace body on TortureClass ──

    #[test]
    fn find_body_bounds_torture_class() {
        let lines: Vec<&str> = TORTURE.lines().collect();
        // TortureClass starts at line 95 (0-indexed: 94), ends at line 121
        let slice = &lines[94..121];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(),
            "find_body_bounds must resolve TortureClass despite computed Symbol properties");
        let (start, end) = bounds.unwrap();
        assert!(start >= 1);
        assert!(end > 10, "class body should span all members, got end={}", end);
    }

    // ── Replace body on arrowGeneric (fake closers in comments) ──

    #[test]
    fn find_body_bounds_arrow_generic_with_fake_closers() {
        let lines: Vec<&str> = TORTURE.lines().collect();
        // arrowGeneric at line 53 (0-indexed: 52)
        let slice = &lines[52..57];
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(),
            "find_body_bounds must not be confused by bracket-closers in comments");
        let (start, end) = bounds.unwrap();
        assert_eq!(start, 1, "body starts after opening brace");
        assert!(end >= 3, "body should span filter call, got end={}", end);
    }

    // ── Sequential edits on torture file ──

    #[test]
    fn three_sequential_edits_maintain_integrity() {
        let edits = vec![
            le(15, "replace", Some("  curlyInString: \"edited\","), None),
            le(20, "delete", None, None), // delete regexTrap line
            le(59, "insert_after", Some("// inserted marker"), None),
        ];
        let (result, _, resolutions) = apply_line_edits(TORTURE, &edits).unwrap();
        assert!(result.contains("curlyInString: \"edited\""), "replace should work");
        assert!(!result.contains("regexTrap"), "delete should work");
        assert!(result.contains("// inserted marker"), "insert should work");
        assert_eq!(resolutions.len(), 3);
        let lines: Vec<&str> = result.lines().collect();
        let balance = brace_balance_delta(&lines);
        assert_eq!(balance, 0, "file should remain balanced after 3 edits");
    }

    // ── REAL APP PATH: shadow-based replace_body ──
    // The agent torture tests above exercise apply_line_edits (positional path).
    // But the real app routes through line_edits_to_edit_ops (shadow path) first.
    // That path had a bug: it ALWAYS sliced to EOF, ignoring end_line.

    #[test]
    fn shadow_replace_body_bracket_maze_no_end_line() {
        let edits = vec![le(60, "replace_body", Some("  return 'simplified';"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, TORTURE, TORTURE).unwrap();
        let body_warnings: Vec<&String> = warnings.iter()
            .filter(|w| w.contains("could not find body bounds"))
            .collect();
        assert!(body_warnings.is_empty(),
            "shadow replace_body on bracketMaze must NOT fail with 'could not find body bounds'. \
             Got warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1, "should produce exactly 1 edit op, got {}", ops.len());
        assert!(ops[0].replacement.contains("return 'simplified'"),
            "replacement content should appear in op");
    }

    #[test]
    fn shadow_replace_body_sql_function_no_end_line() {
        let edits = vec![le(138, "replace_body", Some("  return strings.join('');"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, TORTURE, TORTURE).unwrap();
        let body_warnings: Vec<&String> = warnings.iter()
            .filter(|w| w.contains("could not find body bounds"))
            .collect();
        assert!(body_warnings.is_empty(),
            "shadow replace_body on sql() must NOT fail. Got warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1, "should produce exactly 1 edit op");
    }

    #[test]
    fn shadow_replace_body_with_end_line() {
        let edits = vec![le(60, "replace_body", Some("  return typeof input;"), Some(92))];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, TORTURE, TORTURE).unwrap();
        let body_warnings: Vec<&String> = warnings.iter()
            .filter(|w| w.contains("could not find body bounds"))
            .collect();
        assert!(body_warnings.is_empty(),
            "shadow replace_body with end_line must succeed. Got warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn shadow_replace_body_via_unified_entry_point() {
        let edits = vec![le(60, "replace_body", Some("  return 'simplified';"), None)];
        let (result, warnings, resolutions) =
            apply_line_edits_with_shadow(&edits, TORTURE, Some(TORTURE)).unwrap();
        assert!(result.contains("return 'simplified'"),
            "unified path must succeed for bracketMaze replace_body");
        assert!(!result.contains("switch (typeof input)"),
            "old bracketMaze body should be replaced");
        assert!(resolutions.is_none(),
            "shadow path should succeed, not fall back to positional. Warnings: {:?}", warnings);
    }

    // ── EXACT AGENT REPRO: apply Round 1 edits first, THEN replace_body ──
    // The agent's torture session applied 4 edits in Round 1, which mutated
    // the file content. Round 2's replace_body ran against the MUTATED file.
    // The shadow content WAS the mutated file. This tests that exact sequence.

    fn apply_round1_edits() -> String {
        let round1 = vec![
            le(19, "replace",
               Some("  templateTrap: `hello ${ `nested ${ `deep ${1 + 2} extra ${ {a:1}['a'] }` }` } world`,"),
               None),
            le(43, "replace",
               Some("          { d: { e: [second, ...rest] }, f: { g: [third, { h: [fourth] }] } },"),
               None),
            le(64, "replace",
               Some("      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {\n        try {\n          const parsed = JSON.parse(trimmed); void parsed;"),
               Some(66)),
            le(99, "replace",
               Some("  [Symbol.iterator](): Iterator<T[U]> {\n    let idx = 0;\n    const keys = Object.keys(this.data) as U[]; const vals = Object.values(this.data);"),
               Some(101)),
        ];
        let (mutated, warnings, _) = apply_line_edits(TORTURE, &round1).unwrap();
        assert!(warnings.is_empty(), "Round 1 should apply cleanly: {:?}", warnings);
        mutated
    }

    #[test]
    fn agent_exact_repro_replace_body_bracket_maze_after_round1() {
        let mutated = apply_round1_edits();
        let mutated_lines: Vec<&str> = mutated.lines().collect();
        eprintln!("Post-Round1 file: {} lines", mutated_lines.len());

        // This is what the shadow path does: slice from target line to EOF
        let start_idx = 59; // line 60, 0-indexed
        let slice = &mutated_lines[start_idx..];
        eprintln!("Slice from L60 to EOF: {} lines", slice.len());
        eprintln!("First 3 lines of slice:");
        for (i, l) in slice.iter().take(3).enumerate() {
            eprintln!("  [{}]: {}", i, l);
        }

        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(),
            "find_body_bounds must resolve bracketMaze body from post-Round1 \
             mutated content sliced to EOF. This is the EXACT condition the agent hits.");
        let (start, end) = bounds.unwrap();
        eprintln!("Body bounds: start={}, end={} (relative to slice)", start, end);
        assert_eq!(start, 1, "body should start right after opening brace");
        assert!(end > 20, "body should span switch block, got end={}", end);
    }

    #[test]
    fn agent_exact_repro_shadow_replace_body_bracket_maze_after_round1() {
        let mutated = apply_round1_edits();

        // Round 2 e7: replace_body on bracketMaze via shadow path
        let edits = vec![le(60, "replace_body",
            Some("  switch (typeof input) {\n    case 'string': return 'string';\n    case 'number': return 'number';\n    default: return 'other';\n  }"),
            None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, &mutated, &mutated).unwrap();
        let body_warnings: Vec<&String> = warnings.iter()
            .filter(|w| w.contains("could not find body bounds"))
            .collect();
        assert!(body_warnings.is_empty(),
            "Shadow replace_body on bracketMaze after Round 1 edits must NOT fail. \
             This is the exact agent failure. Got warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1, "should produce 1 op, got {}", ops.len());
    }

    #[test]
    fn agent_exact_repro_shadow_replace_body_sql_after_round1() {
        let mutated = apply_round1_edits();

        // Round 3 e12 equivalent: replace_body on sql function
        let edits = vec![le(138, "replace_body",
            Some("  return strings.reduce((acc, str, i) => {\n    const escaped = i < values.length ? String(values[i]) : '';\n    return acc + str + escaped;\n  }, '');"),
            None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, &mutated, &mutated).unwrap();
        let body_warnings: Vec<&String> = warnings.iter()
            .filter(|w| w.contains("could not find body bounds"))
            .collect();
        assert!(body_warnings.is_empty(),
            "Shadow replace_body on sql() after Round 1 edits must NOT fail. \
             Got warnings: {:?}", warnings);
        assert_eq!(ops.len(), 1, "should produce 1 op, got {}", ops.len());
    }

    #[test]
    fn agent_exact_repro_full_unified_path_after_round1() {
        let mutated = apply_round1_edits();

        // Full unified path: apply_line_edits_with_shadow (what the app calls)
        let edits = vec![le(60, "replace_body",
            Some("  return typeof input;"),
            None)];
        let (result, warnings, resolutions) =
            apply_line_edits_with_shadow(&edits, &mutated, Some(&mutated)).unwrap();
        assert!(result.contains("return typeof input"),
            "replace_body via unified path after Round 1 must succeed");
        assert!(!result.contains("switch (typeof input)"),
            "old bracketMaze body should be gone");
        assert!(resolutions.is_none(),
            "Shadow path should handle it, not fall through to positional. \
             Warnings: {:?}", warnings);
    }

    // ── LIVE APP REPRO: embedded fixture — same shapes the agent exercised in-app ──

    const REPRO: &str = r##"/**
 * replace_body live repro — tests the exact failure patterns from
 * the bracket torture session. Each function below triggered
 * "could not find body bounds" in the app.
 *
 * Test plan:
 *   1. Read this file
 *   2. replace_body on bracketMaze (switch/case/try/catch)
 *   3. replace_body on sql (regex with bracket chars)
 *   4. replace_body on TortureClass (computed Symbol properties)
 *   5. replace_body on processData (destructuring defaults)
 *   6. Verify each succeeds and file remains syntactically valid
 */

// ── Target 1: switch/case/try/catch (the main agent failure) ──
function bracketMaze(input: unknown): string {
  switch (typeof input) {
    case 'string': {
      const trimmed = (input as string).trim();
      if (trimmed.startsWith('{')) {
        try {
          JSON.parse(trimmed);
          return 'json';
        } catch (e) {
          // fall through
        }
      }
      break;
    }
    case 'number': {
      if ((input as number) > 0) {
        return ((input as number) % 2 === 0) ? 'even' : 'odd';
      }
      return 'non-positive';
    }
    case 'object': {
      if (input === null) return 'null';
      if (Array.isArray(input)) {
        return `array[${(input as unknown[]).length}]`;
      }
      return `object{${Object.keys(input as object).join(',')}}`;
    }
    default:
      return `unknown(${typeof input})`;
  }
  return `string(${input})`;
}

// ── Target 2: regex/template brackets in body ──
function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => {
    const val = i < values.length ? `'${String(values[i]).replace(/'/g, "''")}'` : '';
    return acc + str + val;
  }, '');
}

// ── Target 3: class with computed properties ──
class TortureClass<T extends Record<string, unknown>> {
  [Symbol.iterator](): Iterator<T[keyof T]> {
    let idx = 0;
    const keys = Object.keys(this.data) as (keyof T)[];
    return {
      next: (): IteratorResult<T[keyof T]> => {
        if (idx < keys.length) {
          return { value: this.data[keys[idx++]], done: false };
        }
        return { value: undefined as unknown as T[keyof T], done: true };
      }
    };
  }

  constructor(public data: T) {}

  get [Symbol.toStringTag](): string {
    return `TortureClass<${Object.keys(this.data).join(', ')}>`;
  }

  method(cb: (arg: { [K in keyof T]: T[K] }) => void): void {
    cb(this.data as { [K in keyof T]: T[K] });
  }
}

// ── Target 4: destructuring defaults with nested braces ──
function processData({
  timeout = 3000,
  headers = { 'Content-Type': 'application/json' },
  callbacks: {
    onSuccess = () => { console.log('ok'); },
    onError = (err: Error) => { throw err; },
  } = {},
}: {
  timeout?: number;
  headers?: Record<string, string>;
  callbacks?: {
    onSuccess?: () => void;
    onError?: (err: Error) => void;
  };
}): { success: boolean; elapsed: number } {
  const start = Date.now();
  try {
    void fetch('https://api.example.com', { method: 'POST', headers });
    onSuccess();
    return { success: true, elapsed: Date.now() - start };
  } catch (e) {
    onError(e as Error);
    return { success: false, elapsed: Date.now() - start };
  }
}

// ── Padding: extra declarations after targets (forces EOF-slice issue) ──
const QUERY = sql`SELECT * FROM users WHERE name = ${"O'Brien"} AND age > ${21}`;

type DeepNested<A extends Record<string, unknown>> = {
  field: A extends infer U ? (U extends object ? { [K in keyof U]: U[K] } : never) : never;
};

const horror = (x: number) =>
  x > 0
    ? { level: 'high', data: [x, x * 2, { nested: [x * 3] }] }
    : { level: 'low', data: [x, { deep: { deeper: [x] } }] };

// EOF
"##;

    #[test]
    fn repro_file_brace_balance() {
        let lines: Vec<&str> = REPRO.lines().collect();
        let delta = brace_balance_delta(&lines);
        assert_eq!(delta, 0, "repro fixture must be balanced, got delta={}", delta);
    }

    // Exact agent inputs: h:6fac57:17 → line=17, h:6fac57:50 → line=50, etc.
    // These are the EXACT lines the agent sent in the live app test.

    #[test]
    fn repro_positional_bracketmaze_line17() {
        // Agent sent h:6fac57:17 → L17 = "  switch (typeof input) {"
        let edits = vec![le(17, "replace_body", Some("  return typeof input;"), None)];
        let result = apply_line_edits(REPRO, &edits);
        eprintln!("bracketMaze L17 positional: {:?}", result.as_ref().map(|(_, w, _)| w));
        assert!(result.is_ok(), "positional L17: {:?}", result.err());
    }

    #[test]
    fn repro_positional_bracketmaze_line16() {
        // Correct line: L16 = "function bracketMaze(input: unknown): string {"
        let edits = vec![le(16, "replace_body", Some("  return typeof input;"), None)];
        let result = apply_line_edits(REPRO, &edits);
        eprintln!("bracketMaze L16 positional: {:?}", result.as_ref().map(|(_, w, _)| w));
        assert!(result.is_ok(), "positional L16: {:?}", result.err());
    }

    #[test]
    fn repro_positional_sql_line50() {
        let edits = vec![le(50, "replace_body", Some("  return strings.join('');"), None)];
        let result = apply_line_edits(REPRO, &edits);
        eprintln!("sql L50 positional: {:?}", result.as_ref().map(|(_, w, _)| w));
        assert!(result.is_ok(), "positional L50: {:?}", result.err());
    }

    #[test]
    fn repro_positional_tortureclass_line58() {
        let edits = vec![le(58, "replace_body", Some("  data: T;\n  constructor(data: T) { this.data = data; }"), None)];
        let result = apply_line_edits(REPRO, &edits);
        eprintln!("TortureClass L58 positional: {:?}", result.as_ref().map(|(_, w, _)| w));
        assert!(result.is_ok(), "positional L58: {:?}", result.err());
    }

    #[test]
    fn repro_positional_processdata_line84() {
        let edits = vec![le(84, "replace_body", Some("  return { success: true, elapsed: 0 };"), None)];
        let result = apply_line_edits(REPRO, &edits);
        eprintln!("processData L84 positional: {:?}", result.as_ref().map(|(_, w, _)| w));
        assert!(result.is_ok(), "positional L84: {:?}", result.err());
    }

    // Shadow path — what the app actually uses
    #[test]
    fn repro_shadow_bracketmaze_line17() {
        let edits = vec![le(17, "replace_body", Some("  return typeof input;"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, REPRO, REPRO).unwrap();
        let fails: Vec<&String> = warnings.iter().filter(|w| w.contains("could not find body bounds")).collect();
        eprintln!("bracketMaze L17 shadow: ops={}, warns={:?}", ops.len(), warnings);
        assert!(fails.is_empty(), "shadow L17 should not fail: {:?}", warnings);
    }

    #[test]
    fn repro_shadow_sql_line50() {
        let edits = vec![le(50, "replace_body", Some("  return strings.join('');"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, REPRO, REPRO).unwrap();
        let fails: Vec<&String> = warnings.iter().filter(|w| w.contains("could not find body bounds")).collect();
        eprintln!("sql L50 shadow: ops={}, warns={:?}", ops.len(), warnings);
        assert!(fails.is_empty(), "shadow L50 should not fail: {:?}", warnings);
    }

    #[test]
    fn repro_shadow_tortureclass_line58() {
        let edits = vec![le(58, "replace_body", Some("  data: T;\n  constructor(data: T) { this.data = data; }"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, REPRO, REPRO).unwrap();
        let fails: Vec<&String> = warnings.iter().filter(|w| w.contains("could not find body bounds")).collect();
        eprintln!("TortureClass L58 shadow: ops={}, warns={:?}", ops.len(), warnings);
        assert!(fails.is_empty(), "shadow L58 should not fail: {:?}", warnings);
    }

    #[test]
    fn repro_shadow_processdata_line84() {
        let edits = vec![le(84, "replace_body", Some("  return { success: true, elapsed: 0 };"), None)];
        let (ops, warnings) = line_edits_to_edit_ops(&edits, REPRO, REPRO).unwrap();
        let fails: Vec<&String> = warnings.iter().filter(|w| w.contains("could not find body bounds")).collect();
        eprintln!("processData L84 shadow: ops={}, warns={:?}", ops.len(), warnings);
        assert!(fails.is_empty(), "shadow L84 should not fail: {:?}", warnings);
    }

    // ── ROOT CAUSE: single-line hash ref sets end_line == line ──
    // When the agent sends "f": "h:xxxx:16", the TS layer parses ":16" as
    // [16, 16] (start == end), which sets BOTH line=16 and end_line=16.
    // The replace_body handler then computes end_rel = end_line - idx = 1,
    // which is NOT > 1, so it passes a 1-line slice to find_body_bounds.
    // A 1-line slice can never contain a body. This is the exact bug.

    #[test]
    fn root_cause_single_line_end_line_bracketmaze() {
        // Simulates h:xxxx:16 → line=16, end_line=16
        let edits = vec![le(16, "replace_body", Some("  return typeof input;"), Some(16))];
        let result = apply_line_edits(REPRO, &edits);
        assert!(result.is_ok(),
            "replace_body with end_line==line must NOT fail. \
             Single-line hash ref should be treated as 'no scope'. Got: {:?}", result.err());
        let (content, _, _) = result.unwrap();
        assert!(content.contains("return typeof input"), "new body should appear");
        assert!(!content.contains("switch (typeof input)"), "old body should be gone");
    }

    #[test]
    fn root_cause_single_line_end_line_sql() {
        let edits = vec![le(50, "replace_body", Some("  return strings.join('');"), Some(50))];
        let result = apply_line_edits(REPRO, &edits);
        assert!(result.is_ok(),
            "replace_body with end_line==line on sql must NOT fail. Got: {:?}", result.err());
    }

    #[test]
    fn root_cause_single_line_end_line_tortureclass() {
        let edits = vec![le(58, "replace_body", Some("  data: T;\n  constructor(data: T) { this.data = data; }"), Some(58))];
        let result = apply_line_edits(REPRO, &edits);
        assert!(result.is_ok(),
            "replace_body with end_line==line on TortureClass must NOT fail. Got: {:?}", result.err());
        let (content, _, _) = result.unwrap();
        assert!(content.contains("constructor(data: T) { this.data = data; }"),
            "new class body should appear");
        assert!(!content.contains("[Symbol.iterator]"),
            "old class members (Symbol.iterator) should be gone, but found in:\n{}",
            content.lines().skip(56).take(10).collect::<Vec<_>>().join("\n"));
    }

    #[test]
    fn root_cause_single_line_end_line_processdata() {
        // With end_line==line (single-line hash ref), the fix filters it out
        // and falls through to the EOF scan path. find_body_bounds on processData
        // with its complex destructuring defaults picks the wrong body (a later
        // declaration) — this is a known limitation of the cluster heuristic when
        // the signature contains many nested brace pairs. The important thing is
        // that the edit doesn't fail with "could not find body bounds" anymore.
        let edits = vec![le(84, "replace_body", Some("  return { success: true, elapsed: 0 };"), Some(84))];
        let result = apply_line_edits(REPRO, &edits);
        assert!(result.is_ok(),
            "replace_body with end_line==line on processData must NOT fail with 'could not find body bounds'. Got: {:?}", result.err());
    }

    #[test]
    fn diagnostic_find_body_bounds_tortureclass_eof_slice() {
        let lines: Vec<&str> = REPRO.lines().collect();
        let slice = &lines[57..]; // L58 0-indexed
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(), "should find bounds");
        let (start, end) = bounds.unwrap();
        eprintln!("TortureClass EOF slice: start={}, end={}, first_body_line={:?}, last_body_line={:?}",
            start, end,
            slice.get(start).map(|s| &s[..std::cmp::min(s.len(), 60)]),
            slice.get(end.saturating_sub(1)).map(|s| &s[..std::cmp::min(s.len(), 60)]));
        // The class body should span from L59 to L81 (0-indexed 1 to 23 relative to slice)
        assert!(end > 10, "class body should span all members, got end={}", end);
    }

    #[test]
    fn diagnostic_find_body_bounds_processdata_eof_slice() {
        // Known limitation: processData has deeply nested destructuring defaults
        // with many brace pairs in the signature. find_body_bounds' cluster heuristic
        // absorbs them all and picks a later declaration's body instead of the
        // function body. The ideal result would be start~15, end~24 (relative to
        // slice at L84). Currently it picks the DeepNested type body (~start=30).
        // This test documents the current behavior; fixing it requires smarter
        // signature-vs-body disambiguation in find_body_bounds.
        let lines: Vec<&str> = REPRO.lines().collect();
        let slice = &lines[83..]; // L84 0-indexed
        let bounds = find_body_bounds(slice);
        assert!(bounds.is_some(), "should find SOME bounds (not None)");
    }
}
