import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recordIntroductionState } from '../do-work/record-introduction-state.mjs';
import { consentOf } from '../../check-consent-to-an-introduction/src/consent-fingerprint.mjs';
import { rowId } from '../../network-people/read-data/profile-rows.mjs';

// A real SQLite database standing in for the mounted connection: a select answers its rows, a write answers none.
function fixture(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const db = { async exec(sql, ...values) {
    const statement = database.prepare(sql);
    return /^\s*select/i.test(sql) ? statement.all(...values) : (statement.run(...values), []);
  } };
  const rows = table => {
    try { return database.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })); }
    catch (error) { if (/no such table/.test(error.message)) return []; throw error; }
  };
  // Nothing is sent: any network call during a state move fails the test.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('a state move must not send anything'); };
  t.after(() => { globalThis.fetch = realFetch; });
  return { db, rows };
}

const at = () => '2026-11-20T00:00:00.000Z';
const pair = { a: 'person:gate-test-two', b: 'person:gate-test' };
const ID = rowId('introduction', 'person:gate-test', 'person:gate-test-two');
// The introduction as it is shown to the people in it; its consent is the parts of this shown now.
const shown = { text: 'Meet for coffee about the tennis club.', recipients: ['person:gate-test', 'person:gate-test-two'], shared: 'contact', expires_at: '2026-11-27T00:00:00.000Z' };

test('a proposed introduction moves to sent under the pair\'s record id, and its history is kept', async t => {
  const { db, rows } = fixture(t);
  const answer = await recordIntroductionState({ db, input: { ...pair, from: 'proposed', to: 'sent', consent: consentOf(shown), shown }, now: at });
  assert.deepEqual(answer, { id: ID, status: 'sent', says: 'Asked to meet. No answer yet.' });
  assert.deepEqual(rows('introduction_states').map(({ id, status }) => ({ id, status })), [{ id: ID, status: 'sent' }]);
  assert.equal(rows('introduction_state_history').length, 1);
});

test('a move the lifecycle does not allow is refused and nothing changes', async t => {
  const { db, rows } = fixture(t);
  await assert.rejects(recordIntroductionState({ db, input: { ...pair, from: 'proposed', to: 'accepted' } }), error => error.status === 409);
  assert.equal(rows('introduction_states').length, 0);
});

test('a move to sent refuses an introduction that changed since it was shown', async t => {
  const { db, rows } = fixture(t);
  const changed = { ...shown, text: 'Meet for dinner instead.' };
  await assert.rejects(recordIntroductionState({ db, input: { ...pair, from: 'proposed', to: 'sent', consent: consentOf(shown), shown: changed } }), error => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.changed, ['text']);
    return true;
  });
  assert.equal(rows('introduction_states').length, 0);
});

test('the from state must be the state the introduction is in now', async t => {
  const { db, rows } = fixture(t);
  await recordIntroductionState({ db, input: { ...pair, from: 'proposed', to: 'sent', consent: consentOf(shown), shown }, now: at });
  await assert.rejects(recordIntroductionState({ db, input: { ...pair, from: 'proposed', to: 'declined' } }), error => error.status === 409);
  assert.equal(rows('introduction_states')[0].status, 'sent');
  assert.equal(rows('introduction_state_history').length, 1);
});

test('a state not in the lifecycle is refused', async t => {
  const { db } = fixture(t);
  await assert.rejects(recordIntroductionState({ db, input: { ...pair, from: 'proposed', to: 'spam' } }), error => error.status === 400);
});
