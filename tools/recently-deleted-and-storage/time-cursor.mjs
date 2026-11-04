// src/time-cursor.mjs
//
// PURPOSE
//   The one way a newest-first list says where its next page starts. A page cursor that names only the last row's time
//   loses every unseen row sharing that time at the page boundary (the next page asks for rows strictly older), so the
//   cursor names the last row's time AND its id, and the next page reads rows after that exact row in the list's own
//   order: time descending, then id descending.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A list paged with this cursor orders by (time DESC, id DESC); the cursor is opaque to callers.
//   2. A bare time from before this cursor existed still pages (rows strictly older), so a cursor a client already holds
//      keeps working.
//   3. Times never contain "|", so the first "|" separates the time from an id that may contain anything.
//

/** The cursor naming one row: its time and its id. */
export function timeCursor(at, id) {
  return `${at}|${id}`;
}

/** { at, id } from a cursor (id null for a bare time), or null for none. */
export function readTimeCursor(before) {
  if (typeof before !== 'string' || !before) return null;
  const split = before.indexOf('|');
  return split < 0 ? { at: before, id: null } : { at: before.slice(0, split), id: before.slice(split + 1) };
}

/** The SQL condition (and its arguments) for rows after the cursor in (time DESC, id DESC) order; none for no cursor. */
export function afterTimeCursor(cursor, timeColumn, idColumn) {
  if (!cursor) return { sql: '1 = 1', args: [] };
  if (cursor.id === null) return { sql: `${timeColumn} < ?`, args: [cursor.at] };
  return { sql: `(${timeColumn} < ? OR (${timeColumn} = ? AND ${idColumn} < ?))`, args: [cursor.at, cursor.at, cursor.id] };
}

/** The same test for one row held in memory. */
export function isAfterTimeCursor(cursor, at, id) {
  if (!cursor) return true;
  if (at !== cursor.at) return at < cursor.at;
  return cursor.id !== null && id < cursor.id;
}

/** Newest-first order for rows held in memory: time, then id, both descending. */
export function byTimeThenIdDescending(atOf, idOf) {
  return (a, b) => (atOf(b) < atOf(a) ? -1 : atOf(b) > atOf(a) ? 1 : idOf(b) < idOf(a) ? -1 : idOf(b) > idOf(a) ? 1 : 0);
}
