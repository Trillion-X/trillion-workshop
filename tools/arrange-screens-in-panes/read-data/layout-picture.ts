// parts/screen-arrangement/read-data/layout-picture.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// What a layout looks like, read from its own pane tree: every pane as a box
// in a 0..1 frame (the split tree's sizes for tiles, the window rects for a
// canvas) with the icon and title of the screen showing in it, and the plain
// name a layout gets from those screens ("Files and Decisions"). The Layouts
// picker draws its thumbnails from this and a kept layout is named by it.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure: reads a LayoutState, writes nothing, names no screen or app.
// 2. The geometry drawn is the geometry the arrangement uses: the surface mode's
//    base geometry picks the tiled tree or the canvas rects (surface-modes.ts),
//    and a mode with nothing in it falls back to the other so a layout never
//    draws as a blank.
// 3. Boxes are in reading order (tree order for tiles, top-left first for a
//    canvas), so a name built from them reads the way the screen does.
// 4. A pane showing an empty tab has no title in the name; a layout whose every
//    pane is empty has no name, so it is never kept.
//
// =============================================================================

import { EMPTY_TAB_TITLE, type FloatingLayout, type LayoutState, type SplitTreeNode, type TiledLayout } from './layout-types';
import { baseGeometryForSurface } from './surface-modes';

/** One pane of a layout picture, in a 0..1 frame. */
export interface LayoutPicturePane {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The showing screen's icon name, when it has one. */
  icon: string | null;
  /** The showing screen's title; null for an empty tab. */
  title: string | null;
}

type Box = Omit<LayoutPicturePane, 'icon' | 'title'>;

function paneScreen(state: LayoutState, containerId: string): { icon: string | null; title: string | null } {
  const groupId = state.containers[containerId]?.groupId;
  const group = groupId ? state.tabGroups[groupId] : undefined;
  const tabId = group?.activeTabId ?? group?.tabIds[0];
  const tab = tabId ? state.tabs[tabId] : undefined;
  if (!tab) return { icon: null, title: null };
  return { icon: tab.icon ?? null, title: tab.title && tab.title !== EMPTY_TAB_TITLE ? tab.title : null };
}

function tiledBoxes(node: SplitTreeNode, x: number, y: number, w: number, h: number, out: Box[]): void {
  if (node.kind === 'leaf') {
    out.push({ id: node.containerId, x, y, w, h });
    return;
  }
  const total = node.children.reduce((sum, _child, index) => sum + (node.sizes?.[index] ?? 1), 0) || 1;
  let offset = 0;
  node.children.forEach((child, index) => {
    const share = (node.sizes?.[index] ?? 1) / total;
    if (node.dir === 'row') tiledBoxes(child, x + offset * w, y, share * w, h, out);
    else tiledBoxes(child, x, y + offset * h, w, share * h, out);
    offset += share;
  });
}

function floatingBoxes(layout: FloatingLayout): Box[] {
  const windows = layout.containers.filter((item) => item.w > 0 && item.h > 0);
  if (!windows.length) return [];
  const left = Math.min(...windows.map((item) => item.x));
  const top = Math.min(...windows.map((item) => item.y));
  const width = Math.max(...windows.map((item) => item.x + item.w)) - left || 1;
  const height = Math.max(...windows.map((item) => item.y + item.h)) - top || 1;
  // One scale for both axes keeps each window's own shape; the drawing is centred in the frame.
  const span = Math.max(width, height);
  const padX = (span - width) / 2 / span;
  const padY = (span - height) / 2 / span;
  return [...windows]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => ({
      id: item.containerId,
      x: padX + (item.x - left) / span,
      y: padY + (item.y - top) / span,
      w: item.w / span,
      h: item.h / span,
    }));
}

/** Every pane of a layout as a box in a 0..1 frame, in reading order. */
export function layoutPicture(state: LayoutState): LayoutPicturePane[] {
  const tiled = state.layouts.find((layout): layout is TiledLayout => layout.type === 'tiled');
  const floating = state.layouts.find((layout): layout is FloatingLayout => layout.type === 'floating');
  const fromTiles = (): Box[] => {
    const out: Box[] = [];
    if (tiled?.root) tiledBoxes(tiled.root, 0, 0, 1, 1, out);
    return out;
  };
  const fromCanvas = (): Box[] => (floating ? floatingBoxes(floating) : []);
  const [first, second] = baseGeometryForSurface(state.surface) === 'floating' ? [fromCanvas, fromTiles] : [fromTiles, fromCanvas];
  const boxes = first();
  return (boxes.length ? boxes : second())
    .filter((box) => !!state.containers[box.id])
    .map((box) => ({ ...box, ...paneScreen(state, box.id) }));
}

/** The plain name a layout gets from the screens in it, or null when it shows none. */
export function layoutNameFromScreens(state: LayoutState): string | null {
  const titles = [...new Set(layoutPicture(state).map((pane) => pane.title).filter((title): title is string => !!title))];
  if (!titles.length) return null;
  if (titles.length === 1) return titles[0];
  if (titles.length <= 3) return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
  return `${titles.slice(0, 2).join(', ')} and ${titles.length - 2} more`;
}
