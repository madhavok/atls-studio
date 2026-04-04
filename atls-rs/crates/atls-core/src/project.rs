use crate::db::Database;
use crate::indexer::{Indexer, IndexerError};
use crate::query::QueryEngine;
use crate::detector::{DetectorRegistry, RegistryError};
use crate::parser::ParserRegistry;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use thiserror::Error;

/// Errors that can occur when working with an AtlsProject
#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("Database error: {0}")]
    Database(#[from] crate::db::DatabaseError),
    #[error("Indexer error: {0}")]
    Indexer(#[from] IndexerError),
    #[error("Detector registry error: {0}")]
    Detector(#[from] RegistryError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Path error: {0}")]
    Path(String),
}

/// High-level project wrapper that manages all ATLS components
pub struct AtlsProject {
    root_path: PathBuf,
    db: Arc<Database>,
    indexer: Arc<Mutex<Indexer>>,
    query: Arc<QueryEngine>,
    detector: Arc<Mutex<DetectorRegistry>>,
    parser_registry: Arc<ParserRegistry>,
}

impl AtlsProject {
    /// Open or create a new ATLS project at the given root path
    pub async fn open<P: AsRef<Path>>(root_path: P) -> Result<Self, ProjectError> {
        Self::open_with_patterns_fallback(root_path, None).await
    }

    /// Open a project with an optional bundled/fallback patterns directory.
    /// The fallback is used when no project-local patterns directory is found.
    pub async fn open_with_patterns_fallback<P: AsRef<Path>>(
        root_path: P,
        patterns_fallback: Option<&Path>,
    ) -> Result<Self, ProjectError> {
        let root_path = root_path.as_ref().canonicalize()
            .map_err(|e| ProjectError::Path(format!("Failed to canonicalize path: {}", e)))?;
        
        // Create .atls directory if it doesn't exist
        let atls_dir = root_path.join(".atls");
        std::fs::create_dir_all(&atls_dir)
            .map_err(|e| ProjectError::Io(e))?;
        
        // Open or create database
        let db_path = atls_dir.join("atls.db");
        let db = Database::open(&db_path)?;
        let db_arc = Arc::new(db);
        
        // Create parser registry
        let parser_registry = Arc::new(ParserRegistry::new());
        
        // Find patterns directory: project-local first, then bundled fallback
        let mut patterns_dirs = vec![
            root_path.join("patterns"),
            root_path.join("atls-rs").join("patterns"),
            root_path.join("patterns").join("catalog"),
            root_path.join(".atls").join("patterns"),
        ];
        if let Some(fallback) = patterns_fallback {
            patterns_dirs.push(fallback.to_path_buf());
        }
        
        let patterns_dir = patterns_dirs.iter()
            .find(|p| p.exists())
            .cloned();
        
        if let Some(ref dir) = patterns_dir {
            tracing::info!("Found patterns directory at: {:?}", dir);
        }
        
        // Create indexer WITH patterns directory
        let db_for_indexer = Database::open(&db_path)?;
        let indexer = Indexer::with_patterns_dir(&root_path, db_for_indexer, patterns_dir.as_deref())?;
        let indexer_arc = Arc::new(Mutex::new(indexer));
        
        // Create query engine
        let db_for_query = Database::open(&db_path)?;
        let query = Arc::new(QueryEngine::new(db_for_query));
        
        // Create detector registry and load patterns (using same directory as Indexer)
        let mut detector = DetectorRegistry::new();
        
        if let Some(ref dir) = patterns_dir {
            match detector.load_from_dir(dir) {
                Ok(()) => {
                    tracing::info!("Loaded {} patterns into detector registry", detector.pattern_count());
                }
                Err(e) => {
                    tracing::warn!("Failed to load patterns into detector: {}", e);
                    detector.load_builtin_patterns();
                }
            }
        } else {
            tracing::info!("No patterns directory found, using built-in patterns");
            detector.load_builtin_patterns();
        }
        
        let detector_arc = Arc::new(Mutex::new(detector));
        
        Ok(Self {
            root_path,
            db: db_arc,
            indexer: indexer_arc,
            query,
            detector: detector_arc,
            parser_registry,
        })
    }
    
    /// Get the root path of the project
    pub fn root_path(&self) -> &Path {
        &self.root_path
    }
    
    /// Get a reference to the database
    pub fn db(&self) -> &Database {
        &self.db
    }
    
    /// Get a reference to the query engine
    pub fn query(&self) -> &QueryEngine {
        &self.query
    }
    
    /// Get a reference to the indexer (wrapped in Mutex for async access)
    pub fn indexer(&self) -> &Arc<Mutex<Indexer>> {
        &self.indexer
    }
    
    /// Get a reference to the detector registry
    pub fn detector(&self) -> &Arc<Mutex<DetectorRegistry>> {
        &self.detector
    }
    
    /// Get a reference to the parser registry
    pub fn parser_registry(&self) -> &ParserRegistry {
        &self.parser_registry
    }
}

#[cfg(test)]
mod tests {
    use super::AtlsProject;

    #[tokio::test]
    async fn open_creates_atls_dir_and_db() {
        let dir = tempfile::tempdir().unwrap();
        let proj = AtlsProject::open(dir.path()).await.expect("open temp project");
        assert!(dir.path().join(".atls").join("atls.db").exists());
        assert_eq!(proj.root_path(), dir.path().canonicalize().unwrap());
    }
}
