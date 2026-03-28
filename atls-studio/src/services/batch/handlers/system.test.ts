/**
 * Unit tests for system operation handlers.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeExecOutput } from './system';

describe('sanitizeExecOutput', () => {
  it('preserves git-style diff lines starting with +', () => {
    const body = '+added line\n context\n-removed';
    expect(sanitizeExecOutput(body)).toBe(body);
  });

  it('strips echoed Write-Host and scriptblock wrapper lines', () => {
    const out = sanitizeExecOutput(
      'Write-Host "##ATLS_START_abc##"\n'
      + '& { git status } 2>&1; $__ec = 0\n'
      + 'On branch main\n',
    );
    expect(out).toBe('On branch main');
  });

  it('strips cd error block and PS decoration lines only', () => {
    const raw = [
      'cd : Cannot find path ',
      'At line:1 char:1',
      '+ CategoryInfo          : InvalidArgument',
      '+ FullyQualifiedErrorId : PathNotFound',
      '',
      ' M file.ts',
    ].join('\n');
    expect(sanitizeExecOutput(raw)).toBe('M file.ts');
  });

  it('strips ConPTY-split wrapper continuation starting with ";', () => {
    const out = sanitizeExecOutput(
      '"; & { pwd } 2>&1; $__ec = if ($?) { 0 } else { 1 }; Write-Host "##ATLS_END_a1b2c3d4_0##"\n'
      + 'Path\n----\nC:\\proj\n',
    );
    expect(out).toBe('Path\n----\nC:\\proj');
  });

  it('removes leaked ##ATLS_END markers from body', () => {
    expect(
      sanitizeExecOutput('log line\n##ATLS_END_a1b2c3d4_0##\n'),
    ).toBe('log line');
  });

  it('strips echoed temp .ps1 invoke line', () => {
    const out = sanitizeExecOutput(
      "& 'C:\\Users\\x\\AppData\\Local\\Temp\\atls-agent-exec-123-456.ps1'\noutput\n",
    );
    expect(out).toBe('output');
  });
});
