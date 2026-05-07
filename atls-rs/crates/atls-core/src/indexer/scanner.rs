use crate::db::Database;
use crate::indexer::{ImportInfo, IndexerError, ParseResult};
use crate::indexer::uhpp_extractor::uhpp_extract_symbols;
use crate::indexer::relations::{RelationTracker, extract_calls_regex, extract_imports_regex};
use crate::parser::ParserRegistry;
use crate::file::{FileRelationType, Language};
use crate::watcher::{FileFilter, Watcher, WatcherHandle};
use crate::detector::{DetectorRegistry, FocusMatrix, TreeSitterDetector};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{Mutex, Semaphore};
use tracing::{debug, error, info, warn};

use sha2::{Digest, Sha256};
use std::fs;
use rusqlite::{params, OptionalExtension};
use regex::Regex;
use std::sync::LazyLock;

use crate::query::hybrid::{self, EmbeddingProvider};

static IDENT_PLACEHOLDER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b[A-Za-z_][A-Za-z0-9_]*\b").expect("ident placeholder regex")
});

/// Result of processing a single file (CPU-bound work, no DB access)
struct FileProcessResult {
    path: PathBuf,
    hash: String,
    language: Language,
    line_count: u32,
    parse_result: ParseResult,
}

/// Scan progress callback
pub type ProgressCallback = Box<dyn Fn(ScanProgress) + Send + Sync>;

/// Scan progress information
#[derive(Debug, Clone)]
pub struct ScanProgress {
    pub processed: usize,
    pub total: usize,
    pub current_file: Option<PathBuf>,
    pub duration_ms: u64,
}

/// Scan statistics
#[derive(Debug, Clone, Default)]
pub struct ScanStats {
    pub files_scanned: usize,
    pub files_indexed: usize,
    pub errors: usize,
    pub error_details: Vec<(PathBuf, String)>,
}

/// Parsed tsconfig path alias: prefix -> list of replacement bases
type TsConfigPaths = HashMap<String, Vec<String>>;

/// Filter controlling which patterns the scanner runs (focus profile)
#[derive(Debug, Clone, Default)]
pub struct ScanFilter {
    /// Per-category severity enables. None = all patterns (backward compatible)
    pub matrix: Option<FocusMatrix>,
}

/// Policy for incremental single-file indexing (`index_file` / `on_file_change`).
#[derive(Clone, Copy, Debug)]
pub struct IncrementalParsePolicy {
    /// When true (default), run tree-sitter structural pattern detectors and refresh `code_issues`.
    /// When false, skip pattern detectors and leave existing `code_issues` rows unchanged (rare opt-out).
    pub run_structural_patterns: bool,
}

impl IncrementalParsePolicy {
    /// Full incremental index after a touch: symbols, imports, calls, structural patterns, and `code_issues`.
    /// Use this for normal `on_file_change` / post-edit indexing; work can still run in the background
    /// so the UI/agent does not block on completion.
    pub fn full() -> Self {
        Self {
            run_structural_patterns: true,
        }
    }

    /// Skip structural pattern detectors; preserve existing pattern issues in DB. For tests or special cases only.
    pub fn skip_structural_patterns() -> Self {
        Self {
            run_structural_patterns: false,
        }
    }
}

impl Default for IncrementalParsePolicy {
    fn default() -> Self {
        Self::full()
    }
}

/// Indexer orchestrates scanning and indexing
pub struct Indexer {
    db: Arc<Database>,
    root_path: PathBuf,
    filter: Arc<Mutex<FileFilter>>,
    parser_registry: Arc<ParserRegistry>,
    detector_registry: Arc<DetectorRegistry>,
    watcher: Option<WatcherHandle>,
    progress_callback: Option<ProgressCallback>,
    /// Resolved tsconfig.json path aliases (e.g., "@/*" -> ["src/*"])
    ts_path_aliases: TsConfigPaths,
    /// Go module path prefix from go.mod (e.g., "github.com/go-chi/chi/v5")
    go_module_prefix: Option<String>,
    embedding_provider: Box<dyn EmbeddingProvider>,
}

impl Indexer {
    /// Create a new indexer
    pub fn new<P: AsRef<Path>>(
        root_path: P,
        db: Database,
    ) -> Result<Self, IndexerError> {
        Self::with_patterns_dir(root_path, db, None)
    }
    
    /// Create a new indexer with a custom patterns directory
    pub fn with_patterns_dir<P: AsRef<Path>>(
        root_path: P,
        db: Database,
        patterns_dir: Option<&Path>,
    ) -> Result<Self, IndexerError> {
        let root_path = root_path.as_ref().canonicalize()
            .map_err(|e| IndexerError::Path(format!("Failed to canonicalize path: {}", e)))?;
        
        let filter = FileFilter::new(&root_path)?;
        let db = Arc::new(db);
        let parser_registry = Arc::new(ParserRegistry::new());
        
        // Initialize detector registry
        let mut detector_registry = DetectorRegistry::new();
        
        // Try to load patterns from the specified directory or common locations
        let mut patterns_loaded = false;
        
        if let Some(dir) = patterns_dir {
            if dir.exists() {
                if let Err(e) = detector_registry.load_from_dir(dir) {
                    warn!("Failed to load patterns from {:?}: {}", dir, e);
                } else {
                    patterns_loaded = true;
                    info!("Loaded {} patterns from {:?}", detector_registry.pattern_count(), dir);
                }
            }
        }
        
        // If no patterns loaded yet, try common locations
        if !patterns_loaded {
            // Try patterns in project root
            let project_patterns = root_path.join("patterns");
            if project_patterns.exists() {
                if let Err(e) = detector_registry.load_from_dir(&project_patterns) {
                    warn!("Failed to load patterns from {:?}: {}", project_patterns, e);
                } else {
                    patterns_loaded = true;
                    info!("Loaded {} patterns from project", detector_registry.pattern_count());
                }
            }
        }
        
        // If still no patterns, try parent directory (workspace patterns)
        if !patterns_loaded {
            if let Some(parent) = root_path.parent() {
                let workspace_patterns = parent.join("patterns");
                if workspace_patterns.exists() {
                    if let Err(e) = detector_registry.load_from_dir(&workspace_patterns) {
                        warn!("Failed to load patterns from {:?}: {}", workspace_patterns, e);
                    } else {
                        patterns_loaded = true;
                        info!("Loaded {} patterns from workspace", detector_registry.pattern_count());
                    }
                }
            }
        }
        
        // Fallback to built-in patterns
        if !patterns_loaded {
            detector_registry.load_builtin_patterns();
        }
        
        // Load tsconfig.json path aliases for TS/JS import resolution
        let ts_path_aliases = Self::load_tsconfig_paths(&root_path);
        
        // Load Go module prefix from go.mod for import resolution
        let go_module_prefix = Self::load_go_module_prefix(&root_path);
        
        Ok(Self {
            db,
            root_path,
            filter: Arc::new(Mutex::new(filter)),
            parser_registry,
            detector_registry: Arc::new(detector_registry),
            watcher: None,
            progress_callback: None,
            ts_path_aliases,
            go_module_prefix,
            embedding_provider: hybrid::default_provider(),
        })
    }
    
