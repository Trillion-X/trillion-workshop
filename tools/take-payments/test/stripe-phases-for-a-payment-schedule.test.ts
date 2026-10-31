// The question these answer is not "are the phases shaped right". It is
// whether the phases take THE SAME MONEY ON THE SAME DAYS as the offer
// promised. So the central check reads the phases back out and compares them
// to the offer, the same way the other Stripe mapping is held.

import { describe, expect, it } from './expect.mjs';
import {
  stripePhasesForAPaymentSchedule,
  whatThesePhasesTake,
  exactDurationForDays,
  howStripeTakesASchedule,
  whatThisArrangementTakes,
  whatTheCheckoutDoes,
  subscriptionScheduleRequest,
} from '../do-work/stripe-phases-for-a-payment-schedule.ts';
import { whenMoneyIsTaken } from '../read-data/when-money-is-taken.ts';
import type { CommercialPriceOption } from '../../funnels-and-offers/read-data/read-offers.ts';

function priceOption(extra: Record<string, unknown>): CommercialPriceOption {
  return { id: 'price:x', label: 'x', currency: 'usd', ...extra } as CommercialPriceOption;
}

function whatTheOfferPromised(schedule: ReturnType<typeof whenMoneyIsTaken>) {
  return schedule.charges
    .filter((charge) => charge.amountCents > 0n)
    .map((charge) => ({ amountCents: charge.amountCents, daysAfterSignup: charge.daysAfterSignup }));
}

describe('a ladder a bakery sells', () => {
  const schedule = whenMoneyIsTaken(priceOption({
    charges: [
      { amount_cents: 800, days_after_signup: 0 },
      { amount_cents: 3200, days_after_signup: 7 },
    ],
    repeat: { amount_cents: 4000, interval: 'month' },
  }), 4000n);

  it('becomes three phases and needs no discount anywhere', () => {
    // The whole reason for phases. A one-use discount is spent by whichever
    // invoice settles first, so an offer that also takes money at signup can
    // have its reduction land on the wrong charge and invert itself. A phase
    // charges its own amount and there is nothing to misapply.
    expect(stripePhasesForAPaymentSchedule(schedule)).toEqual([
      { amountCents: 800n, duration: { interval: 'week', interval_count: 1 }, recurring: { interval: 'week', interval_count: 1 } },
      { amountCents: 3200n, duration: { interval: 'month', interval_count: 1 }, recurring: { interval: 'month', interval_count: 1 } },
      { amountCents: 4000n, recurring: { interval: 'month', interval_count: 1 } },
    ]);
  });

  it('takes the same money on the same days the offer promised', () => {
    const phases = stripePhasesForAPaymentSchedule(schedule);
    expect(whatThesePhasesTake(phases)).toEqual([
      ...whatTheOfferPromised(schedule),
      { amountCents: 4000n, daysAfterSignup: 37 },
    ]);
  });
});

describe('every one of the drip offers', () => {
  it('reaches the published monthly amount across its first month', () => {
    for (const atTheDoor of [800, 400, 200, 80]) {
      const schedule = whenMoneyIsTaken(priceOption({
        charges: [
          { amount_cents: atTheDoor, days_after_signup: 0 },
          { amount_cents: 4000 - atTheDoor, days_after_signup: 7 },
        ],
        repeat: { amount_cents: 4000, interval: 'month' },
      }), 4000n);

      const taken = whatThesePhasesTake(stripePhasesForAPaymentSchedule(schedule));
      const firstMonth = taken
        .filter((row) => row.daysAfterSignup < 30)
        .reduce((total, row) => total + row.amountCents, 0n);
      expect(firstMonth).toBe(4000n);
    }
  });
});

describe('an ordinary plan', () => {
  it('is one phase that continues', () => {
    const schedule = whenMoneyIsTaken(
      priceOption({ amount_cents: 4000, payment_timing: 'subscription', interval: 'month' }),
      4000n,
    );
    expect(stripePhasesForAPaymentSchedule(schedule)).toEqual([
      { amountCents: 4000n, duration: { interval: 'month', interval_count: 1 }, recurring: { interval: 'month', interval_count: 1 } },
      { amountCents: 4000n, recurring: { interval: 'month', interval_count: 1 } },
    ]);
  });
});

