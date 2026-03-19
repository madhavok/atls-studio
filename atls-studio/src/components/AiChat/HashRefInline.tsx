/**
 * HashRefInline — renders h:XXXX references in model output as
 * expandable inline code blocks.
 *
 * HPP v2: Supports shape modifiers, diff refs, symbol anchors, lazy loading,
 * highlight rendering, copy buttons, and full expansion.
 */

import { memo, useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/appStore';
import { useContextStore } from '../../stores/contextStore';
import { HREF_PATTERN, BB_REF_PATTERN, parseDiffRef } from '../../utils/hashResolver';

// ---------------------------------------------------------------------------
// Types (mirroring backend ResolvedOutputRef / ResolvedHashContent)
// ---------------------------------------------------------------------------

interface DiffStats {
  added: number;
  removed: number;
  changed_hunks: number;
}

interface ResolvedOutputRef {
  raw: string;
  offset: number;
  length: number;
  source: string | null;
  lines: string | null;
  short_hash: string;
  resolved: boolean;
  ref_type: 'code' | 'diff' | 'meta' | 'symbol' | 'blackboard';
  shape: string | null;
  content: string | null;
  highlight_ranges: [number, number | null][] | null;
  diff_stats: DiffStats | null;
  lang: string | null;
}

interface ResolvedHashContent {
  source: string | null;
  content: string;
  total_lines: number;
  lang: string | null;
  shape_applied: string | null;
  highlight_ranges: [number, number | null][] | null;
  is_diff: boolean;
  diff_stats: DiffStats | null;
}

// ---------------------------------------------------------------------------
// HashRefText — scans text and replaces h:refs with pills
// ---------------------------------------------------------------------------

export const HashRefText = memo(function HashRefText({ text }: { text: string }) {
  const [refs, setRefs] = useState<ResolvedOutputRef[]>([]);

  useEffect(() => {
    const hexRe = new RegExp(HREF_PATTERN.source, HREF_PATTERN.flags);
    const bbRe = new RegExp(BB_REF_PATTERN.source, BB_REF_PATTERN.flags);
    const hasHex = hexRe.test(text);
    const hasBb = bbRe.test(text);
    if (!hasHex && !hasBb) return;

    invoke<ResolvedOutputRef[]>('scan_output_hash_refs', { text })
      .then(setRefs)
      .catch(() => {});
  }, [text]);

  if (refs.length === 0) return <>{text}</>;

  const parts: (string | ResolvedOutputRef)[] = [];
  let lastEnd = 0;

  for (const ref of refs) {
    if (ref.offset > lastEnd) {
      parts.push(text.slice(lastEnd, ref.offset));
    }
    parts.push(ref);
    lastEnd = ref.offset + ref.length;
  }
  if (lastEnd < text.length) {
    parts.push(text.slice(lastEnd));
  }

  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : part.ref_type === 'diff' ? (
          <DiffRefPill key={i} ref_data={part} />
        ) : part.ref_type === 'blackboard' ? (
          <BbRefPill key={i} ref_data={part} />
        ) : (
          <HashRefPill key={i} ref_data={part} />
        )
      )}
    </>
  );
});

// ---------------------------------------------------------------------------
// HashRefPill — code/symbol/meta references
// ---------------------------------------------------------------------------

