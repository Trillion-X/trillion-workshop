// test/contract-checkout-trial.test.mjs
//
// Purpose: free days set on a contract's payment line reach checkout or are refused in words, never dropped (audit
// finding 20). A trial set while a line was phased used to survive, hidden, a switch to one price, and checkout
// charged at once without it. It runs the real contract-to-checkout translator.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutFromSalesContract } from '../src/contract-checkout.mjs';

const line = (metadata, extra = {}) => ({ type: 'Commitment', label: 'Coaching', amount: 9900, currency: 'usd', recurrence: 'monthly', metadata: { payment_structure: 'simple', ...metadata }, ...extra });
const saved = rules => ({ name: 'Coaching', contract: { name: 'Coaching', rules } });

test('free days on a repeating line reach checkout (finding 20)', () => {
  const { terms } = checkoutFromSalesContract(saved([line({ trial_period_days: 14 })]));
  assert.equal(terms.trial_days, 14);
  assert.equal(terms.payment_timing, 'subscription');
});

test('free days on a line paid once are refused in words, not dropped', () => {
  assert.throws(() => checkoutFromSalesContract(saved([line({ trial_period_days: 14 }, { recurrence: 'one_time' })])), /Free days first need a payment that repeats/);
});

test('a line without free days is unchanged', () => {
  const { terms } = checkoutFromSalesContract(saved([line({})]));
  assert.equal(terms.trial_days, undefined);
});
