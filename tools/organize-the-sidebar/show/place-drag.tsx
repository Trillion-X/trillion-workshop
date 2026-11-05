// parts/sidebar/show/place-drag.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Moving the sidebar by dragging it: from the thin bar's grip or the folded handle, the person drags it, every place
// it can go lights up (the four window edges, and every seam between two panes the window's arrangement shows now),
// and letting go docks it on the place under the pointer, or folds it to a handle right there when no place is under
// it. A press that never moves is a click.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The seams are read from the page when the drag starts (ui/show/seam-slots readShownSeams), never from a layout
//    record: whatever the window shows is what can be chosen.
// 2. A seam wins over an edge when the pointer is on both; a seam band too thin to hit is widened to a finger's width.
// 3. Where it folds is kept as shares of the window, so it stays put when the window is resized.
// 4. A press that moves less than the slop is a click; nothing is placed. The click a moved press makes afterwards is
//    the drag's (consumeDrag), never the button's.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
// =============================================================================

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Container, LAYER_ORDER } from '../../ui/index.ts';
import { readShownSeams } from '../../ui/show/seam-slots';
import type { DockPoint, DockPosition, DockSeam } from '../../ui/show/dockable-placement/dockable-placement';
import { suppressGestureTextSelection } from './DesktopSidebar.tsx';

type Rect = { x: number; y: number; w: number; h: number };

/** A place the sidebar can be dropped on. */
export type PlaceTarget =
  | { readonly kind: 'edge'; readonly position: DockPosition; readonly rect: Rect }
  | { readonly kind: 'seam'; readonly seam: DockSeam; readonly axis: 'vertical' | 'horizontal'; readonly rect: Rect };

const SLOP_PX = 5;
const EDGE_BAND_PX = 56;
const SEAM_HIT_PX = 28;

/** Every place there is now (invariant 1), seams first so they win (invariant 2). */
export function readPlaceTargets(width: number, height: number, root: ParentNode = document): PlaceTarget[] {
  const seams: PlaceTarget[] = readShownSeams(root).map(({ seam, axis, rect }) => ({
    kind: 'seam',
    seam,
    axis,
    rect: axis === 'vertical'
      ? { x: rect.x + rect.w / 2 - Math.max(rect.w, SEAM_HIT_PX) / 2, y: rect.y, w: Math.max(rect.w, SEAM_HIT_PX), h: rect.h }
      : { x: rect.x, y: rect.y + rect.h / 2 - Math.max(rect.h, SEAM_HIT_PX) / 2, w: rect.w, h: Math.max(rect.h, SEAM_HIT_PX) },
  }));
  const edges: PlaceTarget[] = [
    { kind: 'edge', position: 'left', rect: { x: 0, y: 0, w: EDGE_BAND_PX, h: height } },
    { kind: 'edge', position: 'right', rect: { x: width - EDGE_BAND_PX, y: 0, w: EDGE_BAND_PX, h: height } },
    { kind: 'edge', position: 'top', rect: { x: 0, y: 0, w: width, h: EDGE_BAND_PX } },
    { kind: 'edge', position: 'bottom', rect: { x: 0, y: height - EDGE_BAND_PX, w: width, h: EDGE_BAND_PX } },
  ];
  return [...seams, ...edges];
}

const inside = (rect: Rect, x: number, y: number) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

/** The place under a point, if any. */
export function placeAt(targets: readonly PlaceTarget[], x: number, y: number): PlaceTarget | undefined {
  return targets.find((target) => inside(target.rect, x, y));
}

export interface PlaceDragOptions {
  /** Dropped on a place: dock there. */
  onPlace: (target: PlaceTarget) => void;
  /** Dropped where no place is: fold to a handle there (shares of the window). */
  onFold: (point: DockPoint) => void;
}

export function usePlaceDrag({ onPlace, onFold }: PlaceDragOptions) {
  const [drag, setDrag] = React.useState<{ x: number; y: number; targets: PlaceTarget[] } | null>(null);
  const handlers = React.useRef({ onPlace, onFold });
  handlers.current = { onPlace, onFold };
  // The click a press makes after it moved belongs to the drag, not to the button (invariant 4).
  const dragged = React.useRef(false);
  const consumeDrag = React.useCallback(() => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }, []);

  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    let moving = false;
    dragged.current = false;
    let targets: PlaceTarget[] = [];
    let restoreSelection: (() => void) | null = null;
    const move = (next: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(next.clientX - start.x, next.clientY - start.y) < SLOP_PX) return;
        moving = true;
        restoreSelection = suppressGestureTextSelection(document);
        targets = readPlaceTargets(window.innerWidth, window.innerHeight);
      }
      setDrag({ x: next.clientX, y: next.clientY, targets });
    };
    const up = (last: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      restoreSelection?.();
      setDrag(null);
      if (!moving) return;
      dragged.current = true;
      // The click that follows this release (if any) comes before the next task; after it the flag is gone.
      setTimeout(() => { dragged.current = false; }, 0);
      const target = placeAt(targets, last.clientX, last.clientY);
      if (target) handlers.current.onPlace(target);
      else handlers.current.onFold({ x: last.clientX / Math.max(1, window.innerWidth), y: last.clientY / Math.max(1, window.innerHeight) });
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      restoreSelection?.();
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }, []);

  const hovered = drag ? placeAt(drag.targets, drag.x, drag.y) : undefined;
  const overlay = drag && typeof document !== 'undefined' ? createPortal(
    <Container aria-hidden data-sidebar-place-targets="" style={{ position: 'fixed', inset: 0, zIndex: LAYER_ORDER.menu, pointerEvents: 'none' }}>
      {drag.targets.map((target, index) => {
        const lit = target === hovered;
        // An edge's band is drawn inside the window's own gap; a seam's band is drawn where it is.
        const band = target.kind === 'edge'
          ? { x: target.rect.x + 8, y: target.rect.y + 8, w: target.rect.w - 16, h: target.rect.h - 16 }
          : target.rect;
        return (
          <Container
            key={index}
            data-sidebar-place-target={target.kind === 'edge' ? target.position : JSON.stringify(target.seam)}
            data-lit={lit ? '' : undefined}
            className="rounded-xl border-2 border-dashed transition-colors duration-100"
            style={{
              position: 'absolute', left: band.x, top: band.y, width: band.w, height: band.h,
              borderColor: lit ? 'var(--accent-primary, var(--border-focus))' : 'color-mix(in srgb, var(--border-focus) 45%, transparent)',
              background: lit ? 'color-mix(in srgb, var(--accent-primary, var(--border-focus)) 18%, transparent)' : 'transparent',
            }}
          />
        );
      })}
      {/* What is being moved, under the pointer: a folded handle when it lands on no place. */}
      <Container
        className="glass-surface rounded-full"
        style={{ position: 'absolute', left: drag.x - 18, top: drag.y - 18, width: 36, height: 36, opacity: 0.9 }}
      />
    </Container>,
    document.body,
  ) : null;

  return { onPointerDown, overlay, dragging: drag !== null, consumeDrag };
}
