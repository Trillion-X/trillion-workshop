// tools/take-payments/do-work/rehearse-a-payment-schedule.mjs
//
// Build an offer's payment schedule at Stripe, in TEST MODE, and report what Stripe says it will charge and when.
//
// Everything else that checks a schedule reads our own functions with our own functions. That proves the arithmetic
// agrees with itself and says nothing about what a card is charged. This asks Stripe.
//
// NON-NEGOTIABLE INVARIANTS
//   1. TEST MODE ONLY, checked before anything is sent: the key must start with a test prefix. A live key reaching this
//      would create real prices and real schedules on the real account. The row mounts a held value named for a test
//      key, and the prefix is checked again here, because a name is not the check.
//   2. Reports what STRIPE said, never what we expected. The point is to find out where those differ.
//   3. No product or customer identity lives here: the name on the test product is the caller's.
import { paymentScheduleFromTheWire } from '../read-data/when-money-is-taken.ts';
import { howStripeTakesASchedule } from './stripe-phases-for-a-payment-schedule.ts';
import { call } from './build-stripe-http-request.mjs';

const TEST_KEY = /^(sk|rk)_test_/;

/** Refuses any key that is not a Stripe test key. */
export function assertTestKey(key) {
  if (typeof key !== 'string' || !TEST_KEY.test(key)) {
    throw new Error('The key given was not a Stripe test key. Refusing to send anything.');
  }
}

/**
 * @param {{ payment_schedule: object, product_name: string, currency?: string }} input
 * @param {(request: object) => Promise<object>} send delivers one built request (made with a test key)
 * @returns what Stripe says: each phase with the amount it bills and its start, in days from the first phase
 */
export async function rehearseAPaymentSchedule({ payment_schedule, product_name, currency = 'usd' }, send) {
  if (!product_name) throw new Error('A product name is required; this tool holds no seller identity.');
  const arrangement = howStripeTakesASchedule(paymentScheduleFromTheWire(payment_schedule));
  const phases = arrangement.phases;
  if (phases.length === 0) throw new Error('This schedule has nothing to schedule after the first payment, so there is nothing to rehearse.');

  const customer = await call(send, 'operation:create-customer', { description: 'payment schedule rehearsal, test mode' });
  const product = await call(send, 'operation:create-product', { name: product_name });

  const priced = [];
  for (const phase of phases) {
    const price = await call(send, 'operation:create-price', {
      currency,
      unit_amount: Number(phase.amountCents),
      product: product.id,
      recurring: { interval: phase.recurring.interval, interval_count: phase.recurring.interval_count },
    });
    priced.push({ phase, priceId: price.id });
  }

  const schedule = await call(send, 'operation:create-subscription-schedule', {
    customer: customer.id,
    start_date: 'now',
    end_behavior: 'release',
    phases: priced.map(({ phase, priceId }) => ({
      items: [{ price: priceId, quantity: 1 }],
      ...(phase.duration ? { duration: { interval: phase.duration.interval, interval_count: phase.duration.interval_count } } : {}),
    })),
  });

  const first = schedule.phases?.[0]?.start_date;
  return {
    schedule_id: schedule.id,
    status: schedule.status,
    what_stripe_says: (schedule.phases ?? []).map((phase, index) => ({
      phase: index,
      amount_cents: Number(priced[index]?.phase.amountCents ?? 0),
      days_after_start: first ? Math.round((phase.start_date - first) / 86400) : 0,
    })),
  };
}
