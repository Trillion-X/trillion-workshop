# composition-graph

The recursive NodeRef composition primitive — container, tab-group, layout, group, board, and archive are all configurations of one `{ref, members?}` node, dispatched by self-describing data, never a `switch(family)`.

## Files

| File | Purpose |
|------|---------|
| `composition-node.ts` | The `CompositionNode`/`GroupMember`/`CompositionGraph` types + pure structural-sharing mutations (add/remove/move member) + cycle-safe O(reachable) fold |
| `facet-registry.ts` | `FacetRegistry<T>` — the one uniform capability-resolution shape (resolve key → capability) presenting existing registries without copying (SSOT) |
| `index.ts` | Public barrel (re-exported from `@/packages/ui`) |
| `composition-node.test.ts` | Family-blind membership, structural sharing (P1), recursive cycle-safe fold (P2) — 11 tests |
| `facet-registry.test.ts` | Data-dispatch, total resolution, existing-registry adaptation — 5 tests |

## Key Types / Functions

| Type / Fn | Signature / Shape | Role |
|-----------|-------------------|------|
| `CompositionNode` | `{ ref: NodeRef; members?: readonly GroupMember[] }` | a node; `members` absent ⇒ leaf, present ⇒ group |
| `GroupMember` | `{ memberId; nodeRef; order?; role?; presentation? }` | one membership edge to a child of ANY family |
| `CompositionGraph` | `ReadonlyMap<string, CompositionNode>` | flat addressed graph; unchanged nodes share by reference (`===`) |
| `addMember/removeMember/moveMember` | `(graph, groupRef, …) → CompositionGraph` | pure, path-copy; one new node per mutation (P1) |
| `foldGroup/flattenGroup` | `(graph, rootRef, visit) → count` | recursive, cycle-safe, O(reachable) (P2) |
| `FacetRegistry<T>` | `{ resolve(key): T \| undefined; keys() }` | uniform capability lookup keyed by family/kind |
| `facetRegistryFromMap/FromGetter`, `resolveFacet` | builders + total resolve-with-fallback | dispatch by DATA, never a code switch |

## Dependencies

**Depends on:** `@/packages/ui/show/node-actions/node-ref` (`NodeRef`, `serializeNodeRef`) — the SAME address type the visual-layer stack, drop-intent router, and node-action menu already use.

**Depended on by:** (planned) `screen-arrangement` LayoutEngine (renders groups via the facet registry), `vision-board` (a board is a group node), and any future folder/dashboard/archive surface — board items, containers, layouts, drawings are all members.

## Why This Design?

A flat addressed graph (not nested node objects) gives structural sharing for free: a mutation creates ONE new node object and shares every other node by reference, so `===` detects exactly what changed (P1) and the fold touches only the reachable subtree (P2) — O(changed), not O(total), at quintillion-node scale. The core is storage-blind: it stores only `nodeRef.family + parts` and never asks what kind a member is (L090, enum-dissolution). This recursion is distinct from the visual-layer `children` recursion (that is visual-only and cannot hold arbitrary nodes).
