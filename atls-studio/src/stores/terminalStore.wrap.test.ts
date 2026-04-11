import { describe, expect, it } from 'vitest';
import { buildAgentExecPs1Content, escapePsSingleQuotedPath, stripAnsiSequences } from './terminalStore';

describe('buildAgentExecPs1Content', () => {
  it('embeds PowerShell $ variables literally (no JS template interpolation)', () => {
    const cmd = '$PSVersionTable.PSVersion.ToString()';
    const body = buildAgentExecPs1Content(cmd, '##ATLS_START_ab##', '##ATLS_END_ab_');
    expect(body).toContain('& { $PSVersionTable.PSVersion.ToString() }');
    expect(body).not.toContain('undefined');
  });

  it('uses CRLF and Out-String on merged stream', () => {
    const body = buildAgentExecPs1Content('pwd', '##S##', '##E_');
    expect(body).toContain('\r\n');
    expect(body).toContain('} 2>&1 | Out-String');
  });
});

describe('stripAnsiSequences', () => {
  it('removes common color codes', () => {
    expect(stripAnsiSequences('\x1b[31mred\x1b[0m')).toBe('red');
  });
});

describe('escapePsSingleQuotedPath', () => {
  it('doubles single quotes for PowerShell single-quoted paths', () => {
    expect(escapePsSingleQuotedPath("C:\\a\\b'c\\d.ps1")).toBe("C:\\a\\b''c\\d.ps1");
  });
});
