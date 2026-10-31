// tools/paid-access/read-data/who-holds-access.mjs
//
// Who holds which paid access now: the one answer every gate in this folder asks. It folds, for one buyer,
//   - their payment events (`payment-event` records, as tools/take-payments keeps them) through the person's
//     `access-effect-rule` rows into effects (payment-effects.mjs),
//   - those effects into purchase episodes and the capabilities of the offers (`commercial-offer` rows) the buyer
//     holds now (effect-lifecycle.mjs), and
//   - the grants the person wrote by hand (`access-grant` records: a gift, a pass with an end date; read-granted-access-
//     refs.ts)
// into one sorted list of access refs. A person with no rule and no lifecycle record of their own gets
// read-data/take-payments-events.json, the event kinds tools/take-payments writes.
//
// `heldAccess` is pure (rows in, answer out); `readHeldAccess` reads the rows through the records door unless the
// request carries them. The time is the caller's `nowMs` (the run's own clock), never a buyer's word.
import defaults from './take-payments-events.json' with { type: 'json' };
import { effectsFromPaymentEvents } from './payment-effects.mjs';
import { currentCapabilityState } from './effect-lifecycle.mjs';
import { grantedAccessProjectionFromEffects } from './read-granted-access-refs.ts';

export const RECORD_TYPES = { paymentEvent: 'payment-event', offer: 'commercial-offer', grant: 'access-grant', rule: 'access-effect-rule', lifecycle: 'effect-lifecycle' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** The answer for one buyer from rows in hand. */
export function heldAccess({ subject, nowMs, paymentEvents = [], offers = [], rules, lifecycle, grants = [] }) {
  const buyer = text(subject);
  if (!buyer) throw new Error('subject must name the buyer, the same way your access rules name a buyer (for the starter rules, the buyer\'s email address).');
  const { effects, problems } = effectsFromPaymentEvents(paymentEvents, rules ?? defaults.effect_rules);
  const state = currentCapabilityState({ effects, offers, lifecycle: lifecycle ?? defaults.lifecycle, subject: buyer });
  const granted = grantedAccessProjectionFromEffects(grants.filter(object).filter(grant => grant.subject === buyer), nowMs);
  return {
    subject: buyer,
    held_access_refs: [...new Set([...state.capabilities, ...granted.granted_access_refs])].sort(),
    capabilities: state.capabilities,
    granted_access_refs: granted.granted_access_refs,
    limits: state.limits,
    active_offers: state.active_offers,
    episodes: state.episodes,
    membership_revision_input: granted.membership_revision_input,
    problems,
  };
}

async function valuesOf(door, type) {
  const values = [];
  for await (const record of door.list({ type })) if (object(record.value)) values.push(record.value);
  return values;
}

const given = (rows, door, type) => (Array.isArray(rows) ? rows : valuesOf(door, type));

/**
 * `heldAccess` over the person's records: each list the request carries stands in for that kind of record, and what
 * it leaves out is listed through the door. A record that cannot be read throws; a gate treats that as unavailable,
 * never as "holds nothing".
 */
export async function readHeldAccess(input, { door, nowMs }) {
  const [paymentEvents, offers, grants, rules, lifecycles] = await Promise.all([
    given(input.payment_events, door, RECORD_TYPES.paymentEvent),
    given(input.offers, door, RECORD_TYPES.offer),
    given(input.grants, door, RECORD_TYPES.grant),
    given(input.rules, door, RECORD_TYPES.rule),
    object(input.lifecycle) ? [input.lifecycle] : valuesOf(door, RECORD_TYPES.lifecycle),
  ]);
  return heldAccess({ subject: input.subject, nowMs, paymentEvents, offers, grants, rules: rules.length ? rules : undefined, lifecycle: lifecycles[0] });
}

/** The access refs one buyer holds now, as the gates ask for them. */
export async function heldAccessRefsOf(subject, context) {
  return (await readHeldAccess({ subject }, context)).held_access_refs;
}
