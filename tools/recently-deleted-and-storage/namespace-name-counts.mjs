// Exact duplicate-name counts. A unique name is already proved by an indexed
// source seek, so only identities with two or more names need a summary row.
// The owner runs each fill page (and reset with source clearing) in its existing
// transaction; foreground listings never backfill.
const PAGE = 256;
const counted = row => `(SELECT complete OR (after_rowid IS NOT NULL AND ${row}.rowid <= after_rowid)
  FROM namespace_name_count_state WHERE id = 1)`;
const countedEnd = `(SELECT CASE WHEN complete THEN 9223372036854775807 ELSE after_rowid END
  FROM namespace_name_count_state WHERE id = 1)`;
const another = row => `EXISTS (SELECT 1 FROM namespace_names n
  WHERE n.identity = ${row}.identity AND n.rowid != ${row}.rowid AND n.rowid <= ${countedEnd} LIMIT 1)`;

export function namespaceNameCounts(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_name_counts (
    identity TEXT PRIMARY KEY, names INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_name_count_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), after_rowid INTEGER,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)))`);
  // LIMIT 1 is deliberate: construction must never count or group legacy names.
  // A row made once: where it exists the statement inserts no row, so it fires no trigger of a frozen Namespace source
  // (installFreeze, src/namespace-live-source.mjs; PersonStore f281a627 2026-10-19: construction refused at this write).
  sql.exec(`INSERT INTO namespace_name_count_state (id, after_rowid, complete)
    SELECT 1, NULL, NOT EXISTS (SELECT 1 FROM namespace_names LIMIT 1)
    WHERE NOT EXISTS (SELECT 1 FROM namespace_name_count_state WHERE id = 1)`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_name_count_added AFTER INSERT ON namespace_names
    WHEN NEW.identity IS NOT NULL AND ${counted('NEW')}
    BEGIN
      INSERT INTO namespace_name_counts (identity, names)
        SELECT NEW.identity, 2 WHERE ${another('NEW')}
      ON CONFLICT(identity) DO UPDATE SET names = names + 1;
    END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_name_count_removed AFTER DELETE ON namespace_names
    WHEN OLD.identity IS NOT NULL AND ${counted('OLD')}
    BEGIN
      UPDATE namespace_name_counts SET names = names - 1 WHERE identity = OLD.identity;
      DELETE FROM namespace_name_counts WHERE identity = OLD.identity AND names <= 1;
    END`);
  // Rowid movement can cross the counted prefix even if identity stays unchanged.
  // Metadata updates do not write the projection. IS NOT handles NULL identities.
  sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_name_count_changed AFTER UPDATE ON namespace_names
    WHEN OLD.identity IS NOT NEW.identity OR OLD.rowid IS NOT NEW.rowid
    BEGIN
      UPDATE namespace_name_counts SET names = names - 1
        WHERE identity = OLD.identity AND ${counted('OLD')};
      DELETE FROM namespace_name_counts WHERE identity = OLD.identity AND names <= 1;
      INSERT INTO namespace_name_counts (identity, names)
        SELECT NEW.identity, 2 WHERE NEW.identity IS NOT NULL AND ${counted('NEW')} AND ${another('NEW')}
        ON CONFLICT(identity) DO UPDATE SET names = names + 1;
    END`);
  const state = () => sql.exec('SELECT after_rowid, complete FROM namespace_name_count_state WHERE id = 1').one();
  const ready = () => Boolean(state().complete);
  return {
    ready,
    // During migration these are prefix counts; the owner uses its exact legacy
    // query until ready(). Missing summaries use at most one indexed source row.
    counts(identities) {
      if (!identities.length) return [];
      const selected = JSON.stringify([...new Set(identities.filter(identity => identity !== null))]);
      return sql.exec(`SELECT identity, names FROM namespace_name_counts
        WHERE identity IN (SELECT value FROM json_each(?1))
        UNION ALL SELECT j.value AS identity, 1 AS names FROM json_each(?1) j
          WHERE NOT EXISTS (SELECT 1 FROM namespace_name_counts c WHERE c.identity = j.value)
            AND EXISTS (SELECT 1 FROM namespace_names n WHERE n.identity = j.value AND n.rowid <= ${countedEnd} LIMIT 1)`, selected).toArray();
    },
    fillStep: {
      nextAt: () => ready() ? null : 0,
      step() {
        const current = state();
        if (current.complete) return { done: true, rows: 0 };
        const page = current.after_rowid === null
          ? sql.exec('SELECT rowid, identity FROM namespace_names ORDER BY rowid LIMIT ?', PAGE).toArray()
          : sql.exec('SELECT rowid, identity FROM namespace_names WHERE rowid > ? ORDER BY rowid LIMIT ?', current.after_rowid, PAGE).toArray();
        if (!page.length) {
          sql.exec('UPDATE namespace_name_count_state SET complete = 1 WHERE id = 1');
          return { done: true, rows: 0 };
        }
        // Group only the selected page. A missing summary has at most one name
        // in the old prefix, found by one indexed existence seek, never a COUNT.
        sql.exec(`INSERT INTO namespace_name_counts (identity, names)
          SELECT p.identity, p.names + CASE
            WHEN NOT EXISTS (SELECT 1 FROM namespace_name_counts c WHERE c.identity = p.identity)
              AND EXISTS (SELECT 1 FROM namespace_names n WHERE n.identity = p.identity AND n.rowid <= ?2 LIMIT 1)
            THEN 1 ELSE 0 END
          FROM (SELECT value AS identity, COUNT(*) AS names FROM json_each(?1) WHERE value IS NOT NULL GROUP BY value) p
          WHERE p.names > 1 OR EXISTS (SELECT 1 FROM namespace_name_counts c WHERE c.identity = p.identity)
            OR EXISTS (SELECT 1 FROM namespace_names n WHERE n.identity = p.identity AND n.rowid <= ?2 LIMIT 1)
          ON CONFLICT(identity) DO UPDATE SET names = names + excluded.names`, JSON.stringify(page.map(row => row.identity)), current.after_rowid);
        sql.exec('UPDATE namespace_name_count_state SET after_rowid = ? WHERE id = 1', page.at(-1).rowid);
        return { done: false, rows: page.length };
      },
    },
    reset() {
      sql.exec('DELETE FROM namespace_name_counts');
      sql.exec(`UPDATE namespace_name_count_state SET after_rowid = NULL,
        complete = NOT EXISTS (SELECT 1 FROM namespace_names LIMIT 1) WHERE id = 1`);
    },
  };
}
