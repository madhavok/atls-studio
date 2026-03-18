import { useState, useEffect, useCallback } from 'react';
import { atlsBatchQuery } from '../../services/toolHelpers';
import { useAppStore } from '../../stores/appStore';
import { ArrowDownIcon, ArrowUpIcon, AlertIcon, RefreshIcon, SpinnerIcon, CodeIcon } from './icons';
import type { ComplexityEntry, DetectedPattern, RefactorCandidate } from './types';

/** Section header with collapse toggle */
function SectionHeader({
  label, count, icon, expanded, onToggle, badge,
}: {
  label: string; count?: number; icon?: React.ReactNode;
  expanded: boolean; onToggle: () => void; badge?: React.ReactNode;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 p-2 bg-studio-surface hover:bg-studio-border/30 transition-colors"
    >
      {expanded ? <ArrowDownIcon /> : <ArrowUpIcon />}
      {icon}
      <span className="text-xs font-medium">{label}</span>
      {badge}
      {count !== undefined && (
        <span className="text-xs text-studio-muted ml-auto">{count}</span>
      )}
    </button>
  );
}

/** Severity-style bar for complexity score */
function ComplexityBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.round((score / 100) * 100));
  let color = 'bg-studio-success';
  if (score > 50) color = 'bg-studio-error';
  else if (score > 20) color = 'bg-studio-warning';

  return (
    <div className="w-12 h-1.5 bg-studio-border rounded-full overflow-hidden shrink-0" title={`Complexity: ${score}`}>
      <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PatternsTab() {
  const { projectPath, activeRoot, openFile, setPendingScrollLine } = useAppStore();
  const resolvedRoot = activeRoot ?? projectPath;
  const hasProject = !!resolvedRoot;

  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set([
    'complexity', 'antipatterns', 'refactor',
  ]));

  // Data
  const [complexity, setComplexity] = useState<ComplexityEntry[]>([]);
  const [patterns, setPatterns] = useState<DetectedPattern[]>([]);
  const [refactorCandidates, setRefactorCandidates] = useState<RefactorCandidate[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);

  // Expanded anti-pattern groups
  const [expandedPatterns, setExpandedPatterns] = useState<Set<string>>(new Set());

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const togglePattern = (id: string) => {
    setExpandedPatterns(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fetchPatterns = useCallback(async () => {
    if (!resolvedRoot) return;

    setLoading(true);
    setError(null);

    try {
      const results = await Promise.allSettled([
        atlsBatchQuery('ast_query', { query: 'function where complexity > 10', limit: 25 }),
        atlsBatchQuery('detect_patterns', { file_paths: [resolvedRoot] }),
      ]);

      // Parse complexity
      if (results[0].status === 'fulfilled') {
        const r = results[0].value as any;
        const entries: ComplexityEntry[] = [];
        const items = r?.results || r?.matches || [];
        for (const item of items) {
          entries.push({
            name: item.name || item.symbol || 'unknown',
            file: item.file || '',
            line: item.line || 0,
            complexity: item.complexity || 0,
            lines: item.lines || item.line_count || 0,
            kind: item.kind || 'function',
          });
        }
        // Sort by complexity descending
        entries.sort((a, b) => b.complexity - a.complexity);
        setComplexity(entries);

        // Fetch refactoring inventory for top hotspot files
        const topFiles = [...new Set(entries.slice(0, 5).map(e => e.file))].filter(Boolean);
        if (topFiles.length > 0) {
          try {
            const invResult = await atlsBatchQuery('refactor', { action: 'inventory', file_paths: topFiles, min_complexity: 20 }) as Record<string, unknown> | null;
            const candidates: RefactorCandidate[] = [];
            const methods = Array.isArray(invResult?.methods) ? invResult.methods : Array.isArray(invResult?.results) ? invResult.results : [];
            for (const m of methods) {
              candidates.push({
                name: m.name || m.method || 'unknown',
                file: m.file || '',
                line: m.line || 0,
                complexity: m.complexity || 0,
                lines: m.lines || m.line_count || 0,
                signature: m.signature,
              });
            }
            candidates.sort((a, b) => b.complexity - a.complexity);
            setRefactorCandidates(candidates);
          } catch {
            // Non-critical: refactor inventory is supplementary
          }
        }
      }

      // Parse anti-patterns
      if (results[1].status === 'fulfilled') {
        const r = results[1].value as any;
        const pats: DetectedPattern[] = [];
        const rawPatterns = r?.patterns || r?.results || [];
        for (const p of rawPatterns) {
          pats.push({
            pattern_id: p.pattern_id || p.id || p.name || 'unknown',
            description: p.description || p.message,
            matches: (p.matches || p.locations || []).map((m: any) => ({
              file: m.file || '',
              line: m.line || 0,
              message: m.message || m.snippet,
              snippet: m.snippet,
            })),
            count: p.count || p.matches?.length || p.locations?.length || 0,
          });
        }
        pats.sort((a, b) => b.count - a.count);
        setPatterns(pats);
      }

      setHasFetched(true);
    } catch (err) {
      console.error('PatternsTab: fetch error', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch patterns');
    } finally {
      setLoading(false);
    }
  }, [resolvedRoot]);

  // Fetch once when tab mounts (or active root changes)
  useEffect(() => {
    if (hasProject && !hasFetched) {
      fetchPatterns();
    }
  }, [hasProject, hasFetched, fetchPatterns]);

  // Reset when active root changes
  useEffect(() => {
    setHasFetched(false);
    setComplexity([]);
    setPatterns([]);
    setRefactorCandidates([]);
  }, [resolvedRoot]);

  if (!hasProject) {
    return (
      <div className="p-4 text-center text-studio-muted">
        <CodeIcon />
        <p className="text-sm mt-2">Open a project</p>
        <p className="text-xs mt-1">ATLS will analyze code patterns</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 text-center text-studio-muted">
        <SpinnerIcon />
        <p className="text-sm mt-2">Analyzing patterns...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center text-studio-error">
        <AlertIcon severity="high" />
        <p className="text-sm mt-2">{error}</p>
        <button onClick={fetchPatterns} className="mt-2 text-xs text-studio-accent hover:underline">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-2 overflow-y-auto scrollbar-thin flex-1">
      {/* Refresh */}
      <div className="flex justify-end">
        <button
          onClick={() => { setHasFetched(false); fetchPatterns(); }}
          className="flex items-center gap-1 px-2 py-1 text-xs text-studio-muted hover:text-studio-text border border-studio-border rounded hover:bg-studio-surface transition-colors"
        >
          <RefreshIcon /> Refresh
        </button>
      </div>

      {/* Complexity Hotspots */}
      <div className="border border-studio-border rounded overflow-hidden">
        <SectionHeader
          label="Complexity Hotspots"
          count={complexity.length}
          icon={<span className="text-studio-warning text-xs">C</span>}
          expanded={expandedSections.has('complexity')}
          onToggle={() => toggleSection('complexity')}
        />
        {expandedSections.has('complexity') && (
          <div className="divide-y divide-studio-border/50 max-h-72 overflow-y-auto scrollbar-thin">
            {complexity.length > 0 ? (
              complexity.map((entry, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-studio-border/20 cursor-pointer transition-colors"
                  onClick={() => {
                    if (entry.file) openFile(entry.file);
                    if (entry.line) setPendingScrollLine(entry.line);
                  }}
                >
                  <span className="text-studio-text truncate flex-1" title={entry.name}>{entry.name}</span>
                  <ComplexityBar score={entry.complexity} />
                  <span className="text-studio-muted tabular-nums shrink-0 w-8 text-right">{entry.complexity}</span>
                  {entry.lines ? (
                    <span className="text-studio-muted text-[10px] shrink-0 w-10 text-right">{entry.lines}L</span>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="px-3 py-3 text-xs text-studio-muted text-center">
                No high-complexity functions found
              </div>
            )}
          </div>
        )}
      </div>

      {/* Anti-Patterns */}
      <div className="border border-studio-border rounded overflow-hidden">
        <SectionHeader
          label="Anti-Patterns"
          count={patterns.reduce((sum, p) => sum + p.count, 0)}
          icon={<AlertIcon severity="medium" />}
          expanded={expandedSections.has('antipatterns')}
          onToggle={() => toggleSection('antipatterns')}
          badge={patterns.length > 0 ? (
            <span className="text-[10px] px-1 py-0.5 bg-studio-warning/10 text-studio-warning rounded">
              {patterns.length} type{patterns.length !== 1 ? 's' : ''}
            </span>
          ) : undefined}
        />
        {expandedSections.has('antipatterns') && (
          <div className="max-h-72 overflow-y-auto scrollbar-thin">
            {patterns.length > 0 ? (
              patterns.map((pat) => (
                <div key={pat.pattern_id} className="border-b border-studio-border/30 last:border-0">
                  <button
                    onClick={() => togglePattern(pat.pattern_id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-studio-border/20 transition-colors"
                  >
                    {expandedPatterns.has(pat.pattern_id) ? <ArrowDownIcon /> : <ArrowUpIcon />}
                    <span className="text-xs text-studio-text truncate flex-1 text-left">{pat.pattern_id}</span>
                    <span className="text-[10px] text-studio-muted shrink-0">{pat.count} match{pat.count !== 1 ? 'es' : ''}</span>
                  </button>
                  {expandedPatterns.has(pat.pattern_id) && (
                    <div className="divide-y divide-studio-border/20 bg-studio-bg/30">
                      {pat.description && (
                        <div className="px-4 py-1 text-[10px] text-studio-muted">{pat.description}</div>
                      )}
                      {pat.matches.slice(0, 10).map((m, i) => (
                        <div
                          key={i}
                          className="px-4 py-1 text-xs hover:bg-studio-border/20 cursor-pointer transition-colors"
                          onClick={() => {
                            if (m.file) openFile(m.file);
                            if (m.line) setPendingScrollLine(m.line);
                          }}
                        >
                          <span className="text-studio-muted truncate">{m.file}</span>
                          <span className="text-studio-muted">:{m.line}</span>
                          {m.message && <span className="text-studio-text ml-2">{m.message}</span>}
                        </div>
                      ))}
                      {pat.matches.length > 10 && (
                        <div className="px-4 py-1 text-[10px] text-studio-muted">
                          +{pat.matches.length - 10} more matches
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="px-3 py-3 text-xs text-studio-muted text-center">
                No anti-patterns detected
              </div>
            )}
          </div>
        )}
      </div>

      {/* Refactoring Candidates */}
      <div className="border border-studio-border rounded overflow-hidden">
        <SectionHeader
          label="Refactoring Candidates"
          count={refactorCandidates.length}
          icon={<span className="text-studio-accent text-xs">R</span>}
          expanded={expandedSections.has('refactor')}
          onToggle={() => toggleSection('refactor')}
        />
        {expandedSections.has('refactor') && (
          <div className="divide-y divide-studio-border/50 max-h-64 overflow-y-auto scrollbar-thin">
            {refactorCandidates.length > 0 ? (
              refactorCandidates.map((c, idx) => (
                <div
                  key={idx}
                  className="px-3 py-1.5 text-xs hover:bg-studio-border/20 cursor-pointer transition-colors"
                  onClick={() => {
                    if (c.file) openFile(c.file);
                    if (c.line) setPendingScrollLine(c.line);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-studio-text truncate flex-1" title={c.name}>{c.name}</span>
                    <ComplexityBar score={c.complexity} />
                    <span className="text-studio-muted tabular-nums shrink-0 w-8 text-right">{c.complexity}</span>
                  </div>
                  <div className="text-[10px] text-studio-muted mt-0.5 truncate">
                    {c.file} · {c.lines}L
                    {c.signature && <span className="ml-1 text-studio-muted/60">{c.signature}</span>}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-3 py-3 text-xs text-studio-muted text-center">
                {complexity.length === 0 ? 'Run a scan to detect refactoring targets' : 'No methods exceed complexity threshold'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
