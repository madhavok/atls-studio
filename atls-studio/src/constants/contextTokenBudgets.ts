/**
 * Context token budgets — single registry for hard-coded token ceilings
 * scattered across the UI and service layer.
 *
 * Motivation: multiple components encoded their own private `5000`
 * constant, making it hard to audit the total agreed-upon budget or
 * reason about when they should grow together. Consolidating here
 * keeps the numbers in one place and cross-links the related budgets
 * already exported from services.
 *
 * Related service-layer constants:
 *   - `SUBAGENT_TOKEN_BUDGET_DEFAULT` (`services/promptMemory.ts`) —
 *     per-subagent prompt budget; dominates delegated-call cost.
 *   - `SKELETON_TOKEN_BUDGET_DEFAULT` (`services/fileView.ts`) —
 *     per-skeleton structural summary ceiling.
 *   - `AVG_TOKENS_PER_LINE_DEFAULT` / `COVERAGE_PROMOTE_RATIO`
 *     (`services/fileViewStore.ts`) — inputs to the coverage-promote
 *     threshold, not raw budgets.
 *
 * NOTE: this file is intentionally pure (no store reads, no React).
 * For live, model-advertised context windows, see provider metadata in
 * the app store — that's a separate concern tracked in the P3 follow-up.
 */

/**
 * Display-only budget used by the Entry Manifest section in the
 * AtlsInternals panel to render "% of budget" progress bars.
 *
 * Not a runtime gate — no handler reads this. Keep aligned with
 * the approximate size at which the entry manifest becomes
 * visually dense in the inspector.
 */
export const ENTRY_MANIFEST_DISPLAY_BUDGET = 5000;
