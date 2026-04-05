/**
 * Bracket Torture Test File
 * Contains: {curly}, [square], (parens), <angle> in comments
 * Edge cases: nested {{deep}}, mismatched-looking "}", escaped \{ chars
 */

// Simple function with nested brackets
function outerFn(a: number, b: string): { result: number; meta: { tag: string; flags: [boolean, { active: true }] } } {
  const obj = { result: a * 2, meta: { tag: b, flags: [true, { active: true }] as [boolean, { active: true }] } };
  return obj;
}

// Array of objects with generics
const registry: Array<{ id: number; children: Array<{ name: string }> }> = [
  { id: 1, children: [{ name: 'alpha' }] },
  { id: 2, children: [{ name: 'beta' }, { name: 'gamma' }] },
];

/* Multi-line comment with brackets
   if (false) { console.log('[skip]'); }
   Tricky: ({ => }) and [( => ])
   // nested comment-like: /* inner */
// end of block */
interface DeepNested {
  level1: {
    level2: {
      level3: {
        value: string;
        items: [number, { inner: boolean }];
        metadata: Record<string, { tags: Array<[string, { weight: number }]> }>;
      };
    };
  };
}

// Template literal with brackets
const tmpl = `Hello ${registry[0].children[0].name}, count=${outerFn(1, 'x').result}, arr=${[1,2,3].join(',')}`;

// Regex with brackets (tricky for parsers)
const re1 = /\[.*?\]/g;
const re2 = /\{[^}]+\}/;
const re4 = /(?<=\[)([^\]]*(?:\{[^}]*\})[^\]]*)(?=\])/g; // lookbehind + lookahead with nested brackets
const re3 = /\(([^)]+)\)/;

// String literals containing brackets
const s1 = 'This has {curly} and [square] brackets';
const s2 = "And (parens) plus <angles>";
const s3 = `Template with ${'{nested}'} and \${escaped} plus ${{a: 1}.a} and ${(() => ({ b: 2 }))().b}`;

// Arrow functions with various bracket styles
const noParens = (x: number) => x * 2;
const withBody = (x: number) => {
  const y = x + 1;
  return { value: y, doubled: y * 2 };
};
const returnObj = (x: number) => ({ value: x });
const generic = <T extends { id: number }>(item: T): T & { processed: boolean } => {
  return { ...item, processed: true };
};

// Destructuring with defaults and renames
function processConfig({
  host = 'localhost',
  port = 8080,
  options: { timeout = 3000, retries: maxRetries = 3 } = {},
}: {
  host?: string;
  port?: number;
  options?: { timeout?: number; retries?: number };
} = {}): { url: string; config: { timeout: number; retries: number } } {
  return {
    url: `${host}:${port}`,
    config: { timeout, retries: maxRetries },
  };
}

// Conditional types with nested brackets
type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

type ExtractArrayItem<T> = T extends Array<infer U>
  ? U extends { nested: infer V }
    ? V
    : U
  : never;

// Switch with complex returns
function evaluate(input: { type: string; data: unknown }): {
  status: 'ok' | 'error';
  payload: Record<string, unknown>;
} {
  switch (input.type) {
    case 'array': {
      const items = (input.data as unknown[]).map((d, i) => ({ index: i, value: d }));
      return { status: 'ok', payload: { items, count: items.length } };
    }
    case 'object': {
      const keys = Object.keys(input.data as Record<string, unknown>);
      return { status: 'ok', payload: { keys, count: keys.length } };
    }
    default: {
      return { status: 'error', payload: { message: `Unknown type: ${input.type}` } };
    }
  }
}

// Class with bracket-heavy generics
class Container<T extends { [key: string]: unknown }> {
  private items: Map<string, T> = new Map();

  constructor(initial: Array<[string, T]> = []) {
    for (const [key, val] of initial) {
      this.items.set(key, val);
    }
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  query(predicate: (item: T) => boolean): Array<{ key: string; value: T }> {
    const results: Array<{ key: string; value: T }> = [];
    for (const [key, value] of this.items) {
      if (predicate(value)) {
        results.push({ key, value });
      }
    }
    return results;
  }

  // Method with callback hell brackets
  async transform<U>(
    fn: (item: T, key: string) => Promise<U>,
    filter?: (item: T) => boolean,
  ): Promise<Map<string, U>> {
    const out = new Map<string, U>();
    for (const [key, val] of this.items) {
      if (!filter || filter(val)) {
        out.set(key, await fn(val, key));
      }
    }
    return out;
  }
}

// IIFE with nested structure
const computed = (() => {
  const data = [{ a: 1 }, { a: 2 }, { a: 3 }];
  return data.reduce<{ sum: number; items: number[] }>(
    (acc, item) => ({
      sum: acc.sum + item.a,
      items: [...acc.items, item.a],
    }),
    { sum: 0, items: [] },
  );
})();

// Export with assertion
export { outerFn, registry, processConfig, evaluate, Container, computed };
export type { DeepNested, DeepPartial, ExtractArrayItem };
