import { useState, useCallback, useEffect, useRef } from 'react';
import { HppSection } from './sections/HppSection';
import { BlackboardSection } from './sections/BlackboardSection';
import { WorkingMemorySection } from './sections/WorkingMemorySection';
import { ContextMetricsSection } from './sections/ContextMetricsSection';
import { ToolTokenSection } from './sections/ToolTokenSection';
import { ContextTimelineSection } from './sections/ContextTimelineSection';
import { CostIOSection } from './sections/CostIOSection';
import { ContextTreemapSection } from './sections/ContextTreemapSection';
import { CacheCompositionSection } from './sections/CacheCompositionSection';
import { BatchEfficiencySection } from './sections/BatchEfficiencySection';
import { EntryManifestSection } from './sections/EntryManifestSection';
import { SubAgentSection } from './sections/SubAgentSection';
import { SwarmActivitySection } from './sections/SwarmActivitySection';
import { MemoryTelemetrySection } from './sections/MemoryTelemetrySection';
import { ReconcileFreshnessSection } from './sections/ReconcileFreshnessSection';
import { IndexDbSection } from './sections/IndexDbSection';
import { SpinTraceSection } from './sections/SpinTraceSection';

export { INTERNALS_TAB_ID } from '../../constants/atlsInternals';

const LS_ORDER_KEY = 'atls-internals-order';
const LS_COLLAPSED_KEY = 'atls-internals-collapsed';

interface SectionDef {
  id: string;
  title: string;
  subtitle: string;
  component: React.FC;
}

const SECTIONS: SectionDef[] = [
  { id: 'spin', title: 'Spin Trace', subtitle: 'Spin detection, fingerprints, and early warning', component: SpinTraceSection },
  { id: 'hpp', title: 'HPP Protocol', subtitle: 'Hash Pointer materialization state machine', component: HppSection },
  { id: 'bb', title: 'Blackboard', subtitle: 'Persistent session knowledge store', component: BlackboardSection },
  { id: 'wm', title: 'Working Memory', subtitle: 'Ephemeral task-scoped context chunks', component: WorkingMemorySection },
  { id: 'memtel', title: 'Memory Telemetry', subtitle: 'Events, retries, and strategy summaries', component: MemoryTelemetrySection },
  { id: 'reconcile', title: 'Reconcile & Freshness', subtitle: 'Last sweep stats and invalidation counters', component: ReconcileFreshnessSection },
  { id: 'ctx', title: 'Context Metrics', subtitle: 'Budget allocation and cache performance', component: ContextMetricsSection },
  { id: 'timeline', title: 'Context Timeline', subtitle: 'Context grow/shrink over rounds', component: ContextTimelineSection },
  { id: 'costio', title: 'Cost & I/O per Iteration', subtitle: 'Token I/O and cost per round', component: CostIOSection },
  { id: 'treemap', title: 'Context Composition', subtitle: 'Treemap of live context allocation', component: ContextTreemapSection },
  { id: 'cache', title: 'Cache Composition', subtitle: 'Provider cache regions and token layout', component: CacheCompositionSection },
  { id: 'batch', title: 'Batch Efficiency', subtitle: 'Batching ratio and non-batched cost comparison', component: BatchEfficiencySection },
  { id: 'tools', title: 'Tool Token Usage', subtitle: 'Per-tool token consumption breakdown', component: ToolTokenSection },
  { id: 'subagent', title: 'SubAgent Activity', subtitle: 'Retriever invocations, cost, and pin efficiency', component: SubAgentSection },
  { id: 'swarm', title: 'Swarm Activity', subtitle: 'Orchestration tasks, per-agent cost, and round timeline', component: SwarmActivitySection },
  { id: 'entry', title: 'Entry Manifest', subtitle: 'Entry point signatures and token scaling', component: EntryManifestSection },
  { id: 'indexdb', title: 'Index / DB', subtitle: 'SQLite index health for active project', component: IndexDbSection },
];

const SECTION_MAP = new Map(SECTIONS.map((s) => [s.id, s]));
const DEFAULT_ORDER = SECTIONS.map((s) => s.id);

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(LS_ORDER_KEY);
    if (!raw) return DEFAULT_ORDER;
    const parsed: string[] = JSON.parse(raw);
    // Validate: must contain exactly the known IDs (handles added/removed sections)
    const known = new Set(DEFAULT_ORDER);
    const restored = parsed.filter((id) => known.has(id));
    // Append any new sections not in saved order
    for (const id of DEFAULT_ORDER) {
      if (!restored.includes(id)) restored.push(id);
    }
    return restored;
  } catch {
    return DEFAULT_ORDER;
  }
}

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const ChevronDown = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
  </svg>
);

const ChevronRight = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
  </svg>
);

const GripIcon = () => (
  <svg className="w-3.5 h-4 text-studio-muted/50 group-hover:text-studio-muted pointer-events-none" viewBox="0 0 16 20" fill="currentColor">
    <circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="4" r="1.5" />
    <circle cx="5" cy="10" r="1.5" /><circle cx="11" cy="10" r="1.5" />
    <circle cx="5" cy="16" r="1.5" /><circle cx="11" cy="16" r="1.5" />
  </svg>
);

