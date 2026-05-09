/**
 * Spin thresholds — single source of truth for read-spin detection.
 *
 * `EXACT_SPIN_LIMIT`: re-reading the *same* (path, range) this many times in a
 * single turn without an intervening write or BB entry triggers a hard <<WARN>>
 * circuit break in `recordFileReadSpin`.
 *
 * `RANGE_NUDGE_LIMIT`: reading this many *distinct* ranges of the same file in
 * a turn triggers a softer <<NUDGE>> suggesting the agent search or use h:refs
 * before fetching more spans.
 *
 * Kept in a tiny standalone module so prompts, store, and circuit-breaker can
 * import without circular deps.
 */
export const EXACT_SPIN_LIMIT = 3;
export const RANGE_NUDGE_LIMIT = 5;
