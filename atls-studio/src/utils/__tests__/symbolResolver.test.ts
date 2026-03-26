import { describe, it, expect } from 'vitest';
import {
  resolveSymbolToLines,
  kindToRegexPrefix,
  parseOverloadIndex,
  findBlockEnd,
  extractSymbolNames,
  findSimilarNames,
} from '../symbolResolver';
import { parseSymbolAnchor } from '../hashModifierParser';

// ---------------------------------------------------------------------------
// parseOverloadIndex
// ---------------------------------------------------------------------------

describe('parseOverloadIndex', () => {
  it('returns base name and null for simple names', () => {
    expect(parseOverloadIndex('myFunc')).toEqual(['myFunc', null]);
  });

  it('returns base name and null for names with no hash', () => {
    expect(parseOverloadIndex('MyClass')).toEqual(['MyClass', null]);
  });

  it('parses overload index from name#N', () => {
    expect(parseOverloadIndex('foo#2')).toEqual(['foo', 2]);
    expect(parseOverloadIndex('bar#1')).toEqual(['bar', 1]);
    expect(parseOverloadIndex('baz#10')).toEqual(['baz', 10]);
  });

  it('handles hash at end with non-numeric suffix', () => {
    // '#abc' is not a valid index, so returns full string with null
    expect(parseOverloadIndex('foo#abc')).toEqual(['foo#abc', null]);
  });

  it('handles multiple hashes — uses last one', () => {
    expect(parseOverloadIndex('a#b#3')).toEqual(['a#b', 3]);
  });

  it('handles empty name', () => {
    expect(parseOverloadIndex('')).toEqual(['', null]);
  });

  it('handles name that is just a hash', () => {
    expect(parseOverloadIndex('#2')).toEqual(['', 2]);
  });
});

// ---------------------------------------------------------------------------
// kindToRegexPrefix
// ---------------------------------------------------------------------------

