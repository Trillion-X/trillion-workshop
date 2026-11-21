import type { LayoutState, SplitTreeNode, TabMeta } from '../../screen-arrangement/read-data/layout-types';
import { normalizeLayoutState } from '../../arrange-screens-in-panes/read-data/read-screen-arrangement';

const TRADING_WORKSPACE_TILED_ROOT = {
  kind: 'split',
  dir: 'row',
  children: [
    {
      kind: 'split',
      dir: 'column',
      children: [
        { kind: 'leaf', containerId: 'trading-workspace-overview' },
        { kind: 'leaf', containerId: 'trading-workspace-account' },
      ],
      sizes: [0.58, 0.42],
    },
    {
      kind: 'split',
      dir: 'column',
      children: [
        { kind: 'leaf', containerId: 'trading-workspace-market' },
        { kind: 'leaf', containerId: 'trading-workspace-order' },
      ],
      sizes: [0.62, 0.38],
    },
    {
      kind: 'split',
      dir: 'column',
      children: [
        { kind: 'leaf', containerId: 'trading-workspace-guardrails' },
        { kind: 'leaf', containerId: 'trading-workspace-audit' },
      ],
      sizes: [0.44, 0.56],
    },
  ],
  sizes: [0.28, 0.46, 0.26],
} satisfies SplitTreeNode;

export const TRADING_WORKSPACE_LAYOUT_STATE = {
  containers: {
    'trading-workspace-overview': { id: 'trading-workspace-overview', groupId: 'trading-workspace-overview-group' },
    'trading-workspace-market': { id: 'trading-workspace-market', groupId: 'trading-workspace-market-group' },
    'trading-workspace-account': { id: 'trading-workspace-account', groupId: 'trading-workspace-account-group' },
    'trading-workspace-guardrails': { id: 'trading-workspace-guardrails', groupId: 'trading-workspace-guardrails-group' },
    'trading-workspace-order': { id: 'trading-workspace-order', groupId: 'trading-workspace-order-group' },
    'trading-workspace-audit': { id: 'trading-workspace-audit', groupId: 'trading-workspace-audit-group' },
  },
  tabGroups: {
    'trading-workspace-overview-group': { tabIds: ['trading-workspace-overview-tab'], activeTabId: 'trading-workspace-overview-tab' },
    'trading-workspace-market-group': { tabIds: ['trading-workspace-market-tab'], activeTabId: 'trading-workspace-market-tab' },
    'trading-workspace-account-group': { tabIds: ['trading-workspace-account-tab'], activeTabId: 'trading-workspace-account-tab' },
    'trading-workspace-guardrails-group': { tabIds: ['trading-workspace-guardrails-tab'], activeTabId: 'trading-workspace-guardrails-tab' },
    'trading-workspace-order-group': { tabIds: ['trading-workspace-order-tab'], activeTabId: 'trading-workspace-order-tab' },
    'trading-workspace-audit-group': { tabIds: ['trading-workspace-audit-tab'], activeTabId: 'trading-workspace-audit-tab' },
  },
  tabs: {
    'trading-workspace-overview-tab': {
      id: 'trading-workspace-overview-tab',
      title: 'Trading center',
      target: null,
      packageEntry: { packageName: 'investment-command', entryName: 'investment-command' },
      materialTarget: 'investment-command',
      icon: 'Activity',
      closable: true,
      metadata: {
        placeable_surface_id: 'investment-command.overview',
        placeable_surface_material_target: 'investment-command',
        surfaceInput: { trading_surface: 'overview' },
      },
    },
    'trading-workspace-market-tab': {
      id: 'trading-workspace-market-tab',
      title: 'Market data',
      target: null,
      packageEntry: { packageName: 'market-data-feed', entryName: 'market-data-feed' },
      materialTarget: 'market-data-feed',
      icon: 'Radar',
      closable: true,
      metadata: {
        placeable_surface_id: 'market-data-feed.panel',
        placeable_surface_material_target: 'market-data-feed',
      },
    },
    'trading-workspace-account-tab': {
      id: 'trading-workspace-account-tab',
      title: 'Account',
      target: null,
      packageEntry: { packageName: 'portfolio-connector', entryName: 'portfolio-connector' },
      materialTarget: 'portfolio-connector',
      icon: 'Wallet',
      closable: true,
      metadata: {
        placeable_surface_id: 'portfolio-connector.panel',
        placeable_surface_material_target: 'portfolio-connector',
      },
    },
    'trading-workspace-guardrails-tab': {
      id: 'trading-workspace-guardrails-tab',
      title: 'Guardrails',
      target: null,
      packageEntry: { packageName: 'permission-lease', entryName: 'permission-lease' },
      materialTarget: 'permission-lease',
      icon: 'ShieldCheck',
      closable: true,
      metadata: {
        placeable_surface_id: 'permission-lease.panel',
        placeable_surface_material_target: 'permission-lease',
      },
    },
    'trading-workspace-order-tab': {
      id: 'trading-workspace-order-tab',
      title: 'Order',
      target: null,
      packageEntry: { packageName: 'trade-order', entryName: 'trade-order' },
      materialTarget: 'trade-order',
      icon: 'SendHorizontal',
      closable: true,
      metadata: {
        placeable_surface_id: 'trade-order.panel',
        placeable_surface_material_target: 'trade-order',
      },
    },
    'trading-workspace-audit-tab': {
      id: 'trading-workspace-audit-tab',
      title: 'Order history',
      target: null,
      packageEntry: { packageName: 'trade-audit', entryName: 'trade-audit' },
      materialTarget: 'trade-audit',
      icon: 'BarChart3',
      closable: true,
      metadata: {
        placeable_surface_id: 'trade-audit.panel',
        placeable_surface_material_target: 'trade-audit',
      },
    },
  },
  layouts: [
    { type: 'tiled', root: TRADING_WORKSPACE_TILED_ROOT },
    {
      type: 'floating',
      containers: [
        { containerId: 'trading-workspace-overview', x: 40, y: 64, w: 420, h: 480, z: 1 },
        { containerId: 'trading-workspace-market', x: 480, y: 64, w: 720, h: 500, z: 2 },
        { containerId: 'trading-workspace-account', x: 40, y: 564, w: 420, h: 280, z: 3 },
        { containerId: 'trading-workspace-guardrails', x: 1220, y: 64, w: 360, h: 340, z: 4 },
        { containerId: 'trading-workspace-order', x: 480, y: 584, w: 720, h: 260, z: 5 },
        { containerId: 'trading-workspace-audit', x: 1220, y: 424, w: 360, h: 420, z: 6 },
      ],
      camera: { scale: 1, tx: 0, ty: 0, min: 0.55, max: 1.75 },
    },
    { type: 'overlay', containers: [] },
  ],
  surface: 'grid',
  focusedContainerId: 'trading-workspace-market',
  maximizedContainerId: null,
} satisfies LayoutState;

