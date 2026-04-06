/**
 * TORTURE TEST: Bracket & Comment Nightmare
 * Purpose: stress-test edit tools with pathological nesting,
 * mixed delimiters, and ambiguous parse contexts.
 * {{ not a real template }} (nested slash-star markers omitted — cannot nest block comments in JS)
 */

// Region 1: Nested generics that look like HTML/comparison operators
type DeepNested<A extends Record<string, Map<string, Set<Array<Promise<A>>>>>> = {
  field: A extends infer U ? (U extends object ? { [K in keyof U]: U[K] } : never) : never;
};

// Region 2: String literals containing every delimiter
const nightmareStrings = {
  curlyInString: "function() { return { a: 1 }; }",
  bracketsInString: "arr[0][1][2] = obj['key']",
  parenInString: "((()))()(())",
  commentInString: "// not a comment /* also not */ <!-- nor this -->",
  templateTrap: `hello ${ `nested ${ `deep ${1 + 2}` }` } world`,
  regexTrap: /\{\}\[\]\(\)/g,
  backtickInRegex: /`[^`]*`/g,
  escapeHell: "\"\{\}\[\]\'\\",
  // Real comment between string props
  jsonLike: '{"key": [1, {"nested": [2, 3]}]}',
};

/* Region 3: Block comment with misleading content
   function shouldNotParse() {
     const x = { a: [ 1, 2, { b: 3 } ] };
     if (x) { return [x]; }
   }
   // nested line comment inside block comment
   const trap = `template ${inside} comment`;
*/

// Region 4: Immediately-invoked with complex destructuring
const result = (function IIFE() {
  const {
    a: {
      b: {
        c: [
          first,
          { d: { e: [second, ...rest] } },
          ...remaining
        ]
      }
    }
  } = JSON.parse('{"a":{"b":{"c":[1,{"d":{"e":[2,3,4]}},5,6]}}}');
  return { first, second, rest, remaining };
})();

// Region 5: Generic arrow functions that confuse JSX parsers
const arrowGeneric = <T extends { id: number }>(items: T[]): T[] => {
  return items.filter(<U extends T>(item: U): item is U => {
    return item.id > 0; // }) <-- fake closer in comment
  });
};

// Region 6: Switch with fallthrough and nested blocks
function bracketMaze(input: unknown): string {
  switch (typeof input) {
    case 'string': {
      const trimmed = (input as string).trim();
      if (trimmed.startsWith('{')) {
        try {
          JSON.parse(trimmed);
          return 'json';
        } catch (e) {
          // fall through intentionally (to end of case)
        }
      }
      break;
    } // <-- closes case block, NOT the switch
    case 'number': {
      if ((input as number) > 0) {
        return ((input as number) % 2 === 0) ? 'even' : 'odd';
      }
      return 'non-positive';
    }
    case 'object': {
      if (input === null) return 'null';
      if (Array.isArray(input)) {
        return `array[${(input as unknown[]).length}]`;
      }
      return `object{${Object.keys(input as object).join(',')}}`;
    }
    default:
      return `unknown(${typeof input})`;
  }
  // Reachable when case 'string' breaks without returning (e.g. non-JSON string)
  return `unknown(${typeof input})`;
}

// Region 7: Class with computed properties and bracket-heavy decorators
class TortureClass<
  T extends Record<string, unknown>,
  U extends keyof T = keyof T
> {
  [Symbol.iterator](): Iterator<T[U]> {
    let idx = 0;
    const keys = Object.keys(this.data) as U[];
    return {
      next: (): IteratorResult<T[U]> => {
        if (idx < keys.length) {
          return { value: this.data[keys[idx++]], done: false };
        }
        return { value: undefined as unknown as T[U], done: true };
      }
    };
  }

  constructor(public data: T) {}

  get [Symbol.toStringTag](): string {
    return `TortureClass<${Object.keys(this.data).join(', ')}>`;
  }

  method(cb: (arg: { [K in U]: T[K] }) => void): void {
    cb(this.data as { [K in U]: T[K] });
  }
}

// Region 8: Conditional types with infer in mapped types
type Unwrap<T> =
  T extends Promise<infer U>
    ? U extends Array<infer V>
      ? V extends Map<infer K, infer V2>
        ? { key: K; value: V2 }[]
        : V[]
      : U
    : T extends (...args: infer A) => infer R
      ? { args: A; return: R }
      : T extends { [K in keyof T]: infer V }
        ? V[]
        : never;

// Region 9: Tagged template literal with bracket injection
function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => {
    const val = i < values.length ? `'${String(values[i]).replace(/'/g, "''")}'` : '';
    return acc + str + val;
  }, '');
}

const query = sql`
  SELECT * FROM users
  WHERE name = ${"O'Brien"}
  AND data::jsonb -> 'address' ->> 'city' = ${'New York'}
  AND tags @> '{"admin", "active"}'::text[]
  AND (age > ${21} OR role IN (${['admin', 'mod'].join("', '")}))
`;

// Region 10: Nested ternaries with bracket expressions
const horror = (x: number) =>
  x > 0
    ? (x > 10
      ? { level: 'high', data: [x, x * 2, { nested: [x * 3] }] }
      : { level: 'mid', data: [x] })
    : (x < -10
      ? { level: 'low', data: [x, { deep: { deeper: [x] } }] }
      : { level: 'zero', data: [] });

// Region 11: Comment that ends file without newline — parser edge case
// EOF: }])};"'` -- every closer in one line