// tools/take-payments/do-work/stripe-phases-for-a-payment-schedule.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Say a payment schedule as a list of subscription phases.
//
// A phase charges its own amount when it starts and lasts for its own
// duration, so a schedule of charges IS a list of phases and needs no discount
// at all to vary what the first ones cost. That matters: the other way to vary
// a first invoice is a one-use discount, and a discount is spent by whichever
// invoice settles first, so an offer that also takes money at signup can have
// its reduction land on the wrong charge and invert itself. Phases have
// nothing to misapply.
//
// Read from the provider's own documentation rather than assumed:
//   phases[n][items][0][price], phases[n][duration][interval],
//   phases[n][duration][interval_count]
// and a phase with no duration continues until something changes it.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure. A schedule in, phases out. No network, no clock, no money moved.
// 2. A gap between two charges becomes an EXACT duration or this refuses. A
//    duration is what decides the day a real charge lands, so a gap that is
//    nearly a month is not a month, and rounding it would move somebody's
//    payment to a day nobody chose.
// 3. Every charge in the schedule appears in exactly one phase, in order. A
//    charge that fell out would be money the offer promised and the provider
//    never asked for.
// 4. The repeat becomes the last phase and has no duration, because it is the
//    part that continues.
//
// =============================================================================

import type { WhenMoneyIsTaken } from '../read-data/when-money-is-taken.ts';

export type SubscriptionPhase = {
  amountCents: bigint;
  /** How long this phase lasts. Absent on the last phase, which continues. */
  duration?: { interval: string; interval_count: number };
  /** How often this phase's own price bills while it lasts. */
  recurring: { interval: string; interval_count: number };
};

// Exact spans only. A gap this cannot name exactly is refused rather than
// rounded, because this number is the day a charge lands on.
const EXACT_SPANS: { days: number; interval: string }[] = [
  { days: 1, interval: 'day' },
  { days: 7, interval: 'week' },
  { days: 30, interval: 'month' },
  { days: 365, interval: 'year' },
];

/**
 * A gap in days as a whole number of one provider interval.
 *
 * Prefers the largest interval that divides the gap exactly, so seven days is
 * one week rather than seven days, which is the same span and the shape a
 * person recognises on an invoice.
 */
export function exactDurationForDays(days: number): { interval: string; interval_count: number } {
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new Error(`A phase cannot last ${days} days.`);
  }
  for (const span of [...EXACT_SPANS].reverse()) {
    if (days % span.days === 0) {
      return { interval: span.interval, interval_count: days / span.days };
    }
  }
  // Unreachable for a whole number of days, because the day span divides every
  // one of them. It is kept rather than deleted so the loop above cannot be
  // narrowed later without something saying what happens to what falls out.
  throw new Error(
    `${days} days is not a whole number of days, weeks, months or years, and rounding it would move a real charge to a day nobody chose.`,
  );
}

/**
 * This schedule as phases, earliest first.
 *
 * Each fixed charge becomes a phase that lasts until the next charge. The
 * repeat becomes the final phase, which continues.
 */
export function stripePhasesForAPaymentSchedule(schedule: WhenMoneyIsTaken): SubscriptionPhase[] {
  const charges = schedule.charges;
  if (charges.length === 0 && !schedule.repeat) {
    throw new Error('This offer has no charges and nothing that repeats, so there are no phases to build.');
  }
  if (charges.length > 0 && charges[0].daysAfterSignup !== 0) {
    // A schedule starts when the person signs up. A first charge dated later
    // is a gap with no phase to fill it, and a phase list that silently begins
    // late would take the first payment on a day the offer never named.
    throw new Error(
      `This offer takes its first money ${charges[0].daysAfterSignup} days after signup with nothing before it, which a phase list cannot express.`,
    );
  }

  const phases: SubscriptionPhase[] = [];
  for (let index = 0; index < charges.length; index += 1) {
    const charge = charges[index];
    const endsAt = index + 1 < charges.length
      ? charges[index + 1].daysAfterSignup
      : schedule.repeat?.firstDaysAfterSignup;
    if (endsAt === undefined) {
      // The last charge with nothing after it: it continues, so it is the
      // final phase and has no duration.
      phases.push({ amountCents: charge.amountCents, recurring: { interval: 'month', interval_count: 1 } });
      continue;
    }
    const duration = exactDurationForDays(endsAt - charge.daysAfterSignup);
    phases.push({
      amountCents: charge.amountCents,
      duration,
      // A phase's price bills on its own span, so one charge for the length of
      // the phase is exactly one billing of that price.
      recurring: duration,
    });
  }

  if (schedule.repeat) {
    phases.push({
      amountCents: schedule.repeat.amountCents,
      recurring: { interval: schedule.repeat.interval, interval_count: 1 },
    });
  }
  return phases;
}

