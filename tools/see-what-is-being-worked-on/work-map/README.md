# parts/work-map/

Everything being worked on, by every AI and every person, as one live tree: goals, the goals under them, the decisions made for them, the jobs those decisions started, who is doing each, and the people in each space. A view over records the person's store already answers; nothing here keeps anything.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The files other parts may import. |
| `read-data/join-records.mjs` | `joinRecords`: joins rows from several answers into one tree of nodes and parent-to-child lines, from source DATA alone. A source can translate state values or provide a default state when the source row has no state (such as a manually started workflow). `valueAt`: reads a path of keys (`*` for every item) in a row. `branchOf`: one node and everything under it, for starting from one goal. |
| `read-data/join-records.test.mjs` | Every kind hangs where its rows say; a parent that is not shown falls through to whoever does it, then the root; one person in several spaces is one node with a line from each. |
| `read-data/work-map-sources.json` | DATA: the reads (`/work/api/decisions`, `/work/api/ai-work`, `/work/api/spaces`, `/work/api/workflows`, `/work/api/workshop`), the root, and one row per kind of record (where its rows are, its id, title, detail, state and time fields, who does it, what it hangs under, its icon and the screen it opens on). A new kind on the map is one row. |
| `show/work-map-screen.tsx` | The screen module (`mount(element, { surfaceInput })`): the work at a glance (shared StatusOverview over the work-state looks), then the shared record views as Draw (default: the tree's cards and lines on the one board, `src/workspace/draw-design.tsx`), Board by state, Table and Timeline. Cards lead with who does the work, take their colour and motion from the work-state looks, and show how much of the work under them is done. Tapping a card opens it. Active schedules, triggers, workflows and Workshop runs come from their existing account reads and appear in Timeline by their next or start time. Reads itself again when the store changes. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `joinRecords({ root, sources, answers })` | `→ { nodes: { id, source, kind, icon, title, detail, at, status?, who?, row }[], lines: { id, from, to }[] }` | Ids are `<source>:<row id>`; only rows an answer held become nodes; only lines between shown nodes are drawn. |
| `branchOf({ nodes, lines }, from)` | `→ { nodes, lines }` | The card `from` and every card under it at any depth; an unknown `from` returns the whole tree. The screen starts here when the person picks a goal above the map (sources marked `start_from`) or opens it with `{ goal: <id> }`, and the glance then reads "Where to go now". |
| `valueAt(row, path)` | `(object, string[]) → unknown[]` | Every value at a path of keys; `*` takes every item of a list. |
| `mount(element, props)` | `→ () => void` | The module screen contract (`tool:screen-work-map`, `records/workshop-screen-tool-records.json`). |

## Dependencies

**Depends on:** `parts/ui` (record views and their Draw design, `roll-up.ts` through `records-on-a-board.ts`, status overview, person tag, provider marks, screen states), `parts/screen-look/show/work-state-looks.json` (each state's words, tone, motion and `settled`), the workspace's `api.ts`, `open-screen.ts`, `record-filter.ts`, `store-changes.ts`, `failure.ts` and `activity-providers.json`.

**Depended on by:** `tool:screen-work-map` (records/workshop-screen-tool-records.json), built as a screen module by `scripts/screen-modules.mjs`.
