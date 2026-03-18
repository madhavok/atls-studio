/**
 * TemplateCard — renders filled BB templates as styled inline cards.
 *
 * The model emits «tpl:NAME|val1|val2|...» in chat output. MarkdownMessage
 * parses this into a <span class="tpl-card"> with data attributes, which the
 * MdSpan handler converts into this component.
 *
 * Slot filling is positional: values map to {placeholder} tokens in the
 * template skeleton in order of appearance. Values prefixed with h: are
 * rendered as hash ref pills. `_` skips a slot.
 */

import { memo, useState, useCallback, useMemo } from 'react';
import { useContextStore } from '../../stores/contextStore';
import { HashRefText } from './HashRefInline';

// Matches {placeholder} tokens in template skeletons
const PLACEHOLDER_RE = /\{[^}]+\}/g;

// Template type labels and accent colors
const TPL_META: Record<string, { label: string; accent: string; icon: string }> = {
  analysis:  { label: 'Analysis',  accent: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10',     icon: '🔍' },
  refactor:  { label: 'Refactor',  accent: 'text-violet-400 border-violet-500/30 bg-violet-500/10', icon: '♻️' },
  task:      { label: 'Task',      accent: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', icon: '✓' },
  diff:      { label: 'Change',    accent: 'text-amber-400 border-amber-500/30 bg-amber-500/10',   icon: '±' },
  issue:     { label: 'Issue',     accent: 'text-red-400 border-red-500/30 bg-red-500/10',         icon: '⚠' },
  scope:     { label: 'Scope',     accent: 'text-blue-400 border-blue-500/30 bg-blue-500/10',      icon: '◎' },
  status:    { label: 'Status',    accent: 'text-teal-400 border-teal-500/30 bg-teal-500/10',      icon: '◆' },
  complete:  { label: 'Task Complete', accent: 'text-green-400 border-green-500/30 bg-green-500/10', icon: '✓' },
};

const DEFAULT_META = { label: 'Template', accent: 'text-studio-muted border-studio-border bg-studio-surface/50', icon: '▦' };

interface TemplateCardProps {
  templateName: string;
  values: string[];
}

export const TemplateCard = memo(function TemplateCard({ templateName, values }: TemplateCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed(v => !v), []);

  const tplKey = templateName.startsWith('tpl:') ? templateName : `tpl:${templateName}`;
  const skeleton = useContextStore(s => s.blackboardEntries.get(tplKey)?.content);

  const meta = TPL_META[templateName] ?? DEFAULT_META;

  const filled = useMemo(() => {
    if (!skeleton) return null;

    const placeholders: string[] = [];
    skeleton.replace(PLACEHOLDER_RE, (match) => {
      placeholders.push(match);
      return match;
    });

    let result = skeleton;
    let valIdx = 0;
    for (const ph of placeholders) {
      if (valIdx >= values.length) break;
      const val = values[valIdx];
      valIdx++;
      if (val === '_') continue; // skip slot
      const text = val.startsWith('t:') ? val.slice(2) : val;
      result = result.replace(ph, text);
    }

    // Remove any unfilled placeholders
    result = result.replace(PLACEHOLDER_RE, '—');

    return result;
  }, [skeleton, values]);

  // Title: first non-skip value, or template label
  const title = values.find(v => v !== '_')?.replace(/^t:/, '') ?? meta.label;

  if (!skeleton) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono text-studio-warning border border-studio-warning/30 bg-studio-warning/10">
        tpl:{templateName} not found
      </span>
    );
  }

  return (
    <div className={`my-2 rounded-lg border ${meta.accent} overflow-hidden`}>
      <button
        onClick={toggle}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm font-medium transition-colors hover:brightness-110 ${meta.accent}`}
      >
        <span className="text-base leading-none">{meta.icon}</span>
        <span className="font-semibold">{meta.label}</span>
        <span className="opacity-70 text-xs truncate flex-1">{title !== meta.label ? title : ''}</span>
        <svg
          className={`w-3.5 h-3.5 shrink-0 transition-transform ${collapsed ? '' : 'rotate-180'}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427z" />
        </svg>
      </button>
      {!collapsed && filled && (
        <div className="px-3 py-2 text-xs leading-relaxed bg-studio-bg/50 border-t border-inherit">
          <TemplateContent content={filled} />
        </div>
      )}
    </div>
  );
});

