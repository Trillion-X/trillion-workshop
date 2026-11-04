// packages/screen-arrangement/read-data/read-screen-arrangement.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Layout state persistence helpers. Read ownership is declared by package data;
// the active path is one canonical direct JSON layout-state record, while older
// logs may still expose a legacy RTBL row feed that is used only for one-way
// migration into the canonical record. Auto-save on state changes (debounced).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Save is debounced (300ms) to prevent hammering during resize
// 2. Active read path is package-data declared as `layout-state`
// 3. Missing sink payload → use DEFAULT_LAYOUT_STATE
// 4. Persistence is fire-and-forget — UI never blocks on save
// 5. Legacy RTBL rows are migration-only, not an active state family
// 6. No component-authored storage batches
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type {
  ArrangementLayer,
  FloatingLayout,
  LayoutContainer,
  LayoutState,
  LayoutSurface,
  OverlayLayout,
  SplitTreeNode,
  TabGroup,
  TabMeta,
  TiledLayout,
} from "./layout-types";
import { DEFAULT_LAYOUT_STATE } from "./layout-types";
import {
  DEFAULT_SURFACE_MODE,
  baseGeometryForSurface,
} from "./surface-modes";
import {
  isNodeBookmarkRecord,
  type NodeBookmarkRecord,
} from "./node-bookmark-types";
import {
  isNodeHistoryRecord,
  type NodeHistoryRecord,
} from "./node-history-types";
import { normalizeArrangementHistory } from './arrangement-history';
import type { VisualLayerStackRecord } from '../../ui/show/visual-layer-stack';
import {
  type LayoutStatePersistence,
  isBrowserLocalLayoutStatePersistence,
  isUnavailableBrowserLocalLayoutStatePersistence,
  writeBrowserLocalLayoutState,
  readLayoutStateChangedCells,
  writeLayoutState,
  writeLayoutStateDelta,
  writeLayoutStateValue,
  layoutStateIdentity,
  layoutStateWriteRefused,
} from "../do-work/save-layout-state";
import { readProjectedRows } from "./read-projected-rows";
import { normalizeTabBarPlacement, normalizeTabBarView } from './tab-bar-placement';

export { readLayoutStateChangedCells } from "../do-work/save-layout-state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isComponentMaterialIdentity(value: string | null): value is string {
  return value?.startsWith("component:") === true;
}

function readPackageEntry(
  value: unknown,
): { packageName: string; entryName: string } | null {
  if (!isRecord(value)) return null;
  const packageName =
    readString(value.packageName) ?? readString(value.package_name);
  const entryName = readString(value.entryName) ?? readString(value.entry_name);
  if (!packageName || !entryName) return null;
  return { packageName, entryName };
}

function defaultFloatingLayout(): FloatingLayout {
  const floating = DEFAULT_LAYOUT_STATE.layouts.find(
    (layout): layout is FloatingLayout => layout.type === "floating",
  );
  return floating
    ? {
        type: "floating",
        containers: [...floating.containers],
        camera: { ...floating.camera },
      }
    : { type: "floating", containers: [], camera: { scale: 1, tx: 0, ty: 0 } };
}

function defaultOverlayLayout(): OverlayLayout {
  const overlay = DEFAULT_LAYOUT_STATE.layouts.find(
    (layout): layout is OverlayLayout => layout.type === "overlay",
  );
  return overlay
    ? {
        type: "overlay",
        containers: [...overlay.containers],
      }
    : { type: "overlay", containers: [] };
}

