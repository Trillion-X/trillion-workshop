// packages/screen-arrangement/read-data/place-tab-in-overlay.ts
//
// PURPOSE
// Pure layout composition: the arrangement a catalog open produces when a
// surface's DATA asks to open as a picture-in-picture window. It adds one
// container holding the tab, one overlay box for it on the active plane, and
// the window's own chrome map, and focuses it, remembering the pane that was
// focused (focusReturnsTo) so closing the window focuses that pane again. The caller applies the result
// with layoutActions.applyLayoutState, so moving, resizing, docking and closing
// the window afterwards are the arrangement's ordinary overlay operations.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Pure: returns a new state and never mutates the input.
// 2. The box always fits the viewport (margin kept on every side) and a new
//    window never lands exactly on an open one: it steps down and left.
// 3. Chrome from DATA applies to the new container's region only.

import type { LayoutState, LayoutSurface, OverlayBox, SplitTreeNode, TabMeta } from './layout-types';
import type { VisualLayerDescriptor, VisualLayerStackRecord } from '../../ui/show/visual-layer-stack/visual-layer-types';
import { containerRegion, overlayWindowRegions, regionAddressKey } from './region-address';

export interface OverlayPlacement {
  size?: { width: number; height: number };
  /** Where the window's centre sits, as fractions of the viewport; absent: top right, stepped away from open windows. */
  anchor?: { x: number; y: number };
  chrome?: Record<string, boolean>;
  /** Layer stacks by the region names `overlayWindowRegions` places (the window, the screen behind it). */
  looks?: Record<string, { layers: readonly Record<string, unknown>[]; frame?: Record<string, unknown> }>;
  closesOnOutside?: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

const DEFAULT_SIZE = { width: 400, height: 560 };
const MARGIN = 16;
const TOP = 56;
const STEP = 28;

function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  let index = 2;
  while (taken(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function withOverlayBox(layouts: LayoutSurface[], box: OverlayBox): LayoutSurface[] {
  let placed = false;
  const next = layouts.map((layout) => {
    if (layout.type !== 'overlay') return layout;
    placed = true;
    return { ...layout, containers: [...layout.containers, box] };
  });
  return placed ? next : [...next, { type: 'overlay', containers: [box] }];
}

// A window id an earlier, closed window used may come back; nothing that window left behind is inherited.
function withoutRegions<T>(map: Record<string, T> | undefined, regions: Record<string, { family: string; parts: Record<string, string> }>): Record<string, T> {
  const next = { ...(map ?? {}) };
  for (const region of Object.values(regions)) delete next[regionAddressKey(region)];
  return next;
}

function withoutKey<T>(map: Record<string, T> | undefined, key: string): Record<string, T> {
  const next = { ...(map ?? {}) };
  delete next[key];
  return next;
}

function overlayBoxes(layouts: readonly LayoutSurface[]): OverlayBox[] {
  return layouts.flatMap((layout) => (layout.type === 'overlay' ? layout.containers : []));
}

export function placeTabInOverlay(
  state: LayoutState,
  tab: TabMeta,
  placement: OverlayPlacement,
  viewport: Viewport,
): { state: LayoutState; containerId: string } {
  const containerId = uniqueId(`overlay-${tab.id}`, (id) => id in state.containers);
  const focusedBefore = state.focusedContainerId && state.focusedContainerId in state.containers ? state.focusedContainerId : null;
  const groupId = uniqueId(`${containerId}-group`, (id) => id in state.tabGroups);
  const tabId = uniqueId(tab.id, (id) => id in state.tabs);

  const activeLayouts = state.layers?.find((layer) => layer.id === state.activeLayerId)?.layouts ?? state.layouts;
  const open = overlayBoxes(activeLayouts);
  const wanted = placement.size ?? DEFAULT_SIZE;
  const w = Math.max(160, Math.min(wanted.width, viewport.width - MARGIN * 2));
  const h = Math.max(120, Math.min(wanted.height, viewport.height - TOP - MARGIN));
  const anchored = placement.anchor;
  let x = anchored ? Math.min(Math.max(MARGIN, anchored.x * viewport.width - w / 2), viewport.width - MARGIN - w) : viewport.width - MARGIN - w;
  let y = anchored ? Math.min(Math.max(MARGIN, anchored.y * viewport.height - h / 2), viewport.height - MARGIN - h) : TOP;
  while (open.some((box) => box.x === x && box.y === y)) {
    x = Math.max(MARGIN, x - STEP);
    y = Math.min(viewport.height - MARGIN - h, y + STEP);
    if (x === MARGIN || y === viewport.height - MARGIN - h) break;
  }
  const z = open.reduce((top, box) => Math.max(top, box.z), 0) + 1;
  const box: OverlayBox = { containerId, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), z };

  const chrome = placement.chrome && Object.keys(placement.chrome).length > 0 ? placement.chrome : null;
  const regions = overlayWindowRegions(containerId);
  const stacks: Record<string, VisualLayerStackRecord> = {};
  for (const [name, look] of Object.entries(placement.looks ?? {})) {
    const region = regions[name];
    if (!region || look.layers.length === 0) continue;
    stacks[regionAddressKey(region)] = {
      kind: 'visual-layer-stack', version: 1, region,
      layers: look.layers as unknown as readonly VisualLayerDescriptor[],
      ...(look.frame ? { frame: look.frame as VisualLayerStackRecord['frame'] } : {}),
    };
  }
  const next: LayoutState = {
    ...state,
    containers: { ...state.containers, [containerId]: { id: containerId, groupId } },
    tabGroups: { ...state.tabGroups, [groupId]: { tabIds: [tabId], activeTabId: tabId } },
    tabs: { ...state.tabs, [tabId]: { ...tab, id: tabId } },
    layouts: withOverlayBox(state.layouts, box),
    ...(state.layers ? {
      layers: state.layers.map((layer) => (
        layer.id === state.activeLayerId ? { ...layer, layouts: withOverlayBox(layer.layouts, box) } : layer
      )),
    } : {}),
    ...(chrome ? {
      regionChrome: { ...(state.regionChrome ?? {}), [regionAddressKey(containerRegion(containerId))]: { ...chrome } },
    } : {}),
    ...(state.visualLayerStacks || Object.keys(stacks).length > 0 ? { visualLayerStacks: { ...withoutRegions(state.visualLayerStacks, regions), ...stacks } } : {}),
    ...(state.closeOnOutsidePress || placement.closesOnOutside ? {
      closeOnOutsidePress: { ...withoutKey(state.closeOnOutsidePress, containerId), ...(placement.closesOnOutside ? { [containerId]: true } : {}) },
    } : {}),
    // The window remembers where the person was working, so what it opens lands there and closing it goes back there.
    ...(state.focusReturnsTo || focusedBefore ? {
      focusReturnsTo: { ...withoutKey(state.focusReturnsTo, containerId), ...(focusedBefore ? { [containerId]: focusedBefore } : {}) },
    } : {}),
    focusedContainerId: containerId,
  };
  return { state: next, containerId };
}

function tiledLeafIds(node: SplitTreeNode | null, out: string[]): string[] {
  if (!node) return out;
  if (node.kind === 'leaf') out.push(node.containerId);
  else for (const child of node.children) tiledLeafIds(child, out);
  return out;
}

/**
 * The container a floating window's tab docks into when the person asks to see
 * it as a tab: the first pane of the active plane's tiled tree. Null when the
 * plane has no tiled pane to dock into.
 */
export function dockTargetContainerId(state: LayoutState, fromContainerId: string): string | null {
  const activeLayouts = state.layers?.find((layer) => layer.id === state.activeLayerId)?.layouts ?? state.layouts;
  for (const layout of activeLayouts) {
    if (layout.type !== 'tiled') continue;
    const target = tiledLeafIds(layout.root, []).find((id) => id !== fromContainerId && id in state.containers);
    if (target) return target;
  }
  return null;
}

function withoutOverlayBox(layouts: LayoutSurface[], containerId: string): LayoutSurface[] {
  return layouts.map((layout) => (
    layout.type === 'overlay' ? { ...layout, containers: layout.containers.filter((box) => box.containerId !== containerId) } : layout
  ));
}

/**
 * A saved arrangement as a newly opened page shows it: a passing window (one a
 * press outside closes, `closeOnOutsidePress`) belonged to the page it was opened
 * on, so it never outlives it and never covers the screen a new address asks for.
 * Anything not shaped as an arrangement is returned as it is. Pure.
 */
export function withoutPassingWindows<T>(saved: T): T {
  const state = saved as unknown as Partial<LayoutState> | null;
  const passing = state && typeof state === 'object' && state.closeOnOutsidePress && typeof state.closeOnOutsidePress === 'object'
    ? Object.entries(state.closeOnOutsidePress).filter(([, closes]) => closes === true).map(([id]) => id)
    : [];
  if (!passing.length || !state?.containers || !state.tabGroups || !state.tabs || !Array.isArray(state.layouts)) return saved;
  return passing.reduce((next, id) => removeOverlayWindow(next, id), state as LayoutState) as unknown as T;
}

/**
 * Remove a floating window. With `dockInto`, its tabs move to the end of that
 * container's tab group and the window's active tab becomes active there;
 * without it, the window's tabs close with it. Pure.
 */
export function removeOverlayWindow(state: LayoutState, containerId: string, dockInto: string | null = null): LayoutState {
  const container = state.containers[containerId];
  if (!container) return state;
  const group = state.tabGroups[container.groupId];
  const tabIds = group?.tabIds ?? [];
  const target = dockInto ? state.containers[dockInto] : undefined;
  const containers = { ...state.containers };
  delete containers[containerId];
  const tabGroups = { ...state.tabGroups };
  delete tabGroups[container.groupId];
  const tabs = { ...state.tabs };
  if (target) {
    const targetGroup = tabGroups[target.groupId] ?? { tabIds: [], activeTabId: null };
    tabGroups[target.groupId] = {
      tabIds: [...targetGroup.tabIds, ...tabIds.filter((id) => !targetGroup.tabIds.includes(id))],
      activeTabId: group?.activeTabId ?? targetGroup.activeTabId,
    };
  } else {
    for (const id of tabIds) delete tabs[id];
  }
  const regionChrome = { ...(state.regionChrome ?? {}) };
  delete regionChrome[regionAddressKey(containerRegion(containerId))];
  // The window's own looks go with it; its tabs docked elsewhere keep their own.
  const visualLayerStacks = withoutRegions(state.visualLayerStacks, overlayWindowRegions(containerId));
  const closeOnOutsidePress = withoutKey(state.closeOnOutsidePress, containerId);
  // Focus goes back to the pane the window was opened from, when it is still there.
  const returnTo = state.focusReturnsTo?.[containerId];
  const focusReturnsTo = Object.fromEntries(Object.entries(state.focusReturnsTo ?? {})
    .filter(([window, pane]) => window !== containerId && pane !== containerId));
  return {
    ...state,
    containers,
    tabGroups,
    tabs,
    layouts: withoutOverlayBox(state.layouts, containerId),
    ...(state.layers ? { layers: state.layers.map((layer) => ({ ...layer, layouts: withoutOverlayBox(layer.layouts, containerId) })) } : {}),
    ...(state.regionChrome ? { regionChrome } : {}),
    ...(state.visualLayerStacks ? { visualLayerStacks } : {}),
    ...(state.closeOnOutsidePress ? { closeOnOutsidePress } : {}),
    ...(state.focusReturnsTo ? { focusReturnsTo } : {}),
    focusedContainerId: target
      ? dockInto
      : state.focusedContainerId === containerId ? (returnTo && returnTo in containers ? returnTo : null) : state.focusedContainerId,
    maximizedContainerId: state.maximizedContainerId === containerId ? null : state.maximizedContainerId,
  };
}
