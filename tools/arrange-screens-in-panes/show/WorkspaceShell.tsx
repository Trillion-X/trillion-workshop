// packages/screen-arrangement/show/WorkspaceShell.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The GENERIC, DATA-driven embedded-workspace shell (L069 generative primitive).
// A "workspace" is a DATA row: a placeable-surface (placed in main-workspace)
// whose surface_input carries the entire configuration. This ONE component
// renders ANY workspace — content, media, trading, a sports swing-analysis
// workspace, a basketball workspace, a book/vlog workspace — with ZERO new code
// per workspace and ZERO domain vocabulary in this file (L090). Adding a
// workspace = adding a DATA record; never a new shell component.
//
// surface_input contract (all Society DATA, all optional except placement_label):
//   {
//     header?: { label?: string, icon?: string },
//     placement_label: string,
//     selectors?: [{ id, source, id_paths, label_paths, ... }],
//     bindings?: [{ source, target }],
//     layout_recipe?: { direction, regions: [{ id, weight }], max_width/maxWidth? },
//     max_width/maxWidth?: positive pixel count (a centered reading/workspace column),
//     layout_state_input?: string,
//     persistence_address?: string,
//     chrome?: Record<string, boolean>,
//   }
//
// The shell discovers its panels from the canonical placeable-surface catalog filtered by
// placement_labels ∋ placement_label, auto-builds one tab per discovered panel,
// and hosts them via the existing EmbeddedScreenArrangement engine. It never
// enumerates a panel list, never names a package, never knows what domain it is.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Zero domain vocabulary — no "swing", "sport", "content", "match" anywhere.
// 2. Every config value comes from surface_input DATA (Society), never hardcoded.
// 3. Panels are DISCOVERED from the canonical catalog by placement label — never enumerated.
// 4. Components imported only from @/packages/ui (the firewall, L065/L066).
// 5. Reads only via useBitfieldData — never imports slot::workflow / slot::eeaf.
// =============================================================================

import * as React from 'react';
import { useBitfieldData } from '#workspace-records';

import { Container, Dropdown, Text, NamedIcon } from '../../ui';
import { EmbeddedScreenArrangement } from './EmbeddedScreenArrangement';
import { createBrowserLocalDestinationRef } from './surface-intent-destination-ref';
import { normalizeLayoutState } from '../read-data/read-screen-arrangement';
import type { LayoutState, SplitTreeNode, TabMeta } from '../read-data/layout-types';

interface DiscoveredPanel {
  id: string;
  label: string;
  icon?: string;
  materialTarget: string;
  packageEntry?: { packageName: string; entryName: string };
  order: number;
  region?: string;
  surfaceInput?: Record<string, unknown>;
}

type WorkspaceDataSelector =
  | string
  | { input: string; params?: Record<string, unknown> };

interface WorkspaceSelectorDescriptor {
  id: string;
  source: WorkspaceDataSelector;
  label?: string;
  initialValue?: string;
  where?: Array<{ path: string[]; equals?: unknown; in?: unknown[]; exists?: boolean }>;
  idPaths: string[][];
  labelPaths: string[][];
  iconPaths: string[][];
  orderPaths: string[][];
}

interface WorkspaceBindingDescriptor {
  source: {
    selectorId?: string;
    output?: {
      surfaceId?: string;
      name: string;
    };
    path?: string[];
    value?: unknown;
  };
  target: {
    surfaceId?: string;
    path: string[];
  };
}

interface WorkspaceRegion {
  id: string;
  weight: number;
  direction?: 'row' | 'column';
  children?: WorkspaceRegion[];
}

interface WorkspaceLayoutRecipe {
  direction: 'row' | 'column';
  regions: WorkspaceRegion[];
  maxWidthPx?: number;
}

function collectWorkspaceRegionIds(regions: readonly WorkspaceRegion[]): string[] {
  return regions.flatMap((region) => region.children?.length
    ? collectWorkspaceRegionIds(region.children)
    : [region.id]);
}

interface WorkspaceConfig {
  headerLabel?: string;
  headerIcon?: string;
  placementLabel: string;
  initialFocusRegion?: string;
  layoutStateInput?: string;
  persistenceAddress?: string;
  layoutMaxWidthPx?: number;
  chrome?: Record<string, boolean>;
  selectors: WorkspaceSelectorDescriptor[];
  bindings: WorkspaceBindingDescriptor[];
  layoutRecipe?: WorkspaceLayoutRecipe;
}

export interface WorkspaceSelectionOption {
  id: string;
  label: string;
  icon?: string;
  value: Record<string, unknown>;
}