export const TRADING_WORKSPACE_LAYOUT_STATE_INPUT = 'investmentCommandWorkspaceLayoutState';
export const TRADING_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL = 'investment-command-workspace-layout-state';
export const TRADING_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL = 'placeable-surface-list::trading-workspace';

const REQUIRED_TRADING_SURFACES = new Set([
  'overview',
  'market-data-feed.panel',
  'portfolio-connector.panel',
  'permission-lease.panel',
  'trade-order.panel',
  'trade-audit.panel',
]);

function readTradingSurface(tab: TabMeta): string | null {
  const metadata = tab.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const rawSurfaceInput = (metadata as { surfaceInput?: unknown; surface_input?: unknown }).surfaceInput
    ?? (metadata as { surface_input?: unknown }).surface_input;
  if (rawSurfaceInput && typeof rawSurfaceInput === 'object' && !Array.isArray(rawSurfaceInput)) {
    const rawSurface = (rawSurfaceInput as { trading_surface?: unknown; tradingSurface?: unknown }).trading_surface
      ?? (rawSurfaceInput as { tradingSurface?: unknown }).tradingSurface;
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

export function acceptsTradingWorkspaceLayoutState(state: Partial<LayoutState>): boolean {
  const normalized = normalizeLayoutState(state);
  if (normalized.surface !== 'grid') return false;

  const tradingSurfaces = new Set(
    Object.values(normalized.tabs)
      .map(readTradingSurface)
      .filter((surface): surface is string => surface !== null),
  );
  for (const requiredSurface of REQUIRED_TRADING_SURFACES) {
    if (!tradingSurfaces.has(requiredSurface)) return false;
  }

  const containerIds = new Set(Object.keys(normalized.containers));
  const tiled = normalized.layouts.find((layout) => layout.type === 'tiled');
  const tiledIds = splitTreeContainerIds(tiled?.root ?? null);
  for (const containerId of containerIds) {
    if (!tiledIds.has(containerId)) return false;
  }

  return true;
}