function normalizeLayouts(layouts: unknown): LayoutSurface[] {
  const surfaces = new Map<LayoutSurface["type"], LayoutSurface>();
  if (Array.isArray(layouts)) {
    for (const layout of layouts) {
      if (
        !layout ||
        typeof layout !== "object" ||
        typeof (layout as { type?: unknown }).type !== "string"
      ) {
        continue;
      }

      if ((layout as { type: string }).type === "tiled") {
        surfaces.set("tiled", {
          type: "tiled",
          root: (layout as Partial<TiledLayout>).root ?? null,
        });
        continue;
      }

      if ((layout as { type: string }).type === "floating") {
        const floating = layout as Partial<FloatingLayout>;
        surfaces.set("floating", {
          type: "floating",
          containers: Array.isArray(floating.containers)
            ? floating.containers
            : [],
          camera: {
            scale: Number.isFinite(floating.camera?.scale)
              ? floating.camera.scale
              : 1,
            tx: Number.isFinite(floating.camera?.tx) ? floating.camera.tx : 0,
            ty: Number.isFinite(floating.camera?.ty) ? floating.camera.ty : 0,
            ...(Number.isFinite(floating.camera?.min)
              ? { min: floating.camera.min }
              : {}),
            ...(Number.isFinite(floating.camera?.max)
              ? { max: floating.camera.max }
              : {}),
          },
        });
        continue;
      }

      if ((layout as { type: string }).type === "overlay") {
        const overlay = layout as Partial<OverlayLayout>;
        surfaces.set("overlay", {
          type: "overlay",
          containers: Array.isArray(overlay.containers)
            ? overlay.containers
            : [],
        });
      }
    }
  }

  return [
    surfaces.get("tiled") ?? { type: "tiled", root: null },
    surfaces.get("floating") ?? defaultFloatingLayout(),
    surfaces.get("overlay") ?? defaultOverlayLayout(),
  ];
}

function normalizeContainers(
  rawContainers: unknown,
): Record<string, LayoutContainer> {
  if (!isRecord(rawContainers)) return DEFAULT_LAYOUT_STATE.containers;
  const containers: Record<string, LayoutContainer> = {};
  for (const [key, rawContainer] of Object.entries(rawContainers)) {
    if (!isRecord(rawContainer)) continue;
    const id = readString(rawContainer.id) ?? key;
    const groupId =
      readString(rawContainer.groupId) ?? readString(rawContainer.group_id);
    if (!groupId) continue;
    containers[id] = { id, groupId };
  }
  return containers;
}

function normalizeTabGroups(rawTabGroups: unknown): Record<string, TabGroup> {
  if (!isRecord(rawTabGroups)) return DEFAULT_LAYOUT_STATE.tabGroups;
  const groups: Record<string, TabGroup> = {};
  for (const [key, rawGroup] of Object.entries(rawTabGroups)) {
    if (!isRecord(rawGroup)) continue;
    const rawTabIds = rawGroup.tabIds ?? rawGroup.tab_ids;
    const tabIds = Array.isArray(rawTabIds)
      ? rawTabIds.filter(
          (tabId): tabId is string =>
            typeof tabId === "string" && tabId.length > 0,
        )
      : [];
    groups[key] = {
      tabIds,
      activeTabId:
        readString(rawGroup.activeTabId) ?? readString(rawGroup.active_tab_id),
    };
  }
  return groups;
}

