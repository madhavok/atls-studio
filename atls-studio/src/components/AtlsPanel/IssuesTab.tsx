import { useState, useEffect, useMemo } from 'react';
import { useAppStore, Issue } from '../../stores/appStore';
import { AlertIcon, CheckIcon } from './icons';

const PAGE_SIZE = 50;

/** Severity ordering for consistent display */
const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const SEV_COLORS: Record<string, string> = {
  high: 'bg-studio-error/20 text-studio-error border-studio-error/30',
  medium: 'bg-studio-warning/20 text-studio-warning border-studio-warning/30',
  low: 'bg-studio-border/40 text-studio-muted border-studio-border',
};

export function IssuesTab() {
  const {
    projectPath,
    activeRoot,
    issues,
    issueCounts,
    scanStatus,
    openFile,
    setSelectedFile,
    setPendingScrollLine,
    projectProfile,
  } = useAppStore();

  const resolveRoot = activeRoot ?? projectPath;

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);

  const hasProject = !!resolveRoot;

  // Build unified category list: prefer profile counts (authoritative), fall back to loaded issues
  const categoryEntries = useMemo(() => {
    const profileCats = projectProfile?.health?.cats;
    if (profileCats && Object.keys(profileCats).length > 0) {
      return Object.entries(profileCats).sort(([, a], [, b]) => b - a);
    }
    // Fall back to counting from loaded issues
    const countMap: Record<string, number> = {};
    for (const issue of issues) {
      countMap[issue.category] = (countMap[issue.category] || 0) + 1;
    }
    return Object.entries(countMap).sort(([, a], [, b]) => b - a);
  }, [projectProfile, issues]);

  // Client-side filtering
  const filteredIssues = useMemo(() => {
    let result = issues;
    if (categoryFilter) {
      result = result.filter((i) => i.category === categoryFilter);
    }
    if (severityFilter) {
      result = result.filter((i) => i.severity === severityFilter);
    }
    return result;
  }, [issues, categoryFilter, severityFilter]);

  const totalPages = Math.ceil(filteredIssues.length / PAGE_SIZE);
  const paginatedIssues = filteredIssues.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(0);
  }, [categoryFilter, severityFilter]);

  const handleIssueClick = (issue: Issue) => {
    let filePath = issue.file;

    // Make relative paths absolute using the active root
    if (resolveRoot && !filePath.match(/^[A-Za-z]:[/\\]/) && !filePath.startsWith('/')) {
      filePath = `${resolveRoot}/${filePath}`;
    }
    filePath = filePath.replace(/\\/g, '/').replace(/([^:])\/\//g, '$1/');

    setSelectedFile(filePath);
    openFile(filePath);
    setPendingScrollLine(issue.line);
  };

  return (
    <>
      {/* Severity filter row */}
      <div className="px-2 py-1.5 border-b border-studio-border flex items-center gap-1.5">
        {(['high', 'medium', 'low'] as const).map((sev) => {
          const count = sev === 'high' ? issueCounts.high
            : sev === 'medium' ? issueCounts.medium
            : issueCounts.low;
          const isActive = severityFilter === sev;
          return (
            <button
              key={sev}
              onClick={() => setSeverityFilter(isActive ? null : sev)}
              className={`
                flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border transition-colors shrink-0
                ${isActive ? SEV_COLORS[sev] + ' ring-1 ring-current' : SEV_COLORS[sev] + ' opacity-70 hover:opacity-100'}
              `}
              title={`${sev}: ${count} issues`}
            >
              <AlertIcon severity={sev} />
              <span className="uppercase font-semibold">{sev[0]}</span>
              <span className="font-mono">{count.toLocaleString()}</span>
            </button>
          );
        })}
        <span className="ml-auto text-[10px] text-studio-muted font-mono">
          {issueCounts.total.toLocaleString()} total
        </span>
      </div>

      {/* Category filter bar (unified: profile counts + loaded issues) */}
      {categoryEntries.length > 0 && (
        <div className="px-2 py-1.5 border-b border-studio-border flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
          <button
            onClick={() => setCategoryFilter(null)}
            className={`
              flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors shrink-0
              ${!categoryFilter
                ? 'bg-studio-accent text-studio-bg'
                : 'bg-studio-border/40 text-studio-muted hover:text-studio-text'
              }
            `}
          >
            All
          </button>
          {categoryEntries.map(([cat, count]) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
              className={`
                flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors shrink-0
                ${categoryFilter === cat
                  ? 'bg-studio-accent text-studio-bg'
                  : 'bg-studio-border/40 text-studio-muted hover:text-studio-text'
                }
              `}
              title={`${cat.replace(/_/g, ' ')}: ${count} issues`}
            >
              <span className="capitalize">{cat.replace(/_/g, ' ')}</span>
              <span className="font-mono opacity-70">{count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}

      {/* Issue list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="divide-y divide-studio-border/50">
          {!hasProject && (
            <div className="p-4 text-center text-studio-muted">
              <svg className="w-12 h-12 mx-auto mb-2 opacity-30" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" />
              </svg>
              <p className="text-sm">Open a project</p>
              <p className="text-xs mt-1">ATLS will scan for issues automatically</p>
            </div>
          )}

          {hasProject && scanStatus.isScanning && filteredIssues.length === 0 && (
            <div className="p-4 text-center text-studio-muted">
              <div className="w-8 h-8 mx-auto mb-2 border-2 border-studio-accent border-t-transparent rounded-full animate-spin" />
              <p className="text-sm">{scanStatus.phase || 'Scanning project'}...</p>
              <p className="text-xs mt-1">{scanStatus.filesProcessed} / {scanStatus.filesTotal} files</p>
              {scanStatus.currentFile && (
                <p className="text-xs mt-0.5 truncate max-w-[250px] mx-auto" title={scanStatus.currentFile}>
                  {scanStatus.currentFile.split(/[/\\]/).pop()}
                </p>
              )}
            </div>
          )}

          {paginatedIssues.map((issue) => (
            <div
              key={issue.id}
              className="p-2 hover:bg-studio-border/30 cursor-pointer transition-colors"
              onClick={() => handleIssueClick(issue)}
            >
              <div className="flex items-start gap-2">
                <AlertIcon severity={issue.severity} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{issue.message}</span>
                  </div>
                  <div className="text-xs text-studio-muted mt-0.5 flex items-center gap-2">
                    <span className="truncate">{issue.file}</span>
                    <span>:</span>
                    <span>line {issue.line}</span>
                    <span>·</span>
                    <span className="capitalize">{issue.category.replace(/_/g, ' ')}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* Pagination controls */}
          {filteredIssues.length > PAGE_SIZE && (
            <div className="sticky bottom-0 p-2 bg-studio-bg border-t border-studio-border flex items-center justify-between">
              <span className="text-xs text-studio-muted">
                {currentPage * PAGE_SIZE + 1}-{Math.min((currentPage + 1) * PAGE_SIZE, filteredIssues.length)} of {filteredIssues.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setCurrentPage(0)} disabled={currentPage === 0} className="px-2 py-1 text-xs text-studio-muted hover:text-studio-text disabled:opacity-30 disabled:cursor-not-allowed" title="First page">
                  ««
                </button>
                <button onClick={() => setCurrentPage(p => Math.max(0, p - 1))} disabled={currentPage === 0} className="px-2 py-1 text-xs text-studio-muted hover:text-studio-text disabled:opacity-30 disabled:cursor-not-allowed">
                  «
                </button>
                <span className="px-2 text-xs text-studio-text">{currentPage + 1} / {totalPages}</span>
                <button onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))} disabled={currentPage >= totalPages - 1} className="px-2 py-1 text-xs text-studio-muted hover:text-studio-text disabled:opacity-30 disabled:cursor-not-allowed">
                  »
                </button>
                <button onClick={() => setCurrentPage(totalPages - 1)} disabled={currentPage >= totalPages - 1} className="px-2 py-1 text-xs text-studio-muted hover:text-studio-text disabled:opacity-30 disabled:cursor-not-allowed" title="Last page">
                  »»
                </button>
              </div>
            </div>
          )}

          {hasProject && !scanStatus.isScanning && filteredIssues.length === 0 && (
            <div className="p-8 text-center text-studio-muted">
              <CheckIcon />
              <p className="mt-2 text-sm">
                {categoryFilter || severityFilter ? 'No issues match the current filters' : 'No issues found'}
              </p>
              {(categoryFilter || severityFilter) ? (
                <button
                  onClick={() => { setCategoryFilter(null); setSeverityFilter(null); }}
                  className="mt-2 text-xs text-studio-accent hover:underline"
                >
                  Clear filters
                </button>
              ) : (
                <p className="text-xs mt-1">Your code looks clean!</p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
