// src/search-answers.mjs
//
// PURPOSE
//   How much each way of matching (a search lane, or one model space in one place) is worth to this person, learned from
//   what they do: a search followed, within `fusion.followed_within_seconds`, by a use of one of its results (opened,
//   watched, edited: src/recent-files.mjs) is a known answer, and every lane that took part in that search is credited
//   by where it ranked the used result (1/rank, 0 when it did not find it). Search fuses its lanes by reciprocal rank
//   with these weights (src/search.mjs finish), so a model that keeps finding what people use counts for more, and one
//   that never does stops being asked (`retired`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a lane, a model or a kind; lanes are the ids search hands in.
//   2. A lane with no answers yet weighs 1; answers move it from a prior (`prior_answers` answers at
//      `prior_reciprocal_rank`), so one answer never decides a lane.
//   3. Each search is credited at most once, for the newest unanswered search that held the used file; of searches
//      asked in the same moment, the one asked last (its rowid: INSERT OR REPLACE gives the search a new one).
//   4. Only searches inside the window are held (older ones cannot be credited); each new search lets a page of the
//      expired go. Every read is a key seek.
//   5. A lane is retired only after `retire_after` answers with its weight under `retire_below`.
//

/**
 * sql     the person's store
 * config  search.json `fusion`
 */
export function searchAnswers(sql, { config, now = () => Date.now() }) {
  sql.exec('CREATE TABLE IF NOT EXISTS search_asked (search TEXT PRIMARY KEY, at INTEGER NOT NULL, took_part TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 0)');
  sql.exec('CREATE INDEX IF NOT EXISTS search_asked_at ON search_asked (at)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_asked_files (identity TEXT NOT NULL, search TEXT NOT NULL, ranks TEXT NOT NULL, PRIMARY KEY (identity, search))');
  sql.exec('CREATE INDEX IF NOT EXISTS search_asked_files_search ON search_asked_files (search)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_weights (lane TEXT PRIMARY KEY, answers INTEGER NOT NULL, reciprocal REAL NOT NULL)');
  // reads-ok: each caller's statement is a literal this lint checks where it is written.
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const prior = () => config.prior_answers * config.prior_reciprocal_rank;
  const weightOf = row => (row ? ((row.reciprocal + prior()) / (row.answers + config.prior_answers)) / config.prior_reciprocal_rank : 1);
  // Actual model-space prefixes end in ASCII '@'. Advancing that delimiter
  // includes every Unicode place suffix, where appending U+FFFF would not.
  const prefixEnd = prefix => prefix.endsWith('@') ? `${prefix.slice(0, -1)}A` : `${prefix}￿`;

  return {
    /**
     * One search's answer: `tookPart` the lanes that answered it, `ranked` [{ identity, ranks: { lane: rank } }] for
     * the files it showed. The oldest kept search leaves when there are more than kept_searches.
     */
    asked(search, tookPart, ranked) {
      sql.exec('INSERT OR REPLACE INTO search_asked (search, at, took_part) VALUES (?, ?, ?)', search, now(), JSON.stringify(tookPart));
      for (const { identity, ranks } of ranked) if (identity) sql.exec('INSERT OR REPLACE INTO search_asked_files (identity, search, ranks) VALUES (?, ?, ?)', identity, search, JSON.stringify(ranks));
      // Searches past the window can no longer be credited: a page of them leaves with each new one, by the at index.
      for (const { search: old } of all('SELECT search FROM search_asked WHERE at < ? ORDER BY at LIMIT 8', now() - config.followed_within_seconds * 1000)) {
        sql.exec('DELETE FROM search_asked_files WHERE search = ?', old);
        sql.exec('DELETE FROM search_asked WHERE search = ?', old);
      }
    },
    /** A file was used: the newest unanswered search within the window that showed it is a known answer. */
    used(identity) {
      const since = now() - config.followed_within_seconds * 1000;
      const [found] = all(`SELECT a.search AS search, a.took_part AS took_part, f.ranks AS ranks FROM search_asked_files f JOIN search_asked a ON a.search = f.search
        WHERE f.identity = ? AND a.answered = 0 AND a.at >= ? ORDER BY a.at DESC, a.rowid DESC LIMIT 1`, identity, since);
      if (!found) return false;
      const ranks = JSON.parse(found.ranks);
      for (const lane of JSON.parse(found.took_part)) {
        const reciprocal = Number.isFinite(ranks[lane]) ? 1 / ranks[lane] : 0;
        sql.exec('INSERT INTO search_weights (lane, answers, reciprocal) VALUES (?, 1, ?) ON CONFLICT (lane) DO UPDATE SET answers = answers + 1, reciprocal = reciprocal + excluded.reciprocal', lane, reciprocal);
      }
      sql.exec('UPDATE search_asked SET answered = 1 WHERE search = ?', found.search);
      return true;
    },
    /** { lane: weight } for these lanes; 1 for a lane with no answers. */
    weights(lanes) {
      // Preserve every selected learned weight. Each statement contains at most64 distinct primary keys.
      const selected = [...new Set(lanes)], rows = new Map();
      for (let at = 0; at < selected.length; at += 64) {
        for (const row of all('SELECT lane, answers, reciprocal FROM search_weights WHERE lane IN (SELECT value FROM json_each(?)) LIMIT 64', JSON.stringify(selected.slice(at, at + 64)))) rows.set(row.lane, row);
      }
      return Object.fromEntries(lanes.map(lane => [lane, weightOf(rows.get(lane))]));
    },
    /** Whether every measured lane whose id starts with `prefix` (one model space) is retired; false when none is measured. */
    retired(prefix) {
      // A later useful or not-yet-measured lane vetoes retirement; no truncated prefix establishes all-useless.
      let after = null, found = false;
      for (;;) {
        const rows = after === null
          ? all('SELECT lane, answers, reciprocal FROM search_weights WHERE lane >= ? AND lane < ? ORDER BY lane LIMIT 64', prefix, prefixEnd(prefix))
          : all('SELECT lane, answers, reciprocal FROM search_weights WHERE lane > ? AND lane < ? ORDER BY lane LIMIT 64', after, prefixEnd(prefix));
        for (const row of rows) { found = true; if (row.answers < config.retire_after || weightOf(row) >= config.retire_below) return false; }
        if (rows.length < 64) return found;
        after = rows.at(-1).lane;
      }
    },
    /** A space's weights leave with it (its encoder uninstalled), so installing it again starts it fresh. */
    forget(prefix) { sql.exec('DELETE FROM search_weights WHERE lane >= ? AND lane < ?', prefix, prefixEnd(prefix)); },
  };
}
