//! Path resolution and normalization utilities.

use std::path::PathBuf;

#[cfg(windows)]
pub(crate) fn strip_windows_prefix(path: &str) -> &str {
    path.strip_prefix("\\\\?\\").unwrap_or(path)
}

#[cfg(not(windows))]
pub(crate) fn strip_windows_prefix(path: &str) -> &str {
    path
}

/// Convert an absolute path to a relative path based on project root
/// Handles Windows \\?\ prefix and normalizes to forward slashes
pub(crate) fn to_relative_path(project_root: &std::path::Path, file_path: &str) -> String {
    let clean_path = strip_windows_prefix(file_path);
    let path = PathBuf::from(clean_path);

    // Build a prefix-free version of the project root (strips \\?\ on Windows)
    let clean_root = PathBuf::from(strip_windows_prefix(&project_root.to_string_lossy()));

    if path.is_absolute() {
        // Primary: compare prefix-stripped paths
        if let Ok(relative) = path.strip_prefix(&clean_root) {
            return relative.to_string_lossy().replace('\\', "/");
        }
        // Fallback: case-insensitive match on Windows
        #[cfg(windows)]
        {
            let path_lower = clean_path.to_lowercase();
            let root_lower = clean_root.to_string_lossy().to_lowercase();
            if path_lower.starts_with(&root_lower) {
                let remainder = &clean_path[root_lower.len()..];
                let trimmed = remainder.trim_start_matches(['/', '\\']);
                if !trimmed.is_empty() {
                    return trimmed.replace('\\', "/");
                }
            }
        }
    }
    clean_path.replace('\\', "/")
}

/// Resolve a path relative to project root (handles both absolute and relative paths)
/// Strips Windows \\?\ prefix for compatibility
pub(crate) fn resolve_project_path(project_root: &std::path::Path, file_path: &str) -> PathBuf {
    // Strip Windows extended-length prefix first
    let clean_path = strip_windows_prefix(file_path);
    let path = PathBuf::from(clean_path);
    let resolved = if path.is_absolute() {
        path
    } else {
        project_root.join(clean_path)
    };
    // Best-effort canonicalize to match indexer behavior on Windows.
    // Resolves case, symlinks, and separator mismatches.
    resolved.canonicalize().unwrap_or(resolved)
}

/// Resolve a directory path for `read.context` tree when the path is relative to a sub-workspace
/// (e.g. `src/foo` exists under `atls-studio/` but not at the monorepo root).
/// Returns `(resolved_path, effective_relative_path)` for display and tree building.
pub(crate) fn resolve_tree_directory_path(
    project_root: &std::path::Path,
    file_path: &str,
    workspace_rel_paths: &[String],
) -> (PathBuf, String) {
    let direct = resolve_project_path(project_root, file_path);
    if direct.is_dir() {
        return (direct, file_path.to_string());
    }
    let norm = file_path.trim_start_matches("./").replace('\\', "/");
    for rp in workspace_rel_paths {
        let rp = rp.replace('\\', "/");
        if rp.is_empty() || rp == "." {
            continue;
        }
        let combined = format!("{}/{}", rp.trim_end_matches('/'), norm);
        let alt = resolve_project_path(project_root, &combined);
        if alt.is_dir() {
            return (alt, combined);
        }
    }
    (direct, file_path.to_string())
}

/// Try to find a source file with fallback strategies when the direct path fails.
/// Searches the project directory for a file matching the given path's filename,
/// checking common project structures (src/, lib/, etc.).
///
/// When multiple candidates match (e.g. two files named `lib.rs` in different
/// sub-workspaces), prefers the candidate whose path shares the most trailing
/// segments with the query. Optionally checks `workspace_rel_paths` before
/// falling back to suffix/breadth-first search.
pub(crate) fn resolve_source_file_with_fallback(
    project_root: &std::path::Path,
    file_path: &str,
) -> Option<(PathBuf, String)> {
    resolve_source_file_with_workspace_hint(project_root, file_path, &[])
}

