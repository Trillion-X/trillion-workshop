// bitfield/packages/screen-arrangement/read-data/chrome-visibility.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE generic chrome-visibility primitive for screen arrangement. Every piece
// of arrangement chrome (the header bar, the tab strip, each action button,
// anything added later) names itself with a dot-separated zone string. One
// resolver answers "does this zone render?" from a plain data map using
// longest-prefix matching. Hiding `actions` hides every `actions.*` zone;
// re-showing `actions.maximize` under a hidden `actions` works because the
// LONGEST matching prefix wins. Embeds, hosts, and persisted layout data all
// configure chrome the same way: a map of zone-name -> boolean.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This resolver NEVER enumerates zone names — chrome declares its own
//    names; new chrome = a new name in data, zero changes here
// 2. Missing zone (no prefix matches) = visible. Chrome hiding is always an
//    explicit data decision, never a default
// 3. Longest matching prefix wins — `{"actions": false,
//    "actions.maximize": true}` hides every action except maximize
// 4. Pure: map + string in, boolean out. No React, no I/O, no state
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/**
 * Chrome visibility map — zone name (dot-separated path) to visibility.
 * Pure Society data: persisted layout state, embed configuration, and
 * placeable-surface records all carry this same shape.
 */
export type ChromeVisibilityMap = Record<string, boolean>;

/**
 * The universal root-default zone key (empty string). `chrome[ROOT_ZONE] = false`
 * hides EVERY chrome zone at once (immersive) unless a longer, more-specific
 * prefix re-shows one — e.g. `{ "": false, "header.actions.close": true }` is
 * fully immersive but keeps the close button. This is the generic, zone-blind
 * way to express "hide all chrome" without ENUMERATING the zones (which would
 * violate invariant 1). The resolver consults it only after every dotted prefix
 * has missed, so existing maps (no `""` key) behave exactly as before.
 */
export const ROOT_ZONE = '';

/**
 * Resolve one zone's visibility by longest-prefix match.
 *
 * For zone `a.b.c` the candidate keys are `a.b.c`, `a.b`, `a`, then the root
 * default `""` — the longest one present in the map decides. No key present
 * (not even the root default) = visible.
 */
export function chromeZoneVisible(
  chrome: ChromeVisibilityMap | null | undefined,
  zone: string,
): boolean {
  if (!chrome) return true;
  let candidate = zone;
  for (;;) {
    const value = chrome[candidate];
    if (typeof value === 'boolean') return value;
    const cut = candidate.lastIndexOf('.');
    if (cut < 0) break;
    candidate = candidate.slice(0, cut);
  }
  // Root default (immersive): `chrome[""]` decides when no dotted prefix matched.
  const root = chrome[ROOT_ZONE];
  return typeof root === 'boolean' ? root : true;
}

/**
 * Immersive chrome map: hide every zone (a video/image fills the container with
 * no controls/tabs/borders/padding/background). Pure data — the SAME shape a
 * shared-presentation recipient view uses (P-CHROME = the presentation
 * descriptor; local immersive and remote bare-doc are one primitive). `keep`
 * names zones to re-show under the immersive default (e.g. a peek affordance
 * re-shows `header` transiently).
 */
export function immersiveChrome(...keep: string[]): ChromeVisibilityMap {
  const map: ChromeVisibilityMap = { [ROOT_ZONE]: false };
  for (const zone of keep) map[zone] = true;
  return map;
}

/** True when this chrome map hides everything by default (immersive). */
export function isImmersive(chrome: ChromeVisibilityMap | null | undefined): boolean {
  return !!chrome && chrome[ROOT_ZONE] === false;
}

/**
 * Merge chrome maps with later maps winning per key — used to layer
 * host-provided chrome over persisted chrome over defaults. Plain object
 * spread is correct because keys are flat zone names; the hierarchy lives in
 * the RESOLVER, not in nesting.
 */
export function mergeChromeMaps(
  ...maps: Array<ChromeVisibilityMap | null | undefined>
): ChromeVisibilityMap {
  const merged: ChromeVisibilityMap = {};
  for (const map of maps) {
    if (map) Object.assign(merged, map);
  }
  return merged;
}
