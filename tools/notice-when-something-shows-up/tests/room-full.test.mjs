// tools/notice-when-something-shows-up/tests/room-full.test.mjs
//
// A fact the door has no room for now (owed_full: its waiting facts, owed facts or book are full) is told back as room full,
// never as a broken fact, so the waiter waits and tells it again instead of counting failed appends and stopping
// (Nov 21 2026, 4:11 and 4:47 PM CST on the Mac). Any other refusal is not room full.
import assert from 'node:assert/strict';
import test from 'node:test';
import { engineCarrier, arriveOverDoor, refusedFact, ROOM_FULL_CODE } from '../do-work/tell-the-engine.mjs';

const doorOf = code => async () => new Response(JSON.stringify({ result: { isError: true, structuredContent: { code, detail: `refused: ${code}` } } }), { status: 200 });
const door = { url: 'http://door.test/mcp', capability: 'run-capability' };

test('a door with no room says room full; another refusal does not', async () => {
  await assert.rejects(arriveOverDoor(door, { kind: 'k', from: 'x', event_id: 'e1', payload: {} }, { fetchImpl: doorOf(ROOM_FULL_CODE) }),
    error => error.roomFull === true && error.code === 'owed_full');
  await assert.rejects(arriveOverDoor(door, { kind: 'k', from: 'x', event_id: 'e2', payload: {} }, { fetchImpl: doorOf('original_input_refused') }),
    error => error.roomFull === false && error.code === 'original_input_refused');
  assert.equal(refusedFact('words', undefined).roomFull, false);
});

test('the carrier\'s write of a record the door has no room for throws room full', async () => {
  const waiter = { kind: 'notice-when-something-shows-up.waiter-descriptor', id: 'waiter:rows', is_active: true,
    emitted_record: { change_kind: 'something-changed', address_label: 'where::something-changed', path_labels: [], payload_fields: [] } };
  const carrier = engineCarrier({ door, waiters: [waiter], fetchImpl: doorOf(ROOM_FULL_CODE), say: () => {} });
  await assert.rejects(carrier.writeRecord({ addressLabel: 'where::something-changed', waiterRef: 'waiter:rows', pathLabels: [], payload: {}, eventKey: 'db:1:2' }),
    error => error.roomFull === true);
});
