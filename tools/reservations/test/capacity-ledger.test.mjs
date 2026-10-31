// The capacity ledger's steps: ported from the package's own cases. Every name is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityLedgerProjection, expireHolds, holdUnit, joinWaitlist, openCapacityLedger, promoteWaitlist, releaseUnit } from '../do-work/capacity-ledger.ts';

const AT = '2026-09-05T10:00:00.000Z';

function ledgerInput(total = 1) {
  return {
    ledger_id: 'ledger:saturday-class',
    scope_ref: 'scope:saturday-class',
    capacity_policy: { total, reserved_by_class: {}, oversubscription_policy: { mode: 'waitlist' }, release_policy: { promote_next: true }, policy_ref: 'policy:class-capacity' },
  };
}
const confirmed = ledger => ledger.holds.filter(hold => hold.state === 'confirmed');
const waiting = ledger => ledger.waitlist_entries.filter(entry => entry.state === 'waiting');
const ask = (subject, key, extra = {}) => ({ subject_ref: subject, idempotency_key: key, occurred_at: AT, ...extra });

test('unnamed classes share the unreserved remainder', () => {
  const input = ledgerInput(3);
  input.capacity_policy.reserved_by_class = { reserved: 2 };
  let ledger = openCapacityLedger(input);
  const first = holdUnit(ledger, ask('a', 'a', { unit_class: 'a' }));
  assert.equal(first.result.outcome, 'held');
  const second = holdUnit(first.ledger, ask('b', 'b', { unit_class: 'b' }));
  assert.equal(second.result.outcome, 'waitlisted');
  ledger = second.ledger;
  for (const id of ['r1', 'r2']) {
    const result = holdUnit(ledger, ask(id, id, { unit_class: 'reserved' }));
    assert.equal(result.result.outcome, 'held');
    ledger = result.ledger;
  }
  assert.equal(confirmed(ledger).length, 3);
});

test('the last unit goes to the first holder and the next is ordered on the waitlist', () => {
  const first = holdUnit(openCapacityLedger(ledgerInput()), ask('subject:first', 'hold:first'));
  const second = holdUnit(first.ledger, ask('subject:second', 'hold:second'));
  assert.equal(first.result.outcome, 'held');
  assert.equal(second.result.outcome, 'waitlisted');
  assert.equal(confirmed(second.ledger).length, 1);
  assert.equal(waiting(second.ledger).length, 1);
  assert.equal(second.ledger.waitlist_entries[0].rank, 1);
});

test('a repeated idempotency key is recognised across a restart', () => {
  const first = holdUnit(openCapacityLedger(ledgerInput(2)), ask('subject:one', 'hold:stable'));
  const afterRestart = JSON.parse(JSON.stringify(first.ledger));
  const repeated = holdUnit(afterRestart, ask('subject:one', 'hold:stable'));
  assert.deepEqual(repeated.result, first.result);
  assert.equal(repeated.ledger.holds.length, 1);
});

test('releasing a unit promotes the next ordered waitlist entry', () => {
  let ledger = openCapacityLedger(ledgerInput(2));
  const first = holdUnit(ledger, ask('subject:first', 'hold:first'));
  ledger = first.ledger;
  ledger = holdUnit(ledger, ask('subject:second', 'hold:second')).ledger;
  ledger = holdUnit(ledger, ask('subject:next', 'hold:next')).ledger;
  const released = releaseUnit(ledger, { hold_id: first.result.hold.hold_id, idempotency_key: 'release:first', occurred_at: AT });
  assert.equal(released.result.promoted_hold.subject_ref, 'subject:next');
  assert.equal(confirmed(released.ledger).length, 2);
  assert.equal(released.ledger.holds.filter(hold => hold.state === 'released').length, 1);
  assert.equal(waiting(released.ledger).length, 0);
  assert.equal(released.ledger.waitlist_entries[0].state, 'promoted');
  assert.equal(released.ledger.state, 'full');
});

