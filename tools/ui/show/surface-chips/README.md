# surface-chips

A small tinted chip beside a navigation row's name ("New"), set by whoever decides it. An owner publishes the whole set (Trillion's page publishes one for each row a list with a `row_chip` holds, src/workspace/sidebar-rules-live.ts); each row reads the chip for its own id and draws it with the shared Badge. A chip names the list it comes from, so the row drawn inside that list does not repeat it.

## Files

| File | Purpose |
|------|---------|
| `surface-chips.ts` | The per-document chip table (on `globalThis`, so separately bundled scripts share it), publish and a React hook. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `SurfaceChip` | `{ label: string; variant?: string; from?: string }` | One chip: its words, the shared Badge variant it is drawn in, and the list (collection id) it comes from. |
| `publishSurfaceChips` | `(chips: ReadonlyMap<string, SurfaceChip>) => void` | Replace every chip; the same set again notifies nobody. |
| `useSurfaceChip` | `(id: string \| undefined) => SurfaceChip \| undefined` | React read of one row's chip (`useSyncExternalStore`). |

## Dependencies

**Depends on:** `react`.

**Depended on by:** `src/workspace/sidebar-rules-live.ts` (publishes), `parts/sidebar/show/SidebarContent.tsx` (a row draws its chip beside its name, `data-slot="sidebar-row-chip"`, except inside the list it comes from).

## Invariants

1. One table per document. 2. Publishing replaces the set whole. 3. An unchanged set notifies nobody. 4. Nothing here names a chip's words or tone: the publisher's DATA does (surfaces.json `row_chip`).
