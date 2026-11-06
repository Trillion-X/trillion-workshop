// Ported from old trillion test/paid-ceiling.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The paid ceiling's rules are this tool's src/cap-change.mjs (commitmentCents, paidWithin,
// paidCeilingRefusal, withinCarve, allowPaidCeilingChange, paidCeilingOf, holdCapConfirmation, confirmationBy) over
// tools/shared-code/src/cap-change.json. The ceiling move ran through old src/account-routes.mjs handleAccountApi
// POST /work/api/account/paid-ceiling, which kept the answer in APP_KV paid-ceiling:<user>; the harness calls
// allowPaidCeilingChange the same way (the call's confirmation used up by confirmationBy for its sign-in) and keeps its
// `kept` text, reading 403/400 from the refusal's status; "is the checkout handed out" is read as paidCeilingRefusal
// against paidCeilingOf, the ceiling in force, for the old offer's first charge (10000 cents, the old optionCommitment).
// Left out, no running owner (searched resourceBudgetOwner, refundPastPaidCeiling, checkoutPaidRefusal, paidRoom,
// paidGate, spotCarvesCents, spotCarveCents, optionCommitment, linkOffers, PAID_MAXIMUM_CENTS and planCheckout across
// trillion-workshop tools, trillion-rust src and trillion-apps: none defined; the engine's sign_in/known.rs lists
// paid-ceiling words as a product feature): the bought plan's capped daily cap (old src/resource-budget-owner.mjs), the
// Stripe refund and cancel of a checkout past the ceiling and its kept reservations (old src/payment.mjs), the payment
// link quantity cap, the spot carve's room and refusal, the Plan screen checkout, and optionCommitment of the offer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { allowPaidCeilingChange, commitmentCents, confirmationBy, holdCapConfirmation, paidCeilingOf, paidCeilingRefusal, paidWithin, withinCarve } from '../src/cap-change.mjs';
import capData from '../../shared-code/src/cap-change.json' with { type: 'json' };

const NOW = Date.parse('2026-10-27T12:00:00Z');
const DAY = 86_400_000;
const at = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();
// A completed checkout of this service's own offer, as the payment notice records it.
const bought = (session, cents, daysAgo, extra = {}) => ({ effect_id: `payment.confirmed:${session}`, kind: 'payment.confirmed', subject: 'person',
  material: { occurred_at: at(daysAgo), offer_id: 'offer:trillion', checkout_attempt_id: 'person', provider_object_ref: session, payment_intent_ref: `pi_${session}`, amount_due_today_cents: cents, ...extra },
  source_event_ids: [`evt_${session}`] });
const renewed = (sub, cents, daysAgo) => ({ effect_id: `subscription.renewed:${sub}:${daysAgo}`, kind: 'subscription.renewed', subject: 'person',
  material: { occurred_at: at(daysAgo), offer_id: 'offer:trillion', provider_object_ref: sub, amount_due_today_cents: cents } });

test('what a request commits is read from the request: quantity, every charge in the window after a trial, installments', () => {
  const month = { interval: 'month' };
  assert.equal(commitmentCents({ lines: [{ unit_cents: 10000, quantity: 9999, every: month }], trial_days: 7 }), 99990000, 'a $0-today trial of 9,999 units still commits its first charge');
  assert.equal(commitmentCents({ lines: [{ unit_cents: 10000, quantity: 1, every: month }] }), 20000, 'with no trial a month counts as its shortest, so the window can hold two charges');
  assert.equal(commitmentCents({ lines: [{ unit_cents: 10000, quantity: 1, every: month }], charges_paid: 1 }), 10000, 'the charge already paid today is not counted again');
  assert.equal(commitmentCents({ lines: [{ unit_cents: 50000, quantity: 1, every: { interval: 'week' } }], installments: 24 }), 250000, 'a 24-installment weekly plan commits the five that fall in the window');
  assert.equal(commitmentCents({ lines: [{ unit_cents: 50000, quantity: 1, every: { interval: 'week' } }], installments: 2 }), 100000, 'never more charges than its installments');
  assert.equal(commitmentCents({ lines: [{ unit_cents: 2500, quantity: 3, every: null }] }), 7500, 'a one-time line is its price times its quantity');
  assert.equal(commitmentCents({ lines: [{ unit_cents: 10000, quantity: 1, every: { interval: 'year' } }], trial_days: 31 }), 0, 'a charge after the window is not in it');
});

test('the paid window counts every completed checkout once, for any payee, with every reserved commitment', () => {
  const effects = [
    bought('cs_a', 50000, 2),
    { ...bought('cs_a', 50000, 2), effect_id: 'payment.confirmed:cs_a:async' },
    bought('cs_b', 30000, 10),
    bought('cs_old', 90000, capData.paid.window_days + 1),
    bought('cs_seller', 90000, 1, { seller_ref: 'acct_seller', payee_account: 'acct_seller', negotiated_offer_id: 'negotiated-offer:n1' }),
    bought('cs_back', 90000, 1),
    { effect_id: 'payment.refunded:cs_back', kind: 'payment.refunded', material: { occurred_at: at(0), payment_intent_ref: 'pi_cs_back' } },
    renewed('sub_a', 90000, 3),
  ];
  assert.equal(paidWithin({ effects, at: NOW }), 170000, 'a seller\'s sale is money out of the person too');
  assert.equal(paidWithin({ effects, at: NOW, except: 'cs_a' }), 120000, 'the purchase being decided is left out');
  const reserved = [{ ref: 'cs_a', cents: 70000, at: at(2) }, { ref: 'negotiated-offer:n1', cents: 400000, at: at(1) }, { ref: 'cs_gone', cents: 99999, at: at(capData.paid.window_days + 1) }];
  assert.equal(paidWithin({ effects, reserved, at: NOW }), 70000 + 30000 + 400000, 'a purchase counts once, at the larger of what it took and what it committed');
  assert.equal(paidCeilingRefusal({ paidCents: 80000, amountCents: 20000, ceilingDollars: 1000 }), null, 'exactly at the ceiling fits');
  const refusal = paidCeilingRefusal({ paidCents: 80000, amountCents: 20001, ceilingDollars: 1000 });
  assert.equal(refusal.status, 403);
  assert.match(refusal.error, /paid ceiling of 1000 dollars/);
});

