// src/plan-usage.mjs
//
// PURPOSE
//   A paying person's own count of what their plan charges by use (src/usage-meters.json), kept in their store and
//   sent once a day. After a checkout or renewal adds the plan's counted prices to their subscription
//   (src/payment.mjs startPlanUsage), the store keeps one fact naming that subscription and plan; each day after the
//   day ends it reads the readings the plan's meters name (what the person keeps, what their work cost that day) and
//   sends the units above what the plan includes to Stripe with the service's own key (src/payment.mjs planUsageSender),
//   only while the plan is paid.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One count per subscription, meter and day: the identifier `<subscription>:<meter>:<day>` is Stripe's, so a
//      retry or a second wake never counts a day twice.
//   2. A day is counted with the reading taken when it is sent. A day missed while the store slept is never filled
//      in with a guess; it is simply not charged.
//   3. Nothing is sent once the purchase is no longer active (cancelled, refunded, ended); the fact is cleared.
//   4. A failed send throws, so the store's scheduler sets the day aside and tries it again; the day is marked counted
//      only after the tool answered.
//
import { historyDays, offerUsage, unitsAbove, usageRow } from '../../price-and-sell-by-contract/src/usage-meters.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
// Sent a little after midnight UTC, so the day it counts is over everywhere the provider looks.
const AFTER_MIDNIGHT_MS = 15 * 60 * 1000;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const startOf = day => Date.parse(`${day}T00:00:00Z`);

// The readings a pending send or a finished day kept, read the same way whether it was kept before readings had names.
const readingsOf = kept => kept?.readings ?? (Number.isSafeInteger(kept?.bytes) ? { 'stored-bytes': kept.bytes } : null);

/**
 * facts: { read, write } of the one `plan_usage` fact; readings(agreement, day, names): the named readings for that
 * day ({ [name]: whole number }, or { pending: true, retry_at } while a measurement is still being taken);
 * active(subscription): whether that purchase is still active; offerOf(id): the offer row; send(input): the operator
 * tool's answer; now(): ms.
 */
