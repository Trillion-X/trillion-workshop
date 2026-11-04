// packages/group/show/placeable-surface-shelf.ts
//
// Maps the SHARED placeable-surface catalog into board shelf variants so the board's
// "Live surface" tool offers exactly the surfaces the app has published. The catalog
// is owned by ui/placeable-surface-intent (findPlaceableSurfaces over the live
// `published-records` input) — the SAME catalog screen-arrangement mounts into its
// containers. group discovers the list from DATA and names NO product package: a new
// published surface appears on the board automatically, zero group edits.

import {
  findPlaceableSurfaces,
  type PublishedRecord,
} from '../../ui/show/placeable-surface-intent/placeable-surface-record';
import type { ShelfVariant } from './item-renderers';
import type { BoardItemDraft } from './item-add-strategies';
import type { PlaceableSurfacePayload } from '../../ui/show/placeable-surface-intent/placeable-surface-intent';

/** Default placed footprint (world units) for a live embedded surface. A dashboard /
 *  chat / leaderboard is unreadable at the default note size (220×160), so the board
 *  places it large enough to be usable immediately; the user can still resize it. This
 *  is the board's placement concern (L098) — the shared catalog owns WHAT surfaces
 *  exist, not HOW big the board renders them. */
export const LIVE_SURFACE_FOOTPRINT = { w: 380, h: 300 } as const;

/** The one shared-payload → board-draft translation used by both shelf and intents. */
export function placeableSurfaceDraft(payload: PlaceableSurfacePayload): BoardItemDraft | null {
  const entry = payload.packageEntry;
  if (!entry?.packageName || !entry.entryName) return null;
  return {
    kind: 'note',
    w: LIVE_SURFACE_FOOTPRINT.w,
    h: LIVE_SURFACE_FOOTPRINT.h,
    extra: {
      placeableSurface: {
        packageName: entry.packageName,
        entryName: entry.entryName,
        ...(payload.surfaceInput ? { surfaceInput: payload.surfaceInput } : {}),
      },
    },
  };
}

/**
 * Board "Live surface" variants derived from the live published-records. Only
 * surfaces that carry a `packageEntry` name pair are offered (that is what a board
 * item mounts via the blind PlaceableSurfaceHost); disabled surfaces are dropped.
 * Each variant seeds `extra.placeableSurface` so the placed node renders that live
 * package entry. Ordering follows the shared catalog's own `order`.
 */
export function placeableSurfaceVariants(publishedRecords: readonly PublishedRecord[]): ShelfVariant[] {
  return findPlaceableSurfaces(publishedRecords)
    .filter((s) => !s.disabled && s.listed !== false && !!s.packageEntry?.packageName && !!s.packageEntry?.entryName)
    .map((s) => {
      const draft = placeableSurfaceDraft({ packageEntry: s.packageEntry!, ...(s.surfaceInput ? { surfaceInput: s.surfaceInput } : {}) });
      if (!draft) return null;
      return ({
      id: `live-surface:${s.packageEntry!.packageName}:${s.packageEntry!.entryName}`,
      label: s.label,
      ...(s.icon ? { icon: s.icon } : {}),
      defaultW: LIVE_SURFACE_FOOTPRINT.w,
      defaultH: LIVE_SURFACE_FOOTPRINT.h,
      defaultExtra: draft.extra,
    });
    })
    .filter((value): value is ShelfVariant => value !== null);
}