export interface WorkspaceSurfaceOutput {
  surfaceId: string;
  name: string;
  value: unknown;
  revision?: string;
  sequence?: number;
  generation: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function readMaxWidthPx(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : undefined;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0
    ? numeric
    : undefined;
}

function readPaths(value: unknown, fallback: string[][]): string[][] {
  if (!Array.isArray(value)) return fallback;
  const paths = value.flatMap((candidate) => (
    Array.isArray(candidate) && candidate.every((part) => typeof part === 'string')
      ? [candidate]
      : []
  ));
  return paths.length > 0 ? paths : fallback;
}

function readDataSelector(value: unknown): WorkspaceDataSelector | undefined {
  const direct = readString(value);
  if (direct) return direct;
  if (!isRecord(value)) return undefined;
  const input = readString(value.input);
  if (!input) return undefined;
  return {
    input,
    ...(isRecord(value.params) ? { params: value.params } : {}),
  };
}

function readSelector(value: unknown): WorkspaceSelectorDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const sourceAddress = readString(value.source_address) ?? readString(value.sourceAddress);
  const source = readDataSelector(value.source)
    ?? readDataSelector(value.source_input ?? value.sourceInput)
    ?? (sourceAddress
      ? { input: 'selector-source-by-address-label', params: { addressLabel: sourceAddress } }
      : undefined);
  if (!id || !source) return undefined;
  const where = Array.isArray(value.where)
    ? value.where.flatMap((condition) => {
        if (!isRecord(condition) || !Array.isArray(condition.path)) return [];
        const path = condition.path.filter((part): part is string => typeof part === 'string');
        if (path.length !== condition.path.length) return [];
        return [{
          path,
          ...(Object.hasOwn(condition, 'equals') ? { equals: condition.equals } : {}),
          ...(Array.isArray(condition.in) ? { in: condition.in } : {}),
          ...(typeof condition.exists === 'boolean' ? { exists: condition.exists } : {}),
        }];
      })
    : undefined;
  return {
    id,
    source,
    label: readString(value.label),
    initialValue: readString(value.initial_value) ?? readString(value.initialValue),
    where,
    idPaths: readPaths(value.id_paths ?? value.idPaths, [['id']]),
    labelPaths: readPaths(value.label_paths ?? value.labelPaths, [['label'], ['name'], ['id']]),
    iconPaths: readPaths(value.icon_paths ?? value.iconPaths, [['icon']]),
    orderPaths: readPaths(value.order_paths ?? value.orderPaths, [['order']]),
  };
}

function readBinding(value: unknown): WorkspaceBindingDescriptor | undefined {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.target)) return undefined;
  const targetPath = Array.isArray(value.target.path)
    ? value.target.path.filter((part): part is string => typeof part === 'string')
    : [];
  if (targetPath.length === 0 || targetPath.length !== value.target.path.length) return undefined;
  const sourcePath = Array.isArray(value.source.path)
    ? value.source.path.filter((part): part is string => typeof part === 'string')
    : undefined;
  const outputValue = isRecord(value.source.output) ? value.source.output : undefined;
  const outputName = outputValue ? readString(outputValue.name) : undefined;
  return {
    source: {
      selectorId: readString(value.source.selector_id) ?? readString(value.source.selectorId),
      ...(outputName
        ? {
            output: {
              name: outputName,
              surfaceId: readString(outputValue?.surface_id) ?? readString(outputValue?.surfaceId),
            },
          }
        : {}),
      ...(sourcePath && sourcePath.length === value.source.path.length ? { path: sourcePath } : {}),
      ...(Object.hasOwn(value.source, 'value') ? { value: value.source.value } : {}),
    },
    target: {
      surfaceId: readString(value.target.surface_id) ?? readString(value.target.surfaceId),
      path: targetPath,
    },
  };
}

function outputKey(surfaceId: string, name: string): string {
  return `${surfaceId}\u0000${name}`;
}

/** Decode and scope one open child-output event to this workspace generation. */
export function readWorkspaceSurfaceOutput(
  detail: unknown,
  generation: number,
  panelIds: ReadonlySet<string>,
): WorkspaceSurfaceOutput | undefined {
  if (!isRecord(detail)) return undefined;
  const surfaceId = readString(detail.source_surface_id) ?? readString(detail.sourceSurfaceId);
  const name = readString(detail.name);
  const eventGeneration = typeof detail.generation === 'number' ? detail.generation : undefined;
  if (!surfaceId || !name || eventGeneration !== generation || !panelIds.has(surfaceId)) return undefined;
  return {
    surfaceId,
    name,
    value: detail.value,
    revision: readString(detail.revision),
    sequence: typeof detail.sequence === 'number' && Number.isFinite(detail.sequence)
      ? detail.sequence
      : undefined,
    generation: eventGeneration,
  };
}

function readLayoutRecipe(value: unknown): WorkspaceLayoutRecipe | undefined {
  if (!isRecord(value)) return undefined;
  const regions = Array.isArray(value.regions)
    ? value.regions.flatMap((candidate) => readLayoutRegion(candidate) ?? [])
    : [];
  if (regions.length === 0) return undefined;
  return {
    direction: value.direction === 'column' ? 'column' : 'row',
    regions,
    maxWidthPx: readMaxWidthPx(value.max_width ?? value.maxWidth),
  };
}

