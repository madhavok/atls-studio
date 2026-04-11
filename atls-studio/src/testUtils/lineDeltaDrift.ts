/**
 * Deterministic line-range shift helper for freshness / batch tests.
 * Applies an integer delta to 1-based inclusive line ranges "a-b" or "n".
 */
export function shiftLineRangeSpec(spec: string, delta: number): string {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const dash = part.indexOf('-');
    if (dash < 0) {
      const n = parseInt(part, 10);
      if (!Number.isFinite(n)) throw new Error(`Invalid line spec segment: ${part}`);
      out.push(String(Math.max(1, n + delta)));
      continue;
    }
    const a = parseInt(part.slice(0, dash).trim(), 10);
    const endS = part.slice(dash + 1).trim();
    const b = endS ? parseInt(endS, 10) : a;
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Invalid line range: ${part}`);
    const na = Math.max(1, a + delta);
    const nb = Math.max(na, b + delta);
    out.push(`${na}-${nb}`);
  }
  return out.join(',');
}
