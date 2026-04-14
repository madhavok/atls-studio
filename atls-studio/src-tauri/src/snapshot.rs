//! Canonical file snapshot service — single source of truth for file identity.
//!
//! Every file read or write produces a `FileSnapshot` with a canonical `snapshot_hash`
//! computed from normalized (LF) content. All read/change handlers use this service
//! instead of calling `content_hash()` directly, eliminating duplicate hash derivation.
//!
//! The `SnapshotService` also maintains a monotonic forward map (old_hash -> new_hash)
//! for lineage, review, and stale-read diagnosis. Mutation authority still comes from
//! a fresh canonical full read; forwarded hashes are not valid write authority.

use std::collections::HashMap;
use std::path::Path;

use crate::content_hash;
use crate::path_utils::{detect_format, read_file_with_format, resolve_project_path, FileFormat};

fn normalize_cache_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// Immutable snapshot of a file at a point in time.
#[derive(Debug, Clone)]
pub struct FileSnapshot {
    pub path: String,
    pub snapshot_hash: String,
    pub content: String,
    pub file_format: FileFormat,
    #[allow(dead_code)]
    pub modified_ns: u128,
    #[allow(dead_code)]
    pub size: u64,
}

/// Canonical file authority used across read/edit flows.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SnapshotAuthority {
    pub path: String,
    pub snapshot_hash: String,
}

impl FileSnapshot {
    #[allow(dead_code)]
    pub fn authority(&self) -> SnapshotAuthority {
        SnapshotAuthority {
            path: self.path.clone(),
            snapshot_hash: self.snapshot_hash.clone(),
        }
    }
}

/// Error returned when the caller's expected hash does not match the current snapshot.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct StaleHashError {
    pub path: String,
    pub expected_hash: String,
    pub actual_hash: String,
}

impl std::fmt::Display for StaleHashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "stale_hash for {}: expected {}, actual {}. Re-read the file and retry.",
            self.path, self.expected_hash, self.actual_hash
        )
    }
}

/// Cached entry: mtime+size used for fast staleness detection without re-reading disk.
#[derive(Debug, Clone)]
struct CacheEntry {
    snapshot_hash: String,
    content: String,
    file_format: FileFormat,
    modified_ns: u128,
    size: u64,
}

/// Centralized service for file snapshot identity.
///
/// Absorbs the former `FileCache` (mtime+size skip) and the scattered `content_hash()`
/// calls. All handlers go through this service to read files, check staleness, and
/// record writes.
pub struct SnapshotService {
    cache: HashMap<String, CacheEntry>,
    forward_map: HashMap<String, String>,
}

impl Default for SnapshotService {
    fn default() -> Self {
        Self {
            cache: HashMap::with_capacity(256),
            forward_map: HashMap::new(),
        }
    }
}

