# ui/show/group — Universal Addressed Group

The blind, infinitely-nesting membership-graph primitive: a group holds ordered members that are `AddressRef`s of ANY family (tab, container, layout, drawing, surface, board, or another group), and the core never enumerates what it holds.

## Files

| File | Purpose |
|------|---------|
| `group-graph.ts` | Pure membership-graph data model + operations (add/remove/move/reorder/group/ungroup, cycle-safe). Zero I/O, zero randomness, plain-JSON state. |
| `group-graph.test.ts` | Adversarial combinatorial gauntlet (L069): every op composed with every other + cycle attacks + group/ungroup round-trips. |
| `index.ts` | Public barrel. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `GroupGraph` | `{ groups: Record<groupKey, Group> }` | Whole graph; flat map keyed by `serializeNodeRef(groupRef)`. |
| `Group` | `{ groupRef: AddressRef, memberOrder: string[], members: Record<memberId, GroupMember> }` | One group; array position IS the order. |
| `GroupMember` | `{ memberId, nodeRef: AddressRef, role?, presentation? }` | A membership edge; `nodeRef` may equal a group's `groupRef` → nesting (I2). |
| `Placement` | `{index}|{before}|{after}|{at:'start'\|'end'}` | Where to insert/move; absent → end. |
| `emptyGraph()` / `ensureGroup(g,ref)` | `→ GroupGraph` | Construct / idempotently add a group. |
| `addMember(g,group,nodeRef,{memberId,role?,presentation?,placement?})` | `→ GroupGraph` | Add a member; throws on duplicate id or cycle. |
| `removeMember` / `reorderMember` / `moveMember` | `→ GroupGraph` | Remove, reorder within a group, move across groups (preserves identity/role/presentation). |
| `groupMembers(g,parent,memberIds,newGroupRef,{wrapperMemberId})` | `→ GroupGraph` | "Select N → group them": wrap a selection into a new sub-group placed at the first selection slot. |
| `ungroupMembers(g,parent,wrapperMemberId)` | `→ GroupGraph` | Inverse of groupMembers: lift a sub-group's members back at the wrapper slot, dissolve the sub-group. |
| `setMemberFields` | `→ GroupGraph` | Set/clear opaque `role`/`presentation`. |
| `membersOf` / `memberById` / `getGroup` / `hasGroup` | reads | Ordered members / lookup. |
| `nestedByIdentity(graph, identityOf?)` | `→ {parents, children}` by record identity | The one reading of a list's nesting every view shares (the visual-database Tree, the record-views thread design). |
| `reaches(g,candidate,target)` | `→ boolean` | Does `candidate` transitively contain `target`? (cycle guard) |
| `isGroupGraph(value)` | type guard | Structural validator for persisted state. |

## Invariants

- **I1 Blind core (L090):** stores only `nodeRef.family + parts`; never enumerates family. New families work for free.
- **I2 Nesting by reference (L069):** a group is a node, so referencing a group as a member nests it — sub-groups are not a special case.
- **I3 Pure (no ambient authority):** every op returns a NEW graph, sharing untouched groups by reference; the caller supplies every `memberId` (no Date/random).
- **I4 One Physics invariant:** a group can never transitively contain itself (cycle detection in `reaches`).
- **I5 Machine-readable:** plain-JSON Records → serializes straight into EEAF, no codec.

## Dependencies

**Depends on:** `ui/show/visual-layer-stack/visual-layer-types` (`AddressRef`), `ui/show/node-actions/node-ref` (`serializeNodeRef`).
**Depended on by:** the forthcoming isolated `group` package (EEAF entity + workflow defs + read fold) and, through it, `vision-board`, archives, and any consumer that arranges addressed nodes. Screen-arrangement's `TabGroup` is a future projection of this model (migrated later, not deleted now).

## Why This Design?

This is the L088 bedrock of the VB3-0 convergence: the group ontology outlives any one layout (archives, boards, source-collections, life-log all read it), so it lives in a shared pure leaf — not inside screen-arrangement. The owner package wraps this leaf with persistence + workflow; every consumer composes it via `AddressRef`, with zero cross-package import.