/// Like `resolve_source_file_with_fallback` but also checks sub-workspace
/// prefixes before resorting to suffix/BFS search.
pub(crate) fn resolve_source_file_with_workspace_hint(
    project_root: &std::path::Path,
    file_path: &str,
    workspace_rel_paths: &[String],
) -> Option<(PathBuf, String)> {
    let direct = resolve_project_path(project_root, file_path);
    if direct.exists() {
        return Some((direct, file_path.to_string()));
    }

    // Try each workspace prefix (e.g. "atls-studio/src-tauri/src/lib.rs")
    let norm = file_path.trim_start_matches("./").replace('\\', "/");
    for rp in workspace_rel_paths {
        let rp = rp.replace('\\', "/");
        if rp.is_empty() || rp == "." { continue; }
        let combined = format!("{}/{}", rp.trim_end_matches('/'), norm);
        let alt = resolve_project_path(project_root, &combined);
        if alt.exists() && alt.is_file() {
            return Some((alt, combined));
        }
    }

    let file_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|s| s.to_str())?;

    // Try stripping common prefixes the caller might have included
    let stripped_variants: Vec<&str> = vec![
        file_path.trim_start_matches("src/"),
        file_path.trim_start_matches("lib/"),
        file_path.trim_start_matches("./"),
    ];
    for variant in &stripped_variants {
        let p = project_root.join(variant);
        if p.exists() {
            return Some((p, variant.to_string()));
        }
    }

    // Try adding common prefixes
    let prefixed_variants = vec![
        format!("src/{}", file_path),
        format!("lib/{}", file_path),
        format!("packages/{}", file_path),
    ];
    for variant in &prefixed_variants {
        let p = project_root.join(&variant);
        if p.exists() {
            return Some((p, variant.clone()));
        }
    }

    // Try matching a path suffix: collect ALL candidates and pick the best one
    // (most trailing segments matching the query).
    let normalized_suffix = file_path.replace('\\', "/");
    let suffix_parts: Vec<&str> = normalized_suffix.split('/').collect();
    for skip in 1..suffix_parts.len() {
        let suffix: String = suffix_parts[skip..].join("/");
        if suffix.is_empty() { continue; }
        let candidates = find_all_files_by_suffix(project_root, &suffix, 0);
        if let Some(best) = pick_best_suffix_match(&candidates, &normalized_suffix, project_root) {
            let relative = best.strip_prefix(project_root)
                .ok()
                .and_then(|p| p.to_str())
                .map(|s| s.replace('\\', "/"))
                .unwrap_or_else(|| best.to_string_lossy().to_string());
            return Some((best, relative));
        }
    }

    // Walk the project looking for a file with the same name (breadth-first, max 8 levels).
    // Collects all matches and picks the one with the best suffix overlap.
    let all_by_name = find_all_in_dir(project_root, file_name, 0);
    if let Some(best) = pick_best_suffix_match(&all_by_name, &normalized_suffix, project_root) {
        let relative = best.strip_prefix(project_root)
            .ok()
            .and_then(|p| p.to_str())
            .map(|s| s.replace('\\', "/"))
            .unwrap_or_else(|| best.to_string_lossy().to_string());
        return Some((best, relative));
    }

    None
}

/// Count how many trailing path segments of `candidate` match the query suffix.
fn suffix_overlap_score(candidate_rel: &str, query: &str) -> usize {
    let c_parts: Vec<&str> = candidate_rel.split('/').rev().collect();
    let q_parts: Vec<&str> = query.split('/').rev().collect();
    c_parts.iter().zip(q_parts.iter())
        .take_while(|(c, q)| c.eq_ignore_ascii_case(q))
        .count()
}

/// From a list of candidate paths, pick the one whose relative path shares the
/// most trailing segments with the query. Tie-break: shortest total path (least nesting).
fn pick_best_suffix_match(
    candidates: &[PathBuf],
    query: &str,
    project_root: &std::path::Path,
) -> Option<PathBuf> {
    if candidates.is_empty() { return None; }
    if candidates.len() == 1 { return Some(candidates[0].clone()); }
    candidates.iter()
        .max_by_key(|c| {
            let rel = c.strip_prefix(project_root)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let score = suffix_overlap_score(&rel, query);
            let brevity = 1000usize.saturating_sub(rel.len());
            (score, brevity)
        })
        .cloned()
}

/// Collect ALL files under `dir` matching the given name (breadth-first, max 8 levels).
fn find_all_in_dir(dir: &std::path::Path, target: &str, depth: u32) -> Vec<PathBuf> {
    let mut results = Vec::new();
    if depth > 8 { return results; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return results,
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path.file_name().and_then(|s| s.to_str()) == Some(target) {
                results.push(path);
            }
        } else if path.is_dir() {
            let dir_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if !matches!(dir_name, "node_modules" | ".git" | "target" | "dist" | "build" | "__pycache__" | ".atls" | "obj" | "bin") {
                subdirs.push(path);
            }
        }
    }
    for subdir in subdirs {
        results.extend(find_all_in_dir(&subdir, target, depth + 1));
    }
    results
}

/// Recursively search for a file whose relative path ends with the given suffix.
#[allow(dead_code)]
pub(crate) fn find_file_by_suffix(dir: &std::path::Path, suffix: &str, depth: u32) -> Option<PathBuf> {
    find_all_files_by_suffix(dir, suffix, depth).into_iter().next()
}

