import { useCallback, useEffect, useRef, useState } from 'react';

interface UsePanelResizeProps {
  leftWidth: number;
  setLeftWidth: (width: number) => void;
  rightWidth: number;
  setRightWidth: (width: number) => void;
  bottomHeight: number;
  setBottomHeight: (height: number) => void;
}

/** Exported for unit tests (panel layout bounds). */
export function clampLeft(v: number): number {
  return Math.max(160, Math.min(Math.min(500, window.innerWidth * 0.3), v));
}

export function clampRight(v: number): number {
  return Math.max(360, Math.min(Math.min(900, window.innerWidth * 0.45), v));
}

export function clampBottom(v: number): number {
  return Math.max(100, Math.min(Math.min(700, window.innerHeight * 0.65), v));
}

function createGhostLine(orientation: 'vertical' | 'horizontal'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `panel-ghost-line panel-ghost-line--${orientation}`;
  document.body.appendChild(el);
  return el;
}

function removeGhostLine(el: HTMLDivElement | null): void {
  if (el?.parentElement) el.remove();
}

export const usePanelResize = ({
  leftWidth,
  setLeftWidth,
  rightWidth,
  setRightWidth,
  bottomHeight,
  setBottomHeight,
}: UsePanelResizeProps) => {
  const [isResizing, setIsResizing] = useState(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Cleanup on unmount: remove any lingering document listeners and ghost lines
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      removeGhostLine(ghostRef.current);
      ghostRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const handleLeftResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;
    const ghost = createGhostLine('vertical');
    ghost.style.left = `${e.clientX}px`;
    ghostRef.current = ghost;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    let finalX = startX;

    const onMouseMove = (moveEvent: MouseEvent) => {
      finalX = moveEvent.clientX;
      ghost.style.left = `${finalX}px`;
    };

    const teardown = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      removeGhostLine(ghost);
      ghostRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      cleanupRef.current = null;
    };

    const onMouseUp = () => {
      teardown();
      setLeftWidth(clampLeft(startWidth + finalX - startX));
      setIsResizing(false);
    };

    cleanupRef.current = () => {
      teardown();
      setIsResizing(false);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [leftWidth, setLeftWidth]);

  const handleRightResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightWidth;
    const ghost = createGhostLine('vertical');
    ghost.style.left = `${e.clientX}px`;
    ghostRef.current = ghost;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    let finalX = startX;

    const onMouseMove = (moveEvent: MouseEvent) => {
      finalX = moveEvent.clientX;
      ghost.style.left = `${finalX}px`;
    };

    const teardown = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      removeGhostLine(ghost);
      ghostRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      cleanupRef.current = null;
    };

    const onMouseUp = () => {
      teardown();
      setRightWidth(clampRight(startWidth - (finalX - startX)));
      setIsResizing(false);
    };

    cleanupRef.current = () => {
      teardown();
      setIsResizing(false);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [rightWidth, setRightWidth]);

  const handleBottomResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = bottomHeight;
    const ghost = createGhostLine('horizontal');
    ghost.style.top = `${e.clientY}px`;
    ghostRef.current = ghost;
    setIsResizing(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    let finalY = startY;

    const onMouseMove = (moveEvent: MouseEvent) => {
      finalY = moveEvent.clientY;
      ghost.style.top = `${finalY}px`;
    };

    const teardown = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      removeGhostLine(ghost);
      ghostRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      cleanupRef.current = null;
    };

    const onMouseUp = () => {
      teardown();
      setBottomHeight(clampBottom(startHeight - (finalY - startY)));
      setIsResizing(false);
    };

    cleanupRef.current = () => {
      teardown();
      setIsResizing(false);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [bottomHeight, setBottomHeight]);

  return {
    handleLeftResize,
    handleRightResize,
    handleBottomResize,
    isResizing,
  };
};
