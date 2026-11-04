// src/record-move.mjs
//
// PURPOSE
//   Moves a person's records from the decomposed tables (parts/eeaf: a row for every value, link and list member, and
//   a log row for each) to the log engine (parts/record-log: one row per write, records packed many to a row), while
//   the store keeps answering and taking writes, losing nothing. A bounded step at a time, from the person store's
//   scheduler:
//     copy      every root record, in the order it was first written, brought into the log engine (load) and read
//               back from it to check the copy is the record; a record a host lays out anew (reshape, by type) is
//               brought in as the records it lays it into. The open log is held where it is meanwhile (holdSealing).
//     catch up  every record the log names after the position the copy started from, copied again, until the changes
//               still to copy are few; then, in one transaction, the last of them are copied, the open log is sealed as
//               the decomposed engine's last generation, and the database says the log engine. The store handed to
//               callers switches in place (src/record-engine.mjs switchTo).
//     archive   the decomposed engine's log generations move to the record history like any others (the record store
//               keeps them as its oldest generations); nothing is dropped while one is in the database.
//     drop      once every change they logged is kept in the record history, and keep_days_after_switch have passed, the
//               decomposed tables go, children first (parts/eeaf nextEeafTable), each a bounded piece per step: its
//               indexes, then rows only while it is too large to drop in one storage operation, then the drop
//               (src/let-go-of-table.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing the decomposed engine holds is dropped before the log engine holds it and its history is kept elsewhere:
//      every copied record is read back and compared whole, the switch copies the last changes in the same transaction
//      that makes it, and the tables go only after their last log generation has been kept and dropped.
//   2. The copy cursor lives where the copied pages do: a bring-in records how far it reached each time it writes its
//      pages out (loadProgress), so a restart, or a step that failed, resumes from what is written and never skips.
//   3. A record keeps its place in its type's order: copied records take the order they were first written in the
//      decomposed engine, before every record the log engine writes itself.
//   4. The move names no product, record kind or field: which records are laid out anew is the host's reshape DATA.
//   5. A move that keeps failing never holds the store's log in place for long: after failures_before_stop failed steps
//      it stops and lets the hold go, and the store answers from the decomposed tables as before; raising `attempt`,
//      or restart_stopped_after_hours passing, starts it again from nothing (what it copied is let go first, never
//      served).
//   6. Whatever a step brought in is written out in the same transaction that moves the copy's phase or watermark past
//      it, so a failed step or a reset never lets go of a record nothing will bring in again.
//
import { decomposedRecords, EARLIER_LOG_KEPT, LOG_ENGINE, setRecordEngine, tableExists } from './record-engine.mjs';
import { nextEeafTable } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { LET_GO_ROWS, letGoStep } from './let-go-of-table.mjs';

