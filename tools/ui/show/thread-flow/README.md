# parts/ui/show/thread-flow

A left-to-right flow of hand-drawn nodes in columns, joined by links in the thread's colour, that carries a page's ScrollThread across it.

## Files

| File | Purpose |
|------|---------|
| `ThreadFlow.tsx` | Columns of nodes (cards, logo marks, steps, items, notes) and the curves between them. |

## Key Types / Functions

| Export | Shape | Role |
|--------|-------|------|
| `ThreadFlow` | `{ label, columns: FlowColumn[], threadFrom }` | Renders the flow. The first node is thread anchor `threadFrom` (the thread waits there, then lifts off); the last node of the last column is anchor `threadFrom + 1`, where the thread lands again. |
| `FlowColumn` | `{ id, nodes: FlowNode[] }` | One column. |
| `FlowNode` | `{ id, title?, detail?, figure?, mark?, steps?, items?, note?, highlighted?, compact?, threadPlace? }` | One node. `threadPlace` sets where the page's thread meets the first or last node. |
| `FlowMark` | `{ image?, icon?, letters?, label }` | A logo picture, a drawn icon (any component taking `size` and `strokeWidth`), or letters; a card's own icon or letters are drawn white on the thread's red. |

When the page's thread reaches the first node, the flow sets `data-flow-lit="true"` and its links draw themselves column by column; each column's nodes come alive as their links reach them (steps tick on in turn, items slide in). With reduced motion every link is drawn and nothing moves.

## Dependencies

**Depends on:** `show/sketch` (`SketchFrame`, `SketchFigure`, `HandNote`); `show/scroll-thread` (`data-thread-reached`, `data-thread-lift`); theme roles `--ink-line`, `--thread-line`, `--on-accent`, `--text-primary`, `--text-secondary`.
**Depended on by:** the gettrillion.ai red-thread landing (`trillion-site/src/designs/2026-09-27-red-thread`).
