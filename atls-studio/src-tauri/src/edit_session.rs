//! Canonical in-memory edit session.
//!
//! All file mutations flow through `EditSession`, which enforces:
//! - Preimage matching (expected text must be found exactly once)
//! - Hash-based staleness detection (abort if file changed since session start)
//! - Structural validation (tree-sitter parse before commit)
//! - Atomic disk writes (temp file + rename)
//!
//! Shaped/cached/signature views cannot start an edit session.

use std::path::{Path, PathBuf};

use crate::linter;
use crate::path_utils::{serialize_with_format, FileFormat};
use crate::snapshot::{self, FileSnapshot, SnapshotService};

/// The kind of edit operation.
#[derive(Debug, Clone)]
pub enum EditOpKind {
    /// Replace `preimage` with `replacement` (exact text match).
    ExactReplace,
    /// Replace byte range `[start, end)` with `replacement`.
    ByteRange { start: usize, end: usize },
    /// Replace the entire file content.
    WholeFile,
}

/// A single edit operation with its expected preimage.
#[derive(Debug, Clone)]
pub struct EditOp {
    pub kind: EditOpKind,
    pub preimage: String,
    pub replacement: String,
}

/// Record of an applied edit (for diagnostics and consolidation).
#[derive(Debug)]
#[allow(dead_code)]
struct EditRecord {
    kind: EditOpKind,
    byte_offset: usize,
    old_len: usize,
    new_len: usize,
}

/// Error from an edit session operation.
#[derive(Debug)]
pub enum EditSessionError {
    /// Preimage not found in working content.
    PreimageNotFound { preimage_preview: String },
    /// Preimage found multiple times (ambiguous).
    AmbiguousPreimage { count: usize, preimage_preview: String },
    /// Byte range out of bounds.
    RangeOutOfBounds { start: usize, end: usize, content_len: usize },
    /// Byte range content doesn't match preimage.
    RangePreimageMismatch { expected_preview: String, actual_preview: String },
    /// File changed on disk since session started.
    StaleOnCommit { path: String, expected_hash: String, actual_hash: String },
    /// Syntax errors in the edited content.
    SyntaxErrors { path: String, errors: Vec<String> },
    /// Generic I/O or other error.
    Io(String),
}

impl std::fmt::Display for EditSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PreimageNotFound { preimage_preview } =>
                write!(f, "preimage not found: {:?}", preimage_preview),
            Self::AmbiguousPreimage { count, preimage_preview } =>
                write!(f, "preimage matched {} times (ambiguous): {:?}", count, preimage_preview),
            Self::RangeOutOfBounds { start, end, content_len } =>
                write!(f, "byte range [{}, {}) out of bounds (content len: {})", start, end, content_len),
            Self::RangePreimageMismatch { expected_preview, actual_preview } =>
                write!(f, "byte range content mismatch: expected {:?}, got {:?}", expected_preview, actual_preview),
            Self::StaleOnCommit { path, expected_hash, actual_hash } =>
                write!(f, "stale on commit for {}: expected {}, actual {}. Re-read and retry.", path, expected_hash, actual_hash),
            Self::SyntaxErrors { path, errors } =>
                write!(f, "syntax errors in {}: {}", path, errors.join("; ")),
            Self::Io(msg) => write!(f, "{}", msg),
        }
    }
}

impl EditSessionError {
    pub fn error_class(&self) -> &'static str {
        match self {
            Self::PreimageNotFound { .. } => "preimage_not_found",
            Self::AmbiguousPreimage { .. } => "ambiguous_preimage",
            Self::RangeOutOfBounds { .. } => "range_out_of_bounds",
            Self::RangePreimageMismatch { .. } => "range_preimage_mismatch",
            Self::StaleOnCommit { .. } => "stale_on_commit",
            Self::SyntaxErrors { .. } => "syntax_error_after_edit",
            Self::Io(_) => "io_error",
        }
    }

    #[allow(dead_code)]
    pub fn to_json(&self, path: &str) -> serde_json::Value {
        serde_json::json!({
            "error": self.to_string(),
            "error_class": self.error_class(),
            "file": path,
            "_next": "Re-read the file and retry with correct content.",
        })
    }
}

/// Result of a successful commit.
#[allow(dead_code)]
pub struct CommitResult {
    pub path: String,
    pub old_hash: String,
    pub new_hash: String,
    pub new_content: String,
    pub file_format: FileFormat,
}

