// packages/screen-arrangement/read-data/region-address.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Region addressing for the screen-arrangement. A "region" is anything that owns
// a coordinate frame and can carry a visual layer stack: a container/pane, the
// freeform canvas world, the surface root, or a tab's content frame. The
// region-address vocabulary (the `family` strings) is screen-arrangement Society
// — the generic `ui/VisualLayerStack` renderer is blind to it; it only receives
// `layers` and a region element.
//
// `regionAddressKey` produces a deterministic string key (family + sorted parts)
// used to look a region's stack up in `LayoutState.visualLayerStacks`. The same
// region always maps to the same key regardless of part insertion order.
// =============================================================================

import type { AddressRef } from '../../ui/show/visual-layer-stack';

/** The region-address families this package owns. Society — not Physics. */
export const REGION_FAMILY = {
  container: 'screen-arrangement.container',
  canvas: 'screen-arrangement.canvas',
  surface: 'screen-arrangement.surface',
  tab: 'screen-arrangement.tab',
  backdrop: 'screen-arrangement.backdrop',
} as const;

/** Canonical, order-independent key for a region address. */
export function regionAddressKey(ref: AddressRef): string {
  const parts = Object.keys(ref.parts)
    .sort()
    .map((key) => `${key}=${ref.parts[key]}`)
    .join(',');
  return parts ? `${ref.family}:${parts}` : ref.family;
}

export function containerRegion(containerId: string): AddressRef {
  return { family: REGION_FAMILY.container, parts: { containerId } };
}

export function canvasRegion(): AddressRef {
  return { family: REGION_FAMILY.canvas, parts: {} };
}

export function surfaceRegion(surface: string): AddressRef {
  return { family: REGION_FAMILY.surface, parts: { surface } };
}

export function tabRegion(tabId: string): AddressRef {
  return { family: REGION_FAMILY.tab, parts: { tabId } };
}

/** The whole screen behind one floating window, beneath the window and above everything under it. */
export function backdropRegion(containerId: string): AddressRef {
  return { family: REGION_FAMILY.backdrop, parts: { containerId } };
}

/**
 * The regions a floating window owns, by the names an open placement's `looks` use: the window itself and the
 * screen behind it. A look named here is painted; any other name is left out.
 */
export function overlayWindowRegions(containerId: string): Record<string, AddressRef> {
  return { window: containerRegion(containerId), backdrop: backdropRegion(containerId) };
}