export type HowStripeTakesASchedule = {
  /**
   * Taken during checkout itself, where a decline is seen while the person is
   * still there. Zero means nothing is due at the door.
   */
  atCheckoutCents: bigint;
  /** Everything after that, as phases, attached once the card is collected. */
  phases: SubscriptionPhase[];
  /** Days after signup those phases begin. */
  phasesStartDaysAfterSignup: number;
};

/**
 * Split a schedule into the part taken at the door and the part scheduled.
 *
 * A subscription schedule cannot take the first payment at the door, and this
 * is the whole reason this function exists. From the provider's own
 * documentation on subscription schedules:
 *
 *   "Unlike when you create a subscription directly, the first invoice of a
 *   subscription schedule with collection_method set to charge_automatically
 *   ... isn't immediately finalized at the time the schedule's subscription is
 *   created. The invoice begins in a draft status and is finalized by Stripe
 *   approximately 1 hour after creation."
 *
 * So a schedule starting now does not charge now. It charges about an hour
 * later, after the person has closed the tab believing they paid, and a card
 * that declines then declines to nobody. For an offer whose first charge IS
 * the moment of commitment, that is the failure that matters most and it is
 * invisible in testing, because an hour later the money usually does arrive.
 *
 * The first charge is therefore taken by the checkout itself, which settles
 * while they are watching, and the phases cover what comes after. The hour of
 * draft still applies to those, where a delay costs nothing.
 *
 * A schedule whose first charge is not at signup keeps an empty door: there is
 * nothing to take yet, and the phases carry all of it.
 */
export function howStripeTakesASchedule(schedule: WhenMoneyIsTaken): HowStripeTakesASchedule {
  const charges = schedule.charges;
  const takenAtTheDoor = charges.length > 0 && charges[0].daysAfterSignup === 0
    ? charges[0]
    : null;
  if (!takenAtTheDoor) {
    return {
      atCheckoutCents: 0n,
      phases: stripePhasesForAPaymentSchedule(schedule),
      phasesStartDaysAfterSignup: 0,
    };
  }

  const rest: WhenMoneyIsTaken = { charges: charges.slice(1), repeat: schedule.repeat };
  if (rest.charges.length === 0 && !rest.repeat) {
    // A single charge at the door is an ordinary one-time sale. There is
    // nothing left to schedule, and creating an empty schedule for it would
    // leave a subscription on the account that bills nobody for nothing.
    return { atCheckoutCents: takenAtTheDoor.amountCents, phases: [], phasesStartDaysAfterSignup: 0 };
  }

  const startsAt = rest.charges.length > 0
    ? rest.charges[0].daysAfterSignup
    : rest.repeat!.firstDaysAfterSignup;
  // The phases are rewritten as if the schedule began on its own first day,
  // because it does: it is attached to start then, and a phase list that still
  // counted from signup would carry a gap it has no phase to fill.
  const fromItsOwnStart: WhenMoneyIsTaken = {
    charges: rest.charges.map((charge) => ({
      amountCents: charge.amountCents,
      daysAfterSignup: charge.daysAfterSignup - startsAt,
    })),
    repeat: rest.repeat
      ? { ...rest.repeat, firstDaysAfterSignup: rest.repeat.firstDaysAfterSignup - startsAt }
      : null,
  };

  return {
    atCheckoutCents: takenAtTheDoor.amountCents,
    phases: stripePhasesForAPaymentSchedule(fromItsOwnStart),
    phasesStartDaysAfterSignup: startsAt,
  };
}

export type WhatTheCheckoutDoes = {
  /**
   * `payment` takes money now. `setup` takes none and only collects a card,
   * which is a real case rather than a degenerate one: an offer whose first
   * money is due next week still needs a card today.
   */
  mode: 'payment' | 'setup';
  amountCents: bigint;
  /**
   * Whether the card must remain usable after this checkout. True whenever
   * anything is scheduled, because a schedule with no stored card fails on its
   * first phase, days later, silently, to somebody who has already been told
   * they are signed up.
   */
  keepTheCardForLater: boolean;
};

/**
 * What the checkout itself must do for this arrangement.
 *
 * Kept apart from the form body because it is a decision, and a decision
 * inside a body builder is a decision nothing can test on its own. All three
 * combinations are real: money now with more scheduled, money now and nothing
 * after it, and nothing now with everything scheduled.
 */
