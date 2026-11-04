// The in-memory name view answers which names hold every asked word from memory, picks up names added since it was
// read by their row ids alone, reads everything again after any delete (so a reused row id never answers an old
// name), and stands aside when a store's names would pass its memory bound.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';
import { namespaceView } from '../namespace-view.mjs';
import settings from '../namespace-view.json' with { type: 'json' };

const namesOf = (sql, rows) => rows.length ? sql.exec('SELECT name FROM namespace_names WHERE rowid IN (SELECT value FROM json_each(?)) ORDER BY name', JSON.stringify(rows)).toArray().map(row => row.name) : [];
const file = name => ({ name, identity: `1f:${'a'.repeat(64)}`, byte_length: 1 });

test('a search finds every name whose last part holds every word, in any order and case, and never a folder word', () => {
  const { sql } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  names.putNames([file('/Pottery/Forehand side VIEW.mp4'), file('/Pottery/backhand.mov'), file('/forehand-drills/notes.txt'), file('/a/Don’t forget forehand.txt')]);
  const view = namespaceView(sql);
  assert.deepEqual(namesOf(sql, view.candidates(['forehand'], 50)), ['/Pottery/Forehand side VIEW.mp4', '/a/Don’t forget forehand.txt']);
  assert.deepEqual(namesOf(sql, view.candidates(['view', 'forehand'], 50)), ['/Pottery/Forehand side VIEW.mp4']);
  assert.deepEqual(namesOf(sql, view.candidates(['dont'], 50)), ['/a/Don’t forget forehand.txt'], 'an apostrophe is dropped as the search words drop it');
  assert.deepEqual(view.candidates(['drills'], 50), [], 'a folder\'s words are not the file\'s');
});

test('names added after the view was read are found by reading only the rows added since', () => {
  const { sql } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  names.putNames([file('/one.mp4')]);
  const view = namespaceView(sql);
  assert.equal(view.candidates(['two'], 10).length, 0);
  let wholeReads = 0;
  const execute = sql.exec.bind(sql);
  sql.exec = (query, ...args) => { if (query.includes('FROM namespace_names WHERE rowid > ?') && args[0] === -1) wholeReads += 1; return execute(query, ...args); };
  names.putNames([file('/two.mp4')]);
  assert.deepEqual(namesOf(sql, view.candidates(['two'], 10)), ['/two.mp4']);
  assert.equal(wholeReads, 0, 'adding a name never reads every name again');
});

test('after a delete the view reads every name again, so a row id handed to a new name answers the new name', () => {
  const { sql } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  names.putNames([file('/keep.mp4'), file('/gone.mp4')]);
  const view = namespaceView(sql);
  assert.equal(view.candidates(['gone'], 10).length, 1);
  names.putNames([{ name: '/gone.mp4', remove: true }]);
  names.putNames([file('/arrived.mp4')]);
  assert.deepEqual(view.candidates(['gone'], 10), []);
  assert.deepEqual(namesOf(sql, view.candidates(['arrived'], 10)), ['/arrived.mp4']);
});

test('a store whose names pass the memory bound is searched by its table', () => {
  const { sql } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const long = 'x'.repeat(4000);
  const count = Math.ceil(settings.most_bytes / long.length) + 2;
  for (let at = 0; at < count; at += 500) names.putNames(Array.from({ length: Math.min(500, count - at) }, (_, i) => file(`/big/${long}${at + i}`)));
  assert.equal(namespaceView(sql).candidates(['x'], 10), null);
});
