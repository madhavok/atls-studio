use crate::LineEdit;

/// Line mapping from old (shadow) line numbers to new (current) line numbers.
/// Index 0 is unused; index i corresponds to old 1-based line i.
/// `Some(n)` means old line i maps to current line n (1-based).
/// `None` means the line was deleted or in a changed hunk (no safe remap).
pub struct LineMap {
    map: Vec<Option<u32>>,
}

impl LineMap {
    #[cfg(test)]
    pub fn identity(line_count: usize) -> Self {
        let mut map = vec![None; line_count + 1];
        for i in 1..=line_count {
            map[i] = Some(i as u32);
        }
        Self { map }
    }

    pub fn remap(&self, old_line: u32) -> Option<u32> {
        let idx = old_line as usize;
        if idx < self.map.len() {
            self.map[idx]
        } else {
            None
        }
    }

    pub fn is_identity(&self) -> bool {
        self.map.iter().enumerate().skip(1).all(|(i, v)| *v == Some(i as u32))
    }
}

/// Compute a line map from old content to new content using LCS diff.
/// Only lines in equal (Keep) hunks get mappings; lines in changed/inserted/deleted
/// regions get `None`.
pub fn compute_line_map(old_content: &str, new_content: &str) -> LineMap {
    let old_lines: Vec<&str> = old_content.lines().collect();
    let new_lines: Vec<&str> = new_content.lines().collect();

    let old_count = old_lines.len();

    if old_count == 0 {
        return LineMap { map: vec![None; 1] };
    }

    let ops = compute_lcs_diff(&old_lines, &new_lines);

    let mut map = vec![None; old_count + 1];
    for op in &ops {
        if let LcsOp::Keep(old_idx, new_idx) = op {
            map[old_idx + 1] = Some((*new_idx + 1) as u32);
        }
    }

    LineMap { map }
}

/// Remap line numbers in a set of LineEdits using a shadow-to-current line map.
/// Returns notice strings for edits that were shifted.
///
/// - Edits with anchors: `edit.line` is remapped as a **hint** (anchor still resolves
///   against the current buffer and wins).
/// - Edits without anchors: `edit.line` is remapped as the **primary locator**.
/// - Edits whose lines fall in changed hunks (`None` mapping) are left unchanged.
pub fn remap_edits(edits: &mut [LineEdit], map: &LineMap, shadow_hash_short: &str) -> Vec<String> {
    let mut notices = Vec::new();

    for edit in edits.iter_mut() {
        if edit.line == 0 {
            continue;
        }
        if let Some(new_line) = map.remap(edit.line) {
            if new_line != edit.line {
                let delta = new_line as i64 - edit.line as i64;
                let sign = if delta > 0 { "+" } else { "" };
                notices.push(format!(
                    "line_remapped: edit L{}→L{} via shadow diff (shadow h:{}, delta {}{})",
                    edit.line, new_line, shadow_hash_short, sign, delta
                ));
                edit.line = new_line;
            }
        }
        // None → line was in a changed hunk; leave edit.line as-is
    }

    notices
}

// ---------------------------------------------------------------------------
// LCS diff (reused from diff_engine pattern, purpose-built for line mapping)
// ---------------------------------------------------------------------------

enum LcsOp {
    Keep(usize, usize),
    Insert,
    Delete,
}

