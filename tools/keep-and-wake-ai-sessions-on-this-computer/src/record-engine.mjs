// src/record-engine.mjs
//
// PURPOSE
//   Opens a person's record store on the engine their database holds. Every store moves to the log engine
//   (parts/record-log: one row per write, records and indexes packed many to a row, reads from memory); a database
//   that still holds its records in the decomposed tables (parts/eeaf) is answered from them until src/record-move.mjs
//   has copied every record across and switched it, and a database with no records yet starts on the log engine.
//   Both answer the same interface, including the declared field indexes (src/record-indexes.json: scan, lastPerGroup,
//   fields), so no caller knows which engine it reads.
//   The log engine also keeps the EEAF data model over the records (src/record-model.json: kinds, properties,
//   participation and sets, and the kinds a person's lists declare), read through model, factsOf, partsOf, holdersOf and
//   membersOf; a store still on the decomposed tables answers these once it is moved.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Which engine a database is on is kept in the database (record_keys_meta `engine`), set once by the log engine
//      when it starts an empty store and by the move when it switches; it is never guessed from anything else once set.
//   2. The decomposed engine is read only through this file and src/record-move.mjs. Its index reads here answer the
//      same entries the log engine's do (same order: values compared as their JSON text, then ids), from its facts.
//   3. The store handed to callers is one object whose every method asks the engine the database is on now, so the
//      move switches it in place (switchTo) and every holder of it (wrappers, owners built over it) reads the new engine
//      from its next call, with nothing reopened.
//   4. Which roots were written, in order, is kept here for both engines (changeSeq, changedSince), one journal per
//      database, so a reader that keeps its own view works out only what changed since it last read.
//   5. The decomposed engine's log generations still in the database after the switch stay the store's oldest
//      generations (sealedLogs and the calls that page, keep and drop them), so the record history keeps every change
//      either engine logged; nothing else of that engine is answered once the switch is made.
//   6. A record read again and again (keptRecords) is answered from the copy read last, frozen so no caller can change
//      it, while the journal says nothing wrote it since; a write, a rolled-back transaction (forgetCached forgets the
//      journal too) or a journal past its bound reads it again.
//
import { groupStarts, maintainInTurns, maintenancePacing, maintenanceTurn, recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { EEAF_CORE_TABLES, eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { eeafFieldReads } from '../../eeaf/do-work/eeaf-field-reads.mjs';
import { tableGeneration } from './table-generation.mjs';
import recordIndexes from './record-indexes.json' with { type: 'json' };
import recordModel from './record-model.json' with { type: 'json' };
import lists from './lists.json' with { type: 'json' };

export const RECORD_INDEXES = recordIndexes.indexes.map(({ type, name, paths, backfill, where, retired, carry, carry_presence }) => ({ type, name, paths, ...(retired ? { retired: true } : {}), ...(carry ? { carry } : {}), ...(carry_presence ? { carry_presence } : {}), ...(backfill ? { backfill } : {}), ...(where ? { where } : {}) }));
// The EEAF data model every store keeps (src/record-model.json): a list's field kinds say what value kind each of its
// fields holds, from the same rows the lists read (src/lists.json field_kinds `value`).
export const RECORD_MODEL = {
  value_kinds: recordModel.value_kinds,
  kinds: recordModel.kinds.map(({ type, properties, guard_properties, parts, table, indexes, erasable, erase_fields, erase_with, erasable_key }) => ({ type, ...(properties ? { properties } : {}), ...(guard_properties ? { guard_properties } : {}), parts: parts ?? [], ...(table === true ? { table: true } : {}), ...(erasable ? { erasable } : {}), ...(erase_fields ? { erase_fields } : {}), ...(erase_with ? { erase_with } : {}), ...(erasable_key ? { erasable_key } : {}), ...(indexes ? { indexes } : {}) })),
  declared_by: recordModel.declared_by.map(({ type, kind, properties, parts_when, part_references, indexes }) => ({ type, kind, properties, parts_when, part_references, ...(indexes ? { indexes } : {}),
    kind_values: Object.fromEntries(lists.field_kinds.map(fieldKind => [fieldKind.id, fieldKind.value])) })),
};
// The deploy's guard tests run with RECORD_MODEL_STRICT=1 (scripts/deploy-worker.mjs): a write of a type no kind
// declares, or of a property its shipped kind does not name, fails the deploy, so no new record shape goes live
// undeclared. A live store never refuses for it.
// Read as each store opens, so a test file that writes made-up record types to test the store itself can say so first.
const recordModelStrict = () => typeof process !== 'undefined' && process.env?.RECORD_MODEL_STRICT === '1';
const ENGINE_KEY = 'engine';
export const LOG_ENGINE = 'record-log';
export { maintainInTurns, maintenancePacing, maintenanceTurn };

export const tableExists = (sql, name) => sql.exec("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
/** The engine a database's records are on: 'record-log', or 'eeaf' while they are still in the decomposed tables. */
export function recordEngineOf(sql) {
  const kept = metaOf(sql, ENGINE_KEY);
  if (kept !== undefined) return kept;
  if (!tableExists(sql, 'entity')) return LOG_ENGINE;
  // Only the vocabulary a store makes when first opened (types, properties, roles) means no record was ever kept.
  const held = sql.exec("SELECT 1 AS found FROM entity_types WHERE type_id NOT IN ('type:type', 'type:property', 'type:role') LIMIT 1").toArray();
  return held.length ? 'eeaf' : LOG_ENGINE;
}
const metaOf = (sql, key) => {
  try {
    for (const row of sql.exec('SELECT value FROM record_keys_meta WHERE key = ?', key)) return JSON.parse(row.value);
    return undefined;
  } catch (error) {
    // New stores have no meta table yet. Once created, a keyed read must not
    // rescan sqlite_master on every history wake or every sealing check.
    if (/\bno such table:\s*record_keys_meta\b/i.test(String(error?.message ?? error))) return undefined;
    throw error;
  }
};
const ensureMetaTable = sql => sql.exec('CREATE TABLE IF NOT EXISTS record_keys_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID');
const setMeta = (sql, key, value) => {
  ensureMetaTable(sql);
  sql.exec('INSERT INTO record_keys_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
};
export function setRecordEngine(sql, engine) { setMeta(sql, ENGINE_KEY, engine); }
// While the move copies a store, its open log stays where it is (the move reads the changes after its starting
// position from it): nothing is sealed until the move switches the store or lets the hold go.
const SEALING_HELD = 'sealing_held';
const sealingFlags = new WeakMap();
// A number for each store an engine has met, so a change mark names the store it was taken over.
const storeNumbers = new WeakMap();
let storesNumbered = 0;

// Which root records were written, in order, for a reader that keeps its own view over many records (what helped,
// over every decided decision): each root written takes the next number, so the reader asks what changed since the
// number it last read and works out only those again, never every record. One journal per database, shared by every
// store opened over it. Bounded: past CHANGES_KEPT it starts again from a floor, and a reader asking from before the
// floor is told nothing can be said (null) and reads everything again.
const CHANGES_KEPT = 20000;
const changeJournals = new WeakMap();
const durableRevisionKey = prefix => `record-change-revision:${prefix}`;
function changeJournal() {
  const ids = new Map();
  // How many roots were written under each id prefix (the text before the first ':'), never bounded or forgotten: a
  // reader that keeps what it worked out from one kind of record compares one number (revisionOf), whatever the
  // journal has dropped. A rolled-back transaction counts against every prefix.
  const prefixes = new Map();
  let rolledBack = 0;
  let seq = 0;
  let floor = 0;
  return {
    note(id) {
      if (ids.size >= CHANGES_KEPT) { ids.clear(); floor = seq; }
      ids.delete(id);
      ids.set(id, ++seq);
      const colon = String(id).indexOf(':');
      const prefix = colon < 0 ? String(id) : String(id).slice(0, colon);
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    },
    seq: () => seq,
    // One number that changes whenever a root with one of these id prefixes was written, or a transaction rolled back.
    revisionOf(names) {
      let total = rolledBack;
      for (const name of names) total += prefixes.get(name) ?? 0;
      return total;
    },
    // Whether `id` may have been written after `at`: one lookup, never a walk of the journal.
    changedAfter: (id, at) => !Number.isSafeInteger(at) || at < floor || (ids.get(id) ?? 0) > at,
    // A rolled-back transaction: what was noted may never have been kept, so nothing earlier can be vouched for.
    forget() { ids.clear(); floor = ++seq; rolledBack += 1; },
    since(at) {
      if (!Number.isSafeInteger(at) || at < floor) return null;
      const changed = [];
      for (const [id, number] of ids) if (number > at) changed.push(id);
      return changed;
    },
  };
}

// The record store's interface: every method the store handed to callers answers, from the engine it is on now.
const RECORD_METHODS = ['read', 'typeOf', 'hasState', 'sizeOf', 'ids', 'find', 'scan', 'scanFirstValues', 'scanSelectedValues', 'indexReady', 'indexCovered', 'lastPerGroup', 'count', 'countsByType', 'tables', 'held', 'forgetCached',
  'readOwn', 'ownFieldPresent', 'memberCount', 'readMember', 'memberFields', 'memberFieldsMany', 'membersHolding', 'membersWhere',
  'log', 'valuesAt',
  // The EEAF data model over the records (parts/record-log record-model): kinds, properties and parts; one record as
  // attribute facts and what it holds; what holds a thing; the members of a set; the sets a record holds and one set by
  // its name; a record as it was true at a valid time by what was known at a system time (bitemporal).
  'model', 'factsOf', 'partsOf', 'holdersOf', 'membersOf', 'setsOf', 'set', 'recordAt', 'tableSchema', 'tableRows', 'tableHistory', 'backfillTables',
  // What copies of the store, undo and earlier reads use (the log engine answers them; parts/record-log record-time,
  // record-layers, record-sync).
  'checksum', 'recordsInBuckets', 'recordsInBucketsPage', 'logAfter', 'lastLogId', 'storedRecord', 'storedForm', 'resolved', 'shareFields', 'sharedChanges',
  // History held in the store from a place on, by name, until released (parts/record-log record-log-store pin).
  'pin', 'unpin', 'pins',
  // Fields kept sealed under a key per record, and the keys a copy takes beside the rows (parts/record-log erasable.mjs).
  'erasableFields', 'erasureOwnerOf', 'secureDelete', 'erasureKeys', 'takeErasureKeys', 'erasure', 'erasuresForArchives', 'archivesErased', 'erasureHeld', 'erasureKeysHeld', 'logTables'];
// The field reads (parts/eeaf eeaf-field-reads, parts/record-log fields), answered the same way.
const FIELD_READS = ['fieldsOf', 'projectOf', 'presenceOf', 'after', 'newestPerGroup', 'idsWhere'];
// The decomposed engine's log keeps where each sealed table's copying reached here; it is there until that engine's
// last table is dropped.
export const EARLIER_LOG_KEPT = 'bitemporal_facts_moves';

/**
 * The person's record store over `sql`, on whichever engine the database is on. Besides the record interface it
 * answers engine() (the engine's name), logStore() (the log engine over this database, opened once: what the move
 * copies into), holdSealing(on) (the move's hold on the open log), clearLogStore() (a stopped move starting again) and
 * switchTo(store) (the move's switch, once the database says the log engine).
 */
export function openRecords(sql, { transaction, contentId, hash, bounds, runs, historyArchives = false, readiness = null, lazy = false, readOnly = false } = {}) {
  if (lazy) {
    let opened;
    const get = () => opened ??= openRecords(sql, { transaction, contentId, hash, bounds, runs, historyArchives, readiness, readOnly });
    const extra = ['changeMark','indexPage','readMany','typesOf','countMany','write','writeOwn','writeMember','applyChanges','erase','takeRecords','indexDeclared','changeSeq','changedSince','changedAfter','revisionOf','durableRevisionOf','checkpoint','maintain','maintenanceAt','oldestLogId','sealLog','oldestPin','holdSealing','sealedLogs','sealedLogPage','sealedLogKept','keepSealedLogThrough','dropSealedLog','engine','logStore','clearLogStore','switchTo','ownFieldRecoveryVersion','matchesOwnField','readOwnFieldJson','rewriteOwnFieldJsonIfEqual','rewriteOwnFieldIfEqual'];
    return { ...Object.fromEntries([...new Set([...RECORD_METHODS, ...extra])].map(name => [name, (...args) => get()[name](...args)])),
      fields: Object.fromEntries(FIELD_READS.map(name => [name, (...args) => get().fields[name](...args)])) };
  }
  // A lazy owner may cross a migration fence before its first source read.
  // Resolve the host's current read-only state when assembly actually opens; a host that asks per write (a function) is
  // asked again at each write, so a window it opens (a retired store's own erasure) admits writes while it is open.
  const readOnlyAsked = readOnly;
  readOnly = typeof readOnly === 'function' ? readOnly() : readOnly;
  let log = null;
  const logStore = () => (log ??= { ...recordLogStore(sql, { transaction, contentId, bounds, runs, indexes: RECORD_INDEXES, model: RECORD_MODEL, history_archives: historyArchives, readOnly, strict_model: recordModelStrict(), readiness }), engine: LOG_ENGINE });
  let current;
  if (recordEngineOf(sql) === LOG_ENGINE) {
    current = logStore();
    if (metaOf(sql, ENGINE_KEY) === undefined) setRecordEngine(sql, LOG_ENGINE);
  } else {
    current = decomposedRecords(sql, { transaction, contentId, hash, bounds, model: RECORD_MODEL });
  }
  // The decomposed engine's sealed log generations, once the log engine answers: opened only while they are held.
  let earlier = null;
  let earlierTablePresent = null, earlierGeneration = null;
  const earlierLogs = () => {
    if (current.engine !== LOG_ENGINE) return null;
    // A table deleteEverything dropped is not remembered as present (src/table-generation.mjs).
    if (earlierGeneration !== tableGeneration(sql)) { earlierGeneration = tableGeneration(sql); earlierTablePresent = null; earlier = null; }
    earlierTablePresent ??= tableExists(sql, EARLIER_LOG_KEPT);
    if (!earlierTablePresent) { earlier = null; return null; }
    return (earlier ??= eeafStore(sql, { transaction, contentId, hash, bounds }));
  };
  const ownerOf = table => (earlierLogs()?.sealedLogs().includes(table) ? earlierLogs() : current);
  // Where this engine's stores' changes stand (record-log-store changeMark): a caller takes it where its transaction
  // begins and gives it to forgetCached(error, mark) if that transaction fails; unchanged, the projections stay current.
  const changeMark = () => {
    const own = current.changeMark?.(), held = earlier ? earlier.changeMark?.() : '-';
    if (!Number.isSafeInteger(own) || held === undefined) return null;
    // Which stores they are counts too: a store opened afresh counts its changes from 0 again.
    const number = store => { if (!storeNumbers.has(store)) storeNumbers.set(store, ++storesNumbered); return storeNumbers.get(store); };
    return `${number(current)}:${own}/${earlier ? number(earlier) : '-'}:${held}`;
  };
  const forgetAll = (error = null, mark = null) => {
    const unchanged = mark !== null && mark !== undefined && mark === changeMark();
    earlier?.forgetCached(error, unchanged ? earlier.changeMark?.() ?? null : null);
    current.forgetCached(error, unchanged ? current.changeMark?.() ?? null : null);
  };
  const ask = name => (...args) => {
    if (typeof current[name] !== 'function') throw new Error(`The ${current.engine} records do not answer ${name}.`);
    return current[name](...args);
  };
  // Every oldest-log and seal check asked the database for the hold. The hold changes only through holdSealing here or
  // a rollback (forgetCached), so one read per database serves them all; openRecords is called several times over
  // one handle, so the remembered value lives with the handle, not with this object.
  const sealingHeld = () => { if (!sealingFlags.has(sql)) sealingFlags.set(sql, metaOf(sql, SEALING_HELD) === true); return sealingFlags.get(sql); };
  if (!changeJournals.has(sql)) changeJournals.set(sql, changeJournal());
  const changes = changeJournals.get(sql);
  // Each write, whole or a part at a time, notes the root it wrote once the engine has taken it (and any it names as
  // `written` beyond those it was handed).
  const noteDurably = ids => {
    const prefixes = new Set();
    for (const id of ids) {
      changes.note(id);
      const colon = String(id).indexOf(':');
      prefixes.add(colon < 0 ? String(id) : String(id).slice(0, colon));
    }
    if (!prefixes.size) return;
    const advance = () => sql.exec(`UPDATE record_keys_meta
      SET value=json_set(value,'$.revision',json_extract(value,'$.revision')+1)
      WHERE key IN (SELECT value FROM json_each(?))`, JSON.stringify([...prefixes].map(durableRevisionKey)));
    try { advance(); }
    catch (error) {
      // Warm writes only advance registered clocks. A physical table reset is
      // recovered in this same mutation transaction, without an existence
      // cache or swallowing another table/column/storage failure.
      if (!/\bno such table:\s*record_keys_meta\s*$/i.test(String(error?.message ?? error))) throw error;
      ensureMetaTable(sql);
      advance();
    }
  };
  const mutationTransaction = work => {
    if (transaction) return transaction(work);
    // Existing nontransactional callers retain their unwatched behavior. Once
    // any durable clock is registered, every mutation needs a real SQL owner
    // transaction so the effect and its clock cannot commit separately.
    try {
      if (sql.exec(`SELECT 1 FROM record_keys_meta WHERE key LIKE 'record-change-revision:%' LIMIT 1`).toArray().length)
        throw new Error('A watched record mutation requires the SQL transaction owner.');
    } catch (error) {
      if (!/\bno such table:\s*record_keys_meta\b/i.test(String(error?.message ?? error))) throw error;
    }
    return work();
  };
  const noting = (name, idsOf) => (...args) => {
    if(typeof readOnlyAsked==='function'?readOnlyAsked():readOnly)throw Object.assign(new Error('This original work source is read-only and fenced.'),{status:409});
    const mark = changeMark();
    try {
      return mutationTransaction(() => {
        const result = ask(name)(...args);
        noteDurably(new Set([...idsOf(...args), ...(result?.written ?? [])]));
        return result;
      });
    } catch (error) { changes.forget(); forgetAll(error, mark); throw error; }
  };
  return {
    ...Object.fromEntries(RECORD_METHODS.map(name => [name, ask(name)])),
    /** A bounded descending page of one declared single-field index, including an id tie-breaker. */
    indexPage(type, name, { before, limit = 100 } = {}) {
      const index = RECORD_INDEXES.find(row => row.type === type && row.name === name);
      if (!index || index.paths.length !== 1) throw new Error('indexPage needs a declared single-field index.');
      const page = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
      if (before !== undefined && (!before || typeof before !== 'object' || typeof before.value !== 'string'
          || typeof before.id !== 'string' || !before.id)) throw new Error('ordered before must be a value and record id from an earlier page.');
      if (current.engine === LOG_ENGINE && !current.indexReady(type, name)) {
        const error = new Error('The sent records are still being ordered. Try again shortly.');
        error.code = 'index_not_ready';
        throw error;
      }
      const tied = before === undefined ? [] : current.scan(type, name, { equal: [before.value], idTo: before.id, reverse: true, limit: page });
      const earlier = tied.length === page ? [] : current.scan(type, name, { ...(before === undefined ? {} : { before: before.value }), reverse: true, limit: page - tied.length });
      return [...tied, ...earlier].map(row => ({ id: row.id, value: row.values[0], cursor: { value: row.values[0], id: row.id } }));
    },
    // Many records at once (a page of them): batched on the engine that answers it, one read at a time on the one that does not.
    readMany: (ids, options) => (typeof current.readMany === 'function' ? current.readMany(ids, options) : new Map([...new Set(ids)].map(id => [id, current.read(id)]))),
    typesOf: ids => (typeof current.typesOf === 'function' ? current.typesOf(ids) : new Map([...new Set(ids)].map(id => [id, current.typeOf(id)]))),
    // Selected counts share one current log check; the earlier engine keeps its exact per-type aggregate.
    countMany: types => (typeof current.countMany === 'function' ? current.countMany(types) : new Map([...new Set(types)].map(type => [type, current.count?.(type) ?? null]))),
    // A rollback can restore or remove the earlier table. Its presence is checked once per committed state, while
    // ordinary requests do not rescan the catalog for a table whose owner has not changed it.
    forgetCached(error = null, mark = null) { earlierTablePresent = null; sealingFlags.delete(sql); changes.forget(); forgetAll(error, mark); },
    changeMark,
    write: noting('write', records => records.map(record => record.id)),
    writeOwn: noting('writeOwn', id => [id]),
    // Only a physically qualified packed owner exposes all-at-once field repair. EEAF needs sliced retirement.
    ownFieldRecoveryVersion: () => current.engine === LOG_ENGINE ? current.ownFieldRecoveryVersion?.() ?? null : null,
    matchesOwnField: (...args) => { if (current.engine !== LOG_ENGINE) throw new Error('This owner has no qualified field recovery.'); return ask('matchesOwnField')(...args); },
    readOwnFieldJson: (...args) => { if (current.engine !== LOG_ENGINE) throw new Error('This owner has no qualified field recovery.'); return ask('readOwnFieldJson')(...args); },
    rewriteOwnFieldJsonIfEqual: (...args) => {
      if (current.engine !== LOG_ENGINE) throw new Error('This owner has no qualified field recovery.');
      try { return mutationTransaction(() => { const changed = ask('rewriteOwnFieldJsonIfEqual')(...args); if (changed) noteDurably([args[0]]); return changed; }); }
      catch(error) { changes.forget(); current.forgetCached(error); earlier?.forgetCached(error); throw error; }
    },
    rewriteOwnFieldIfEqual: (...args) => {
      if (current.engine !== LOG_ENGINE) throw new Error('This owner has no qualified field recovery.');
      try { return mutationTransaction(() => { const changed = ask('rewriteOwnFieldIfEqual')(...args); if (changed) noteDurably([args[0]]); return changed; }); }
      catch(error) { changes.forget(); current.forgetCached(error); earlier?.forgetCached(error); throw error; }
    },
    writeMember: noting('writeMember', id => [id]),
    // The raw producer's committed inventory includes generated roots. A lazy
    // row/envelope feed belongs to that producer and cannot be traversed again.
    applyChanges: noting('applyChanges', () => []),
    erase: noting('erase', id => [id]),
    takeRecords: noting('takeRecords', records => records.map(record => record.id)),
    indexDeclared: (type, name) => current.indexDeclared?.(type, name) ?? RECORD_INDEXES.some(index => index.type === type && index.name === name),
    /** The number of the latest root record written, and the root ids written after `seq` (null when the journal no
     *  longer reaches back that far, so the caller reads everything). */
    changeSeq: () => changes.seq(),
    changedSince: seq => changes.since(seq),
    changedAfter: (id, seq) => changes.changedAfter(id, seq),
    /** One number that changes whenever a root whose id starts with one of `prefixes` (the text before the first ':')
     *  was written, or a transaction rolled back. */
    revisionOf: prefixes => changes.revisionOf(prefixes),
    /** Durable mutation frontier for bounded proofs that must survive a cold owner restart. */
    durableRevisionOf(prefixes) {
      if (!Array.isArray(prefixes) || prefixes.length > 16 || prefixes.some(prefix => typeof prefix !== 'string' || !prefix))
        throw new TypeError('Read at most sixteen named record mutation frontiers.');
      if (readOnly) return JSON.stringify(prefixes.map(prefix => metaOf(sql,durableRevisionKey(prefix)) ?? null));
      if (!transaction) throw new Error('Registering a durable record frontier requires the SQL transaction owner.');
      ensureMetaTable(sql);
      return transaction(() => JSON.stringify(prefixes.map(prefix => {
        const key=durableRevisionKey(prefix);
        sql.exec('INSERT INTO record_keys_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING',
          key,JSON.stringify({epoch:crypto.randomUUID(),revision:0}));
        return metaOf(sql,key);
      })));
    },
    // Only the log engine writes pages out and merges them; the decomposed one has everything written already.
    checkpoint: () => readOnly ? null : current.checkpoint?.(),
    maintain: (options, now) => (readOnly ? {merged:0,more:false} : typeof current.maintain === 'function' ? current.maintain(options, now) : { merged: 0, more: false }),
    maintenanceAt: now => (readOnly ? null : typeof current.maintenanceAt === 'function' ? current.maintenanceAt(now) : null),
    fields: Object.fromEntries(FIELD_READS.map(name => [name, (...args) => current.fields[name](...args)])),
    oldestLogId: () => (sealingHeld() ? null : current.oldestLogId()),
    sealLog: () => (sealingHeld() ? null : current.sealLog()),
    // Only the log engine holds pins; a store not moved to it yet holds none.
    oldestPin: () => (typeof current.oldestPin === 'function' ? current.oldestPin() : null),
    holdSealing: on => { setMeta(sql, SEALING_HELD, Boolean(on)); sealingFlags.set(sql, Boolean(on)); },
    sealedLogs: () => [...(earlierLogs()?.sealedLogs() ?? []), ...current.sealedLogs()],
    sealedLogPage: (table, ...rest) => ownerOf(table).sealedLogPage(table, ...rest),
    sealedLogKept: table => ownerOf(table).sealedLogKept(table),
    keepSealedLogThrough: (table, rowid, options) => ownerOf(table).keepSealedLogThrough(table, rowid, options),
    dropSealedLog: table => ownerOf(table).dropSealedLog(table),
    engine: () => current.engine,
    logStore,
    // Lets go of everything a move copied so far (a move that stopped and starts again begins clean): only while the
    // decomposed engine still answers, so nothing it drops was ever served.
    clearLogStore() {
      if (current.engine === LOG_ENGINE) throw new Error('The log engine answers this store; nothing it holds is let go.');
      const tables = logStore().tables();
      transaction(() => { for (const table of tables) sql.exec(`DROP TABLE IF EXISTS ${table}`); setRecordEngine(sql, current.engine); });
      log = null;
    },
    switchTo(store) {
      if (recordEngineOf(sql) !== store.engine) throw new Error(`The database is not on the ${store.engine} records.`);
      // A changed physical reader cannot reuse a receiving proof established
      // against the previous one, even if its per-prefix numeric revision agrees.
      sql.exec(`UPDATE record_keys_meta SET value=json_set(value,'$.epoch',?)
        WHERE key LIKE 'record-change-revision:%'`,crypto.randomUUID());
      current = store;
      earlierTablePresent = null;
    },
  };
}

/**
 * Hands a stored object's host context its records (ctx.records, src/stored-object.mjs invariant 3): the store over the
 * object's own SQL seam, every write inside its storage's transaction, opened at its first use. ctx.storage.sql is read at
 * that first use, so a host or class that wraps its SQL seam while the object is made is the seam the records go through.
 * The storage's transactionSync and transaction are kept so that any of them rolling back (the class's own, or one nested
 * in it) takes back what the records remember of the writes it undid (forgetCached, with the change mark taken where it
 * began), so no class repeats that undo. Every host (src/hosts/cloudflare/lazy-durable-object.mjs on Cloudflare,
 * src/hosts/local/stored-object-host.mjs here) calls this one function, so the records a class receives are the same on
 * each. A ctx already given its records keeps them.
 */
export function giveRecords(ctx) {
  if (Object.hasOwn(ctx, 'records')) return ctx;
  const storage = ctx.storage;
  let records = null;
  const undone = (error, mark) => { records?.forgetCached(error, mark); throw error; };
  const kept = run => fn => {
    const mark = records?.changeMark() ?? null;
    try {
      const result = run(fn);
      return typeof result?.then === 'function' ? result.catch(error => undone(error, mark)) : result;
    } catch (error) { return undone(error, mark); }
  };
  // What the host gives is kept; what it does not give stays absent and refuses when called (src/stored-object.mjs invariant 3).
  const own = {};
  for (const name of ['transactionSync', 'transaction']) {
    if (typeof storage?.[name] !== 'function') continue;
    own[name] = storage[name].bind(storage);
    Object.defineProperty(storage, name, { configurable: true, writable: true, value: kept(own[name]) });
  }
  Object.defineProperty(ctx, 'records', { configurable: true, enumerable: false,
    get: () => (records ??= openRecords(ctx.storage.sql, { transaction: fn => own.transactionSync(fn), lazy: true })) });
  return ctx;
}

// Records read again and again, kept (invariant 6): `read(id)` answers the copy read last while the store's journal
// says nothing wrote it since, so a screen asked for on every look reads nothing until the record changes. One reader
// per store; at most `most` records are kept, the least recently read let go first. A kept value is frozen through:
// a caller that wants a changed copy makes one.
const keptByStore = new WeakMap();
const KEPT_MOST = 16;
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) frozen(item); }
  return value;
};
export function keptRecords(store, { most = KEPT_MOST } = {}) {
  if (keptByStore.has(store)) return keptByStore.get(store);
  const kept = new Map();
  const reader = {
    read(id) {
      const held = kept.get(id);
      kept.delete(id);
      if (held && !store.changedAfter(id, held.seq)) { kept.set(id, held); return held.value; }
      const seq = store.changeSeq();
      const value = frozen(store.read(id));
      kept.set(id, { seq, value });
      if (kept.size > most) kept.delete(kept.keys().next().value);
      return value;
    },
  };
  keptByStore.set(store, reader);
  return reader;
}

// The decomposed tables answering the same interface: their own store, field reads, and the declared indexes read
// from the facts (a path's last field is a fact; each field before it is a link walked up to the root).
export function decomposedRecords(sql, { transaction, contentId, hash, bounds, indexes = RECORD_INDEXES, model = RECORD_MODEL } = {}) {
  const store = eeafStore(sql, { transaction, contentId, hash, bounds });
  const all = (query, ...params) => sql.exec(query, ...params).toArray();
  const fields = eeafFieldReads(sql, id => store.read(id), (id,names) => store.readSelected(id,names));
  // Resolve a customer list's index from the one exact declaration that owns
  // this record type. This bounded point read avoids materializing every list
  // or its indexes just to open a row-order cursor.
  const dynamicIndex = (type, name) => {
    const rule = (model.declared_by ?? []).find(item => item.indexes?.path
      && type.startsWith(item.kind?.prefix ?? ''));
    if (!rule) return null;
    const named = type.slice((rule.kind.prefix ?? '').length);
    const at = (value, path) => path.reduce((current, part) => current?.[part], value);
    // The kind name is not the declaration's record id: a list called tasks
    // may declare row_type ordered-task. Resolve a direct declaration key
    // through EEAF's maintained (property, value, subject) index. For a
    // nested declaration path, use the owner's bounded declaration inventory.
    const ownerPath = rule.kind.path ?? [];
    let declarations;
    if (ownerPath.length === 1) {
      const property = `prop:${rule.type}:${ownerPath[0]}`;
      declarations = all(`SELECT fact.subject_id AS id FROM attribute_fact fact INDEXED BY idx_attribute_fact_property_value_subject
        JOIN entity_types owner ON owner.entity_id = fact.subject_id
        WHERE fact.property_id = ? AND fact.value_json = ? AND owner.type_id = ? AND fact.subject_id NOT LIKE '%/%'
        ORDER BY fact.subject_id LIMIT 2`, property, JSON.stringify(named), `type:${rule.type}`).map(row => row.id);
    } else {
      const owners = store.ids(rule.type, { prefix: `${rule.type}:`, limit: lists.limits.lists_per_person });
      declarations = owners.filter(id => store.typeOf(id) === rule.type && at(store.read(id), ownerPath) === named);
    }
    if (declarations.length !== 1) return null;
    const owner = declarations[0];
    const declaration = store.read(owner);
    const indexes = at(declaration, rule.indexes.path);
    if (!Array.isArray(indexes)) return null;
    const index = indexes.find(item => item?.name === name);
    if (!index || !Array.isArray(index.fields) || !index.fields.length) return null;
    return { type, name, paths: index.fields.map(field => [field]) };
  };
  const indexNamed = (type, name) => {
    const index = indexes.find(item => !item.retired && item.type === type && item.name === name);
    const dynamic = index ? null : dynamicIndex(type, name);
    if (!index && !dynamic) throw new Error(`No index named ${name} is declared for ${type} records.`);
    return index ?? dynamic;
  };
  // One path as a subquery answering (root, v): the fact at its last field, its links walked up to the root.
  const pathQuery = (type, path, n) => {
    const childType = [type, ...path.slice(0, -1)].join('/');
    const joins = [];
    let subject = `a${n}.subject_id`;
    for (let depth = path.length - 2; depth >= 0; depth -= 1) {
      const alias = `p${n}_${depth}`;
      joins.push(`JOIN participation ${alias} ON ${alias}.participant_id = ${subject} AND ${alias}.role_id = '${`role:${path[depth]}`.replace(/'/g, "''")}'`);
      subject = `${alias}.interaction_id`;
    }
    const property = `prop:${childType}:${path.at(-1)}`.replace(/'/g, "''");
    return `SELECT ${subject} AS root, a${n}.value_json AS v FROM attribute_fact a${n} ${joins.join(' ')} WHERE a${n}.property_id = '${property}'`;
  };
  const conditions = (type, index) => (index.where ?? []).map((rule, at) => {
    const excluded = rule.not.map(value => `'${JSON.stringify(value).replace(/'/g, "''")}'`).join(',');
    return `q0.root IN (SELECT root FROM (${pathQuery(type, rule.path, `w${at}`)}) WHERE v NOT IN (${excluded || "''"}))`;
  });
  // Selected scalar fields use the same bounded primary-key field reader as other decomposed projections. Nested
  // paths follow only the selected subjects' named links; an explicitly carried object opens that named child,
  // never its root's other fields. Missing values answer null, as the log index does.
  const selectedLinks = (ids, field) => {
    if (ids.length > 128) throw new Error('Selected carried links need a page of at most 128 subjects.');
    // The decomposed writer owns one exact #part identity per parent/field.
    // Primary-key lookup therefore reads at most one link per selected subject.
    return new Map(all(`SELECT links.interaction_id AS id, links.participant_id AS child
      FROM json_each(?) selected CROSS JOIN participation links
      WHERE links.id = selected.value AND links.role_id = ? LIMIT 128`,
    JSON.stringify(ids.map(id => `${id}/${encodeURIComponent(field)}#part`)), `role:${field}`).map(row => [row.id, row.child]));
  };
  function carriedFields(type, ids, paths) {
    const result = new Map(ids.map(id => [id, {}]));
    const defined = new Map(ids.map(id => [id, {}]));
    for (let start = 0; start < ids.length; start += 128) {
      const selected = ids.slice(start, start + 128);
      for (const path of paths) {
        let subjects = new Map(selected.map(id => [id, id]));
        for (const field of path.slice(0, -1)) {
          const links = selectedLinks([...new Set(subjects.values())], field);
          subjects = new Map([...subjects].flatMap(([id, subject]) => links.has(subject) ? [[id, links.get(subject)]] : []));
          if (!subjects.size) break;
        }
        const name = path.at(-1);
        const childType = [type, ...path.slice(0, -1)].join('/');
        const scalar = fields.fieldsOf(childType, [...new Set(subjects.values())], [name]);
        const missing = [...new Set([...subjects.values()].filter(subject => scalar.get(subject)?.[name] === undefined))];
        const links = missing.length ? selectedLinks(missing, name) : new Map();
        const children = [...new Set(links.values())];
        const sets = new Set(children.length ? all(`SELECT sets.id FROM json_each(?) selected CROSS JOIN interaction_sets sets
          WHERE sets.id = selected.value`, JSON.stringify(children)).map(row => row.id) : []);
        const opened = new Map();
        for (const child of children) {
          opened.set(child, sets.has(child)
            ? all('SELECT member_id FROM interaction_set_members WHERE set_id = ? ORDER BY ordinal', child).map(({ member_id }) => store.read(member_id))
            : store.read(child));
        }
        for (const id of selected) {
          const subject = subjects.get(id);
          const own = scalar.get(subject);
          const present = Object.hasOwn(own ?? {}, name) || links.has(subject);
          result.get(id)[path.join('.')] = (Object.hasOwn(own ?? {}, name) ? own[name] : opened.get(links.get(subject))) ?? null;
          defined.get(id)[path.join('.')] = present;
        }
      }
    }
    return { values: result, defined };
  }
  function scan(type, name, { equal = [], from, to, after, after_id, before, startsWith, idFrom, idTo, reverse = false, limit, carried = false } = {}) {
    const index = indexNamed(type, name);
    if (after_id !== undefined && (typeof after_id !== 'string' || !after_id || after === undefined || index.paths.length !== equal.length + 1 || from !== undefined || startsWith !== undefined))
      throw new Error('after_id needs an exclusive value and record id for the final index field.');
    const parts = index.paths.map((path, n) => `(${pathQuery(type, path, n)}) q${n}`);
    const from_ = [parts[0], ...parts.slice(1).map((part, n) => `JOIN ${part} ON q${n + 1}.root = q0.root`)].join(' ');
    const where = [`q0.root NOT LIKE '%/%'`, ...conditions(type, index)];
    const params = [];
    equal.forEach((value, n) => { where.push(`q${n}.v = ?`); params.push(JSON.stringify(value)); });
    const next = `q${equal.length}.v`;
    if (equal.length < index.paths.length) {
      if (from !== undefined) { where.push(`${next} >= ?`); params.push(JSON.stringify(from)); }
      if (after_id !== undefined) {
        where.push(`(${next} > ? OR (${next} = ? AND q0.root > ?))`);
        params.push(JSON.stringify(after), JSON.stringify(after), after_id);
      } else if (after !== undefined) { where.push(`${next} > ?`); params.push(JSON.stringify(after)); }
      if (to !== undefined) { where.push(`${next} <= ?`); params.push(JSON.stringify(to)); }
      if (before !== undefined) { where.push(`${next} < ?`); params.push(JSON.stringify(before)); }
      if (startsWith !== undefined) {
        const low = JSON.stringify(startsWith).slice(0, -1);
        where.push(`${next} >= ? AND ${next} < ?`);
        params.push(low, `${low.slice(0, -1)}${String.fromCharCode(low.charCodeAt(low.length - 1) + 1)}`);
      }
    } else {
      if (idFrom !== undefined) { where.push('q0.root >= ?'); params.push(idFrom); }
      if (idTo !== undefined) { where.push('q0.root < ?'); params.push(idTo); }
    }
    const direction = reverse ? 'DESC' : 'ASC';
    const order = [...index.paths.map((_, n) => `q${n}.v ${direction}`), `q0.root ${direction}`].join(', ');
    const values = index.paths.map((_, n) => `q${n}.v AS v${n}`).join(', ');
    const rows = all(`SELECT q0.root AS id, ${values} FROM ${from_} WHERE ${where.join(' AND ')} ORDER BY ${order}${Number.isFinite(limit) ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : ''}`, ...params);
    const valuesCarried = carried && index.carry?.length ? carriedFields(type, rows.map(row => row.id), index.carry) : null;
    return rows.map(row => {
      const own = valuesCarried?.values.get(row.id);
      // Decomposed facts are read fresh; qualify only the requested scalar fields.
      const qualified = index.carry_presence?.length === 0 && own && Object.values(own).every(value =>
        value === null || ['string', 'number', 'boolean'].includes(typeof value));
      return { id: row.id, values: index.paths.map((_, n) => JSON.parse(row[`v${n}`])),
        ...(own ? { carried: own } : {}),
        ...(qualified ? { carried_defined: valuesCarried.defined.get(row.id), carried_presence: {} } : {}),
      };
    });
  }
  function scanFirstValues(type, name, values) {
    const index = indexNamed(type, name);
    if (!index.paths.length || !values.length) return [];
    const parts = index.paths.map((path, n) => `(${pathQuery(type, path, n)}) q${n}`);
    const from_ = [parts[0], ...parts.slice(1).map((part, n) => `JOIN ${part} ON q${n + 1}.root = q0.root`)].join(' ');
    const order = [...index.paths.map((_, n) => `q${n}.v`), 'q0.root'].join(', ');
    const columns = index.paths.map((_, n) => `q${n}.v AS v${n}`).join(', ');
    const selected = JSON.stringify([...new Set(values)].map(value => JSON.stringify(value)));
    const rows = [];
    for (const row of sql.exec(`SELECT q0.root AS id, ${columns} FROM ${from_}
      WHERE q0.root NOT LIKE '%/%' ${conditions(type, index).map(condition => `AND ${condition}`).join(' ')} AND q0.v IN (SELECT value FROM json_each(?)) ORDER BY ${order}`, selected)) {
      rows.push({ id: row.id, values: index.paths.map((_, n) => JSON.parse(row[`v${n}`])) });
    }
    return rows;
  }
  function scanSelectedValues(type, name, { equal = [], values = [], suffix = [], from, to, after, before, limit = Infinity, reverse = false } = {}) {
    const index = indexNamed(type, name);
    if (equal.length >= index.paths.length) throw new Error(`Index ${name} has no value after its fixed prefix.`);
    if (!Array.isArray(suffix) || equal.length + 1 + suffix.length > index.paths.length) throw new Error(`Index ${name} cannot fix that suffix after its selected value.`);
    const selected = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
    const count = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : Infinity;
    if (!selected.length || count === 0) return [];
    if (equal.length + 1 + suffix.length === index.paths.length && [from, to, after, before].some(value => value !== undefined)) throw new Error(`Index ${name} has no value after its selected prefix to bound.`);
    return selected.flatMap(value => scan(type, name, { equal: [...equal, value, ...suffix], from, to, after, before, reverse, limit: count }))
      .sort((left, right) => {
        for (let at = 0; at < index.paths.length; at += 1) {
          const a = JSON.stringify(left.values[at]);
          const b = JSON.stringify(right.values[at]);
          if (a !== b) return (a < b ? -1 : 1) * (reverse ? -1 : 1);
        }
        return (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) * (reverse ? -1 : 1);
      });
  }
  function lastPerGroup(type, name, { equal = [], exclude = [], include = () => true, depth = 1, startsWith } = {}) {
    const index = indexNamed(type, name);
    if (equal.length >= index.paths.length) throw new Error(`Index ${name} has no group after its fixed prefix.`);
    if (!Number.isSafeInteger(depth) || depth < 1 || equal.length + depth > index.paths.length)
      throw new Error(`Index ${name} needs a group depth within its remaining paths.`);
    if (typeof include !== 'function') throw new Error('Group inclusion must be a function.');
    const starts = groupStarts(startsWith);
    const excluded = new Set(exclude.map(value => JSON.stringify(value)));
    const out = [];
    const visit = (fixed, start) => {
      let after;
      for (;;) {
        const [head] = scan(type, name, { equal: fixed, ...(after === undefined ? {} : { after }), ...(start === undefined ? {} : { startsWith: start }), limit: 1 });
        if (!head) break;
        const group = head.values[fixed.length];
        const accepted = fixed.length !== equal.length || (!excluded.has(JSON.stringify(group)) && include(group));
        if (accepted) {
          const next = [...fixed, group];
          if (next.length < equal.length + depth) visit(next);
          else {
            const [last] = scan(type, name, { equal: next, reverse: true, limit: 1 });
            if (last) out.push(last);
          }
        }
        after = group;
      }
    };
    if (starts === null) visit(equal);
    else for (const start of starts) visit(equal, start);
    return out;
  }
  function countsByType() {
    return all("SELECT type_id AS type, COUNT(*) AS n FROM entity_types WHERE entity_id NOT LIKE '%/%' AND entity_id NOT LIKE '%#part' AND type_id NOT IN ('type:type', 'type:property', 'type:role', 'type:participation', 'type:set') GROUP BY type_id ORDER BY n DESC")
      .map(row => ({ type: row.type.slice('type:'.length), n: row.n }));
  }
  // reads-ok: exact aggregate over this type's indexed membership; returns one number and no record bodies.
  const count = type => all("SELECT COUNT(*) AS n FROM entity_types WHERE type_id = ? AND entity_id NOT LIKE '%/%' AND entity_id NOT LIKE '%#part'", `type:${type}`)[0].n;
  return { ...store, engine: 'eeaf', hasState: id => store.typeOf(id) !== null, fields, scan, scanFirstValues, scanSelectedValues, indexReady: (type, name) => { indexNamed(type, name); return true; }, indexDeclared: (type, name) => { try { indexNamed(type, name); return true; } catch { return false; } }, indexCovered: (type, name, ids) => {
    indexNamed(type, name);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.includes('\0'))) throw new Error('Index coverage needs an array of record ids.');
    return new Set(ids);
  }, lastPerGroup, countsByType, count, tables: () => EEAF_CORE_TABLES.map(({ table }) => table) };
}
