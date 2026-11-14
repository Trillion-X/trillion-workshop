// packages/ui/show/node-actions/node-action-types.ts
//
// A node action is a data-described thing you can do to a NodeRef. The generic
// context menu asks an owner-provided pack "which actions accept this node?"
// and renders the survivors. The core names NO action and NO node kind —
// `appliesTo` tests what the node exposes, never `switch(kind)` (Pattern 81).
//
// Sibling of DropIntentCapability {accepts,apply} and VisualLayerCapability
// {capabilityId,render}: one address-keyed-capability shape across the platform.

import type * as React from 'react';
import type { NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';

/** One owner-provided action over a node. The pack is built by the surface and
 *  closes over whatever services its `run`/`appliesTo` need — so the core stays
 *  blind to rename/background/bookmark/etc. */
export interface NodeActionCapability {
  /** Stable id (a string — DATA, never an enum variant). */
  readonly id: string;
  /** Row label. */
  readonly label: string;
  /** Lucide icon name → menu row icon. Required: the shared ActionMenu refuses
   *  a row without one, so no menu renders as plain text. */
  readonly icon: string;
  /** `'destructive'` gives the row the quiet destructive tone from screen-look. */
  readonly tone?: 'destructive';
  /** Right-aligned shortcut hint (display-only). */
  readonly shortcut?: string;
  /** Secondary descriptive line (below the label). Pure data — hosts read what
   *  they understand. Rendered as a muted subtitle in menu rows. */
  readonly hint?: string;
  /** Lower sorts earlier. Defaults to 0. */
  readonly priority?: number;
  /** Greyed-but-shown when true. */
  readonly disabled?: boolean;
  /** Capability/data test — does this action accept this node? NOT a kind switch. */
  accepts(nodeRef: NodeRef): boolean;
  /** Perform the action (leaf rows). Mutually exclusive with `submenu`. */
  run?(nodeRef: NodeRef): void | Promise<void>;
  /** Nested choices → a submenu panel. Mutually exclusive with `run`. */
  submenu?(nodeRef: NodeRef): readonly NodeActionCapability[];
  /** Open a rich editor panel (color wheel, rename field, grain slider, …)
   *  inside the menu's glass popover. The menu is BLIND to what this renders —
   *  it just hosts it and supplies `close`. Mutually exclusive with run/submenu. */
  editor?(nodeRef: NodeRef, close: () => void): React.ReactNode;
}

export type NodeActionPack = readonly NodeActionCapability[];

/** Actions that accept this node, sorted by priority (stable). */
export function acceptedNodeActions(pack: NodeActionPack, nodeRef: NodeRef): NodeActionCapability[] {
  return pack
    .filter((action) => {
      try {
        return action.accepts(nodeRef);
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/** Flat id → action lookup including one level of submenu children, for dispatch
 *  (the menu's child-selection fires the child's id at the top seam). */
export function indexNodeActions(
  actions: readonly NodeActionCapability[],
  nodeRef: NodeRef,
): Map<string, NodeActionCapability> {
  const index = new Map<string, NodeActionCapability>();
  for (const action of actions) {
    index.set(action.id, action);
    if (action.submenu) {
      try {
        for (const child of action.submenu(nodeRef)) index.set(child.id, child);
      } catch {
        /* skip a throwing submenu */
      }
    }
  }
  return index;
}
