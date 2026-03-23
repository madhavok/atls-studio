/**
 * Unit tests for system operation handlers — git workspace path prefix.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildGitCommand, prefixFilePath, sanitizeExecOutput } from './system';
import type { HandlerContext } from '../types';

function makeCtx(overrides?: Partial<Pick<HandlerContext, 'getWorkspaceRelPath'>>): HandlerContext {
  return {
    store: vi.fn(),
    setLookup: vi.fn(),
    hashLookup: vi.fn(),
    atlsBatchQuery: vi.fn(),
    sessionId: null,
    isSwarmAgent: false,
    getProjectPath: () => null,
    resolveSearchRefs: vi.fn(),
    expandSetRefsInHashes: vi.fn(() => ({ expanded: [], notes: [] })),
    expandFilePathRefs: vi.fn(async () => ({ items: [], notes: [] })),
    ...overrides,
  } as unknown as HandlerContext;
}

describe('prefixFilePath', () => {
  it('prepends rel_path when path does not already have it', () => {
    expect(prefixFilePath('src/foo.ts', 'atls-studio')).toBe('atls-studio/src/foo.ts');
  });

  it('does not double-prefix when path already starts with rel_path', () => {
    expect(prefixFilePath('atls-studio/src/foo.ts', 'atls-studio')).toBe('atls-studio/src/foo.ts');
  });

  it('normalizes backslashes for comparison', () => {
    expect(prefixFilePath('atls-studio\\src\\foo.ts', 'atls-studio')).toBe('atls-studio\\src\\foo.ts');
  });

  it('returns path unchanged when path equals rel_path', () => {
    expect(prefixFilePath('atls-studio', 'atls-studio')).toBe('atls-studio');
  });
});

describe('buildGitCommand workspace path prefix', () => {
  it('prefixes file paths for stage when getWorkspaceRelPath returns workspace', () => {
    const ctx = makeCtx({ getWorkspaceRelPath: () => 'atls-studio' });
    const cmd = buildGitCommand(
      { action: 'stage', files: ['src/services/foo.ts', 'src/utils/bar.ts'] },
      ctx
    );
    expect(cmd).toContain('atls-studio/src/services/foo.ts');
    expect(cmd).toContain('atls-studio/src/utils/bar.ts');
  });

  it('prefixes file paths for unstage when workspace rel_path is set', () => {
    const ctx = makeCtx({ getWorkspaceRelPath: () => 'packages/core' });
    const cmd = buildGitCommand(
      { action: 'unstage', files: ['src/index.ts'] },
      ctx
    );
    expect(cmd).toContain('packages/core/src/index.ts');
  });

  it('does not prefix when getWorkspaceRelPath returns null', () => {
    const ctx = makeCtx({ getWorkspaceRelPath: () => null });
    const cmd = buildGitCommand(
      { action: 'stage', files: ['src/foo.ts'] },
      ctx
    );
    expect(cmd).toContain('src/foo.ts');
    expect(cmd).not.toContain('atls-studio/src/foo.ts');
  });

  it('uses params.workspace to resolve rel_path via getWorkspaceRelPath', () => {
    const getWorkspaceRelPath = vi.fn((name?: string) => (name === 'atls-studio' ? 'atls-studio' : null));
    const ctx = makeCtx({ getWorkspaceRelPath });
    buildGitCommand(
      { action: 'stage', workspace: 'atls-studio', files: ['src/foo.ts'] },
      ctx
    );
    expect(getWorkspaceRelPath).toHaveBeenCalledWith('atls-studio');
  });

  it('does not double-prefix when path already has workspace prefix', () => {
    const ctx = makeCtx({ getWorkspaceRelPath: () => 'atls-studio' });
    const cmd = buildGitCommand(
      { action: 'stage', files: ['atls-studio/src/services/foo.ts'] },
      ctx
    );
    expect(cmd).toContain('atls-studio/src/services/foo.ts');
  });

  it('skips prefix for diff action file paths when no workspace', () => {
    const ctx = makeCtx();
    const cmd = buildGitCommand(
      { action: 'diff', files: ['src/foo.ts'] },
      ctx
    );
    expect(cmd).toContain('src/foo.ts');
  });
});

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
