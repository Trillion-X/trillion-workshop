// src/copy-followers.mjs
//
// PURPOSE
//   The account's own records' side of the copies of them kept near far readers (src/record-replica.mjs): which places
//   hold a copy, for which account, and telling each of them, whenever the records change, so the copy settles at once
//   and a far reader reads what the records hold without waiting for a trip to them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A place is followed only by the copy's own settle call (an RPC a reader's request never reaches), only for a
//      place src/record-replicas.json names, and kept as one row per place, with the account whose copy it is.
//   2. Told at once on the first change, then at most once per `notice_every_ms` while changes keep coming, and always
//      once after the last of them: a burst of writes is one notice, and the last change is never left untold.
//   3. A notice is only "look again": it carries no record, so a lost one costs freshness only until the copy's own
//      `trust_notices_for_ms`, never a wrong answer.
//

import settings from './record-replicas.json' with { type: 'json' };

const TABLE = 'record_copy_followers';
const knownPlace = place => settings.places.some(row => row.hint === place);

/** The followers kept in `sql`, or null while no copy ever settled there (so records nobody copies keep no table). */
export const keptCopyFollowers = (sql, options) => sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, TABLE).toArray().length ? copyFollowers(sql, options) : null;

/**
 * sql: the records' database. tell(place, user): sends the copy of `user`'s records at `place` its notice
 * (src/record-replica.mjs tellCopyNear). Answers { follow(place, user), unfollow(place), places(), changed() }.
 */
export function copyFollowers(sql, { tell, every_ms = settings.notice_every_ms, now = () => Date.now(), later = (run, ms) => setTimeout(run, ms) }) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (place TEXT PRIMARY KEY, user TEXT NOT NULL, since TEXT NOT NULL) WITHOUT ROWID`);
  // A PersonStore kept this table as (place, since), its user being the store's own; a carry out moves it into the account's
  // book as it was (src/resource-state-carry.mjs ownRecordTable), where reading `user` failed every write that told its
  // followers (RecordBook 880c74dd, 2026-10-19). Such a place has no user to tell until its copy settles and follows again.
  if (!sql.exec(`SELECT 1 FROM pragma_table_info('${TABLE}') WHERE name = 'user'`).toArray().length) sql.exec(`ALTER TABLE ${TABLE} ADD COLUMN user TEXT`);
  let followed = sql.exec(`SELECT place, user FROM ${TABLE} WHERE user IS NOT NULL ORDER BY place`).toArray().map(row => ({ place: row.place, user: row.user }));
  let toldAt = -Infinity;
  let waiting = false;
  const tellAll = () => { toldAt = now(); for (const { place, user } of followed) Promise.resolve().then(() => tell(place, user)).catch(error => console.warn('copy near a reader: notice', place, String(error?.message ?? error))); };
  const places = () => followed.map(row => row.place);
  return {
    follow(place, user) {
      if (!knownPlace(place) || typeof user !== 'string' || !user || followed.some(row => row.place === place && row.user === user)) return false;
      sql.exec(`INSERT INTO ${TABLE} (place, user, since) VALUES (?, ?, ?) ON CONFLICT (place) DO UPDATE SET user = excluded.user`, place, user, new Date(now()).toISOString());
      followed = [...followed.filter(row => row.place !== place), { place, user }].sort((a, b) => a.place.localeCompare(b.place));
      return true;
    },
    /** A copy beside the store is not told: its readers read the store itself. */
    unfollow(place) {
      if (!followed.some(row => row.place === place)) return false;
      sql.exec(`DELETE FROM ${TABLE} WHERE place = ?`, place);
      followed = followed.filter(row => row.place !== place);
      return true;
    },
    places,
    changed() {
      if (!followed.length || waiting) return;
      const wait = toldAt + every_ms - now();
      if (wait <= 0) { tellAll(); return; }
      waiting = true;
      later(() => { waiting = false; tellAll(); }, wait);
    },
  };
}
