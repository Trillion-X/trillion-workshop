// src/search-feed.mjs
//
// PURPOSE
//   The writer's side of search's change feed. A person's results are kept by the person's store (PersonStore); the
//   search index is kept by its own follower (src/search-follower.mjs, PersonWork), which reads the writer through the
//   small pages here instead of sharing the writer's thread. The feed names only what changed: a result kind and an
//   identity, one append-only row per change, so a change made while the follower reads a page is never lost (the
//   follower acknowledges a row only after it has marked its identity). Values are read one at a time (`row`), never a
//   page of them, because a result is up to 1.5 MB.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A feed row exists only for a result kind a search lane derives (search.json `kind`, registered by the follower
//      through `register`); every other result change costs the writer nothing extra.
//   2. Rows are kept in change order (seq) and deleted only up to a position the follower acknowledged, so a row the
//      follower has not read is never deleted, and a repeated read or ack is harmless (idempotent).
//   3. The writer's pages are indexed reads (namespace_results kind index, the feed's seq key): each answers in ms.
//
import settings from './search.json' with { type: 'json' };
import useData from './metered-use.json' with { type: 'json' };

// The lane mechanisms whose hits come from the index (the follower). Others (names, connected services) are answered by
// the writer, which owns the names, aliases, set-aside and Workshop state they read.
export const INDEX_MATCHES = new Set(['words-in-results', 'words-in-index', 'meaning-in-results', 'words-in-records', 'colour-in-results']);
const KEPT_MATCHES = new Set(['words-in-results', 'words-in-index', 'meaning-in-results', 'colour-in-results']);
/** The result kinds the feed carries: the kinds of the lanes whose text or meaning the index keeps. */
export const feedKinds = (lanes = settings.lanes) => [...new Set(lanes.filter(lane => KEPT_MATCHES.has(lane.match)).map(lane => lane.kind))];
// The record types the words-in-records lanes read (search.json `record_type`; a list and its rows, `rows_of`). A write of any
// other record leaves the index nothing to read, so it never wakes the follower: an account whose records are only its
// settings, schedules and command bookkeeping has no follower and opens no store for search.
const RECORD_LANES = settings.lanes.filter(lane => lane.match === 'words-in-records');
const SEARCHED_TYPES = new Set(RECORD_LANES.map(lane => lane.rows_of?.record_type ?? lane.record_type));
const SEARCHED_PREFIXES = RECORD_LANES.flatMap(lane => lane.rows_of?.row_type_prefix ?? []);
/** Whether the search index reads records of `type` (a record whose type is not said is taken as read). */
export const searchesRecord = type => typeof type !== 'string' || SEARCHED_TYPES.has(type) || SEARCHED_PREFIXES.some(prefix => type.startsWith(prefix));

// The durable source-change frontier's one row, made wherever it is written or read.
function ensureSourceClock(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS search_feed_source_clock (singleton INTEGER PRIMARY KEY CHECK (singleton=1), revision INTEGER NOT NULL)');
  // Seeded once: a start that finds it writes nothing, so a store whose own-record writer is fenced still opens.
  if (!sql.exec('SELECT 1 AS held FROM search_feed_source_clock WHERE singleton=1 LIMIT 1').toArray().length) sql.exec('INSERT OR IGNORE INTO search_feed_source_clock (singleton,revision) VALUES (1,0)');
  if (!sql.exec('PRAGMA table_info(search_feed_source_clock)').toArray().some(row => row.name === 'watch_files')) sql.exec('ALTER TABLE search_feed_source_clock ADD COLUMN watch_files INTEGER NOT NULL DEFAULT 0');
}

