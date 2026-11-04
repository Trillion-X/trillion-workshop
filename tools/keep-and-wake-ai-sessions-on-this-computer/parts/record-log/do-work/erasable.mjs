// parts/record-log/do-work/erasable.mjs
//
// FIELDS A RECORD MODEL DECLARES ERASABLE, KEPT SEALED UNDER ONE KEY PER RECORD, SO ERASING THE RECORD IS DELETING ITS KEY.
//
// Purpose
//   The log keeps every earlier value of a record for good (record-log-store invariant 9): a removal carries what it
//   replaced, history reads it back, a sealed generation is archived as files, and every device's copy holds it too. A
//   field whose words a person must be able to take back (a message's text) is therefore never kept as words: it is
//   kept sealed (XChaCha20-Poly1305) under a key of its record's own, and every copy of the record, every row that
//   carries it and every archive line holds only the sealed form. Erasing the record deletes its key, and with it every
//   copy of the words at once, wherever they were kept.
//
// Non-negotiable invariants
//   1. A key never enters the log's envelopes. A record's key is kept in a column of its own beside the envelopes of
//      the open-log row that made it (the row is written anyway, so a key costs no row of its own, and a crash rebuilds
//      from that row) and, for reading, in the record's own entry of the store's key space (record-log-store `i|id`),
//      read with the record and written out with it. The column is emptied when the row leaves the open log, so a sealed generation or an
//      archive never holds a key. It is carried to a device's copy beside the rows that need it (record-sync.mjs),
//      never as a record, never in an envelope, a record's identity or what a change replaced. The table
//      (`record_erasable_keys`) holds the tombstones, the keys a copy was sent, and keys made by work that writes no
//      log row.
//   2. An erased record's key row stays as a tombstone (no key, the time it was erased), so a copy that settles later
//      deletes its key too, and a key a copy sends for an erased record is never taken back.
//   3. Sealing is deterministic for one key, record, field and value (the nonce is the keyed hash of them), so writing a
//      record again with the same words changes nothing and appends nothing (record-log-store invariant 2).
//   3a. A record whose words are another's (an arrival is its message's words) may be sealed under that one's key: the
//      sealed form names whose key (`k`), so erasing that record makes both unreadable at once.
//   4. The record id and field name are the sealed text's associated data: a sealed value moved to another record or
//      field does not open.
//   5. The key table asks SQLite for secure_delete, so an erased key's bytes are overwritten, not left in a free page;
//      `secureDelete` says whether the host granted it, and the remaining risk is stated, never hidden.
//
// Security
//   The key is 32 random bytes from the platform's generator. Nothing here names a product, a kind or a field.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { blake3 } from '../../live-namespace/do-work/blake3.mjs';
import { base64Of as toBase64 } from '../../../../serialized-content/do-work/base64.mjs';

export const SEALED_MARK = '\u0000sealed';
const TABLE = 'record_erasable_keys';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Indexed decoding avoids the iterable string/number arrays Uint8Array.from creates for multi-megabyte fields.
const fromBase64 = text => {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
};
const bound = (id, field) => encoder.encode(`${id}\u0000${field}`);

// The sealed form of one field, kept as small as it can be, since it is permanent once written:
//   { [SEALED_MARK]: base64(version | nonce (24) | ciphertext | tag (16)) } and, for a field sealed under another
//   record's key (invariant 3a), `k`: that record's id. Nothing else.
const VERSION = 1;
/** Whether `value` is a sealed field: { [SEALED_MARK]: text, k?: id } and nothing else. */
export const isSealed = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && typeof value[SEALED_MARK] === 'string' && Object.keys(value).every(name => name === SEALED_MARK || (name === 'k' && typeof value.k === 'string'));

/** The sealed form of one field's value under its record's key, or under the key of `keyId` (whose words they are). */
export function seal(key, id, field, value, keyId = id) {
  const plain = encoder.encode(JSON.stringify(value));
  const associated = bound(id, field);
  const material = new Uint8Array(associated.length + 1 + plain.length);
  material.set(associated); material.set(plain, associated.length + 1);
  const nonce = blake3(material, { key, dkLen: 24 });
  const sealed = xchacha20poly1305(key, nonce, bound(id, field)).encrypt(plain);
  const bytes = new Uint8Array(1 + nonce.length + sealed.length);
  bytes[0] = VERSION;
  bytes.set(nonce, 1);
  bytes.set(sealed, 1 + nonce.length);
  return { [SEALED_MARK]: toBase64(bytes), ...(keyId !== id ? { k: keyId } : {}) };
}
/** Whose key a sealed field is sealed under: the record that names it (`k`), else its own. */
export const keyIdOf = (id, sealed) => (isSealed(sealed) && typeof sealed.k === 'string' ? sealed.k : id);
export const keyText = toBase64;
export const keyBytes = fromBase64;

