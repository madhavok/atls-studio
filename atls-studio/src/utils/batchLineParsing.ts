/**
 * Batch result line parsing — extracts primary step-status lines from
 * `formatBatchResult` or streaming `onBatchStepProgress` output.
 *
 * Primary lines match: [OK|FAIL|SKIP|WARN|TOOL-ERROR|PASS] <step_id> ...
 * Continuation lines (indented refs/BB/etc.), footer lines ([ATLS]...),
 * and volatile nudge lines are dropped so the result maps 1:1 to steps.
 */

export interface ParsedStepLine {
  stepId: string;
  text: string;
  failed: boolean;
}

const STEP_STATUS_RE = /^\[(OK|FAIL|SKIP|WARN|PASS|TOOL-ERROR)\]\s+(\S+)/;

/**
 * Parse batch result text into an array of primary step-status lines.
 * Each entry corresponds to exactly one executed step, keyed by step id.
 */
export function parseBatchStepLines(result?: string): ParsedStepLine[] {
  if (!result) return [];
  const lines = result.split(/\r?\n/g);
  const parsed: ParsedStepLine[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip footer/meta lines
    if (/^\[ATLS\]/i.test(line)) continue;
    // Skip volatile nudge
    if (line.startsWith('⚠') && /VOLATILE/i.test(line)) continue;
    // Skip indented continuation lines (refs, BB, explanatory)
    if (/^\s{2,}/.test(raw)) continue;

    const m = STEP_STATUS_RE.exec(line);
    if (!m) continue;

    const statusTag = m[1];
    const stepId = m[2];
    const failed = statusTag === 'FAIL' || statusTag === 'TOOL-ERROR';
    parsed.push({ stepId, text: line, failed });
  }

  return parsed;
}

/**
 * Build a Map<stepId, ParsedStepLine> for O(1) lookup by step id.
 */
export function indexStepLinesById(lines: ParsedStepLine[]): Map<string, ParsedStepLine> {
  const map = new Map<string, ParsedStepLine>();
  for (const line of lines) {
    map.set(line.stepId, line);
  }
  return map;
}