function readLayoutRegion(value: unknown, depth = 0, seen = new WeakSet<object>()): WorkspaceRegion | undefined {
  if (!isRecord(value) || depth >= 32 || seen.has(value)) return undefined;
  seen.add(value);
  const id = readString(value.id);
  const children = Array.isArray(value.children)
    ? value.children.flatMap((candidate) => readLayoutRegion(candidate, depth + 1, seen) ?? [])
    : [];
  if (children.length > 0) {
    if (!id && typeof value.direction !== 'string') return undefined;
    return {
      id: id ?? `region-${children.map((child) => child.id).join('-')}`,
      weight: readLayoutWeight(value.weight),
      direction: value.direction === 'column' ? 'column' : 'row',
      children,
    };
  }
  if (!id) return undefined;
  return { id, weight: readLayoutWeight(value.weight) };
}

function readLayoutWeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function firstLayoutRegionId(regions: readonly WorkspaceRegion[]): string | undefined {
  for (const region of regions) {
    if (region.children?.length) {
      const nested = firstLayoutRegionId(region.children);
      if (nested) return nested;
    } else if (region.id) {
      return region.id;
    }
  }
  return undefined;
}

/** Parse the workspace config out of surface_input DATA. The placement label is required. */
export function readWorkspaceConfig(surfaceInput: Record<string, unknown> | undefined): WorkspaceConfig | null {
  if (!isRecord(surfaceInput)) return null;
  const placementLabel = readString(surfaceInput.placement_label) ?? readString(surfaceInput.placementLabel);
  if (!placementLabel) return null;
  const header = isRecord(surfaceInput.header) ? surfaceInput.header : {};
  const chrome = isRecord(surfaceInput.chrome) ? (surfaceInput.chrome as Record<string, boolean>) : undefined;
  const layoutRecipe = readLayoutRecipe(surfaceInput.layout_recipe ?? surfaceInput.layoutRecipe);
  return {
    headerLabel: readString(header.label),
    headerIcon: readString(header.icon),
    placementLabel,
    initialFocusRegion: readString(surfaceInput.initial_focus_region) ?? readString(surfaceInput.initialFocusRegion),
    layoutStateInput: readString(surfaceInput.layout_state_input) ?? readString(surfaceInput.layoutStateInput),
    persistenceAddress: readString(surfaceInput.persistence_address) ?? readString(surfaceInput.persistenceAddress),
    layoutMaxWidthPx: layoutRecipe?.maxWidthPx
      ?? readMaxWidthPx(surfaceInput.max_width ?? surfaceInput.maxWidth),
    chrome,
    selectors: Array.isArray(surfaceInput.selectors)
      ? surfaceInput.selectors.flatMap((selector) => readSelector(selector) ?? [])
      : [],
    bindings: Array.isArray(surfaceInput.bindings)
      ? surfaceInput.bindings.flatMap((binding) => readBinding(binding) ?? [])
      : [],
    layoutRecipe,
  };
}

function sourcePayload(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;
  if (isRecord(entry.payload)) return entry.payload;
  if (isRecord(entry.record) && isRecord(entry.record.payload)) return entry.record.payload;
  return entry;
}

function selectorMatches(value: Record<string, unknown>, descriptor: WorkspaceSelectorDescriptor): boolean {
  for (const condition of descriptor.where ?? []) {
    const candidate = readPath(value, condition.path);
    const present = candidate !== undefined && candidate !== null && candidate !== '';
    if (condition.exists !== undefined && present !== condition.exists) return false;
    if (Object.hasOwn(condition, 'equals') && candidate !== condition.equals) return false;
    if (condition.in && !condition.in.includes(candidate)) return false;
  }
  return true;
}

/** Decode DATA-authored choices through a DATA selector descriptor. */
export function readWorkspaceSelectionOptions(
  raw: unknown,
  descriptor: WorkspaceSelectorDescriptor,
): WorkspaceSelectionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: WorkspaceSelectionOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const payload = sourcePayload(entry);
    if (!payload || !selectorMatches(payload, descriptor)) continue;
    const id = descriptor.idPaths.map((path) => readString(readPath(payload, path))).find(Boolean);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: descriptor.labelPaths.map((path) => readString(readPath(payload, path))).find(Boolean) ?? id,
      icon: descriptor.iconPaths.map((path) => readString(readPath(payload, path))).find(Boolean),
      value: payload,
    });
  }
  return options.sort((left, right) => {
    const leftOrder = descriptor.orderPaths.map((path) => readPath(left.value, path)).find((value) => typeof value === 'number');
    const rightOrder = descriptor.orderPaths.map((path) => readPath(right.value, path)).find((value) => typeof value === 'number');
    const leftNumber = typeof leftOrder === 'number' ? leftOrder : 0;
    const rightNumber = typeof rightOrder === 'number' ? rightOrder : 0;
    return leftNumber - rightNumber || left.label.localeCompare(right.label);
  });
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const numericKey = Array.isArray(cursor) && /^\d+$/.test(segment)
      ? Number(segment)
      : undefined;
    const existing = numericKey === undefined
      ? (cursor as Record<string, unknown>)[segment]
      : cursor[numericKey];
    const nextSegment = path[index + 1];
    const next = Array.isArray(existing)
      ? [...existing]
      : isRecord(existing)
        ? { ...existing }
        : /^\d+$/.test(nextSegment)
          ? []
          : {};
    if (numericKey === undefined) (cursor as Record<string, unknown>)[segment] = next;
    else cursor[numericKey] = next;
    cursor = next;
  }
  const finalSegment = path[path.length - 1];
  const finalKey = Array.isArray(cursor) && /^\d+$/.test(finalSegment)
    ? Number(finalSegment)
    : undefined;
  if (finalKey === undefined) (cursor as Record<string, unknown>)[finalSegment] = value;
  else cursor[finalKey] = value;
}