impl SnapshotService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the cached `FileFormat` for a path without reading disk.
    /// Used by the write path to avoid a full file re-read just for CRLF detection.
    pub fn get_cached_format(&self, resolved_path: &Path) -> Option<FileFormat> {
        let key = normalize_cache_key(&resolved_path.to_string_lossy());
        self.cache.get(&key).map(|entry| entry.file_format)
    }

    /// Read a file from disk (or use cache if mtime+size match) and return its snapshot.
    /// The `project_root` is used to resolve relative paths. The `source_path` is the
    /// caller-facing path (possibly relative).
    pub fn get(
        &mut self,
        project_root: &Path,
        source_path: &str,
    ) -> Result<FileSnapshot, String> {
        let resolved = resolve_project_path(project_root, source_path);
        self.get_resolved(&resolved, source_path)
    }

    /// Read a file from an already-resolved absolute path.
    pub fn get_resolved(
        &mut self,
        resolved_path: &Path,
        source_path: &str,
    ) -> Result<FileSnapshot, String> {
        let key = normalize_cache_key(&resolved_path.to_string_lossy());

        let meta = std::fs::metadata(resolved_path)
            .map_err(|e| format!("Failed to stat {}: {}", source_path, e))?;
        let modified_ns = metadata_modified_ns(&meta);
        let size = meta.len();

        if let Some(cached) = self.cache.get(&key) {
            if cached.modified_ns == modified_ns && cached.size == size {
                return Ok(FileSnapshot {
                    path: source_path.to_string(),
                    snapshot_hash: cached.snapshot_hash.clone(),
                    content: cached.content.clone(),
                    file_format: cached.file_format,
                    modified_ns,
                    size,
                });
            }
        }

        let (content, file_format) = read_file_with_format(resolved_path)
            .map_err(|e| format!("Failed to read {}: {}", source_path, e))?;

        let snapshot_hash = content_hash(&content);

        self.cache.insert(key, CacheEntry { snapshot_hash: snapshot_hash.clone(), content: content.clone(), file_format, modified_ns, size });

        Ok(FileSnapshot {
            path: source_path.to_string(),
            snapshot_hash,
            content,
            file_format,
            modified_ns,
            size,
        })
    }

    /// Read a file and verify that the expected hash matches the current content.
    /// Returns the snapshot on match, or `StaleHashError` on mismatch.
    #[allow(dead_code)]
    pub fn get_if_fresh(
        &mut self,
        project_root: &Path,
        source_path: &str,
        expected_hash: &str,
    ) -> Result<FileSnapshot, StaleHashError> {
        let snap = self.get(project_root, source_path).map_err(|_| StaleHashError {
            path: source_path.to_string(),
            expected_hash: expected_hash.to_string(),
            actual_hash: String::new(),
        })?;

        let expected_clean = canonicalize_hash(expected_hash);
        if snap.snapshot_hash == expected_clean {
            return Ok(snap);
        }

        // Check forward map: maybe expected_hash was forwarded to the current hash
        if let Some(forwarded) = self.resolve_forward(&expected_clean) {
            if forwarded == snap.snapshot_hash {
                return Ok(snap);
            }
        }

        Err(StaleHashError {
            path: source_path.to_string(),
            expected_hash: expected_clean,
            actual_hash: snap.snapshot_hash,
        })
    }

    /// Read a file from an already-resolved path and verify freshness.
    #[allow(dead_code)]
    pub fn get_resolved_if_fresh(
        &mut self,
        resolved_path: &Path,
        source_path: &str,
        expected_hash: &str,
    ) -> Result<FileSnapshot, StaleHashError> {
        let snap = self.get_resolved(resolved_path, source_path).map_err(|_| StaleHashError {
            path: source_path.to_string(),
            expected_hash: expected_hash.to_string(),
            actual_hash: String::new(),
        })?;

        let expected_clean = canonicalize_hash(expected_hash);
        if snap.snapshot_hash == expected_clean {
            return Ok(snap);
        }

        if let Some(forwarded) = self.resolve_forward(&expected_clean) {
            if forwarded == snap.snapshot_hash {
                return Ok(snap);
            }
        }

        Err(StaleHashError {
            path: source_path.to_string(),
            expected_hash: expected_clean,
            actual_hash: snap.snapshot_hash,
        })
    }

    /// Record that a file was written with `new_content`. Updates cache and forward map.
    /// `old_snapshot_hash` (if provided) is forwarded to the new hash.
    pub fn record_write(
        &mut self,
        resolved_path: &Path,
        source_path: &str,
        new_content: &str,
        old_snapshot_hash: Option<&str>,
    ) -> FileSnapshot {
        let snapshot_hash = content_hash(new_content);
        let key = normalize_cache_key(&resolved_path.to_string_lossy());

        let (modified_ns, size) = std::fs::metadata(resolved_path)
            .map(|m| (metadata_modified_ns(&m), m.len()))
            .unwrap_or((0, 0));

        self.cache.insert(key, CacheEntry { snapshot_hash: snapshot_hash.clone(), content: new_content.to_string(), file_format: detect_format(new_content.as_bytes()), modified_ns, size });

        if let Some(old_hash) = old_snapshot_hash {
            let old_clean = canonicalize_hash(old_hash);
            if old_clean != snapshot_hash {
                self.insert_forward(old_clean, snapshot_hash.clone());
            }
        }

        let file_format = detect_format(new_content.as_bytes());

        FileSnapshot {
            path: source_path.to_string(),
            snapshot_hash,
            content: new_content.to_string(),
            file_format,
            modified_ns,
            size,
        }
    }

    /// Compute snapshot for in-memory content without touching disk.
    /// Useful for draft/undo flows where content is already in memory.
    pub fn snapshot_from_content(
        &mut self,
        source_path: &str,
        content: &str,
        old_snapshot_hash: Option<&str>,
    ) -> FileSnapshot {
        let snapshot_hash = content_hash(content);

        if let Some(old_hash) = old_snapshot_hash {
            let old_clean = canonicalize_hash(old_hash);
            if old_clean != snapshot_hash {
                self.insert_forward(old_clean, snapshot_hash.clone());
            }
        }

        let file_format = detect_format(content.as_bytes());

        FileSnapshot {
            path: source_path.to_string(),
            snapshot_hash,
            content: content.to_string(),
            file_format,
            modified_ns: 0,
            size: 0,
        }
    }

    /// Follow the forward map chain. Returns the final forwarded hash if any.
    pub fn resolve_forward<'a>(&'a self, hash: &'a str) -> Option<&'a str> {
        let mut current = hash;
        let mut depth = 0;
        while let Some(next) = self.forward_map.get(current) {
            current = next.as_str();
            depth += 1;
            if depth > 50 {
                break;
            }
        }
        if current != hash { Some(current) } else { None }
    }

    /// Check if a hash is stale for a given path (does NOT read from disk; uses cache only).
    /// Follows the forward map so that old hashes that were forwarded to the current
    /// snapshot hash are not considered stale.
    #[allow(dead_code)]
    pub fn is_stale_cached(&self, resolved_path: &Path, hash: &str) -> Option<bool> {
        let key = normalize_cache_key(&resolved_path.to_string_lossy());
        let clean = canonicalize_hash(hash);
        self.cache.get(&key).map(|entry| {
            if entry.snapshot_hash == clean {
                return false;
            }
            // Check if the provided hash forwards to the current snapshot hash
            if let Some(forwarded) = self.resolve_forward(&clean) {
                return forwarded != entry.snapshot_hash;
            }
            true
        })
    }

    /// Invalidate cache for a path (e.g. after external modification detected by watcher).
    pub fn invalidate(&mut self, resolved_path: &Path) {
        let key = normalize_cache_key(&resolved_path.to_string_lossy());
        self.cache.remove(&key);
    }

    /// Clear all cache entries.
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.cache.clear();
        self.forward_map.clear();
    }

    fn insert_forward(&mut self, old_hash: String, new_hash: String) {
        // Collapse transitive chains: anything pointing to old_hash now points to new_hash
        let stale_keys: Vec<String> = self.forward_map.iter()
            .filter(|(_, v)| **v == old_hash)
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale_keys {
            self.forward_map.insert(k, new_hash.clone());
        }
        self.forward_map.insert(old_hash, new_hash);
    }
}

