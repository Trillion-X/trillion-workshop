// Which facts an installed payment descriptor's rules read is decided by the formula engine (one owner, tools/paid-access
// read-data/payment-effects.mjs): made-up events through the installed descriptor give the effects its rules name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runSignedEventEffectsWithGivenReplies } from '../do-work/run-with-given-replies.mjs';

const fact = (relation, attributes) => ({ fact_id: `f-${relation}`, subject: 'person-1', relation, object: 'offer-1', attributes });
const event = (id, facts) => ({
  payload: { event_id: id, namespace: 'made-up', occurred_at: '2026-01-02T03:04:05Z', idempotency_key: `k-${id}`, facts },
  proof: { signer_id: 'signer-1', signature_hex: 'ab' },
});

async function admit(events) {
  return runSignedEventEffectsWithGivenReplies({
    op: 'admit',
    descriptor_ref: 'signed-event-effects.payment-provider-event-accepted.v1',
    events,
    replies: {
      'payment-provider.verified-webhook-event': { evaluation: { event_hashes: Object.fromEntries(events.map(({ payload }) => [payload.event_id, `hash-${payload.event_id}`])) } },
      'person-effect-store': {},
    },
  });
}

test('a fact of a rule\'s event kind with every required attribute given is an effect', async () => {
  const answer = await admit([event('e1', [fact('payment.confirmed', { provider_event_id: 'p-1' })])]);
  assert.equal(answer.admitted_count, 1);
  assert.equal(answer.effects[0].kind, 'payment.confirmed');
});

test('a missing, blank or null required attribute gives no effect, and a falsy one that is given still does', async () => {
  const answer = await admit([
    event('e1', [fact('payment.confirmed', {})]),
    event('e2', [fact('payment.confirmed', { provider_event_id: '   ' })]),
    event('e3', [fact('payment.confirmed', { provider_event_id: null })]),
    event('e4', [fact('payment.confirmed', { provider_event_id: 0 })]),
  ]);
  assert.deepEqual(answer.effects.map(effect => effect.source_event_ids[0]), ['e4']);
});

test('a fact of an event kind no rule names gives no effect', async () => {
  const answer = await admit([event('e1', [fact('something.else', { provider_event_id: 'p-1' })])]);
  assert.equal(answer.admitted_count, 0);
});
