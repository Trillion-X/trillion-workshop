// A person's Trillion credit: the one prepaid amount every paid tool call is taken from, whichever AI app makes it.
//
// What it holds is read, never stored as a running total:
//   given    the credit offer row's `allowances` for the tool-spend access that everyone gets (period `once`: a starting
//            credit), from commercial-offer-records
//   bought   each paid top-up of that offer, from the person's payment effects folded by capability-effect-lifecycle
//            (a refunded or disputed top-up ends its episode and stops counting)
//   spent    the person's own charge entries, one per task, each either taken or given back
// so a top-up, a refund and a charge each change the credit exactly once, in any order they arrive.
//
// A charge is keyed by the task it pays for, taken BEFORE the paid work starts and given back if the work fails, so a
// retry or two AI apps sending the same task are charged once. Limits are DATA on the credit offer row (`spend_limits`:
// per person and per AI app, per day or once) and a person may set lower ones for themselves.
import { observedLifecycleFactSet } from '../../paid-capability-state/parts/capability-effect-lifecycle/do-work/current-capability-state.mjs';

const MICROS_PER_CENT = 10000;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The day a charge falls in, for a per-day limit; `once` counts every charge ever made.
const WINDOWS = {
  day: at => String(at).slice(0, 10),
  once: () => 'once',
};

/** The credit offer: the one sale offer that grants `access`. */
export function creditOffer(offers, access) {
  const found = offers.filter(offer => (offer.access_refs ?? []).includes(access));
  if (found.length !== 1) throw new Error(`Exactly one offer must grant ${access}; ${found.length} do.`);
  return found[0];
}

/**
 * What the person can spend now.
 *   effects    the person's admitted payment effects
 *   offer      the credit offer row
 *   access     the access that tool spending uses
 *   lifecycle  the installed capability-effect-lifecycle row
 *   charges    the person's charge entries: [{ task_id, micros, currency, at, app, given_back_at? }]
 */
export function creditOf({ effects, offer, access, lifecycle, charges, spent_micros }) {
  const allowances = (offer.allowances ?? []).filter(row => row?.access === access && Number.isSafeInteger(row.amount_micros));
  const currency = allowances[0]?.currency ?? offer.price_options?.[0]?.currency ?? 'usd';
  const given = allowances.filter(row => row.per === 'once').reduce((sum, row) => sum + row.amount_micros, 0);
  const confirmed = new Map((effects ?? []).filter(object).map(effect => [effect.effect_id, effect]));
  let bought = 0;
  for (const episode of observedLifecycleFactSet({ effects: effects ?? [], lifecycle })) {
    if (episode.offer_id !== offer.id || episode.state !== 'active') continue;
    const first = confirmed.get(episode.events[0]?.effect_id);
    const cents = Number(first?.material?.amount_due_today_cents);
    if (Number.isSafeInteger(cents) && cents > 0) bought += cents * MICROS_PER_CENT;
  }
  if(spent_micros!==undefined&&(!Number.isSafeInteger(spent_micros)||spent_micros<0))throw new TypeError('The original charge owner must supply an exact non-negative spent amount.');
  const spent = spent_micros ?? (charges ?? []).filter(charge => !charge.given_back_at).reduce((sum, charge) => sum + charge.micros, 0);
  return { micros: given + bought - spent, currency, given_micros: given, bought_micros: bought, spent_micros: spent };
}

/**
 * Whether a charge of `micros` may be taken now. Limits come from the offer row (`spend_limits`), narrowed by the
 * person's own (`own_limits`, same shape), each `{ scope: 'person' | 'app', amount_micros, per: 'day' | 'once' }`.
 * Returns null when it may, else what stops it: `{ missing: 'credit' | 'spend-limit', ... }`.
 */
export function chargeRefusal({ credit, micros, app, at, charges, limits = [], ownLimits = [], usedMicrosFor = null }) {
  if (micros > credit.micros) return { missing: 'credit', needed_micros: micros, credit_micros: credit.micros };
  const live = (charges ?? []).filter(charge => !charge.given_back_at);
  for (const limit of [...limits, ...ownLimits]) {
    const window = WINDOWS[limit.per];
    if (!window || !Number.isSafeInteger(limit.amount_micros)) continue;
    const inScope = charge => window(charge.at) === window(at) && (limit.scope !== 'app' || (charge.app ?? null) === (app ?? null));
    const used = usedMicrosFor ? usedMicrosFor({scope:limit.scope,per:limit.per,app:app??null,at})
      : live.filter(inScope).reduce((sum, charge) => sum + charge.micros, 0);
    if(!Number.isSafeInteger(used)||used<0)throw new TypeError('The original charge owner must supply an exact non-negative limit amount.');
    if (used + micros > limit.amount_micros) return { missing: 'spend-limit', scope: limit.scope, per: limit.per, limit_micros: limit.amount_micros, used_micros: used, ...(limit.scope === 'app' ? { app: app ?? null } : {}) };
  }
  return null;
}

/** The price a person pays for a call: the source's own price plus that source's markup percent (DATA, may be zero). */
export function withMarkup(micros, markup) {
  const percent = Number(markup?.percent ?? 0);
  if (!(percent >= 0)) throw new Error('A markup is { percent } of zero or more.');
  return Math.ceil(micros * (1 + percent / 100));
}

export const dollars = micros => `$${(micros / 1e6).toFixed(micros % 10000 === 0 ? 2 : 4)}`;
