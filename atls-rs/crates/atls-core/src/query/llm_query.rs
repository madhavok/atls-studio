//! Optional LLM-assisted structured query extraction (stub).
//!
//! Wire an HTTP client behind `ATLS_LLM_INTENT_URL` in a future revision; keep search deterministic when unset.

use crate::query::structured::StructuredFilters;

/// When implemented: POST the natural-language query, validate JSON → [`StructuredFilters`].
#[must_use]
pub fn try_llm_structured_query(_query: &str) -> Option<StructuredFilters> {
    None
}
