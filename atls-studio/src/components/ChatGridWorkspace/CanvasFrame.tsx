import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { AgentWindow, CanvasRect } from '../../stores/agentWindowStore';

export interface CanvasFrameProps {
  window: AgentWindow;
  selected: boolean;
  active: boolean;
  zoom: number;
  activeRounds: number;
  totalRounds: number;
  colorClass: string;
  colorText: string;
  kindLabel: string;
  projectLabel?: string;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onBringToFront: () => void;
  onToggleMinimized: () => void;
  onTogglePinned: () => void;
  onClose?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}

const MIN_W = 300;
const MIN_H = 220;

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, a, input, select, textarea, [data-no-drag]'));
}

export function CanvasFrame({
  window,
  selected,
  active,
  zoom,
  activeRounds,
  totalRounds,
  colorClass,
  colorText,
  kindLabel,
  projectLabel,
  onSelect,
  onMove,
  onResize,
  onBringToFront,
  onToggleMinimized,
  onTogglePinned,
  onClose,
  actions,
  children,
  testId,
}: CanvasFrameProps) {
  const [localRect, setLocalRect] = useState<CanvasRect>(window.rect);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  useEffect(() => {
    if (!dragRef.current && !resizeRef.current) setLocalRect(window.rect);
  }, [window.rect]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) return;
    event.stopPropagation();
    onBringToFront();
    onSelect();
    dragRef.current = { startX: event.clientX, startY: event.clientY, origX: localRect.x, origY: localRect.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onBringToFront();
    resizeRef.current = { startX: event.clientX, startY: event.clientY, origW: localRect.w, origH: localRect.h };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const dx = (event.clientX - drag.startX) / zoom;
      const dy = (event.clientY - drag.startY) / zoom;
      setLocalRect((rect) => ({ ...rect, x: drag.origX + dx, y: drag.origY + dy }));
      return;
    }
    const resize = resizeRef.current;
    if (resize) {
      const dw = (event.clientX - resize.startX) / zoom;
      const dh = (event.clientY - resize.startY) / zoom;
      setLocalRect((rect) => ({
        ...rect,
        w: Math.max(MIN_W, resize.origW + dw),
        h: Math.max(MIN_H, resize.origH + dh),
      }));
    }
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      dragRef.current = null;
      onMove(localRect.x, localRect.y);
    }
    if (resizeRef.current) {
      resizeRef.current = null;
      onResize(localRect.w, localRect.h);
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const minimized = window.minimized;
  const height = minimized ? 44 : localRect.h;

  return (
    <section
      className={`absolute flex flex-col overflow-hidden rounded-xl border bg-studio-surface/80 shadow-2xl backdrop-blur-sm transition-shadow ${colorClass} ${
        selected ? 'ring-1 ring-studio-title/50' : 'hover:border-studio-title/35'
      }`}
      style={{
        left: localRect.x,
        top: localRect.y,
        width: localRect.w,
        height,
        zIndex: window.zIndex,
      }}
      data-testid={testId}
      onPointerDown={() => { onBringToFront(); onSelect(); }}
    >
      <div
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-studio-border/70 bg-gradient-to-r from-studio-bg/90 via-studio-surface/55 to-studio-bg/65 px-3 py-2 active:cursor-grabbing"
        onPointerDown={beginDrag}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        data-testid={testId ? `${testId}-header` : undefined}
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${active ? 'bg-emerald-400' : selected ? 'bg-studio-title' : 'bg-studio-border'}`} />
        <div className="min-w-0 flex-1">
          <div className={`truncate text-xs font-semibold ${colorText}`}>{window.title}</div>
          <div className="flex items-center gap-2 truncate font-mono text-[9px] uppercase tracking-[0.16em] text-studio-muted">
            <span className="truncate">{kindLabel}</span>
            {projectLabel && (
              <span className="shrink-0 rounded border border-studio-border/60 bg-studio-bg/60 px-1 py-0.5 normal-case tracking-normal text-studio-title" title={window.projectPath}>
                {projectLabel}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" data-no-drag>
          <span className="rounded-full border border-studio-border/60 bg-studio-bg/60 px-2 py-0.5 font-mono text-[9px] uppercase text-studio-muted">
            {window.status}
          </span>
          <span className="rounded-full border border-studio-title/20 bg-studio-title/10 px-2 py-0.5 font-mono text-[9px] text-studio-title" title="Active rounds / total rounds">
            {activeRounds}/{totalRounds}
          </span>
          {actions}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onTogglePinned(); }}
            className={`rounded px-1 py-0.5 text-[9px] uppercase ${window.pinned ? 'text-studio-title' : 'text-studio-muted hover:text-studio-text'}`}
            title={window.pinned ? 'Unpin from auto-arrange' : 'Pin position'}
          >
            {window.pinned ? 'Pinned' : 'Pin'}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleMinimized(); }}
            className="rounded px-1 py-0.5 text-[9px] uppercase text-studio-muted hover:text-studio-text"
            title={minimized ? 'Expand' : 'Minimize'}
          >
            {minimized ? '+' : '–'}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="rounded px-1 py-0.5 text-[9px] uppercase text-red-300 hover:bg-red-500/10"
              title="Close window"
              aria-label={`Close ${window.title}`}
              data-testid={`close-${window.windowId}`}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {!minimized && <div className="min-h-0 flex-1 overflow-hidden">{children}</div>}

      {!minimized && (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          onPointerDown={beginResize}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          data-no-drag
          title="Resize"
        >
          <svg viewBox="0 0 16 16" className="h-full w-full text-studio-muted/60">
            <path d="M11 15L15 11M6 15L15 6" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
        </div>
      )}
    </section>
  );
}

export default CanvasFrame;
