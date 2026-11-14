# reorder-control

An accessible control that reorders a list by drag, touch, keyboard or move buttons, each producing one complete ordered list of ids for the caller to keep; ported verbatim from Bitfield `ui/show/reorder-control` (only import paths changed).

## Files

| File | Purpose |
|------|---------|
| `reorder-operation.ts` | The one order operation every way of moving uses: `reorderIds`, `reorderBeforeId`, `beforeIdForTarget`, `orderChanged`. |
| `ReorderControl.tsx` | The control: drag handle, move buttons and keyboard moves, calling back with the new order and a `preview` the caller paints. |
| `index.ts` | Re-exports both. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `reorderIds` | `(ids, movedId, targetIndex) => string[]` | The new order after one move. |
| `ReorderPreview` | `{movedId, beforeId}` | Where the moved item would land, for the caller's insertion mark. |
| `REORDER_DRAG_MIME` | `'application/x-bitfield-reorder-id'` | The drag data type the control carries. |

## Dependencies

**Depends on:** `../button`, `../drop-indicator`, `../expandable-tabs`, `../icon`.

**Depended on by:** `trillion-workshop/tools/keep-lists-of-rows/show/VisualDatabaseSurface.tsx` (field and view order).