function normalizeTab(rawTab: unknown, fallbackId: string): TabMeta | null {
  if (!isRecord(rawTab)) return null;
  const id = readString(rawTab.id) ?? fallbackId;
  const explicitTarget = readString(rawTab.target);
  const explicitMaterialTarget =
    readString(rawTab.materialTarget) ?? readString(rawTab.material_target);
  const packageEntry = readPackageEntry(
    rawTab.packageEntry ?? rawTab.package_entry,
  );
  const targetIsMaterial = isComponentMaterialIdentity(explicitTarget);
  const materialTarget =
    explicitMaterialTarget ?? (targetIsMaterial ? explicitTarget : null);
  const metadata = isRecord(rawTab.metadata) ? rawTab.metadata : undefined;
  const icon = readString(rawTab.icon);
  const pinned = readBoolean(rawTab.pinned);
  const closable = readBoolean(rawTab.closable);
  return {
    id,
    title: readString(rawTab.title) ?? id,
    target: targetIsMaterial ? null : explicitTarget,
    ...(packageEntry ? { packageEntry } : {}),
    ...(materialTarget ? { materialTarget } : {}),
    ...(icon ? { icon } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(closable !== undefined ? { closable } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeTabs(rawTabs: unknown): Record<string, TabMeta> {
  if (!isRecord(rawTabs)) return DEFAULT_LAYOUT_STATE.tabs;
  const tabs: Record<string, TabMeta> = {};
  for (const [key, rawTab] of Object.entries(rawTabs)) {
    const tab = normalizeTab(rawTab, key);
    if (!tab) continue;
    tabs[tab.id] = tab;
  }
  return tabs;
}

function cloneContainers(
  containers: Record<string, LayoutContainer>,
): Record<string, LayoutContainer> {
  return Object.fromEntries(
    Object.entries(containers).map(([id, container]) => [id, { ...container }]),
  );
}

function cloneTabGroups(
  tabGroups: Record<string, TabGroup>,
): Record<string, TabGroup> {
  return Object.fromEntries(
    Object.entries(tabGroups).map(([id, group]) => [
      id,
      {
        tabIds: [...group.tabIds],
        activeTabId: group.activeTabId,
      },
    ]),
  );
}

function cloneTabs(tabs: Record<string, TabMeta>): Record<string, TabMeta> {
  return Object.fromEntries(
    Object.entries(tabs).map(([id, tab]) => [
      id,
      {
        ...tab,
        ...(tab.packageEntry ? { packageEntry: { ...tab.packageEntry } } : {}),
        ...(tab.metadata ? { metadata: { ...tab.metadata } } : {}),
      },
    ]),
  );
}

function normalizeSplitTreeNode(
  node: unknown,
  containerIds: ReadonlySet<string>,
): SplitTreeNode | null {
  if (!isRecord(node)) return null;
  if (node.kind === "leaf") {
    const containerId =
      readString(node.containerId) ?? readString(node.container_id);
    return containerId && containerIds.has(containerId)
      ? { kind: "leaf", containerId }
      : null;
  }
  if (node.kind !== "split") return null;
  // Each kept child keeps its own lengths: they are read by the child's place in the saved split, not its place
  // after any empty child is dropped.
  const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
  const rawCross = Array.isArray(node.crossSizes) ? node.crossSizes : [];
  const kept = Array.isArray(node.children)
    ? node.children.flatMap((child, at) => {
        const normalized = normalizeSplitTreeNode(child, containerIds);
        return normalized ? [{ child: normalized, at }] : [];
      })
    : [];
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  // A pixel split's sizes are each pane's own length; losing the unit here
  // would read them back as shares and every dragged width would reset.
  const pixels = node.sizeUnit === "px";
  const fallbackSize = pixels ? 0 : 1 / kept.length;
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  const cross = kept.map(({ at }) => (positive(rawCross[at]) ? rawCross[at] : null));
  return {
    kind: "split",
    dir: node.dir === "column" ? "column" : "row",
    children: kept.map(({ child }) => child),
    sizes: kept.map(({ at }) => (positive(rawSizes[at]) ? rawSizes[at] : fallbackSize)),
    ...(pixels ? { sizeUnit: "px" as const } : {}),
    ...(cross.some((length) => length !== null) ? { crossSizes: cross } : {}),
    ...(pixels && node.keepLengths === true ? { keepLengths: true } : {}),
    ...(positive(node.stackBelow) ? { stackBelow: node.stackBelow } : {}),
  };
}

function normalizeLayoutSurfaces(
  layouts: LayoutSurface[],
  containerIds: ReadonlySet<string>,
  firstContainerId: string | null,
  populateTiledFallback = true,
): LayoutSurface[] {
  return layouts.map((layout) => {
    if (layout.type === "tiled") {
      return {
        type: "tiled",
        root:
          normalizeSplitTreeNode(layout.root, containerIds) ??
          (populateTiledFallback && firstContainerId
            ? { kind: "leaf", containerId: firstContainerId }
            : null),
      };
    }
    if (layout.type === "floating") {
      return {
        ...layout,
        containers: layout.containers
          .filter((entry) => containerIds.has(entry.containerId))
          .map((entry) => ({ ...entry })),
        camera: { ...layout.camera },
      };
    }
    return {
      ...layout,
      containers: layout.containers
        .filter((entry) => containerIds.has(entry.containerId))
        .map((entry) => ({ ...entry })),
    };
  });
}

function normalizeLayoutGraph(state: LayoutState): LayoutState {
  let containers = cloneContainers(state.containers);
  let rawTabGroups = cloneTabGroups(state.tabGroups);
  let rawTabs = cloneTabs(state.tabs);

  if (Object.keys(containers).length === 0) {
    containers = cloneContainers(DEFAULT_LAYOUT_STATE.containers);
    rawTabGroups = cloneTabGroups(DEFAULT_LAYOUT_STATE.tabGroups);
    rawTabs = cloneTabs(DEFAULT_LAYOUT_STATE.tabs);
  }

  const containerIds = new Set(Object.keys(containers));
  const usedGroupIds = new Set(
    Object.values(containers).map((container) => container.groupId),
  );
  const assignedTabIds = new Set<string>();
  const tabGroups: Record<string, TabGroup> = {};

  for (const groupId of usedGroupIds) {
    const rawGroup = rawTabGroups[groupId] ?? { tabIds: [], activeTabId: null };
    const tabIds: string[] = [];
    for (const tabId of rawGroup.tabIds) {
      if (!rawTabs[tabId] || assignedTabIds.has(tabId)) continue;
      assignedTabIds.add(tabId);
      tabIds.push(tabId);
    }
    tabGroups[groupId] = {
      tabIds,
      activeTabId:
        rawGroup.activeTabId && tabIds.includes(rawGroup.activeTabId)
          ? rawGroup.activeTabId
          : (tabIds[0] ?? null),
    };
  }

  const tabs: Record<string, TabMeta> = {};
  for (const tabId of assignedTabIds) {
    tabs[tabId] = rawTabs[tabId];
  }

  const firstContainerId = Object.keys(containers)[0] ?? null;
  return {
    ...state,
    containers,
    tabGroups,
    tabs,
    layouts: normalizeLayoutSurfaces(
      state.layouts,
      containerIds,
      firstContainerId,
    ),
    focusedContainerId:
      state.focusedContainerId && containerIds.has(state.focusedContainerId)
        ? state.focusedContainerId
        : firstContainerId,
    maximizedContainerId:
      state.maximizedContainerId && containerIds.has(state.maximizedContainerId)
        ? state.maximizedContainerId
        : null,
  };
}

export function normalizeLayoutState(state: Partial<LayoutState>): LayoutState {
  const visualLayerStacks = normalizeVisualLayerStacks(state.visualLayerStacks);
  const nodeBookmarks = normalizeNodeBookmarks(state.nodeBookmarks);
  const nodeHistory = normalizeNodeHistory(state.nodeHistory);
  const arrangementHistory = normalizeArrangementHistory(state.arrangementHistory);
  const regionChrome = normalizeRegionChrome(state.regionChrome);
  const containers = normalizeContainers(state.containers);
  const tabBarPlacement = normalizeTabBarPlacement(state.tabBarPlacement, new Set(Object.keys(containers)));
  const tabBarView = normalizeTabBarView(state.tabBarView, new Set(Object.keys(containers)));
  // The floating windows a press outside closes (place-tab-in-overlay.ts): only windows that exist, only `true`.
  const closeOnOutsidePress = Object.fromEntries(Object.entries(isRecord(state.closeOnOutsidePress) ? state.closeOnOutsidePress : {})
    .filter(([id, closes]) => closes === true && id in containers));
  // Where focus goes back to when a floating window closes (place-tab-in-overlay.ts): only between panes that exist.
  const focusReturnsTo = Object.fromEntries(Object.entries(isRecord(state.focusReturnsTo) ? state.focusReturnsTo : {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] in containers && entry[1] in containers && entry[0] !== entry[1]));
  const legacyLayouts = normalizeLayouts(state.layouts);
  const rawLayers = Array.isArray(state.layers) ? state.layers : [];
  const layers: ArrangementLayer[] = rawLayers.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const id = readString(raw.id);
    if (!id) return [];
    const name = readString(raw.name) ?? undefined;
    const z = typeof raw.z === 'number' && Number.isFinite(raw.z) ? raw.z : index;
    const layerSurface = typeof raw.surface === 'string' ? raw.surface : undefined;
    return [{ id, ...(name ? { name } : {}), z, ...(layerSurface ? { surface: layerSurface } : {}), layouts: normalizeLayouts(raw.layouts) }];
  });
  const uniqueLayers = layers.filter((layer, index) => layers.findIndex((candidate) => candidate.id === layer.id) === index);
  const activeLayerId = uniqueLayers.some((layer) => layer.id === state.activeLayerId)
    ? state.activeLayerId!
    : uniqueLayers[0]?.id;
  const projectedLayouts = uniqueLayers.find((layer) => layer.id === activeLayerId)?.layouts ?? legacyLayouts;
  const normalized = normalizeLayoutGraph({
    layouts: projectedLayouts,
    containers,
    tabs: normalizeTabs(state.tabs),
    tabGroups: normalizeTabGroups(state.tabGroups),
    focusedContainerId: state.focusedContainerId ?? null,
    maximizedContainerId: state.maximizedContainerId ?? null,
    surface: typeof state.surface === "string" ? state.surface : DEFAULT_SURFACE_MODE,
    ...(isChromeMap(state.chrome) ? { chrome: state.chrome } : {}),
    ...(Object.keys(regionChrome).length > 0 ? { regionChrome } : {}),
    ...(Object.keys(tabBarPlacement).length > 0 ? { tabBarPlacement } : {}),
    ...(Object.keys(tabBarView).length > 0 ? { tabBarView } : {}),
    ...(Object.keys(closeOnOutsidePress).length > 0 ? { closeOnOutsidePress } : {}),
    ...(Object.keys(focusReturnsTo).length > 0 ? { focusReturnsTo } : {}),
    ...(Object.keys(visualLayerStacks).length > 0 ? { visualLayerStacks } : {}),
    ...(Object.keys(nodeBookmarks).length > 0 ? { nodeBookmarks } : {}),
    ...(Object.keys(nodeHistory).length > 0 ? { nodeHistory } : {}),
    ...(arrangementHistory ? { arrangementHistory } : {}),
    ...(uniqueLayers.length > 0 ? {
      layers: uniqueLayers.map((layer) => ({
        ...layer,
        surface: layer.surface ?? (layer.id === activeLayerId && typeof state.surface === 'string' ? state.surface : DEFAULT_SURFACE_MODE),
      })),
      activeLayerId,
      surface: uniqueLayers.find((layer) => layer.id === activeLayerId)?.surface
        ?? (typeof state.surface === 'string' ? state.surface : DEFAULT_SURFACE_MODE),
    } : {}),
  });
  if (normalized.layers) {
    const containerIds = new Set(Object.keys(normalized.containers));
    const firstContainerId = Object.keys(normalized.containers)[0] ?? null;
    normalized.layers = normalized.layers.map((layer) => ({
      ...layer,
      layouts: normalizeLayoutSurfaces(layer.layouts, containerIds, firstContainerId, false),
    }));
    normalized.layouts = normalized.layers.find((layer) => layer.id === normalized.activeLayerId)?.layouts ?? normalized.layouts;
    normalized.surface = normalized.layers.find((layer) => layer.id === normalized.activeLayerId)?.surface ?? normalized.surface;
  }
  return normalized;
}

/** Preserve node navigation history across read/write. Kind-blind: keeps any
 *  well-formed history record, clamps an out-of-range cursor, drops malformed. */
function normalizeNodeHistory(
  raw: unknown,
): Record<string, NodeHistoryRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, NodeHistoryRecord> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isNodeHistoryRecord(value)) continue;
    const cursor = Math.max(-1, Math.min(value.cursor, value.entries.length - 1));
    out[key] = { ...value, cursor };
  }
  return out;
}

