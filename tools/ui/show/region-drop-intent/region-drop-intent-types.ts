// packages/ui/show/region-drop-intent/region-drop-intent-types.ts
//
// A region drop-intent is a data-described route for a subject dropped on a
// region. A region may accept many intents; the generic router never
// enumerates them. Sibling of VisualLayerCapability {accepts, render}: there a
// layer descriptor dispatches to a paint capability, here a dropped subject
// dispatches to an intent capability {accepts, apply}. Owner-provided map,
// no closed union (Pattern 81 enum dissolution).

import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

/**
 * Handed to an intent at hover and at drop. Readability differs by phase:
 *  - hover (accepts): only `dataTransfer.types` is readable — the browser hides
 *    file handles until the drop, so accepts decides from the type list.
 *  - drop (apply): the full `dataTransfer` is readable, including file handles.
 */
export interface RegionDrop {
  readonly region: AddressRef;
  readonly dataTransfer: DataTransfer;
  /** Viewport coordinates of the drop (present at apply, may be 0 at hover). */
  readonly clientX: number;
  readonly clientY: number;
}

/** One owner-provided intent. The router reads only the metadata fields and calls accepts/apply. */
export interface DropIntentCapability {
  /** Stable capability id (a string — Pattern 81, never an enum variant). */
  readonly id: string;
  /** Label rendered on this intent's zone. */
  readonly label: string;
  /** Named icon for the zone (resolved by the host icon set), when provided. */
  readonly icon?: string;
  /** Lower sorts earlier. Defaults to 0. */
  readonly priority?: number;
  /**
   * The catch-all intent owns the whole region (a drop anywhere routes here),
   * keeping the common action zero-aim. Other intents render as distinct zones.
   * Exactly one intent is the default; when an apply declines, the router
   * routes to it.
   */
  readonly isDefault?: boolean;
  /** Coarse, types-only acceptance test (see RegionDrop note). */
  accepts(drop: RegionDrop): boolean;
  /**
   * Perform the intent. Return false (or throw) to decline — the router routes
   * to the default intent so a drop is never lost. Return true/void to consume.
   */
  apply(drop: RegionDrop): boolean | void | Promise<boolean | void>;
}

/** An owner-provided set of intents. Order is by `priority`, not array index. */
export type DropIntentPack = readonly DropIntentCapability[];

/** Intents that accept this drag, sorted by priority (stable). */
export function acceptedIntents(pack: DropIntentPack, drop: RegionDrop): DropIntentCapability[] {
  return pack
    .filter((intent) => {
      try {
        return intent.accepts(drop);
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/** The default intent among a set (the whole-region fallback), or null. */
export function defaultIntent(intents: readonly DropIntentCapability[]): DropIntentCapability | null {
  return intents.find((intent) => intent.isDefault) ?? null;
}