/** Bind arbitrary selected values into arbitrary child input paths. */
export function resolveWorkspaceSurfaceInputs(
  panels: readonly DiscoveredPanel[],
  selections: Readonly<Record<string, WorkspaceSelectionOption | undefined>>,
  outputs: Readonly<Record<string, WorkspaceSurfaceOutput | undefined>>,
  bindings: readonly WorkspaceBindingDescriptor[],
  generation = 0,
): Record<string, Record<string, unknown>> {
  const outputSources = new Set(
    bindings.flatMap((binding) => binding.source.output?.surfaceId ?? []),
  );
  const resolved = Object.fromEntries(
    panels.map((panel) => [
      panel.id,
      {
        ...(panel.surfaceInput ?? {}),
        ...(outputSources.has(panel.id)
          ? {
              __surface_output: {
                source_surface_id: panel.id,
                generation,
              },
            }
          : {}),
      },
    ]),
  );
  for (const binding of bindings) {
    const selected = binding.source.selectorId ? selections[binding.source.selectorId] : undefined;
    const output = binding.source.output?.surfaceId
      ? outputs[outputKey(binding.source.output.surfaceId, binding.source.output.name)]
      : undefined;
    const sourceValue = selected?.value ?? output?.value;
    const value = binding.source.selectorId || binding.source.output
      ? (sourceValue === undefined ? undefined : readPath(sourceValue, binding.source.path ?? []))
      : binding.source.value;
    if (value === undefined) continue;
    const targets = binding.target.surfaceId
      ? panels.filter((panel) => panel.id === binding.target.surfaceId)
      : panels;
    for (const panel of targets) setPath(resolved[panel.id], binding.target.path, value);
  }
  return resolved;
}

/** Discover panels published into a placement label from the canonical catalog. Generic — never names a package. */
export function discoverPanelsForPlacement(publishedRecords: unknown, placementLabel: string): DiscoveredPanel[] {
  if (!Array.isArray(publishedRecords)) return [];
  const panels: DiscoveredPanel[] = [];
  for (const row of publishedRecords) {
    const payload = isRecord(row) ? (isRecord(row.payload) ? row.payload : row) : null;
    if (!payload || payload.kind !== 'placeable-surface') continue;
    const labels = payload.placement_labels ?? payload.placementLabels;
    if (!Array.isArray(labels) || !labels.includes(placementLabel)) continue;
    const id = readString(payload.id) ?? readString(payload.surface_id);
    const materialTarget = readString(payload.material_target) ?? readString(payload.materialTarget);
    if (!id || !materialTarget) continue;
    const entry = isRecord(payload.package_entry) ? payload.package_entry : isRecord(payload.packageEntry) ? payload.packageEntry : undefined;
    const packageName = entry ? readString(entry.package_name) ?? readString(entry.packageName) : undefined;
    const entryName = entry ? readString(entry.entry_name) ?? readString(entry.entryName) : undefined;
    const surfaceInput = isRecord(payload.surface_input)
      ? payload.surface_input
      : isRecord(payload.surfaceInput)
        ? payload.surfaceInput
        : undefined;
    panels.push({
      id,
      label: readString(payload.label) ?? id,
      icon: readString(payload.icon),
      materialTarget,
      packageEntry: packageName && entryName ? { packageName, entryName } : undefined,
      order: typeof payload.order === 'number' ? payload.order : 0,
      region: readString(payload.region)
        ?? (surfaceInput ? readString(surfaceInput.region) : undefined),
      surfaceInput,
    });
  }
  panels.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // The catalog's canonical surface identity is the placement key. Projection
  // twins (including identity-text/addressed-mode delivery remnants) must not
  // create two tabs with the same tab id.
  const panelsById = new Set<string>();
  return panels.filter((panel) => {
    if (panelsById.has(panel.id)) return false;
    panelsById.add(panel.id);
    return true;
  });
}