/**
 * Renders filled template content line-by-line with hash ref pill support.
 * Lines starting with ## or ### get header styling; lines with h: refs
 * get wrapped in HashRefText for pill rendering.
 */
const TemplateContent = memo(function TemplateContent({ content }: { content: string }) {
  const lines = content.split('\n');
  const HREF_DETECT = /h:[0-9a-fA-F]{6,16}|h:bb:[a-zA-Z0-9_.\-:]+/;

  return (
    <>
      {lines.map((line, i) => {
        const trimmed = line.trimStart();

        if (trimmed.startsWith('## ')) {
          return (
            <div key={i} className="text-sm font-semibold mt-1.5 mb-0.5 text-studio-text">
              {renderLine(trimmed.slice(3), HREF_DETECT)}
            </div>
          );
        }
        if (trimmed.startsWith('### ')) {
          return (
            <div key={i} className="text-xs font-semibold mt-1.5 mb-0.5 text-studio-text/90">
              {renderLine(trimmed.slice(4), HREF_DETECT)}
            </div>
          );
        }
        if (trimmed.startsWith('**') && trimmed.includes(':**')) {
          const colonIdx = trimmed.indexOf(':**');
          const label = trimmed.slice(2, colonIdx);
          const value = trimmed.slice(colonIdx + 3).replace(/\*\*\s*$/, '');
          return (
            <div key={i} className="flex gap-1.5 py-0.5">
              <span className="font-semibold text-studio-text/80 shrink-0">{label}:</span>
              <span className="text-studio-text/90">{renderLine(value, HREF_DETECT)}</span>
            </div>
          );
        }
        if (trimmed.startsWith('- ')) {
          return (
            <div key={i} className="flex gap-1.5 py-0.5 pl-2">
              <span className="text-studio-muted shrink-0">•</span>
              <span className="text-studio-text/90">{renderLine(trimmed.slice(2), HREF_DETECT)}</span>
            </div>
          );
        }
        if (/^\d+\.\s/.test(trimmed)) {
          const numEnd = trimmed.indexOf('. ');
          const num = trimmed.slice(0, numEnd + 1);
          const rest = trimmed.slice(numEnd + 2);
          return (
            <div key={i} className="flex gap-1.5 py-0.5 pl-2">
              <span className="text-studio-muted shrink-0 font-mono text-[10px]">{num}</span>
              <span className="text-studio-text/90">{renderLine(rest, HREF_DETECT)}</span>
            </div>
          );
        }
        if (trimmed === '' || trimmed === '—') return <div key={i} className="h-1" />;

        return (
          <div key={i} className="py-0.5 text-studio-text/90">
            {renderLine(trimmed, HREF_DETECT)}
          </div>
        );
      })}
    </>
  );
});

function renderLine(text: string, hrefDetect: RegExp): React.ReactNode {
  if (hrefDetect.test(text)) {
    return <HashRefText text={text} />;
  }
  return text;
}

// ---------------------------------------------------------------------------
// TaskCompleteCard — wraps TemplateCard for task_complete tool results
// ---------------------------------------------------------------------------

interface TaskCompleteCardProps {
  summary: string;
  filesChanged: string[];
}

export const TaskCompleteCard = memo(function TaskCompleteCard({ summary, filesChanged }: TaskCompleteCardProps) {
  const filesList = filesChanged.length > 0 ? filesChanged.join(', ') : 'none';
  return <TemplateCard templateName="complete" values={[summary, filesList]} />;
});
