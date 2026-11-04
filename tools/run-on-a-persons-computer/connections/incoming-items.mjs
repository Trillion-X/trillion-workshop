// A connection's durable incoming items, consumed by the existing Mac reader and /inbound door.
// This is integration progress, not the provider's database or session. Pending words survive a bounded
// recent-messages view, an offline account and process restart. Only a confirmed door receipt acknowledges
// an item. Its account and immutable source identity are retained even after acknowledgement, so replay
// cannot replace the original words or send them again. An explicit account-scoped erase removes selected
// local copies and retains only hashed source tombstones; pending items require explicit inclusion.
// Shared receipts and provider history are not changed. No credentials belong in this store.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const sourceHash = (account, source) => createHash('sha256').update(JSON.stringify([account, source])).digest('hex');

const open = (file, write = false) => {
  if (!write && !existsSync(file)) throw new Error('This connection has not started receiving items.');
  if (write) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: !write });
  db.exec('PRAGMA busy_timeout = 5000');
  if (write) db.exec(`
    CREATE TABLE IF NOT EXISTS incoming_state (id INTEGER PRIMARY KEY CHECK (id = 1), account TEXT, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incoming_accounts (account TEXT PRIMARY KEY, started_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incoming_erased (source_hash TEXT PRIMARY KEY, account TEXT NOT NULL, erased_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incoming_items (
      source_id TEXT PRIMARY KEY, account TEXT NOT NULL, source_ref TEXT NOT NULL,
      conversation_id TEXT NOT NULL, sender TEXT NOT NULL, title TEXT, text TEXT NOT NULL,
      at TEXT NOT NULL, kept_at TEXT NOT NULL, acknowledged_at TEXT
    );
    CREATE INDEX IF NOT EXISTS incoming_pending ON incoming_items(account, acknowledged_at, kept_at);
  `);
  return db;
};
const using = (file, write, action) => { const db = open(file, write); try { return action(db); } finally { db.close(); } };
const transaction = (db, action) => {
  db.exec('BEGIN IMMEDIATE');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};
const erased = (db, account, source) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'incoming_erased'").get()) && Boolean(db.prepare('SELECT 1 FROM incoming_erased WHERE source_hash = ? AND account = ?').get(sourceHash(account, source), account));
const stateOf = db => db.prepare('SELECT state.account, state.status, accounts.started_at FROM incoming_state state LEFT JOIN incoming_accounts accounts ON accounts.account = state.account WHERE state.id = 1').get();
const allowed = (db, account = null) => {
  const state = stateOf(db);
  if (state?.status !== 'active' || !state.account) throw new Error(`This connection is ${state?.status ?? 'not connected'}; incoming items remain on this computer.`);
  if (account && state.account !== account) throw new Error('This incoming item belongs to a different connected account.');
  return state;
};

