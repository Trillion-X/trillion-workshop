// packages/ui/show/canvas-history/command-history.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE one undo/redo owner, without React. The board's `useCanvasHistory` hook and
// the Visual Database's record undo both sequence their commands through
// `createCommandHistory`, so every screen gets the same guarantees instead of each
// keeping its own stack with its own bugs (L063, L069):
//
//   1. SAVED OR NOT MOVED. A command's apply/revert does its I/O first; the stack
//      only moves when that work succeeds. A command reports failure by throwing
//      (or rejecting). A failed undo leaves the step where it was, so the person can
//      try again; nothing is silently lost and the stack never claims a state the
//      saved record does not hold.
//   2. EDITS DURING AN UNDO ARE KEPT. Undo/redo await I/O, and the person can keep
//      editing meanwhile. A finishing transition is merged into the CURRENT stack
//      by command identity, never by writing back a stack computed before the
//      await, so an edit recorded mid-undo stays undoable (and, being a new
//      action, clears the redo branch exactly as `record` always does).
//   3. ONE TRANSITION AT A TIME. A second undo/redo while one is in flight reports
//      `busy` instead of replaying the same command twice.
//
// A command may also refuse because its target changed since it was recorded (a
// newer edit, another device). It throws a `StaleHistoryStepError`; the step is
// dropped rather than retried forever, because applying it would overwrite work
// that came after it (ProseMirror drops unmappable steps; Excalidraw re-versions).
//
// The stack transitions themselves (push clears the redo branch; undo/redo move a
// command between the two stacks) are the pure functions below.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** One reversible step. The caller builds both closures with its own context.
 *  Each closure THROWS (or rejects) when its work was not saved. */
export interface HistoryCommand {
  /** Re-applies the change (redo / forward replay). */
  apply: () => void | Promise<void>;
  /** Reverses the change (undo). */
  revert: () => void | Promise<void>;
}

export interface HistoryState {
  /** Done commands, oldest→newest. The last is the next to undo. */
  past: readonly HistoryCommand[];
  /** Undone commands, oldest→newest. The last is the next to redo. */
  future: readonly HistoryCommand[];
}

export const EMPTY_HISTORY: HistoryState = { past: [], future: [] };

/**
 * Record a freshly-applied command. A new action invalidates the redo branch
 * (you cannot redo into a future that no longer follows from the present), and
 * the past is capped at `limit` so an infinite editing session stays bounded.
 */
export function pushCommand(state: HistoryState, command: HistoryCommand, limit: number): HistoryState {
  const past = [...state.past, command];
  // limit <= 0 means "keep nothing" — guard against slice(-0) === slice(0),
  // which would (wrongly) keep the ENTIRE history instead of zero.
  return { past: limit > 0 ? past.slice(-limit) : [], future: [] };
}

/** Move the newest past command to the future; returns it to revert (or null). */
export function popUndo(state: HistoryState): { next: HistoryState; command: HistoryCommand | null } {
  if (state.past.length === 0) return { next: state, command: null };
  const command = state.past[state.past.length - 1]!;
  return { next: { past: state.past.slice(0, -1), future: [...state.future, command] }, command };
}

/** Move the newest future command to the past; returns it to apply (or null). */
export function popRedo(state: HistoryState): { next: HistoryState; command: HistoryCommand | null } {
  if (state.future.length === 0) return { next: state, command: null };
  const command = state.future[state.future.length - 1]!;
  return { next: { past: [...state.past, command], future: state.future.slice(0, -1) }, command };
}

/** Thrown by a command whose target changed since it was recorded: the step is dropped. */
export class StaleHistoryStepError extends Error {
  constructor(message = 'This changed after that step, so it can no longer be undone.') {
    super(message);
    this.name = 'StaleHistoryStepError';
  }
}

/** What one undo/redo did. `failed` keeps the step; `stale` dropped it. */
export type HistoryOutcome =
  | { status: 'done' }
  | { status: 'empty' }
  | { status: 'busy' }
  | { status: 'failed'; error: unknown }
  | { status: 'stale'; error: StaleHistoryStepError };

export interface CommandHistory {
  /** Record a just-saved command (clears the redo branch). */
  record: (command: HistoryCommand) => void;
  undo: () => Promise<HistoryOutcome>;
  redo: () => Promise<HistoryOutcome>;
  /** Drop all history (e.g. when the canvas identity changes). */
  clear: () => void;
  /** The current stacks. */
  state: () => HistoryState;
}

/** Remove the LAST occurrence of `command` from `list` (identity), if present. */
function without(list: readonly HistoryCommand[], command: HistoryCommand): HistoryCommand[] {
  const at = list.lastIndexOf(command);
  return at < 0 ? [...list] : [...list.slice(0, at), ...list.slice(at + 1)];
}

/**
 * Create a history. `onChange` fires after every stack change (the hook mirrors
 * sizes into React state from it). `limit` bounds the past depth (default 100).
 */
export function createCommandHistory(
  options: { limit?: number; onChange?: (state: HistoryState) => void } = {},
): CommandHistory {
  const limit = options.limit ?? 100;
  let state: HistoryState = EMPTY_HISTORY;
  // How many records happened, and whether a clear did, while a transition ran.
  let recordsSince = 0;
  let clearedSince = false;
  let busy = false;
  const set = (next: HistoryState) => {
    state = next;
    options.onChange?.(state);
  };

  const transition = async (direction: 'undo' | 'redo'): Promise<HistoryOutcome> => {
    if (busy) return { status: 'busy' };
    const from = direction === 'undo' ? state.past : state.future;
    const command = from[from.length - 1];
    if (!command) return { status: 'empty' };
    busy = true;
    recordsSince = 0;
    clearedSince = false;
    try {
      await (direction === 'undo' ? command.revert() : command.apply());
    } catch (error) {
      if (error instanceof StaleHistoryStepError) {
        // Drop the step wherever it now sits: it can never apply cleanly.
        set({ past: without(state.past, command), future: without(state.future, command) });
        return { status: 'stale', error };
      }
      // Not saved: the stack stays exactly where it was.
      return { status: 'failed', error };
    } finally {
      busy = false;
    }
    // History was dropped while the step ran (e.g. the canvas changed identity).
    if (clearedSince) return { status: 'done' };
    if (direction === 'undo') {
      // A record during the undo cleared the redo branch; the undone step is not
      // redoable on top of that newer action.
      set({
        past: without(state.past, command),
        future: recordsSince === 0 ? [...state.future, command] : [...state.future],
      });
    } else {
      // Re-applied before anything recorded during the redo, so it sits beneath them.
      const past = [...state.past];
      past.splice(Math.max(0, past.length - recordsSince), 0, command);
      set({ past: limit > 0 ? past.slice(-limit) : [], future: without(state.future, command) });
    }
    return { status: 'done' };
  };

  return {
    record: (command) => {
      recordsSince += 1;
      set(pushCommand(state, command, limit));
    },
    undo: () => transition('undo'),
    redo: () => transition('redo'),
    clear: () => {
      clearedSince = true;
      set(EMPTY_HISTORY);
    },
    state: () => state,
  };
}
