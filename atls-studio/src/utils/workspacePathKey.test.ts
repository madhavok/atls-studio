import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getConfiguredWorkspacePrefixes,
  workspacePathKey,
  workspacePathKeyDefault,
} from './workspacePathKey';
import { useAppStore } from '../stores/appStore';

const snapshot = useAppStore.getState().projectProfile;

afterEach(() => {
  useAppStore.setState({ projectProfile: snapshot ?? null });
});

describe('workspacePathKey (pure)', () => {
  it('lowercases and flips backslashes', () => {
    expect(workspacePathKey('SRC\\Foo.ts')).toBe('src/foo.ts');
  });

  it('strips a matching prefix (trailing slash tolerant)', () => {
    expect(workspacePathKey('atls-studio/src/foo.ts', { prefixes: ['atls-studio/'] }))
      .toBe('src/foo.ts');
    expect(workspacePathKey('atls-studio/src/foo.ts', { prefixes: ['atls-studio'] }))
      .toBe('src/foo.ts');
  });

  it('strips at most one prefix from the head', () => {
    expect(workspacePathKey('atls-studio/atls-studio/nested.ts', { prefixes: ['atls-studio'] }))
      .toBe('atls-studio/nested.ts');
  });

  it('leaves non-matching paths alone', () => {
    expect(workspacePathKey('docs/foo.md', { prefixes: ['atls-studio/'] }))
      .toBe('docs/foo.md');
  });

  it('matches case-insensitively', () => {
    expect(workspacePathKey('ATLS-STUDIO/SRC/foo.ts', { prefixes: ['atls-studio/'] }))
      .toBe('src/foo.ts');
  });

  it('returns empty string for empty / non-string input', () => {
    expect(workspacePathKey('')).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(workspacePathKey(null as any)).toBe('');
  });

  it('returns empty when trim collapses the path', () => {
    expect(workspacePathKey('   ')).toBe('');
  });

  it('skips empty prefix entries', () => {
    expect(
      workspacePathKey('atls-studio/src/foo.ts', { prefixes: ['', 'atls-studio'] }),
    ).toBe('src/foo.ts');
  });

  it('accepts multiple prefixes and strips the first match', () => {
    expect(workspacePathKey('backend/src/lib.rs', { prefixes: ['atls-studio', 'backend'] }))
      .toBe('src/lib.rs');
  });
});

describe('workspacePathKeyDefault (config-derived)', () => {
  it('falls back to legacy atls-studio/ prefix when no profile is loaded', () => {
    useAppStore.setState({ projectProfile: null });
    expect(workspacePathKeyDefault('atls-studio/src/foo.ts')).toBe('src/foo.ts');
  });

  it('uses configured workspaces when a profile is loaded', () => {
    useAppStore.setState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projectProfile: {
        workspaces: [
          { name: 'backend', path: 'backend', abs_path: '/abs/backend', types: [], build_files: [], group: null, source: 'auto' },
          { name: 'frontend', path: 'frontend', abs_path: '/abs/frontend', types: [], build_files: [], group: null, source: 'auto' },
        ],
      } as unknown as ReturnType<typeof useAppStore.getState>['projectProfile'],
    });
    expect(workspacePathKeyDefault('backend/src/lib.rs')).toBe('src/lib.rs');
    expect(workspacePathKeyDefault('frontend/src/App.tsx')).toBe('src/app.tsx');
    expect(workspacePathKeyDefault('docs/readme.md')).toBe('docs/readme.md');
  });

  it('ignores root workspace (path = ".") entries', () => {
    useAppStore.setState({
      projectProfile: {
        workspaces: [
          { name: 'root', path: '.', types: [], build_files: [], group: null, source: 'auto' },
        ],
      } as unknown as ReturnType<typeof useAppStore.getState>['projectProfile'],
    });
    // No real prefixes present → falls back to legacy default.
    expect(workspacePathKeyDefault('atls-studio/src/foo.ts')).toBe('src/foo.ts');
  });

  it('ignores workspace rows with non-string path', () => {
    useAppStore.setState({
      projectProfile: {
        workspaces: [
          {
            name: 'bad',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            path: null as any,
            types: [],
            build_files: [],
            group: null,
            source: 'auto',
          },
          { name: 'good', path: 'pkg', types: [], build_files: [], group: null, source: 'auto' },
        ],
      } as unknown as ReturnType<typeof useAppStore.getState>['projectProfile'],
    });
    expect(getConfiguredWorkspacePrefixes()).toEqual(['pkg']);
  });

  it('falls back to legacy prefixes when app store read throws', () => {
    const spy = vi.spyOn(useAppStore, 'getState').mockImplementation(() => {
      throw new Error('store unavailable');
    });
    expect(getConfiguredWorkspacePrefixes()).toEqual(['atls-studio/']);
    spy.mockRestore();
  });
});
