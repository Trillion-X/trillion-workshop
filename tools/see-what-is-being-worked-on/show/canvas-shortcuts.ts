// packages/workflow-canvas/show/canvas-shortcuts.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure keyboard-shortcut decisions for the canvas — the testable core behind the
// WorkflowCanvas keydown effects. Keeping the decision pure (no React, no DOM)
// means the "should this key do X?" rules are exhaustively unit-tested, and the
// effect is a trivial shell that reads the event and calls the action.
//
// Every rule here is capability-driven, never node-kind: a node is deletable
// because it carries the `editable` flag, not because it is an "action".
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** The shortcut the node menu shows beside Delete; the same keys delete the selected node below. */
export const DELETE_SELECTED_NODE_SHORTCUT = { key: 'Backspace' } as const;

export interface DeleteIntentInput {
  /** KeyboardEvent.key. */
  key: string;
  /** event.target.tagName (uppercase), or null. Guards against deleting while
   *  the caret is in a text field. */
  targetTag: string | null;
  /** event.target.isContentEditable. */
  isContentEditable: boolean;
  /** A node is currently selected. */
  hasSelection: boolean;
  /** The selected node is editable — a capability flag, NOT a node-kind check.
   *  Triggers / shipped nodes are not editable, so they are not deletable. */
  selectedEditable: boolean;
}

/**
 * True when a Delete/Backspace keydown should remove the selected node:
 * the key is a delete key, the caret is NOT in a text field (so text editing
 * keeps its own Backspace), and an editable node is selected.
 */
export function isDeleteSelectedNodeIntent(input: DeleteIntentInput): boolean {
  if (input.key !== 'Delete' && input.key !== 'Backspace') return false;
  if (input.targetTag === 'INPUT' || input.targetTag === 'TEXTAREA' || input.isContentEditable) {
    return false;
  }
  return input.hasSelection && input.selectedEditable;
}
