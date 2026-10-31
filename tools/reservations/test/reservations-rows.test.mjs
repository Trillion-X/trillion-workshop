// The rows run as the container runs them, against the fake records door with exactly each row's rights.
// Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const open = rowOf(rows, 'tool:open-a-capacity-ledger');
const hold = rowOf(rows, 'tool:hold-a-place');
const release = rowOf(rows, 'tool:release-a-place');
const join = rowOf(rows, 'tool:join-a-waitlist');
const promote = rowOf(rows, 'tool:promote-from-the-waitlist');
const expire = rowOf(rows, 'tool:expire-old-holds');
const read = rowOf(rows, 'tool:read-a-capacity-ledger');
const sort = rowOf(rows, 'tool:sort-reservations-by-status');

const LEDGER = 'ledger:saturday-class';
const ledgerOf = answer => answer.kept.find(item => item.id === LEDGER).value;
const step = async (row, input, previous) => {
  const answer = await runRow(row, input, { records: previous?.kept ?? [] });
  assert.equal(answer.status, 0, answer.error);
  return answer;
};

test('opening a ledger keeps one record, and opening it again changes nothing', async () => {
  const first = await step(open, { ledger_id: LEDGER, scope_ref: 'scope:saturday-class', total: 2, reserved_by_class: { member: 1 } });
  assert.deepEqual([first.result.already_open, first.result.total, first.result.confirmed], [false, 2, 0]);
  assert.equal(ledgerOf(first).capacity_policy.reserved_by_class.member, 1);
  const again = await step(open, { ledger_id: LEDGER, scope_ref: 'scope:other', total: 99 }, first);
  assert.deepEqual([again.result.already_open, again.result.total], [true, 2]);
  assert.equal(ledgerOf(again).scope_ref, 'scope:saturday-class');
});

test('holds fill the places, then wait; the same key holds nothing twice', async () => {
  let last = await step(open, { ledger_id: LEDGER, scope_ref: 'scope:saturday-class', total: 1 });
  const ana = await step(hold, { ledger_id: LEDGER, subject_ref: 'person:ana', idempotency_key: 'k:ana' }, last);
  assert.deepEqual([ana.result.outcome, ana.result.state, ana.result.confirmed], ['held', 'full', 1]);
  const ben = await step(hold, { ledger_id: LEDGER, subject_ref: 'person:ben', idempotency_key: 'k:ben' }, ana);
  assert.deepEqual([ben.result.outcome, ben.result.waiting, ben.result.state], ['waitlisted', 1, 'waitlist_open']);
  const again = await step(hold, { ledger_id: LEDGER, subject_ref: 'person:ana', idempotency_key: 'k:ana' }, ben);
  assert.equal(again.result.outcome, 'held');
  assert.equal(ledgerOf(again).holds.length, 1);
  assert.equal(again.calls.filter(call => call.method === 'records:write').length, 0);
});

test('releasing a place promotes the waitlist and reading shows who holds it', async () => {
  let last = await step(open, { ledger_id: LEDGER, scope_ref: 'scope:saturday-class', total: 1 });
  last = await step(hold, { ledger_id: LEDGER, subject_ref: 'person:ana', idempotency_key: 'k:ana' }, last);
  last = await step(hold, { ledger_id: LEDGER, subject_ref: 'person:ben', idempotency_key: 'k:ben' }, last);
  const released = await step(release, { ledger_id: LEDGER, subject_ref: 'person:ana', idempotency_key: 'r:ana' }, last);
  assert.equal(released.result.released, true);
  assert.equal(released.result.promoted_hold.subject_ref, 'person:ben');
  assert.deepEqual([released.result.confirmed, released.result.waiting], [1, 0]);
  const seen = await step(read, { ledger_id: LEDGER, title: 'Saturday class' }, released);
  assert.deepEqual(seen.result.projection.partyRefs, ['person:ben']);
  assert.equal(seen.result.projection.title, 'Saturday class');
  const nobody = await step(release, { ledger_id: LEDGER, subject_ref: 'person:nobody', idempotency_key: 'r:none' }, released);
  assert.equal(nobody.result.released, false);
});

