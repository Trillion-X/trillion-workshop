// packages/documents/do-work/build-float-transaction.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The PURE "drag-surface-to-floating" primitive — extracted from the surface so
// it is testable without React, the engine, or async. "Float" is a UI verb, not
// a backend type: a floated node is an ordinary scene node positioned by
// `layout.x/y` under an Absolute parent. The engine has NO "FloatingCard" type
// (L039/L090 — verified: `composition-engine-core/src/kernel/layout.rs` reads
// `LayoutMode` per node from `props.style.layout.mode`, with NO root special-case;
// an Absolute node fills `parent_constraints.max` and `place_absolute_children`
// positions each child at `parent_content_origin + (layout.x, layout.y)`).
//
// CONVERGED STRUCTURE (Codex 2026-06-20, `convergence/2026-06-20-codex-drag-to-
// floating-verdict.md` — the naive "Absolute layer as a Flex-Y child" FAILED:
// it collapses to a zero-height slot whose origin sits AFTER all flow content, so
// a node persisted at y=100 renders at y=1000). The engine-native structure is:
//
//     root: Absolute canvas plane (x=0, y=0, w/h = canvas)
//       child 0: FlowColumn  (Flex axis=Y, x=0, y=0, w=canvas_w)  ← all old flow
//         flow blocks…
//       child 1+: floated nodes (Absolute siblings, layout.x/y)   ← cards on top
//
// The migration is LAZY (only on the first float) so the proven-live default doc
// surface (Flex-Y root, native scroll) is untouched until a user explicitly
// floats — bounding any regression to the opt-in action.
//
// FOUR HIGH fixes folded from the convergence:
//   1. root → Absolute canvas; old flow wrapped in ONE Flex-Y FlowColumn child.
//   2. world → overlay-local coords: with the canvas root at (0,0), world == local,
//      so persisted x/y = the node's captured on-screen origin (no jump).
//   3. source Split `parts[]` repaired ATOMICALLY when a node leaves a split.
//   4. ONE ordered atomic ScenePatch batch (no separate scene/layout passes →
//      no intermediate invalid tree / visible jump).
//   +MED: capture current w/h so a node measured in a 320px column does not
//      remeasure into one long line on the wide canvas.
//
// Z-order = child order under the canvas root (REORDER_CHILDREN brings to front);
// no explicit `z` field (that would be a second source of truth — Codex Q5).
//
// =============================================================================

import {
  type SceneNode,
  type ScenePatch,
  type CompositionTransaction,
} from '../read-data/documents';
import { isSplitNode, readSplitParts } from './build-split-transaction';

/** The canvas root and the per-node Absolute layout mode (engine `LayoutMode::Absolute`). */
export const CANVAS_ROOT_MODE = 'absolute';
/** A floated node / the canvas root / the FlowColumn are all plain Containers (no special kind). */
export const STRUCTURAL_KIND = 'Container';

export type CanvasSize = { width: number; height: number };
/** A node's current on-screen rect (engine `snapshot.frames[id].rect`), used to float without jump/remeasure. */
export type FloatFrame = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------
// Tree navigation (pure) — owned here so the primitive is surface-independent.
// (The surface keeps private `findNodeById`/`parentLocation`; this is the
//  canonical pure form a future refactor can consolidate onto — L030 note.)
// ---------------------------------------------------------------------------

/** Locate a node, its parent, and its index. `parent === null` for the root. */
export function findNodeWithParent(
  tree: SceneNode | null | undefined,
  nodeId: string,
): { node: SceneNode; parent: SceneNode | null; index: number } | null {
  if (!tree) return null;
  if (tree.id === nodeId) return { node: tree, parent: null, index: -1 };
  const walk = (parent: SceneNode): { node: SceneNode; parent: SceneNode; index: number } | null => {
    const children = parent.children ?? [];
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child.id === nodeId) return { node: child, parent, index: i };
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(tree);
}

// ---------------------------------------------------------------------------
// Layout helpers (pure)
// ---------------------------------------------------------------------------