fn compute_lcs_diff<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<LcsOp> {
    let n = old.len();
    let m = new.len();

    // Strip common prefix/suffix to reduce the LCS table size
    let mut prefix = 0;
    while prefix < n && prefix < m && old[prefix] == new[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < (n - prefix) && suffix < (m - prefix)
        && old[n - 1 - suffix] == new[m - 1 - suffix]
    {
        suffix += 1;
    }

    let old_mid = &old[prefix..n - suffix];
    let new_mid = &new[prefix..m - suffix];
    let nm = old_mid.len();
    let mm = new_mid.len();

    let mut ops = Vec::with_capacity(n + m);

    // Common prefix → Keep
    for i in 0..prefix {
        ops.push(LcsOp::Keep(i, i));
    }

    if nm == 0 && mm == 0 {
        // Only prefix+suffix, no middle
    } else if nm == 0 {
        for _ in 0..mm {
            ops.push(LcsOp::Insert);
        }
    } else if mm == 0 {
        for _ in 0..nm {
            ops.push(LcsOp::Delete);
        }
    } else {
        // LCS on the middle portion
        let mut dp = vec![vec![0u32; mm + 1]; nm + 1];
        for i in 1..=nm {
            for j in 1..=mm {
                if old_mid[i - 1] == new_mid[j - 1] {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
                }
            }
        }

        let mut mid_ops = Vec::new();
        let mut i = nm;
        let mut j = mm;
        while i > 0 || j > 0 {
            if i > 0 && j > 0 && old_mid[i - 1] == new_mid[j - 1] {
                mid_ops.push(LcsOp::Keep(prefix + i - 1, prefix + j - 1));
                i -= 1;
                j -= 1;
            } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
                mid_ops.push(LcsOp::Insert);
                j -= 1;
            } else {
                mid_ops.push(LcsOp::Delete);
                i -= 1;
            }
        }
        mid_ops.reverse();
        ops.extend(mid_ops);
    }

    // Common suffix → Keep
    for i in 0..suffix {
        ops.push(LcsOp::Keep(n - suffix + i, m - suffix + i));
    }

    ops
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_edit(line: u32, action: &str, anchor: Option<&str>, content: Option<&str>) -> LineEdit {
        LineEdit {
            line,
            action: action.to_string(),
            content: content.map(|s| s.to_string()),
            count: None,
            symbol: None,
            position: None,
            anchor: anchor.map(|s| s.to_string()),
            anchor_miss_policy: None,
            destination: None,
            reindent: false,
        }
    }

    #[test]
    fn remap_through_pure_insertion() {
        // 5 lines inserted at line 20 → lines after 20 shift by +5
        let old: Vec<String> = (1..=100).map(|i| format!("line {}", i)).collect();
        let mut new_lines: Vec<String> = old[..19].to_vec(); // lines 1-19
        for i in 0..5 {
            new_lines.push(format!("inserted {}", i));
        }
        new_lines.extend_from_slice(&old[19..]); // lines 20-100

        let old_str = old.join("\n");
        let new_str = new_lines.join("\n");
        let map = compute_line_map(&old_str, &new_str);

        // Line 10 (before insertion) → still 10
        assert_eq!(map.remap(10), Some(10));
        // Line 50 (after insertion) → 55
        assert_eq!(map.remap(50), Some(55));
        // Line 100 → 105
        assert_eq!(map.remap(100), Some(105));
    }

    #[test]
    fn remap_through_deletion() {
        // 5 lines deleted at lines 20-24 → lines after 24 shift by -5
        let old: Vec<String> = (1..=100).map(|i| format!("line {}", i)).collect();
        let mut new_lines: Vec<String> = old[..19].to_vec(); // lines 1-19
        // skip lines 20-24 (old[19..24])
        new_lines.extend_from_slice(&old[24..]); // lines 25-100

        let old_str = old.join("\n");
        let new_str = new_lines.join("\n");
        let map = compute_line_map(&old_str, &new_str);

        // Line 10 → still 10
        assert_eq!(map.remap(10), Some(10));
        // Lines 20-24 were deleted → None
        for l in 20..=24 {
            assert_eq!(map.remap(l), None, "deleted line {} should be None", l);
        }
        // Line 50 → 45
        assert_eq!(map.remap(50), Some(45));
    }

    #[test]
    fn no_remap_for_changed_hunk() {
        let old = "line 1\nline 2\nline 3\nline 4\nline 5";
        let new = "line 1\nline 2\nREWRITTEN\nline 4\nline 5";
        let map = compute_line_map(old, new);

        assert_eq!(map.remap(1), Some(1));
        assert_eq!(map.remap(2), Some(2));
        assert_eq!(map.remap(3), None); // changed
        assert_eq!(map.remap(4), Some(4));
        assert_eq!(map.remap(5), Some(5));
    }

    #[test]
    fn identity_diff_no_remapping() {
        let content = "line 1\nline 2\nline 3";
        let map = compute_line_map(content, content);

        assert!(map.is_identity());
        assert_eq!(map.remap(1), Some(1));
        assert_eq!(map.remap(2), Some(2));
        assert_eq!(map.remap(3), Some(3));
    }

    #[test]
    fn remap_edits_shifts_line_numbers() {
        let old: Vec<String> = (1..=100).map(|i| format!("line {}", i)).collect();
        let mut new_lines: Vec<String> = old[..19].to_vec();
        for i in 0..5 {
            new_lines.push(format!("inserted {}", i));
        }
        new_lines.extend_from_slice(&old[19..]);

        let map = compute_line_map(&old.join("\n"), &new_lines.join("\n"));

        let mut edits = vec![
            make_edit(50, "replace", None, Some("new content")),
            make_edit(10, "insert_after", None, Some("added")),
        ];

        let notices = remap_edits(&mut edits, &map, "abc123");

        assert_eq!(edits[0].line, 55); // shifted +5
        assert_eq!(edits[1].line, 10); // before insertion, unchanged
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("L50→L55"));
    }

    #[test]
    fn remap_edits_leaves_changed_hunk_unchanged() {
        let old = "line 1\nline 2\nline 3\nline 4\nline 5";
        let new = "line 1\nline 2\nREWRITTEN\nline 4\nline 5";
        let map = compute_line_map(old, new);

        let mut edits = vec![
            make_edit(3, "replace", Some("line 3"), Some("fixed")),
        ];

        let notices = remap_edits(&mut edits, &map, "abc123");

        // Line 3 is in a changed hunk → not remapped
        assert_eq!(edits[0].line, 3);
        assert!(notices.is_empty());
    }

    #[test]
    fn remap_with_anchor_shifts_hint_only() {
        // Anchor-bearing edits get their line shifted, but anchor still resolves
        // against the current buffer (tested via apply_line_edits, not here).
        // This test just verifies the line field is updated.
        let old: Vec<String> = (1..=50).map(|i| format!("fn func_{}() {{}}", i)).collect();
        let mut new_lines: Vec<String> = old[..9].to_vec();
        new_lines.push("// new comment".to_string());
        new_lines.extend_from_slice(&old[9..]);

        let map = compute_line_map(&old.join("\n"), &new_lines.join("\n"));

        let mut edits = vec![
            make_edit(25, "replace", Some("fn func_25()"), Some("fn func_25_v2() {}")),
        ];

        let notices = remap_edits(&mut edits, &map, "def456");

        assert_eq!(edits[0].line, 26); // shifted +1
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("L25→L26"));
    }

    #[test]
    fn no_shadow_produces_no_notices() {
        // When there's no shadow (identity map), no remapping occurs
        let content = "a\nb\nc\nd\ne";
        let map = compute_line_map(content, content);

        let mut edits = vec![make_edit(3, "replace", None, Some("x"))];
        let notices = remap_edits(&mut edits, &map, "aaa");

        assert_eq!(edits[0].line, 3);
        assert!(notices.is_empty());
    }

    #[test]
    fn out_of_range_line_returns_none() {
        let old = "line 1\nline 2";
        let new = "line 1\nline 2";
        let map = compute_line_map(old, new);

        assert_eq!(map.remap(999), None);
    }

    #[test]
    fn line_zero_skipped() {
        let old = "a\nb\nc";
        let new = "a\nINSERTED\nb\nc";
        let map = compute_line_map(old, new);

        let mut edits = vec![make_edit(0, "insert_before", None, Some("x"))];
        let notices = remap_edits(&mut edits, &map, "aaa");

        assert_eq!(edits[0].line, 0); // untouched
        assert!(notices.is_empty());
    }

    // -----------------------------------------------------------------------
    // Integration tests: remap + apply_line_edits pipeline
    // -----------------------------------------------------------------------

    #[test]
    fn remap_plus_anchor_resolves_correctly() {
        // Shadow: 10 lines. Current: 5 lines inserted at top → everything shifts +5.
        // Edit targets shadow line 8 with anchor "target_line".
        // After remap, edit.line = 13. Anchor resolves at line 13 in current buffer.
        let shadow = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\ntarget_line\nline 9\nline 10";
        let mut current_lines: Vec<&str> = vec!["new 1", "new 2", "new 3", "new 4", "new 5"];
        current_lines.extend(shadow.lines());
        let current = current_lines.join("\n");

        let map = compute_line_map(shadow, &current);

        let mut edits = vec![make_edit(8, "replace", Some("target_line"), Some("REPLACED"))];
        let notices = remap_edits(&mut edits, &map, "abc");

        assert_eq!(edits[0].line, 13); // remapped from 8 to 13
        assert_eq!(notices.len(), 1);

        let (result, warnings) = crate::apply_line_edits(&current, &edits).unwrap();
        assert!(result.contains("REPLACED"));
        assert!(!result.contains("target_line"));
        // No anchor warnings — anchor found at the remapped position
        let has_miss = warnings.iter().any(|w| w.contains("anchor_miss") || w.contains("not found"));
        assert!(!has_miss, "unexpected anchor warning: {:?}", warnings);
    }

    #[test]
    fn remap_plus_fuzzy_resolves_case_insensitive() {
        // Shadow: 10 lines. Current: 3 lines deleted at top → everything shifts -3.
        // Anchor is case-mismatched ("TARGET_LINE" vs "target_line").
        // After remap, edit.line = 5 (was 8). Fuzzy finds case-insensitive match near 5.
        let shadow = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\ntarget_line\nline 9\nline 10";
        let current_lines: Vec<&str> = shadow.lines().skip(3).collect(); // drop first 3
        let current = current_lines.join("\n");

        let map = compute_line_map(shadow, &current);

        let mut edits = vec![make_edit(8, "replace", Some("TARGET_LINE"), Some("REPLACED"))];
        let notices = remap_edits(&mut edits, &map, "def");

        assert_eq!(edits[0].line, 5); // remapped from 8 to 5
        assert_eq!(notices.len(), 1);

        let (result, warnings) = crate::apply_line_edits(&current, &edits).unwrap();
        assert!(result.contains("REPLACED"));
        assert!(!result.contains("target_line"));
        // Should have fuzzy resolution notice
        let has_fuzzy = warnings.iter().any(|w| w.contains("fuzzy_resolved"));
        assert!(has_fuzzy, "expected fuzzy resolution notice, got: {:?}", warnings);
    }

    #[test]
    fn remap_no_anchor_content_identity() {
        // No anchor — pure line-number edit. Shadow line 8 shifts to current line 13.
        // The content at current line 13 is the same as shadow line 8 (content identity).
        let shadow = "a\nb\nc\nd\ne\nf\ng\nTARGET\ni\nj";
        let mut current_lines: Vec<&str> = vec!["x1", "x2", "x3", "x4", "x5"];
        current_lines.extend(shadow.lines());
        let current = current_lines.join("\n");

        let map = compute_line_map(shadow, &current);

        let mut edits = vec![make_edit(8, "replace", None, Some("REPLACED"))];
        let notices = remap_edits(&mut edits, &map, "ghi");

        assert_eq!(edits[0].line, 13);
        assert_eq!(notices.len(), 1);

        let (result, _) = crate::apply_line_edits(&current, &edits).unwrap();
        let result_lines: Vec<&str> = result.lines().collect();
        assert_eq!(result_lines[12], "REPLACED"); // 0-indexed line 12 = 1-indexed line 13
    }
}