/** Build a one-tab-per-panel LayoutState generically from discovered panels (no enumeration). */
export function buildWorkspaceLayout(
  placementLabel: string,
  panels: readonly DiscoveredPanel[],
  layoutRecipe?: WorkspaceLayoutRecipe,
  resolvedSurfaceInputs: Record<string, Record<string, unknown>> = {},
  initialFocusRegion?: string,
): LayoutState {
  const fallbackRegion = (layoutRecipe ? firstLayoutRegionId(layoutRecipe.regions) : undefined) ?? 'main';
  const configuredRegions = layoutRecipe?.regions ?? [{ id: fallbackRegion, weight: 1 }];
  const panelRegionIds = new Set(panels.map((panel) => panel.region ?? fallbackRegion));
  const configuredRegionIds = new Set(collectWorkspaceRegionIds(configuredRegions));
  const unknownRegionIds = [...new Set(panels
    .map((panel) => panel.region)
    .filter((region): region is string => !!region && !configuredRegionIds.has(region)))];
  const focusedRegionId = initialFocusRegion && panelRegionIds.has(initialFocusRegion)
    ? initialFocusRegion
    : [...panelRegionIds][0] ?? fallbackRegion;
  const tabId = (panelId: string) => `${placementLabel}-${panelId}-tab`;
  const containerId = (regionId: string) => `${placementLabel}-${regionId}`;

  const tabs: Record<string, TabMeta> = {};
  for (const p of panels) {
    tabs[tabId(p.id)] = {
      id: tabId(p.id),
      title: p.label,
      target: null,
      ...(p.packageEntry ? { packageEntry: p.packageEntry } : {}),
      materialTarget: p.materialTarget,
      icon: p.icon ?? 'Square',
      closable: false,
      metadata: {
        placeable_surface_id: p.id,
        placeable_surface_material_target: p.materialTarget,
        workspace_placement_label: placementLabel,
        region: p.region ?? fallbackRegion,
        // Self-describing tab (L090/L063): carry the panel's own surface_input so the
        // embedded container resolves it directly from the tab — never depending on a
        // per-placement-label placeable-surface-list projection materializing (that
        // sink is config-gated to a fixed label set). No-op for panels with no
        // surface_input (e.g. content-workspace children).
        ...(p.surfaceInput || resolvedSurfaceInputs[p.id]
          ? { surfaceInput: resolvedSurfaceInputs[p.id] ?? p.surfaceInput }
          : {}),
      },
    } as TabMeta;
  }

  interface BuiltLayoutNode {
    node: SplitTreeNode;
    regionIds: string[];
    weight: number;
  }
  const placedRegionIds = new Set<string>();
  const buildLayoutNode = (region: WorkspaceRegion): BuiltLayoutNode | null => {
    if (region.children?.length) {
      const children = region.children
        .map((child) => buildLayoutNode(child))
        .filter((child): child is BuiltLayoutNode => child !== null);
      if (children.length === 0) return null;
      if (children.length === 1) return { ...children[0], weight: region.weight };
      const totalWeight = children.reduce((sum, child) => sum + child.weight, 0) || 1;
      return {
        node: {
          kind: 'split',
          dir: region.direction ?? 'row',
          sizes: children.map((child) => child.weight / totalWeight),
          children: children.map((child) => child.node),
        },
        regionIds: children.flatMap((child) => child.regionIds),
        weight: region.weight,
      };
    }
    if (!panelRegionIds.has(region.id) || placedRegionIds.has(region.id)) return null;
    placedRegionIds.add(region.id);
    return {
      node: { kind: 'leaf', containerId: containerId(region.id) },
      regionIds: [region.id],
      weight: region.weight,
    };
  };

  const rootChildren = configuredRegions
    .map((region) => buildLayoutNode(region))
    .filter((child): child is BuiltLayoutNode => child !== null);
  for (const regionId of unknownRegionIds) {
    rootChildren.push({
      node: { kind: 'leaf', containerId: containerId(regionId) },
      regionIds: [regionId],
      weight: 1,
    });
  }
  if (rootChildren.length === 0) {
    rootChildren.push({
      node: { kind: 'leaf', containerId: containerId(fallbackRegion) },
      regionIds: [fallbackRegion],
      weight: 1,
    });
  }
  const rootResult = rootChildren.length === 1
    ? rootChildren[0]
    : (() => {
      const totalWeight = rootChildren.reduce((sum, child) => sum + child.weight, 0) || 1;
      return {
        node: {
          kind: 'split' as const,
          dir: layoutRecipe?.direction ?? 'row',
          sizes: rootChildren.map((child) => child.weight / totalWeight),
          children: rootChildren.map((child) => child.node),
        },
        regionIds: rootChildren.flatMap((child) => child.regionIds),
        weight: 1,
      };
    })();
  const regionIds = [...new Set(rootResult.regionIds)];
  const containers = Object.fromEntries(
    regionIds.map((regionId) => [
      containerId(regionId),
      { id: containerId(regionId), groupId: `${containerId(regionId)}-group` },
    ]),
  );
  const tabGroups = Object.fromEntries(
    regionIds.map((regionId) => {
      const tabIds = panels
        .filter((panel) => (panel.region ?? fallbackRegion) === regionId)
        .map((panel) => tabId(panel.id));
      return [`${containerId(regionId)}-group`, { tabIds, activeTabId: tabIds[0] ?? null }];
    }),
  );
  const tiledRoot = rootResult.node;

  return normalizeLayoutState({
    containers,
    tabGroups,
    tabs,
    layouts: [
      { type: 'tiled', root: tiledRoot },
      { type: 'floating',
        containers: regionIds.map((regionId, index) => ({
          containerId: containerId(regionId),
          x: 40 + index * 48,
          y: 64 + index * 48,
          w: 1100,
          h: 720,
          z: index + 1,
        })),
        camera: { scale: 1, tx: 0, ty: 0, min: 0.55, max: 1.75 },
      },
      { type: 'overlay', containers: [] },
    ],
    surface: 'grid',
    focusedContainerId: `${placementLabel}-${focusedRegionId}`,
    maximizedContainerId: null,
  } as Partial<LayoutState>);
}

