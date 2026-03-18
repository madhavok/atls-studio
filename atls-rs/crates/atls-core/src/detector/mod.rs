pub mod loader;
pub mod registry;
pub mod treesitter;
pub mod runner;

pub use loader::PatternLoader;
pub use registry::{DetectorRegistry, FocusMatrix, RegistryError};
pub use treesitter::TreeSitterDetector;
pub use runner::DetectionRunner;
