// parts/device-copy/do-work/device-copy.mjs
//
// PURPOSE
//   One copy of a person's records kept on one of their devices, over whatever SQL host that device has (a browser's
//   SQLite compiled to WebAssembly, the Mac's node:sqlite): the record store (parts/record-log) plus the copy's own id
//   and positions, settled with the copy it follows through `send(request) -> answer` (record-sync.mjs settleWith).
//   The browser's worker opens its copy here, so there is one way a device keeps records.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The copy's id and positions live in its own database (table device_copy_state), written in the same transaction
//      after each acknowledged page is applied. A failure before the whole settle finishes resumes those durable
//      positions; a split upload advances only after its whole source page is acknowledged.
//   2. One settle at a time: one asked for while another runs waits for it, then runs.
//   3. Nothing here names a host, a route, a record kind or a device kind; `prefix` only names the copy's id.
//   4. What the copy holds beyond its last write-out (a tail of the log) is written out when the copy opens and when a
//      settle ends, finished or failed. A tail left unwritten is replayed from every run on every open: a Mac copy that
//      could not settle for ten days held 570 MB at open, 363 MB once the tail was written out (2026-10-22).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { recordLogStore } from '../../record-log/do-work/record-log-store.mjs';
import { settleWith } from 'trillion-workshop/tools/record-log/do-work/record-sync.mjs';

function stateTable(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS device_copy_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID');
  const get = key => { const row = sql.exec('SELECT value FROM device_copy_state WHERE key = ?', key).toArray()[0]; return row ? JSON.parse(row.value) : null; };
  const set = (key, value) => sql.exec('INSERT INTO device_copy_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  return { get, set };
}

/**
 * host: { sql, transaction, kept? } over the device's database. send: (request) -> answer, to the copy it follows.
 * erasable: { type: [field] }, the fields the copy keeps sealed (parts/record-log erasable.mjs), as the store's DATA.
 * Answers { store, describe(), settle() }; settle answers settleWith's report plus `ms`.
 */
export function deviceCopy(host, { send, indexes = [], erasable = {}, prefix = 'device', now = () => new Date(), max_upload_rows = 200, max_upload_chars = 4_000_000 }) {
  const state = stateTable(host.sql);
  if (!state.get('copy_id')) state.set('copy_id', `${prefix}-${crypto.randomUUID()}`);
  const store = recordLogStore(host.sql, { transaction: host.transaction, indexes, erasable });
  store.checkpoint();
  let settling = null;
  const describe = () => ({ kept: host.kept ?? 'device', copy_id: state.get('copy_id'), position: state.get('position'), settled_at: state.get('settled_at'), root: store.checksum().root });
  async function settle() {
    if (settling) await settling.catch(() => {});
    settling = (async () => {
      const started = performance.now();
      try {
        const result = await settleWith(store, send, {
          id: state.get('copy_id'), state: state.get('position') ?? {}, max_upload_rows, max_upload_chars,
          onProgress: position => host.transaction(() => { state.set('position', position); }),
        });
        host.transaction(() => { state.set('position', result.state); state.set('settled_at', now().toISOString()); });
        return { ...result, ms: Math.round(performance.now() - started) };
      } finally { store.checkpoint(); }
    })();
    return settling;
  }
  return { store, describe, settle };
}
