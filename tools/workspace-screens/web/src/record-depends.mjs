// src/record-depends.mjs
//
// Purpose: what a read depended on and what a write changed, in one shape both ends of the live screen compare. A store
// change tells open pages which records changed (ids, the fields written when known, and a version), never their
// values (src/live-keys.mjs). A screen keeps what its last read depended on (an answer's `depends`, src/lists.mjs
// dependsOf) and reads again only when a change touches it and is newer than what it read.
//
// Shapes (plain JSON, no encoded strings):
//   writes  = { at, version, records: [{ id, fields: [field id] | null }] }   fields null: any field may have changed
//   depends = { version, ids: [record id], rows: [record id], members: [{ prefix, fields: [field id] | null }] }
//     ids:     records whose every change matters (the list itself, a view kept as its own record)
//     rows:    the rows the screen shows: any change to one matters
//     members: records under `prefix` that could join, leave or reorder what is shown; only a change to one of `fields`
//              matters (the fields a view filters, sorts, groups or reaches through by), or any change when fields is null
//
// Non-Negotiable Invariants:
//   1. A version is the store's record log position when the change was made or the read answered (a time-ordered id
//      that sorts as text). A change is newer than a read only when its version sorts after the read's; a missing version
//      on either side counts as newer, so a store without a log never loses a change.
//   2. Unknown is never "untouched": a change naming no fields touches every member under its prefix.
//   3. Pure: no I/O, no clock; the same answer on the Worker, in a page and in a test.

const isList = value => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Whether a change at `version` came after a read at `seen` (invariant 1). */
export const newerThan = (version, seen) => typeof version !== 'string' || typeof seen !== 'string' || version > seen;

/** A `writes` frame as received, or null when it is not one (a malformed frame is never trusted as a narrow one). */
export function writesOf(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.records)) return null;
  const records = [];
  for (const record of value.records) {
    if (!record || typeof record.id !== 'string' || !(record.fields === null || isList(record.fields))) return null;
    records.push({ id: record.id, fields: record.fields });
  }
  return { at: typeof value.at === 'string' ? value.at : null, version: typeof value.version === 'string' ? value.version : null, records };
}

/** A `depends` as an answer carried it, or null when the answer carried none a page can rely on. */
export function dependsOf(value) {
  if (!value || typeof value !== 'object' || !isList(value.ids) || !isList(value.rows) || !Array.isArray(value.members)) return null;
  const members = [];
  for (const member of value.members) {
    if (!member || typeof member.prefix !== 'string' || !member.prefix || !(member.fields === null || isList(member.fields))) return null;
    members.push({ prefix: member.prefix, fields: member.fields });
  }
  return { version: typeof value.version === 'string' ? value.version : null, ids: value.ids, rows: value.rows, members };
}

/** Whether `writes` changed anything the read described by `depends` showed or could show (invariants 1 and 2). */
export function touches(depends, writes) {
  if (!newerThan(writes.version, depends.version)) return false;
  const exact = new Set([...depends.ids, ...depends.rows]);
  return writes.records.some(record => exact.has(record.id) || depends.members.some(member => record.id.startsWith(member.prefix)
    && (member.fields === null || record.fields === null || record.fields.some(field => member.fields.includes(field)))));
}
