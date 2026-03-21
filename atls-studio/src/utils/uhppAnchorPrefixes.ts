/**
 * Canonical mirror of `src-tauri/src/shape_ops.rs` `UHPP_ANCHOR_PREFIXES`.
 * Keep in sync when Rust changes; order matches Rust for diff sanity.
 */
export const UHPP_ANCHOR_PREFIXES: Array<[string, string | null]> = [
  ['fn', 'fn'],
  ['sym', null],
  ['cls', 'cls'],
  ['class', 'cls'],
  ['struct', 'struct'],
  ['trait', 'trait'],
  ['interface', 'trait'],
  ['protocol', 'protocol'],
  ['enum', 'enum'],
  ['record', 'record'],
  ['extension', 'extension'],
  ['mixin', 'mixin'],
  ['impl', 'impl'],
  ['type', 'type'],
  ['const', 'const'],
  ['static', 'static'],
  ['mod', 'mod'],
  ['ns', 'mod'],
  ['namespace', 'mod'],
  ['package', 'mod'],
  ['macro', 'macro'],
  ['ctor', 'ctor'],
  ['property', 'property'],
  ['field', 'field'],
  ['enum_member', 'enum_member'],
  ['variant', 'enum_member'],
  ['operator', 'operator'],
  ['event', 'event'],
  ['object', 'object'],
  ['actor', 'actor'],
  ['union', 'union'],
];

/** Regex fragment for one modifier token after `h:HEX` (used by INLINE_HREF_DETECT, HREF_PATTERN). */
export function buildHashModifierTokenRe(): string {
  const kinds = UHPP_ANCHOR_PREFIXES.map(([p]) => p).join('|');
  return `(?:[0-9]+(?:-[0-9]*)?(?:,[0-9]+(?:-[0-9]*)?)*|(?:${kinds})\\([^)]+\\)|sig|fold|dedent|nocomment|imports|exports|content|source|tokens|meta|lang|head\\(\\d+\\)|tail\\(\\d+\\)|grep\\([^)]+\\)|ex\\([^)]+\\)|hl\\([^)]+\\)|concept\\([^)]+\\)|pattern\\([^)]+\\)|if\\([^)]+\\))`;
}
