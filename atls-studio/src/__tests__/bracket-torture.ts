/**
 * Bracket Torture Test File
 * Purpose: stress-test edit operations with tricky bracket patterns.
 * Note: obj = { a: [1, 2, { b: 3 }] } is a common pattern.
 */

// Simple nested brackets: arr = [[1], [2, [3]]]
const simple = { a: 1, b: [2, 3], c: { d: 4 } };

// Comment with unmatched open bracket: { and nested [arr]
// Comment with unmatched close bracket: } and also ]
function alpha(x: number): { result: number; meta: { tag: string } } {
  const inner = {
    result: x * 2,
    meta: { tag: `computed-${x}` },
  };
  // Tricky: template literal with brackets ${JSON.stringify({a:1})}
  // EDIT TEST: added a second comment with brackets: ({[]})
  const msg = `Value is ${inner.result} and obj is ${
    JSON.stringify({ key: [1, 2, 3], extra: { nested: [4, 5] } })
  } plus ${{ toString: () => '{more brackets}' }}`;
  void msg;
  return inner;
}

/* Multi-line comment with brackets
   { "key": [1, 2, 3] }
   function fake() { return null; }
   const arr = [[[deep]]];
   EDIT TEST: added line inside multi-line comment { with: [more, {brackets}] }
*/

type Nested = {
  a: { b: { c: { d: number } } };
  e: Array<{ f: [number, string] }>;
  g: Record<string, { h: () => { i: boolean } }>;
};

interface BracketHell {
  // Method returning nested generics
  process<T extends Record<string, unknown>>(
    input: T,
    opts?: { deep: boolean; transform?: (v: T) => T }
  ): Promise<{ data: T; errors: Array<{ code: number; msg: string }> }>;
}

// Regex with brackets (edge case)
const BRACKET_RE = /[\[\]{}()]/g;
const ESCAPED = /\{not-a-block\}/;

// String literals with brackets
const jsonStr = '{"users": [{"id": 1, "roles": ["admin", "user"]}]}';
const tmplStr = `{
  "nested": {
    "array": [1, 2, 3],
    "obj": { "a": true }
  }
}`;

class BracketFactory {
  // Property with complex type
  private cache: Map<string, { data: unknown[]; meta: { ts: number } }> = new Map();

  constructor(
    private config: {
      maxDepth: number;
      transforms: Array<(x: unknown) => unknown>;
      fallback?: { default: unknown; errorHandler: (e: Error) => void };
    }
  ) {}

  /**
   * Method with deeply nested brackets in body.
   * Example call: factory.build({ layers: [{ type: 'a' }] })
   */
  build(spec: { layers: Array<{ type: string; children?: unknown[] }> }): {
    output: unknown;
    stats: { depth: number; nodes: number };
  } {
    const result = {
      output: spec.layers.map((layer) => ({
        ...layer,
        children: (layer.children ?? []).map((child) => {
          // EDIT TEST: validation inside deeply nested arrow
          if (typeof child === 'object' && child !== null) {
            return { wrapped: child, meta: { processed: true, validated: true } };
          }
          return { wrapped: child, meta: { processed: false } };
        }),
      })),
      stats: { depth: this.config.maxDepth, nodes: spec.layers.length },
    };
    // Inline arrow with brackets: spec.layers.filter(l => ({ ...l }));
    this.cache.set('last', {
      data: [result],
      meta: { ts: Date.now() },
    });
    return result;
  }

  // Destructuring with defaults (bracket-heavy) — EDIT TEST: added z param
  unpack(
    { a = [1, 2], b = { c: { d: [3] } }, z = { nested: [{ deep: true }] } }: {
      a?: number[];
      b?: { c: { d: number[] } };
      z?: { nested: Array<{ deep: boolean }> };
    } = {},
  ): [number[], { c: { d: number[] } }, { nested: Array<{ deep: boolean }> }] {
    return [a, b, z];
  }
}

// Switch with bracket-heavy cases
function dispatch(action: { type: string; payload?: unknown }): unknown {
  switch (action.type) {
    case 'init': {
      const state = { ready: true, data: [] as unknown[] };
      return { ...state, meta: { initialized: true } };
    }
    case 'update': {
      const { payload } = action;
      // EDIT TEST: intermediate destructure with bracket-heavy default
      const { v = 0 } = (payload as { v: number }) ?? { v: -1 };
      return {
        data: [payload],
        nested: { deep: { value: v } },
        extra: { tags: [{ id: 1 }, { id: 2 }] },
      };
    }
    case 'batch': {
      // Comment: handle [{a:1},{a:2}] style batches
      return (action.payload as unknown[])?.map((item) => ({
        processed: item,
        meta: { batchId: crypto.randomUUID() },
      })) ?? [];
    }
    default:
      return { error: { code: 404, details: { type: action.type } } };
  }
}

// Immediately invoked with complex args
const computed = ((opts: { multiplier: number }) => {
  return [1, 2, 3].reduce((acc, n) => {
    return { ...acc, [`key_${n}`]: n * opts.multiplier };
  }, {} as Record<string, number>);
})({ multiplier: 10 });

// Conditional types with brackets
type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

type Unwrap<T> = T extends Promise<infer U>
  ? U extends Array<infer V>
    ? V extends { data: infer D }
      ? D
      : V
    : U
  : T;

// Tuple + intersection bracket salad
type Salad = [{ a: 1 } & { b: 2 }, ({ c: 3 } | { d: 4 })[], ...Array<{ e: 5 }>];

// Export to prevent tree-shaking
export {
  alpha,
  BracketFactory,
  dispatch,
  computed,
  simple,
  jsonStr,
  tmplStr,
  BRACKET_RE,
  ESCAPED,
};
export type { Nested, BracketHell, DeepPartial, Unwrap, Salad };
