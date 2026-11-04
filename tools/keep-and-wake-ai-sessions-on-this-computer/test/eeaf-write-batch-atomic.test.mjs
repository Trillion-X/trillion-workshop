// test/eeaf-write-batch-atomic.test.mjs
// A write makes its existence checks together (prefetch) and logs its rows 12 to a statement (flush). A write that
// fails partway through those batches (a thrown insert in the middle of the log rows, or of the entity rows) must leave
// the store exactly as it was, and the store instance that saw it fail must write the same records afterwards as a fresh
// one: the whole write is one transaction, and a failed one makes the instance forget what it remembered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

const hash = text => `h:${text}`;
const records = (from, count) => Array.from({ length: count }, (_, index) => ({ id: `note:${String(from + index).padStart(4, '0')}`, type: 'note', value: {
  title: `Note ${from + index}`, tags: [{ name: `a${from + index}` }, { name: `b${from + index}` }], body: { text: `Words ${from + index}` } } }));

// Every row of every table, as text, but for the ids the log makes up for itself.
function snapshot(host) {
  const tables = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray().map(row => row.name);
  return Object.fromEntries(tables.map(name => [name, host.sql.exec(`SELECT * FROM "${name}"`).toArray().map(row => JSON.stringify(row)).sort()]));
}
// The same, without the log rows' own ids and times, to compare two stores that wrote the same records.
const content = host => Object.fromEntries(Object.entries(snapshot(host)).filter(([name]) => !/bitemporal|log/.test(name)));

function failing(host, matches, nth) {
  const exec = host.sql.exec.bind(host.sql);
  let seen = 0, armed = true;
  host.sql.exec = (query, ...params) => {
    if (armed && matches.test(query) && (seen += 1) === nth) { armed = false; throw new Error('the write fails here'); }
    return exec(query, ...params);
  };
  return () => { armed = false; };
}

for (const [name, matches, nth] of [
  ['the second batch of log rows', /^INSERT INTO bitemporal_facts/, 2],
  ['an entity row in the middle of the entities', /^INSERT INTO entity \(/, 20],
  ['an attribute fact after the entities are in', /^INSERT INTO attribute_fact/, 30],
]) {
  test(`a write that fails at ${name} leaves the store as it was, and the instance writes the same afterwards`, () => {
    const host = sqliteHost(':memory:');
    const store = eeafStore(host.sql, { transaction: host.transaction, hash });
    store.write(records(0, 5));
    const before = snapshot(host);

    failing(host, matches, nth);
    assert.throws(() => store.write(records(100, 40)), /the write fails here/);
    assert.deepEqual(snapshot(host), before, 'nothing of the failed write is left, rows or log');

    store.write(records(100, 40));
    const fresh = sqliteHost(':memory:');
    const control = eeafStore(fresh.sql, { transaction: fresh.transaction, hash });
    control.write(records(0, 5));
    control.write(records(100, 40));
    assert.deepEqual(content(host), content(fresh), 'the instance that saw the failure wrote what a fresh one writes');
    assert.equal(store.read('note:0120').title, 'Note 120');
  });
}