test('join and promote work the waitlist by hand', async () => {
  let last = await step(open, { ledger_id: LEDGER, scope_ref: 'scope:saturday-class', total: 1 });
  last = await step(join, { ledger_id: LEDGER, subject_ref: 'person:cy', idempotency_key: 'j:cy', reason: 'asked first' }, last);
  assert.equal(last.result.waitlist_entry.rank, 1);
  const promoted = await step(promote, { ledger_id: LEDGER, idempotency_key: 'p:one' }, last);
  assert.equal(promoted.result.promoted, true);
  assert.equal(promoted.result.hold.subject_ref, 'person:cy');
  const none = await step(promote, { ledger_id: LEDGER, idempotency_key: 'p:two' }, promoted);
  assert.equal(none.result.promoted, false);
});

test('a hold that ran out by the run\'s clock expires, and one with no end does not', async () => {
  const soon = (await step(open, { ledger_id: LEDGER, scope_ref: 'scope:saturday-class', total: 2 }));
  let last = await step(hold, { ledger_id: LEDGER, subject_ref: 'person:ana', idempotency_key: 'k:ana', expires_in_seconds: 3600 }, soon);
  last = await step(hold, { ledger_id: LEDGER, subject_ref: 'person:ben', idempotency_key: 'k:ben' }, last);
  const nothingYet = await step(expire, { ledger_id: LEDGER }, last);
  assert.equal(nothingYet.result.expired_holds.length, 0);
  // make the first hold's end a past instant in the record, as a clock would have after an hour
  const stored = ledgerOf(last);
  stored.holds[0].expires_at = '2001-01-01T00:00:00.000Z';
  const expired = await step(expire, { ledger_id: LEDGER }, last);
  assert.deepEqual(expired.result.expired_holds.map(item => item.subject_ref), ['person:ana']);
  assert.equal(expired.result.confirmed, 1);
});

test('a caller cannot choose the time, and a missing ledger or key is refused in words', async () => {
  const opened = await step(open, { ledger_id: LEDGER, scope_ref: 'scope:saturday-class', total: 1 });
  const sneaky = await step(hold, { ledger_id: LEDGER, subject_ref: 'person:ana', idempotency_key: 'k:ana', occurred_at: '2001-01-01T00:00:00.000Z' }, opened);
  assert.notEqual(ledgerOf(sneaky).holds[0].held_at.slice(0, 4), '2001');
  const missing = await runRow(hold, { ledger_id: 'ledger:none', subject_ref: 'person:ana', idempotency_key: 'k' });
  assert.equal(missing.status, 1);
  assert.match(missing.error, /no capacity ledger "ledger:none"\. Open it first/);
  const noKey = await runRow(hold, { ledger_id: LEDGER, subject_ref: 'person:ana' }, { records: opened.kept });
  assert.match(noKey.error, /idempotency_key is required/);
  const badExpiry = await runRow(hold, { ledger_id: LEDGER, subject_ref: 'person:ana', idempotency_key: 'k', expires_in_seconds: 0 }, { records: opened.kept });
  assert.match(badExpiry.error, /whole number of seconds/);
});

test('reservations sort by status in the person\'s order, from input or from records', async () => {
  const fromInput = await step(sort, {
    reservations: [{ id: 'r1', status: 'confirmed', policy_ref: 'policy:a' }, { id: 'r2', status: 'requested' }, { id: 'r3', status: 'changed', policy_ref: 'policy:b' }, { title: 'dropped' }],
    attention_order: ['changed', 'requested', 'never-used'],
  });
  assert.deepEqual(fromInput.result.groups.map(group => [group.status, group.needs_attention]), [['changed', true], ['requested', true], ['confirmed', false]]);
  assert.deepEqual(fromInput.result.without_policy, ['r2']);
  assert.equal(fromInput.result.count, 3);
  const fromRecords = await step(sort, {}, { kept: [
    { id: 'reservation:one', type: 'reservation', value: { title: 'Window table', status: 'held' } },
    { id: 'reservation:two', type: 'reservation', value: { title: 'Back room', status: 'held' } },
  ] });
  assert.deepEqual(fromRecords.result.groups.map(group => [group.status, group.reservations.length]), [['held', 2]]);
});
