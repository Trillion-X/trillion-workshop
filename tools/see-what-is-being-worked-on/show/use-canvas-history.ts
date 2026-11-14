// packages/workflow-canvas/show/use-canvas-history.ts
//
// RE-EXPORT SHIM. The undo/redo canvas-history primitive was HOMED in `ui`
// (packages/ui/show/canvas-history) because undo/redo is a canvas concept, not a
// workflow concept — the board (group), workflow canvas, screen-arrangement and
// any future canvas all consume the ONE owner (SSOT, L088). This path stays as a
// thin re-export so existing workflow-canvas consumers and the co-located test
// keep working with zero churn. Do NOT re-add an implementation here (L030).
export {
  useCanvasHistory,
  pushCommand,
  popUndo,
  popRedo,
  EMPTY_HISTORY,
} from '../../ui/show/canvas-history/use-canvas-history';
export type {
  HistoryCommand,
  HistoryState,
  CanvasHistory,
} from '../../ui/show/canvas-history/use-canvas-history';
