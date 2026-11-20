// Test helper (not a test file): an in-memory store with the tables the reading reads, and the query seam the reader takes.
// The reader writes $n placeholders (the store's own SQL); SQLite takes the same placeholders as ?n.
import { DatabaseSync } from 'node:sqlite';

export function openStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, speaker TEXT, app TEXT, at TEXT, text TEXT);
    CREATE TABLE namespace_results (identity TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, produced_by TEXT,
      value_identity TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (identity, kind));
    CREATE TABLE activity (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, app TEXT, row TEXT NOT NULL, ok INTEGER);
  `);
  const query = (sql, params = []) => db.prepare(sql.replace(/\$(\d+)/g, '?$1')).all(...params).map(row => ({ ...row }));
  return { db, query };
}

export function addMessage(db, { id, recorded_at, speaker = 'person', app = 'Claude', text }) {
  db.prepare('INSERT INTO messages (id, recorded_at, speaker, app, at, text) VALUES (?, ?, ?, ?, ?, ?)').run(id, recorded_at, speaker, app, recorded_at, text);
}

export function addResult(db, { identity, kind, recorded_at, value }) {
  db.prepare('INSERT INTO namespace_results (identity, kind, value, produced_by, value_identity, recorded_at) VALUES (?, ?, ?, NULL, ?, ?)')
    .run(identity, kind, value, `v-${identity}`, recorded_at);
}

export function addActivity(db, { seq, at, app = 'Codex', row }) {
  db.prepare('INSERT INTO activity (seq, at, app, row, ok) VALUES (?, ?, ?, ?, 1)').run(seq, at, app, JSON.stringify(row));
}
