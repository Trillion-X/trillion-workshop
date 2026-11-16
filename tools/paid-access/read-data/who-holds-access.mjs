// tools/paid-access/read-data/who-holds-access.mjs
//
// Who holds which paid access now: the one answer every gate in this folder asks. It folds, for one buyer,
//   - their payment events (`payment-event` records, as tools/take-payments keeps them) through the person's
//     `access-effect-rule` rows into effects (payment-effects.mjs),
//   - those effects into purchase episodes and the capabilities of the offers (the rows of the person's offers list,
//     `record:commercial-offer` records) the buyer holds now (effect-lifecycle.mjs), and
//   - the grants the person wrote by hand (`access-grant` records: a gift, a pass with an end date; read-granted-access-
//     refs.ts)
// into one sorted list of access refs. A person with no rule and no lifecycle record of their own gets
// read-data/take-payments-events.json, the event kinds tools/take-payments writes.
//
// `heldAccess` is pure (rows in, answer out); `heldAccessOfRequest` takes the rows from the request: the caller's AI
// reads them from the person's stores. The time is the caller's `nowMs` (the run's own clock), never a buyer's word.
import defaults from './take-payments-events.json' with { type: 'json' };
import { effectsFromPaymentEvents } from './payment-effects.mjs';
import { currentCapabilityState } from './effect-lifecycle.mjs';
import { grantedAccessProjectionFromEffects } from './read-granted-access-refs.ts';

export const RECORD_TYPES = { paymentEvent: 'payment-event', offer: 'record:commercial-offer', grant: 'access-grant', rule: 'access-effect-rule', lifecycle: 'effect-lifecycle' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** The answer for one buyer from rows in hand. */
export function heldAccess({ subject, nowMs, paymentEvents = [], offers = [], rules, lifecycle, grants = [], emailVerified = false }) {
  const buyer = text(subject);
  if (!buyer) throw new Error('subject must name the buyer, the same way your access rules name a buyer (for the starter rules, the buyer\'s email address).');
  // A purchase names its buyer by the email on the payment, so it follows a subject only when that subject's email is
  // verified (anyone can type any email at sign-up); grants name the account and need no such proof.
  const { effects, problems } = effectsFromPaymentEvents(emailVerified === true ? paymentEvents : [], rules ?? defaults.effect_rules);
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

/**
 * `heldAccess` over a request: the rows the request carries (payment_events, offers, grants, rules, lifecycle) are
 * the rows used; the caller's AI reads them from the person's stores and hands them in. Nothing is read or kept here.
 */
export function heldAccessOfRequest(input, { nowMs }) {
  const rows = value => (Array.isArray(value) ? value.filter(object) : []);
  const rules = rows(input.rules);
  return heldAccess({
    subject: input.subject,
    nowMs,
    paymentEvents: rows(input.payment_events),
    offers: rows(input.offers),
    grants: rows(input.grants),
    rules: rules.length ? rules : undefined,
    lifecycle: object(input.lifecycle) ? input.lifecycle : undefined,
    emailVerified: input.email_verified,
  });
}

/** The access refs one buyer holds now, as the gates ask for them. */
export const heldAccessRefsOf = (input, context) => heldAccessOfRequest(input, context).held_access_refs;
