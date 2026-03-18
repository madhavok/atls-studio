import { useAppStore } from '../../stores/appStore';

export function OverviewTab() {
  const { projectPath, activeRoot, projectProfile, openFile } = useAppStore();
  const hasProject = !!(activeRoot ?? projectPath);

  if (!hasProject) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-studio-muted">Open a project to view its profile</p>
      </div>
    );
  }

  if (!projectProfile) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-studio-muted">Scan project to generate profile</p>
      </div>
    );
  }

  const { stats, health, stack, arch, deps, patterns } = projectProfile;
  const catEntries = health?.cats ? Object.entries(health.cats).sort(([, a], [, b]) => b - a) : [];
  const maxCatCount = catEntries.length > 0 ? catEntries[0][1] : 1;

  return (
    <div className="p-3 space-y-3 overflow-y-auto scrollbar-thin flex-1">
      {/* Project name */}
      <div className="text-sm font-medium text-studio-title truncate" title={projectProfile.proj}>
        {projectProfile.proj}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block">Files</span>
          <span className="text-lg font-semibold text-studio-text">{stats.files.toLocaleString()}</span>
        </div>
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block">Lines</span>
          <span className="text-lg font-semibold text-studio-text">{stats.loc.toLocaleString()}</span>
        </div>
      </div>

      {/* Language breakdown */}
      {Object.keys(stats.langs).length > 0 && (
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block mb-1">Languages</span>
          <div className="space-y-1">
            {Object.entries(stats.langs)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 8)
              .map(([lang, lines]) => {
                const pct = Math.round((lines / Math.max(stats.loc, 1)) * 100);
                return (
                  <div key={lang} className="flex items-center gap-2 text-xs">
                    <span className="w-20 truncate text-studio-text">{lang}</span>
                    <div className="flex-1 h-1.5 bg-studio-border rounded-full overflow-hidden">
                      <div className="h-full bg-studio-accent rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-studio-muted text-[10px] w-8 text-right">{pct}%</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Issue summary */}
      <div className="bg-studio-surface rounded p-2 border border-studio-border">
        <span className="text-[10px] text-studio-muted uppercase tracking-wide block mb-1">Issues</span>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-studio-error font-medium">H: {health.issues.h}</span>
          <span className="text-studio-warning font-medium">M: {health.issues.m}</span>
          <span className="text-studio-muted font-medium">L: {health.issues.l}</span>
        </div>
      </div>

      {/* Issue Categories breakdown */}
      {catEntries.length > 0 && (
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block mb-1">Issue Categories</span>
          <div className="space-y-1">
            {catEntries.map(([cat, count]) => {
              const pct = Math.round((count / Math.max(maxCatCount, 1)) * 100);
              return (
                <div key={cat} className="flex items-center gap-2 text-xs">
                  <span className="w-28 truncate text-studio-text capitalize">{cat.replace(/_/g, ' ')}</span>
                  <div className="flex-1 h-1.5 bg-studio-border rounded-full overflow-hidden">
                    <div className="h-full bg-studio-warning rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-studio-muted text-[10px] w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stack */}
      {stack.length > 0 && (
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block mb-1">Stack</span>
          <div className="flex flex-wrap gap-1">
            {stack.map((s) => (
              <span key={s} className="text-[10px] px-1.5 py-0.5 bg-studio-accent/10 text-studio-accent rounded">{s}</span>
            ))}
          </div>
        </div>
      )}

      {/* Architecture */}
      {arch && (arch.entry?.length > 0 || arch.mods?.length > 0) && (
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block mb-1">Architecture</span>
          {arch.entry && arch.entry.length > 0 && (
            <div className="mb-1.5">
              <span className="text-[10px] text-studio-muted block mb-0.5">Entry Points</span>
              <div className="space-y-0.5">
                {arch.entry.map((e) => (
                  <div
                    key={e}
                    className="text-xs text-studio-text truncate hover:text-studio-accent cursor-pointer"
                    title={e}
                    onClick={() => openFile(e)}
                  >
                    {e}
                  </div>
                ))}
              </div>
            </div>
          )}
          {arch.mods && arch.mods.length > 0 && (
            <div>
              <span className="text-[10px] text-studio-muted block mb-0.5">Modules</span>
              <div className="flex flex-wrap gap-1">
                {arch.mods.map((m) => (
                  <span key={m} className="text-[10px] px-1.5 py-0.5 bg-studio-border/50 text-studio-text rounded">{m}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dependencies (prod/dev) */}
      {deps && (deps.prod?.length > 0 || deps.dev?.length > 0) && (
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block mb-1">Dependencies</span>
          {deps.prod && deps.prod.length > 0 && (
            <div className="mb-1.5">
              <span className="text-[10px] text-studio-muted block mb-0.5">Production ({deps.prod.length})</span>
              <div className="flex flex-wrap gap-1">
                {deps.prod.map((d) => (
                  <span key={d} className="text-[10px] px-1.5 py-0.5 bg-studio-accent/10 text-studio-accent rounded">{d}</span>
                ))}
              </div>
            </div>
          )}
          {deps.dev && deps.dev.length > 0 && (
            <div>
              <span className="text-[10px] text-studio-muted block mb-0.5">Dev ({deps.dev.length})</span>
              <div className="flex flex-wrap gap-1">
                {deps.dev.map((d) => (
                  <span key={d} className="text-[10px] px-1.5 py-0.5 bg-studio-border/50 text-studio-muted rounded">{d}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Codebase Patterns */}
      {patterns && patterns.length > 0 && (
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block mb-1">Codebase Patterns</span>
          <div className="flex flex-wrap gap-1">
            {patterns.map((p) => (
              <span key={p} className="text-[10px] px-1.5 py-0.5 bg-purple-500/10 text-purple-400 rounded">{p}</span>
            ))}
          </div>
        </div>
      )}

      {/* Hotspots */}
      {health.hotspots.length > 0 && (
        <div className="bg-studio-surface rounded p-2 border border-studio-border">
          <span className="text-[10px] text-studio-muted uppercase tracking-wide block mb-1">Hotspots</span>
          <div className="space-y-0.5">
            {health.hotspots.slice(0, 5).map((h) => (
              <div
                key={h}
                className="text-xs text-studio-text truncate hover:text-studio-accent cursor-pointer"
                title={h}
                onClick={() => openFile(h)}
              >
                {h}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
