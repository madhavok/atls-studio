//! Diff Engine — computes unified diffs between two hash registry states.
//!
//! Supports `h:OLD..h:NEW` syntax for zero-token change explanation.
//! The model emits a tiny diff ref; the frontend renders a full diff view.

use crate::hash_resolver::{self, HashRegistry};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiffStats {
    pub added: usize,
    pub removed: usize,
    pub changed_hunks: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
    /// Line number in old file (for removals/context)
    pub old_line: Option<usize>,
    /// Line number in new file (for additions/context)
    pub new_line: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Add,
    Remove,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiffResult {
    pub source: Option<String>,
    pub hunks: Vec<DiffHunk>,
    pub stats: DiffStats,
    pub unified: String,
}

// ---------------------------------------------------------------------------
// Core diff algorithm (Myers-like, simple O(ND))
// ---------------------------------------------------------------------------

/// Compute a unified diff between two hash states from the registry.
pub fn compute_diff(
    registry: &HashRegistry,
    old_hash: &str,
    new_hash: &str,
    context_lines: usize,
) -> Result<DiffResult, String> {
    // Use get_original to retrieve actual content at each hash; get() follows forwarding
    // and would return the newest version for same-source entries, breaking diff semantics.
    let old_entry = registry.get_original(old_hash)
        .ok_or_else(|| format!("Old hash h:{} not found in registry", old_hash))?;
    let new_entry = registry.get_original(new_hash)
        .ok_or_else(|| format!("New hash h:{} not found in registry", new_hash))?;

    let source = new_entry.source.clone()
        .or_else(|| old_entry.source.clone());

    let old_lines: Vec<&str> = old_entry.content.lines().collect();
    let new_lines: Vec<&str> = new_entry.content.lines().collect();

    let edit_script = compute_lcs_diff(&old_lines, &new_lines);
    let hunks = build_hunks(&edit_script, &old_lines, &new_lines, context_lines);

    let mut added = 0;
    let mut removed = 0;
    for hunk in &hunks {
        for line in &hunk.lines {
            match line.kind {
                DiffLineKind::Add => added += 1,
                DiffLineKind::Remove => removed += 1,
                DiffLineKind::Context => {}
            }
        }
    }

    let stats = DiffStats {
        added,
        removed,
        changed_hunks: hunks.len(),
    };

    let unified = format_unified(&hunks, source.as_deref(), old_hash, new_hash);

    Ok(DiffResult { source, hunks, stats, unified })
}

// ---------------------------------------------------------------------------
// LCS-based diff (simple, no external dep)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum EditOp {
    Keep(usize, usize),
    Insert(usize),
    Delete(usize),
}

fn compute_lcs_diff<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<EditOp> {
    let n = old.len();
    let m = new.len();

    // LCS table (O(nm) space — acceptable for file-sized inputs)
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            if old[i - 1] == new[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }

    // Backtrack to produce edit script
    let mut ops = Vec::new();
    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && old[i - 1] == new[j - 1] {
            ops.push(EditOp::Keep(i - 1, j - 1));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            ops.push(EditOp::Insert(j - 1));
            j -= 1;
        } else {
            ops.push(EditOp::Delete(i - 1));
            i -= 1;
        }
    }
    ops.reverse();
    ops
}

fn build_hunks(
    ops: &[EditOp],
    old: &[&str],
    new: &[&str],
    context: usize,
) -> Vec<DiffHunk> {
    // Convert ops to diff lines with line numbers
    let mut all_lines: Vec<DiffLine> = Vec::new();
    for op in ops {
        match op {
            EditOp::Keep(oi, ni) => {
                all_lines.push(DiffLine {
                    kind: DiffLineKind::Context,
                    content: old[*oi].to_string(),
                    old_line: Some(oi + 1),
                    new_line: Some(ni + 1),
                });
            }
            EditOp::Delete(oi) => {
                all_lines.push(DiffLine {
                    kind: DiffLineKind::Remove,
                    content: old[*oi].to_string(),
                    old_line: Some(oi + 1),
                    new_line: None,
                });
            }
            EditOp::Insert(ni) => {
                all_lines.push(DiffLine {
                    kind: DiffLineKind::Add,
                    content: new[*ni].to_string(),
                    old_line: None,
                    new_line: Some(ni + 1),
                });
            }
        }
    }

    // Group into hunks with context
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut change_indices: Vec<usize> = Vec::new();
    for (i, line) in all_lines.iter().enumerate() {
        if line.kind != DiffLineKind::Context {
            change_indices.push(i);
        }
    }

    if change_indices.is_empty() {
        return hunks;
    }

    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut group_start = change_indices[0];
    let mut group_end = change_indices[0];

    for &idx in &change_indices[1..] {
        if idx <= group_end + 2 * context + 1 {
            group_end = idx;
        } else {
            groups.push((group_start, group_end));
            group_start = idx;
            group_end = idx;
        }
    }
    groups.push((group_start, group_end));

    for (gs, ge) in groups {
        let start = gs.saturating_sub(context);
        let end = (ge + context + 1).min(all_lines.len());
        let hunk_lines = all_lines[start..end].to_vec();

        let old_start = hunk_lines.iter()
            .find_map(|l| l.old_line)
            .unwrap_or(1);
        let new_start = hunk_lines.iter()
            .find_map(|l| l.new_line)
            .unwrap_or(1);
        let old_count = hunk_lines.iter()
            .filter(|l| l.kind != DiffLineKind::Add)
            .count();
        let new_count = hunk_lines.iter()
            .filter(|l| l.kind != DiffLineKind::Remove)
            .count();

        hunks.push(DiffHunk {
            old_start,
            old_count,
            new_start,
            new_count,
            lines: hunk_lines,
        });
    }

    hunks
}