/// Atomic file write: write to temp file, then rename over the target.
/// On Unix, `rename` is atomic within the same filesystem.
/// On Windows, `rename` is not guaranteed atomic but is crash-safe for
/// single-file operations (either old or new content, never partial).
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("atls-tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("atomic_write tmp: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("atomic_write rename: {}", e)
    })
}

/// Strip `h:` prefix and any modifier suffixes (`:sig`, `:15-20`, etc.) to get bare hash.
pub fn canonicalize_hash(value: &str) -> String {
    let stripped = value.strip_prefix("h:").unwrap_or(value);
    stripped.split(':').next().unwrap_or(stripped).to_string()
}

fn metadata_modified_ns(metadata: &std::fs::Metadata) -> u128 {
    metadata.modified().ok()
        .and_then(|mtime| mtime.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

/// Thread-safe wrapper for use as Tauri managed state.
pub struct SnapshotServiceState {
    pub service: tokio::sync::Mutex<SnapshotService>,
}

impl Default for SnapshotServiceState {
    fn default() -> Self {
        Self {
            service: tokio::sync::Mutex::new(SnapshotService::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn get_returns_correct_hash() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("test.txt");
        fs::write(&file, "hello world\n").unwrap();

        let mut svc = SnapshotService::new();
        let snap = svc.get_resolved(&file, "test.txt").unwrap();
        assert!(!snap.snapshot_hash.is_empty());
        assert_eq!(snap.content, "hello world\n");
    }

    #[test]
    fn file_snapshot_exposes_canonical_authority() {
        let snapshot = FileSnapshot {
            path: "src/demo.ts".to_string(),
            snapshot_hash: "deadbeefcafebabe".to_string(),
            content: "const demo = 1;\n".to_string(),
            file_format: FileFormat::default(),
            modified_ns: 0,
            size: 0,
        };

        assert_eq!(snapshot.authority(), SnapshotAuthority {
            path: "src/demo.ts".to_string(),
            snapshot_hash: "deadbeefcafebabe".to_string(),
        });
    }

    #[test]
    fn cache_hit_on_unchanged_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("test.txt");
        fs::write(&file, "hello\n").unwrap();

        let mut svc = SnapshotService::new();
        let snap1 = svc.get_resolved(&file, "test.txt").unwrap();
        let snap2 = svc.get_resolved(&file, "test.txt").unwrap();
        assert_eq!(snap1.snapshot_hash, snap2.snapshot_hash);
        // Cache hit returns canonical content for edit sessions
        assert_eq!(snap2.content, snap1.content);
        assert!(!snap2.content.is_empty());
    }

    #[test]
    fn get_if_fresh_returns_stale_on_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("test.txt");
        fs::write(&file, "original\n").unwrap();

        let mut svc = SnapshotService::new();
        let result = svc.get_resolved_if_fresh(&file, "test.txt", "badhash0badhash0");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.expected_hash, "badhash0badhash0");
    }

    #[test]
    fn record_write_updates_forward_map() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        fs::write(&file, "v1\n").unwrap();

        let mut svc = SnapshotService::new();
        let snap1 = svc.get_resolved(&file, "test.txt").unwrap();
        let old_hash = snap1.snapshot_hash.clone();

        fs::write(&file, "v2\n").unwrap();
        let snap2 = svc.record_write(&file, "test.txt", "v2\n", Some(&old_hash));
        assert_ne!(old_hash, snap2.snapshot_hash);

        let forwarded = svc.resolve_forward(&old_hash);
        assert_eq!(forwarded, Some(snap2.snapshot_hash.as_str()));
    }

    #[test]
    fn canonicalize_hash_strips_prefix_and_modifiers() {
        assert_eq!(canonicalize_hash("h:abc123:sig"), "abc123");
        assert_eq!(canonicalize_hash("h:abc123"), "abc123");
        assert_eq!(canonicalize_hash("abc123"), "abc123");
        assert_eq!(canonicalize_hash("h:abc123:15-20"), "abc123");
    }

    #[test]
    fn forward_map_collapses_transitively() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        fs::write(&file, "v1\n").unwrap();

        let mut svc = SnapshotService::new();
        let snap1 = svc.get_resolved(&file, "test.txt").unwrap();
        let h1 = snap1.snapshot_hash.clone();

        fs::write(&file, "v2\n").unwrap();
        let snap2 = svc.record_write(&file, "test.txt", "v2\n", Some(&h1));
        let h2 = snap2.snapshot_hash.clone();

        fs::write(&file, "v3\n").unwrap();
        let snap3 = svc.record_write(&file, "test.txt", "v3\n", Some(&h2));
        let h3 = snap3.snapshot_hash.clone();

        // h1 should now forward directly to h3 (collapsed)
        assert_eq!(svc.resolve_forward(&h1), Some(h3.as_str()));
        assert_eq!(svc.resolve_forward(&h2), Some(h3.as_str()));
    }

    // ── get_cached_format tests ──

    #[test]
    fn get_cached_format_returns_none_for_unknown_file() {
        let svc = SnapshotService::new();
        let result = svc.get_cached_format(std::path::Path::new("/nonexistent/file.txt"));
        assert!(result.is_none());
    }

    #[test]
    fn get_cached_format_returns_format_after_read() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        fs::write(&file, b"line1\r\nline2\r\n").unwrap();

        let mut svc = SnapshotService::new();
        svc.get_resolved(&file, "test.txt").unwrap();

        let fmt = svc.get_cached_format(&file);
        assert!(fmt.is_some());
        let fmt = fmt.unwrap();
        assert_eq!(fmt.newline, crate::path_utils::NewlineMode::CrLf);
        assert!(fmt.trailing_newline);
    }

    #[test]
    fn get_cached_format_returns_format_after_record_write() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        fs::write(&file, b"original\n").unwrap();

        let mut svc = SnapshotService::new();
        svc.record_write(&file, "test.txt", "new content\n", None);

        let fmt = svc.get_cached_format(&file);
        assert!(fmt.is_some());
        assert_eq!(fmt.unwrap().newline, crate::path_utils::NewlineMode::Lf);
    }
}
