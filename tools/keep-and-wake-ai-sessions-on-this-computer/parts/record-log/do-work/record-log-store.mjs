// parts/record-log/do-work/record-log-store.mjs
//
// A RECORD STORE WHOSE TRUTH IS AN APPEND-ONLY LOG OF ENVELOPES, OVER ANY SQLITE.
//
// Purpose
//   Whole root records (`{ id, type, value }`) kept the way a log-structured engine keeps them: every write() appends
//   ONE row to the log holding every envelope of that write (group commit), and the records, their type lists, their
//   recency and the field indexes the host declares are keys of one ordered key space (kept-runs.mjs), held in memory
//   until they are written out together as packed pages. A write costs one row; writing the key space out costs about
//   one row for every page_bytes of changed records, however many records and index entries they are. Reads answer
//   from memory (the key space's memtable and page cache) or, cold, one row per page. The interface is the record
//   store's (write, read, ids, find, typeOf, the list operations, the log's generations), so callers do not change.
//
// Non-negotiable invariants
//   1. The log is the truth: a change exists once its log row is committed, in the caller's transaction. The key space
//      is a projection of the log: after a restart, or a transaction that rolled back (forgetCached), it is rebuilt from
//      the pages already written plus the log rows after the position they cover, and every write first checks that the
//      log ends where the projection thinks it does, so a rollback nobody reported is caught before it is built on.
//   2. One write() is one transaction and one log row (several rows only when its envelopes pass log_row_chars, all in
//      the same transaction). A write that changes nothing appends nothing.
//   3. A record's keys: `i|id` ([type, seq, value]: everything a read by id needs, in one key, so a record not in
//      memory costs one page), `r|type|seq|id` (1; seq orders a type's records by when each was first written),
//      `t|type|id` (a type's ids in id order), `y|type` (the types held), and one `f|type|index|value...|id` per declared
//      index it has values for. Separator is U+0000, which JSON text never holds. Records written before this layout
//      keep their value at `r|type|seq|id` and `[type, seq]` at `i|id` until they are next written; both are read.
//   4. A nested object the host marks content-addressed (contentId) is kept once as its own record under that id,
//      linked from every record using it, never removed by one record's change; reading resolves the link.
//   5. Field indexes are DATA the host passes ({ type, name, paths }); the module names no product, record kind or field.
//      A field read or range over an index nobody declared is refused by name, never answered by a scan.
//      A declaration may opt into a named `backfill` group for keys missing from old checkpoints. The existing idle
//      maintainer builds those keys a bounded type page at a time; indexReady stays false until keys and progress
//      are durably committed. Building an index never rewrites the record or its history.
//      Carried fields form part of that declaration. An explicitly retired index with a named backfill drains its
//      exact key prefix in bounded idle slices; unnamed historical retirements remain erasure-only declarations.
//   6. Memory is bounded by bytes: the key space's memtable (written out when full) and page cache, the shared-object
//      cache, bounded selected index keys, the resident records (parts/slot-table, `slot_bytes`), and nothing that grows with the store.
//   7. A record read or written is resident in a slot (parts/slot-table) as { type, seq, value, size }: its id is hashed
//      once to find the slot, and every later read of it is an array index with no key built, no page parsed and its
//      size already counted. The slots are a cache of the projection: every applied envelope updates them, a rebuild
//      clears them, and nothing is ever answered from a slot the projection would not answer.
//   8. A failed statement marks the projection stale unless its SQL owner proves it refused before execution.
//      Every call through the interface first rebuilds a stale
//      projection: no answer and no write is ever built on memory a failure may have left ahead of or behind the log,
//      including a rebuild that itself failed partway.
//   9. Every envelope written carries what it replaced: a field change its `was` (each changed field's value before)
//      and `added` (fields that did not exist before), a whole value or a removal its `prior` ({ type, value } or null).
//      That is what makes a change undoable, a record readable as it was at an earlier time, and a change from another
//      copy appliable only where this copy still holds what that change replaced (applyChanges). It costs bytes in the
//      log row, never another row.
//  10. The store keeps an order-free checksum of everything it holds (record-digest.mjs), changed one field at a time
//      and kept with each write-out of the pages, so two copies compare by one root and find what differs by bucket.
//      A store whose pages were written before it was kept builds it as idle work, `checksum_page` records a call, with
//      its progress kept beside the pages; until then checksum() answers { root: null, buckets: null }, never a walk of
//      every record in one call.
//  11. The EEAF data model is kept as keys of the same space (record-model.mjs, DATA from the host): every record
//      written keeps `k|type|property|kind` (each value kind each property of a type has held: its type's properties, known
//      the first time data uses them) and, for a kind that declares parts, one `p|participant|holder|role|ordinal` per
//      thing it holds (participation; a list's members in order are its interaction set, kept as a record of its own:
//      one `s|set|holder|role` per holder, the set named by the hash of its members in order), so "what is X inside" and
//      "who holds this set" are each one range and cost no row beyond the pages. A record of a declaring type (a list) declares a kind of its own as it is
//      written. Records kept before the model are walked as idle work (`model_build_v2`): the kinds with parts first,
//      each over its own type list, and a kind whose parts change again; then every record once for its value kinds; a holder is always checked against the record it names before it is
//      answered, so an entry a changed declaration left behind is never served. A live write whose changed field breaks
//      its type's declared kind is refused (ModelRefused) before its log row; replay, load and another copy's changes
//      are never refused.
//
// Security
//   No credential, no network. Partitioning between people is the host's job (one database per person). Ids are refused
//   when they hold "/" (a root id) or U+0000.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { keptRuns, repairKeptRunsCatalog, KeptRangeBudgetExceeded, KEPT_RANGE_PROGRESS, KEPT_RUNS_DEFAULTS } from './kept-runs.mjs';
import { slotTable } from '../../../../slot-table/do-work/slot-table.mjs';
import { jsonExpansionBytes } from '../../../../json-expansion.mjs';
import { sqlStatementWasNotExecuted } from '../../../../sql-statement-execution.mjs';
import { jsonMembers } from './json-members.mjs';
import pacing from '../../../../record-log/do-work/maintenance-pacing.json' with { type: 'json' };
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { storeSums, lanesFrom, bucketOf, textHash, BUCKETS } from '../../../../record-log/do-work/record-digest.mjs';
import { stateOf, stateFrom, merge, keptFrom, stampAfter, tieByContent, envelopeOfKept, sameKept } from '../../../../record-log/do-work/record-stamps.mjs';
import { recordModel, declarationIndexesOf, partsOf, setsOf, refusalOf, undeclaredOf, factsOf, valueKindOf, ModelRefused, ModelUndeclared } from '../../../../record-log/do-work/record-model.mjs';
import { recordTables } from './record-tables.mjs';
import { erasableKeys, erasureQueue, seal, open as openSealed, isSealed, keyIdOf, SEALED_MARK } from './erasable.mjs';
export { ModelRefused, ModelUndeclared };

const SEP = '\u0000';
const AFTER = '\u0001';
// The literal starts a group read is limited to (lastPerGroup `startsWith`): null for every group, otherwise the
// distinct non-empty strings in key order, a start inside another's range dropped so no group is answered twice.
export function groupStarts(startsWith) {
  if (startsWith === undefined || startsWith === null) return null;
  if (!Array.isArray(startsWith) || !startsWith.length || startsWith.some(start => typeof start !== 'string' || !start))
    throw new Error('Group starts must be a list of non-empty strings.');
  const sorted = [...new Set(startsWith)].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return sorted.filter((start, at) => !sorted.slice(0, at).some(earlier => start.startsWith(earlier)));
}

export const RECORD_BOUNDS = { rows: 30000, bytes: 8 * 1024 * 1024 };
// Index readiness kept by the host (src/index-readiness.mjs). Without one, readiness lives in the kept-runs meta.
const NO_READINESS = { isReady: () => false, set: () => {}, setMany: () => {}, reload: () => {} };
const SHARED_KEPT = 100;
const SHARED_CACHE_BYTES = 8 * 1024 * 1024;
const SHARED_EXPANSION_BYTES = 32 * 1024 * 1024;
// The bytes of resident records (decoded, sized) kept beside the key space's page cache.
export const SLOT_BYTES = 4 * 1024 * 1024;
const MEMBER_CACHE_BYTES = 1024 * 1024;
const MEMBER_CACHE_ENTRIES = 256;
// Records walked per page of a checksum build (buildSums), and the key its progress is kept under beside the pages.
export const CHECKSUM_PAGE = 5000;
// Pages one idle wake writes merging runs, across as many merges as fit (record-runs; maintain): about a quarter of a
// second of a store's CPU at half a millisecond a page.
export const WAKE_PAGES = 512;
// One bounded turn of an alarm-driven maintenance wake: at most this many milliseconds of work and this many pages
// written (64 pages of 64 KiB, 4 MiB), reading at most MAINTENANCE_TURN_INPUT_PAGES pages (4 MiB) per merge step.
// The wake then returns, so reads queued behind it run before the next turn; merge and projection progress are
// saved in the same transactions, so many turns finish the same work a long wake would. A wake with no `left` runs
// every merge it can fit in WAKE_PAGES without a clock, which on a 4 GB store held the object for 4 to 12 seconds.
export const MAINTENANCE_TURN_MS = pacing.turn_ms;
export const MAINTENANCE_TURN_PAGES = pacing.turn_pages;
export const MAINTENANCE_TURN_INPUT_PAGES = pacing.turn_input_pages;
// maintenance-pacing.json: alarm_ms is how long one alarm invocation keeps running turns back to back (yielding to the
// event loop between them so queued requests are admitted); 0 is one turn per wake, which is what a live book runs, since
// longer wakes lengthened the stage on a 4.2 GB book (2026-10-21). gap_ms is the least time from the last turn to the next
// maintenance wake. A store with no due work rests whatever these say.
export const MAINTENANCE_ALARM_MS = pacing.alarm_ms;
export const MAINTENANCE_ALARM_GAP_MS = pacing.gap_ms;
const yieldToQueue = () => new Promise(resolve => setTimeout(resolve, 0));
export async function maintainInTurns(records, { alarmMs = MAINTENANCE_ALARM_MS, turnMs = MAINTENANCE_TURN_MS, clock = () => performance.now(), yieldTurn = yieldToQueue, now = Date.now, report = null } = {}) {
  const started = clock(), ends = started + alarmMs;
  let result = { merged: false, more: false }, turns = 0, slowest = null, slowestMs = -1;
  do {
    const turnStarted = clock();
    result = records.maintain(maintenanceTurn({ ms: turnMs, clock }), now());
    turns += 1;
    const took = clock() - turnStarted;
    if (took > slowestMs) { slowestMs = took; slowest = result.diagnostics ?? null; }
    if (!result.more || clock() >= ends) break;
    await yieldTurn();
  } while (true);
  // What a wake did, for the log: how many turns, how long all and the slowest took, and what the slowest turn spent its time on.
  report?.({ turns, wake_ms: Math.round(clock() - started), slowest_turn_ms: Math.round(slowestMs), slowest_turn: slowest, more: Boolean(result.more) });
  return { ...result, turns };
}
// The earliest an alarm may next run maintenance: the gap after the last turn, never sooner than the store says it is due.
export function maintenancePacing(gap = MAINTENANCE_ALARM_GAP_MS, clock = Date.now) {
  let last = null;
  return {
    nextAt: at => (at === null || last === null ? at : Math.max(at, last + gap)),
    ran: () => { last = clock(); },
  };
}
export function maintenanceTurn({ ms = MAINTENANCE_TURN_MS, clock = () => performance.now() } = {}) {
  const ends = clock() + ms;
  return { max_pages: MAINTENANCE_TURN_PAGES, max_input_pages: MAINTENANCE_TURN_INPUT_PAGES, left: () => Math.max(0, ends - clock()) };
}
const SUMS_BUILD = 'sums_build';
// A value-free directory of all retained heads, including removal stamps and unknown kinds. Its epoch rides in
// the existing projection checkpoint: a writer without this directory drops that proof and starts a fresh build.
const BUCKET_DIRECTORY_SIGNATURE = 'record-bucket-heads-v1';
const BUCKET_DIRECTORY_PAGE = 256;
const BUCKET_DIRECTORY_READ_PAGE = 32;
const BUCKET_DIRECTORY_ROOT = `z${SEP}`;
const LOG_ROW_CHARS = 512 * 1024;
const LOG = 'record_log';
const SEALED_LOG = 'record_log_sealed_';
// `keys`: the erasable keys the row's write made ({ record id: base64 }), beside its envelopes, never in them
// (erasable.mjs invariant 1); moved out when the open log is sealed, and taken out at once when a record is erased.
const LOG_TABLE_SQL = name => `CREATE TABLE IF NOT EXISTS ${name} (id TEXT NOT NULL, transaction_id TEXT NOT NULL, actor_context TEXT NOT NULL, application_time TEXT NOT NULL, system_time TEXT NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL, envelopes TEXT NOT NULL, keys TEXT)`;
const SHARED_MARK = '\u0000shared';

/** A record too large to read whole: `record_id`, and `size` { rows, bytes, by_field } saying where it grew. */
export class RecordTooLarge extends Error {
  constructor(recordId, size) {
    super(`Record ${recordId} is too large to open (${size.rows} rows, ${size.bytes} bytes).`);
    this.code = 'record_too_large';
    this.record_id = recordId;
    this.size = size;
  }
}

