import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { labelAPerson } from '../do-work/label-a-person.mjs';

// A real SQLite database standing in for the mounted connection: a select answers its rows, a write answers none.
function fixture(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const db = { exec(sql, ...values) {
    const statement = database.prepare(sql);
    return /^\s*select/i.test(sql) ? statement.all(...values) : (statement.run(...values), []);
  } };
  // A refused label writes no table at all, so a table not yet made holds no rows; rows are copied to plain objects.
  const rows = table => {
    try { return database.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })); }
    catch (error) { if (/no such table/.test(error.message)) return []; throw error; }
  };
  return { db, rows };
}

const at = () => '2026-11-20T00:00:00.000Z';

test('a declared label is written once, with one history row of what was written', t => {
  const { db, rows } = fixture(t);
  assert.deepEqual(labelAPerson({ db, input: { relay: 'target', label: 'unsafe', by: 'labeler' }, now: at }), { labelled: 'target', label: 'unsafe' });
  assert.deepEqual(rows('labels'), [{ relay: 'target', label: 'unsafe', by_relay: 'labeler', at: at() }]);
  assert.equal(rows('native_moderation_history').length, 1);
});

test('the same label from the same person writes nothing new', t => {
  const { db, rows } = fixture(t);
  labelAPerson({ db, input: { relay: 'target', label: 'vouched', by: 'labeler' }, now: at });
  labelAPerson({ db, input: { relay: 'target', label: 'vouched', by: 'labeler' }, now: () => 'later' });
  assert.equal(rows('labels').length, 1);
  assert.equal(rows('labels')[0].at, at());
  assert.equal(rows('native_moderation_history').length, 1);
});

test('a label that is not declared is refused with the declared ones, and nothing is written', t => {
  const { db, rows } = fixture(t);
  assert.throws(() => labelAPerson({ db, input: { relay: 'target', label: 'spam', by: 'labeler' } }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.message, 'label is one of: unwanted-requests, unsafe, vouched');
    return true;
  });
  assert.equal(rows('labels').length, 0);
});

test('an erased identity cannot publish a label', t => {
  const { db, rows } = fixture(t);
  db.exec('CREATE TABLE IF NOT EXISTS native_moderation_erased_relays(relay TEXT PRIMARY KEY)');
  db.exec('INSERT INTO native_moderation_erased_relays VALUES(?)', 'labeler');
  assert.throws(() => labelAPerson({ db, input: { relay: 'target', label: 'unsafe', by: 'labeler' } }), error => error.status === 410);
  assert.equal(rows('labels').length, 0);
});

test('a target and a labeler are both required', t => {
  const { db } = fixture(t);
  assert.throws(() => labelAPerson({ db, input: { relay: '', label: 'unsafe', by: 'labeler' } }), error => error.status === 400);
  assert.throws(() => labelAPerson({ db, input: { relay: 'target', label: 'unsafe' } }), error => error.status === 400);
});
