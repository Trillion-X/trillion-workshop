// packages/ui/show/canvas-history/use-canvas-history.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A generic undo/redo command-history primitive — the Lindy/n8n/Figma canvas
// toolbar's ↶↷ and Cmd-Z / Cmd-Shift-Z. It is BLIND: it knows nothing about
// nodes, definitions, layouts, boards, or workflows. A caller records a
// `HistoryCommand` (a pair of `apply` / `revert` closures it builds with its own
// context); the history just sequences them. Every canvas mutation — move, edit,
// add-step, fork, delete, a multi-item BATCH transaction — reduces to one
// recorded command, so undo/redo work uniformly for all of them with ZERO
// per-mutation special-casing here (L069: one primitive, N callers).
//
// HOMED IN `ui` (was workflow-canvas): undo/redo is not a workflow concept, it
// is a canvas concept. The board (group), the workflow canvas, screen-arrangement
// and any future canvas all consume this ONE owner (SSOT). The workflow-canvas
// path re-exports from here for back-compat.
//
// =============================================================================
// WHY A PURE CORE + A THIN HOOK
// =============================================================================
//
// The stack transitions (push clears the redo branch; undo/redo move a command
// between the two stacks) are pure and exhaustively unit-tested below the React
// layer. The hook is a thin shell: it holds the stacks in refs (no stale
// closures) and mirrors their sizes into one state so `canUndo`/`canRedo`
// re-render the toolbar. Side-effects (apply/revert) fire OUTSIDE any state
// updater, so React StrictMode's double-invoked updaters can never double-write.
//
// Undo/redo are ATOMIC against I/O failure: the command does its async work
// (re-save / retract) FIRST, and the stack only advances if that work succeeds.
// A command signals an unsaved step by THROWING — a closure that swallows its
// save error and resolves would make the stack lie, so callers must rethrow.
// A rejected engine write thus leaves the stack exactly where it was — stack and
// reality never diverge. An in-flight guard serializes them so a double-click
// can't replay one command twice, and an edit recorded while an undo is still
// saving is merged into the current stack, never overwritten (command-history.ts).
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { useCallback, useRef, useState } from 'react';
import {
  createCommandHistory,
  type CommandHistory,
  type HistoryCommand,
  type HistoryOutcome,
} from 'trillion-workshop/tools/ui/show/canvas-history/command-history.ts';

// The pure stack and the React-free owner live in ./command-history; re-exported
// here so existing imports keep one path.
export {
  EMPTY_HISTORY,
  StaleHistoryStepError,
  createCommandHistory,
  popRedo,
  popUndo,
  pushCommand,
} from 'trillion-workshop/tools/ui/show/canvas-history/command-history.ts';
export type { CommandHistory, HistoryCommand, HistoryOutcome, HistoryState } from 'trillion-workshop/tools/ui/show/canvas-history/command-history.ts';

export interface CanvasHistory {
  /** Record a just-applied command (clears the redo branch). */
  record: (command: HistoryCommand) => void;
  /** Resolves with what happened, so a caller can tell the person a step failed. */
  undo: () => Promise<HistoryOutcome>;
  redo: () => Promise<HistoryOutcome>;
  canUndo: boolean;
  canRedo: boolean;
  /** Drop all history (e.g. when the canvas identity changes). */
  clear: () => void;
}

/**
 * React binding over the one history owner. `limit` bounds the past depth (default 100).
 */
export function useCanvasHistory(limit = 100): CanvasHistory {
  // Mirror only the sizes into state — that is all the UI needs to re-render
  // (button enabled/disabled). The commands themselves live in the owner.
  const [sizes, setSizes] = useState<{ past: number; future: number }>({ past: 0, future: 0 });
  const ownerRef = useRef<CommandHistory | null>(null);
  if (!ownerRef.current) {
    ownerRef.current = createCommandHistory({
      limit,
      onChange: (state) => setSizes({ past: state.past.length, future: state.future.length }),
    });
  }
  const owner = ownerRef.current;

  const record = useCallback((command: HistoryCommand) => owner.record(command), [owner]);
  const report = (direction: string) => (outcome: HistoryOutcome) => {
    if (outcome.status === 'failed') console.error(`[canvas-history] ${direction} failed; stack left unchanged`, outcome.error);
    return outcome;
  };
  const undo = useCallback(() => owner.undo().then(report('undo')), [owner]);
  const redo = useCallback(() => owner.redo().then(report('redo')), [owner]);
  const clear = useCallback(() => owner.clear(), [owner]);

  return { record, undo, redo, canUndo: sizes.past > 0, canRedo: sizes.future > 0, clear };
}
