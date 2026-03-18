import { parseModifierChain } from './hashModifierParser';
import type {
  CompositeSetRef,
  HashModifierV2,
  ParsedBlackboardRef,
  ParsedDiffRef,
  ParsedHashRef,
  ParsedRecencyRef,
  ParsedSetExpression,
  ParsedSetRef,
  ParsedUhppRef,
  SetSelector,
} from './uhppTypes';

function parseHashCore(rest: string): ParsedHashRef | null {
  const colonPos = rest.indexOf(':');
  const hashPart = colonPos >= 0 ? rest.slice(0, colonPos) : rest;
  const modifierChain = colonPos >= 0 ? rest.slice(colonPos + 1) : '';
  if (hashPart.length < 6 || hashPart.length > 16 || !/^[0-9a-fA-F]+$/.test(hashPart)) return null;
  const parsedModifier = modifierChain ? parseModifierChain(modifierChain) : 'auto';
  if (parsedModifier == null) return null;
  return { hash: hashPart, modifier: parsedModifier as HashModifierV2 };
}

function parseDiffCore(rest: string): ParsedDiffRef | null {
  const parts = rest.split('..');
  if (parts.length !== 2) return null;
  const [leftRaw, rightRaw] = parts;
  if (!leftRaw || !rightRaw) return null;
  const left = leftRaw.startsWith('h:') ? leftRaw.slice(2) : leftRaw;
  const right = rightRaw.startsWith('h:') ? rightRaw.slice(2) : rightRaw;
  if (!/^[0-9a-fA-F]{6,16}$/.test(left) || !/^[0-9a-fA-F]{6,16}$/.test(right)) return null;
  return { oldHash: left, newHash: right };
}

function finalizeSetRef(selector: SetSelector, modifierChain = ''): ParsedSetRef | null {
  const parsedModifier = modifierChain ? parseModifierChain(modifierChain) : 'auto';
  if (parsedModifier == null) return null;
  return { selector, modifier: parsedModifier };
}

function parseSearchSelector(selectorPart: string): SetSelector | null {
  if (!selectorPart.startsWith('search(') || !selectorPart.endsWith(')')) return null;
  let body = selectorPart.slice(7, -1).trim();
  if (!body) return null;

  let limit: number | undefined;
  let tier: 'high' | 'medium' | undefined;

  while (true) {
    const trimmed = body.trimEnd();
    const optionMatch = trimmed.match(/(?:^|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)=([^,]+)\s*$/);
    if (!optionMatch) {
      body = trimmed;
      break;
    }

    const key = optionMatch[1];
    const raw = optionMatch[2].trim();
    if (key === 'limit') {
      const parsed = Number.parseInt(raw, 10);
      if (/^\d+$/.test(raw)) {
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        limit = parsed;
      } else if (/^-/.test(raw) || raw === '0') {
        return null;
      }
    } else if (key === 'tier') {
      if (raw === 'high' || raw === 'medium') {
        tier = raw;
      }
    } else {
      return null;
    }

    body = trimmed.slice(0, optionMatch.index).trimEnd();
  }

  const query = body.replace(/,$/, '').trim();
  if (!query) return null;
  return {
    kind: 'search',
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(tier !== undefined ? { tier } : {}),
  };
}

function parseHeadSelector(body: string): ParsedSetRef | null {
  if (!body.startsWith('HEAD')) return null;
  const prefixColon = body.indexOf(':');
  if (prefixColon < 0) return null;
  const headSpec = body.slice(0, prefixColon);
  const tail = body.slice(prefixColon + 1);
  const modifierColon = tail.indexOf(':');
  const path = modifierColon >= 0 ? tail.slice(0, modifierColon) : tail;
  const modifierChain = modifierColon >= 0 ? tail.slice(modifierColon + 1) : '';
  if (!path) return null;
  const offsetMatch = headSpec.match(/^HEAD(?:~(\d+))?$/);
  if (!offsetMatch) return null;
  const offset = offsetMatch[1] ? Number.parseInt(offsetMatch[1], 10) : undefined;
  return finalizeSetRef({ kind: 'head', path, offset }, modifierChain);
}