// ---------------------------------------------------------------------------
// Unified diff formatting
// ---------------------------------------------------------------------------

fn format_unified(
    hunks: &[DiffHunk],
    source: Option<&str>,
    old_hash: &str,
    new_hash: &str,
) -> String {
    let mut out = String::new();
    let src = source.unwrap_or("file");
    let old_short = if old_hash.len() > hash_resolver::SHORT_HASH_LEN { &old_hash[..hash_resolver::SHORT_HASH_LEN] } else { old_hash };
    let new_short = if new_hash.len() > hash_resolver::SHORT_HASH_LEN { &new_hash[..hash_resolver::SHORT_HASH_LEN] } else { new_hash };

    out.push_str(&format!("--- {} (h:{})\n", src, old_short));
    out.push_str(&format!("+++ {} (h:{})\n", src, new_short));

    for hunk in hunks {
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_count,
            hunk.new_start, hunk.new_count,
        ));
        for line in &hunk.lines {
            let prefix = match line.kind {
                DiffLineKind::Context => ' ',
                DiffLineKind::Add => '+',
                DiffLineKind::Remove => '-',
            };
            out.push(prefix);
            out.push_str(&line.content);
            out.push('\n');
        }
    }

    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash_resolver::{HashEntry, HashRegistry, detect_lang};

    fn entry(source: &str, content: &str) -> HashEntry {
        HashEntry {
            source: Some(source.to_string()),
            content: content.to_string(),
            tokens: content.len() / 4,
            lang: detect_lang(Some(source)),
            line_count: content.lines().count(),
            symbol_count: None,
            spilled: false,
        }
    }

    #[test]
    fn test_compute_diff_basic() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), entry("src/a.ts", "line1\nline2\nline3"));
        reg.register("ccdd3344".to_string(), entry("src/a.ts", "line1\nchanged\nline3"));

        let result = compute_diff(&reg, "aabb1122", "ccdd3344", 1).unwrap();
        assert_eq!(result.stats.added, 1);
        assert_eq!(result.stats.removed, 1);
        assert!(result.unified.contains("+changed"));
        assert!(result.unified.contains("-line2"));
    }

    #[test]
    fn test_compute_diff_addition() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), entry("src/a.ts", "a\nb"));
        reg.register("ccdd3344".to_string(), entry("src/a.ts", "a\nb\nc"));

        let result = compute_diff(&reg, "aabb1122", "ccdd3344", 1).unwrap();
        assert_eq!(result.stats.added, 1);
        assert_eq!(result.stats.removed, 0);
        assert!(result.unified.contains("+c"));
    }

    #[test]
    fn test_compute_diff_deletion() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), entry("src/a.ts", "a\nb\nc"));
        reg.register("ccdd3344".to_string(), entry("src/a.ts", "a\nc"));

        let result = compute_diff(&reg, "aabb1122", "ccdd3344", 1).unwrap();
        assert_eq!(result.stats.removed, 1);
        assert!(result.unified.contains("-b"));
    }

    #[test]
    fn test_compute_diff_no_changes() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), entry("src/a.ts", "same\ncontent"));
        reg.register("ccdd3344".to_string(), entry("src/a.ts", "same\ncontent"));

        let result = compute_diff(&reg, "aabb1122", "ccdd3344", 1).unwrap();
        assert_eq!(result.stats.added, 0);
        assert_eq!(result.stats.removed, 0);
        assert!(result.hunks.is_empty());
    }
}