const HashRefPill = memo(function HashRefPill({ ref_data }: { ref_data: ResolvedOutputRef }) {
  const [expanded, setExpanded] = useState(false);
  const [resolved, setResolved] = useState<ResolvedHashContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const currentSessionId = useAppStore(state => state.currentSessionId);

  const toggle = useCallback(() => {
    if (!expanded && !resolved && !loading) {
      setLoading(true);
      const payload: { rawRef: string; sessionId?: string } = { rawRef: ref_data.raw };
      if (currentSessionId) payload.sessionId = currentSessionId;
      invoke<ResolvedHashContent>('resolve_hash_ref', payload)
        .then(r => { setResolved(r); setExpanded(true); })
        .catch(() => setExpanded(true))
        .finally(() => setLoading(false));
    } else {
      setExpanded(v => !v);
    }
  }, [expanded, resolved, loading, ref_data.raw, currentSessionId]);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const text = resolved?.content || ref_data.content || ref_data.lines || '';
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(e => console.warn('[HashRef] Clipboard write failed:', e));
  }, [resolved, ref_data]);

  const label = buildLabel(ref_data);
  const modifierBadge = ref_data.shape
    || (ref_data.ref_type === 'meta' ? 'meta' : null);

  const lineSpec = extractLineSpec(ref_data.raw);

  const displayContent = resolved?.content || ref_data.content || ref_data.lines;
  const hasExpandable = ref_data.resolved;

  const pillColor = ref_data.ref_type === 'meta'
    ? 'bg-studio-info/15 text-studio-info border-studio-info/30 hover:bg-studio-info/25'
    : ref_data.ref_type === 'symbol'
    ? 'bg-purple-500/15 text-purple-400 border-purple-500/30 hover:bg-purple-500/25'
    : ref_data.resolved
    ? 'bg-studio-accent/15 text-studio-accent border-studio-accent/30 hover:bg-studio-accent/25'
    : 'bg-studio-warning/15 text-studio-warning border-studio-warning/30 hover:bg-studio-warning/25';

  return (
    <span className="inline-block align-baseline">
      <button
        onClick={toggle}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono transition-colors cursor-pointer border ${pillColor}`}
        title={ref_data.resolved
          ? `${ref_data.source || ref_data.short_hash} — click to ${expanded ? 'collapse' : 'expand'}`
          : `Unresolved: h:${ref_data.short_hash}`}
      >
        <LinkIcon />
        <span>{label}</span>
        {lineSpec && <span className="opacity-70">:{lineSpec}</span>}
        {modifierBadge && (
          <span className="px-1 py-0 rounded bg-current/10 text-[10px] opacity-80">
            {modifierBadge}
          </span>
        )}
        {loading && <span className="animate-pulse">...</span>}
        {hasExpandable && !loading && <ChevronIcon expanded={expanded} />}
      </button>
      {expanded && displayContent && (
        <div className="block mt-1 mb-1 rounded bg-studio-bg border border-studio-border overflow-x-auto relative group">
          <button
            onClick={handleCopy}
            className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[10px] font-mono opacity-0 group-hover:opacity-100 transition-opacity bg-studio-surface text-studio-text/70 hover:text-studio-text border border-studio-border"
            title="Copy content"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <pre className="text-xs p-2 font-mono text-studio-text/90 leading-relaxed">
            {renderHighlightedContent(displayContent, resolved?.highlight_ranges || ref_data.highlight_ranges)}
          </pre>
        </div>
      )}
    </span>
  );
});

// ---------------------------------------------------------------------------
// DiffRefPill — diff references (h:OLD..h:NEW)
// ---------------------------------------------------------------------------

const DiffRefPill = memo(function DiffRefPill({ ref_data }: { ref_data: ResolvedOutputRef }) {
  const [expanded, setExpanded] = useState(false);
  const [resolved, setResolved] = useState<ResolvedHashContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const currentSessionId = useAppStore(state => state.currentSessionId);

  const toggle = useCallback(() => {
    if (!expanded && !resolved && !loading) {
      setLoading(true);
      const payload: { rawRef: string; sessionId?: string } = { rawRef: ref_data.raw };
      if (currentSessionId) payload.sessionId = currentSessionId;
      invoke<ResolvedHashContent>('resolve_hash_ref', payload)
        .then(r => { setResolved(r); setExpanded(true); })
        .catch(() => setExpanded(true))
        .finally(() => setLoading(false));
    } else {
      setExpanded(v => !v);
    }
  }, [expanded, resolved, loading, ref_data.raw, currentSessionId]);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const text = resolved?.content || ref_data.content || '';
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(e => console.warn('[HashRef] Clipboard write failed:', e));
  }, [resolved, ref_data]);

  const diff = parseDiffRef(ref_data.raw);
  const stats = resolved?.diff_stats || ref_data.diff_stats;
  const displayContent = resolved?.content || ref_data.content;

  return (
    <span className="inline-block align-baseline">
      <button
        onClick={toggle}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono transition-colors cursor-pointer bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/30"
        title={`Diff: ${ref_data.source || 'file'} — click to ${expanded ? 'collapse' : 'expand'}`}
      >
        <DiffIcon />
        <span>{ref_data.source ? basename(ref_data.source) : (diff ? `${diff.oldHash.slice(0, 6)}..${diff.newHash.slice(0, 6)}` : ref_data.short_hash)}</span>
        {stats && (
          <span className="text-[10px] opacity-80">
            <span className="text-green-400">+{stats.added}</span>
            {' '}
            <span className="text-red-400">-{stats.removed}</span>
          </span>
        )}
        {loading && <span className="animate-pulse">...</span>}
        {!loading && <ChevronIcon expanded={expanded} />}
      </button>
      {expanded && displayContent && (
        <div className="block mt-1 mb-1 rounded bg-studio-bg border border-studio-border overflow-x-auto relative group">
          <button
            onClick={handleCopy}
            className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[10px] font-mono opacity-0 group-hover:opacity-100 transition-opacity bg-studio-surface text-studio-text/70 hover:text-studio-text border border-studio-border"
            title="Copy diff"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <pre className="text-xs p-2 font-mono leading-relaxed">
            {displayContent.split('\n').map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'text-green-400 bg-green-500/10'
                    : line.startsWith('-') && !line.startsWith('---')
                    ? 'text-red-400 bg-red-500/10'
                    : line.startsWith('@@')
                    ? 'text-cyan-400 opacity-70'
                    : 'text-studio-text/90'
                }
              >
                {line}
              </div>
            ))}
          </pre>
        </div>
      )}
    </span>
  );
});

// ---------------------------------------------------------------------------
// BbRefPill — blackboard references (h:bb:keyname)
// ---------------------------------------------------------------------------

const BbRefPill = memo(function BbRefPill({ ref_data }: { ref_data: ResolvedOutputRef }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const bbKey = ref_data.raw.startsWith('h:bb:') ? ref_data.raw.slice(5) : ref_data.short_hash.replace(/^bb:/, '');
  const entry = useContextStore(s => s.blackboardEntries.get(bbKey));
  const content = entry?.content ?? null;
  const tokens = entry?.tokens ?? 0;

  const toggle = useCallback(() => setExpanded(v => !v), []);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (content) {
      navigator.clipboard.writeText(content).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(e => console.warn('[HashRef] Clipboard write failed:', e));
    }
  }, [content]);

  return (
    <span className="inline-block align-baseline">
      <button
        onClick={toggle}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono transition-colors cursor-pointer border bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25"
        title={content ? `bb:${bbKey} (${tokens}tk) — click to ${expanded ? 'collapse' : 'expand'}` : `bb:${bbKey} — not found`}
      >
        <BookmarkIcon />
        <span>{bbKey}</span>
        {tokens > 0 && <span className="opacity-60">{tokens}tk</span>}
        {content && <ChevronIcon expanded={expanded} />}
      </button>
      {expanded && content && (
        <div className="block mt-1 mb-1 rounded bg-studio-bg border border-amber-500/20 overflow-x-auto relative group">
          <button
            onClick={handleCopy}
            className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[10px] font-mono opacity-0 group-hover:opacity-100 transition-opacity bg-studio-surface text-studio-text/70 hover:text-studio-text border border-studio-border"
            title="Copy content"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <pre className="text-xs p-2 font-mono text-studio-text/90 leading-relaxed whitespace-pre-wrap">
            {content}
          </pre>
        </div>
      )}
    </span>
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract just the filename from a path (e.g. "src/utils/foo.ts" → "foo.ts") */
function basename(path: string): string {
  const seg = path.replace(/\\/g, '/').split('/').pop() || path;
  return seg;
}

/** Build a human-readable label for the pill */
function buildLabel(ref: ResolvedOutputRef): string {
  // Symbol anchors: show the symbol name prominently
  if (ref.ref_type === 'symbol' && ref.shape) {
    const symMatch = ref.shape.match(/^(?:fn|sym|cls|struct)\(([^)]+)\)$/);
    if (symMatch) {
      const src = ref.source ? basename(ref.source) : null;
      return src ? `${src} → ${symMatch[1]}` : symMatch[1];
    }
  }

  // Meta queries: show the query type
  if (ref.ref_type === 'meta' && ref.shape) {
    const src = ref.source ? basename(ref.source) : null;
    return src ? `${src}:${ref.shape}` : ref.shape;
  }

  // Source available: use filename
  if (ref.source) return basename(ref.source);

  // Fallback: short hash
  return `h:${ref.short_hash}`;
}

function extractLineSpec(raw: string): string | null {
  const parts = raw.replace(/^h:/, '').split(':');
  if (parts.length < 2) return null;
  const afterHash = parts.slice(1).join(':');
  if (/^\d/.test(afterHash)) {
    const endOfLines = afterHash.search(/[^0-9,\- ]/);
    return endOfLines > 0 ? afterHash.slice(0, endOfLines) : afterHash;
  }
  return null;
}

function renderHighlightedContent(
  content: string,
  highlights: [number, number | null][] | null | undefined
): React.ReactNode {
  if (!highlights || highlights.length === 0) return content;

  const hlSet = new Set<number>();
  for (const [start, end] of highlights) {
    const e = end ?? start;
    for (let i = start; i <= e; i++) hlSet.add(i);
  }

  return content.split('\n').map((line, i) => {
    const lineNum = i + 1;
    const isHighlighted = hlSet.has(lineNum);
    return (
      <div
        key={i}
        className={isHighlighted ? 'bg-yellow-500/15 border-l-2 border-yellow-400 pl-1 -ml-1' : ''}
      >
        {line}
      </div>
    );
  });
}

function LinkIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25z" />
      <path d="M8.225 12.725a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 1 1-2.83-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25z" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5v12a.5.5 0 0 1-.765.424L8 12.266l-4.235 2.658A.5.5 0 0 1 3 14.5v-12z" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z" />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427z" />
    </svg>
  );
}

export default HashRefText;