export const MOVE_SETTINGS = {
  // Root entities looked at, and bytes of records brought in, in one copy batch.
  entities_per_batch: 200,
  bytes_per_batch: 1024 * 1024,
  // Log rows read for changed records in one catch-up batch.
  log_rows_per_batch: 5000,
  // The switch is made once no more than this many log rows are left to copy (all copied in its transaction).
  switch_within_log_rows: 2000,
  // Batches one step runs before it hands the store back (a count, never a clock: a Worker's clock stands still while
  // it computes, so a time budget would never end a step that only reads and writes SQLite).
  batches_per_step: 6,
  // The rest between steps, so the person's own requests are answered between them.
  rest_seconds: 2,
  // The most rows the move writes in an hour, on average, whatever is left of it (the person's store budgets 500,000 an
  // hour for everything it does): a step that wrote W rows rests W / rows_per_hour of an hour before the next. Letting
  // the decomposed tables go deletes 2,000 rows a piece, 6 pieces a step: on Sam's store, a step every 2 s wrote the
  // hour's budget in minutes. Counted for the drop, whose rows are known; a copy's pages are bounded by its batches.
  rows_per_hour: 100000,
  // How long the decomposed tables are kept, as they were at the switch, after it: a store can be read back from them
  // while the log engine is new to it, beside the record history its changes moved to.
  keep_days_after_switch: 3,
  // A move whose steps fail this many times in one attempt stops (a step that failed starts again from the pages last
  // written, so the same failure comes round again): the hold on the open log is let go and the store keeps
  // answering from the decomposed tables, with the error kept in the move's state and logged.
  failures_before_stop: 3,
  // A stopped move resumes this long after it stopped if its layout is compatible; otherwise it starts clean, so a few
  // passing failures (a reset, a deploy, a statement interrupted) never leave a store on the decomposed tables for good.
  restart_stopped_after_hours: 6,
  // Attempts at or above this floor share the same record layout, so their verified load cursor remains resumable.
  resume_from_attempt: 3,
  // Which attempt the code asks for: an unswitched move at or above resume_from_attempt keeps its verified cursor when
  // this is raised; older layouts start clean. 2: decisions' own steps and calls are copied only while their decision
  // is kept apart (attempt 1 could copy a step left beside a decision kept whole over its own). 3:
  // record past the bounds is reshaped lazily in byte-bounded chunks, and a step the store was reset under counts as failed.
  attempt: 4,
};
const STATE_TABLE = 'record_move';
const BEFORE_SWITCH = new Set(['copy', 'catch-up', 'stopped']);
const SKIPPED_TYPES = new Set(['type', 'property', 'role', 'participation', 'set']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (key, item) => (object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

// The root a decomposed log row changed: the first field of its canonical address (`table|field|...`, `\` and `|`
// escaped), up to the first `/` (a child entity, list or link of that root).
export function rootOfAddress(address) {
  const fields = [];
  let field = '';
  for (let index = address.indexOf('|') + 1; index < address.length; index += 1) {
    const char = address[index];
    if (char === '\\') { field += address[index + 1] ?? ''; index += 1; continue; }
    if (char === '|') { fields.push(field); field = ''; continue; }
    field += char;
  }
  fields.push(field);
  return fields[0].split('/')[0];
}

/**
 * sql        the person's database
 * records    the store handed to callers (src/record-engine.mjs openRecords)
 * transaction, contentId, hash, bounds  as the store was opened with
 * reshape    { [type]: (id, value | null, kept | null, from) -> Iterable<{ id, type, value }> }: the records one record of that type
 *            is brought in as (kept: what the log engine holds for it already; from: the decomposed records, to read
 *            another record it depends on); [] leaves it out. Iterables may yield lazily so a root with many members
 *            does not require holding the reshaped records for that root in memory at once.
 * settings   any of MOVE_SETTINGS, over its defaults
 * now        () -> ms
 */
export function makeRecordMove({ sql, records, transaction, contentId, hash, bounds, reshape = {}, settings: given = {}, now = () => Date.now() }) {
  const settings = { ...MOVE_SETTINGS, ...given };
  const all = (query, ...params) => sql.exec(query, ...params).toArray();
  const stateOf = () => {
    try {
      const row = all(`SELECT value FROM ${STATE_TABLE} WHERE key = 'state'`)[0];
      return row ? JSON.parse(row.value) : null;
    } catch (error) {
      // A new store has no move table until its first step. Read the keyed row directly on every later due check;
      // probing sqlite_master first scans the whole table catalog on every person's request.
      if (/\bno such table:\s*record_move\b/i.test(String(error?.message ?? error))) return null;
      throw error;
    }
  };
  const keepState = state => {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
    sql.exec(`INSERT INTO ${STATE_TABLE} (key, value) VALUES ('state', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(state));
  };
  // The decomposed records, held to the bounds callers are: reading one past them whole is what resets a Durable
  // Object's memory, so such a record is read a part at a time (inParts).
  let reader = null;
  const decomposed = () => (reader ??= decomposedRecords(sql, { transaction, contentId, hash, bounds }));
  const log = () => records.logStore();
  // Where the copy has reached in this isolate: from what the written pages say after a restart or a failed step.
  let cursor = null;
  const progress = () => (cursor ??= log().loadProgress() ?? { after: 0 });
  const forget = () => { cursor = null; log().forgetCached(); };

  const openLogEnd = () => (tableExists(sql, 'bitemporal_facts') ? all('SELECT max(rowid) AS n FROM bitemporal_facts')[0]?.n ?? 0 : 0);
  const seqOf = (rowid, part) => `00${rowid.toString(16).padStart(13, '0')}${part.toString(16).padStart(4, '0')}`;
  const rowidOf = id => all('SELECT rowid AS n FROM entity WHERE id = ?', id)[0]?.n ?? null;

  // The records one root is brought in as, with the order they take; null when it is not a root the move copies.
  // A record past the bounds, read as its own fields and then each object of the lists it grew under, one at a time:
  // the rows of the whole record are never in memory at once.
  function inParts(id, tooLarge) {
    const from = decomposed();
    const lists = (tooLarge.size?.by_field ?? []).map(entry => entry.field).filter(field => from.memberCount(id, field) > 0);
    const value = from.readOwn(id, lists);
    for (const field of lists) value[field] = Array.from({ length: from.memberCount(id, field) }, (_, n) => from.readMember(id, field, n));
    return value;
  }
  const readWhole = id => {
    try { return decomposed().read(id); } catch (error) { if (error?.code !== 'record_too_large') throw error; return inParts(id, error); }
  };
  function broughtIn(id, rowid) {
    const type = decomposed().typeOf(id);
    if (type !== null && (type.includes('/') || SKIPPED_TYPES.has(type))) return null;
    const keptType = log().typeOf(id);
    if (type === null && keptType === null) return [];
    const lay = reshape[type ?? keptType];
    const kept = keptType ? log().read(id, { bounded: false }) : null;
    const from = decomposed();
    const laid = lay?.stream
      ? lay.stream(id, type === null ? null : undefined, kept, from)
      : (() => { const value = type === null ? null : readWhole(id); return lay ? lay(id, value, kept, from) : [{ id, type: type ?? keptType, value }]; })();
    const at = rowid ?? rowidOf(id) ?? 0;
    return (function* sequence() {
      let part = 0;
      for (const item of laid) yield { ...item, seq: seqOf(at, part++) };
    }());
  }
  // Brings records in and reads each back: the copy is the record, or the step fails and nothing of it counts.
  function bringIn(batch, reached) {
    log().load(batch, reached);
    for (const item of batch) {
      const copied = log().read(item.id, { bounded: false });
      if (canonical(copied) !== canonical(item.value)) throw new Error(`The copy of ${item.id} does not match the record.`);
    }
  }

  function copyBatch() {
    const { after } = progress();
    const rows = all('SELECT rowid AS n, id FROM entity WHERE rowid > ? AND instr(id, \'/\') = 0 ORDER BY rowid LIMIT ?', after, settings.entities_per_batch);
    if (!rows.length) return false;
    const batch = [];
    let bytes = 0;
    let reached = after;
    const flush = () => {
      if (!batch.length) return;
      bringIn(batch.splice(0), { after: reached });
      bytes = 0;
    };
    for (const row of rows) {
      for (const item of broughtIn(row.id, row.n) ?? []) {
        batch.push(item);
        bytes += JSON.stringify(item.value)?.length ?? 0;
        if (bytes >= settings.bytes_per_batch) flush();
      }
      reached = row.n;
      if (bytes >= settings.bytes_per_batch) break;
    }
    flush();
    // Keep this root cursor behind every chunk written above. The enclosing transaction makes the chunks and cursor
    // advance together, so a reset either commits the complete root or makes it eligible to be copied again.
    log().loadDone({ after: reached });
    cursor = { after: reached };
    return true;
  }
  // The records the open log names after `after`, up to `limit` rows: { roots, last, more }.
  function changedSince(after, limit) {
    const rows = all('SELECT rowid AS n, record_id FROM bitemporal_facts WHERE rowid > ? ORDER BY rowid LIMIT ?', after, limit);
    return { roots: [...new Set(rows.map(row => rootOfAddress(row.record_id)))], last: rows.at(-1)?.n ?? after, more: rows.length === limit };
  }
  function copyAgain(roots, reached) {
    const batch = [];
    let bytes = 0;
    const flush = () => {
      if (!batch.length) return;
      bringIn(batch.splice(0), reached);
      bytes = 0;
    };
    for (const id of roots) for (const item of broughtIn(id, null) ?? []) {
      batch.push(item);
      bytes += JSON.stringify(item.value)?.length ?? 0;
      if (bytes >= settings.bytes_per_batch) flush();
    }
    flush();
  }

  function switchOver(state) {
    transaction(() => {
      const { roots } = changedSince(state.watermark, Number.MAX_SAFE_INTEGER);
      copyAgain(roots, { after: progress().after });
      log().loadDone({ after: progress().after, switched: true });
      decomposed().sealLog();
      setRecordEngine(sql, LOG_ENGINE);
      records.holdSealing(false);
      keepState({ ...state, phase: 'archive', switched_at: new Date(now()).toISOString() });
    });
    records.switchTo(log());
  }

  let restUntil = 0;
  const stoppedUntil = state => Date.parse(state.stopped_at ?? state.started_at) + (settings.restart_stopped_after_hours ?? Infinity) * 3600000;
  const dropFrom = state => Date.parse(state.switched_at) + (settings.keep_days_after_switch ?? 0) * 86400000;
  // The archive owner keeps this list current as it seals and drops old generations. Reuse it instead of scanning
  // sqlite_master again whenever the scheduler asks whether an archived store can finish its move.
  const earlierGenerations = () => records.sealedLogs().filter(name => name.startsWith('bitemporal_facts_sealed_')).length;
  function nextAt() {
    const state = stateOf();
    // rest_until is kept in the state the step writes anyway, so a store that started again keeps the pace.
    const due = Math.max(now(), restUntil, state?.rest_until ?? 0);
    if (!state) return records.engine() === LOG_ENGINE ? null : due;
    if (state.phase === 'done') return null;
    if (BEFORE_SWITCH.has(state.phase) && (state.attempt ?? 1) < settings.attempt) return due;
    if (state.phase === 'stopped') return Math.max(due, stoppedUntil(state));
    if (state.phase === 'archive') return earlierGenerations() ? null : Math.max(due, dropFrom(state));
    return due;
  }

  // One step: copies, catches up, switches, or drops a table, at most batches_per_step times.
  function step() {
    restUntil = now() + (settings.rest_seconds ?? 0) * 1000;
    let written = 0;
    let state = stateOf();
    // Attempts before the compatible-layout floor start clean. A corrected attempt at or above the floor keeps its
    // verified pages and resumes from their persisted load cursor; an expired stopped move resumes its last phase.
    if (state && BEFORE_SWITCH.has(state.phase) && ((state.attempt ?? 1) < settings.attempt || (state.phase === 'stopped' && now() >= stoppedUntil(state)))) {
      if ((state.attempt ?? 1) >= settings.resume_from_attempt) {
        const { stopped_at, stopped_from, last_error, ...kept } = state;
        state = { ...kept, phase: state.phase === 'stopped' ? stopped_from ?? 'copy' : state.phase, attempt: settings.attempt, failures: 0, running: false };
        cursor = log().loadProgress() ?? { after: 0 };
        transaction(() => { records.holdSealing(true); keepState(state); });
      } else {
        records.clearLogStore();
        cursor = null;
        state = null;
      }
    }
    if (state?.phase === 'stopped') return { phase: 'stopped', more: false };
    if (!state) {
      if (records.engine() === LOG_ENGINE) return { phase: 'done', more: false };
      // Both stores are opened before any transaction, so the tables they make are kept whatever a step rolls back.
      decomposed();
      log();
      state = { phase: 'copy', watermark: openLogEnd(), started_at: new Date(now()).toISOString(), attempt: settings.attempt };
      transaction(() => { records.holdSealing(true); keepState(state); });
    }
    if (state.phase === 'copy' || state.phase === 'catch-up') { decomposed(); log(); }
    // A step marks itself running before it works and clears the mark when it ends: a mark found still set is a step that
    // never ended (the Durable Object was reset under it), counted as a failure like one that threw.
    if (state.running) state = failed(state, 'a step did not finish (the store was reset while it ran)');
    if (state.phase === 'stopped') return { phase: 'stopped', more: false };
    state = { ...state, running: true };
    keepState(state);
    // The rest after a step is the longer of rest_seconds and the hour's share of the rows it wrote.
    const ended = result => {
      restUntil = Math.max(restUntil, now() + written / settings.rows_per_hour * 3600000);
      state = { ...state, running: false, rest_until: restUntil };
      keepState(state);
      return result;
    };
    try {
      for (let batch = 0; batch < settings.batches_per_step; batch += 1) {
        // A record brought in lives only in the log engine's memory until its pages are written out, and nothing
        // brings it in again once the phase or the watermark has moved past it: so the copy's end and every catch-up
        // batch write out what they brought in, in the same transaction that moves the phase or the watermark on.
        // Found by seeded faults (test/store-crash-recovery.test.mjs): a catch-up step that failed (or a reset) let go
        // of every record copied since the last write-out, and the switch then served the store without them.
        if (state.phase === 'copy') {
          const next = { ...state, phase: 'catch-up' };
          if (!transaction(() => copyBatch() || (log().loadDone({ after: progress().after }), keepState(next), false))) state = next;
          continue;
        }
        if (state.phase === 'catch-up') {
          const { roots, last, more } = changedSince(state.watermark, settings.log_rows_per_batch);
          if (!more && openLogEnd() - state.watermark <= settings.switch_within_log_rows) { switchOver(state); state = stateOf(); return ended({ phase: 'archive', more: false }); }
          const next = { ...state, watermark: last };
          transaction(() => { copyAgain(roots, { after: progress().after }); log().loadDone({ after: progress().after }); keepState(next); });
          state = next;
          continue;
        }
        if (state.phase === 'archive') {
          if (earlierGenerations() || now() < dropFrom(state)) return ended({ phase: 'archive', more: false });
          state = { ...state, phase: 'drop' };
          // The kept positions of the earlier generations go first: with them gone the store no longer opens that
          // engine for its generations, so nothing makes its tables again while they are dropped.
          transaction(() => { if (tableExists(sql, EARLIER_LOG_KEPT)) sql.exec(`DROP TABLE ${EARLIER_LOG_KEPT}`); keepState(state); });
          continue;
        }
        if (state.phase === 'drop') {
          // Each table goes a bounded piece per step (src/let-go-of-table.mjs), then is dropped.
          const table = nextEeafTable(sql);
          if (table === null) { state = { ...state, phase: 'done', done_at: new Date(now()).toISOString() }; return ended({ phase: 'done', more: false }); }
          const piece = transaction(() => { const letGo = letGoStep(sql, table); if (letGo === 'drop') sql.exec(`DROP TABLE ${table}`); return letGo; });
          if (piece === 'rows') written += LET_GO_ROWS;
          continue;
        }
        return ended({ phase: state.phase, more: false });
      }
      return ended({ phase: state.phase, more: true });
    } catch (error) {
      // What the failed step brought in is taken back with its transaction; the copy resumes from the written pages.
      forget();
      failed({ ...state, running: false }, String(error?.message ?? error));
      throw error;
    }
  }
  // Counts a failed step; at failures_before_stop, before the switch, the move stops and lets go of the open log.
  function failed(state, why) {
    const failures = (state.failures ?? 0) + 1;
    const stops = failures >= settings.failures_before_stop && BEFORE_SWITCH.has(state.phase);
    console.error(JSON.stringify({ record_move_failed: state.phase, failures, stops, error: why.slice(0, 300) }));
    const next = { ...state, running: false, failures, last_error: why.slice(0, 300), ...(stops ? { phase: 'stopped', stopped_from: state.phase, stopped_at: new Date(now()).toISOString() } : {}) };
    transaction(() => { if (stops) records.holdSealing(false); keepState(next); });
    return next;
  }

  return { nextAt, step, state: stateOf };
}
