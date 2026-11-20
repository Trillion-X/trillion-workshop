import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { labelAPerson } from '../do-work/label-a-person.mjs';

// A real SQLite database standing in for the mounted connection: a select answers its rows, a write answers none.
function fixture(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const db = { async exec(sql, ...values) {
    const statement = database.prepare(sql);
    return /^\s*select/i.test(sql) ? statement.all(...values) : (statement.run(...values), []);
  } };
  // A refused label writes no table at all, so a table not yet made holds no rows; rows are copied to plain objects.
  const rows = table => {
    try { return database.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })); }
    catch (error) { if (/no such table/.test(error.message)) return []; throw error; }
  };
  return { db, rows, database };
}

const at = () => '2026-11-20T00:00:00.000Z';

test('a declared label is written once, with one history row of what was written', async t => {
  const { db, rows } = fixture(t);
  assert.deepEqual(await labelAPerson({ db, input: { relay: 'target', label: 'unsafe', by: 'labeler' }, now: at }), { labelled: 'target', label: 'unsafe' });
  assert.deepEqual(rows('labels'), [{ relay: 'target', label: 'unsafe', by_relay: 'labeler', at: at() }]);
  assert.deepEqual(rows('native_moderation_history'), [{ relay: 'target', label: 'unsafe', by_relay: 'labeler', at: at(), action: 'label' }]);
});

test('the same label from the same person writes nothing new', async t => {
  const { db, rows } = fixture(t);
  await labelAPerson({ db, input: { relay: 'target', label: 'vouched', by: 'labeler' }, now: at });
  await labelAPerson({ db, input: { relay: 'target', label: 'vouched', by: 'labeler' }, now: () => 'later' });
  assert.equal(rows('labels').length, 1);
  assert.equal(rows('labels')[0].at, at());
  assert.equal(rows('native_moderation_history').length, 1);
});

test('a label that is not declared is refused with the declared ones, and nothing is written', async t => {
  const { db, rows } = fixture(t);
  await assert.rejects(labelAPerson({ db, input: { relay: 'target', label: 'spam', by: 'labeler' } }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.message, 'label is one of: unwanted-requests, unsafe, vouched');
    return true;
  });
  assert.equal(rows('labels').length, 0);
});

test('an erased identity cannot publish a label', async t => {
  const { db, rows, database } = fixture(t);
  // The erased table is made by the erasure owner; this test makes the one row the refusal reads.
  database.exec('CREATE TABLE native_moderation_erased_relays(relay TEXT PRIMARY KEY)');
  database.prepare('INSERT INTO native_moderation_erased_relays VALUES(?)').run('labeler');
  await assert.rejects(labelAPerson({ db, input: { relay: 'target', label: 'unsafe', by: 'labeler' } }), error => error.status === 410);
  assert.equal(rows('labels').length, 0);
});

test('a target and a labeler are both required', async t => {
  const { db } = fixture(t);
  await assert.rejects(labelAPerson({ db, input: { relay: '', label: 'unsafe', by: 'labeler' } }), error => error.status === 400);
  await assert.rejects(labelAPerson({ db, input: { relay: 'target', label: 'unsafe' } }), error => error.status === 400);
});
