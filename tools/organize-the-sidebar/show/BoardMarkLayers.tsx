// packages/group/show/BoardMarkLayers.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Mounts the addressed-marks drawing tools (pen/shape/eraser ink) over the
// vision board, exactly the way screen-arrangement mounts them over its canvas.
// The board OWNS the geometry (its pan/zoom camera + the screen↔world mapping);
// addressed-marks OWNS the ink (strokes, tools, styles, persistence). The two
// packages meet only through the addressed-marks PUBLIC surface
// (AddressedMarkOverlay / MarkInputLayer / MarkToolbar) + a MarkTarget address —
// no god package, no import of addressed-marks internals, no board logic leaking
// into addressed-marks. This is the screen-arrangement ArrangementMarkLayers
// recipe re-expressed for the board's camera (L069: one drawing primitive,
// configured by a different owner's coordinate system).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Marks live in WORLD pixels so ink pans/zooms with the board items. The
//    display overlay's viewBox follows the camera; the input layer maps each
//    client point through the board's own screenToWorld (the SSOT transform).
// 2. The input layer is inert (pointer-events:none) until the MarkToolbar turns
//    drawing on, so mounting it NEVER blocks board pan / item drag.
// 3. Ink is scoped per board via the target address, so each board keeps its own
//    drawing and switching boards switches the ink.
// 4. The z-layer class strings are the SAME ones screen-arrangement uses, so they
//    are already present in the precompiled studio CSS (no purged arbitrary class).
//    They are passed via a props object rather than a raw className attribute —
//    these are composed components, not raw HTML.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AddressedMarkOverlay } from '../../addressed-marks/show/AddressedMarkOverlay';
import { MarkInputLayer, type MarkPointerSpace } from '../../addressed-marks/show/MarkInputLayer';
import { MarkToolbar } from '../../addressed-marks/show/MarkToolbar';
import { useMarkSession } from '../../addressed-marks/show/MarkSessionContext';
import type { MarkTarget } from '../../addressed-marks/read-data/addressed-marks';

/** Erase hit radius in screen px, divided by zoom into world units (mirrors the
 *  screen-arrangement world resolver). */
const ERASE_HIT_RADIUS_PX = 8;

/** Stacking order shared with screen-arrangement's mark layers (already compiled
 *  into the studio CSS): display ink below, stroke capture above it. */
const OVERLAY_LAYER_PROPS = { className: 'z-[10005]' } as const;
const INPUT_LAYER_PROPS = { className: 'z-[10010]' } as const;

/** The world-pixel mark target for one board. Address scopes the ink to this
 *  board; the frame names the two world axes (data, not behavior). */
export function boardWorldMarkTarget(boardId: string): MarkTarget {
  return {
    address: `group.board:${boardId}`,
    frame: { id: 'world-2d', axes: [{ id: 'x', unit: 'px' }, { id: 'y', unit: 'px' }] },
  };
}

export interface BoardMarkLayersProps {
  /** The board canvas element — measured for the display viewBox. */
  readonly stageRef: React.RefObject<HTMLDivElement | null>;
  /** The board camera (pan in screen px, zoom factor). */
  readonly camera: { panX: number; panY: number; zoom: number };
  /** The board's SSOT screen→world mapping (inverse of its world transform). */
  readonly screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
  /** Identifies the board so its ink is its own. */
  readonly boardId: string;
  /** The owner's close for the drawing mode. The board OWNS the active tool
   *  (DrawToolBinder re-derives session.enabled from it), so the toolbar's
   *  Done must close the mode HERE — a child-side setEnabled(false) alone
   *  would be re-enabled by the binder on the next render. */
  readonly onDone: () => void;
}

/** Drawing-tool layers for the board: a camera-following display overlay, the
 *  shared stroke-capture input layer, and the floating toolbar. Lives ABOVE the
 *  world transform so ink renders over items, yet maps to world coordinates so it
 *  pans/zooms with them. */
export function BoardMarkLayers({ stageRef, camera, screenToWorld, boardId, onDone }: BoardMarkLayersProps): React.ReactElement {
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const screenToWorldRef = useRef(screenToWorld);
  screenToWorldRef.current = screenToWorld;

  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setStageSize({ width: rect.width || 1, height: rect.height || 1 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [stageRef]);

  const target = useMemo(() => boardWorldMarkTarget(boardId), [boardId]);

  const zoom = camera.zoom || 1;
  const viewBox = stageSize
    ? `${(0 - camera.panX) / zoom} ${(0 - camera.panY) / zoom} ${stageSize.width / zoom} ${stageSize.height / zoom}`
    : undefined;

  // Resolve the addressed space under the pointer: every client point maps to
  // world pixels through the board's own transform (SSOT). hitRadius is in world
  // units so erasing feels constant on screen regardless of zoom.
  const resolvePointerSpace = useMemo(
    () =>
      (_clientX: number, _clientY: number): MarkPointerSpace | null => ({
        target,
        toCoordinate: (x: number, y: number) => {
          const world = screenToWorldRef.current(x, y);
          return { values: [world.x, world.y] };
        },
        hitRadius: ERASE_HIT_RADIUS_PX / (cameraRef.current.zoom || 1),
      }),
    [target],
  );

  return (
    <>
      <AddressedMarkOverlay target={target} enabled={false} viewBox={viewBox} {...OVERLAY_LAYER_PROPS} />
      <MarkInputLayer resolvePointerSpace={resolvePointerSpace} {...INPUT_LAYER_PROPS} />
      <MarkToolbar onDone={onDone} />
    </>
  );
}

/** Binds the shared addressed-marks drawing session's `enabled` flag to the
 *  canvas-tool primitive's active tool: drawing is ON exactly when the Draw tool
 *  is active. This dissolves the old ad-hoc BoardDrawToggle button (L030) — the
 *  Draw tool IS the toggle now. The MarkToolbar self-hides until enabled
 *  (addressed-marks/show/MarkToolbar.tsx), and the MarkInputLayer arms with it.
 *  Render-null binder; must live inside MarkSessionProvider. */
export function DrawToolBinder({ active }: { active: boolean }): null {
  const session = useMarkSession();
  useEffect(() => {
    if (!session) return;
    if (session.enabled !== active) session.setEnabled(active);
  }, [session, active]);
  return null;
}
