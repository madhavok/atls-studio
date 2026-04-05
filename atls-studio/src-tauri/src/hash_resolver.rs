//! Hash-Relational Resolver — universal `h:` reference middleware.
//!
//! Any tool parameter accepting a string can use `h:XXXX` instead of a literal value.
//! The resolver pre-processes params JSON, detects `h:` references, and resolves them
//! from the in-memory registry (populated by context reads, edits, buffers).
//!
//! Syntax:
//!   h:abc12345             — auto-resolve based on field name
//!   h:abc12345:source      — resolve to the entry's source file path
//!   h:abc12345:content     — resolve to full content
//!   h:abc12345:15-22       — extract lines 15–22 from content
//!   h:abc12345:15-22,40-55 — extract multiple line ranges
//!   h:abc12345:sig         — signatures only, bodies collapsed
//!   h:abc12345:15-30:dedent — line range with common indent stripped
//!   h:abc12345:fn(name)    — symbol anchor (edit-stable)
//!   h:abc12345..h:def67890 — diff between two hash states

use std::collections::HashMap;
use std::path::Path;
use tokio::sync::Mutex;

use crate::error::AtlsError;
use crate::path_utils::{normalize_line_endings, read_file_with_format, resolve_project_path, FileFormat};
use crate::{content_hash, LineEdit};

fn normalize_source_key(source: &str) -> String {
    source.replace('\\', "/").to_lowercase()
}

fn maybe_format_go_after_write(resolved_path: &Path) -> Option<String> {
    let path_str = resolved_path.to_string_lossy().to_string();
    if !path_str.ends_with(".go") {
        return None;
    }

    let working_dir = resolved_path.parent()?;
    let (shell, shell_arg) = crate::resolve_shell();
    let cmd_str = if cfg!(windows) {
        format!(
            "$ErrorActionPreference='SilentlyContinue'; goimports -w \"{}\"; if ($LASTEXITCODE -ne 0) {{ gofmt -w \"{}\" }}",
            path_str, path_str
        )
    } else {
        format!("goimports -w \"{}\" 2>/dev/null || gofmt -w \"{}\"", path_str, path_str)
    };

    let output = std::process::Command::new(shell)
        .arg(shell_arg)
        .arg(cmd_str)
        .current_dir(working_dir)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    std::fs::read_to_string(resolved_path)
        .ok()
        .map(|content| normalize_line_endings(&content))
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Content-shaping operation applied after line extraction.
#[derive(Debug, Clone, PartialEq)]
pub enum ShapeOp {
    /// Signatures only, bodies collapsed to `{ ... }`
    Sig,
    /// Preserve top-level bodies, collapse nested blocks >1 level
    Fold,
    /// Strip common leading indentation
    Dedent,
    /// Strip comment-only lines
    NoComment,
    /// First N lines
    Head(u32),
    /// Last N lines
    Tail(u32),
    /// Lines matching pattern (+1 line context)
    Grep(String),
    /// Omit line ranges from view, insert placeholders
    Exclude(Vec<(u32, Option<u32>)>),
    /// Import/use statements only
    Imports,
    /// Exported/public symbols only
    Exports,
    /// Visual annotation passthrough for frontend highlight rendering
    Highlight(Vec<(u32, Option<u32>)>),
    /// Extract code related to a named concept/topic (semantic grep)
    Concept(String),
    /// Extract code matching a structural pattern (e.g. "error-handling", "state-mutation")
    Pattern(String),
    /// Conditional filter: include lines/blocks matching a boolean expression
    If(String),
    /// Snap line ranges to enclosing function/block boundaries
    Snap,
    /// All referenced identifiers (for dependency analysis)
    Refs,
}

/// Whether a shape can be safely re-applied to new content (deterministic, content-only transform).
/// Replay-safe shapes: sig, fold, dedent, nocomment, imports, exports, head, tail, grep, exclude, snap.
#[allow(dead_code)] // Used by frontend for auto-refresh vs mark-stale (future)
pub fn is_replay_safe(shape: &ShapeOp) -> bool {
    matches!(
        shape,
        ShapeOp::Sig
            | ShapeOp::Fold
            | ShapeOp::Dedent
            | ShapeOp::NoComment
            | ShapeOp::Head(_)
            | ShapeOp::Tail(_)
            | ShapeOp::Grep(_)
            | ShapeOp::Exclude(_)
            | ShapeOp::Imports
            | ShapeOp::Exports
            | ShapeOp::Snap
    )
}

/// Parsed `h:XXXX` reference with optional modifier.
#[derive(Debug, Clone)]
pub struct HashRef {
    pub hash: String,
    pub modifier: HashModifier,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ResolvedAuthorityRef {
    pub path: Option<String>,
    pub snapshot_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
}

/// Diff between two hash states: `h:OLD..h:NEW`
#[derive(Debug, Clone, PartialEq)]
pub struct DiffRef {
    pub old_hash: String,
    pub new_hash: String,
}

#[derive(Debug, Clone)]
pub enum HashModifier {
    /// Resolve based on the JSON field name context.
    Auto,
    /// Explicitly resolve to the source file path.
    Source,
    /// Explicitly resolve to full content.
    Content,
    /// Extract specific line ranges from content (1-indexed, inclusive).
    Lines(Vec<(u32, Option<u32>)>),
    /// Apply a shape operation to full content.
    Shape(ShapeOp),
    /// Extract line ranges, then apply a shape operation.
    ShapedLines {
        ranges: Vec<(u32, Option<u32>)>,
        shape: ShapeOp,
    },
    /// Symbol anchor — resolve to a named symbol's line range (edit-stable).
    SymbolAnchor {
        kind: Option<String>,
        name: String,
        shape: Option<ShapeOp>,
    },
    /// Resolve to the token count as a string.
    Tokens,
    /// Resolve to JSON metadata: `{ source, tokens, lines, lang, symbols }`.
    Meta,
    /// Resolve to detected language string.
    Lang,
    /// Dependency analysis for a symbol anchor: needed imports, co-move candidates, scope.
    SymbolDeps {
        kind: Option<String>,
        name: String,
    },
}

/// A single entry in the hash registry.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct HashEntry {
    /// Source file path (if this hash came from a file read / edit).
    pub source: Option<String>,
    /// Full content at the time of hashing.
    pub content: String,
    /// Estimated token count.
    pub tokens: usize,
    /// Detected language (from file extension).
    pub lang: Option<String>,
    /// Cached line count.
    pub line_count: usize,
    /// Number of top-level symbols (if known from indexer).
    pub symbol_count: Option<usize>,
}

/// Canonical short hash length. 6 hex chars = ~16M unique refs per session.
/// Backend uses adaptive 6-8 on collision; this is the default minimum.
pub const SHORT_HASH_LEN: usize = 6;

/// Session-scoped registry mapping content hashes to their entries.
/// Populated by context reads, edit results, and buffer operations.
///
/// Hash forwarding: when a file is re-read or re-edited, all previous hashes
/// for that source path forward to the latest version. `get()` follows the
/// forward chain transparently. Diff resolution bypasses forwarding via `get_original()`.
#[allow(dead_code)]
pub struct HashRegistry {
    entries: HashMap<String, HashEntry>,
    /// Maps old_hash -> current_hash for file-sourced entries.
    /// Transitively collapsed: if A->B and B->C, we update A->C.
    forward_map: HashMap<String, String>,
    /// Maps source_path -> list of full hashes registered for that path (oldest first).
    source_index: HashMap<String, Vec<String>>,
}

impl Default for HashRegistry {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            forward_map: HashMap::new(),
            source_index: HashMap::new(),
        }
    }
}

impl HashRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a hash entry. Sets up hash forwarding for file-sourced entries:
    /// all previous hashes for the same source path forward to this new hash.
    /// Returns the canonical short ref (min 6 chars, adaptive on collision).
    pub fn register(&mut self, hash: String, entry: HashEntry) -> String {
        // Normalize the source path: strip context-store key prefixes, normalize
        // separators to forward slashes. This prevents registry mismatches when
        // the same file is registered with slightly different path forms across
        // sessions or read modes.
        let entry = if let Some(ref source) = entry.source {
            let cleaned = source
                .trim_start_matches("context:")
                .trim_start_matches("raw:")
                .trim_start_matches("smart:")
                .replace('\\', "/");
            if cleaned != *source {
                HashEntry { source: Some(cleaned), ..entry }
            } else {
                entry
            }
        } else {
            entry
        };

        // Set up forwarding: if this entry has a source path, forward all
        // previous hashes for that path to this new hash.
        if let Some(ref source) = entry.source {
            let source_key = normalize_source_key(source);
            let prev_hashes = self.source_index.entry(source_key.clone()).or_default();
            for old_hash in prev_hashes.iter() {
                if old_hash != &hash {
                    self.forward_map.insert(old_hash.clone(), hash.clone());
                    // Also forward old short hashes
                    if old_hash.len() > SHORT_HASH_LEN {
                        let old_short = old_hash[..SHORT_HASH_LEN].to_string();
                        self.forward_map.insert(old_short, hash.clone());
                    }
                }
            }
            // Transitively collapse: anything pointing to an old hash should now point to the new one
            let stale_targets: Vec<String> = prev_hashes.clone();
            for (_, target) in self.forward_map.iter_mut() {
                if stale_targets.contains(target) {
                    *target = hash.clone();
                }
            }
            if !prev_hashes.contains(&hash) {
                prev_hashes.push(hash.clone());
            }
        }

        self.entries.insert(hash.clone(), entry.clone());
        if hash.len() >= SHORT_HASH_LEN {
            let short = self.shortest_unique_prefix(&hash);
            if !self.entries.contains_key(&short) {
                self.entries.insert(short.clone(), entry);
            }
            return short;
        }
        hash
    }

    /// Find the shortest unique prefix for `hash` (6..=8 chars).
    fn shortest_unique_prefix(&self, hash: &str) -> String {
        let max = 8.min(hash.len());
        for len in SHORT_HASH_LEN..=max {
            let prefix = &hash[..len];
            match self.entries.get(prefix) {
                None => return prefix.to_string(),
                Some(existing) if existing.content == self.entries.get(hash).map_or("", |e| &e.content) => {
                    return prefix.to_string();
                }
                _ => continue,
            }
        }
        hash[..max].to_string()
    }

    /// Look up by full hash, short hash, or prefix. Follows hash forwarding
    /// transparently: if the ref was forwarded, returns the latest version.
    pub fn get(&self, hash_ref: &str) -> Option<&HashEntry> {
        // Follow forward chain
        let effective_ref = self.resolve_forward(hash_ref);
        let ref_str = effective_ref.as_deref().unwrap_or(hash_ref);

        if let Some(entry) = self.entries.get(ref_str) {
            return Some(entry);
        }
        // Prefix match — prefer longest key (most specific hash). HashMap iteration order
        // is arbitrary; without this, short-prefix lookups can hit the wrong entry and
        // surface false "stale" errors in peek/read_lines.
        let mut best: Option<(&String, &HashEntry)> = None;
        for (k, v) in &self.entries {
            let matched = k.starts_with(ref_str) || ref_str.starts_with(k.as_str());
            if !matched {
                continue;
            }
            if best.map_or(true, |(bk, _)| k.len() > bk.len()) {
                best = Some((k, v));
            }
        }
        best.map(|(_, v)| v)
    }

    /// Get the ORIGINAL content for a hash, bypassing forwarding.
    /// Used by diff resolution (h:OLD..h:NEW) to access historical versions.
    pub fn get_original(&self, hash_ref: &str) -> Option<&HashEntry> {
        if let Some(entry) = self.entries.get(hash_ref) {
            return Some(entry);
        }
        let mut best: Option<(&String, &HashEntry)> = None;
        for (k, v) in &self.entries {
            let matched = k.starts_with(hash_ref) || hash_ref.starts_with(k.as_str());
            if !matched {
                continue;
            }
            if best.map_or(true, |(bk, _)| k.len() > bk.len()) {
                best = Some((k, v));
            }
        }
        best.map(|(_, v)| v)
    }

    /// Follow the forward chain to get the current target hash, if forwarded.
    fn resolve_forward(&self, hash_ref: &str) -> Option<String> {
        self.forward_map.get(hash_ref).cloned()
    }

    /// Remove forwarding for a hash (rollback). Returns the hash it was forwarding to.
    pub fn remove_forward(&mut self, hash_ref: &str) -> Option<String> {
        self.forward_map.remove(hash_ref)
    }

    /// Check if a hash is forwarded to another.
    pub fn is_forwarded(&self, hash_ref: &str) -> bool {
        self.forward_map.contains_key(hash_ref)
    }

    /// Resolve a hash to its full content string, if present.
    /// Follows hash forwarding (returns latest version for that source).
    pub fn resolve_content(&self, hash_ref: &str) -> Option<String> {
        self.get(hash_ref).map(|e| e.content.clone())
    }

    /// Resolve a hash to its content without following forwarding.
    /// Used by rollback to restore the exact pre-refactor state.
    pub fn resolve_content_original(&self, hash_ref: &str) -> Option<String> {
        self.get_original(hash_ref).map(|e| e.content.clone())
    }

    /// Get all hashes registered for a source path (oldest first).
    pub fn get_by_source(&self, source_path: &str) -> Option<&Vec<String>> {
        let source_key = normalize_source_key(source_path);
        if let Some(v) = self.source_index.get(&source_key) {
            return Some(v);
        }
        None
    }

    /// Get the current canonical revision (content hash) for a source path.
    /// Returns the last registered hash for that path (newest = current).
    pub fn get_current_revision(&self, source_path: &str) -> Option<String> {
        self.get_by_source(source_path)
            .and_then(|hashes| hashes.last())
            .cloned()
    }

    /// Returns true when the expected hash points to the same file bytes as the
    /// current content, even if the hash itself is not the canonical file snapshot.
    pub fn matches_authoritative_content(
        &self,
        source_path: &str,
        hash_ref: &str,
        current_content: &str,
    ) -> bool {
        let expected = crate::snapshot::canonicalize_hash(hash_ref);
        let Some(entry) = self.get_original(&expected) else {
            return false;
        };
        let Some(entry_source) = entry.source.as_deref() else {
            return false;
        };
        if normalize_source_key(entry_source) != normalize_source_key(source_path) {
            return false;
        }
        content_hash(&normalize_line_endings(&entry.content)) == content_hash(current_content)
    }

    pub fn resolve_authority_ref(&self, raw_ref: &str) -> Option<ResolvedAuthorityRef> {
        let href = parse_hash_ref(raw_ref)?;
        let entry = self.get(&href.hash)?;
        Some(ResolvedAuthorityRef {
            path: clean_source_path(entry.source.as_deref()),
            snapshot_hash: href.hash,
            selector: modifier_selector(&href.modifier),
        })
    }

    /// Invalidate canonical source tracking for a path while preserving historical hash entries.
    pub fn invalidate_source(&mut self, source_path: &str) -> Vec<String> {
        let source_key = normalize_source_key(source_path);
        let Some(stale_hashes) = self.source_index.remove(&source_key) else {
            return Vec::new();
        };

        self.forward_map.retain(|key, target| {
            !stale_hashes.iter().any(|hash| hash == key || hash == target)
        });

        stale_hashes
    }
}

