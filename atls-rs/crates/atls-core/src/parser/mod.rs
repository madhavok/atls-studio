pub mod languages;
pub mod registry;
pub mod query;
pub mod captures;

pub use languages::{load_language, is_supported, create_parser, LanguageError};
pub use registry::{ParserRegistry, RegistryError};
pub use query::{compile_query, execute_query, execute_query_string, QueryError, QueryResult};
pub use captures::{Capture, QueryMatch, extract_matches_from_cursor, capture_text};