/**
 * Preserve node bookmarks across read/write. Without this they would be silently
 * dropped (like any unknown LayoutState field). Generic — kind-blind: keeps any
 * well-formed bookmark record, drops malformed ones, never enumerates families.
 */
function normalizeNodeBookmarks(
  raw: unknown,
): Record<string, NodeBookmarkRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, NodeBookmarkRecord> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isNodeBookmarkRecord(value)) out[key] = value;
  }
  return out;
}

/** A layer descriptor must have a stable id and a paint capability id. */
function isLayerDescriptor(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const layer = value as Record<string, unknown>;
  if (typeof layer.id !== "string") return false;
  const paint = layer.paint as Record<string, unknown> | undefined;
  const capability = paint?.capability as Record<string, unknown> | undefined;
  return !!capability && typeof capability.capabilityId === "string";
}

/**
 * Preserve region visual layer stacks across read/write. Without this they would
 * be silently dropped (like any unknown LayoutState field). Generic — kind-blind:
 * keeps any well-formed `visual-layer-stack` record, drops malformed layers but
 * keeps their valid siblings; never enumerates capability kinds.
 */
function normalizeVisualLayerStacks(
  raw: unknown,
): Record<string, VisualLayerStackRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, VisualLayerStackRecord> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.kind !== "visual-layer-stack" || record.version !== 1) continue;
    if (!Array.isArray(record.layers)) continue;
    const region = record.region as VisualLayerStackRecord["region"] | undefined;
    out[key] = {
      kind: "visual-layer-stack",
      version: 1,
      region: region && typeof region.family === "string"
        ? region
        : { family: key, parts: {} },
      layers: (record.layers as unknown[]).filter(isLayerDescriptor) as VisualLayerStackRecord["layers"],
    };
  }
  return out;
}