export function makePlanUsage({ facts, readings, active, offerOf, send, contractTerms = () => null, now = Date.now }) {
  return {
    /** The plan's counted prices were added to `subscription_id`: count from today. */
    attached({ subscription_id, offer_id, customer = null, allocation_offer_id = null, payer_id = null, usage_terms = null, usage_price_ids = null, spending_terms = null, resource_pricing_terms = null }) {
      const kept = facts.read();
      if (kept?.subscription_id === subscription_id && kept.offer_id === offer_id) return kept;
      const started = { subscription_id, offer_id, customer, since: new Date(now()).toISOString(), counted_day: null,
        ...(allocation_offer_id ? { allocation_offer_id, payer_id } : {}), ...(usage_terms ? { usage_terms: structuredClone(usage_terms), usage_price_ids: structuredClone(usage_price_ids) } : {}),
        ...(resource_pricing_terms ? { resource_pricing_terms: structuredClone(resource_pricing_terms) } : {}), ...(spending_terms ? { spending_terms: structuredClone(spending_terms) } : {}) };
      facts.write(started);
      return started;
    },
    /** When the next day's count is due, or null when nothing is counted. */
    nextAt() {
      const kept = facts.read();
      if (!kept) return null;
      if (kept.measurement?.retry_at) return kept.measurement.retry_at;
      const ended = dayOf(now() - DAY_MS);
      return kept.counted_day === ended || ended < dayOf(Date.parse(kept.since))
        ? startOf(dayOf(now())) + DAY_MS + AFTER_MIDNIGHT_MS
        : now();
    },
    /** Counts the day that ended last, once. → what was sent, or why nothing was. */
    async countDue() {
      const kept = facts.read();
      if (!kept) return { counted: false, reason: 'no plan counts usage' };
      if (!(await active(kept.subscription_id))) {
        facts.write(null);
        return { counted: false, reason: 'the plan ended' };
      }
      const day = kept.pending?.day ?? kept.measurement?.day ?? dayOf(now() - DAY_MS);
      if (kept.counted_day === day || day < dayOf(Date.parse(kept.since))) return { counted: false, reason: 'already counted' };
      if (kept.pending && now() - Date.parse(kept.pending.prepared_at) > 23 * 60 * 60 * 1000) {
        throw new Error('A usage send has an unknown outcome beyond its safe retry window. Reconcile the provider before sending it again.');
      }
      let terms = (kept.usage_terms ?? offerUsage(offerOf(kept.offer_id))).map(usageRow);
      // New agreements pin this choice when their purchase is recorded. A false
      // choice stops only work-cost overage; storage and any already-pending send
      // keep their own purchased rows. Older agreements without the new field
      // keep the exact usage terms they already carried.
      // A negotiated contract's billing choice (access.spending_terms) replaces the one the purchase pinned.
      if ((contractTerms() ?? kept.spending_terms)?.bill_overage === false) terms = terms.filter(row => row.meter.reading !== 'work-cost');
      const names = [...new Set(terms.map(usage => usage.meter.reading))];
      const read = readingsOf(kept.pending) ?? await readings(kept, day, names);
      if (read?.pending === true) {
        facts.write({ ...kept, measurement: { day, retry_at: read.retry_at } });
        return { counted: false, reason: 'measurement pending', retry_at: read.retry_at };
      }
      if (!names.every(name => Number.isSafeInteger(read?.[name]) && read[name] >= 0)) throw new Error('Usage could not be measured; no charge was reported.');
      const report = kept.pending?.report ?? terms.map(usage => ({
        event_name: usage.meter.event_name,
        value: unitsAbove(read[usage.meter.reading], usage),
        identifier: `${kept.subscription_id}:${usage.meter.id}:${day}`,
        // The last second of the day counted, in seconds as the provider takes it.
        timestamp: Math.floor((startOf(day) + DAY_MS) / 1000) - 1,
      })).filter(event => Number.isSafeInteger(event.value) && event.value > 0);
      if (report.length && !kept.pending) facts.write({ ...kept, pending: { day, readings: read, report, prepared_at: new Date(now()).toISOString() } });
      const answer = report.length ? await send({ subscription_id: kept.subscription_id, report, ...(kept.allocation_offer_id ? { allocation_offer_id: kept.allocation_offer_id } : {}) }) : null;
      // The last days counted are kept with the agreement, so Billing can draw what each day used without asking anyone.
      const counted = { day, readings: read, sent: answer?.reported ?? [], skipped: answer?.skipped ?? (report.length ? null : 'within what the plan includes') };
      facts.write({ ...kept, pending: null, measurement: null, counted_day: day, last: counted,
        history: [...(kept.history ?? []).filter(row => row.day !== day), { day, readings: read }].slice(-historyDays) });
      return { counted: true, day, report, answer };
    },
  };
}


/** Several independently funded agreements, on the same scheduler as a legacy single plan.
 * A bounded wake drains due agreements; a second purchase never replaces the first.
 * Legacy state is read in place and migrates on the first actual write, not on a read. */
/** The readings a kept day or send counted, by name (see readingsOf). */
export const keptReadings = readingsOf;

/** The agreements one `plan_usage` fact holds: a list, or the single plan it held before there were several. */
export const planUsageAgreements = state => (Array.isArray(state?.agreements) ? state.agreements : state?.subscription_id ? [state] : []);

export function makePlanUsageSet({ facts, readings, active, offerOf, send, contractTerms = () => null, now = Date.now, batch_size = 10 }) {
  const states = () => planUsageAgreements(facts.read());
  const one = id => makePlanUsage({
    facts: {
      read: () => states().find(row => row.subscription_id === id) ?? null,
      write: value => facts.write({ version: 1, agreements: [...states().filter(row => row.subscription_id !== id), ...(value ? [value] : [])] }),
    }, readings, active, offerOf, send, contractTerms, now,
  });
  let running = null;
  return {
    states: () => structuredClone(states()),
    attached: input => one(input.subscription_id).attached(input),
    nextAt() { const times = states().map(row => one(row.subscription_id).nextAt()).filter(Number.isFinite); return times.length ? Math.min(...times) : null; },
    async countDue() {
      if (running) return running;
      running = (async () => {
        const due = states().map(row => ({ id: row.subscription_id, at: one(row.subscription_id).nextAt() }))
          .filter(row => row.at !== null && row.at <= now()).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        const results = [];
        for (const row of due.slice(0, batch_size)) results.push({ subscription_id: row.id, ...await one(row.id).countDue() });
        return { counted: results.some(row => row.counted), results, remaining: Math.max(0, due.length - results.length) };
      })();
      try { return await running; } finally { running = null; }
    },
  };
}