function layoutOf(node: SceneNode | null | undefined): Record<string, unknown> | undefined {
  const style = node?.props?.style as Record<string, unknown> | undefined;
  return style && typeof style.layout === 'object' && style.layout !== null
    ? (style.layout as Record<string, unknown>)
    : undefined;
}

function layoutMode(node: SceneNode | null | undefined): string {
  const layout = layoutOf(node);
  return layout && typeof layout.mode === 'string' ? layout.mode.toLowerCase() : '';
}

/** True when the root has already been migrated to an Absolute canvas plane. */
export function isCanvasRoot(root: SceneNode | null | undefined): boolean {
  return layoutMode(root) === CANVAS_ROOT_MODE;
}

/**
 * Build the FULL replacement props for `node` with `layout` merged and optional
 * extra `style` keys — UPDATE_PROPS replaces props wholesale, so we spread the
 * existing props/style/layout to preserve every authored key (matches the
 * resize/divider write path). Never mutates the input.
 */
function propsWithLayout(
  node: SceneNode,
  layoutPatch: Record<string, unknown>,
  extraStyle?: Record<string, unknown>,
): Record<string, unknown> {
  const props = (node.props ?? {}) as Record<string, unknown>;
  const style = (props.style ?? {}) as Record<string, unknown>;
  const layout = (style.layout ?? {}) as Record<string, unknown>;
  return {
    ...props,
    style: {
      ...style,
      ...(extraStyle ?? {}),
      layout: { ...layout, ...layoutPatch },
    },
  };
}

