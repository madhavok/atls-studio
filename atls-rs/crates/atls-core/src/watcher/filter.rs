use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum FilterError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Ignore error: {0}")]
    Ignore(#[from] ignore::Error),
    #[error("Path error: {0}")]
    Path(String),
}

/// Canonical list of directories that should never be traversed or indexed.
/// `.atlsignore` is the user-facing override; this is the safety net underneath.
pub const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "vendor",
    "__pycache__", ".git", ".atls", "obj", "bin",
    ".next", ".nuxt", "coverage", ".tox", "venv", ".venv",
    ".turbo", ".parcel-cache", ".cache",
];

/// Check if a directory name is in the shared skip list or is a hidden directory
/// (dot-prefixed, excluding `.atls` which holds project config).
pub fn is_skip_dir(name: &str) -> bool {
    if SKIP_DIRS.contains(&name) {
        return true;
    }
    name.starts_with('.') && name != ".atls"
}

/// Resolve .atlsignore path: prefer .atls/.atlsignore, fallback to root .atlsignore
fn atlsignore_path(root: &Path) -> Option<PathBuf> {
    let in_atls = root.join(".atls").join(".atlsignore");
    if in_atls.exists() {
        return Some(in_atls);
    }
    let at_root = root.join(".atlsignore");
    if at_root.exists() {
        return Some(at_root);
    }
    None
}

/// Load atlsignore patterns into a Gitignore matcher (patterns rooted at project root)
fn load_atlsignore(root: &Path) -> Option<ignore::gitignore::Gitignore> {
    let path = atlsignore_path(root)?;
    let content = std::fs::read_to_string(&path).ok()?;
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let _ = builder.add_line(None, line);
    }
    builder.build().ok()
}

/// File filter for gitignore/atlsignore patterns
pub struct FileFilter {
    root_path: PathBuf,
    ignore_builder: ignore::WalkBuilder,
    atlsignore: Option<ignore::gitignore::Gitignore>,
}

impl FileFilter {
    /// Create a new file filter for the given root path
    pub fn new<P: AsRef<Path>>(root_path: P) -> Result<Self, FilterError> {
        let root_path = root_path.as_ref().canonicalize()
            .map_err(|e| FilterError::Path(format!("Failed to canonicalize path: {}", e)))?;
        
        // Build ignore walker (handles .gitignore, etc.)
        let mut builder = ignore::WalkBuilder::new(&root_path);
        builder.hidden(false); // Don't skip hidden files by default
        builder.git_ignore(true);
        builder.git_exclude(true);
        
        // Add .atlsignore: when at root, add_ignore works; when in .atls/, we use filter_entry
        let atlsignore = load_atlsignore(&root_path);
        let at_root = root_path.join(".atlsignore");
        if at_root.exists() {
            let _ = builder.add_ignore(&at_root);
        }
        
        // Custom matcher for .atls/.atlsignore (patterns must be rooted at project)
        let atlsignore_clone = atlsignore.clone();
        let root_for_filter = root_path.clone();
        
        builder.filter_entry(move |entry| {
            let path = entry.path();
            if let Some(name) = path.file_name() {
                if path.is_dir() && is_skip_dir(&name.to_string_lossy()) {
                    return false;
                }
            }
            if let Some(ref gi) = atlsignore_clone {
                if let Ok(rel) = path.strip_prefix(&root_for_filter) {
                    let is_dir = path.is_dir();
                    if gi.matched(rel, is_dir).is_ignore() {
                        return false;
                    }
                }
            }
            true
        });
        
        Ok(Self {
            root_path,
            ignore_builder: builder,
            atlsignore,
        })
    }

    /// Check if a file path should be ignored
    pub fn should_ignore<P: AsRef<Path>>(&self, path: P) -> bool {
        let path = path.as_ref();
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

        let relative_path = match canonical.strip_prefix(&self.root_path) {
            Ok(rel) => rel,
            Err(_) => return true,
        };

        for component in relative_path.components() {
            if let std::path::Component::Normal(name) = component {
                if is_skip_dir(&name.to_string_lossy()) {
                    return true;
                }
            }
        }

        if let Some(ref gi) = self.atlsignore {
            if gi.matched(relative_path, canonical.is_dir()).is_ignore() {
                return true;
            }
        }

        false
    }

    /// Get all files that should be indexed (respecting ignore patterns)
    pub fn walk_files(&self) -> impl Iterator<Item = Result<PathBuf, FilterError>> {
        self.ignore_builder
            .build()
            .filter_map(|entry| {
                match entry {
                    Ok(entry) => {
                        if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                            Some(Ok(entry.path().to_path_buf()))
                        } else {
                            None
                        }
                    }
                    Err(e) => Some(Err(FilterError::Ignore(e))),
                }
            })
    }

    /// Reload ignore patterns (e.g., after .atlsignore changes)
    pub fn reload(&mut self) -> Result<(), FilterError> {
        let atlsignore = load_atlsignore(&self.root_path);
        let at_root = self.root_path.join(".atlsignore");
        
        let mut builder = ignore::WalkBuilder::new(&self.root_path);
        builder.hidden(false);
        builder.git_ignore(true);
        builder.git_exclude(true);
        if at_root.exists() {
            let _ = builder.add_ignore(&at_root);
        }
        
        let atlsignore_clone = atlsignore.clone();
        let root = self.root_path.clone();
        builder.filter_entry(move |entry| {
            let path = entry.path();
            if let Some(name) = path.file_name() {
                if path.is_dir() && is_skip_dir(&name.to_string_lossy()) {
                    return false;
                }
            }
            if let Some(ref gi) = atlsignore_clone {
                if let Ok(rel) = path.strip_prefix(&root) {
                    if gi.matched(rel, path.is_dir()).is_ignore() {
                        return false;
                    }
                }
            }
            true
        });
        
        self.atlsignore = atlsignore;
        self.ignore_builder = builder;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::fs;

    #[test]
    fn test_filter_ignores_atls_dir() {
        let temp_dir = TempDir::new().unwrap();
        let atls_dir = temp_dir.path().join(".atls");
        fs::create_dir_all(&atls_dir).unwrap();
        fs::write(atls_dir.join("db.sqlite"), "test").unwrap();
        
        let filter = FileFilter::new(temp_dir.path()).unwrap();
        assert!(filter.should_ignore(atls_dir.join("db.sqlite")));
    }

    #[test]
    fn test_filter_allows_source_files() {
        let temp_dir = TempDir::new().unwrap();
        let src_file = temp_dir.path().join("src").join("main.rs");
        fs::create_dir_all(src_file.parent().unwrap()).unwrap();
        fs::write(&src_file, "fn main() {}").unwrap();
        
        let filter = FileFilter::new(temp_dir.path()).unwrap();
        assert!(!filter.should_ignore(&src_file));
    }
}
