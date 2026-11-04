// src/operational-state.mjs
//
// Purpose
//   State a running owner keeps for itself (the own AIs' routing counters, a reader's place and its waiting queue):
//   written as often as that work runs, read only by that owner, and never one of the person's records. It lives in
//   plain SQL rows that each write overwrites, so it keeps no history. Kept as an EEAF setting instead, every write was
//   kept in the record log for good: on 2026-10-13 the routing setting `own_ais_runs`, a 133 KB copy of every counter
//   rewritten about every 0.6 s, filled the founder's store to the platform's 10 GB limit within a day (lesson L126:
//   operational exhaust stays off the record path).
//
// Non-negotiable invariants
//   1. One document per name (`doc`). Each top-level field is one row; a field named in `split` keeps one row per key of
//      its object, so a write that changes one key (one handoff's counters) writes one row. A write writes only the rows
//      whose JSON changed and deletes the rows of keys and fields it left out; a write that changes nothing writes
//      nothing at all.
//   2. The rows are the truth. Memory holds a copy of the rows tagged with the document's version token, which every
//      write that changes something replaces in the same transaction. A read whose stored token differs (another
//      instance wrote, or a transaction rolled back) reads the rows again. Every reader gets its own copy.
//   3. stamp() is the version token: it changes exactly when a write changed something, at the cost of one row read.
//   4. present() says whether the document was ever written, so its owner can carry an earlier value in once (adopt).
//      Nothing here reads or writes any record, so a store's record history never sees these writes.
//
// Key Concepts
//   doc     the document's name; one owner per name.
//   split   top-level fields that are maps: one row per key (`<field>\u001f<key>`; SQLite text ends at a NUL).
//   token   the row with the empty part name; absent until the first write.
//
// Security
//   Values are the owner's own bookkeeping (times, agent ids, row reasons). Nothing here is shared or exported.
//
import { tableGeneration } from '../../keep-and-wake-ai-sessions-on-this-computer/src/table-generation.mjs';

const TABLE = 'operational_state';
const SEP = '\u001f';
const TOKEN = '';

/** Sets up the one table every document shares (idempotent). */
export function setupOperationalState(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (doc TEXT NOT NULL, part TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (doc, part)) WITHOUT ROWID`);
  return sql;
}

/**
 * sql:         a SQL handle (exec)
 * transaction: (fn) → fn's result, atomically (default: run fn)
 * doc:         the document's name
 * split:       top-level fields kept one row per key
 * Answers { read() → value | null, write(value), stamp() → token | null, present() → boolean, adopt(value) → boolean }.
 */
export function operationalState({ sql, transaction = fn => fn(), doc, split = [] }) {
  if (!sql?.exec || typeof doc !== 'string' || !doc) throw new TypeError('Operational state needs a SQL handle and a document name.');
  const splitFields = new Set(split);
  // The table is made again once its handle moved to a new generation (deleteEverything, src/table-generation.mjs).
  let madeIn = null;
  let cache = null; // { token, parts: Map(part → json) }
  const table = () => {
    if (madeIn !== tableGeneration(sql)) { setupOperationalState(sql); madeIn = tableGeneration(sql); cache = null; }
    return sql;
  };

  const tokenNow = () => table().exec(`SELECT value FROM ${TABLE} WHERE doc = ? AND part = ?`, doc, TOKEN).toArray()[0]?.value ?? null;
  const partsOf = value => {
    const parts = new Map();
    if (value === null || value === undefined) return parts;
    if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Operational state ${doc} keeps an object.`);
    for (const [field, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!field || field.includes(SEP)) throw new TypeError(`Operational state ${doc} cannot keep the field ${JSON.stringify(field)}.`);
      if (splitFields.has(field) && item && typeof item === 'object' && !Array.isArray(item)) {
        for (const [key, entry] of Object.entries(item)) {
          if (entry === undefined) continue;
          if (key.includes(SEP)) throw new TypeError(`Operational state ${doc} cannot keep the key ${JSON.stringify(key)}.`);
          parts.set(`${field}${SEP}${key}`, JSON.stringify(entry));
        }
      } else parts.set(field, JSON.stringify(item));
    }
    return parts;
  };
  const valueOf = parts => {
    const value = {};
    for (const [part, json] of parts) {
      const at = part.indexOf(SEP);
      if (at < 0) { value[part] = JSON.parse(json); continue; }
      const field = part.slice(0, at);
      (value[field] ??= {})[part.slice(at + 1)] = JSON.parse(json);
    }
    return value;
  };
  // The rows as they are, from memory when the stored token is the one they were read or written under.
  const current = () => {
    const token = tokenNow();
    if (token === null) { cache = null; return { token: null, parts: new Map() }; }
    if (cache?.token === token) return cache;
    const parts = new Map(table().exec(`SELECT part, value FROM ${TABLE} WHERE doc = ? AND part <> ?`, doc, TOKEN).toArray()
      .map(row => [row.part, row.value]));
    cache = { token, parts };
    return cache;
  };

  function write(value) {
    const next = partsOf(value);
    const { token, parts } = current();
    const put = [...next].filter(([part, json]) => parts.get(part) !== json);
    const gone = [...parts.keys()].filter(part => !next.has(part));
    if (token !== null && !put.length && !gone.length) return false;
    const fresh = crypto.randomUUID();
    transaction(() => {
      for (const part of gone) table().exec(`DELETE FROM ${TABLE} WHERE doc = ? AND part = ?`, doc, part);
      for (const [part, json] of put) table().exec(`INSERT INTO ${TABLE} (doc, part, value) VALUES (?, ?, ?) ON CONFLICT (doc, part) DO UPDATE SET value = excluded.value`, doc, part, json);
      table().exec(`INSERT INTO ${TABLE} (doc, part, value) VALUES (?, ?, ?) ON CONFLICT (doc, part) DO UPDATE SET value = excluded.value`, doc, TOKEN, fresh);
    });
    cache = { token: fresh, parts: next };
    return true;
  }

  return {
    read() { const { token, parts } = current(); return token === null ? null : valueOf(parts); },
    write,
    stamp: () => tokenNow(),
    present: () => tokenNow() !== null,
    /** Writes `value` only when the document was never written: an earlier value carried in once. */
    adopt(value) {
      if (tokenNow() !== null) return false;
      write(value ?? {});
      return true;
    },
  };
}
