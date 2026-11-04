// packages/screen-arrangement/read-data/build-companion-overlay-arrangement.ts
//
// Generic layout builder: compose a HOST surface as the full-screen base with one or
// more HEADLESS COMPANION surfaces mounted as minimal overlay boxes on top. The
// companions render nothing visible (a headless surface returns null) but their
// component MOUNTS — so their on-mount effects run (e.g. a traffic-capture beacon
// records the page visit, an analytics/consent/widget surface initialises).
//
// This is the DATA primitive behind "attach a headless effect surface to any page":
// the result is a LayoutState that a placeable-surface record carries as its
// `initialArrangement` (read-initial-arrangement.ts). When the host surface opens,
// screen-arrangement renders the host plus every companion — zero source edit to the
// host page, zero coupling (the host names no companion; the wiring is this DATA).
//
// Generic + agnostic: it names no package. Host + companions are PackageEntryReference
// DATA. Adding/removing a companion is a DATA change to the entry list, never code.
//
// Pure: no I/O, no clock, no React. The output is run through normalizeLayoutState so
// it is always a valid, canonical LayoutState (a malformed arrangement can never reach
// a live surface and break its render).

import type { LayoutState, OverlayBox, PackageEntryReference } from './layout-types';
import { normalizeLayoutState } from './read-screen-arrangement';

const HOST_CONTAINER_ID = 'host';
const HOST_GROUP_ID = 'host-group';
const HOST_TAB_ID = 'host-tab';

/** A minimal, effectively-invisible overlay box: a headless companion mounts here. */
function companionOverlayBox(containerId: string, index: number): OverlayBox {
  return { containerId, x: 0, y: 0, w: 1, h: 1, z: index + 1 };
}

function sameEntry(a: PackageEntryReference, b: PackageEntryReference): boolean {
  return a.packageName === b.packageName && a.entryName === b.entryName;
}

/**
 * Build a LayoutState that renders `host` full-screen with each of `companions`
 * mounted as a headless overlay. Returns a normalized (valid, canonical) LayoutState.
 *
 * - Empty/duplicate companions are ignored (a companion equal to the host, or a repeat,
 *   is dropped — mounting the same surface twice is never intended).
 * - With zero effective companions the result is just the host as the base (still valid).
 */
export function buildCompanionOverlayArrangement(
  host: PackageEntryReference,
  companions: readonly PackageEntryReference[],
): LayoutState {
  const seen: PackageEntryReference[] = [host];
  const effective: PackageEntryReference[] = [];
  for (const c of companions ?? []) {
    if (!c || typeof c.packageName !== 'string' || typeof c.entryName !== 'string') continue;
    if (c.packageName.length === 0 || c.entryName.length === 0) continue;
    if (seen.some((s) => sameEntry(s, c))) continue;
    seen.push(c);
    effective.push(c);
  }

  const containers: LayoutState['containers'] = {
    [HOST_CONTAINER_ID]: { id: HOST_CONTAINER_ID, groupId: HOST_GROUP_ID },
  };
  const tabGroups: LayoutState['tabGroups'] = {
    [HOST_GROUP_ID]: { tabIds: [HOST_TAB_ID], activeTabId: HOST_TAB_ID },
  };
  const tabs: LayoutState['tabs'] = {
    [HOST_TAB_ID]: { id: HOST_TAB_ID, title: host.entryName, target: null, packageEntry: { ...host } },
  };
  const overlayBoxes: OverlayBox[] = [];

  effective.forEach((companion, index) => {
    const containerId = `companion-${index}`;
    const groupId = `${containerId}-group`;
    const tabId = `${containerId}-tab`;
    containers[containerId] = { id: containerId, groupId };
    tabGroups[groupId] = { tabIds: [tabId], activeTabId: tabId };
    tabs[tabId] = { id: tabId, title: companion.entryName, target: null, packageEntry: { ...companion } };
    overlayBoxes.push(companionOverlayBox(containerId, index));
  });

  return normalizeLayoutState({
    containers,
    tabGroups,
    tabs,
    layouts: [
      { type: 'tiled', root: { kind: 'leaf', containerId: HOST_CONTAINER_ID } },
      { type: 'floating', containers: [], camera: { scale: 1, tx: 0, ty: 0 } },
      { type: 'overlay', containers: overlayBoxes },
    ],
    surface: 'grid',
    focusedContainerId: HOST_CONTAINER_ID,
    maximizedContainerId: null,
  });
}