/** Chrome maps are flat zone-name -> boolean records; anything else is dropped. */
function isChromeMap(value: unknown): value is Record<string, boolean> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}

/** Preserve per-region chrome across read/write (region-key → chrome map). Keeps
 *  only well-formed region maps; drops malformed entries. Without this, the
 *  applyLayoutState→normalizeLayoutState path would silently drop regionChrome
 *  (an immersive region would revert on the next layout write). */
function normalizeRegionChrome(raw: unknown): Record<string, Record<string, boolean>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, boolean>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isChromeMap(value)) out[key] = value;
  }
  return out;
}

function countLeafNodes(node: SplitTreeNode | null): number {
  if (!node) return 0;
  if (node.kind === "leaf") return 1;
  return node.children.reduce(
    (sum, child) => sum + countLeafNodes(child),
    0,
  );
}

export function layoutStateRichnessScore(state: LayoutState): number {
  const containerCount = Object.keys(state.containers).length;
  const tabGroupCount = Object.keys(state.tabGroups).length;
  const tabCount = Object.keys(state.tabs).length;
  const materializedTabCount = Object.values(state.tabs).filter(
    (tab) => !!tab.target || !!tab.packageEntry || !!tab.materialTarget,
  ).length;
  const tiled = state.layouts.find(
    (layout): layout is TiledLayout => layout.type === "tiled",
  );
  const floating = state.layouts.find(
    (layout): layout is FloatingLayout => layout.type === "floating",
  );
  const overlay = state.layouts.find(
    (layout): layout is OverlayLayout => layout.type === "overlay",
  );
  return (
    materializedTabCount * 10000 +
    containerCount * 1000 +
    tabCount * 100 +
    tabGroupCount * 50 +
    countLeafNodes(tiled?.root ?? null) * 10 +
    (floating?.containers.length ?? 0) * 5 +
    (overlay?.containers.length ?? 0) * 3 +
    (baseGeometryForSurface(state.surface) === "floating" ? 1 : 0)
  );
}