function parseNamedGitSelector(body: string): ParsedSetRef | null {
  if (!body.startsWith('tag:') && !body.startsWith('commit:')) return null;
  const isTag = body.startsWith('tag:');
  const tail = body.slice(isTag ? 4 : 7);
  const firstColon = tail.indexOf(':');
  if (firstColon < 0) return null;
  const first = tail.slice(0, firstColon);
  const remainder = tail.slice(firstColon + 1);
  if (!first || !remainder) return null;

  const lastColon = remainder.lastIndexOf(':');
  if (lastColon >= 0) {
    const maybePath = remainder.slice(0, lastColon);
    const maybeModifier = remainder.slice(lastColon + 1);
    const parsedModifier = parseModifierChain(maybeModifier);
    if (maybePath && parsedModifier != null) {
      return {
        selector: isTag ? { kind: 'tag', name: first, path: maybePath } : { kind: 'commit', sha: first, path: maybePath },
        modifier: parsedModifier,
      };
    }
  }

  return finalizeSetRef(
    isTag ? { kind: 'tag', name: first, path: remainder } : { kind: 'commit', sha: first, path: remainder },
  );
}

function parseSingleSetCore(rest: string): ParsedSetRef | null {
  if (!rest.startsWith('@')) return null;
  const body = rest.slice(1);
  if (!body) return null;

  if (body === 'edited') return finalizeSetRef({ kind: 'edited' });
  if (body === 'all') return finalizeSetRef({ kind: 'all' });
  if (body === 'pinned') return finalizeSetRef({ kind: 'pinned' });
  if (body === 'stale') return finalizeSetRef({ kind: 'stale' });
  if (body === 'dormant') return finalizeSetRef({ kind: 'dormant' });

  if (body === 'latest') return finalizeSetRef({ kind: 'latest', count: 1 });
  if (body.startsWith('latest:')) {
    const tail = body.slice(7);
    const nextColon = tail.indexOf(':');
    const firstSegment = nextColon >= 0 ? tail.slice(0, nextColon) : tail;
    const modifierChain = nextColon >= 0 ? tail.slice(nextColon + 1) : '';
    if (/^\d+$/.test(firstSegment)) {
      const count = Number.parseInt(firstSegment, 10);
      if (!Number.isFinite(count) || count <= 0) return null;
      return finalizeSetRef({ kind: 'latest', count }, modifierChain);
    }
    if (/^\d/.test(firstSegment)) return null;
    return finalizeSetRef({ kind: 'latest', count: 1 }, tail);
  }

  if (body.startsWith('file=')) {
    const tail = body.slice(5);
    const nextColon = tail.indexOf(':');
    const pattern = nextColon >= 0 ? tail.slice(0, nextColon) : tail;
    const modifierChain = nextColon >= 0 ? tail.slice(nextColon + 1) : '';
    if (!pattern) return null;
    return finalizeSetRef({ kind: 'file', pattern }, modifierChain);
  }

  if (body.startsWith('type=')) {
    const tail = body.slice(5);
    const nextColon = tail.indexOf(':');
    const chunkType = nextColon >= 0 ? tail.slice(0, nextColon) : tail;
    const modifierChain = nextColon >= 0 ? tail.slice(nextColon + 1) : '';
    if (!chunkType) return null;
    return finalizeSetRef({ kind: 'type', chunkType }, modifierChain);
  }

  if (body.startsWith('sub:')) {
    const tail = body.slice(4);
    const nextColon = tail.indexOf(':');
    const id = nextColon >= 0 ? tail.slice(0, nextColon) : tail;
    const modifierChain = nextColon >= 0 ? tail.slice(nextColon + 1) : '';
    if (!id) return null;
    return finalizeSetRef({ kind: 'subtask', id }, modifierChain);
  }

  if (body.startsWith('ws:')) {
    const tail = body.slice(3);
    const nextColon = tail.indexOf(':');
    const name = nextColon >= 0 ? tail.slice(0, nextColon) : tail;
    const modifierChain = nextColon >= 0 ? tail.slice(nextColon + 1) : '';
    if (!name) return null;
    return finalizeSetRef({ kind: 'workspace', name }, modifierChain);
  }

  if (body.startsWith('search(')) {
    const close = body.lastIndexOf(')');
    if (close < 0) return null;
    const selectorPart = body.slice(0, close + 1);
    const selector = parseSearchSelector(selectorPart);
    if (!selector) return null;
    const suffix = body.slice(close + 1);
    if (suffix && !suffix.startsWith(':')) return null;
    return finalizeSetRef(selector, suffix.startsWith(':') ? suffix.slice(1) : '');
  }

  return parseHeadSelector(body) ?? parseNamedGitSelector(body);
}

