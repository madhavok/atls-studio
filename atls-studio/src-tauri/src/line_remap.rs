use crate::{LineCoordinate, LineEdit};

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

/// Maximum changed lines in the middle portion (after prefix/suffix strip) before
/// we bail out. Beyond this threshold the file has drifted too much for line-number
/// remapping to be reliable — the model should re-read instead.
/// At 150×150 the DP table is ~22K cells (microseconds). Real stale-edit scenarios
/// rarely exceed 50 changed lines in the middle.
const MAX_MIDDLE_LINES: usize = 150;

/// Compute a line map from old content to new content using LCS diff.
/// Only lines in equal (Keep) hunks get mappings; lines in changed/inserted/deleted
/// regions get `None`. Bails out with an all-None map if the middle portion
/// (after prefix/suffix stripping) exceeds MAX_MIDDLE_LINES on either side.
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
/// `edit.line` is remapped when the map has a definite mapping; lines in changed
/// hunks (`None` mapping) are left unchanged.
pub fn remap_edits(edits: &mut [LineEdit], map: &LineMap, shadow_hash_short: &str) -> Vec<String> {
    let mut notices = Vec::new();

    for edit in edits.iter_mut() {
        let old_abs = match &edit.line {
            LineCoordinate::Abs(0) => continue,
            LineCoordinate::Abs(n) => *n,
            LineCoordinate::End | LineCoordinate::Neg(_) => continue,
        };
        if let Some(new_line) = map.remap(old_abs) {
            if new_line != old_abs {
                let delta = new_line as i64 - old_abs as i64;
                let sign = if delta > 0 { "+" } else { "" };
                notices.push(format!(
                    "line_remapped: edit L{}→L{} via shadow diff (shadow h:{}, delta {}{})",
                    old_abs, new_line, shadow_hash_short, sign, delta
                ));
                edit.line = LineCoordinate::Abs(new_line);
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

    // Bail out if the middle portion is too large — file drifted too much
    if nm > MAX_MIDDLE_LINES || mm > MAX_MIDDLE_LINES {
        return Vec::new();
    }

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

    fn make_edit(line: u32, action: &str, content: Option<&str>) -> LineEdit {
        LineEdit {
            line: LineCoordinate::Abs(line),
            action: action.to_string(),
            content: content.map(|s| s.to_string()),
            end_line: None,
            symbol: None,
            position: None,
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
            make_edit(50, "replace", Some("new content")),
            make_edit(10, "insert_after", Some("added")),
        ];

        let notices = remap_edits(&mut edits, &map, "abc123");

        assert_eq!(edits[0].line, LineCoordinate::Abs(55)); // shifted +5
        assert_eq!(edits[1].line, LineCoordinate::Abs(10)); // before insertion, unchanged
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("L50→L55"));
    }

    #[test]
    fn remap_edits_leaves_changed_hunk_unchanged() {
        let old = "line 1\nline 2\nline 3\nline 4\nline 5";
        let new = "line 1\nline 2\nREWRITTEN\nline 4\nline 5";
        let map = compute_line_map(old, new);

        let mut edits = vec![
            make_edit(3, "replace", Some("fixed")),
        ];

        let notices = remap_edits(&mut edits, &map, "abc123");

        // Line 3 is in a changed hunk → not remapped
        assert_eq!(edits[0].line, LineCoordinate::Abs(3));
        assert!(notices.is_empty());
    }

    #[test]
    fn remap_shifts_line_after_insert_above() {
        let old: Vec<String> = (1..=50).map(|i| format!("fn func_{}() {{}}", i)).collect();
        let mut new_lines: Vec<String> = old[..9].to_vec();
        new_lines.push("// new comment".to_string());
        new_lines.extend_from_slice(&old[9..]);

        let map = compute_line_map(&old.join("\n"), &new_lines.join("\n"));

        let mut edits = vec![
            make_edit(25, "replace", Some("fn func_25_v2() {}")),
        ];

        let notices = remap_edits(&mut edits, &map, "def456");

        assert_eq!(edits[0].line, LineCoordinate::Abs(26)); // shifted +1
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("L25→L26"));
    }

    #[test]
    fn no_shadow_produces_no_notices() {
        // When there's no shadow (identity map), no remapping occurs
        let content = "a\nb\nc\nd\ne";
        let map = compute_line_map(content, content);

        let mut edits = vec![make_edit(3, "replace", Some("x"))];
        let notices = remap_edits(&mut edits, &map, "aaa");

        assert_eq!(edits[0].line, LineCoordinate::Abs(3));
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

        let mut edits = vec![make_edit(0, "insert_before", Some("x"))];
        let notices = remap_edits(&mut edits, &map, "aaa");

        assert_eq!(edits[0].line, LineCoordinate::Abs(0)); // untouched
        assert!(notices.is_empty());
    }

    // -----------------------------------------------------------------------
    // Integration tests: remap + apply_line_edits pipeline
    // -----------------------------------------------------------------------

    #[test]
    fn remap_plus_apply_line_edits_line_number() {
        // Shadow: 10 lines. Current: 5 lines inserted at top → everything shifts +5.
        // Edit targets shadow line 8; after remap, edit.line = 13.
        let shadow = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\ntarget_line\nline 9\nline 10";
        let mut current_lines: Vec<&str> = vec!["new 1", "new 2", "new 3", "new 4", "new 5"];
        current_lines.extend(shadow.lines());
        let current = current_lines.join("\n");

        let map = compute_line_map(shadow, &current);

        let mut edits = vec![make_edit(8, "replace", Some("REPLACED"))];
        let notices = remap_edits(&mut edits, &map, "abc");

        assert_eq!(edits[0].line, LineCoordinate::Abs(13)); // remapped from 8 to 13
        assert_eq!(notices.len(), 1);

        let (result, warnings, _) = crate::apply_line_edits(&current, &edits).unwrap();
        assert!(result.contains("REPLACED"));
        assert!(!result.contains("target_line"));
        assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings);
    }

    #[test]
    fn large_middle_bails_out() {
        // When the middle portion exceeds MAX_MIDDLE_LINES, compute_line_map
        // returns an all-None map (no remapping attempted).
        let old: Vec<String> = (0..200).map(|i| format!("old_{}", i)).collect();
        let new: Vec<String> = (0..200).map(|i| format!("new_{}", i)).collect();
        let map = compute_line_map(&old.join("\n"), &new.join("\n"));

        // All lines should be None (no common prefix/suffix, middle too large)
        for i in 1..=200 {
            assert_eq!(map.remap(i), None, "line {} should be None when middle exceeds cap", i);
        }
    }

    #[test]
    fn large_file_small_diff_still_works() {
        // 500-line file with 5 lines inserted at line 10 — prefix/suffix strip
        // reduces the middle to ~5 lines, well under the cap.
        let old: Vec<String> = (1..=500).map(|i| format!("line {}", i)).collect();
        let mut new_lines: Vec<String> = old[..9].to_vec();
        for i in 0..5 {
            new_lines.push(format!("inserted {}", i));
        }
        new_lines.extend_from_slice(&old[9..]);

        let map = compute_line_map(&old.join("\n"), &new_lines.join("\n"));

        // Lines before insertion unchanged
        assert_eq!(map.remap(5), Some(5));
        // Lines after insertion shifted +5
        assert_eq!(map.remap(100), Some(105));
        assert_eq!(map.remap(500), Some(505));
    }

    #[test]
    fn remap_line_number_content_identity() {
        // Shadow line 8 shifts to current line 13.
        let shadow = "a\nb\nc\nd\ne\nf\ng\nTARGET\ni\nj";
        let mut current_lines: Vec<&str> = vec!["x1", "x2", "x3", "x4", "x5"];
        current_lines.extend(shadow.lines());
        let current = current_lines.join("\n");

        let map = compute_line_map(shadow, &current);

        let mut edits = vec![make_edit(8, "replace", Some("REPLACED"))];
        let notices = remap_edits(&mut edits, &map, "ghi");

        assert_eq!(edits[0].line, LineCoordinate::Abs(13));
        assert_eq!(notices.len(), 1);

        let (result, _, _) = crate::apply_line_edits(&current, &edits).unwrap();
        let result_lines: Vec<&str> = result.lines().collect();
        assert_eq!(result_lines[12], "REPLACED"); // 0-indexed line 12 = 1-indexed line 13
    }
}
