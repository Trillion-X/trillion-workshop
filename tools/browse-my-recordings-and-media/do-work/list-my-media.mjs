// tools/browse-my-recordings-and-media/do-work/list-my-media.mjs
//
// The Media section's rows, read the way the signed-in Media screen reads a page (media-library.mjs's own
// mediaLibraryPage), over what is handed in: the person's files by name, laid in the namespace with namespace-store.mjs's
// namespaceStore and putNames (tools/recently-deleted-and-storage), and the results kept about them (a recording the
// library knows, its title, its facts, its transcript...) laid in a namespace_results table. Each recording and each
// video, sound or picture file under the folders media-library.json names becomes one row, newest first, with what is
// known about it. A file deleted or archived (set_aside) and left with no name is not a row. Nothing is kept after the
// run, no file is written and nothing is sent; no bytes are held, so every row says stored: false.
//
// Input:
//   files     [{ name, identity, byte_length?, modified_at_ms? }]: the person's files (names start with /)
//   results   [{ identity, kind, value }]: results kept about a file by its identity; kind library-entry makes a
//             recording row (its value { name?, path?, media_kind? }), and title, summary, organization, facts,
//             transcript and the other kinds media-library.json joins add to a row
//   set_aside [{ name } | { identity }]: things to delete first, as Recently Deleted does
//   page      { limit?, origin? (recording, made or file), unused? }
// Answers { rows, next_after, origin_labels, revision }, each row { identity, origin, name, path, media_kind,
// media_type, stored, captured_ms, title?, duration?, edits?, words?, ... }.
// Refuses no files and results that are not a list, a result without identity, kind and value, and what the page
// refuses (more than 60 rows, an origin that is not text).
import { DatabaseSync } from 'node:sqlite';
import { namespaceStore } from '../namespace-store.mjs';
import { setAsideStore } from '../namespace-set-aside.mjs';
import { mediaLibraryPage } from '../media-library.mjs';

// The results table as old trillion's src/namespace-results.mjs:200 (resultsStore) made it. That module is not here: it
// also keeps the search feed (src/search-feed.mjs and its DATA), which a Media page does not read.
const RESULTS_TABLE = 'CREATE TABLE IF NOT EXISTS namespace_results (identity TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, produced_by TEXT, value_identity TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (identity, kind))';
const RESULTS_BY_KIND = 'CREATE INDEX IF NOT EXISTS namespace_results_kind ON namespace_results (kind, identity)';

// The node:sqlite handle in the shape the store's code takes: exec(query, ...params), spread or toArray().
function sqlOver(db) {
  return {
    exec(query, ...params) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params).map(row => ({ ...row })) : (statement.run(...params), []);
      return Object.assign(rows, { toArray: () => rows });
    },
  };
}

export function listMyMedia({ files, results = [], set_aside = [], page = {} } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Give files: a list of { name, identity, byte_length?, modified_at_ms? }, each name starting with /.');
  if (!Array.isArray(results)) throw new Error('Give results as a list of { identity, kind, value }, or leave them out.');
  const sql = sqlOver(new DatabaseSync(':memory:'));
  const names = namespaceStore(sql);
  const put = names.putNames(files.map(file => ({ byte_length: 0, ...file })));
  if (put.conflicts?.length) throw new Error(`These files could not be named: ${JSON.stringify(put.conflicts)}.`);
  sql.exec(RESULTS_TABLE);
  sql.exec(RESULTS_BY_KIND);
  const at = new Date(0).toISOString();
  results.forEach((result, index) => {
    if (typeof result?.identity !== 'string' || typeof result.kind !== 'string' || result.value === undefined) {
      throw new Error(`Result ${index} needs identity, kind and value.`);
    }
    const value = JSON.stringify(result.value);
    sql.exec('INSERT INTO namespace_results (identity, kind, value, produced_by, value_identity, recorded_at) VALUES (?, ?, ?, NULL, ?, ?)',
      result.identity, result.kind, value, `given:${index}`, at);
  });
  if (set_aside.length) {
    let saved = null;
    const store = setAsideStore(sql, { keepFor: { read: () => saved, write: value => { saved = value; } } });
    const { refused } = store.setAside({ items: set_aside, state: 'deleted' });
    if (refused.length) throw new Error(`These could not be deleted first: ${JSON.stringify(refused)}.`);
  }
  const { limit = 60, origin = null, unused = false } = page ?? {};
  return mediaLibraryPage(sql, { limit, origin, unused, previews: false });
}