/// Collect ALL files whose relative path ends with the given suffix (recursive, max 8 levels).
fn find_all_files_by_suffix(dir: &std::path::Path, suffix: &str, depth: u32) -> Vec<PathBuf> {
    let mut results = Vec::new();
    if depth > 8 { return results; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return results,
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let path_str = path.to_string_lossy().replace('\\', "/");
            if path_str.ends_with(suffix) {
                results.push(path);
            }
        } else if path.is_dir() {
            let dir_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if !matches!(dir_name, "node_modules" | ".git" | "target" | "dist" | "build" | "__pycache__" | ".atls" | "obj" | "bin") {
                subdirs.push(path);
            }
        }
    }
    for subdir in subdirs {
        results.extend(find_all_files_by_suffix(&subdir, suffix, depth + 1));
    }
    results
}

/// Manifest kinds detected by find_manifest_nearest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManifestKind {
    Node,
    Rust,
    Go,
    Python,
    Php,
    Ruby,
    CCpp,
    Java,
    CSharp,
    Swift,
}

/// Find the nearest manifest file by walking up from `path`.
/// Returns (ManifestKind, directory containing manifest).
/// Priority order: package.json, Cargo.toml, go.mod, pyproject.toml, requirements.txt,
/// pom.xml, build.gradle.kts, build.gradle, CMakeLists.txt, Makefile, Package.swift,
/// *.sln/*.csproj, composer.json, Gemfile.
pub(crate) fn find_manifest_nearest(
    path: &std::path::Path,
) -> Option<(ManifestKind, std::path::PathBuf)> {
    let mut current = if path.is_file() {
        path.parent()?.to_path_buf()
    } else if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };

    let manifest_checkers: &[(&str, ManifestKind)] = &[
        ("package.json", ManifestKind::Node),
        ("Cargo.toml", ManifestKind::Rust),
        ("go.mod", ManifestKind::Go),
        ("pyproject.toml", ManifestKind::Python),
        ("requirements.txt", ManifestKind::Python),
        ("pom.xml", ManifestKind::Java),
        ("build.gradle.kts", ManifestKind::Java),
        ("build.gradle", ManifestKind::Java),
        ("CMakeLists.txt", ManifestKind::CCpp),
        ("Makefile", ManifestKind::CCpp),
        ("Package.swift", ManifestKind::Swift),
        ("composer.json", ManifestKind::Php),
        ("Gemfile", ManifestKind::Ruby),
    ];

    loop {
        for (manifest_file, kind) in manifest_checkers {
            if current.join(manifest_file).exists() {
                return Some((*kind, current.clone()));
            }
        }
        // C#: check for *.sln or *.csproj in directory
        if let Ok(entries) = std::fs::read_dir(&current) {
            for e in entries.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.ends_with(".sln") || n.ends_with(".csproj") {
                    return Some((ManifestKind::CSharp, current.clone()));
                }
            }
        }
        if !current.pop() {
            break;
        }
    }
    None
}

/// Expected manifest file for a given command prefix (e.g. "cargo" -> "Cargo.toml").
/// Used for fail-fast validation before running commands.
#[allow(dead_code)]
pub(crate) fn expected_manifest_for_command(cmd: &str) -> Option<&'static str> {
    let lower = cmd.to_lowercase();
    if lower.starts_with("cargo ") || lower == "cargo" {
        Some("Cargo.toml")
    } else if lower.starts_with("go ") || lower == "go" {
        Some("go.mod")
    } else if lower.starts_with("npm ") || lower.starts_with("npx ") || lower == "npm" || lower == "npx" {
        Some("package.json")
    } else if lower.starts_with("python ") || lower.starts_with("uv ") || lower.starts_with("pytest ") || lower.starts_with("mypy ") || lower.starts_with("pyright ") {
        Some("pyproject.toml") // or requirements.txt - we accept either
    } else if lower.starts_with("dotnet ") {
        None // *.sln/*.csproj - harder to validate
    } else {
        None
    }
}

/// Normalize line endings to LF (\n) for consistent matching across platforms
pub(crate) fn normalize_line_endings(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

// ---------------------------------------------------------------------------
// File format detection and byte-level serialization
// ---------------------------------------------------------------------------

/// Newline mode detected from raw file bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NewlineMode {
    Lf,   // \n
    CrLf, // \r\n
    Cr,   // \r (legacy)
}

/// File format metadata for preserving byte-level write style.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileFormat {
    pub newline: NewlineMode,
    pub trailing_newline: bool,
}

impl Default for FileFormat {
    fn default() -> Self {
        Self {
            newline: NewlineMode::Lf,
            trailing_newline: true,
        }
    }
}

