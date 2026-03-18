import type { ExpandedFilePath } from './batch/types';
import {
  isTemporalSelector,
  parseHashRef,
  parseSetExpression,
  resolveCompositeSetRef,
  resolveSetRefToValues,
  resolveTemporalRef,
  type HashLookup,
  type SetRefLookup,
} from '../utils/hashResolver';

export interface ExpandFilePathRefsOptions {
  projectPath?: string | null;
  sessionId?: string | null;
  resolveHashRef?: (rawRef: string, sessionId: string | null) => Promise<{ source?: string | null; content: string } | null>;
  expandFileGlob?: (projectRoot: string, pattern: string) => Promise<string[]>;
}

export function stripGitLabelPrefix(source: string): string {
  const match = source.match(/^(?:HEAD(?:~\d+)?|[a-f0-9]{7,40}|v\d[^:]*):(.+)$/);
  return match ? match[1] : source;
}

export async function expandFilePathRefs(
  rawPaths: string[],
  hashLookup: HashLookup,
  setLookup: SetRefLookup,
  options: ExpandFilePathRefsOptions = {},
): Promise<{ items: ExpandedFilePath[]; notes: string[] }> {
  const items: ExpandedFilePath[] = [];
  const notes: string[] = [];

  for (const filePath of rawPaths) {
    const parsedHash = parseHashRef(filePath);
    if (parsedHash) {
      const entry = await hashLookup(parsedHash.hash);
      if (entry?.source) {
        items.push({ kind: 'path', path: entry.source });
        continue;
      }
      if (options.resolveHashRef) {
        try {
          const resolved = await options.resolveHashRef(filePath, options.sessionId ?? null);
          if (resolved?.source) {
            items.push({ kind: 'path', path: resolved.source });
            notes.push(`${filePath} -> backend resolved to ${resolved.source}`);
            continue;
          }
        } catch {
          // Fall through to note-only failure; caller decides whether to keep path literal.
        }
      }
      notes.push(`${filePath} -> hash ref not found (chunk store + backend miss)`);
      continue;
    }

    const setExpr = parseSetExpression(filePath);
    if (setExpr) {
      if ('left' in setExpr) {
        const { values } = resolveCompositeSetRef(setExpr, filePath, 'file_paths', setLookup);
        if (values.length > 0) {
          for (const value of values) items.push({ kind: 'path', path: stripGitLabelPrefix(value) });
          notes.push(`${filePath} -> ${values.length} files (composite set)`);
        } else {
          notes.push(`${filePath} -> 0 matched (composite set)`);
        }
        continue;
      }

      if (isTemporalSelector(setExpr.selector)) {
        const content = await resolveTemporalRef(setExpr.selector, setExpr.modifier);
        if (content !== null) {
          const gitLabel = setExpr.selector.kind === 'head'
            ? (setExpr.selector.offset ? `HEAD~${setExpr.selector.offset}` : 'HEAD')
            : setExpr.selector.kind === 'tag'
              ? setExpr.selector.name
              : setExpr.selector.sha;
          items.push({ kind: 'content', content, source: `${gitLabel}:${setExpr.selector.path}` });
          notes.push(`${filePath} -> temporal ref ${gitLabel}:${setExpr.selector.path}`);
        } else {
          notes.push(`${filePath} -> temporal ref failed`);
        }
        continue;
      }

      const { values: contextPaths } = resolveSetRefToValues(setExpr, filePath, 'file_paths', setLookup);
      const cleanContextPaths = contextPaths.map((value) => stripGitLabelPrefix(value));

      let diskPaths: string[] = [];
      if (
        setExpr.selector.kind === 'file'
        && setExpr.selector.pattern.includes('*')
        && options.projectPath
        && options.expandFileGlob
      ) {
        try {
          const globPattern = setExpr.selector.pattern.startsWith('**/')
            ? setExpr.selector.pattern
            : `**/${setExpr.selector.pattern}`;
          diskPaths = await options.expandFileGlob(options.projectPath, globPattern);
        } catch (error) {
          notes.push(`${filePath} -> filesystem glob failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const dedupedPaths: string[] = [];
      const seen = new Set<string>();
      for (const path of [...cleanContextPaths, ...diskPaths]) {
        const normalized = path.replace(/\\/g, '/').toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        dedupedPaths.push(path);
      }

      if (dedupedPaths.length > 0) {
        for (const path of dedupedPaths) items.push({ kind: 'path', path });
        const note = diskPaths.length > 0
          ? `${filePath} -> ${dedupedPaths.length} files (${cleanContextPaths.length} from context, ${diskPaths.length} from disk, deduped)`
          : `${filePath} -> ${dedupedPaths.length} files (set ref)`;
        notes.push(note);
      } else {
        notes.push(`${filePath} -> 0 matched (set ref + filesystem)`);
      }
      continue;
    }

    items.push({ kind: 'path', path: filePath });
  }

  const dedupedItems: ExpandedFilePath[] = [];
  const seenPaths = new Set<string>();
  for (const item of items) {
    if (item.kind === 'content') {
      dedupedItems.push(item);
      continue;
    }
    const normalized = item.path.replace(/\\/g, '/').toLowerCase();
    if (seenPaths.has(normalized)) continue;
    seenPaths.add(normalized);
    dedupedItems.push(item);
  }

  return { items: dedupedItems, notes };
}

export function expandSetRefsInHashes(
  hashes: string[],
  setLookup: SetRefLookup,
): { expanded: string[]; notes: string[] } {
  const expanded: string[] = [];
  const notes: string[] = [];

  for (const hash of hashes) {
    const setExpr = parseSetExpression(hash);
    if (!setExpr) {
      expanded.push(hash);
      continue;
    }

    if ('left' in setExpr) {
      const { values } = resolveCompositeSetRef(setExpr, hash, 'hash', setLookup);
      if (values.length > 0) {
        expanded.push(...values);
        notes.push(`${hash} -> ${values.length} matched (composite set)`);
      } else {
        notes.push(`${hash} -> 0 matched (composite set)`);
      }
      continue;
    }

    const { values, expansion } = resolveSetRefToValues(setExpr, hash, 'hash', setLookup);
    if (values.length > 0) {
      expanded.push(...values);
      const detail = expansion.hashes.map((ref, index) => {
        const source = expansion.sources[index];
        return source && source !== '(no source)'
          ? `${ref} ${source.split(/[/\\]/).pop()}`
          : ref;
      }).join(', ');
      notes.push(`${hash} -> ${values.length} matched [${detail}]`);
    } else {
      notes.push(`${hash} -> 0 matched`);
    }
  }

  return { expanded, notes };
}
