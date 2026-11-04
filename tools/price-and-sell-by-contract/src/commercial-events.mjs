// Commercial activity as records in the person's Trillion account.
// Each event can feed any funnel whose DATA names its `funnel_id` and `stage`; EEAF writes also reach the person's
// ordinary trigger rules and workflows. The event owner does not decide which stage a graph should call it.
// Every other fact the caller gives (contract_id, buyer_ref, ...) is kept when it is text, a number or true/false, so a
// rule on the event ({ recorded: "commercial-event", where: [{ field: "event", equals: "negotiated_offer_paid" }] })
// can fill its run's input from it.
import { WorkFailure } from '../../shared-code/src/failure.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const OWN_FIELDS = ['event_id', 'kind', 'event', 'subject_kind', 'subject_id', 'funnel_id', 'stage', 'converted', 'amount_cents', 'currency', 'occurred_at'];
const FACT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const plainFact = value => (typeof value === 'string' && value.length <= 2000) || Number.isFinite(value) || typeof value === 'boolean';
const FUNNEL_INDEX = 'by-funnel';
const FUNNEL_PAGE = 128;
const ordered = events => events.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)) || String(a.event_id).localeCompare(String(b.event_id)));
const indexPending = () => Object.assign(new WorkFailure('service-busy', 'Commercial events are being indexed. Try this funnel again shortly.'),
  { domain_code: 'commercial_events_index_pending' });

export class CommercialEventError extends Error {}

function clean(input, now) {
  if (!object(input)) throw new CommercialEventError('Give the commercial event as an object.');
  for (const field of ['event_id', 'event', 'subject_kind', 'subject_id']) {
    if (!text(input[field])) throw new CommercialEventError(`Commercial event needs ${field}.`);
  }
  if (input.event_id.includes('/') || input.event_id.length > 240) throw new CommercialEventError('event_id must be up to 240 characters and contain no slash.');
  if (input.funnel_id !== undefined && !text(input.funnel_id)) throw new CommercialEventError('funnel_id must be text when supplied.');
  if (input.stage !== undefined && !text(input.stage)) throw new CommercialEventError('stage must be text when supplied.');
  if (input.converted !== undefined && typeof input.converted !== 'boolean') throw new CommercialEventError('converted must be true or false.');
  if (input.amount_cents !== undefined && (!Number.isSafeInteger(input.amount_cents) || input.amount_cents < 0)) throw new CommercialEventError('amount_cents must be a non-negative whole number.');
  if (input.currency !== undefined && (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency))) throw new CommercialEventError('currency must be a three-letter currency code in capitals, like USD.');
  const occurredAt = input.occurred_at ?? now();
  if (!text(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) throw new CommercialEventError('occurred_at must be a date and time.');
  const facts = Object.entries(input).filter(([name, value]) => !OWN_FIELDS.includes(name) && value !== undefined);
  for (const [name, value] of facts) {
    if (!FACT_NAME.test(name) || !plainFact(value)) throw new CommercialEventError(`${name} must be a lowercase name holding text, a number or true/false.`);
  }
  return {
    ...Object.fromEntries(facts),
    event_id: input.event_id,
    kind: 'commercial-event',
    event: input.event.trim(),
    subject_kind: input.subject_kind.trim(),
    subject_id: input.subject_id.trim(),
    ...(input.funnel_id ? { funnel_id: input.funnel_id.trim() } : {}),
    ...(input.stage ? { stage: input.stage.trim() } : {}),
    ...(input.converted !== undefined ? { converted: input.converted } : {}),
    ...(input.amount_cents !== undefined ? { amount_cents: input.amount_cents } : {}),
    ...(input.currency ? { currency: input.currency } : {}),
    occurred_at: occurredAt,
  };
}

/** Keep one retry-safe commercial event. Reusing its id with different facts is refused; a repeat that gives no
 *  occurred_at (its caller cannot know when the first one happened) keeps the first one's time. */
export function recordCommercialEvent(eeaf, input, { now = () => new Date().toISOString() } = {}) {
  if (!eeaf || typeof eeaf.read !== 'function' || typeof eeaf.write !== 'function') throw new TypeError('Commercial events need the account EEAF store.');
  const id = object(input) && text(input.event_id) ? `commercial-event:${input.event_id}` : null;
  const earlier = id ? eeaf.read(id) : null;
  const event = clean(input, () => (earlier?.occurred_at ?? now()));
  if (earlier) {
    // A retry without an explicit time keeps the first event's time. Its other facts must still match.
    const compared = input.occurred_at === undefined ? { ...event, occurred_at: earlier.occurred_at } : event;
    if (JSON.stringify(earlier) !== JSON.stringify(compared)) throw new CommercialEventError(`Commercial event ${event.event_id} already has different facts.`);
    return { event: earlier, repeated: true };
  }
  eeaf.write([{ id, type: 'commercial-event', value: event }], { actor: { by: 'commercial-event' } });
  return { event, repeated: false };
}

/** This person's events that pass `test`, oldest first. The account EEAF type bounds the read to that person's events. */
export function commercialEventsWhere(eeaf, test) {
  return ordered(eeaf.ids('commercial-event')
    .map(id => eeaf.read(id))
    .filter(event => object(event) && test(event)));
}

/** Read all events for one funnel. */
export function commercialEventsFor(eeaf, funnelId) {
  if (!text(funnelId)) throw new CommercialEventError('Name the funnel whose events to read.');
  if (typeof eeaf?.scan !== 'function' || typeof eeaf?.indexReady !== 'function')
    throw new TypeError('Funnel events need the canonical indexed account record store.');
  if (!eeaf.indexReady('commercial-event', FUNNEL_INDEX)) throw indexPending();
  const events = [];
  let after = null;
  try {
    for (;;) {
      const page = eeaf.scan('commercial-event', FUNNEL_INDEX, {
        equal: [funnelId], ...(after === null ? {} : { idFrom: `${after}\0` }), limit: FUNNEL_PAGE,
      });
      for (const { id } of page) {
        const event = eeaf.read(id);
        if (object(event) && event.funnel_id === funnelId) events.push(event);
      }
      if (page.length < FUNNEL_PAGE) break;
      after = page.at(-1).id;
    }
  } catch (error) {
    if (error?.code === 'index_not_ready') throw indexPending();
    throw error;
  }
  return ordered(events);
}
