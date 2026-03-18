import { useState, useEffect, useCallback } from 'react';
import { atlsBatchQuery } from '../../services/toolHelpers';
import { useAppStore } from '../../stores/appStore';
import {
  AlertIcon, ArrowDownIcon, ArrowUpIcon,
  ImportIcon, ExportIcon, FileIcon, SymbolIcon,
  RefreshIcon, SpinnerIcon,
} from './icons';
import type {
  FileGraph, FileGraphRaw, SmartContext, ImpactAnalysis, ComponentContext,
  AffectedSymbol,
} from './types';

/** Section header with collapse toggle */
function SectionHeader({
  label, count, icon, expanded, onToggle,
}: {
  label: string; count?: number; icon?: React.ReactNode;
  expanded: boolean; onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 p-2 bg-studio-surface hover:bg-studio-border/30 transition-colors"
    >
      {expanded ? <ArrowDownIcon /> : <ArrowUpIcon />}
      {icon}
      <span className="text-xs font-medium">{label}</span>
      {count !== undefined && (
        <span className="text-xs text-studio-muted ml-auto">{count}</span>
      )}
    </button>
  );
}

export function FileIntelTab() {
  const { projectPath, activeRoot, activeFile, openFile, setPendingScrollLine } = useAppStore();
  const resolvedRoot = activeRoot ?? projectPath;
  const hasProject = !!resolvedRoot;

  // Collapsible sections
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set([
    'smart', 'impact', 'component', 'imports', 'exports', 'symbols',
    'sym-function', 'sym-class', 'sym-interface', 'sym-type', 'sym-const',
  ]));

  // Data state
  const [smartCtx, setSmartCtx] = useState<SmartContext | null>(null);
  const [impact, setImpact] = useState<ImpactAnalysis | null>(null);
  const [componentCtx, setComponentCtx] = useState<ComponentContext | null>(null);
  const [deps, setDeps] = useState<FileGraph | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isReactFile = activeFile?.match(/\.(tsx|jsx)$/) != null;

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  /** Fetch all file intelligence in parallel */
  const fetchAll = useCallback(async (filePath: string) => {
    if (!filePath || !resolvedRoot) return;

    setLoading(true);
    setError(null);
    setSmartCtx(null);
    setImpact(null);
    setComponentCtx(null);
    setDeps(null);

    const isReact = filePath.match(/\.(tsx|jsx)$/) != null;

    try {
      // Build batch of parallel queries
      const queries: Array<Promise<any>> = [
        atlsBatchQuery('context', { type: 'smart', file_paths: [filePath] }),
        atlsBatchQuery('dependencies', { mode: 'impact', file_paths: [filePath] }),
        atlsBatchQuery('dependencies', { mode: 'graph', file_paths: [filePath] }),
      ];

      if (isReact) {
        queries.push(atlsBatchQuery('context', { type: 'component', file_paths: [filePath] }));
      }

      const results = await Promise.allSettled(queries);

      // Parse smart context
      // Backend wraps as { file, relative_path, context: SmartContextResult }
      // SmartContextResult fields are arrays; extract counts for display
      if (results[0].status === 'fulfilled') {
        const r = results[0].value as any;
        const wrapper = r?.results?.[0] || r;
        // Unwrap nested context -- backend nests SmartContextResult inside "context" key
        const ctx = wrapper?.context || wrapper;
        if (ctx && !ctx.error) {
          const toCount = (v: any): number => {
            if (typeof v === 'number') return v;
            if (Array.isArray(v)) return v.length;
            return 0;
          };
          const toPathArray = (v: any): string[] =>
            (Array.isArray(v) ? v : []).map(
              (f: any) => (typeof f === 'string' ? f : f?.path || f?.file || ''),
            ).filter(Boolean);

          setSmartCtx({
            file: wrapper.file || ctx.file || filePath,
            symbols: toCount(ctx.symbols),
            imports: toCount(ctx.imports),
            related_files: toPathArray(ctx.related_files),
            issues: toCount(ctx.issues),
            summary: typeof ctx.summary === 'string' ? ctx.summary : undefined,
          });
        }
      }

      // Parse impact analysis
      // Backend returns: { file, direct_dependents: [{impact_type, path, symbols_affected}], indirect_dependents: [...], summary: {risk_level, ...} }
      if (results[1].status === 'fulfilled') {
        const r = results[1].value as any;
        const imp = r?.results?.[0] || r;
        if (imp && !imp.error) {
          const impactData = imp.impact || imp;

          // direct_dependents / indirect_dependents are arrays of objects, not numbers
          const directArr = Array.isArray(impactData.direct_dependents) ? impactData.direct_dependents : [];
          const indirectArr = Array.isArray(impactData.indirect_dependents) ? impactData.indirect_dependents : [];
          const extractPath = (f: any) => (typeof f === 'string' ? f : f?.path || f?.file || '');

          // risk_level lives inside the summary sub-object
          const summary = impactData.summary || {};
          const riskLevel = (typeof summary === 'string' ? summary : summary.risk_level) || impactData.risk_level || 'low';

          // Merge both arrays for a combined affected-files list, deduplicated
          const allPaths = [...directArr, ...indirectArr].map(extractPath).filter(Boolean);
          const uniquePaths = [...new Set(allPaths)];

          // Parse affected symbols (exported symbols referenced from other files)
          const rawSymbols = Array.isArray(impactData.affected_symbols) ? impactData.affected_symbols : [];
          const affectedSymbols: AffectedSymbol[] = rawSymbols.map((s: any) => ({
            name: s.name || '',
            file: s.file || '',
            kind: s.kind || '',
            line: typeof s.line === 'number' ? s.line : 0,
          })).filter((s: AffectedSymbol) => s.name);

          setImpact({
            file: impactData.file || filePath,
            risk_level: riskLevel as 'low' | 'medium' | 'high',
            direct_dependents: directArr.length,
            indirect_dependents: indirectArr.length,
            total_affected: uniquePaths.length,
            affected_files: uniquePaths,
            affected_symbols: affectedSymbols.length > 0 ? affectedSymbols : undefined,
          });
        }
      }

      // Parse dependency graph
      if (results[2].status === 'fulfilled') {
        const r = results[2].value as any;
        const first = r?.results?.[0];
        if (first?.graph) {
          const raw = first.graph as FileGraphRaw;
          setDeps({
            file: raw.file?.path || filePath,
            imports: raw.outgoing?.map((rel: any) => rel.path) || [],
            exports: raw.incoming?.map((rel: any) => rel.path) || [],
            symbols: raw.symbols || [],
          });
        }
      }

      // Parse component context (React only)
      if (isReact && results[3]?.status === 'fulfilled') {
        const r = results[3].value as any;
        const comp = r?.results?.[0] || r;
        if (comp && !comp.error) {
          const toStringArray = (arr: any[]) =>
            (arr || []).map((v: any) => (typeof v === 'string' ? v : v?.name || v?.path || String(v)));
          setComponentCtx({
            file: comp.file || filePath,
            children: toStringArray(comp.children || comp.child_components),
            hooks: toStringArray(comp.hooks),
            props: toStringArray(comp.props),
            framework: comp.framework || 'React',
          });
        }
      }
    } catch (err) {
      console.error('FileIntelTab: fetch error', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch file intelligence');
    } finally {
      setLoading(false);
    }
  }, [resolvedRoot]);

  // Fetch when active file changes
  useEffect(() => {
    if (activeFile && hasProject) {
      fetchAll(activeFile);
    }
  }, [activeFile, hasProject, fetchAll]);

  // -- Empty states --
  if (!hasProject) {
    return (
      <div className="p-4 text-center text-studio-muted">
        <FileIcon />
        <p className="text-sm mt-2">Open a project</p>
        <p className="text-xs mt-1">ATLS will analyze file intelligence</p>
      </div>
    );
  }
  if (!activeFile) {
    return (
      <div className="p-4 text-center text-studio-muted">
        <FileIcon />
        <p className="text-sm mt-2">Select a file to view intelligence</p>
        <p className="text-xs mt-1">Open a file from the explorer or issues</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="p-4 text-center text-studio-muted">
        <SpinnerIcon />
        <p className="text-sm mt-2">Analyzing file...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4 text-center text-studio-error">
        <AlertIcon severity="high" />
        <p className="text-sm mt-2">{error}</p>
        <button onClick={() => fetchAll(activeFile)} className="mt-2 text-xs text-studio-accent hover:underline">
          Try again
        </button>
      </div>
    );
  }

  // Kind-label map for symbols
  const kindLabels: Record<string, string> = {
    function: 'Functions', class: 'Classes', interface: 'Interfaces',
    type: 'Types', const: 'Constants', variable: 'Variables',
  };
  const kindOrder = ['function', 'class', 'interface', 'type', 'const', 'variable'];

  const riskColors: Record<string, string> = {
    high: 'bg-studio-error/20 text-studio-error border-studio-error/30',
    medium: 'bg-studio-warning/20 text-studio-warning border-studio-warning/30',
    low: 'bg-studio-success/20 text-studio-success border-studio-success/30',
  };

  return (
    <div className="p-2 space-y-2 overflow-y-auto scrollbar-thin flex-1">
      {/* Current file header */}
      <div className="p-2 bg-studio-surface rounded border border-studio-border">
        <div className="flex items-center gap-2">
          <FileIcon />
          <span className="text-sm font-medium truncate">{activeFile.split(/[/\\]/).pop()}</span>
          <button
            onClick={() => fetchAll(activeFile)}
            className="ml-auto p-1 text-studio-muted hover:text-studio-text transition-colors"
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
        <p className="text-xs text-studio-muted mt-1 truncate" title={activeFile}>{activeFile}</p>
      </div>

      {/* Smart Context summary */}
      {smartCtx && (
        <div className="border border-studio-border rounded overflow-hidden">
          <SectionHeader
            label="Smart Context"
            expanded={expandedSections.has('smart')}
            onToggle={() => toggleSection('smart')}
          />
          {expandedSections.has('smart') && (
            <div className="p-2 grid grid-cols-3 gap-2 text-center">
              <div className="bg-studio-bg rounded p-1.5 border border-studio-border/50">
                <span className="text-lg font-semibold text-studio-text">{smartCtx.symbols}</span>
                <span className="block text-[10px] text-studio-muted uppercase">Symbols</span>
              </div>
              <div className="bg-studio-bg rounded p-1.5 border border-studio-border/50">
                <span className="text-lg font-semibold text-studio-text">{smartCtx.imports}</span>
                <span className="block text-[10px] text-studio-muted uppercase">Imports</span>
              </div>
              <div className="bg-studio-bg rounded p-1.5 border border-studio-border/50">
                <span className="text-lg font-semibold text-studio-text">{smartCtx.issues ?? 0}</span>
                <span className="block text-[10px] text-studio-muted uppercase">Issues</span>
              </div>
              {smartCtx.related_files && smartCtx.related_files.length > 0 && (
                <div className="col-span-3 text-left">
                  <span className="text-[10px] text-studio-muted uppercase block mb-1">Related Files</span>
                  <div className="space-y-0.5">
                    {smartCtx.related_files.slice(0, 5).map((f, i) => (
                      <div
                        key={i}
                        className="text-xs text-studio-text truncate hover:text-studio-accent cursor-pointer"
                        onClick={() => openFile(f)}
                        title={f}
                      >
                        {f}
                      </div>
                    ))}
                    {smartCtx.related_files.length > 5 && (
                      <span className="text-[10px] text-studio-muted">+{smartCtx.related_files.length - 5} more</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Impact Analysis */}
      {impact && (
        <div className="border border-studio-border rounded overflow-hidden">
          <SectionHeader
            label="Impact Analysis"
            count={impact.total_affected}
            expanded={expandedSections.has('impact')}
            onToggle={() => toggleSection('impact')}
          />
          {expandedSections.has('impact') && (
            <div className="p-2 space-y-2">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border ${riskColors[impact.risk_level] || riskColors.low}`}>
                  {impact.risk_level} risk
                </span>
                <span className="text-xs text-studio-muted">
                  {impact.total_affected} file{impact.total_affected !== 1 ? 's' : ''} affected
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-studio-bg rounded p-1.5 border border-studio-border/50 text-center">
                  <span className="text-sm font-semibold text-studio-text">{impact.direct_dependents}</span>
                  <span className="block text-[10px] text-studio-muted uppercase">Direct</span>
                </div>
                <div className="bg-studio-bg rounded p-1.5 border border-studio-border/50 text-center">
                  <span className="text-sm font-semibold text-studio-text">{impact.indirect_dependents}</span>
                  <span className="block text-[10px] text-studio-muted uppercase">Indirect</span>
                </div>
                <div className="bg-studio-bg rounded p-1.5 border border-studio-border/50 text-center">
                  <span className="text-sm font-semibold text-studio-text">{impact.affected_symbols?.length ?? 0}</span>
                  <span className="block text-[10px] text-studio-muted uppercase">Symbols</span>
                </div>
              </div>
              {impact.affected_symbols && impact.affected_symbols.length > 0 && (
                <div>
                  <span className="text-[10px] text-studio-muted uppercase block mb-1">
                    Affected Symbols ({impact.affected_symbols.length})
                  </span>
                  <div className="space-y-0.5 max-h-28 overflow-y-auto scrollbar-thin">
                    {impact.affected_symbols.map((s, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-1.5 text-xs hover:bg-studio-border/20 cursor-pointer px-1 py-0.5 rounded transition-colors"
                        onClick={() => { openFile(s.file); setPendingScrollLine(s.line); }}
                        title={`${s.kind} ${s.name} (${s.file}:${s.line})`}
                      >
                        <SymbolIcon kind={s.kind} />
                        <span className="text-studio-text truncate">{s.name}</span>
                        <span className="text-studio-muted text-[10px] ml-auto shrink-0">L{s.line}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {impact.affected_files && impact.affected_files.length > 0 && (
                <div>
                  <span className="text-[10px] text-studio-muted uppercase block mb-1">Affected Files</span>
                  <div className="space-y-0.5 max-h-32 overflow-y-auto scrollbar-thin">
                    {impact.affected_files.map((f, i) => (
                      <div
                        key={i}
                        className="text-xs text-studio-text truncate hover:text-studio-accent cursor-pointer"
                        onClick={() => openFile(f)}
                        title={f}
                      >
                        {f}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Component Analysis (React files only) */}
      {isReactFile && componentCtx && (
        <div className="border border-studio-border rounded overflow-hidden">
          <SectionHeader
            label="Component Analysis"
            icon={<span className="text-[10px] text-blue-400 font-mono">R</span>}
            expanded={expandedSections.has('component')}
            onToggle={() => toggleSection('component')}
          />
          {expandedSections.has('component') && (
            <div className="p-2 space-y-2">
              {componentCtx.framework && (
                <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded">
                  {componentCtx.framework}
                </span>
              )}
              {componentCtx.children && componentCtx.children.length > 0 && (
                <div>
                  <span className="text-[10px] text-studio-muted uppercase block mb-1">
                    Child Components ({componentCtx.children.length})
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {componentCtx.children.map((c, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-0.5 bg-studio-border/40 text-studio-text rounded">{c}</span>
                    ))}
                  </div>
                </div>
              )}
              {componentCtx.hooks && componentCtx.hooks.length > 0 && (
                <div>
                  <span className="text-[10px] text-studio-muted uppercase block mb-1">
                    Hooks ({componentCtx.hooks.length})
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {componentCtx.hooks.map((h, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-0.5 bg-purple-500/10 text-purple-400 rounded font-mono">{h}</span>
                    ))}
                  </div>
                </div>
              )}
              {componentCtx.props && componentCtx.props.length > 0 && (
                <div>
                  <span className="text-[10px] text-studio-muted uppercase block mb-1">
                    Props ({componentCtx.props.length})
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {componentCtx.props.map((p, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-0.5 bg-cyan-500/10 text-cyan-400 rounded font-mono">{p}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Dependencies Graph -- Imports */}
      {deps && (
        <>
          <div className="border border-studio-border rounded overflow-hidden">
            <SectionHeader
              label="Imports"
              count={deps.imports?.length || 0}
              icon={<ImportIcon />}
              expanded={expandedSections.has('imports')}
              onToggle={() => toggleSection('imports')}
            />
            {expandedSections.has('imports') && (
              <div className="divide-y divide-studio-border/50">
                {deps.imports && deps.imports.length > 0 ? (
                  deps.imports.map((imp, idx) => (
                    <div
                      key={idx}
                      className="px-3 py-1.5 text-xs hover:bg-studio-border/20 cursor-pointer"
                      onClick={() => {
                        if (imp.startsWith('.') && resolvedRoot) {
                          const dir = activeFile.substring(0, activeFile.lastIndexOf('/'));
                          let resolved = `${dir}/${imp}`;
                          if (!resolved.match(/\.(ts|tsx|js|jsx|mjs)$/)) resolved += '.ts';
                          openFile(resolved);
                        }
                      }}
                    >
                      <span className="text-studio-text">{imp}</span>
                    </div>
                  ))
                ) : (
                  <div className="px-3 py-2 text-xs text-studio-muted">No imports found</div>
                )}
              </div>
            )}
          </div>

          {/* Exports / Dependents */}
          <div className="border border-studio-border rounded overflow-hidden">
            <SectionHeader
              label="Dependents"
              count={deps.exports?.length || 0}
              icon={<ExportIcon />}
              expanded={expandedSections.has('exports')}
              onToggle={() => toggleSection('exports')}
            />
            {expandedSections.has('exports') && (
              <div className="divide-y divide-studio-border/50">
                {deps.exports && deps.exports.length > 0 ? (
                  deps.exports.map((exp, idx) => (
                    <div
                      key={idx}
                      className="px-3 py-1.5 text-xs hover:bg-studio-border/20 cursor-pointer"
                      onClick={() => openFile(exp)}
                    >
                      <span className="text-studio-success">{exp}</span>
                    </div>
                  ))
                ) : (
                  <div className="px-3 py-2 text-xs text-studio-muted">No dependents found</div>
                )}
              </div>
            )}
          </div>

          {/* Symbols grouped by kind */}
          <div className="border border-studio-border rounded overflow-hidden">
            <SectionHeader
              label="Symbols"
              count={deps.symbols?.length || 0}
              icon={<span className="text-xs">Abc</span>}
              expanded={expandedSections.has('symbols')}
              onToggle={() => toggleSection('symbols')}
            />
            {expandedSections.has('symbols') && (
              <div className="max-h-64 overflow-y-auto scrollbar-thin">
                {deps.symbols && deps.symbols.length > 0 ? (
                  (() => {
                    const grouped = deps.symbols.reduce<Record<string, typeof deps.symbols>>((acc, sym) => {
                      const key = sym.kind || 'other';
                      if (!acc[key]) acc[key] = [];
                      acc[key].push(sym);
                      return acc;
                    }, {});
                    const sortedKinds = Object.keys(grouped).sort((a, b) => {
                      const ai = kindOrder.indexOf(a);
                      const bi = kindOrder.indexOf(b);
                      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                    });
                    return sortedKinds.map(kind => (
                      <div key={kind}>
                        <button
                          onClick={() => toggleSection(`sym-${kind}`)}
                          className="w-full flex items-center gap-1.5 px-3 py-1 bg-studio-bg/50 hover:bg-studio-border/20 transition-colors border-b border-studio-border/30"
                        >
                          {expandedSections.has(`sym-${kind}`) ? <ArrowDownIcon /> : <ArrowUpIcon />}
                          <SymbolIcon kind={kind} />
                          <span className="text-xs font-medium text-studio-muted">
                            {kindLabels[kind] || kind.charAt(0).toUpperCase() + kind.slice(1)}
                          </span>
                          <span className="text-[10px] text-studio-muted ml-auto">{grouped[kind].length}</span>
                        </button>
                        {expandedSections.has(`sym-${kind}`) && (
                          <div className="divide-y divide-studio-border/20">
                            {grouped[kind].sort((a, b) => a.line - b.line).map((sym, idx) => (
                              <div
                                key={idx}
                                className="flex items-center gap-2 px-4 py-1 text-xs hover:bg-studio-border/20 cursor-pointer transition-colors"
                                onClick={() => {
                                  if (activeFile) openFile(activeFile);
                                  setPendingScrollLine(sym.line);
                                }}
                              >
                                <span className="text-studio-text truncate" title={sym.name}>{sym.name}</span>
                                <span className="text-studio-muted text-[10px] ml-auto shrink-0">L{sym.line}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ));
                  })()
                ) : (
                  <div className="px-3 py-2 text-xs text-studio-muted">No symbols found</div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
