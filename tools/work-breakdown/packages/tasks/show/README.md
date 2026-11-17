# tasks/show

React surface for the tasks package: list, kanban, and dependency-DAG views over task records, windowed so large task counts cannot freeze the app.

## Files

| File | Purpose |
|------|---------|
| `mount-tasks.tsx` | Browser package entry: reads task inputs and mounts `TasksPanel` |
| `TasksPanel.tsx` | View shell: search/filter state, view switcher (list/kanban/DAG), task detail routing |
| `TaskList.tsx` | Filtered task rows; rows render through the shared ui `VirtualList` above 150 tasks (self-scrolling viewport, O(visible) DOM at any N) |
| `KanbanBoard.tsx` | Status-lane board; each column's cards window through `VirtualList` above 100 cards (self-scrolling column viewport) |
| `KanbanCard.tsx` | One task card (title, status, meta) used by the kanban columns |
| `TaskDAG.tsx` | Dependency graph rendering over the computed DAG layout |
| `compute-task-dag-layout.ts` | Pure DAG layout computation (nodes/edges/positions) for `TaskDAG` |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `TaskList` | `({ tasks, onTaskClick })` | Filtered rows; windowing constants `TASK_LIST_VIRTUALIZATION_THRESHOLD = 150`, `TASK_ROW_ESTIMATED_HEIGHT = 48`, `TASK_LIST_VIEWPORT_HEIGHT = 640` |
| `KanbanBoard` | `({ tasks, onTaskClick })` | Lane columns; per-column `VirtualList` (estimate 96px, threshold 100, maxHeight 640) |
| `KanbanCard` | `({ card, onClick })` | Single card view |
| `TaskDAG` / `computeTaskDagLayout` | graph view + pure layout | Dependency visualization |

## Dependencies

**Depends on:** `tools/ui` (including `VirtualList`), tasks package read-data decoders, `lucide-react` icons.
**Depended on by:** `mount-tasks.tsx` (browser entry), studio Tasks placeable surface.
