/**
 * Fixed JSON strings for structural payload efficiency tests.
 * Keep in sync with `bpe_structural_*` tests in `src-tauri/src/tokenizer.rs` (same literals for BPE).
 * Model ids for tokenizer runs: `tokenizerTestModels.ts` / `tokenizer::test_models`.
 */

/** Verbose snake_case keys (typical batch result). */
export const BPE_VERBOSE_KEYS_JSON =
  '{"file":"src/services/edit.ts","content_hash":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef","h":"h:a1b2c3","line":42,"status":"applied"}';

/** Short keys, same information (single canonical hash ref). */
export const BPE_COMPACT_KEYS_JSON =
  '{"f":"src/services/edit.ts","h":"h:a1b2c3","line":42,"status":"applied"}';

/** h + 64-char content_hash + file (hex still redundant with h for token audit). */
export const BPE_TRIPLE_HASH_JSON =
  '{"h":"h:a1b2c3","content_hash":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef","file":"src/x.ts"}';

/** Single h + file (no duplicate hex). */
export const BPE_SINGLE_HASH_JSON = '{"h":"h:a1b2c3","file":"src/x.ts"}';

/** Git-style status with explicit defaults and empty arrays. */
export const BPE_VERBOSE_DEFAULTS_JSON =
  '{"action":"status","branch":"main","ahead":0,"behind":0,"clean":false,"staged":[],"modified":["src/a.ts","src/b.ts"],"untracked":[],"deleted":[],"dry_run":false}';

/** Same facts, omitting false/0/empty arrays where derivable. */
export const BPE_COMPACT_DEFAULTS_JSON =
  '{"action":"status","branch":"main","modified":["src/a.ts","src/b.ts"]}';

/** extract_plan-style duplicate: proposed_modules + mirror in extract_methods_params. */
export const BPE_DUPLICATE_NESTED_JSON = `{"proposed_modules":[{"target":"src/mod/a.ts","symbols":["fnA","fnB"]},{"target":"src/mod/b.ts","symbols":["fnC"]}],"extract_methods_params":{"extractions":[{"target_file":"src/mod/a.ts","methods":["fnA","fnB"]},{"target_file":"src/mod/b.ts","methods":["fnC"]}],"dry_run":false}}`;

/** Same modules once (client could derive extractions). */
export const BPE_SINGLE_NESTED_JSON =
  '{"proposed_modules":[{"target":"src/mod/a.ts","symbols":["fnA","fnB"]},{"target":"src/mod/b.ts","symbols":["fnC"]}]}';

/** Inconsistent naming: total_refs (shorter key). */
export const BPE_NAMING_REFS_JSON =
  '{"file":"src/x.ts","total_refs":12,"total_definitions":3,"files_shown":4}';

/** Same counts with longer synonym key. */
export const BPE_NAMING_REFERENCES_JSON =
  '{"file":"src/x.ts","total_references":12,"total_definitions":3,"files_shown":4}';
