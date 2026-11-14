// packages/ui/show/node-actions/batch-action-types.ts
//
// =============================================================================
// PURPOSE — P2: an Operation is a data-described capability over a TARGET SET
// =============================================================================
//
// A batch action is a data-described thing you can do to MANY NodeRefs at once,
// as ONE undoable transaction. It is the multi-target sibling of
// NodeActionCapability {accepts(ref), run(ref)} — same address-keyed-capability
// shape, refs→array. The generic bulk-select bar asks an owner-provided pack
// "which actions accept THIS set of nodes?" and renders the survivors. The core
// names NO action and NO node kind — `accepts` tests what the set exposes, never
// `switch(kind)` (Pattern 81 / enum-dissolution).
//
// This is THE category-eliminator (L063): every multi-edit the product will ever
// want — align, distribute, equal-size, lock, z-order, duplicate, nudge,
// set-frame, set-opacity, apply-layer-to-all, copy-bundle, apply-preset, tag,
// rotate — is ONE entry in a pack. Adding a multi-edit = adding one DATA-shaped
// capability, ZERO engine/dispatch code. The surface supplies the pack, closing
// over whatever services its run/accepts need, so the core stays blind.
//
// Sibling of NodeActionCapability, DropIntentCapability, VisualLayerCapability:
// one address-keyed-capability shape across the whole platform.
// =============================================================================

import type * as React from 'react';
import type { NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';

/** Services a batch action may need, supplied by the surface (kept opaque to the core). */
export interface BatchRunContext {
  /** The anchor/reference member of the set (e.g. align-to-primary), if any. */
  readonly primary: NodeRef | null;
  /** A free-form bag the surface may thread in (e.g. a live keyboard event). */
  readonly extras?: Record<string, unknown>;
}

/** One owner-provided action over a SET of nodes. */
export interface BatchActionCapability {
  /** Stable id (a string — DATA, never an enum variant). */
  readonly id: string;
  /** Row label (already in the user's language — never internal vocabulary). */
  readonly label: string;
  /** Lucide icon name → row icon. */
  readonly icon?: string;
  /** Any CSS color → row tint (e.g. red destructive). */
  readonly tone?: string;
  /** Lower sorts earlier. Defaults to 0. */
  readonly priority?: number;
  /** Greyed-but-shown when true. */
  readonly disabled?: boolean;
  /** Smallest set size this action needs (e.g. distribute needs ≥3). Default 1. */
  readonly minCount?: number;
  /** Capability/data test — does this action accept THIS set? NOT a kind switch. */
  accepts(refs: readonly NodeRef[]): boolean;
  /** Perform the action over the whole set as ONE transaction. The surface wraps
   *  this in a single canvas-history checkpoint + a single engine write-batch. */
  run?(refs: readonly NodeRef[], ctx: BatchRunContext): void | Promise<void>;
  /** Open a rich panel (opacity slider, frame picker, color wheel, preset list…)
   *  inside the bar's popover. The bar is BLIND to what this renders — it hosts it
   *  and supplies `close`. Mutually exclusive with `run`. */
  editor?(refs: readonly NodeRef[], close: () => void, ctx: BatchRunContext): React.ReactNode;
}

export type BatchActionPack = readonly BatchActionCapability[];

/** Actions that accept this set (and meet minCount), sorted by priority (stable). */
export function acceptedBatchActions(
  pack: BatchActionPack,
  refs: readonly NodeRef[],
): BatchActionCapability[] {
  return pack
    .filter((action) => {
      if (refs.length < (action.minCount ?? 1)) return false;
      try {
        return action.accepts(refs);
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/** Flat id → action lookup for dispatch. */
export function indexBatchActions(pack: BatchActionPack): Map<string, BatchActionCapability> {
  const index = new Map<string, BatchActionCapability>();
  for (const action of pack) index.set(action.id, action);
  return index;
}
