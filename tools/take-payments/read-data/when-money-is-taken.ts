// packages/payment-adapter/read-data/when-money-is-taken.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One shape for when a price takes money and how much: a list of charges, each
// with an amount and how many days after signup it is due, and optionally a
// repeat that continues from the last one.
//
// A price already said this four separate ways, and each way was one example
// that had been turned into its own field:
//
//   trial_days: 7            the first charge is due on day 7
//   initial_amount_cents     the first charge is a different amount
//   installment_count: 3     there are three charges and then it stops
//   amount_cents + interval  one charge on day 0 that repeats
//
// Every one of those is a list of charges with a repeat. None of them could
// express a charge today AND a different charge next week, which is an
// ordinary offer, so a fifth field was about to be added for it. The fifth
// field is the tell: when adding an example means adding a field, the field is
// not the idea.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure. A price in, a schedule out; no clock is read here, because "day 7"
//    is a property of the offer and the date it lands on is not.
// 2. Amounts are whole cents as bigint. Money never becomes a float.
// 3. Charges come out in the order they are taken, earliest first, so a reader
//    never has to sort before it can say what happens first.
// 4. A price that declares a schedule directly is read as written. The older
//    fields are DERIVED into the same shape rather than handled beside it, so
//    everything downstream reads one thing and the old fields can be deleted
//    from DATA without touching anything downstream.
// 5. A schedule that takes no money is refused. Nothing downstream can tell a
//    genuinely free offer from a price whose fields cancelled out, and a
//    checkout that charges nothing looks like it worked.
//
// =============================================================================

/**
 * The parts of a price this reads, and nothing else.
 *
 * This used to name the checkout's own full price type, which is how a payment
 * provider ended up importing the checkout's source to read a schedule. Of that
 * type's twenty-five fields this reads seven. Declaring those seven here means
 * the caller's larger type still fits, this file learns nothing about a
 * checkout, and any provider can read a schedule without reaching into one.
 */
export type WhatThePriceSays = {
  charges?: unknown;
  repeat?: unknown;
  installment_count?: number;
  initial_amount_cents?: number;
  interval?: string;
  payment_timing?: string;
  trial_days?: number;
};

/** One amount, and how long after signup it is taken. */
export type ScheduledCharge = {
  amountCents: bigint;
  daysAfterSignup: number;
};

/** What a price takes, and when. */
export type WhenMoneyIsTaken = {
  /** Each charge that happens a fixed number of days after signup. */
  charges: ScheduledCharge[];
  /**
   * What continues after the last charge above, or null when the price stops.
   * `intervalDays` is how often it repeats; `firstDaysAfterSignup` is when the
   * first repeating charge lands.
   */
  repeat: {
    amountCents: bigint;
    interval: string;
    firstDaysAfterSignup: number;
  } | null;
};

// How long each repeat is, with the spellings the corpus actually uses. The
// first version of this table knew `year` and not `yearly`, and real prices in
// this repository are written `yearly`, so every one of them failed to quote.
// The spellings were counted rather than guessed at the second attempt.
const DAYS_IN_AN_INTERVAL: Record<string, number> = {
  day: 1,
  daily: 1,
  week: 7,
  weekly: 7,
  month: 30,
  monthly: 30,
  year: 365,
  yearly: 365,
};

/**
 * Roughly how long one repeat lasts, for ORDERING charges. NOT A DATE.
 *
 * A month here is thirty days and a year is three hundred and sixty five. A
 * payment provider bills on calendar dates: a subscription anchored on the
 * 31st renews on the 28th, then the 31st, then the 30th. Thirty days is never
 * that, and the difference is a real day on a real statement.
 *
 * So this number decides only which charge comes FIRST, which is all this file
 * needs to know to say that the repeat continues after the last fixed charge
 * rather than before it. Nothing here may be shown to a person as a renewal
 * date or used to decide when to take money. The provider owns the calendar,
 * and the date a customer is told must come from the provider's own answer for
 * that subscription, never from arithmetic done here.
 *
 * A word this does not know is REFUSED rather than treated as a month.
 * Elsewhere an unknown interval quietly becomes monthly, which is a safe
 * default for LABELLING a price and a dangerous one here, because ordering the
 * charges wrongly changes which one the provider treats as the first payment.
 */