describe('what it refuses rather than rounding', () => {
  it('names an odd gap in days rather than rounding it to a week', () => {
    // This was written expecting a five-day gap to be REFUSED, and it was not,
    // because five days is exactly five days. The premise was wrong, not the
    // code: every whole-day gap is expressible, so nothing here ever needs to
    // round. What matters is that it does not reach for the nearest week.
    const schedule = whenMoneyIsTaken(priceOption({
      charges: [
        { amount_cents: 800, days_after_signup: 0 },
        { amount_cents: 3200, days_after_signup: 5 },
      ],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n);

    const phases = stripePhasesForAPaymentSchedule(schedule);
    expect(phases[0].duration).toEqual({ interval: 'day', interval_count: 5 });
    expect(whatThesePhasesTake(phases)).toEqual([
      { amountCents: 800n, daysAfterSignup: 0 },
      { amountCents: 3200n, daysAfterSignup: 5 },
      { amountCents: 4000n, daysAfterSignup: 35 },
    ]);
  });

  it('refuses an offer whose first money arrives after signup with nothing before it', () => {
    // A schedule starts when the person signs up. A phase list that silently
    // began late would take the first payment on a day the offer never named.
    const schedule = whenMoneyIsTaken(priceOption({
      charges: [{ amount_cents: 4000, days_after_signup: 7 }],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n);

    expect(() => stripePhasesForAPaymentSchedule(schedule))
      .toThrow(/takes its first money 7 days after signup/i);
  });

  it('takes the first charge at the door and schedules the rest', () => {
    // The provider's documentation says a schedule's first invoice is created
    // as a draft and finalized about an hour later. So a schedule starting now
    // does not charge now, and the money at the door is the one charge that
    // cannot be left to it: a decline an hour later declines to somebody who
    // already closed the tab believing they paid.
    const schedule = whenMoneyIsTaken(priceOption({
      charges: [
        { amount_cents: 800, days_after_signup: 0 },
        { amount_cents: 3200, days_after_signup: 5 },
      ],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n);

    const arrangement = howStripeTakesASchedule(schedule);
    expect(arrangement.atCheckoutCents).toBe(800n);
    expect(arrangement.phasesStartDaysAfterSignup).toBe(5);
    expect(arrangement.phases).toHaveLength(2);

    // The check that matters: the whole arrangement still takes the money the
    // offer promised, on the days it promised. Splitting it is only correct if
    // nothing moved. The repeat lands one month after the last fixed charge,
    // which the schedule derives rather than the offer stating it.
    expect(whatThisArrangementTakes(arrangement)).toEqual([
      { amountCents: 800n, daysAfterSignup: 0 },
      { amountCents: 3200n, daysAfterSignup: 5 },
      { amountCents: 4000n, daysAfterSignup: 35 },
    ]);
  });

  it('leaves an ordinary monthly plan as one charge at the door and one phase', () => {
    const schedule = whenMoneyIsTaken(priceOption({
      charges: [{ amount_cents: 4000, days_after_signup: 0 }],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n);

    const arrangement = howStripeTakesASchedule(schedule);
    expect(arrangement.atCheckoutCents).toBe(4000n);
    expect(arrangement.phases).toHaveLength(1);
    expect(whatThisArrangementTakes(arrangement)).toEqual([
      { amountCents: 4000n, daysAfterSignup: 0 },
      { amountCents: 4000n, daysAfterSignup: 30 },
    ]);
  });

  it('schedules nothing for a one-time sale', () => {
    // An empty schedule would leave a subscription on the account that bills
    // nobody for nothing, which is worse than no schedule because it looks
    // like an active plan to whoever reads it next.
    const schedule = whenMoneyIsTaken(priceOption({
      charges: [{ amount_cents: 700, days_after_signup: 0 }],
    }), 0n);

    const arrangement = howStripeTakesASchedule(schedule);
    expect(arrangement).toEqual({ atCheckoutCents: 700n, phases: [], phasesStartDaysAfterSignup: 0 });
    expect(whatThisArrangementTakes(arrangement)).toEqual(whatTheOfferPromised(schedule));
  });

  it('keeps an empty door when the offer names no charge at signup', () => {
    // The control for the split. Without it, an arrangement that always took
    // the first charge at the door would pass every assertion above.
    const schedule = whenMoneyIsTaken(priceOption({
      charges: [],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n);

    const arrangement = howStripeTakesASchedule(schedule);
    expect(arrangement.atCheckoutCents).toBe(0n);
    expect(arrangement.phasesStartDaysAfterSignup).toBe(0);
    expect(whatThisArrangementTakes(arrangement)).toEqual([
      { amountCents: 4000n, daysAfterSignup: 0 },
    ]);
  });

  it('keeps the card when anything is still to come, and lets it go when nothing is', () => {
    // The case that fails days later and silently: a schedule with no stored
    // card fails on its first phase, to somebody already told they signed up.
    const ladder = howStripeTakesASchedule(whenMoneyIsTaken(priceOption({
      charges: [{ amount_cents: 800, days_after_signup: 0 }],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n));
    expect(whatTheCheckoutDoes(ladder)).toEqual({
      mode: 'payment',
      amountCents: 800n,
      keepTheCardForLater: true,
    });

    const oneTime = howStripeTakesASchedule(whenMoneyIsTaken(priceOption({
      charges: [{ amount_cents: 700, days_after_signup: 0 }],
    }), 0n));
    expect(whatTheCheckoutDoes(oneTime)).toEqual({
      mode: 'payment',
      amountCents: 700n,
      keepTheCardForLater: false,
    });
  });

  it('collects a card and takes nothing when the first money is due later', () => {
    // Not a degenerate case. An offer whose first money is due next week still
    // needs a card today, and charging zero is not the same as charging
    // nothing: one of them creates a payment.
    const later = howStripeTakesASchedule(whenMoneyIsTaken(priceOption({
      charges: [],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n));
    expect(whatTheCheckoutDoes(later)).toEqual({
      mode: 'setup',
      amountCents: 0n,
      keepTheCardForLater: true,
    });
  });

  it('refuses to make a checkout that does nothing', () => {
    expect(() => whatTheCheckoutDoes({
      atCheckoutCents: 0n,
      phases: [],
      phasesStartDaysAfterSignup: 0,
    })).toThrow(/nothing at the door and schedules nothing/i);
  });

  it('asks the provider for the ladder with its prices written inline', () => {
    const SIGNED_UP_AT = 1_800_000_000;
    const arrangement = howStripeTakesASchedule(whenMoneyIsTaken(priceOption({
      charges: [
        { amount_cents: 800, days_after_signup: 0 },
        { amount_cents: 3200, days_after_signup: 7 },
      ],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n));

    const request = subscriptionScheduleRequest(arrangement, {
      customerRef: 'cus_1',
      currency: 'usd',
      productName: 'A product',
      signedUpAtUnixSeconds: SIGNED_UP_AT,
    });

    // The schedule starts on the day the door charge's week runs out, not at
    // signup: the $20 was already taken by the checkout.
    expect(request.start_date).toBe(SIGNED_UP_AT + 7 * 86_400);
    // So an ended ladder leaves an ordinary subscription rather than cancelling.
    expect(request.end_behavior).toBe('release');
    expect(request).toMatchObject({
      customer: 'cus_1',
      phases: [
        {
          items: [{
            price_data: {
              currency: 'usd',
              product_data: { name: 'A product' },
              unit_amount: 3200,
              recurring: { interval: 'month', interval_count: 1 },
            },
            quantity: 1,
          }],
          duration: { interval: 'month', interval_count: 1 },
        },
        {
          items: [{ price_data: { unit_amount: 4000, recurring: { interval: 'month', interval_count: 1 } } }],
        },
      ],
    });
    // The part that continues has no duration. Giving it one would end the plan
    // on a day nobody chose.
    expect((request.phases as Record<string, unknown>[])[1].duration).toBeUndefined();
  });

  it('refuses a schedule request that is missing what it bills or who it bills', () => {
    const arrangement = howStripeTakesASchedule(whenMoneyIsTaken(priceOption({
      charges: [{ amount_cents: 800, days_after_signup: 0 }],
      repeat: { amount_cents: 4000, interval: 'month' },
    }), 4000n));
    const complete = {
      customerRef: 'cus_1', currency: 'usd', productName: 'A product', signedUpAtUnixSeconds: 1_800_000_000,
    };

    expect(() => subscriptionScheduleRequest(arrangement, { ...complete, customerRef: '  ' }))
      .toThrow(/needs the customer it bills/i);
    expect(() => subscriptionScheduleRequest(arrangement, { ...complete, productName: '' }))
      .toThrow(/needs a name for what is being bought/i);
    expect(() => subscriptionScheduleRequest(arrangement, { ...complete, signedUpAtUnixSeconds: 1.5 }))
      .toThrow(/needs the moment the person signed up/i);
    expect(() => subscriptionScheduleRequest(
      { atCheckoutCents: 700n, phases: [], phasesStartDaysAfterSignup: 0 },
      complete,
    )).toThrow(/schedules nothing/i);
  });

  it('names the largest exact span, so seven days is a week', () => {
    expect(exactDurationForDays(7)).toEqual({ interval: 'week', interval_count: 1 });
    expect(exactDurationForDays(30)).toEqual({ interval: 'month', interval_count: 1 });
    expect(exactDurationForDays(60)).toEqual({ interval: 'month', interval_count: 2 });
    expect(exactDurationForDays(365)).toEqual({ interval: 'year', interval_count: 1 });
    expect(exactDurationForDays(3)).toEqual({ interval: 'day', interval_count: 3 });
    for (const impossible of [0, -7, 1.5]) {
      expect(() => exactDurationForDays(impossible)).toThrow(/cannot last/i);
    }
  });
});
