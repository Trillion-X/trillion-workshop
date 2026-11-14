// packages/ui/show/scene-resize-handles/SceneResizeHandles.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The blind selected-node resize chrome: eight handles on a node's engine
// bounding box (four corners + four edge midpoints) plus a live `W × H` badge
// during a drag. Pure pointer math — it knows NOTHING about what the node
// contains, which slot it mounts, or how the consumer turns a new rect into an
// engine transaction. It emits a candidate rect; the consumer owns the commit.
//
// Reference anatomy (Mobbin MCP 2026-06-20): Jitter / Figma / Framer selected-
// object handles + live dimension readout. See CS-065 reference contract.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / blind: no node-type knowledge, no Society vocabulary. It takes a
//    rect in and emits a rect out.
// 2. Lives on a CHROME plane that is NEVER clipped by the frame (the frame drops
//    its own `overflow-hidden` for mounted surfaces — convergence F3/F4), so a
//    handle centered on an edge renders half-outside the box like every real
//    design tool.
// 3. The container is pointer-transparent (`pointer-events-none`); only the
//    handle dots capture the pointer, so the mounted live surface underneath
//    stays fully interactive between the handles.
// 4. The rect is in engine WORLD pixels. A client-pixel drag delta maps 1:1 onto
//    the rect when unzoomed; under canvas zoom the delta is divided by `zoom` (the
//    plane is scaled by scale(zoom)) so the edge stays pinned under the cursor.
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

export type SceneResizeRect = { x: number; y: number; w: number; h: number };

export type SceneResizeHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// Normalized anchor of each handle on the box (0..1) + the resize cursor.
const HANDLES: ReadonlyArray<{ id: SceneResizeHandleId; cx: number; cy: number; cursor: string }> = [
  { id: 'nw', cx: 0, cy: 0, cursor: 'nwse-resize' },
  { id: 'n', cx: 0.5, cy: 0, cursor: 'ns-resize' },
  { id: 'ne', cx: 1, cy: 0, cursor: 'nesw-resize' },
  { id: 'e', cx: 1, cy: 0.5, cursor: 'ew-resize' },
  { id: 'se', cx: 1, cy: 1, cursor: 'nwse-resize' },
  { id: 's', cx: 0.5, cy: 1, cursor: 'ns-resize' },
  { id: 'sw', cx: 0, cy: 1, cursor: 'nesw-resize' },
  { id: 'w', cx: 0, cy: 0.5, cursor: 'ew-resize' },
];

export type SceneResizeHandlesProps = {
  /** Current engine rect (stage pixels, zoom = 1). */
  rect: SceneResizeRect;
  /** Minimum interactive width/height floor so a node can't collapse to nothing. */
  minW?: number;
  minH?: number;
  /** Force handles visible (e.g. node selected). Otherwise they hover-reveal. */
  revealed?: boolean;
  /**
   * Current camera zoom (default 1). The handles live inside a content plane that
   * the canvas scales by `scale(zoom)`, so a SCREEN-pixel drag delta is 1/zoom
   * world (engine) pixels. Dividing the delta by zoom keeps the resized edge pinned
   * under the cursor (B-45). Flow / unzoomed surfaces pass nothing → 1 → no-op.
   */
  zoom?: number;
  onResizeStart?: () => void;
  /**
   * Live, every pointer move during a drag — the consumer commits the rect.
   * `handle` is the active grip so the consumer can ask `handleMovesOrigin(handle)`
   * whether this drag moves the node's top-left. Origin intent is read from the
   * handle, NEVER inferred by diffing async engine-snapshot coordinates (rounding
   * + reply latency can drop a real move — convergence 2026-06-20 Q1).
   */
  onResize: (rect: SceneResizeRect, handle: SceneResizeHandleId) => void;
  onResizeEnd?: (rect: SceneResizeRect) => void;
};

