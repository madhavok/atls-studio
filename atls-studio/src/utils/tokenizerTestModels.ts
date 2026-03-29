/**
 * Canonical model ids for token-budget documentation and tests.
 * Keep in sync with `src-tauri/src/tokenizer.rs` `#[cfg(test)] mod test_models`.
 *
 * - **OpenAI:** tiktoken (o200k family via `tiktoken-rs`; unknown ids fall back to o200k_base).
 * - **Anthropic:** default `selectedModel` in `src/stores/appStore.ts`.
 * - **Google:** native BPE not wired in Rust; `count_tokens` uses calibrated heuristic (`modelCapabilities.ts`).
 */
export const TOKENIZER_TEST_MODEL_OPENAI = 'gpt-5.4';
export const TOKENIZER_TEST_MODEL_ANTHROPIC = 'claude-sonnet-4-5';
export const TOKENIZER_TEST_MODEL_GOOGLE = 'gemini-2.5-pro';