pub fn modifier_selector(modifier: &HashModifier) -> Option<String> {
    match modifier {
        HashModifier::Auto | HashModifier::Content => None,
        HashModifier::Source => Some("source".to_string()),
        HashModifier::Lines(ranges) => Some(ranges.iter()
            .map(|(start, end)| match end {
                Some(end) => format!("{}-{}", start, end),
                None => format!("{}-", start),
            })
            .collect::<Vec<_>>()
            .join(",")),
        HashModifier::Shape(shape) => Some(crate::hash_protocol::shape_label(shape)),
        HashModifier::ShapedLines { ranges, shape } => {
            let range_spec = ranges.iter()
                .map(|(start, end)| match end {
                    Some(end) => format!("{}-{}", start, end),
                    None => format!("{}-", start),
                })
                .collect::<Vec<_>>()
                .join(",");
            Some(format!("{}:{}", range_spec, crate::hash_protocol::shape_label(shape)))
        }
        HashModifier::SymbolAnchor { kind, name, shape } => {
            let base = match kind {
                Some(kind) => format!("{}({})", kind, name),
                None => format!("sym({})", name),
            };
            Some(match shape {
                Some(shape) => format!("{}:{}", base, crate::hash_protocol::shape_label(shape)),
                None => base,
            })
        }
        HashModifier::Tokens => Some("tokens".to_string()),
        HashModifier::Meta => Some("meta".to_string()),
        HashModifier::Lang => Some("lang".to_string()),
        HashModifier::SymbolDeps { kind, name } => Some(match kind {
            Some(kind) => format!("{}({}):deps", kind, name),
            None => format!("sym({}):deps", name),
        }),
    }
}

/// Thread-safe wrapper for use as Tauri managed state.
pub struct HashRegistryState {
    pub registry: Mutex<HashRegistry>,
}

impl Default for HashRegistryState {
    fn default() -> Self {
        Self {
            registry: Mutex::new(HashRegistry::new()),
        }
    }
}

// ---------------------------------------------------------------------------
// File Cache — skip redundant disk reads via mtime+size checks
// ---------------------------------------------------------------------------

/// Marker entry for a previously-read file.
/// Deprecated: superseded by `snapshot::SnapshotService`; retained only to
/// remember which normalized paths have been seen by this legacy cache.
#[derive(Debug, Clone, Default)]
struct FileCacheEntry;

/// Maps canonical file paths to their last-known hash + mtime + size.
/// If a file's mtime and size haven't changed, we can skip re-reading
/// and re-hashing — the existing HashRegistry entry is still valid.
pub struct FileCache {
    entries: HashMap<String, FileCacheEntry>,
}

impl Default for FileCache {
    fn default() -> Self {
        Self { entries: HashMap::with_capacity(256) }
    }
}

impl FileCache {
    /// Record that `path` was read by the legacy cache.
    pub fn insert(&mut self, path: String, _hash: String, _modified_ns: u128, _size: u64) {
        self.entries
            .insert(normalize_source_key(&path), FileCacheEntry);
    }

    /// Invalidate a specific path (e.g. after an edit).
    #[allow(dead_code)] // Used in tests
    pub fn invalidate(&mut self, path: &str) {
        self.entries.remove(&normalize_source_key(path));
    }

    /// Clear all entries (e.g. on project switch).
    #[allow(dead_code)] // Reserved for project switch
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// Thread-safe wrapper for Tauri managed state.
pub struct FileCacheState {
    pub cache: Mutex<FileCache>,
}

impl Default for FileCacheState {
    fn default() -> Self {
        Self { cache: Mutex::new(FileCache::default()) }
    }
}

// ---------------------------------------------------------------------------
// Language Detection
// ---------------------------------------------------------------------------

/// Detect language from file extension.
pub fn detect_lang(source: Option<&str>) -> Option<String> {
    let src = source?;
    let ext = src.rsplit('.').next()?;
    let lang = match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" | "erb" => "ruby",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "dart" => "dart",
        "php" => "php",
        "ex" | "exs" => "elixir",
        "lua" => "lua",
        "r" | "R" => "r",
        "scala" | "sc" => "scala",
        "zig" => "zig",
        "proto" => "protobuf",
        "vue" => "vue",
        "svelte" => "svelte",
        "hh" | "hxx" => "cpp",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "shell",
        "md" | "markdown" => "markdown",
        _ => return None,
    };
    Some(lang.to_string())
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/// Detect and parse an `h:XXXX` reference from a string value.
/// Returns None if the value is not an `h:` reference.
///
/// Extended syntax:
///   h:XXXX                  — auto
///   h:XXXX:source           — source path
///   h:XXXX:content          — full content
///   h:XXXX:tokens           — token count
///   h:XXXX:meta             — JSON metadata
///   h:XXXX:lang             — detected language
///   h:XXXX:15-22            — line range
///   h:XXXX:sig              — signatures only
///   h:XXXX:15-30:dedent     — lines + shape
///   h:XXXX:fn(name)         — symbol anchor
///   h:XXXX:fn(name):sig     — symbol anchor + shape
pub fn parse_hash_ref(value: &str) -> Option<HashRef> {
    let trimmed = value.trim();
    if !trimmed.starts_with("h:") {
        return None;
    }
    let rest = &trimmed[2..];
    if rest.is_empty() {
        return None;
    }

    // Split on first colon after the hash to find modifier chain
    let (hash_part, modifier_chain) = match rest.find(':') {
        Some(pos) => (&rest[..pos], Some(&rest[pos + 1..])),
        None => (rest, None),
    };

    // Validate hash: must be hex chars, 6-16 length
    if hash_part.len() < 6
        || hash_part.len() > 16
        || !hash_part.chars().all(|c| c.is_ascii_hexdigit())
    {
        return None;
    }

    let modifier = match modifier_chain {
        None => HashModifier::Auto,
        Some(chain) => parse_modifier_chain(chain)?,
    };

    Some(HashRef {
        hash: hash_part.to_string(),
        modifier,
    })
}

/// Parse a diff ref: `h:OLD..h:NEW`
pub fn parse_diff_ref(value: &str) -> Option<DiffRef> {
    let trimmed = value.trim();
    if !trimmed.starts_with("h:") {
        return None;
    }
    let rest = &trimmed[2..];
    let sep = rest.find("..")?;
    let old_part = &rest[..sep];
    let new_part_raw = &rest[sep + 2..];
    let new_part = new_part_raw.strip_prefix("h:").unwrap_or(new_part_raw);

    if old_part.len() < 6 || old_part.len() > 16
        || !old_part.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if new_part.len() < 6 || new_part.len() > 16
        || !new_part.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    Some(DiffRef {
        old_hash: old_part.to_string(),
        new_hash: new_part.to_string(),
    })
}

/// Parse the modifier chain after the hash (everything after `h:XXXX:`).
/// Supports: keyword modifiers, line ranges, shape ops, symbol anchors, and
/// chained `lines:shape` combinations.
fn parse_modifier_chain(chain: &str) -> Option<HashModifier> {
    // Single keyword modifiers
    match chain {
        "source" => return Some(HashModifier::Source),
        "content" => return Some(HashModifier::Content),
        "tokens" => return Some(HashModifier::Tokens),
        "meta" => return Some(HashModifier::Meta),
        "lang" => return Some(HashModifier::Lang),
        _ => {}
    }

    // Shape-only modifiers (no line range prefix)
    if let Some(shape) = parse_shape_op(chain) {
        return Some(HashModifier::Shape(shape));
    }

    // Symbol anchors: fn(name), sym(name), optionally chained with :shape
    if let Some(anchor) = parse_symbol_anchor(chain) {
        return Some(anchor);
    }

    // Try line ranges, possibly chained with a shape: "15-30:dedent"
    if let Some(colon_pos) = find_shape_separator(chain) {
        let lines_part = &chain[..colon_pos];
        let shape_part = &chain[colon_pos + 1..];
        if let Some(ranges) = parse_line_ranges(lines_part) {
            if let Some(shape) = parse_shape_op(shape_part) {
                return Some(HashModifier::ShapedLines { ranges, shape });
            }
        }
    }

    // Plain line ranges
    parse_line_ranges(chain).map(HashModifier::Lines)
}

/// Parse a shape operation keyword, including parameterized ones.
fn parse_shape_op(s: &str) -> Option<ShapeOp> {
    match s {
        "sig" => Some(ShapeOp::Sig),
        "fold" => Some(ShapeOp::Fold),
        "dedent" => Some(ShapeOp::Dedent),
        "nocomment" => Some(ShapeOp::NoComment),
        "imports" => Some(ShapeOp::Imports),
        "exports" => Some(ShapeOp::Exports),
        "snap" => Some(ShapeOp::Snap),
        "refs" => Some(ShapeOp::Refs),
        _ => {
            // head(N), tail(N), grep(pattern), ex(ranges), hl(ranges)
            if let Some(inner) = strip_fn_call(s, "head") {
                return inner.parse::<u32>().ok().map(ShapeOp::Head);
            }
            if let Some(inner) = strip_fn_call(s, "tail") {
                return inner.parse::<u32>().ok().map(ShapeOp::Tail);
            }
            if let Some(inner) = strip_fn_call(s, "grep") {
                if !inner.is_empty() {
                    return Some(ShapeOp::Grep(inner.to_string()));
                }
            }
            if let Some(inner) = strip_fn_call(s, "ex") {
                return parse_line_ranges(inner).map(ShapeOp::Exclude);
            }
            if let Some(inner) = strip_fn_call(s, "hl") {
                return parse_line_ranges(inner).map(ShapeOp::Highlight);
            }
            // Semantic modifiers: concept(name), pattern(name), if(expr)
            if let Some(inner) = strip_fn_call(s, "concept") {
                if !inner.is_empty() {
                    return Some(ShapeOp::Concept(inner.to_string()));
                }
            }
            if let Some(inner) = strip_fn_call(s, "pattern") {
                if !inner.is_empty() {
                    return Some(ShapeOp::Pattern(inner.to_string()));
                }
            }
            if let Some(inner) = strip_fn_call(s, "if") {
                if !inner.is_empty() {
                    return Some(ShapeOp::If(inner.to_string()));
                }
            }
            None
        }
    }
}

/// Parse symbol anchor: `fn(name)`, `sym(name)`, optionally `:shape` suffix.
fn parse_symbol_anchor(chain: &str) -> Option<HashModifier> {
    // Split off optional trailing :shape
    let (anchor_part, shape_suffix) = if let Some(paren_end) = chain.find(')') {
        let after_paren = &chain[paren_end + 1..];
        if after_paren.starts_with(':') {
            (&chain[..paren_end + 1], Some(&after_paren[1..]))
        } else if after_paren.is_empty() {
            (&chain[..paren_end + 1], None)
        } else {
            return None;
        }
    } else {
        return None;
    };

    let (kind, name) = {
        let mut resolved = None;
        for (prefix, canonical_kind) in crate::shape_ops::UHPP_ANCHOR_PREFIXES {
            if let Some(inner) = strip_fn_call(anchor_part, prefix) {
                resolved = Some((canonical_kind.map(|s| s.to_string()), inner.to_string()));
                break;
            }
        }
        match resolved {
            Some(pair) => pair,
            None => return None,
        }
    };

    if name.is_empty() {
        return None;
    }

    // :deps suffix produces SymbolDeps instead of SymbolAnchor
    if shape_suffix == Some("deps") {
        return Some(HashModifier::SymbolDeps { kind, name });
    }

    let shape = shape_suffix.and_then(parse_shape_op);
    // If there was a suffix but it didn't parse as a shape, reject
    if shape_suffix.is_some() && shape.is_none() {
        return None;
    }

    Some(HashModifier::SymbolAnchor { kind, name, shape })
}

/// Extract the inner content of a `name(...)` call, e.g. `head(5)` -> `"5"`.
fn strip_fn_call<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let s = s.strip_prefix(name)?;
    let s = s.strip_prefix('(')?;
    let s = s.strip_suffix(')')?;
    Some(s)
}