/** The value a sealed field holds, or undefined when its key is gone or it does not open. */
export function open(key, id, field, sealed) {
  if (!key || !isSealed(sealed)) return undefined;
  try {
    const bytes = fromBase64(sealed[SEALED_MARK]);
    if (bytes[0] !== VERSION) return undefined;
    return JSON.parse(decoder.decode(xchacha20poly1305(key, bytes.subarray(1, 25), bound(id, field)).decrypt(bytes.subarray(25))));
  }
  catch { return undefined; }
}

// reads-ok: every read here is one keyed row (LIMIT 1).
/**
 * The keys of one store's erasable records, over its SQLite (exec, toArray). A key made by a write is held as pending
 * until that write's log row takes it (`takePending`); `inLog(id)` finds the key the store keeps with the record
 * ({ key: base64, at } or null). A key made outside a write (`ensureKept`) goes straight into the table.
 */
export function erasableKeys(sql, { now = () => new Date(), random = bytes => crypto.getRandomValues(new Uint8Array(bytes)), inLog = () => null, inLogMany = null } = {}) {
  let secureDelete = false;
  try {
    sql.exec('PRAGMA secure_delete = ON');
    secureDelete = Number(sql.exec('PRAGMA secure_delete').toArray()[0]?.secure_delete) === 1;
  } catch { secureDelete = false; }
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (record_id TEXT PRIMARY KEY, key BLOB, erased_at TEXT, erased_fields TEXT) WITHOUT ROWID`);
  sql.exec(`CREATE INDEX IF NOT EXISTS record_erased_by_identity ON ${TABLE}(record_id) WHERE erased_at IS NOT NULL`);
  const held = new Map();
  const pending = new Map();
  const rowOf = id => {
    if (!held.has(id)) {
      // The key the store keeps with its record first ({ key, at }: read with the record, no statement of its own); the
      // table holds tombstones, keys a copy was sent and keys made by work that writes no log row.
      const logged = inLog(id);
      const row = logged ? null : sql.exec(`SELECT key, erased_at, erased_fields FROM ${TABLE} WHERE record_id = ? LIMIT 1`, id).toArray()[0] ?? null;
      held.set(id, logged ? { key: fromBase64(logged.key), at: logged.at ?? null, erased_at: null, fields: [] }
        : row ? { key: row.key ? new Uint8Array(row.key) : null, erased_at: row.erased_at ?? null, fields: row.erased_fields ? JSON.parse(row.erased_fields) : [] } : null);
    }
    return held.get(id);
  };
  return {
    secureDelete,
    table: TABLE,
    erasedPage(after = '', limit = 64) {
      return sql.exec(`SELECT record_id, erased_fields FROM ${TABLE} WHERE erased_at IS NOT NULL AND record_id > ? ORDER BY record_id LIMIT ?`, after, limit)
        .toArray().map(row => ({ id: row.record_id, fields: row.erased_fields ? JSON.parse(row.erased_fields) : [] }));
    },
    // Forward declarations and remote erasure evidence can add fields, but
    // never replace the original erasure time or restore a removed key.
    broadenErasure(id, fields) {
      const row = rowOf(id);
      if (!row?.erased_at) return null;
      const merged = [...new Map([...(row.fields ?? []), ...fields].map(field => [JSON.stringify(field), field])).values()];
      if (merged.length === (row.fields ?? []).length) return null;
      sql.exec(`UPDATE ${TABLE} SET erased_fields = ? WHERE record_id = ? AND erased_at IS NOT NULL`, JSON.stringify(merged), id);
      held.set(id, { ...row, key: null, fields: merged });
      return merged;
    },
    /** The record's key, or null when it has none or was erased. */
    keyOf: id => rowOf(id)?.key ?? null,
    /** The record's key, made now when it has none (an erased record written again gets a new key), pending until the
     *  log row of the write that made it takes it. */
    ensure(id) {
      const row = rowOf(id);
      if (row?.key) return row.key;
      const key = random(32);
      pending.set(id, key);
      held.set(id, { key, erased_at: null, fields: [] });
      return key;
    },
    /** The same, kept in the table at once: for a key made by work that writes no log row (an index built later). */
    ensureKept(id) {
      const row = rowOf(id);
      if (row?.key) return row.key;
      const key = random(32);
      sql.exec(`INSERT INTO ${TABLE} (record_id, key, erased_at) VALUES (?, ?, NULL) ON CONFLICT (record_id) DO UPDATE SET key = excluded.key, erased_at = NULL`, id, key);
      held.set(id, { key, erased_at: null, fields: [] });
      return key;
    },
    /** A key read with its record ({ key: base64, at }), held so opening its fields reads nothing more. */
    prime(id, entry) {
      if (!held.has(id) && typeof entry?.key === 'string') held.set(id, { key: fromBase64(entry.key), at: entry.at ?? null, erased_at: null, fields: [] });
    },
    /** What a record keeps of its key ({ key: base64, at: the open-log row that made it }), from what is held here (no
     *  statement); a key made by this write is at `nextRow`. Null when none is held or it was erased. */
    entryOf(id, nextRow) {
      if (pending.has(id)) return { key: toBase64(pending.get(id)), at: nextRow };
      const row = held.get(id);
      return row?.key ? { key: toBase64(row.key), ...(Number.isSafeInteger(row.at) ? { at: row.at } : {}) } : null;
    },
    /** The open-log row a held key was made in, or null. */
    rowOf: id => (Number.isSafeInteger(held.get(id)?.at) ? held.get(id).at : null),
    /** The keys made since the last call, { id: base64 } or null, for the log row being written to keep (open-log row
     *  `at`, held with each so an erasure finds the row). */
    takePending(at = null) {
      if (!pending.size) return null;
      const out = Object.fromEntries([...pending].map(([id, key]) => [id, toBase64(key)]));
      for (const id of pending.keys()) { const row = held.get(id); if (row) row.at = at; }
      pending.clear();
      return out;
    },
    /** Keys a sealing of the open log moves into the table: { id: base64 }, a tombstone already kept winning. */
    keep(found) {
      for (const [id, text] of Object.entries(found ?? {})) {
        if (typeof text !== 'string') continue;
        sql.exec(`INSERT INTO ${TABLE} (record_id, key, erased_at) VALUES (?, ?, NULL) ON CONFLICT (record_id) DO NOTHING`, id, fromBase64(text));
      }
      held.clear();
    },
    /** Deletes the record's key, keeping the tombstone a copy learns it from, with the fields it erased (a copy that
     *  holds them as words, written before they were erasable, takes them out of its own rows). */
    erase(id, fields = []) {
      const previous = rowOf(id);
      const at = previous?.erased_at ?? now().toISOString();
      if (previous?.erased_at) fields = [...new Map([...(previous.fields ?? []), ...fields]
        .map(field => [JSON.stringify(field), field])).values()];
      sql.exec(`INSERT INTO ${TABLE} (record_id, key, erased_at, erased_fields) VALUES (?, NULL, ?, ?) ON CONFLICT (record_id) DO UPDATE SET key = NULL, erased_at = excluded.erased_at, erased_fields = excluded.erased_fields`, id, at, JSON.stringify(fields));
      held.set(id, { key: null, erased_at: at, fields });
      pending.delete(id);
    },
    erased: id => Boolean(rowOf(id)?.erased_at),
    /** Whether this object erased the record's key (held only: no statement). */
    erasedHere: id => Boolean(held.get(id)?.erased_at),
    /** What a copy needs to open these records: { id: key (base64) | { erased: [fields] } } for the ids that have a row. */
    keysFor(ids) {
      const unique = [...new Set(ids)], out = {};
      // The store can resolve current log metadata in bounded groups. A cold
      // miss must not re-open every record individually merely to prove it has no key.
      for (let at = 0; at < unique.length; at += 64) {
        const missing = unique.slice(at, at + 64).filter(id => !held.has(id));
        if (!missing.length) continue;
        if (missing.length === 1) { rowOf(missing[0]); continue; }
        const logged = inLogMany ? inLogMany(missing) : new Map(missing.map(id => [id, inLog(id)]));
        const tableIds = [];
        for (const id of missing) {
          // The current-root owner may already have primed this positive key.
          if (held.has(id)) continue;
          const entry = logged.get(id);
          if (entry) held.set(id, { key: fromBase64(entry.key), at: entry.at ?? null, erased_at: null, fields: [] });
          else tableIds.push(id);
        }
        if (!tableIds.length) continue;
        const rows = new Map(sql.exec(`SELECT record_id, key, erased_at, erased_fields FROM ${TABLE}
          WHERE record_id IN (${tableIds.map(() => '?').join(',')}) LIMIT ?`, ...tableIds, tableIds.length).toArray()
          .map(row => [row.record_id, row]));
        for (const id of tableIds) {
          const row = rows.get(String(id));
          held.set(id, row ? { key: row.key ? new Uint8Array(row.key) : null, erased_at: row.erased_at ?? null,
            fields: row.erased_fields ? JSON.parse(row.erased_fields) : [] } : null);
        }
      }
      for (const id of unique) {
        const row = held.get(id);
        if (row) out[id] = row.key ? toBase64(row.key) : { erased: row.fields ?? [] };
      }
      return out;
    },
    /** Takes keys and tombstones another copy sent; answers [{ id, fields }] for each record it erased here. A
     *  tombstone always wins. */
    take(sent) {
      const erased = [];
      for (const [id, key] of Object.entries(sent ?? {})) {
        const row = rowOf(id);
        if (key === null || typeof key === 'object') {
          const fields = Array.isArray(key?.erased) ? key.erased.filter(field => typeof field === 'string' || (Array.isArray(field) && field.length > 0 && field.every(part => typeof part === 'string'))) : [];
          if (!row?.erased_at) { this.erase(id, fields); erased.push({ id, fields }); }
          else { const broadened = this.broadenErasure(id, fields); if (broadened) erased.push({ id, fields: broadened }); }
          continue;
        }
        if (row || typeof key !== 'string') continue;
        const bytes = fromBase64(key);
        sql.exec(`INSERT INTO ${TABLE} (record_id, key, erased_at) VALUES (?, ?, NULL) ON CONFLICT (record_id) DO NOTHING`, id, bytes);
        held.set(id, { key: bytes, erased_at: null });
      }
      return erased;
    },
    // Dropped on every rollback (record-log-store replay): a key made in a transaction that rolled back is gone with it.
    forgetCached: () => { held.clear(); pending.clear(); },
  };
}

/**
 * The erasures still taking words out of rows kept before their fields were erasable (record-log-store scrubStep), and
 * where the one pass over the log that serves them has reached, kept beside the store so a restart goes on from there.
 * A record waits in `rows` until a pass that began after it was queued has read every log table, then in `archives`
 * until its host has rewritten the kept history files that hold it (a host keeping none moves it straight to `done`).
 */
export function erasureQueue(sql, { now = () => new Date() } = {}) {
  sql.exec('CREATE TABLE IF NOT EXISTS record_erasure_scrubs (record_id TEXT PRIMARY KEY, fields TEXT NOT NULL, phase TEXT NOT NULL, queued_at TEXT NOT NULL, done_at TEXT)');
  // The waiting page of one phase is read on every wake (the scheduler's record-erasure source): from this index, not a
  // scan of every erasure the store ever did.
  sql.exec('CREATE INDEX IF NOT EXISTS record_erasure_scrubs_phase ON record_erasure_scrubs (phase, queued_at, record_id)');
  sql.exec('CREATE TABLE IF NOT EXISTS record_erasure_pass (id INTEGER PRIMARY KEY CHECK (id = 1), ids TEXT NOT NULL, scanned TEXT NOT NULL, table_name TEXT, after_rowid INTEGER NOT NULL, rewritten INTEGER NOT NULL)');
  // reads-ok: each caller below names a LIMIT or reads the one-row pass (id = 1).
  const all = (query, ...params) => sql.exec(query, ...params).toArray();
  return {
    queue(id, fields) {
      sql.exec("INSERT INTO record_erasure_scrubs (record_id, fields, phase, queued_at, done_at) VALUES (?, ?, 'rows', ?, NULL) ON CONFLICT (record_id) DO UPDATE SET fields = excluded.fields, phase = 'rows', queued_at = excluded.queued_at, done_at = NULL",
        id, JSON.stringify(fields), now().toISOString());
    },
    phaseOf: id => all('SELECT phase FROM record_erasure_scrubs WHERE record_id = ? LIMIT 1', id)[0]?.phase ?? null,
    // The records waiting in one phase, oldest first, a bounded page: [{ id, fields }].
    waiting: (phase, limit = 500) => all('SELECT record_id, fields FROM record_erasure_scrubs WHERE phase = ? ORDER BY queued_at, record_id LIMIT ?', phase, limit)
      .map(row => ({ id: row.record_id, fields: JSON.parse(row.fields) })),
    move(ids, phase) {
      for (const id of ids) sql.exec(`UPDATE record_erasure_scrubs SET phase = ?, done_at = ${phase === 'done' ? '?' : 'NULL'} WHERE record_id = ?`, ...(phase === 'done' ? [phase, now().toISOString(), id] : [phase, id]));
    },
    pass: () => {
      const row = all('SELECT ids, scanned, table_name, after_rowid, rewritten FROM record_erasure_pass WHERE id = 1 LIMIT 1')[0];
      return row ? { ids: JSON.parse(row.ids), scanned: JSON.parse(row.scanned), table: row.table_name, after: row.after_rowid, rewritten: row.rewritten } : null;
    },
    keepPass(pass) {
      if (!pass) { sql.exec('DELETE FROM record_erasure_pass WHERE id = 1'); return; }
      sql.exec('INSERT INTO record_erasure_pass (id, ids, scanned, table_name, after_rowid, rewritten) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ids = excluded.ids, scanned = excluded.scanned, table_name = excluded.table_name, after_rowid = excluded.after_rowid, rewritten = excluded.rewritten',
        JSON.stringify(pass.ids), JSON.stringify(pass.scanned), pass.table, pass.after, pass.rewritten);
    },
  };
}
