// parts/ui/show/node-actions/contributed-node-actions.ts
//
// NO PRIOR: searched bitfield-packages/packages/ui/show/node-actions and packages/screen-arrangement for a way for a
// page to add entries to the one node menu; the menu took only the pack its surface built. This is the seam for that.
//
// PURPOSE
//   Actions a page adds to the one node menu every surface opens (a tray's "Add to tray"), without a second menu and
//   without the surface knowing them. A surface shows its own pack followed by every contributed action that accepts
//   the node, read each time the menu opens, so an action contributed after the surface mounted still shows.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Contributed actions are ordinary NodeActionCapability rows; the menu treats them exactly like the surface's own.
//   2. Contributing answers a function that takes the actions back out.

import type { NodeActionCapability, NodeActionPack } from './node-action-types';

const contributed: NodeActionCapability[] = [];

/** Adds `actions` to every node menu on the page; answers how to take them back out. */
export function contributeNodeActions(actions: NodeActionPack): () => void {
  contributed.push(...actions);
  return () => {
    for (const action of actions) {
      const at = contributed.indexOf(action);
      if (at >= 0) contributed.splice(at, 1);
    }
  };
}

/** Every action contributed so far, for a surface to show after its own. */
export function contributedNodeActions(): NodeActionPack {
  return contributed;
}
