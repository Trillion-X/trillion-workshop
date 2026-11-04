// parts/device-copy/do-work/wasm-sqlite-host.mjs
//
// PURPOSE
//   The record store's SQL seam over SQLite compiled to WebAssembly, so a person's records live in their own browser
//   (or iPhone web view) the same way they live on the Mac (node:sqlite, src/local-store.mjs sqliteHost) and in the
//   hosted store (Durable Object SQLite): one store module, any host. In a page's worker the database is kept in the
//   browser's private file system (the SQLite "opfs-sahpool" file system: synchronous, needs no special page headers),
//   so it survives reloads and works offline; anywhere else it is kept in memory.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The same cursor every host answers: exec(query, ...params) -> { toArray(), one(), [Symbol.iterator] }, and a
//      nested transaction(fn) that commits once at the outermost call and rolls back on any error.
//   2. A query binding more than 100 values is refused here too, as a Durable Object refuses it, so a query that passes
//      on a device never fails only once hosted.
//   3. A statement is prepared once per text and reused; it is reset after every run, whatever happened.
//   4. Nothing here names a record kind, a product or a device: it moves SQL text and values, nothing else.
//
// KEY CONCEPTS
//   wasmSqliteHost(db)            any open sqlite-wasm `oo1.DB` (memory, OPFS, SAH pool) -> { db, sql, transaction }
//   openDeviceDatabase(sqlite3, { name, directory }) the person's database file in the private file system when the
//                                 SAH pool can be installed here (a dedicated worker), else in memory; answers which
//
// SECURITY
//   The database sits in this origin's private file system, readable only by pages of this origin; nothing is sent.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const MAX_BOUND_VALUES = 100;

/** The SQL seam over an open sqlite-wasm database (`sqlite3.oo1.DB` or any subclass). */
export function wasmSqliteHost(db) {
  const statements = new Map();
  const prepared = query => {
    let statement = statements.get(query);
    if (!statement) { statement = db.prepare(query); statements.set(query, statement); }
    return statement;
  };
  const sql = {
    exec(query, ...params) {
      if (params.length > MAX_BOUND_VALUES) throw new Error(`A query may bind at most ${MAX_BOUND_VALUES} values; this one binds ${params.length}.`);
      const statement = prepared(query);
      const rows = [];
      try {
        if (params.length) statement.bind(params.map(value => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)));
        while (statement.step()) rows.push(statement.get({}));
      } finally { statement.reset(true); }
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
  const close = () => { for (const statement of statements.values()) statement.finalize(); statements.clear(); db.close(); };
  return { db, sql, transaction, close };
}

/**
 * Opens the database a device keeps its copy in. `sqlite3` is the initialised sqlite-wasm module. In a dedicated
 * worker of a browser that has the private file system it is the file `name` in the SAH pool kept under `directory`
 * (kept across reloads); anywhere else (a page's main thread, Node.js) it is in memory. Answers { kept: 'device' |
 * 'memory', ...wasmSqliteHost(db) }.
 */
export async function openDeviceDatabase(sqlite3, { name = 'records.sqlite3', directory = '.trillion-records' } = {}) {
  const canKeep = typeof sqlite3.installOpfsSAHPoolVfs === 'function' && typeof globalThis.navigator?.storage?.getDirectory === 'function' && typeof globalThis.FileSystemSyncAccessHandle === 'function';
  if (canKeep) {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ directory, name: 'trillion-records' });
    const db = new pool.OpfsSAHPoolDb(`/${name}`);
    db.exec('PRAGMA journal_mode = DELETE');
    return { kept: 'device', ...wasmSqliteHost(db) };
  }
  return { kept: 'memory', ...wasmSqliteHost(new sqlite3.oo1.DB(':memory:', 'c')) };
}
