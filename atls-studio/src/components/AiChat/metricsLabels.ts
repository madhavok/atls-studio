/**
 * Metric tier helpers — keep the "billed vs estimated" line crisp across the
 * chat footer, the ATLS internals panel, and any new surface.
 *
 * Two tiers:
 *   - "billed"    — authoritative numbers from provider `Usage` events that
 *                   also land in `costStore.recordUsage`. Safe to treat as
 *                   invoice-grade.
 *   - "estimated" — heuristic / BPE estimates, compounding views, and derived
 *                   "~$ saved" numbers. Directional signal, never a bill.
 *
 * Keep this module free of React; it's pure string formatting. See
 * `docs/metrics.md` for the full taxonomy.
 */

export type MetricTier = 'billed' | 'estimated';

const TIER_PREFIX: Record<MetricTier, string> = {
  billed: 'BILLED',
  estimated: 'EST',
};

/** Prefix-only label, e.g. `"BILLED: session input"`. */
export function tierLabel(tier: MetricTier, rest: string): string {
  return `${TIER_PREFIX[tier]}: ${rest}`;
}

/**
 * Prepend the tier to a multi-line tooltip. Idempotent: if the first line
 * already starts with a tier prefix we return the input unchanged.
 */
export function tierTooltip(tier: MetricTier, lines: string[]): string {
  if (lines.length > 0) {
    const first = lines[0];
    if (first.startsWith('BILLED:') || first.startsWith('EST:')) {
      return lines.join('\n');
    }
  }
  return [tierLabel(tier, lines[0] ?? ''), ...lines.slice(1)].join('\n');
}

/** Short chip tag, e.g. `"billed"` / `"est"` — for dense UI surfaces. */
export function tierChip(tier: MetricTier): string {
  return tier === 'billed' ? 'billed' : 'est';
}
