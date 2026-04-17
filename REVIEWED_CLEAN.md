# Code Review — Clean Files

**Date:** 2025-01-27  
**Scope:** Full stack — `atls-studio/src-tauri/src/`, `atls-rs/crates/` (Rust backend) + `atls-studio/src/` (TypeScript frontend)  
**Reviewer:** ATLS AI agent  
**Build:** `cargo build` + `npm run build` — 0 errors, 0 warnings

## Summary

45+ files reviewed for correctness bugs (logic errors, off-by-ones, data loss, type unsoundness). 6 bugs found and fixed; all remaining files are clean. **Full codebase review complete.**

---

## Backend (Rust)

### Bug Found & Fixed

| File | Function | Issue | Commit |
|------|----------|-------|--------|
| `refactor_engine.rs` | `remove_symbol_from_import_line` (L1365) | Operated on `line.trim()` when reconstructing imports, silently stripping original indentation. All three language branches (TS/JS, Rust, Python) affected. | `43bddae` |

### Clean Files

| File | Lines | Area | Notes |
|------|-------|------|-------|
| `line_remap.rs` | 450 | LCS diff + line mapping | Prefix/suffix strip, DP table, backtrack, MAX_MIDDLE_LINES bail-out all sound |
| `edit_session.rs` | 663 | Preimage matching, atomic edits | Byte range validation, conflict markers, baseline-aware syntax check, staleness guard |
| `diff_engine.rs` | 354 | Unified diff generation | LCS diff, hunk building, format output — standard algorithm, no edge cases |
| `snapshot.rs` | 548 | File snapshot management | Clean snapshot lifecycle |
| `shape_ops.rs` | 5657 | Code shape/signature extraction | Large but correct — folding, signature extraction, digest generation |
| `hash_resolver.rs` | 3087 | UHPP hash resolution | Hash parsing, line range resolution, symbol lookup — all correct |
| `linter.rs` | 1955 | Pattern-based issue detection | Rule matching, severity classification, dedup — sound |
| `batch_query/helpers.rs` | 606 | Batch execution helpers | Parameter normalization, path resolution — clean |
| `batch_query/mod.rs` | 16064 | Batch query orchestration | Full review — operation dispatch, param handling, edit pipeline, refactor engine calls all correct |
| `tokenizer.rs` | 964 | Token counting | BPE integration, caching, drift correction — correct |
| `workspace_run.rs` | 229 | Workspace subprocess execution | Process spawning, output capture — clean |

---

## Frontend — Cognitive Subsystems (TypeScript)

### Bugs Found & Fixed

| File | Function | Issue | Commit |
|------|----------|-------|--------|
| `promptMemory.ts` | `reconcileBudgets` (L217) | Comment said "overage ratio" but code sorted by absolute token overage. Fixed comment to match code. | `cff3232` |
| `executor.ts` | `rebaseIntraStepSnapshotLineEdits` (L367) | Sort comparator returned 1 when `b.snap===0` (symbol-based edit), should return -1. Symbol edits sorted before positional edits in mixed `le` entries. | `cff3232` |
| `orchestrator.ts` | `addChunk`/`find` (L1479) | `addChunk()` returns full 16-char hash but `find()` compared against `c.shortHash` (6 chars). Synthesis never persisted to DB. | `cff3232` |
| `orchestrator.ts` | retry guard (L1820) | Pre-acquisition path uses `maxRetries-1`, post-acquisition uses raw `maxRetries`. One extra retry allowed. | `cff3232` |
| `edit.ts` + `editMulti.ts` | `extractEditRange` (L117, L20) | Used nonexistent `e.count` field instead of `e.end_line`. Multi-line edits always computed as single-line range. | `cff3232` |

### Clean Files

