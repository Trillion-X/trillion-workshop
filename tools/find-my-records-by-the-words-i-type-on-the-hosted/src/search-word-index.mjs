// FTS5 does not index UNINDEXED columns for equality lookups. Keep an ordinary SQLite index from a result to its
// FTS rowid so replacing one document never scans every indexed document. Existing FTS rows are admitted a page at
// a time before replacements resume; their text remains searchable throughout admission. The FTS5 virtual table
// bills a rowid range as a scan of earlier rows in Durable Object SQLite. Its content table holds the same rowids
// under an integer primary key, so legacy admission walks that table directly with bounded indexed reads.
export function searchWordIndex(sql, transaction = work => work()) {
  sql.exec('CREATE VIRTUAL TABLE IF NOT EXISTS search_words USING fts5(lane UNINDEXED, identity UNINDEXED, text)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_word_rows (word_row INTEGER PRIMARY KEY, lane TEXT NOT NULL, identity TEXT NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS search_word_rows_result ON search_word_rows (lane, identity)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_word_admission (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), after_row INTEGER NOT NULL, done INTEGER NOT NULL)');
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  if (!all('SELECT 1 FROM search_word_admission WHERE singleton = 1 LIMIT 1').length) {
    const hasOldRows = all('SELECT 1 FROM search_words LIMIT 1').length > 0;
    sql.exec('INSERT INTO search_word_admission (singleton, after_row, done) VALUES (1, 0, ?)', hasOldRows ? 0 : 1);
  }

  const pending = () => all('SELECT done FROM search_word_admission WHERE singleton = 1')[0].done === 0;

  // How many documents hold a word (a prefix counts every word it starts), read from the index's own vocabulary, which
  // keeps nothing of its own; null where the database offers no fts5vocab module, so a search then asks every word.
  let vocabulary = null;
  try {
    sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_words_vocab USING fts5vocab(search_words, 'row')");
    vocabulary = term => all('SELECT COALESCE(SUM(doc), 0) AS n FROM search_words_vocab WHERE term >= ? AND term < ?', term, `${term}\u{10FFFF}`)[0].n;
  } catch {
    vocabulary = null;
  }

  // Progress and inserted keys commit together, so an interrupted wake repeats safely. The result-change queue
  // retains writes that arrive while the older word index is admitted.
  function admit(limit) {
    if (!pending()) return false;
    const pageSize = Math.max(1, Math.min(512, Math.trunc(limit) || 1));
    transaction(() => {
      const after = all('SELECT after_row FROM search_word_admission WHERE singleton = 1')[0].after_row;
      const page = all('SELECT id FROM search_words_content WHERE id > ? ORDER BY id LIMIT ?', after, pageSize);
      if (!page.length) {
        sql.exec('UPDATE search_word_admission SET done = 1 WHERE singleton = 1');
        return;
      }
      const last = page.at(-1).id;
      sql.exec('INSERT OR IGNORE INTO search_word_rows (word_row, lane, identity) SELECT id, c0, c1 FROM search_words_content WHERE id > ? AND id <= ?', after, last);
      const more = all('SELECT 1 FROM search_words_content WHERE id > ? LIMIT 1', last).length > 0;
      sql.exec('UPDATE search_word_admission SET after_row = ?, done = ? WHERE singleton = 1', last, more ? 0 : 1);
    });
    return pending();
  }

  function forget(lane, identity) {
    if (pending()) throw new Error('The existing word index is still being admitted');
    for (const { word_row } of all('SELECT word_row FROM search_word_rows WHERE lane = ? AND identity = ?', lane, identity)) {
      sql.exec('DELETE FROM search_words WHERE rowid = ?', word_row);
    }
    sql.exec('DELETE FROM search_word_rows WHERE lane = ? AND identity = ?', lane, identity);
  }

  function replace(lane, identity, text) {
    // A result that changed in a field this lane does not read has the same words: its index row stays as it is. Taking
    // the row out and putting it back wrote 18 rows for a result of a few hundred words, and a lane's definition changing
    // derives every result of its kind again.
    if (!pending()) {
      const held = all('SELECT word_row FROM search_word_rows WHERE lane = ? AND identity = ? LIMIT 2', lane, identity);
      const wanted = typeof text === 'string' && text.trim() ? text : null;
      if (wanted === null ? !held.length : held.length === 1 && all('SELECT c2 AS text FROM search_words_content WHERE id = ?', held[0].word_row)[0]?.text === wanted) return;
    }
    forget(lane, identity);
    if (typeof text !== 'string' || !text.trim()) return;
    const [{ word_row }] = all('INSERT INTO search_word_rows (lane, identity) VALUES (?, ?) RETURNING word_row', lane, identity);
    sql.exec('INSERT INTO search_words (rowid, lane, identity, text) VALUES (?, ?, ?, ?)', word_row, lane, identity, text);
  }

  // Used by the older generation-based catch-up. The change-queue owner instead calls forget for one identity.
  function forgetMissing(lane, kind) {
    if (pending()) throw new Error('The existing word index is still being admitted');
    const missing = all('SELECT identity FROM search_word_rows WHERE lane = ? AND identity NOT IN (SELECT identity FROM namespace_results WHERE kind = ?)', lane, kind);
    for (const { identity } of missing) forget(lane, identity);
  }

  return { pending, admit, replace, forget, forgetMissing, documentsHolding: vocabulary };
}
