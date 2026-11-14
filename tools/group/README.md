# group — the Universal Addressed Group owner package

The isolated package that owns the universal addressed group ontology: it
persists group membership and spatial-board state behind group addresses and
exposes a finished `GroupGraph` to consumers via the envelope boundary.

## Visual Canvas ownership

`group-board` is the canonical generic Visual Canvas entry. Product composition
DATA may label or configure it without owning a product canvas adapter. The
generic `build-application-board-surface-contribution` entry accepts only the
group-owned board-surface contribution address and materializes the surface in
the `package::group::*` namespace, pointing directly to `group/group-board`.
The application-composition primitive routes DATA to that entry but cannot mint
group records itself. `graph-canvas` remains an optional blind renderer
composed by its owner; it is not a second product surface. The retired Trillion
adapter is gone. The older `vision-board` wrapper remains a separate L101
migration and must not be treated as the canonical canvas or copied for new
products.

## Why this package exists (VB3-0 convergence, 2026-06-26)

The group ontology outlives any one layout — archives, boards, source-collections, and life-log groups are not screen-arrangement state. So the ontology lives here, in its own blind/generic/decoupled package, on top of the pure leaf `ui/show/group/group-graph` (the membership logic). Screen-arrangement, vision-board, etc. are consumers; screen-arrangement's `TabGroup` becomes a projection of this model later (migrated, not deleted now). Full verdict: `notes/.../vision-board/convergence/2026-06-26-group-and-presentation-decomposition-CONVERGED.md`.

## Files

| File | Purpose |
|------|---------|
| `read-data/group-eeaf.ts` | EEAF translation boundary (L098): folds raw group records → `GroupGraph` (read) and diffs two graphs → a minimal write-set (write). The ONLY place that knows the record shape. |
| `read-data/group-eeaf.test.ts` | Fold + write-set tests (parse/blind-tolerance/latest-wins; 1/2/delete/no-op write-sets; full round-trip). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `GroupRecord` | `{ address: string, value_json: unknown }` | A persisted group as it sits in the log (value parsed or JSON text). |
| `GroupWrite` | `{ address: string, value_json: Group }` | A write-batch entry the codec emits for the live writer. |
| `groupRecordAddress(groupRef)` | `→ string` | `package::group::group::<groupKey>` — the storage key SSOT. |
| `foldGroupRecords(records)` | `→ GroupGraph` | Read path: parse + validate + deterministically assemble. |
| `groupGraphWriteSet(before, after)` | `→ { upserts: GroupWrite[], deletes: string[] }` | Write path: minimal diff — only changed groups written, vanished groups deleted (O(changed)). |

## Architecture (storage ⇄ graph ⇄ consumer)

```
EEAF group records ──foldGroupRecords──▶ GroupGraph ──(leaf op: add/move/group/ungroup)──▶ GroupGraph'
        ▲                                                                                     │
        └────────────── live writer ◀── groupGraphWriteSet(before, after) ◀───────────────────┘
```

The membership rules (ordering, cycle detection, nesting) live in the leaf — this package never re-implements them (SSOT).

## Dependencies

**Depends on:** `ui/show/group/group-graph` (the pure leaf — canonical membership logic), `ui/show/visual-layer-stack/visual-layer-types` (`AddressRef`).
**Depended on by:** application-composition DATA through the registered
`build-application-board-surface-contribution` boundary, `vision-board`, archive
surfaces, and other consumers of addressed groups.

## Status

Built in source: the EEAF translation codec and write-set, group mutation/load
targets, generic board entries, package boundary DATA, and the owner-specific
application board-surface contribution target. Live admission and faithful
render/readback proof remain release responsibilities of the authorized writer.