| File | Lines | Area | Notes |
|------|-------|------|-------|
| `hashProtocol.ts` | 744 | Chunk lifecycle + eviction heap | Min-heap ops correct; `advanceTurn` Map deletion during for-of safe per ES6; ref count tracking sound |
| `contextStore.ts` | 6177 | Working memory store | Tiered eviction, staged pruning, chunk promotion — all correct |
| `contextHash.ts` | 599 | Hashing + token estimation | Dual FNV-1 hash, CJK-aware token heuristic, `sliceContentByLines` 1-indexed inclusive — correct |
| `snapshotTracker.ts` | 351 | File snapshot tracking | `mergeRanges` adjacency via `+1` correct; `regionsCover` containment check sound |
| `tokenCounter.ts` | 304 | Token counting + LRU cache | Delete+re-set MRU promotion, drift correction formula `1/(1+signedAvg/100)` — correct |
| `toon.ts` | 550 | TOON serializer + batch parser | Quote normalization, trailing comma strip, balanced brace tracking — all sound |
| `intents.ts` | 376 | Intent resolution | Iterate-and-expand, unregistered passthrough, `Math.max(0,...)` guards — correct |
| `roundHistoryStore.ts` | 168 | Round history | Immutable spread + slice for cap, division-by-zero guard — correct |
| `contextFormatter.ts` | ~250 | Working memory formatting | Staged token calc, telemetry assembly, BB summary — correct |
| `spinDetector.ts` | ~200 | Read spin detection | Jaccard empty-array guard, tool categorization priority, context-loss detection — correct |
| `historyCompressor.ts` | ~570 | History compression | Protected-round guard, pinned-content preservation, budget enforcement loop — correct |
| `searchReplace.ts` | ~100 | Search-replace intent | Literal text matching — correct |
| `freshnessPreflight.ts` | ~150 | Edit freshness checks | Pre-edit staleness detection, hash reconciliation — correct |

---

## Second Pass — Completed

All previously-unreviewed files examined. **0 new bugs found.**

### Backend (Rust) — Additional Clean Files

| File | Lines | Area | Notes |
|------|-------|------|-------|
| `query/search.rs` | 1928 | Full-text search engine | BM25 normalization correct (negative scores inverted via `1.0-norm`). Fuzzy hits filtered from median calc (`f64::MAX` sentinel). Quality floor threshold sound. FTS sanitization well-tested. |
| `query/symbols.rs` | 2476 | Symbol query engine | Symbol lookup, identifier splitting (camelCase/snake_case), method pattern detection, extraction resistance scoring — all correct. Operator precedence in `detect_method_pattern` traces correctly despite looking suspicious. |
| `indexer/symbols.rs` | 2320 | Symbol extraction | AST-based via tree-sitter. Standard visitor pattern. Good test coverage across 10+ languages. |
| `indexer/relations.rs` | 1864 | Import/call extraction | Both AST-based and regex-based extractors examined. Inner-scope import filtering correct (body detection covers fn/closure/impl/lambda/arrow). Nested brace handling in regex extractors sound. |
| `uhpp.rs` | 2546 | UHPP type definitions | ~40 structs/enums + ~60 serde round-trip tests. Digest generation matches TS counterparts. No logic to harbor bugs. |
| `ai_streaming.rs` | 3263 | AI streaming protocol | `extract_text_tool_calls`: complex paren-matching with quoted string skipping correct. `retry_with_backoff`: exponential backoff sound. `parse_retry_delay_from_body` handles Google/OpenAI/Anthropic formats. Minor UX nit: 5xx errors show "Rate limited" message (cosmetic, not correctness). |
| `chat_db.rs` | 1982 | Chat database | Standard CRUD with parameterized SQL (no injection risk). Schema has proper indexes. Upsert via INSERT OR REPLACE correct. Migration logic handles schema versioning. |
| `lib.rs` | 8005 | Edit engine + Tauri commands | `apply_line_edits` engine: index validation, replace/delete counting, move destination adjustment all correct. `find_body_bounds` brace matching handles strings/comments/templates via `scan_char`. ~4500 lines of tests cover edge cases exhaustively. Workspace utils clean. |

### Frontend (TypeScript) — Additional Clean Files

| File | Lines | Area | Notes |
|------|-------|------|-------|
| `orchestrator.ts` (remainder) | ~800 | Agent execution, rate limiting | Rate limiter early-return paths correctly avoid finally block. Exponential backoff with jitter correct. Terminal lifecycle properly guarded. |
| `understand.ts` | 97 | Intent resolver | Simple step-sequence builder — conditional read/deps/pin emission. Clean. |
| `edit.ts` | 135 | Intent resolver | Step builder with `extractEditRange`. Bug in `extractEditRange` was already fixed (commit `cff3232`). |
| `editMulti.ts` | 150 | Intent resolver | Multi-file edit step builder. Same `extractEditRange` fix applied. |
| `investigate.ts` | 94 | Intent resolver | Cached-result awareness, conditional search/read/stage. Clean. |
| `diagnose.ts` | 106 | Intent resolver | Issue scan + BB key builder. Clean. |
| `survey.ts` | 79 | Intent resolver | Tree read + sig discovery. Clean. |
| `refactor.ts` | 126 | Intent resolver | Read/pin/deps/extract plan pipeline. Clean. |
| `create.ts` | 70 | Intent resolver | File creation with ref reads + verify. Clean. |
