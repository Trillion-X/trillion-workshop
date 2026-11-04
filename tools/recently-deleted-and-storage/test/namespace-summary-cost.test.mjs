import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';

const one = (sql, query) => sql.exec(query).toArray()[0];
const exact = sql => {
  const files = one(sql, 'SELECT COUNT(*) AS files, COALESCE(SUM(byte_length), 0) AS bytes FROM namespace_files');
  const names = one(sql, 'SELECT COUNT(*) AS names FROM namespace_names');
  const uploads = one(sql, 'SELECT COUNT(*) AS files, COALESCE(SUM(byte_length), 0) AS bytes FROM namespace_growing WHERE finished IS NULL');
  const chunks = one(sql, 'SELECT COUNT(*) AS chunks, COALESCE(SUM(byte_length), 0) AS bytes FROM namespace_chunks');
  const by_origin = Object.fromEntries(sql.exec('SELECT origin, COUNT(*) AS files, COALESCE(SUM(byte_length), 0) AS bytes FROM namespace_files GROUP BY origin').toArray().map(row => [row.origin, { files: row.files, bytes: row.bytes }]));
  return { files: files.files, bytes: files.bytes, by_origin, names: names.names, uploads_in_progress: uploads.files, bytes_in_progress: uploads.bytes, chunks: chunks.chunks, chunk_bytes: chunks.bytes };
};

const addFile = (sql, identity, origin, bytes) => sql.exec(`INSERT INTO namespace_files
  (identity, byte_length, media_type, origin, key, part_bytes, stored_at, checked_at)
  VALUES (?, ?, 'application/octet-stream', ?, ?, 0, '2026-10-05', '2026-10-05')`, identity, bytes, origin, identity);
const addName = (sql, name, identity = null, bytes = null) => sql.exec(`INSERT INTO namespace_names
  (name, collection, identity, byte_length, named_at) VALUES (?, '/', ?, ?, '2026-10-05')`, name, identity, bytes);
const addChunk = (sql, chunk, bytes) => sql.exec(`INSERT INTO namespace_chunks
  (chunk, byte_length, origin, key, stored_at) VALUES (?, ?, 'one', ?, '2026-10-05')`, chunk, bytes, chunk);

test('one lazy backfill stays exact through direct file, name, upload and chunk mutations', () => {
  const { sql } = sqliteHost(':memory:');
  const index = namespaceStore(sql);
  addFile(sql, 'a', 'one', 100);
  addFile(sql, 'b', 'two', 200);
  addName(sql, '/a', 'a', 100);
  addName(sql, '/folder');
  addChunk(sql, 'c1', 80);
  sql.exec(`INSERT INTO namespace_growing (growing, byte_length, origin, started_at) VALUES ('up:one', 90, 'one', '2026-10-05')`);
  sql.exec(`INSERT INTO namespace_growing (growing, byte_length, origin, started_at, finished) VALUES ('up:done', 12, 'one', '2026-10-05', 'a')`);
  assert.deepEqual(index.summary(), exact(sql), 'existing rows seed the counts once');

  sql.exec("UPDATE namespace_files SET origin = 'two', byte_length = 125 WHERE identity = 'a'");
  assert.deepEqual(index.summary(), exact(sql), 'origin and byte changes move the exact totals');
  const beforeNoop = one(sql, 'SELECT total_changes() AS changes').changes;
  sql.exec("UPDATE namespace_files SET origin = 'two', byte_length = 125 WHERE identity = 'a'");
  assert.equal(one(sql, 'SELECT total_changes() AS changes').changes - beforeNoop, 1, 'an unchanged file update writes only its base row');
  addFile(sql, 'c', 'one', 50);
  sql.exec("DELETE FROM namespace_files WHERE identity = 'b'");
  addName(sql, '/c', 'c', 50);
  sql.exec("DELETE FROM namespace_names WHERE name = '/folder'");
  sql.exec("UPDATE namespace_names SET name = '/a-renamed' WHERE name = '/a'");
  assert.deepEqual(index.summary(), exact(sql), 'direct inserts, deletes and a name update remain exact');

  sql.exec("UPDATE namespace_growing SET byte_length = 120 WHERE growing = 'up:one'");
  assert.deepEqual(index.summary(), exact(sql), 'an open upload can grow');
  sql.exec("UPDATE namespace_growing SET finished = 'a' WHERE growing = 'up:one'");
  sql.exec("DELETE FROM namespace_growing WHERE growing = 'up:done'");
  addChunk(sql, 'c2', 20);
  sql.exec("UPDATE namespace_chunks SET byte_length = 81 WHERE chunk = 'c1'");
  sql.exec("DELETE FROM namespace_chunks WHERE chunk = 'c2'");
  assert.deepEqual(index.summary(), exact(sql), 'finished uploads and changed chunks remain exact');

  index.clear();
  assert.deepEqual(index.summary(), exact(sql), 'account clearing removes every count');
  assert.deepEqual(index.summary(), { files: 0, bytes: 0, by_origin: {}, names: 0, uploads_in_progress: 0, bytes_in_progress: 0, chunks: 0, chunk_bytes: 0 });
});

