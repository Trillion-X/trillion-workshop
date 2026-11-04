// packages/screen-arrangement/read-data/layout-types.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical layout data model for the screen-arrangement system. Defines the split-tree,
// freeform canvas, and overlay surface types. LayoutState is the SSOT for all
// panel arrangement — persisted to JSON file for external editability.
//
// Shared view-state fields consumed by any package-set layout.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure data types — no React, no side effects, no rendering logic
// 2. LayoutState is the SSOT for all layout arrangement
// 3. Containers exist in exactly ONE surface at a time (exclusivity)
// 4. Tab groups own ordered tab lists + active tab pointer
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { SurfaceMode } from './surface-modes';
import type { VisualLayerStackRecord } from '../../ui/show/visual-layer-stack';
import type { DockablePlacementState } from '../../ui/show/dockable-placement/dockable-placement';
import type { NodeBookmarkRecord } from './node-bookmark-types';
import type { NodeHistoryRecord } from './node-history-types';

// ---------------------------------------------------------------------------
// SPLIT-TREE (tiled surface)
// ---------------------------------------------------------------------------

/** Leaf node — renders a single container. */
export interface LeafNode {
  kind: 'leaf';
  containerId: string;
}

/**
 * What a split's `sizes` measure.
 *
 * - `share`: fractions of the split's own space. The children always fill the
 *   split, so widening one narrows its neighbours. Layouts saved before pane
 *   sizes existed have no `sizeUnit` and read as `share`.
 * - `px`: each child's own width (row) or height (column) in layout pixels,
 *   independent of zoom. Changing one child changes nothing else; the split is
 *   as long as its children together and the arrangement scrolls when that is
 *   longer than the window. A length of 0 draws that child at its content's height
 *   (the tallest `[data-fits-content]` it holds), so a pane of a card reads as the card.
 */
export type SplitSizeUnit = 'share' | 'px';

/** Split node — divides space into children along a direction. */
export interface SplitNode {
  kind: 'split';
  dir: 'row' | 'column';
  /** One size per child along `dir`, in the unit `sizeUnit` names. */
  sizes: number[];
  /** Absent means `share`. */
  sizeUnit?: SplitSizeUnit;
  /**
   * Each child's own length across the split (its height in a `row`, its width in a `column`), in layout pixels;
   * `null` or no entry fills the split. Absent when every child fills.
   */
  crossSizes?: (number | null)[];
  /**
   * With `px` sizes: draw every child at exactly its saved length, the split as long as its children together and the
   * arrangement scrolling past the window, instead of scaling them to fit (a pane added beside never shrinks another).
   */
  keepLengths?: boolean;
  /**
   * A row drawn narrower than this many layout pixels draws its children stacked instead, top to bottom, each at its
   * own length across the row (`crossSizes`) or its least height, and the arrangement scrolls: a dashboard of pieces
   * side by side on a wide screen reads as one column on a phone. Absent: the row stays side by side at every width.
   */
  stackBelow?: number;
  children: SplitTreeNode[];
}

export type SplitTreeNode = SplitNode | LeafNode;

/** Tiled layout — recursive split tree of containers. */
export interface TiledLayout {
  type: 'tiled';
  root: SplitTreeNode | null;
}

// ---------------------------------------------------------------------------
// FREEFORM CANVAS (floating surface)
// ---------------------------------------------------------------------------

/** Position + size rect for a floating window. */
export interface FreeformRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Floating window — rect + z-order. */
export interface FreeformWin extends FreeformRect {
  z: number;
}

/** Camera state for pan/zoom on the freeform canvas. */
export interface Camera {
  scale: number;
  tx: number;
  ty: number;
  min?: number;
  max?: number;
}

/** Floating layout — absolutely-positioned windows with camera. */
export interface FloatingLayout {
  type: 'floating';
  containers: Array<{ containerId: string } & FreeformWin>;
  camera: Camera;
}

// ---------------------------------------------------------------------------
// OVERLAY (PiP surface)
// ---------------------------------------------------------------------------

