/**
 * file: packages/content-production/read-data/read-content-workspace-state.ts
 *
 * PURPOSE: Pure layout-state + surface-discovery queries for the content workspace shell.
 * Defines the default screen-arrangement layout (one tab per content surface) and the
 * persistence acceptance check, mirroring media-composition's read-media-editor-layout-state.ts.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Never imports from slot::workflow or slot::eeaf — pure data + types only
 * 2. Zero side effects, zero writes
 * 3. Surfaces are discovered from published placeable-surface records — never enumerated in handlers
 */

import type { LayoutState, SplitTreeNode, TabMeta } from '../../../../arrange-screens-in-panes/read-data/layout-types';
import { normalizeLayoutState } from '../../../../arrange-screens-in-panes/read-data/read-screen-arrangement';

export interface PlaceableSurfaceRecord {
  id: string;
  kind: 'placeable-surface';
  label: string;
  icon: string;
  material_target: string;
  package_entry: {
    package_name: string;
    entry_name: string;
  };
  surface_input?: Record<string, unknown>;
  accepts_material_kinds?: string[];
  order?: number;
}

/**
 * Discover all placeable surfaces from published-records.
 * The shell hosts whatever surfaces exist — it never names them in code.
 */
export function discoverPlaceableSurfaces(publishedRecords: unknown): PlaceableSurfaceRecord[] {
  if (!Array.isArray(publishedRecords)) return [];

  return publishedRecords
    .filter(
      (record: unknown): record is { payload: PlaceableSurfaceRecord } =>
        typeof record === 'object' &&
        record !== null &&
        'payload' in record &&
        typeof (record as { payload?: unknown }).payload === 'object' &&
        (record as { payload: { kind?: unknown } }).payload !== null &&
        (record as { payload: { kind?: unknown } }).payload.kind === 'placeable-surface',
    )
    .map((record) => record.payload)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ---------------------------------------------------------------------------
// DEFAULT LAYOUT — one tab group hosting each content surface as a tab.
// Tabs carry placeable_surface_id metadata; the arranger resolves each id to
// its registered placeable-surface record when that surface's package entry
// exists, and renders an empty container until then.
// ---------------------------------------------------------------------------

const CONTENT_WORKSPACE_SURFACE_TABS = [
  { key: 'library', title: 'Library', icon: 'FileText', surfaceId: 'content-production.library', packageName: 'content-production', entryName: 'content-library', materialTarget: 'library' },
  { key: 'style', title: 'Style', icon: 'Palette', surfaceId: 'content-production.style', packageName: 'content-production', entryName: 'content-style', materialTarget: 'style' },
  { key: 'compose', title: 'Compose', icon: 'Clapperboard', surfaceId: 'media-composition.panel', packageName: 'media-composition', entryName: 'media-composition', materialTarget: 'media-composition' },
  { key: 'deliverables', title: 'Deliverables', icon: 'Package', surfaceId: 'content-production.deliverables', packageName: 'content-production', entryName: 'content-deliverables', materialTarget: 'deliverables' },
  { key: 'distribution', title: 'Distribution', icon: 'Share2', surfaceId: 'content-distribution.panel', packageName: 'content-distribution', entryName: 'content-distribution', materialTarget: 'content-distribution' },
  { key: 'connections', title: 'Connections', icon: 'Link', surfaceId: 'connectable-services', packageName: 'connectable-services', entryName: 'connectable-services', materialTarget: 'component:connectable-services' },
  { key: 'settings', title: 'Settings', icon: 'Settings', surfaceId: 'content-production.settings', packageName: 'content-production', entryName: 'content-settings', materialTarget: 'settings' },
] as const;

const CONTENT_WORKSPACE_TILED_ROOT = {
  kind: 'leaf',
  containerId: 'content-workspace-main',
} satisfies SplitTreeNode;

function contentWorkspaceTabId(key: string): string {
  return `content-workspace-${key}-tab`;
}

export const CONTENT_WORKSPACE_LAYOUT_STATE = {
  containers: {
    'content-workspace-main': { id: 'content-workspace-main', groupId: 'content-workspace-main-group' },
  },
  tabGroups: {
    'content-workspace-main-group': {
      tabIds: CONTENT_WORKSPACE_SURFACE_TABS.map((tab) => contentWorkspaceTabId(tab.key)),
      activeTabId: contentWorkspaceTabId('library'),
    },
  },
  tabs: Object.fromEntries(
    CONTENT_WORKSPACE_SURFACE_TABS.map((tab) => [
      contentWorkspaceTabId(tab.key),
      {
        id: contentWorkspaceTabId(tab.key),
        title: tab.title,
        target: null,
        packageEntry: { packageName: tab.packageName, entryName: tab.entryName },
        materialTarget: tab.materialTarget,
        icon: tab.icon,
        closable: false,
        metadata: {
          placeable_surface_id: tab.surfaceId,
          placeable_surface_material_target: tab.materialTarget,
        },
      } satisfies TabMeta,
    ]),
  ),
  layouts: [
    { type: 'tiled', root: CONTENT_WORKSPACE_TILED_ROOT },
    {
      type: 'floating',
      containers: [{ containerId: 'content-workspace-main', x: 40, y: 64, w: 1100, h: 720, z: 1 }],
      camera: { scale: 1, tx: 0, ty: 0, min: 0.55, max: 1.75 },
    },
    { type: 'overlay', containers: [] },
  ],
  surface: 'grid',
  focusedContainerId: 'content-workspace-main',
  maximizedContainerId: null,
} satisfies LayoutState;

export const CONTENT_WORKSPACE_LAYOUT_STATE_INPUT = 'contentWorkspaceLayoutState';
export const CONTENT_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL = 'content-workspace-layout-state';

/**
 * Accept a persisted layout only when every container in it appears in both
 * the tiled tree and the floating surface (same structural check media-composition uses).
 */
export function acceptsContentWorkspaceLayoutState(state: Partial<LayoutState>): boolean {
  const normalized = normalizeLayoutState(state);
  const containerIds = new Set(Object.keys(normalized.containers));
  if (containerIds.size === 0) return false;

  const floating = normalized.layouts.find((layout) => layout.type === 'floating');
  const floatingIds = new Set(floating?.containers.map((entry) => entry.containerId) ?? []);
  const tiled = normalized.layouts.find((layout) => layout.type === 'tiled');
  const tiledIds = splitTreeContainerIds(tiled?.root ?? null);

  for (const containerId of containerIds) {
    if (!floatingIds.has(containerId)) return false;
    if (!tiledIds.has(containerId)) return false;
  }
  return true;
}

function splitTreeContainerIds(node: SplitTreeNode | null): Set<string> {
  if (!node) return new Set();
  if (node.kind === 'leaf') return new Set([node.containerId]);
  return node.children.reduce((ids, child) => {
    for (const containerId of splitTreeContainerIds(child)) ids.add(containerId);
    return ids;
  }, new Set<string>());
}
