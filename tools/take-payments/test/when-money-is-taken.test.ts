// The claim under test is that four older fields were four examples of one
// idea. So the tests are written as pairs: a price that says it the old way
// and a price that says it the new way must produce the SAME schedule. If any
// pair disagrees, the older field was carrying meaning the new shape lost, and
// deleting it later would change what somebody is charged.
//
// The last case is the one none of the four fields could express, which is why
// a fifth was about to be added.

import { describe, expect, it } from './expect.mjs';
import {
  whenMoneyIsTaken,
  amountDueAtSignup,
  paymentScheduleFromTheWire,
  type WhatThePriceSays,
} from '../read-data/when-money-is-taken.ts';

const BASE = { id: 'price:x', label: 'x', currency: 'usd' } as const;

function price(extra: Record<string, unknown>): WhatThePriceSays {
  return { ...BASE, ...extra } as WhatThePriceSays;
}

describe('the four older fields are four examples of one schedule', () => {
  it('an ordinary monthly plan is one charge at signup that repeats', () => {
    const schedule = whenMoneyIsTaken(
      price({ amount_cents: 4000, payment_timing: 'subscription', interval: 'month' }),
      4000n,
    );
    expect(schedule.charges).toEqual([{ amountCents: 4000n, daysAfterSignup: 0 }]);
    expect(schedule.repeat).toEqual({ amountCents: 4000n, interval: 'month', firstDaysAfterSignup: 30 });
    expect(amountDueAtSignup(schedule)).toBe(4000n);
  });

  it('a free trial is the first charge landing later, and nothing at signup', () => {
    const asOldFields = whenMoneyIsTaken(
      price({ amount_cents: 4000, payment_timing: 'subscription', interval: 'month', trial_days: 7 }),
      4000n,
    );
    const asSchedule = whenMoneyIsTaken(
      price({
        charges: [{ amount_cents: 4000, days_after_signup: 7 }],
        repeat: { amount_cents: 4000, interval: 'month' },
      }),
      4000n,
    );
    expect(asOldFields).toEqual(asSchedule);
    expect(amountDueAtSignup(asOldFields)).toBe(0n);
    // The charge is on day 7 and the NEXT one is a month after that, not a
    // month after signup. Getting this wrong bills someone twice in one month.
    expect(asOldFields.repeat?.firstDaysAfterSignup).toBe(37);
  });

  it('a different first amount is the first charge having a different amount', () => {
    const asOldFields = whenMoneyIsTaken(
      price({
        amount_cents: 4000, payment_timing: 'subscription', interval: 'month',
        trial_days: 7, initial_amount_cents: 3200,
      }),
      4000n,
    );
    const asSchedule = whenMoneyIsTaken(
      price({
        charges: [{ amount_cents: 3200, days_after_signup: 7 }],
        repeat: { amount_cents: 4000, interval: 'month' },
      }),
      4000n,
    );
    expect(asOldFields).toEqual(asSchedule);
  });

  it('paying in three is three charges and then nothing, never a repeat', () => {
    const schedule = whenMoneyIsTaken(
      price({
        amount_cents: 5000, payment_timing: 'installment', interval: 'month', installment_count: 3,
      }),
      5000n,
    );
    expect(schedule.charges).toEqual([
      { amountCents: 5000n, daysAfterSignup: 0 },
      { amountCents: 5000n, daysAfterSignup: 30 },
      { amountCents: 5000n, daysAfterSignup: 60 },
    ]);
    // A bounded count that came back as a repeat would bill forever.
    expect(schedule.repeat).toBeNull();
  });
});

describe('what none of the four fields could say', () => {
  it('money at signup and a different amount a week later, then the monthly price', () => {
    // A bakery's own offer, and the reason a fifth field was about to exist.
    const schedule = whenMoneyIsTaken(
      price({
        charges: [
          { amount_cents: 3200, days_after_signup: 7 },
          { amount_cents: 800, days_after_signup: 0 },
        ],
        repeat: { amount_cents: 4000, interval: 'month' },
      }),
      4000n,
    );
    // Written out of order on purpose: a reader must never have to sort before
    // it can say what happens first.
    expect(schedule.charges).toEqual([
      { amountCents: 800n, daysAfterSignup: 0 },
      { amountCents: 3200n, daysAfterSignup: 7 },
    ]);
    expect(amountDueAtSignup(schedule)).toBe(800n);
    expect(schedule.repeat?.firstDaysAfterSignup).toBe(37);
  });

  it('adds up several charges landing on the same day', () => {
    const schedule = whenMoneyIsTaken(
      price({ charges: [{ amount_cents: 800 }, { amount_cents: 500, days_after_signup: 0 }] }),
      0n,
    );
    expect(amountDueAtSignup(schedule)).toBe(1300n);
  });
});

