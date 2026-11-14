import type { LayoutState, SplitTreeNode, TabMeta } from '@/packages/screen-arrangement/read-data/layout-types';
import { normalizeLayoutState } from '@/packages/screen-arrangement/read-data/read-screen-arrangement';

const CONNECTIONS_WORKSPACE_TILED_ROOT = {
  kind: 'split',
  dir: 'row',
  children: [
    { kind: 'leaf', containerId: 'connections-workspace-connected' },
    {
      kind: 'split',
      dir: 'column',
      children: [
        { kind: 'leaf', containerId: 'connections-workspace-available' },
        { kind: 'leaf', containerId: 'connections-workspace-recent' },
      ],
      sizes: [0.56, 0.44],
    },
    {
      kind: 'split',
      dir: 'column',
      children: [
        { kind: 'leaf', containerId: 'connections-workspace-workflows' },
        { kind: 'leaf', containerId: 'connections-workspace-groups' },
      ],
      sizes: [0.52, 0.48],
    },
  ],
  sizes: [0.42, 0.34, 0.24],
} satisfies SplitTreeNode;

export const CONNECTIONS_WORKSPACE_LAYOUT_STATE = {
  containers: {
    'connections-workspace-connected': { id: 'connections-workspace-connected', groupId: 'connections-workspace-connected-group' },
    'connections-workspace-available': { id: 'connections-workspace-available', groupId: 'connections-workspace-available-group' },
    'connections-workspace-recent': { id: 'connections-workspace-recent', groupId: 'connections-workspace-recent-group' },
    'connections-workspace-workflows': { id: 'connections-workspace-workflows', groupId: 'connections-workspace-workflows-group' },
    'connections-workspace-groups': { id: 'connections-workspace-groups', groupId: 'connections-workspace-groups-group' },
  },
  tabGroups: {
    'connections-workspace-connected-group': { tabIds: ['connections-workspace-connected-tab'], activeTabId: 'connections-workspace-connected-tab' },
    'connections-workspace-available-group': { tabIds: ['connections-workspace-available-tab'], activeTabId: 'connections-workspace-available-tab' },
    'connections-workspace-recent-group': { tabIds: ['connections-workspace-recent-tab'], activeTabId: 'connections-workspace-recent-tab' },
    'connections-workspace-workflows-group': { tabIds: ['connections-workspace-workflows-tab'], activeTabId: 'connections-workspace-workflows-tab' },
    'connections-workspace-groups-group': { tabIds: ['connections-workspace-groups-tab'], activeTabId: 'connections-workspace-groups-tab' },
  },
  tabs: {
    'connections-workspace-connected-tab': {
      id: 'connections-workspace-connected-tab',
      title: 'Outside accounts and keys',
      target: null,
      packageEntry: { packageName: 'service-connections', entryName: 'service-connections' },
      materialTarget: 'component:service-connections',
      icon: 'KeyRound',
      closable: true,
      metadata: {
        placeable_surface_id: 'service-connections.settings',
        placeable_surface_material_target: 'component:service-connections',
      },
    },
    'connections-workspace-available-tab': {
      id: 'connections-workspace-available-tab',
      title: 'Available services',
      target: null,
      packageEntry: { packageName: 'connectable-services', entryName: 'connectable-services' },
      materialTarget: 'component:connectable-services',
      icon: 'Link',
      closable: true,
      metadata: {
        placeable_surface_id: 'connectable-services',
        placeable_surface_material_target: 'component:connectable-services',
      },
    },
    'connections-workspace-recent-tab': {
      id: 'connections-workspace-recent-tab',
      title: 'Recent activity',
      target: null,
      packageEntry: { packageName: 'activity-feed', entryName: 'activity-feed' },
      materialTarget: 'activity-feed',
      icon: 'Activity',
      closable: true,
      metadata: {
        placeable_surface_id: 'activity-feed.panel',
        placeable_surface_material_target: 'activity-feed',
      },
    },
    'connections-workspace-workflows-tab': {
      id: 'connections-workspace-workflows-tab',
      title: 'Connected workflows',
      target: null,
      packageEntry: { packageName: 'connector-room', entryName: 'connector-room' },
      materialTarget: 'connector-room',
      icon: 'DoorOpen',
      closable: true,
      metadata: {
        placeable_surface_id: 'connector-room.workflows',
        placeable_surface_material_target: 'connector-room',
        surfaceInput: { connections_surface: 'connected-workflows' },
      },
    },
    'connections-workspace-groups-tab': {
      id: 'connections-workspace-groups-tab',
      title: 'Activity groups',
      target: null,
      packageEntry: { packageName: 'event-group', entryName: 'event-group' },
      materialTarget: 'event-group',
      icon: 'Layers3',
      closable: true,
      metadata: {
        placeable_surface_id: 'event-group.panel',
        placeable_surface_material_target: 'event-group',
      },
    },
  },
  layouts: [
    { type: 'tiled', root: CONNECTIONS_WORKSPACE_TILED_ROOT },
    {
      type: 'floating',
      containers: [
        { containerId: 'connections-workspace-connected', x: 40, y: 64, w: 620, h: 700, z: 1 },
        { containerId: 'connections-workspace-available', x: 680, y: 64, w: 500, h: 380, z: 2 },
        { containerId: 'connections-workspace-recent', x: 680, y: 464, w: 500, h: 300, z: 3 },
        { containerId: 'connections-workspace-workflows', x: 1200, y: 64, w: 380, h: 350, z: 4 },
        { containerId: 'connections-workspace-groups', x: 1200, y: 434, w: 380, h: 330, z: 5 },
      ],
      camera: { scale: 1, tx: 0, ty: 0, min: 0.55, max: 1.75 },
    },
    { type: 'overlay', containers: [] },
  ],
  surface: 'grid',
  focusedContainerId: 'connections-workspace-connected',
  maximizedContainerId: null,
} satisfies LayoutState;

