// packages/ui/show/canvas-viewport/CanvasViewport.tsx
//
// Physics-layer canvas viewport: the fixed window you look THROUGH at an infinite
// 2D canvas. Every 2D canvas surface (graph canvas, workflow canvas, boardrd)
// needs the same window — a position:relative, overflow:hidden, touch-action:none
// rectangle that clips the world, captures pointer + wheel events, and exposes its
// ref so the owner can do screen↔world math. Zero domain vocabulary — it only knows
// a rectangle and pointer/wheel events.
//
// Named for the finger-point test (generic-naming.md): you point at it and say
// "that is the window I look through at the canvas" — a viewport. NOT a "stage"
// (theatre metaphor — undescribable by pointing).
//
// This exists so feature code never hand-rolls a raw <div> window (L065/L106):
// compose CanvasViewport + CanvasDotGrid + CanvasWorldTransform + CanvasNode.

import React, { forwardRef } from 'react';

export interface CanvasViewportProps {
  /** CSS height for the viewport (e.g. 'calc(100vh - 160px)' or a number of px).
   *  Ignored when `fill` is set. */
  height?: number | string;
  /** Fill the remaining space of a flex-column parent instead of taking a fixed
   *  height. The viewport becomes a `flex: 1` child (with `minHeight` as its floor),
   *  so the canvas always reaches the bottom of its pane — no magic-number height,
   *  no gap below it. Use this whenever the viewport owns the rest of a panel. */
  fill?: boolean;
  /** Minimum height so the viewport is usable in small panels. */
  minHeight?: number | string;
  cursor?: React.CSSProperties['cursor'];
  /** True while a canvas gesture (marquee-select / pan) is in flight. The static
   *  userSelect:none below only covers this viewport's OWN subtree, but a drag that
   *  sweeps across floating panels (a metric popover, a toolbar) paints a native text
   *  selection over their labels ("why is it highlighting all these words"). While
   *  `interacting`, selection is suppressed DOCUMENT-WIDE and any range the drag already
   *  started is cleared; both are restored the instant the gesture ends. The owner sets
   *  this from its marquee/pan state. */
  interacting?: boolean;
  children: React.ReactNode;
  /** Absolutely-filled, pointer-transparent overlay (empty/loading/error states). */
  overlay?: React.ReactNode;
  /** Live marquee rectangle in viewport-LOCAL pixels (left/top/width/height).
   *  When set, a generic dashed-accent rubber-band is drawn over the canvas while
   *  the user drags to select. The owner computes it from pointer positions
   *  relative to the viewport ref; this only draws it. Null/undefined → nothing. */
  selectionRect?: { left: number; top: number; width: number; height: number } | null;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onWheel?: (e: React.WheelEvent<HTMLDivElement>) => void;
  /** Double-click on the viewport (the owner decides what an empty-canvas
   *  double-click means — e.g. create a note at the cursor). */
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Right-click on the viewport (the owner decides what an empty-canvas
   *  context menu offers — e.g. paste / add note / select all at the cursor). */
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Files/content dropped onto the viewport from the OS or elsewhere. */
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Mark this viewport as the owner when it handles external file drops. */
  acceptsExternalFiles?: boolean;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Accessible interactive-region role. Canvas viewports are applications by
   * default; callers may select another standard role for a different region. */
  role?: React.AriaRole;
  /** Focus order for keyboard interaction. Defaults to 0 for the application. */
  tabIndex?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onKeyUp?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

export const CanvasViewport = forwardRef<HTMLDivElement, CanvasViewportProps>(
  (
    { height = '100%', fill = false, minHeight = 360, cursor = 'default', interacting = false, children, overlay, selectionRect, onPointerDown, onPointerMove, onPointerUp, onWheel, onDoubleClick, onContextMenu, onDrop, onDragOver, acceptsExternalFiles = false, role = 'application', tabIndex = 0, onKeyDown, onKeyUp, ...rest },
    ref,
  ) => {
    // R51: while a gesture is active, suppress text selection document-wide and clear
    // any range the drag already started — the viewport's own userSelect:none can't
    // stop a marquee from painting a selection across sibling/floating chrome.
    React.useEffect(() => {
      if (!interacting || typeof document === 'undefined') return;
      const body = document.body;
      const prev = body.style.userSelect;
      const prevWebkit = (body.style as React.CSSProperties & { webkitUserSelect?: string }).webkitUserSelect;
      body.style.userSelect = 'none';
      (body.style as React.CSSProperties & { webkitUserSelect?: string }).webkitUserSelect = 'none';
      try { window.getSelection?.()?.removeAllRanges(); } catch { /* no selection API (jsdom) */ }
      return () => {
        body.style.userSelect = prev;
        (body.style as React.CSSProperties & { webkitUserSelect?: string }).webkitUserSelect = prevWebkit;
      };
    }, [interacting]);
    return (
    <div
      ref={ref}
      role={role}
      tabIndex={tabIndex}
      aria-label={rest['aria-label']}
      aria-describedby={rest['aria-describedby']}
      data-accepts-external-files={acceptsExternalFiles ? 'true' : undefined}
      style={{
        position: 'relative',
        width: '100%',
        // `fill` → grow to consume the rest of a flex-column parent (no fixed
        // height, so the canvas always reaches the pane bottom). Else: fixed height.
        ...(fill ? { flex: '1 1 0', minHeight } : { height, minHeight }),
        overflow: 'hidden',
        touchAction: 'none',
        // The canvas is a manipulation surface, not a text-reading one: a drag must
        // draw a marquee / pan, NEVER start a native text selection (which would
        // highlight every note and block the gesture). Editable notes opt back in
        // to text selection via their own contentEditable (which overrides this).
        userSelect: 'none',
        WebkitUserSelect: 'none',
        cursor,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {children}
      {selectionRect ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height,
            border: '1px dashed var(--accent-primary)',
            backgroundColor: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
            borderRadius: 'var(--radius-sm)',
            pointerEvents: 'none',
            zIndex: 50,
          }}
        />
      ) : null}
      {overlay ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          {overlay}
        </div>
      ) : null}
    </div>
    );
  },
);

CanvasViewport.displayName = 'CanvasViewport';