// A handle moves the node's ORIGIN (top-left) iff it drags the west edge (writes
// x) or the north edge (writes y) — exactly the edges `applySceneResize` moves
// x/y for. This is the SINGLE source of origin-intent: a consumer turns a resize
// into a `layout_patch` based on THIS predicate (gated on whether the node's
// parent positions children absolutely), not on comparing the new rect against
// the latest engine snapshot, which async replies + rounding can defeat.
export function handleMovesOrigin(id: SceneResizeHandleId): boolean {
  const west = id === 'nw' || id === 'w' || id === 'sw';
  const north = id === 'nw' || id === 'n' || id === 'ne';
  return west || north;
}

// Apply a handle drag delta to the start rect. East/south edges grow w/h;
// west/north edges move the origin and shrink, keeping the opposite edge fixed.
// Clamping to the min floor also keeps the anchored edge fixed.
export function applySceneResize(
  id: SceneResizeHandleId,
  start: SceneResizeRect,
  dx: number,
  dy: number,
  minW: number,
  minH: number,
): SceneResizeRect {
  let { x, y, w, h } = start;
  const east = id === 'ne' || id === 'e' || id === 'se';
  const west = id === 'nw' || id === 'w' || id === 'sw';
  const north = id === 'nw' || id === 'n' || id === 'ne';
  const south = id === 'sw' || id === 's' || id === 'se';
  if (east) w = start.w + dx;
  if (west) {
    w = start.w - dx;
    x = start.x + dx;
  }
  if (south) h = start.h + dy;
  if (north) {
    h = start.h - dy;
    y = start.y + dy;
  }
  if (w < minW) {
    if (west) x -= minW - w;
    w = minW;
  }
  if (h < minH) {
    if (north) y -= minH - h;
    h = minH;
  }
  return { x, y, w, h };
}

export function SceneResizeHandles({
  rect,
  minW = 48,
  minH = 32,
  revealed,
  zoom = 1,
  onResizeStart,
  onResize,
  onResizeEnd,
}: SceneResizeHandlesProps) {
  const zoomDivisor = zoom > 0 ? zoom : 1;
  const [active, setActive] = React.useState<SceneResizeHandleId | null>(null);
  const liveRect = React.useRef<SceneResizeRect>(rect);
  liveRect.current = active ? liveRect.current : rect;

  function startDrag(id: SceneResizeHandleId, event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const startRect = rect;
    const startX = event.clientX;
    const startY = event.clientY;
    setActive(id);
    onResizeStart?.();

    function move(moveEvent: PointerEvent) {
      // SCREEN delta ÷ zoom = world (engine) delta, so the edge tracks the cursor
      // even when the canvas is scaled by scale(zoom). zoomDivisor = 1 when unzoomed.
      const next = applySceneResize(
        id,
        startRect,
        (moveEvent.clientX - startX) / zoomDivisor,
        (moveEvent.clientY - startY) / zoomDivisor,
        minW,
        minH,
      );
      liveRect.current = next;
      onResize(next, id);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setActive(null);
      onResizeEnd?.(liveRect.current);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  return (
    <div
      data-scene-resize-handles
      aria-hidden
      className={cn(
        'absolute inset-0 z-20 transition-opacity duration-150',
        // Pointer-transparent container — the live surface underneath stays
        // interactive; only the handle dots below opt back in.
        'pointer-events-none',
        revealed ? 'opacity-100' : 'opacity-0 group-hover/hover-reveal:opacity-100',
      )}
    >
      {active ? (
        <div className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--border-primary)] bg-[var(--surface-primary)] px-1.5 py-0.5 text-[length:var(--font-size-caption)] font-medium tabular-nums text-[var(--text-primary)] shadow-sm">
          {Math.round(liveRect.current.w)} × {Math.round(liveRect.current.h)}
        </div>
      ) : null}
      {HANDLES.map((handle) => (
        <div
          key={handle.id}
          data-scene-resize-handle={handle.id}
          onPointerDown={(event) => startDrag(handle.id, event)}
          style={{ left: `${handle.cx * 100}%`, top: `${handle.cy * 100}%`, cursor: handle.cursor }}
          className={cn(
            'pointer-events-auto absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[3px]',
            'border border-[var(--border-focus,var(--border-primary))] bg-[var(--surface-primary)] shadow-sm',
            'transition-transform duration-100',
            active === handle.id && 'scale-125',
          )}
        />
      ))}
    </div>
  );
}