function daysInOneInterval(interval: string): number {
  const days = DAYS_IN_AN_INTERVAL[interval.trim().toLowerCase()];
  if (!days) throw new Error(`This price repeats every "${interval}", which has no known length in days.`);
  return days;
}

function wholeCents(value: unknown, label: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a whole number of cents.`);
  }
  return BigInt(value);
}

function wholeDays(value: unknown, label: string): number {
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a whole number of days.`);
  }
  return value;
}

/** A price that writes its schedule out. */
function scheduleAsWritten(price: WhatThePriceSays): WhenMoneyIsTaken | null {
  const written = (price as { charges?: unknown }).charges;
  if (!Array.isArray(written)) return null;
  const charges = written.map((row, index) => ({
    amountCents: wholeCents((row as { amount_cents?: unknown })?.amount_cents, `charges[${index}].amount_cents`),
    daysAfterSignup: wholeDays(
      (row as { days_after_signup?: unknown })?.days_after_signup,
      `charges[${index}].days_after_signup`,
    ),
  }));
  charges.sort((left, right) => left.daysAfterSignup - right.daysAfterSignup);

  const repeating = (price as { repeat?: { amount_cents?: unknown; interval?: unknown } }).repeat;
  if (!repeating) return { charges, repeat: null };
  const interval = typeof repeating.interval === 'string' ? repeating.interval : '';
  if (!interval) throw new Error('A repeating charge must say how often it repeats.');
  const last = charges.length > 0 ? charges[charges.length - 1] : null;
  return {
    charges,
    repeat: {
      amountCents: wholeCents(repeating.amount_cents, 'repeat.amount_cents'),
      interval,
      // The repeat continues from the last fixed charge, so its first landing
      // is one interval after that charge. With no fixed charges it starts at
      // signup, which is the ordinary monthly plan.
      firstDaysAfterSignup: last ? last.daysAfterSignup + daysInOneInterval(interval) : 0,
    },
  };
}

/**
 * The same shape, read off the four older fields.
 *
 * This exists so everything downstream reads ONE thing while DATA still says
 * it the old way. Handling the old fields beside the new shape instead would
 * mean every reader learns both, forever.
 */
function scheduleFromTheOlderFields(
  price: WhatThePriceSays,
  recurringAmountCents: bigint,
): WhenMoneyIsTaken {
  const firstDay = wholeDays(price.trial_days, 'trial_days');
  const firstAmount = price.initial_amount_cents == null
    ? recurringAmountCents
    : wholeCents(price.initial_amount_cents, 'initial_amount_cents');
  const charges: ScheduledCharge[] = [{ amountCents: firstAmount, daysAfterSignup: firstDay }];

  const timing = typeof price.payment_timing === 'string' ? price.payment_timing.toLowerCase() : '';
  const interval = typeof price.interval === 'string' ? price.interval : '';

  // A bounded count of charges is a list, not a repeat: it ends.
  const count = price.installment_count;
  if (typeof count === 'number' && count > 1 && interval) {
    const every = daysInOneInterval(interval);
    for (let index = 1; index < count; index += 1) {
      charges.push({ amountCents: recurringAmountCents, daysAfterSignup: firstDay + every * index });
    }
    return { charges, repeat: null };
  }

  if (timing !== 'subscription' || !interval) return { charges, repeat: null };
  return {
    charges,
    repeat: {
      amountCents: recurringAmountCents,
      interval,
      firstDaysAfterSignup: firstDay + daysInOneInterval(interval),
    },
  };
}

/**
 * When this price takes money, and how much, however the price says it.
 *
 * `recurringAmountCents` is what the quote worked out the ordinary amount to
 * be, after any per-unit arithmetic. It is passed in rather than read from the
 * price because that arithmetic is the quote's job, not this one's.
 */