describe('kindToRegexPrefix', () => {
  it('returns fn prefix for "fn"', () => {
    const prefix = kindToRegexPrefix('fn');
    const re = new RegExp(prefix + 'myFunc');
    expect(re.test('function myFunc')).toBe(true);
    expect(re.test('async function myFunc')).toBe(true);
    expect(re.test('def myFunc')).toBe(true);
    expect(re.test('fn myFunc')).toBe(true);
    expect(re.test('pub fn myFunc')).toBe(true);
    expect(re.test('pub(crate) fn myFunc')).toBe(true);
    expect(re.test('pub async fn myFunc')).toBe(true);
  });

  it('returns cls prefix for "cls"', () => {
    const prefix = kindToRegexPrefix('cls');
    const re = new RegExp(prefix + 'MyClass');
    expect(re.test('class MyClass')).toBe(true);
    expect(re.test('export class MyClass')).toBe(true);
    expect(re.test('abstract class MyClass')).toBe(true);
    expect(re.test('export abstract class MyClass')).toBe(true);
    expect(re.test('pub class MyClass')).toBe(true);
  });

  it('returns struct prefix for "struct"', () => {
    const prefix = kindToRegexPrefix('struct');
    const re = new RegExp(prefix + 'MyStruct');
    expect(re.test('struct MyStruct')).toBe(true);
    expect(re.test('pub struct MyStruct')).toBe(true);
    expect(re.test('pub(crate) struct MyStruct')).toBe(true);
  });

  it('returns trait prefix for "trait"', () => {
    const prefix = kindToRegexPrefix('trait');
    const re = new RegExp(prefix + 'MyTrait');
    expect(re.test('trait MyTrait')).toBe(true);
    expect(re.test('interface MyTrait')).toBe(true);
    expect(re.test('export trait MyTrait')).toBe(true);
    expect(re.test('export interface MyTrait')).toBe(true);
    expect(re.test('pub trait MyTrait')).toBe(true);
  });

  it('returns enum prefix for "enum"', () => {
    const prefix = kindToRegexPrefix('enum');
    const re = new RegExp(prefix + 'Color');
    expect(re.test('enum Color')).toBe(true);
    expect(re.test('export enum Color')).toBe(true);
    expect(re.test('pub enum Color')).toBe(true);
  });

  it('returns type prefix for "type"', () => {
    const prefix = kindToRegexPrefix('type');
    const re = new RegExp(prefix + 'MyType');
    expect(re.test('type MyType')).toBe(true);
    expect(re.test('export type MyType')).toBe(true);
    expect(re.test('typedef MyType')).toBe(true);
    expect(re.test('pub type MyType')).toBe(true);
  });

  it('impl prefix matches bare impl, generic impl, and trait-for', () => {
    const prefix = kindToRegexPrefix('impl');
    const re = new RegExp(prefix + 'MyStruct');
    // bare impl now supported
    expect(re.test('impl MyStruct')).toBe(true);
    expect(re.test('pub impl MyStruct')).toBe(true);
    // generic impl
    expect(re.test('impl<T> MyStruct')).toBe(true);
    // trait-for
    expect(re.test('impl Display for MyStruct')).toBe(true);
    expect(re.test('pub impl Display for MyStruct')).toBe(true);
    expect(re.test('pub(crate) impl Display for MyStruct')).toBe(true);
  });

  it('returns const prefix for "const"', () => {
    const prefix = kindToRegexPrefix('const');
    const re = new RegExp(prefix + 'MAX_SIZE');
    expect(re.test('const MAX_SIZE')).toBe(true);
    expect(re.test('static MAX_SIZE')).toBe(true);
    expect(re.test('final MAX_SIZE')).toBe(true);
    expect(re.test('export const MAX_SIZE')).toBe(true);
    expect(re.test('pub const MAX_SIZE')).toBe(true);
    // const with type annotation: `const int MAX_SIZE`
    expect(re.test('const int MAX_SIZE')).toBe(true);
  });

  it('returns default prefix for undefined kind', () => {
    const prefix = kindToRegexPrefix(undefined);
    const re = new RegExp(prefix + 'something');
    // Default matches common declaration keywords
    expect(re.test('function something')).toBe(true);
    expect(re.test('class something')).toBe(true);
    expect(re.test('struct something')).toBe(true);
    expect(re.test('interface something')).toBe(true);
    expect(re.test('enum something')).toBe(true);
  });

  it('returns default prefix for unknown kind', () => {
    const prefix = kindToRegexPrefix('unknown_kind');
    const re = new RegExp(prefix + 'foo');
    // Falls back to default
    expect(re.test('function foo')).toBe(true);
  });

  // ---- New kind prefixes ----

  it('returns protocol prefix for "protocol" (Swift)', () => {
    const prefix = kindToRegexPrefix('protocol');
    const re = new RegExp(prefix + 'Sendable');
    expect(re.test('protocol Sendable')).toBe(true);
    expect(re.test('public protocol Sendable')).toBe(true);
  });

  it('returns record prefix for "record" (Java/C#)', () => {
    const prefix = kindToRegexPrefix('record');
    const re = new RegExp(prefix + 'Point');
    expect(re.test('record Point')).toBe(true);
    expect(re.test('public record Point')).toBe(true);
    expect(re.test('sealed record Point')).toBe(true);
  });

  it('returns extension prefix for "extension" (Swift)', () => {
    const prefix = kindToRegexPrefix('extension');
    const re = new RegExp(prefix + 'Array');
    expect(re.test('extension Array')).toBe(true);
    expect(re.test('public extension Array')).toBe(true);
  });

  it('returns mixin prefix for "mixin" (Dart)', () => {
    const prefix = kindToRegexPrefix('mixin');
    const re = new RegExp(prefix + 'Loggable');
    expect(re.test('mixin Loggable')).toBe(true);
  });

  it('returns macro prefix for "macro" (Rust/C)', () => {
    const prefix = kindToRegexPrefix('macro');
    const re = new RegExp(prefix + 'derive');
    expect(re.test('macro_rules! derive')).toBe(true);
    expect(re.test('macro derive')).toBe(true);
    expect(re.test('pub macro derive')).toBe(true);
  });

  it('returns mod prefix for "mod"/"ns"/"namespace"/"package"', () => {
    for (const kind of ['mod', 'ns', 'namespace', 'package'] as const) {
      const prefix = kindToRegexPrefix(kind);
      const re = new RegExp(prefix + 'utils');
      expect(re.test('mod utils')).toBe(true);
      expect(re.test('namespace utils')).toBe(true);
      expect(re.test('pub mod utils')).toBe(true);
    }
  });

  it('returns ctor prefix for "ctor"', () => {
    const prefix = kindToRegexPrefix('ctor');
    const re = new RegExp(prefix + 'Foo');
    expect(re.test('constructor Foo')).toBe(true);
    expect(re.test('public constructor Foo')).toBe(true);
    expect(re.test('new Foo')).toBe(true);
  });

  it('returns property prefix for "property"', () => {
    const prefix = kindToRegexPrefix('property');
    const re = new RegExp(prefix + 'width');
    expect(re.test('get width')).toBe(true);
    expect(re.test('set width')).toBe(true);
  });

  it('returns field prefix for "field"', () => {
    const prefix = kindToRegexPrefix('field');
    const re = new RegExp(prefix + 'name');
    expect(re.test('name')).toBe(true);
  });

  it('returns enum_member/variant prefix', () => {
    for (const kind of ['enum_member', 'variant'] as const) {
      const prefix = kindToRegexPrefix(kind);
      const re = new RegExp(prefix + 'Red');
      expect(re.test('  Red')).toBe(true);
      expect(re.test('Red')).toBe(true);
    }
  });

  it('returns operator prefix for "operator"', () => {
    const prefix = kindToRegexPrefix('operator');
    const re = new RegExp(prefix + 'add');
    expect(re.test('operator add')).toBe(true);
  });

  it('returns event prefix for "event" (C#)', () => {
    const prefix = kindToRegexPrefix('event');
    const re = new RegExp(prefix + 'OnClick');
    expect(re.test('event EventHandler OnClick')).toBe(true);
  });

  it('returns object prefix for "object" (Kotlin)', () => {
    const prefix = kindToRegexPrefix('object');
    const re = new RegExp(prefix + 'Config');
    expect(re.test('object Config')).toBe(true);
    expect(re.test('companion object Config')).toBe(true);
  });

  it('returns actor prefix for "actor" (Swift)', () => {
    const prefix = kindToRegexPrefix('actor');
    const re = new RegExp(prefix + 'Worker');
    expect(re.test('actor Worker')).toBe(true);
    expect(re.test('public actor Worker')).toBe(true);
  });

  it('returns union prefix for "union" (C/C++)', () => {
    const prefix = kindToRegexPrefix('union');
    const re = new RegExp(prefix + 'Data');
    expect(re.test('union Data')).toBe(true);
  });

  it('returns static prefix for "static"', () => {
    const prefix = kindToRegexPrefix('static');
    const re = new RegExp(prefix + 'INSTANCE');
    expect(re.test('static INSTANCE')).toBe(true);
    expect(re.test('pub static INSTANCE')).toBe(true);
  });

  it('fn prefix matches unsafe, extern, fun (Kotlin), method', () => {
    const prefix = kindToRegexPrefix('fn');
    expect(new RegExp(prefix + 'foo').test('unsafe fn foo')).toBe(true);
    expect(new RegExp(prefix + 'foo').test('pub unsafe fn foo')).toBe(true);
    expect(new RegExp(prefix + 'foo').test('fun foo')).toBe(true);
    expect(new RegExp(prefix + 'foo').test('method foo')).toBe(true);
    expect(new RegExp(prefix + 'foo').test('pub const fn foo')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findBlockEnd
// ---------------------------------------------------------------------------

describe('findBlockEnd', () => {
  it('finds end of single-line block', () => {
    const lines = ['function foo() { return 1; }'];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(0);
  });

  it('finds end of multi-line block', () => {
    const lines = [
      'function foo() {',
      '  const x = 1;',
      '  return x;',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(3);
  });

  it('handles nested braces', () => {
    const lines = [
      'function foo() {',
      '  if (true) {',
      '    return 1;',
      '  }',
      '  return 0;',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(5);
  });

  it('handles deeply nested braces', () => {
    const lines = [
      'function foo() {',
      '  if (a) {',
      '    if (b) {',
      '      doStuff();',
      '    }',
      '  }',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(6);
  });

  it('handles statement ending with semicolon (no block)', () => {
    const lines = ['type Foo = string;'];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(0);
  });

  it('handles block starting mid-file', () => {
    const lines = [
      '// comment',
      'function bar() {',
      '  return 42;',
      '}',
      '// more code',
    ];
    expect(findBlockEnd(lines, 1, lines.length)).toBe(3);
  });

  it('returns last line when no closing brace found', () => {
    const lines = [
      'function broken() {',
      '  return 1;',
      '  // missing closing brace',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(2);
  });

  it('handles empty lines array gracefully', () => {
    expect(findBlockEnd([], 0, 0)).toBe(0);
  });

  it('handles line with semicolon AND braces — brace wins', () => {
    // e.g. `const obj = { a: 1; b: 2 };` — has both ; and {}
    // The trimmed line ends with ';' but also contains '{'
    // Since the check is `endsWith(';') && !includes('{')`, this won't short-circuit
    const lines = ['const obj = { a: 1 };'];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(0);
  });

  it('handles class with methods', () => {
    const lines = [
      'class Foo {',
      '  method() {',
      '    return 1;',
      '  }',
      '',
      '  other() {',
      '    return 2;',
      '  }',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(8);
  });

  it('handles starting at inner method', () => {
    const lines = [
      'class Foo {',
      '  method() {',
      '    return 1;',
      '  }',
      '',
      '  other() {',
      '    return 2;',
      '  }',
      '}',
    ];
    // Starting at line 1 (method), should find its closing brace at line 3
    expect(findBlockEnd(lines, 1, lines.length)).toBe(3);
  });

  // ---- String/comment awareness ----

  it('ignores braces inside double-quoted strings', () => {
    const lines = [
      'function foo() {',
      '  const s = "{ not a block }";',
      '  return s;',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(3);
  });

  it('ignores braces inside single-quoted strings', () => {
    const lines = [
      'function foo() {',
      "  const s = '{ not a block }';",
      '  return s;',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(3);
  });

  it('ignores braces inside template literals', () => {
    const lines = [
      'function foo() {',
      '  const s = `{ template }`;',
      '  return s;',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(3);
  });

  it('ignores braces inside line comments', () => {
    const lines = [
      'function foo() {',
      '  // { this is a comment }',
      '  return 1;',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(3);
  });

  it('ignores braces inside block comments', () => {
    const lines = [
      'function foo() {',
      '  /* { block comment',
      '     } still comment */',
      '  return 1;',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(4);
  });

  // ---- Python indentation-based blocks ----

  it('handles Python function (colon-ending, indentation-based)', () => {
    const lines = [
      'def greet(name):',
      '    return f"Hello, {name}!"',
      '',
      'def other():',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(2);
  });

  it('handles Python class with methods', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.x = 1',
      '',
      '    def run(self):',
      '        return self.x',
      '',
      'class Bar:',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(6);
  });

  it('handles Python method inside class', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.x = 1',
      '',
      '    def run(self):',
      '        return self.x',
    ];
    expect(findBlockEnd(lines, 1, lines.length)).toBe(3);
  });

  // ---- Ruby/Elixir keyword blocks ----

  it('handles Ruby def...end block', () => {
    const lines = [
      'def greet(name)',
      '  puts "Hello #{name}"',
      'end',
      '',
      'def other',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(2);
  });

  it('handles nested Ruby blocks', () => {
    const lines = [
      'def process',
      '  if condition',
      '    do_something',
      '  end',
      '  result',
      'end',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(5);
  });

  // ---- Rust raw strings ----

  it('handles Rust raw strings r#"..."#', () => {
    const lines = [
      'fn foo() {',
      '    let s = r#"{ not a brace }"#;',
      '    return s;',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(3);
  });

  // ---- Rust where clause ----

  it('handles Rust where clause before opening brace', () => {
    const lines = [
      'fn process<T>(x: T)',
      'where',
      '    T: Display + Debug,',
      '{',
      '    println!("{}", x);',
      '}',
    ];
    expect(findBlockEnd(lines, 0, lines.length)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// resolveSymbolToLines — integration tests
// ---------------------------------------------------------------------------

describe('resolveSymbolToLines', () => {
  // -- TypeScript content samples --
  const tsContent = [
    'import { something } from "./mod";',        // 1
    '',                                            // 2
    'export function greet(name: string): string {', // 3
    '  return `Hello, ${name}!`;',                 // 4
    '}',                                           // 5
    '',                                            // 6
    'export class Greeter {',                      // 7
    '  private name: string;',                     // 8
    '',                                            // 9
    '  constructor(name: string) {',               // 10
    '    this.name = name;',                       // 11
    '  }',                                         // 12
    '',                                            // 13
    '  greet(): string {',                         // 14
    '    return `Hello, ${this.name}!`;',          // 15
    '  }',                                         // 16
    '}',                                           // 17
    '',                                            // 18
    'export type GreetResult = string;',           // 19
    '',                                            // 20
    'export interface Logger {',                   // 21
    '  log(msg: string): void;',                   // 22
    '  warn(msg: string): void;',                  // 23
    '}',                                           // 24
    '',                                            // 25
    'export enum Level {',                         // 26
    '  Info = "info",',                           // 27
    '  Warn = "warn",',                           // 28
    '  Error = "error",',                         // 29
    '}',                                           // 30
    '',                                            // 31
    'export const MAX_RETRIES = 3;',               // 32
  ].join('\n');

  // -- Rust content sample --
  const rustContent = [
    'use std::fmt;',                               // 1
    '',                                            // 2
    'pub struct Config {',                         // 3
    '    pub name: String,',                       // 4
    '    pub value: i32,',                         // 5
    '}',                                           // 6
    '',                                            // 7
    'impl Config {',                               // 8
    '    pub fn new(name: &str, value: i32) -> Self {', // 9
    '        Config {',                            // 10
    '            name: name.to_string(),',         // 11
    '            value,',                          // 12
    '        }',                                   // 13
    '    }',                                       // 14
    '',                                            // 15
    '    pub fn display(&self) -> String {',       // 16
    '        format!("{}: {}", self.name, self.value)', // 17
    '    }',                                       // 18
    '}',                                           // 19
    '',                                            // 20
    'pub trait Printable {',                       // 21
    '    fn print(&self);',                        // 22
    '}',                                           // 23
    '',                                            // 24
    'pub enum Status {',                           // 25
    '    Active,',                                 // 26
    '    Inactive,',                               // 27
    '}',                                           // 28
    '',                                            // 29
    'pub(crate) fn helper() {',                    // 30
    '    println!("helper");',                    // 31
    '}',                                           // 32
  ].join('\n');

  // -- Python content sample --
  const pyContent = [
    'import os',                                   // 1
    '',                                            // 2
    'def greet(name):',                            // 3
    '    return f"Hello, {name}!"',              // 4
    '',                                            // 5
    'class Greeter:',                              // 6
    '    def __init__(self, name):',               // 7
    '        self.name = name',                    // 8
    '',                                            // 9
    '    def greet(self):',                        // 10
    '        return f"Hello, {self.name}!"',     // 11
    '',                                            // 12
  ].join('\n');

  // -- Overload content sample --
  const overloadContent = [
    'function process(x: number): number;',        // 1
    'function process(x: string): string;',        // 2
    'function process(x: number | string): number | string {', // 3
    '  if (typeof x === "number") return x * 2;', // 4
    '  return x.toUpperCase();',                   // 5
    '}',                                           // 6
    '',                                            // 7
    'function other() {',                          // 8
    '  return 42;',                                // 9
    '}',                                           // 10
  ].join('\n');

  // ---- TypeScript function resolution ----

  describe('TypeScript functions', () => {
    it('resolves fn(greet) to the function block', () => {
      const result = resolveSymbolToLines(tsContent, 'fn', 'greet');
      expect(result).toEqual([3, 5]);
    });

    it('resolves fn with undefined kind (default prefix)', () => {
      const result = resolveSymbolToLines(tsContent, undefined, 'greet');
      expect(result).toEqual([3, 5]);
    });

    it('returns null for non-existent function', () => {
      expect(resolveSymbolToLines(tsContent, 'fn', 'nonExistent')).toBeNull();
    });
  });

  // ---- TypeScript class resolution ----

  describe('TypeScript classes', () => {
    it('resolves cls(Greeter) to the full class block', () => {
      const result = resolveSymbolToLines(tsContent, 'cls', 'Greeter');
      expect(result).toEqual([7, 17]);
    });

    it('returns null for non-existent class', () => {
      expect(resolveSymbolToLines(tsContent, 'cls', 'NonExistent')).toBeNull();
    });
  });

  // ---- TypeScript type/interface/enum ----

  describe('TypeScript types, interfaces, enums', () => {
    it('resolves type(GreetResult) — single-line type', () => {
      const result = resolveSymbolToLines(tsContent, 'type', 'GreetResult');
      expect(result).toEqual([19, 19]);
    });

    it('resolves trait(Logger) — interface via trait kind', () => {
      const result = resolveSymbolToLines(tsContent, 'trait', 'Logger');
      expect(result).toEqual([21, 24]);
    });

    it('resolves enum(Level)', () => {
      const result = resolveSymbolToLines(tsContent, 'enum', 'Level');
      expect(result).toEqual([26, 30]);
    });

    it('resolves const(MAX_RETRIES)', () => {
      const result = resolveSymbolToLines(tsContent, 'const', 'MAX_RETRIES');
      expect(result).toEqual([32, 32]);
    });
  });

  // ---- Rust resolution ----

  describe('Rust symbols', () => {
    it('resolves struct(Config)', () => {
      const result = resolveSymbolToLines(rustContent, 'struct', 'Config');
      expect(result).toEqual([3, 6]);
    });

    it('resolves impl(Config) — bare impl now supported', () => {
      const result = resolveSymbolToLines(rustContent, 'impl', 'Config');
      expect(result).toEqual([8, 19]);
    });

    it('resolves impl(Config) with trait-for syntax', () => {
      const traitImplContent = [
        'pub struct Config {',
        '  pub name: String,',
        '}',
        '',
        'impl Display for Config {',
        '  fn fmt(&self, f: &mut Formatter) -> Result {',
        '    write!(f, "{}", self.name)',
        '  }',
        '}',
      ].join('\n');
      const result = resolveSymbolToLines(traitImplContent, 'impl', 'Config');
      expect(result).toEqual([5, 9]);
    });

    it('resolves fn(new) inside impl block', () => {
      const result = resolveSymbolToLines(rustContent, 'fn', 'new');
      expect(result).toEqual([9, 14]);
    });

    it('resolves fn(display) inside impl block', () => {
      const result = resolveSymbolToLines(rustContent, 'fn', 'display');
      expect(result).toEqual([16, 18]);
    });

    it('resolves trait(Printable)', () => {
      const result = resolveSymbolToLines(rustContent, 'trait', 'Printable');
      expect(result).toEqual([21, 23]);
    });

    it('resolves enum(Status)', () => {
      const result = resolveSymbolToLines(rustContent, 'enum', 'Status');
      expect(result).toEqual([25, 28]);
    });

    it('resolves pub(crate) fn helper', () => {
      const result = resolveSymbolToLines(rustContent, 'fn', 'helper');
      expect(result).toEqual([30, 32]);
    });
  });

  // ---- Tiered fallback: JS/TS class method shorthand ----

  describe('Tier 1.5a: JS/TS class method shorthand', () => {
    const classContent = [
      'class UserService {',
      '  async getUser(id: string) {',
      '    return db.get(id);',
      '  }',
      '',
      '  static create() {',
      '    return new UserService();',
      '  }',
      '',
      '  get name() {',
      '    return this._name;',
      '  }',
      '}',
    ].join('\n');

    it('resolves class method shorthand getUser via fallback', () => {
      const result = resolveSymbolToLines(classContent, 'fn', 'getUser');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(2);
      expect(result![1]).toBe(4);
    });

    it('resolves static class method create via fallback', () => {
      const result = resolveSymbolToLines(classContent, 'fn', 'create');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(6);
      expect(result![1]).toBe(8);
    });

    it('resolves getter name via fallback', () => {
      const result = resolveSymbolToLines(classContent, 'fn', 'name');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(10);
      expect(result![1]).toBe(12);
    });
  });

  // ---- Tiered fallback: Variable-bound arrow functions ----

  describe('Tier 1.5b: Variable-bound arrow functions', () => {
    const arrowContent = [
      'export const handler = async (req: Request) => {',
      '  return new Response("ok");',
      '};',
      '',
      'const processItem = (item: Item): Result => {',
      '  return transform(item);',
      '};',
    ].join('\n');

    it('resolves const arrow function handler', () => {
      const result = resolveSymbolToLines(arrowContent, 'fn', 'handler');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(1);
      expect(result![1]).toBe(3);
    });

    it('resolves const arrow function processItem', () => {
      const result = resolveSymbolToLines(arrowContent, 'fn', 'processItem');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(5);
      expect(result![1]).toBe(7);
    });
  });

  // ---- Tiered fallback: C-family return-type syntax ----

  describe('Tier 2: C-family return-type syntax', () => {
    const cContent = [
      'void parse_number(const char* s) {',
      '    int result = 0;',
      '    // parsing logic',
      '}',
      '',
      'public String toJson() {',
      '    return gson.toJson(this);',
      '}',
    ].join('\n');

    it('resolves C-style function with return type', () => {
      const result = resolveSymbolToLines(cContent, 'fn', 'parse_number');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(1);
      expect(result![1]).toBe(4);
    });

    it('resolves Java-style method with return type', () => {
      const result = resolveSymbolToLines(cContent, 'fn', 'toJson');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(6);
      expect(result![1]).toBe(8);
    });
  });

  // ---- Tiered fallback: Go type declarations ----

  describe('Tier 3: Go type declarations', () => {
    const goContent = [
      'package main',
      '',
      'type Config struct {',
      '    Name string',
      '    Value int',
      '}',
      '',
      'type Handler interface {',
      '    Handle(ctx Context) error',
      '}',
    ].join('\n');

    it('resolves Go struct type declaration', () => {
      const result = resolveSymbolToLines(goContent, 'struct', 'Config');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(3);
      expect(result![1]).toBe(6);
    });

    it('resolves Go interface type declaration', () => {
      const result = resolveSymbolToLines(goContent, 'trait', 'Handler');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(8);
      expect(result![1]).toBe(10);
    });
  });

  // ---- New kind resolution ----

  describe('New kind resolution', () => {
    it('resolves Swift protocol', () => {
      const content = 'public protocol Sendable {\n    func send()\n}';
      const result = resolveSymbolToLines(content, 'protocol', 'Sendable');
      expect(result).toEqual([1, 3]);
    });

    it('resolves Kotlin object', () => {
      const content = 'object Config {\n    val name = "default"\n}';
      const result = resolveSymbolToLines(content, 'object', 'Config');
      expect(result).toEqual([1, 3]);
    });

    it('resolves Swift actor', () => {
      const content = 'public actor Worker {\n    func run() {}\n}';
      const result = resolveSymbolToLines(content, 'actor', 'Worker');
      expect(result).toEqual([1, 3]);
    });

    it('resolves Rust macro_rules!', () => {
      const content = 'macro_rules! my_macro {\n    ($x:expr) => { $x * 2 };\n}';
      const result = resolveSymbolToLines(content, 'macro', 'my_macro');
      expect(result).toEqual([1, 3]);
    });

    it('resolves Rust mod', () => {
      const content = 'pub mod utils {\n    pub fn helper() {}\n}';
      const result = resolveSymbolToLines(content, 'mod', 'utils');
      expect(result).toEqual([1, 3]);
    });

    it('resolves namespace', () => {
      const content = 'namespace Utils {\n    export function helper() {}\n}';
      const result = resolveSymbolToLines(content, 'namespace', 'Utils');
      expect(result).toEqual([1, 3]);
    });

    it('resolves Swift extension', () => {
      const content = 'extension Array {\n    func first() -> Element? { nil }\n}';
      const result = resolveSymbolToLines(content, 'extension', 'Array');
      expect(result).toEqual([1, 3]);
    });

    it('resolves Dart mixin', () => {
      const content = 'mixin Loggable {\n    void log(String msg) {}\n}';
      const result = resolveSymbolToLines(content, 'mixin', 'Loggable');
      expect(result).toEqual([1, 3]);
    });

    it('resolves Java record', () => {
      const content = 'public record Point(int x, int y) {\n    public int sum() { return x + y; }\n}';
      const result = resolveSymbolToLines(content, 'record', 'Point');
      expect(result).toEqual([1, 3]);
    });

    it('resolves Rust impl with generics', () => {
      const content = 'impl<T: Debug> MyStruct<T> {\n    fn new() -> Self { todo!() }\n}';
      const result = resolveSymbolToLines(content, 'impl', 'MyStruct');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(1);
      expect(result![1]).toBe(3);
    });
  });

  // ---- Python resolution ----

  describe('Python symbols', () => {
    it('resolves def greet (fn kind)', () => {
      const result = resolveSymbolToLines(pyContent, 'fn', 'greet');
      // First match is the module-level `def greet` at line 3
      expect(result).toEqual([3, 5]);
    });

    it('resolves class Greeter (cls kind)', () => {
      const result = resolveSymbolToLines(pyContent, 'cls', 'Greeter');
      // Python class — no closing brace, so findBlockEnd goes to end of file
      expect(result).not.toBeNull();
      expect(result![0]).toBe(6);
    });
  });

  // ---- Overload resolution ----

  describe('overload resolution', () => {
    it('resolves first overload by default (process)', () => {
      const result = resolveSymbolToLines(overloadContent, 'fn', 'process');
      // First match at line 1 (the first overload declaration)
      expect(result).not.toBeNull();
      expect(result![0]).toBe(1);
    });

    it('resolves specific overload with process#2', () => {
      const result = resolveSymbolToLines(overloadContent, 'fn', 'process#2');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(2);
    });

    it('resolves implementation overload with process#3', () => {
      const result = resolveSymbolToLines(overloadContent, 'fn', 'process#3');
      expect(result).not.toBeNull();
      expect(result![0]).toBe(3);
      expect(result![1]).toBe(6); // closing brace of implementation
    });

    it('returns null for out-of-range overload index', () => {
      expect(resolveSymbolToLines(overloadContent, 'fn', 'process#4')).toBeNull();
      expect(resolveSymbolToLines(overloadContent, 'fn', 'process#0')).toBeNull();
    });

    it('resolves non-overloaded function normally', () => {
      const result = resolveSymbolToLines(overloadContent, 'fn', 'other');
      expect(result).toEqual([8, 10]);
    });
  });

  // ---- sym() — no kind, uses default prefix ----

  describe('sym() — no kind (default prefix)', () => {
    it('resolves sym(greet) using default prefix', () => {
      // Default prefix matches common keywords: fn, function, def, class, struct, etc.
      const result = resolveSymbolToLines(tsContent, undefined, 'greet');
      expect(result).toEqual([3, 5]);
    });

    it('resolves sym(Greeter) using default prefix', () => {
      const result = resolveSymbolToLines(tsContent, undefined, 'Greeter');
      expect(result).toEqual([7, 17]);
    });

    it('resolves sym(Logger) using default prefix — matches interface', () => {
      const result = resolveSymbolToLines(tsContent, undefined, 'Logger');
      expect(result).toEqual([21, 24]);
    });

    it('resolves sym(Level) using default prefix — matches enum', () => {
      const result = resolveSymbolToLines(tsContent, undefined, 'Level');
      expect(result).toEqual([26, 30]);
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('returns null for empty content', () => {
      expect(resolveSymbolToLines('', 'fn', 'foo')).toBeNull();
    });

    it('handles names with regex special characters', () => {
      const content = 'function $special(x) {\n  return x;\n}';
      const result = resolveSymbolToLines(content, 'fn', '$special');
      expect(result).toEqual([1, 3]);
    });

    it('does not match partial names', () => {
      const content = 'function fooBar() {\n  return 1;\n}';
      // Looking for 'foo' should NOT match 'fooBar' because the regex requires
      // a non-word boundary after the name (whitespace, <, (, {, etc.)
      expect(resolveSymbolToLines(content, 'fn', 'foo')).toBeNull();
    });

    it('matches name followed by generic bracket', () => {
      const content = 'function identity<T>(x: T): T {\n  return x;\n}';
      const result = resolveSymbolToLines(content, 'fn', 'identity');
      expect(result).toEqual([1, 3]);
    });

    it('matches name followed by opening paren', () => {
      const content = 'function run() {\n  console.log("run");\n}';
      const result = resolveSymbolToLines(content, 'fn', 'run');
      expect(result).toEqual([1, 3]);
    });

    it('matches name at end of line', () => {
      // Some languages: `fn foo` on one line, body on next
      const content = 'fn foo\n{\n  42\n}';
      const result = resolveSymbolToLines(content, 'fn', 'foo');
      expect(result).toEqual([1, 4]);
    });

    it('handles async function', () => {
      const content = 'async function fetchData() {\n  return await fetch("/api");\n}';
      const result = resolveSymbolToLines(content, 'fn', 'fetchData');
      expect(result).toEqual([1, 3]);
    });

    it('handles export async function', () => {
      // Note: 'fn' kind prefix doesn't include 'export' — but the regex
      // matches `async function` which can appear after export
      const content = 'export async function fetchData() {\n  return await fetch("/api");\n}';
      const result = resolveSymbolToLines(content, 'fn', 'fetchData');
      expect(result).toEqual([1, 3]);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: parseSymbolAnchor -> resolveSymbolToLines pipeline
// ---------------------------------------------------------------------------

describe('parseSymbolAnchor + resolveSymbolToLines integration', () => {

  const content = [
    'export function alpha() {',    // 1
    '  return 1;',                   // 2
    '}',                             // 3
    '',                              // 4
    'export class Beta {',           // 5
    '  run() {',                     // 6
    '    return 2;',                 // 7
    '  }',                           // 8
    '}',                             // 9
  ].join('\n');

  it('parses fn(alpha) and resolves to lines', () => {
    const mod = parseSymbolAnchor('fn(alpha)');
    expect(mod).not.toBeNull();
    const { kind, name } = mod.symbol;
    const result = resolveSymbolToLines(content, kind, name);
    expect(result).toEqual([1, 3]);
  });

  it('parses cls(Beta) and resolves to lines', () => {
    const mod = parseSymbolAnchor('cls(Beta)');
    expect(mod).not.toBeNull();
    const { kind, name } = mod.symbol;
    const result = resolveSymbolToLines(content, kind, name);
    expect(result).toEqual([5, 9]);
  });

  it('parses sym(alpha) and resolves to lines (default prefix)', () => {
    const mod = parseSymbolAnchor('sym(alpha)');
    expect(mod).not.toBeNull();
    const { kind, name } = mod.symbol;
    const result = resolveSymbolToLines(content, kind, name);
    expect(result).toEqual([1, 3]);
  });

  it('parses fn(alpha):sig — shape is preserved but does not affect line resolution', () => {
    const mod = parseSymbolAnchor('fn(alpha):sig');
    expect(mod).not.toBeNull();
    expect(mod.symbol.shape).toBe('sig');
    const { kind, name } = mod.symbol;
    const result = resolveSymbolToLines(content, kind, name);
    expect(result).toEqual([1, 3]);
  });

  it('returns null for non-existent symbol', () => {
    const mod = parseSymbolAnchor('fn(nonExistent)');
    expect(mod).not.toBeNull();
    const { kind, name } = mod.symbol;
    const result = resolveSymbolToLines(content, kind, name);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional anchor prefix coverage
// ---------------------------------------------------------------------------

describe('all UHPP anchor prefixes', () => {

  it('parses fn(name)', () => {
    const r = parseSymbolAnchor('fn(foo)');
    expect(r).toEqual({ symbol: { kind: 'fn', name: 'foo', shape: undefined } });
  });

  it('rejects func(name) — not a registered prefix', () => {
    expect(parseSymbolAnchor('func(foo)')).toBeNull();
  });

  it('rejects function(name) — not a registered prefix', () => {
    expect(parseSymbolAnchor('function(foo)')).toBeNull();
  });

  it('rejects def(name) — not a registered prefix', () => {
    expect(parseSymbolAnchor('def(foo)')).toBeNull();
  });

  it('rejects method(name) — not a registered prefix', () => {
    expect(parseSymbolAnchor('method(foo)')).toBeNull();
  });

  it('parses cls(name)', () => {
    const r = parseSymbolAnchor('cls(Foo)');
    expect(r).toEqual({ symbol: { kind: 'cls', name: 'Foo', shape: undefined } });
  });

  it('parses class(name) — alias for cls', () => {
    const r = parseSymbolAnchor('class(Foo)');
    expect(r).toEqual({ symbol: { kind: 'cls', name: 'Foo', shape: undefined } });
  });

  it('parses struct(name)', () => {
    const r = parseSymbolAnchor('struct(Foo)');
    expect(r).toEqual({ symbol: { kind: 'struct', name: 'Foo', shape: undefined } });
  });

  it('parses trait(name)', () => {
    const r = parseSymbolAnchor('trait(Foo)');
    expect(r).toEqual({ symbol: { kind: 'trait', name: 'Foo', shape: undefined } });
  });

  it('rejects iface(name) — not a registered prefix', () => {
    expect(parseSymbolAnchor('iface(Foo)')).toBeNull();
  });

  it('parses interface(name) — alias for trait', () => {
    const r = parseSymbolAnchor('interface(Foo)');
    expect(r).toEqual({ symbol: { kind: 'trait', name: 'Foo', shape: undefined } });
  });

  it('parses enum(name)', () => {
    const r = parseSymbolAnchor('enum(Color)');
    expect(r).toEqual({ symbol: { kind: 'enum', name: 'Color', shape: undefined } });
  });

  it('parses type(name)', () => {
    const r = parseSymbolAnchor('type(MyType)');
    expect(r).toEqual({ symbol: { kind: 'type', name: 'MyType', shape: undefined } });
  });

  it('rejects typedef(name) — not a registered prefix', () => {
    expect(parseSymbolAnchor('typedef(MyType)')).toBeNull();
  });

  it('parses impl(name)', () => {
    const r = parseSymbolAnchor('impl(Foo)');
    expect(r).toEqual({ symbol: { kind: 'impl', name: 'Foo', shape: undefined } });
  });

  it('parses const(name)', () => {
    const r = parseSymbolAnchor('const(MAX)');
    expect(r).toEqual({ symbol: { kind: 'const', name: 'MAX', shape: undefined } });
  });

  it('parses static(name) — own canonical kind, not aliased to const', () => {
    const r = parseSymbolAnchor('static(MAX)');
    expect(r).toEqual({ symbol: { kind: 'static', name: 'MAX', shape: undefined } });
  });

  it('parses sym(name) — no canonical kind', () => {
    const r = parseSymbolAnchor('sym(anything)');
    expect(r).toEqual({ symbol: { name: 'anything', shape: undefined } });
  });

  it('rejects symbol(name) — not a registered prefix', () => {
    expect(parseSymbolAnchor('symbol(anything)')).toBeNull();
  });

  // Additional prefixes from UHPP_ANCHOR_PREFIXES
  it('parses protocol(name)', () => {
    const r = parseSymbolAnchor('protocol(Sendable)');
    expect(r).toEqual({ symbol: { kind: 'protocol', name: 'Sendable', shape: undefined } });
  });

  it('parses record(name)', () => {
    const r = parseSymbolAnchor('record(Point)');
    expect(r).toEqual({ symbol: { kind: 'record', name: 'Point', shape: undefined } });
  });

  it('parses extension(name)', () => {
    const r = parseSymbolAnchor('extension(Array)');
    expect(r).toEqual({ symbol: { kind: 'extension', name: 'Array', shape: undefined } });
  });

  it('parses mixin(name)', () => {
    const r = parseSymbolAnchor('mixin(Loggable)');
    expect(r).toEqual({ symbol: { kind: 'mixin', name: 'Loggable', shape: undefined } });
  });

  it('parses mod(name)', () => {
    const r = parseSymbolAnchor('mod(utils)');
    expect(r).toEqual({ symbol: { kind: 'mod', name: 'utils', shape: undefined } });
  });

  it('parses ns(name) — alias for mod', () => {
    const r = parseSymbolAnchor('ns(utils)');
    expect(r).toEqual({ symbol: { kind: 'mod', name: 'utils', shape: undefined } });
  });

  it('parses namespace(name) — alias for mod', () => {
    const r = parseSymbolAnchor('namespace(utils)');
    expect(r).toEqual({ symbol: { kind: 'mod', name: 'utils', shape: undefined } });
  });

  it('parses package(name) — alias for mod', () => {
    const r = parseSymbolAnchor('package(utils)');
    expect(r).toEqual({ symbol: { kind: 'mod', name: 'utils', shape: undefined } });
  });

  it('parses macro(name)', () => {
    const r = parseSymbolAnchor('macro(derive)');
    expect(r).toEqual({ symbol: { kind: 'macro', name: 'derive', shape: undefined } });
  });

  it('parses ctor(name)', () => {
    const r = parseSymbolAnchor('ctor(Foo)');
    expect(r).toEqual({ symbol: { kind: 'ctor', name: 'Foo', shape: undefined } });
  });

  it('parses property(name)', () => {
    const r = parseSymbolAnchor('property(width)');
    expect(r).toEqual({ symbol: { kind: 'property', name: 'width', shape: undefined } });
  });

  it('parses field(name) — own canonical kind, not aliased to property', () => {
    const r = parseSymbolAnchor('field(width)');
    expect(r).toEqual({ symbol: { kind: 'field', name: 'width', shape: undefined } });
  });

  it('parses enum_member(name)', () => {
    const r = parseSymbolAnchor('enum_member(Red)');
    expect(r).toEqual({ symbol: { kind: 'enum_member', name: 'Red', shape: undefined } });
  });

  it('parses variant(name) — alias for enum_member', () => {
    const r = parseSymbolAnchor('variant(Red)');
    expect(r).toEqual({ symbol: { kind: 'enum_member', name: 'Red', shape: undefined } });
  });

  it('parses operator(name)', () => {
    const r = parseSymbolAnchor('operator(+)');
    expect(r).toEqual({ symbol: { kind: 'operator', name: '+', shape: undefined } });
  });

  it('parses event(name)', () => {
    const r = parseSymbolAnchor('event(onClick)');
    expect(r).toEqual({ symbol: { kind: 'event', name: 'onClick', shape: undefined } });
  });

  it('parses object(name)', () => {
    const r = parseSymbolAnchor('object(Config)');
    expect(r).toEqual({ symbol: { kind: 'object', name: 'Config', shape: undefined } });
  });

  it('parses actor(name)', () => {
    const r = parseSymbolAnchor('actor(Worker)');
    expect(r).toEqual({ symbol: { kind: 'actor', name: 'Worker', shape: undefined } });
  });

  it('parses union(name)', () => {
    const r = parseSymbolAnchor('union(Result)');
    expect(r).toEqual({ symbol: { kind: 'union', name: 'Result', shape: undefined } });
  });

  it('trims whitespace in symbol name', () => {
    const r = parseSymbolAnchor('fn( myFunc )');
    expect(r).toEqual({ symbol: { kind: 'fn', name: 'myFunc', shape: undefined } });
  });

  it('rejects unknown prefix', () => {
    expect(parseSymbolAnchor('xyz(foo)')).toBeNull();
    expect(parseSymbolAnchor('module(foo)')).toBeNull();
    expect(parseSymbolAnchor('var(foo)')).toBeNull();
  });

  it('supports all prefixes with shape suffix', () => {
    const r = parseSymbolAnchor('struct(Config):fold');
    expect(r).toEqual({ symbol: { kind: 'struct', name: 'Config', shape: 'fold' } });
  });

  it('supports overload syntax in anchor', () => {
    const r = parseSymbolAnchor('fn(process#2)');
    expect(r).toEqual({ symbol: { kind: 'fn', name: 'process#2', shape: undefined } });
  });
});

// ---- Template literal ${} in findBlockEnd ----

describe('findBlockEnd: template literal interpolation', () => {
  it('does not miscount braces inside template literal ${}', () => {
    const lines = [
      'function render() {',
      '  const msg = `Hello ${name}`;',
      '  const html = `<div>${items.map(i => `<span>${i}</span>`).join("")}</div>`;',
      '  return msg;',
      '}',
    ];
    const result = findBlockEnd(lines, 0, lines.length);
    expect(result).toBe(4);
  });

  it('handles nested template literal with object literal inside ${}', () => {
    const lines = [
      'function build() {',
      '  return `result: ${JSON.stringify({ a: 1, b: 2 })}`;',
      '}',
    ];
    const result = findBlockEnd(lines, 0, lines.length);
    expect(result).toBe(2);
  });
});

// ---- Python triple-quote strings in findBlockEnd ----

describe('findBlockEnd: Python triple-quote strings', () => {
  it('skips content inside triple-double-quote strings', () => {
    const lines = [
      'def example():',
      '    """This is a docstring',
      '    with { braces } inside',
      '    """',
      '    return 1',
    ];
    const result = findBlockEnd(lines, 0, lines.length);
    expect(result).toBe(4);
  });

  it('skips content inside triple-single-quote strings', () => {
    const lines = [
      'def parse():',
      "    '''Multi-line",
      '    string with { and }',
      "    '''",
      '    pass',
    ];
    const result = findBlockEnd(lines, 0, lines.length);
    expect(result).toBe(4);
  });
});

// ---- Decorator/annotation rollback ----

describe('Decorator/annotation rollback', () => {
  it('includes Python decorator in symbol range', () => {
    const content = [
      '@app.route("/api")',
      'def handler():',
      '    return "ok"',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'fn', 'handler');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1); // starts at decorator, not def
    expect(result![1]).toBe(3);
  });

  it('includes multiple decorators', () => {
    const content = [
      '@login_required',
      '@cache(timeout=60)',
      'def view():',
      '    pass',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'fn', 'view');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1); // starts at first decorator
  });

  it('includes Rust #[derive] attribute', () => {
    const content = [
      '#[derive(Debug, Clone)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct Config {',
      '    pub name: String,',
      '}',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'struct', 'Config');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1); // starts at #[derive]
    expect(result![1]).toBe(5);
  });

  it('includes JSDoc comment above function', () => {
    const content = [
      '/**',
      ' * Process the input data.',
      ' * @param data - the input',
      ' */',
      'export function process(data: string) {',
      '  return data.trim();',
      '}',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'fn', 'process');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1); // starts at /**
    expect(result![1]).toBe(7);
  });

  it('includes Rust /// doc comments', () => {
    const content = [
      '/// Creates a new instance.',
      '/// Returns None if invalid.',
      'pub fn create() -> Option<Self> {',
      '    Some(Self {})',
      '}',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'fn', 'create');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1); // starts at /// doc
  });

  it('does not roll back past unrelated code', () => {
    const content = [
      'const x = 1;',
      '',
      'function standalone() {',
      '  return x;',
      '}',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'fn', 'standalone');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(3); // does NOT include const x
  });
});

// ---- Lua keyword blocks ----

describe('Lua keyword blocks', () => {
  it('resolves Lua function...end block', () => {
    const content = [
      'function greet(name)',
      '    print("Hello " .. name)',
      'end',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'fn', 'greet');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1);
    expect(result![1]).toBe(3);
  });

  it('resolves local function...end block', () => {
    const content = [
      'local function helper(x)',
      '    if x > 0 then',
      '        return x',
      '    end',
      '    return 0',
      'end',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'fn', 'helper');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1);
    expect(result![1]).toBe(6);
  });
});

// ---- Kotlin receiver functions ----

describe('Kotlin receiver functions', () => {
  it('resolves fun Type.extensionMethod()', () => {
    const content = [
      'fun String.isEmail(): Boolean {',
      '    return this.contains("@")',
      '}',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'fn', 'isEmail');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1);
    expect(result![1]).toBe(3);
  });
});

// ---- Rust nested generics in impl ----

describe('Rust nested generics in impl', () => {
  it('resolves impl with nested angle brackets', () => {
    const content = [
      'impl<T: Into<Vec<u8>>> Parser<T> {',
      '    pub fn parse(&self) -> Result<T, Error> {',
      '        todo!()',
      '    }',
      '}',
    ].join('\n');
    const result = resolveSymbolToLines(content, 'impl', 'Parser');
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1);
    expect(result![1]).toBe(5);
  });
});