test('an unnamed unit class draws on the remainder without touching reserved capacity', () => {
  const ledger = openCapacityLedger({ ...ledgerInput(3), capacity_policy: { ...ledgerInput(3).capacity_policy, reserved_by_class: { member: 2 } } });
  const invented = holdUnit(ledger, ask('subject:walkup', 'hold:walkup', { unit_class: 'a-class-nothing-here-has-heard-of' }));
  assert.equal(invented.result.outcome, 'held');
  // the remainder was 1, so a second unnamed holder waits even though two member units are free
  const second = holdUnit(invented.ledger, ask('subject:walkup-two', 'hold:walkup-two', { unit_class: 'a-class-nothing-here-has-heard-of' }));
  assert.equal(second.result.outcome, 'waitlisted');
  const member = holdUnit(second.ledger, ask('subject:member', 'hold:member', { unit_class: 'member' }));
  assert.equal(member.result.outcome, 'held');
});

test('a hold whose expires_at has passed expires and the freed unit is promoted into', () => {
  let ledger = openCapacityLedger(ledgerInput(1));
  ledger = holdUnit(ledger, ask('subject:short-lived', 'hold:short-lived', { expires_at: '2026-09-05T11:00:00.000Z' })).ledger;
  ledger = holdUnit(ledger, ask('subject:waiting', 'hold:waiting')).ledger;
  assert.equal(confirmed(ledger).length, 1);
  const before = expireHolds(ledger, { occurred_at: '2026-09-05T10:59:59.000Z' });
  assert.equal(before.result.expired_holds.length, 0);
  assert.equal(before.ledger, ledger);
  const after = expireHolds(ledger, { occurred_at: '2026-09-05T11:00:00.000Z' });
  assert.equal(after.result.expired_holds.length, 1);
  assert.equal(after.result.promoted_holds[0].subject_ref, 'subject:waiting');
  assert.equal(after.ledger.holds.filter(hold => hold.state === 'expired').length, 1);
  assert.equal(confirmed(after.ledger).length, 1);
});

test('a hold with no expires_at is never expired', () => {
  let ledger = openCapacityLedger(ledgerInput(1));
  ledger = holdUnit(ledger, ask('subject:open-ended', 'hold:open-ended')).ledger;
  assert.equal(expireHolds(ledger, { occurred_at: '2099-01-01T00:00:00.000Z' }).result.expired_holds.length, 0);
});

test('a ledger of opaque data keeps working', () => {
  let ledger = openCapacityLedger({
    ...ledgerInput(), ledger_id: 'opaque-ledger', scope_ref: 'opaque-scope', state: 'defined-open',
    capacity_policy: { ...ledgerInput().capacity_policy, oversubscription_policy: { descriptor_ref: 'descriptor:overflow' }, release_policy: { descriptor_ref: 'descriptor:release' } },
  });
  ledger = holdUnit(ledger, ask('opaque-subject-a', 'opaque-key-a')).ledger;
  ledger = joinWaitlist(ledger, { subject_ref: 'opaque-subject-b', idempotency_key: 'opaque-key-b', occurred_at: AT, reason: 'defined-reason', promotion_policy: { descriptor_ref: 'descriptor:promotion' } }).ledger;
  const released = releaseUnit(ledger, { subject_ref: 'opaque-subject-a', idempotency_key: 'opaque-release', occurred_at: AT });
  const projection = capacityLedgerProjection(released.ledger, 'Opaque occurrence');
  assert.equal(released.result.promoted_hold.subject_ref, 'opaque-subject-b');
  assert.equal(projection.id, 'opaque-scope');
  assert.deepEqual(projection.partyRefs, ['opaque-subject-b']);
});

test('refusals name the field and a zero total is a ledger that is always full', () => {
  assert.throws(() => openCapacityLedger({ ...ledgerInput(), ledger_id: ' ' }), /ledger_id must be non-empty/);
  assert.throws(() => openCapacityLedger({ ...ledgerInput(), capacity_policy: { ...ledgerInput().capacity_policy, total: -1 } }), /non-negative integer/);
  assert.throws(() => openCapacityLedger({ ...ledgerInput(2), capacity_policy: { ...ledgerInput(2).capacity_policy, reserved_by_class: { member: 3 } } }), /cannot exceed/);
  const none = holdUnit(openCapacityLedger(ledgerInput(0)), ask('subject:a', 'hold:a'));
  assert.equal(none.result.outcome, 'waitlisted');
  assert.throws(() => releaseUnit(openCapacityLedger(ledgerInput()), { idempotency_key: 'k', occurred_at: AT }), /hold_id or subject_ref is required/);
  assert.equal(promoteWaitlist(openCapacityLedger(ledgerInput()), { idempotency_key: 'k', occurred_at: AT }).result.hold, undefined);
});
