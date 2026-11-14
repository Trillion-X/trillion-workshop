// packages/ui/show/split-dividers/SplitDividers.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The blind split-column divider chrome: a thin draggable bar at each boundary
// between adjacent columns of a split layout node. Pure pointer math — it knows
// NOTHING about fractions, parts, the engine, or how the consumer turns a drag
// into a transaction. It is given each divider's pre-computed frame-relative
// rect (from `splitDividerScreenRects`) and emits, every pointer move, the
// CUMULATIVE pixel delta from drag start for that divider; the consumer applies
// that delta to the parts captured at drag start (exactly like SceneResizeHandles
// applies its delta to the start rect — never to a live, mid-drag value, so
// async snapshot updates can't double-count).
//
// Reference anatomy (Mobbin MCP 2026-06-20): Dovetail "Three columns" multi-
// column block; Craft column resize ("Reset Column Size"). The divider is a
// hover-revealed hairline that strengthens on hover/active — Fey/Notion density,
// no persistent per-block label. See CS-065 reference contract.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / blind: no fraction/part knowledge, no Society vocabulary. It takes
//    rects in and emits (leftIndex, rightIndex, cumulativeDeltaPx) out.
// 2. The container is pointer-transparent; only the divider bars capture the
//    pointer, so column content stays interactive between dividers.
// 3. Coordinates are stage pixels at zoom = 1, so a client-pixel drag delta maps
//    1:1 onto the engine's main-axis space.
// 4. Cumulative delta from start (not incremental), so the consumer's
//    `applySplitDividerDrag(startParts, ..., deltaPx)` is drift-free.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import * as React from 'react';

import { cn } from '../cn';

/** One divider's frame-relative rect (from `splitDividerScreenRects`). */
export type SplitDividerView = {
  leftIndex: number;
  rightIndex: number;
  left: number | string;
  top: number | string;
  width: number | string;
  height: number | string;
};

export type SplitDividersProps = {
  /** The dividers to draw (frame-relative px, zoom = 1). */
  dividers: ReadonlyArray<SplitDividerView>;
  /** Main axis of the split: 'x' = vertical dividers (drag horizontally). */
  axis: 'x' | 'y';
  /** Force visible (e.g. split node selected). Otherwise they hover-reveal. */
  revealed?: boolean;
  /** Drag begins — the consumer snapshots the parts + available size NOW. */
  onResizeStart?: (leftIndex: number, rightIndex: number) => void;
  /** Every move — CUMULATIVE pixel delta from drag start (apply to start parts). */
  onResize: (leftIndex: number, rightIndex: number, deltaPx: number) => void;
  onResizeEnd?: () => void;
  label?: string;
  onResizeStep?: (direction: 'decrease' | 'increase' | 'minimum' | 'maximum' | 'reset') => void;
  value?: { now: number; min: number; max: number };
};

function dividerKey(view: { leftIndex: number; rightIndex: number }): string {
  return `${view.leftIndex}-${view.rightIndex}`;
}

export function SplitDividers({ dividers, axis, revealed, onResizeStart, onResize, onResizeEnd, label, onResizeStep, value }: SplitDividersProps) {
  const [active, setActive] = React.useState<string | null>(null);
  const cleanup = React.useRef<() => void>(() => {});
  React.useEffect(() => () => cleanup.current(), []);

  function startDrag(view: SplitDividerView, event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    cleanup.current();
    const startX = event.clientX;
    const startY = event.clientY;
    const key = dividerKey(view);
    setActive(key);
    onResizeStart?.(view.leftIndex, view.rightIndex);

    function move(moveEvent: PointerEvent) {
      // CUMULATIVE delta from start (zoom = 1 -> client px maps 1:1).
      const deltaPx = axis === 'x' ? moveEvent.clientX - startX : moveEvent.clientY - startY;
      onResize(view.leftIndex, view.rightIndex, deltaPx);
    }
    function up() {
      cleanup.current();
      setActive(null);
      onResizeEnd?.();
    }
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
  }

  return (
    <div
      data-split-dividers
      aria-hidden={onResizeStep ? undefined : true}
      className={cn(
        'absolute inset-0 z-10 transition-opacity duration-150',
        // Pointer-transparent container — column content stays interactive; only
        // the divider bars below opt back in.
        'pointer-events-none',
        revealed ? 'opacity-100' : 'opacity-0 group-hover/hover-reveal:opacity-100 group-focus-within/hover-reveal:opacity-100',
      )}
    >
      {dividers.map((view) => {
        const key = dividerKey(view);
        return (
          <div
            key={key}
            data-split-divider={key}
            role={onResizeStep ? 'separator' : undefined}
            aria-label={label}
            aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
            aria-valuenow={value?.now}
            aria-valuemin={value?.min}
            aria-valuemax={value?.max}
            tabIndex={onResizeStep ? 0 : undefined}
            onDoubleClick={() => onResizeStep?.('reset')}
            onKeyDown={event => {
              const direction = event.key === (axis === 'x' ? 'ArrowLeft' : 'ArrowUp') ? 'decrease' : event.key === (axis === 'x' ? 'ArrowRight' : 'ArrowDown') ? 'increase' : event.key === 'Home' ? 'minimum' : event.key === 'End' ? 'maximum' : event.key === 'Enter' ? 'reset' : null;
              if (direction && onResizeStep) { event.preventDefault(); onResizeStep(direction); }
            }}
            onPointerDown={(event) => startDrag(view, event)}
            style={{
              left: view.left,
              top: view.top,
              width: view.width,
              height: view.height,
              cursor: axis === 'x' ? 'ew-resize' : 'ns-resize',
            }}
            className="group/divider pointer-events-auto absolute flex items-center justify-center"
          >
            {/* The visible hairline: a thin bar centered in the (wider) hit area.
                Quiet by default, strengthens on hover, accent while dragging. */}
            <div
              className={cn(
                axis === 'x' ? 'h-full w-px' : 'h-px w-full',
                'rounded-full transition-colors duration-100',
                active === key
                  ? 'bg-[var(--border-focus,var(--accent-primary,var(--text-primary)))]'
                  : 'bg-[var(--border-primary)] group-hover/divider:bg-[var(--border-focus,var(--text-primary))]',
              )}
            />
          </div>
        );
      })}
    </div>
  );
}
