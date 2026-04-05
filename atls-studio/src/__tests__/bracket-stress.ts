/**
 * Bracket Stress Test — exercises edge cases for edit tooling.
 * Contains: nested generics, template literals with braces, regex,
 * comments with brackets, destructuring, and intentional complexity.
 */

// Simple bracket pairs: () [] {} <>
type Pair<A, B> = { first: A; second: B };
type Nested<A extends Record<string, Array<Pair<A, B>>>, B> = {
  data: Map<string, Set<Array<[A, B]>>>;
  // This comment has {braces} and [brackets] and (parens)
};

/* Multi-line comment with brackets:
 * function fake() { return [1, 2, {a: 3}]; }
 * const x = (a: number) => { return a * 2; };
 * type T = Record<string, Array<number>>;
 */

interface DeepNest {
  a: {
    b: {
      c: {
        d: {
          value: string;
          count: number;  // added inside 4-deep nesting
          // deeply nested comment with { open brace but no close
        };
      };
    };
  };
}

// Regex with brackets (tricky for parsers)
const BRACKET_REGEX = /[\[\]{}()]/g;
const COMPLEX_REGEX = /\{[^}]*\}|\([^)]*\)|\[[^\]]*\]/g;
const ESCAPE_HELL = /\\\{|\\\[|\\\(/g;

// Template literals with embedded expressions containing braces
function templateBrackets<T extends Record<string, unknown>>(obj: T): string {
  const keys = Object.keys(obj);
  return `Items: ${keys.map((k) => {
    const val = obj[k];
    const typ = typeof val;
    return `{${k}(${typ}): ${typ === 'object' ? JSON.stringify(val) : val}}`;
  }).join(', ')}`;
}

// Destructuring madness
function destructure() {
  const {
    a: {
      b: [c, ...rest],
      d: { e: { f } },
    },
    g = { h: 'default' },  // default with braces in destructuring
  } = ((): { a: { b: [number, ...number[]]; d: { e: { f: string } } }; g?: { h: string } } => ({
    a: { b: [1, 2, 3], d: { e: { f: 'val' } } },
  }))();

  const [{ x }, [y, { z: [w] }]] = [{ x: 1 }, [2, { z: [3] as [number] }]] as [{ x: number }, [number, { z: [number] }]];

  // Comment: the above uses } ] ) in confusing positions
  return { c, rest, f, g, x, y, w };
}

// Arrow functions with various bracket styles
const noParens = (x: number) => x * 2;
const withBody = (x: number) => { return x * 2; };
const returnObj = (x: number) => ({ value: x * 2 });
const nested = (x: number) => (y: number) => ({ sum: x + y });

function processMap<
  K extends string | number | symbol,
  V extends Array<{ id: K; data: Map<string, Set<K>> }>,
>(
  input: Map<K, V>,
  transform: (key: K, val: V) => [K, V],
): Record<K extends string ? K : string, V> {
  const result = {} as Record<string, V>;
  for (const [key, val] of input) {
    const [newKey, newVal] = transform(key, val);
    result[String(newKey)] = newVal;
  }
  return result as Record<K extends string ? K : string, V>;
}

// String literals with bracket characters
const STRINGS = {
  json: '{"key": [1, 2, {"nested": true, "deep": {"arr": [3,4]}}]}',
  template: '${not_a_real_expression}',
  parens: 'function() { return (a + b) * (c + d); }',
  mixed: 'types: Array<Map<string, Set<number>>>',
  escaped: 'line1\nline2\t{bracketed}\n[array]',
};

// Conditional types with nested brackets
type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

type UnwrapPromise<T> = T extends Promise<infer U>
  ? U extends Promise<infer V>
    ? V
    : U
  : T;

type Flatten<T> = T extends Array<infer U>
  ? U extends Array<infer V>
    ? Flatten<V>
    : U
  : T;

// Switch with fall-through and blocks
function bracketSwitch(input: string): number {
  let result = 0;
  switch (input) {
    case '{': {
      result = 1;  // open brace as string value inside braces
      console.log('matched: open-brace');
      break;
    }
    case '}': {
      result = 2;
      break;
    }
    case '[]': {
      result = 3;
      break;
    }
    case '()': {
      result = 4;
      break;
    }
    default: {
      result = -1;
    }
  }
  return result;  // { this comment bracket doesn't close
}

// Class with complex generics and method signatures
class Container<T extends { id: string; children?: Container<T>[] }> {
  private items: Map<string, { value: T; meta: Record<string, unknown> }> = new Map();

  constructor(
    private readonly config: {
      maxSize: number;
      onEvict?: (item: T) => void;
      comparator: (a: T, b: T) => number;
    },
  ) {}

  add(item: T): boolean {
    const existing = this.items.get(item.id);
    if (existing) {
      // Update: merge meta {old} with {new}
      this.items.set(item.id, {
        value: item,
        meta: { ...existing.meta, updatedAt: Date.now(), source: 'merged' },
      });
      return false;
    }
    this.items.set(item.id, { value: item, meta: { createdAt: Date.now() } });
    return true;
  }

  // Method with callback containing nested brackets
  filter(predicate: (item: T, index: number) => boolean): T[] {
    return [...this.items.values()]
      .map(({ value }) => value)
      .filter((item, idx) => predicate(item, idx));
  }
}

// IIFE with brackets galore
const COMPUTED = (() => {
  const table: Record<string, { open: string; close: string }[]> = {
    brackets: [{ open: '[', close: ']' }],
    braces: [{ open: '{', close: '}' }],
    parens: [{ open: '(', close: ')' }],
    angles: [{ open: '<', close: '>' }],
  };
  return Object.entries(table).reduce(
    (acc, [key, pairs]) => ({ ...acc, [key]: pairs.length }),
    {} as Record<string, number>,
  );
})();

export { Container, COMPUTED, templateBrackets, processMap, destructure, bracketSwitch };
export type { Pair, Nested, DeepNest, DeepPartial, UnwrapPromise, Flatten };
