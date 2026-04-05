/**
 * TORTURE TEST: Bracket & Comment Nightmare
 * Purpose: stress-test edit tooling against pathological syntax
 *
 * Contains: nested generics, string-embedded braces, template literals,
 * regex with delimiters, comment-in-string, string-in-comment,
 * arrow functions inside object literals inside arrays inside generics.
 */

// --- Section 1: Nested generics with trailing commas ---
type DeepNested<A extends Record<string, Map<string, Set<Array<[A, B]>>>>, B = { x: { y: { z: number } } }> = {
  inner: A extends infer U ? (U extends Record<infer K, infer V> ? { [P in K]: V } : never) : never;
};

// --- Section 2: String literals containing braces and comment-like sequences ---
const nightmareStrings = {
  fake_comment: '// this is NOT a comment { still a string }',
  block_fake: '/* also not a comment */ { } {{ }}',
  nested_quotes: "she said \"hello { world }\" and left",
  template_trap: `literal backtick with ${(() => {
    const x = { a: 1, b: [2, 3, { c: 4 }] };
    return x.b[2]; // comment inside template expression
  })()}`,
  regex_like: '/^\\{[a-z]+\\}$/g is not a regex here',
  json_blob: '{"key": "value", "arr": [1,2,{"nested": true}]}',
};

// --- Section 3: Actual regex with bracket chaos ---
const regexNightmare = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
const regexCommentTrap = /\/\*.*?\*\//gs; // matches /* ... */ but IS a regex

// --- Section 4: Arrow functions in object literals in arrays in generics ---
function processItems<
  T extends { id: string; transform: (input: { data: unknown[] }) => { result: unknown } },
  U extends Array<{ handler: (ev: { type: string; payload: Record<string, unknown> }) => void }>
>(items: T[], handlers: U): Map<string, { processed: boolean; output: ReturnType<T['transform']> }> {
  const results = new Map<string, { processed: boolean; output: ReturnType<T['transform']> }>();
  for (const item of items) {
    try {
      const output = item.transform({ data: [{ nested: { deeply: [1, [2, [3]]] } }] });
      results.set(item.id, { processed: true, output });
    } catch (e) {
      // Error path: note the brace nesting depth here is 4
      results.set(item.id, { processed: false, output: { result: null } as ReturnType<T['transform']> });
    }
  }
  return results;
}

// --- Section 5: Conditional types with infer and distributive madness ---
type ExtractDeep<T> = T extends { a: { b: { c: infer U } } }
  ? U extends Array<infer V>
    ? V extends Record<string, infer W>
      ? W extends (...args: infer A) => infer R
        ? { args: A; return: R; depth: 'four' }
        : { value: W; depth: 'three' }
      : { element: V; depth: 'two' }
    : { inner: U; depth: 'one' }
  : never;

// --- Section 6: Immediately-invoked with comment traps ---
const result = /* opening comment { */ (() => {
  const arr = [
    { /* comment with } brace */ key: 'value' },
    { key: /* another { trap */ 'value2' /* } closing trap */ },
    // { this entire line is a comment with braces { } }
  ];
  return arr.reduce((acc, { key }) => ({ ...acc, [key]: true /* } not closing */ }), {} as Record<string, boolean>);
})() /* closing comment } */;

// --- Section 7: Class with decorators-like patterns and method overloads ---
class BracketHell {
  private data: Map<string, { handlers: Array<(ev: { type: string }) => { handled: boolean }> }> = new Map();

  // Method with destructuring defaults containing braces
  process(
    { input = { default: true }, config = { retries: 3, timeout: { ms: 1000 } } }: {
      input?: { default: boolean };
      config?: { retries: number; timeout: { ms: number } };
    } = {}
  ): { success: boolean; data: typeof input } {
    return { success: true, data: input };
  }

  // Computed property with bracket expressions
  get [`${'dynamic' + '_'}key`](): { value: number } {
    return { value: 42 };
  }

  // Method returning function returning object
  createHandler(): (event: { type: string; data: unknown }) => { handled: boolean; timestamp: number } {
    return (event) => ({
      handled: event.type !== 'ignore',
      timestamp: Date.now(), // trailing comma in returned object expression
    });
  }
}

// --- Section 8: Tagged template with embedded expressions containing all the traps ---
function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), '');
}

const query = sql`
  SELECT * FROM users
  WHERE metadata @> '{"roles": ["admin"]}' -- JSON containment { not code }
  AND name IN (${['alice', 'bob'].map(n => `'${n}'`).join(', ')})
  AND config = ${JSON.stringify({ theme: 'dark', mode: 'auto' })}
`;

// --- Section 9: Pathological ternary chain with object literals ---
const nightmare = (x: number): { type: string; value: unknown } =>
  x > 100 ? { type: 'huge', value: { nested: { deep: { deeper: x } } } }
  : x > 50 ? { type: 'big', value: [{ a: 1 }, { b: 2 }, { c: [3, { d: 4 }] }] }
  : x > 0 ? { type: 'small', value: x }
  : { type: 'zero', value: null };

// --- Section 10: Type-level string template literal with conditional ---
type PathSegment<T extends string> =
  T extends `${infer Head}/${infer Tail}`
    ? { head: Head; tail: PathSegment<Tail>; depth: [Head, ...PathSegment<Tail> extends { all: infer A } ? A & unknown[] : []] }
    : { head: T; tail: never; depth: [T] };

// --- Section 11: Switch inside reduce inside try-catch ---
function chaosReduce(items: Array<{ tag: string; payload: Record<string, unknown> }>): Record<string, unknown> {
  return items.reduce((acc, { tag, payload }) => {
    try {
      switch (tag) {
        case 'merge': return { ...acc, ...payload };
        case 'nest': return { ...acc, [tag]: { ...payload, parent: { ...acc } } };
        case 'wrap': return { wrapper: { inner: acc, extra: payload } };
        case 'deep': return { ...acc, [tag]: { level: { depth: { payload } } } };
        default: {
          // Default branch with its own block scope
          const fallback = { unknown_tag: tag, data: payload };
          return { ...acc, ...fallback };
        }
      }
    } catch (e) {
      return { ...acc, error: { tag, message: (e as Error).message } };
    }
  }, {} as Record<string, unknown>);
}

// --- Section 12: Export barrel with re-export gymnastics ---
export { nightmareStrings, regexNightmare, processItems, BracketHell, chaosReduce };
export type { DeepNested, ExtractDeep, PathSegment };
export default result;

// EOF - if your parser survived this, congratulations. Count: ~30 distinct brace-nesting contexts.
