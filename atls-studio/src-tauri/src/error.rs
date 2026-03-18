//! Structured error types for ATLS backend operations.
//!
//! Replaces raw String errors with typed variants that carry context
//! and provide user-friendly messages.

use std::fmt;
use std::io;
use crate::hash_resolver;

/// Main error type for ATLS backend operations.
#[derive(Debug)]
pub enum AtlsError {
    /// I/O operation failed (file read/write, directory operations)
    IoError {
        path: String,
        source: io::Error,
    },
    
    /// Resource not found (file, directory, hash, symbol)
    NotFound {
        resource: String,
        context: String,
    },
    
    /// Hash resolution failed
    HashResolutionError {
        hash: String,
        reason: String,
    },
    
    /// Validation failed for input data
    ValidationError {
        field: String,
        message: String,
    },
    
}

impl fmt::Display for AtlsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AtlsError::IoError { path, source } => {
                write!(f, "I/O error on '{}': {}", path, source)
            }
            AtlsError::NotFound { resource, context } => {
                write!(f, "{} not found: {}", resource, context)
            }
            AtlsError::HashResolutionError { hash, reason } => {
                write!(f, "Failed to resolve hash '{}': {}", hash, reason)
            }
            AtlsError::ValidationError { field, message } => {
                write!(f, "Validation error for '{}': {}", field, message)
            }
        }
    }
}

impl std::error::Error for AtlsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AtlsError::IoError { source, .. } => Some(source),
            _ => None,
        }
    }
}

// Automatic conversion from std::io::Error
impl From<io::Error> for AtlsError {
    fn from(err: io::Error) -> Self {
        AtlsError::IoError {
            path: "<unknown>".to_string(),
            source: err,
        }
    }
}

impl AtlsError {
    /// Create an IoError with a specific path context.
    pub fn io_error(path: impl Into<String>, source: io::Error) -> Self {
        AtlsError::IoError {
            path: path.into(),
            source,
        }
    }
    
    /// Create a NotFound error for a file.
    pub fn file_not_found(path: impl Into<String>) -> Self {
        let path_str = path.into();
        AtlsError::NotFound {
            resource: "File".to_string(),
            context: path_str,
        }
    }
    
    /// Produce a clean, user-friendly error message.
    /// 
    /// This strips internal paths, stack traces, and technical details,
    /// providing actionable feedback for end users.
    pub fn to_user_message(&self) -> String {
        match self {
            AtlsError::IoError { path, source } => {
                let kind = source.kind();
                match kind {
                    io::ErrorKind::NotFound => {
                        format!("File not found: {}", Self::sanitize_path(path))
                    }
                    io::ErrorKind::PermissionDenied => {
                        format!("Permission denied: {}", Self::sanitize_path(path))
                    }
                    io::ErrorKind::AlreadyExists => {
                        format!("File already exists: {}", Self::sanitize_path(path))
                    }
                    _ => {
                        format!("I/O error on {}: {}", Self::sanitize_path(path), kind)
                    }
                }
            }
            AtlsError::NotFound { resource, context } => {
                format!("{} not found: {}", resource, Self::sanitize_path(context))
            }
            AtlsError::HashResolutionError { hash, reason } => {
                let short_hash = if hash.len() > hash_resolver::SHORT_HASH_LEN {
                    &hash[..hash_resolver::SHORT_HASH_LEN]
                } else {
                    hash
                };
                format!("Could not resolve reference '{}': {}", short_hash, reason)
            }
            AtlsError::ValidationError { field, message } => {
                format!("Invalid {}: {}", field, message)
            }
        }
    }
    
    /// Remove internal path prefixes for cleaner user messages.
    fn sanitize_path(path: &str) -> String {
        path.trim_start_matches(r"\\?\\").to_string()
    }
}

/// Helper trait for adding path context to io::Result
pub trait IoResultExt<T> {
    fn with_path(self, path: impl Into<String>) -> Result<T, AtlsError>;
}

impl<T> IoResultExt<T> for io::Result<T> {
    fn with_path(self, path: impl Into<String>) -> Result<T, AtlsError> {
        self.map_err(|e| AtlsError::io_error(path, e))
    }
}