/// In-memory edit session for a single file.
///
/// Lifecycle: `begin()` -> `apply()` (one or more) -> `validate()` -> `commit()`.
#[allow(dead_code)]
pub struct EditSession {
    source_path: String,
    resolved_path: PathBuf,
    original_content: String,
    working_content: String,
    snapshot_hash: String,
    file_format: FileFormat,
    edits: Vec<EditRecord>,
}

impl EditSession {
    #[allow(dead_code)]
    /// Start a new edit session by reading canonical file bytes from disk.
    /// The session records the snapshot hash at load time for commit-time staleness check.
    pub fn begin(
        snapshot_svc: &mut SnapshotService,
        project_root: &Path,
        source_path: &str,
    ) -> Result<Self, EditSessionError> {
        let resolved = crate::path_utils::resolve_project_path(project_root, source_path);
        let snap = snapshot_svc.get_resolved(&resolved, source_path)
            .map_err(|e| EditSessionError::Io(e))?;

        Ok(Self {
            source_path: source_path.to_string(),
            resolved_path: resolved,
            original_content: snap.content.clone(),
            working_content: snap.content,
            snapshot_hash: snap.snapshot_hash,
            file_format: snap.file_format,
            edits: Vec::new(),
        })
    }

    /// Start a session from already-loaded content (for callers that already hold content).
    pub fn begin_from_snapshot(snap: &FileSnapshot, resolved_path: PathBuf) -> Self {
        Self {
            source_path: snap.path.clone(),
            resolved_path,
            original_content: snap.content.clone(),
            working_content: snap.content.clone(),
            snapshot_hash: snap.snapshot_hash.clone(),
            file_format: snap.file_format,
            edits: Vec::new(),
        }
    }

    #[allow(dead_code)]
    pub fn source_path(&self) -> &str { &self.source_path }
    #[allow(dead_code)]
    pub fn snapshot_hash(&self) -> &str { &self.snapshot_hash }
    #[allow(dead_code)]
    pub fn working_content(&self) -> &str { &self.working_content }
    #[allow(dead_code)]
    pub fn original_content(&self) -> &str { &self.original_content }
    #[allow(dead_code)]
    pub fn edits_count(&self) -> usize { self.edits.len() }

    /// Apply a single edit operation. The preimage must be found exactly once
    /// in the current working content (for ExactReplace), or the byte range
    /// must match the preimage (for ByteRange).
    pub fn apply(&mut self, op: EditOp) -> Result<(), EditSessionError> {
        match op.kind {
            EditOpKind::ExactReplace => {
                self.apply_exact_replace(&op.preimage, &op.replacement)
            }
            EditOpKind::ByteRange { start, end } => {
                self.apply_byte_range(start, end, &op.preimage, &op.replacement)
            }
            EditOpKind::WholeFile => {
                self.apply_whole_file(&op.preimage, &op.replacement)
            }
        }
    }

    fn apply_exact_replace(&mut self, preimage: &str, replacement: &str) -> Result<(), EditSessionError> {
        if preimage.is_empty() {
            return Err(EditSessionError::PreimageNotFound {
                preimage_preview: "[empty preimage]".to_string(),
            });
        }
        let preview = truncate_preview(preimage, 120);
        let mut positions: Vec<usize> = Vec::new();
        let mut start = 0;
        while let Some(pos) = self.working_content[start..].find(preimage) {
            positions.push(start + pos);
            start += pos + 1;
        }

        match positions.len() {
            0 => Err(EditSessionError::PreimageNotFound { preimage_preview: preview }),
            1 => {
                let offset = positions[0];
                let old_len = preimage.len();
                let new_len = replacement.len();
                self.working_content = format!(
                    "{}{}{}",
                    &self.working_content[..offset],
                    replacement,
                    &self.working_content[offset + old_len..],
                );
                self.edits.push(EditRecord {
                    kind: EditOpKind::ExactReplace,
                    byte_offset: offset, old_len, new_len,
                });
                Ok(())
            }
            n => Err(EditSessionError::AmbiguousPreimage { count: n, preimage_preview: preview }),
        }
    }