// A time-ordered id (UUIDv7, RFC 9562) for log rows; within one millisecond the 12-bit rand_a field counts up.
let lastMs = 0;
let counter = 0;
/** The first log id of the millisecond `ms`: every log id written before it sorts lower. */
export function logIdAt(ms) {
  const hex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-`;
}
/** The time (ms) a log row id was made at: its first twelve hex digits. */
export function logTimeOf(id) {
  return Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
}
/** A place in the log: a log row id as given, or the place of a time (anything Date.parse reads). */
export function logPositionOf(at) {
  if (typeof at === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(at)) return at;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`${at} is neither a time nor a log row id.`);
  return logIdAt(ms);
}
// Random bytes are drawn from the system a pool at a time (one call per 256 ids, not one per id), and written out as hex
// through a table, so making an id costs well under a microsecond.
const POOL = new Uint8Array(4096);
let poolAt = POOL.length;
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));
export function uuidv7() {
  if (poolAt + 16 > POOL.length) { crypto.getRandomValues(POOL); poolAt = 0; }
  const bytes = POOL.subarray(poolAt, poolAt + 16);
  poolAt += 16;
  let ms = Date.now();
  if (ms <= lastMs) { counter += 1; ms = lastMs; if (counter > 0xfff) { counter = 0; ms += 1; } } else counter = 0;
  lastMs = ms;
  for (let index = 5, rest = ms; index >= 0; index -= 1, rest = Math.floor(rest / 256)) bytes[index] = rest % 256;
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = '';
  for (let index = 0; index < 16; index += 1) hex += HEX[bytes[index]];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// The order a record was first written in: its log row's time and in-millisecond count (15 hex digits from the UUIDv7)
// and its place among that row's envelopes. Records brought in from another store (load) take `seqOf` they are given.
const seqFrom = (logId, index) => `${logId.slice(0, 8)}${logId.slice(9, 13)}${logId.slice(15, 18)}${index.toString(16).padStart(4, '0')}`;
/** The stamp of one envelope of a log row (record-stamps.mjs): its own when it names one, else its place. */
export const envelopeStamp = (rowId, envelope, index) => envelope.at ?? envelope.seq ?? seqFrom(rowId, index);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isListOfObjects = value => Array.isArray(value) && value.length > 0 && value.every(isObject);
// What a field holds as a value of its own (a scalar, or a list of scalars): the only fields a field read answers.
const isScalarField = value => value !== undefined && !isObject(value) && !isListOfObjects(value);

const recordKey = (type, seq, id) => `r${SEP}${type}${SEP}${seq}${SEP}${id}`;
const idKey = id => `i${SEP}${id}`;
// A record's erasable key alone ({ key, at }), beside its entry: what opening another record sealed under it (a copy)
// or a field an index carries reads, a few dozen bytes to a key where the record's own entry is all its value.
const keyHolderKey = id => `e${SEP}${id}`;
const typeKey = (type, id) => `t${SEP}${type}${SEP}${id}`;
const typesKey = type => `y${SEP}${type}`;
const indexPrefix = (type, name) => `f${SEP}${type}${SEP}${name}${SEP}`;
const holderKey = (participant, holder, role, ordinal) => `p${SEP}${participant}${SEP}${holder}${SEP}${role}${SEP}${ordinal ?? ''}`;
const seenKey = (type, property, kind) => `k${SEP}${type}${SEP}${property}${SEP}${kind}`;
const setKey = (set, holder, role) => `s${SEP}${set}${SEP}${holder}${SEP}${role}`;
// An interaction set's name: the first 16 bytes of the blake3 hash of its members' ids in order, as hex.
const setHash = text => bytesToHex(blake3(new TextEncoder().encode(text))).slice(0, 32);
const MODEL_BUILD = 'model_build_v2';
// keys.range compares JavaScript strings, so its exclusive prefix end advances a UTF-16 code unit.
// The bound need not be a valid stored id; it only has to follow every key beginning with the prefix.
const afterKeyPrefix = prefix => {
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const code = prefix.charCodeAt(index);
    if (code < 0xffff) return `${prefix.slice(0, index)}${String.fromCharCode(code + 1)}`;
  }
  return null;
};

// Consume one committed log transaction without joining or parsing its whole envelope array. The first and
// final rows establish its identity and application position; each intervening part is checked as it is read.
// Replay's existing selected-read batch owner receives at most 256 envelopes / 2 MiB of their JSON text at once,
// except that one supported larger envelope is kept whole. The completion event follows strict JSON validation:
// no partially consumed or malformed transaction can advance the projection's durable application position.
export function replayLogBatches(sql, from, applyBatch, keysAt = null, slice = null) {
  // reads-ok: only one metadata row is returned; the incomplete-tail count walks changed log rows without their text.
  const all = (query, ...params) => sql.exec(query, ...params).toArray();
  let after = from, rowsRead = 0;
  function* rows() {
    for (;;) {
      const page = sql.exec(`SELECT rowid AS n, id, transaction_id, part, parts, keys, envelopes FROM ${LOG} WHERE rowid > ? ORDER BY rowid LIMIT 16`, after)[Symbol.iterator]();
      let found = false;
      try {
        for (;;) {
          const taken = page.next();
          if (taken.done) break;
          found = true;
          after = taken.value.n; rowsRead += 1;
          yield taken.value;
        }
      } finally { page.return?.(); }
      if (!found) return;
    }
  }
  const source = rows();
  let events = [], queuedChars = 0;
  const flush = () => {
    if (!events.length) return;
    const batch = events;
    events = []; queuedChars = 0;
    applyBatch(batch);
  };
  const queue = (event, chars = 0) => {
    if (events.length && queuedChars + chars > 2 * 1024 * 1024) flush();
    events.push(event); queuedChars += chars;
    if (events.length >= 256 || queuedChars >= 2 * 1024 * 1024) flush();
  };
  try {
    for (let taken; !(taken = source.next()).done;) {
      const first = taken.value;
      if (first.part !== 0 || !Number.isSafeInteger(first.parts) || first.parts < 1)
        throw new Error('The record log has an incomplete transaction.');
      if (keysAt && typeof first.keys === 'string' && first.keys) keysAt(first.n, first.keys);
      // Ordinary atomic writes have contiguous rowids, so their final metadata is one indexed point read. Validate
      // its identity before using it; older/copied logs with gaps fall back to a metadata-only ordinal seek.
      const finalId = first.parts === 1 ? first.id : `${first.id}.${first.parts - 1}`;
      const finalAt = first.n + first.parts - 1;
      let end = first.parts === 1 ? first : Number.isSafeInteger(finalAt)
        ? all(`SELECT rowid AS n, id, transaction_id, part, parts FROM ${LOG} WHERE rowid = ? LIMIT 1`, finalAt)[0] : null;
      if (first.parts > 1 && (!end || end.part !== first.parts - 1 || end.parts !== first.parts
        || end.transaction_id !== first.transaction_id || end.id !== finalId))
        end = all(`SELECT rowid AS n, id, transaction_id, part, parts FROM ${LOG} WHERE rowid >= ? ORDER BY rowid LIMIT 1 OFFSET ?`, first.n, first.parts - 1)[0];
      if (!end) {
        // Older replay ignored an unfinished multipart tail and answered only preceding complete transactions.
        // Metadata proves this tail cannot complete before any of its envelopes are parsed or dispatched. Count
        // its remaining rows without selecting their text, retaining the old tail accounting and application floor.
        rowsRead += all(`SELECT COUNT(*) AS n FROM ${LOG} WHERE rowid > ?`, first.n)[0]?.n ?? 0;
        flush();
        return rowsRead;
      }
      if (end.part !== first.parts - 1 || end.parts !== first.parts || end.transaction_id !== first.transaction_id
        || end.id !== finalId)
        throw new Error('The record log has an incomplete transaction.');
      function* chunks() {
        for (let part = 0; part < first.parts; part += 1) {
          const row = part === 0 ? first : source.next().value;
          if (!row || row.part !== part || row.parts !== first.parts || row.transaction_id !== first.transaction_id
            || row.id !== (part === 0 ? first.id : `${first.id}.${part}`) || (part === first.parts - 1 && row.n !== end.n))
            throw new Error('The record log has an incomplete transaction.');
          yield row.envelopes;
        }
      }
      // One member of lookbehind identifies the final envelope only after the array and all parts validate.
      // Ordinary transactions retain their existing batch cardinality: a completion-only event is needed only
      // for an empty array, not an additional event for every small write in a cold tail.
      let prior = null;
      for (const member of jsonMembers(chunks(), { chars: Infinity, bytes: Infinity, container: 'array', strictWhitespace: true })) {
        if (prior) queue({ logId: first.id, at: end.n, envelope: prior.value, index: prior.path[0], last: false }, prior.chars);
        prior = member;
      }
      queue({ logId: first.id, at: end.n, envelope: prior?.value ?? null, ...(prior ? { index: prior.path[0] } : {}), last: true }, prior?.chars ?? 0);
      // A slice stops only after a whole transaction, so what it applied is a position the log covers.
      if (slice && rowsRead >= slice.rows) { slice.more = true; break; }
    }
    flush();
    return rowsRead;
  } finally { source.return?.(); }
}

/**
 * The store over one SQLite database.
 *   sql         { exec(query, ...params) -> { toArray() } }
 *   transaction (fn) -> result, running fn atomically (optional; defaults to calling fn)
 *   contentId   (typeName, value) -> id | null: a nested object stored once under that id
 *   indexes     [{ type, name, paths: [[field, ...], ...] }]: the field indexes kept, as DATA; one marked
 *               `retired: true` is kept no more and never read. With a named `backfill`, idle work retires its old
 *               keys; without one it retains the historical erasure-only behavior for keys once built from words
 *   bounds      { rows, bytes }: past these one record is refused (RecordTooLarge) instead of read
 *   runs        kept-runs options (page_bytes, memtable_bytes, cache_bytes, fan_in)
 */
/** Whether `name` is a table the record log keeps invariants over: its log and sealed logs, its kept key space (catalogue, metadata, large
 *  values, runs), its typed tables and their registry, and the copy positions and erasable keys that follow it. Nothing outside the log
 *  removes rows from these piecemeal: a catalogue naming a run whose pages are gone makes the store throw when it opens its records. */
export const recordLogOwnsTable = name => /^(record_|_record_|rt_)/.test(name);

/** Brings the record log's kept key space back to one that opens after pages were removed from under its catalogue
 *  (kept-runs repairKeptRunsCatalog), through any handle over the same database and without opening the store. */
export function repairRecordLogCatalog(sql, { transaction = fn => fn() } = {}) {
  return repairKeptRunsCatalog(sql, { transaction, prefix: 'record_keys' });
}

/** Derived space a full store may let go from this log's kept runs (kept-runs releaseDerivedSpace), through any handle
 *  over the same database (src/full-store-recovery.mjs): their marker is read from SQLite on every call, so a live
 *  store's next step sees the merge gone and starts it again when room allows. A database holding no runs frees nothing. */
export function releaseRecordLogSpace(sql, { transaction = fn => fn() } = {}) {
  if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'record_keys_runs'").toArray().length) return { freed: false, more: false };
  return keptRuns(sql, { transaction, prefix: 'record_keys' }).releaseDerivedSpace();
}

export function recordLogStore(host, { transaction = fn => fn(), readiness: hostReadiness = null, readOnly = false, contentId = null, indexes: indexData = [], model: modelData = {}, erasable: erasableData = {}, history_archives = false, strict_model = false, columns = [], bounds = RECORD_BOUNDS, runs: runOptions = {}, slot_bytes = SLOT_BYTES, member_cache_bytes = MEMBER_CACHE_BYTES, member_cache_entries = MEMBER_CACHE_ENTRIES, selection_cache_bytes = 1024 * 1024, selection_cache_entries = 256, checksum_page = CHECKSUM_PAGE, selected_scan_budget = { pages: 2048, entries: 4096 }, shared_cache_bytes = SHARED_CACHE_BYTES, shared_expansion_bytes = SHARED_EXPANSION_BYTES, strict_reads = typeof process !== 'undefined' && process.env?.RECORD_READS_STRICT === '1' } = {}) {
  const readiness = hostReadiness ?? NO_READINESS;
  const declarationIndexes = declarationIndexesOf(modelData);
  if (indexData.some(index => declarationIndexes.some(own => own.type === index.type && own.name === index.name)))
    throw new Error('The model declaration index is owned by the model DATA.');
  const indexes = [...indexData, ...declarationIndexes].filter(index => !index?.retired);
  const retiredIndexes = indexData.filter(index => index?.retired);
  if (!Number.isSafeInteger(shared_cache_bytes) || shared_cache_bytes < 1
    || !Number.isSafeInteger(shared_expansion_bytes) || shared_expansion_bytes < 1) throw new Error('recordLogStore shared read bounds must be positive safe integers');
  if (![member_cache_bytes, member_cache_entries].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Member projection cache bounds must be nonnegative safe integers');
  // These projections contain only selected raw scalars, never resolved links. The log owner invalidates them
  // before changing a root, including unlogged load, and clears them on replay/rollback. No missing root is cached.
  // Bound both entries and decoded bytes, including request keys; every answer remains a fresh mutable copy.
  const memberCache = new Map();
  const memberRoots = new Map();
  let memberCacheBytes = 0;
  const dropMemberProjection = entry => {
    memberCache.delete(entry);
    memberCacheBytes -= entry.bytes;
    const root = memberRoots.get(entry.id);
    root.delete(entry.key);
    if (!root.size) memberRoots.delete(entry.id);
  };
  const forgetMemberProjections = id => {
    for (const entry of memberRoots.get(id)?.values() ?? []) dropMemberProjection(entry);
  };
  const memberRequestKey = (id, field, names, ordinals) => member_cache_bytes && member_cache_entries && typeof id === 'string' && typeof field === 'string'
    ? JSON.stringify([field, Array.from(names), ordinals === null ? null : Array.from(ordinals)]) : null;
  const cachedMemberProjection = (id, key) => {
    const entry = key === null ? null : memberRoots.get(id)?.get(key);
    if (!entry) return null;
    memberCache.delete(entry); memberCache.set(entry, true);
    return structuredClone(entry.value);
  };
  const keepMemberProjection = (id, key, value) => {
    if (key === null) return;
    const size = sharedValueSize(value, member_cache_bytes);
    const bytes = 256 + (id.length + key.length) * 2 + size.bytes;
    if (bytes > member_cache_bytes) return;
    const prior = memberRoots.get(id)?.get(key);
    if (prior) dropMemberProjection(prior);
    while (memberCache.size >= member_cache_entries || memberCacheBytes + bytes > member_cache_bytes) dropMemberProjection(memberCache.keys().next().value);
    const entry = { id, key, bytes, value: structuredClone(value) };
    if (!memberRoots.has(id)) memberRoots.set(id, new Map());
    memberRoots.get(id).set(key, entry);
    memberCache.set(entry, true); memberCacheBytes += bytes;
  };
  // Cache only ordered selection keys, never record bodies. A narrower interval is covered when the
  // retained prefix contains the requested count, or the original interval was exhausted. Incomplete
  // selections cannot prove a suffix that has too few keys. No time rounding or extra cold SQL is needed.
  if (![selection_cache_bytes, selection_cache_entries].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Selection cache bounds must be nonnegative safe integers');
  const selectionCache = new Map();
  let selectionCacheBytes = 0;
  const dropSelection = entry => { selectionCache.delete(entry); selectionCacheBytes -= entry.bytes; };
  const forgetSelections = type => {
    for (const entry of selectionCache.keys()) if (type === undefined || entry.type === type) dropSelection(entry);
  };
  const selectionEnabled = count => selection_cache_bytes && selection_cache_entries
    && (count === Infinity || (Number.isSafeInteger(count) && count > 0));
  const selectionBaseBytes = (type, mode, lo, hi) => 256 + (type.length + mode.length + lo.length + hi.length) * 2;
  function cachedSelectionKeys(type, mode, lo, hi, direction, count) {
    for (const entry of selectionCache.keys()) {
      if (entry.type !== type || entry.mode !== mode || entry.reverse !== direction || lo < entry.lo || hi > entry.hi) continue;
      const found = [];
      for (const key of entry.keys) if (key >= lo && key < hi) {
        found.push(key);
        if (found.length >= count) break;
      }
      if (found.length >= count || entry.complete) {
        selectionCache.delete(entry); selectionCache.set(entry, true);
        return found;
      }
    }
    return null;
  }
  function keepSelectionKeys(type, mode, lo, hi, direction, count, found, bytes = null) {
    if (bytes === null) {
      bytes = selectionBaseBytes(type, mode, lo, hi);
      for (const key of found) { bytes += 24 + key.length * 2; if (bytes > selection_cache_bytes) return; }
    }
    if (bytes > selection_cache_bytes) return;
    while (selectionCache.size >= selection_cache_entries || selectionCacheBytes + bytes > selection_cache_bytes) dropSelection(selectionCache.keys().next().value);
    const entry = { type, mode, lo, hi, reverse: direction, complete: found.length < count, keys: found.slice(), bytes };
    selectionCache.set(entry, true); selectionCacheBytes += bytes;
  }
  function selectionKeys(type, mode, lo, hi, { reverse = false, limit = Infinity } = {}) {
    const count = limit === Infinity ? Infinity : Math.ceil(limit);
    const enabled = typeof limit === 'number' && selectionEnabled(count);
    const direction = !!reverse;
    const cached = enabled ? cachedSelectionKeys(type, mode, lo, hi, direction, count) : null;
    if (cached) return cached;
    const found = keys.range(lo, hi, { reverse, limit, keys_only: true }).map(([key]) => key);
    if (enabled) keepSelectionKeys(type, mode, lo, hi, direction, count, found);
    return found;
  }
  function allSelectionIds(type, lo, hi, prefixLength) {
    const mode = 'ids-all', enabled = selectionEnabled(Infinity);
    const cached = enabled ? cachedSelectionKeys(type, mode, lo, hi, false, Infinity) : null;
    if (cached) return cached.map(key => key.slice(prefixLength));
    const out = [];
    let bytes = selectionBaseBytes(type, mode, lo, hi);
    let candidate = enabled && bytes <= selection_cache_bytes ? [] : null;
    // Keep the original cold walk and one required output. Cache bookkeeping never retains a second
    // history-sized array: once the candidate exceeds its byte bound, discard it and finish the walk.
    for (const [key] of keys.walk(lo, hi)) {
      out.push(key.slice(prefixLength));
      if (candidate) {
        bytes += 24 + key.length * 2;
        if (bytes > selection_cache_bytes) candidate = null;
        else candidate.push(key);
      }
    }
    if (candidate) keepSelectionKeys(type, mode, lo, hi, false, Infinity, candidate, bytes);
    return out;
  }
  // current: whether the projection in memory is the log's. A statement that fails anywhere (in this store or the key
  // space under it) may leave memory ahead of or behind the database, so it marks the projection stale and the next
  // call rebuilds it first (invariant 8). Found by seeded faults (test/store-crash-recovery.test.mjs): a rebuild cut off
  // partway answered without the records written since the last page write-out, and the next write was built on that.
  let current = false;
  // Report only a real current -> stale transition. The reason is a fixed
  // label: SQL text, bindings and error contents can include customer data.
  // Which known platform failure an error is, by a fixed list of its words; any other message stays out of the log (it can hold values).
  const FAILURE_KINDS = [[/network connection lost/i, 'network_connection_lost'], [/durable object (?:reset|storage operation exceeded timeout)/i, 'object_reset'],
    [/overloaded/i, 'object_overloaded'], [/subrequest depth limit/i, 'subrequest_depth_limit'], [/too many terms in compound select/i, 'compound_select_terms'],
    [/database or disk is full|storage limit/i, 'storage_full'], [/statement outside a measured lifetime/i, 'outside_measured_lifetime']];
  const failureKind = error => { const text = typeof error?.message === 'string' ? error.message : ''; return FAILURE_KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? null; };
  const invalidateProjection = (reason, error = null, query = null, why = null) => {
    const changed = current;
    current = false;
    if (!changed) return;
    // Logging cannot replace the failure that requires recovery. Only bounded
    // diagnostic tokens and a recognized SQL verb leave this owner.
    try {
      const token = value => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z_0-9]{0,63}$/.test(value) ? value : null;
      const operation = typeof query === 'string' ? /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|PRAGMA|BEGIN|COMMIT|ROLLBACK|WITH)\b/i.exec(query)?.[1]?.toUpperCase() ?? 'other' : null;
      const diagnostic = Object.freeze({ reason, operation, error_name: token(error?.name), error_code: token(error?.code), error_reason: token(error?.reason), error_kind: failureKind(error), ...(why ? whyForgotten(why) : {}) });
      try { host.projectionInvalidated?.(diagnostic); } catch {}
      console.warn('record-log projection invalidated', diagnostic);
    } catch {}
  };
  // Why a failed transaction forgot the projection (RecordBook 880c74dd, 2026-10-19: which of no mark, a moved mark or
  // an open outer transaction): only counts, booleans and the code locations of the caller, never a value.
  const whyForgotten = ({ mark }) => {
    const frames = String(new Error().stack ?? '').split('\n').slice(3, 11)
      .map(line => line.trim().replace(/^at /, '').replace(/\((?:file|https?):\/\/[^)]*\/([^/)]+)\)/, '($1)').slice(0, 120));
    return { mark: mark === null || mark === undefined ? 'none' : mark === projectionChanges ? 'unchanged' : 'moved',
      changes_since_mark: Number.isSafeInteger(mark) ? projectionChanges - mark : null,
      changed_in_transaction: host.inTransaction?.() === true && typeof host.transactionToken === 'function' ? changedInTransaction === host.transactionToken() : null,
      changes_total: projectionChanges,
      store: typeof host.storeId === 'function' ? host.storeId() : null, transactions_counted: host.transactionsCounted === true, transaction_depth: typeof host.transactionDepth === 'function' ? host.transactionDepth() : null,
      site: frames };
  };
  // How many times this store has changed its projection or written its tables. A failed outermost transaction whose
  // caller took this mark at its start (changeMark) and finds it unchanged left the projection as committed (forgetCached).
  let projectionChanges = 0;
  let changedInTransaction = null;
  const noteChange = () => { projectionChanges += 1; changedInTransaction = host.transactionToken?.() ?? null; };
  // A mark means something only where no transaction is open yet (the host counts every one, host.transactionsCounted):
  // inside one, an outer transaction can still roll back what this store changed earlier in it, so there is none.
  const markNow = () => host.transactionsCounted === true && host.inTransaction?.() === false ? projectionChanges : null;
  // Whether a failed transaction left this projection as committed: its caller's mark is unchanged, or (a nested step, which
  // has no mark of its own) this store changed nothing since the outermost open transaction began, so that transaction's
  // rollback restores exactly what is cached. A command refused at its bound before it changed anything keeps the projection.
  const unchangedSince = mark => {
    if (Number.isSafeInteger(mark)) return mark === projectionChanges;
    if (mark !== null && mark !== undefined) return false;
    return host.transactionsCounted === true && host.inTransaction?.() === true && typeof host.transactionToken === 'function' && changedInTransaction !== host.transactionToken();
  };
  // Even when the final statement never ran, an enclosing transaction can have rolled back earlier SQL and
  // cached schema/key changes. Every transaction supplied to child projections retains that recovery boundary.
  const transact = transaction;
  // One that failed before this store changed anything leaves the projection current (projectionChanges, forgetCached).
  transaction = work => { const mark = markNow(); try { return transact(work); } catch (error) { if (!unchangedSince(mark)) invalidateProjection('transaction-failed', error, null, { mark }); throw error; } };
  // databaseSize (bytes the database holds, where the host reports it) lets the key space keep a merge within the space left.
  const WRITES = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
  // A read-only statement that failed because the connection to storage was lost changed nothing, so with no write of this store
  // pending in an open transaction the projection is as committed (RecordBook 880c74dd, 2026-10-20: two lost connections on a WITH
  // read sent 10-13 callers "catching up" each). Any other failed statement still leaves it untrusted: it may have reached SQLite.
  const readLostConnection = (query, error) => !(WRITES.test(query) || (/^\s*WITH\b/i.test(query) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query)))
    && failureKind(error) === 'network_connection_lost' && (host.inTransaction?.() !== true || unchangedSince(null));
  const sql = { exec(query, ...params) { if (WRITES.test(query)) noteChange(); try { return host.exec(query, ...params); } catch (error) { if (!sqlStatementWasNotExecuted(host, error) && !readLostConnection(query, error)) invalidateProjection('sql-statement-failed', error, query); throw error; } }, get databaseSize() { return host.databaseSize; }, get databaseFreeBytes() { return host.databaseFreeBytes; } };
  // Who rebuilds a projection a call finds stale: a host that names its own upkeep (host.rebuild(work)) runs the rebuild
  // there, or refuses the call as busy until it has; any other host's call rebuilds it first, as before. Opening a store
  // always rebuilds it.
  const rebuild = () => (typeof host.rebuild === 'function' ? host.rebuild(() => replay(host.replaySliceRows?.() ?? null)) : replay());
  const all = (query, ...params) => sql.exec(query, ...params).toArray();
  sql.exec(LOG_TABLE_SQL(LOG));
  // An open log made before rows kept keys beside their envelopes gains the column (an empty one: no row is rewritten).
  if (!all(`PRAGMA table_info(${LOG})`).some(column => column.name === 'keys')) sql.exec(`ALTER TABLE ${LOG} ADD COLUMN keys TEXT`);
  let activeExpansion = null;
  const boundedPackedJson = (text, context = {}) => {
    const used = activeExpansion?.bytes ?? 0;
    const budget = Math.max(0, shared_expansion_bytes - used);
    const size = jsonExpansionBytes(text, budget);
    if (size.bytes > budget) {
      const recordId = context.key?.split(SEP).at(-1) ?? context.ref ?? 'packed record value';
      throw new RecordTooLarge(activeExpansion?.rootId ?? recordId, {
        rows: (activeExpansion?.rows ?? 0) + size.rows,
        bytes: used + size.bytes,
      });
    }
    return JSON.parse(text);
  };
  const keys = keptRuns(sql, { transaction, prefix: 'record_keys', prefix_page_bytes: [{ prefix: `f${SEP}`, bytes: 8 * 1024 }, { prefix: BUCKET_DIRECTORY_ROOT, bytes: Math.min(8 * 1024, (runOptions.page_bytes ?? KEPT_RUNS_DEFAULTS.page_bytes) / 2) }], ...runOptions, parseJson: boundedPackedJson });
  // Every change to the key space in memory is a projection change (forgetCached), as every write of its tables is.
  for (const method of ['put', 'remove']) { const original = keys[method]; keys[method] = (...args) => { noteChange(); return original(...args); }; }
  let bucketDirectory;
  const directoryPrefix = bucket => `${BUCKET_DIRECTORY_ROOT}${bucketDirectory.epoch}${SEP}${bucket.toString(16).padStart(2, '0')}${SEP}`;
  const directoryKey = id => `${directoryPrefix(bucketOf(id))}${id}`;
  const directoryCovered = id => bucketDirectory.ready || (bucketDirectory.after !== null && id <= bucketDirectory.after)
    || (typeof bucketDirectory.through === 'string' && id > bucketDirectory.through);
  const keepDirectoryHead = (id, alreadyHeld = false) => {
    if (!alreadyHeld || !directoryCovered(id)) keys.put(directoryKey(id), 1);
  };
  const dropDirectoryHead = id => {
    const key = directoryKey(id);
    keys.remove(key, obsoleteIndexBytes(key));
  };
  const bucketDirectoryPending = () => !bucketDirectory.ready || bucketDirectory.retiring;
  const sharedFieldTypes = new Set(keys.meta.get('shared_field_types') ?? []);
  let pendingShared = null;
  // Ephemeral metadata for this actual write only. The first live application,
  // including a shared member created while building envelopes, owns BEFORE.
  // Map absence stays unknown; a present null is a known absent/removed root.
  let mutationBeforeTypes = null;
  const noteMutationBefore = (id, before) => {
    if (mutationBeforeTypes && !mutationBeforeTypes.has(id)) mutationBeforeTypes.set(id, before?.type ?? null);
  };
  const SHARED_ID = 'shared:1f:';
  const sharedId = (type, value) => `${SHARED_ID}${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([type, value]))))}`;
  const sharedMember = (type, value) => {
    if (!isObject(value) || typeof value[SHARED_MARK] === 'string') return value;
    const id = sharedId(type, value);
    if (!kept(id)) {
      const memberType = `${type}/shared-member`;
      // This creation precedes the pending member's later live application.
      // Capture BEFORE here, never from the value setRecord is about to make.
      noteMutationBefore(id, null);
      setRecord(id, memberType, id.slice(SHARED_ID.length), value, null, null, { at: id });
      pendingShared?.set(id, { id, type: memberType, value, at: id, seq: id.slice(SHARED_ID.length) });
    }
    return { [SHARED_MARK]: id };
  };
  function shareEnvelope(envelope) {
    const type = envelope.type ?? envelope.prior?.type;
    if (!sharedFieldTypes.has(type) || envelope.id.startsWith(SHARED_ID)) return envelope;
    const share = value => value && Object.fromEntries(Object.entries(value).map(([field, item]) => [field, sharedMember(type, item)]));
    return { ...envelope,
      ...(envelope.value !== undefined ? { value: share(envelope.value) } : {}),
      ...(envelope.set ? { set: share(envelope.set) } : {}),
      ...(envelope.was ? { was: share(envelope.was) } : {}),
      ...(envelope.prior?.type === type ? { prior: { ...envelope.prior, value: share(envelope.prior.value) } } : {}),
    };
  }
  // Representation-only forward migration: history stays in the log, stamps and logical values stay unchanged.
  // Each old field crosses the guard independently; the old container is never decoded whole.
  function shareStoredFields(id) {
    if (id.startsWith(SHARED_ID)) return false;
    let type, seq, meta = null, changed = false, chars = 0, inline = false;
    const links = Object.create(null);
    try { transaction(() => {
      const add = (field, member) => {
        const link = sharedMember(type, member.value);
        links[field] = link;
        if (link !== member.value) { changed = true; sumsFor(id)?.change(id, { [field]: member.value }, { [field]: link }, [field]); }
        if (keys.overfull()) writeOut(applied);
      };
      for (const member of jsonMembers(keys.jsonParts(idKey(id)), { expand: [[2]], bytes: shared_expansion_bytes })) {
        chars += member.chars;
        if (member.path.length === 1) {
          if (member.path[0] === 0) { type = member.value; if (!sharedFieldTypes.has(type)) return; }
          else if (member.path[0] === 1) seq = member.value;
          else if (member.path[0] === 3) meta = member.value;
        } else {
          inline = true;
          add(member.path[1], member);
        }
      }
      if (!inline && sharedFieldTypes.has(type) && seq) {
        for (const member of jsonMembers(keys.jsonParts(recordKey(type, seq, id)), { bytes: shared_expansion_bytes })) {
          chars += member.chars;
          add(member.path[0], member);
        }
      }
      if (!changed) return;
      const size = sizeOfValue(links);
      keys.put(idKey(id), meta ? [type, seq, links, meta] : [type, seq, links], size.bytes + size.rows * 12 + type.length + seq.length + 8 + stampsSize(meta), chars * 2);
      if (!inline) keys.put(recordKey(type, seq, id), 1);
      resident(id, type, seq, links, true, size, meta);
      // Old secondary indexes can cross changed stored members; those logical members are the same through links.
      // Publishing all new keys together with this representation prevents a restart replaying half a migration.
      writeOut(applied);
    }); } catch (error) { invalidateProjection('transaction-failed', error); throw error; }
    return changed;
  }
  // The erasable fields' keys (erasable.mjs), set up with the data model below; a record read before then primes none.
  let erasing = null;
  function keptPosition(id) {
    let at;
    try { at = keys.get(idKey(id)); }
    catch (error) {
      if (error.code !== 'record_too_large' || !sharedFieldTypes.size || !shareStoredFields(id)) throw error;
      at = keys.get(idKey(id));
    }
    primeKey(id, at);
    return at;
  }
  // A record's entry keeps its erasable key as its fifth part ({ key, at }: record-log-store invariant 3, erasable.mjs
  // invariant 1), so a read of the record holds the key that opens it without reading anything more.
  // One-use metadata from an authentic bounded page; no values or page bodies are retained.
  // Every semantic root writer and replay discard all proofs, including writes that later roll back.
  let copiedOwnerPages = null;
  // Scoped only to consumption of this owner's authentic page proof; never a retained root cache.
  let copiedKeyRoots = null;
  const primeKey = (id, at) => { if (erasing && Array.isArray(at) && at[4]) erasing.prime(id, at[4]); };
  const slots = slotTable({ capacity_bytes: slot_bytes, columns });
  const declared = new Map();
  for (const index of indexes) {
    if (typeof index?.type !== 'string' || typeof index?.name !== 'string' || !Array.isArray(index.paths) || !index.paths.length) throw new Error('An index needs a type, a name and paths.');
    if (index.where !== undefined && (!Array.isArray(index.where) || index.where.some(rule => !Array.isArray(rule.path) || !rule.path.length || !Array.isArray(rule.not)))) throw new Error('An index condition needs a path and excluded scalar values.');
    if (index.carry !== undefined && (!Array.isArray(index.carry) || index.carry.some(path => !Array.isArray(path) || !path.length || path.some(part => typeof part !== 'string')))) throw new Error('An index carries fields named by their paths.');
    if (index.carry_presence !== undefined && (!Array.isArray(index.carry_presence) || !index.carry?.length || index.carry_presence.some(path => !Array.isArray(path) || !path.length || path.some(part => typeof part !== 'string' || !part)))) throw new Error('Carried presence needs carried fields and nonempty field paths.');
    if (!declared.has(index.type)) declared.set(index.type, []);
    declared.get(index.type).push(index);
  }
  const indexNamed = (type, name) => (declared.get(type) ?? []).find(index => index.name === name);
  for (const index of retiredIndexes) if (indexNamed(index.type, index.name)) throw new Error('An index cannot be current and retired.');
  const indexOnPaths = (type, paths) => (declared.get(type) ?? []).find(index => !index.where?.length && JSON.stringify(index.paths) === JSON.stringify(paths));
  // Only declarations opting into a named build need new keys for already-checkpointed records. One type/group
  // shares one cursor and reads each old head once, even when several new indexes ask questions of that head.
  const indexBuilds = new Map();
  for (const index of [...indexes, ...retiredIndexes.filter(index => index.backfill)].filter(index => index.backfill)) {
    if (typeof index.backfill !== 'string') throw new Error('An index backfill names its build.');
    if (typeof index.type !== 'string' || typeof index.name !== 'string') throw new Error('An index needs a type and name.');
    const key = `${index.retired ? 'index-retire' : 'index-build'}:${index.type}:${index.backfill}`;
    if (!indexBuilds.has(key)) indexBuilds.set(key, { key, type: index.type, retired: index.retired === true, indexes: [] });
    indexBuilds.get(key).indexes.push(index);
  }
  // A checkpoint made by a writer without this projection drops its proof. Give
  // the next supported writer a new epoch, so older schema-valid entries cannot
  // certify values that such a writer changed without updating the index payload.
  const carriedDescriptors = indexes.filter(index => index.carry_presence !== undefined)
    .map(({ type, name, carry, carry_presence }) => ({ type, name, carry, carry_presence }));
  const carriedSignature = JSON.stringify(carriedDescriptors);
  const carriedProof = keys.covered()?.carried_projection;
  const carriedEpoch = carriedDescriptors.length
    ? carriedProof?.signature === carriedSignature && typeof carriedProof.epoch === 'string'
      ? carriedProof.epoch : uuidv7()
    : null;
  for (const group of indexBuilds.values()) group.signature = JSON.stringify(group.indexes.map(({ name, paths, where, carry, carry_presence, retired }) => ({
    name, paths, ...(where ? { where } : {}),
    // Carried metadata changes require rebuilding even when ordered paths stay the same.
    ...(carry ? { carry } : {}),
    ...(carry_presence !== undefined ? { carry_presence, epoch: carriedEpoch } : {}),
    ...(retired ? { retired: true } : {}),
  })));
  const qualifiedBuildState = (group, state) => state?.signature === group.signature ? state
    : { signature: group.signature, after: null, ready: false };
  // A finished build is answered by the host's readiness; a build still running (or never run) reads its progress from the meta.
  const buildState = group => {
    if (readiness.isReady(group.key, group.signature)) return { signature: group.signature, after: null, ready: true };
    const state = qualifiedBuildState(group, keys.meta.get(group.key));
    if (state.ready) readiness.set(group.key, group.signature);
    return state;
  };
  const indexesPending = () => {
    const groups = [...indexBuilds.values()].filter(group => !readiness.isReady(group.key, group.signature));
    const states = keys.meta.getMany(groups.map(group => group.key));
    let pending = false;
    for (const group of groups) {
      const state = qualifiedBuildState(group, states.get(group.key));
      if (state.ready) readiness.set(group.key, group.signature); else pending = true;
    }
    return pending;
  };
  const nextIndexBuild = () => {
    const groups = [...indexBuilds.values()];
    const saved = keys.meta.get('index_build_last');
    const last = groups.findIndex(group => group.key === saved);
    for (let offset = 1; offset <= groups.length; offset += 1) {
      const group = groups[(last + offset) % groups.length];
      if (!buildState(group).ready) return group;
    }
    return null;
  };
  const indexReady = (type, name) => {
    const index = indexNamed(type, name);
    if (!index) {
      const dynamic = tableKind(type)?.indexes?.some(item => item.name === name);
      if (!dynamic) throw new Error(`No index named ${name} is declared for ${type} records.`);
      return tableComplete(type);
    }
    return !index.backfill || buildState(indexBuilds.get(`index-build:${type}:${index.backfill}`)).ready;
  };
  // Coverage is independent of membership: a covered id can have no matching key.
  // A committed cursor covers earlier ids, and every id beyond the captured old
  // frontier was written through the current index owner. An unstarted/legacy
  // build without that frontier cannot prove the latter. Never advance a build
  // or read a record body just to answer this bounded caller selection.
  const indexCovered = (type, name, ids) => {
    const index = indexNamed(type, name);
    if (!index) throw new Error(`No index named ${name} is declared for ${type} records.`);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.includes(SEP)))
      throw new Error('Index coverage needs an array of record ids.');
    if (!ids.length) return new Set();
    inStep();
    if (!index.backfill) return new Set(ids);
    const state = buildState(indexBuilds.get(`index-build:${type}:${index.backfill}`));
    if (state.ready) return new Set(ids);
    return new Set(ids.filter(id => (typeof state.after === 'string' && id <= state.after)
      || (typeof state.through === 'string' && id > state.through)));
  };

  // ---- the data model (invariant 11) -----------------------------------------------------------------------------
  const model = recordModel(modelData);
  // ---- erasable fields (erasable.mjs) ------------------------------------------------------------------------------
  // The fields each kind declares erasable (the model's `erasable`) are kept sealed under their record's own key: every
  // row, page, copy and archive line holds the sealed form, and erase(id) deletes the key. Reads open them; a field
  // whose key is gone reads as null. A field is named by itself ("text") or by its path within the record
  // (["input", "said"]: one field of an object whose other fields stay as they are, and may be indexed).
  // A device's copy is given the erasable fields as their own DATA ({ type: [field] }), without the whole model.
  const erasableByType = new Map([...Object.entries(erasableData).filter(([, fields]) => Array.isArray(fields) && fields.length),
    ...(modelData.kinds ?? []).filter(kind => Array.isArray(kind?.erasable) && kind.erasable.length).map(kind => [kind.type, kind.erasable])]);
  const pathOf = field => (Array.isArray(field) ? field : [field]);
  const startsWith = (path, prefix) => prefix.length <= path.length && prefix.every((field, at) => path[at] === field);
  for (const [type, fields] of erasableByType) {
    if ((modelData.kinds ?? []).find(kind => kind.type === type)?.table === true) throw new Error(`${type} is a table kind; its fields cannot be erasable yet.`);
    if (fields.some(field => !pathOf(field).length || pathOf(field).some(part => typeof part !== 'string'))) throw new Error(`An erasable field of ${type} is a name or a path of names.`);
    for (const index of indexes) if (index.type === type && index.paths.some(path => fields.some(field => startsWith(path, pathOf(field))))) throw new Error(`The index ${index.name} of ${type} orders by an erasable field.`);
  }
  const erasableOf = type => erasableByType.get(type) ?? [];
  // Indexed metadata can remain readable while a record exists, then be
  // physically scrubbed with its words when it is erased. It cannot be sealed
  // without changing the index contract. Both sets travel in erasure evidence.
  const eraseFieldsByType = new Map((modelData.kinds ?? []).filter(kind => Array.isArray(kind?.erase_fields))
    .map(kind => [kind.type, kind.erase_fields]));
  const erasureFieldsOf = type => [...new Map([...erasableOf(type), ...(eraseFieldsByType.get(type) ?? [])]
    .map(field => [JSON.stringify(pathOf(field)), field])).values()];
  for (const [type, fields] of eraseFieldsByType) {
    if ((modelData.kinds ?? []).find(kind => kind.type === type)?.table === true)
      throw new Error(`${type} is a table kind; its fields cannot be erased yet.`);
    if (fields.some(field => !pathOf(field).length || pathOf(field).some(part => typeof part !== 'string')))
      throw new Error(`An erase_fields field of ${type} is a name or a path of names.`);
  }
  // The erasable fields that lie within an object of a record, across every kind: a read opens them where they are.
  const nestedErasable = [...new Map([...erasableByType.values()].flat().map(pathOf).filter(path => path.length > 1).map(path => [JSON.stringify(path), path])).values()];
  const nameOfField = field => pathOf(field).join('.');
  const fieldAt = (holder, field) => {
    let at = holder;
    for (const part of pathOf(field)) { if (!isObject(at)) return undefined; at = at[part]; }
    return at;
  };
  // `holder` with the field at `field` made `make(item)`, its objects on the way copied, never changed; `holder` itself
  // when there is nothing there or nothing changed.
  const withField = (holder, field, make) => {
    const [part, ...rest] = pathOf(field);
    if (!isObject(holder) || holder[part] === undefined) return holder;
    const next = rest.length ? withField(holder[part], rest, make) : make(holder[part]);
    return next === holder[part] ? holder : { ...holder, [part]: next };
  };
  // The keys a retired index built from a value whose erasable fields were words: the key's text holds them, so an
  // erasure takes the key out of the runs (kept-runs dropKey) wherever it meets such a value.
  const retiredOf = type => [...indexes, ...retiredIndexes].filter(index => index.type === type
    && index.paths.some(path => erasureFieldsOf(type).some(field => startsWith(path, pathOf(field)))));
  const retiredKeysOf = (type, id, value) => {
    const list = type ? retiredOf(type) : [];
    if (!list.length || !isObject(value) || !erasureFieldsOf(type).some(field => plainField(fieldAt(value, field)))) return [];
    return indexKeysOf(type, id, value, list);
  };
  const dropKeys = found => { let dropped = 0; for (const key of new Set(found)) dropped += keys.dropKey(key); return dropped; };
  // The records erased with one of a kind (the model's `erase_with`, DATA): { id: "<template with {id}>" } a record named
  // from this one's id; { field, type? } the record a field of this one names (`type` when that record is already
  // removed); { type, index, equal? } the records of a kind whose declared single-value index holds this one's id (or
  // `equal`, a template: {id} the id, {key} the id after its kind's `type:`). Followed from each record erased in turn,
  // each record once; only kinds with erasable fields are erased.
  const eraseWithByType = new Map((modelData.kinds ?? []).filter(kind => Array.isArray(kind?.erase_with)).map(kind => [kind.type, kind.erase_with]));
  function erasedWith(id, type, value) {
    const out = [];
    for (const link of eraseWithByType.get(type) ?? []) {
      if (typeof link.id === 'string') out.push({ id: link.id.replaceAll('{id}', id), type: link.type ?? null });
      else if (typeof link.field === 'string' || Array.isArray(link.field)) { const named = fieldAt(value, link.field); if (typeof named === 'string' && named) out.push({ id: named, type: link.type ?? null }); }
      else if (typeof link.type === 'string' && typeof link.index === 'string') {
        const key = id.startsWith(`${type}:`) ? id.slice(type.length + 1) : id;
        const equal = typeof link.equal === 'string' ? link.equal.replaceAll('{id}', id).replaceAll('{key}', key) : id;
        out.push(...scan(link.type, link.index, { equal: [equal], all: true }).map(entry => ({ id: entry.id, type: link.type })));
      }
    }
    return out;
  }
  // The key a record's entry keeps ({ key, at }), or null: what a read of the record reads anyway.
  const keyInLog = id => {
    const held = keys.get(keyHolderKey(id));
    if (typeof held?.key === 'string') return held;
    if (copiedKeyRoots?.has(id)) return copiedKeyRoots.get(id);
    const at = keys.get(idKey(id));
    return Array.isArray(at) && at[4] ? at[4] : null;
  };
  // Same current-key owner and precedence as keyInLog, with bounded group admission.
  // This reads authentic metadata; a caller's payload cannot prime or prove an absent key.
  const keysInLog = ids => {
    const found = new Map();
    // Complete resident membership already serves cheap point reads. Preserve
    // that owner path; groups remove amplification in cold/unfiltered runs.
    if (keys.exactMembershipResident()) {
      for (const id of new Set(ids)) found.set(id, keyInLog(id));
      return found;
    }
    const exact = key => ({ lo: key, hi: `${key}\u0000` });
    const batch = selected => {
      if (!selected.length) return;
      if (selected.length === 1) { found.set(selected[0], keyInLog(selected[0])); return; }
      let holders, positions;
      try {
        const value_budget = { remaining: 2 * 1024 * 1024 };
        holders = new Map(keys.ranges(selected.map(id => exact(keyHolderKey(id))), { value_budget }));
        const missing = selected.filter(id => typeof holders.get(keyHolderKey(id))?.key !== 'string' && !copiedKeyRoots?.has(id));
        positions = new Map(keys.ranges(missing.map(id => exact(idKey(id))), { value_budget }));
      } catch (error) {
        if (!(error instanceof KeptRangeBudgetExceeded) && error.code !== 'record_too_large') throw error;
        holders = null; positions = null;
        const middle = Math.ceil(selected.length / 2);
        batch(selected.slice(0, middle)); batch(selected.slice(middle));
        return;
      }
      for (const id of selected) {
        const holder = holders.get(keyHolderKey(id)), at = positions.get(idKey(id));
        found.set(id, typeof holder?.key === 'string' ? holder : copiedKeyRoots?.has(id) ? copiedKeyRoots.get(id) : Array.isArray(at) && at[4] ? at[4] : null);
      }
    };
    const unique = [...new Set(ids)];
    for (let at = 0; at < unique.length; at += 64) batch(unique.slice(at, at + 64));
    return found;
  };
  // An erased record's key leaves the open-log row that made it at once (secure_delete overwrites what the update
  // frees); its entries in the key space are written again without it (scrubPages), and again when the idle scrub
  // ends, for a run a merge wrote meanwhile.
  const forgetKeyInLog = id => {
    const at = erasing.rowOf(id);
    if (at === null) return;
    const text = all(`SELECT keys FROM ${LOG} WHERE rowid = ? LIMIT 1`, at)[0]?.keys;
    if (typeof text !== 'string') return;
    const made = JSON.parse(text);
    if (!(id in made)) return;
    delete made[id];
    sql.exec(`UPDATE ${LOG} SET keys = ? WHERE rowid = ?`, Object.keys(made).length ? JSON.stringify(made) : null, at);
  };
  erasing = erasableKeys(sql, { inLog: keyInLog, inLogMany: keysInLog });
  // Whose key a kind's erasable fields are sealed under (the model's `erasable_key`: the path of a field naming the
  // record whose words they are, an arrival's message); its own when it names none.
  const keyOwnerPaths = new Map((modelData.kinds ?? []).filter(kind => kind?.erasable_key).map(kind => [kind.type, kind.erasable_key]));
  // Kinds whose records may keep a key of their own or open under another's (an `e|` entry is theirs alone).
  const holdsKeys = type => erasableOf(type).length > 0 || keyOwnerPaths.has(type);
  const keyIdFor = (type, id, value) => { const path = keyOwnerPaths.get(type); const named = path ? fieldAt(value, path) : null; return typeof named === 'string' && named ? named : id; };
  // A key is kept by the log row of the write that makes it; work that writes no row keeps it in the table at once, and
  // a rebuild (replay) makes none.
  const keyFor = id => (pendingShared !== null ? erasing.ensure(id) : replaying !== null ? null : erasing.ensureKept(id));
  const sealFields = (id, type, value) => {
    const fields = erasableOf(type);
    if (!fields.length || !isObject(value)) return value;
    let out = value;
    let key = null;
    const owner = keyIdFor(type, id, value);
    if (owner !== id && erasing.erased(owner))
      return fields.reduce((out, field) => withField(out, field, item => plainField(item) ? null : item), value);
    for (const field of fields) out = withField(out, field, item => (item === null || isSealed(item) ? item : seal(key ??= keyFor(owner), id, nameOfField(field), item, owner)));
    return out;
  };
  // What reads opened, held in this object's memory only (never written) so a read of many records does not decrypt each
  // field again: the words and numbers opened, keyed by record, field and the sealed text, up to OPENED_BYTES. Any key
  // erased or forgotten empties it (eraseHere, replay), so nothing opened under a deleted key is ever answered from it.
  const opened = new Map();
  let openedBytes = 0;
  const OPENED_BYTES = 4 * 1024 * 1024;
  const forgetOpened = () => { opened.clear(); openedBytes = 0; };
  const openedSize = (at, value) => at.length + (typeof value === 'string' ? value.length : 8);
  const openField = (id, field, item) => {
    if (!isSealed(item)) return item;
    const at = `${id}\0${field}\0${item[SEALED_MARK]}`;
    if (opened.has(at)) return opened.get(at);
    const found = openSealed(erasing.keyOf(keyIdOf(id, item)), id, field, item);
    if (found === undefined) return null;
    // Objects are opened afresh each read: a caller changing what it was given never changes what the next one reads.
    if (typeof found === 'object' && found !== null) return found;
    const size = openedSize(at, found);
    if (size > OPENED_BYTES) return found;
    for (const [first, value] of opened) { if (openedBytes + size <= OPENED_BYTES) break; openedBytes -= openedSize(first, value); opened.delete(first); }
    opened.set(at, found);
    openedBytes += size;
    return found;
  };
  const openFields = (id, value) => {
    if (!isObject(value)) return value;
    let out = value;
    for (const [field, item] of Object.entries(value)) {
      if (!isSealed(item)) continue;
      if (out === value) out = { ...value };
      out[field] = openField(id, field, item);
    }
    for (const path of nestedErasable) out = withField(out, path, item => openField(id, nameOfField(path), item));
    return out;
  };
  // A change applied with an erasable field as words (a copy opened before it knew the field was erasable, undo or kept
  // history of a record written before) is sealed as it arrives, value and change and what it replaced alike: sealing is deterministic, so what it
  // replaced seals to exactly what this store holds and the change applies as it would have. Nothing here is ever kept
  // as words. A copy taking the copy it follows keeps what that one holds as it holds it.
  const sealArriving = (envelope, type) => {
    const fields = erasableOf(type);
    if (!fields.length) return envelope;
    let key = null;
    const sealed = { ...envelope };
    const owner = keyIdFor(type, envelope.id, envelope.value ?? envelope.prior?.value ?? envelope.was);
    const erasedOwner = owner !== envelope.id && erasing.erased(owner);
    const sealIn = holder => {
      let out = holder;
      for (const field of fields) out = withField(out, field, item => (item === null || isSealed(item) ? item
        : erasedOwner ? null : seal(key ??= keyFor(owner), envelope.id, nameOfField(field), item, owner)));
      return out;
    };
    for (const part of ['value', 'set', 'was']) if (sealed[part] !== undefined) sealed[part] = sealIn(sealed[part]);
    if (isObject(sealed.prior)) sealed.prior = { ...sealed.prior, value: sealIn(sealed.prior.value) };
    return sealed;
  };
  const erasures = erasureQueue(sql);
  // The key a record's entry keeps: its own key when it holds one (made by this write, or read with the record before),
  // or when a field of `value` is sealed under it; none once erased.
  let nextLogRow = null;
  const keyEntryOf = (id, value) => {
    const entry = erasing.entryOf(id, nextLogRow);
    if (entry || !isObject(value)) return entry;
    const own = [...Object.values(value), ...nestedErasable.map(path => fieldAt(value, path))].some(item => isSealed(item) && keyIdOf(id, item) === id);
    if (!own || !erasing.keyOf(id)) return null;
    return erasing.entryOf(id, nextLogRow);
  };
  // The records whose keys a value's sealed fields are sealed under, other than its own.
  const sealedOwners = (id, value) => {
    if (!isObject(value)) return [];
    const items = [...Object.values(value), ...nestedErasable.map(path => fieldAt(value, path))];
    return [...new Set(items.filter(isSealed).map(item => keyIdOf(id, item)).filter(owner => owner !== id))];
  };
  const plainField = item => item !== undefined && item !== null && !isSealed(item);
  // Takes an erasable field's words out of one record's envelopes in a row (its values, its changes and what it
  // replaced); answers whether anything changed. `fieldsOf(id)` names the fields to take out, or null for none.
  // The keys a retired index built from those words are added to `retired` when given.
  function scrubEnvelopes(envelopes, fieldsOf, retired = null) {
    let changed = false;
    for (const envelope of envelopes) {
      const fields = fieldsOf(envelope.id);
      if (!fields?.length) continue;
      for (const [owner, part] of [[envelope, 'value'], [envelope, 'set'], [envelope, 'was'], [envelope.prior, 'value']]) {
        const holder = owner?.[part];
        if (!isObject(holder)) continue;
        if (retired && part !== 'set') retired.push(...retiredKeysOf(envelope.type ?? typeOf(envelope.id), envelope.id, holder));
        const scrubbed = fields.reduce((out, field) => withField(out, field, item => (plainField(item) ? null : item)), holder);
        if (scrubbed !== holder) { owner[part] = scrubbed; changed = true; }
      }
    }
    return changed;
  }
  // Writes a row's envelopes again over the same rows (its parts), so the row keeps its place and its part count.
  function rewriteRow(table, rowids, envelopes) {
    const text = JSON.stringify(envelopes);
    const size = Math.ceil(text.length / rowids.length);
    rowids.forEach((rowid, part) => sql.exec(`UPDATE ${table} SET envelopes = ? WHERE rowid = ?`, text.slice(part * size, part === rowids.length - 1 ? text.length : (part + 1) * size), rowid));
  }
  // Versions of an erased record still in the key space's runs (a merge lets them go only later), [type, seq, value]:
  // rewritten in place, page by page, never by a merge of the store.
  function scrubPages(id, fields) {
    // The key's own entry goes from every run, as from the open entries (removeRecord).
    const dropped = keys.dropKey(keyHolderKey(id));
    if (!fields.length) return dropped;
    const retired = [];
    const pages = keys.rewriteKey(idKey(id), stored => {
      if (!Array.isArray(stored)) return undefined;
      // Every version of an erased record is written again without its key.
      if (!isObject(stored[2])) return stored[4] ? stored.slice(0, 4) : undefined;
      retired.push(...retiredKeysOf(stored[0], id, stored[2]));
      const value = fields.reduce((out, field) => withField(out, field, item => (plainField(item) ? null : item)), stored[2]);
      return value !== stored[2] || stored[4] ? [stored[0], stored[1], value, stored[3] ?? null] : undefined;
    });
    return dropped + pages + dropKeys(retired);
  }
  // The instant part of an erasure here: a record still holding a field as words is written once sealed (so the
  // removal's record of what it replaced holds no words), its key is deleted, it is removed, its versions in the key
  // space are rewritten, and the rows kept before are queued for the idle pass (scrubStep).
  function eraseHere(id, fields, write, context) {
    const type = typeOf(id);
    const found = kept(id);
    forgetKeyInLog(id);
    if (found && isObject(found.value)) dropKeys(retiredKeysOf(type, id, resolveRead(found.value, id)));
    if (found && isObject(found.value) && fields.some(field => plainField(fieldAt(resolveRead(found.value, id), field)))) write([{ id, type, value: openFields(id, resolveRead(found.value, id)) }], context);
    erasing.erase(id, fields);
    forgetOpened();
    if (type !== null) write([{ id, type, value: null }], context);
    const pages = scrubPages(id, fields);
    if (fields.length) erasures.queue(id, fields);
    return pages;
  }
  // One bounded step of the one pass over the log that serves every queued erasure: rows after the kept place, a page
  // at a time, each table of the log in turn (sealed generations first, the open log last, and any generation sealed
  // while the pass ran); a record joins the next pass after the one under way. Answers { rows, rewritten, more }.
  const SCRUB_PAGE = 500;
  function scrubStep({ hasTime = () => true, page = SCRUB_PAGE } = {}) {
    let pass = erasures.pass();
    if (!pass) {
      const waiting = erasures.waiting('rows');
      if (!waiting.length) return { rows: 0, rewritten: 0, more: false };
      pass = { ids: waiting, scanned: [], table: null, after: 0, rewritten: 0 };
    }
    const fieldsById = new Map(pass.ids.map(({ id, fields }) => [id, fields]));
    let rows = 0;
    while (hasTime()) {
      if (pass.table === null) {
        const next = [...sealedLogs(), LOG].find(table => !pass.scanned.includes(table));
        if (!next) {
          // A merge that finished while the pass ran may have written an erased record's key into a run of its own.
          for (const [id, fields] of fieldsById) scrubPages(id, fields);
          erasures.move([...fieldsById.keys()], history_archives ? 'archives' : 'done');
          erasures.keepPass(null);
          return { rows, rewritten: pass.rewritten, more: erasures.waiting('rows', 1).length > 0 };
        }
        pass.table = next;
        pass.after = 0;
      }
      if (!all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", pass.table).length) { pass.scanned.push(pass.table); pass.table = null; continue; }
      const found = all(`SELECT rowid AS at, part, parts, envelopes FROM ${pass.table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, pass.after, page);
      // A row split into parts is read whole: the page is extended to the row's last part.
      while (found.length && found.at(-1).part !== found.at(-1).parts - 1) {
        const more = all(`SELECT rowid AS at, part, parts, envelopes FROM ${pass.table} WHERE rowid > ? ORDER BY rowid LIMIT 1`, found.at(-1).at);
        if (!more.length) break;
        found.push(more[0]);
      }
      let pending = null;
      for (const row of found) {
        if (row.part === 0) pending = { rowids: [], texts: [] };
        if (!pending) continue;
        pending.rowids.push(row.at);
        pending.texts.push(row.envelopes);
        if (row.part !== row.parts - 1) continue;
        const text = pending.texts.join('');
        const { rowids } = pending;
        pending = null;
        if (![...fieldsById.keys()].some(id => text.includes(`"id":${JSON.stringify(id)}`))) continue;
        const envelopes = JSON.parse(text);
        const retired = [];
        if (scrubEnvelopes(envelopes, id => fieldsById.get(id) ?? null, retired)) { rewriteRow(pass.table, rowids, envelopes); pass.rewritten += 1; }
        dropKeys(retired);
      }
      rows += found.length;
      if (found.length < page) { pass.scanned.push(pass.table); pass.table = null; }
      else pass.after = found.at(-1).at;
      erasures.keepPass(pass);
    }
    erasures.keepPass(pass);
    return { rows, rewritten: pass.rewritten, more: true };
  }
  const scrubDue = () => erasures.pass() !== null || erasures.waiting('rows', 1).length > 0;
  const privacyDeclarations = (modelData.kinds ?? []).filter(kind => erasableOf(kind.type).length || erasureFieldsOf(kind.type).length || kind.erasable_key)
    .sort((a, b) => a.type.localeCompare(b.type));
  const erasureDeclaration = JSON.stringify(privacyDeclarations.map(kind => ({ type: kind.type,
    erasable: erasableOf(kind.type), erase_fields: eraseFieldsByType.get(kind.type) ?? [],
    erase_with: eraseWithByType.get(kind.type) ?? [], erasable_key: keyOwnerPaths.get(kind.type) ?? null })));
  const erasedKinds = [...(modelData.kinds ?? [])].sort((a, b) => b.type.length - a.type.length);
  const borrowedKinds = privacyDeclarations.filter(kind => keyOwnerPaths.has(kind.type));
  const erasureDeclarationPending = () => privacyDeclarations.length > 0 && keys.meta.get('erasure_declaration')?.signature !== erasureDeclaration;
  function advanceErasureDeclaration(write) {
    const saved = keys.meta.get('erasure_declaration');
    if (saved?.pending_signature === erasureDeclaration && saved.stage === 'borrowed') {
      const kind = borrowedKinds[saved.kind];
      if (!kind) { keys.meta.set('erasure_declaration', { signature: erasureDeclaration }); return; }
      const page = idsOfType(kind.type, { ...(saved.before ? { before: saved.before } : {}), limit: 64 });
      for (const id of page) {
        const found = kept(id);
        if (!found?.value) continue;
        const owner = keyIdFor(kind.type, id, found.value);
        if (owner === id || !erasing.erased(owner)) continue;
        const fields = erasureFieldsOf(kind.type);
        const value = fields.reduce((out, field) => withField(out, field, item => plainField(item) ? null : item), found.value);
        if (value !== found.value) write([{ id, type: kind.type, value }], { actor: { by: 'erasure-declaration' } });
        scrubPages(id, fields); erasures.queue(id, fields);
      }
      keys.meta.set('erasure_declaration', { pending_signature: erasureDeclaration, stage: 'borrowed',
        kind: page.length < 64 ? saved.kind + 1 : saved.kind,
        before: page.length < 64 ? null : page.at(-1) });
      return;
    }
    const after = saved?.pending_signature === erasureDeclaration ? saved.after : '';
    const page = erasing.erasedPage(after, 64);
    if (!page.length && !after) { keys.meta.set('erasure_declaration', { signature: erasureDeclaration }); return; }
    for (const { id, fields } of page) {
      // Old tombstones keep the original record namespace, even after its live
      // slot is gone. A known DATA namespace can qualify that historical kind;
      // unidentified records are not guessed or assigned a new identity.
      const type = typeOf(id) ?? erasedKinds.find(kind => id.startsWith(`${kind.type}:`))?.type;
      if (!type) continue;
      const broadened = erasing.broadenErasure(id, erasureFieldsOf(type));
      if (broadened) { scrubPages(id, broadened); erasures.queue(id, broadened); }
      // A new cascade may name a still-live derivative of an old erasure.
      // Follow only the model's actual identities/indexes, never all records.
      const waiting = erasedWith(id, type, null), visited = new Set([id]);
      while (waiting.length) {
        const next = waiting.shift();
        if (visited.has(next.id)) continue;
        visited.add(next.id);
        const nextType = typeOf(next.id) ?? next.type;
        if (!nextType || !erasureFieldsOf(nextType).length || !kept(next.id)?.value) continue;
        waiting.push(...erasedWith(next.id, nextType, kept(next.id).value));
        eraseHere(next.id, erasureFieldsOf(nextType), write, { actor: { by: 'erasure-declaration' } });
      }
    }
    keys.meta.set('erasure_declaration', page.length < 64 ? { pending_signature: erasureDeclaration, stage: 'borrowed', kind: 0, before: null }
      : { pending_signature: erasureDeclaration, after: page.at(-1).id });
  }
  const isShared = item => isObject(item) && typeof item[SHARED_MARK] === 'string';
  // A link to a shared object read as the object it names; anything else as itself.
  const follow = item => (isShared(item) ? kept(item[SHARED_MARK])?.value : item);
  // One participation key per thing a record of a kind with parts holds.
  function modelKeysOf(type, id, value) {
    const kind = kindOf(type);
    if (!kind?.parts?.length) return [];
    const parts = partsOf(kind, value, follow);
    return [...parts.map(part => holderKey(part.id, id, part.role, part.ordinal)), ...setsOf(parts, setHash).map(held => setKey(held.set, id, held.role))];
  }
  // The value kinds each property of a type has held: one key per type, property and value kind, put the first time
  // this store meets that kind there since it opened (a put of a key already held changes nothing), so a write of a
  // shape already met writes no key and nothing is read to find out. A shared object is seen as `shared` (its value is
  // never read to say what it is).
  const SEEN_KEPT = 50000;
  const seen = new Set();
  function noteSeen(type, value, fields = null) {
    if (!isObject(value)) return;
    for (const field of fields ?? Object.keys(value)) {
      const item = value[field];
      if (item === undefined) continue;
      const key = seenKey(type, field, isShared(item) ? 'shared' : isSealed(item) ? (kindOf(type)?.guard_properties?.[field] ?? kindOf(type)?.properties?.[field] ?? 'sealed') : valueKindOf(item));
      if (seen.has(key)) continue;
      if (seen.size >= SEEN_KEPT) seen.clear();
      seen.add(key);
      keys.put(key, 1);
    }
  }
  // The kinds records declare, read the first time a type that could be one is asked about after an open or a rebuild
  // (a store whose reads never touch such a type reads none of them); a declaring record written or replayed before
  // that declares its own kind as it is applied, and the load reads them all as they now stand. Declaring records are
  // few (a person's lists), so all of them are read.
  let declaredLoaded = false;
  const declaredPrefixes = model.declaredPrefixes();
  function ensureDeclared(type = null) {
    if (declaredLoaded || (type !== null && !declaredPrefixes.some(prefix => type.startsWith(prefix)))) return;
    declaredLoaded = true;
    loadDeclared();
  }
  const kindOf = type => { ensureDeclared(type); return model.kindOf(type); };
  const allKinds = () => { ensureDeclared(); return model.kinds(); };
  function loadDeclared() {
    model.clear();
    for (const type of model.declaringTypes()) {
      const prefix = typeKey(type, '');
      // Every declaring record's entry, then the values kept apart, each read for all of them together: read one at a
      // time, each of a person's lists cost a membership read of every run older than its own.
      const ids = keys.range(prefix, `t${SEP}${type}${AFTER}`, { keys_only: true }).map(([key]) => key.slice(prefix.length));
      const positions = keys.getMany(ids.map(idKey));
      const apart = keys.getMany(ids.flatMap(id => { const at = positions.get(idKey(id)); return at && at[0] === type && at.length < 3 ? [recordKey(at[0], at[1], id)] : []; }));
      for (const id of ids) {
        const at = positions.get(idKey(id));
        if (!at || at[0] !== type) continue;
        const value = at.length >= 3 ? at[2] : apart.get(recordKey(at[0], at[1], id));
        if (value !== undefined) model.declare(type, id, value);
      }
    }
  }
  // A selected record needs its declared kind, not the inventory of every kind,
  // observed property and index in this store. Resolve only matching declaring
  // records through the normal maintained field index. An unfinished old-data
  // build cannot prove which declaration wins; it stays explicitly incomplete.
  function readDeclaredKind(type, { participation = false, budget = { reads: 128, bytes: bounds.bytes } } = {}) {
    if (declaredLoaded) {
      // A write can change the winning declaration before a restart. The
      // authoritative in-memory owner must win over cold index ordering.
      const kind = model.kindOf(type, { resolved_only: participation });
      const issues = (kind?.unresolved_declarations ?? []).map(record => ({ record, code: 'linked_declaration_missing' }));
      return { kind, complete: issues.length === 0, issues };
    }
    const selected = recordModel(modelData);
    let complete = true;
    const owners = [], issues = [];
    const readDeclaration = id => {
      if (budget.reads <= 0 || budget.bytes <= 0) { complete = false; issues.push({ record: id, code: 'declaration_read_budget' }); return undefined; }
      budget.reads -= 1;
      const found = readRoot(id);
      if (found && found.size.bytes > budget.bytes) { budget.bytes = 0; complete = false; issues.push({ record: id, code: 'declaration_byte_budget' }); return undefined; }
      if (found) budget.bytes -= found.size.bytes;
      return found;
    };
    const rules = [...new Map((modelData.declared_by ?? []).map(rule => [rule.type, rule])).values()];
    for (const rule of rules) {
      const prefix = rule.kind.prefix ?? '';
      if (!type.startsWith(prefix)) continue;
      if (budget.reads <= 0 || budget.bytes <= 0) { complete = false; issues.push({ type: rule.type, code: 'declaration_read_budget' }); continue; }
      if (!indexReady(rule.type, '__model_declaration')) { complete = false; issues.push({ type: rule.type, code: 'declaration_index_incomplete' }); continue; }
      const name = type.slice(prefix.length);
      // loadDeclared applies declaring ids in ascending order; the last exact
      // declaration wins. A reverse point-range preserves that same ownership.
      const row = scan(rule.type, '__model_declaration', { equal: [name], reverse: true, limit: 1 })[0];
      if (!row) continue;
      const found = readDeclaration(row.id);
      if (found?.type !== rule.type || atPath(found.value, rule.kind.path) !== name) { complete = false; continue; }
      const declared = selected.declare(rule.type, row.id, found.value);
      owners.push({ id: row.id, type: rule.type, value: found.value, declared });
    }
    if (participation) {
      // A link's directly named declaring record determines the target row
      // prefix. One hop of exact identities is sufficient; loading a target's
      // own outgoing declarations would turn this back into an inventory walk.
      const targets = [...new Set(owners.flatMap(owner => (owner.declared?.parts ?? []).map(part => part.declaration).filter(Boolean)))];
      if (targets.length > 64) { complete = false; issues.push({ code: 'linked_declaration_limit', limit: 64 }); }
      for (const id of targets.slice(0, 64)) {
        if (owners.some(owner => owner.id === id)) continue;
        try {
          const found = readDeclaration(id);
          if (found === undefined) continue;
          if (!found || !selected.declares(found.type)) { complete = false; issues.push({ record: id, code: 'linked_declaration_missing' }); continue; }
          if (!selected.declare(found.type, id, found.value)) { complete = false; issues.push({ record: id, code: 'linked_declaration_invalid' }); }
        } catch (error) {
          complete = false;
          issues.push({ record: id, code: error?.code ?? 'linked_declaration_unavailable' });
        }
      }
      // An explicitly linked declaration may declare the same type as the
      // selected owner. Loading it must not change the index's winning owner.
      for (const owner of owners) selected.declare(owner.type, owner.id, owner.value);
    }
    return { kind: selected.kindOf(type, { resolved_only: participation }), complete, issues };
  }
  // Customer tables are an atomic SQL projection, alongside the packed read indexes. Machine kinds opt in only
  // through DATA. Schema changes restart a bounded retained-record walk; reads say when it is unfinished.
  const tableKind = type => {
    const kind = kindOf(type);
    if (!kind || (!kind.declared_by && kind.table !== true)) return null;
    return { ...kind, properties: Object.fromEntries(Object.entries(kind.properties).map(([field, shape]) => [field, model.valueKinds[shape] ?? shape])) };
  };
  // Every schema change of a table is itself a dated record of the log (`table-schema-change`), written in the
  // transaction that made it: a write that adds a field carries its column's change in its own log row (commit), and
  // the idle table build commits the changes it makes as one row of their own.
  const SCHEMA_CHANGE = 'table-schema-change';
  let schemaChanges = null;
  // A table made again (record-tables.mjs LAYOUT) is empty: its build starts over, so the log fills it again.
  let activeTableBuild = null;
  const typed = recordTables({ sql, kindOf: tableKind, onSchemaChange: change => {
    if (change.event === 'table_rebuilt') {
      keys.meta.remove(tableKey(change.kind));
      // A schema commit can ensure a sibling table during the same slice.
      // Its durable invalidation also invalidates every enclosing slice's
      // exact-signature check, including a synchronous reentrant backfill.
      for (let frame = activeTableBuild; frame; frame = frame.parent) frame.checked.delete(change.kind);
    }
    schemaChanges?.push(change);
  } });
  // A schema change is a record whose id is minted here (uuidv7), so it holds nothing yet: its envelope replaces nothing
  // and its apply reads nothing, where looking the new id up read every run (a write that changed 15 table schemas read
  // 1,600 rows that way, 2026-10-20). The prior state it is known to have is held as a write's are (priorHeld).
  const schemaChangeEnvelopes = changes => changes.map(change => {
    const id = `${SCHEMA_CHANGE}:${uuidv7()}`;
    (priorHeld ??= new Map()).set(id, { at: undefined, value: undefined });
    return envelopeFor(id, SCHEMA_CHANGE, change, new Map());
  }).filter(Boolean);
  // Changes made before they were written to the log (kept only in the table history) are copied into it once, in
  // bounded steps at idle: up to the history's last sequence when this store first opened with this rule, so a change
  // made since (already in the log) is never copied twice. Each step is one log row of changes made at one moment.
  const HISTORY_COPY = 'table_schema_history_copy';
  // The boundary is written with the first change logged directly (in that change's transaction, so a rollback takes
  // both back), as the history's last sequence before that change; a store that never changes a schema writes nothing.
  const markHistoryBoundary = made => {
    if (!made || keys.meta.get(HISTORY_COPY)) return;
    keys.meta.set(HISTORY_COPY, { through: typed.lastSequence() - made, after: 0 });
  };
  const historyCopyPending = () => {
    const state = keys.meta.get(HISTORY_COPY);
    return state ? state.after < state.through : typed.lastSequence() > 0;
  };
  function copySchemaHistory({ limit = 64 } = {}) {
    inStep();
    if (!keys.meta.get(HISTORY_COPY)) keys.meta.set(HISTORY_COPY, { through: typed.lastSequence(), after: 0 });
    const state = keys.meta.get(HISTORY_COPY);
    const rows = typed.schemaHistory({ after: state.after, limit }).filter(row => row.sequence <= state.through);
    if (!rows.length) { keys.meta.set(HISTORY_COPY, { ...state, after: state.through }); return { copied: 0 }; }
    const moment = rows.filter(row => row.changed_at === rows[0].changed_at);
    commit(schemaChangeEnvelopes(moment.map(row => ({ kind: row.kind, event: row.event, field: row.field, old_type: row.old_type, new_type: row.new_type, changed_at: row.changed_at }))),
      contextOf({ actor: { by: 'table-schema-history' }, application_time: moment[0].changed_at }));
    keys.meta.set(HISTORY_COPY, { ...state, after: moment[moment.length - 1].sequence });
    return { copied: moment.length };
  }
  const tableKey = type => `customer_table_build:${type}`;
  // A kind's table is built again from the log when its declaration or the tables' layout (record-tables.mjs LAYOUT) changes.
  const tableSignature = type => JSON.stringify({ ...tableKind(type), layout: typed.layout });
  // A kind this store never laid out a table for and holds no record of has nothing to build: the shared model answers
  // its schema and its rows, reads and index scans are empty (record-tables.mjs), until its first record lays its table
  // out in the write that keeps it (commit, typed.putMany). So a store never copies the model's kinds it does not use.
  // With the store's counts known this is answered from memory, before the build state is read, so admission stays
  // constant while declarations grow; without them one bounded id read answers it, after the build state.
  const unusedKind = type => !typed.kindLaidOut(type) && (counts !== null ? countOf(counts, type) === 0 : idsOfType(type, { limit: 1 }).length === 0);
  const tableComplete = (type, checked = null) => {
    if (counts !== null && unusedKind(type)) return true;
    const signature = tableSignature(type);
    const prior = checked?.get(type);
    if (prior?.signature === signature) return prior.complete;
    const state = keys.meta.get(tableKey(type));
    const complete = (!!state?.done && state.signature === signature) || (counts === null && unusedKind(type));
    checked?.set(type, { signature, complete });
    return complete;
  };
  // Admission needs only the first unfinished table. Later kinds are checked when that table finishes.
  const nextPendingTable = (checked = null) => allKinds().find(kind => (kind.declared_by || kind.table === true) && !tableComplete(kind.type, checked));
  function buildTables({ limit = 64, hasTime = () => true } = {}) {
    inStep();
    // One call walks up to `limit` records, going on to the next kind when one finishes (a laid-out kind with no records
    // costs only its schema; a kind never laid out and never written is not pending at all, unusedKind), so a store's
    // empty table kinds never take a call each.
    // This synchronous slice owns every table cursor it advances. Reuse only
    // exact-signature status checks inside the slice: completed empty kinds
    // must not make every later kind reread every earlier SQL cursor. A changed
    // declaration gets a fresh check; no result survives return or rollback.
    const checked = new Map();
    const parent = activeTableBuild;
    activeTableBuild = { checked, parent };
    try {
      let walked = 0, type = null;
      while (walked < limit) {
        const kind = nextPendingTable(checked);
        if (!kind || !hasTime()) break;
        type = kind.type;
        const signature = tableSignature(type);
        let state = keys.meta.get(tableKey(type));
        if (state?.signature !== signature) state = { signature, before: null, done: false };
        schemaChanges = [];
        try { typed.ensure(type); } finally {
          const changes = schemaChanges;
          schemaChanges = null;
          markHistoryBoundary(changes.length);
          if (changes.length) commit(schemaChangeEnvelopes(changes), contextOf({ actor: { by: 'table-schema' } }));
        }
        if (state.before !== null && !keys.meta.get(tableKey(type))) state = { signature, before: null, done: false };
        const room = limit - walked;
        const ids = idsOfType(type, { ...(state.before ? { before: state.before } : {}), limit: room + 1 });
        let here = 0;
        for (const id of ids.slice(0, room)) {
          if (!hasTime()) break;
          const found = kept(id);
          if (found?.type === type) typed.put({ id, type, value: resolveRead(found.value, id) }, { actor: { by: 'table-backfill' }, validate: false });
          state.before = id;
          here += 1;
        }
        walked += here;
        state.done = here === ids.length;
        keys.meta.set(tableKey(type), state);
        checked.set(type, { signature, complete: state.done });
        if (!state.done) break;
      }
      return { type, walked, more: !!nextPendingTable(checked) };
    } finally { activeTableBuild = parent; }
  }
  // Where the walk of records kept before the model stands: { parts: { type: the parts signature its records were last
  // walked under }, walking: { type, after, signature } | null, seen_after, seen_walked }. The kinds with parts are
  // walked first, each over its own type list (a few thousand records where the store holds millions), so what holds a
  // thing is known soon after a deploy; then every record once for the value kinds its properties hold. Held in memory
  // once read (a rollback rereads it).
  let modelBuild;
  const modelState = () => (modelBuild ??= keys.meta.get(MODEL_BUILD) ?? null);
  const kindsToWalk = state => allKinds().filter(kind => model.signatureOf(kind.type) !== (state.parts[kind.type] ?? '[]'));
  const partsPending = () => { const state = modelState(); return !state || state.walking !== null || kindsToWalk(state).length > 0; };
  // A relationship read never opens every declaring record to answer a status
  // question. A cold declaration cache is unknown until the ordinary owner or
  // maintainer has loaded it; it is not evidence that the parts index is ready.
  const partsPendingForRead = () => !declaredLoaded && model.declaringTypes().length > 0 || partsPending();
  const modelPending = () => partsPending() || !modelState().seen_walked;
  // A live write's changed fields against the kind its type declares: refused before anything is kept or logged.
  function checkModel(id, type, value, against = model) {
    const kind = against === model ? kindOf(type) : against.kindOf(type);
    // A strict model (the deploy's guard tests) refuses a shape it does not declare; with a file named, each is noted
    // there instead, so one run finds every shape a change leaves undeclared.
    if (strict_model) {
      const undeclared = undeclaredOf(kind, value);
      if (undeclared) {
        const file = typeof process !== 'undefined' ? process.env?.RECORD_MODEL_UNDECLARED_FILE : null;
        if (!file) throw new ModelUndeclared(id, type, undeclared);
        const fields = undeclared.property === null ? [null]
          : Object.keys(value).filter(field => value[field] !== undefined && kind.properties[field] === undefined && kind.guard_properties?.[field] === undefined);
        process.getBuiltinModule('fs').appendFileSync(file, fields.map(property => `${JSON.stringify({ type, property, value_kind: property === null ? null : valueKindOf(value[property]), id })}\n`).join(''));
      }
    }
    // A strict model holds a kind's guard properties to their value kinds too; a live store only its own properties.
    const held = kind && strict_model && Object.keys(kind.guard_properties ?? {}).length ? { ...kind, properties: { ...kind.guard_properties, ...kind.properties } } : kind;
    if (!held || !isObject(value) || !Object.keys(held.properties).length) return;
    const before = kept(id);
    const changed = {};
    for (const [field, item] of Object.entries(value)) {
      if (held.properties[field] === undefined) continue;
      if (before && before.type === type && JSON.stringify(before.value[field]) === JSON.stringify(item)) continue;
      changed[field] = item;
    }
    const refused = refusalOf(held, against.valueKinds, changed);
    if (refused) throw new ModelRefused(id, type, refused);
  }

  // Preflight sees the declarations the whole write will leave in place. Fork the already-loaded model only when a
  // declaring record changes, so a failed write cannot leak a kind and a row may precede its declaration.
  function modelForWrite(entries) {
    if (!model.declaringTypes().length) return model;
    // writing() already synchronized this projection inside the same transaction before building these envelopes.
    const changesDeclaration = entries.some(({ record, envelope }) => envelope &&
      (model.declares(record.type) || model.declares(typeOf(record.id))));
    if (!changesDeclaration) return model;

    ensureDeclared();
    const effective = model.fork();
    // Each envelope was built against the pre-write projection, but envelopes are applied in order. In particular,
    // two partial updates to one declaring record each carry only their own delta; overlay those deltas in order so
    // the fork sees the same final declaration that applyEnvelope will leave behind. Keep logical values here because
    // storedForm/shareEnvelope can replace nested declaration data with shared-object links.
    const virtual = new Map();
    const stateFor = id => {
      if (!virtual.has(id)) {
        const held = kept(id);
        virtual.set(id, held && held.type !== null
          ? { type: held.type, value: resolveRead(held.value, id) }
          : null);
      }
      return virtual.get(id);
    };
    for (const { record: { id, type, value }, envelope } of entries) {
      if (!envelope) continue;
      const before = stateFor(id);
      effective.forget(id);
      if (envelope.remove || envelope.purge || value === null) {
        virtual.set(id, null);
        continue;
      }
      const finalType = envelope.type ?? before?.type ?? type ?? typeOf(id);
      let finalValue;
      if (envelope.value !== undefined) {
        finalValue = value;
      } else {
        finalValue = { ...(before?.value ?? {}) };
        for (const field of envelope.unset ?? []) delete finalValue[field];
        for (const field of Object.keys(envelope.set ?? {})) {
          if (value && Object.hasOwn(value, field)) finalValue[field] = value[field];
          else delete finalValue[field];
        }
      }
      virtual.set(id, { type: finalType, value: finalValue });
      if (finalValue !== null && finalValue !== undefined && effective.declares(finalType)) effective.declare(finalType, id, finalValue);
    }
    return effective;
  }

  // ---- the projection's position in the log ----------------------------------------------------------------------
  // applied: the rowid of the last log row in the projection (memtable + runs), in the open log table.
  let applied = 0;
  // The log rows after the position the written pages cover: what a start reads again (replay), counted as they are
  // replayed and appended, and none once the memtable is written out.
  let tailRows = 0;
  const logEnd = () => all(`SELECT max(rowid) AS n FROM ${LOG}`)[0]?.n ?? 0;
  const coveredAtOpen = () => { const kept = keys.covered(); return (typeof kept === 'object' && kept !== null ? kept.at : kept) ?? 0; };
  // How far the log the pages hold: kept with each write-out as a position, or as { at, sums } when the checksum is
  // known, so the checksum rides in the row the write-out writes anyway (invariant 10).

  // ---- shared objects ---------------------------------------------------------------------------------------------
  const sharedCache = new Map();
  let sharedCacheBytes = 0;
  const forgetShared = id => {
    const held = sharedCache.get(id);
    if (!held) return;
    sharedCacheBytes -= held.bytes;
    sharedCache.delete(id);
  };
  function sharedValueSize(value, maxBytes = Infinity) {
    let rows = 0;
    let bytes = 0;
    const seen = new Set();
    const pending = [value];
    while (pending.length && bytes <= maxBytes) {
      const item = pending.pop();
      rows += 1;
      if (typeof item === 'string') { bytes += 16 + item.length * 2; continue; }
      if (item === null || typeof item !== 'object') { bytes += 16; continue; }
      if (seen.has(item)) continue;
      seen.add(item);
      if (Array.isArray(item)) {
        bytes += 32 + item.length * 8;
        if (bytes > maxBytes) break;
        for (const child of item) pending.push(child);
      } else {
        bytes += 64;
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          bytes += 16 + key.length * 2;
          pending.push(item[key]);
        }
      }
    }
    return { rows, bytes };
  }
  function keepShared(id, value, size) {
    forgetShared(id);
    if (size.bytes > shared_cache_bytes) return false;
    while (sharedCache.size >= SHARED_KEPT || sharedCacheBytes + size.bytes > shared_cache_bytes) forgetShared(sharedCache.keys().next().value);
    sharedCache.set(id, { value, bytes: size.bytes, rows: size.rows });
    sharedCacheBytes += size.bytes;
    return true;
  }
  function chargeExpansion(rootId, addedRows, addedBytes, expansion) {
    const bytes = expansion.bytes + addedBytes;
    const rows = expansion.rows + addedRows;
    if (bytes > shared_expansion_bytes) throw new RecordTooLarge(rootId, { rows, bytes });
    expansion.bytes = bytes;
    expansion.rows = rows;
  }
  const opening = new Set();

  // A record as kept: { type, seq, value, size } with shared objects as links, or null. Held in its slot once read or
  // written; the object is the store's own and is never changed in place (a write makes a new one).
  function kept(id) {
    const slot = slots.find(id);
    if (slot >= 0) return slots.value(slot);
    if (priorHeld?.has(id)) {
      const { at, value } = priorHeld.get(id);
      primeKey(id, at);
      if (!at || at[0] === null || value === undefined) return null;
      return resident(id, at[0], at[1], value, at.length >= 3, null, at[3] ?? null);
    }
    return keptAt(id, keptPosition(id));
  }
  // The record an id-key entry names, read and made resident, or null for none or a removal.
  function keptAt(id, at) {
    if (!at || at[0] === null) return null;
    let value;
    try { value = at.length >= 3 ? at[2] : keys.get(recordKey(at[0], at[1], id)); }
    catch (error) {
      if (error.code !== 'record_too_large' || !sharedFieldTypes.has(at[0]) || !shareStoredFields(id)) throw error;
      return kept(id);
    }
    return value === undefined ? null : resident(id, at[0], at[1], value, at.length >= 3, null, at[3] ?? null);
  }
  // Only while one bounded group of changes is applied (a replay's batch of log envelopes, or one write's records): the
  // prior id-key entries and values of the ids it names, read together from the runs (priorStatesOf). Each id is
  // consumed once; later changes in the same group read the value just written to the memtable or resident slots.
  let priorHeld = null;
  // The prior state of each of `ids` as the runs keep it, read for all of them together: id -> { at, value }, at its
  // id-key entry (or undefined), value its record (or undefined). A key read one at a time costs a membership read of
  // every run it may be in; a write of 75 new rows over 50 runs read about 20,000 rows that way (2026-10-20).
  const exactKey = key => ({ lo: key, hi: `${key}\u0000` });
  function priorStatesOf(selected, value_budget) {
    const positions = new Map(keys.ranges(selected.map(id => exactKey(idKey(id))), { value_budget }));
    const pointerKeys = selected.flatMap(id => {
      const at = positions.get(idKey(id));
      primeKey(id, at);
      return at && at[0] !== null && at.length < 3 ? [recordKey(at[0], at[1], id)] : [];
    });
    const pointers = new Map(keys.ranges(pointerKeys.map(exactKey), { value_budget }));
    return new Map(selected.map(id => {
      const at = positions.get(idKey(id));
      primeKey(id, at);
      return [id, { at, value: at && at[0] !== null ? at.length >= 3 ? at[2] : pointers.get(recordKey(at[0], at[1], id)) : undefined }];
    }));
  }
  // A record as kept, or what a removed one left (its stamps: { type: null, value: null, meta }), or null.
  function keptOrRemoved(id) {
    if (priorHeld?.has(id)) {
      const { at, value } = priorHeld.get(id);
      primeKey(id, at);
      priorHeld.delete(id);
      const slot = slots.find(id);
      if (slot >= 0) return slots.value(slot);
      if (!at) return null;
      if (at[0] === null) return { type: null, value: null, meta: at[3] };
      return value === undefined ? null : resident(id, at[0], at[1], value, at.length >= 3, null, at[3] ?? null);
    }
    const slot = slots.find(id);
    if (slot >= 0) return slots.value(slot);
    const at = keptPosition(id);
    return at && at[0] === null ? { type: null, value: null, meta: at[3] } : keptAt(id, at);
  }
  // Makes one record resident, its size counted once.
  function resident(id, type, seq, value, inline = true, counted = null, meta = null) {
    const size = counted ?? sizeOfValue(value);
    const found = { type, seq, value, size, inline, meta };
    slots.set(id, type, found, null, 64 + size.rows * 48 + size.bytes * 2);
    return found;
  }
  function resolve(value, expansion, rootId) {
    if (Array.isArray(value)) {
      chargeExpansion(rootId, 1, 32 + value.length * 8, expansion);
      return value.map(item => resolve(item, expansion, rootId));
    }
    if (!isObject(value)) {
      chargeExpansion(rootId, 1, typeof value === 'string' ? 16 + value.length * 2 : 16, expansion);
      return value;
    }
    if (typeof value[SHARED_MARK] === 'string') return readShared(value[SHARED_MARK], expansion, rootId);
    let shell = 64;
    for (const field in value) if (Object.hasOwn(value, field)) shell += 16 + field.length * 2;
    chargeExpansion(rootId, 1, shell, expansion);
    const out = {};
    for (const field in value) {
      if (!Object.hasOwn(value, field)) continue;
      const resolved = resolve(value[field], expansion, rootId);
      // JSON keys are data, including the legacy prototype setter name.
      if (field === '__proto__') Object.defineProperty(out, field, { value: resolved, enumerable: true, writable: true, configurable: true });
      else out[field] = resolved;
    }
    return out;
  }
  function readShared(id, expansion, rootId) {
    let held = sharedCache.get(id);
    if (held) {
      sharedCache.delete(id);
      sharedCache.set(id, held);
      chargeExpansion(rootId, held.rows, held.bytes, expansion);
      return held.value === null ? null : structuredClone(held.value);
    }
    if (opening.has(id)) throw new Error(`Record ${id} contains itself.`);
    opening.add(id);
    const priorExpansion = activeExpansion;
    try {
      // A packed shared value must fit in the caller's remaining allowance before JSON.parse allocates it. Keep the
      // same context while resolving its links, then charge the completed shared graph once for this returned copy.
      activeExpansion = expansion;
      const found = kept(id);
      activeExpansion = priorExpansion;
      const cacheBuild = { rows: 0, bytes: 0, rootId };
      const value = found ? resolve(found.value, cacheBuild, rootId) : null;
      const size = value === null ? { rows: 0, bytes: 0 } : sharedValueSize(value);
      const retained = keepShared(id, value, size);
      // Cache warmth must not change admission: misses assemble a cache value under a separate bounded allowance,
      // while the caller's expansion is charged exactly as a cache hit would be.
      chargeExpansion(rootId, size.rows, size.bytes, expansion);
      // A miss already resolved a new graph. Only a retained cache graph needs a second independent copy.
      return value === null ? null : retained ? structuredClone(value) : value;
    } finally { activeExpansion = priorExpansion; opening.delete(id); }
  }
  const resolveRead = (value, rootId = '(resolved value)') => {
    const expansion = { rows: 0, bytes: 0, rootId };
    const previous = activeExpansion;
    activeExpansion = expansion;
    try { return resolve(value, expansion, rootId); }
    finally { activeExpansion = previous; }
  };
  // The value as kept: every nested object the host marks content-addressed becomes a link, and the objects to keep
  // once are named in `shared` (id -> { type, value }).
  function storedForm(type, value, shared) {
    const walk = (typeName, object) => {
      const out = {};
      for (const field in object) {
        if (!Object.hasOwn(object, field)) continue;
        const item = object[field];
        if (item === undefined) continue;
        if (isObject(item)) {
          const childType = `${typeName}/${field}`;
          const sharedId = contentId?.(childType, item);
          if (sharedId) {
            shared.set(sharedId, { type: childType, value: walk(childType, item) });
            out[field] = { [SHARED_MARK]: sharedId };
          } else out[field] = walk(childType, item);
        } else if (isListOfObjects(item)) {
          out[field] = item.map(member => walk(`${typeName}/${field}`, member));
        } else out[field] = Array.isArray(item) ? structuredClone(item) : item;
      }
      return out;
    };
    return walk(type, value);
  }

  // What one record holds, counted the way a decomposed store would hold it (entities, values, links, list members),
  // so bounds mean the same thing they always did.
  function sizeOfValue(value, top = true) {
    let rows = 1;
    let bytes = 0;
    const byField = top ? new Map() : null;
    // Nested sizing only contributes counters. Keep one accumulator rather than
    // allocating entry pairs and recursive result/diagnostic objects per word.
    function countItem(item) {
      if (isObject(item)) {
        if (typeof item[SHARED_MARK] === 'string') rows += 1;
        else { rows += 2; countFields(item); }
      } else if (isListOfObjects(item)) {
        rows += 2;
        for (const member of item) { rows += 2; countFields(member); }
      } else if (item !== undefined) { rows += 1; bytes += JSON.stringify(item).length; }
    }
    function countFields(object) {
      for (const field in object) {
        if (Object.hasOwn(object, field)) countItem(object[field]);
      }
    }
    if (byField) {
      for (const field in value) {
        if (!Object.hasOwn(value, field)) continue;
        const beforeRows = rows;
        const beforeBytes = bytes;
        countItem(value[field]);
        byField.set(field, { field, values_held: rows - beforeRows, bytes: bytes - beforeBytes });
      }
    } else countFields(value);
    return { rows, bytes, byField };
  }
  function withinBounds(id, value, counted = null) {
    const size = counted ?? sizeOfValue(value);
    if (size.rows <= bounds.rows && size.bytes <= bounds.bytes) return;
    throw new RecordTooLarge(id, { rows: size.rows, bytes: size.bytes, by_field: [...size.byField.values()].sort((a, b) => b.values_held - a.values_held).slice(0, 20) });
  }

  // ---- index entries ----------------------------------------------------------------------------------------------
  // The value at a path, following content-addressed links; undefined when the path leads nowhere or to an object.
  function atPath(value, path) {
    let at = value;
    for (const field of path) {
      if (isObject(at) && typeof at[SHARED_MARK] === 'string') at = kept(at[SHARED_MARK])?.value;
      if (!isObject(at)) return undefined;
      at = at[field];
    }
    if (isObject(at) || isListOfObjects(at)) return undefined;
    return at;
  }
  // An index may carry fields beside its keys (`carry`: paths): its entry's value holds them as the record keeps them,
  // an erasable field sealed under the record's key (one held as words, kept before it was erasable, is sealed as it is
  // carried), so a read of the index answers them without reading the record while no key ever holds them. Without
  // `carry` an entry's value is 1.
  // A scalar carried projection proves both omitted fields and nested path existence.
  // Intermediate shared values are opened only through the same kept owner as
  // projectOf; final objects are never expanded or copied into this projection.
  const carriedSchema = index => JSON.stringify([index.carry, index.carry_presence]);
  function carriedPath(value, path, id) {
    let at = value;
    const opened = new Set();
    for (const field of path) {
      while (isObject(at) && typeof at[SHARED_MARK] === 'string') {
        const shared = at[SHARED_MARK];
        if (opened.has(shared)) throw new Error(`Record ${id} contains itself.`);
        opened.add(shared);
        at = kept(shared)?.value;
      }
      if (at === null || at === undefined) return undefined;
      at = at[field];
    }
    return at;
  }
  function carriedOf(type, id, index, value) {
    if (!index.carry?.length) return 1;
    const attested = index.carry_presence !== undefined;
    const own = index.carry.map(path => attested ? carriedPath(value, path, id) : fieldAt(value, path));
    const scalar = item => item === null || item === undefined || ['string', 'number', 'boolean'].includes(typeof item);
    const admitted = (item, at) => scalar(item) || (isSealed(item) && scalar(openField(id, nameOfField(index.carry[at]), item)));
    if (attested && !own.every(admitted))
      return { carry: [], carry_schema: null }; // Replace any earlier scalar attestation on the same key.
    const erasable = erasableOf(type);
    const carried = { carry: own.map((item, at) => {
      const path = index.carry[at];
      item ??= null;
      const field = erasable.find(one => JSON.stringify(pathOf(one)) === JSON.stringify(path));
      if (field === undefined || !plainField(item)) return item;
      const owner = keyIdFor(type, id, value);
      const key = keyFor(owner);
      return key ? seal(key, id, nameOfField(field), item, owner) : null;
    }) };
    if (attested && own.every(admitted)) {
      carried.carry_schema = carriedSchema(index);
      carried.carry_epoch = carriedEpoch;
      carried.defined = own.map(item => item !== undefined);
      carried.presence = index.carry_presence.map(path => carriedPath(value, path, id) !== undefined);
    }
    return carried;
  }
  // [key, entry value] for each index the record holds an entry in.
  function indexEntriesOf(type, id, value, list = declared.get(type) ?? []) {
    return indexKeysOf(type, id, value, list, true);
  }
  function indexKeysOf(type, id, value, list = declared.get(type) ?? [], entries = false) {
    const out = [];
    for (const index of list) {
      if (index.where?.some(rule => { const found = atPath(value, rule.path); return found === undefined || rule.not.some(excluded => JSON.stringify(excluded) === JSON.stringify(found)); })) continue;
      const parts = [];
      for (const path of index.paths) {
        const found = atPath(value, path);
        if (found === undefined) break;
        parts.push(JSON.stringify(found));
      }
      if (parts.length !== index.paths.length) continue;
      const key = `${indexPrefix(type, index.name)}${parts.join(SEP)}${SEP}${id}`;
      out.push(entries ? [key, carriedOf(type, id, index, value)] : key);
    }
    return out;
  }

  // ---- applying envelopes -----------------------------------------------------------------------------------------
  // The checksum of what the store holds (null until it is known: a store whose pages were written before it was kept
  // builds it a page of records at a time, keeps it from the next write-out on, and answers no checksum meanwhile).
  let sums = null;
  let counts = null;
  // That build while it goes on: { after: the last id walked, at: the log row it was kept at, sums: of every record up
  // to `after` }, kept beside the pages after each page so a restart goes on from there. A write to a record already
  // walked moves it as it moves `sums`; a log row replayed at open that the kept build already holds (at or before
  // `at`) does not move it again.
  let building = null;
  let replaying = null;
  const sumsFor = id => sums ?? (building && building.after !== null && id <= building.after && (replaying === null || replaying > building.at) ? building.sums : null);
  const countsFor = id => counts ?? (building && building.after !== null && id <= building.after && (replaying === null || replaying > building.at) ? building.counts : null);
  const countOf = (held, type) => Object.hasOwn(held, type) ? held[type] : 0;
  function changeCount(id, before, after) {
    if (before === after) return;
    const held = countsFor(id);
    if (!held) return;
    if (before !== null) held[before] = countOf(held, before) - 1;
    if (after !== null) held[after] = countOf(held, after) + 1;
  }
  // A record's stamps are kept beside its value (record-stamps.mjs); `removed` is what a removal left here before.
  const stampsSize = meta => (meta ? 24 + Object.keys(meta.s ?? {}).length * 32 + Object.keys(meta.d ?? {}).length * 32 : 0);
  const obsoleteRecordBytes = (id, before) => before ? 32 + idKey(id).length * 2
    + 2 * (before.size.bytes + before.size.rows * 12 + before.type.length + before.seq.length + 8 + stampsSize(before.meta)) : 0;
  const obsoleteIndexChars = (key, chars) => 32 + key.length * 2 + chars * 2;
  const obsoleteIndexBytes = (key, entry = 1) => obsoleteIndexChars(key, JSON.stringify(entry).length);
  function setRecord(id, type, seq, value, before, fields = null, meta = null, removed = null) {
    copiedOwnerPages = null;
    forgetMemberProjections(id);
    forgetSelections(type);
    if (before && before.type !== type) forgetSelections(before.type);
    changeCount(id, before?.type ?? null, type);
    const moved = sumsFor(id);
    if (moved) {
      if (before && before.type === type) moved.change(id, before.value, value, fields);
      else { if (before) moved.remove(id, before.type, before.value); moved.add(id, type, value); }
      moved.stamps(id, before ? before.meta : removed, meta);
    }
    if (before && (before.type !== type || before.seq !== seq)) {
      const oldKey = recordKey(before.type, before.seq, id);
      keys.remove(oldKey, obsoleteIndexBytes(oldKey));
      if (before.type !== type) { const oldTypeKey = typeKey(before.type, id); keys.remove(oldTypeKey, obsoleteIndexBytes(oldTypeKey)); }
    }
    if (!before || before.type !== type || before.seq !== seq || !before.inline) keys.put(recordKey(type, seq, id), 1);
    const size = sizeOfValue(value);
    const keyEntry = keyEntryOf(id, value);
    keys.put(idKey(id), keyEntry ? [type, seq, value, meta ?? null, keyEntry] : meta ? [type, seq, value, meta] : [type, seq, value], size.bytes + size.rows * 12 + type.length + seq.length + 8 + stampsSize(meta) + (keyEntry ? 64 : 0), obsoleteRecordBytes(id, before));
    keepDirectoryHead(id, Boolean(before || removed));
    if (keyEntry) keys.put(keyHolderKey(id), keyEntry, 64);
    if (!before || before.type !== type) { keys.put(typeKey(type, id), 1); keys.put(typesKey(type), 1); }
    const hadEntries = before ? indexEntriesOf(before.type, id, before.value) : [];
    const hadEntryOf = new Map(hadEntries);
    const had = new Set(before ? [...hadEntries.map(([key]) => key), ...modelKeysOf(before.type, id, before.value)] : []);
    if (model.declares(type)) model.declare(type, id, value);
    else if (before && model.declares(before.type)) model.forget(id);
    const nowEntries = indexEntriesOf(type, id, value);
    const now = new Set([...nowEntries.map(([key]) => key), ...modelKeysOf(type, id, value)]);
    for (const key of had) if (!now.has(key)) keys.remove(key, obsoleteIndexBytes(key, hadEntryOf.get(key) ?? 1));
    // An entry carrying fields is put again when what it carries changed, its key the same.
    const carriedBefore = new Map(hadEntries.filter(([, entry]) => entry !== 1).map(([key, entry]) => [key, JSON.stringify(entry)]));
    const entryOf = new Map(nowEntries);
    for (const key of now) {
      const entry = entryOf.get(key) ?? 1;
      if (!had.has(key) || (entry !== 1 && carriedBefore.get(key) !== JSON.stringify(entry))) {
        keys.put(key, entry, undefined, had.has(key) ? obsoleteIndexBytes(key, hadEntryOf.get(key) ?? 1) : 0);
      }
    }
    noteSeen(type, value, before && before.type === type ? fields : null);
    resident(id, type, seq, value, true, size, meta);
  }
  // Removes a record; with stamps (`meta`) what it leaves is kept, so a change made before the removal never brings
  // it back on a copy that hears of the removal later (record-stamps.mjs).
  function removeRecord(id, before, meta = null) {
    copiedOwnerPages = null;
    forgetMemberProjections(id);
    forgetSelections(before.type);
    changeCount(id, before.type, null);
    const moved = sumsFor(id);
    if (moved) { moved.remove(id, before.type, before.value); moved.stamps(id, before.meta, meta); }
    const oldKey = recordKey(before.type, before.seq, id), oldTypeKey = typeKey(before.type, id);
    keys.remove(oldKey, obsoleteIndexBytes(oldKey));
    // A record removed but not erased keeps its key, so its history still opens; an erased one keeps none.
    const keyEntry = keyEntryOf(id, null);
    if (meta || keyEntry) keys.put(idKey(id), keyEntry ? [null, null, null, meta ?? null, keyEntry] : [null, null, null, meta], 48 + stampsSize(meta) + (keyEntry ? 64 : 0), obsoleteRecordBytes(id, before)); else keys.remove(idKey(id), obsoleteRecordBytes(id, before));
    if (meta || keyEntry) keepDirectoryHead(id, true); else dropDirectoryHead(id);
    if (!keyEntry && (holdsKeys(before.type) || erasing.erasedHere(id))) keys.remove(keyHolderKey(id), 64);
    keys.remove(oldTypeKey, obsoleteIndexBytes(oldTypeKey));
    const oldEntries = new Map(indexEntriesOf(before.type, id, before.value));
    for (const key of [...oldEntries.keys(), ...modelKeysOf(before.type, id, before.value)]) {
      keys.remove(key, obsoleteIndexBytes(key, oldEntries.get(key) ?? 1));
    }
    if (model.declares(before.type)) model.forget(id);
    slots.drop(id);
  }
  // What an envelope replaces, written into it as it is committed (invariant 9).
  function annotate(envelope, before) {
    if (envelope.remove || envelope.purge || envelope.value !== undefined) { envelope.prior = before ? { type: before.type, value: before.value } : null; return; }
    const was = {};
    const added = [];
    for (const field of [...Object.keys(envelope.set ?? {}), ...(envelope.unset ?? [])]) {
      if (before?.value[field] !== undefined) was[field] = before.value[field]; else if (!(envelope.unset ?? []).includes(field)) added.push(field);
    }
    envelope.was = was;
    if (added.length) envelope.added = added;
  }
  // One envelope: { id, type, value } (whole), { id, type, set, unset } (its top-level fields changed), { id, remove },
  // or { id, purge } (nothing kept for it, not even a removal: what a copy does when the copy it settles with holds none).
  // `exact` on a whole value or removal makes the record that state instead of merging it with what is held.
  // A live envelope (being committed now) is first given what it replaces.
  // `seq` is the envelope's place (its row and position, or the place applyChanges gave it): the record's order among
  // records when it is new, and the stamp of a change made here, moved after what the record holds (stampAfter) and
  // written into the envelope when moved. An envelope from another copy names its own stamps (`at`).
  function applyEnvelope(envelope, seq, live = false) {
    copiedOwnerPages = null;
    Object.assign(envelope, shareEnvelope(envelope));
    const held = keptOrRemoved(envelope.id);
    const before = held && held.type !== null ? held : null;
    if (live) { annotate(envelope, before); noteMutationBefore(envelope.id, before); }
    forgetShared(envelope.id);
    // { id, purge }: the copy this one settles with holds nothing for the id, not even a removal, so nothing is kept.
    if (envelope.purge) {
      if (before) removeRecord(envelope.id, before);
      else if (held) { keys.remove(idKey(envelope.id)); dropDirectoryHead(envelope.id); sumsFor(envelope.id)?.stamps(envelope.id, held.meta, null); }
      return;
    }
    let stamp = envelope.at;
    if (stamp === undefined) {
      stamp = stampAfter(seq, held?.meta?.at);
      if (live && stamp !== seq) envelope.at = stamp;
    }
    // A whole value or removal stamped after everything held (every write made here, and most that cross) replaces
    // it: its state is the value with one stamp, so no merge is worked out. Anything else is merged field by field;
    // { exact } makes the record the state the envelope carries, whatever this copy held (a copy taking its leader's).
    const replaces = !envelope.exact && (envelope.remove || envelope.value !== undefined) && envelope.stamps === undefined && envelope.removed === undefined
      && envelope.floor_kind === undefined && (envelope.floor === undefined || envelope.floor === stamp) && !(held?.meta && held.meta.at >= stamp);
    const after = replaces
      ? (envelope.remove ? { type: null, value: null, meta: { at: stamp, k: 'removed' } } : { type: envelope.type, value: envelope.value, meta: { at: stamp } })
      : keptFrom(envelope.exact ? stateFrom(envelope, stamp) : merge(stateOf(held), stateFrom(envelope, stamp), tieByContent));
    if (!after) return;
    if (after.type === null) {
      if (before) removeRecord(envelope.id, before, after.meta);
      else { keys.put(idKey(envelope.id), [null, null, null, after.meta], 48 + stampsSize(after.meta)); keepDirectoryHead(envelope.id, Boolean(held)); sumsFor(envelope.id)?.stamps(envelope.id, held?.meta ?? null, after.meta); }
      return;
    }
    // Only the fields a field change names are hashed again; a whole value or a floor (fields let go) hashes all.
    const fields = envelope.value === undefined && !envelope.remove && envelope.floor === undefined && before && before.type === after.type ? [...Object.keys(envelope.set ?? {}), ...(envelope.unset ?? [])] : null;
    setRecord(envelope.id, after.type, before && before.type === after.type ? before.seq : seq, after.value, before, fields, after.meta, held && held.type === null ? held.meta : null);
  }
  function applyRow(row, envelopes, live = false) {
    envelopes.forEach((envelope, index) => applyEnvelope(envelope, envelope.seq ?? seqFrom(row.id, index), live));
  }

  // Rebuilds the memtable from the log rows after the position the written pages cover. Until it has finished the
  // projection is stale, so a rebuild cut off partway (a statement failing inside it) is done again by the next call
  // instead of answering from a memtable half refilled.
  function replay(sliceRows = null) {
    copiedOwnerPages = null;
    invalidateProjection('replay-started');
    memberCache.clear(); memberRoots.clear(); memberCacheBytes = 0;
    typed.forgetReady();
    // A key made in a transaction that rolled back is gone with it: the keys are read again, never trusted from memory.
    erasing.forgetCached();
    forgetOpened();
    forgetSelections();
    keys.reloadCatalog();
    sharedFieldTypes.clear();
    for (const type of keys.meta.get('shared_field_types') ?? []) sharedFieldTypes.add(type);
    keys.clearMemtable();
    sharedCache.clear();
    sharedCacheBytes = 0;
    slots.clear();
    seen.clear();
    modelBuild = undefined;
    model.clear();
    declaredLoaded = false;
    // The checksum as kept with the pages at the position they cover, then moved along by every row replayed below.
    // With no pages yet, everything held comes from the log, so it starts at zero; pages written before the checksum
    // was kept leave it unknown until the build (buildSums) has walked every record; a build under way goes on from
    // where it was kept.
    const keptPosition = keys.covered();
    const coveredAt = (typeof keptPosition === 'object' && keptPosition !== null ? keptPosition.at : keptPosition) ?? 0;
    // Replay uses one synchronous checkpoint snapshot for its metadata and log frontier.
    const fresh = !keys.held().runs.length && !coveredAt;
    const directoryProof = keptPosition?.bucket_directory;
    bucketDirectory = directoryProof?.signature === BUCKET_DIRECTORY_SIGNATURE
      && typeof directoryProof.epoch === 'string' && /^[0-9a-f]{32}$/.test(directoryProof.epoch)
      && typeof directoryProof.ready === 'boolean' && (directoryProof.after === null || typeof directoryProof.after === 'string')
      && (!Object.hasOwn(directoryProof, 'through') || directoryProof.through === null || typeof directoryProof.through === 'string')
      && typeof directoryProof.retiring === 'boolean' && (directoryProof.retire_after === null || typeof directoryProof.retire_after === 'string')
      ? { ...directoryProof }
      : { signature: BUCKET_DIRECTORY_SIGNATURE, epoch: uuidv7().replaceAll('-', ''), after: null,
        ready: fresh, retiring: !fresh, retire_after: null };
    counts = keptPosition?.counts ?? (fresh ? Object.create(null) : null);
    // Old projections build exact type counts through the same bounded checksum walk. No count request walks records.
    const keptSums = keptPosition?.sums;
    if (keptSums && counts) sums = storeSums(lanesFrom(keptSums));
    else sums = fresh ? storeSums() : null;
    const keptBuild = sums ? null : keys.meta.get(SUMS_BUILD);
    building = keptBuild?.counts ? { after: keptBuild.after, at: keptBuild.at, sums: storeSums(lanesFrom(keptBuild.sums)), counts: keptBuild.counts } : null;
    const from = coveredAt;
    let last = from;
    tailRows = 0;
    const applyBatch = batch => {
      const ids = [...new Set(batch.flatMap(event => event.envelope ? [event.envelope.id] : []))];
      // A record may hold 8 MiB. Split only groups whose actual selected values
      // exceed this budget; a single large record still opens correctly.
      const value_budget = batch.length > 1 ? { remaining: 2 * 1024 * 1024 } : null;
      const readSelected = selected => priorStatesOf(selected, value_budget);
      let prefetched;
      try {
        prefetched = readSelected(ids);
        if (value_budget) {
          // Index paths can cross content-addressed links. Find only links an
          // index can follow, then read each depth together before applying.
          const changes = new Map();
          const requests = [];
          const seen = new Set();
          const follow = (value, path) => {
            let at = value;
            for (let index = 0; index < path.length; index += 1) {
              if (isObject(at) && typeof at[SHARED_MARK] === 'string') {
                const id = at[SHARED_MARK];
                const rest = path.slice(index);
                const key = JSON.stringify([id, rest]);
                if (!seen.has(key)) { seen.add(key); requests.push({ id, path: rest }); }
                return;
              }
              if (!isObject(at)) return;
              at = at[path[index]];
            }
          };
          for (const event of batch) {
            const envelope = event.envelope;
            if (!envelope) continue;
            const candidate = prefetched.get(envelope.id);
            const types = new Set([candidate?.at?.[0], envelope.prior?.type, envelope.type].filter(Boolean));
            const values = [candidate?.value, envelope.value, envelope.set, envelope.prior?.value, envelope.was];
            if (!changes.has(envelope.id)) changes.set(envelope.id, []);
            changes.get(envelope.id).push(...values);
            for (const type of types) for (const index of declared.get(type) ?? []) {
              for (const path of [...index.paths, ...(index.carry_presence ? index.carry ?? [] : []), ...(index.carry_presence ?? [])]) for (const value of values) follow(value, path);
            }
          }
          while (requests.length) {
            const level = requests.splice(0);
            const missing = [...new Set(level.map(request => request.id))].filter(id => !prefetched.has(id));
            for (let at = 0; at < missing.length; at += 256) {
              for (const [id, held] of readSelected(missing.slice(at, at + 256))) prefetched.set(id, held);
            }
            for (const request of level) {
              follow(prefetched.get(request.id)?.value, request.path);
              for (const value of changes.get(request.id) ?? []) follow(value, request.path);
            }
          }
        }
      } catch (error) {
        if (!(error instanceof KeptRangeBudgetExceeded) || batch.length === 1) throw error;
        prefetched = null;
        const middle = batch.length >>> 1;
        applyBatch(batch.slice(0, middle));
        applyBatch(batch.slice(middle));
        return;
      }
      priorHeld = prefetched;
      try {
        for (const event of batch) {
          replaying = event.at;
          if (event.envelope) applyEnvelope(event.envelope, event.envelope.seq ?? seqFrom(event.logId, event.index));
          if (event.last) last = event.at;
        }
      } finally { priorHeld = null; }
    };
    const slice = Number.isSafeInteger(sliceRows) && sliceRows > 0 ? { rows: sliceRows, more: false } : null;
    tailRows = replayLogBatches(sql, from, applyBatch, (rowid, text) => { for (const [id, key] of Object.entries(JSON.parse(text))) erasing.prime(id, { key, at: rowid }); }, slice);
    replaying = null;
    applied = last;
    const logEndRow = slice?.more ? all(`SELECT MAX(rowid) AS n FROM ${LOG}`)[0]?.n ?? last : last;
    if (slice?.more && logEndRow > last) {
      // One slice of a long tail: what it applied is written out as one checkpoint (position, sums and counts together), so the next
      // slice starts from here and the memtable it held is freed. The projection stays stale until a slice reaches the end.
      transaction(() => writeOut(applied));
      return { more: true, covered: last, tail_left: logEndRow - last, slice_rows: sliceRows, replayed: tailRows };
    }
    current = true;
    return { more: false, covered: last, tail_left: 0, slice_rows: sliceRows, replayed: tailRows };
  }
  // A cold open can have the same long uncovered tail as a failed warm write. Let the host place this first
  // replay in its upkeep too; an ordinary own-record call can then answer busy without spending its bound here.
  // A tail the host calls short (host.openReplayRows) is replayed here by the opening call: a current checkpoint is
  // loaded in a few statements, and refusing every first call after an eviction as "catching up" helps no one.
  if (typeof host.rebuild === 'function' && Number.isSafeInteger(host.openReplayRows) && logEnd() - coveredAtOpen() <= host.openReplayRows) replay(); else rebuild();
  // A genuinely empty type has nothing to backfill: new records receive every declared key on their first write.
  // The marker is kept once, so reopening a fresh account does not manufacture an upgrade it never needed.
  // Their build states are read in one page, and every empty type is marked ready in one transaction with one readiness
  // write: a fresh store marked each in its own (2026-10-15: about 100 statements of one account erasure's rebuild).
  const unbuilt = readOnly ? [] : [...indexBuilds.values()].filter(group => !readiness.isReady(group.key, group.signature));
  const unbuiltStates = keys.meta.getMany(unbuilt.map(group => group.key));
  const empty = unbuilt.filter(group => !qualifiedBuildState(group, unbuiltStates.get(group.key)).ready).filter(group => group.retired
    ? !group.indexes.some(index => { const prefix = indexPrefix(index.type, index.name); return keys.hasRange(prefix, afterKeyPrefix(prefix)); })
    : !keys.hasRange(typeKey(group.type, ''), `t${SEP}${group.type}${AFTER}`));
  const builtBefore = unbuilt.filter(group => qualifiedBuildState(group, unbuiltStates.get(group.key)).ready);
  if (builtBefore.length) (readiness.setMany ?? (entries => entries.forEach(([key, signature]) => readiness.set(key, signature))))(builtBefore.map(group => [group.key, group.signature]));
  if (empty.length) transaction(() => {
    for (const group of empty) keys.meta.set(group.key, { signature: group.signature, after: null, ready: true });
    (readiness.setMany ?? (entries => entries.forEach(([key, signature]) => readiness.set(key, signature))))(empty.map(group => [group.key, group.signature]));
  });
  // Likewise a store holding no record yet has nothing for the model to walk: every record it keeps is keyed as written.
  if (!readOnly && !modelState() && !keys.range(idKey(''), `i${AFTER}`, { limit: 1 }).length) {
    const parts = Object.fromEntries(allKinds().map(kind => [kind.type, model.signatureOf(kind.type)]));
    transaction(() => keys.meta.set(MODEL_BUILD, (modelBuild = { parts, walking: null, seen_after: null, seen_walked: true })));
  }
  // The projection is the log's: a transaction that rolled back without saying so (its log rows gone, its changes
  // still in memory) is found here, before anything is built on it.
  function inStep() { if (logEnd() !== applied) rebuild(); }

  // Writes the memtable out, recording how far the log it covers and, beside it, the checksum at that position.
  function writeOut(at) {
    // A write to a record already walked also changes the partial checksum/counts.
    // Keep that change beside this checkpoint: its covered log will not replay on
    // the next open, so an older saved partial summary would lose those edits.
    if (!sums && building) {
      keys.meta.set(SUMS_BUILD, { after: building.after, at, sums: building.sums.text(), counts: building.counts });
      building.at = at;
    }
    const position = sums ? { at, sums: sums.text(), counts } : { at };
    if (carriedEpoch !== null) position.carried_projection = { signature: carriedSignature, epoch: carriedEpoch };
    position.bucket_directory = { ...bucketDirectory };
    keys.flush({ covered: position });
    tailRows = 0;
  }
  // Keys and frontier share the existing projection checkpoint, so a failed transaction cannot publish coverage
  // of a directory that never reached the runs. The fixed old frontier excludes later writes, which maintain their
  // own directory entries. A slice reads only ID key metadata; it never opens a root value to compute bucketOf(id).
  function buildBucketDirectory(hasTime = () => true) {
    inStep();
    if (!bucketDirectory.ready) {
      const through = Object.hasOwn(bucketDirectory, 'through') ? bucketDirectory.through
        : keys.range(idKey(''), `i${AFTER}`, { reverse: true, limit: 1, readValue: () => false })[0]?.[0].slice(2) ?? null;
      const lo = bucketDirectory.after === null ? idKey('') : `${idKey(bucketDirectory.after)}${SEP}`;
      const page = through === null ? [] : keys.range(lo, `${idKey(through)}${SEP}`, { limit: BUCKET_DIRECTORY_PAGE, readValue: () => false });
      let after = bucketDirectory.after, stopped = false;
      for (const [key] of page) {
        if (after !== bucketDirectory.after && !hasTime()) { stopped = true; break; }
        const id = key.slice(2);
        keys.put(directoryKey(id), 1);
        after = id;
      }
      bucketDirectory = { ...bucketDirectory, after, through,
        ready: !stopped && (page.length < BUCKET_DIRECTORY_PAGE || (through !== null && after >= through)) };
      writeOut(applied);
      return;
    }
    // A missing checkpoint proof retires prior epochs as bounded idle work, rather than leaving their directories
    // to accumulate. Current-epoch keys are skipped by prefix, never decoded. This cursor is checkpointed too.
    if (bucketDirectory.retiring) {
      const currentPrefix = `${BUCKET_DIRECTORY_ROOT}${bucketDirectory.epoch}${SEP}`;
      let lo = bucketDirectory.retire_after === null ? BUCKET_DIRECTORY_ROOT : `${bucketDirectory.retire_after}${SEP}`;
      const beyondCurrent = `${currentPrefix.slice(0, -1)}${AFTER}`;
      // Jump over this epoch's entire prefix using fences, without an epoch list or a second active-directory walk.
      const page = lo < currentPrefix
        ? keys.range(lo, currentPrefix, { limit: BUCKET_DIRECTORY_PAGE, readValue: () => false }) : [];
      if (page.length < BUCKET_DIRECTORY_PAGE) {
        if (lo < beyondCurrent) lo = beyondCurrent;
        page.push(...keys.range(lo, `z${AFTER}`, { limit: BUCKET_DIRECTORY_PAGE - page.length, readValue: () => false }));
      }
      let after = bucketDirectory.retire_after, stopped = false;
      for (const [key] of page) {
        if (after !== bucketDirectory.retire_after && !hasTime()) { stopped = true; break; }
        keys.remove(key, obsoleteIndexBytes(key));
        after = key;
      }
      bucketDirectory = { ...bucketDirectory, retire_after: after, retiring: stopped || page.length >= BUCKET_DIRECTORY_PAGE };
      writeOut(applied);
    }
  }

  // A bounded idle slice of an opted-in field-index upgrade. Keys and progress commit together: a crash can repeat
  // a page, but can never advance its cursor past keys that existed only in a discarded memtable. Mutations and
  // deletions use the normal index write path; every visited id is read from its current head, not a copied snapshot.
  const INDEX_BUILD_PAGE = 32;
  // Explicit retirement uses the same idle admission as backfill. One slice visits only one exact index prefix,
  // at most 32 live keys; tombstones and the saved cursor are checkpointed atomically. New writes do not maintain
  // retired declarations, so record mutation cannot add work behind this cursor. Unnamed legacy retirements retain
  // their existing erasure-only behavior.
  function retireIndexes(group, hasTime) {
    const state = buildState(group);
    const position = state.index ?? 0;
    const index = group.indexes[position];
    if (!index) { keys.meta.set(group.key, { signature: group.signature, after: null, index: position, ready: true }); readiness.set(group.key, group.signature); return []; }
    const prefix = indexPrefix(index.type, index.name);
    const page = keys.range(state.after === null ? prefix : `${state.after}${SEP}`, afterKeyPrefix(prefix), { limit: INDEX_BUILD_PAGE, readValue: () => false });
    let after = state.after;
    let stopped = false;
    for (const [key] of page) {
      if (after !== state.after && !hasTime()) { stopped = true; break; }
      // Count raw JSON one stored chunk at a time. Retiring 32 large carried values must never decode and hold all
      // of them in memory merely to measure their debt.
      let chars = 0;
      for (const part of keys.jsonParts(key)) chars += part.length;
      keys.remove(key, obsoleteIndexChars(key, chars));
      after = key;
    }
    const finished = !stopped && page.length < INDEX_BUILD_PAGE;
    const next = finished ? position + 1 : position;
    writeOut(applied);
    keys.meta.set(group.key, { signature: group.signature, after: finished ? null : after, index: next, ready: next >= group.indexes.length });
    readiness.set(group.key, next >= group.indexes.length ? group.signature : null);
    return [];
  }
  function buildIndexes(group, hasTime = () => true) {
    if (!group) return [];
    forgetSelections(group.type);
    inStep();
    if (group.retired) return retireIndexes(group, hasTime);
    const state = buildState(group);
    const prefix = typeKey(group.type, '');
    // New writes already maintain every declared index. Fix the old-data
    // frontier once, so a busy carrier cannot grow this rebuild faster than
    // its bounded slices. Legacy saved cursors capture a frontier on resumption.
    const through = Object.hasOwn(state, 'through') ? state.through
      : keys.range(prefix, `t${SEP}${group.type}${AFTER}`, { reverse: true, limit: 1 })[0]?.[0].slice(prefix.length) ?? null;
    const lo = state.after === null ? prefix : `${typeKey(group.type, state.after)}${SEP}`;
    const page = through === null ? [] : keys.range(lo, `${typeKey(group.type, through)}${SEP}`, { limit: INDEX_BUILD_PAGE });
    const prefixes = group.indexes.map(index => indexPrefix(group.type, index.name));
    let after = state.after;
    let stopped = false;
    for (const [key] of page) {
      if (after !== state.after && !hasTime()) { stopped = true; break; }
      const id = key.slice(prefix.length);
      const current = kept(id);
      if (current?.type === group.type) for (const [entry, carried] of indexEntriesOf(group.type, id, current.value)) {
        if (prefixes.some(prefix => entry.startsWith(prefix))) {
          const prior = keys.get(entry);
          if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(carried)) continue;
          keys.put(entry, carried, undefined, prior === undefined ? 0 : obsoleteIndexBytes(entry, prior));
        }
      }
      after = id;
    }
    const ready = !stopped && (page.length < INDEX_BUILD_PAGE || (through !== null && after >= through));
    writeOut(applied);
    keys.meta.set(group.key, { signature: group.signature, after, through, ready });
    readiness.set(group.key, ready ? group.signature : null);
    return ready ? group.indexes.map(({ type, name }) => ({ type, name })) : [];
  }
  // A bounded idle slice of the model's walk (invariant 11): first the records of each kind whose parts are not yet
  // keyed under its current declaration, a kind at a time over its own type list; then every record, in id order, for
  // the value kinds its properties hold. Keys and progress are written out together, as the index builds are, so a
  // restart walks again from a place whose keys exist. Answers what this slice walked.
  const MODEL_PAGE = 256;
  function buildModel(hasTime = () => true) {
    inStep();
    const held = modelState();
    const state = held ? { ...held, parts: { ...held.parts } } : { parts: {}, walking: null, seen_after: null, seen_walked: false };
    let walked = 0;
    let finished = false;
    const next = state.walking ? null : kindsToWalk(state)[0];
    // Copy the saved cursor: memory may not advance past a transaction that rolls back.
    const kind = state.walking ? { ...state.walking } : (next ? { type: next.type, after: null, signature: model.signatureOf(next.type) } : null);
    if (kind) {
      const prefix = typeKey(kind.type, '');
      if (hasTime()) {
        const lo = kind.after === null ? prefix : `${typeKey(kind.type, kind.after)}${SEP}`;
        const page = keys.range(lo, `t${SEP}${kind.type}${AFTER}`, { limit: MODEL_PAGE }).map(([key]) => key.slice(prefix.length));
        for (const id of page) {
          if (!hasTime()) break;
          const current = kept(id);
          if (current?.type === kind.type) {
            for (const key of modelKeysOf(kind.type, id, current.value)) keys.put(key, 1);
            noteSeen(kind.type, current.value);
          }
          kind.after = id;
          walked += 1;
        }
        finished = walked === page.length && page.length < MODEL_PAGE;
      }
      if (finished) { state.parts[kind.type] = kind.signature; state.walking = null; } else state.walking = kind;
    } else if (!state.seen_walked) {
      if (hasTime()) {
        // Collect only ids before changing keys, never an entire page of decoded record values.
        const lo = state.seen_after === null ? idKey('') : `${idKey(state.seen_after)}${SEP}`;
        const page = [];
        for (const [key] of keys.walk(lo, `i${AFTER}`, { readValue: () => false })) {
          page.push(key.slice(2));
          if (page.length >= MODEL_PAGE) break;
        }
        for (const id of page) {
          if (!hasTime()) break;
          const current = kept(id);
          if (current) noteSeen(current.type, current.value);
          state.seen_after = id;
          walked += 1;
        }
        finished = walked === page.length && page.length < MODEL_PAGE;
      }
      if (finished) Object.assign(state, { seen_walked: true, seen_after: null });
    }
    writeOut(applied);
    keys.meta.set(MODEL_BUILD, state);
    modelBuild = state;
    return { phase: kind ? 'parts' : 'properties', type: kind?.type ?? null, walked, done: !modelPending() };
  }
  // Writes the memtable out from a write only once it is overfull: the log row already makes the write durable, so
  // writing the memtable out (and merging) is idle work (maintain()), off the write's path.
  function writeOutWhenOverfull() {
    if (keys.overfull() || tailRows >= keys.settings.tail_rows) writeOut(applied);
  }

  let sealedLogNames = null;
  // Where each sealed log ends (the id of its last row): a sealed log is never written again, so this is read once, and
  // a copy settling from a position past it passes over the whole table without a statement (logAfter).
  const sealedEnds = new Map();
  const endOf = table => {
    if (table !== LOG && sealedEnds.has(table)) return sealedEnds.get(table);
    const end = all(`SELECT id FROM ${table} ORDER BY rowid DESC LIMIT 1`)[0]?.id?.split('.')[0] ?? null;
    if (table !== LOG) sealedEnds.set(table, end);
    return end;
  };
  // A host with its own upkeep leaves recovery to that upkeep; its failing work has often outgrown its bound already.
  // Other hosts still restore the projection here, including a record-engine move whose same turn reads it again.
  // A failed transaction that neither changed this projection nor wrote its tables since its caller's mark (changeMark,
  // taken where it began) leaves the projection current: a command refused at its bound before any statement, or a
  // write refused while it was being built, must not make every next call wait for a rebuild (RecordBook 880c74dd,
  // 2026-10-19: 2.2 invalidations a minute, each answering calls "catching up" until the upkeep had rebuilt). Without
  // a mark the projection is forgotten as before. Keys made for a write that never committed are forgotten either way.
  const forgetCached = (error = null, mark = null) => {
    if (unchangedSince(mark)) { erasing.forgetCached(); return; }
    sealedLogNames = null; sealedEnds.clear(); invalidateProjection('cache-forgotten', error, null, { mark });
    if (typeof host.rebuild !== 'function') replay();
  };

  // The envelope one record's write needs against what is kept, or null when it changes nothing.
  function envelopeFor(id, type, value, shared) {
    const before = kept(id);
    if (value === null) return before ? { id, remove: true } : null;
    const stored = shareEnvelope({ id, type, value: storedForm(type, value, shared) }).value;
    if (!before || before.type !== type) return { id, type, value: stored };
    const set = {};
    const unset = [];
    let changed = false;
    for (const [field, item] of Object.entries(stored)) {
      if (JSON.stringify(before.value[field]) !== JSON.stringify(item)) { set[field] = item; changed = true; }
    }
    for (const field of Object.keys(before.value)) if (!Object.hasOwn(stored, field)) { unset.push(field); changed = true; }
    if (!changed) return null;
    return { id, type, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
  }
  // Appends the envelopes as one log row (or several parts of one, all in this transaction) and applies them.
  function commit(envelopes, context, appliedAlready = false) {
    if (!envelopes.length) return;
    noteChange();
    const logId = uuidv7();
    // The row this write's first part takes (a write's rows are contiguous, as replayLogBatches relies on): where the
    // keys it makes are kept, named in each record's entry.
    nextLogRow = applied + 1;
    // Applied first, so each envelope learns what it replaces before it is written (a failure after this rebuilds the
    // projection from the log, which never got the row).
    if (!appliedAlready) applyRow({ id: logId }, envelopes, true);
    const included = new Set(envelopes.map(envelope => envelope.id));
    for (const [id, envelope] of pendingShared ?? []) if (!included.has(id)) envelopes.push(envelope);
    const tableChanges = new Map();
    for (const envelope of envelopes) {
      if (!tableChanges.has(envelope.id)) tableChanges.set(envelope.id, new Set());
      if (envelope.prior?.type) tableChanges.get(envelope.id).add(envelope.prior.type);
    }
    const outer = schemaChanges;
    schemaChanges = [];
    // Each kind's table is ensured once for this write's rows of it, and again after a declaration here changes it. Its
    // rows are written together, those before a declaration under the table as it was (typed.putMany).
    const schemas = new Map();
    let puts = [];
    const putHeld = () => { if (puts.length) typed.putMany(puts, { ...context, validate: false }, schemas); puts = []; };
    for (const [id, oldTypes] of tableChanges) {
      const found = kept(id);
      for (const oldType of oldTypes) {
        if (oldType !== found?.type) typed.remove(id, oldType, context);
      }
      if (found && tableKind(found.type)) puts.push({ id, type: found.type, value: resolveRead(found.value, id) });
      if (found && model.declares(found.type)) {
        const declared = model.kinds().find(kind => kind.declared_by === id);
        if (declared) { putHeld(); typed.ensure(declared.type, context); schemas.delete(declared.type); }
      }
    }
    putHeld();
    // The schema changes this write made go into its own log row, after its envelopes, so a replay applies them in place.
    markHistoryBoundary(schemaChanges.length);
    const changes = schemaChangeEnvelopes(schemaChanges);
    schemaChanges = outer;
    changes.forEach((envelope, index) => applyEnvelope(envelope, seqFrom(logId, envelopes.length + index), true));
    envelopes.push(...changes);
    const text = JSON.stringify(envelopes);
    const parts = Math.max(1, Math.ceil(text.length / LOG_ROW_CHARS));
    // The keys this write made ride in its first row, beside the envelopes (erasable.mjs invariant 1).
    const madeKeys = erasing.takePending(nextLogRow);
    for (let part = 0; part < parts; part += 1) {
      const values = [part === 0 ? logId : `${logId}.${part}`, context.transaction_id, JSON.stringify(context.actor ?? {}), context.application_time, context.system_time, part, parts, text.slice(part * LOG_ROW_CHARS, (part + 1) * LOG_ROW_CHARS)];
      if (part === 0 && madeKeys) sql.exec(`INSERT INTO ${LOG} (id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes, keys) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...values, JSON.stringify(madeKeys));
      else sql.exec(`INSERT INTO ${LOG} (id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ...values);
    }
    applied = logEnd();
    tailRows += parts;
  }
  function contextOf({ actor = {}, application_time, transaction_id = uuidv7() } = {}) {
    const system_time = new Date().toISOString();
    return { actor, application_time: application_time ?? system_time, system_time, transaction_id };
  }
  // Runs one write: checks the projection, builds the envelopes, commits them; a failure rebuilds the projection.
  function writing(context, build, { applied_already = false, prior = [] } = {}) {
    const mark = markNow();
    let previousTypes = new Map(), written = [];
    const beforeTypes = new Map(), outerBeforeTypes = mutationBeforeTypes;
    try {
      transaction(() => {
        inStep();
        holdPriorStates(prior);
        mutationBeforeTypes = beforeTypes;
        pendingShared = new Map();
        const shared = new Map();
        const envelopes = build(shared).map(shareEnvelope);
        const sharedEnvelopes = [...shared].filter(([id]) => !kept(id)).map(([id, { type, value }]) => ({ id, type, value }));
        // commit appends real shared/schema roots to THIS array. Report the
        // committed row, never the caller's earlier or narrower input list.
        const committed = [...pendingShared.values(), ...sharedEnvelopes, ...envelopes];
        commit(committed, context, applied_already);
        written = [...new Set(committed.map(envelope => envelope.id))];
        previousTypes = new Map(written.filter(id => beforeTypes.has(id)).map(id => [id, beforeTypes.get(id)]));
        pendingShared = null;
        writeOutWhenOverfull();
      });
    } catch (error) {
      pendingShared = null;
      priorHeld = null;
      mutationBeforeTypes = outerBeforeTypes;
      if (typeof host.rebuild === 'function') forgetCached(error, mark);
      else { try { replay(); } catch { /* rebuilt by the next call */ } }
      throw error;
    } finally { priorHeld = null; mutationBeforeTypes = outerBeforeTypes; }
    return { transaction_id: context.transaction_id, previous_types: previousTypes, written };
  }
  // What a write's records held before it, read together (priorStatesOf) for the ids not resident, a bounded group at a
  // time: its envelopes, model check and apply then read them from here, not each id from every run two or three times.
  // A group whose values pass the budget (or one record too large to read whole) is left to the point reads.
  function holdPriorStates(ids) {
    const missing = [...new Set(ids)].filter(id => slots.find(id) < 0);
    if (!missing.length) return;
    const held = new Map();
    for (let at = 0; at < missing.length; at += 64) {
      try { for (const [id, state] of priorStatesOf(missing.slice(at, at + 64), { remaining: 2 * 1024 * 1024 })) held.set(id, state); }
      catch (error) { if (!(error instanceof KeptRangeBudgetExceeded) && error.code !== 'record_too_large') throw error; }
    }
    priorHeld = held;
  }

  function readRoot(id, bounded = true) {
    const found = kept(id);
    if (!found) return null;
    if (bounded) withinBounds(id, found.value, found.size);
    return found;
  }
  // Consume stored roots without expanding shared objects. Exact id ranges share one run-page read; bound each
  // prefetch by ids and selected value bytes. A singleton keeps the ordinary representation-only field migration.
  // The consumer decides whether to enforce full-read bounds/resolve links or to clone only selected scalar fields.
  function consumeRawRoots(ids, consume, { retainFilteredPointReads = false, preserveBudgetProgress = false } = {}) {
    const unique = [...new Set(ids)];
    const exact = key => ({ lo: key, hi: `${key}\u0000` });
    const readOne = id => consume(id, kept(id));
    // Complete resident membership filters already reject unrelated runs without SQL. Keep the field reader's
    // cheaper point path there; batching is for roots whose run membership needs stored pages. Full readMany keeps
    // its existing grouped admission/lookup behavior, independent of this field-specific preservation option.
    const pointReads = retainFilteredPointReads && keys.exactMembershipResident();
    const batch = selected => {
      if (pointReads) { for (const id of selected) readOne(id); return; }
      const missing = [];
      for (const id of selected) {
        if (slots.find(id) >= 0 || priorHeld?.has(id)) readOne(id); else missing.push(id);
      }
      if (!missing.length) return;
      if (missing.length === 1) { readOne(missing[0]); return; }
      if (preserveBudgetProgress) {
        const retry = pending => {
          if (!pending.length) return;
          if (pending.length < missing.length) { batch(pending); return; }
          const middle = Math.ceil(pending.length / 2);
          batch(pending.slice(0, middle));
          batch(pending.slice(middle));
        };
        const budget = { remaining: 2 * 1024 * 1024 };
        const selectedRange = bounds => {
          try {
            return { accepted: new Map(keys.ranges(bounds, { value_budget: budget,
              resident_exact_points: retainFilteredPointReads, preserve_exact_progress: true })), complete: true };
          } catch (error) {
            if (!(error instanceof KeptRangeBudgetExceeded)) throw error;
            const progress = error[KEPT_RANGE_PROGRESS];
            if (!progress) throw error;
            return { ...progress, complete: false };
          }
        };
        let positions;
        try { positions = selectedRange(missing.map(id => exact(idKey(id)))); }
        catch (error) {
          if (!(error instanceof KeptRangeBudgetExceeded) && error.code !== 'record_too_large') throw error;
          retry(missing);
          return;
        }
        const legacy = [], unresolved = [];
        // Consume completed inline roots and removals before the legacy-value
        // range, so even a separate refusal there cannot make them read again.
        for (const id of missing) {
          const key = idKey(id);
          if (!positions.complete && !positions.completed.has(key)) { unresolved.push(id); continue; }
          const at = positions.accepted.get(key);
          primeKey(id, at);
          if (!at || at[0] === null) { consume(id, null); continue; }
          if (at.length < 3) legacy.push({ id, at, key: recordKey(at[0], at[1], id) });
          else consume(id, resident(id, at[0], at[1], at[2], true, null, at[3] ?? null));
        }
        let pointers;
        try { pointers = selectedRange(legacy.map(({ key }) => exact(key))); }
        catch (error) {
          if (!(error instanceof KeptRangeBudgetExceeded) && error.code !== 'record_too_large') throw error;
          retry([...legacy.map(({ id }) => id), ...unresolved]);
          return;
        }
        for (const { id, at, key } of legacy) {
          if (!pointers.complete && !pointers.completed.has(key)) { unresolved.push(id); continue; }
          const value = pointers.accepted.get(key);
          consume(id, value === undefined ? null : resident(id, at[0], at[1], value, false, null, at[3] ?? null));
        }
        retry(unresolved);
        return;
      }
      let positions, pointers;
      try {
        const value_budget = { remaining: 2 * 1024 * 1024 };
        positions = new Map(keys.ranges(missing.map(id => exact(idKey(id))), { value_budget, resident_exact_points: retainFilteredPointReads }));
        const older = missing.flatMap(id => {
          const at = positions.get(idKey(id));
          primeKey(id, at);
          return at && at[0] !== null && at.length < 3 ? [exact(recordKey(at[0], at[1], id))] : [];
        });
        pointers = new Map(keys.ranges(older, { value_budget, resident_exact_points: retainFilteredPointReads }));
      } catch (error) {
        if (!(error instanceof KeptRangeBudgetExceeded) && error.code !== 'record_too_large') throw error;
        const middle = Math.ceil(missing.length / 2);
        batch(missing.slice(0, middle));
        batch(missing.slice(middle));
        return;
      }
      for (const id of missing) {
        const at = positions.get(idKey(id));
        primeKey(id, at);
        const value = at && at[0] !== null ? at.length >= 3 ? at[2] : pointers.get(recordKey(at[0], at[1], id)) : undefined;
        if (value === undefined) { consume(id, null); continue; }
        const found = resident(id, at[0], at[1], value, at.length >= 3, null, at[3] ?? null);
        consume(id, found);
      }
    };
    for (let at = 0; at < unique.length; at += 64) batch(unique.slice(at, at + 64));
    return unique;
  }
  function readMany(ids, { pointReads = false } = {}) {
    const answered = new Map();
    const unique = [...new Set(ids)];
    // Neighboring physical id roots share pages across bounded groups. Read in UTF-16 key order so the next
    // group can reuse the preceding group's boundary page, then reconstruct the caller's original order below.
    // pointReads: where complete resident membership filters already reject unrelated runs, each root is a point read,
    // as the field reader does. A batched run-page read costs the rows of every neighbouring record on its pages, so
    // a caller reading scattered roots of one type (a person's pursuits) grew with everything else the store held
    // (routes-budget * /pursuits: rows 2 -> 167 at 4n, 2026-10-16). Without resident filters it batches as before.
    consumeRawRoots([...unique].sort(), (id, found) => {
      if (found) withinBounds(id, found.value, found.size);
      answered.set(id, found ? openFields(id, resolveRead(found.value, id)) : null);
    }, { retainFilteredPointReads: pointReads });
    return new Map(unique.map(id => [id, answered.get(id)]));
  }
  const typeOf = id => { const slot = slots.find(id); return slot >= 0 ? slots.kindOf(slot) : priorHeld?.has(id) ? priorHeld.get(id).at?.[0] ?? null : keys.get(idKey(id))?.[0] ?? null; };
  // Type selection needs only id-root metadata, never legacy value records or expanded shared fields.
  // Keep the existing point behavior for an oversized singleton while batching ordinary roots under one byte bound.
  function typesOf(ids) {
    const unique = [...new Set(ids)], found = new Map();
    const batch = selected => {
      const missing = [];
      for (const id of selected) {
        const slot = slots.find(id);
        if (slot >= 0) found.set(id, slots.kindOf(slot)); else missing.push(id);
      }
      if (!missing.length) return;
      if (missing.length === 1) { found.set(missing[0], typeOf(missing[0])); return; }
      let positions;
      try {
        positions = new Map(keys.ranges(missing.map(id => { const lo = idKey(id); return { lo, hi: `${lo}\u0000` }; }),
          { value_budget: { remaining: 2 * 1024 * 1024 } }));
      } catch (error) {
        if (!(error instanceof KeptRangeBudgetExceeded) && error.code !== 'record_too_large') throw error;
        const middle = Math.ceil(missing.length / 2);
        batch(missing.slice(0, middle)); batch(missing.slice(middle));
        return;
      }
      for (const id of missing) found.set(id, positions.get(idKey(id))?.[0] ?? null);
    };
    const ordered = [...unique].sort();
    for (let at = 0; at < ordered.length; at += 64) batch(ordered.slice(at, at + 64));
    return new Map(unique.map(id => [id, found.get(id)]));
  }
  const listOf = (value, field) => (value && isListOfObjects(value[field]) ? value[field] : []);
  const memberFieldOrdinals = (names, ordinals) => {
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name)) throw new Error('names must be field names');
    if (ordinals !== null && (!Array.isArray(ordinals) || ordinals.some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error('ordinals must be nonnegative integers');
    return ordinals === null ? null : new Set(ordinals);
  };
  // Point and batch reads share the raw-member projection. Neither resolves shared siblings or adopts full-read bounds.
  const projectMemberFields = (value, field, names, wanted) => {
    const out = [];
    listOf(value, field).forEach((member, ordinal) => {
      if (wanted && !wanted.has(ordinal)) return;
      const selected = { ordinal };
      let any = false;
      for (const name of names) if (isScalarField(member[name])) { selected[name] = structuredClone(member[name]); any = true; }
      if (any) out.push(selected);
    });
    return out;
  };

  // ---- range reads over the key space ---------------------------------------------------------------------------
  // A read over a type's ids or an index with neither a limit nor `{ all: true }` walks every key of it, however many
  // there are. Production still answers it; a test run that sets RECORD_READS_STRICT=1 (or a store opened with
  // strict_reads) refuses it, so a call that grows with the records held is found by a test, not by a reset.
  const unbounded = what => { if (strict_reads) throw new Error(`${what} has neither a limit nor { all: true }: say how many to read, or that all of them are meant.`); };
  function idsOfType(type, { before, limit, prefix: idPrefix = '', all: everything = false } = {}) {
    const base = typeKey(type, '');
    const literal = String(idPrefix);
    const start = typeKey(type, literal);
    const end = literal ? afterKeyPrefix(start) : `${base.slice(0, -1)}${AFTER}`;
    if (before === undefined && limit === undefined) {
      if (!everything) unbounded(`ids(${type})`);
      inStep();
      if (counts !== null && countOf(counts, type) === 0) return [];
      return allSelectionIds(type, start, end, base.length);
    }
    const page = Math.max(1, Math.floor(Number(limit) || 100));
    const beforeKey = before === undefined ? end : typeKey(type, String(before));
    const hi = beforeKey < end ? beforeKey : end;
    return selectionKeys(type, 'ids', start, hi, { reverse: true, limit: page }).map(key => key.slice(base.length));
  }
  function requireIndex(type, name) {
    const index = indexNamed(type, name);
    if (!index) throw new Error(`No index named ${name} is declared for ${type} records.`);
    return index;
  }
  /**
   * Entries of one declared index: [{ id, values }] (values decoded). `equal` fixes the first values; `from` / `to` bound
   * the next value (inclusive; `after` / `before` exclusive; `startsWith` keeps text values beginning with it);
   * `after_id` with `after` resumes the exact (final field value, record id) pair;
   * all earlier index fields must be fixed by `equal`. It seeks past this one entry,
   * including when many records share that value, rather than filtering a tied group.
   * `idFrom` / `idTo` bound the id among entries whose values
   * are all fixed by `equal` (idTo exclusive); `reverse` walks down; `limit` bounds the work, `all: true` says every
   * entry in the range is meant (a read with neither is refused when strict_reads is set).
   */
  // carried: with an index that carries fields, each entry answers them too ({ field name: value }, an erasable one
  // opened with its record's key, null once erased), read from the entry, never from the record.
  function scan(type, name, { equal = [], from, to, after, after_id, before, startsWith, idFrom, idTo, reverse = false, limit = Infinity, all: everything = false, carried = false } = {}) {
    if (limit === Infinity && !everything) unbounded(`scan(${type}, ${name})`);
    if (!indexNamed(type, name)) {
      const dynamic = tableKind(type)?.indexes?.some(item => item.name === name);
      if (!dynamic) throw new Error(`No index named ${name} is declared for ${type} records.`);
      if (!indexReady(type, name)) {
        const error = new Error(`The ${name} index for ${type} records is still being prepared. Try again shortly.`);
        error.code = 'index_not_ready';
        throw error;
      }
      return typed.scanIndex(type, name, { equal, from, to, after, after_id, before, startsWith, idFrom, idTo, reverse,
        limit: Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 1000 });
    }
    const index = requireIndex(type, name);
    if (after_id !== undefined && (typeof after_id !== 'string' || !after_id || after_id.includes(SEP) || after === undefined || index.paths.length !== equal.length + 1 || from !== undefined || startsWith !== undefined)) {
      throw new Error('after_id needs an exclusive value and record id for the final index field.');
    }
    const base = indexPrefix(type, index.name) + equal.map(value => `${JSON.stringify(value)}${SEP}`).join('');
    let lo = base;
    let hi = `${base.slice(0, -1)}${AFTER}`;
    if (!equal.length) hi = `${indexPrefix(type, index.name).slice(0, -1)}${AFTER}`;
    if (equal.length === index.paths.length) {
      if (idFrom !== undefined) lo = `${base}${idFrom}`;
      if (idTo !== undefined) hi = `${base}${idTo}`;
    } else {
      if (from !== undefined) lo = `${base}${JSON.stringify(from)}`;
      if (after !== undefined) lo = after_id === undefined
        ? `${base}${JSON.stringify(after)}${AFTER}`
        // NUL follows this exact ID but sorts before its longer valid prefix IDs.
        // Seeking a prefix end instead would incorrectly skip IDs such as a0 after a.
        : `${base}${JSON.stringify(after)}${SEP}${after_id}${SEP}`;
      if (to !== undefined) hi = `${base}${JSON.stringify(to)}${AFTER}`;
      if (before !== undefined) hi = `${base}${JSON.stringify(before)}${SEP}`;
      if (startsWith !== undefined) {
        lo = `${base}${JSON.stringify(startsWith).slice(0, -1)}`;
        hi = `${lo.slice(0, -1)}${String.fromCharCode(lo.charCodeAt(lo.length - 1) + 1)}`;
      }
    }
    const start = indexPrefix(type, index.name).length;
    if (carried && index.carry?.length) {
      return keys.range(lo, hi, { reverse, limit }).map(([key, entry]) => {
        const parts = key.slice(start).split(SEP);
        const id = parts.pop();
        const held = Array.isArray(entry?.carry) ? entry.carry : [];
        const attested = index.carry_presence !== undefined && entry?.carry_schema === carriedSchema(index) && entry?.carry_epoch === carriedEpoch
          && held.length === index.carry.length && Array.isArray(entry.defined) && entry.defined.length === held.length
          && entry.defined.every(value => typeof value === 'boolean') && Array.isArray(entry.presence)
          && entry.presence.length === index.carry_presence.length && entry.presence.every(value => typeof value === 'boolean');
        return { id, values: parts.map(part => JSON.parse(part)),
          carried: Object.fromEntries(index.carry.map((path, at) => [nameOfField(path), structuredClone(openField(id, nameOfField(path), held[at] ?? null))])),
          ...(attested ? {
            carried_defined: Object.fromEntries(index.carry.map((path, at) => [nameOfField(path), entry.defined[at]])),
            carried_presence: Object.fromEntries(index.carry_presence.map((path, at) => [JSON.stringify(path), entry.presence[at]])),
          } : {}),
        };
      });
    }
    return selectionKeys(type, `scan:${index.name}`, lo, hi, { reverse, limit }).map(key => {
      const parts = key.slice(start).split(SEP);
      const id = parts.pop();
      return { id, values: parts.map(part => JSON.parse(part)) };
    });
  }
  // Selected first-value prefixes share one pass over the key store's runs.
  function scanFirstValues(type, name, values) {
    const index = requireIndex(type, name);
    if (!index.paths.length || !values.length) return [];
    const prefix = indexPrefix(type, index.name);
    const bounds = [...new Set(values)].map(value => {
      const lo = `${prefix}${JSON.stringify(value)}${SEP}`;
      return { lo, hi: `${lo.slice(0, -1)}${AFTER}` };
    });
    // Parent selections commonly have no children. Prove that with a lazy
    // enclosing existence read; populated selections retain their page batch.
    if (bounds.length > 1) {
      const lo = bounds.reduce((least, bound) => bound.lo < least ? bound.lo : least, bounds[0].lo);
      const hi = bounds.reduce((most, bound) => bound.hi > most ? bound.hi : most, bounds[0].hi);
      if (!keys.hasRange(lo, hi)) return [];
    }
    return keys.ranges(bounds, { keys_only: true }).map(([key]) => {
      const parts = key.slice(prefix.length).split(SEP);
      const id = parts.pop();
      return { id, values: parts.map(part => JSON.parse(part)) };
    });
  }
  // Several exact prefixes of one declared index, each with its own result limit. Reading them together batches
  // selected run pages; an unexpectedly wide batch uses the ordinary bounded range for each prefix instead.
  // An optional suffix fixes later contiguous components after each selected value, so a
  // batch of recipients can select only their waiting states without visiting dead/sent history.
  function scanSelectedValues(type, name, { equal = [], values = [], suffix = [], from, to, after, before, limit = Infinity, reverse = false } = {}) {
    const index = requireIndex(type, name);
    if (equal.length >= index.paths.length) throw new Error(`Index ${name} has no value after its fixed prefix.`);
    if (!Array.isArray(suffix) || equal.length + 1 + suffix.length > index.paths.length) throw new Error(`Index ${name} cannot fix that suffix after its selected value.`);
    const selected = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
    const count = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : Infinity;
    if (!selected.length || count === 0) return [];
    const compare = (left, right) => {
      for (let at = 0; at < index.paths.length; at += 1) {
        const a = JSON.stringify(left.values[at]);
        const b = JSON.stringify(right.values[at]);
        if (a !== b) return a < b ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    };
    if (equal.length + 1 + suffix.length === index.paths.length && [from, to, after, before].some(value => value !== undefined)) throw new Error(`Index ${name} has no value after its selected prefix to bound.`);
    const separately = () => selected.flatMap(value => scan(type, name, { equal: [...equal, value, ...suffix], from, to, after, before, reverse, limit: count, all: true }))
      .sort((left, right) => compare(left, right) * (reverse ? -1 : 1));
    if (!Number.isFinite(count)) return separately();
    const prefix = indexPrefix(type, index.name);
    const fixed = equal.map(value => `${JSON.stringify(value)}${SEP}`).join('');
    const bounds = selected.map(value => {
      const base = `${prefix}${fixed}${JSON.stringify(value)}${SEP}${suffix.map(item => `${JSON.stringify(item)}${SEP}`).join('')}`;
      let lo = base, hi = `${base.slice(0, -1)}${AFTER}`;
      if (from !== undefined) lo = `${base}${JSON.stringify(from)}`;
      if (after !== undefined) lo = `${base}${JSON.stringify(after)}${AFTER}`;
      if (to !== undefined) hi = `${base}${JSON.stringify(to)}${AFTER}`;
      if (before !== undefined) hi = `${base}${JSON.stringify(before)}${SEP}`;
      return { lo, hi };
    });
    let keysFound;
    try {
      keysFound = keys.ranges(bounds, {
        keys_only: true,
        limit_per_range: count,
        reverse,
        page_budget: { remaining: selected_scan_budget.pages },
        entry_budget: { remaining: selected_scan_budget.entries },
      });
    } catch (error) {
      if (!(error instanceof KeptRangeBudgetExceeded)) throw error;
      return separately();
    }
    const counts = new Map();
    const answer = [];
    for (const [key] of keysFound) {
      const parts = key.slice(prefix.length).split(SEP);
      const id = parts.pop();
      const group = parts[equal.length];
      const seen = counts.get(group) ?? 0;
      if (seen >= count) continue;
      counts.set(group, seen + 1);
      answer.push({ id, values: parts.map(part => JSON.parse(part)) });
    }
    return reverse ? answer.reverse() : answer;
  }
  // Last live entries for consecutive index components under a fixed prefix.
  // Inclusion applies to the first unfixed component before any reverse seek;
  // depth shares one cursor frontier across compound groups. Deleted included
  // groups may still require reconciliation of their retained tombstones.
  // `startsWith` (literal strings) limits the first unfixed component to text beginning with one of them, so groups
  // outside those ranges are never sought: a store's thousands of named speakers cost nothing to find its few unnamed.
  function lastPerGroup(type, name, { equal = [], exclude = [], include = () => true, depth = 1, startsWith } = {}) {
    const index = requireIndex(type, name);
    if (equal.length >= index.paths.length) throw new Error(`Index ${name} has no group after its fixed prefix.`);
    if (!Number.isSafeInteger(depth) || depth < 1 || equal.length + depth > index.paths.length)
      throw new Error(`Index ${name} needs a group depth within its remaining paths.`);
    if (typeof include !== 'function') throw new Error('Group inclusion must be a function.');
    const starts = groupStarts(startsWith);
    const root = indexPrefix(type, index.name);
    const prefix = root + equal.map(value => `${JSON.stringify(value)}${SEP}`).join('');
    const excluded = new Set(exclude.map(value => JSON.stringify(value)));
    const end = `${prefix.slice(0, -1)}${AFTER}`;
    const components = key => key.slice(prefix.length).split(SEP);
    let remembered, accepted;
    const accepts = key => {
      const first = components(key)[0];
      if (first !== remembered) {
        remembered = first;
        accepted = !excluded.has(first) && include(JSON.parse(first));
      }
      return accepted;
    };
    const ranges = starts === null ? [[prefix, end]] : starts.map(start => {
      const low = `${prefix}${JSON.stringify(start).slice(0, -1)}`;
      return [low, `${low.slice(0, -1)}${String.fromCharCode(low.charCodeAt(low.length - 1) + 1)}`];
    });
    return ranges.flatMap(([lo, hi]) => keys.groupHeads(lo, hi, {
      // A rejected first component skips all its subgroups as well as history.
      groupEnd: key => `${prefix}${components(key).slice(0, accepts(key) ? depth : 1).join(SEP)}${AFTER}`,
      include: accepts,
    })).map(([key]) => {
      const parts = key.slice(root.length).split(SEP);
      return { id: parts.pop(), values: parts.map(part => JSON.parse(part)) };
    });
  }

  // Field reads over the same records (the host's former attribute-fact reads): only a root record's own top-level
  // fields that hold a value of their own (a scalar or a list of scalars) are answered.
  const fieldsFromRecords = (type, ids, fields, { groupRoots = false, includeId = true, logicalFields = false } = {}) => {
    const found = new Map();
    const unique = consumeRawRoots(ids, (id, record) => {
      if (!record || record.type !== type) return;
      const out = includeId ? { id } : {};
      for (const field of fields) {
        if (!Object.hasOwn(record.value, field)) continue;
        const value = logicalFields ? resolveRead(record.value[field], id) : record.value[field];
        const item = openFields(id, { [field]: value })[field];
        if (logicalFields || isScalarField(item)) Object.defineProperty(out, field, { value: structuredClone(item), enumerable: true, writable: true, configurable: true });
      }
      if (logicalFields) withinBounds(id, out);
      found.set(id, out);
    }, { retainFilteredPointReads: !groupRoots, preserveBudgetProgress: true });
    return new Map(unique.filter(id => found.has(id)).map(id => [id, found.get(id)]));
  };
  // Exact JSON comparison over a stored field, without opening or copying the complete logical graph.
  // A representation repair must prove the old value, rather than trusting a replacement source's identity.
  // Ordinary read/project bounds stay unchanged. The comparison consumes at most bounds.bytes characters,
  // uses one scalar at a time, and refuses cycles, excessive depth and sealed values it cannot safely traverse.
  function visitOwnJson(id, value, consume, opening = new Set(), depth = 0) {
    if (depth > 128) throw Object.assign(new Error('Stored field exceeds bounded JSON comparison depth.'), { code: 'record_too_large', status: 413 });
    if (isSealed(value)) throw Object.assign(new Error('A sealed field cannot use representation-only JSON recovery.'), { code: 'record_field_sealed', status: 409 });
    if (isShared(value)) {
      const shared = value[SHARED_MARK];
      if (opening.has(shared)) throw new Error(`Record ${id} contains itself.`);
      opening.add(shared);
      try { return visitOwnJson(id, kept(shared)?.value ?? null, consume, opening, depth + 1); }
      finally { opening.delete(shared); }
    }
    if (Array.isArray(value)) {
      if (!consume('[')) return false;
      for (let at = 0; at < value.length; at += 1) {
        if (at && !consume(',')) return false;
        if (!visitOwnJson(id, value[at] ?? null, consume, opening, depth + 1)) return false;
      }
      return consume(']');
    }
    if (isObject(value)) {
      // A scalar-only JSON object has no shared/sealed descendants. Serialize it
      // once rather than allocating a token for every key, separator and scalar.
      // Non-JSON scalar kinds retain the explicit traversal/refusal below.
      let scalarOnly = true;
      for (const name in value) {
        if (!Object.hasOwn(value, name)) continue;
        const item = value[name], kind = typeof item;
        if (item !== null && kind !== 'string' && kind !== 'number' && kind !== 'boolean' && kind !== 'undefined') {
          scalarOnly = false; break;
        }
      }
      if (scalarOnly) return consume(JSON.stringify(value));
      if (!consume('{')) return false;
      let first = true;
      for (const name of Object.keys(value)) {
        if (value[name] === undefined) continue;
        if (!first && !consume(',')) return false;
        first = false;
        if (!consume(JSON.stringify(name)) || !consume(':') || !visitOwnJson(id, value[name], consume, opening, depth + 1)) return false;
      }
      return consume('}');
    }
    const scalar = JSON.stringify(value);
    if (scalar === undefined) throw new Error('Stored field is not JSON.');
    return consume(scalar);
  }

  function matchesFieldJson(type, id, field, text) {
    if (typeof field !== 'string' || !field || typeof text !== 'string') throw new Error('JSON comparison needs a field name and serialized JSON.');
    if (text.length > bounds.bytes) throw new RecordTooLarge(id, { rows: 0, bytes: text.length });
    const found = kept(id);
    if (!found || found.type !== type || !Object.hasOwn(found.value, field)) return false;
    let offset = 0;
    const matched = visitOwnJson(id, found.value[field], chunk => {
      if (offset + chunk.length > bounds.bytes) throw new RecordTooLarge(id, { rows: 0, bytes: offset + chunk.length });
      if (!text.startsWith(chunk, offset)) return false;
      offset += chunk.length;
      return true;
    });
    return matched && offset === text.length;
  }
  const fields = {
    // A caller already batching full roots can preserve that admission strategy while opening only selected fields.
    fieldsOf(type, ids, names, options) { return fieldsFromRecords(type, [...new Set(ids)], names, options); },
    // Request-bound field and presence projection shares bounded grouped roots.
    // Retain accepted exact-range progress; unresolved wide roots use ordinary
    // point admission, never recursive rereads of already accepted values.
    projectOf(type, ids, { fields: names = [], presence: paths = [] } = {}) {
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name)) throw new Error('Projection must name fields');
      if (!Array.isArray(paths) || paths.some(path => !Array.isArray(path) || !path.length || path.some(field => typeof field !== 'string' || !field))) throw new Error('Presence must name nonempty field paths');
      const found = new Map();
      const unique = consumeRawRoots(ids, (id, record) => {
        if (!record || record.type !== type) return;
        const picked = { id };
        for (const name of new Set(names)) if (record.value[name] !== undefined)
          picked[name] = isScalarField(record.value[name]) ? structuredClone(record.value[name]) : resolveRead(record.value[name], id);
        // An erasable field is answered opened, as read and fieldsOf answer it (null once erased); its sealed form never leaves.
        const selected = openFields(id, picked);
        withinBounds(id, selected);
        const presence = paths.map(path => {
          let value = record.value;
          const opened = new Set();
          for (const field of path) {
            while (isObject(value) && typeof value[SHARED_MARK] === 'string') {
              const shared = value[SHARED_MARK];
              if (opened.has(shared)) throw new Error(`Record ${id} contains itself.`);
              opened.add(shared);
              value = kept(shared)?.value;
            }
            if (value === null || value === undefined) return false;
            value = value[field];
          }
          return value !== undefined;
        });
        found.set(id, { fields: selected, presence });
      }, { retainFilteredPointReads: true, preserveBudgetProgress: true });
      return new Map(unique.filter(id => found.has(id)).map(id => [id, found.get(id)]));
    },
    presenceOf(type, ids, paths) {
      return new Map([...fields.projectOf(type, ids, { presence: paths })].map(([id, value]) => [id, value.presence]));
    },
    // after_id continues the exact (field value, record id) pair, without reading the preceding tied group.
    // Omitting it preserves the existing strict field-value bound for every scalar caller.
    after(type, field, after, names = [], { limit, after_id } = {}) {
      const index = indexOnPaths(type, [[field]]);
      if (!index) throw new Error(`No index on ${field} is declared for ${type} records.`);
      const page = Number.isInteger(limit) && limit > 0 ? limit : Infinity;
      const ids = scan(type, index.name, { after, after_id, limit: page, all: page === Infinity }).map(entry => entry.id);
      const found = fieldsFromRecords(type, ids, [...new Set([field, ...names])]);
      return ids.map(id => found.get(id)).filter(Boolean);
    },
    newestPerGroup(type, { group, order, fields: names = [] }) {
      const index = indexOnPaths(type, [[group], [order]]);
      if (!index) throw new Error(`No index on ${group} then ${order} is declared for ${type} records.`);
      const ids = lastPerGroup(type, index.name).map(entry => entry.id);
      const found = fieldsFromRecords(type, ids, [...new Set([group, order, ...names])]);
      return ids.map(id => found.get(id)).filter(Boolean);
    },
    idsWhere(type, field, value, { limit } = {}) {
      const index = indexOnPaths(type, [[field]]);
      if (!index) throw new Error(`No index on ${field} is declared for ${type} records.`);
      return scan(type, index.name, { equal: [value], ...(Number.isFinite(limit) ? { limit } : { all: true }) }).map(entry => entry.id);
    },
  };

  // ---- the log's generations ----------------------------------------------------------------------------------------
  // Only sealLog and dropSealedLog change this store's generations. A request collecting scheduler due times must not
  // rescan the whole SQLite catalog for a list that has not changed.
  const sealedLogs = () => [...(sealedLogNames ??= all("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB ? ORDER BY name", `${SEALED_LOG}*`).map(row => row.name))];
  const oldestLogId = () => all(`SELECT id FROM ${LOG} ORDER BY rowid LIMIT 1`)[0]?.id ?? null;

  const listOps = {
    ownFieldRecoveryVersion: () => 'record-log-exact-field-rewrite/v1',
    // Lossless packed-owner serialization uses the authoritative raw field, without logical graph expansion.
    readOwnFieldJson(id, type, field) {
      if (typeof field !== 'string' || !field) throw new Error('Own-field JSON needs a field name.');
      const found = kept(id);
      if (!found || found.type !== type || !Object.hasOwn(found.value, field)) return null;
      // Flatten bounded pieces instead of retaining a rope for every scalar token.
      // One reusable UTF-8 buffer bounds scratch storage even for large Unicode fields.
      let size = 0, used = 0;
      const piece = new Uint8Array(65536), pieces = [];
      const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
      const flush = () => { pieces.push(decoder.decode(piece.subarray(0, used))); used = 0; };
      visitOwnJson(id, found.value[field], chunk => {
        size += chunk.length;
        if (size > bounds.bytes) throw new RecordTooLarge(id, { rows: 0, bytes: size });
        let offset = 0;
        while (offset < chunk.length) {
          if (piece.length - used < 4) flush();
          const encoded = encoder.encodeInto(offset ? chunk.slice(offset) : chunk, piece.subarray(used));
          offset += encoded.read; used += encoded.written;
        }
        return true;
      });
      if (used) flush();
      return pieces.join('');
    },
    matchesOwnField(id,type,field,expected) { return matchesFieldJson(type,id,field,JSON.stringify(expected)); },
    rewriteOwnFieldIfEqual(id,type,field,expected,replacement,context = {}) {
      return listOps.rewriteOwnFieldJsonIfEqual(id,type,field,JSON.stringify(expected),replacement,context);
    },
    rewriteOwnFieldJsonIfEqual(id,type,field,expectedJson,replacement,context = {}) {
      if (!isObject(replacement) || !Object.keys(replacement).length || Object.hasOwn(replacement,field)) throw new Error('Field recovery needs a replacement object without the old field.');
      let matched = false;
      transaction(() => {
        inStep();
        if (!matchesFieldJson(type,id,field,expectedJson)) return;
        const found = kept(id);
        const omit = Object.keys(found.value).filter(name => name !== field && !Object.hasOwn(replacement,name));
        listOps.writeOwn(id,type,replacement,omit,context);
        matched = true;
      });
      return matched;
    },

    // Raw own fields support lossless rewrites. A logical consumer may explicitly
    // open only the retained fields, without decoding any omitted content body.
    readOwn(id, omit = [], { openErasable = false } = {}) {
      if (typeof openErasable !== 'boolean') throw new Error('openErasable must be boolean');
      if (!Array.isArray(omit) || omit.some(field => typeof field !== 'string' || !field)) throw new Error('omit must name fields');
      const found = kept(id);
      if (!found) return null;
      const own = Object.fromEntries(Object.entries(found.value).filter(([field]) => !omit.includes(field)));
      withinBounds(id, own);
      const resolved = resolveRead(own, id);
      return openErasable ? openFields(id, resolved) : resolved;
    },
    ownFieldPresent(id, field) { const found = kept(id); return Boolean(found && found.value[field] !== undefined); },
    memberCount(id, field) { return listOf(kept(id)?.value, field).length; },
    readMember(id, field, ordinal) {
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Member ordinal must be a nonnegative integer.');
      const member = listOf(kept(id)?.value, field)[ordinal];
      return member === undefined ? null : resolveRead(member, id);
    },
    memberFields(id, field, names, ordinals = null) {
      const wanted = memberFieldOrdinals(names, ordinals);
      if (!names.length || (ordinals && !ordinals.length)) return [];
      const key = memberRequestKey(id, field, names, ordinals);
      const cached = cachedMemberProjection(id, key);
      if (cached) return cached;
      const record = kept(id);
      const value = projectMemberFields(record?.value, field, names, wanted);
      if (record) keepMemberProjection(id, key, value);
      return value;
    },
    // Stable unique input order, including missing roots as empty lists. Raw prefetch retains its 64-id/2-MiB bounds.
    memberFieldsMany(ids, field, names, ordinals = null) {
      const wanted = memberFieldOrdinals(names, ordinals);
      const unique = [...new Set(ids)];
      if (!unique.length || !names.length || (ordinals && !ordinals.length)) return new Map(unique.map(id => [id, []]));
      // This method validates and handles empty work before replay, including after a prior SQL failure.
      if (!current) rebuild();
      const found = new Map();
      const requests = new Map(unique.map(id => [id, memberRequestKey(id, field, names, ordinals)]));
      const misses = unique.filter(id => {
        const cached = cachedMemberProjection(id, requests.get(id));
        if (cached) found.set(id, cached);
        return !cached;
      });
      consumeRawRoots(misses, (id, record) => {
        const value = projectMemberFields(record?.value, field, names, wanted);
        if (record) keepMemberProjection(id, requests.get(id), value);
        found.set(id, value);
      }, { retainFilteredPointReads: true });
      return new Map(unique.map(id => [id, found.get(id)]));
    },
    membersHolding(id, field, name) {
      return listOf(kept(id)?.value, field).flatMap((member, ordinal) => (member[name] !== undefined ? [ordinal] : []));
    },
    membersWhere(id, field, name, value) {
      const text = JSON.stringify(value);
      return listOf(kept(id)?.value, field).flatMap((member, ordinal) => (isScalarField(member[name]) && JSON.stringify(member[name]) === text ? [ordinal] : []));
    },
    writeOwn(id, type, value, omit = [], context = {}) {
      if (!isObject(value) || !Array.isArray(omit) || omit.some(field => typeof field !== 'string' || !field)) throw new Error('writeOwn needs an object and fields to leave in place.');
      if (typeOf(id) !== type) throw new Error(`Record ${id} is not a ${type}.`);
      checkModel(id, type, Object.fromEntries(Object.entries(value).filter(([field]) => !omit.includes(field))));
      return writing(contextOf(context), shared => {
        const before = kept(id);
        const own = Object.fromEntries(Object.entries(value).filter(([field]) => !omit.includes(field)));
        const keptFields = Object.fromEntries(Object.entries(before.value).filter(([field]) => omit.includes(field)));
        return diffEnvelope(id, type, before, { ...storedForm(type, own, shared), ...keptFields });
      });
    },
    writeMember(id, type, field, ordinal, value, context = {}) {
      if (typeOf(id) !== type) throw new Error(`Record ${id} is not a ${type}.`);
      if (!isObject(value) || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('writeMember needs an object and a nonnegative ordinal.');
      return writing(contextOf(context), shared => {
        const before = kept(id);
        const held = before.value[field];
        if (held !== undefined && !(Array.isArray(held) && (held.length === 0 || isListOfObjects(held)))) throw new Error(`Field ${id}/${field} is not an empty list.`);
        const list = Array.isArray(held) ? [...held] : [];
        if (ordinal > list.length) throw new Error(`List ${id}/${field} cannot skip ordinal ${list.length}.`);
        const member = storedForm(`${type}/${field}`, value, shared);
        if (ordinal < list.length && JSON.stringify(list[ordinal]) === JSON.stringify(member)) return [];
        list[ordinal] = member;
        return [{ id, type, set: { [field]: list } }];
      });
    },
  };
  // The envelope taking a kept record to a stored value, or none when they are the same.
  function diffEnvelope(id, type, before, stored) {
    const set = {};
    const unset = [];
    for (const [field, item] of Object.entries(stored)) if (JSON.stringify(before.value[field]) !== JSON.stringify(item)) set[field] = item;
    for (const field of Object.keys(before.value)) if (!Object.hasOwn(stored, field)) unset.push(field);
    if (!Object.keys(set).length && !unset.length) return [];
    return [{ id, type, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) }];
  }

  // ---- copies of this store: the checksum, the log after a position, applying another copy's changes ------------------
  // Every record held, one decoded page per run at a time (bounded memory however large the store), as [id, type, value, meta];
  // a removed record that left its stamps comes as [id, null, null, meta]. `after` starts the walk past one id;
  // `wanted(id)` (optional) passes over a record before its value is read.
  function* everyRecord(after = null, wanted = null) {
    const lo = after === null ? idKey('') : `${idKey(after)}${SEP}`;
    const hi = `i${AFTER}`;
    for (const [key, at] of keys.walk(lo, hi, { readValue: wanted ? key => wanted(key.slice(2)) : null })) {
      const id = key.slice(2);
      if (at === undefined) { yield [id, null, undefined]; continue; }
      if (at[0] === null) { yield [id, null, null, at[3], at[4] ?? null]; continue; }
      const value = at.length >= 3 ? at[2] : keys.get(recordKey(at[0], at[1], id));
      if (value !== undefined) yield [id, at[0], value, at[3] ?? null, at[4] ?? null];
    }
  }
  // Requested directory ranges are read together through the existing bounded multi-range owner. Each buffer
  // contains only 32 tiny directory entries; refill only exhausted buckets. Choosing the smallest ID across those
  // buffers preserves the original globally ordered after cursor, even though the directory is grouped by bucket.
  function* recordsFromDirectory(buckets, after = null) {
    const selected = [...new Set(buckets)].filter(bucket => Number.isInteger(bucket) && bucket >= 0 && bucket < BUCKETS);
    const lanes = selected.map(bucket => ({ prefix: directoryPrefix(bucket), after, values: [], at: 0, done: false }));
    const reader = keys.rangeReader();
    const refill = () => {
      const empty = lanes.filter(lane => !lane.done && lane.at >= lane.values.length);
      if (!empty.length) return;
      const bounds = empty.map(lane => ({ lo: lane.after === null ? lane.prefix : `${lane.prefix}${lane.after}${SEP}`,
        hi: `${lane.prefix.slice(0, -1)}${AFTER}` }));
      const pages = reader.ranges(bounds, { limit_per_range: BUCKET_DIRECTORY_READ_PAGE });
      const byPrefix = new Map(empty.map(lane => { lane.values = []; lane.at = 0; return [lane.prefix, lane]; }));
      const prefixLength = empty[0].prefix.length;
      for (const [key] of pages) {
        const lane = byPrefix.get(key.slice(0, prefixLength));
        if (lane) lane.values.push(key.slice(prefixLength));
      }
      for (const lane of empty) lane.done = lane.values.length < BUCKET_DIRECTORY_READ_PAGE;
    };
    function* openHeads(ids) {
      const exact = key => ({ lo: key, hi: `${key}\u0000` });
      let heads, legacy;
      try {
        const value_budget = { remaining: 2 * 1024 * 1024 };
        heads = new Map(keys.ranges(ids.map(id => exact(idKey(id))), { value_budget }));
        const old = ids.flatMap(id => {
          const at = heads.get(idKey(id));
          return at && at[0] !== null && at.length < 3 ? [exact(recordKey(at[0], at[1], id))] : [];
        });
        legacy = new Map(keys.ranges(old, { value_budget }));
      } catch (error) {
        if (!(error instanceof KeptRangeBudgetExceeded) && error.code !== 'record_too_large') throw error;
        heads = null; legacy = null;
        if (ids.length > 1) {
          const middle = Math.ceil(ids.length / 2);
          yield* openHeads(ids.slice(0, middle));
          yield* openHeads(ids.slice(middle));
          return;
        }
        // Preserve the existing admission of one accepted large source record, without retaining its siblings.
        const id = ids[0], at = keys.get(idKey(id));
        if (at === undefined) { yield [id, null, undefined]; return; }
        if (at[0] === null) { yield [id, null, null, at[3], at[4] ?? null]; return; }
        const value = at.length >= 3 ? at[2] : keys.get(recordKey(at[0], at[1], id));
        if (value !== undefined) yield [id, at[0], value, at[3] ?? null, at[4] ?? null];
        return;
      }
      for (const id of ids) {
        const at = heads.get(idKey(id));
        if (at === undefined) { yield [id, null, undefined]; continue; }
        if (at[0] === null) { yield [id, null, null, at[3], at[4] ?? null]; continue; }
        const value = at.length >= 3 ? at[2] : legacy.get(recordKey(at[0], at[1], id));
        if (value !== undefined) yield [id, at[0], value, at[3] ?? null, at[4] ?? null];
      }
    }
    try { for (;;) {
      const ids = [];
      while (ids.length < BUCKET_DIRECTORY_READ_PAGE) {
        refill();
        let best = null;
        for (const lane of lanes) if (lane.at < lane.values.length && (best === null || lane.values[lane.at] < best.values[best.at])) best = lane;
        if (best === null) break;
        const id = best.values[best.at++];
        best.after = id;
        ids.push(id);
      }
      if (!ids.length) return;
      yield* openHeads(ids);
    } } finally { reader.close(); }
  }

  const bucketRecords = (buckets, after = null) => {
    // Asking for every bucket is already an efficient ordered value stream: no directory seeks are needed.
    if (new Set(buckets.filter(bucket => Number.isInteger(bucket) && bucket >= 0 && bucket < BUCKETS)).size === BUCKETS) return everyRecord(after);
    if (bucketDirectory.ready) return recordsFromDirectory(buckets, after);
    const wanted = new Set(buckets);
    return everyRecord(after, id => wanted.has(bucketOf(id)));
  };

  // One page of the checksum build: walks at most `page` records past where the build stopped, then keeps where it is
  // (or, once every record is walked, the checksum itself with the pages). A whole walk in one call was more than five
  // minutes of CPU on a store of a million records, so every call that asked for the checksum was cut off and the next
  // one started the walk again (2026-10-05). Answers whether the checksum is known.
  function buildSums(page, hasTime = () => true) {
    if (sums) return true;
    inStep();
    building ??= { after: null, at: applied, sums: storeSums(), counts: Object.create(null) };
    let walked = 0;
    let finished = true;
    for (const [id, type, value, meta] of everyRecord(building.after)) {
      if (type !== null) { building.sums.add(id, type, value); building.counts[type] = countOf(building.counts, type) + 1; }
      building.sums.stamps(id, null, meta);
      building.after = id;
      walked += 1;
      if (walked >= page || !hasTime()) { finished = false; break; }
    }
    building.at = applied;
    if (!finished) { keys.meta.set(SUMS_BUILD, { after: building.after, at: building.at, sums: building.sums.text(), counts: building.counts }); return false; }
    sums = building.sums;
    counts = building.counts;
    building = null;
    keys.meta.remove(SUMS_BUILD);
    writeOut(applied);
    return true;
  }
  // The first rowid in a log table whose id sorts after `position` (ids are time-ordered, so rowid order is id order):
  // two ordered rowid seeks bound the binary search without aggregating every row in the table.
  // `inclusive` takes a row whose id is `position` itself.
  function firstRowAfter(table, position, inclusive = false) {
    const first = all(`SELECT rowid FROM ${table} ORDER BY rowid LIMIT 1`)[0]?.rowid;
    if (first === undefined) return null;
    if (position === null) return first;
    const last = all(`SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT 1`)[0]?.rowid ?? first;
    let lo = first;
    let hi = last + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const row = all(`SELECT rowid AS n, id FROM ${table} WHERE rowid >= ? ORDER BY rowid LIMIT 1`, mid)[0];
      if (!row) { hi = mid; continue; }
      const at = row.id.split('.')[0];
      if (inclusive ? at >= position : at > position) hi = mid; else lo = row.n + 1;
    }
    return lo > last ? null : lo;
  }
  // A kept value's text, for comparing what one copy expects with what this one holds.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // What one envelope from another copy does here: the envelope to apply (or none), and the conflicts it met. A field
  // (or whole record) changed here since is kept as it is here, unless `prefer(here, there)` says the other copy's
  // value wins it: both copies run the same rule over the same two values, so they settle on one without a leader.
  // What one stamped envelope from another copy does here (record-stamps.mjs): merged field by field, the later stamp
  // kept, so every copy that has met the same changes holds the same state whatever order they came in. A field that
  // both copies changed from different values (the envelope's `was` or `prior` is not what is held here) is a conflict,
  // and both versions are kept apart; the stamps alone say which one stays. Answers the envelope to write (its own
  // stamps kept, so copies after this one merge it the same way), or null when it changes nothing here.
  function mergeFrom(envelope, conflicts) {
    envelope = shareEnvelope(envelope);
    const held = keptOrRemoved(envelope.id);
    const after = keptFrom(merge(stateOf(held), stateFrom(envelope, envelope.at), tieByContent));
    const here = held && held.type !== null ? held : null;
    const type = here?.type ?? envelope.type ?? null;
    // The later of the two writes that met: every copy that meets the same two stamps the versions it keeps apart alike.
    const met = held?.meta?.at && held.meta.at > envelope.at ? held.meta.at : envelope.at;
    if (envelope.remove || envelope.value !== undefined) {
      const there = envelope.remove ? null : { type: envelope.type, value: envelope.value };
      const now = here ? { type: here.type, value: here.value } : null;
      if ('prior' in envelope && !same(now, envelope.prior) && !same(now, there)) {
        const kept = after && after.type !== null ? { type: after.type, value: after.value } : null;
        if (now && there && now.type === there.type) {
          // The same kind of record on both: the fields that differ are the conflict, each kept apart on its own.
          const prior = envelope.prior?.type === now.type ? envelope.prior.value : {};
          for (const field of new Set([...Object.keys(now.value), ...Object.keys(there.value)])) {
            if (same(now.value[field], there.value[field]) || same(now.value[field], prior[field])) continue;
            conflicts.push({ id: envelope.id, type, field, reason: 'changed_here', here: now.value[field] ?? null, there: there.value[field] ?? null, before: prior[field] ?? null, kept: same(kept?.value?.[field], there.value[field]) ? 'there' : 'here', at: met });
          }
        } else {
          conflicts.push({ id: envelope.id, type, field: null, reason: 'changed_here', here: now, there, before: envelope.prior, kept: same(kept, there) ? 'there' : 'here', at: met });
        }
      }
    } else if (envelope.was) {
      for (const field of [...Object.keys(envelope.set ?? {}), ...(envelope.unset ?? [])]) {
        const there = (envelope.unset ?? []).includes(field) ? undefined : envelope.set[field];
        const now = here?.value[field];
        const expected = field in envelope.was ? envelope.was[field] : undefined;
        if (same(now, there) || same(now, expected)) continue;
        conflicts.push({ id: envelope.id, type, field, reason: 'changed_here', here: now ?? null, there: there ?? null, before: expected ?? null, kept: same(after?.value?.[field], there) ? 'there' : 'here', at: met });
      }
    }
    // A conflict whose winner is already held here changes nothing here, but it is still answered and kept apart.
    if (sameKept(held && held.meta ? { type: held.type, value: held.value, meta: held.meta } : null, after)) return null;
    const { was, prior, added, ...change } = envelope;
    return change;
  }
  function changeFrom(envelope, conflicts, prefer) {
    envelope = shareEnvelope(envelope);
    const now = kept(envelope.id);
    if (envelope.remove || envelope.value !== undefined) {
      if (!('prior' in envelope)) { conflicts.push({ id: envelope.id, field: null, reason: 'no_basis' }); return null; }
      const after = envelope.remove ? null : { type: envelope.type, value: envelope.value };
      const held = now ? { type: now.type, value: now.value } : null;
      if (same(held, after)) return null;
      if (!same(held, envelope.prior)) {
        const wins = prefer(held, after);
        conflicts.push({ id: envelope.id, type: held?.type ?? after?.type, field: null, reason: 'changed_here', here: held, there: after, before: envelope.prior, kept: wins ? 'there' : 'here' });
        if (!wins) return null;
      }
      return envelope.remove ? { id: envelope.id, remove: true } : { id: envelope.id, type: envelope.type, value: envelope.value };
    }
    if (!envelope.was) { conflicts.push({ id: envelope.id, field: null, reason: 'no_basis' }); return null; }
    if (now && now.type !== envelope.type) { conflicts.push({ id: envelope.id, type: now.type, field: null, reason: 'changed_here', here: { type: now.type, value: now.value }, there: { type: envelope.type }, kept: 'here' }); return null; }
    const set = {};
    const unset = [];
    for (const field of [...Object.keys(envelope.set ?? {}), ...(envelope.unset ?? [])]) {
      const removing = (envelope.unset ?? []).includes(field);
      const after = removing ? undefined : envelope.set[field];
      const expected = field in envelope.was ? envelope.was[field] : undefined;
      const held = now?.value[field];
      if (same(held, after)) continue;
      if (!same(held, expected)) {
        // A field on a record removed here stays removed: the record is not made again from one field of it.
        const wins = now !== null && prefer(held ?? null, after ?? null);
        conflicts.push({ id: envelope.id, type: envelope.type, field, reason: 'changed_here', here: held ?? null, there: after ?? null, before: expected ?? null, kept: wins ? 'there' : 'here' });
        if (!wins) continue;
      }
      if (removing) unset.push(field); else set[field] = after;
    }
    if (!Object.keys(set).length && !unset.length) return null;
    return { id: envelope.id, type: envelope.type, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
  }

  // The versions a conflict met, kept as one record per contested record (`<type>:<record id>`), one field per version:
  // the field's name is the contested field (or * for the whole record) and a checksum of the version, so two copies
  // that met the same conflict write the same fields and every later fork only adds fields, never replaces one.
  function keptApart(conflicts, type) {
    const byRecord = new Map();
    const stampOf = new Map();
    for (const conflict of conflicts) {
      if (conflict.reason !== 'changed_here' || conflict.type === type) continue;
      const id = `${type}:${conflict.id}`;
      if (!byRecord.has(id)) byRecord.set(id, {});
      if (conflict.at && !(stampOf.get(id) >= conflict.at)) stampOf.set(id, conflict.at);
      for (const version of [conflict.here, conflict.there]) {
        const text = JSON.stringify(version ?? null);
        const [a, b] = textHash(text);
        const key = `${conflict.field ?? '*'}|${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
        byRecord.get(id)[key] = { record: conflict.id, record_type: conflict.type ?? null, field: conflict.field, value: version ?? null };
      }
    }
    const out = [];
    for (const [id, versions] of byRecord) {
      // Stamped by the writes that met, each version is one field set the same way on every copy that met them.
      if (stampOf.has(id)) { out.push({ id, type, set: versions, at: stampOf.get(id) }); continue; }
      const held = kept(id);
      const set = Object.fromEntries(Object.entries(versions).filter(([key]) => !(held && held.type === type && key in held.value)));
      if (Object.keys(set).length) out.push(held && held.type === type ? { id, type, set } : { id, type, value: { ...(held?.type === type ? held.value : {}), ...set } });
    }
    return out;
  }

  // Every call, at any depth of the interface (the field reads included), first brings a stale projection up to the
  // log; while it is current that is one boolean read. Batch member metadata owns its validation/empty fast path
  // before that replay and explicitly restores a stale projection before consuming any nonempty read.
  const stayingCurrent = api => Object.fromEntries(Object.entries(api).map(([name, item]) => [name,
    typeof item === 'function' ? function call(...args) { if (!current && name !== 'memberFieldsMany' && name !== 'changeMark' && (name !== 'forgetCached' || typeof host.rebuild !== 'function')) rebuild(); return item.apply(this, args); }
      : item && typeof item === 'object' && !Array.isArray(item) ? stayingCurrent(item) : item]));

  return stayingCurrent({
    ...listOps,
    /** Opt this store into shared members for append-only collections. Both copies use the same representation. */
    shareFields(type, { limit = 32 } = {}) {
      if (typeof type !== 'string' || !type || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('Shared collections need a type and a page limit from 1 to 256.');
      try {
        return transaction(() => {
          inStep();
          if (!sharedFieldTypes.has(type)) {
            sharedFieldTypes.add(type);
            keys.meta.set('shared_field_types', [...sharedFieldTypes]);
          }
          const mark = `shared_fields:${type}`;
          const state = keys.meta.get(mark) ?? { after: null, done: false };
          if (state.done) return { more: false };
          const prefix = typeKey(type, '');
          let after = state.after, read = 0;
          // Visit keys without opening old losing values. Each oversized current value is migrated by streaming.
          for (const key of keys.walkKeys(after === null ? prefix : `${typeKey(type, after)}${SEP}`, `t${SEP}${type}${AFTER}`)) {
            const id = key.slice(prefix.length);
            const found = kept(id);
            if (found && JSON.stringify(found.value).length > 4_000_000) shareStoredFields(id);
            after = id;
            if (++read >= limit) break;
          }
          const more = read >= limit;
          writeOut(applied);
          keys.meta.set(mark, { after, done: !more });
          return { more };
        });
      } catch (error) {
        if (typeof host.rebuild === 'function') forgetCached(error);
        else { try { replay(); } catch { /* preserve the original failure; a later call retries */ } }
        throw error;
      }
    },
    /** Every shared member referenced by legacy wire changes is kept durably, even an old removed version. */
    sharedChanges(rows) {
      if (!rows.length || !sharedFieldTypes.size) return rows;
      let converted;
      writing(contextOf({ actor: { by: 'shared-members' } }), () => {
        converted = rows.map(row => ({ ...row, envelopes: row.envelopes.map(shareEnvelope) }));
        return [];
      }, { applied_already: true });
      return converted;
    },
    forgetCached,
    /** Where this store's changes stand now: a caller takes it where its transaction begins and gives it to
     *  forgetCached(error, mark) if that transaction fails. */
    changeMark: markNow,
    /** Keep dependent record batches together; rebuild projections if the host rolls back. */
    atomically(work) {
      const mark = markNow();
      try { return transaction(work); }
      catch (error) { try { forgetCached(error, mark); } catch { /* preserve the original failure */ } throw error; }
    },
    /** How much this store holds in memory now. */
    held: () => ({ shared: sharedCache.size, shared_bytes: sharedCacheBytes, member_projections: memberCache.size, member_projection_bytes: memberCacheBytes, selections: selectionCache.size, selection_bytes: selectionCacheBytes, keys: keys.held(), slots: slots.held(), opened: opened.size, opened_bytes: openedBytes, log_applied: applied }),
    /** Write whole root records: [{ id, type, value }], value null to remove. One transaction, one log row. */
    write(records, context = {}) {
      // Build the actual ordered envelopes first: no-op writes do not change the declaration winner. Validate against
      // that final state before commit, so a refusal leaves no persisted write and cannot mutate the live model.
      return writing(contextOf(context), shared => {
        const entries = records.map(record => {
          const { id, type, value } = record;
          if (typeof id !== 'string' || !id || id.includes('/') || id.includes(SEP)) throw new Error(`A record id must be text without "/": ${id}`);
          return { record, envelope: envelopeFor(id, type, value === null ? null : sealFields(id, type, value), shared) };
        });
        const effective = modelForWrite(entries);
        for (const { record: { id, type, value } } of entries) if (value !== null && typeof id === 'string') checkModel(id, type, value, effective);
        return entries.flatMap(({ envelope }) => envelope ? [envelope] : []);
      }, { prior: records.flatMap(({ id }) => (typeof id === 'string' && id && !id.includes('/') && !id.includes(SEP) ? [id] : [])) });
    },
    /** The fields `type` keeps sealed (erasable.mjs). */
    erasableFields: type => [...erasableOf(type)],
    // Resolve the actual model-declared owner of inherited words, without
    // copying keys or accepting a caller-supplied owner. Cycles fail closed.
    erasureOwnerOf(id, observeOwner = null) {
      if(observeOwner!==null&&(typeof observeOwner!=='function'||observeOwner.constructor?.name==='AsyncFunction'))
        throw new TypeError('Inherited owner observation must be a trusted synchronous callback.');
      inStep();const seen=new Set();let owner=id;
      const original=kept(id);if(!original?.type||!original.value||erasing.erased(id))return null;
      const sealed=[...new Set(erasableOf(original.type).map(field=>fieldAt(original.value,pathOf(field))).filter(isSealed).map(item=>keyIdOf(id,item)))];
      if(sealed.length>1)throw new Error('Inherited words have distinct physical erasure owners.');
      const physicalOwner=sealed[0]??keyIdFor(original.type,id,original.value);
      for(let depth=0;depth<64;depth++){
        if(seen.has(owner))throw new Error('Inherited erasure ownership is cyclic.');seen.add(owner);
        if(observeOwner&&observeOwner(owner)!==undefined)throw new TypeError('Inherited owner observation must return no value.');
        const row=kept(owner);if(!row?.type||!row.value||erasing.erased(owner))return null;
        const parent=keyIdFor(row.type,owner,row.value);
        if(parent===owner)return erasableOf(row.type).length&&!erasing.erased(physicalOwner)&&erasing.keyOf(physicalOwner)?physicalOwner:null;
        owner=parent;
      }
      throw new Error('Inherited erasure ownership exceeds its bounded chain.');
    },
    /** Whether this store's SQLite overwrites an erased key's bytes (secure_delete), as the host granted it. */
    secureDelete: () => erasing.secureDelete,
    /** What a copy needs to open these records: { id: key | null (erased) } (record-sync.mjs carries it beside rows). */
    // With the keys of the records whose words theirs are (a sealed field names whose key: erasable.mjs invariant 3a).
    erasureKeys(ids, { from_page = null } = {}) {
      inStep();
      const proof = from_page && copiedOwnerPages?.get(from_page);
      if (proof) copiedOwnerPages.delete(from_page);
      // The identity and immutable ID list are supplied by this owner, never by row payloads.
      // A forged, edited, stale or already consumed page takes the ordinary current-root path.
      const owners = new Set(ids);
      const authentic = proof && ids.length === proof.ids.length && ids.every((id, at) => id === proof.ids[at]);
      if (authentic) {
        for (const owner of proof.owners) owners.add(owner);
      } else {
        consumeRawRoots(ids, (id, record) => {
          for (const owner of sealedOwners(id, record?.value)) owners.add(owner);
        }, { preserveBudgetProgress: true });
      }
      const previous = copiedKeyRoots;
      copiedKeyRoots = authentic ? proof.root_keys : null;
      try { return erasing.keysFor([...owners]); } finally { copiedKeyRoots = previous; }
    },
    /** Keys and erasures another copy sent; a record erased there is erased here too, at once, as erase() does it
     *  (removed here first, so the copy it came from finds nothing its removal would replace, never a conflict that
     *  would keep this copy's words apart), and not sent back (from_leader). */
    takeErasureKeys(sent) {
      return transaction(() => {
        const erased = erasing.take(sent);
        const write = (records, context) => this.write(records, context);
        for (const { id, fields } of erased) eraseHere(id, [...new Map([...fields, ...erasureFieldsOf(typeOf(id))]
          .map(field => [JSON.stringify(pathOf(field)), field])).values()], write, { actor: { by: 'erasure', from_leader: true } });
        return erased.map(({ id }) => id);
      });
    },
    /**
     * Erases one record, at once: its key is deleted (every sealed copy of its erasable fields, in every row, page, copy
     * and archive line, no longer opens), it is removed, and its versions in the key space are rewritten. Rows kept
     * before its fields were erasable that still hold them as words are rewritten by idle work (scrubStep, from
     * maintain); `erasure(id)` says how far that is. Answers { erased, also: [ids erased with it], scrub: 'scrubbing' |
     * 'archives' | 'done' }. A record whose kind declares no erasable field is refused (code not_erasable), naming its
     * kind; one already erased answers how far its erasure is, so asking again is how its progress is read.
     */
    erase(id, context = {}) {
      const asked = typeOf(id);
      if (asked === null) {
        if (erasing.erased(id)) return { erased: id, also: [], scrub: this.erasure(id) ?? 'done' };
        throw Object.assign(new Error(`There is no record ${id} to erase.`), { code: 'not_found' });
      }
      if (!erasureFieldsOf(asked).length) throw Object.assign(new Error(`${asked} records keep no words that can be erased, so ${id} cannot be erased.`), { code: 'not_erasable', kind: asked });
      return transaction(() => {
        const write = (records, how) => this.write(records, how);
        const erased = [];
        const seen = new Set();
        const waiting = [{ id, type: typeOf(id) }];
        while (waiting.length) {
          const next = waiting.shift();
          if (seen.has(next.id)) continue;
          seen.add(next.id);
          const type = typeOf(next.id) ?? next.type;
          const fields = erasureFieldsOf(type);
          if (!fields.length) continue;
          const found = kept(next.id);
          const value = found ? found.value : null;
          waiting.push(...erasedWith(next.id, type, value));
          eraseHere(next.id, fields, write, context);
          erased.push(next.id);
        }
        return { erased: id, also: erased.filter(other => other !== id), scrub: erased.length ? 'scrubbing' : 'done' };
      });
    },
    /** How far one erasure is: 'scrubbing' (old rows still being read), 'archives' (the host's kept files), 'done', or null. */
    erasure(id) {
      const phase = erasures.phaseOf(id);
      return phase === null ? null : phase === 'rows' ? 'scrubbing' : phase;
    },
    /** For an erasure's readback (src/erasure-check.mjs): how many versions of the record the key space still holds
     *  that pass `holds` (the caller's test of the words, which never reach the store's state). */
    erasureHeld: (id, holds) => keys.versions(idKey(id)).filter(version => holds(version)).length,
    /** How many versions in the key space still keep the record's key: its own entry (`e|`) and its record entry's. */
    erasureKeysHeld: id => keys.versions(keyHolderKey(id)).length + keys.versions(idKey(id)).filter(version => Array.isArray(version) && version[4]).length,
    /** The log's tables, oldest first: the sealed generations, then the open log. */
    logTables: () => [...sealedLogs(), LOG],
    /** The erasures waiting for their host to rewrite kept history files: [{ id, fields }], a bounded page. */
    erasuresForArchives: (limit = 100) => erasures.waiting('archives', limit),
    /** The host has rewritten every kept history file holding these records. */
    archivesErased: ids => transaction(() => erasures.move(ids, 'done')),
    /** One root record as JSON (a fresh copy), or null. */
    /** One root record as JSON, or null; past the bounds it is refused (RecordTooLarge) unless `bounded` is false (a
     *  host checking a copy it made, never a caller serving the record). */
    read(id, { bounded = true } = {}) {
      const found = readRoot(id, bounded);
      return found ? openFields(id, resolveRead(found.value, id)) : null;
    },
    /** A bounded page at a time, with the same fresh values and refusals as read(id). */
    readMany,
    typeOf,
    typesOf,
    tableSchema(type) { inStep(); return { type, schema: typed.schema(type), complete: !!tableKind(type) && tableComplete(type) }; },
    tableRows(type, options = {}) { inStep(); return { type, rows: typed.rows(type, options), complete: !!tableKind(type) && tableComplete(type) }; },
    tableHistory(options = {}) { inStep(); return typed.schemaHistory(options); },
    backfillTables({ limit = 64 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Table backfill limit must be between 1 and 1000.');
      const mark = markNow();
      try { return transaction(() => buildTables({ limit })); }
      catch (error) { forgetCached(error, mark); throw error; }
    },
    /** Whether this identity has current state, including a retained removal. No record body is resolved. */
    hasState: id => slots.find(id) >= 0 || keys.get(idKey(id)) !== undefined,
    /** What one record holds, counted as a decomposed store would: { rows, bytes }. */
    sizeOf(id) { const found = kept(id); if (!found) return { rows: 0, bytes: 0 }; const { rows, bytes } = found.size; return { rows, bytes }; },
    /** Root ids of one type in id order, optionally within a literal id prefix; with `before` and/or `limit`, the
     *  ids just before `before`, newest first, at most `limit`. */
    ids: idsOfType,
    /**
     * Root records of every type whose words at one of `fields` hold every one of `words`, newest first (in the order
     * each was first written): [{ id, type, title }]. The first field a record holds words at is its title. With no
     * words it answers the newest named records. `leaveOut` names types never answered; `types` names the only ones.
     * Walks each type's records newest first, a page of them at a time, until `limit` are found or `budget` records
     * have been looked at (a request passes one: how much one call may read does not grow with the records held).
     * When it stopped before the end, the answer's `next` (not enumerable, so the list reads as before) is the cursor
     * to pass as `resume` to go on from the record after the last one looked at; it is null when nothing is left.
     */
    find({ words = [], fields: paths, leaveOut = [], types = null, limit = 30, budget = Infinity, resume = null } = {}) {
      if (!Array.isArray(paths) || !paths.length || !paths.every(path => Array.isArray(path) && path.length && path.every(name => typeof name === 'string' && name))) throw new Error('find needs fields: a list of field-name paths');
      const skip = new Set(leaveOut);
      const held = keys.range(typesKey(''), `y${AFTER}`).map(([key]) => key.slice(2));
      const chosen = held.filter(type => !type.includes('/') && !skip.has(type) && (!types || types.includes(type)));
      if (!chosen.length) return [];
      const terms = words.map(word => String(word).toLocaleLowerCase()).filter(Boolean);
      const page = Math.max(1, Math.min(200, Math.floor(Number(limit) || 30)));
      // One cursor per type, walking its records newest first; the newest head across types is taken each time.
      let after = null;
      if (resume !== null && resume !== undefined) {
        try { after = JSON.parse(resume); } catch { /* refused below */ }
        if (!Array.isArray(after) || after.length !== 3 || !after.every(part => typeof part === 'string')) throw new Error('That page of records is no longer available.');
      }
      const looked = Number.isFinite(budget) ? Math.max(1, Math.floor(Number(budget) || 1)) : Infinity;
      const cursors = chosen.map(type => {
        const prefix = `r${SEP}${type}${SEP}`;
        let hi = !after ? `r${SEP}${type}${AFTER}` : type === after[0] ? recordKey(type, after[1], after[2]) : `${prefix}${after[1]}${SEP}`;
        let buffer = [];
        return {
          type,
          peek() {
            if (!buffer.length && hi !== null) {
              buffer = keys.range(prefix, hi, { reverse: true, limit: 64 });
              hi = buffer.length === 64 ? buffer.at(-1)[0] : null;
            }
            return buffer[0] ?? null;
          },
          next() { buffer.shift(); },
        };
      });
      const textAt = (value, path) => {
        const found = atPath(value, path);
        return typeof found === 'string' ? found : null;
      };
      const out = [];
      let examined = 0;
      let last = null;
      const answer = () => Object.defineProperty(out, 'next', { value: last, enumerable: false });
      for (;;) {
        let best = null;
        for (const cursor of cursors) {
          const head = cursor.peek();
          if (head && (!best || head[0].split(SEP)[2] > best.head[0].split(SEP)[2])) best = { cursor, head };
        }
        if (!best) { last = null; break; }
        if (examined >= looked) break;
        best.cursor.next();
        examined += 1;
        const [key, held] = best.head;
        const [, , seq, id] = key.split(SEP);
        last = JSON.stringify([best.cursor.type, seq, id]);
        const value = held === 1 ? kept(id)?.value : held;
        if (value === undefined) continue;
        const texts = paths.map(path => textAt(openFields(id, value), path));
        const matches = texts.some(text => text !== null && text.trim() && terms.every(term => JSON.stringify(text).toLocaleLowerCase().includes(term)));
        if (!matches) continue;
        const title = texts.find(text => text !== null && text.trim());
        out.push({ id, type: best.cursor.type, title: title.replace(/\s+/g, ' ').trim() });
        if (out.length >= page) break;
      }
      return answer();
    },
    /** The data model (invariant 11): every type held or declared, with how many records it has, the kind that declares
     *  it (null, or the id of the record declaring it), its properties (each with the value kind declared for it, or
     *  null, and the value kinds it has held) and its parts (participation roles; a role over a list is an interaction
     *  set). `type` narrows it to one type. `complete` is false while records kept before the model are still being
     *  walked, so a property or part not shown yet is unknown rather than absent. */
    model({ type: only, declaration_only = false, model_budget } = {}) {
      if (declaration_only) {
        if (typeof only !== 'string' || !only) throw new Error('A declaration read names one record type.');
        const { kind, complete } = readDeclaredKind(only, { budget: model_budget });
        return { complete, kinds: [{ type: only, declared_by: kind?.declared_by ?? null }] };
      }
      const types = only !== undefined ? [only]
        : [...new Set([...keys.range(typesKey(''), `y${AFTER}`).map(([key]) => key.slice(2)), ...allKinds().map(kind => kind.type)])].sort();
      return {
        complete: !modelPending(),
        parts_complete: !partsPending(),
        kinds: types.map(type => {
          const kind = kindOf(type);
          const prefix = `k${SEP}${type}${SEP}`;
          const held = new Map();
          for (const [key] of keys.range(prefix, `k${SEP}${type}${AFTER}`)) {
            const [property, kind] = key.slice(prefix.length).split(SEP);
            held.set(property, [...(held.get(property) ?? []), kind]);
          }
          const properties = [...new Set([...Object.keys(kind?.properties ?? {}), ...Object.keys(kind?.guard_properties ?? {}), ...held.keys()])].sort()
            .map(property => ({ property, declared: kind?.properties[property] ?? kind?.guard_properties?.[property] ?? null, ...(kind?.properties[property] === undefined && kind?.guard_properties?.[property] !== undefined ? { checked_in: 'guard' } : {}), seen: held.get(property) ?? [] }));
          // Its indexes: every kind is read by id (i|) and listed by type (t|); a declared field index (the host's DATA,
          // EEAF's IndexInstance) keeps its entries as f| keys of the same pages (its IndexArtifact), built as idle work.
          const fieldIndexes = (declared.get(type) ?? []).map(index => ({ name: index.name, paths: index.paths, ready: indexReady(type, index.name) }));
          return { type, count: counts ? countOf(counts, type) : null, declared_by: kind ? kind.declared_by ?? 'model' : null, properties, parts: kind?.parts ?? [],
            indexes: [{ name: 'id', paths: [['id']], ready: true }, { name: 'type', paths: [['type']], ready: true }, ...fieldIndexes] };
        }).filter(kind => kind.declared_by !== null || kind.count !== 0 || kind.properties.length),
      };
    },
    /** One record as attribute facts: its type, and every value it holds at its path ([field], or [field, ordinal,
     *  field] inside a list of objects), with its value kind and, for a top-level property, the kind declared for it. */
    factsOf(id, { narrow_model = false, model_budget } = {}) {
      const found = readRoot(id);
      if (!found) return null;
      const declaration = narrow_model ? readDeclaredKind(found.type, { budget: model_budget }) : { kind: kindOf(found.type), complete: true };
      const kind = declaration.kind;
      return { id, type: found.type, facts: factsOf(found.value, follow).map(fact => ({ ...fact, declared: fact.path.length === 1 ? kind?.properties[fact.path[0]] ?? null : null })), ...(narrow_model ? { complete: declaration.complete } : {}) };
    },
    /** What one record holds by its kind's parts: [{ role, id, ordinal }] (a list's members in order). */
    partsOf(id, { narrow_model = false, model_budget } = {}) {
      const found = readRoot(id);
      if (!found) return null;
      const declaration = narrow_model ? readDeclaredKind(found.type, { participation: true, budget: model_budget }) : { kind: kindOf(found.type), complete: true };
      return { id, type: found.type, parts: partsOf(declaration.kind, found.value, follow), ...(narrow_model ? { complete: declaration.complete, declaration_issues: declaration.issues } : {}) };
    },
    /** The members of one interaction set: the ids a record holds under `role`, in order. */
    membersOf(id, role) {
      const found = readRoot(id);
      if (!found) return [];
      return partsOf(kindOf(found.type), found.value, follow).filter(part => part.role === role).map(part => part.id);
    },
    /** The interaction sets one record holds: [{ set, role, members }], each named by its members in order. */
    setsOf(id, { narrow_model = false, model_budget } = {}) {
      const found = readRoot(id);
      if (!found) return null;
      const declaration = narrow_model ? readDeclaredKind(found.type, { participation: true, budget: model_budget }) : { kind: kindOf(found.type), complete: true };
      // A set names the entire ordered membership. Partial participation may
      // still expose exact absolute parts, but must not mint a subset's hash as
      // though that were the retained whole set (including dynamic roles).
      return { id, type: found.type, sets: declaration.complete ? setsOf(partsOf(declaration.kind, found.value, follow), setHash) : [], ...(narrow_model ? { complete: declaration.complete, declaration_issues: declaration.issues } : {}) };
    },
    /** One interaction set by its name: its members in order and the records holding it, each under its role (one range
     *  of `s|set|...` keys, each holder checked against the record it names), or null when nothing holds it now. */
    set(name, { limit = 100 } = {}) {
      const prefix = `s${SEP}${name}${SEP}`;
      const most = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
      const holders = [];
      let members = null;
      for (const [key] of keys.range(prefix, `s${SEP}${name}${AFTER}`, { limit: most * 4 })) {
        const [holder, role] = key.slice(prefix.length).split(SEP);
        const found = kept(holder);
        const held = found && setsOf(partsOf(kindOf(found.type), found.value, follow), setHash).find(item => item.role === role && item.set === name);
        if (!held) continue;
        members ??= held.members;
        holders.push({ id: holder, type: found.type, role });
        if (holders.length >= most) break;
      }
      return members ? { set: name, members, holders, complete: !partsPending() } : null;
    },
    /** What holds `id` (participation read the other way: what it is inside): [{ id, type, role, ordinal }], holders in id
     *  order after `after`, at most `limit` before finishing the last whole holder, of `role` only when named. One raw
     *  key page bounds candidates before filtering. Even a holder spanning that page is read only once: its current
     *  parts answer the whole holder, so `next` remains a holder id and never loses an ordinal. A page may contain no
     *  matching holders and still have `next`. `complete` describes the model index, independently of pagination. */
    holdersOf(id, { role, after, limit = 100, narrow_model = false, model_budget = { reads: 128, bytes: bounds.bytes } } = {}) {
      const prefix = `p${SEP}${id}${SEP}`;
      const lo = after === undefined ? prefix : `${prefix}${after}${AFTER}`;
      const most = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
      const budget = Math.max(256, most * 4), hi = `p${SEP}${id}${AFTER}`;
      const page = keys.range(lo, hi, { limit: budget + 1 });
      const groups = [];
      for (const [key] of page.slice(0, budget)) {
        const [holder, held] = key.slice(prefix.length).split(SEP);
        if (groups.at(-1)?.id !== holder) groups.push({ id: holder, roles: new Set() });
        groups.at(-1).roles.add(held);
      }
      const tailHolder = page.length > budget ? page[budget][0].slice(prefix.length).split(SEP)[0] : null;
      const holders = [], kinds = new Map();
      let last = null, stopped = false, bytes = 0, declarationsComplete = true;
      const byteBudget = Math.min(bounds.bytes, 2 * 1024 * 1024);
      for (const group of groups) {
        if (holders.length >= most) { stopped = true; break; }
        // A complete group with no requested role needs no record body. When
        // the page ends inside a group, current parts settle all of its roles.
        if (role !== undefined && !group.roles.has(role) && group.id !== tailHolder) { last = group.id; continue; }
        const found = kept(group.id);
        if (found) {
          withinBounds(group.id, found.value, found.size);
          if (bytes && bytes + found.size.bytes > byteBudget) { stopped = true; break; }
          bytes += found.size.bytes;
          if (!kinds.has(found.type)) kinds.set(found.type, narrow_model
            ? readDeclaredKind(found.type, { participation: true, budget: model_budget })
            : { kind: kindOf(found.type), complete: true });
          const declaration = kinds.get(found.type);
          declarationsComplete = declarationsComplete && declaration.complete;
          const current = partsOf(declaration.kind, found.value, follow);
          const selected = [...new Map(current.filter(part => part.id === id && (role === undefined || part.role === role))
            .map(part => [holderKey(id, group.id, part.role, part.ordinal), part])).entries()]
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, part]) => part);
          const sets = new Map(declaration.complete && selected.some(part => part.ordinal !== null)
            ? setsOf(current, setHash).map(item => [item.role, item.set]) : []);
          for (const part of selected) {
            const inSet = part.ordinal === null ? null : sets.get(part.role);
            holders.push({ id: group.id, type: found.type, role: part.role, ordinal: part.ordinal, ...(inSet ? { set: inSet } : {}) });
          }
        }
        last = group.id;
      }
      // Seek beyond the whole last holder, including a group cut by the raw
      // key budget. The old opaque value remains the exact holder id.
      const next = last !== null && (stopped || page.length > budget)
        && keys.hasRange(`${prefix}${last}${AFTER}`, hi) ? last : null;
      // Operational callers keep the original full model contract, including
      // the persisted completed walk after a restart. Only inspection opts in
      // to the bounded declaration view and its explicit cold uncertainty.
      return { holders, next, complete: declarationsComplete && !(narrow_model ? partsPendingForRead() : partsPending()), examined: Math.min(page.length, budget) };
    },
    /** Entries of a declared field index (see scan). */
    scan,
    scanFirstValues,
    scanSelectedValues,
    indexDeclared: (type, name) => Boolean(indexNamed(type, name) || tableKind(type)?.indexes?.some(index => index.name === name)),
    indexReady,
    indexCovered,
    /** One entry per distinct first value of a declared two-path index: the one with the largest second value. */
    lastPerGroup,
    /** The field reads (fieldsOf, after, newestPerGroup, idsWhere) over this store's records. */
    fields,
    /** How many root records of each type are held: [{ type, n }], largest first, from the exact kept counts. */
    // null means the bounded upgrade is still building, never a guessed zero.
    count(type) { inStep(); return counts ? countOf(counts, type) : null; },
    /** Exact selected counts at one current log position; unknown counts remain null during upgrade. */
    countMany(types) {
      inStep();
      return new Map([...new Set(types)].map(type => [type, counts ? countOf(counts, type) : null]));
    },
    countsByType() {
      inStep();
      return keys.range(typesKey(''), `y${AFTER}`).map(([key]) => key.slice(2))
        .map(type => {
          if (counts !== null) return { type, n: countOf(counts, type) };
          // An older projection has no kept counts yet. Preserve its exact diagnostic answer without
          // collecting hundreds of thousands of IDs into one array while the bounded count build runs.
          let n = 0;
          for (const key of keys.walkKeys(typeKey(type, ''), `t${SEP}${type}${AFTER}`)) n += 1;
          return { type, n };
        }).filter(row => row.n).sort((a, b) => b.n - a.n);
    },
    /** Writes the memtable out now (it is otherwise written when full), recording how far the log it covers. */
    checkpoint() { transaction(() => { inStep(); writeOut(applied); }); },
    /** One bounded merge of written runs and nothing else: maintain also walks the checksum, the indexes and the model, which
     *  held a device's copy of 1,342 runs at 3 GB. Answers { merged, more, due, pages, runs }; `runs` is how many are left and
     *  `due` whether the store would merge more on its own rules (more alone stays true after the last merge). */
    mergeRuns({ max_pages = MAINTENANCE_TURN_PAGES, max_input_pages = MAINTENANCE_TURN_INPUT_PAGES } = {}) {
      const step = keys.step({ max_pages, max_input_pages });
      return { merged: Boolean(step.merged), more: Boolean(step.more), due: keys.mergeDue(), pages: step.pages ?? 0, runs: keys.summary().runs };
    },
    /** Idle work, bounded: writes a full memtable out, then merges written runs until `max_pages` pages are written
     *  (WAKE_PAGES when left out). A scheduler may also supply `left()` so successive merge steps yield within its
     *  stage budget; one transaction still completes before its cursor advances. Answers { merged, more }. */
    maintain(options, now = Date.now()) {
      const started = performance.now();
      let flushedMs = 0;
      const stageLeft = typeof options?.left === 'function' ? options.left : null;
      const hasTime = () => !stageLeft || stageLeft() > 0;
      if (hasTime() && keys.full()) {
        const flushStarted = performance.now();
        transaction(() => { inStep(); writeOut(applied); });
        flushedMs = performance.now() - flushStarted;
      }
      // Merging normally gets first admission and the checksum waits until no merge is due: every record the build walks is a read
      // through every run, so on a store left with 200 runs a page of the build read about 1.4M pages and took four
      // minutes of CPU (the owner's store, 2026-10-06), while after the merges it reads a few.
      // The wake's budget is pages written, across as many merges as fit: merging copies page text without parsing
      // values (about half a millisecond a page), and a budget of a couple of pages a wake let runs pile up faster than
      // they merged (142 runs on the owner's store, 2026-10-06), which every read then probed.
      let left = options?.max_pages ?? WAKE_PAGES;
      // A cold, many-run merge can spend far more per output page than the usual half millisecond. Keep each
      // transaction small enough to check the scheduler clock before starting another one.
      const stepPages = () => stageLeft ? Math.min(left, 64) : left;
      let merging = { merged: false, more: true, pages: 0 };
      let pages = 0, steps = 0, mergedMs = 0;
      const merge = () => {
        const mergeStarted = performance.now();
        const canStartMerge = hasTime();
        merging = canStartMerge ? keys.step({ max_pages: stepPages(), max_input_pages: options?.max_input_pages ?? null, hasTime }) : merging;
        pages += merging.pages;
        steps += canStartMerge ? 1 : 0;
        left -= merging.pages;
        while (merging.more && left > 0 && (merging.merged || merging.pages > 0) && hasTime()) {
          merging = keys.step({ max_pages: stepPages(), max_input_pages: options?.max_input_pages ?? null, hasTime });
          pages += merging.pages;
          steps += 1;
          left -= merging.pages;
        }
        mergedMs = performance.now() - mergeStarted;
      };
      let checksummedMs = 0;
      let known = sums !== null;
      let indexesReady = [];
      let modelWalk = null;
      let filling = null;
      let tableWalk = null;
      let scrubbing = null;
      // These projections are independent. In particular, model/index upgrades must not keep a large run
      // unfiltered while repeatedly reading it. Each gets one bounded slice under the same stage deadline.
      // Persist the next first choice so repeated short wakes and cold resets cannot starve later tasks.
      const tasks = [
        { due: () => keys.fillDue(), run: () => { filling = keys.fillFilters({ max_pages: Math.min(keys.settings.fill_pages, 64), hasTime }); } },
        // Keep the full checksum walk's existing merge-first cost guard.
        { due: () => sums === null && !keys.mergeDue(), run: () => {
          const began = performance.now();
          known = transaction(() => buildSums(Math.min(checksum_page, MODEL_PAGE), hasTime));
          checksummedMs = performance.now() - began;
        } },
        { due: () => bucketDirectoryPending(), run: () => {
          try { transaction(() => buildBucketDirectory(hasTime)); }
          catch (error) { invalidateProjection('transaction-failed', error); throw error; }
        } },
        { due: () => indexesPending(), run: () => {
          const group = nextIndexBuild();
          if (!group) return;
          // This admission cursor precedes the group's transaction: even a
          // failed slice cannot monopolize every later wake after a restart.
          keys.meta.set('index_build_last', group.key);
          try { indexesReady = transaction(() => buildIndexes(group, hasTime)); }
          catch (error) { invalidateProjection('transaction-failed', error); throw error; }
        } },
        { due: () => modelPending(), run: () => { modelWalk = transaction(() => buildModel(hasTime)); } },
        { due: () => !!nextPendingTable(), run: () => { tableWalk = transaction(() => buildTables({ hasTime })); } },
        { due: () => historyCopyPending(), run: () => { transaction(() => copySchemaHistory()); } },
        { due: () => erasureDeclarationPending(), run: () => { transaction(() => advanceErasureDeclaration((records, context) => this.write(records, context))); } },
        { due: () => scrubDue(), run: () => { scrubbing = transaction(() => scrubStep({ hasTime })); } },
      ];
      const projections = () => {
        if (!hasTime()) return;
        const saved = keys.meta.get('maintenance_next');
        const first = Number.isInteger(saved) && saved >= 0 && saved < tasks.length ? saved : 0;
        for (let offset = 0; offset < tasks.length && hasTime(); offset += 1) {
          const position = (first + offset) % tasks.length;
          const task = tasks[position];
          if (!task.due()) continue;
          // Advance before starting; an interrupted task cannot permanently monopolize the next admission.
          keys.meta.set('maintenance_next', (position + 1) % tasks.length);
          task.run();
        }
      };
      // A long merge may consume every short wake, or remain due indefinitely.
      // Rotate admission between it and the existing bounded projection classes.
      // Save before entering a phase, so deadlines and failed slices cannot pin
      // the next cold wake to the same phase. Completed merges still run first
      // on ordinary wakes whose budget fits both phases.
      const first = keys.meta.get('maintenance_phase_next') === 'projections' ? 'projections' : 'merge';
      const phases = { merge, projections };
      for (const name of first === 'merge' ? ['merge', 'projections'] : ['projections', 'merge']) {
        if (!hasTime()) break;
        keys.meta.set('maintenance_phase_next', name === 'merge' ? 'projections' : 'merge');
        phases[name]();
      }
      return {
        ...merging,
        more: merging.more || !known || bucketDirectoryPending() || indexesPending() || modelPending() || keys.fillDue() || !!nextPendingTable() || erasureDeclarationPending() || scrubDue(),
        indexes_ready: indexesReady,
        diagnostics: {
          duration_ms: Math.round(performance.now() - started),
          kept: keys.summary(),
          flushed_ms: Math.round(flushedMs),
          merged_ms: Math.round(mergedMs),
          checksummed_ms: Math.round(checksummedMs),
          pages,
          steps,
          ...(modelWalk ? { model_walk: modelWalk } : {}),
          ...(filling ? { filter_pages: filling.pages } : {}),
          ...(tableWalk ? { table_walk: tableWalk } : {}),
          ...(scrubbing ? { erasure_scrub: scrubbing } : {}),
        },
      };
    },
    /** When idle work is next due: now for a full memtable or other idle work, else null. */
    maintenanceAt: (now = Date.now()) => (keys.full() || keys.mergeDue() || sums === null || bucketDirectoryPending() || indexesPending() || modelPending() || keys.fillDue() || !!nextPendingTable() || erasureDeclarationPending() || scrubDue() ? now : null),
    /**
     * Brings records in from another store without logging them (they are already that store's history): each
     * { id, type, value, seq } is kept as written then, at `seq` (its place in that store's order, which must sort before
     * every seq this store makes itself). Written out when the memtable is full; `progress` (any JSON) is recorded with
     * each write-out so a bring-in resumes where its last write-out ended.
     */
    load(records, progress) {
      transaction(() => {
        inStep();
        for (const { id, type, value, seq } of records) {
          if (typeof id !== 'string' || !id || id.includes(SEP)) throw new Error(`A record id must be text: ${id}`);
          const shared = new Map();
          const stored = value === null ? null : storedForm(type, value, shared);
          for (const [sharedId, item] of shared) if (!kept(sharedId)) setRecord(sharedId, item.type, seq, item.value, null);
          const before = kept(id);
          if (stored === null) { if (before) removeRecord(id, before); continue; }
          setRecord(id, type, before && before.type === type ? before.seq : seq, stored, before);
          forgetShared(id);
        }
        if (keys.full()) { writeOut(applied); keys.meta.set('load_progress', progress); }
      });
    },
    /** Writes everything brought in so far and records `progress` with it. */
    loadDone(progress) { transaction(() => { writeOut(applied); keys.meta.set('load_progress', progress); }); },
    /** The progress the last write-out of a bring-in recorded, or undefined. */
    loadProgress: () => keys.meta.get('load_progress'),
    /** Every table this store owns. */
    tables: () => [LOG, ...sealedLogs(), ...keys.tables(), ...typed.tables()],
    sealedLogs,
    oldestLogId,
    /** Seals the open log once everything in it is written out: renames it after its first row and opens a fresh one,
     *  in one transaction. Answers the sealed table's name, or null when the log is empty. */
    sealLog() {
      const first = oldestLogId();
      if (first === null) return null;
      const name = `${SEALED_LOG}${first.replace(/[^0-9a-f]/gi, '').toLowerCase()}`;
      transaction(() => {
        inStep();
        // The keys kept beside the open log's rows leave them: the sealed generation (and every file of history made
        // from it) holds none (erasable.mjs invariant 1). Each stays in its record's entry, written out below.
        sql.exec(`UPDATE ${LOG} SET keys = NULL WHERE keys IS NOT NULL`);
        writeOut(0);
        sql.exec(`ALTER TABLE ${LOG} RENAME TO ${name}`);
        sql.exec(LOG_TABLE_SQL(LOG));
      });
      sealedLogNames = null;
      sealedEnds.clear();
      applied = 0;
      return name;
    },
    sealedLogPage(table, after, limit, maxBytes = null) {
      if (!sealedLogs().includes(table)) throw new Error(`${table} is not a sealed log.`);
      let take = limit;
      if (maxBytes !== null) {
        // Sizes only, read row by row and stopped at the cap. octet_length is answered from each row's header, never its
        // text: CAST(... AS BLOB) loaded every row's whole envelopes, and toArray() took all `limit` of them, so a sealed
        // log of 133 KB rows read ~136 MB to size each 2 MB page (2026-10-14, the founder's full store).
        const sizes = sql.exec(`SELECT 256 + octet_length(envelopes) + octet_length(actor_context) AS estimated_bytes FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, limit);
        take = 0;
        let bytes = 0;
        for (const { estimated_bytes } of sizes) {
          if (take === 0 && estimated_bytes > maxBytes * 4) throw new Error('One record history row is too large to archive in memory.');
          if (take && bytes + estimated_bytes > maxBytes) break;
          take += 1;
          bytes += estimated_bytes;
        }
      }
      if (!take) return { rows: [], last: after, rowids: [] };
      const read = all(`SELECT rowid AS log_rowid, id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, take);
      // rowids[n] is row n's place, so a caller that keeps only the first rows continues after them without reading again.
      return { rows: read.map(({ log_rowid, ...row }) => row), last: read.length ? read.at(-1).log_rowid : after, rowids: read.map(row => row.log_rowid) };
    },
    /** Keeps the history from `at` (a time or a log row id) on in this store, under `name`, until unpin(name): what
     *  moves history out (src/record-history.mjs) leaves every row from the oldest pin on, so the store reads as it
     *  was at any time since. Answers the pinned place. */
    pin(name, at) {
      const position = logPositionOf(at);
      transaction(() => keys.meta.set('pins', { ...(keys.meta.get('pins') ?? {}), [name]: position }));
      return position;
    },
    unpin(name) {
      const { [name]: gone, ...rest } = keys.meta.get('pins') ?? {};
      transaction(() => keys.meta.set('pins', rest));
      return gone !== undefined;
    },
    /** { name: place } for every pin held. */
    pins: () => keys.meta.get('pins') ?? {},
    /** The oldest place a pin holds, or null. */
    oldestPin: () => Object.values(keys.meta.get('pins') ?? {}).sort()[0] ?? null,
    sealedLogKept: table => keys.meta.get(`kept:${table}`) ?? 0,
    keepSealedLogThrough(table, rowid, { reclaim = false } = {}) {
      if (reclaim && !sealedLogs().includes(table)) throw new Error(`${table} is not a sealed log.`);
      transaction(() => {
        const after = reclaim ? keys.meta.get(`kept:${table}`) ?? 0 : 0;
        if (reclaim) {
          if (!Number.isSafeInteger(rowid) || rowid < after) throw new Error('A kept history page must advance its sealed rowid.');
          // Delete before keeping the cursor: even a physically full database
          // can reuse the pages this verified interval frees. The host keeps
          // its archive chain head in the same outer transaction.
          sql.exec(`DELETE FROM ${table} WHERE rowid > ? AND rowid <= ?`, after, rowid);
        }
        keys.meta.set(`kept:${table}`, rowid);
      });
      if (reclaim) sealedEnds.delete(table);
    },
    dropSealedLog(table) {
      if (!sealedLogs().includes(table)) throw new Error(`${table} is not a sealed log.`);
      transaction(() => { sql.exec(`DROP TABLE ${table}`); keys.meta.remove(`kept:${table}`); });
      sealedLogNames = null;
      sealedEnds.delete(table);
    },
    /** Each value one record's field (a path of field names) held, in the order written, from the log still in the
     *  database: [{ value, application_time, system_time, transaction_id, actor }], one entry per change of that value
     *  (a removed record, or a field left out, holds undefined). */
    valuesAt(id, path) {
      let current;
      let had;
      const out = [];
      for (const row of this.log({ record_id: id })) {
        for (const envelope of row.envelopes) {
          if (envelope.id !== id) continue;
          if (envelope.remove) current = undefined;
          else if (envelope.value !== undefined) current = envelope.value;
          else { current = { ...(current ?? {}) }; for (const field of envelope.unset ?? []) delete current[field]; Object.assign(current, envelope.set ?? {}); }
          const value = path.reduce((at, field) => (isObject(at) ? at[field] : undefined), current);
          const text = JSON.stringify(value);
          if (text === had) continue;
          had = text;
          out.push({ value, application_time: row.application_time, system_time: row.system_time, transaction_id: row.transaction_id, actor: JSON.parse(row.actor_context) });
        }
      }
      return out;
    },
    /**
     * One record as it was true at `valid` (application time) by what had been written by `known` (system time): the
     * bitemporal read EEAF's bitemporal_facts gave. It starts from the record as it is and takes back, newest first, every
     * change written after `known` or true only after `valid` (either left out: no bound), each by what it replaced
     * (invariant 9), leaving any field a kept later change set. Each attribute fact carries the valid and system time of
     * the newest kept change that set its top-level field (null when that change is older than the log in the database).
     * A write names when what it says was true with `application_time` (write(records, { application_time })); unnamed,
     * it is the time written. `complete` is false when a change it would take back is no longer in the database or
     * carries nothing to take it back with, `kept_from` then the oldest moment the answer is good for (record-time.mjs
     * readAt's rule). → { id, type, value, facts: [{ path, value, value_kind, valid_time, system_time }], complete, kept_from } or null.
     */
    recordAt(id, { valid = null, known = null } = {}) {
      const kept = (row) => (known === null || row.system_time <= known) && (valid === null || row.application_time <= valid);
      const now = this.storedRecord(id);
      let type = now?.type ?? null;
      let value = now ? structuredClone(now.value) : null;
      const settled = new Set();
      let settledAll = false;
      const setAt = {};
      let complete = true;
      let keptFrom = null;
      const rows = this.log({ record_id: id }).reverse();
      const bound = [valid, known].filter(Boolean).sort()[0] ?? null;
      const oldest = this.logAfter(null, { limit: 0 }).oldest;
      if (bound !== null && oldest !== null && oldest > logPositionOf(bound)) { complete = false; keptFrom = oldest; }
      outer: for (const row of rows) {
        const at = { valid_time: row.application_time, system_time: row.system_time };
        for (const envelope of [...row.envelopes].reverse()) {
          if (envelope.id !== id) continue;
          const touched = envelope.remove || envelope.value !== undefined ? null : [...Object.keys(envelope.set ?? {}), ...(envelope.unset ?? [])];
          if (kept(row)) {
            if (touched === null) {
              if (!settledAll && isObject(envelope.value)) for (const field of Object.keys(envelope.value)) if (!settled.has(field)) setAt[field] = at;
              settledAll = true;
            } else for (const field of touched) if (!settledAll && !settled.has(field)) { setAt[field] = at; settled.add(field); }
            continue;
          }
          if (settledAll) continue;
          if (envelope.remove || envelope.value !== undefined) {
            if (!('prior' in envelope)) { complete = false; keptFrom = row.id; break outer; }
            const keep = Object.fromEntries([...settled].filter(field => isObject(value) && field in value).map(field => [field, value[field]]));
            value = envelope.prior ? { ...structuredClone(envelope.prior.value), ...keep } : (Object.keys(keep).length ? keep : null);
            type = envelope.prior?.type ?? (Object.keys(keep).length ? type : null);
            continue;
          }
          if (!envelope.was && touched.length) { complete = false; keptFrom = row.id; break outer; }
          value = { ...(value ?? {}) };
          for (const field of envelope.added ?? []) if (!settled.has(field)) delete value[field];
          for (const [field, was] of Object.entries(envelope.was ?? {})) if (!settled.has(field)) value[field] = structuredClone(was);
          type = envelope.type ?? type;
        }
      }
      if (value === null) return null;
      const resolved = openFields(id, resolveRead(value));
      return { id, type, value: resolved, facts: factsOf(resolved, follow).map(fact => ({ ...fact, ...(setAt[fact.path[0]] ?? { valid_time: null, system_time: null }) })),
        complete, kept_from: complete ? null : keptFrom };
    },
    /**
     * The order-free checksum of everything held: { root, buckets } (buckets as text, 16 hex characters each). Equal
     * stores have equal roots whatever order their writes came in. A store written before the checksum was kept works it
     * out once here, a page of records at a time.
     */
    /** The id of the newest log row in the database, or null: where a copy's next logAfter starts. */
    lastLogId: () => all(`SELECT id FROM ${LOG} ORDER BY rowid DESC LIMIT 1`)[0]?.id?.split('.')[0] ?? sealedLogs().reverse().map(table => all(`SELECT id FROM ${table} ORDER BY rowid DESC LIMIT 1`)[0]?.id?.split('.')[0]).find(Boolean) ?? null,
    /** One record as kept: { type, value } with content-addressed objects as links, or null (what copies compare). */
    storedRecord(id) { const found = kept(id); return found ? { type: found.type, value: found.value } : null; },
    /** A value as this store would keep it: { value, shared: [{ id, type, value }] } (the content-addressed objects it
     *  links to, which must be kept with it). */
    storedForm(type, value) { const shared = new Map(); const stored = storedForm(type, value, shared); return { value: stored, shared: [...shared].map(([id, item]) => ({ id, ...item })) }; },
    /** A kept value with its links read: what read() answers for it. */
    resolved: (value, recordId = null) => {
      const resolved = resolveRead(value);
      return typeof recordId === 'string' ? openFields(recordId, resolved) : resolved;
    },
    /** The order-free checksum, or { root: null, buckets: null } while it is being built. `build: false` (the side a copy
     *  settles against) answers what is known without walking a page: the build is left to idle work, so a settle stays
     *  cheap however often devices ask. */
    checksum({ build = true } = {}) {
      return (build ? buildSums(checksum_page) : sums !== null) ? { root: sums.root(), buckets: sums.text() } : { root: null, buckets: null };
    },
    /** Every record whose id falls in one of `buckets`, as kept: [{ id, type, value }] (content-addressed objects as
     *  links, which are records of their own). The kept all-head directory selects only requested buckets once its bounded upgrade is ready. */
    recordsInBuckets(buckets) {
      const out = [];
      for (const [id, type, value, meta] of bucketRecords(buckets)) if (value !== undefined) out.push({ id, type, value, ...(meta ? { meta } : {}) });
      return out;
    },
    /**
     * One page of recordsInBuckets in id order after `after`: at most `limit` records, `chars` characters of their
     * values and `examine` ids looked at (matching directory heads once ready, all ID heads during the legacy fallback), so a copy taking a whole store from a large one never holds it all in memory
     * on either side. Answers { records, next } (`next` null once every id was looked at).
     */
    recordsInBucketsPage(buckets, { after = null, limit = 500, chars = 4_000_000, examine = 20_000, key_owners = false } = {}) {
      const records = [];
      const owners = key_owners ? new Set() : null;
      const rootKeys = key_owners ? new Map() : null;
      const answer = next => {
        if (owners) (copiedOwnerPages ??= new WeakMap()).set(records, { ids: records.map(record => record.id), owners: [...owners], root_keys: rootKeys });
        return { records, next };
      };
      let size = 0;
      let looked = 0;
      for (const [id, type, value, meta, rootKey] of bucketRecords(buckets, after)) {
        looked += 1;
        if (value !== undefined) {
          records.push({ id, type, value, ...(meta ? { meta } : {}) });
          size += JSON.stringify(value).length;
          if (owners) {
            for (const owner of sealedOwners(id, value)) owners.add(owner);
            // Keep only detached key metadata, including an authenticated absent inline key.
            rootKeys.set(id, rootKey ? structuredClone(rootKey) : null);
          }
        }
        if (records.length >= limit || size >= chars || looked >= examine) return answer(id);
      }
      return answer(null);
    },
    /**
     * The log rows written after `position` (a log row id, or null for the oldest the database keeps), oldest first, at
     * most `limit`: { rows: [{ id, transaction_id, actor, application_time, system_time, envelopes }], oldest, last }.
     * With `lazy: true`, `rows` is a synchronous iterator that decodes only the transaction being visited; `last`
     * moves as it is consumed and `more` checks later row ids without opening their envelopes. Array callers keep
     * the existing page behavior. `buffer_chars` (a number or a function answering the remaining budget) permits
     * physical read-ahead only when even full-sized parts fit; without it one part is fetched at a time. A transaction
     * stays whole even when its text crosses physical parts or exceeds that budget by itself.
     * `oldest` is the first row id the database still keeps, so a caller asking from before it knows rows are gone
     * (they are in the record history) and settles by checksum instead. Finding the start is a binary search.
     */
    logAfter(position = null, { limit = 200, lazy = false, buffer_chars = 0 } = {}) {
      const tables = [...sealedLogs(), LOG];
      // The oldest row kept: the first row of the first table that holds any (one read, not one per table).
      let oldest = null;
      for (const table of tables) { oldest = all(`SELECT id FROM ${table} ORDER BY rowid LIMIT 1`)[0]?.id ?? null; if (oldest) break; }
      let last = position;
      function* walk() {
        let read = 0;
        let pending = null;
        for (const table of tables) {
          if (read >= limit) break;
          if (position !== null) { const end = endOf(table); if (end === null || end <= position) continue; }
          const from = firstRowAfter(table, position);
          if (from === null) continue;
          let after = from - 1;
          while (read < limit) {
            // Hosts may materialize the SQL result before handing out its cursor. Bound read-ahead by the remaining
            // character budget using the owner's largest physical part; near the boundary read one part so a whole
            // transaction can still finish. Small records batch without admitting an unbounded discarded tail.
            const left = lazy ? Number(typeof buffer_chars === 'function' ? buffer_chars() : buffer_chars) || 0 : 0;
            const physical = lazy ? Math.max(1, Math.min(64, Math.ceil(limit - read), Math.floor(left / LOG_ROW_CHARS))) : 64;
            const batch = all(`SELECT rowid AS n, id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${physical}`, after);
            if (!batch.length) break;
            for (const row of batch) {
              after = row.n;
              if (row.part === 0) pending = { id: row.id, transaction_id: row.transaction_id, actor: JSON.parse(row.actor_context), application_time: row.application_time, system_time: row.system_time, text: [] };
              if (!pending) continue;
              pending.text.push(row.envelopes);
              if (row.part !== row.parts - 1) continue;
              const { text, ...whole } = pending;
              const envelopes = JSON.parse(text.join(''));
              pending = null;
              last = whole.id;
              read += 1;
              yield { ...whole, envelopes };
              if (read >= limit) break;
            }
          }
        }
      }
      if (lazy) return { rows: walk(), oldest, get last() { return last; }, get more() { return tables.some(table => { const end = endOf(table); return end !== null && (last === null || end > last); }); } };
      const rows = [...walk()];
      return { rows, oldest, last };
    },
    /**
     * Applies changes another copy of this store made (log rows from its logAfter), each field only where this copy
     * still holds what the change replaced (its `was` / `prior`): a field already holding the new value is passed over,
     * and a field changed here since is left as it is here and answered as a conflict ({ id, type, field, here, there,
     * before, kept }). Rows written before changes carried what they replaced are conflicts (`no_basis`), never applied
     * blindly. Everything applied is one write here (one log row). Answers { transaction_id, applied, conflicts, written }
     * (written: the ids of every record it changed, the kept-apart ones included).
     *   prefer      (here, there) -> whether the other copy's value wins a conflict (record-sync.mjs byContent: the
     *               same answer on both copies, so they settle on one value with no leader); never, when left out
     *   keep_apart  a record type: every version a conflict met is kept in a record of that type beside the record
     *               (`<type>:<id>`), one field per version, so the version that did not win stays readable
     */
    applyChanges(rows, context = {}, { prefer = () => false, keep_apart = null } = {}) {
      const conflicts = [];
      let applied = 0;
      const result = writing(contextOf(context), () => {
        const out = [];
        for (const row of rows) {
          for (const sent of row.envelopes) {
            const type = sent.type ?? sent.prior?.type ?? typeOf(sent.id);
            // Kept sealed whoever applies it (a copy settling, undo, a layer, kept history put back): only a copy taking
            // the copy it follows keeps what that one holds as it holds it.
            const envelope = context?.actor?.from_leader ? sent : sealArriving(sent, type);
            const change = envelope.at === undefined ? changeFrom(envelope, conflicts, prefer) : mergeFrom(envelope, conflicts);
            if (!change) continue;
            // Applied at once, so a later envelope for the same record compares against it; its order among records
            // (seq) is written into it, so the projection rebuilt from this store's log places it the same way.
            change.seq = seqFrom(uuidv7(), 0);
            applyEnvelope(change, change.seq, true);
            out.push(change);
            applied += 1;
          }
        }
        if (keep_apart) {
          for (const envelope of keptApart(conflicts, keep_apart)) {
            envelope.seq = seqFrom(uuidv7(), 0);
            applyEnvelope(envelope, envelope.seq, true);
            out.push(envelope);
          }
        }
        return out;
      }, { applied_already: true });
      return { ...result, applied, conflicts };
    },
    /** Makes these records exactly as given (stored form, value null removes): how a copy takes another's records for
     *  the buckets they differ in. One write. */
    takeRecords(records, context = {}) {
      return writing(contextOf(context), () => records.flatMap(({ id, type, value, meta }) => {
        // With its stamps, a record is made exactly the state it is there (a removed one included), stamps and all;
        // without them it is made as given, as a change made here.
        if (meta) {
          const held = keptOrRemoved(id);
          const given = { type: value === null ? null : type, value: value === null ? null : value, meta };
          return held && held.meta && sameKept({ type: held.type, value: held.value, meta: held.meta }, given) ? [] : [{ ...envelopeOfKept(id, given), exact: true }];
        }
        const now = kept(id);
        if (value === null) return keptOrRemoved(id) ? [{ id, purge: true }] : [];
        if (now && now.type === type && same(now.value, value)) return [];
        return [{ id, type, value }];
      }));
    },
    /** The log rows of one transaction, or naming one record, still in the database, oldest first (the log keeps no
     *  index, so SQLite looks through it, handing back only rows that name the transaction or hold the record's id;
     *  a write split into parts is always read, and answers as one row with its envelopes joined). `since` (a log row id)
     *  leaves out the rows before it: a sealed log that ends before it is not read at all, and the open one is read from
     *  its first row at or after it, so a question about recent history reads only the rows written since. */
    log({ transaction_id, record_id, since = null } = {}) {
      if (!transaction_id && !record_id) throw new Error('log needs a transaction_id or a record_id');
      const rows = [];
      const where = transaction_id ? 'transaction_id = ?' : '(instr(envelopes, ?) > 0 OR parts > 1)';
      const term = transaction_id ?? `"id":${JSON.stringify(record_id)}`;
      for (const table of [...sealedLogs(), LOG]) {
        let from = 0;
        if (since !== null) {
          const end = endOf(table);
          if (end === null || end < since) continue;
          from = firstRowAfter(table, since, true);
          if (from === null) continue;
        }
        let pending = null;
        for (const row of all(`SELECT id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes FROM ${table} WHERE rowid >= ? AND ${where} ORDER BY rowid`, from, term)) {
          if (row.part === 0) pending = { ...row, envelopes: [] };
          pending.envelopes.push(row.envelopes);
          if (row.part !== row.parts - 1) continue;
          const whole = { ...pending, envelopes: JSON.parse(pending.envelopes.join('')) };
          pending = null;
          if (transaction_id ? whole.transaction_id === transaction_id : whole.envelopes.some(envelope => envelope.id === record_id)) rows.push(whole);
        }
      }
      return rows;
    },
  });
}
