// The broker's own words for a refused or rejected order reach the answer's note. Ported outcome: bitfield-packages
// packages/trade-order/read-data/trade-order-live.ts (d926b7adb, messageFromBrokerObject and failureReasonFromOrder,
// lines 512-562): message, reason, error, the error's message, and the order JSON nested under a `body` text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { failureReasonOf } from '../read-data/broker-requests.mjs';
import { placePaperOrders } from '../read-data/trading.mjs';
import { HELD, PAPER_ROUTE, fakeBroker, policy } from './fixtures.mjs';

const ROUTES = { 'paper-route': PAPER_ROUTE };
const NOW = Date.parse('2026-01-02T15:00:00Z');
const context = broker => ({ held: HELD, fetchImpl: broker.fetchImpl, now: () => NOW });

test('the reason is read from message, reason, error, the error\'s message, or a JSON body text', () => {
  assert.equal(failureReasonOf({ message: ' insufficient buying power ' }), 'insufficient buying power');
  assert.equal(failureReasonOf({ reason: 'market closed' }), 'market closed');
  assert.equal(failureReasonOf({ error: 'bad symbol' }), 'bad symbol');
  assert.equal(failureReasonOf({ error: { message: 'nested words' } }), 'nested words');
  assert.equal(failureReasonOf(JSON.stringify({ body: JSON.stringify({ message: 'inside the body' }) })), 'inside the body');
  assert.equal(failureReasonOf('plain text from the broker'), 'plain text from the broker');
  assert.equal(failureReasonOf('x'.repeat(500)).length, 300);
  assert.equal(failureReasonOf({ code: 42 }), null);
  assert.equal(failureReasonOf(''), null);
  assert.equal(failureReasonOf(null), null);
});

test('a refused order says the broker\'s reason in its note, and a rejected order says it too', async () => {
  const refused = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(fakeBroker([{ status: 422, body: { message: 'insufficient buying power' } }])));
  assert.equal(refused.placed[0].status, 'refused');
  assert.equal(refused.placed[0].note, 'the broker refused the order: insufficient buying power');
  const silent = await placePaperOrders({ policy: policy({ version: 'v2' }), routes: ROUTES, prices: { BREAD: 100 } }, context(fakeBroker([{ status: 422, body: {} }])));
  assert.equal(silent.placed[0].note, 'the broker refused the order', 'no reason in the answer: the words stay as they were');
  const rejected = await placePaperOrders({ policy: policy({ version: 'v3' }), routes: ROUTES, prices: { BREAD: 100 } }, context(fakeBroker([{ status: 200, body: { id: 'b-9', status: 'rejected', reason: 'wash trade' } }])));
  assert.equal(rejected.placed[0].status, 'rejected');
  assert.equal(rejected.placed[0].note, 'wash trade');
});
