# Dockable Placement

Generic dock/float/collapse placement primitive for ANY dockable chrome — one primitive, N consumers (sidebar, drawing toolbar, future inspectors).

## Files

| File | Purpose |
|------|---------|
| `dockable-placement.ts` | Placement types/defaults, generic decode (accepts `size` or legacy `width`), pure selectors, per-instance optimistic store with persist-reconcile, `useDockablePlacement` controller (atomic `set(patch)` reads live store value). |
| `PositionCompass.tsx` | 4-cardinal position picker (extracted from the sidebar that proved it). |
| `index.ts` | Public exports. |

## Key Types / Functions

| Item | Shape | Role |
|------|-------|------|
| `DockablePlacementState` | `{position, dockState, mode, size, floatRect, seam?, foldedAt?, fit?}` | The placement truth shape. `size` = primary-axis size. `seam` docks it between two panes (`DockSeam {split, after}`, `dockSeamKey`), mode `folded` shows only a handle at `foldedAt` (`DockPoint`, shares of the window), `fit` (`DockFit {min?, max?}`) bounds how many rows a thin bar shows. |
| `createDockablePlacementStore(initial)` | → `{get, stage, reconcile, subscribe}` | Per-instance optimistic store. `stage` marks pending; `reconcile(owner)` is ignored until the owner echoes the staged value. |
| `useDockablePlacement(store, ownerState, persist?)` | → controller | Binds store + owner feed + persistence. Setters and `set(patch)` commit from the LIVE store value (multiple commits compose inside one handler). |
| `selectDockIsVertical/Floating/Orientation` | pure | Derived placement facts. |
| `PositionCompass` | component | Edge picker; consumer decides what selection means. |

## Dependencies

**Depends on:** react, lucide-react. ZERO `@bitfield/runtime-kit` — consumers own data reads and persistence.
**Depended on by:** `packages/sidebar` (durable: `sidebar-placement` feed + `action:update-sidebar-placement`), `packages/addressed-marks` MarkToolbar (ephemeral session placement).

## Invariants

- Stores are per-instance — two dockables never share state.
- No data/action vocabulary here: the sidebar's record shape and the toolbar's ephemerality are consumer Society.
- Reconcile never flickers a staged value back to stale owner state.