export function incomingItems(file, { now = () => new Date().toISOString() } = {}) {
  return {
    state: () => existsSync(file) ? using(file, false, stateOf) : null,
    setState(status, account = null) {
      return using(file, true, db => {
        const current = stateOf(db);
        if (status === 'active' && account) db.prepare('INSERT OR IGNORE INTO incoming_accounts(account, started_at) VALUES(?, ?)').run(account, now());
        db.prepare('INSERT INTO incoming_state(id, account, status) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET account = excluded.account, status = excluded.status').run(account ?? current?.account ?? null, status);
      });
    },
    put(item) {
      return using(file, true, db => transaction(db, () => {
        allowed(db, item.account);
        if (erased(db, item.account, item.source_id)) return false;
        return db.prepare(`INSERT OR IGNORE INTO incoming_items(source_id, account, source_ref, conversation_id, sender, title, text, at, kept_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.source_id, item.account, item.source_ref, item.conversation_id, item.from, item.title ?? null, item.text, item.at, now()).changes > 0;
      }));
    },
    summary(account) {
      if (!account || !existsSync(file)) return { pending: 0, delivered: 0, erased: 0 };
      return using(file, true, db => ({
        pending: db.prepare('SELECT COUNT(*) AS n FROM incoming_items WHERE account = ? AND acknowledged_at IS NULL').get(account).n,
        delivered: db.prepare('SELECT COUNT(*) AS n FROM incoming_items WHERE account = ? AND acknowledged_at IS NOT NULL').get(account).n,
        erased: db.prepare('SELECT COUNT(*) AS n FROM incoming_erased WHERE account = ?').get(account).n,
      }));
    },
    accounts() {
      if (!existsSync(file)) return [];
      return using(file, false, db => db.prepare('SELECT account FROM incoming_accounts ORDER BY account').all().map(row => row.account));
    },
    list({ account, after = '', limit = 50 } = {}) {
      if (typeof account !== 'string' || !account.trim()) throw new Error('Name the exact account whose incoming copies may be listed.');
      if (typeof after !== 'string' || after.length > 4000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Use an exact after source ID and a limit between 1 and 100.');
      return using(file, false, db => {
        const rows = db.prepare(`SELECT source_id, source_ref, conversation_id, sender AS "from", at, acknowledged_at
          FROM incoming_items WHERE account = ? AND source_id > ? ORDER BY source_id LIMIT ?`).all(account, after, limit + 1);
        const items = rows.slice(0, limit).map(({ acknowledged_at, ...item }) => ({ ...item, pending: !acknowledged_at }));
        return { account, items, next_after: rows.length > limit ? items.at(-1).source_id : null };
      });
    },
    erase({ account, source_ids, include_pending = false } = {}) {
      if (typeof account !== 'string' || !account.trim()) throw new Error('Name the exact account whose incoming copy may be erased.');
      if (!Array.isArray(source_ids) || !source_ids.length || source_ids.length > 100 || source_ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 4000)) throw new Error('source_ids must contain between 1 and 100 exact incoming source IDs.');
      if (typeof include_pending !== 'boolean') throw new Error('include_pending must be true or false.');
      return using(file, true, db => transaction(db, () => {
        const ids = [...new Set(source_ids)];
        const selected = ids.map(id => ({ id, row: db.prepare('SELECT account, acknowledged_at FROM incoming_items WHERE source_id = ?').get(id), erased: erased(db, account, id) }));
        if (selected.some(item => item.row && item.row.account !== account)) throw new Error('An incoming item belongs to a different account. Nothing was erased.');
        if (selected.some(item => !item.row && !item.erased)) throw new Error('An incoming source ID was not found for this account. Nothing was erased.');
        const pending = selected.filter(item => item.row && !item.row.acknowledged_at);
        if (pending.length && !include_pending) throw new Error('Some selected items are still pending. Nothing was erased; include_pending: true is required to erase those exact undelivered copies.');
        db.exec('PRAGMA secure_delete = ON');
        for (const item of selected.filter(item => item.row)) {
          db.prepare('INSERT OR IGNORE INTO incoming_erased(source_hash, account, erased_at) VALUES(?, ?, ?)').run(sourceHash(account, item.id), account, now());
          db.prepare('DELETE FROM incoming_items WHERE source_id = ? AND account = ?').run(item.id, account);
        }
        return { state: 'erased', account, erased: selected.filter(item => item.row).length, already_erased: selected.filter(item => item.erased).length, pending_erased: pending.length, shared_history_changed: false };
      }));
    },
  };
}

// A journal contains only newly received items explicitly admitted by its connection, never history scraped
// from a provider store. Read every pending row, irrespective of source time or when the Mac reader first ran.
export const readIncomingItems = (file, { includeDelivered = false } = {}) => using(file, false, db => {
  const { account } = allowed(db);
  return db.prepare(`SELECT source_id, account, source_ref, conversation_id, sender AS "from", title, text, at
    FROM incoming_items WHERE account = ? ${includeDelivered ? '' : 'AND acknowledged_at IS NULL'} ORDER BY kept_at, source_id`).all(account)
    .map(item => ({ ...item, from_person: false }));
});

// Recheck immediately before each send: a stop, logout or account change while the previous delivery was
// awaiting its answer cannot admit the following item from the old snapshot.
export const assertIncomingAllowed = (file, item) => using(file, false, db => {
  const state = allowed(db, item.account);
  if (erased(db, item.account, item.source_id)) return false;
  if (!db.prepare('SELECT 1 FROM incoming_items WHERE source_id = ? AND account = ? AND text = ? AND at = ?').get(item.source_id, item.account, item.text, item.at)) throw new Error('The incoming item changed before delivery.');
  return state;
});
export const acknowledgeIncomingItem = (file, item) => using(file, true, db => {
  // A reply to a send already in flight may finish after stop/account change. It acknowledges only that exact
  // account's immutable item, and does not enable the connection or claim another account's item.
  db.prepare(`UPDATE incoming_items SET acknowledged_at = COALESCE(acknowledged_at, ?)
    WHERE source_id = ? AND account = ? AND at = ? AND text = ?`).run(new Date().toISOString(), item.source_id, item.account, item.at, item.text);
});
