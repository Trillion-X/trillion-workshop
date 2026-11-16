// packages/group/show/board-selection-chrome-visibility.ts
// R53 SSOT: the single rule deciding whether a board's FLOATING SELECTION CHROME is
// visible — the bulk "Board tools" rail and the per-item toolbar. Both used to inline
// their own copy of the rule (`selectedIds.size >= 1 && !editingId` in one place,
// `editingId ? null : selectedItem` in the other), which could silently drift. This
// makes it ONE tested predicate every floating-selection-chrome surface calls.
//
// The rule: chrome shows when selected or explicitly opened, while NOT inline-editing a
// card. Editing (writing in a note) is a focus task — slamming the heavy analytics/
// smart-set rail + item toolbar open the instant the user starts typing felt
// "overwhelming" (the owner, 2026-07-10). The chrome returns the moment editing ends and the
// card is still selected.

export interface BoardSelectionChromeInputs {
  /** Is at least one board item currently selected? */
  readonly hasSelection: boolean;
  /** Is a card currently in inline-edit mode (editingId set)? */
  readonly editing: boolean;
  /** A person explicitly opened the inspector, including saved-query management. */
  readonly explicitlyOpened?: boolean;
}

export function boardSelectionChromeVisible({ hasSelection, editing, explicitlyOpened = false }: BoardSelectionChromeInputs): boolean {
  return (hasSelection || explicitlyOpened) && !editing;
}