/** Overlay box — fixed-position PiP window. */
export interface OverlayBox {
  containerId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

/** Overlay layout — PiP windows layered on top of any surface. */
export interface OverlayLayout {
  type: 'overlay';
  containers: OverlayBox[];
}

// ---------------------------------------------------------------------------
// FRAME EDGE (shared by arrangers)
// ---------------------------------------------------------------------------

export type FrameEdge = 'left' | 'right' | 'top' | 'bottom';

// ---------------------------------------------------------------------------
// CONTAINER + TAB GROUP
// ---------------------------------------------------------------------------

/** Container — a panel that holds a tab group. */
export interface LayoutContainer {
  id: string;
  groupId: string;
}

/** Tab group — ordered list of tabs with an active pointer. */
export interface TabGroup {
  tabIds: string[];
  activeTabId: string | null;
}

export interface PackageEntryReference {
  packageName: string;
  entryName: string;
}

// ---------------------------------------------------------------------------
// LAYOUT STATE (the SSOT)
// ---------------------------------------------------------------------------

/** All layout types that can appear in the layouts array. */
export type LayoutSurface = TiledLayout | FloatingLayout | OverlayLayout;

/** One independently arranged plane in the workspace's z ordered stack. */
export interface ArrangementLayer {
  id: string;
  name?: string;
  z: number;
  surface?: SurfaceMode;
  layouts: LayoutSurface[];
}

/**
 * Complete layout state — persisted to JSON file.
 *
 * External editors can write the JSON representation directly to change the UI layout.
 */
export interface LayoutState {
  /** All containers by ID. */
  containers: Record<string, LayoutContainer>;
  /** Tab groups by ID — each group holds an ordered tab list. */
  tabGroups: Record<string, TabGroup>;
  /** All tabs by ID — metadata for rendering tab strips. */
  tabs: Record<string, TabMeta>;
  /** The three layout surfaces: tiled, floating, overlay. */
  layouts: LayoutSurface[];
  /** Optional stacked planes; `layouts` remains the active plane's legacy projection. */
  layers?: ArrangementLayer[];
  /** Plane currently receiving arrangement edits. */
  activeLayerId?: string;
  /**
   * Open label for the active base mode (`'grid'`, `'canvas'`, future `'stage'`…).
   * The renderer maps it to a base geometry via the `surface-modes` registry —
   * never a `=== 'canvas'` branch. Overlay always renders on top, orthogonally.
   */
  surface: SurfaceMode;
  /** Which container currently has focus (for keyboard nav + visual highlight). */
  focusedContainerId: string | null;
  /** Which container is maximized (takes full screen, hides all others). null = normal. */
  maximizedContainerId: string | null;
  /**
   * Chrome zone visibility — dot-path zone name to boolean, resolved by
   * longest-prefix match (read-data/chrome-visibility.ts). Absent = all
   * chrome visible. Pure data: hosts, embeds, and direct JSON edits all
   * configure chrome here the same way.
   */
  chrome?: Record<string, boolean>;
  /**
   * Region-address-key → that region's OWN chrome-visibility map (a per-region
   * override of the arrangement-wide `chrome` above). The key is `regionAddressKey`
   * (read-data/region-address.ts) — the SAME keying as `visualLayerStacks`. A
   * region's effective chrome = `mergeChromeMaps(chrome, regionChrome[key])`
   * (region-chrome.ts). This makes ONE addressed region immersive
   * (`{'':false}` = hide its header/frame/padding) while siblings keep theirs —
   * note #33 ("drop a video → only the video"). Absent = region inherits the
   * arrangement-wide map. Pure data, like every other region-keyed side-map.
   */
  regionChrome?: Record<string, Record<string, boolean>>;
  /**
   * Container id → where that container's tab bar sits (edge) and how much of
   * it shows (shown / minimized / hidden until pointed at). The value is the
   * shared ui dockable-placement state, the same state the sidebar uses
   * (read-data/tab-bar-placement.ts). Absent = top and shown.
   */
  tabBarPlacement?: Record<string, DockablePlacementState>;
  /**
   * Container id → which view its tab bar draws its tabs in (an id from
   * TAB_BAR_VIEWS in read-data/tab-bar-placement.ts). Absent = tabs.
   */
  tabBarView?: Record<string, string>;
  /**
   * Region-address-key → that region's ordered visual layer stack. The key is a
   * canonical serialization of a region AddressRef (see region-address.ts). A
   * region with no entry has an empty/transparent stack. Pure data — hosts,
   * embeds, and direct JSON edits all author region wallpaper here the same way.
   */
  visualLayerStacks?: Record<string, VisualLayerStackRecord>;
  /**
   * Floating-window container id -> true when a press outside that window closes it (the window's backdrop region,
   * when it has one, takes the press). A side map because few windows close this way; absent = none do.
   */
  closeOnOutsidePress?: Record<string, boolean>;
  /**
   * Floating-window container id -> the container that was focused when the window opened. A screen opened from the
   * window (Find anything) lands where the person was working, and closing the window gives focus back there. A side
   * map because only floating windows have one; absent = none.
   */
  focusReturnsTo?: Record<string, string>;
  /**
   * Bookmark id -> a saved pointer to an addressed node (tab/container/canvas/
   * layout). Generic, kind-blind — the record carries the node's AddressRef.
   * Persisted on the engine log like any LayoutState field; the renderer is a
   * blind projection (read-data/node-bookmark-types.ts). Absent = none saved.
   */
  nodeBookmarks?: Record<string, NodeBookmarkRecord>;
  /**
   * Region key -> that node's navigation history (visited refs + cursor).
   * Generic, kind-blind — the record carries the node's AddressRef and opaque
   * refs. Persisted on the engine log; a blind projection drives the nav arrows.
   * Absent = no history yet. See read-data/node-history-types.ts.
   */
  nodeHistory?: Record<string, NodeHistoryRecord>;
  /** Bounded undo/redo history for changes to the screen arrangement itself. */
  arrangementHistory?: ArrangementHistoryRecord;
}

/** The geometry and pane membership state needed to restore one arrangement. */
export type ArrangementHistorySnapshot = Pick<LayoutState,
  'containers' | 'tabGroups' | 'tabs' | 'layouts' | 'surface' | 'focusedContainerId' | 'maximizedContainerId' |
  'layers' | 'activeLayerId'
>;

export interface ArrangementHistoryEntry {
  snapshot: ArrangementHistorySnapshot;
  label: string;
  ts: number;
  /** Consecutive pointer updates from one resize gesture share one undo row. */
  coalesceKey?: string;
}

export interface ArrangementHistoryRecord {
  entries: ArrangementHistoryEntry[];
  cursor: number;
}

/** Tab metadata stored in layout state — enough to render the tab strip. */
export interface TabMeta {
  id: string;
  title: string;
  target: string | null;
  packageEntry?: PackageEntryReference | null;
  materialTarget?: string | null;
  icon?: string;
  pinned?: boolean;
  closable?: boolean;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DROP TARGET (shared by split-tree arranger)
// ---------------------------------------------------------------------------

export type DropTarget =
  | { kind: 'frame-edge'; edge: FrameEdge }
  | { kind: 'container-edge'; containerId: string; edge: FrameEdge }
  | { kind: 'split-gutter'; dir: 'row' | 'column'; beforeId: string; afterId: string };

// ---------------------------------------------------------------------------
// DEFAULT STATE
// ---------------------------------------------------------------------------

/** The one title a tab shows while it holds no surface (the thing picker). A tab never
 * borrows an id as its title; an id is not words a person reads. */
export const EMPTY_TAB_TITLE = 'Empty tab';

/** A new tab that holds no surface yet (it shows the thing picker). */
export function newEmptyTab(): TabMeta {
  return {
    id: `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: EMPTY_TAB_TITLE,
    target: null,
  };
}

/** Default layout: one pane, one empty surface, tiled surface. */
export const DEFAULT_LAYOUT_STATE: LayoutState = {
  containers: { main: { id: 'main', groupId: 'main-group' } },
  tabGroups: { 'main-group': { tabIds: ['surface-default'], activeTabId: 'surface-default' } },
  tabs: { 'surface-default': { id: 'surface-default', title: EMPTY_TAB_TITLE, target: null, icon: 'Square' } },
  layouts: [
    { type: 'tiled', root: { kind: 'leaf', containerId: 'main' } },
    { type: 'floating', containers: [], camera: { scale: 1, tx: 0, ty: 0 } },
    { type: 'overlay', containers: [] },
  ],
  surface: 'grid',
  focusedContainerId: 'main',
  maximizedContainerId: null,
};