function layoutPropertyStateKey(propertyId: string): string | null {
  if (propertyId === "prop:layout_state:layouts") return "layouts";
  if (propertyId === "prop:layout_state:containers") return "containers";
  if (propertyId === "prop:layout_state:tabs") return "tabs";
  if (propertyId === "prop:layout_state:tab_groups") return "tabGroups";
  if (propertyId === "prop:layout_state:focused_container_id") {
    return "focusedContainerId";
  }
  if (propertyId === "prop:layout_state:maximized_container_id") {
    return "maximizedContainerId";
  }
  if (propertyId === "prop:layout_state:surface") return "surface";
  if (propertyId === "prop:layout_state:layers") return "layers";
  if (propertyId === "prop:layout_state:active_layer_id") return "activeLayerId";
  if (propertyId === "prop:layout_state:chrome") return "chrome";
  return null;
}

function rowValue(row: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(row, "value_json")
    ? row.value_json
    : row.value;
}

function layoutStateCandidatesFromPropertyRows(rows: readonly unknown[]): Partial<LayoutState>[] {
  const candidates: Partial<LayoutState>[] = [];
  let state: Record<string, unknown> = {};
  let seenStateKeys = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const propertyId = readString(row.property_id) ?? readString(row.propertyId);
    if (!propertyId) continue;
    const stateKey = layoutPropertyStateKey(propertyId);
    if (!stateKey) continue;
    if (seenStateKeys.has(stateKey) && Object.keys(state).length > 0) {
      candidates.push(state as Partial<LayoutState>);
      state = {};
      seenStateKeys = new Set<string>();
    }
    state[stateKey] = rowValue(row);
    seenStateKeys.add(stateKey);
  }
  if (Object.keys(state).length > 0) candidates.push(state as Partial<LayoutState>);
  return candidates;
}

function looksLikeLayoutState(value: unknown): value is Partial<LayoutState> {
  return isRecord(value) && (
    Object.prototype.hasOwnProperty.call(value, "layouts")
    || Object.prototype.hasOwnProperty.call(value, "containers")
    || Object.prototype.hasOwnProperty.call(value, "tabs")
    || Object.prototype.hasOwnProperty.call(value, "tabGroups")
    || Object.prototype.hasOwnProperty.call(value, "tab_groups")
    || Object.prototype.hasOwnProperty.call(value, "surface")
    || Object.prototype.hasOwnProperty.call(value, "layers")
    || Object.prototype.hasOwnProperty.call(value, "activeLayerId")
  );
}

