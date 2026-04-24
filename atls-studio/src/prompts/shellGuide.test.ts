import { describe, expect, it } from 'vitest';
import { getShellGuide } from './shellGuide';

describe('getShellGuide', () => {
  it('returns PowerShell block for powershell', () => {
    const g = getShellGuide('powershell');
    expect(g).toContain('PowerShell');
    expect(g).toContain('Get-Content');
  });

  it('returns unix block for bash and zsh', () => {
    for (const sh of ['bash', 'zsh'] as const) {
      const g = getShellGuide(sh);
      expect(g).toContain('Bash');
      expect(g).toMatch(/NEVER use cat/i);
    }
  });

  it('returns generic one-liner for other shells', () => {
    expect(getShellGuide('fish')).toContain('fish');
  });
});
