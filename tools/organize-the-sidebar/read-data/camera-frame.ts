// packages/group/read-data/camera-frame.ts
//
// FRAME-TO-FIT — the camera that makes a set of cards fill the viewport. `panToReveal` (viewport-visibility)
// only PANS a box into view at the current zoom; the complementary operation — compute the `{panX, panY, zoom}`
// that CENTERS and ZOOMS a set of world boxes to fill the screen with padding — was missing, yet it powers
// zoom-to-selection, fit-to-screen, zoom-to-cluster, and present-mode steps. This owns that one pure math
// primitive; the board vocabulary (which cards) is injected as boxes, so it names nothing.
//
// Screen projection is the board's canon (viewport-visibility): screenX = worldX * zoom + panX. So framing is:
// zoom = the tighter of (avail width / content width, avail height / content height), clamped; pan centers the
// content's world midpoint on the viewport midpoint. Pure, deterministic (no DOM, no clock).

import type { BoardItem } from './group-board-model.ts';
import { islandOf } from './board-islands.ts';
import type { Camera, Viewport, WorldBox } from './viewport-visibility.ts';

/** The tightest world box containing every box (the union bounding box), or null when the list is empty. */
export function unionBox(boxes: readonly WorldBox[]): WorldBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface FrameOptions {
  /** Screen-px padding kept around the framed content (default 40). */
  readonly margin?: number;
  /** Never zoom IN past this — a single tiny card shouldn't balloon to fill the screen (default 1). */
  readonly maxZoom?: number;
  /** Never zoom OUT past this (default 0.02). */
  readonly minZoom?: number;
}

/**
 * The camera `{panX, panY, zoom}` that centers `boxes` in `view` with `margin` px of padding. Zoom fits the
 * tighter of width/height, clamped to `[minZoom, maxZoom]`. Empty boxes or a non-positive viewport → null
 * (nothing to frame). A zero-size box (a single point) frames at `maxZoom`, centered. Pure.
 */
export function frameCamera(boxes: readonly WorldBox[], view: Viewport, opts: FrameOptions = {}): Camera | null {
  const bb = unionBox(boxes);
  if (!bb || view.w <= 0 || view.h <= 0) return null;
  const margin = opts.margin ?? 40;
  const maxZoom = opts.maxZoom ?? 1;
  const minZoom = opts.minZoom ?? 0.02;
  const availW = Math.max(1, view.w - 2 * margin);
  const availH = Math.max(1, view.h - 2 * margin);
  const fit = Math.min(availW / Math.max(bb.w, 1e-6), availH / Math.max(bb.h, 1e-6));
  const zoom = Math.min(maxZoom, Math.max(minZoom, fit));
  const cx = bb.x + bb.w / 2;
  const cy = bb.y + bb.h / 2;
  return { zoom, panX: view.w / 2 - cx * zoom, panY: view.h / 2 - cy * zoom };
}

/** A card's world box. */
function boxOf(i: BoardItem): WorldBox {
  return { x: i.x, y: i.y, w: i.w, h: i.h };
}

/** The camera that frames the WHOLE board (every item). null on an empty board. */
export function frameAll(items: readonly BoardItem[], view: Viewport, opts?: FrameOptions): Camera | null {
  return frameCamera(items.map(boxOf), view, opts);
}

/** The camera that frames just the cards whose ids are given (zoom-to-selection). null when none match. */
export function frameSelection(items: readonly BoardItem[], ids: readonly string[], view: Viewport, opts?: FrameOptions): Camera | null {
  const set = new Set(ids);
  return frameCamera(items.filter((i) => set.has(i.memberId)).map(boxOf), view, opts);
}

/** The camera that frames the whole connected cluster containing `cardId` (zoom-to-cluster) — composes the
 *  island reader, so a "focus this piece of the mind-map" jump falls out. null when the id isn't on the board. */
export function frameIsland(items: readonly BoardItem[], cardId: string, view: Viewport, opts?: FrameOptions): Camera | null {
  return frameSelection(items, islandOf(items, cardId), view, opts);
}
