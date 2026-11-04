// A table leaves a person's store a bounded piece per call (src/let-go-of-table.mjs): its own indexes one a call, then
// rows a batch at a time only while it spans more rowids than one drop may free, then its owner drops it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { letGoStep } from '../src/let-go-of-table.mjs';

test('indexes go first, rows only above the drop size, then the owner drops what is left', () => {
  const { sql } = sqliteHost(':memory:');
  sql.exec('CREATE TABLE big (id TEXT PRIMARY KEY, kind TEXT, at TEXT)');
  sql.exec('CREATE INDEX big_kind ON big (kind)');
  sql.exec('CREATE INDEX big_at ON big (at)');
  for (let n = 0; n < 1050; n += 1) sql.exec('INSERT INTO big VALUES (?, ?, ?)', `r${n}`, `k${n % 7}`, `t${n}`);
  const settings = { drop_rows: 300, delete_rows: 250 };
  const pieces = [];
  for (let piece = null; piece !== 'drop'; ) { piece = letGoStep(sql, 'big', settings); pieces.push(piece); assert.ok(pieces.length < 20); }
  assert.deepEqual(pieces, ['index', 'index', 'rows', 'rows', 'rows', 'drop']);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM big').toArray()[0].n, 300, 'rows below the drop size are left for the drop, never paid for one by one');
  assert.deepEqual(sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'big' AND sql IS NOT NULL").toArray(), []);
  sql.exec('DROP TABLE big');
});

test('a table already small goes straight to its drop', () => {
  const { sql } = sqliteHost(':memory:');
  sql.exec('CREATE TABLE small (id TEXT PRIMARY KEY)');
  sql.exec("INSERT INTO small VALUES ('a')");
  assert.equal(letGoStep(sql, 'small'), 'drop');
  sql.exec('CREATE TABLE empty (id INTEGER)');
  assert.equal(letGoStep(sql, 'empty'), 'drop');
});

test('a let-go step reads the table\'s span by seeks, never by walking its rows', () => {
  const host = sqliteHost(':memory:');
  const { sql } = host;
  sql.exec('CREATE TABLE big (id TEXT PRIMARY KEY, v TEXT)');
  host.transaction(() => { for (let n = 0; n < 5000; n += 1) sql.exec('INSERT INTO big VALUES (?, ?)', `r${n}`, 'x'); });
  const walks = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...params) => {
    if (/^\s*SELECT/i.test(query) && !/LIMIT/i.test(query)) {
      const plan = host.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params).map(row => row.detail).join(' ');
      if (/\bSCAN big\b/.test(plan)) walks.push(query);
    }
    return exec(query, ...params);
  };
  letGoStep(sql, 'big', { drop_rows: 100, delete_rows: 50 });
  assert.deepEqual(walks, []);
});
