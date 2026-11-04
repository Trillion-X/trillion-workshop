// parts/screen-look/do-work/screen-look-records.ts
//
// PURPOSE
//   The person's own looks in this page's records. A look travels as the record read-data/screen-look-record.ts
//   defines (a downloaded file, a Marketplace listing, a look an AI made). The person's own looks are kept apart from
//   the app's: the app's list comes from its DATA on every load, the person's list is their own record, and a look of
//   the person's with an app look's id is their edit of it. The Worker's looks owner (src/looks.mjs) keeps the same
//   records the same way for every AI.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A record is decoded only by read-data/screen-look-record.ts; anything it refuses is refused with plain words.
//   2. Saving writes only the person's own looks (input `own-screen-look-themes`); the app's looks are never copied
//      into the person's records, so a changed app look reaches everyone who did not edit it.
//   3. Nothing here names a look, an app or a colour.

import { readInputValue, writeInputValue } from '#workspace-records';
import { readScreenLookRecord, type EditableScreenLookTheme } from '../read-data/read-editable-screen-look-themes';
import { readScreenLookFile, screenLookRecord } from '../read-data/screen-look-record';
import { chooseCurrentScreenLook } from './choose-current-screen-look';

/** The person's own looks (their saved record), each a look. */
export function readOwnScreenLooks(): EditableScreenLookTheme[] {
  const rows = readInputValue<unknown>('own-screen-look-themes');
  return (Array.isArray(rows) ? rows : []).map(readScreenLookRecord).filter((theme): theme is EditableScreenLookTheme => !!theme);
}

/** Keeps `theme` among the person's own looks, replacing their look with the same id. */
export async function saveOwnScreenLook(theme: EditableScreenLookTheme): Promise<void> {
  await writeInputValue('own-screen-look-themes', [...readOwnScreenLooks().filter(one => one.id !== theme.id).map(screenLookRecord), screenLookRecord(theme)]);
}

/** Takes in a look record from anywhere (an opened file's text, a marketplace listing, another app), keeps it among
 *  the person's own looks and makes it the look they see. Answers the look; throws with plain words when `record` is
 *  not a look. */
export async function applyScreenLookRecord(record: unknown): Promise<EditableScreenLookTheme> {
  const theme = readScreenLookFile(record);
  await saveOwnScreenLook(theme);
  await chooseCurrentScreenLook(theme.id);
  return theme;
}
