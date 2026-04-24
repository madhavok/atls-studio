import { describe, expect, it } from 'vitest';
import { getLanguage } from './languageMap';

describe('getLanguage', () => {
  it('maps common extensions', () => {
    expect(getLanguage('foo.ts')).toBe('typescript');
    expect(getLanguage('a/b.jsx')).toBe('javascript');
    expect(getLanguage('x.rs')).toBe('rust');
    expect(getLanguage('d.py')).toBe('python');
  });

  it('maps special basenames', () => {
    expect(getLanguage('/path/Dockerfile')).toBe('dockerfile');
    expect(getLanguage('Makefile')).toBe('makefile');
    expect(getLanguage('Rakefile')).toBe('ruby');
    expect(getLanguage('Gemfile')).toBe('ruby');
    expect(getLanguage('Cargo.toml')).toBe('toml');
    expect(getLanguage('docker-compose.yml')).toBe('yaml');
    expect(getLanguage('docker-compose.yaml')).toBe('yaml');
    expect(getLanguage('.gitignore')).toBe('ini');
    expect(getLanguage('.env')).toBe('ini');
    expect(getLanguage('.editorconfig')).toBe('ini');
  });

  it('handles dotfiles and compound extensions', () => {
    expect(getLanguage('.eslintrc.json')).toBe('json');
    expect(getLanguage('foo.d.ts')).toBe('typescript');
  });

  it('returns plaintext for unknown extensions', () => {
    expect(getLanguage('weird.unknownext')).toBe('plaintext');
    expect(getLanguage('nope')).toBe('plaintext');
  });
});