function layoutStateCandidatesFromRows(rows: readonly unknown[]): Partial<LayoutState>[] {
  const candidates: Partial<LayoutState>[] = [];
  candidates.push(...layoutStateCandidatesFromPropertyRows(rows));
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (looksLikeLayoutState(row.payload)) candidates.push(row.payload);
    else if (looksLikeLayoutState(row)) candidates.push(row);
  }
  return candidates;
}


export function decodeLayoutState(
  raw: unknown,
  fallback: Partial<LayoutState> = DEFAULT_LAYOUT_STATE,
): LayoutState {
  const fallbackState = normalizeLayoutState(fallback);
  if (raw === undefined || raw === null) return fallbackState;
  if (Array.isArray(raw)) {
    const states = layoutStateCandidatesFromRows(raw).map((candidate) =>
      normalizeLayoutState(candidate),
    );
    if (states.length === 0) return fallbackState;
    return states.sort(
      (left, right) => layoutStateRichnessScore(right) - layoutStateRichnessScore(left),
    )[0];
  }
  if (isRecord(raw)) {
    const payload = isRecord(raw.payload) ? raw.payload : raw;
    return normalizeLayoutState(payload as Partial<LayoutState>);
  }
  return fallbackState;
}

/** What a save did: `refused` when the store kept nothing because the copy it was made from is no longer what is kept,
 *  `identity` the identity the store keeps now when it wrote (a later save from this copy names it). */
export type LayoutStateSaveResult = { refused: boolean; identity: string | null };

export async function saveLayoutState(
  state: LayoutState,
  publication?: unknown,
  persistence?: LayoutStatePersistence,
  expectedIdentity?: string | null,
): Promise<LayoutStateSaveResult> {
  const canonicalState = normalizeLayoutState(state);
  if (persistence) {
    if (isUnavailableBrowserLocalLayoutStatePersistence(persistence)) return { refused: false, identity: null };
    if (isBrowserLocalLayoutStatePersistence(persistence)) {
      writeBrowserLocalLayoutState(canonicalState, persistence);
      return { refused: false, identity: null };
    }
    const reply = await writeLayoutStateValue(canonicalState, persistence, expectedIdentity);
    if (expectedIdentity !== undefined && layoutStateWriteRefused(reply)) return { refused: true, identity: null };
    return { refused: false, identity: layoutStateIdentity(canonicalState) };
  }
  const changedCells = readLayoutStateChangedCells(publication);
  if (
    changedCells !== null &&
    (await writeLayoutStateDelta(canonicalState, changedCells))
  )
    return { refused: false, identity: null };
  await writeLayoutState(canonicalState);
  return { refused: false, identity: null };
}

export function defaultLayoutState(): LayoutState {
  return normalizeLayoutState(DEFAULT_LAYOUT_STATE);
}

/**
 * The layer a person can currently work in, always one of the drawn `layers`. An empty layer paints nothing, so when
 * the chosen layer holds nothing the topmost layer that does stays usable instead of leaving visible work that ignores
 * every click. A remembered layer that is no longer drawn (out of date) is treated the same way, so some layer always
 * answers. New surfaces still land on the chosen layer; this decides only which layer receives pointer and keyboard
 * input.
 */
export function usableLayerId(
  layers: readonly Pick<ArrangementLayer, 'id' | 'z' | 'layouts'>[],
  activeLayerId: string,
  activeLayouts: readonly LayoutSurface[],
): string {
  const holdsSomething = (layouts: readonly LayoutSurface[]) => layouts.some((layout) =>
    layout.type === 'tiled' ? Boolean(layout.root) : layout.containers.length > 0);
  const chosenIsDrawn = layers.some((layer) => layer.id === activeLayerId);
  if (chosenIsDrawn && holdsSomething(activeLayouts)) return activeLayerId;
  const topFirst = [...layers].sort((left, right) => right.z - left.z);
  const topmost = topFirst.find((layer) => layer.id !== activeLayerId && holdsSomething(layer.layouts));
  if (topmost) return topmost.id;
  return chosenIsDrawn ? activeLayerId : topFirst[0]?.id ?? activeLayerId;
}
