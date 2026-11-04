import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';

test('child folders keep sibling names while indexed seeks skip deep descendants', () => {
  const { db, sql } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const paths = [
    '/A/own.txt', '/A-/own.txt', '/A./own.txt', '/A0/own.txt',
    '/A/deep/own.txt', '/A/deep-/own.txt', '/A/deep0/own.txt',
    '/A/second/own.txt', '/B/own.txt', '/😀/own.txt',
    ...Array.from({ length: 60 }, (_, i) => `/A/deep/branch-${i}/leaf/file.txt`),
  ];
  names.putNames(paths.map(name => ({ name })));
  const collectionPlan = db.prepare('EXPLAIN QUERY PLAN SELECT collection FROM namespace_names WHERE collection >= ? ORDER BY collection LIMIT 1').all('/A/');
  assert.ok(collectionPlan.some(row => row.detail.includes('SEARCH namespace_names USING COVERING INDEX namespace_names_collection')));

  let seeks = 0;
  const execute = sql.exec.bind(sql);
  sql.exec = (query, ...args) => {
    if (query.startsWith('SELECT collection FROM namespace_names WHERE collection ')) seeks += 1;
    return execute(query, ...args);
  };
  assert.deepEqual(names.childFolders('/'), ['/A', '/A-', '/A.', '/A0', '/B', '/😀']);
  assert.deepEqual(names.childFolders('/A'), ['/A/deep', '/A/deep-', '/A/deep0', '/A/second']);
  assert.deepEqual(names.childFolders('/A/deep'), Array.from({ length: 60 }, (_, i) => `/A/deep/branch-${i}`).sort());
  assert.deepEqual(names.childFolders('/missing'), []);
  // /A has 60 deep branches but only four direct children, so it takes a bounded number of index seeks.
  seeks = 0;
  assert.deepEqual(names.childFolders('/A'), ['/A/deep', '/A/deep-', '/A/deep0', '/A/second']);
  assert.ok(seeks <= 10, `expected at most ten index seeks, got ${seeks}`);
});

test('a wide folder takes a bounded number of seeks and still returns all children', () => {
  const { sql } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const children = [...Array.from({ length: 130 }, (_, i) => `/wide/f${String(i).padStart(3, '0')}`), '/wide/😀'];
  names.putNames(children.map(child => ({ name: `${child}/item.txt` })));
  let seeks = 0;
  let rangeScans = 0;
  const execute = sql.exec.bind(sql);
  sql.exec = (query, ...args) => {
    if (query.startsWith('SELECT collection FROM namespace_names WHERE collection ')) seeks += 1;
    if (query.startsWith('SELECT DISTINCT collection FROM namespace_names WHERE collection ')) rangeScans += 1;
    return execute(query, ...args);
  };
  assert.deepEqual(names.childFolders('/wide'), children.sort());
  assert.ok(seeks <= 258, `expected at most 258 seeks, got ${seeks}`);
  assert.equal(rangeScans, 1);
});