/** Accept any persisted layout that normalizes to a non-empty container set. Generic across workspaces. */
function acceptsWorkspaceLayout(state: Partial<LayoutState>): boolean {
  return Object.keys(normalizeLayoutState(state).containers).length > 0;
}

function managedTabPlacement(tab: TabMeta): string | undefined {
  return isRecord(tab.metadata) ? readString(tab.metadata.workspace_placement_label) : undefined;
}

/**
 * Reconcile the catalog-owned tab membership with a user's persisted arrangement.
 *
 * The catalog owns WHICH managed tabs exist and their current mount metadata.
 * The persisted arrangement owns WHERE surviving tabs live and their order.
 * This separation means a DATA-only add/update/retraction becomes visible without
 * resetting user layout choices or creating one materializer per placement.
 */
export function reconcileWorkspaceLayout(
  persistedState: LayoutState,
  discoveredState: LayoutState,
  placementLabel: string,
): LayoutState {
  const persisted = normalizeLayoutState(persistedState);
  const discovered = normalizeLayoutState(discoveredState);
  const desiredTabs = new Map(Object.entries(discovered.tabs));
  const managedPersistedIds = new Set(
    Object.values(persisted.tabs)
      .filter((tab) => managedTabPlacement(tab) === placementLabel)
      .map((tab) => tab.id),
  );

  const tabs: Record<string, TabMeta> = {};
  for (const [tabId, tab] of Object.entries(persisted.tabs)) {
    if (!managedPersistedIds.has(tabId)) tabs[tabId] = tab;
  }
  for (const [tabId, desired] of desiredTabs) {
    const current = persisted.tabs[tabId];
    tabs[tabId] = current
      ? {
          ...current,
          ...desired,
          metadata: {
            ...(current.metadata ?? {}),
            ...(desired.metadata ?? {}),
          },
        }
      : desired;
  }

  const discoveredContainerIds = Object.keys(discovered.containers).sort();
  const persistedManagedContainerIds = Object.values(persisted.containers)
    .filter((container) => (
      persisted.tabGroups[container.groupId]?.tabIds.some((tabId) => managedPersistedIds.has(tabId))
    ))
    .map((container) => container.id)
    .sort();
  const regionStructureChanged = (
    JSON.stringify(discoveredContainerIds) !== JSON.stringify(persistedManagedContainerIds)
  );

  if (regionStructureChanged) {
    const persistedOrder = Object.values(persisted.tabGroups).flatMap((group) => group.tabIds);
    const tabGroups = Object.fromEntries(
      Object.entries(discovered.tabGroups).map(([groupId, group]) => {
        const desired = new Set(group.tabIds);
        const tabIds = [
          ...persistedOrder.filter((tabId) => desired.has(tabId)),
          ...group.tabIds.filter((tabId) => !persistedOrder.includes(tabId)),
        ];
        return [groupId, {
          tabIds,
          activeTabId: tabIds.includes(group.activeTabId ?? '')
            ? group.activeTabId
            : (tabIds[0] ?? null),
        }];
      }),
    );
    const unmanagedTabIds = Object.keys(tabs).filter((tabId) => !desiredTabs.has(tabId));
    const firstGroupId = Object.keys(tabGroups)[0];
    if (firstGroupId && unmanagedTabIds.length > 0) {
      const group = tabGroups[firstGroupId];
      tabGroups[firstGroupId] = {
        ...group,
        tabIds: [...group.tabIds, ...unmanagedTabIds.filter((tabId) => !group.tabIds.includes(tabId))],
        activeTabId: group.activeTabId ?? unmanagedTabIds[0] ?? null,
      };
    }
    return normalizeLayoutState({
      ...persisted,
      containers: discovered.containers,
      tabGroups,
      tabs,
      layouts: discovered.layouts,
      focusedContainerId: discovered.focusedContainerId,
    });
  }

  const assignedDesired = new Set<string>();
  const tabGroups = Object.fromEntries(
    Object.entries(persisted.tabGroups).map(([groupId, group]) => {
      const tabIds = group.tabIds.filter((tabId) => {
        if (desiredTabs.has(tabId)) {
          if (assignedDesired.has(tabId)) return false;
          assignedDesired.add(tabId);
          return true;
        }
        return !managedPersistedIds.has(tabId) && !!tabs[tabId];
      });
      return [
        groupId,
        {
          tabIds,
          activeTabId: group.activeTabId && tabIds.includes(group.activeTabId)
            ? group.activeTabId
            : (tabIds[0] ?? null),
        },
      ];
    }),
  );

  const focusedGroupId = persisted.focusedContainerId
    ? persisted.containers[persisted.focusedContainerId]?.groupId
    : undefined;
  const destinationGroupId = focusedGroupId && tabGroups[focusedGroupId]
    ? focusedGroupId
    : Object.keys(tabGroups)[0];
  const missingDesired = [...desiredTabs.keys()].filter((tabId) => !assignedDesired.has(tabId));

  if (!destinationGroupId) return discovered;
  if (missingDesired.length > 0) {
    const destination = tabGroups[destinationGroupId];
    tabGroups[destinationGroupId] = {
      ...destination,
      tabIds: [...destination.tabIds, ...missingDesired],
      activeTabId: destination.activeTabId ?? missingDesired[0] ?? null,
    };
  }

  const reconciled = normalizeLayoutState({
    ...persisted,
    tabs,
    tabGroups,
  });
  return JSON.stringify(reconciled) === JSON.stringify(persisted) ? persistedState : reconciled;
}