function parseCompositeSetCore(rest: string): CompositeSetRef | null {
  if (!rest.startsWith('@')) return null;
  let depth = 0;
  for (let i = 1; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '+' || ch === '&' || ch === '-')) {
      const leftRaw = rest.slice(0, i);
      const rightRaw = rest.slice(i + 1);
      const left = parseSingleSetCore(leftRaw);
      const right = parseSingleSetCore(rightRaw.startsWith('h:') ? rightRaw.slice(2) : rightRaw);
      if (!left || !right || left.modifier !== 'auto') return null;
      return { left: left.selector, op: ch, right: right.selector, modifier: right.modifier };
    }
  }
  return null;
}

function parseSetCore(rest: string): ParsedSetExpression | null {
  return parseCompositeSetCore(rest) ?? parseSingleSetCore(rest);
}

function parseBlackboardCore(rest: string): ParsedBlackboardRef | null {
  if (!rest.startsWith('bb:')) return null;
  const body = rest.slice(3);
  if (!body) return null;
  const colonPos = body.indexOf(':');
  const key = colonPos >= 0 ? body.slice(0, colonPos) : body;
  const modifierChain = colonPos >= 0 ? body.slice(colonPos + 1) : '';
  if (!key) return null;
  const parsedModifier = modifierChain ? parseModifierChain(modifierChain) : undefined;
  if (modifierChain && parsedModifier == null) return null;
  return {
    key,
    modifier: parsedModifier as HashModifierV2 | undefined,
  };
}

function parseRecencyCore(rest: string): ParsedRecencyRef | null {
  if (!rest.startsWith('$last')) return null;
  if (rest === '$last' || rest === '$last_edit' || rest === '$last_read' || rest === '$last_stage') {
    return { value: '$last' };
  }
  const match = rest.match(/^\$last(?:_(?:edit|read|stage))?-(\d+)$/);
  if (!match) return null;
  return { value: `$last-${Number.parseInt(match[1], 10)}` as `$last-${number}` };
}

export function parseUhppRef(value: string): ParsedUhppRef | null {
  const trimmed = String(value).trim();
  if (!trimmed.startsWith('h:')) return null;
  const rest = trimmed.slice(2);
  if (!rest) return null;

  const diff = parseDiffCore(rest);
  if (diff) return { kind: 'diff', value: diff };

  const setRef = parseSetCore(rest);
  if (setRef) return { kind: 'set', value: setRef };

  const blackboardRef = parseBlackboardCore(rest);
  if (blackboardRef) return { kind: 'blackboard', value: blackboardRef };

  const recencyRef = parseRecencyCore(rest);
  if (recencyRef) return { kind: 'recency', value: recencyRef };

  const hashRef = parseHashCore(rest);
  if (hashRef) return { kind: 'hash', value: hashRef };

  return null;
}

export function parseHashRef(value: string): ParsedHashRef | null {
  const parsed = parseUhppRef(value);
  return parsed?.kind === 'hash' ? parsed.value : null;
}

export function parseDiffRef(value: string): ParsedDiffRef | null {
  const parsed = parseUhppRef(value);
  return parsed?.kind === 'diff' ? parsed.value : null;
}

export function parseSetRef(value: string): ParsedSetExpression | null {
  const parsed = parseUhppRef(value);
  return parsed?.kind === 'set' ? parsed.value : null;
}

export function parseSetExpression(value: string): ParsedSetExpression | null {
  const parsed = parseUhppRef(value);
  return parsed?.kind === 'set' ? parsed.value : null;
}
