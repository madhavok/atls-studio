// Map file extensions to Monaco editor languages
const languageMap: Record<string, string> = {
  // TypeScript
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  // JavaScript
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Python
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  pyx: 'python',
  // Rust
  rs: 'rust',
  // Go
  go: 'go',
  // Java
  java: 'java',
  // C
  c: 'c',
  h: 'c',
  // C++
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  hh: 'cpp',
  // C#
  cs: 'csharp',
  csx: 'csharp',
  // PHP
  php: 'php',
  phtml: 'php',
  // Ruby
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  // Swift
  swift: 'swift',
  // Kotlin
  kt: 'kotlin',
  kts: 'kotlin',
  // Scala
  scala: 'scala',
  sc: 'scala',
  // Dart
  dart: 'dart',
  // Lua
  lua: 'lua',
  // R
  r: 'r',
  // Haskell
  hs: 'haskell',
  lhs: 'haskell',
  // Elixir
  ex: 'elixir',
  exs: 'elixir',
  // Clojure
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  // Other common formats
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  env: 'ini',
};

/**
 * Get the Monaco editor language identifier for a given filename.
 * Handles dotfiles, extensionless files, and compound extensions.
 */
export function getLanguage(filename: string): string {
  const baseName = filename.split(/[\\/]/).pop() ?? filename;

  // Handle special filenames
  const specialFiles: Record<string, string> = {
    Dockerfile: 'dockerfile',
    Makefile: 'makefile',
    Rakefile: 'ruby',
    Gemfile: 'ruby',
    'Cargo.toml': 'toml',
    'docker-compose.yml': 'yaml',
    'docker-compose.yaml': 'yaml',
    '.gitignore': 'ini',
    '.env': 'ini',
    '.editorconfig': 'ini',
  };
  if (specialFiles[baseName]) return specialFiles[baseName];

  // Extract extension
  const ext = baseName.startsWith('.') && !baseName.slice(1).includes('.')
    ? ''
    : baseName.includes('.')
      ? baseName.split('.').pop()?.toLowerCase() ?? ''
      : '';

  return languageMap[ext] || 'plaintext';
}
