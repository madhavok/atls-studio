use atls_core::{
    Database, Indexer, ParserRegistry, QueryEngine, DetectorRegistry,
    WatcherHandle,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ProjectError {
    #[error("Database error: {0}")]
    Database(#[from] atls_core::DatabaseError),
    #[error("Indexer error: {0}")]
    Indexer(#[from] atls_core::IndexerError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Path error: {0}")]
    Path(String),
}

/// Project instance for a root path
#[allow(dead_code)]
pub struct Project {
    root_path: PathBuf,
    db: Arc<Database>,
    indexer: Arc<Mutex<Indexer>>,
    query_engine: Arc<QueryEngine>,
    detector_registry: Arc<DetectorRegistry>,
    parser_registry: Arc<ParserRegistry>,
    watcher_handle: Option<WatcherHandle>,
}

impl Project {
    /// Create or open a project at the given root path
    pub async fn open<P: AsRef<Path>>(root_path: P) -> Result<Self, ProjectError> {
        let root_path = root_path.as_ref().canonicalize()
            .map_err(|e| ProjectError::Path(format!("Failed to canonicalize path: {}", e)))?;

        info!("Opening project at: {:?}", root_path);

        // Find patterns directory first (needed for Indexer)
        let patterns_dir: Option<PathBuf> = {
            let patterns_path = root_path.join("patterns");
            if patterns_path.exists() {
                Some(patterns_path)
            } else {
                let atls_patterns = root_path.join("atls-rs").join("patterns");
                if atls_patterns.exists() {
                    Some(atls_patterns)
                } else {
                    root_path.parent()
                        .and_then(|p| p.join("patterns").canonicalize().ok())
                        .filter(|p| p.exists())
                }
            }
        };
        
        if let Some(ref dir) = patterns_dir {
            info!("Using patterns from: {:?}", dir);
        } else {
            info!("No patterns directory found, using builtin patterns only");
        }

        // Database path: .atls/db.sqlite in project root
        let db_path = root_path.join(".atls").join("db.sqlite");
        
        // Create .atls directory if it doesn't exist
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Open database connections (separate for indexer and query engine since they take ownership)
        let indexer_db = Database::open(&db_path)?;
        let query_db = Database::open(&db_path)?;
        let main_db = Database::open(&db_path)?;  // Keep one for the project struct

        // Create indexer WITH patterns directory
        let indexer = Arc::new(Mutex::new(
            Indexer::with_patterns_dir(&root_path, indexer_db, patterns_dir.as_deref())?
        ));

        // Create query engine
        let query_engine = Arc::new(QueryEngine::new(query_db));

        // Wrap main db in Arc for storage
        let db = Arc::new(main_db);

        // Create parser registry
        let parser_registry = Arc::new(ParserRegistry::new());

        // Load detector registry (patterns from patterns/ directory) - for Project-level queries
        let mut detector_registry = DetectorRegistry::new();
        if let Some(ref dir) = patterns_dir {
            if let Err(e) = detector_registry.load_from_dir(dir) {
                warn!("Failed to load patterns for detector registry: {}", e);
            }
        }
        if detector_registry.pattern_count() == 0 {
            detector_registry.load_builtin_patterns();
        }
        let detector_registry = Arc::new(detector_registry);

        Ok(Self {
            root_path,
            db,
            indexer,
            query_engine,
            detector_registry,
            parser_registry,
            watcher_handle: None,
        })
    }

    #[allow(dead_code)]
    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    pub fn db_handle(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub async fn indexer(&self) -> tokio::sync::MutexGuard<'_, Indexer> {
        self.indexer.lock().await
    }

    pub fn query_engine(&self) -> &QueryEngine {
        &self.query_engine
    }

    pub fn query_engine_handle(&self) -> Arc<QueryEngine> {
        Arc::clone(&self.query_engine)
    }

    pub fn detector_registry(&self) -> &DetectorRegistry {
        &self.detector_registry
    }

    /// Start watching for file changes
    #[allow(dead_code)]
    pub async fn start_watching(&mut self, debounce_ms: u64) -> Result<(), ProjectError> {
        let mut indexer = self.indexer.lock().await;
        indexer.start_watching(debounce_ms).await?;
        // Note: WatcherHandle is stored in Indexer, not here
        Ok(())
    }

    /// Stop watching for file changes
    #[allow(dead_code)]
    pub async fn stop_watching(&mut self) {
        let mut indexer = self.indexer.lock().await;
        indexer.stop_watching().await;
    }
}

/// Project manager - maintains per-root-path project instances
#[derive(Clone)]
pub struct ProjectManager {
    projects: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<Project>>>>>,
    last_project_path: Arc<Mutex<Option<PathBuf>>>,
}

impl ProjectManager {
    pub fn new() -> Self {
        Self {
            projects: Arc::new(Mutex::new(HashMap::new())),
            last_project_path: Arc::new(Mutex::new(None)),
        }
    }

    /// Get or create a project for the given root path.
    /// When root_path is None, reuses the most recently opened project
    /// before falling back to CWD.
    pub async fn get_or_create_project<P: AsRef<Path>>(
        &self,
        root_path: Option<P>,
    ) -> Result<Arc<Mutex<Project>>, ProjectError> {
        let root_path = if let Some(path) = root_path {
            path.as_ref().canonicalize()
                .map_err(|e| ProjectError::Path(format!("Failed to canonicalize path: {}", e)))?
        } else {
            // Prefer most recently opened project over CWD
            let last = self.last_project_path.lock().await;
            if let Some(ref p) = *last {
                p.clone()
            } else {
                std::env::current_dir()
                    .map_err(|e| ProjectError::Io(e))?
                    .canonicalize()
                    .map_err(|e| ProjectError::Path(format!("Failed to canonicalize cwd: {}", e)))?
            }
        };

        let mut projects = self.projects.lock().await;

        if let Some(project) = projects.get(&root_path) {
            // Update last used
            *self.last_project_path.lock().await = Some(root_path);
            return Ok(Arc::clone(project));
        }

        // Create new project
        let project = Arc::new(Mutex::new(Project::open(&root_path).await?));
        projects.insert(root_path.clone(), Arc::clone(&project));
        *self.last_project_path.lock().await = Some(root_path);

        Ok(project)
    }
}

impl Default for ProjectManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::ProjectManager;

    #[tokio::test]
    async fn get_or_create_reuses_cached_project() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let pm = ProjectManager::new();
        let a = pm.get_or_create_project(Some(path)).await.unwrap();
        let b = pm.get_or_create_project(Some(path)).await.unwrap();
        assert!(std::sync::Arc::ptr_eq(&a, &b));
    }
}
