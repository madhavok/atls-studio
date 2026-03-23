import { describe, expect, it } from 'vitest';
import { tryParseAgentExecPtyBuffer } from './terminalExecCapture';

describe('tryParseAgentExecPtyBuffer', () => {
  const marker = 'a1b2c3d4';
  const startMarker = `##ATLS_START_${marker}##`;

  it('returns null until end marker is present', () => {
    expect(
      tryParseAgentExecPtyBuffer(`${startMarker}hello`, marker, startMarker),
    ).toBeNull();
  });

  it('extracts multiline git-style output and exit code', () => {
    // Whole capture is .trim() — leading space on first line is stripped.
    const body = ' M src/foo.ts\n?? new.txt';
    const buf = `${startMarker}\n${body}\n##ATLS_END_${marker}_0##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r).not.toBeNull();
    expect(r!.exitCode).toBe(0);
    expect(r!.success).toBe(true);
    expect(r!.output).toBe(body.trim());
  });

  it('treats $__ec in end marker as exit 0', () => {
    const buf = `${startMarker}\nok\n##ATLS_END_${marker}_$__ec##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r!.exitCode).toBe(0);
    expect(r!.success).toBe(true);
    expect(r!.output).toBe('ok');
  });

  it('parses non-zero exit code', () => {
    const buf = `${startMarker}\nerr\n##ATLS_END_${marker}_-1##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r!.exitCode).toBe(-1);
    expect(r!.success).toBe(false);
  });

  it('strips ANSI so markers still match when escapes wrap mid-line', () => {
    // Simulate cursor / color codes between marker fragments (ConPTY wrapping).
    const ansi = '\x1b[31m';
    const buf = `${startMarker}\nout${ansi}\n##ATLS_END_${marker}_0##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r).not.toBeNull();
    expect(r!.output).toContain('out');
  });

  it('filters Write-Host and error-decoration lines from body', () => {
    const buf = `${startMarker}
Write-Host noise
real line
+ CategoryInfo : x
##ATLS_END_${marker}_0##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r!.output).toBe('real line');
  });

  it('yields empty output when body is only filtered noise', () => {
    const buf = `${startMarker}
Write-Host only
##ATLS_END_${marker}_0##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r!.exitCode).toBe(0);
    expect(r!.output).toBe('');
  });

  it('normalizes CRLF so markers and body still parse on Windows', () => {
    const body = 'line1\r\nline2';
    const buf = `${startMarker}\r\n${body}\r\n##ATLS_END_${marker}_0##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r!.output).toBe('line1\nline2');
  });

  it('fallback: returns stdout before end marker when start marker is absent', () => {
    const buf = `PS C:\\> prompt\r\nactual output\r\n##ATLS_END_${marker}_0##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r!.exitCode).toBe(0);
    expect(r!.output).toContain('actual output');
  });

  it('dedupes duplicate start-marker lines between first start and end', () => {
    const buf = `${startMarker}\nfirst\n${startMarker}\nsecond\n##ATLS_END_${marker}_0##`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r!.output).toBe('first\nsecond');
  });

  it('recovers via fallback when end line appears before start marker in buffer', () => {
    const buf = `actual output\n##ATLS_END_${marker}_0##\n${startMarker}\n`;
    const r = tryParseAgentExecPtyBuffer(buf, marker, startMarker);
    expect(r!.exitCode).toBe(0);
    expect(r!.output).toBe('actual output');
  });
});
