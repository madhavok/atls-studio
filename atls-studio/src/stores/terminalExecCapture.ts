/**
 * PTY buffer parsing for agent `executeCommand` — markers + PowerShell Out-String wrapper.
 * Extracted for unit tests (regression: empty or truncated capture when ANSI/wrapping breaks markers).
 */

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[\??[0-9;]*[hl]|\x1b[()][0-9A-B]|\x1b\[[\d;]*m|\x1b/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Normalize CRLF / lone CR so marker strings match PowerShell / ConPTY output. */
function normalizePtyText(s: string): string {
  return stripAnsi(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export interface AgentExecParseResult {
  exitCode: number;
  output: string;
  success: boolean;
}

/**
 * If the buffer contains a complete end marker, extract stdout between start/end markers
 * and exit code. Returns null when the end marker is not present yet.
 */
function filterExecBodyLines(
  lines: string[],
  marker: string,
  startMarker: string,
): string[] {
  return lines.filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('Write-Host')
      && !trimmed.startsWith('$__ec')
      && !trimmed.includes(startMarker)
      && !trimmed.includes(`##ATLS_END_${marker}`)
      && !trimmed.includes('##ATLS_START_')
      && !trimmed.includes('NativeCommandError')
      && !trimmed.startsWith('+ CategoryInfo')
      && !trimmed.startsWith('+ FullyQualifiedErrorId')
      && !(trimmed.startsWith("Program '") && trimmed.includes('failed to run:'));
  });
}

/** When the start marker is missing or mis-aligned (ConPTY / wrapping), still return stdout before the end marker. */
function fallbackOutputBeforeEnd(
  cleanBuf: string,
  endIdx: number,
  marker: string,
  startMarker: string,
): string {
  const segment = cleanBuf.slice(0, endIdx);
  const lines = segment.split('\n');
  const cleanLines = filterExecBodyLines(lines, marker, startMarker);
  return cleanLines.join('\n').trim();
}

export function tryParseAgentExecPtyBuffer(
  rawBuffer: string,
  marker: string,
  startMarker: string,
): AgentExecParseResult | null {
  const cleanBuf = normalizePtyText(rawBuffer);
  const endPattern = new RegExp(`##ATLS_END_${marker}_((?:-?\\d+|\\$__ec)?)##`);
  const match = cleanBuf.match(endPattern);
  if (!match) return null;

  const raw = match[1] || '';
  const exitCode = /^-?\d+$/.test(raw) ? parseInt(raw, 10) : 0;
  const endIdx = cleanBuf.indexOf(match[0]);
  if (endIdx === -1) return null;

  let startIdx = cleanBuf.indexOf(startMarker);
  if (startIdx === -1 || startIdx >= endIdx) {
    startIdx = cleanBuf.lastIndexOf(startMarker, endIdx - 1);
  }

  let output = '';
  if (startIdx !== -1 && endIdx > startIdx) {
    output = cleanBuf.slice(startIdx + startMarker.length, endIdx).trim();
    const lines = output.split('\n');
    output = filterExecBodyLines(lines, marker, startMarker).join('\n').trim();
  } else {
    output = fallbackOutputBeforeEnd(cleanBuf, endIdx, marker, startMarker);
  }

  return { exitCode, output, success: exitCode === 0 };
}
