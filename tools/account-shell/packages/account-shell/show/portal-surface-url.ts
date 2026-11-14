// packages/account-shell/show/portal-surface-url.ts
//
// URL state for the active portal surface (?surface=<id>).

import type { PortalSurface } from '../read-data/read-portal-surfaces';

export function requestedSurfaceFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('surface');
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function surfaceInputFromSearch(
  surface: PortalSurface | null,
  search: string,
): Record<string, unknown> {
  if (!surface) return {};
  const params = new URLSearchParams(search);
  const result: Record<string, unknown> = { ...surface.surfaceInput };
  for (const [inputKey, queryKey] of Object.entries(surface.surfaceInputQuery)) {
    const value = params.get(queryKey);
    if (value?.trim()) result[inputKey] = value.trim();
  }
  return result;
}

export function resolveActiveSurfaceId(
  surfaces: readonly PortalSurface[],
  requested: string | null,
  fallback: string | null,
): string | null {
  if (requested && surfaces.some((surface) => surface.id === requested)) return requested;
  if (fallback && surfaces.some((surface) => surface.id === fallback)) return fallback;
  return null;
}

export function surfaceUrl(
  pathname: string,
  search: string,
  hash: string,
  surfaceId: string,
  defaultSurfaceId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (surfaceId === defaultSurfaceId) {
    params.delete('surface');
  } else {
    params.set('surface', surfaceId);
  }
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}${hash}`;
}
