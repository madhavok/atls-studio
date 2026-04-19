/**
 * Auto-pin telemetry — round-scoped counters for the "auto-pin on read" feature.
 *
 * Two metrics matter for the ship gate (per docs/auto-pin-on-read.md):
 *  - `created` — auto-pin fires this round (one per newly auto-pinned FileView).
 *  - `releasedUnused` — unpin path observed `lastAccessed <= autoPinnedAt`,
 *    meaning the view was auto-pinned and released without the model ever
 *    re-accessing it. The ratio `releasedUnused / created` is the primary
 *    signal that auto-pinning is too aggressive.
 *
 * Module-level accumulator matches the sidecar pattern used by
 * `spinCircuitBreaker` and `assessContext`. Drained once per round by
 * `captureInternalsSnapshot` so each RoundSnapshot carries only that round's
 * counts. Reset on session reset alongside other per-session telemetry.
 */

let createdCount = 0;
let releasedUnusedCount = 0;

export function recordAutoPinCreated(): void {
  createdCount++;
}

export function recordAutoPinReleasedUnused(): void {
  releasedUnusedCount++;
}

/** Returns current counts and resets them to zero. Call once per round. */
export function drainAutoPinMetrics(): { created: number; releasedUnused: number } {
  const out = { created: createdCount, releasedUnused: releasedUnusedCount };
  createdCount = 0;
  releasedUnusedCount = 0;
  return out;
}

/** Readout without reset — for tests / diagnostics. */
export function peekAutoPinMetrics(): { created: number; releasedUnused: number } {
  return { created: createdCount, releasedUnused: releasedUnusedCount };
}

/** Session reset — called from aiService alongside other sidecar resets. */
export function resetAutoPinTelemetry(): void {
  createdCount = 0;
  releasedUnusedCount = 0;
}
