/**
 * Bracket Stress Test — exercises parser edge cases.
 * Contains: nested generics, template literals, regex, comments with brackets,
 * string escapes, arrow functions, destructuring, and conditional types.
 *
 * Note: lines like `if (a > b) { doStuff(); }` are common { traps }.
 * Also tricky: `const re = /[a-z]{3,}/g;`  // regex with {braces}
 */

// ============ Section 1: Nested Generics & Conditional Types ============

type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

type UnwrapPromise<T> = T extends Promise<infer U>
  ? U extends Promise<infer V>
    ? V
    : U
  : T;

interface Registry<K extends string, V extends Record<string, unknown>> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  entries(): Array<[K, V]>;
  // TODO: add batch({ keys: K[] }): Map<K, V>;
}

// ============ Section 2: Template Literals with Expressions ============

function formatMessage<T extends { name: string; count: number }>(
  data: T,
  template: `Hello ${string}, you have ${number} items`
): string {
  const { name, count } = data;
  // Tricky: template literal with nested expressions and brackets
  return `Dear ${name}, your ${count > 0 ? `${count} item${count === 1 ? '' : 's'}` : 'no items'} ${'{are}'} ready.`;
}

// ============ Section 3: Regex with Brackets ============

const PATTERNS = {
  // Each regex contains bracket characters that must NOT be counted as code blocks
  brackets: /[\[\]{}()]/g,
  jsonPath: /\$\{[^}]+\}/g,
  balanced: /\{(?:[^{}]|\{[^{}]*\})*\}/g,
  quantifier: /[a-zA-Z]{2,4}/,
  escape: /\\[\\{}\[\]]/g,
} as const;

// ============ Section 4: Destructuring & Default Values ============

function processConfig({
  timeout = 3000,
  retries = 3,
  headers = { 'Content-Type': 'application/json' },
  callbacks: {
    onSuccess = () => { console.log('ok'); },
    onError = (err: Error) => { throw err; },
    onRetry = ({ attempt, max }: { attempt: number; max: number }) => {
      console.log(`Retry ${attempt}/${max}`);
    },
  } = {},
}: {
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
  callbacks?: {
    onSuccess?: () => void;
    onError?: (err: Error) => void;
    onRetry?: (info: { attempt: number; max: number }) => void;
  };
}): void {
  // Body intentionally minimal — structure is the test
  if (retries > 0) {
    for (let i = 0; i < retries; i++) {
      try {
        fetch('https://api.example.com', { method: 'POST', headers })
          .then((r) => { if (!r.ok) { throw new Error(`HTTP ${r.status}`); } return r.json(); })
          .then((data: Record<string, unknown>) => { onSuccess(); })
          .catch((e: Error) => {
            onRetry({ attempt: i + 1, max: retries });
            if (i === retries - 1) { onError(e); }
          });
      } catch (e) {
        // Fallback: { this comment has braces } and [brackets] too
        onError(e as Error);
      }
    }
  }
}

// ============ Section 5: Mapped & Conditional Utility Types ============

type EventMap = {
  click: { x: number; y: number; button: 'left' | 'right' };
  keydown: { key: string; code: number; modifiers: { ctrl: boolean; shift: boolean } };
  resize: { width: number; height: number };
};

type EventHandler<E extends keyof EventMap> = (
  event: EventMap[E] & { timestamp: number; target: { id: string } }
) => void | Promise<void>;

type StrictPick<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T[P] extends Array<infer U>
      ? ReadonlyArray<U>
      : T[P];
};

// ============ Section 6: String Escapes & Edge Cases ============

const EDGE_CASES = [
  'simple string',
  'string with {braces} and [brackets]',
  "double-quoted {curly} and (parens)",
  `template with ${1 + 2} and ${{ toString: () => '{nested}' }}`,
  'escaped \' quote with { brace',
  "escaped \" quote with } brace",
  `multi-line template
    with ${(() => {
      const x = { a: 1, b: [2, 3] };
      return JSON.stringify(x);
    })()}
    and more text`,
  String.raw`raw template \${not_interpolated} {literal}`,
];

// ============ Section 7: Class with Complex Methods ============

class BracketParser<T extends Record<string, unknown>> {
  private stack: Array<{ char: string; pos: number; depth: number }> = [];
  private readonly pairs: Map<string, string> = new Map([
    ['{', '}'], ['[', ']'], ['(', ')'],
  ]);

  constructor(
    private readonly input: string,
    private readonly options: { strict: boolean; maxDepth: number } = { strict: true, maxDepth: 100 },
  ) {}

  parse(): { valid: boolean; errors: Array<{ msg: string; pos: number }> } {
    const errors: Array<{ msg: string; pos: number }> = [];
    for (let i = 0; i < this.input.length; i++) {
      const ch = this.input[i];
      if (this.pairs.has(ch)) {
        this.stack.push({ char: ch, pos: i, depth: this.stack.length });
        if (this.stack.length > this.options.maxDepth) {
          errors.push({ msg: `Max depth ${this.options.maxDepth} exceeded`, pos: i });
          if (this.options.strict) { break; }
        }
      } else if (['}', ']', ')'].includes(ch)) {
        const top = this.stack.pop();
        if (!top || this.pairs.get(top.char) !== ch) {
          errors.push({ msg: `Unmatched '${ch}' at position ${i}`, pos: i });
        }
      }
      /* Block comment with { braces } and
         [brackets] spanning multiple lines
         and even a // nested line comment fake-out */
    }
    // Remaining unclosed brackets
    while (this.stack.length > 0) {
      const unclosed = this.stack.pop()!;
      errors.push({ msg: `Unclosed '${unclosed.char}' from pos ${unclosed.pos}`, pos: unclosed.pos });
    }
    return { valid: errors.length === 0, errors };
  }
}

export { BracketParser, processConfig, formatMessage, PATTERNS, EDGE_CASES };
export type { DeepPartial, UnwrapPromise, Registry, EventMap, EventHandler, StrictPick };