const BrainIcon = () => (
  <svg className="w-5 h-5 text-studio-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
  </svg>
);

export function AtlsInternals() {
  const [order, setOrder] = useState<string[]>(loadOrder);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [refreshKey, setRefreshKey] = useState(0);

  // Drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragCounter = useRef(0);

  // Persist order
  useEffect(() => {
    localStorage.setItem(LS_ORDER_KEY, JSON.stringify(order));
  }, [order]);

  // Persist collapsed
  useEffect(() => {
    localStorage.setItem(LS_COLLAPSED_KEY, JSON.stringify(collapsed));
  }, [collapsed]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const expandAll = useCallback(() => setCollapsed({}), []);
  const collapseAll = useCallback(() => {
    const c: Record<string, boolean> = {};
    SECTIONS.forEach((s) => { c[s.id] = true; });
    setCollapsed(c);
  }, []);

  const resetOrder = useCallback(() => {
    setOrder(DEFAULT_ORDER);
  }, []);

  // --- Drag handlers ---
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-section-id="${id}"]`) as HTMLElement | null;
      if (el) el.style.opacity = '0.4';
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragId) {
      const el = document.querySelector(`[data-section-id="${dragId}"]`) as HTMLElement | null;
      if (el) el.style.opacity = '';
    }
    setDragId(null);
    setDragOverId(null);
    dragCounter.current = 0;
  }, [dragId]);

  const handleDragEnter = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    dragCounter.current++;
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOverId(null);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOverId(null);
    const sourceId = e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === targetId) return;
    setOrder((prev) => {
      const next = [...prev];
      const fromIdx = next.indexOf(sourceId);
      const toIdx = next.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, sourceId);
      return next;
    });
  }, []);

  // Resolve ordered sections
  const orderedSections = order.map((id) => SECTION_MAP.get(id)).filter(Boolean) as SectionDef[];

  return (
    <div className="h-full flex flex-col bg-studio-bg text-studio-text">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-studio-border bg-studio-surface/50">
        <BrainIcon />
        <div className="flex-1">
          <h2 className="text-sm font-semibold">ATLS Internals</h2>
          <p className="text-[10px] text-studio-muted">Live subsystem diagnostics</p>
        </div>
        <div className="flex gap-1">
          <button
            className="text-[10px] text-studio-muted hover:text-studio-text px-2 py-1 rounded hover:bg-studio-border/30"
            onClick={expandAll}
          >
            Expand All
          </button>
          <button
            className="text-[10px] text-studio-muted hover:text-studio-text px-2 py-1 rounded hover:bg-studio-border/30"
            onClick={collapseAll}
          >
            Collapse All
          </button>
          <button
            className="text-[10px] text-studio-muted hover:text-studio-text px-2 py-1 rounded hover:bg-studio-border/30"
            onClick={resetOrder}
            title="Reset panel order to default"
          >
            Reset Order
          </button>
          <button
            className="text-[10px] text-studio-muted hover:text-studio-text px-2 py-1 rounded hover:bg-studio-border/30"
            onClick={() => setRefreshKey((k) => k + 1)}
            title="Refresh all sections"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2" key={refreshKey}>
        {orderedSections.map((section) => {
          const isCollapsed = collapsed[section.id] ?? false;
          const isDragTarget = dragOverId === section.id && dragId !== section.id;
          const Comp = section.component;
          return (
            <div
              key={section.id}
              data-section-id={section.id}
              draggable
              onDragStart={(e) => handleDragStart(e, section.id)}
              onDragEnd={handleDragEnd}
              onDragEnter={(e) => handleDragEnter(e, section.id)}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, section.id)}
              className={[
                'border rounded-lg bg-studio-surface/30 overflow-hidden transition-all group',
                isDragTarget
                  ? 'border-studio-accent/60 ring-1 ring-studio-accent/30 scale-[1.01]'
                  : 'border-studio-border/40',
              ].join(' ')}
            >
              {/* Section header */}
              <div className="w-full flex items-center gap-2 px-3 py-2 hover:bg-studio-border/20 transition-colors">
                <span
                  className="cursor-grab active:cursor-grabbing flex-shrink-0"
                  title="Drag to reorder"
                >
                  <GripIcon />
                </span>
                <button
                  className="flex items-center gap-2 flex-1 min-w-0"
                  draggable={false}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => toggle(section.id)}
                >
                  <span className="text-studio-muted flex-shrink-0">
                    {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                  </span>
                  <span className="text-xs font-medium text-studio-text">{section.title}</span>
                  <span className="text-[10px] text-studio-muted">{section.subtitle}</span>
                </button>
              </div>

              {/* Section content */}
              {!isCollapsed && (
                <div className="px-3 pb-3 border-t border-studio-border/20">
                  <div className="mt-2">
                    <Comp />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
