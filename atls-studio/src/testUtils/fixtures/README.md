# Regression fixtures (freshness / batch)

Place captured `PreflightResult` or batch step payloads here as `.json` files.

Suggested capture (dev-only): log `JSON.stringify(result, …)` from `runFreshnessPreflight` / `executeUnifiedBatch` when `process.env.ATLS_CAPTURE_FIXTURES` is set.

Do not commit secrets or full transcripts with API keys.
