import type { LayoutState } from './layout-types';
import { normalizeLayoutState } from './read-screen-arrangement';
import type { PlaceableSurfaceRecord } from './read-published-records';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readInitialArrangementState(surface: PlaceableSurfaceRecord): LayoutState | null {
  const arrangement = surface.initialArrangement;
  if (!isRecord(arrangement)) return null;
  const candidate = arrangement.layoutState ?? arrangement.layout_state ?? arrangement;
  return isRecord(candidate) ? normalizeLayoutState(candidate as Partial<LayoutState>) : null;
}

export function layoutStatesEqual(left: LayoutState, right: LayoutState): boolean {
  return JSON.stringify(normalizeLayoutState(left)) === JSON.stringify(normalizeLayoutState(right));
}