test('an interrupted seed recovers and a reopened warm summary does not scan base tables', () => {
  const { sql } = sqliteHost(':memory:');
  const index = namespaceStore(sql);
  addFile(sql, 'a', 'one', 10);
  assert.deepEqual(index.summary(), exact(sql));
  sql.exec('UPDATE namespace_summary_counts SET ready = 0, files = 999 WHERE id = 1');
  sql.exec('DROP TRIGGER namespace_summary_file_added');
  addFile(sql, 'b', 'two', 20);
  assert.deepEqual(index.summary(), exact(sql), 'an incomplete trigger set is reseeded from base rows');

  const statements = [];
  const traced = { exec(query, ...values) { statements.push(query); return sql.exec(query, ...values); } };
  const reopened = namespaceStore(traced);
  statements.length = 0;
  assert.deepEqual(reopened.summary(), exact(sql));
  assert.equal(statements.length, 2, 'a warm read selects one totals row and one origin page');
  assert.ok(statements.every(query => /FROM namespace_summary_(counts|origins)/.test(query)), 'no warm read scans source rows');
  addFile(sql, 'c', 'two', 30);
  assert.deepEqual(reopened.summary(), exact(sql), 'triggers remain active across a store reopen');
});

test('the first count in bounded chunks agrees with the table, writes nothing until its last chunk, and the totals then follow the triggers', () => {
  const { sql } = sqliteHost(':memory:');
  const index = namespaceStore(sql);
  for (let at = 0; at < 25; at++) addFile(sql, `f${at}`, at % 3 ? 'one' : 'two', 10 + at);
  for (let at = 0; at < 7; at++) addName(sql, `/n${at}`, `f${at}`, 10);
  for (let at = 0; at < 31; at++) addChunk(sql, `c${at}`, 5 + at);
  sql.exec(`INSERT INTO namespace_growing (growing, byte_length, origin, started_at) VALUES ('up:one', 90, 'one', '2026-10-05')`);
  sql.exec(`INSERT INTO namespace_growing (growing, byte_length, origin, started_at, finished) VALUES ('up:done', 12, 'one', '2026-10-05', 'a')`);
  sql.exec('DELETE FROM namespace_summary_counts');
  let step = { cursor: null, done: false }, calls = 0;
  while (!step.done) {
    const before = one(sql, 'SELECT total_changes() AS changes').changes;
    step = index.summaryStep(step.cursor, 10);
    calls += 1;
    if (!step.done) assert.equal(one(sql, 'SELECT total_changes() AS changes').changes, before, 'a chunk writes nothing');
  }
  assert.ok(calls > 4, 'the tables were counted in several chunks');
  assert.equal(one(sql, 'SELECT ready FROM namespace_summary_counts').ready, 1);
  assert.equal(index.summaryStep(null, 10).done, true, 'counted totals are done at once');
  index.keepSummary();
  assert.deepEqual(index.summary(), exact(sql), 'the chunked count is exact');
  addFile(sql, 'late', 'one', 77);
  assert.deepEqual(index.summary(), exact(sql), 'the triggers keep the totals after it');
});