// Read a node's explicit style.width (px) if it has one — used so the FlowColumn
// inherits the OLD root's authored width instead of blindly filling the canvas
// (Codex 2026-06-21 Q4b: forcing canvas width rewraps a narrower/padded doc).
function readStyleWidth(node: SceneNode | null | undefined): number | undefined {
  const style = node?.props?.style as Record<string, unknown> | undefined;
  const w = style?.width;
  return typeof w === 'number' && Number.isFinite(w) ? w : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Pad/truncate a split's parts to match its child count BEFORE removing one
// (Codex 2026-06-21 Q3: the engine tolerates parts.length != children.length, so
// a pre-existing mismatch must be normalized or the by-index removal drifts).
function normalizePartsToCount(parts: Array<{ fraction: number }>, count: number): Array<{ fraction: number }> {
  if (parts.length === count) return parts;
  if (parts.length > count) return parts.slice(0, count);
  const padded = parts.slice();
  while (padded.length < count) padded.push({ fraction: 1 });
  return padded;
}

// ---------------------------------------------------------------------------
// 1. Canvas-root migration (idempotent, lazy)
// ---------------------------------------------------------------------------

/**
 * Convert a Flex-Y flow root into an Absolute canvas root: wrap EVERY current
 * root child into one Flex-Y FlowColumn (pinned at the canvas origin, full canvas
 * width — so existing blocks render identically), then flip the root to Absolute
 * sized to the canvas. Idempotent: returns `{ patches: [], flowColumnId: null }`
 * when the root is already a canvas root. One ordered batch (engine applies in
 * order, runs ONE layout pass at the end).
 */
export function buildCanvasRootMigration(
  tree: SceneNode | null | undefined,
  canvasSize: CanvasSize,
  makeId: () => string,
): { patches: ScenePatch[]; flowColumnId: string | null } {
  if (!tree || isCanvasRoot(tree)) return { patches: [], flowColumnId: null };
  const rootId = tree.id;
  const flowColumnId = makeId();
  const existing = tree.children ?? [];
  const flowColumn: SceneNode = {
    id: flowColumnId,
    kind: STRUCTURAL_KIND,
    props: { style: { layout: { mode: 'flex', axis: 'y', x: 0, y: 0 }, width: readStyleWidth(tree) ?? canvasSize.width } },
    visible: true,
    children: [],
  };
  const patches: ScenePatch[] = [
    { type: 'INSERT_NODE', parent_id: rootId, index: 0, node: flowColumn },
  ];
  // Re-home every old root child into the FlowColumn, preserving order.
  existing.forEach((child, i) => {
    patches.push({ type: 'MOVE_NODE', node_id: child.id, new_parent_id: flowColumnId, new_index: i });
  });
  // Flip the root to an Absolute canvas plane (full-props spread).
  patches.push({
    type: 'UPDATE_PROPS',
    node_id: rootId,
    changes: {
      props: propsWithLayout(
        tree,
        { mode: CANVAS_ROOT_MODE, x: 0, y: 0 },
        { width: canvasSize.width, height: canvasSize.height },
      ),
    },
  });
  return { patches, flowColumnId };
}

// ---------------------------------------------------------------------------
// 1b. Workspace canvas arrangement (pages as nodes on the infinite plane)
// ---------------------------------------------------------------------------
//
// "Canvas view (pages as nodes)" is NOT a backend mode (locked primitive): the
// WORKSPACE root becomes an Absolute canvas and each PAGE (root child) becomes an
// independent absolute CARD at a grid position — the exact engine-native structure
// buildFloatTransaction proved (CANVAS_ROOT_MODE + layout.x/y + pinned w/h via
// `place_absolute_children`). Unlike buildCanvasRootMigration (which wraps a page's
// blocks in ONE FlowColumn so non-floated content keeps reading top-to-bottom), the
// workspace has no flow to preserve — every page is already an independent unit, so
// each is positioned directly. After this, the existing reposition (drag a card),
// free-pan, resize, and edge (#37) primitives all operate on the pages FOR FREE (a
// page-card IS an absolute canvas child — `nodeAuthorsOrigin`). Pages that already
// carry a layout.x/y (a card the user dragged) are LEFT in place so re-entering
// canvas view never throws away the user's spatial arrangement (L117 — no silent reset).

export type WorkspaceCanvasOptions = {
  columns?: number;
  cardWidth?: number;
  cardHeight?: number;
  gap?: number;
};

/** True when a node already carries an explicit canvas position (a placed card). */
function hasCanvasPosition(node: SceneNode): boolean {
  const layout = layoutOf(node);
  return !!layout && typeof layout.x === 'number' && typeof layout.y === 'number';
}

/**
 * True when the workspace is a canvas as told by the DATA ALONE — any top-level page
 * carries an explicit layout.x/y (a placed card). The persisted record stores only the
 * children (their full props, positions included) — never a separate "root mode" field —
 * so on load the canvas is RECONSTRUCTED from this self-describing signal (L090). The
 * surface uses this to re-flip the root to CANVAS_ROOT_MODE in the load handoff, so a
 * workspace saved in canvas view reopens in canvas view (L116 — survives reload).
 */
export function workspaceHasCanvasLayout(tree: SceneNode | null | undefined): boolean {
  if (!tree) return false;
  if (isCanvasRoot(tree)) return true;
  return (tree.children ?? []).some(hasCanvasPosition);
}

/**
 * Arrange the workspace root's PAGES as cards on an Absolute canvas: flip the root to
 * CANVAS_ROOT_MODE (if needed) and grid-position every page that is not already
 * placed. Empty/childless tree → empty transaction. One atomic scene_patches batch
 * (the engine applies in order, runs ONE layout pass).
 */
export function buildWorkspaceCanvasArrangement(
  tree: SceneNode | null | undefined,
  canvasSize: CanvasSize,
  options?: WorkspaceCanvasOptions,
): CompositionTransaction {
  if (!tree) return { scene_patches: [] };
  const pages = tree.children ?? [];
  if (pages.length === 0) return { scene_patches: [] };
  const columns = Math.max(1, options?.columns ?? 3);
  const cardW = options?.cardWidth ?? 320;
  const cardH = options?.cardHeight ?? 240;
  const gap = options?.gap ?? 48;

  const patches: ScenePatch[] = [];
  if (!isCanvasRoot(tree)) {
    patches.push({
      type: 'UPDATE_PROPS',
      node_id: tree.id,
      changes: { props: propsWithLayout(tree, { mode: CANVAS_ROOT_MODE, x: 0, y: 0 }, { width: canvasSize.width, height: canvasSize.height }) },
    });
  }
  let slot = 0;
  for (const page of pages) {
    if (hasCanvasPosition(page)) continue; // preserve a user-placed card (no silent reset)
    const col = slot % columns;
    const row = Math.floor(slot / columns);
    slot += 1;
    const x = gap + col * (cardW + gap);
    const y = gap + row * (cardH + gap);
    patches.push({
      type: 'UPDATE_PROPS',
      node_id: page.id,
      changes: { props: propsWithLayout(page, { x, y }, { width: cardW, height: cardH }) },
    });
  }
  return { scene_patches: patches };
}

// ---------------------------------------------------------------------------
// 2. Float a node onto the canvas
// ---------------------------------------------------------------------------

/**
 * Float `nodeId` out of the flow onto the canvas at its captured `frame`:
 *   migrate root → canvas (if needed) → repair source Split parts (if leaving a
 *   split) → MOVE the node to the canvas root (top of z-order) → pin x/y/w/h.
 * Returns an empty transaction when the node is missing or is the root itself.
 * All patches ride in ONE `scene_patches` array = one atomic engine transaction.
 */
export function buildFloatTransaction(
  tree: SceneNode | null | undefined,
  nodeId: string,
  frame: FloatFrame,
  canvasSize: CanvasSize,
  makeId: () => string,
): CompositionTransaction {
  if (!tree) return { scene_patches: [] };
  const located = findNodeWithParent(tree, nodeId);
  if (!located || located.parent === null) return { scene_patches: [] }; // never float the root / a missing node
  const { node, parent, index } = located;
  const rootId = tree.id;

  const migration = buildCanvasRootMigration(tree, canvasSize, makeId);
  const patches: ScenePatch[] = [...migration.patches];

  // (Q6) Repair the source split's parts BY INDEX. Split fractions are relative
  // weights sized by `fraction/Σ`, so dropping the floated child's part preserves
  // the remaining columns' proportions for free ([0.2,0.5,0.3] − idx1 → [0.2,0.3]
  // renders 0.4/0.6). Only when the node's immediate parent is a split.
  if (isSplitNode(parent)) {
    const childCount = (parent.children ?? []).length;
    const parts = normalizePartsToCount(readSplitParts(parent), childCount);
    if (index >= 0 && index < childCount) {
      const remaining = parts.filter((_, i) => i !== index);
      patches.push({
        type: 'UPDATE_PROPS',
        node_id: parent.id,
        changes: { props: propsWithLayout(parent, { parts: remaining }) },
      });
    }
  }

  // Move the node to the canvas root as an absolute sibling, appended = top of
  // z-order. After migration the root holds exactly [FlowColumn]; an
  // already-canvas root appends after its existing children.
  // Skip the move when the node is ALREADY a direct canvas-root child (no
  // migration + its parent is the root): re-floating an already-floated card is a
  // re-pin only, and a same-parent MOVE with a stale index is ambiguous (Codex Q2/LOW).
  const alreadyFloated = migration.flowColumnId === null && parent.id === rootId;
  if (!alreadyFloated) {
    const appendIndex = migration.flowColumnId !== null ? 1 : (tree.children ?? []).length;
    patches.push({ type: 'MOVE_NODE', node_id: nodeId, new_parent_id: rootId, new_index: appendIndex });
  }

  // (Q2/Q3 + MED) Pin at the captured world frame. Canvas root is at (0,0) so
  // world == overlay-local: x/y = the node's current on-screen origin (no jump),
  // and w/h are materialized so it does not remeasure under the wide canvas.
  patches.push({
    type: 'UPDATE_PROPS',
    node_id: nodeId,
    changes: {
      props: propsWithLayout(node, { x: frame.x, y: frame.y }, { width: frame.w, height: frame.h }),
    },
  });

  return { scene_patches: patches };
}

// ---------------------------------------------------------------------------
// 3. Reposition a floated node (drag its body across the canvas)
// ---------------------------------------------------------------------------
//
// A floated card you cannot move is half a feature (L113). Repositioning is the
// pure complement to floating: the node is already an absolute sibling of the
// canvas root (its parent uses `LayoutMode::Absolute` — `nodeAuthorsOrigin`), so
// a body-drag only updates `layout.x/y`. Same engine truth as resize-origin: the
// snapshot frame is the start, the pointer delta is the move, the engine re-lays
// it out. No reorder, no reparent — just new coordinates.

/** Captured drag inputs in stage/canvas pixels. */
export type RepositionDrag = {
  originX: number; // the node's frame origin when the drag began (snapshot truth)
  originY: number;
  pointerStartX: number; // pointer position (stage-local) at the first move
  pointerStartY: number;
  pointerX: number; // current pointer position (stage-local)
  pointerY: number;
  nodeWidth: number; // the card's size — so it can't be dragged off the right/bottom
  nodeHeight: number;
  canvasWidth: number; // the reachable canvas bounds in WORLD px (caller passes stage/zoom)
  canvasHeight: number;
  zoom?: number; // current camera zoom; a SCREEN delta maps to world delta / zoom
};

/**
 * New canvas origin (WORLD coords) for a dragged floated node: the captured origin
 * plus the pointer delta, clamped to the REACHABLE canvas bounds on all four sides
 * (Codex 2026-06-21 Q5: a top/left-only clamp let a card drag off the right/bottom
 * into unreachable space) and rounded to integer px. The pointer delta is in SCREEN
 * px; under zoom one screen pixel is 1/zoom world px (the content plane is scaled by
 * `scale(zoom)`), so the delta is divided by zoom to keep the card pinned under the
 * cursor (B-45). zoom defaults to 1 (flow / unzoomed) so every existing caller is a
 * no-op. The caller passes canvasWidth/Height already in world units (stage / zoom).
 */
export function repositionFromDrag(drag: RepositionDrag): { x: number; y: number } {
  const zoom = drag.zoom && drag.zoom > 0 ? drag.zoom : 1;
  const x = drag.originX + (drag.pointerX - drag.pointerStartX) / zoom;
  const y = drag.originY + (drag.pointerY - drag.pointerStartY) / zoom;
  return {
    x: clamp(Math.round(x), 0, Math.max(0, drag.canvasWidth - drag.nodeWidth)),
    y: clamp(Math.round(y), 0, Math.max(0, drag.canvasHeight - drag.nodeHeight)),
  };
}

/**
 * The UPDATE_PROPS transaction that writes a floated node's new `layout.x/y`
 * (full-props spread, like the resize/divider path). One patch; rAF-coalesce the
 * caller side (latest position wins) exactly like the resize commit.
 */
export function buildRepositionTransaction(node: SceneNode, x: number, y: number): CompositionTransaction {
  return {
    scene_patches: [
      {
        type: 'UPDATE_PROPS',
        node_id: node.id,
        changes: { props: propsWithLayout(node, { x, y }) },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. Free-pan the canvas (grab-drag the background to move the camera)
// ---------------------------------------------------------------------------
//
// Camera-ONLY navigation for the Absolute canvas (Codex 2026-06-21 free-pan +
// 2026-06-23 camera-model convergence). No tree mutation, no pan/canvas/view
// backend type: `camera.pan` is generic engine state (Q6 PASS). The host applies
// the camera as a VIEW TRANSFORM over the engine's world-coordinate frames (the
// engine stores the camera and only culls visibility — it never projects frames;
// verified mod.rs:2240). So the host adopts the ENGINE camera convention
// (composition-ast types.rs:671): screen = world * zoom + pan, pan in SCREEN px.
// Grab semantics (Q1): content follows the pointer — a fixed world point under the
// pointer stays under it, so its screen position moves by the pointer delta, i.e.
// pan moves WITH the drag (screen = world*zoom + pan ⇒ +Δscreen ⇒ +Δpan). Because
// pan is now in SCREEN px, the delta is added DIRECTLY (no /zoom — that was the old
// world-unit convention). UNBOUNDED (Q4: the engine does not clamp pan and has no
// world-bounds model). startPan captured ONCE at pointerdown (Q3 — re-reading
// mid-drag would jump). startZoom is carried so commitCamera preserves it.

export type CameraPanDrag = {
  startPanX: number; // snapshot.camera.pan_x (SCREEN px) captured ONCE at pointerdown
  startPanY: number;
  startZoom: number; // snapshot.camera.zoom at pointerdown (preserved through the pan)
  pointerStartX: number;
  pointerStartY: number;
  pointerX: number;
  pointerY: number;
};

export function panFromDrag(drag: CameraPanDrag): { pan_x: number; pan_y: number } {
  // Engine convention: pan is in SCREEN pixels (screen = world*zoom + pan), so the
  // grab delta maps 1:1 onto pan regardless of zoom. Content follows the pointer.
  const pan_x = drag.startPanX + (drag.pointerX - drag.pointerStartX);
  const pan_y = drag.startPanY + (drag.pointerY - drag.pointerStartY);
  return { pan_x: Math.round(pan_x), pan_y: Math.round(pan_y) };
}

// ---------------------------------------------------------------------------
// 5. Pinch / wheel ZOOM about the cursor (B-45)
// ---------------------------------------------------------------------------
//
// Cursor-anchored zoom: the world point under the pointer stays pinned to the same
// screen pixel as zoom changes (the universal "zoom toward what I'm pointing at"
// behaviour — Figma / Miro / tldraw). Pure math in the ENGINE convention
// (screen = world*zoom + pan, pan in SCREEN px), so it is the inverse of the host's
// content-plane `transform: translate(pan) scale(zoom)` and agrees with the engine's
// own `screen_to_world` culling. `pointerScreen` is measured from the FIXED stage
// viewport origin (NOT the transforming plane), so the anchor is a true screen point.
// zoom is clamped to the engine's own limits (Camera::validated clamps 0.1–4.0); we
// clamp here too so the anchor math uses the SAME zoom the engine will store (else
// pan would be computed against an out-of-range zoom and the anchor would drift).

export type ZoomLimits = { min: number; max: number };
export const CANVAS_ZOOM_LIMITS: ZoomLimits = { min: 0.1, max: 4 };

export function zoomAtPoint(
  camera: { pan_x: number; pan_y: number; zoom: number },
  pointerScreen: { x: number; y: number },
  factor: number,
  limits: ZoomLimits = CANVAS_ZOOM_LIMITS,
): { pan_x: number; pan_y: number; zoom: number } {
  const z0 = camera.zoom > 0 ? camera.zoom : 1;
  const z1 = clamp(z0 * (factor > 0 ? factor : 1), limits.min, limits.max);
  // World point currently under the cursor (engine screen_to_world): (screen - pan)/zoom.
  const worldX = (pointerScreen.x - camera.pan_x) / z0;
  const worldY = (pointerScreen.y - camera.pan_y) / z0;
  // Re-solve pan so that same world point maps back to the same screen pixel at z1:
  // pointerScreen = world * z1 + pan  ⇒  pan = pointerScreen - world * z1.
  return {
    pan_x: Math.round(pointerScreen.x - worldX * z1),
    pan_y: Math.round(pointerScreen.y - worldY * z1),
    zoom: z1,
  };
}

// ---------------------------------------------------------------------------
// 6. Canvas HUD operations (B-46) — zoom controls, fit-to-content, minimap
// ---------------------------------------------------------------------------
//
// All PURE camera math over the same B-45 primitive (engine convention
// screen = world*zoom + pan, pan in SCREEN px). The HUD + minimap are blind ui
// components fed these results; they name nothing and read ONLY the engine frames
// (the only layout truth) + the camera. Adding a control = composing these fns,
// never a new backend type.

export type ViewportSize = { w: number; h: number };
export type WorldRect = { x: number; y: number; w: number; h: number };

type Camera = { pan_x: number; pan_y: number; zoom: number };

/** Final safety net for every camera produced by HUD/minimap math (Codex-converged
 *  B-46 robustness boundary): degenerate geometry (empty canvas, zero-size bbox/map,
 *  padding ≥ viewport) must never leak NaN/Infinity/negative-zoom into a set_camera
 *  send. Any non-finite component collapses to the identity; zoom is always clamped to
 *  the engine limits. This is the ONE place degenerate cases resolve — callers stay pure. */
function safeCamera(c: Camera, limits: ZoomLimits = CANVAS_ZOOM_LIMITS): Camera {
  const zoom = Number.isFinite(c.zoom) ? clamp(c.zoom, limits.min, limits.max) : 1;
  const pan_x = Number.isFinite(c.pan_x) ? Math.round(c.pan_x) : 0;
  const pan_y = Number.isFinite(c.pan_y) ? Math.round(c.pan_y) : 0;
  return { pan_x, pan_y, zoom };
}

/** True only for a rect whose every component is finite (a frame the math can trust). */
function isFiniteRect(r: WorldRect): boolean {
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h);
}

/** Zoom by a fixed factor about the VIEWPORT CENTRE — the HUD +/- buttons (Mobbin:
 *  GitBook/Slite/Craft/Fibery [-] [%] [+]). Reuses the cursor-anchored zoom with the
 *  centre as the anchor, so the middle of the view stays put. */
export function zoomByFactor(
  camera: { pan_x: number; pan_y: number; zoom: number },
  viewport: ViewportSize,
  factor: number,
  limits: ZoomLimits = CANVAS_ZOOM_LIMITS,
): { pan_x: number; pan_y: number; zoom: number } {
  return zoomAtPoint(camera, { x: viewport.w / 2, y: viewport.h / 2 }, factor, limits);
}

/** Reset to 100% (actual size) about the viewport centre — clicking the % readout. */
export function zoomToActualSize(
  camera: { pan_x: number; pan_y: number; zoom: number },
  viewport: ViewportSize,
  limits: ZoomLimits = CANVAS_ZOOM_LIMITS,
): { pan_x: number; pan_y: number; zoom: number } {
  const z0 = camera.zoom > 0 ? camera.zoom : 1;
  const target = clamp(1, limits.min, limits.max);
  return safeCamera(zoomByFactor(camera, viewport, target / z0, limits), limits);
}

/** Axis-aligned bounding box of a set of world rects (null for an empty set). Non-finite
 *  rects are skipped so one bad frame can never poison the extent (→ NaN fit/minimap). */
export function framesBoundingBox(rects: WorldRect[]): WorldRect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, seen = 0;
  for (const r of rects) {
    if (!isFiniteRect(r)) continue;
    seen++;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  if (!seen) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Camera that fits a world bbox into the viewport with padding — the HUD "fit"
 *  (Mobbin: Fibery/Asana "Fit to view/screen"). Centres the bbox; clamps zoom to the
 *  engine limits. A degenerate/empty bbox returns the identity camera (nothing to fit). */
export function fitCamera(
  bbox: WorldRect | null,
  viewport: ViewportSize,
  padding = 48,
  limits: ZoomLimits = CANVAS_ZOOM_LIMITS,
): { pan_x: number; pan_y: number; zoom: number } {
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) return { pan_x: 0, pan_y: 0, zoom: 1 };
  const availW = Math.max(1, viewport.w - 2 * padding);
  const availH = Math.max(1, viewport.h - 2 * padding);
  const zoom = clamp(Math.min(availW / bbox.w, availH / bbox.h), limits.min, limits.max);
  const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
  return safeCamera({
    pan_x: viewport.w / 2 - cx * zoom,
    pan_y: viewport.h / 2 - cy * zoom,
    zoom,
  }, limits);
}

/** Camera that re-centres the view on a WORLD point, keeping the current zoom.
 *  This is the minimap-navigation conversion: the shared `CanvasMinimap` does ALL
 *  its own world↔map scaling internally and emits the world point that should land
 *  at the viewport centre (`onJump(worldX, worldY)`); we only turn that into a pan.
 *  pan = viewportCentre − world·zoom (engine convention screen = world·zoom + pan). */
export function cameraCenteredOnWorld(
  worldX: number,
  worldY: number,
  camera: { pan_x: number; pan_y: number; zoom: number },
  viewport: ViewportSize,
): { pan_x: number; pan_y: number; zoom: number } {
  const z = camera.zoom > 0 ? camera.zoom : 1;
  return safeCamera({
    pan_x: viewport.w / 2 - worldX * z,
    pan_y: viewport.h / 2 - worldY * z,
    zoom: z,
  });
}