    fn apply_byte_range(&mut self, start: usize, end: usize, preimage: &str, replacement: &str) -> Result<(), EditSessionError> {
        let content_len = self.working_content.len();
        if start > content_len || end > content_len || start > end {
            return Err(EditSessionError::RangeOutOfBounds { start, end, content_len });
        }
        let actual = &self.working_content[start..end];
        if actual != preimage {
            return Err(EditSessionError::RangePreimageMismatch {
                expected_preview: truncate_preview(preimage, 120),
                actual_preview: truncate_preview(actual, 120),
            });
        }
        let old_len = end - start;
        let new_len = replacement.len();
        self.working_content = format!(
            "{}{}{}",
            &self.working_content[..start],
            replacement,
            &self.working_content[end..],
        );
        self.edits.push(EditRecord {
            kind: EditOpKind::ByteRange { start, end },
            byte_offset: start, old_len, new_len,
        });
        Ok(())
    }

    fn apply_whole_file(&mut self, preimage: &str, replacement: &str) -> Result<(), EditSessionError> {
        if !preimage.is_empty() && self.working_content != preimage {
            return Err(EditSessionError::PreimageNotFound {
                preimage_preview: format!("[whole_file mismatch, {} bytes expected vs {} actual]",
                    preimage.len(), self.working_content.len()),
            });
        }
        let old_len = self.working_content.len();
        let new_len = replacement.len();
        self.working_content = replacement.to_string();
        self.edits.push(EditRecord {
            kind: EditOpKind::WholeFile,
            byte_offset: 0, old_len, new_len,
        });
        Ok(())
    }

    /// Validate the working content: run tree-sitter syntax check for supported
    /// languages (JS/TS, Rust, Go, Java, Python, C#), check for conflict markers.
    pub fn validate(&self) -> Result<(), EditSessionError> {
        self.check_conflict_markers()?;
        self.check_syntax()?;
        Ok(())
    }

    fn check_conflict_markers(&self) -> Result<(), EditSessionError> {
        let markers = ["<<<<<<<", "=======", ">>>>>>>"];
        let mut found = Vec::new();
        for (i, line) in self.working_content.lines().enumerate() {
            for marker in &markers {
                if line.starts_with(marker) {
                    found.push(format!("L{}: {}", i + 1, marker));
                }
            }
        }
        if !found.is_empty() {
            return Err(EditSessionError::SyntaxErrors {
                path: self.source_path.clone(),
                errors: found,
            });
        }
        Ok(())
    }

    fn check_syntax(&self) -> Result<(), EditSessionError> {
        let ext = self.resolved_path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let use_ts_check = matches!(ext.as_str(), "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs");
        let use_treesitter_check = matches!(ext.as_str(), "rs" | "go" | "java" | "py" | "pyw" | "cs");

        if !use_ts_check && !use_treesitter_check {
            return Ok(());
        }

        // Baseline-aware: only reject errors that are NEW (not pre-existing in the original).
        // This prevents tree-sitter false positives (e.g. complex TS generics, Rust macros)
        // from blocking unrelated edits in files that already had those parse artifacts.
        let (baseline_results, post_results) = if use_ts_check {
            (
                linter::syntax_check_ts(&self.source_path, &self.original_content),
                linter::syntax_check_ts(&self.source_path, &self.working_content),
            )
        } else {
            let opts = linter::LintOptions {
                root_path: self.resolved_path.parent()
                    .unwrap_or(std::path::Path::new("."))
                    .to_string_lossy()
                    .to_string(),
                syntax_only: Some(true),
                max_errors_per_file: Some(50),
                ..Default::default()
            };
            (
                linter::lint_treesitter(&self.source_path, &self.original_content, &opts),
                linter::lint_treesitter(&self.source_path, &self.working_content, &opts),
            )
        };

        let baseline_errors: std::collections::HashSet<String> = baseline_results
            .iter()
            .filter(|e| e.severity == "error")
            .map(|e| format!("L{}:{}: {}", e.line, e.column, e.message))
            .collect();
        let new_errors: Vec<String> = post_results.iter()
            .filter(|e| e.severity == "error")
            .map(|e| format!("L{}:{}: {}", e.line, e.column, e.message))
            .filter(|msg| !baseline_errors.contains(msg))
            .take(10)
            .collect();
        if !new_errors.is_empty() {
            return Err(EditSessionError::SyntaxErrors {
                path: self.source_path.clone(),
                errors: new_errors,
            });
        }
        Ok(())
    }

