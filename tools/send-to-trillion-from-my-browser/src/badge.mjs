// extension/src/badge.mjs
//
// PURPOSE
//   The one owner of the toolbar button's badge. Several things want to show there (a recording running, notices the
//   person has not read, things waiting in the tray); each sets its own mark, and the badge shows the first mark that
//   has something to say, in the order of settings.json `badge` (each row names a mark and the colour of the worn look
//   it shows in, by its palette name: extension/src/worn-look.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing else calls chrome.action.setBadgeText or setBadgeBackgroundColor: a second writer would erase the
//      first one's mark.
//   2. A mark is a word (REC) or a count; an empty word, zero or null says nothing and the next row is shown.
//   3. Marks live in session storage (`mark:<name>`), one key each, so two writers never overwrite each other.
//   4. Which marks exist and their order and colours are DATA; this file never names one.

import settings from '../settings.json' with { type: 'json' };
import { wornColor } from './worn-look.mjs';

const key = name => `mark:${name}`;
const says = value => (typeof value === 'number' ? value > 0 : typeof value === 'string' && value !== '');

/** The first row whose mark says something, as { text, color }, or null when none does. */
export function firstMark(rows, valueOf) {
  const row = rows.find(candidate => says(valueOf(candidate.mark)));
  return row ? { text: String(valueOf(row.mark)), color: row.color } : null;
}

/** Shows the badge the current marks call for. */
export async function showBadge() {
  const marks = await chrome.storage.session.get(settings.badge.map(row => key(row.mark)));
  const shown = firstMark(settings.badge, name => marks[key(name)] ?? null);
  const color = shown ? await wornColor(shown.color) : null;
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text: shown?.text ?? '' });
}

/** Sets one mark (a word, a count, or null to clear it) and shows the badge again. */
export async function setMark(name, value) {
  await chrome.storage.session.set({ [key(name)]: value ?? null });
  await showBadge();
}