export interface WorkspaceShellProps {
  surfaceInput?: Record<string, unknown>;
}

function WorkspaceSelectorControl({
  descriptor,
  selected,
  onSelect,
}: {
  descriptor: WorkspaceSelectorDescriptor;
  selected?: WorkspaceSelectionOption;
  onSelect: (value: WorkspaceSelectionOption | undefined) => void;
}) {
  const raw = useBitfieldData(descriptor.source);
  const options = React.useMemo(
    () => readWorkspaceSelectionOptions(raw, descriptor),
    [raw, descriptor],
  );

  React.useEffect(() => {
    if (selected && options.some((option) => option.id === selected.id)) return;
    const next = options.find((option) => option.id === descriptor.initialValue) ?? options[0];
    onSelect(next);
  }, [descriptor.initialValue, onSelect, options, selected]);

  if (options.length === 0) return null;
  return (
    <Dropdown
      aria-label={descriptor.label ?? 'Choose'}
      label={descriptor.label}
      items={options.map((option) => ({
        value: option.id,
        label: option.label,
        icon: option.icon,
      }))}
      value={selected?.id ?? ''}
      onValueChange={(id) => onSelect(options.find((option) => option.id === id))}
      placeholder={descriptor.label ?? 'Choose'}
      scrollable
      align="end"
      size="md"
    />
  );
}

