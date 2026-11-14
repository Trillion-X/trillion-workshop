// bitfield-societies/bitfield-studio/packages/ui/show/collapsible-panel/CollapsiblePanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic collapsible panel primitive with resize handle and smooth transitions.
// Durable persistence is owned by callers; this primitive only owns local drag
// interaction mechanics.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Smooth width transition for collapse/expand; active drag is immediate
// 2. Resize drag handle: invisible hit area + visible rail on hover
// 3. Durable collapse/width state is caller-owned, never stored here
// 4. Transparent background — inherits glass from parent container, border-[var(--border-primary)]
// 5. Render prop for header: receives { collapsed, toggleCollapse }
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { motion } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx';

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_MIN = 200;
const DEFAULT_MAX = 400;
const DEFAULT_COLLAPSED = 36;

// ============================================================================
// RESIZE HANDLE
// ============================================================================

function ResizeHandle({
  edge,
  dragging,
  onPointerDown,
}: {
  edge: 'left' | 'right';
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const [isHovered, setIsHovered] = React.useState(false);
  const isLeft = edge === 'left';
  const isActive = isHovered || dragging;

  return (
    <div
      className={[
        'absolute top-0 bottom-0 z-10 flex-shrink-0 w-4 cursor-col-resize',
        isLeft ? 'left-0' : 'right-0',
      ].join(' ')}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onPointerDown={onPointerDown}
    >
      {/* Invisible hit area */}
      <div
        className={[
          'absolute h-full',
          isLeft ? 'w-6 -left-3' : 'w-6 -right-3',
        ].join(' ')}
      />
      {/* Visible rail */}
      <motion.div
        className={[
          'absolute top-2 bottom-2 w-0.5 rounded-full bg-[var(--glass-bg-active)]',
          isLeft ? 'left-0 -translate-x-[85%]' : 'right-0 translate-x-[85%]',
        ].join(' ')}
        initial={false}
        animate={{ opacity: isActive ? 0.85 : 0, scale: isActive ? 1 : 0.55 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
      />
    </div>
  );
}

// ============================================================================
// TYPES
// ============================================================================

export interface CollapsiblePanelContext {
  collapsed: boolean;
  toggleCollapse: () => void;
}

export interface CollapsiblePanelProps {
  /** Current persisted collapse state */
  collapsed: boolean;
  /** Current persisted expanded width in px */
  width: number;
  /** Called when the panel should toggle collapsed state */
  onCollapsedChange: (collapsed: boolean) => void;
  /** Called when a resize interaction finishes with the next width */
  onWidthChange: (width: number) => void;
  /** Min resize width */
  minWidth?: number;
  /** Max resize width */
  maxWidth?: number;
  /** Collapsed width — just enough for an expand button */
  collapsedWidth?: number;
  /** Which side the resize handle is on */
  resizeEdge?: 'left' | 'right';
  /** Header render prop — receives collapse state */
  renderHeader: (ctx: CollapsiblePanelContext) => React.ReactNode;
  /** Content — rendered in scrollable body */
  children: React.ReactNode;
  /** Optional className for outer container */
  className?: string;
  /** Optional ref forwarded to the scrollable content div — use for virtualizer getScrollElement */
  contentRef?: React.Ref<HTMLDivElement>;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function CollapsiblePanel({
  collapsed,
  width,
  onCollapsedChange,
  onWidthChange,
  minWidth = DEFAULT_MIN,
  maxWidth = DEFAULT_MAX,
  collapsedWidth = DEFAULT_COLLAPSED,
  resizeEdge = 'right',
  renderHeader,
  children,
  className,
  contentRef,
}: CollapsiblePanelProps) {
  const [dragging, setDragging] = React.useState(false);
  const [dragWidth, setDragWidth] = React.useState<number | null>(null);
  const dragWidthRef = React.useRef<number | null>(null);
  const startDragX = React.useRef<number | null>(null);
  const startW = React.useRef<number>(width);
  const startedCollapsed = React.useRef(false);

  // --- Toggle ---
  const toggleCollapse = React.useCallback(() => {
    onCollapsedChange(!collapsed);
  }, [collapsed, onCollapsedChange]);

  // --- Resize drag ---
  React.useEffect(() => {
    if (!dragging) return;

    const isLeft = resizeEdge === 'left';

    const onMove = (e: PointerEvent) => {
      if (startDragX.current == null) return;
      const dx = e.clientX - startDragX.current;
      const delta = isLeft ? -dx : dx;
      const nextWidth = Math.min(maxWidth, Math.max(minWidth, startW.current + delta));
      dragWidthRef.current = nextWidth;
      setDragWidth(nextWidth);
    };

    const onUp = () => {
      const nextWidth = dragWidthRef.current ?? width;
      setDragging(false);
      setDragWidth(null);
      dragWidthRef.current = null;
      startDragX.current = null;
      if (startedCollapsed.current) {
        onCollapsedChange(false);
      }
      if (nextWidth !== width) {
        onWidthChange(nextWidth);
      }
      startedCollapsed.current = false;
      document.body.style.cursor = 'auto';
      document.body.style.userSelect = 'auto';
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, width, resizeEdge, minWidth, maxWidth, onCollapsedChange, onWidthChange]);

  const effectiveCollapsed = !dragging && collapsed;
  const currentWidth = effectiveCollapsed ? collapsedWidth : (dragWidth ?? width);

  const handleResizeStart = (e: React.PointerEvent) => {
    startedCollapsed.current = collapsed;
    setDragging(true);
    setDragWidth(width);
    dragWidthRef.current = width;
    startDragX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const borderSide = resizeEdge === 'right' ? 'border-r' : 'border-l';

  return (
    <div
      className={[
        'relative h-full flex flex-col overflow-hidden text-[var(--text-primary)]',
        dragging ? 'transition-none' : 'transition-[width] duration-200 ease-out',
        `${borderSide} border-[var(--border-primary)]`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ width: currentWidth }}
    >
      {/* Header */}
      <div className="flex-shrink-0 border-b border-[var(--border-primary)]">
        {renderHeader({ collapsed: effectiveCollapsed, toggleCollapse })}
      </div>

      {/* Scrollable content */}
      {!effectiveCollapsed && (
        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      )}

      {/* Resize handle */}
      <ResizeHandle edge={resizeEdge} dragging={dragging} onPointerDown={handleResizeStart} />
    </div>
  );
}
