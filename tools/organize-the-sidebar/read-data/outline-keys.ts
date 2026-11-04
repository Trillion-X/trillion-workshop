// packages/group/read-data/outline-keys.ts
//
// The PURE keyboard grammar of an outliner: Tab indents, Shift+Tab outdents, Enter splits a new
// sibling row below, Backspace on an empty row deletes it (merging focus upward). This is what
// makes an outline feel like Workflowy/Notion instead of a form of buttons. It owns ONLY the
// (items, keystroke) → (new items, which row to focus) transform, deferring every STRUCTURE op
// to the list-block-model leaf (indent/outdent/normalize). Deterministic, no React, no DOM, no
// I/O — the id of a new row is INJECTED (`newId`) so the transform stays pure and testable.

import { indentItem, normalizeIndents, outdentItem, type ListItem } from './list-block-model';

export interface OutlineKeyResult {
  readonly items: ListItem[];
  /** The row the caller should focus after applying `items` (null → leave focus alone). */
  readonly focusId: string | null;
}

/**
 * Apply an outliner keystroke. Returns the new items + focus target, or `null` when the key is
 * not an outline command (the caller lets the default happen — normal typing, caret moves).
 *
 * - Tab            → indent this row one level (clamped by the leaf's legality rule); keep focus.
 * - Shift+Tab      → outdent one level, then normalize; keep focus.
 * - Enter          → insert a new empty sibling row directly below at the SAME indent; focus it.
 * - Backspace (empty row, not the only row) → delete the row; focus the previous (or next) row.
 */
export function handleOutlineKey(
  items: readonly ListItem[],
  id: string,
  key: string,
  shiftKey: boolean,
  rowIsEmpty: boolean,
  newId: string,
): OutlineKeyResult | null {
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return null;

  if (key === 'Tab' && !shiftKey) return { items: indentItem(items, id), focusId: id };
  if (key === 'Tab' && shiftKey) return { items: normalizeIndents(outdentItem(items, id)), focusId: id };

  if (key === 'Enter') {
    const indent = items[idx].indent;
    const next = [...items.slice(0, idx + 1), { id: newId, text: '', indent }, ...items.slice(idx + 1)];
    return { items: next, focusId: newId };
  }

  if (key === 'Backspace' && rowIsEmpty && items.length > 1) {
    const focusId = items[idx - 1]?.id ?? items[idx + 1]?.id ?? null;
    return { items: normalizeIndents(items.filter((it) => it.id !== id)), focusId };
  }

  return null;
}
