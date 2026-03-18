use tree_sitter::Query;
use std::collections::HashSet;
use streaming_iterator::StreamingIterator;

/// A single capture from a query match
/// Note: We store node position info instead of the node itself due to lifetime constraints
#[derive(Debug, Clone)]
pub struct Capture {
    /// Capture name (e.g., "offender", "function") - without @ prefix
    pub name: String,
    /// Byte offset in source
    pub start_byte: usize,
    /// End byte offset
    pub end_byte: usize,
    /// Start row (0-indexed)
    pub start_row: usize,
    /// End row (0-indexed)
    pub end_row: usize,
    /// Start column (0-indexed)
    pub start_column: usize,
    /// End column (0-indexed)
    pub end_column: usize,
}

/// A complete query match with all captures
#[derive(Debug, Clone)]
pub struct QueryMatch {
    /// Pattern index in the query
    pub pattern_index: u32,
    /// All captures in this match
    pub captures: Vec<Capture>,
}

impl QueryMatch {
    /// Get a capture by name (e.g., "offender" - without @ prefix)
    pub fn get_capture(&self, name: &str) -> Option<&Capture> {
        self.captures.iter().find(|c| c.name == name)
    }

    /// Get the first capture, or a specific named capture
    pub fn get_offender(&self) -> Option<&Capture> {
        self.get_capture("offender")
            .or_else(|| self.captures.first())
    }
}

/// Extract matches from tree-sitter query cursor using StreamingIterator.
/// Requires the Query to map capture indices to names.
pub fn extract_matches_from_cursor(
    query: &Query,
    cursor: &mut tree_sitter::QueryCursor,
    root_node: tree_sitter::Node<'_>,
    source: &[u8],
) -> Vec<QueryMatch> {
    let capture_names = query.capture_names();
    let mut results = Vec::new();
    let mut seen: HashSet<(usize, Option<usize>)> = HashSet::new();
    
    let mut matches = cursor.matches(query, root_node, source);
    
    while let Some(m) = matches.next() {
        if let Some(qm) = convert_match(m, &capture_names, &mut seen) {
            results.push(qm);
        }
    }
    
    results
}

/// Extract matches using `matches_with_options` (timeout via progress callback).
pub fn extract_matches_with_options(
    query: &Query,
    cursor: &mut tree_sitter::QueryCursor,
    root_node: tree_sitter::Node<'_>,
    source: &[u8],
    options: tree_sitter::QueryCursorOptions<'_>,
) -> Vec<QueryMatch> {
    let capture_names = query.capture_names();
    let mut results = Vec::new();
    let mut seen: HashSet<(usize, Option<usize>)> = HashSet::new();
    
    let mut matches = cursor.matches_with_options(query, root_node, source, options);

    while let Some(m) = matches.next() {
        if let Some(qm) = convert_match(m, &capture_names, &mut seen) {
            results.push(qm);
        }
    }
    
    results
}

fn convert_match(
    m: &tree_sitter::QueryMatch<'_, '_>,
    capture_names: &[&str],
    seen: &mut HashSet<(usize, Option<usize>)>,
) -> Option<QueryMatch> {
    let key = (
        m.pattern_index,
        m.captures.first().map(|c| c.node.start_byte()),
    );
    if seen.contains(&key) {
        return None;
    }
    seen.insert(key);

    let captures: Vec<Capture> = m
        .captures
        .iter()
        .map(|c| {
            let node = c.node;
            let name = capture_names
                .get(c.index as usize)
                .copied()
                .unwrap_or("capture");
            let start_pos = node.start_position();
            let end_pos = node.end_position();
            Capture {
                name: name.to_string(),
                start_byte: node.start_byte(),
                end_byte: node.end_byte(),
                start_row: start_pos.row,
                end_row: end_pos.row,
                start_column: start_pos.column,
                end_column: end_pos.column,
            }
        })
        .collect();

    Some(QueryMatch {
        pattern_index: m.pattern_index as u32,
        captures,
    })
}

/// Get the full text of a capture
pub fn capture_text(capture: &Capture, source: &str) -> String {
    source
        .get(capture.start_byte..capture.end_byte)
        .unwrap_or("")
        .to_string()
}
