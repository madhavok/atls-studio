import { useState, useEffect, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/appStore';
import type { LanguageHealth, LanguageCapabilities } from './types';

const CAPABILITY_LABELS: Record<keyof LanguageCapabilities, string> = {
  inventory: 'Inv',
  rename: 'Ren',
  move: 'Mov',
  extract: 'Ext',
  find_symbol: 'Find',
  symbol_usage: 'Refs',
  verify_typecheck: 'Check',
  verify_test: 'Test',
};

function CapBadge({ supported, label }: { supported: boolean; label: string }) {
  return (
    <span
      title={`${label}: ${supported ? 'supported' : 'not supported'}`}
      className={`
        inline-flex items-center justify-center w-[30px] text-[9px] font-medium rounded px-0.5 py-px
        ${supported
          ? 'bg-emerald-500/15 text-emerald-400'
          : 'bg-red-500/10 text-red-400/60'
        }
      `}
    >
      {label}
    </span>
  );
}

function SymbolBar({ symbols }: { symbols: LanguageHealth['symbols'] }) {
  const total = symbols.total || 1;
  const segments = [
    { key: 'fn', count: symbols.functions, label: 'Functions' },
    { key: 'st', count: symbols.structs, label: 'Structs/Classes' },
    { key: 'mt', count: symbols.methods, label: 'Methods' },
    { key: 'tr', count: symbols.traits, label: 'Traits/Interfaces' },
    { key: 'ty', count: symbols.types, label: 'Types' },
    { key: 'co', count: symbols.constants, label: 'Constants' },
    { key: 'ot', count: symbols.other, label: 'Other' },
  ].filter(s => s.count > 0);

  const colors = [
    'bg-blue-400', 'bg-amber-400', 'bg-emerald-400',
    'bg-purple-400', 'bg-cyan-400', 'bg-orange-400', 'bg-zinc-400',
  ];

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-1.5 rounded-full overflow-hidden bg-studio-border">
        {segments.map((seg, i) => (
          <div
            key={seg.key}
            className={`${colors[i]} h-full`}
            style={{ width: `${(seg.count / total) * 100}%` }}
            title={`${seg.label}: ${seg.count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0">
        {segments.map((seg, i) => (
          <span key={seg.key} className="flex items-center gap-0.5 text-[9px] text-studio-muted">
            <span className={`w-1.5 h-1.5 rounded-full ${colors[i]}`} />
            {seg.label} {seg.count}
          </span>
        ))}
      </div>
    </div>
  );
}

function generateGaps(languages: LanguageHealth[]): string[] {
  const gaps: string[] = [];
  for (const lang of languages) {
    if (lang.symbols.total === 0 && lang.files > 0) {
      gaps.push(`${lang.language}: 0 symbols indexed across ${lang.files} files`);
    }
    const structExpected = ['Go', 'Java', 'CSharp', 'C#', 'Rust', 'C', 'C++'].includes(lang.language);
    if (lang.symbols.structs === 0 && lang.symbols.functions > 10 && structExpected) {
      gaps.push(`${lang.language}: no structs/classes indexed (${lang.symbols.functions} functions found)`);
    }
    if (lang.calls === 0 && lang.symbols.total > 0) {
      gaps.push(`${lang.language}: 0 call-sites tracked (cross-reference may not work)`);
    }
    const caps = lang.capabilities;
    const unsupported = (Object.keys(caps) as (keyof LanguageCapabilities)[])
      .filter(k => !caps[k]);
    if (unsupported.length > 0 && unsupported.length <= 4) {
      gaps.push(`${lang.language}: ${unsupported.join(', ')} not supported`);
    }
  }
  return gaps;
}

function buildReport(languages: LanguageHealth[]): string {
  const lines: string[] = ['Language Health Report', '='.repeat(40), ''];
  for (const lang of languages) {
    lines.push(`${lang.language}`);
    lines.push(`  Files: ${lang.files}  LOC: ${lang.loc.toLocaleString()}`);
    lines.push(`  Symbols: ${lang.symbols.total} (fn:${lang.symbols.functions} struct:${lang.symbols.structs} method:${lang.symbols.methods} trait:${lang.symbols.traits} type:${lang.symbols.types} const:${lang.symbols.constants} other:${lang.symbols.other})`);
    lines.push(`  Calls: ${lang.calls}  Issues: ${lang.issues}`);
    const caps = lang.capabilities;
    const supported = (Object.keys(caps) as (keyof LanguageCapabilities)[]).filter(k => caps[k]);
    const unsupported = (Object.keys(caps) as (keyof LanguageCapabilities)[]).filter(k => !caps[k]);
    if (supported.length > 0) lines.push(`  Supported: ${supported.join(', ')}`);
    if (unsupported.length > 0) lines.push(`  Unsupported: ${unsupported.join(', ')}`);
    lines.push('');
  }
  const gaps = generateGaps(languages);
  if (gaps.length > 0) {
    lines.push('Gaps / Warnings', '-'.repeat(30));
    gaps.forEach(g => lines.push(`  - ${g}`));
  }
  return lines.join('\n');
}

export function HealthTab() {
  const { projectPath, activeRoot, languageHealth, setLanguageHealth } = useAppStore();
  const resolvedRoot = activeRoot ?? projectPath;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchHealth = useCallback(async () => {
    if (!resolvedRoot) return;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<{ languages: LanguageHealth[] }>('atls_get_language_health');
      setLanguageHealth(result.languages);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [resolvedRoot, setLanguageHealth]);

  useEffect(() => {
    if (resolvedRoot && !languageHealth) {
      fetchHealth();
    }
  }, [resolvedRoot, languageHealth, fetchHealth]);

  const gaps = useMemo(() => languageHealth ? generateGaps(languageHealth) : [], [languageHealth]);
  const totals = useMemo(() => {
    if (!languageHealth) return { langs: 0, symbols: 0, calls: 0, issues: 0 };
    return {
      langs: languageHealth.length,
      symbols: languageHealth.reduce((s, l) => s + l.symbols.total, 0),
      calls: languageHealth.reduce((s, l) => s + l.calls, 0),
      issues: languageHealth.reduce((s, l) => s + l.issues, 0),
    };
  }, [languageHealth]);

  const handleCopy = useCallback(() => {
    if (!languageHealth) return;
    navigator.clipboard.writeText(buildReport(languageHealth));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [languageHealth]);

  if (!resolvedRoot) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-studio-muted">Open a project to view language health</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-studio-muted">Loading language health...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 space-y-2">
        <p className="text-sm text-studio-error">{error}</p>
        <button onClick={fetchHealth} className="text-xs text-studio-accent hover:underline">Retry</button>
      </div>
    );
  }

  if (!languageHealth || languageHealth.length === 0) {
    return (
      <div className="text-center py-8 space-y-2">
        <p className="text-sm text-studio-muted">No language data. Scan the project first.</p>
        <button onClick={fetchHealth} className="text-xs text-studio-accent hover:underline">Refresh</button>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3 overflow-y-auto scrollbar-thin flex-1">
      {/* Header row: title + actions */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-studio-title">Language Index Health</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="text-[10px] px-2 py-0.5 rounded bg-studio-border/50 text-studio-muted hover:text-studio-text hover:bg-studio-border transition-colors"
          >
            {copied ? 'Copied!' : 'Copy Report'}
          </button>
          <button
            onClick={fetchHealth}
            className="text-[10px] px-2 py-0.5 rounded bg-studio-border/50 text-studio-muted hover:text-studio-text hover:bg-studio-border transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'Languages', value: totals.langs },
          { label: 'Symbols', value: totals.symbols },
          { label: 'Call Sites', value: totals.calls },
          { label: 'Issues', value: totals.issues },
        ].map(({ label, value }) => (
          <div key={label} className="bg-studio-surface rounded p-2 border border-studio-border text-center">
            <span className="text-[10px] text-studio-muted uppercase tracking-wide block">{label}</span>
            <span className="text-lg font-semibold text-studio-text">{value.toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* Per-language rows */}
      {languageHealth.map((lang) => (
        <div
          key={lang.language}
          className="bg-studio-surface rounded p-2 border border-studio-border space-y-1.5"
        >
          {/* Language header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-studio-text">{lang.language}</span>
              {lang.symbols.total === 0 && lang.files > 0 && (
                <span className="text-[9px] px-1 py-px rounded bg-red-500/15 text-red-400" title="No symbols indexed">
                  NO SYMBOLS
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-studio-muted">
              <span>{lang.files} files</span>
              <span>{lang.loc.toLocaleString()} LOC</span>
              <span>{lang.symbols.total} sym</span>
              <span>{lang.calls} calls</span>
              {lang.issues > 0 && <span className="text-studio-warning">{lang.issues} issues</span>}
            </div>
          </div>

          {/* Symbol breakdown bar */}
          {lang.symbols.total > 0 && <SymbolBar symbols={lang.symbols} />}

          {/* Capability badges */}
          <div className="flex flex-wrap gap-1">
            {(Object.keys(CAPABILITY_LABELS) as (keyof LanguageCapabilities)[]).map((cap) => (
              <CapBadge key={cap} supported={lang.capabilities[cap]} label={CAPABILITY_LABELS[cap]} />
            ))}
          </div>
        </div>
      ))}

      {/* Gaps / Warnings */}
      {gaps.length > 0 && (
        <div className="bg-studio-surface rounded p-2 border border-studio-warning/30 space-y-1">
          <span className="text-[10px] text-studio-warning uppercase tracking-wide font-medium block">
            Gaps / Warnings ({gaps.length})
          </span>
          {gaps.map((gap, i) => (
            <div key={i} className="text-xs text-studio-muted flex items-start gap-1.5">
              <span className="text-studio-warning shrink-0 mt-0.5">&#x26A0;</span>
              <span>{gap}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
