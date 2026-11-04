// src/data-rows.mjs
//
// Purpose: the one reader of the vendor tables that are DATA rows rather than code: fixed sign-in apps, the readers of a
// video link, the programs and engines that speak, the models a computer serves, the places posts go and the storage
// origins files are kept in. A table is a kind of row (the kinds are declared in src/marketplace-kinds.json); a module
// that needs the rows hands this reader the kind and the records file it ships with, and gets the rows' values back.
//
//   dataRows(kind, records, { installed })        -> the values of the rows of `kind`, in the file's order
//   withTables(settings, tables, { installed })   -> `settings` with each named table read from its rows
//
// `records` is the parsed records file (`{ records: [...] }`) the caller imports itself, so a page or program that needs
// one table never carries the others. `installed(kind)` is the seam for the installed set: when it answers an array of
// rows of that kind, those rows are the table; when it is absent or answers nothing (the installed set is not wired yet,
// or the account has not installed the kind), the shipped records file is read directly, which gives every account
// exactly the table it had when the table was code.
//
// A row is { id, kind, payload } (kind and payload on the row), or an older package row whose payload carries the kind
// (post places), or a flat package row (cloud-files origins). `payload` is the value; a flat row is its own value.
//
// Non-negotiable invariants:
//   1. This file names no vendor, address, model or place; it only reads rows.
//   2. A kind it does not know is refused, never read as empty, so a typo cannot silently remove a table.
//   3. A table read from the shipped file is the same values, in the same order, as the code table it replaced
//      (test/vendor-table-rows.test.mjs holds each to test/fixtures/vendor-tables-golden.json).
//

// The kinds this reader knows, and the kind a row of each is stored under.
const STORED_AS = {
  'oauth-client': 'oauth-client',
  'hear-fetcher': 'hear-fetcher',
  'video-list-rule': 'video-list-rule',
  'speech-program': 'speech-program',
  'speech-engine': 'speech-engine',
  'local-model-server': 'local-model-server',
  'local-model-job': 'local-model-job',
  'local-model-classifier': 'local-model-classifier',
  'local-model-offer': 'local-model-offer',
  'post-place': 'post-place',
  'storage-origin': 'cloud-files.origin',
  'storage-origin-settings': 'cloud-files.origin-settings',
};

const kindOf = row => row?.kind ?? row?.payload?.kind;
const valueOf = row => ('payload' in row ? row.payload : row);

/** The kinds of data row this reader knows. */
export const dataRowKinds = Object.keys(STORED_AS);

/** The values of the rows of `kind` in `records` (or in the installed set's rows), in order. */
export function dataRows(kind, records, { installed = null } = {}) {
  const stored = STORED_AS[kind];
  if (!stored) throw new Error(`${kind} is not a kind of data row this reader knows.`);
  const fromInstalled = typeof installed === 'function' ? installed(kind) : null;
  const rows = Array.isArray(fromInstalled) ? fromInstalled : records?.records;
  if (!Array.isArray(rows)) throw new Error(`There are no ${kind} rows to read.`);
  return rows.filter(row => kindOf(row) === stored).map(valueOf);
}

/**
 * `settings` with each table in `tables` read from its rows: { key: { kind, records, keyed } }. A table is the list of
 * its rows' values; a `keyed` table is an object whose keys are the rows' `id`s (the id is the key, not part of the
 * value), for tables that were an object of named entries.
 */
export function withTables(settings, tables, { installed = null } = {}) {
  const read = { ...settings };
  for (const [key, { kind, records, keyed = false }] of Object.entries(tables)) {
    // Copied, as reading the settings file afresh was: a program that adjusts what it read never changes the shipped rows.
    const values = structuredClone(dataRows(kind, records, { installed }));
    read[key] = keyed ? Object.fromEntries(values.map(({ id, ...rest }) => [id, rest])) : values;
  }
  return read;
}
