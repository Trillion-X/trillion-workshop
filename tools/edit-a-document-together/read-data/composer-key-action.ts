// packages/documents/read-data/composer-key-action.ts
//
// The pure keydown DECISION for the space→AI composer (C2/C3), extracted out of the 6000-line surface so
// it is a zero-DOM, zero-React, unit-testable function. The ComposerEditable's onKeyDown does exactly two
// things a machine can check: (1) map a physical key event to ONE of a fixed set of intents, and (2)
// perform that intent (preventDefault + call the matching callback). This module owns step (1) — a total,
// deterministic function over the four facts that decide it — so C2 ("Backspace on empty / Escape closes
// the composer and restores the block") and C3 ("Enter submits, Shift+Enter is a newline, and while an
// overlay is open it owns Arrow/Enter/Escape") are verifiable without the deploy-gated studio shell.
//
// The intents are Physics of THIS editable, not Society: they are the closed algebra of what a single-line
// prompt editor can decide from a keystroke (defer to an open overlay, submit, dismiss, or fall through to
// ordinary typing). It is not an extensible list of app commands — those live as DATA input-shortcut rows
// read elsewhere — so a plain union is correct here (enum-dissolution applies to open sets, not to the
// four terminal outcomes of one keystroke).

/** What the composer should do with a keystroke. `type` = let the browser insert the character (no
 *  preventDefault, no callback). `defer` = an overlay owns this key; do nothing here. */
export type ComposerKeyIntent = 'defer' | 'submit' | 'dismiss' | 'type';

/** The four facts that fully determine the outcome — no DOM, no event object. */
export interface ComposerKeyFacts {
  /** The KeyboardEvent.key value (e.g. 'Enter', 'Escape', 'Backspace', 'a'). */
  key: string;
  /** Whether Shift was held (Shift+Enter is a newline, not a submit). */
  shiftKey: boolean;
  /** Whether the composer's editable is currently empty (drives Backspace→dismiss). */
  isEmpty: boolean;
  /** Whether a mention picker OR command menu overlay is open (it owns Arrow/Enter/Escape). */
  overlayOpen: boolean;
}

/** Keys an open overlay (mention picker / command menu) consumes — the composer must not act on them. */
const OVERLAY_OWNED_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape']);

/**
 * Decide what the composer does with a keystroke. Total and pure: same facts → same intent, always.
 *
 * Order matters and encodes the rules exactly:
 *  1. An open overlay owns Arrow/Enter/Escape → `defer` (the stage's capture handler drives it).
 *  2. Enter without Shift → `submit` (Shift+Enter falls through to `type` = a real newline).
 *  3. Escape, or Backspace on an empty editable → `dismiss` (C2: close composer, restore the block).
 *  4. Anything else → `type` (ordinary editing; the browser inserts the character).
 */
export function composerKeyAction(facts: ComposerKeyFacts): ComposerKeyIntent {
  const { key, shiftKey, isEmpty, overlayOpen } = facts;
  if (overlayOpen && OVERLAY_OWNED_KEYS.has(key)) return 'defer';
  if (key === 'Enter' && !shiftKey) return 'submit';
  if (key === 'Escape' || (key === 'Backspace' && isEmpty)) return 'dismiss';
  return 'type';
}