    /// Commit the working content to disk atomically.
    /// Re-reads the disk hash first; if it differs from the session hash, aborts.
    pub fn commit(
        self,
        snapshot_svc: &mut SnapshotService,
    ) -> Result<CommitResult, EditSessionError> {
        // Re-read disk to check for external changes
        let current_snap = snapshot_svc.get_resolved(&self.resolved_path, &self.source_path)
            .map_err(|e| EditSessionError::Io(e))?;
        if current_snap.snapshot_hash != self.snapshot_hash {
            return Err(EditSessionError::StaleOnCommit {
                path: self.source_path.clone(),
                expected_hash: self.snapshot_hash.clone(),
                actual_hash: current_snap.snapshot_hash,
            });
        }

        // Auto-consolidate: if >40% of lines touched or >5 edits, use whole-file semantics.
        // The working_content already reflects all edits; this is just a note for callers.
        let final_content = &self.working_content;

        // Serialize with original file format (CRLF/LF preservation)
        let bytes = serialize_with_format(final_content, &self.file_format);

        // Ensure parent directory exists
        if let Some(parent) = self.resolved_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        // Atomic write
        snapshot::atomic_write(&self.resolved_path, &bytes)
            .map_err(|e| EditSessionError::Io(e))?;

        // Record the new snapshot
        let new_snap = snapshot_svc.record_write(
            &self.resolved_path,
            &self.source_path,
            final_content,
            Some(&self.snapshot_hash),
        );

        Ok(CommitResult {
            path: self.source_path,
            old_hash: self.snapshot_hash,
            new_hash: new_snap.snapshot_hash,
            new_content: new_snap.content,
            file_format: self.file_format,
        })
    }
}

fn truncate_preview(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        s.to_string()
    } else {
        let byte_end = s.char_indices().nth(max_chars).map(|(i, _)| i).unwrap_or(s.len());
        format!("{}...", &s[..byte_end])
    }
}

/// Rollback journal for multi-file batches.
/// Snapshots original file content before edits; restores on failure.
#[allow(dead_code)]
pub struct RollbackJournal {
    originals: Vec<(PathBuf, Vec<u8>, String, String)>,
}

#[allow(dead_code)]
impl RollbackJournal {
    pub fn new() -> Self {
        Self { originals: Vec::new() }
    }

    /// Record the original state of a file before editing.
    pub fn record(
        &mut self,
        resolved_path: PathBuf,
        source_path: &str,
        original_bytes: Vec<u8>,
        snapshot_hash: String,
    ) {
        self.originals.push((resolved_path, original_bytes, snapshot_hash, source_path.to_string()));
    }

    /// Restore all recorded files to their original state.
    /// Called when any commit in the batch fails.
    pub fn rollback(&self, snapshot_svc: &mut SnapshotService) -> Vec<String> {
        let mut errors = Vec::new();
        for (path, bytes, _hash, source_path) in self.originals.iter().rev() {
            if let Err(e) = snapshot::atomic_write(path, bytes) {
                errors.push(format!("rollback failed for {}: {}", source_path, e));
                continue;
            }
            let content = String::from_utf8_lossy(bytes);
            snapshot_svc.record_write(path, source_path, &content, None);
        }
        errors
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool { self.originals.is_empty() }
    #[allow(dead_code)]
    pub fn len(&self) -> usize { self.originals.len() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_test_file(dir: &tempfile::TempDir, name: &str, content: &str) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn exact_replace_succeeds_on_unique_match() {
        let dir = tempfile::tempdir().unwrap();
        let _file = setup_test_file(&dir, "test.ts", "const a = 1;\nconst b = 2;\n");

        let mut svc = SnapshotService::new();
        let mut session = EditSession::begin(&mut svc, dir.path(), "test.ts").unwrap();

        session.apply(EditOp {
            kind: EditOpKind::ExactReplace,
            preimage: "const a = 1;".to_string(),
            replacement: "const a = 42;".to_string(),
        }).unwrap();

        assert!(session.working_content().contains("const a = 42;"));
        assert!(session.working_content().contains("const b = 2;"));
    }

    #[test]
    fn exact_replace_fails_on_missing_preimage() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_file(&dir, "test.ts", "const a = 1;\n");

        let mut svc = SnapshotService::new();
        let mut session = EditSession::begin(&mut svc, dir.path(), "test.ts").unwrap();

        let result = session.apply(EditOp {
            kind: EditOpKind::ExactReplace,
            preimage: "const b = 2;".to_string(),
            replacement: "const b = 42;".to_string(),
        });
        assert!(matches!(result, Err(EditSessionError::PreimageNotFound { .. })));
    }

    #[test]
    fn exact_replace_fails_on_ambiguous_preimage() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_file(&dir, "test.ts", "const a = 1;\nconst a = 1;\n");

        let mut svc = SnapshotService::new();
        let mut session = EditSession::begin(&mut svc, dir.path(), "test.ts").unwrap();

        let result = session.apply(EditOp {
            kind: EditOpKind::ExactReplace,
            preimage: "const a = 1;".to_string(),
            replacement: "const a = 42;".to_string(),
        });
        assert!(matches!(result, Err(EditSessionError::AmbiguousPreimage { count: 2, .. })));
    }