export function whatTheCheckoutDoes(arrangement: HowStripeTakesASchedule): WhatTheCheckoutDoes {
  const scheduled = arrangement.phases.length > 0;
  if (arrangement.atCheckoutCents > 0n) {
    return { mode: 'payment', amountCents: arrangement.atCheckoutCents, keepTheCardForLater: scheduled };
  }
  if (!scheduled) {
    throw new Error('This offer takes nothing at the door and schedules nothing, so there is no checkout to make.');
  }
  return { mode: 'setup', amountCents: 0n, keepTheCardForLater: true };
}

const SECONDS_IN_A_DAY = 86_400;

/**
 * The request that creates this arrangement's schedule at the provider.
 *
 * Phases carry their price INLINE. Read from the provider's API reference
 * rather than assumed: "price_data: Data used to generate a new Price object
 * inline. One of price or price_data is required." That matters more than it
 * looks, because the alternative is creating a Price for every amount in every
 * ladder before the schedule can exist, which is a second set of objects to
 * make, name, find again and keep in step with the offer that describes them.
 *
 * `end_behavior: release` so that when a schedule finishes it leaves an
 * ordinary subscription behind rather than cancelling one. For a ladder ending
 * in a repeat this never happens, because the last phase has no duration and
 * continues; it matters for a ladder that ends.
 *
 * No clock. The caller says when signup happened, because this has to produce
 * the same request twice for the same signup: a time read here would make the
 * request differ every call and quietly defeat retrying one safely.
 */
export function subscriptionScheduleRequest(
  arrangement: HowStripeTakesASchedule,
  at: { customerRef: string; currency: string; productName: string; signedUpAtUnixSeconds: number },
): Record<string, unknown> {
  if (arrangement.phases.length === 0) {
    throw new Error('This arrangement schedules nothing, so there is no schedule to create.');
  }
  const customer = at.customerRef?.trim();
  if (!customer) throw new Error('A schedule needs the customer it bills.');
  const productName = at.productName?.trim();
  if (!productName) throw new Error('A schedule needs a name for what is being bought.');
  if (!Number.isSafeInteger(at.signedUpAtUnixSeconds)) {
    throw new Error('A schedule needs the moment the person signed up.');
  }

  return {
    customer,
    start_date: at.signedUpAtUnixSeconds + arrangement.phasesStartDaysAfterSignup * SECONDS_IN_A_DAY,
    end_behavior: 'release',
    phases: arrangement.phases.map((phase) => {
      const item: Record<string, unknown> = {
        price_data: {
          currency: at.currency,
          product_data: { name: productName },
          unit_amount: asAWholeNumberOfCents(phase.amountCents),
          recurring: { interval: phase.recurring.interval, interval_count: phase.recurring.interval_count },
        },
        quantity: 1,
      };
      const built: Record<string, unknown> = { items: [item] };
      // The last phase has no duration because it is the part that continues.
      // Giving it one would end the plan on a day nobody chose.
      if (phase.duration) built.duration = phase.duration;
      return built;
    }),
  };
}

function asAWholeNumberOfCents(amount: bigint): number {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('A phase amount is too large to send without losing cents.');
  }
  return Number(amount);
}

/**
 * What this whole arrangement takes and when, read back out.
 *
 * Compared against the offer it came from, this is what proves the split did
 * not lose or move any money. Without it the split is trusted, and a split
 * that drops the door charge takes the same shape as one that does not.
 */
export function whatThisArrangementTakes(
  arrangement: HowStripeTakesASchedule,
): { amountCents: bigint; daysAfterSignup: number }[] {
  const taken = arrangement.atCheckoutCents > 0n
    ? [{ amountCents: arrangement.atCheckoutCents, daysAfterSignup: 0 }]
    : [];
  for (const row of whatThesePhasesTake(arrangement.phases)) {
    taken.push({
      amountCents: row.amountCents,
      daysAfterSignup: row.daysAfterSignup + arrangement.phasesStartDaysAfterSignup,
    });
  }
  return taken;
}

/** What each phase takes and when, read back out, for comparing to the offer. */
export function whatThesePhasesTake(
  phases: readonly SubscriptionPhase[],
): { amountCents: bigint; daysAfterSignup: number }[] {
  const daysOf = (duration?: { interval: string; interval_count: number }) => {
    if (!duration) return 0;
    const span = EXACT_SPANS.find((row) => row.interval === duration.interval);
    if (!span) throw new Error(`A phase lasts one "${duration.interval}", which has no known length.`);
    return span.days * duration.interval_count;
  };
  let day = 0;
  const taken: { amountCents: bigint; daysAfterSignup: number }[] = [];
  for (const phase of phases) {
    taken.push({ amountCents: phase.amountCents, daysAfterSignup: day });
    day += daysOf(phase.duration);
  }
  return taken;
}
