// packages/documents/do-work/build-panel-group-transaction.ts
//
// The COLLAPSE-TO-TAB primitive for a multi-panel "command center" (§C #7).
//
// A panel group is a Flex ROW (`LayoutMode::Flex`, axis x): each panel is a
// FlexGrow child (`style.flex = 1`) that absorbs equal width. Collapse turns ONE
// panel into a fixed-width in-place SPINE — engine-native via the flex/explicit
// duality the engine already implements (composition-engine-core layout.rs
// `SizingMode::from_style`, ~122-144): a child with `style.flex > 0` is FlexGrow;
// a child with `style.width` and no flex is Explicit (a fixed size). So a collapsed
// panel is `{ flex: 0, width: SPINE_PX }` — the engine reserves exactly SPINE_PX
// and the visible siblings fill the rest. NO new backend type, NO engine change:
// Flex already expresses fixed + grow. Split's pure-fraction model (`SplitPart =
// { fraction }`) CANNOT express a guaranteed-width spine — which is why this is a
// Flex group, not a Split (Codex-converged 2026-06-21, "SWITCH TO FLEX";
// convergence/2026-06-21-collapse-to-tab-design-fork.md).
//
// Restore is EXACT (Codex must-fix #3): collapse stashes the prior flex factor in a
// generic `style.collapsed` number; expand restores `flex` and clears `width` +
// `collapsed`. Self-describing — the host never needs parent context: a node IS a
// panel when `style.flex != null`, and IS collapsed when `style.collapsed` is a
// number. The host renders the spine for a collapsed node (generic chrome for a
// generic layout state, like `visible`/`selected` — zero Society vocabulary).

import type { CompositionTransaction, SceneNode } from '../read-data/documents';

/** Fixed on-screen width (px) of a collapsed panel's spine — a thin labelled rail. */
export const SPINE_PX = 36;

/** Default gap between panels (px) — matches the split reference density. */
export const DEFAULT_PANEL_GAP_PX = 12;

// ---------------------------------------------------------------------------
// 1. Build a panel group (pure data — the engine lays it out as Flex)
// ---------------------------------------------------------------------------

export type MakePanelGroupOptions = {
  /** Number of panels (clamped to >= 2). */
  panels: number;
  /** Main axis: 'x' = side-by-side panels (default). */
  axis?: 'x' | 'y';
  /** Gap between panels in px. */
  gap?: number;
  /** Produces a fresh, unique node id. */
  makeId: () => string;
  /** Produces one empty panel child (e.g. the surface's blank flow node). */
  makePanel: () => SceneNode;
};

/**
 * Build an N-panel Flex group: a Flex row whose children each FlexGrow equally
 * (`style.flex = 1`). The engine renders equal panels; collapse then turns one
 * into a fixed spine while the others re-expand to fill — for FREE, because the
 * engine re-distributes the remaining width across the FlexGrow children.
 */
export function makePanelGroup(options: MakePanelGroupOptions): SceneNode {
  if (!Number.isFinite(options.panels) || !Number.isSafeInteger(Math.floor(options.panels))) {
    throw new Error('The number of panels must be a finite safe number.');
  }
  const panels = Math.max(2, Math.floor(options.panels));
  const axis = options.axis ?? 'x';
  const gap = options.gap ?? DEFAULT_PANEL_GAP_PX;
  const children: SceneNode[] = [];
  for (let i = 0; i < panels; i += 1) {
    const panel = options.makePanel();
    children.push({ ...panel, props: withStyle(panel.props, { flex: 1 }) });
  }
  return {
    id: options.makeId(),
    kind: 'Container',
    props: { style: { layout: { mode: 'flex', axis, gap } } },
    visible: true,
    children,
  };
}

// ---------------------------------------------------------------------------
// 2. Detection (self-describing — no parent context, no Society marker)
// ---------------------------------------------------------------------------

