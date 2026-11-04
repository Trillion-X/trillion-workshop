// packages/group/read-data/search-field-key.ts
//
// The search FIELD keyboard→intent map — the tiny generative primitive behind "what should a key do
// while the cursor is in the board's search box". Given the pressed key, whether Shift is held, and the
// current search state (is there a query, how many matches, can we step), it returns ONE self-describing
// intent; the bar is a blind dispatcher of that intent. Pure + deterministic, names nothing about the
// board — it is the single place the find-field lifecycle (step / clear / dismiss) is decided.
//
// The lifecycle it completes: OPEN + FOCUS is an imperative act (BoardFocusBarHandle.focusSearch, driven
// by ⌘F / "/" on the canvas); STEP + CLEAR + BLUR are keystrokes IN the field, and those three are what
// this map decides. Enter → next match, Shift+Enter → previous (the find-in-field canon); Escape is a
// TWO-STAGE dismiss — first press clears a non-empty query (stay in the field), second press (empty
// query) blurs back to the canvas (the Figma/Miro/browser-find canon). Every other key → null (the field
// keeps its native behaviour: typing, arrows within the text, etc.).

/** The intent a key produces while focused in the search field. `null` = no board-level intent (native). */
export type SearchFieldIntent = 'step-next' | 'step-prev' | 'clear' | 'blur' | null;

export interface SearchFieldKeyState {
  /** `KeyboardEvent.key`. */
  key: string;
  /** Whether Shift is held (only affects Enter → prev). */
  shiftKey: boolean;
  /** Is the query non-empty — decides Escape's stage (clear vs blur). */
  hasQuery: boolean;
  /** How many items currently match — Enter only steps when there is something to step to. */
  matchCount: number;
  /** Whether stepping is wired at all (onStepMatch provided). When false, Enter is native. */
  canStep: boolean;
}

/**
 * The intent for one keystroke in the search field. Enter (+Shift) steps only when stepping is wired and
 * at least one match exists; Escape clears a non-empty query else blurs; anything else is native (null).
 */
export function searchFieldKeyIntent(state: SearchFieldKeyState): SearchFieldIntent {
  const { key, shiftKey, hasQuery, matchCount, canStep } = state;
  if (key === 'Enter') {
    if (!canStep || matchCount <= 0) return null;
    return shiftKey ? 'step-prev' : 'step-next';
  }
  if (key === 'Escape') return hasQuery ? 'clear' : 'blur';
  return null;
}