export function whenMoneyIsTaken(
  price: WhatThePriceSays,
  recurringAmountCents: bigint,
): WhenMoneyIsTaken {
  const schedule = scheduleAsWritten(price) ?? scheduleFromTheOlderFields(price, recurringAmountCents);
  const takesMoney = schedule.charges.some((charge) => charge.amountCents > 0n)
    || (schedule.repeat?.amountCents ?? 0n) > 0n;
  if (!takesMoney) {
    throw new Error('This price never takes any money. A free offer says so with a zero amount, not with a schedule that cancels out.');
  }
  return schedule;
}

/** What is taken at signup, which is every charge due on day 0. */
export function amountDueAtSignup(schedule: WhenMoneyIsTaken): bigint {
  return schedule.charges
    .filter((charge) => charge.daysAfterSignup === 0)
    .reduce((total, charge) => total + charge.amountCents, 0n);
}

/**
 * A schedule that arrived over the wire, back as money.
 *
 * This lives beside the type it produces rather than inside a payment
 * provider, because what it decodes is a schedule, not anything a provider
 * says. A provider that reads schedules would otherwise own the definition of
 * one, and the next provider would need its own copy.
 *
 * Amounts come as text because whole cents are not JSON numbers, so they are
 * read with BigInt rather than Number. Reading them with Number is the failure
 * this guards: it loses the last digits of a large amount silently, and every
 * total still adds up.
 */
export function paymentScheduleFromTheWire(value: unknown): WhenMoneyIsTaken {
  // ONE PATH. A schedule is how an offer says what it takes, so a request to
  // charge somebody arrives with one or it does not get made.
  //
  // The first version returned null for anything it could not read, and a test
  // here enshrined it: `{ charges: 'none' }` came back as "no schedule". Null
  // meant "use the separate fields instead", so a schedule that arrived
  // damaged would have charged a person by a DIFFERENT set of instructions
  // than the one that was sent, silently. Two ways to decide what to charge is
  // one too many; the weaker fix was to tell them apart, and the correct one
  // is to have a single way and refuse anything that is not it.
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new Error('This charge request carries no payment schedule, so there is nothing that says what to take.');
  }
  const sent = value as { charges?: unknown; repeat?: unknown };
  if (!Array.isArray(sent.charges)) {
    throw new Error('This payment schedule does not list what it charges.');
  }

  const charges = sent.charges.map((row, index) => {
    const charge = row as { amount_cents?: unknown; days_after_signup?: unknown };
    if (typeof charge?.amount_cents !== 'string' || !/^\d+$/.test(charge.amount_cents)) {
      throw new Error(`charges[${index}].amount_cents must be whole cents written as text.`);
    }
    const days = charge.days_after_signup;
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 0) {
      throw new Error(`charges[${index}].days_after_signup must be a whole number of days.`);
    }
    return { amountCents: BigInt(charge.amount_cents), daysAfterSignup: days };
  });

  const sentRepeat = sent.repeat as
    { amount_cents?: unknown; interval?: unknown; first_days_after_signup?: unknown } | null;
  if (!sentRepeat) return { charges, repeat: null };
  if (typeof sentRepeat.amount_cents !== 'string' || !/^\d+$/.test(sentRepeat.amount_cents)) {
    throw new Error('repeat.amount_cents must be whole cents written as text.');
  }
  const firstDays = sentRepeat.first_days_after_signup;
  if (typeof firstDays !== 'number' || !Number.isSafeInteger(firstDays) || firstDays < 0) {
    throw new Error('repeat.first_days_after_signup must be a whole number of days.');
  }
  return {
    charges,
    repeat: {
      amountCents: BigInt(sentRepeat.amount_cents),
      interval: typeof sentRepeat.interval === 'string' ? sentRepeat.interval : '',
      firstDaysAfterSignup: firstDays,
    },
  };
}