test('a spot\'s billed usage is clamped to its carve', () => {
  const clamped = withinCarve({ 'stored-bytes': 10 ** 15, 'work-cost': 10 ** 12 });
  assert.deepEqual(clamped, capData.paid.spot_carve.per_day, 'a day of usage bills the payer at most the carve');
});

test('the paid ceiling moves in neither direction without a known passkey\'s confirmation for exactly that move, one step, after its notice', async () => {
  const held = new Map();
  const pool = { holdPasskeyChallenge: async (id, record) => { held.set(id, record); }, takePasskeyChallenge: async id => { const record = held.get(id) ?? null; held.delete(id); return record; } };
  const signIn = 'session:fixture-session';
  let stored = null;
  const call = async body => {
    try {
      const answer = await allowPaidCeilingChange({ current: stored, next: body.dollars, confirm: change => confirmationBy(pool, body.confirmation, signIn, change) });
      stored = answer.kept;
      return { status: 200, body: { said: answer.said } };
    } catch (error) {
      if (!error.status) throw error;
      return { status: error.status, body: { error: error.message, ...(error.change ? { change: error.change } : {}) } };
    }
  };
  const confirmed = change => holdCapConfirmation(pool, signIn, change);
  const kept = () => JSON.parse(stored ?? 'null');
  // The old checkout of the offer's first charge (10000 cents) with 950 dollars already paid in the window.
  const handOut = () => paidCeilingRefusal({ paidCents: 95000, amountCents: 10000, ceilingDollars: paidCeilingOf(stored) });
  const refused = await call({ dollars: 2000 });
  assert.equal(refused.status, 403, 'an emailed-code session (or an AI driving it) cannot raise the paid ceiling');
  assert.match(refused.body.error, /needs a passkey you already had/);
  assert.deepEqual(refused.body.change, { action: 'paid-ceiling', dollars: 2000 }, 'the refusal names the exact change to confirm');
  assert.equal(kept(), null);
  assert.equal((await call({ dollars: 2000, confirmation: await holdCapConfirmation(pool, 'session:someone-else', refused.body.change) })).status, 403);
  assert.equal((await call({ dollars: 2000, confirmation: await confirmed({ action: 'paid-ceiling', dollars: 1500 }) })).status, 403, 'a confirmation for another amount does not carry over');
  // One deceived touch is worth one step: a confirmation for ten times the ceiling, or past the maximum, is refused outright.
  const big = await confirmed({ action: 'paid-ceiling', dollars: 5000 });
  assert.match((await call({ dollars: 5000, confirmation: big })).body.error, /at most 1000 dollars above the one in force/);
  assert.match((await call({ dollars: capData.maxima.paid + 1, confirmation: big })).body.error, /never be above 10000 dollars/);
  const good = await confirmed(refused.body.change);
  const raised = await call({ dollars: 2000, confirmation: good });
  assert.equal(raised.status, 200);
  assert.match(raised.body.said, /rises to 2000 dollars .* from .*; until then it stays 1000 dollars/);
  assert.equal(kept().dollars, null);
  assert.equal(kept().raise.to, 2000);
  assert.equal(Date.parse(kept().raise.from) - Date.now() > 71 * 3_600_000, true, 'it takes effect only after the notice');
  assert.equal(handOut().ceiling_dollars, 1000, 'while the raise waits, the ceiling in force is the old one');
  assert.equal((await call({ dollars: 3000, confirmation: good })).status, 403, 'a confirmation is used once');
  // The person cancels the waiting raise with their passkey by asking for the ceiling in force.
  const cancel = await call({ dollars: 1000 });
  assert.deepEqual(cancel.body.change, { action: 'paid-ceiling', dollars: 1000 }, 'cancelling a raise needs the passkey too');
  assert.equal((await call({ dollars: 1000, confirmation: await confirmed(cancel.body.change) })).status, 200);
  assert.equal(kept().raise, undefined);
  // A raise whose notice has passed is in force, and the next step counts from it.
  stored = JSON.stringify({ dollars: 1000, raise: { to: 2000, from: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(handOut(), null, 'the raise is in force once its notice has passed');
  assert.equal((await call({ dollars: 3000, confirmation: await confirmed({ action: 'paid-ceiling', dollars: 3000 }) })).status, 200);
  assert.equal(kept().dollars, 2000);
  // Lowering is refused too, so an AI cannot drive it down and force the person through the passkey step to restore it.
  assert.equal((await call({ dollars: 100 })).status, 403);
  assert.equal((await call({ dollars: 3000 })).status, 200, 'asking for the raise already waiting changes nothing and needs nothing');
  assert.equal((await call({ dollars: -1 })).status, 400);
});
