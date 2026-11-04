// packages/group/show/paste-to-notes.ts
//
// The "bulk create" transform (Miro/FigJam canon): pasted plain text becomes ONE
// sticky-note draft per non-empty line, so a brain-dump list ("buy milk\nwash car\n
// call mom") drops onto the board as a grid of notes in a single paste. A pure leaf
// (zero I/O, zero DOM) — the paste handler splits the text here, then hands the drafts
// to the SAME `fillFromDrafts` → `layoutDraftsToOutput` multi-place primitive the
// producer fill uses (one commit, one undo step, tidy sqrt-grid layout). No new
// placement code, no per-line commit (L093 reuse).
//
// Lines are trimmed and blanks dropped so pasted prose with trailing newlines doesn't
// mint empty cards; the count is capped (a paste that would explode into thousands of
// stickies is never intended) and each line is length-clamped. Empty / whitespace-only
// text returns [] so the caller falls through to its next paste branch (internal
// clipboard) unchanged.

import type { BoardItemDraft } from './item-add-strategies';

/** Max notes one paste can mint — a runaway paste (a whole document) is never a
 *  deliberate "one sticky per line", so we cap rather than freeze the board. */
export const MAX_PASTE_NOTES = 200;
/** Per-note text clamp — a single pathological megabyte line can't bloat one card. */
export const MAX_PASTE_NOTE_LEN = 2000;

/**
 * Split pasted plain text into note drafts, one per non-empty line. Returns `[]` for
 * empty/whitespace-only input (the caller falls through). A single non-empty line →
 * one note (paste-text-onto-canvas is itself canonical); many lines → a note each,
 * which the caller's grid layout arranges. Pure + deterministic.
 */
export function textToNoteDrafts(text: string): BoardItemDraft[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_PASTE_NOTES)
    .map((line) => ({ kind: 'note', text: line.slice(0, MAX_PASTE_NOTE_LEN) }));
}