/** True when a node participates in a flex group — expanded (`flex>0`) or collapsed (stash present). */
export function isPanelNode(node: SceneNode | null | undefined): boolean {
  const style = styleOf(node);
  if (!style) return false;
  return typeof style.flex === 'number' || typeof style.collapsed === 'number';
}

/** True when a node is a COLLAPSED panel: it carries the `collapsed` stash (the flex to restore). */
export function isCollapsedPanel(node: SceneNode | null | undefined): boolean {
  const style = styleOf(node);
  return !!style && typeof style.collapsed === 'number';
}

/** The flex factor to restore on expand (defaults to 1 for a malformed/zero stash). */
export function collapsedFlexOf(node: SceneNode | null | undefined): number {
  const style = styleOf(node);
  return style && typeof style.collapsed === 'number' && Number.isFinite(style.collapsed) && style.collapsed > 0 ? style.collapsed : 1;
}

// ---------------------------------------------------------------------------
// 3. Collapse / expand transactions (one UPDATE_PROPS each; pure)
// ---------------------------------------------------------------------------

/**
 * Collapse a panel to a fixed-width spine: `flex:0` + `width:SPINE_PX` (Explicit
 * wins in the engine → it reserves exactly SPINE_PX), stashing the prior flex in
 * `style.collapsed` for an exact restore. No-op if already collapsed or not a panel.
 */
export function collapsePanelTransaction(node: SceneNode | null | undefined): CompositionTransaction {
  if (!node || isCollapsedPanel(node) || !isPanelNode(node)) return { scene_patches: [] };
  const style = styleOf(node) ?? {};
  if (typeof style.flex === 'number' && !Number.isFinite(style.flex)) throw new Error('The panel proportion must be finite.');
  const prevFlex = typeof style.flex === 'number' && style.flex > 0 ? style.flex : 1;
  const nextStyle: Record<string, unknown> = { ...style, flex: 0, width: SPINE_PX, collapsed: prevFlex };
  return updatePropsTx(node, nextStyle);
}

/**
 * Expand a collapsed panel: restore its prior flex factor and clear the spine
 * width + the stash. No-op if the node is not a collapsed panel.
 */
export function expandPanelTransaction(node: SceneNode | null | undefined): CompositionTransaction {
  if (!node || !isCollapsedPanel(node)) return { scene_patches: [] };
  const style = styleOf(node) ?? {};
  if (typeof style.collapsed === 'number' && !Number.isFinite(style.collapsed)) throw new Error('The saved panel proportion must be finite.');
  const restoreFlex = collapsedFlexOf(node);
  const nextStyle: Record<string, unknown> = { ...style, flex: restoreFlex };
  delete nextStyle.width;
  delete nextStyle.collapsed;
  return updatePropsTx(node, nextStyle);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function styleOf(node: SceneNode | null | undefined): Record<string, unknown> | null {
  const props = isRecord(node?.props) ? (node!.props as Record<string, unknown>) : null;
  return props && isRecord(props.style) ? (props.style as Record<string, unknown>) : null;
}

/** Spread a node's props, merging the given style keys onto `props.style`. */
function withStyle(props: unknown, styleKeys: Record<string, unknown>): Record<string, unknown> {
  const existing = isRecord(props) ? props : {};
  const style = isRecord(existing.style) ? existing.style : {};
  return { ...existing, style: { ...style, ...styleKeys } };
}

/**
 * One UPDATE_PROPS patch replacing the node's props wholesale (the engine replaces,
 * not merges) with its existing props + the new style object.
 */
function updatePropsTx(node: SceneNode, nextStyle: Record<string, unknown>): CompositionTransaction {
  const existingProps = isRecord(node.props) ? node.props : {};
  return {
    scene_patches: [
      {
        type: 'UPDATE_PROPS',
        node_id: node.id,
        changes: { props: { ...existingProps, style: nextStyle } },
      },
    ],
  };
}