export const CONNECTIONS_WORKSPACE_LAYOUT_STATE_INPUT = 'connectionsWorkspaceLayoutState';
export const CONNECTIONS_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL = 'connections-workspace-layout-state';
export const CONNECTIONS_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL = 'placeable-surface-list::connections-workspace';

const REQUIRED_CONNECTIONS_SURFACES = new Set([
  'service-connections.settings',
  'connectable-services',
  'activity-feed.panel',
  'connected-workflows',
  'event-group.panel',
]);

function readConnectionsSurface(tab: TabMeta): string | null {
  const metadata = tab.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const rawSurfaceInput = (metadata as { surfaceInput?: unknown; surface_input?: unknown }).surfaceInput
    ?? (metadata as { surface_input?: unknown }).surface_input;
  if (rawSurfaceInput && typeof rawSurfaceInput === 'object' && !Array.isArray(rawSurfaceInput)) {
    const rawSurface = (rawSurfaceInput as { connections_surface?: unknown; connectionsSurface?: unknown }).connections_surface
      ?? (rawSurfaceInput as { connectionsSurface?: unknown }).connectionsSurface;
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

export function acceptsConnectionsWorkspaceLayoutState(state: Partial<LayoutState>): boolean {
  const normalized = normalizeLayoutState(state);
  if (normalized.surface !== 'grid') return false;

  const connectionsSurfaces = new Set(
    Object.values(normalized.tabs)
      .map(readConnectionsSurface)
      .filter((surface): surface is string => surface !== null),
  );
  for (const requiredSurface of REQUIRED_CONNECTIONS_SURFACES) {
    if (!connectionsSurfaces.has(requiredSurface)) return false;
  }

  const containerIds = new Set(Object.keys(normalized.containers));
  const tiled = normalized.layouts.find((layout) => layout.type === 'tiled');
  const tiledIds = splitTreeContainerIds(tiled?.root ?? null);
  for (const containerId of containerIds) {
    if (!tiledIds.has(containerId)) return false;
  }

  return true;
}
