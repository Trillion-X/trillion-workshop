// src/hosts/local/sqlite-host.mjs
//
// PURPOSE
//   node:sqlite's SQL seam: one SQLite file (or ':memory:') answering the interface every host's SQL gives, the one a
//   Durable Object's storage gives (exec(query, ...params) -> toArray(), one(), iteration), with a transaction that
//   commits once at the outermost call. The record engines (src/record-engine.mjs), this computer's stored objects
//   (src/hosts/local/stored-object-host.mjs), its addressed resources (src/hosts/local/local-resource-host.mjs) and its
//   decision store (src/local-store.mjs) all run over it, so the same store code runs here and on Cloudflare.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A query binding more than 100 values is refused, as a Durable Object's SQLite refuses it, so a query that passes
//      here never fails only once deployed.
//   2. ArrayBuffer values bind as their bytes, as a Durable Object binds them.
//   3. A connection that fails to open holds no lock; claimExclusive gives the connection to one retained owner once.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_BOUND_VALUES = 100;

export function sqliteHost(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
  } catch (error) {
    // A failed open never leaves our newly created connection holding locks.
    try { db.close(); } catch { /* preserve the actual initialization failure */ }
    throw error;
  }
  const statements = new Map();
  const sql = {
    // This host supports these read-only PRAGMAs. Other hosts may omit the capability entirely; consumers must
    // not discover it by executing a statement through a live record projection. Keep existing size semantics.
    get databaseFreeBytes() {
      const pages = db.prepare('PRAGMA freelist_count').get().freelist_count;
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      return pages * pageSize;
    },
    exec(query, ...params) {
      // A Durable Object's SQLite refuses a query binding more than 100 values; refusing it here too keeps a query that
      // passes on this computer from failing only once deployed.
      if (params.length > MAX_BOUND_VALUES) throw new Error(`A query may bind at most ${MAX_BOUND_VALUES} values; this one binds ${params.length}.`);
      if (!statements.has(query)) statements.set(query, db.prepare(query));
      // Durable Object SQLite binds ArrayBuffer blobs; node:sqlite binds their byte views.
      const rows = statements.get(query).all(...params.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      // The cursor a Durable Object answers with: every row, exactly one, or row by row as an iterator.
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}.`); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  let depth = 0;
  const transaction = fn => {
    if (depth > 0) return fn();
    depth += 1;
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { depth -= 1; }
  };
  // Grant this connection's lifetime once, before a retained record owner is
  // constructed. WAL transaction serialization alone is not cache ownership.
  let exclusivelyClaimed = false;
  const claimExclusive = () => {
    if (exclusivelyClaimed) throw Object.assign(new Error('This SQLite connection already belongs to a retained owner.'), { code: 'sqlite_connection_claimed', status: 409 });
    try { db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; COMMIT;'); }
    catch (error) {
      // This unclaimed connection is ours; another retained owner is untouched.
      try { db.close(); } catch { /* preserve the actual lock refusal */ }
      throw error;
    }
    exclusivelyClaimed = true;
  };
  return { db, sql, transaction, claimExclusive };
}
