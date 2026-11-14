# drag-reorder-list

The one sortable mechanism for vertical lists: while a row is dragged, the other rows slide out of its way and the dragged row's own place becomes the landing slot, drawn as a clear line where it will land.

## Files

| File | Purpose |
|------|---------|
| `use-drag-reorder.ts` | The mechanism: measures the rows once when a drag starts, plans where every row goes for the pointer's position, moves them by transform, commits once on drop, puts everything back when the drag ends elsewhere. Native drag plus touch. |
| `DragReorderList.tsx` | A list with grip handles and keyboard moves (ArrowUp/ArrowDown/Home/End) over the mechanism; announces the move target. |
| `SortableRows.tsx` | Wraps rows that start their own drag (a sidebar row, a filter rule) so they sort with the mechanism; keeps the dropped order until the caller's saved order arrives. | Draws the rows still until its moving half has arrived.
| `SortableRowsMoving.tsx` | The moving half of `SortableRows` (framer-motion `Reorder`), fetched the first time a list draws. |
| `index.ts` | Barrel. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `useDragReorder` | `({ids, onReorder(order, {id, before, after}), disabled?}) => {listProps, rowProps(id), touchProps(id), dragging, order}` | Spread `listProps` on the list and `rowProps(id)` on each row; any draggable element inside a row starts the sort. |
| `planReorder` | `(rows: MeasuredRow[], dragged, targetIndex) => {order, shifts}` | Pure: the new order and each moving row's pixel shift; rows restack with their original gap. |
| `targetIndexAt` | `(rows, dragged, clientY) => number` | Pure: which gap among the other rows the pointer points at. |
| `DragReorderList` | `({items: {id, label?, content}[], onReorder(newIds), className?, surface?: 'plain' \| 'grouped', handleAlign?: 'center' \| 'start'})` | Grip-handle list. `surface="grouped"` draws the rows as one bordered settings group with a hairline between rows (look: `screen-look/show/drag-reorder.css`, `[data-reorder-surface]`); `handleAlign="start"` keeps the grip level with the first line of a taller row (a title over more text). |
| `SortableRows` | `<T>({items, getId, renderItem, onReorder(order, moved), disabled?, className?, rowClassName?})` | `getId` must be stable. A rejected `onReorder` promise restores the saved order. |
| `reorderIds` | `(ids, id, index) => string[]` | Keyboard moves (from `reorder-control`). |

## Dependencies

**Depends on:** `react`, `../cn`, `../icon`, `../control-target`, `../drop-indicator` (announcements), `../reorder-control/reorder-operation`. Appearance: `parts/screen-look/show/drag-reorder.css` (`--reorder-shift-duration`, `--reorder-shift-ease`, `--reorder-line`; reduced motion moves rows instantly).

**Depended on by:** `sidebar/show/SidebarContent.tsx` (list rows, via `SortableRows`), `screen-arrangement/show/LayerPlacementPanel.tsx` (layers), `ui/show/rule-filter` (filter rules), `visual-database`.

## Invariants

- Only drags that start in this list move its rows; a row's own drag data is untouched, so a sidebar row can still be dropped on a pane.
- Rows move by transform only and are measured once per drag, so nothing reflows or jitters while dragging.
- `onReorder` fires once per drop, only when the order changed.

## References

21st.dev #23550 "Reorder List" (ddoemonn): spring-shifted rows and a lifted row; #12556 "Draggable Priority List" (native HTML5 drag with smooth transitions). Original code.
