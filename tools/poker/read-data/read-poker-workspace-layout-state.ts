import type { LayoutState, SplitTreeNode, TabMeta } from '@/packages/screen-arrangement/read-data/layout-types';
import { normalizeLayoutState } from '@/packages/screen-arrangement/read-data/read-screen-arrangement';

const POKER_WORKSPACE_TILED_ROOT = {
  kind: 'split',
  dir: 'row',
  children: [
    { kind: 'leaf', containerId: 'poker-workspace-table' },
    {
      kind: 'split',
      dir: 'column',
      children: [
        { kind: 'leaf', containerId: 'poker-workspace-rules' },
        { kind: 'leaf', containerId: 'poker-workspace-connect' },
      ],
      sizes: [0.58, 0.42],
    },
  ],
  sizes: [0.68, 0.32],
} satisfies SplitTreeNode;

export const POKER_WORKSPACE_LAYOUT_STATE = {
  containers: {
    'poker-workspace-table': { id: 'poker-workspace-table', groupId: 'poker-workspace-table-group' },
    'poker-workspace-rules': { id: 'poker-workspace-rules', groupId: 'poker-workspace-rules-group' },
    'poker-workspace-connect': { id: 'poker-workspace-connect', groupId: 'poker-workspace-connect-group' },
  },
  tabGroups: {
    'poker-workspace-table-group': { tabIds: ['poker-workspace-table-tab'], activeTabId: 'poker-workspace-table-tab' },
    'poker-workspace-rules-group': { tabIds: ['poker-workspace-rules-tab'], activeTabId: 'poker-workspace-rules-tab' },
    'poker-workspace-connect-group': { tabIds: ['poker-workspace-connect-tab'], activeTabId: 'poker-workspace-connect-tab' },
  },
  tabs: {
    'poker-workspace-table-tab': {
      id: 'poker-workspace-table-tab',
      title: 'Poker table',
      target: null,
      packageEntry: { packageName: 'poker-table', entryName: 'poker-table' },
      materialTarget: 'poker-table',
      icon: 'Table',
      closable: true,
      metadata: {
        placeable_surface_id: 'poker-table.table',
        placeable_surface_material_target: 'poker-table',
        surfaceInput: { poker_surface: 'table' },
      },
    },
    'poker-workspace-rules-tab': {
      id: 'poker-workspace-rules-tab',
      title: 'Poker rules',
      target: null,
      packageEntry: { packageName: 'poker-rules', entryName: 'poker-rules' },
      materialTarget: 'poker-rules',
      icon: 'Club',
      closable: true,
      metadata: {
        placeable_surface_id: 'poker-rules.panel',
        placeable_surface_material_target: 'poker-rules',
      },
    },
    'poker-workspace-connect-tab': {
      id: 'poker-workspace-connect-tab',
      title: 'Connect devices',
      target: null,
      packageEntry: { packageName: 'shared-room-connection', entryName: 'shared-room-connection' },
      materialTarget: 'shared-room-connection',
      icon: 'QrCode',
      closable: true,
      metadata: {
        placeable_surface_id: 'shared-room-connection.panel',
        placeable_surface_material_target: 'shared-room-connection',
      },
    },
  },
  layouts: [
    { type: 'tiled', root: POKER_WORKSPACE_TILED_ROOT },
    {
      type: 'floating',
      containers: [
        { containerId: 'poker-workspace-table', x: 40, y: 64, w: 980, h: 700, z: 1 },
        { containerId: 'poker-workspace-rules', x: 1040, y: 64, w: 500, h: 400, z: 2 },
        { containerId: 'poker-workspace-connect', x: 1040, y: 484, w: 500, h: 280, z: 3 },
      ],
      camera: { scale: 1, tx: 0, ty: 0, min: 0.55, max: 1.75 },
    },
    { type: 'overlay', containers: [] },
  ],
  surface: 'grid',
  focusedContainerId: 'poker-workspace-table',
  maximizedContainerId: null,
} satisfies LayoutState;

export const POKER_WORKSPACE_LAYOUT_STATE_INPUT = 'pokerWorkspaceLayoutState';
export const POKER_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL = 'poker-workspace-layout-state';
export const POKER_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL = 'placeable-surface-list::poker-workspace';

const REQUIRED_POKER_SURFACES = new Set([
  'table',
  'poker-rules.panel',
  'shared-room-connection.panel',
]);

function readPokerSurface(tab: TabMeta): string | null {
  const metadata = tab.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const rawSurfaceInput = (metadata as { surfaceInput?: unknown; surface_input?: unknown }).surfaceInput
    ?? (metadata as { surface_input?: unknown }).surface_input;
  if (rawSurfaceInput && typeof rawSurfaceInput === 'object' && !Array.isArray(rawSurfaceInput)) {
    const rawSurface = (rawSurfaceInput as { poker_surface?: unknown; pokerSurface?: unknown }).poker_surface
      ?? (rawSurfaceInput as { pokerSurface?: unknown }).pokerSurface;
    if (typeof rawSurface === 'string' && rawSurface.length > 0) return rawSurface;
  }
  const rawPlaceableSurfaceId = (metadata as { placeable_surface_id?: unknown }).placeable_surface_id;
  return typeof rawPlaceableSurfaceId === 'string' && rawPlaceableSurfaceId.length > 0
    ? rawPlaceableSurfaceId
    : null;
}

function splitTreeContainerIds(node: SplitTreeNode | null): Set<string> {
  if (!node) return new Set();
  if (node.kind === 'leaf') return new Set([node.containerId]);
  return node.children.reduce((ids, child) => {
    for (const containerId of splitTreeContainerIds(child)) ids.add(containerId);
    return ids;
  }, new Set<string>());
}

export function acceptsPokerWorkspaceLayoutState(state: Partial<LayoutState>): boolean {
  const normalized = normalizeLayoutState(state);
  if (normalized.surface !== 'grid') return false;

  const pokerSurfaces = new Set(
    Object.values(normalized.tabs)
      .map(readPokerSurface)
      .filter((surface): surface is string => surface !== null),
  );
  for (const requiredSurface of REQUIRED_POKER_SURFACES) {
    if (!pokerSurfaces.has(requiredSurface)) return false;
  }

  const containerIds = new Set(Object.keys(normalized.containers));
  const tiled = normalized.layouts.find((layout) => layout.type === 'tiled');
  const tiledIds = splitTreeContainerIds(tiled?.root ?? null);
  for (const containerId of containerIds) {
    if (!tiledIds.has(containerId)) return false;
  }

  return true;
}