export function WorkspaceShell({ surfaceInput }: WorkspaceShellProps) {
  const config = React.useMemo(() => readWorkspaceConfig(surfaceInput), [surfaceInput]);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const generatedDestinationRef = React.useRef<string | null>(null);
  if (!generatedDestinationRef.current) generatedDestinationRef.current = createBrowserLocalDestinationRef();
  // Reuse the platform's canonical global placeable-surface catalog. The shell
  // filters that existing primitive by the placement label supplied as Society
  // DATA; it must never introduce a second full-record materializer.
  const publishedRecords = useBitfieldData('placeable-surfaces');
  const [selections, setSelections] = React.useState<Record<string, WorkspaceSelectionOption | undefined>>({});
  const selectionsRef = React.useRef(selections);
  const [outputs, setOutputs] = React.useState<Record<string, WorkspaceSurfaceOutput | undefined>>({});
  const [generation, setGeneration] = React.useState(0);
  const select = React.useCallback((selectorId: string, value: WorkspaceSelectionOption | undefined) => {
    const current = selectionsRef.current;
    if (current[selectorId]?.id === value?.id) return;
    const next = { ...current, [selectorId]: value };
    selectionsRef.current = next;
    setSelections(next);
    setGeneration((currentGeneration) => currentGeneration + 1);
    setOutputs({});
  }, []);

  const panels = React.useMemo(
    () => (config ? discoverPanelsForPlacement(publishedRecords, config.placementLabel) : []),
    [publishedRecords, config?.placementLabel],
  );
  const resolvedSurfaceInputs = React.useMemo(
    () => resolveWorkspaceSurfaceInputs(panels, selections, outputs, config?.bindings ?? [], generation),
    [config?.bindings, generation, outputs, panels, selections],
  );
  const initialState = React.useMemo(
    () => (
      config
        ? buildWorkspaceLayout(
            config.placementLabel,
            panels,
            config.layoutRecipe,
            resolvedSurfaceInputs,
            config.initialFocusRegion,
          )
        : normalizeLayoutState({})
    ),
    [config?.initialFocusRegion, config?.layoutRecipe, config?.placementLabel, panels, resolvedSurfaceInputs],
  );
  const persistenceAddress = config?.persistenceAddress ?? 'embedded-workspace-layout-state';
  const layoutEntryInput = config?.layoutStateInput
    ?? (config?.persistenceAddress ? 'layout-state-by-address-label' : 'embedded-workspace-layout-state');
  const layoutEntrySelector = React.useMemo(
    () => layoutEntryInput === 'layout-state-by-address-label'
      ? { input: layoutEntryInput, params: { addressLabel: persistenceAddress } }
      : layoutEntryInput,
    [layoutEntryInput, persistenceAddress],
  );
  const reconcilePersistedState = React.useCallback(
    (persisted: LayoutState, discovered: LayoutState) => (
      config ? reconcileWorkspaceLayout(persisted, discovered, config.placementLabel) : discovered
    ),
    [config?.placementLabel],
  );

  React.useEffect(() => {
    if (config) console.log(`[ui:workspace-shell] mounted placement=${config.placementLabel} panels=${panels.length}`);
  }, [config?.placementLabel, panels.length]);
  React.useEffect(() => {
    if (config) console.log(`[ui:workspace-shell] binding-state ${JSON.stringify({
      bindings: config.bindings.length,
      selections,
      resolvedSurfaceInputs,
    })}`);
  }, [config, resolvedSurfaceInputs, selections]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const onSurfaceOutput = (event: Event) => {
      const next = readWorkspaceSurfaceOutput(
        (event as CustomEvent<unknown>).detail,
        generation,
        new Set(panels.map((panel) => panel.id)),
      );
      if (!next) return;
      setOutputs((current) => {
        const key = outputKey(next.surfaceId, next.name);
        const previous = current[key];
        if (
          previous?.sequence !== undefined
          && next.sequence !== undefined
          && next.sequence < previous.sequence
        ) return current;
        if (previous?.revision && next.revision && previous.revision === next.revision) return current;
        return { ...current, [key]: next };
      });
    };
    root.addEventListener('bitfield:surface-output', onSurfaceOutput);
    return () => root.removeEventListener('bitfield:surface-output', onSurfaceOutput);
  }, [generation, panels]);

  React.useEffect(() => {
    const panelIds = new Set(panels.map((panel) => panel.id));
    setOutputs((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([, output]) => output && panelIds.has(output.surfaceId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [panels]);

  if (!config) {
    return (
      <Container layout="vertical" gap="sm" padding="lg" alignItems="center" justifyContent="center" height="full">
        <Text variant="body" color="faint">This workspace has no configuration.</Text>
      </Container>
    );
  }

  return (
    <Container
      ref={rootRef}
      layout="vertical"
      gap="none"
      height="full"
      minHeight="0"
      overflow="hidden"
      data-workspace-generation={generation}
    >
      {config.headerLabel || config.selectors.length > 0 ? (
        <Container layout="horizontal" gap="md" padding="md" alignItems="center" justifyContent="between" border="bottom">
          <Container layout="horizontal" gap="md" alignItems="center">
            {config.headerIcon ? <NamedIcon name={config.headerIcon} size="lg" /> : null}
            {config.headerLabel ? <Text variant="heading-lg">{config.headerLabel}</Text> : null}
          </Container>
          <Container layout="horizontal" gap="sm" alignItems="center">
            {config.selectors.map((descriptor) => (
              <WorkspaceSelectorControl
                key={descriptor.id}
                descriptor={descriptor}
                selected={selections[descriptor.id]}
                onSelect={(value) => select(descriptor.id, value)}
              />
            ))}
          </Container>
        </Container>
      ) : null}
      <Container layout="vertical" gap="none" flex={1} minHeight="0" overflow="hidden"
        data-workspace-layout
        width={config.layoutMaxWidthPx ? 'full' : undefined}
        marginX={config.layoutMaxWidthPx ? 'auto' : undefined}
        style={config.layoutMaxWidthPx ? { maxWidth: `${config.layoutMaxWidthPx}px` } : undefined}>
        <EmbeddedScreenArrangement
          initialState={initialState}
          layoutEntryInput={layoutEntrySelector}
          placeableSurfaceListAddressLabel={`placeable-surface-list::${config.placementLabel}`}
          surfaceIntentDestinationRef={generatedDestinationRef.current}
          addressedSurfaceTargetContainerId={initialState.focusedContainerId}
          persistence={{ valueAddressLabel: persistenceAddress }}
          acceptPersistedState={acceptsWorkspaceLayout}
          reconcilePersistedState={reconcilePersistedState}
          chrome={config.chrome ?? { 'header.actions': false, 'header.new-tab': false }}
        />
      </Container>
    </Container>
  );
}
