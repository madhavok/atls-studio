/**
 * TORTURE TEST — nested brackets, comments, string edge cases.
 * Purpose: stress-test edit tools against worst-case formatting.
 */

// Region 1: Nested generics with arrow fns inside template literals
type DeepNest<T extends Record<string, Array<Map<string, Set<T>>>>> = {
  fn: <U extends keyof T>(key: U) => T[U] extends infer V
    ? V extends Map<infer K, infer S>
      ? { mapped: [K, S] }
      : never
    : never;
};

/* Block comment EDITED:
  if (x > 0) {
    // TEST 2: edit inside block comment with fake code
    const y = x < 10 ? 'small' : 'big';
    return { result: y }; // } tricky brace in comment
  }
  End of edited fake code */
const edgeCases = {
  // String with brackets that shouldn't be parsed
  a: '{ not a block }',
  b: "( also not ) a group",
  c: `template with ${(() => {
    // arrow fn inside template literal inside object
    const inner = { nested: true };
    return inner;
  })()}`,
  d: `multi
    line template ${
      // comment inside template expression
      [1, 2, 3].map((x) => ({
        value: x,
        label: `item-${x}` // nested template in template
      }))
    } end`,
  /* inline block comment */ e: 42,
  f: /regex with {braces} and (parens)/g,
  h: "double \" escaped with } brace",
};

// Region 2: Deeply nested callbacks with misleading indentation
function nightmareCallbacks(
  cb1: (err: Error | null, result: {
    data: Array<{
      id: number;
      children: Array<{
        name: string;
        meta: { [key: string]: unknown };
      }>;
    }>;
  }) => void,
  cb2: (
    // This param has a block comment
    /* with nested { braces } */
    input: string
  ) => Promise<{
    status: 'ok' | 'fail';
    payload: Record<string, {
      items: [string, number, { deep: boolean }];
    }>;
  }>
): void {
  // intentionally weird indentation
      const x = {
    a: [[
      [1, [2, [3, [4]]]]
    ]],
        b: (() => {
      return { c: { d: { e: 'deep' } } };
    })(),
  };
  cb1(null, { data: [{ id: 1, children: [{ name: 'a', meta: {} }] }] });
}

// Region 3: Switch with objects and comments interleaved
function switchMess(val: string): unknown {
  switch (val) {
    case '{':
      // TEST 4: edited bracket-in-string case
      return { type: 'open_brace', edited: true /* } still tricky */ };
      return { type: 'close_brace' };
    case '(':
      // fall through with comment containing )
    case ')':
      return (() => {
        const obj = {
          // comment with { and [
          arr: [1, 2, /* 3, */ 4],
          fn: (x: number) => ({
            result: x > 0
              ? { positive: true }
              : { negative: true },
          }),
        };
        return obj;
      })();
    default: {
      const _exhaustive: never = val as never;
      return _exhaustive;
    }
  }
}

// Region 4: Class with decorators-style comments and computed props
const COMPUTED = Symbol('computed');
class BracketHell {
  /* @decorator-like comment */
  [COMPUTED]: string = '}';

  // Method with destructuring defaults containing nested objects
  process(
    { a = { b: { c: 1 } }, d = [{ e: 2 }] }: {
      a?: { b: { c: number } };
      d?: Array<{ e: number }>;
    } = {}
  ): { result: typeof a & { extra: typeof d } } {
    return {
      result: {
        ...a,
        extra: d,
      } as typeof a & { extra: typeof d },
    };
  }

  // Getter returning conditional type-like structure
  get nightmare(): (
    | { type: 'a'; data: { nested: Array<[string, { deep: true }]> } }
    | { type: 'b'; data: null }
  ) {
    return Math.random() > 0.5
      ? { type: 'a' as const, data: { nested: [['x', { deep: true as const }]] } }
      : { type: 'b' as const, data: null };
  }
}

// Region 5: IIFE chain with type assertions and as const
const result = ((() => {
  const a = { x: 1 } as const;
  return ((() => {
    const b = { ...a, y: 2 } as const;
    return ((() => {
      return { ...b, z: 3 } as const;
    })());
  })());
})()) satisfies { readonly x: 1; readonly y: 2; readonly z: 3 };

// Region 6: String with all bracket types and escape sequences
const allBrackets = `{[(<>)]}` + '{[(<>)]}' + "\{\[\(" + '\)\]\}';
const jsonInString = '{"key": [{"nested": true, "arr": [1,2,{"deep": {}}]}]}';

export { edgeCases, nightmareCallbacks, switchMess, BracketHell, result, allBrackets, jsonInString };
export type { DeepNest };
