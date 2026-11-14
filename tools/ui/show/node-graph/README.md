# parts/ui/show/node-graph

Draws records as a graph of cards joined by lines (a tree, a flow, an org chart), laid out by the graph itself, with each card's state, face and progress coming from the caller's data.

## Files

| File | Purpose |
|------|---------|
| `NodeGraph.tsx` | The graph: lays nodes out (dag or free), draws each card (mark, title, state dot and label, progress bar) and the lines between them, moving a line while the work it leads to is active; states look the way the caller's `statusOverrides` say and colour through `toneToColor`. |
| `mount-node-graph.tsx` | Mounts a `NodeGraph` into a plain element for callers outside React. |
| `project-topology.ts` | Turns records plus a descriptor (which records are nodes, which fields make edges) into nodes and edges. |
| `roll-up.ts` | How much of the work under each node is done: the share of stated nodes below it (any depth) whose state the caller calls settled. Also read by the record views' Draw design (`../record-views/designs/records-on-a-board.ts`) for each card's done count. |
| `index.ts` | The folder's exports. |

## Key types / functions

| Name | Shape | Role |
|------|-------|------|
| `NodeGraph` | `(props: NodeGraphProps) => JSX.Element` | The graph component. |
| `GraphNodeInput` | `{id, label, status?, mark?: ReactNode, progress?: number, ...}` | One card; `mark` is drawn before the state dot (a face, an app mark, an icon), `progress` (0 to 1) draws a bar in the card's tone with its percentage. |
| `GraphEdgeInput` | `{id, from, to, status?, activity?}` | One line; `activity` moves it. |
| `mountNodeGraph` | `(element, props) => MountedNodeGraph` | Plain-element mount. |
| `projectTopology` | `(records, descriptor) => {nodes, edges}` | Records to graph; an edge path holding a list of ids (a record under several others) draws one edge to or from each. |
| `rollUp` | `(nodes, edges, settled: (status) => boolean) => Map<id, {done, of, share}>` | Branch progress; a node with no stated node under it is absent (never a guessed number). |

## Dependencies

**Depends on:** `react`, the shared `ui` primitives and the look's record-kind palette (`parts/screen-look/show/coss-workspace.css`).

**Depended on by:** `trillion-workshop/tools/keep-lists-of-rows` (`views/NodeGraphView.tsx`, drawn where a descriptor names the `nodegraph` kind) and `parts/ui/show/record-views/designs/records-on-a-board.ts` (`rollUp`). A list's canvas is Draw, the board (`src/workspace/draw-design.tsx`), not a graph drawn here.
