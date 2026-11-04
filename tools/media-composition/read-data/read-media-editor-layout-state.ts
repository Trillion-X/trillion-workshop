import type { LayoutState, SplitTreeNode, TabMeta } from '@/packages/screen-arrangement/read-data/layout-types';
import { normalizeLayoutState } from '@/packages/screen-arrangement/read-data/read-screen-arrangement';
import {
  MEDIA_COMPOSITION_SURFACES,
  mediaCompositionLayoutState,
} from './media-composition-descriptors';

export const MEDIA_EDITOR_LAYOUT_STATE = mediaCompositionLayoutState() satisfies LayoutState;

export const MEDIA_EDITOR_LAYOUT_STATE_INPUT = 'mediaCompositionEditorLayoutState';
export const MEDIA_EDITOR_LAYOUT_STATE_ADDRESS_LABEL = 'media-composition-editor-layout-state';

const REQUIRED_MEDIA_SURFACES = new Set(MEDIA_COMPOSITION_SURFACES.map((surface) => surface.surface));

function readMediaSurface(tab: TabMeta): string | null {
  const metadata = tab.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const rawSurfaceInput = (metadata as { surfaceInput?: unknown; surface_input?: unknown }).surfaceInput
    ?? (metadata as { surface_input?: unknown }).surface_input;
  if (!rawSurfaceInput || typeof rawSurfaceInput !== 'object' || Array.isArray(rawSurfaceInput)) return null;
  const rawSurface = (rawSurfaceInput as { media_surface?: unknown; mediaSurface?: unknown }).media_surface
    ?? (rawSurfaceInput as { mediaSurface?: unknown }).mediaSurface;
  return typeof rawSurface === 'string' && rawSurface.length > 0 ? rawSurface : null;
}

function splitTreeContainerIds(node: SplitTreeNode | null): Set<string> {
  if (!node) return new Set();
  if (node.kind === 'leaf') return new Set([node.containerId]);
  return node.children.reduce((ids, child) => {
    for (const containerId of splitTreeContainerIds(child)) ids.add(containerId);
    return ids;
  }, new Set<string>());
}

export function acceptsMediaEditorLayoutState(state: Partial<LayoutState>): boolean {
  const normalized = normalizeLayoutState(state);
  if (normalized.surface !== 'grid') return false;

  const mediaSurfaces = new Set(
    Object.values(normalized.tabs)
      .map(readMediaSurface)
      .filter((surface): surface is string => surface !== null),
  );
  for (const requiredSurface of REQUIRED_MEDIA_SURFACES) {
    if (!mediaSurfaces.has(requiredSurface)) return false;
  }

  const containerIds = new Set(Object.keys(normalized.containers));
  const floating = normalized.layouts.find((layout) => layout.type === 'floating');
  const floatingIds = new Set(floating?.containers.map((entry) => entry.containerId) ?? []);
  for (const containerId of containerIds) {
    if (!floatingIds.has(containerId)) return false;
  }

  const tiled = normalized.layouts.find((layout) => layout.type === 'tiled');
  const tiledIds = splitTreeContainerIds(tiled?.root ?? null);
  for (const containerId of containerIds) {
    if (!tiledIds.has(containerId)) return false;
  }

  return true;
}