/// Find the colon that separates a line range from a shape modifier.
/// Skips colons inside parentheses (e.g. `ex(30-40)`).
fn find_shape_separator(s: &str) -> Option<usize> {
    let mut depth = 0;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ':' if depth == 0 => {
                // Verify the part before this is a valid line range
                let before = &s[..i];
                if parse_line_ranges(before).is_some() {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Parse line range strings like "15-22", "15-22,40-55", "45-" (to end).
pub fn parse_line_ranges(s: &str) -> Option<Vec<(u32, Option<u32>)>> {
    let mut ranges = Vec::new();
    for part in s.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some(dash_pos) = part.find('-') {
            let start_str = &part[..dash_pos];
            let end_str = &part[dash_pos + 1..];
            let start: u32 = start_str.parse().ok()?;
            let end = if end_str.is_empty() {
                None
            } else {
                Some(end_str.parse::<u32>().ok()?)
            };
            ranges.push((start, end));
        } else {
            let line: u32 = part.parse().ok()?;
            ranges.push((line, Some(line)));
        }
    }
    if ranges.is_empty() {
        None
    } else {
        Some(ranges)
    }
}

/// Clamp context buffering to a small bounded window.
pub fn normalize_context_lines(context_lines: Option<u32>) -> u32 {
    context_lines.unwrap_or(3).min(5)
}

fn resolve_line_ranges(
    ranges: &[(u32, Option<u32>)],
    total_lines: usize,
) -> Result<Vec<(u32, u32)>, AtlsError> {
    let total_u32 = total_lines as u32;
    let mut resolved = Vec::new();
    for &(start, end) in ranges {
        if start == 0 {
            return Err(AtlsError::ValidationError {
                field: "line_range".into(),
                message: "line numbers are 1-indexed; 0 is invalid".into(),
            });
        }
        if total_lines == 0 {
            return Err(AtlsError::ValidationError {
                field: "line_range".into(),
                message: "cannot extract lines from empty content".into(),
            });
        }
        if start > total_u32 {
            return Err(AtlsError::ValidationError {
                field: "line_range".into(),
                message: format!("line {} out of range (content has {} lines)", start, total_lines),
            });
        }
        let effective_end = end.unwrap_or(total_u32).min(total_u32);
        if effective_end < start {
            return Err(AtlsError::ValidationError {
                field: "line_range".into(),
                message: format!("line range {}-{} is invalid", start, effective_end),
            });
        }
        resolved.push((start, effective_end));
    }
    Ok(resolved)
}

pub fn buffer_line_ranges(
    ranges: &[(u32, Option<u32>)],
    total_lines: usize,
    context_lines: u32,
) -> Result<Vec<(u32, Option<u32>)>, AtlsError> {
    let resolved = resolve_line_ranges(ranges, total_lines)?;
    let mut buffered = Vec::new();
    let total_u32 = total_lines as u32;
    for (start, end) in resolved {
        let actual_start = start.saturating_sub(context_lines).max(1);
        let actual_end = end.saturating_add(context_lines).min(total_u32);
        buffered.push((actual_start, Some(actual_end)));
    }
    Ok(buffered)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExtractedLineBuffer {
    pub content: String,
    pub target_range: Vec<(u32, Option<u32>)>,
    pub actual_range: Vec<(u32, Option<u32>)>,
    pub context_lines: u32,
}

pub fn extract_lines_for_display_with_context(
    content: &str,
    ranges: &[(u32, Option<u32>)],
    context_lines: u32,
) -> Result<ExtractedLineBuffer, AtlsError> {
    let total_lines = content.lines().count();
    let actual_range = buffer_line_ranges(ranges, total_lines, context_lines)?;
    let extracted = extract_lines(content, &actual_range)?;
    Ok(ExtractedLineBuffer {
        content: extracted,
        target_range: ranges.to_vec(),
        actual_range,
        context_lines,
    })
}

// ---------------------------------------------------------------------------
// Resolver Middleware
// ---------------------------------------------------------------------------

/// Try to parse and resolve file→symbol syntax for from_ref/from_refs.
/// Supports: "path → cls(Name)", "path\ncls(Name)", "path:cls(Name):dedent".
/// Returns Ok(content) or Err (no match / resolution failed).
fn try_resolve_file_symbol_ref(
    s: &str,
    field_name: Option<&str>,
    registry: &HashRegistry,
    project_root: &Path,
) -> Result<String, ()> {
    let Some(name) = field_name else { return Err(()); };
    if name != "from_ref" && name != "from_refs" {
        return Err(());
    }
    let trimmed = s.trim();
    if trimmed.is_empty() || trimmed.starts_with("h:") {
        return Err(());
    }

    // Parse: "path → spec", "path\nspec", "path → label\ncls(Name)", or "path:kind(name):modifiers"
    let (file_path, symbol_spec) = if let Some(idx) = trimmed.find(" → ") {
        let (a, b) = trimmed.split_at(idx);
        (a.trim().to_string(), b.trim_start_matches(" → ").trim().to_string())
    } else if trimmed.contains('\n') {
        let lines: Vec<&str> = trimmed.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let spec_line = lines.iter().rev().find(|l| {
            crate::shape_ops::is_symbol_anchor_str(l)
        }).copied().ok_or(())?;
        let path = lines.first().ok_or(())?
            .split(" → ").next().unwrap_or(lines[0]).trim();
        (path.to_string(), spec_line.to_string())
    } else {
        let mut split_at = None;
        for (prefix, _) in crate::shape_ops::UHPP_ANCHOR_PREFIXES {
            let marker = format!(":{}(", prefix);
            if let Some(idx) = trimmed.find(&marker) {
                if split_at.map_or(true, |s| idx < s) {
                    split_at = Some(idx);
                }
            }
        }
        let idx = split_at.ok_or(())?;
        let (a, b) = trimmed.split_at(idx);
        (a.trim().to_string(), b.trim_start_matches(':').to_string())
    };

    if file_path.is_empty() || symbol_spec.is_empty() {
        return Err(());
    }

    // Extract kind and name from symbol_spec (e.g. "cls(ParseStrategy):dedent")
    let needs_dedent = symbol_spec.contains(":dedent");
    let symbol_part = symbol_spec.split(":dedent").next().unwrap_or(&symbol_spec).trim();
    let (kind, sym_name) = crate::shape_ops::parse_symbol_anchor_str(symbol_part).ok_or(())?;

    // Get content: registry (by source path) or disk
    let content = if let Some(hashes) = registry.get_by_source(&file_path) {
        hashes.last().and_then(|h| registry.resolve_content(h))
    } else {
        None
    };
    let content = content.or_else(|| {
        let resolved = resolve_project_path(project_root, &file_path);
        std::fs::read_to_string(&resolved).ok().map(|c| normalize_line_endings(&c))
    });
    let content = content.ok_or(())?;

    let lang = detect_lang(Some(&file_path));
    let extracted = crate::shape_ops::resolve_symbol_anchor_lang(
        &content, kind, sym_name, lang.as_deref(),
    ).map_err(|_| ())?;

    let result = if needs_dedent {
        crate::shape_ops::apply_shape(&extracted, &ShapeOp::Dedent)
    } else {
        extracted
    };

    Ok(result)
}

/// Field names that always resolve to content, even if their name
/// would otherwise substring-match a FILE_FIELDS entry (e.g. "from_ref"
/// contains "from", but should return content, not a file path).
const CONTENT_FIELDS: &[&str] = &["from_ref", "from_refs", "content", "body", "code"];

/// Field names that resolve to the entry's source file path.
/// Uses `contains` matching so "my_file_ref" matches "file".
const FILE_FIELDS: &[&str] = &[
    "file", "file_path", "file_paths", "target_file", "source_file",
    "path", "from_path", "target", "target_path", "deletes", "delete",
];

/// Exact-match field names that resolve to source path but are too
/// short / ambiguous for `contains` (e.g. "source" would falsely match "resource",
/// "from" would falsely match "from_ref"/"from_refs").
const EXACT_FILE_FIELDS: &[&str] = &["source", "from"];

/// Field names that pass through the raw hash (strip `h:` prefix only).
const HASH_FIELDS: &[&str] = &["hash", "content_hash", "old_hash", "new_hash", "undo", "hashes", "refs", "to"];

/// Field names where inline h:ref replacement within larger strings is allowed.
const INLINE_RESOLVE_FIELDS: &[&str] = &[
    "content", "new", "old", "code", "body", "text", "template",
    "query", "queries", "message", "summary", "description", "anchor",
    "key", "value", "comment", "label", "cmd",
];

/// Array keys whose child objects contain literal file content — inline h:ref
/// expansion inside these structures would corrupt code being written to disk.
/// `creates` is excluded: `creates[].content` is CONTENT-AS-REF (UHPP v6) and must
/// resolve embedded `h:…` refs before `create_files`.
const LITERAL_CONTENT_ARRAYS: &[&str] = &["line_edits", "edits"];

/// Recursively walk the params JSON and resolve all `h:XXXX` references.
/// Mutates `params` in place. Returns (resolved_count, unresolved_warnings).
/// Lenient: unresolved refs are left as literal strings with a warning collected.
pub fn resolve_hash_refs(
    params: &mut serde_json::Value,
    registry: &HashRegistry,
    _project_root: &Path,
) -> (usize, Vec<String>) {
    let mut resolved_count = 0;
    let mut warnings: Vec<String> = Vec::new();
    resolve_value(params, None, registry, _project_root, &mut resolved_count, &mut warnings, false);
    (resolved_count, warnings)
}

fn resolve_value(
    value: &mut serde_json::Value,
    field_name: Option<&str>,
    registry: &HashRegistry,
    project_root: &Path,
    count: &mut usize,
    warnings: &mut Vec<String>,
    skip_inline: bool,
) {
    match value {
        serde_json::Value::String(s) => {
            if let Some(href) = parse_hash_ref(s) {
                match resolve_single(&href, field_name, registry, project_root) {
                    Ok(resolved) => {
                        *s = resolved;
                        *count += 1;
                    }
                    Err(e) => {
                        warnings.push(format!("h:{} (field {:?}): {}", href.hash, field_name.unwrap_or("?"), e));
                    }
                }
            } else if let Ok(resolved) = try_resolve_file_symbol_ref(s, field_name, registry, project_root) {
                *s = resolved;
                *count += 1;
            } else if field_name.map_or(false, |n| n == "from_ref" || n == "from_refs")
                && (s.contains("→") || s.contains("\n")) && (s.contains("cls(") || s.contains("fn("))
            {
                warnings.push(format!(
                    "from_refs element looks like file→symbol but failed to resolve: {:?}. Use h:XXX:cls(Name):dedent format.",
                    s.chars().take(80).collect::<String>()
                ));
            } else if !skip_inline {
                if let Some(name) = field_name {
                    if INLINE_RESOLVE_FIELDS.contains(&name) && s.contains("h:") {
                        *s = resolve_inline_refs(s, name, registry, project_root, count, warnings);
                    }
                }
            }
        }
        serde_json::Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                let child_skip = skip_inline
                    || LITERAL_CONTENT_ARRAYS.contains(&key.as_str());
                if let Some(val) = map.get_mut(&key) {
                    resolve_value(val, Some(&key), registry, project_root, count, warnings, child_skip);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                resolve_value(item, field_name, registry, project_root, count, warnings, skip_inline);
            }
        }
        _ => {}
    }
}

/// True if `pos` in `text` falls on a line whose leading non-whitespace is a comment marker.
fn is_inside_comment(text: &str, pos: usize) -> bool {
    let line_start = text[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let prefix = text[line_start..pos].trim_start();
    prefix.starts_with("//") || prefix.starts_with('#') || prefix.starts_with("--") || prefix.starts_with('*')
}

/// Scan a string for embedded h:refs and replace each with its resolved content.
fn resolve_inline_refs(
    text: &str,
    field_name: &str,
    registry: &HashRegistry,
    project_root: &Path,
    count: &mut usize,
    warnings: &mut Vec<String>,
) -> String {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        let anchor_prefixes = crate::shape_ops::UHPP_ANCHOR_PREFIXES
            .iter()
            .map(|(prefix, _)| regex::escape(prefix))
            .collect::<Vec<_>>()
            .join("|");
        let pattern = format!(
            r"h:[0-9a-fA-F]{{6,16}}(?::(?:[0-9]+(?:-[0-9]*)?(?:,[0-9]+(?:-[0-9]*)?)*|(?:{})\([^)]+\)|sig|fold|dedent|nocomment|imports|exports|content|source|tokens|meta|lang|head\(\d+\)|tail\(\d+\)|grep\([^)]+\)|ex\([^)]+\)|hl\([^)]+\)|concept\([^)]+\)|pattern\([^)]+\)|if\([^)]+\)|refs))*",
            anchor_prefixes,
        );
        Regex::new(&pattern).unwrap_or_else(|e| {
            eprintln!("UHPP regex compilation failed: {e}");
            // Fallback: match bare hashes only
            Regex::new(r"h:[0-9a-fA-F]{6,16}").unwrap()
        })
    });

    let mut result = String::with_capacity(text.len());
    let mut last_end = 0;

    for m in re.find_iter(text) {
        result.push_str(&text[last_end..m.start()]);
        if let Some(href) = parse_hash_ref(m.as_str()) {
            if matches!(href.modifier, HashModifier::Auto) {
                result.push_str(m.as_str());
            } else if is_inside_comment(text, m.start()) {
                warnings.push(format!(
                    "h:{} (inline, field {:?}): skipped — ref is inside a comment. Move it to its own line to resolve.",
                    href.hash, field_name
                ));
                result.push_str(m.as_str());
            } else {
                match resolve_single(&href, Some(field_name), registry, project_root) {
                    Ok(resolved) => {
                        result.push_str(&resolved);
                        *count += 1;
                    }
                    Err(e) => {
                        warnings.push(format!("h:{} (inline, field {:?}): {}", href.hash, field_name, e));
                        result.push_str(m.as_str());
                    }
                }
            }
        } else {
            result.push_str(m.as_str());
        }
        last_end = m.end();
    }
    result.push_str(&text[last_end..]);
    result
}

/// Resolve a single `h:XXXX` reference to its string value.
fn resolve_single(
    href: &HashRef,
    field_name: Option<&str>,
    registry: &HashRegistry,
    _project_root: &Path,
) -> Result<String, AtlsError> {
    if let Some(name) = field_name {
        if HASH_FIELDS.contains(&name) && matches!(href.modifier, HashModifier::Auto) {
            return Ok(href.hash.clone());
        }
    }

    let entry = registry.get(&href.hash).ok_or_else(|| {
        AtlsError::HashResolutionError {
            hash: href.hash.clone(),
            reason: "not found in registry — content may have been evicted or never loaded".into(),
        }
    })?;

    let clean_source = clean_source_path(entry.source.as_deref());

    if let Some(name) = field_name {
        let lower = name.to_lowercase();
        if EXACT_FILE_FIELDS.contains(&lower.as_str())
            || FILE_FIELDS.iter().any(|f| lower.contains(f))
        {
            return clean_source.ok_or_else(|| {
                AtlsError::HashResolutionError {
                    hash: href.hash.clone(),
                    reason: format!("no source path for field '{}'", name),
                }
            });
        }
    }

    match &href.modifier {
        HashModifier::Source => clean_source.ok_or_else(|| {
            AtlsError::HashResolutionError {
                hash: href.hash.clone(),
                reason: "no source file path (may be from a search result or tool output)".into(),
            }
        }),

        HashModifier::Content => Ok(entry.content.clone()),

        HashModifier::Lines(ranges) => extract_lines_raw(&entry.content, ranges),

        HashModifier::Shape(shape) => {
            let shaped = crate::shape_ops::apply_shape(&entry.content, shape);
            Ok(shaped)
        }

        HashModifier::ShapedLines { ranges, shape } => {
            if matches!(shape, ShapeOp::Snap) {
                let snapped = crate::shape_ops::snap_lines_to_block(&entry.content, ranges);
                extract_lines_raw(&entry.content, &snapped)
            } else {
                let extracted = extract_lines_raw(&entry.content, ranges)?;
                Ok(crate::shape_ops::apply_shape(&extracted, shape))
            }
        }

        HashModifier::SymbolAnchor { kind, name, shape } => {
            match crate::shape_ops::resolve_symbol_anchor_lang(
                &entry.content, kind.as_deref(), name, entry.lang.as_deref(),
            ) {
                Ok(extracted) => match shape {
                    Some(s) => Ok(crate::shape_ops::apply_shape(&extracted, s)),
                    None => Ok(extracted),
                },
                Err(e) => {
                    let looks_shaped = entry.content.contains("{ ... }")
                        || entry.content.contains("{ /* ... */ }");
                    if looks_shaped {
                        let kind_label = kind.as_deref().unwrap_or("sym");
                        Err(crate::error::AtlsError::NotFound {
                            resource: format!("symbol '{}'", name),
                            context: format!(
                                "Content is shaped (bodies stripped). :{}() cannot resolve against shaped content. \
                                 Use :sym() for signature-level matches, or apply :{}() to the full-content hash instead.",
                                kind_label, kind_label
                            ),
                        })
                    } else {
                        Err(e)
                    }
                }
            }
        }

        HashModifier::SymbolDeps { kind, name } => {
            crate::shape_ops::analyze_symbol_deps(
                &entry.content,
                kind.as_deref(),
                name,
                entry.lang.as_deref(),
            )
        }

        HashModifier::Tokens => Ok(entry.tokens.to_string()),

        HashModifier::Meta => {
            let meta = serde_json::json!({
                "source": clean_source,
                "tokens": entry.tokens,
                "lines": entry.line_count,
                "lang": entry.lang,
                "symbols": entry.symbol_count,
            });
            Ok(meta.to_string())
        }

        HashModifier::Lang => {
            Ok(entry.lang.clone().unwrap_or_else(|| "unknown".to_string()))
        }

        HashModifier::Auto => {
            if let Some(name) = field_name {
                let lower = name.to_lowercase();
                if CONTENT_FIELDS.iter().any(|f| lower == *f) {
                    return Ok(entry.content.clone());
                }
                if EXACT_FILE_FIELDS.contains(&lower.as_str())
                    || FILE_FIELDS.iter().any(|f| lower.contains(f))
                {
                    return clean_source.ok_or_else(|| {
                        AtlsError::HashResolutionError {
                            hash: href.hash.clone(),
                            reason: format!("no source path for field '{}'", name),
                        }
                    });
                }
            }
            Ok(entry.content.clone())
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 2: Hydration-mode dispatch
// ---------------------------------------------------------------------------

/// Resolve a hash reference at a named hydration mode.
///
/// Maps the 9 UHPP hydration modes to the existing modifier-based resolution
/// pipeline. This is the backend counterpart to the TS `hydrate()` function.
#[allow(dead_code)]
pub fn resolve_hydrated(
    hash: &str,
    mode: atls_core::types::uhpp::HydrationMode,
    registry: &HashRegistry,
    _project_root: &Path,
    options: &HydrationOptions,
) -> Result<atls_core::types::uhpp::HydrationResult, AtlsError> {
    use atls_core::types::uhpp::{HydrationMode, HydrationResult};

    let ref_id = format!("h:{}", hash);

    if mode == HydrationMode::IdOnly {
        return Ok(HydrationResult {
            ref_id: ref_id.clone(),
            mode,
            content: hash.to_string(),
            content_hash: None,
            token_estimate: 1,
            truncated: None,
            source_revision: None,
        });
    }

    let entry = registry.get(hash).ok_or_else(|| AtlsError::HashResolutionError {
        hash: hash.to_string(),
        reason: "not found in registry — content may have been evicted".into(),
    })?;

    let (content, content_hash) = match mode {
        HydrationMode::IdOnly => unreachable!(),

        HydrationMode::Digest => {
            let symbols = options.symbols.as_deref();
            let ct = options.content_type.as_deref().unwrap_or("file");
            let digest = atls_core::types::uhpp::generate_digest(&entry.content, ct, symbols);
            let d = if digest.is_empty() {
                format!("[no digest for h:{}]", hash)
            } else {
                digest
            };
            let h = content_hash(&d);
            (d, Some(h))
        }

        HydrationMode::EditReadyDigest => {
            let symbols = options.symbols.as_deref();
            let ct = options.content_type.as_deref().unwrap_or("file");
            let digest = atls_core::types::uhpp::generate_edit_ready_digest(&entry.content, ct, symbols);
            let d = if digest.is_empty() {
                format!("[no edit-ready digest for h:{}]", hash)
            } else {
                digest
            };
            let h = content_hash(&d);
            (d, Some(h))
        }

        HydrationMode::ExactSpan => {
            let lines_spec = options.lines.as_deref().ok_or_else(|| AtlsError::HashResolutionError {
                hash: hash.to_string(),
                reason: "hydrate(exact_span) requires lines option".into(),
            })?;
            let ranges = parse_line_ranges(lines_spec).ok_or_else(|| AtlsError::HashResolutionError {
                hash: hash.to_string(),
                reason: format!("invalid line range spec: {}", lines_spec),
            })?;
            let extracted = extract_lines_raw(&entry.content, &ranges)?;
            let h = content_hash(&extracted);
            (extracted, Some(h))
        }

        HydrationMode::SemanticSlice => {
            let name = options.symbol_name.as_deref().ok_or_else(|| AtlsError::HashResolutionError {
                hash: hash.to_string(),
                reason: "hydrate(semantic_slice) requires symbol_name option".into(),
            })?;
            let kind = options.symbol_kind.as_deref();
            let extracted = crate::shape_ops::resolve_symbol_anchor_lang(
                &entry.content, kind, name, entry.lang.as_deref(),
            )?;
            let h = content_hash(&extracted);
            (extracted, Some(h))
        }

        HydrationMode::Full => {
            let h = content_hash(&entry.content);
            (entry.content.clone(), Some(h))
        }

        HydrationMode::DiffView => {
            let other_hash = options.diff_ref.as_deref().ok_or_else(|| AtlsError::HashResolutionError {
                hash: hash.to_string(),
                reason: "hydrate(diff_view) requires diff_ref option".into(),
            })?;
            let old_entry = registry.get_original(hash).ok_or_else(|| AtlsError::HashResolutionError {
                hash: hash.to_string(),
                reason: "old ref not found for diff".into(),
            })?;
            let new_entry = registry.get(other_hash).ok_or_else(|| AtlsError::HashResolutionError {
                hash: other_hash.to_string(),
                reason: "new ref not found for diff".into(),
            })?;
            let old_lines: Vec<&str> = old_entry.content.lines().collect();
            let new_lines: Vec<&str> = new_entry.content.lines().collect();
            let mut diff_out = String::new();
            diff_out.push_str(&format!("--- h:{}\n+++ h:{}\n", hash, other_hash));
            let old_len = old_lines.len();
            let new_len = new_lines.len();
            let max_len = old_len.max(new_len);
            for i in 0..max_len {
                match (old_lines.get(i), new_lines.get(i)) {
                    (Some(o), Some(n)) if *o == *n => {
                        diff_out.push(' ');
                        diff_out.push_str(o);
                        diff_out.push('\n');
                    }
                    (Some(o), Some(n)) => {
                        diff_out.push('-');
                        diff_out.push_str(o);
                        diff_out.push('\n');
                        diff_out.push('+');
                        diff_out.push_str(n);
                        diff_out.push('\n');
                    }
                    (Some(o), None) => {
                        diff_out.push('-');
                        diff_out.push_str(o);
                        diff_out.push('\n');
                    }
                    (None, Some(n)) => {
                        diff_out.push('+');
                        diff_out.push_str(n);
                        diff_out.push('\n');
                    }
                    (None, None) => {}
                }
            }
            (diff_out, None)
        }

        HydrationMode::NeighborhoodPack => {
            return Err(AtlsError::HashResolutionError {
                hash: hash.to_string(),
                reason: "hydrate(neighborhood_pack) is not yet implemented".into(),
            });
        }

        HydrationMode::VerificationSummary => {
            return Err(AtlsError::HashResolutionError {
                hash: hash.to_string(),
                reason: "hydrate(verification_summary) requires structured VerificationResult data".into(),
            });
        }
    };

    let token_estimate = estimate_tokens_simple(&content);

    Ok(HydrationResult {
        ref_id,
        mode,
        content,
        content_hash,
        token_estimate,
        truncated: None,
        source_revision: None,
    })
}

/// Options for hydration mode dispatch.
#[derive(Debug, Default)]
#[allow(dead_code)]
pub struct HydrationOptions {
    pub lines: Option<String>,
    pub symbol_name: Option<String>,
    pub symbol_kind: Option<String>,
    pub diff_ref: Option<String>,
    pub symbols: Option<Vec<atls_core::types::uhpp::DigestSymbol>>,
    pub content_type: Option<String>,
}

/// Simple token estimator for backend use — ~3.5 chars per token for code.
#[allow(dead_code)]
fn estimate_tokens_simple(content: &str) -> u32 {
    let len = content.len();
    if len == 0 { return 0; }
    ((len as f64) / 3.5).ceil() as u32
}

/// Sanitize source paths: strip context store key prefixes.
/// Returns None for empty/whitespace-only results so the frontend gets null rather than "".
pub fn clean_source_path(source: Option<&str>) -> Option<String> {
    source.and_then(|s| {
        let cleaned = s
            .trim_start_matches("context:")
            .trim_start_matches("raw:")
            .trim_start_matches("smart:")
            .trim();
        if cleaned.is_empty() { None } else { Some(cleaned.to_string()) }
    })
}

/// Apply a shape string (e.g. "sig", "fold", "42-80:dedent") to raw content.
/// Used by `resolve_temporal_ref` and other callers that have content but no registry entry.
pub fn apply_shape_to_content(
    content: &str,
    shape_str: &str,
    _registry: &HashRegistry,
    _hash: &str,
) -> Result<String, AtlsError> {
    let modifier = parse_modifier_chain(shape_str).ok_or_else(|| AtlsError::HashResolutionError {
        hash: _hash.to_string(),
        reason: format!("invalid shape modifier: {}", shape_str),
    })?;

    match modifier {
        HashModifier::Shape(ref shape) => Ok(crate::shape_ops::apply_shape(content, shape)),
        HashModifier::Lines(ref ranges) => extract_lines_raw(content, ranges),
        HashModifier::ShapedLines { ref ranges, ref shape } => {
            let extracted = extract_lines_raw(content, ranges)?;
            Ok(crate::shape_ops::apply_shape(&extracted, shape))
        }
        HashModifier::Content => Ok(content.to_string()),
        _ => Ok(content.to_string()),
    }
}

/// Extract lines without line-number prefixes (for further shaping).
fn extract_lines_raw(content: &str, ranges: &[(u32, Option<u32>)]) -> Result<String, AtlsError> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let mut output = Vec::new();

    for (start, end) in resolve_line_ranges(ranges, total)? {
        let start_idx = (start as usize).saturating_sub(1);
        let end_idx = end as usize;
        for &line in &lines[start_idx..end_idx] {
            output.push(line);
        }
    }

    Ok(output.join("\n"))
}

/// Extract specific line ranges from content, returning them with line numbers.
fn extract_lines(content: &str, ranges: &[(u32, Option<u32>)]) -> Result<String, AtlsError> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let mut output = Vec::new();

    for (start, end) in resolve_line_ranges(ranges, total)? {
        let start_idx = (start as usize).saturating_sub(1);
        let end_idx = end as usize;
        for (i, &line) in lines[start_idx..end_idx].iter().enumerate() {
            let line_num = start_idx + i + 1;
            output.push(format!("{:>4}|{}", line_num, line));
        }
    }

    Ok(output.join("\n"))
}

/// Public line extraction with line numbers, for use by the resolve_hash_ref Tauri command.
pub fn extract_lines_for_display(content: &str, ranges: &[(u32, Option<u32>)]) -> String {
    match extract_lines_for_display_with_context(content, ranges, 0) {
        Ok(result) => result.content,
        Err(e) => format!("(error: {})", e),
    }
}

// ---------------------------------------------------------------------------
// Peek Handler
// ---------------------------------------------------------------------------

/// Prefer the latest registered revision for `file_path` when `hash` is a short prefix,
/// so read_lines/peek don't bind to an older registry entry and report stale_hash falsely.
fn registry_entry_for_peek<'a>(
    registry: &'a HashRegistry,
    hash: &str,
    file_path_fallback: Option<&str>,
) -> Option<&'a HashEntry> {
    let base = hash.trim_start_matches("h:");
    if let Some(fp) = file_path_fallback {
        let nk = normalize_source_key(fp);
        if let Some(hashes) = registry.get_by_source(&nk) {
            for full in hashes.iter().rev() {
                if full.starts_with(base) {
                    return registry.get_original(full);
                }
            }
        }
    }
    registry.get(base)
}

