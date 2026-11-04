// packages/screen-arrangement/read-data/region-chrome.ts
//
// Per-region chrome (the locked Presentation primitive, region-keyed). A region's
// EFFECTIVE chrome is the arrangement-wide `LayoutState.chrome` overlaid with that
// region's own override in `LayoutState.regionChrome` (keyed by `regionAddressKey`,
// exactly like `visualLayerStacks`). This is what makes ONE addressed region
// immersive — hide its header/frame/padding via `{'':false}` — while its siblings
// keep their chrome (note #33: "drop a video → only the video").
//
// SSOT: this is the ONLY place the base+override merge + the immersive toggle live.
// Every render path (container header, arranger frame, freeform/overlay/focus
// wrappers) asks `regionZoneVisible(state.chrome, state.regionChrome, region, zone)`
// and never reasons about region maps itself. The immersive trigger writes ONLY
// the region side-map — it never touches `maximizedContainerId` (focus state is a
// separate, optionally-composed concern, per the C-fork convergence).
//
// Every zone is also a control the person's show rules decide (parts/ui/show/show-rules show-of.ts controlShown): zone
// `header.nav` is control `arrangement.header.nav`, so a rule given to a person, or one they keep, hides it the same
// way the layout's own map does. The layout says how this arrangement is drawn; the rules say what this person sees.

import type { AddressRef } from '../../ui/show/visual-layer-stack'
import {
  type ChromeVisibilityMap,
  chromeZoneVisible,
  mergeChromeMaps,
  ROOT_ZONE,
} from './chrome-visibility'
import { regionAddressKey } from './region-address'
import { controlShown } from '../../ui/show/show-rules/show-of'

/** The control path a chrome zone is decided under by show rules: `arrangement.` and the zone. */
export const zoneControl = (zone: string): string => (zone ? `arrangement.${zone}` : 'arrangement')

/** Region-key → that region's own chrome override map. */
export type RegionChromeMap = Record<string, ChromeVisibilityMap>

/**
 * The chrome a region actually renders with: the arrangement-wide base overlaid
 * with the region's own override (override wins per-zone via `mergeChromeMaps`).
 * Absent override → the region inherits the arrangement map unchanged.
 */
export function effectiveChromeForRegion(
  arrangementChrome: ChromeVisibilityMap | null | undefined,
  regionChrome: RegionChromeMap | null | undefined,
  region: AddressRef,
): ChromeVisibilityMap {
  return mergeChromeMaps(arrangementChrome, regionChrome?.[regionAddressKey(region)])
}

/** Is `zone` visible for `region` under its effective chrome and the show rules? The single call site. */
export function regionZoneVisible(
  arrangementChrome: ChromeVisibilityMap | null | undefined,
  regionChrome: RegionChromeMap | null | undefined,
  region: AddressRef,
  zone: string,
): boolean {
  return chromeZoneVisible(effectiveChromeForRegion(arrangementChrome, regionChrome, region), zone) && controlShown(zoneControl(zone))
}

/** True when this region's OWN override makes it immersive (root zone hidden). */
export function regionIsImmersive(
  regionChrome: RegionChromeMap | null | undefined,
  region: AddressRef,
): boolean {
  return regionChrome?.[regionAddressKey(region)]?.[ROOT_ZONE] === false
}

/**
 * Toggle a region's immersive override, returning a NEW RegionChromeMap (pure —
 * the caller commits it via `applyLayoutState`). Entering sets `{'':false}` on the
 * region (merged over any existing override); exiting removes the root zone and
 * prunes the region entry if it becomes empty. Never touches focus/maximize state.
 */
export function toggleRegionImmersive(
  regionChrome: RegionChromeMap | null | undefined,
  region: AddressRef,
): RegionChromeMap {
  const key = regionAddressKey(region)
  const next: RegionChromeMap = { ...(regionChrome ?? {}) }
  const current = next[key] ?? {}
  if (current[ROOT_ZONE] === false) {
    // exit immersive — drop the root zone, prune the region if nothing else remains
    const { [ROOT_ZONE]: _dropped, ...rest } = current
    if (Object.keys(rest).length === 0) delete next[key]
    else next[key] = rest
  } else {
    next[key] = { ...current, [ROOT_ZONE]: false }
  }
  return next
}

/** True when ANY region is currently immersive — so an Escape handler knows
 *  whether there is anything to exit. */
export function hasImmersiveRegion(regionChrome: RegionChromeMap | null | undefined): boolean {
  if (!regionChrome) return false
  return Object.values(regionChrome).some((map) => map[ROOT_ZONE] === false)
}

/**
 * Exit immersive for EVERY region (standard fullscreen-Escape semantics, so an
 * immersive container — whose header is hidden — is never a trap). Drops each
 * region's root zone, keeps any other zones it declared, prunes emptied regions.
 * Returns a NEW map (pure).
 */
export function clearImmersiveRegions(
  regionChrome: RegionChromeMap | null | undefined,
): RegionChromeMap {
  const next: RegionChromeMap = {}
  for (const [key, map] of Object.entries(regionChrome ?? {})) {
    if (map[ROOT_ZONE] === false) {
      const { [ROOT_ZONE]: _root, ...rest } = map
      if (Object.keys(rest).length > 0) next[key] = rest
    } else {
      next[key] = map
    }
  }
  return next
}
