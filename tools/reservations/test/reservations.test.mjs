import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeReservations, reservationsByStatus } from '../read-data/reservations.ts';

test('reservations decode and group by status', () => {
  const reservations = decodeReservations([
    { id: 'r1', kind: 'table', title: 'Window table', status: 'confirmed', confirmationCode: 'ABC' },
    { id: 'r2', kind: 'room', title: 'Back room', status: 'requested' },
    { title: 'no id, dropped' },
  ]);
  const grouped = reservationsByStatus(reservations);
  assert.equal(reservations.length, 2);
  assert.equal(grouped.confirmed[0].confirmationCode, 'ABC');
  assert.equal(grouped.requested.length, 1);
});

test('rows in snake_case decode the same, and a missing status or kind gets the plain defaults', () => {
  const [row] = decodeReservations({ reservations: [{ id: 'reservation:one', starts_at: '2026-06-03 08:20', provider_ref: 'provider:bakery', policy_ref: 'policy:one', party_refs: ['guest:a'], task_refs: ['task:b'], cost: { amount: 250 } }] });
  assert.deepEqual([row.status, row.kind, row.startsAt, row.providerRef, row.policyRef], ['idea', 'custom', '2026-06-03 08:20', 'provider:bakery', 'policy:one']);
  assert.deepEqual([row.partyRefs, row.taskRefs, row.cost], [['guest:a'], ['task:b'], { amount: 250 }]);
  assert.deepEqual(decodeReservations('nothing'), []);
});