/// Detect newline mode from raw bytes (first occurrence wins).
/// Defaults to LF for empty or no-newline content.
pub(crate) fn detect_format(raw: &[u8]) -> FileFormat {
    let mut newline = NewlineMode::Lf;
    let mut trailing_newline = false;

    if raw.is_empty() {
        return FileFormat { newline, trailing_newline };
    }
    trailing_newline = raw.ends_with(b"\n") || raw.ends_with(b"\r");

    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'\r' {
            if i + 1 < raw.len() && raw[i + 1] == b'\n' {
                newline = NewlineMode::CrLf;
            } else {
                newline = NewlineMode::Cr;
            }
            break;
        }
        if raw[i] == b'\n' {
            newline = NewlineMode::Lf;
            break;
        }
        i += 1;
    }

    FileFormat {
        newline,
        trailing_newline,
    }
}

/// Read a file and return (normalized content, format). Use when you need to
/// preserve format on write (e.g. undo, edit flush).
pub(crate) fn read_file_with_format(path: &std::path::Path) -> Result<(String, FileFormat), String> {
    let raw = std::fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let format = detect_format(&raw);
    let s = String::from_utf8(raw).map_err(|e| format!("File {} is not valid UTF-8: {}", path.display(), e))?;
    let normalized = normalize_line_endings(&s);
    Ok((normalized, format))
}

/// Serialize normalized content (LF-only) back to bytes using the given format.
/// The normalized string's structure (incl. trailing `\n`) is preserved; only
/// line separators are converted to the target newline mode.
pub(crate) fn serialize_with_format(normalized: &str, fmt: &FileFormat) -> Vec<u8> {
    let nl: &[u8] = match fmt.newline {
        NewlineMode::Lf => b"\n",
        NewlineMode::CrLf => b"\r\n",
        NewlineMode::Cr => b"\r",
    };

    let mut out = Vec::new();
    let lines: Vec<&str> = normalized.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        out.extend_from_slice(line.as_bytes());
        if i < lines.len() - 1 {
            out.extend_from_slice(nl);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_manifest_nearest_finds_package_json_in_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        let sub = root.join("src").join("utils");
        std::fs::create_dir_all(&sub).unwrap();
        let found = find_manifest_nearest(&sub);
        assert!(found.is_some(), "should find package.json walking up");
        let (kind, path) = found.unwrap();
        assert_eq!(kind, ManifestKind::Node);
        assert_eq!(path, root);
    }

    #[test]
    fn find_manifest_nearest_finds_cargo_toml() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        let found = find_manifest_nearest(&root.join("src").join("lib.rs"));
        assert!(found.is_some());
        let (kind, path) = found.unwrap();
        assert_eq!(kind, ManifestKind::Rust);
        assert_eq!(path, root);
    }

    #[test]
    fn find_manifest_nearest_returns_none_when_no_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("empty").join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        let found = find_manifest_nearest(&sub);
        assert!(found.is_none());
    }

    #[test]
    fn detect_format_lf() {
        let fmt = detect_format(b"line1\nline2\n");
        assert_eq!(fmt.newline, NewlineMode::Lf);
        assert!(fmt.trailing_newline);
    }

    #[test]
    fn detect_format_crlf() {
        let fmt = detect_format(b"line1\r\nline2\r\n");
        assert_eq!(fmt.newline, NewlineMode::CrLf);
        assert!(fmt.trailing_newline);
    }

    #[test]
    fn serialize_with_format_preserves_crlf() {
        let fmt = FileFormat {
            newline: NewlineMode::CrLf,
            trailing_newline: true,
        };
        let out = serialize_with_format("a\nb\n", &fmt);
        assert_eq!(out, b"a\r\nb\r\n");
    }

    #[test]
    fn serialize_with_format_no_trailing() {
        let fmt = FileFormat {
            newline: NewlineMode::Lf,
            trailing_newline: false,
        };
        let out = serialize_with_format("a\nb", &fmt);
        assert_eq!(out, b"a\nb");
    }

    #[test]
    fn read_then_serialize_roundtrips_crlf_for_edited_normalized_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sample.ts");
        std::fs::write(&p, b"line1\r\nline2\r\n").unwrap();
        let (normalized, fmt) = read_file_with_format(&p).unwrap();
        assert_eq!(normalized, "line1\nline2\n");
        assert_eq!(fmt.newline, NewlineMode::CrLf);
        let edited = normalized.replace("line2", "edited");
        let out = serialize_with_format(&edited, &fmt);
        assert_eq!(out, b"line1\r\nedited\r\n");
    }

    #[test]
    fn atomic_write_returns_err_for_unwritable_path() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("missing_parent_chain").join("f.txt");
        let res = crate::snapshot::atomic_write(&bad, b"z");
        assert!(res.is_err(), "expected atomic_write to fail: {:?}", res);
    }

    #[test]
    fn find_manifest_nearest_monorepo_prefers_nearest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        let pkg = root.join("packages").join("foo");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), "{}").unwrap();
        let found = find_manifest_nearest(&pkg);
        assert!(found.is_some());
        let (_kind, path) = found.unwrap();
        assert_eq!(path, pkg, "should find package in packages/foo, not root");
    }
}
