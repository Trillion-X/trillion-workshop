import test from 'node:test';
import assert from 'node:assert/strict';
import { paidWhen, ruleCarriesDeal, ruleFires, scheduleIsDue } from '../read-data/sent-deal-follow-ups-run-on-own-engines.mjs';

const welcome = { label: 'Welcome', when: paidWhen('sales-contract:7'), then: { tool_id: 'tool:send-an-email' } };
const paidEvent = (contractId, eventId) => ({ event_id: eventId, event: 'negotiated_offer_paid', contract_id: contractId });

test('a paid rule names its own deal id after the paid trigger', () => {
  assert.deepEqual(welcome.when.where, [
    { field: 'event', equals: 'negotiated_offer_paid' },
    { field: 'contract_id', equals: 'sales-contract:7' },
  ]);
  assert.equal(ruleCarriesDeal(welcome, 'sales-contract:7'), true);
  assert.equal(ruleCarriesDeal(welcome, 'sales-contract:9'), false);
});

test('a payment for this deal runs its rule; another deal\'s payment does not', () => {
  assert.equal(ruleFires(welcome, paidEvent('sales-contract:9', 'paid-other')), false);
  assert.equal(ruleFires(welcome, paidEvent('sales-contract:7', 'paid-7')), true);
});

test('a non-payment event does not run a paid rule', () => {
  assert.equal(ruleFires(welcome, { event: 'negotiated_offer_opened', contract_id: 'sales-contract:7' }), false);
});

test('a scheduled check-in is due at its time and not before', () => {
  const checkIn = { once_at: '2026-10-05T10:00:00Z' };
  assert.equal(scheduleIsDue(checkIn, Date.parse('2026-10-05T09:59:59Z')), false);
  assert.equal(scheduleIsDue(checkIn, Date.parse('2026-10-05T10:00:00Z')), true);
});
