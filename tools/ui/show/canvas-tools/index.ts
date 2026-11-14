// packages/ui/show/canvas-tools/index.ts
//
// The canvas-tool primitive: ONE interpreter owns "what does this gesture mean
// right now"; the active tool's DATA row decides the intent. Dissolves the
// scattered pan-vs-marquee-vs-move-vs-draw branches (L055 root) into a single
// data-driven decision table (L063/L069).

export type {
  CanvasPoint,
  CanvasHit,
  CanvasHitKind,
  GestureChord,
  GesturePhase,
  CanvasIntent,
  CanvasIntentKind,
  ToolGestureTable,
  CanvasToolDescriptor,
  TemporaryToolRule,
  IntentHandler,
  IntentHandlerArgs,
  IntentHandlerMap,
} from './canvas-tool-types';

export {
  CANVAS_TOOLS,
  TEMPORARY_TOOLS,
  indexTools,
  toolForShortcut,
  resolveTemporaryTool,
  resolveIntent,
  chordOf,
} from './canvas-tools';

export { useCanvasTool } from './use-canvas-tool';
export type { CanvasToolApi, UseCanvasToolOptions } from './use-canvas-tool';

export { CanvasToolPicker } from './CanvasToolPicker';
export type { CanvasToolPickerProps } from './CanvasToolPicker';