/// Retrieve specific line ranges from a file identified by hash.
/// Accepts an optional `file_path` fallback from the frontend context store
/// when the hash isn't in the backend registry (e.g., smart context reads).
pub fn peek(
    registry: &HashRegistry,
    project_root: &Path,
    hash: &str,
    lines: &str,
    file_path_fallback: Option<&str>,
    context_lines: u32,
    snapshot_svc: &mut crate::snapshot::SnapshotService,
) -> Result<serde_json::Value, String> {
    let (raw_source, has_registry_entry) = match registry_entry_for_peek(registry, hash, file_path_fallback) {
        Some(entry) => match &entry.source {
            Some(src) => (src.clone(), true),
            None => match file_path_fallback {
                Some(fp) => (fp.to_string(), false),
                None => return Err(format!(
                    "Hash h:{} has no source file path — peek requires a file-backed hash", hash
                )),
            },
        },
        None => match file_path_fallback {
            Some(fp) => (fp.to_string(), false),
            None => return Err(format!(
                "Hash h:{} not found in registry. Provide file_path or re-read the file first.", hash
            )),
        },
    };

    let source = raw_source
        .trim_start_matches("context:")
        .trim_start_matches("raw:")
        .trim_start_matches("smart:")
        .to_string();

    // Try the registry source first; on failure, fall back to file_path_fallback
    // and resolve_source_file_with_fallback before giving up. This handles the
    // common case where the registry stored a stale/prefixed path that doesn't
    // resolve from the current project_root.
    let (snap, source) = match snapshot_svc.get(project_root, &source) {
        Ok(s) => (s, source),
        Err(primary_err) => {
            // Attempt 1: caller-provided file_path_fallback (direct)
            let fallback_result = file_path_fallback.and_then(|fp| {
                let clean = fp.trim_start_matches("context:")
                    .trim_start_matches("raw:")
                    .trim_start_matches("smart:");
                snapshot_svc.get(project_root, clean).ok().map(|s| (s, clean.to_string()))
            });
            match fallback_result {
                Some(ok) => ok,
                None => {
                    // Attempt 2: fuzzy path resolution on source, then fallback
                    let candidates = [Some(source.as_str()), file_path_fallback];
                    let mut resolved = None;
                    for candidate in candidates.iter().flatten() {
                        if let Some((resolved_path, relative)) =
                            crate::path_utils::resolve_source_file_with_fallback(project_root, candidate)
                        {
                            if let Ok(s) = snapshot_svc.get_resolved(&resolved_path, &relative) {
                                resolved = Some((s, relative));
                                break;
                            }
                        }
                    }
                    match resolved {
                        Some(ok) => ok,
                        None => {
                            return Ok(serde_json::json!({
                                "error": "path_not_found",
                                "file": source,
                                "fallback_tried": file_path_fallback.unwrap_or("none"),
                                "io_error": primary_err,
                                "hint": "File path from hash is invalid or file no longer exists. Re-read the file to get a fresh hash."
                            }));
                        }
                    }
                }
            }
        }
    };

    let current_hash = &snap.snapshot_hash;
    let current_content = if snap.content.is_empty() {
        // Cache hit returned no content — read from disk
        let resolved_path = crate::path_utils::resolve_project_path(project_root, &source);
        normalize_line_endings(&std::fs::read_to_string(&resolved_path)
            .map_err(|e| format!("Failed to read {}: {}", source, e))?)
    } else {
        snap.content.clone()
    };

    if has_registry_entry {
        if let Some(entry) = registry_entry_for_peek(registry, hash, file_path_fallback) {
            let expected_hash = content_hash(&entry.content);
            if *current_hash != expected_hash {
                let normalize_deep = |s: &str| -> String {
                    s.lines()
                        .map(|l| l.trim_end())
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                let norm_stored = normalize_deep(&entry.content);
                let norm_disk = normalize_deep(&current_content);
                if content_hash(&norm_stored) != content_hash(&norm_disk) {
                    return Ok(serde_json::json!({
                        "error": "stale",
                        "file": source,
                        "expected_hash": expected_hash,
                        "current_hash": current_hash,
                        "content_hash": current_hash,
                        "hint": "File changed since last read. Use the new hash or re-read the file."
                    }));
                }
            }
        }
    }

    let ranges = parse_line_ranges(lines).ok_or_else(|| {
        format!("Invalid line range '{}'. Use: 15-22, 15-22,40-55, or 45-", lines)
    })?;

    let extracted = extract_lines_for_display_with_context(&current_content, &ranges, context_lines)
        .map_err(|e| e.to_string())?;
    let total_lines = current_content.lines().count();

    Ok(serde_json::json!({
        "file": source,
        "h": format!("h:{}", &current_hash[..SHORT_HASH_LEN]),
        "content_hash": current_hash,
        "lines": lines,
        "total_lines": total_lines,
        "content": extracted.content,
        "target_range": extracted.target_range,
        "actual_range": extracted.actual_range,
        "context_lines": extracted.context_lines,
    }))
}

// ---------------------------------------------------------------------------
// Batch Edits Handler
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
pub struct BatchEditEntry {
    pub file: String,
    #[serde(default, alias = "snapshot_hash")]
    pub content_hash: Option<String>,
    pub line_edits: Vec<LineEdit>,
}

/// Per-file undo data returned by batch_edits for the caller to push into UndoStore.
#[derive(Debug)]
pub struct BatchUndoEntry {
    pub file_path: String,
    pub new_hash: String,
    pub new_content: String,
    pub previous_content: String,
    pub previous_format: Option<FileFormat>,
}

#[derive(Debug)]
pub struct BatchEditsResult {
    pub json: serde_json::Value,
    pub undo_entries: Vec<BatchUndoEntry>,
}

/// Apply line edits to multiple files in a single call.
/// Each file is validated by snapshot_hash for staleness.
/// Returns a hash chain (old_hash -> new_hash) per file plus undo data.
pub fn batch_edits(
    registry: &mut HashRegistry,
    project_root: &Path,
    edits: Vec<BatchEditEntry>,
    snapshot_svc: &mut crate::snapshot::SnapshotService,
) -> Result<BatchEditsResult, String> {
    if edits.is_empty() {
        return Err("batch_edits requires at least one entry".to_string());
    }

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut all_written: Vec<(String, String)> = Vec::new();
    let mut undo_entries: Vec<BatchUndoEntry> = Vec::new();

    for entry in &edits {
        let file_path = &entry.file;
        let resolved_path = resolve_project_path(project_root, file_path);

        let (content, file_format) = read_file_with_format(&resolved_path)
            .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;

        let snap = snapshot_svc.snapshot_from_content(file_path, &content, None);
        let old_hash = snap.snapshot_hash.clone();
        // Authority mismatch and forwarded hashes are hard errors — no warning path.

        if let Some(ref expected) = entry.content_hash {
            let expected_clean = crate::snapshot::canonicalize_hash(expected);
            if old_hash != expected_clean {
                if let Some(fwd) = snapshot_svc.resolve_forward(&expected_clean) {
                    if fwd == old_hash {
                        return Err(format!(
                            "stale_hash (forwarded) for {}: expected {}, actual {}. The hash was forwarded from a prior edit but is no longer canonical. Perform a fresh canonical full read before retrying.",
                            file_path, expected_clean, old_hash
                        ));
                    }
                    if registry.matches_authoritative_content(file_path, &expected_clean, &content) {
                        return Err(format!(
                            "authority_mismatch for {}: expected {}, actual {}. The supplied hash referred to the same bytes through a non-canonical view. Perform a fresh canonical full read before retrying.",
                            file_path, expected_clean, old_hash
                        ));
                    }
                    return Err(format!(
                        "stale_hash for {}: expected {}, actual {}. Perform a fresh canonical full read and retry with the current revision.",
                        file_path, expected_clean, old_hash
                    ));
                } else if registry.matches_authoritative_content(file_path, &expected_clean, &content) {
                    return Err(format!(
                        "authority_mismatch for {}: expected {}, actual {}. The supplied hash referred to the same bytes through a non-canonical view. Perform a fresh canonical full read before retrying.",
                        file_path, expected_clean, old_hash
                    ));
                } else {
                    return Err(format!(
                        "stale_hash for {}: expected {}, actual {}. Perform a fresh canonical full read and retry with the current revision.",
                        file_path, expected_clean, old_hash
                    ));
                }
            }
        }

        if entry.line_edits.is_empty() {
            results.push(serde_json::json!({
                "f": file_path,
                "h": format!("h:{}", &old_hash[..SHORT_HASH_LEN]),
                "ok": 0,
                "skip": "no edits"
            }));
            continue;
        }

        // Shadow lookup for content-anchored edits when hash is stale
        let shadow_for_batch: Option<String> = if let Some(ref expected) = entry.content_hash {
            let expected_clean = crate::snapshot::canonicalize_hash(expected);
            if old_hash != expected_clean {
                registry.get_original(&expected_clean).map(|e| e.content.clone())
            } else {
                None
            }
        } else {
            None
        };

        let (new_content, warnings, _resolutions) = crate::apply_line_edits_with_shadow(
            &entry.line_edits,
            &content,
            shadow_for_batch.as_deref(),
        )?;

        // Use EditSession for validation and atomic commit
        let mut session = crate::edit_session::EditSession::begin_from_snapshot(&snap, resolved_path.clone());
        session.apply(crate::edit_session::EditOp::new(
            crate::edit_session::EditOpKind::WholeFile,
            content.clone(),
            new_content.clone(),
        )).map_err(|e| format!("EditSession apply failed for {}: {}", file_path, e))?;

        session.validate().map_err(|e| format!("EditSession validation failed for {}: {}", file_path, e))?;

        let commit_result = session.commit(snapshot_svc)
            .map_err(|e| format!("EditSession commit failed for {}: {}", file_path, e))?;

        let mut final_content = commit_result.new_content.clone();
        if let Some(formatted) = maybe_format_go_after_write(&resolved_path) {
            final_content = formatted;
        }

        let new_snap = snapshot_svc.record_write(&resolved_path, file_path, &final_content, Some(&old_hash));
        let new_hash = new_snap.snapshot_hash;

        let lang = detect_lang(Some(file_path.as_str()));
        registry.register(
            new_hash.clone(),
            HashEntry {
                source: Some(file_path.clone()),
                content: final_content.clone(),
                tokens: final_content.len() / 4,
                lang,
                line_count: final_content.lines().count(),
                symbol_count: None,
            },
        );

        undo_entries.push(BatchUndoEntry {
            file_path: file_path.clone(),
            new_hash: new_hash.clone(),
            new_content: final_content.clone(),
            previous_content: content,
            previous_format: Some(file_format),
        });

        all_written.push((file_path.clone(), final_content));

        let mut result_entry = serde_json::json!({
            "f": file_path,
            "h": format!("h:{}", &new_hash[..SHORT_HASH_LEN]),
            "content_hash": new_hash,
            "old_h": format!("h:{}", &old_hash[..SHORT_HASH_LEN]),
            "ok": entry.line_edits.len(),
        });
        if !warnings.is_empty() {
            result_entry["line_edit_notices"] = serde_json::json!(warnings);
        }
        results.push(result_entry);
    }

    Ok(BatchEditsResult {
        json: serde_json::json!({
            "batch": results,
            "files": all_written.len(),
        }),
        undo_entries,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize)]
    struct SharedHashRefCase {
        desc: String,
        input: String,
        expected: Option<serde_json::Value>,
        valid: Option<bool>,
    }

    #[derive(Debug, Deserialize)]
    struct SharedDiffRefCase {
        desc: String,
        input: String,
        expected: Option<serde_json::Value>,
        valid: Option<bool>,
    }

    fn shape_to_json(shape: &ShapeOp) -> serde_json::Value {
        match shape {
            ShapeOp::Sig => json!("sig"),
            ShapeOp::Fold => json!("fold"),
            ShapeOp::Dedent => json!("dedent"),
            ShapeOp::NoComment => json!("nocomment"),
            ShapeOp::Imports => json!("imports"),
            ShapeOp::Exports => json!("exports"),
            ShapeOp::Snap => json!("snap"),
            ShapeOp::Head(n) => json!({ "head": n }),
            ShapeOp::Tail(n) => json!({ "tail": n }),
            ShapeOp::Grep(pattern) => json!({ "grep": pattern }),
            ShapeOp::Exclude(ranges) => json!({ "exclude": ranges_to_json(ranges) }),
            ShapeOp::Highlight(ranges) => json!({ "highlight": ranges_to_json(ranges) }),
            ShapeOp::Concept(name) => json!({ "concept": name }),
            ShapeOp::Pattern(name) => json!({ "pattern": name }),
            ShapeOp::If(expr) => json!({ "if": expr }),
            ShapeOp::Refs => json!("refs"),
        }
    }

    fn ranges_to_json(ranges: &[(u32, Option<u32>)]) -> serde_json::Value {
        serde_json::Value::Array(
            ranges
                .iter()
                .map(|(start, end)| json!([start, end]))
                .collect(),
        )
    }

    fn modifier_to_json(modifier: &HashModifier) -> serde_json::Value {
        match modifier {
            HashModifier::Auto => json!("auto"),
            HashModifier::Source => json!("source"),
            HashModifier::Content => json!("content"),
            HashModifier::Lines(ranges) => json!({ "lines": ranges_to_json(ranges) }),
            HashModifier::Shape(shape) => json!({ "shape": shape_to_json(shape) }),
            HashModifier::ShapedLines { ranges, shape } => {
                json!({ "lines": ranges_to_json(ranges), "shape": shape_to_json(shape) })
            }
            HashModifier::SymbolAnchor { kind, name, shape } => {
                let mut symbol = serde_json::Map::new();
                if let Some(kind) = kind {
                    symbol.insert("kind".into(), json!(kind));
                }
                symbol.insert("name".into(), json!(name));
                if let Some(shape) = shape {
                    symbol.insert("shape".into(), shape_to_json(shape));
                }
                json!({ "symbol": serde_json::Value::Object(symbol) })
            }
            HashModifier::Tokens => json!("tokens"),
            HashModifier::Meta => json!("meta"),
            HashModifier::Lang => json!("lang"),
            HashModifier::SymbolDeps { kind, name } => {
                let mut symbol = serde_json::Map::new();
                if let Some(kind) = kind {
                    symbol.insert("kind".into(), json!(kind));
                }
                symbol.insert("name".into(), json!(name));
                json!({ "symbol_deps": serde_json::Value::Object(symbol) })
            }
        }
    }

    fn hash_ref_to_json(r: &HashRef) -> serde_json::Value {
        json!({
            "hash": r.hash,
            "modifier": modifier_to_json(&r.modifier),
        })
    }

    fn diff_ref_to_json(r: &DiffRef) -> serde_json::Value {
        json!({
            "oldHash": r.old_hash,
            "newHash": r.new_hash,
        })
    }

    #[test]
    fn matches_authoritative_content_only_for_same_file_bytes() {
        let mut registry = HashRegistry::new();
        registry.register(
            "deadbeefcafebabe".to_string(),
            HashEntry {
                source: Some("src/demo.ts".to_string()),
                content: "const demo = 1;\n".to_string(),
                tokens: 4,
                lang: Some("ts".to_string()),
                line_count: 1,
                symbol_count: None,
            },
        );

        assert!(registry.matches_authoritative_content("src/demo.ts", "h:deadbeefcafebabe:sig", "const demo = 1;\n"));
        assert!(!registry.matches_authoritative_content("src/other.ts", "h:deadbeefcafebabe:sig", "const demo = 1;\n"));
        assert!(!registry.matches_authoritative_content("src/demo.ts", "h:deadbeefcafebabe:sig", "const demo = 2;\n"));
    }

    #[test]
    fn test_parse_hash_ref_shared_fixture_cases() {
        let cases: Vec<SharedHashRefCase> = serde_json::from_str(include_str!("../../testdata/uhpp_hash_ref_cases.json"))
            .expect("shared UHPP fixture should parse");
        for case in cases {
            let parsed = parse_hash_ref(&case.input);
            if case.valid == Some(false) {
                assert!(
                    parsed.is_none(),
                    "expected shared case '{}' to be invalid, got {:?}",
                    case.desc,
                    parsed
                );
                continue;
            }
            let parsed = parsed.unwrap_or_else(|| panic!("expected shared case '{}' to parse", case.desc));
            assert_eq!(
                hash_ref_to_json(&parsed),
                case.expected.unwrap_or(serde_json::Value::Null),
                "shared case '{}'",
                case.desc
            );
        }
    }

    #[test]
    fn test_parse_diff_ref_shared_fixture_cases() {
        let cases: Vec<SharedDiffRefCase> = serde_json::from_str(include_str!("../../testdata/uhpp_diff_ref_cases.json"))
            .expect("shared UHPP diff fixture should parse");
        for case in cases {
            let parsed = parse_diff_ref(&case.input);
            if case.valid == Some(false) {
                assert!(
                    parsed.is_none(),
                    "expected shared diff case '{}' to be invalid, got {:?}",
                    case.desc,
                    parsed
                );
                continue;
            }
            let parsed = parsed.unwrap_or_else(|| panic!("expected shared diff case '{}' to parse", case.desc));
            assert_eq!(
                diff_ref_to_json(&parsed),
                case.expected.unwrap_or(serde_json::Value::Null),
                "shared diff case '{}'",
                case.desc
            );
        }
    }

    #[test]
    fn test_parse_hash_ref_basic() {
        let r = parse_hash_ref("h:abc12345").unwrap();
        assert_eq!(r.hash, "abc12345");
        assert!(matches!(r.modifier, HashModifier::Auto));
    }

    #[test]
    fn test_parse_hash_ref_source() {
        let r = parse_hash_ref("h:abc12345:source").unwrap();
        assert_eq!(r.hash, "abc12345");
        assert!(matches!(r.modifier, HashModifier::Source));
    }

    #[test]
    fn test_parse_hash_ref_content() {
        let r = parse_hash_ref("h:abc12345:content").unwrap();
        assert!(matches!(r.modifier, HashModifier::Content));
    }

    #[test]
    fn test_parse_hash_ref_lines() {
        let r = parse_hash_ref("h:abc12345:15-22").unwrap();
        match r.modifier {
            HashModifier::Lines(ranges) => {
                assert_eq!(ranges, vec![(15, Some(22))]);
            }
            _ => panic!("Expected Lines modifier"),
        }
    }

    #[test]
    fn test_parse_hash_ref_multi_lines() {
        let r = parse_hash_ref("h:abc12345:15-22,40-55").unwrap();
        match r.modifier {
            HashModifier::Lines(ranges) => {
                assert_eq!(ranges, vec![(15, Some(22)), (40, Some(55))]);
            }
            _ => panic!("Expected Lines modifier"),
        }
    }

    #[test]
    fn test_parse_hash_ref_open_end() {
        let r = parse_hash_ref("h:abc12345:45-").unwrap();
        match r.modifier {
            HashModifier::Lines(ranges) => {
                assert_eq!(ranges, vec![(45, None)]);
            }
            _ => panic!("Expected Lines modifier"),
        }
    }

    #[test]
    fn test_parse_hash_ref_full_16_char() {
        let r = parse_hash_ref("h:abc12345def67890").unwrap();
        assert_eq!(r.hash, "abc12345def67890");
    }

    #[test]
    fn test_parse_not_hash_ref() {
        assert!(parse_hash_ref("hello world").is_none());
        assert!(parse_hash_ref("h:").is_none());
        assert!(parse_hash_ref("h:abc").is_none()); // too short
        assert!(parse_hash_ref("h:xyz12345").is_none()); // non-hex
    }

    #[test]
    fn test_extract_lines() {
        let content = "line1\nline2\nline3\nline4\nline5";
        let result = extract_lines(content, &[(2, Some(4))]).unwrap();
        assert!(result.contains("line2"));
        assert!(result.contains("line3"));
        assert!(result.contains("line4"));
        assert!(!result.contains("line1"));
        assert!(!result.contains("line5"));
    }

    #[test]
    fn test_extract_lines_open_end() {
        let content = "a\nb\nc\nd\ne";
        let result = extract_lines(content, &[(3, None)]).unwrap();
        assert!(result.contains("c"));
        assert!(result.contains("d"));
        assert!(result.contains("e"));
    }

    #[test]
    fn test_buffer_line_ranges_middle_with_context() {
        let buffered = buffer_line_ranges(&[(4, Some(5))], 10, 3).unwrap();
        assert_eq!(buffered, vec![(1, Some(8))]);
    }

    #[test]
    fn test_buffer_line_ranges_clamps_to_file_edges() {
        let buffered = buffer_line_ranges(&[(2, Some(3)), (8, Some(10))], 10, 3).unwrap();
        assert_eq!(buffered, vec![(1, Some(6)), (5, Some(10))]);
    }

    #[test]
    fn test_extract_lines_with_context_preserves_target_and_actual_ranges() {
        let content = "line1\nline2\nline3\nline4\nline5\nline6\nline7";
        let extracted = extract_lines_for_display_with_context(content, &[(3, Some(4))], 2).unwrap();
        assert_eq!(extracted.target_range, vec![(3, Some(4))]);
        assert_eq!(extracted.actual_range, vec![(1, Some(6))]);
        assert_eq!(extracted.context_lines, 2);
        assert!(extracted.content.contains("   1|line1"));
        assert!(extracted.content.contains("   6|line6"));
    }

    #[test]
    fn test_extract_lines_with_zero_context_is_exact() {
        let content = "line1\nline2\nline3\nline4\nline5";
        let extracted = extract_lines_for_display_with_context(content, &[(2, Some(3))], 0).unwrap();
        assert_eq!(extracted.actual_range, vec![(2, Some(3))]);
        assert!(extracted.content.contains("   2|line2"));
        assert!(extracted.content.contains("   3|line3"));
        assert!(!extracted.content.contains("line1"));
        assert!(!extracted.content.contains("line4"));
    }

    fn test_entry(source: &str, content: &str) -> HashEntry {
        HashEntry {
            source: Some(source.to_string()),
            content: content.to_string(),
            tokens: content.len() / 4,
            lang: detect_lang(Some(source)),
            line_count: content.lines().count(),
            symbol_count: None,
        }
    }

    #[test]
    fn test_registry_lookup() {
        let mut reg = HashRegistry::new();
        reg.register("abc12345def67890".to_string(), test_entry("src/auth.ts", "file content"));
        assert!(reg.get("abc12345def67890").is_some());
        assert!(reg.get("abc12345").is_some());
        assert!(reg.get("abc123").is_some());
    }

    #[test]
    fn test_resolve_hash_refs_file_field() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/utils.ts", "export function foo() {}"));
        let mut params = serde_json::json!({"file": "h:aabb1122", "line_edits": []});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        assert_eq!(params["file"].as_str().unwrap(), "src/utils.ts");
    }

    #[test]
    fn test_resolve_hash_refs_creates_content_inline_expands() {
        let mut reg = HashRegistry::new();
        reg.register(
            "aabb1122".to_string(),
            test_entry("src/utils.ts", "export function foo() {}"),
        );
        let mut params = serde_json::json!({
            "creates": [{
                "path": "out/generated.ts",
                "content": "prefix h:aabb1122:content suffix"
            }]
        });
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert!(count >= 1, "expected inline resolution, warnings: {warnings:?}");
        assert!(warnings.is_empty());
        let c = params["creates"][0]["content"].as_str().unwrap();
        assert!(c.contains("export function foo"));
        assert!(!c.contains("h:aabb1122"));
    }

    #[test]
    fn test_resolve_hash_refs_content_hash_passthrough() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/utils.ts", "content"));
        let mut params = serde_json::json!({"content_hash": "h:aabb1122"});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        assert_eq!(params["content_hash"].as_str().unwrap(), "aabb1122");
    }

    #[test]
    fn test_resolve_hash_refs_with_line_modifier() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/utils.ts", "line1\nline2\nline3\nline4\nline5"));
        let mut params = serde_json::json!({"content": "h:aabb1122:2-4"});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        let resolved = params["content"].as_str().unwrap();
        assert!(resolved.contains("line2"));
        assert!(resolved.contains("line4"));
    }

    #[test]
    fn test_resolve_hash_refs_file_field_with_line_modifier_uses_source_path() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/utils.ts", "line1\nline2\nline3\nline4\nline5"));
        let mut params = serde_json::json!({"file": "h:aabb1122:2-4", "line_edits": []});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        assert_eq!(params["file"].as_str().unwrap(), "src/utils.ts");
    }

    #[test]
    fn test_resolve_hash_refs_nested_edit_file_path_with_line_modifier_uses_source_path() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/utils.ts", "line1\nline2\nline3\nline4\nline5"));
        let mut params = serde_json::json!({
            "edits": [{
                "file_path": "h:aabb1122:2-4",
                "old": "line2\nline3\nline4",
                "new": "replacement"
            }]
        });
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        assert_eq!(params["edits"][0]["file_path"].as_str().unwrap(), "src/utils.ts");
    }

    #[test]
    fn test_resolve_hash_refs_unresolved_is_lenient() {
        let reg = HashRegistry::new();
        let mut params = serde_json::json!({"content": "h:deadbeef:content", "file": "h:cafebabe"});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 0);
        assert_eq!(warnings.len(), 2);
        // Literal strings preserved when resolution fails
        assert_eq!(params["content"].as_str().unwrap(), "h:deadbeef:content");
        assert_eq!(params["file"].as_str().unwrap(), "h:cafebabe");
    }

    #[test]
    fn test_resolve_hash_refs_deletes_resolves_to_path() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/foo.ts", "content"));
        reg.register("ccdd3344".to_string(), test_entry("src/bar.ts", "content"));
        let mut params = serde_json::json!({"deletes": ["h:aabb1122", "h:ccdd3344"]});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 2);
        assert!(warnings.is_empty());
        let deletes = params["deletes"].as_array().unwrap();
        assert_eq!(deletes[0].as_str().unwrap(), "src/foo.ts");
        assert_eq!(deletes[1].as_str().unwrap(), "src/bar.ts");
    }

    #[test]
    fn test_resolve_hash_refs_hashes_passthrough() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/foo.ts", "content"));
        let mut params = serde_json::json!({"hashes": ["h:aabb1122", "h:ccdd3344"]});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 2, "hashes pass-through does not require registry");
        assert!(warnings.is_empty());
        let hashes = params["hashes"].as_array().unwrap();
        assert_eq!(hashes[0].as_str().unwrap(), "aabb1122");
        assert_eq!(hashes[1].as_str().unwrap(), "ccdd3344");
    }

    // --- HPP v2 parser tests ---

    #[test]
    fn test_parse_shape_sig() {
        let r = parse_hash_ref("h:abc12345:sig").unwrap();
        assert!(matches!(r.modifier, HashModifier::Shape(ShapeOp::Sig)));
    }

    #[test]
    fn test_parse_shape_fold() {
        let r = parse_hash_ref("h:abc12345:fold").unwrap();
        assert!(matches!(r.modifier, HashModifier::Shape(ShapeOp::Fold)));
    }

    #[test]
    fn test_parse_shape_dedent() {
        let r = parse_hash_ref("h:abc12345:dedent").unwrap();
        assert!(matches!(r.modifier, HashModifier::Shape(ShapeOp::Dedent)));
    }

    #[test]
    fn test_parse_shape_imports() {
        let r = parse_hash_ref("h:abc12345:imports").unwrap();
        assert!(matches!(r.modifier, HashModifier::Shape(ShapeOp::Imports)));
    }

    #[test]
    fn test_parse_shape_exports() {
        let r = parse_hash_ref("h:abc12345:exports").unwrap();
        assert!(matches!(r.modifier, HashModifier::Shape(ShapeOp::Exports)));
    }

    #[test]
    fn test_parse_head_tail() {
        let r = parse_hash_ref("h:abc12345:head(5)").unwrap();
        assert!(matches!(r.modifier, HashModifier::Shape(ShapeOp::Head(5))));
        let r = parse_hash_ref("h:abc12345:tail(10)").unwrap();
        assert!(matches!(r.modifier, HashModifier::Shape(ShapeOp::Tail(10))));
    }

    #[test]
    fn test_parse_grep() {
        let r = parse_hash_ref("h:abc12345:grep(async)").unwrap();
        match &r.modifier {
            HashModifier::Shape(ShapeOp::Grep(pat)) => assert_eq!(pat, "async"),
            _ => panic!("Expected Grep"),
        }
    }

    #[test]
    fn test_parse_shaped_lines() {
        let r = parse_hash_ref("h:abc12345:15-30:dedent").unwrap();
        match &r.modifier {
            HashModifier::ShapedLines { ranges, shape } => {
                assert_eq!(ranges, &[(15, Some(30))]);
                assert_eq!(shape, &ShapeOp::Dedent);
            }
            _ => panic!("Expected ShapedLines"),
        }
    }

    #[test]
    fn test_parse_lines_with_exclude() {
        let r = parse_hash_ref("h:abc12345:15-80:ex(30-40)").unwrap();
        match &r.modifier {
            HashModifier::ShapedLines { ranges, shape } => {
                assert_eq!(ranges, &[(15, Some(80))]);
                assert!(matches!(shape, ShapeOp::Exclude(_)));
            }
            _ => panic!("Expected ShapedLines with Exclude"),
        }
    }

    #[test]
    fn test_parse_lines_with_highlight() {
        let r = parse_hash_ref("h:abc12345:15-50:hl(22,25-27)").unwrap();
        match &r.modifier {
            HashModifier::ShapedLines { ranges, shape } => {
                assert_eq!(ranges, &[(15, Some(50))]);
                match shape {
                    ShapeOp::Highlight(hl) => {
                        assert_eq!(hl, &[(22, Some(22)), (25, Some(27))]);
                    }
                    _ => panic!("Expected Highlight shape"),
                }
            }
            _ => panic!("Expected ShapedLines"),
        }
    }

    #[test]
    fn test_parse_symbol_anchor_fn() {
        let r = parse_hash_ref("h:abc12345:fn(authenticate)").unwrap();
        match &r.modifier {
            HashModifier::SymbolAnchor { kind, name, shape } => {
                assert_eq!(kind, &Some("fn".to_string()));
                assert_eq!(name, "authenticate");
                assert!(shape.is_none());
            }
            _ => panic!("Expected SymbolAnchor"),
        }
    }

    #[test]
    fn test_parse_symbol_anchor_sym() {
        let r = parse_hash_ref("h:abc12345:sym(AuthService)").unwrap();
        match &r.modifier {
            HashModifier::SymbolAnchor { kind, name, shape } => {
                assert!(kind.is_none());
                assert_eq!(name, "AuthService");
                assert!(shape.is_none());
            }
            _ => panic!("Expected SymbolAnchor"),
        }
    }

    #[test]
    fn test_parse_symbol_anchor_with_shape() {
        let r = parse_hash_ref("h:abc12345:fn(authenticate):sig").unwrap();
        match &r.modifier {
            HashModifier::SymbolAnchor { kind, name, shape } => {
                assert_eq!(kind, &Some("fn".to_string()));
                assert_eq!(name, "authenticate");
                assert_eq!(shape, &Some(ShapeOp::Sig));
            }
            _ => panic!("Expected SymbolAnchor with shape"),
        }
    }

    #[test]
    fn test_parse_meta_modifiers() {
        let r = parse_hash_ref("h:abc12345:tokens").unwrap();
        assert!(matches!(r.modifier, HashModifier::Tokens));
        let r = parse_hash_ref("h:abc12345:meta").unwrap();
        assert!(matches!(r.modifier, HashModifier::Meta));
        let r = parse_hash_ref("h:abc12345:lang").unwrap();
        assert!(matches!(r.modifier, HashModifier::Lang));
    }

    #[test]
    fn test_parse_diff_ref() {
        let d = parse_diff_ref("h:abc12345..h:def67890").unwrap();
        assert_eq!(d.old_hash, "abc12345");
        assert_eq!(d.new_hash, "def67890");
    }

    #[test]
    fn test_parse_diff_ref_no_prefix() {
        let d = parse_diff_ref("h:abc12345..def67890").unwrap();
        assert_eq!(d.old_hash, "abc12345");
        assert_eq!(d.new_hash, "def67890");
    }

    #[test]
    fn test_detect_lang() {
        assert_eq!(detect_lang(Some("src/auth.ts")), Some("typescript".to_string()));
        assert_eq!(detect_lang(Some("main.rs")), Some("rust".to_string()));
        assert_eq!(detect_lang(Some("script.py")), Some("python".to_string()));
        assert_eq!(detect_lang(None), None);
    }

    #[test]
    fn test_detect_lang_all_extensions() {
        let cases: &[(&str, &str)] = &[
            ("main.rs", "rust"),
            ("lib.ts", "typescript"),
            ("app.tsx", "typescript"),
            ("index.js", "javascript"),
            ("component.jsx", "javascript"),
            ("mod.mjs", "javascript"),
            ("bundle.cjs", "javascript"),
            ("script.py", "python"),
            ("main.go", "go"),
            ("App.java", "java"),
            ("foo.c", "c"),
            ("bar.h", "c"),
            ("main.cpp", "cpp"),
            ("lib.cc", "cpp"),
            ("file.hpp", "cpp"),
            ("header.hh", "cpp"),
            ("header.hxx", "cpp"),
            ("api.cs", "csharp"),
            ("app.rb", "ruby"),
            ("view.erb", "ruby"),
            ("App.swift", "swift"),
            ("main.kt", "kotlin"),
            ("script.kts", "kotlin"),
            ("main.dart", "dart"),
            ("index.php", "php"),
            ("module.ex", "elixir"),
            ("script.exs", "elixir"),
            ("init.lua", "lua"),
            ("script.r", "r"),
            ("data.R", "r"),
            ("app.scala", "scala"),
            ("Build.sc", "scala"),
            ("main.zig", "zig"),
            ("schema.proto", "protobuf"),
            ("App.vue", "vue"),
            ("Component.svelte", "svelte"),
            ("config.json", "json"),
            ("Cargo.toml", "toml"),
            ("config.yaml", "yaml"),
            ("manifest.yml", "yaml"),
            ("index.html", "html"),
            ("page.htm", "html"),
            ("style.css", "css"),
            ("theme.scss", "css"),
            ("vars.less", "css"),
            ("schema.sql", "sql"),
            ("script.sh", "shell"),
            ("run.bash", "shell"),
            ("config.zsh", "shell"),
            ("readme.md", "markdown"),
            ("docs.markdown", "markdown"),
        ];
        for (path, expected) in cases {
            assert_eq!(
                detect_lang(Some(path)),
                Some((*expected).to_string()),
                "path: {}",
                path
            );
        }
        assert!(detect_lang(Some("file.unknown")).is_none());
    }

    // -----------------------------------------------------------------------
    // HPP v4: New parser tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_concept_modifier() {
        let r = parse_hash_ref("h:abc12345:concept(authentication)").unwrap();
        match &r.modifier {
            HashModifier::Shape(ShapeOp::Concept(term)) => {
                assert_eq!(term, "authentication");
            }
            _ => panic!("Expected Shape(Concept), got {:?}", r.modifier),
        }
    }

    #[test]
    fn test_parse_pattern_modifier() {
        let r = parse_hash_ref("h:abc12345:pattern(error-handling)").unwrap();
        match &r.modifier {
            HashModifier::Shape(ShapeOp::Pattern(name)) => {
                assert_eq!(name, "error-handling");
            }
            _ => panic!("Expected Shape(Pattern), got {:?}", r.modifier),
        }
    }

    #[test]
    fn test_parse_if_modifier() {
        let r = parse_hash_ref("h:abc12345:if(has(TODO))").unwrap();
        match &r.modifier {
            HashModifier::Shape(ShapeOp::If(expr)) => {
                assert_eq!(expr, "has(TODO)");
            }
            _ => panic!("Expected Shape(If), got {:?}", r.modifier),
        }
    }

    #[test]
    fn test_expanded_file_fields() {
        assert!(FILE_FIELDS.contains(&"path"));
        assert!(FILE_FIELDS.contains(&"file_paths"));
        assert!(FILE_FIELDS.contains(&"from_path"));
        assert!(FILE_FIELDS.contains(&"target"));
        assert!(FILE_FIELDS.contains(&"target_path"));
        assert!(EXACT_FILE_FIELDS.contains(&"from"),
            "'from' should be in EXACT_FILE_FIELDS to avoid substring-matching 'from_ref'/'from_refs'");
    }

    #[test]
    fn test_source_field_resolves_to_path() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("_uhpp_test/source.ts", "export function foo() {}"));
        let mut params = serde_json::json!({"source": "h:aabb1122", "remove_lines": "1-3"});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        assert_eq!(params["source"].as_str().unwrap(), "_uhpp_test/source.ts",
            "source field should resolve to file path, not content");
    }

    #[test]
    fn test_from_field_resolves_to_path() {
        let mut reg = HashRegistry::new();
        reg.register("ccdd3344".to_string(), test_entry("_uhpp_test/from.ts", "const x = 1;"));
        let mut params = serde_json::json!({"from": "h:ccdd3344"});
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        assert_eq!(params["from"].as_str().unwrap(), "_uhpp_test/from.ts",
            "exact 'from' field should resolve to file path");
    }

    #[test]
    fn test_file_paths_resolves_to_source() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/api.ts", "export const x = 1;"));
        let mut params = serde_json::json!({
            "operation": "context",
            "file_paths": ["h:aabb1122", "src/other.ts"]
        });
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        let paths = params["file_paths"].as_array().unwrap();
        assert_eq!(paths[0].as_str().unwrap(), "src/api.ts",
            "file_paths[0] h:ref should resolve to source path, not content");
        assert_eq!(paths[1].as_str().unwrap(), "src/other.ts",
            "file_paths[1] literal path should pass through");
    }

    #[test]
    fn test_from_refs_resolves_to_content() {
        let content_a = "export function foo() { return 1; }";
        let content_b = "export function bar() { return 2; }";
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("_uhpp_test/source_a.ts", content_a));
        reg.register("ccdd3344".to_string(), test_entry("_uhpp_test/source_b.ts", content_b));

        let mut params = serde_json::json!({
            "create": {
                "path": "target.ts",
                "from_refs": ["h:aabb1122", "h:ccdd3344"]
            }
        });
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 2, "both refs should resolve");
        assert!(warnings.is_empty(), "no warnings expected: {:?}", warnings);

        let resolved = params["create"]["from_refs"].as_array().unwrap();
        assert_eq!(resolved[0].as_str().unwrap(), content_a,
            "from_refs[0] should resolve to content, not file path");
        assert_eq!(resolved[1].as_str().unwrap(), content_b,
            "from_refs[1] should resolve to content, not file path");
    }

    #[test]
    fn test_from_ref_resolves_to_content() {
        let content = "export function baz() { return 42; }";
        let mut reg = HashRegistry::new();
        reg.register("eeff5566".to_string(), test_entry("_uhpp_test/source.ts", content));

        let mut params = serde_json::json!({
            "create": {
                "path": "target.ts",
                "from_ref": "h:eeff5566"
            }
        });
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));
        assert_eq!(count, 1);
        assert!(warnings.is_empty());
        assert_eq!(params["create"]["from_ref"].as_str().unwrap(), content,
            "from_ref should resolve to content, not file path");
    }

    #[test]
    fn test_source_exact_match_no_false_positives() {
        assert!(EXACT_FILE_FIELDS.contains(&"source"));
        assert!(EXACT_FILE_FIELDS.contains(&"from"));
        assert!(!EXACT_FILE_FIELDS.contains(&"resource"));
        let lower = "resource".to_lowercase();
        assert!(!EXACT_FILE_FIELDS.contains(&lower.as_str()),
            "resource should NOT match EXACT_FILE_FIELDS");
    }

    #[test]
    fn test_content_fields_take_priority() {
        for &f in CONTENT_FIELDS {
            let lower = f.to_lowercase();
            let would_match_file = EXACT_FILE_FIELDS.contains(&lower.as_str())
                || FILE_FIELDS.iter().any(|ff| lower.contains(ff));
            if would_match_file {
                assert!(CONTENT_FIELDS.iter().any(|cf| lower == *cf),
                    "field '{}' matches FILE_FIELDS but CONTENT_FIELDS must take priority", f);
            }
        }
    }

    #[test]
    fn test_inline_resolve_fields() {
        assert!(INLINE_RESOLVE_FIELDS.contains(&"query"));
        assert!(INLINE_RESOLVE_FIELDS.contains(&"message"));
        assert!(INLINE_RESOLVE_FIELDS.contains(&"description"));
        assert!(INLINE_RESOLVE_FIELDS.contains(&"label"));
    }

    // FileCache::check method was removed; these tests are disabled pending SnapshotService migration.
    // #[test] fn test_file_cache_insert_and_check() { ... }
    // #[test] fn test_file_cache_invalidate() { ... }

    #[test]
    fn test_hash_registry_invalidate_source_drops_current_revision_tracking() {
        let mut reg = HashRegistry::new();
        reg.register("aabb1122".to_string(), test_entry("src/demo.ts", "const a = 1;"));
        reg.register("ccdd3344".to_string(), test_entry("src/demo.ts", "const a = 2;"));

        assert_eq!(reg.get_current_revision("src/demo.ts").as_deref(), Some("ccdd3344"));
        let stale_hashes = reg.invalidate_source("SRC\\DEMO.ts");

        assert_eq!(stale_hashes, vec!["aabb1122".to_string(), "ccdd3344".to_string()]);
        assert!(reg.get_current_revision("src/demo.ts").is_none());
        assert!(reg.get("aabb1122").is_some(), "historical content should remain available");
    }

    #[test]
    fn test_resolve_hash_refs_inline_supports_anchor_aliases_and_refs_shape() {
        let mut reg = HashRegistry::new();
        reg.register(
            "aabb1122".to_string(),
            test_entry(
                "src/auth.ts",
                "class AuthService {\n  validate(user) {\n    return check(user);\n  }\n}\n",
            ),
        );

        let mut params = serde_json::json!({
            "message": "Alias h:aabb1122:class(AuthService) deps h:aabb1122:refs"
        });
        let (count, warnings) = resolve_hash_refs(&mut params, &reg, Path::new("/tmp"));

        assert_eq!(count, 2);
        assert!(warnings.is_empty());
        let resolved = params["message"].as_str().unwrap();
        assert!(resolved.contains("class AuthService"));
        assert!(!resolved.contains("h:aabb1122:class(AuthService)"));
        assert!(!resolved.contains("h:aabb1122:refs"));
    }

    #[test]
    fn test_peek_returns_canonical_content_hash() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("demo.ts");
        std::fs::write(&file_path, "line1\nline2\nline3\n").unwrap();

        let mut reg = HashRegistry::new();
        let content = std::fs::read_to_string(&file_path).unwrap();
        let hash = content_hash(&content);
        reg.register(hash.clone(), test_entry("demo.ts", &content));

        let mut snapshot_svc = crate::snapshot::SnapshotService::new();
        let result = peek(&reg, dir.path(), &hash, "2-2", Some("demo.ts"), 0, &mut snapshot_svc).unwrap();
        let short_hash = format!("h:{}", &hash[..SHORT_HASH_LEN]);

        assert_eq!(result["content_hash"].as_str(), Some(hash.as_str()));
        assert_eq!(result["h"].as_str(), Some(short_hash.as_str()));
    }

    #[test]
    fn test_peek_fallback_when_registry_source_wrong() {
        let dir = tempfile::tempdir().unwrap();
        let src_dir = dir.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let file_path = src_dir.join("app.ts");
        std::fs::write(&file_path, "line1\nline2\nline3\n").unwrap();

        let content = std::fs::read_to_string(&file_path).unwrap();
        let hash = content_hash(&content);

        // Register with a WRONG source path (missing src/ prefix)
        let mut reg = HashRegistry::new();
        reg.register(hash.clone(), test_entry("app.ts", &content));

        let mut snapshot_svc = crate::snapshot::SnapshotService::new();
        // Without fallback, peek would fail because "app.ts" doesn't resolve
        // from project root — but with file_path_fallback = "src/app.ts", it recovers.
        let result = peek(&reg, dir.path(), &hash, "1-2", Some("src/app.ts"), 0, &mut snapshot_svc).unwrap();

        assert!(result.get("error").is_none(), "expected success but got error: {:?}", result);
        assert!(result["content"].as_str().unwrap().contains("line1"));
    }

    #[test]
    fn test_peek_path_not_found_error_distinct_from_stale() {
        let dir = tempfile::tempdir().unwrap();

        let mut reg = HashRegistry::new();
        reg.register("deadbeef12345678".to_string(), test_entry("nonexistent.ts", "content"));

        let mut snapshot_svc = crate::snapshot::SnapshotService::new();
        let result = peek(&reg, dir.path(), "deadbeef12345678", "1-1", None, 0, &mut snapshot_svc).unwrap();

        // Should be "path_not_found", not the old generic "stale"
        assert_eq!(result["error"].as_str(), Some("path_not_found"));
    }

    #[test]
    fn test_peek_fuzzy_resolve_finds_nested_file() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("src").join("components");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("Button.tsx");
        std::fs::write(&file, "export const Button = () => {};\n").unwrap();

        let content = std::fs::read_to_string(&file).unwrap();
        let hash = content_hash(&content);

        // Register with an extra prefix that doesn't resolve directly
        let mut reg = HashRegistry::new();
        reg.register(hash.clone(), test_entry("myapp/src/components/Button.tsx", &content));

        let mut snapshot_svc = crate::snapshot::SnapshotService::new();
        let result = peek(&reg, dir.path(), &hash, "1-1", None, 0, &mut snapshot_svc).unwrap();

        assert!(result.get("error").is_none(), "expected fuzzy resolve to succeed: {:?}", result);
        assert!(result["content"].as_str().unwrap().contains("Button"));
    }

    #[test]
    fn test_register_normalizes_source_prefixes() {
        let mut reg = HashRegistry::new();
        let entry = HashEntry {
            source: Some("context:src/demo.ts".to_string()),
            content: "const x = 1;".to_string(),
            tokens: 3,
            lang: None,
            line_count: 1,
            symbol_count: None,
        };
        reg.register("aabb1122".to_string(), entry);

        let stored = reg.get("aabb1122").unwrap();
        assert_eq!(stored.source.as_deref(), Some("src/demo.ts"),
            "context: prefix should be stripped on registration");
    }

    #[test]
    fn test_register_normalizes_backslashes() {
        let mut reg = HashRegistry::new();
        let entry = HashEntry {
            source: Some("src\\components\\App.tsx".to_string()),
            content: "const App = () => {};".to_string(),
            tokens: 5,
            lang: None,
            line_count: 1,
            symbol_count: None,
        };
        reg.register("ccdd3344".to_string(), entry);

        let stored = reg.get("ccdd3344").unwrap();
        assert_eq!(stored.source.as_deref(), Some("src/components/App.tsx"),
            "backslashes should be normalized to forward slashes on registration");
    }
}
