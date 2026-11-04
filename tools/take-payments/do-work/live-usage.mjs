// The account's own live usage rows as take-payments' usage input. The engine counts three generic quantities per
// account and keeps them as that account's own day rows (trillion-rust src/namespace/usage.rs, read through the files
// door's `usage_days` operation): stored_bytes (the level kept that day), source_bytes_read and work_ms. Nothing in
// those rows is a price. This file turns one closed day of one row into one immutable resource-usage-observation per
// billed resource (read-data/usage-meters.json, the old trillion meters ported one to one), through the existing
// keepResourceUsageObservation, so the existing pooled settlement (settleSharedResourceCost with observation_refs)
// prices them at the seller's usage-pricing-rule markup and the existing reporting sends them to Stripe.
//
// A day is observed only once it is closed (before the current UTC day), so an observation never has to change: a row
// still counting is refused, never observed twice. A row the engine has not written is no observation, never zero.
import { readFileSync } from 'node:fs';
import { keepResourceUsageObservation } from './resource-usage.mjs';
import { rational, exactAmount, divideAmounts, subtractAmounts, compareAmounts } from '../read-data/resource-usage.mjs';

const meters = JSON.parse(readFileSync(new URL('../read-data/usage-meters.json', import.meta.url), 'utf8'));
const DAY = /^\d{4}-\d\d-\d\d$/;
const MOST_DAYS = 400;

// Required native-owner API, retained from verified main.
export async function usageReadings({ day, names, storedBytes, workDollars }) {
  const readers = {
    'stored-bytes': () => storedBytes(),
    'work-cost': async () => {
      const dollars = await workDollars(day);
      if (!Number.isFinite(dollars) || dollars < 0) throw new Error('The work of that day could not be priced.');
      return dollars;
    },
  };
  const read = {};
  for (const name of names) {
    if (!readers[name]) throw new Error(`No reader answers the usage reading ${name}.`);
    read[name] = await readers[name]();
  }
  return read;
}

/** The readings of one engine day row: the older owner's readers over the row's own fields, and source-bytes. The
 * engine counts work as milliseconds of tool run time, so `workDollars` (the older owner's name) answers that count;
 * its price is the seller's rows and the supplier invoice in settlement, never the row. */
export async function liveUsageReadings({ names, row }) {
  const read = await usageReadings({ day: row.day, names: names.filter(name => name !== 'source-bytes'),
    storedBytes: () => count(row, 'stored-bytes'), workDollars: () => count(row, 'work-cost') });
  if (names.includes('source-bytes')) read['source-bytes'] = count(row, 'source-bytes');
  return read;
}

/** One reading's whole count in a day row, or null when the engine wrote none (never a guessed zero). */
function count(row, reading) {
  const raw = row?.[meters.live_readings[reading].row_field];
  if (raw === undefined || raw === null) return null;
  if (!Number.isSafeInteger(raw) || raw < 0) throw new Error(`A usage row's ${meters.live_readings[reading].row_field} is a whole count.`);
  return raw;
}

/** The settled resources and how each reads its row: { resource_id: { row_field, unit, per_unit, level } }. */
export function liveReadings() {
  const resources = meters.resource_pricing.resources.map(row => row.id);
  return Object.fromEntries(resources.map(id => {
    const reading = meters.resource_readings[id];
    const live = meters.live_readings[reading];
    if (!live) throw new Error(`The resource ${id} names no live reading.`);
    return [id, { reading, ...live }];
  }));
}

/** Every usage day row the account's files door answers, in day order. */
export async function readUsageDays(door, { after, limit = MOST_DAYS } = {}) {
  const days = []; let next = after;
  for (;;) {
    const page = await door.files('usage_days', { ...(next ? { after: next } : {}), limit });
    if (!page || !Array.isArray(page.days)) throw new Error('The files door answered no usage days.');
    days.push(...page.days);
    if (!page.next_after) return days;
    next = page.next_after;
  }
}

/** One closed day's quantity of one resource, exact, in its settled unit, or null when the row holds none. */
export async function quantityOf(row, reading) {
  const read = await liveUsageReadings({ names: [reading.reading], row });
  const raw = read[reading.reading];
  return raw === null ? null : divideAmounts(String(raw), reading.per_unit);
}

/**
 * Keep the account's closed usage days from..to as observations, one per resource per day.
 * input: { payer_id, day_from, day_to, today, settlement_keys: { [resource_id]: settlement_key },
 *          included_units?: { [resource_id]: amount per day }, request_key }
 * answers { observation_refs: { [resource_id]: [...] }, quantities: { [resource_id]: { [day]: amount } }, missing_days }.
 */
export async function observeLiveUsage(input, context) {
  const { door } = context;
  for (const name of ['day_from', 'day_to', 'today']) if (!DAY.test(input[name] ?? '')) throw new Error(`Give ${name} as YYYY-MM-DD.`);
  if (input.day_from > input.day_to) throw new Error('day_from comes on or before day_to.');
  if (input.day_to >= input.today) throw new Error('Only closed days are observed: day_to must be before today, while the engine still counts today.');
  if (typeof input.payer_id !== 'string' || !input.payer_id) throw new Error('Give the payer_id these rows belong to.');
  if (typeof input.request_key !== 'string' || !input.request_key) throw new Error('Give a request_key.');
  const readings = liveReadings();
  const keys = input.settlement_keys ?? {};
  const resources = Object.keys(readings).filter(id => keys[id]);
  if (!resources.length) throw new Error('Name a settlement_key for at least one resource.');
  const rows = (await readUsageDays(door)).filter(row => row.day >= input.day_from && row.day <= input.day_to);
  if (rows.length > MOST_DAYS) throw new Error(`Observe at most ${MOST_DAYS} days at once.`);
  const seen = new Set(rows.map(row => row.day));
  const missing_days = [];
  for (let day = new Date(`${input.day_from}T00:00:00Z`); day.toISOString().slice(0, 10) <= input.day_to; day = new Date(day.getTime() + 86400000)) {
    const name = day.toISOString().slice(0, 10); if (!seen.has(name)) missing_days.push(name);
  }
  const observation_refs = Object.fromEntries(resources.map(id => [id, []]));
  const quantities = Object.fromEntries(resources.map(id => [id, {}]));
  for (const row of rows) {
    for (const id of resources) {
      const quantity = await quantityOf(row, readings[id]);
      if (quantity === null) continue;
      const over = subtractAmounts(quantity, exactAmount(rational(input.included_units?.[id] ?? '0', 'included units')));
      const excess = compareAmounts(over, '0') > 0 ? over : { n: '0', d: '1' };
      const event_id = `live:${input.payer_id}:${id}:${row.day}`;
      const kept = await keepResourceUsageObservation({
        request_key: `${input.request_key}:${event_id}`,
        observation: {
          event_id, payer_id: input.payer_id, settlement_key: keys[id], state: 'observed',
          observed_at: row.updated_at, evidence_ref: `@namespace/usage/${row.day}#flushes=${row.flushes}`,
          source_units: quantity, delivered_units: quantity, excess_units: excess,
          unit: readings[id].unit, reading: readings[id].reading,
        },
      }, context);
      observation_refs[id].push(kept.record_id);
      quantities[id][row.day] = quantity;
    }
  }
  return { observation_refs, quantities, missing_days };
}