describe('what it refuses rather than guesses', () => {
  it('refuses a schedule that never takes any money', () => {
    expect(() => whenMoneyIsTaken(price({ charges: [{ amount_cents: 0 }] }), 0n))
      .toThrow(/never takes any money/i);
  });

  it('reads the spellings real prices in this repository actually use', () => {
    // The first version of the table knew `year` and not `yearly`, and prices
    // here are written `yearly`, so every one of them failed to quote. The
    // spellings were counted the second time instead of guessed.
    for (const [interval, expectedDays] of [['yearly', 365], ['year', 365], ['monthly', 30], ['month', 30]] as const) {
      const schedule = whenMoneyIsTaken(
        price({ charges: [{ amount_cents: 100 }], repeat: { amount_cents: 100, interval } }),
        100n,
      );
      expect(schedule.repeat?.firstDaysAfterSignup).toBe(expectedDays);
    }
  });

  it('refuses a repeat whose length in days it does not know', () => {
    // Guessing would put a real charge on the wrong date, which is worse than
    // refusing to publish the price.
    expect(() => whenMoneyIsTaken(
      price({ charges: [{ amount_cents: 100 }], repeat: { amount_cents: 100, interval: 'fortnight' } }),
      100n,
    )).toThrow(/no known length in days/i);
  });

  it('refuses an amount that is not whole cents', () => {
    for (const bad of [1.5, -100, '100', null]) {
      expect(() => whenMoneyIsTaken(price({ charges: [{ amount_cents: bad }] }), 0n))
        .toThrow(/whole number of cents/i);
    }
  });

  it('refuses a day that is not a whole count of days', () => {
    expect(() => whenMoneyIsTaken(price({ charges: [{ amount_cents: 100, days_after_signup: 1.5 }] }), 100n))
      .toThrow(/whole number of days/i);
  });

  it('refuses a repeat that does not say how often', () => {
    expect(() => whenMoneyIsTaken(
      price({ charges: [{ amount_cents: 100 }], repeat: { amount_cents: 100 } }),
      100n,
    )).toThrow(/how often/i);
  });
});

describe('a schedule that arrived over the wire', () => {
  it('keeps every cent of an amount too large to be a JSON number', () => {
    // Read with Number instead of BigInt this loses its last digit and every
    // total still adds up, which is the reason it travels as text.
    const schedule = paymentScheduleFromTheWire({
      charges: [{ amount_cents: '9007199254740993', days_after_signup: 0 }],
      repeat: null,
    });
    expect(schedule.charges[0].amountCents).toBe(9007199254740993n);
  });

  it('reads a whole ladder back as the money it describes', () => {
    const schedule = paymentScheduleFromTheWire({
      charges: [
        { amount_cents: '800', days_after_signup: 0 },
        { amount_cents: '3200', days_after_signup: 7 },
      ],
      repeat: { amount_cents: '4000', interval: 'month', first_days_after_signup: 37 },
    });
    expect(schedule.charges).toEqual([
      { amountCents: 800n, daysAfterSignup: 0 },
      { amountCents: 3200n, daysAfterSignup: 7 },
    ]);
    expect(schedule.repeat).toEqual({
      amountCents: 4000n,
      interval: 'month',
      firstDaysAfterSignup: 37,
    });
  });

  it('refuses a charge request that carries no schedule at all', () => {
    // This used to return null for anything unreadable, and null meant "use
    // the separate fields instead", so a damaged schedule would have charged
    // somebody by a DIFFERENT set of instructions than the one that was sent.
    for (const nothing of [undefined, null, 'a schedule', 42]) {
      expect(() => paymentScheduleFromTheWire(nothing)).toThrow(/carries no payment schedule/i);
    }
  });

  it('refuses a schedule that does not list what it charges', () => {
    for (const broken of [{}, { charges: 'none' }, { charges: { amount_cents: '800' } }]) {
      expect(() => paymentScheduleFromTheWire(broken)).toThrow(/does not list what it charges/i);
    }
  });

  it('refuses an amount that did not arrive as whole cents in text', () => {
    for (const bad of [800, '20.00', '-5', '', null]) {
      expect(() => paymentScheduleFromTheWire({ charges: [{ amount_cents: bad, days_after_signup: 0 }] }))
        .toThrow(/whole cents written as text/i);
    }
  });
});