/** Creates the feed tables and the triggers on namespace_results (called where namespace_results is created). */
export function ensureSearchFeed(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS search_feed (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, identity TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_feed_kinds (kind TEXT PRIMARY KEY)');
  ensureSourceClock(sql);
  sql.exec('CREATE INDEX IF NOT EXISTS search_feed_kind ON search_feed (kind, seq)');
  const watched = 'kind IN (SELECT kind FROM search_feed_kinds)';
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_insert AFTER INSERT ON namespace_results WHEN NEW.${watched} BEGIN
    INSERT INTO search_feed (kind, identity) VALUES (NEW.kind, NEW.identity);
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_update AFTER UPDATE ON namespace_results
    WHEN (OLD.identity <> NEW.identity OR OLD.kind <> NEW.kind OR OLD.value_identity <> NEW.value_identity)
      AND (OLD.${watched} OR NEW.${watched}) BEGIN
    INSERT INTO search_feed (kind, identity) SELECT OLD.kind, OLD.identity WHERE OLD.${watched};
    INSERT INTO search_feed (kind, identity) SELECT NEW.kind, NEW.identity WHERE NEW.${watched};
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_delete AFTER DELETE ON namespace_results WHEN OLD.${watched} BEGIN
    INSERT INTO search_feed (kind, identity) VALUES (OLD.kind, OLD.identity);
  END`);
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='namespace_files' LIMIT 1").toArray().length) {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_file_insert AFTER INSERT ON namespace_files
      WHEN (SELECT watch_files FROM search_feed_source_clock WHERE singleton=1)=1 BEGIN
      UPDATE search_feed_source_clock SET revision=revision+1 WHERE singleton=1; END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_file_delete AFTER DELETE ON namespace_files
      WHEN (SELECT watch_files FROM search_feed_source_clock WHERE singleton=1)=1 BEGIN
      UPDATE search_feed_source_clock SET revision=revision+1 WHERE singleton=1; END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_file_update AFTER UPDATE ON namespace_files
      WHEN (OLD.identity IS NOT NEW.identity OR OLD.media_type IS NOT NEW.media_type OR OLD.byte_length IS NOT NEW.byte_length)
        AND (SELECT watch_files FROM search_feed_source_clock WHERE singleton=1)=1 BEGIN
      UPDATE search_feed_source_clock SET revision=revision+1 WHERE singleton=1; END`);
  }
  // A durable source frontier survives feed acknowledgements. Meaning-set consumers use it to notice writes that
  // share a timestamp with, and sort behind, a saved result cursor. Their own derived meaning rows do not move it.
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_source_insert AFTER INSERT ON namespace_results
    WHEN NEW.kind IN (SELECT kind FROM search_feed_kinds) AND NEW.produced_by IS NOT 'search:meaning' BEGIN
    UPDATE search_feed_source_clock SET revision=revision+1 WHERE singleton=1;
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_source_update AFTER UPDATE ON namespace_results
    WHEN (OLD.identity <> NEW.identity OR OLD.kind <> NEW.kind OR OLD.value_identity <> NEW.value_identity)
      AND (OLD.kind IN (SELECT kind FROM search_feed_kinds) OR NEW.kind IN (SELECT kind FROM search_feed_kinds))
      AND NEW.produced_by IS NOT 'search:meaning' BEGIN
    UPDATE search_feed_source_clock SET revision=revision+1 WHERE singleton=1;
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_feed_source_delete AFTER DELETE ON namespace_results
    WHEN OLD.kind IN (SELECT kind FROM search_feed_kinds) AND OLD.produced_by IS NOT 'search:meaning' BEGIN
    UPDATE search_feed_source_clock SET revision=revision+1 WHERE singleton=1;
  END`);
}

/**
 * The writer's answers to one follower (`sql` is the person's store). Each method is one indexed read or one delete;
 * the follower awaits them, so a local caller (the writer's own search, tests) gets the same shape.
 *   register(kinds)            the kinds the feed carries from now on (idempotent)
 *   sourceRevision()           the durable source-change frontier; unlike feed rows it survives acknowledgements
 *   page(kind, after, limit)   [{ identity, value_identity }] of a kind, by identity after `after`
 *   pageNow(kind, after, limit) optional local synchronous page; remote facades omit this capability
 *   known(kind, identities)    the identities that still have a result of this kind
 *   row(identity, kind)        { value, value_identity } or null
 *   rows(kind, identities, maxBytes)  { rows: [{ identity, value, value_identity }], through }: the named identities in
 *                              the caller's (ascending) order, read ROWS_CHUNK to a statement, a value taken only while the
 *                              running size fits `maxBytes` (always at least one, never read past it) and before the statement past
 *                              ROWS_MOST identities; `through` is the last identity considered, so one named up to it
 *                              with no row has no result of this kind
 *   feed(after, limit)         [{ seq, kind, identity }] after `after`, in order
 *   ack(upTo)                  deletes the feed rows the follower has read through `upTo`
 */
/** The reads a search follower makes of a results feed (searchFeedWriter), wherever the results are kept. */
export const SEARCH_FEED_READS = ['register', 'page', 'known', 'row', 'rows', 'feed', 'ack'];
// One rows read reads its identities ROWS_CHUNK to a statement: the follower's whole wake in one metered call instead of
// one call a value (about 220 ms each, 2026-10-19). It is cut before the statement that would pass half of one read's
// statements (metered-use.json most_held_statements), so the read with its meter's own statements stays inside one read,
// and so at most ROWS_MOST identities are considered; at most ROWS_CHUNK values are held at once before they are kept.
const ROWS_CHUNK = 16;
const ROWS_STATEMENTS = Math.floor(useData.most_held_statements / 2);
export const ROWS_MOST = ROWS_STATEMENTS * ROWS_CHUNK;

export function searchFeedWriter(sql) {
  // A store kept before the source clock existed meets a reader (the meaning-set alarm) before anything constructs its
  // results store, so the clock is made here too: "no such table: search_feed_source_clock" refused every founder call
  // on 2026-10-16. Its triggers stay with ensureSearchFeed, which runs wherever namespace_results is opened.
  ensureSourceClock(sql);
  const page = (kind, after, limit) => sql.exec('SELECT identity, value_identity FROM namespace_results WHERE kind = ? AND identity > ? ORDER BY identity LIMIT ?', kind, after, limit).toArray();
  const localResults = sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='namespace_results' LIMIT 1").toArray().length > 0;
  return {
    register(kinds) {
      for (const kind of kinds) sql.exec('INSERT OR IGNORE INTO search_feed_kinds (kind) VALUES (?)', kind);
      return kinds.length;
    },
    watchFiles() {
      sql.exec('UPDATE search_feed_source_clock SET watch_files=1 WHERE singleton=1 AND watch_files=0');
    },
    sourceRevision() {
      return sql.exec('SELECT revision FROM search_feed_source_clock WHERE singleton=1 LIMIT 1').toArray()[0]?.revision ?? 0;
    },
    page,
    // No local source capability means pending backfill, never an empty result page.
    pageNow: localResults ? page : undefined,
    known(kind, identities) {
      if (!identities.length) return [];
      // reads-ok: only the identities the caller names (one follower page), each by the (identity, kind) primary key
      return sql.exec('SELECT identity FROM namespace_results WHERE kind = ? AND identity IN (SELECT value FROM json_each(?))', kind, JSON.stringify(identities)).toArray().map(row => row.identity);
    },
    row(identity, kind) {
      // reads-ok: one row by the (identity, kind) primary key
      return sql.exec('SELECT value, value_identity FROM namespace_results WHERE identity = ? AND kind = ?', identity, kind).toArray()[0] ?? null;
    },
    rows(kind, identities, maxBytes = Number.MAX_SAFE_INTEGER) {
      if (!Array.isArray(identities)) throw new TypeError('Name the results to read.');
      const found = [];
      let bytes = 0;
      for (let at = 0; at < identities.length; at += ROWS_CHUNK) {
        // CROSS JOIN fixes the join order: the named identities are the outer loop and each is one primary-key lookup. Left to choose, the
        // planner scanned every result of the kind (117,864 rows read for two identities of a kind of 39,000 on a founder's Namespace, which
        // failed every other Namespace evidence step against its 40,000-row bound, 2026-10-20).
        // Cut before the statement that would pass the read's statements: `through` names the last identity considered.
        if (at >= ROWS_MOST) return { rows: found, through: identities[at - 1] };
        const chunk = identities.slice(at, at + ROWS_CHUNK);
        // reads-ok: at most ROWS_CHUNK rows, each by the (identity, kind) primary key, in the caller's order. The value of a row is
        // taken only while the running size of the chunk's rows fits what is left of maxBytes (the first read always takes one), so a
        // value past the slice is measured and never read into the store's memory: a chunk of sixteen 100 KB values read 1.6 MB
        // against a 300 KB slice, and a chunk of sixteen 1.5 MB values 24 MB.
        const read = sql.exec(`SELECT identity, value_identity, CASE WHEN running <= ? OR (position = 1 AND ? = 1) THEN value END AS value FROM (
            SELECT r.identity AS identity, r.value_identity AS value_identity, r.value AS value, ROW_NUMBER() OVER (ORDER BY j.key) AS position,
              SUM(length(r.value)) OVER (ORDER BY j.key) AS running
            FROM json_each(?) AS j CROSS JOIN namespace_results AS r ON r.identity = j.value AND r.kind = ?) ORDER BY position LIMIT ?`,
          maxBytes - bytes, found.length ? 0 : 1, JSON.stringify(chunk), kind, ROWS_CHUNK).toArray();
        for (const row of read) {
          if (row.value === null) return { rows: found, through: found.at(-1).identity };
          found.push({ identity: row.identity, value: row.value, value_identity: row.value_identity }); bytes += row.value.length;
        }
      }
      return { rows: found, through: identities.at(-1) ?? null };
    },
    feed(after, limit) {
      return sql.exec('SELECT seq, kind, identity FROM search_feed WHERE seq > ? ORDER BY seq LIMIT ?', after, limit).toArray();
    },
    ack(upTo) {
      sql.exec('DELETE FROM search_feed WHERE seq <= ?', upTo);
      return true;
    },
  };
}

/** The registered feed kinds that have a feed row after `after`: one seek per kind on search_feed (kind, seq). */
export function kindsWithFeedAfter(sql, after) {
  // reads-ok: one row per result kind a search lane derives (a handful, from search.json)
  return sql.exec('SELECT kind FROM search_feed_kinds ORDER BY kind').toArray().map(row => row.kind)
    .filter(kind => sql.exec('SELECT 1 AS one FROM search_feed WHERE kind = ? AND seq > ? LIMIT 1', kind, after).toArray().length > 0);
}

// The record log as the search index reads it (src/record-search-index.mjs, src/search.mjs words-in-records). The follower
// has no copy of the records: it reads them through the store's RPCs (src/person-store.mjs records*), which answer this
// same shape, so every answer is one bounded page and no call's size grows with the records the person holds.
//   available            whether this engine keeps a record log (an earlier engine does not: its records are read by find)
//   lastLogId()          the id of the newest logged transaction, or null
//   logAfter(after, n)   { ids, count, oldest, last }: the envelope ids of the (at most n) transactions after `after`, in log
//                        order, each once; `count` is the transactions read (a full page says more may follow)
//   types(ids)           [{ id, type }] for at most RECORD_CALL.ids ids (a key lookup, never a record read)
//   read(ids)            { found: [{ id, type, value }], unread: [ids] } for at most RECORD_CALL.ids ids: `value` is null when
//                        the record is missing or past its bounds; a call stops at RECORD_CALL.bytes and names the rest
//   ids(type, { before, limit })  the ids of one type newest first, at most `limit` (at most RECORD_CALL.log)
export const RECORD_CALL = { ids: 100, bytes: 2_000_000, log: 200 };
export function recordFeedWriter(eeaf) {
  const available = Boolean(eeaf?.logAfter && eeaf?.lastLogId && eeaf?.ids);
  const typeOfRecord = id => { try { return eeaf.typeOf(id) ?? null; } catch { return null; } };
  const named = (ids, what) => {
    if (!Array.isArray(ids) || ids.length > RECORD_CALL.ids) throw new RangeError(`${what} names at most ${RECORD_CALL.ids} records`);
    return ids;
  };
  const pageOf = limit => Math.min(RECORD_CALL.log, Math.max(1, Math.trunc(Number(limit)) || 1));
  return {
    available,
    lastLogId: () => eeaf.lastLogId(),
    logAfter(after, limit) {
      // The feed needs only ids, not a retained page of whole transaction payloads.
      // Consume the existing lazy log owner; legacy array-only facades still work.
      const changes = eeaf.logAfter(after, { limit: pageOf(limit), lazy: true, buffer_chars: RECORD_CALL.bytes });
      const ids = new Set();
      let count = 0;
      for (const row of changes.rows) {
        for (const envelope of row.envelopes) ids.add(envelope.id);
        count += 1;
      }
      // The lazy owner's last cursor advances only while complete rows are consumed.
      return { ids: [...ids], count, oldest: changes.oldest, last: changes.last };
    },
    types: ids => named(ids, 'types').map(id => ({ id, type: typeOfRecord(id) })),
    read(ids) {
      named(ids, 'read');
      const found = [];
      let bytes = 0;
      let at = 0;
      for (; at < ids.length; at += 1) {
        if (found.length && bytes >= RECORD_CALL.bytes) break;
        const id = ids[at];
        const type = typeOfRecord(id);
        let value = null;
        if (type) { try { value = eeaf.read(id) ?? null; } catch { value = null; } }
        if (value !== null) bytes += JSON.stringify(value).length;
        found.push({ id, type, value });
      }
      return { found, unread: ids.slice(at) };
    },
    ids: (type, { before, limit } = {}) => eeaf.ids(type, { ...(before === undefined ? {} : { before }), limit: pageOf(limit) }),
  };
}

/**
 * Visit each actual byte-bounded record response before asking for the next one. Input order and repeated identities
 * are retained, so a consumer can apply work in its chosen order without holding previous values. `visit` is synchronous;
 * the source read is awaited outside any transaction. A source making no progress has the same missing-value behavior
 * as readRecords: its last answer is used, and the remaining identities are not retried forever.
 */
export async function visitRecordPages(records, ids, visit) {
  for (let at = 0; at < ids.length; at += RECORD_CALL.ids) {
    let rest = ids.slice(at, at + RECORD_CALL.ids);
    while (rest.length) {
      const answer = await records.read(rest);
      const loaded = new Map(answer.found.map(row => [row.id, row]));
      const advanced = answer.unread.length < rest.length;
      const accepted = advanced ? rest.slice(0, rest.length - answer.unread.length) : rest;
      visit(accepted, loaded);
      if (!advanced) break;
      rest = answer.unread;
    }
  }
}

/** The records of `ids`, read through `records` in bounded calls: Map id -> { id, type, value }; an unread id is asked again. */
export async function readRecords(records, ids) {
  const loaded = new Map();
  await visitRecordPages(records, [...new Set(ids)], (_ids, page) => {
    for (const [id, row] of page) loaded.set(id, row);
  });
  return loaded;
}

/** The types of `ids` through `records`, in calls of RECORD_CALL.ids: Map id -> type (null when the record is missing). */
export async function typesOfRecords(records, ids) {
  const typed = new Map();
  for (let at = 0; at < ids.length; at += RECORD_CALL.ids) for (const row of await records.types(ids.slice(at, at + RECORD_CALL.ids))) typed.set(row.id, row.type);
  return typed;
}