    /// Replace the embedding provider (e.g., swap deterministic for ONNX neural).
    pub fn set_embedding_provider(&mut self, provider: Box<dyn EmbeddingProvider>) {
        self.embedding_provider = provider;
    }

    /// Re-embed symbols whose stored `model` doesn't match the current provider.
    /// Processes `batch_size` rows per call; returns the number updated.
    /// Call repeatedly (e.g. during idle) until it returns 0.
    pub fn reembed_stale(&self, batch_size: usize) -> Result<usize, IndexerError> {
        let conn = self.db.conn();
        let model = self.embedding_provider.model_id();
        let dim = self.embedding_provider.dim();
        let limit = batch_size.min(500).max(1) as i64;

        let mut stmt = conn.prepare(
            "SELECT se.symbol_id, s.name, s.signature, json_extract(s.metadata, '$.body_preview')
             FROM symbol_embeddings se
             JOIN symbols s ON s.id = se.symbol_id
             WHERE se.model != ?1
             LIMIT ?2"
        )?;

        let rows: Vec<(i64, String, Option<String>, Option<String>)> = stmt
            .query_map(params![model, limit], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        if rows.is_empty() {
            return Ok(0);
        }

        let count = rows.len();
        for (symbol_id, name, sig, body) in &rows {
            let sig_str = sig.as_deref().unwrap_or("");
            let body_str = body.as_deref().unwrap_or("");
            let embed_text = format!("{}\n{}\n{}", name, sig_str, body_str);
            let emb = self.embedding_provider.embed(&embed_text);
            let blob = hybrid::vec_to_blob(&emb);
            conn.execute(
                "UPDATE symbol_embeddings SET vec = ?1, dim = ?2, model = ?3 WHERE symbol_id = ?4",
                params![blob, dim as i64, model, symbol_id],
            )?;
        }

        Ok(count)
    }

    /// Count symbols with embeddings from a different model than the current provider.
    pub fn stale_embedding_count(&self) -> Result<usize, IndexerError> {
        let conn = self.db.conn();
        let model = self.embedding_provider.model_id();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM symbol_embeddings WHERE model != ?1",
            params![model],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    /// Parse tsconfig.json / jsconfig.json for path aliases.
    /// Handles `compilerOptions.paths` like `{"@/*": ["src/*"]}`.
    fn load_tsconfig_paths(root_path: &Path) -> TsConfigPaths {
        let mut aliases = TsConfigPaths::new();
        
        // Search for tsconfig.json in root and immediate subdirectories
        let candidates = [
            root_path.join("tsconfig.json"),
            root_path.join("jsconfig.json"),
        ];
        
        // Also check common monorepo locations
        let mut all_candidates: Vec<PathBuf> = candidates.to_vec();
        if let Ok(entries) = fs::read_dir(root_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    all_candidates.push(path.join("tsconfig.json"));
                    all_candidates.push(path.join("jsconfig.json"));
                }
            }
        }
        
        for config_path in all_candidates {
            if !config_path.exists() {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&config_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    let base_url = json
                        .get("compilerOptions")
                        .and_then(|c| c.get("baseUrl"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(".");
                    
                    let config_dir = config_path.parent().unwrap_or(root_path);
                    let base_dir = config_dir.join(base_url);
                    
                    // Make base_dir relative to root_path
                    let base_rel = base_dir.strip_prefix(root_path)
                        .unwrap_or(&base_dir)
                        .to_string_lossy()
                        .replace('\\', "/");
                    
                    if let Some(paths) = json
                        .get("compilerOptions")
                        .and_then(|c| c.get("paths"))
                        .and_then(|v| v.as_object())
                    {
                        for (alias, targets) in paths {
                            // Strip trailing /* from alias to get prefix
                            let prefix = alias.trim_end_matches("/*").trim_end_matches('*');
                            
                            if let Some(target_arr) = targets.as_array() {
                                let resolved: Vec<String> = target_arr.iter()
                                    .filter_map(|t| t.as_str())
                                    .map(|t| {
                                        let t = t.trim_end_matches("/*").trim_end_matches('*');
                                        if base_rel.is_empty() || base_rel == "." {
                                            t.to_string()
                                        } else {
                                            format!("{}/{}", base_rel.trim_end_matches('/'), t)
                                        }
                                    })
                                    .collect();
                                
                                if !resolved.is_empty() {
                                    aliases.insert(prefix.to_string(), resolved);
                                }
                            }
                        }
                    }
                }
            }
        }
        
        if !aliases.is_empty() {
            info!("[INDEXER] Loaded {} tsconfig path aliases", aliases.len());
        }
        
        aliases
    }

    /// Parse go.mod to extract the module path prefix.
    /// The "module" directive (e.g., `module github.com/go-chi/chi/v5`) tells us
    /// how to map import paths like `github.com/go-chi/chi/v5/middleware` to local
    /// directory paths like `middleware/`.
    fn load_go_module_prefix(root_path: &Path) -> Option<String> {
        // Search root and immediate subdirectories
        let candidates = std::iter::once(root_path.join("go.mod"))
            .chain(
                fs::read_dir(root_path).ok()
                    .into_iter()
                    .flat_map(|entries| entries.flatten())
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.path().join("go.mod"))
            );

        for go_mod_path in candidates {
            if let Ok(content) = fs::read_to_string(&go_mod_path) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("module ") {
                        let module = trimmed["module ".len()..].trim();
                        if !module.is_empty() {
                            info!("[INDEXER] Go module prefix: {}", module);
                            return Some(module.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    /// Set progress callback
    pub fn set_progress_callback(&mut self, callback: Option<ProgressCallback>) {
        self.progress_callback = callback;
    }

    /// Reload .atlsignore patterns so the next scan respects changes
    pub async fn reload_ignore_filter(&self) -> Result<(), IndexerError> {
        let mut filter = self.filter.lock().await;
        filter.reload().map_err(|e| IndexerError::Path(format!("Failed to reload filter: {}", e)))
    }

    /// Scan the project (initial or full rescan)
    pub async fn scan(&mut self, full_rescan: bool) -> Result<ScanStats, IndexerError> {
        self.scan_filtered(full_rescan, &ScanFilter::default()).await
    }

    /// Scan with an optional focus-profile filter controlling which patterns run
    pub async fn scan_filtered(&mut self, full_rescan: bool, scan_filter: &ScanFilter) -> Result<ScanStats, IndexerError> {
        let start_time = std::time::Instant::now();
        let mut stats = ScanStats::default();
        let scan_matrix_shared = scan_filter.matrix.clone();
        
        info!("Starting scan (full_rescan={})", full_rescan);
        
        // Get all files
        debug!("Acquiring filter lock...");
        let filter = self.filter.lock().await;
        debug!("Got filter lock, walking files...");
        let files: Vec<PathBuf> = filter.walk_files()
            .filter_map(|r| match r {
                Ok(p) => Some(p),
                Err(e) => {
                    tracing::warn!("Skipping file walk entry: {}", e);
                    None
                }
            })
            .collect();
        info!("Found {} files", files.len());
        drop(filter);
        
        stats.files_scanned = files.len();
        
        // Emit start progress
        if let Some(ref callback) = self.progress_callback {
            callback(ScanProgress {
                processed: 0,
                total: files.len(),
                current_file: None,
                duration_ms: 0,
            });
        }
        
        // Get existing files from database
        debug!("Getting existing files from database...");
        let existing_files = self.get_existing_files().await?;
        debug!("Found {} existing files in database", existing_files.len());
        let existing_file_map: HashMap<PathBuf, String> = existing_files
            .into_iter()
            .map(|(path, hash)| (path, hash))
            .collect();
        
        // Determine which files need indexing
        debug!("Computing files to index (full_rescan={})...", full_rescan);
        let files_to_index: Vec<(PathBuf, String)> = if full_rescan {
            files.iter()
                .filter_map(|path| {
                    match self.calculate_file_hash(path) {
                        Ok(hash) => Some((path.clone(), hash)),
                        Err(e) => {
                            tracing::warn!("Skipping file (hash failed): {:?}: {}", path, e);
                            None
                        }
                    }
                })
                .collect()
        } else {
            files.iter()
                .filter_map(|path| {
                    let hash = match self.calculate_file_hash(path) {
                        Ok(h) => h,
                        Err(e) => {
                            tracing::warn!("Skipping file (hash failed): {:?}: {}", path, e);
                            return None;
                        }
                    };
                    let existing_hash = existing_file_map.get(path);
                    if existing_hash != Some(&hash) {
                        Some((path.clone(), hash))
                    } else {
                        None
                    }
                })
                .collect()
        };
        
        info!("{} files need indexing", files_to_index.len());
        
        // Remove deleted files
        debug!("Checking for deleted files...");
        let file_paths: std::collections::HashSet<PathBuf> = files.iter().cloned().collect();
        let mut removed_count = 0;
        for (path, _) in existing_file_map.iter() {
            if !file_paths.contains(path) {
                self.remove_file(path).await?;
                removed_count += 1;
            }
        }
        info!("Removed {} deleted files", removed_count);
        
        // Parallel processing with controlled concurrency
        // Phase 1: Parse files in parallel (CPU-bound)
        // Phase 2: Write to DB sequentially (SQLite constraint)
        let max_concurrent: usize = num_cpus::get().min(8); // Use up to 8 cores
        
        let total_files = files_to_index.len();
        let processed_count = Arc::new(AtomicUsize::new(0));
        let semaphore = Arc::new(Semaphore::new(max_concurrent));
        
        info!("Starting parallel processing of {} files ({} workers)", total_files, max_concurrent);
        
        // Emit initial progress
        if let Some(ref callback) = self.progress_callback {
            callback(ScanProgress {
                processed: 0,
                total: total_files,
                current_file: None,
                duration_ms: 0,
            });
        }
        
        // Phase 1: Parallel file processing (read, parse, detect)
        let mut handles = tokio::task::JoinSet::new();
        
        for (path, hash) in files_to_index {
            let semaphore = Arc::clone(&semaphore);
            let parser_registry = Arc::clone(&self.parser_registry);
            let detector_registry = Arc::clone(&self.detector_registry);
            let processed_count = Arc::clone(&processed_count);
            let _progress_callback = self.progress_callback.as_ref().map(|_| ());
            let total = total_files;
            let _start = start_time.clone();
            let scan_matrix = scan_matrix_shared.clone();
            
            handles.spawn(async move {
                // Acquire semaphore permit to limit concurrency
                let _permit = semaphore.acquire().await.unwrap();
                
                // Determine language
                let ext = path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                let language = Language::from_extension(ext);
                
                if language == Language::Unknown {
                    processed_count.fetch_add(1, Ordering::Relaxed);
                    return Ok::<Option<FileProcessResult>, IndexerError>(None);
                }
                
                // Read file (blocking I/O)
                let content = match fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(e) => {
                        processed_count.fetch_add(1, Ordering::Relaxed);
                        return Err(IndexerError::Io(e));
                    }
                };
                
                let line_count = content.lines().count() as u32;

                // Preprocess C/C++ files to strip macros that confuse tree-sitter
                let parse_content = if crate::preprocess::is_c_family(ext) {
                    crate::preprocess::preprocess_c_macros(&content, Some(&path.to_string_lossy()))
                        .unwrap_or_else(|| content.clone())
                } else {
                    content.clone()
                };

                // Parse file (CPU-bound) - use spawn_blocking for heavy work
                let content_clone = parse_content;
                let path_clone = path.clone();
                let detector_clone = Arc::clone(&detector_registry);
                
                let parse_result = tokio::task::spawn_blocking(move || {
                    // UHPP regex symbols + regex imports (tree-sitter-free)
                    let lang_str = language.as_str();
                    let symbols = uhpp_extract_symbols(&content_clone, Some(lang_str));
                    let imports = extract_imports_regex(&content_clone, language);

                    // Lazy tree-sitter: only parse when calls or pattern detection are needed
                    let patterns = match &scan_matrix {
                        Some(matrix) => detector_clone.get_patterns_for_language_filtered(language, matrix),
                        None => detector_clone.get_patterns_for_language(language),
                    };
                    let needs_tree = !patterns.is_empty()
                        || (matches!(
                            language,
                            Language::Php
                                | crate::types::Language::Dart
                                | crate::types::Language::Swift
                        ) && !symbols.is_empty());
                    let needs_calls_regex = matches!(language, crate::types::Language::Kotlin);

                    let mut calls = Vec::new();
                    let mut issues = Vec::new();

                    if needs_calls_regex && !needs_tree {
                        calls = extract_calls_regex(&content_clone, language);
                    }

                    if needs_tree {
                        match parser_registry.parse(language, &content_clone) {
                            Ok(tree) => {
                                calls = RelationTracker::extract_calls(&tree, &content_clone, language);

                                for pattern in patterns {
                                    if pattern.structural_hints.as_ref()
                                        .and_then(|h| h.tree_sitter_query.as_ref())
                                        .is_some()
                                    {
                                        let pattern_start = std::time::Instant::now();
                                        let detector = TreeSitterDetector::new(pattern.clone(), language);
                                        match detector.detect(&content_clone, &tree) {
                                            Ok(mut detected) => {
                                                let elapsed = pattern_start.elapsed();
                                                if elapsed.as_millis() > 500 {
                                                    tracing::warn!(
                                                        "Slow pattern {:?} took {}ms on {:?}",
                                                        pattern.id, elapsed.as_millis(), path_clone
                                                    );
                                                }
                                                for issue in &mut detected {
                                                    issue.file_path = Some(path_clone.to_string_lossy().to_string());
                                                }
                                                issues.extend(detected);
                                            }
                                            Err(e) => {
                                                tracing::warn!(
                                                    "Pattern {:?} failed on {:?}: {} — skipping this pattern",
                                                    pattern.id, path_clone, e
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                let lines = content_clone.lines().count();
                                tracing::warn!(
                                    "Parse failed for {:?} ({} lines, lang={:?}): {} — symbols already indexed via UHPP, skipping calls/patterns",
                                    path_clone, lines, language, e
                                );
                            }
                        }
                    }

                    Ok::<ParseResult, IndexerError>(ParseResult {
                        symbols,
                        imports,
                        calls,
                        issues,
                    })
                }).await.map_err(|e| IndexerError::Parser(format!("Task join error: {}", e)))??;
                
                let count = processed_count.fetch_add(1, Ordering::Relaxed) + 1;
                
                // Log progress every 10% or so
                if count % (total.max(10) / 10).max(1) == 0 || count == total {
                    debug!("Parsed {}/{} files", count, total);
                }
                
                Ok(Some(FileProcessResult {
                    path,
                    hash,
                    language,
                    line_count,
                    parse_result,
                }))
            });
        }
        
        // Collect results as parse tasks complete so progress callbacks are not
        // blocked behind an earlier slow file in spawn order.
        let mut results = Vec::with_capacity(total_files);
        let mut completed_count = 0usize;
        
        while let Some(joined) = handles.join_next().await {
            completed_count += 1;
            match joined {
                Ok(Ok(Some(result))) => results.push(result),
                Ok(Ok(None)) => {} // Skipped (unknown language)
                Ok(Err(e)) => {
                    stats.errors += 1;
                    stats.error_details.push((PathBuf::new(), e.to_string()));
                }
                Err(e) => {
                    stats.errors += 1;
                    stats.error_details.push((PathBuf::new(), format!("Task panic: {}", e)));
                }
            }

            if let Some(ref callback) = self.progress_callback {
                callback(ScanProgress {
                    processed: completed_count,
                    total: total_files,
                    current_file: None,
                    duration_ms: start_time.elapsed().as_millis() as u64,
                });
            }
        }
        
        // Final progress update for parse phase
        if let Some(ref callback) = self.progress_callback {
            callback(ScanProgress {
                processed: total_files,
                total: total_files,
                current_file: None,
                duration_ms: start_time.elapsed().as_millis() as u64,
            });
        }
        
        info!("Parse phase complete: {} files parsed, {} errors", results.len(), stats.errors);
        
        // Phase 2: Sequential DB writes (fast, no progress updates needed)
        debug!("Writing {} files to database...", results.len());
        
        // Collect import data before consuming results (needed for Phase 3)
        let import_work: Vec<(PathBuf, Language, Vec<ImportInfo>)> = results.iter()
            .filter(|r| !r.parse_result.imports.is_empty())
            .map(|r| (r.path.clone(), r.language, r.parse_result.imports.clone()))
            .collect();
        
        for result in results {
            match self.write_file_to_db(&result).await {
                Ok(_) => {
                    stats.files_indexed += 1;
                }
                Err(e) => {
                    warn!("DB write error for {:?}: {}", result.path, e);
                    stats.errors += 1;
                    stats.error_details.push((result.path, e.to_string()));
                }
            }
        }
        
        info!("DB writes complete: {} files", stats.files_indexed);
        
        // Phase 3: Re-resolve imports now that ALL files are in the DB.
        // Phase 2 resolves imports per-file as they're written, but targets
        // processed later in the batch won't exist yet. This pass catches those.
        if !import_work.is_empty() {
            info!("Resolving import relations for {} files...", import_work.len());
            let conn = self.db.conn();
            let mut resolved_count = 0u32;
            for (path, language, imports) in &import_work {
                let canonical_path = match path.canonicalize() {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let relative_path = match canonical_path.strip_prefix(&self.root_path) {
                    Ok(p) => p.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                let file_id: Option<i64> = conn.query_row(
                    "SELECT id FROM files WHERE path = ?1",
                    params![relative_path],
                    |row| row.get(0),
                ).optional().unwrap_or(None);
                
                if let Some(file_id) = file_id {
                    if let Err(e) = conn.execute(
                        "DELETE FROM file_relations WHERE from_file_id = ?1",
                        params![file_id],
                    ) {
                        tracing::warn!("Failed to clear stale relations for file_id {}: {}", file_id, e);
                    }
                    if self.resolve_and_store_imports(&conn, file_id, &relative_path, imports, *language).is_ok() {
                        resolved_count += 1;
                    }
                }
            }
            // Summary: count relations created
            let total_relations: i64 = conn.query_row(
                "SELECT COUNT(*) FROM file_relations",
                [],
                |row| row.get(0),
            ).unwrap_or(0);
            info!("Import resolution complete: {}/{} files, {} total file_relations created", resolved_count, import_work.len(), total_relations);
        }
        
        // Phase 4: Refresh file_importance scores from resolved relations + entry point detection.
        //
        // Re-export-only modules (`mod.rs` / barrel `index.ts` that contain only
        // `pub use` / `mod foo;` / `export { X } from './x'`) used to dominate
        // `importance_score` by inherited import_count even though they hold no
        // logic. We detect them by "file has no symbols other than `mod` /
        // `namespace`" and both drop the `is_entry_point` flag and collapse the
        // score to a minimum floor so real modules surface first.
        {
            let conn = self.db.conn();
            if let Err(e) = conn.execute_batch(
                r#"
                DELETE FROM file_importance;
                INSERT INTO file_importance (file_id, import_count, is_entry_point, importance_score)
                SELECT
                    f.id,
                    COALESCE(ic.cnt, 0),
                    CASE WHEN (
                        f.path LIKE '%/main.ts' OR f.path LIKE '%/main.tsx' OR
                        f.path LIKE '%/main.rs' OR f.path LIKE '%/main.go' OR
                        f.path LIKE '%/main.py' OR f.path LIKE '%/main.java' OR
                        f.path LIKE '%/index.ts' OR f.path LIKE '%/index.tsx' OR
                        f.path LIKE '%/index.js' OR f.path LIKE '%/index.jsx' OR
                        f.path LIKE '%/App.tsx' OR f.path LIKE '%/App.ts' OR
                        f.path LIKE '%/App.jsx' OR f.path LIKE '%/App.js' OR
                        f.path LIKE '%/lib.rs' OR f.path LIKE '%/__main__.py' OR
                        f.path LIKE '%/app.py'
                    ) AND EXISTS (
                        SELECT 1 FROM symbols s
                        WHERE s.file_id = f.id
                          AND s.kind NOT IN ('mod', 'ns', 'namespace', 'module')
                    ) THEN 1 ELSE 0 END,
                    CASE WHEN NOT EXISTS (
                        SELECT 1 FROM symbols s
                        WHERE s.file_id = f.id
                          AND s.kind NOT IN ('mod', 'ns', 'namespace', 'module')
                    ) THEN 0.1
                    ELSE 1.0 + (COALESCE(ic.cnt, 0) * 0.1)
                    END
                FROM files f
                LEFT JOIN (
                    SELECT to_file_id, COUNT(*) as cnt
                    FROM file_relations
                    WHERE type = 'IMPORTS'
                    GROUP BY to_file_id
                ) ic ON f.id = ic.to_file_id;
                "#,
            ) {
                tracing::warn!("Failed to refresh file_importance: {}", e);
            } else {
                info!("File importance scores refreshed (with entry point + reexport-stub detection)");
            }
        }

        // Emit complete progress
        if let Some(ref callback) = self.progress_callback {
            callback(ScanProgress {
                processed: total_files,
                total: total_files,
                current_file: None,
                duration_ms: start_time.elapsed().as_millis() as u64,
            });
        }
        
        info!("Scan complete: {} files indexed, {} errors (workers={})", 
              stats.files_indexed, stats.errors, max_concurrent);
        Ok(stats)
    }

    /// Index a specific file (incremental update)
    pub async fn index_file<P: AsRef<Path>>(
        &self,
        path: P,
        hash: &str,
        policy: IncrementalParsePolicy,
    ) -> Result<(), IndexerError> {
        let path = path.as_ref();
        
        // Determine language from extension
        let language = self.get_language_from_path(path);
        if language == Language::Unknown {
            return Ok(()); // Skip unsupported languages
        }
        
        // Read file content
        let content = fs::read_to_string(path)
            .map_err(|e| IndexerError::Io(e))?;
        
        let parse_result = self
            .parse_file(&content, language, path, policy.run_structural_patterns)
            .await?;
        
        self.write_indexed_file_to_db(
            path,
            hash,
            language,
            content.lines().count() as u32,
            &parse_result,
            policy.run_structural_patterns,
        )
        .await?;
        
        Ok(())
    }

    /// Handle file change event from watcher
    pub async fn on_file_change<P: AsRef<Path>>(&self, path: P) -> Result<(), IndexerError> {
        let path = path.as_ref();
        let hash = self.calculate_file_hash(path)?;
        self.index_file(path, &hash, IncrementalParsePolicy::default())
            .await
    }

    /// Handle file create event from watcher
    pub async fn on_file_create<P: AsRef<Path>>(&self, path: P) -> Result<(), IndexerError> {
        self.on_file_change(path).await
    }

    /// Handle file delete event from watcher
    pub async fn on_file_delete<P: AsRef<Path>>(&self, path: P) -> Result<(), IndexerError> {
        self.remove_file(path).await
    }

    /// Start watching for file changes
    pub async fn start_watching(&mut self, debounce_ms: u64) -> Result<(), IndexerError> {
        let (watcher, handle) = Watcher::new(&self.root_path, debounce_ms)?;
        
        // Start watcher in background
        // Note: Event handling will be done by the caller via WatcherHandle
        // The watcher just emits events, and the caller can process them
        self.watcher = Some(handle);
        
        tokio::spawn(async move {
            if let Err(e) = watcher.watch().await {
                error!("Watcher error: {}", e);
            }
        });
        
        Ok(())
    }

    /// Stop watching for file changes
    pub async fn stop_watching(&mut self) {
        if let Some(handle) = self.watcher.take() {
            handle.stop().await;
        }
    }

    // Private helper methods

    /// Write a processed file result to the database
    async fn write_file_to_db(&self, result: &FileProcessResult) -> Result<(), IndexerError> {
        self.write_indexed_file_to_db(
            &result.path,
            &result.hash,
            result.language,
            result.line_count,
            &result.parse_result,
            true,
        )
        .await
    }

    /// Atomically upsert a file and replace all derived index rows for it.
    async fn write_indexed_file_to_db(
        &self,
        path: &Path,
        hash: &str,
        language: Language,
        line_count: u32,
        parse_result: &ParseResult,
        update_code_issues: bool,
    ) -> Result<(), IndexerError> {
        let path_str = self.relative_db_path(path)?;
        let mut conn = self.db.conn();
        let tx = conn.transaction()?;

        let file_id = Self::upsert_file_in_conn(&tx, &path_str, hash, language, line_count)?;
        self.store_parse_result_in_conn(
            &tx,
            file_id,
            parse_result,
            language,
            update_code_issues,
        )?;

        tx.commit()?;
        Ok(())
    }

    fn relative_db_path(&self, path: &Path) -> Result<String, IndexerError> {
        let canonical_path = path
            .canonicalize()
            .map_err(|e| IndexerError::Path(format!("Failed to canonicalize path: {}", e)))?;
        let relative_path = canonical_path.strip_prefix(&self.root_path).map_err(|_| {
            IndexerError::Path(format!(
                "Path not under root: {:?} not under {:?}",
                canonical_path, self.root_path
            ))
        })?;

        Ok(relative_path.to_string_lossy().replace('\\', "/"))
    }

    fn upsert_file_in_conn(
        conn: &rusqlite::Connection,
        path_str: &str,
        hash: &str,
        language: Language,
        line_count: u32,
    ) -> Result<i64, IndexerError> {
        conn.execute(
            "INSERT INTO files (path, hash, language, line_count, last_indexed)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))
             ON CONFLICT(path) DO UPDATE SET
                hash = excluded.hash,
                language = excluded.language,
                line_count = excluded.line_count,
                last_indexed = datetime('now')",
            params![path_str, hash, language.as_str(), line_count],
        )?;

        let file_id: i64 = conn.query_row(
            "SELECT id FROM files WHERE path = ?1",
            params![path_str],
            |row| row.get(0),
        )?;

        Ok(file_id)
    }

    async fn get_existing_files(&self) -> Result<Vec<(PathBuf, String)>, IndexerError> {
        // Query database for existing files (stored as relative paths)
        let conn = self.db.conn();
        let mut stmt = conn.prepare("SELECT path, hash FROM files")?;
        let rows = stmt.query_map(params![], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
            ))
        })?;
        
        let mut files = Vec::new();
        for row in rows {
            let (rel_path, hash) = row?;
            // Convert relative path back to absolute by joining with root_path
            let abs_path = self.root_path.join(&rel_path);
            files.push((abs_path, hash));
        }
        Ok(files)
    }

    fn calculate_file_hash<P: AsRef<Path>>(&self, path: P) -> Result<String, IndexerError> {
        let content = fs::read(path.as_ref())
            .map_err(|e| IndexerError::Io(e))?;
        let mut hasher = Sha256::new();
        hasher.update(&content);
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn get_language_from_path<P: AsRef<Path>>(&self, path: P) -> Language {
        let ext = path.as_ref()
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        Language::from_extension(ext)
    }

    async fn parse_file(
        &self,
        content: &str,
        language: Language,
        path: &Path,
        run_structural_patterns: bool,
    ) -> Result<ParseResult, IndexerError> {
        // UHPP regex symbols + regex imports (tree-sitter-free)
        let lang_str = language.as_str();
        let symbols = uhpp_extract_symbols(content, Some(lang_str));
        let imports = extract_imports_regex(content, language);

        // Align with parallel scan (scan_filtered): tree-sitter for calls and/or patterns
        let patterns = self.detector_registry.get_patterns_for_language(language);
        let needs_tree = !patterns.is_empty()
            || (matches!(
                language,
                Language::Php | Language::Dart | Language::Swift
            ) && !symbols.is_empty());
        let needs_calls_regex = matches!(language, Language::Kotlin);

        let mut calls = Vec::new();
        let mut issues = Vec::new();

        if needs_calls_regex && !needs_tree {
            calls = extract_calls_regex(content, language);
        }

        if needs_tree {
            let tree = self.parser_registry.parse(language, content)
                .map_err(|e| IndexerError::Parser(format!("Parse error: {}", e)))?;

            calls = RelationTracker::extract_calls(&tree, content, language);

            if run_structural_patterns {
                for pattern in patterns {
                    if pattern.structural_hints.as_ref()
                        .and_then(|h| h.tree_sitter_query.as_ref())
                        .is_some()
                    {
                        let detector = TreeSitterDetector::new(pattern.clone(), language);
                        match detector.detect(content, &tree) {
                            Ok(mut detected) => {
                                for issue in &mut detected {
                                    issue.file_path = Some(path.to_string_lossy().to_string());
                                }
                                issues.extend(detected);
                            }
                            Err(e) => {
                                debug!("Pattern {} detection failed: {}", pattern.id, e);
                            }
                        }
                    }
                }
            }
        }

        Ok(ParseResult {
            symbols,
            imports,
            calls,
            issues,
        })
    }

    /// Resolve import paths to file IDs and store as file_relations.
    /// Uses language-specific strategies:
    /// - JS/TS: relative imports (`.`-prefixed) resolved against file dir
    /// - Python: dotted module names converted to paths
    /// - Rust: `crate::`, `super::`, `self::` prefixes resolved
    /// - Go: full module path matched by last segment
    /// - C/C++: quoted includes resolved relative to file dir; system includes skipped
    /// - C#/Java: dotted namespaces/packages converted to paths
    fn resolve_and_store_imports(
        &self,
        conn: &rusqlite::Connection,
        from_file_id: i64,
        file_rel_path: &str,
        imports: &[crate::indexer::ImportInfo],
        language: Language,
    ) -> Result<(), IndexerError> {

        let file_dir = Path::new(file_rel_path)
            .parent()
            .unwrap_or_else(|| Path::new(""));

        let extensions: &[&str] = match language {
            Language::TypeScript | Language::JavaScript => &[
                "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
                "/index.ts", "/index.tsx", "/index.js", "/index.jsx",
            ],
            Language::Rust => &["", ".rs", "/mod.rs"],
            Language::Python => &["", ".py", "/__init__.py"],
            Language::Go => &["", ".go"],
            Language::Java => &["", ".java"],
            Language::C => &["", ".c", ".h"],
            Language::Cpp => &["", ".cpp", ".hpp", ".h", ".cc", ".cxx"],
            Language::CSharp => &["", ".cs"],
            Language::Swift => &["", ".swift"],
            Language::Php => &["", ".php", ".phtml"],
            Language::Ruby => &["", ".rb"],
            Language::Scala => &["", ".scala", ".sc"],
            Language::Dart => &["", ".dart"],
            _ => &[""],
        };

        let strip_extensions: &[&str] = match language {
            Language::TypeScript | Language::JavaScript => &[
                ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
            ],
            _ => &[],
        };

        for import in imports {
            let module = &import.module;

            let candidates = self.build_import_candidates(module, file_dir, language);
            if candidates.is_empty() {
                continue;
            }

            let mut resolved_id: Option<i64> = None;

            for base_str in &candidates {
                let stripped = Self::strip_known_extension(base_str, strip_extensions);
                let bases_to_try: Vec<&str> = if stripped != base_str.as_str() {
                    vec![base_str.as_str(), &stripped]
                } else {
                    vec![base_str.as_str()]
                };

                for base in &bases_to_try {
                    for ext in extensions {
                        let candidate = format!("{}{}", base, ext);

                        let id: Option<i64> = conn.query_row(
                            "SELECT id FROM files WHERE path = ?1",
                            params![candidate],
                            |row| row.get(0),
                        ).optional()?;

                        if id.is_some() {
                            resolved_id = id;
                            break;
                        }
                    }
                    if resolved_id.is_some() {
                        break;
                    }
                }
                if resolved_id.is_some() {
                    break;
                }
            }

            // LIKE fallback: if exact matching failed, try suffix match
            if resolved_id.is_none() && !candidates.is_empty() {
                let last_candidate = candidates.last().unwrap();
                let stripped = Self::strip_known_extension(last_candidate, strip_extensions);
                let suffix = if stripped != last_candidate.as_str() { &stripped } else { last_candidate.as_str() };
                if suffix.len() > 2 {
                    for ext in extensions {
                        let like_pattern = format!("%/{}{}", suffix, ext);
                        resolved_id = conn.query_row(
                            "SELECT id FROM files WHERE path LIKE ?1 LIMIT 1",
                            params![like_pattern],
                            |row| row.get(0),
                        ).optional()?;
                        if resolved_id.is_some() {
                            break;
                        }
                    }
                }
            }

            if let Some(to_file_id) = resolved_id {
                if to_file_id != from_file_id {
                    conn.execute(
                        "INSERT OR IGNORE INTO file_relations (from_file_id, to_file_id, type) VALUES (?1, ?2, ?3)",
                        params![from_file_id, to_file_id, FileRelationType::Imports.as_str()],
                    )?;
                }
            }
        }

        Ok(())
    }

    fn strip_known_extension(path: &str, extensions: &[&str]) -> String {
        for ext in extensions {
            if path.ends_with(ext) {
                return path[..path.len() - ext.len()].to_string();
            }
        }
        path.to_string()
    }

    /// Build candidate base paths for an import module based on language conventions.
    /// Returns normalized path strings relative to the project root.
    fn build_import_candidates(
        &self,
        module: &str,
        file_dir: &Path,
        language: Language,
    ) -> Vec<String> {
        match language {
            // JS/TS: resolve relative imports and path aliases
            Language::TypeScript | Language::JavaScript => {
                if module.starts_with('.') {
                    // Relative import
                    let base = file_dir.join(module);
                    vec![Self::normalize_import_path(&base.to_string_lossy().replace('\\', "/"))]
                } else {
                    // Try path aliases from tsconfig.json
                    let mut candidates = Vec::new();
                    for (prefix, targets) in &self.ts_path_aliases {
                        if module.starts_with(prefix.as_str()) {
                            let remainder = &module[prefix.len()..];
                            // Strip leading / if present
                            let remainder = remainder.strip_prefix('/').unwrap_or(remainder);
                            for target in targets {
                                let resolved = if remainder.is_empty() {
                                    target.clone()
                                } else {
                                    format!("{}/{}", target, remainder)
                                };
                                candidates.push(Self::normalize_import_path(&resolved));
                            }
                        }
                    }
                    // Skip bare package imports (react, lodash, etc.) — they won't resolve
                    candidates
                }
            }

            // Python: `os.path` -> `os/path`; relative `.` imports resolved against file dir
            Language::Python => {
                if module.starts_with('.') {
                    // Count leading dots for relative depth
                    let dot_count = module.chars().take_while(|c| *c == '.').count();
                    let remainder = &module[dot_count..];
                    let mut dir = file_dir.to_path_buf();
                    // Each dot beyond the first goes up one directory
                    for _ in 1..dot_count {
                        dir = dir.parent().unwrap_or(&dir).to_path_buf();
                    }
                    let subpath = remainder.replace('.', "/");
                    let base = if subpath.is_empty() {
                        dir.to_string_lossy().replace('\\', "/")
                    } else {
                        let joined = dir.join(&subpath);
                        joined.to_string_lossy().replace('\\', "/")
                    };
                    vec![Self::normalize_import_path(&base)]
                } else {
                    // Absolute import: `os.path` -> try `os/path` from project root
                    let path = module.replace('.', "/");
                    vec![path]
                }
            }

            // Rust: `crate::types::Language` -> `src/types/Language`
            Language::Rust => {
                let path = if module.starts_with("crate::") {
                    // `crate::` resolves to `src/` by convention
                    let remainder = &module["crate::".len()..];
                    format!("src/{}", remainder.replace("::", "/"))
                } else if module.starts_with("super::") {
                    let remainder = &module["super::".len()..];
                    let parent = file_dir.parent().unwrap_or(file_dir);
                    let base = parent.join(&remainder.replace("::", "/"));
                    base.to_string_lossy().replace('\\', "/")
                } else if module.starts_with("self::") {
                    let remainder = &module["self::".len()..];
                    let base = file_dir.join(&remainder.replace("::", "/"));
                    base.to_string_lossy().replace('\\', "/")
                } else {
                    // External crate or std -- skip
                    return Vec::new();
                };
                // Strip brace groups for path resolution: `src/types/{A, B}` -> `src/types`
                let clean = if let Some(brace_pos) = path.find('{') {
                    path[..brace_pos].trim_end_matches("::").trim_end_matches('/').to_string()
                } else {
                    path
                };
                vec![Self::normalize_import_path(&clean)]
            }

            // Go: resolve module-relative imports using go.mod module prefix,
            // then fall back to last-segment matching
            Language::Go => {
                let parts: Vec<&str> = module.split('/').collect();
                let mut candidates = Vec::new();

                // If we have a go.mod module prefix, strip it to get a local relative path.
                // e.g., module = "github.com/go-chi/chi/v5/middleware"
                //        prefix = "github.com/go-chi/chi/v5"
                //        local  = "middleware"
                if let Some(ref prefix) = self.go_module_prefix {
                    if module.starts_with(prefix.as_str()) {
                        let remainder = module[prefix.len()..].trim_start_matches('/');
                        if !remainder.is_empty() {
                            candidates.push(remainder.to_string());
                        } else {
                            // Import of the module root itself — try "." or package name
                            candidates.push(".".to_string());
                        }
                    }
                }

                // Full path as-is (for local packages in monorepo)
                candidates.push(module.to_string());
                // Just the last segment (common for std lib and local packages)
                if parts.len() > 1 {
                    if let Some(last) = parts.last() {
                        candidates.push(last.to_string());
                    }
                }
                candidates
            }

            // C/C++: `"local.h"` resolved relative to file dir; skip system `<>` includes
            Language::C | Language::Cpp => {
                // System includes (already stripped of <> by extractor) -- heuristic: has no path sep and no `.h`-like extension from project
                // We attempt resolution for all includes; system ones just won't match
                let base = file_dir.join(module);
                let normalized = Self::normalize_import_path(&base.to_string_lossy().replace('\\', "/"));
                // Also try from project root for project-wide includes
                let mut candidates = vec![normalized];
                candidates.push(module.to_string());
                candidates
            }

            // C#: `System.Collections.Generic` -> `System/Collections/Generic`
            Language::CSharp => {
                let path = module.replace('.', "/");
                vec![path]
            }

            // Java: `java.util.List` -> `java/util/List`
            Language::Java => {
                let path = module.replace('.', "/");
                vec![path]
            }

            // Swift: import Foundation -> Foundation; import Module.Sub
            Language::Swift => {
                let path = module.replace('.', "/");
                vec![path]
            }

            // PHP: use App\Models\User -> App/Models
            Language::Php => {
                let path = module.replace('\\', "/");
                vec![path]
            }

            // Ruby: require 'foo/bar' -> foo/bar
            Language::Ruby => {
                vec![module.to_string()]
            }

            // Scala: import foo.bar -> foo/bar
            Language::Scala => {
                let path = module.replace('.', "/");
                vec![path]
            }

            // Dart: import 'package:foo/bar.dart' -> package:foo/bar or bar
            Language::Dart => {
                let path = module.replace('.', "/");
                vec![path.clone(), format!("{}.dart", path)]
            }

            _ => Vec::new(),
        }
    }

    /// Normalize a relative import path: remove `.` segments, resolve `..`
    fn normalize_import_path(path: &str) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for seg in path.split('/') {
            match seg {
                "." | "" => {}
                ".." => { parts.pop(); }
                other => parts.push(other),
            }
        }
        parts.join("/")
    }

    fn store_parse_result_in_conn(
        &self,
        conn: &rusqlite::Connection,
        file_id: i64,
        result: &ParseResult,
        language: Language,
        update_code_issues: bool,
    ) -> Result<(), IndexerError> {
        // Clear stale data for this file before re-inserting
        conn.execute("DELETE FROM symbols WHERE file_id = ?1", params![file_id])?;
        conn.execute("DELETE FROM calls WHERE file_id = ?1", params![file_id])?;
        
        // Clear stale code_signatures for this file's symbols
        conn.execute(
            "DELETE FROM code_signatures WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?1)",
            params![file_id],
        )?;

        // Store symbols and populate code_signatures for similarity search
        for symbol in &result.symbols {
            let metadata_json = serde_json::to_string(&symbol.metadata)
                .map_err(|e| IndexerError::Parser(format!("Failed to serialize metadata: {}", e)))?;
            
            conn.execute(
                "INSERT INTO symbols (file_id, name, kind, line, end_line, signature, complexity, metadata, body_preview) 
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    file_id,
                    symbol.name,
                    symbol.kind.as_str(),
                    symbol.line,
                    symbol.end_line,
                    symbol.signature,
                    symbol.complexity.unwrap_or(0),
                    metadata_json,
                    symbol.body_preview.as_deref().unwrap_or("")
                ],
            )?;

            // Populate code_signatures for function-like symbols with signatures
            if let Some(ref sig) = symbol.signature {
                if !sig.is_empty()
                    && matches!(
                        symbol.kind.as_str(),
                        "function" | "method" | "arrow_function" | "generator_function"
                            | "constructor" | "macro"
                    )
                {
                    let symbol_id = conn.last_insert_rowid();
                    let normalized = Self::normalize_signature(sig);
                    let hash = Self::compute_signature_hash(&normalized);
                    let body_prev = symbol.body_preview.as_deref().unwrap_or("");
                    let norm_body = Self::normalize_body_identifiers(body_prev);
                    let norm_body_hash = if norm_body.len() >= 12 {
                        Self::compute_signature_hash(&norm_body)
                    } else {
                        String::new()
                    };
                    conn.execute(
                        "INSERT INTO code_signatures (symbol_id, normalized_signature, hash, normalized_body_hash) VALUES (?1, ?2, ?3, ?4)",
                        params![symbol_id, normalized, hash, norm_body_hash],
                    )?;

                    let embed_text = format!("{}\n{}\n{}", symbol.name, sig.as_str(), body_prev);
                    let emb = self.embedding_provider.embed(&embed_text);
                    let blob = hybrid::vec_to_blob(&emb);
                    conn.execute(
                        "INSERT INTO symbol_embeddings (symbol_id, dim, model, vec) VALUES (?1, ?2, ?3, ?4)",
                        params![symbol_id, self.embedding_provider.dim() as i64, self.embedding_provider.model_id(), blob],
                    )?;
                }
            }
        }
        
        // Clear stale file_relations for this file before re-inserting
        conn.execute(
            "DELETE FROM file_relations WHERE from_file_id = ?1",
            params![file_id],
        )?;
        
        // Resolve imports to file IDs and store as file_relations
        let file_path: String = conn.query_row(
            "SELECT path FROM files WHERE id = ?1",
            params![file_id],
            |row| row.get(0),
        )?;
        self.resolve_and_store_imports(&conn, file_id, &file_path, &result.imports, language)?;
        
        // Store calls
        for call in &result.calls {
            conn.execute(
                "INSERT INTO calls (file_id, name, line, scope_name) VALUES (?1, ?2, ?3, ?4)",
                params![file_id, call.name, call.line, call.scope_name],
            )?;
        }

        // Clear stale symbol_relations originating from this file's symbols
        conn.execute(
            "DELETE FROM symbol_relations WHERE from_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?1)",
            params![file_id],
        )?;

        // Resolve calls to symbol_relations so call_hierarchy can traverse them.
        // For each call, match the caller (scope_name in this file) and callee
        // (by name across all files) and create a CALLS relation.
        for call in &result.calls {
            // Resolve caller: try scope_name first, fall back to first symbol in file
            let caller_id: Option<i64> = if let Some(ref scope) = call.scope_name {
                conn.query_row(
                    "SELECT id FROM symbols WHERE file_id = ?1 AND name = ?2 LIMIT 1",
                    params![file_id, scope],
                    |row| row.get(0),
                ).optional()?
            } else {
                // Fallback: use the first function/class symbol in this file as the caller
                // (covers top-level calls and anonymous arrow functions)
                conn.query_row(
                    "SELECT id FROM symbols WHERE file_id = ?1 AND kind IN ('function', 'method', 'arrow_function', 'class', 'variable') ORDER BY line LIMIT 1",
                    params![file_id],
                    |row| row.get(0),
                ).optional()?
            };

            // Resolve callee: broader kind filter to catch const arrow fns and exports
            // Also handle dotted calls like "obj.method" by extracting the last segment
            let call_name = call.name.rsplit('.').next().unwrap_or(&call.name);
            let callee_id: Option<i64> = conn.query_row(
                "SELECT id FROM symbols WHERE name = ?1 AND kind IN ('function', 'method', 'arrow_function', 'variable', 'export') LIMIT 1",
                params![call_name],
                |row| row.get(0),
            ).optional()?;

            if let (Some(from_id), Some(to_id)) = (caller_id, callee_id) {
                if from_id != to_id {
                    conn.execute(
                        "INSERT OR IGNORE INTO symbol_relations (from_symbol_id, to_symbol_id, type) VALUES (?1, ?2, 'CALLS')",
                        params![from_id, to_id],
                    )?;
                }
            }
        }
        
        if update_code_issues {
            // Clear existing issues for this file before inserting new ones
            conn.execute(
                "DELETE FROM code_issues WHERE file_id = ?1",
                params![file_id],
            )?;
            
            // Store issues detected by pattern detectors (deduplicated)
            let mut seen_issues: HashSet<(String, u32, u32)> = HashSet::new();
            for issue in &result.issues {
                // Deduplicate by (pattern_id, line, col) per file
                let key = (issue.pattern_id.clone(), issue.line, issue.col);
                if !seen_issues.insert(key) {
                    continue;
                }

                let category = self.detector_registry
                    .get_pattern(&issue.pattern_id)
                    .map(|p| p.category.to_lowercase())
                    .unwrap_or_else(|| "code_quality".to_string());
                
                conn.execute(
                    "INSERT INTO code_issues (file_id, type, severity, message, line, col, end_line, end_col, category) 
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        file_id,
                        issue.pattern_id,
                        format!("{:?}", issue.severity).to_lowercase(),
                        issue.message,
                        issue.line,
                        issue.col,
                        issue.end_line,
                        issue.end_col,
                        category
                    ],
                )?;
            }
        }
        
        Ok(())
    }

    /// Normalize a function signature for similarity comparison.
    /// Strips parameter names, normalizes whitespace, and lowercases type names
    /// so that structurally equivalent signatures produce the same string.
    /// Replace identifiers so renamed clones share a hash (Type-2 structural clone).
    fn normalize_body_identifiers(body: &str) -> String {
        IDENT_PLACEHOLDER_RE.replace_all(body, "id").to_string()
    }

    fn normalize_signature(sig: &str) -> String {
        sig.chars()
            // Collapse all whitespace runs to a single space
            .fold(String::with_capacity(sig.len()), |mut acc, c| {
                if c.is_whitespace() {
                    if !acc.ends_with(' ') {
                        acc.push(' ');
                    }
                } else {
                    acc.push(c);
                }
                acc
            })
            .to_lowercase()
            .trim()
            .to_string()
    }

    /// Compute a short hash of a normalized signature for fast pre-filtering.
    fn compute_signature_hash(normalized: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        format!("{:x}", hasher.finalize())[..16].to_string()
    }

    async fn remove_file<P: AsRef<Path>>(&self, path: P) -> Result<(), IndexerError> {
        // Try to get relative path - for paths from DB, they're already relative
        // For paths from walk_files, we need to strip the prefix
        let path_ref = path.as_ref();
        let relative_path = if path_ref.is_absolute() {
            // Try to canonicalize and strip prefix
            let canonical = path_ref.canonicalize()
                .unwrap_or_else(|_| path_ref.to_path_buf());
            canonical.strip_prefix(&self.root_path)
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|_| path_ref.to_path_buf())
        } else {
            // Already relative
            path_ref.to_path_buf()
        };
        let relative_path = relative_path.as_path();
        // Always use forward slashes for cross-platform consistency
        let path_str = relative_path.to_string_lossy().replace('\\', "/");
        
        let mut conn = self.db.conn();
        let tx = conn.transaction()?;
        
        // Get file ID
        let file_id: Option<i64> = tx.query_row(
            "SELECT id FROM files WHERE path = ?1",
            params![path_str],
            |row| row.get(0),
        ).optional()?;
        
        if let Some(file_id) = file_id {
            // Delete related data (cascade delete should handle this, but we'll be explicit)
            tx.execute("DELETE FROM symbols WHERE file_id = ?1", params![file_id])?;
            tx.execute("DELETE FROM code_issues WHERE file_id = ?1", params![file_id])?;
            tx.execute("DELETE FROM file_relations WHERE from_file_id = ?1 OR to_file_id = ?1", params![file_id])?;
            tx.execute("DELETE FROM files WHERE id = ?1", params![file_id])?;
        }

        tx.commit()?;
        
        Ok(())
    }
}

#[cfg(test)]
mod incremental_policy_tests {
    use super::IncrementalParsePolicy;

    #[test]
    fn default_runs_structural_patterns() {
        assert!(IncrementalParsePolicy::default().run_structural_patterns);
    }

    #[test]
    fn skip_structural_patterns_opt_out() {
        assert!(!IncrementalParsePolicy::skip_structural_patterns().run_structural_patterns);
    }
}