    #[test]
    fn commit_fails_on_stale_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = setup_test_file(&dir, "test.ts", "const a = 1;\n");

        let mut svc = SnapshotService::new();
        let mut session = EditSession::begin(&mut svc, dir.path(), "test.ts").unwrap();

        session.apply(EditOp {
            kind: EditOpKind::ExactReplace,
            preimage: "const a = 1;".to_string(),
            replacement: "const a = 42;".to_string(),
        }).unwrap();

        // Modify file behind the session's back
        fs::write(&file, "const a = 999;\n").unwrap();
        svc.invalidate(&file);

        let result = session.commit(&mut svc);
        assert!(matches!(result, Err(EditSessionError::StaleOnCommit { .. })));
    }

    #[test]
    fn commit_succeeds_with_atomic_write() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_file(&dir, "test.ts", "const a = 1;\n");

        let mut svc = SnapshotService::new();
        let mut session = EditSession::begin(&mut svc, dir.path(), "test.ts").unwrap();

        session.apply(EditOp {
            kind: EditOpKind::ExactReplace,
            preimage: "const a = 1;".to_string(),
            replacement: "const a = 42;".to_string(),
        }).unwrap();

        let result = session.commit(&mut svc).unwrap();
        assert_ne!(result.old_hash, result.new_hash);
        assert!(result.new_content.contains("const a = 42;"));

        // Verify file on disk
        let on_disk = fs::read_to_string(dir.path().join("test.ts")).unwrap();
        assert!(on_disk.contains("const a = 42;"));
    }

    #[test]
    fn whole_file_replace() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_file(&dir, "test.ts", "old content\n");

        let mut svc = SnapshotService::new();
        let mut session = EditSession::begin(&mut svc, dir.path(), "test.ts").unwrap();

        session.apply(EditOp {
            kind: EditOpKind::WholeFile,
            preimage: "old content\n".to_string(),
            replacement: "new content\n".to_string(),
        }).unwrap();

        assert_eq!(session.working_content(), "new content\n");
    }

    #[test]
    fn byte_range_replace() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_file(&dir, "test.ts", "ABCDEFGH");

        let mut svc = SnapshotService::new();
        let mut session = EditSession::begin(&mut svc, dir.path(), "test.ts").unwrap();

        session.apply(EditOp {
            kind: EditOpKind::ByteRange { start: 2, end: 5 },
            preimage: "CDE".to_string(),
            replacement: "XYZ123".to_string(),
        }).unwrap();

        assert_eq!(session.working_content(), "ABXYZ123FGH");
    }

    #[test]
    fn conflict_markers_rejected() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_file(&dir, "test.ts", "clean\n");

        let mut svc = SnapshotService::new();
        let mut session = EditSession::begin(&mut svc, dir.path(), "test.ts").unwrap();

        session.apply(EditOp {
            kind: EditOpKind::WholeFile,
            preimage: "clean\n".to_string(),
            replacement: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n".to_string(),
        }).unwrap();

        let result = session.validate();
        assert!(matches!(result, Err(EditSessionError::SyntaxErrors { .. })));
    }

    #[test]
    fn rollback_journal_restores_files() {
        let dir = tempfile::tempdir().unwrap();
        let file_a = setup_test_file(&dir, "a.ts", "original A\n");
        let file_b = setup_test_file(&dir, "b.ts", "original B\n");

        let mut svc = SnapshotService::new();
        let mut journal = RollbackJournal::new();

        journal.record(file_a.clone(), "a.ts", b"original A\n".to_vec(), "hash_a".to_string());
        journal.record(file_b.clone(), "b.ts", b"original B\n".to_vec(), "hash_b".to_string());

        // Modify files
        fs::write(&file_a, "modified A\n").unwrap();
        fs::write(&file_b, "modified B\n").unwrap();

        // Rollback
        let errors = journal.rollback(&mut svc);
        assert!(errors.is_empty());

        assert_eq!(fs::read_to_string(&file_a).unwrap(), "original A\n");
        assert_eq!(fs::read_to_string(&file_b).unwrap(), "original B\n");
    }
}
