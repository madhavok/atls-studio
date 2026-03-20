import { memo, useCallback, useMemo, useState, useEffect, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { openUrl } from '@tauri-apps/plugin-opener';
import { HashRefText } from './HashRefInline';
import { TemplateCard } from './TemplateCard';
import type { HighlighterCore } from 'shiki';

// Matches «st:working|step:1/3» with or without guillemets (Gemini often drops «)
const STATUS_MARKER_RE = /«?(st:\s*(?:working|done)(?:\|[^\n»]*)?)»?/g;

// Matches «tpl:NAME|val1|val2|...» template shorthand markers
const TPL_MARKER_RE = /«tpl:([a-zA-Z0-9_-]+)\|([^»]+)»/g;

/** Escape a string for safe embedding in an HTML attribute. */
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace status markers and template shorthand with HTML spans that survive
 * the markdown pipeline. Status markers are deduplicated; template markers
 * are converted to <span class="tpl-card"> with encoded data attributes.
 */
function injectMarkerHtml(text: string): string {
  let result = text;

  // Template markers — must run first (before status markers consume «»)
  result = result.replace(TPL_MARKER_RE, (_match, name: string, valStr: string) => {
    const encoded = encodeURIComponent(valStr);
    return `<span class="tpl-card" data-tpl="${escAttr(name)}" data-vals="${escAttr(encoded)}"></span>`;
  });

  // Status markers
  let lastBadge = '';
  result = result.replace(STATUS_MARKER_RE, (_match, inner: string) => {
    const kv: Record<string, string> = {};
    inner.split('|').forEach((pair: string) => {
      const [k, v] = pair.split(':').map((s: string) => s.trim());
      if (k && v) kv[k] = v;
    });
    const status = kv['st'] ?? '';
    if (status === 'done') return '';
    const step = kv['step'] ?? '';
    const next = kv['next'] ?? '';
    const badge = `${status}|${step}|${next}`;
    if (badge === lastBadge) return '';
    lastBadge = badge;
    return `<span class="status-badge" data-status="${escAttr(status)}" data-step="${escAttr(step)}" data-next="${escAttr(next)}"></span>`;
  });

  return result;
}

function MdLink({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (href) openUrl(href).catch(() => {});
  }, [href]);

  return (
    <a href={href} onClick={handleClick} className="md-link" {...rest}>
      {children}
    </a>
  );
}

const HREF_DETECT = /h:[0-9a-fA-F]{6,16}(?:\.\.[h:]?[0-9a-fA-F]{6,16})?|h:bb:[a-zA-Z0-9_.\-:]+/;

/**
 * Recursively scan React children for string nodes containing h:refs
 * and wrap them with HashRefText for interactive pill rendering.
 */
function hashAwareChildren(children: ReactNode): ReactNode {
  if (!children) return children;
  if (typeof children === 'string') {
    if (HREF_DETECT.test(children)) {
      return <HashRefText text={children} />;
    }
    return children;
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string' && HREF_DETECT.test(child)) {
        return <HashRefText key={i} text={child} />;
      }
      return child;
    });
  }
  return children;
}

// ── Shiki syntax highlighter (lazy-loaded singleton) ────────────────────
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('shiki/bundle/web'),
      import('shiki/engine/javascript'),
    ]).then(([{ createHighlighterCore, bundledLanguages }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import('shiki/themes/github-dark-default.mjs')],
        langs: Object.values(bundledLanguages),
        engine: createJavaScriptRegexEngine(),
      })
    ).catch(e => {
      console.warn('[Shiki] Failed to initialize highlighter:', e);
      highlighterPromise = null;
      throw e;
    });
  }
  return highlighterPromise;
}

function useShikiHighlight(code: string, lang: string | undefined): string | null {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    if (!lang) return;
    let cancelled = false;
    getHighlighter().then(hl => {
      if (cancelled) return;
      try {
        const loadedLangs = hl.getLoadedLanguages();
        if (!loadedLangs.includes(lang as any)) return;
        const result = hl.codeToHtml(code, {
          lang,
          theme: 'github-dark-default',
        });
        setHtml(result);
      } catch {
        // Language not supported, fall back to plain
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [code, lang]);

  return html;
}

/** Hash-aware code: renders inline `h:XXXX` as pills, code blocks with Shiki highlighting. */
function HashAwareCode({ className, children, ...rest }: ComponentPropsWithoutRef<'code'>) {
  const match = /language-(\w+)/.exec(className || '');
  const lang = match?.[1];
  const code = String(children).replace(/\n$/, '');
  const isInline = !className && !String(children).includes('\n');
  const highlightedHtml = useShikiHighlight(code, isInline ? undefined : lang);

  if (isInline && HREF_DETECT.test(code)) {
    return <HashRefText text={code} />;
  }

  if (isInline) {
    return (
      <code className="md-inline-code" {...rest}>
        {children}
      </code>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
  };

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        {lang && <span className="md-code-lang">{lang}</span>}
        <button className="md-code-copy" onClick={handleCopy} title="Copy">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        </button>
      </div>
      {highlightedHtml ? (
        <div 
          className="md-code-pre shiki-container" 
          dangerouslySetInnerHTML={{ __html: highlightedHtml }} 
        />
      ) : (
        <pre className="md-code-pre">
          <code className={className} {...rest}>
            {children}
          </code>
        </pre>
      )}
    </div>
  );
}

const remarkPlugins = [remarkGfm, remarkBreaks];

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'span'],
  attributes: {
    ...defaultSchema.attributes,
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      'className', 'class',
      'data-status', 'data-step', 'data-next',
      'data-tpl', 'data-vals',
    ],
  },
};

const rehypePlugins: import('unified').PluggableList = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

function MdSpan(props: React.ComponentPropsWithoutRef<'span'> & ExtraProps) {
  const { className, node: _node, ...rest } = props;
  if (className === 'tpl-card') {
    const tpl = (rest as Record<string, unknown>)['data-tpl'] as string | undefined;
    const encoded = (rest as Record<string, unknown>)['data-vals'] as string | undefined;
    if (tpl && encoded) {
      const vals = decodeURIComponent(encoded).split('|');
      return <TemplateCard templateName={tpl} values={vals} />;
    }
  }
  return <span className={className} {...rest} />;
}

const components = {
  code: HashAwareCode,
  a: MdLink,
  span: MdSpan,
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => <>{children}</>,
  p: ({ children, ...rest }: ComponentPropsWithoutRef<'p'>) => (
    <p {...rest}>{hashAwareChildren(children)}</p>
  ),
  li: ({ children, ...rest }: ComponentPropsWithoutRef<'li'>) => (
    <li {...rest}>{hashAwareChildren(children)}</li>
  ),
  blockquote: ({ children, ...rest }: ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote {...rest}>{hashAwareChildren(children)}</blockquote>
  ),
  table: ({ children, ...rest }: ComponentPropsWithoutRef<'table'>) => (
    <div className="md-table-wrap">
      <table className="md-table" {...rest}>{children}</table>
    </div>
  ),
};

interface MarkdownMessageProps {
  content: string;
}

export const MarkdownMessage = memo(function MarkdownMessage({ content }: MarkdownMessageProps) {
  const processed = useMemo(() => injectMarkerHtml(content), [content]);

  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
});
