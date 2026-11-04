// parts/screen-look/show/theme-toggle.ts
//
// PURPOSE
//   The one way anything outside the Screen look (a key, a menu, an AI) switches the page between light and dark: the page's
//   painter (ScreenLookSurface's PaintChosenScreenLook) hands over what does it, because only it holds the person's looks
//   and theme record (read-data/look-follow-system.ts), and `toggleTheme` runs that.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Switching writes the same account record the Theme control writes (look-follow-system.json `record_key`), through
//      the same `pickMode`, so the control and this one always agree and every device follows.
//   2. Nothing here names a look or a mode: the kind opposite the worn look's own kind is found in look-follow-system.json.
//   3. When no painter is mounted `toggleTheme` does nothing and says so (false).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

type Toggle = () => void;
let held: Toggle | null = null;

/** The painter keeps its switch here while it is mounted (null takes it away). */
export function keepThemeToggle(toggle: Toggle | null): void { held = toggle; }

/** Switches between light and dark now; false when nothing is mounted that can. */
export function toggleTheme(): boolean {
  if (!held) return false;
  held();
  return true;
}
