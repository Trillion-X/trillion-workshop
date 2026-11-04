// packages/group/read-data/board-tree.ts
//
// PURE recursive reads over the board TREE (root items + nested sections). These
// are the traversal core the board surface uses for export flattening (#142) and
// nested-child hide/lock/reorder (#153). Extracted verbatim out of the
// GroupBoardPanel show component so the traversal is unit-testable and the god
// surface shrinks (no behavior change — same functions, new home). Every function
// is a pure fold over `readItems`; none touch React, DOM, or component state.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { groupKey, type AddressRef, type GroupGraph } from '../../ui/show/group/group-graph';
import { readItems, type BoardItem } from './group-board-model';

/**
 * The ONE cycle-safe pre-order walk of the board tree — the SSOT every board-tree read
 * below is a configuration of. Calls `visit(item, parentRef)` for every item (root items
 * + nested-section descendants, sections themselves included), descending into a section's
 * group ref but NEVER re-entering a group already seen on this walk. `visit` may return a
 * value to STOP early (that value is returned); returning `undefined` continues.
 *
 * `visit` also receives `enclosingSectionId` — the memberId of the nearest ancestor SECTION
 * (undefined at the root) — so a caller that needs to tag each descendant with its folder (the
 * share-capsule flatten) reuses this ONE cycle-safe traversal instead of its own recursion.
 *
 * The `seen` guard is NOT optional: the graph is hydrated by `store.load()` DIRECTLY from
 * persisted records (`foldGroupRecords`), which does NOT run the write-path cycle guard
 * (`reaches` / `nestGroup`). A corrupted/hand-crafted persisted graph can therefore contain
 * a CYCLIC section nesting (group A → B → A) at read time — `store.load()`'s own BFS carries
 * a `seen` set for exactly this reason. Without the same guard here these reads would recurse
 * forever → stack overflow → crash on export/reorder/SHARE. Fail closed: a cyclic branch simply
 * contributes nothing (it is never re-descended). Pure, no I/O. Exported so the share-capsule
 * flatten (`board-to-capsule-source`) shares this SSOT rather than re-rolling the recursion.
 */
/** Depth ceiling for the tree walk. The `seen` set stops CYCLES, but a DEEP LINEAR chain of DISTINCT
 *  nested sections (A → B → C → … each unique, from a hostile/corrupted persisted graph) has no repeated
 *  key, so `seen` never fires and the recursion would still stack-overflow. Any real board nests sections
 *  a handful of levels; past this cap we stop descending (fail-closed — the ultra-deep branch contributes
 *  nothing, exactly like a cyclic one), so export/reorder/SHARE can never crash on adversarial nesting. */
const MAX_TREE_DEPTH = 1000;

export function walkTree<R>(
  graph: GroupGraph,
  rootRef: AddressRef,
  visit: (item: BoardItem, parentRef: AddressRef, enclosingSectionId: string | undefined) => R | undefined,
): R | undefined {
  const seen = new Set<string>([groupKey(rootRef)]);
  const walk = (ref: AddressRef, enclosingSectionId: string | undefined, depth: number): R | undefined => {
    if (depth > MAX_TREE_DEPTH) return undefined; // adversarial deep-linear nesting → stop, never overflow
    for (const it of readItems(graph, ref)) {
      const hit = visit(it, ref, enclosingSectionId);
      if (hit !== undefined) return hit;
      if (it.isSection) {
        const key = groupKey(it.nodeRef);
        if (seen.has(key)) continue; // cyclic / duplicate nesting → do not re-descend
        seen.add(key);
        const r = walk(it.nodeRef, it.memberId, depth + 1); // children's enclosing section = this section's memberId
        if (r !== undefined) return r;
      }
    }
    return undefined;
  };
  return walk(rootRef, undefined, 0);
}

/** Flatten the whole board TREE (root items + recurse into every nested section)
 *  into one world-space `BoardItem[]` for export. Section children carry
 *  world-space rectangles, so a flat list renders at the correct positions; the
 *  section itself stays in the list (exported as an outlined labelled rect).
 *  Cycle-safe via {@link walkTree}. */
export function flattenBoardTree(graph: GroupGraph, rootRef: AddressRef): BoardItem[] {
  const out: BoardItem[] = [];
  walkTree(graph, rootRef, (it) => {
    out.push(it);
    return undefined; // collect all, never stop early
  });
  return out;
}

/** The OWN nodeRef of the member `id` anywhere in the tree under `rootRef` — for a
 *  SECTION this is its group ref (the parent of its children), used to reorder
 *  children within that section (#153). Cycle-safe via {@link walkTree}. */
export function findMemberRef(graph: GroupGraph, rootRef: AddressRef, id: string): AddressRef | null {
  return walkTree(graph, rootRef, (it) => (it.memberId === id ? it.nodeRef : undefined)) ?? null;
}

/** The GROUP ref that CONTAINS member `id` (its parent) — top-level → `rootRef`,
 *  a section child → the section's nodeRef. Used to toggle a nested child's
 *  hide/lock flag against the correct group (#153). Cycle-safe via {@link walkTree}. */
export function findParentRef(graph: GroupGraph, rootRef: AddressRef, id: string): AddressRef | null {
  return walkTree(graph, rootRef, (it, parentRef) => (it.memberId === id ? parentRef : undefined)) ?? null;
}
