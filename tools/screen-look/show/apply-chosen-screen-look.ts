// parts/screen-look/show/apply-chosen-screen-look.ts
//
// PURPOSE
//   Paints a page in one of an app's theme records without the records runtime: a small page (a browser extension's
//   popup, a sign-in return page) hands over the same theme rows the app's workspace reads and the id it starts with,
//   and gets the same tokens on its root and the same bridges on its body (look-bridges.css), so its shared controls
//   look exactly as they do in the workspace.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The theme rows are the caller's one source (the app's looks DATA); nothing here holds a colour or a font.
//   2. Resolution is the shared resolver's (ApplyCurrentScreenLook.applyScreenLookTheme), never a copy of it.
//   3. An id the rows do not hold falls back the way the workspace does (readEditableScreenLookTheme's default).

import { readEditableScreenLookTheme } from '../read-data/read-editable-screen-look-themes';
import { applyScreenLookTheme } from './ApplyCurrentScreenLook';

/** Applies theme `themeId` from `themes` (published theme rows) to this document; answers the theme id applied. */
export function applyChosenScreenLook(themes: unknown, themeId: string): string {
  document.body.classList.add('screen-look-page');
  return applyScreenLookTheme(readEditableScreenLookTheme(themes, themeId));
}
