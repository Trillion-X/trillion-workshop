// src/usage-meters.mjs
//
// PURPOSE
//   What a paid plan includes and charges by use, read from src/usage-meters.json (the meters) and an offer row's
//   `usage` rows (which meters it charges by, and how many units come with it). One place derives every number a
//   person reads or Stripe is told: the unit price from each meter's listed base rate, the price
//   Stripe charges per counted unit, how many units are charged above what is included, and the words the plan cards,
//   the checkout note, Plan and Billing say.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No meter, offer, vendor, reading or unit is named here: each comes from a row.
//   2. A meter's price is never below its cost: the price is the cost times `margin`, rounded UP to `round_up_cents`
//      (a whole cent when absent), and a row whose cost cannot be read is refused rather than priced by a guess.
//   3. What is above the included amount is a whole number of units, never negative; a reading that cannot be read is
//      null (nothing is sent), never zero.
//   4. A usage row kept with a purchase (its pinned terms) is read through `usageRow`, so terms pinned before a meter
//      named its reading or unit size are read as the storage terms they were.
//
import settings from '../../price-and-sell-by-contract/src/usage-meters.json' with { type: 'json' };
import cloudFilesOrigins from '../../price-and-sell-by-contract/records/cloud-files-origins.json' with { type: 'json' };
import { dataRows } from './data-rows.mjs';

// The package records a meter's cost may read, by record kind: gathered when a price is first asked for, so a page that
// imports this file only for its words (a browser extension's plan title) leaves the records out of its bundle.
let costRecords = null;
const COST_RECORDS = () => {
  if (costRecords) return costRecords;
  // The storage origins' rows, under the record kind a meter names (usage-meters.json `records`).
  costRecords = new Map([['cloud-files.origin', dataRows('storage-origin', cloudFilesOrigins)]]);
  return costRecords;
};
const TAKE = { highest: values => Math.max(...values), lowest: values => Math.min(...values) };
const fill = (template, parts) => template.replace(/\{(\w+)\}/g, (_, name) => String(parts[name] ?? ''));
const at = (value, path) => path.reduce((inner, key) => (inner == null ? undefined : inner[key]), value);

/** The operator account's Workshop tool that adds counted prices to a subscription and sends each day's count. */
export const usageTool = settings.tool;
/** How many counted days each agreement keeps to draw (src/plan-usage.mjs history). */
export const historyDays = settings.history_days;
/** Every meter row. */
export const meters = () => settings.meters;

/** A meter row by id, or null. */
export const meterOf = id => settings.meters.find(meter => meter.id === id) ?? null;

/** The listed base rate of one unit of a meter in dollars (from the records it names, or its own unit_dollars) and its
 *  price in cents, rounded up from base rate x margin to the meter's own precision. Throws when a base rate cannot be read. */
export function meterPrice(meter, records = COST_RECORDS()) {
  let cost = meter.cost.unit_dollars;
  if (!Number.isFinite(cost)) {
    const values = (records.get(meter.cost.records) ?? []).map(record => Number(at(record, meter.cost.path))).filter(Number.isFinite);
    const take = TAKE[meter.cost.take];
    if (!values.length || !take) throw new Error(`${meter.id} names a cost Trillion cannot read (${meter.cost.records} ${(meter.cost.path ?? []).join('.')}).`);
    cost = take(values);
  }
  const step = meter.cost.round_up_cents ?? 1;
  // Rounded at a ten-thousandth of the step first, so floating error never adds a whole step.
  const steps = Math.ceil(Math.round(((cost * meter.cost.margin * 100) / step) * 1e4) / 1e4);
  return { cost_dollars: cost, cents_per_unit: Number((steps * step).toPrecision(12)) };
}

// Stripe takes a decimal string of at most 12 places for a unit amount in cents.
const decimalCents = value => value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');

/** A read amount of a meter as a person reads it: its shown form (money), the larger unit when it is whole, else units. */
export function amountWords(units, meter) {
  if (meter.shown) return `${meter.shown.before ?? ''}${(units * meter.shown.scale).toFixed(meter.shown.digits ?? 2)}${meter.shown.after ?? ''}`;
  const larger = meter.larger_unit;
  if (larger && units >= larger.units && units % larger.units === 0) return `${units / larger.units} ${larger.unit}`;
  return `${units.toLocaleString('en-US')} ${meter.unit}`;
}
const dollars = cents => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
const marginWords = meter => `${Number(((meter.cost.margin - 1) * 100).toFixed(8))}%`;
// A meter's listed base rate to three significant figures, so a fraction of a cent reads as it is ($0.015).
const costWords = cost => `$${Number(cost.toPrecision(3))}`;

/** A kept usage row as it is read now: terms pinned before a meter named its reading or unit size were storage terms. */
export function usageRow(row) {
  const meter = { reading: 'stored-bytes', per_unit: row.meter.unit_bytes, words: meterOf(row.meter.id)?.words, ...row.meter };
  return { ...row, meter, included_amount: row.included_amount ?? row.included_bytes ?? row.included * meter.per_unit };
}

/** An offer's usage rows, each joined with its meter (at the row's own `margin` when it names one) and price: { meter, included, included_amount, price_option_id,
 *  currency, cents_per_unit, cost_dollars, unit_amount_decimal (what the provider charges per counted unit), interval,
 *  words: { included, checkout_note } }. */
export function offerUsage(offer) {
  return (offer?.usage ?? []).map(row => {
    const named = meterOf(row.meter);
    if (!named) throw new Error(`${offer.id} charges by ${row.meter}, which src/usage-meters.json does not have.`);
    // An offer may charge its own margin on a meter (a price test of the margin): never below cost.
    if (row.margin !== undefined && !(Number.isFinite(row.margin) && row.margin >= 1)) throw new Error(`${offer.id} charges ${row.meter} at a margin below cost (${row.margin}).`);
    const meter = row.margin === undefined ? named : { ...named, cost: { ...named.cost, margin: row.margin } };
    const { cents_per_unit: cents, cost_dollars: cost } = meterPrice(meter);
    const parts = { included: amountWords(row.included, meter), price: dollars(cents), unit: meter.unit, per: meter.per, units_word: meter.units_word, margin: marginWords(meter), cost: costWords(cost) };
    // A plan that includes none says the charge plainly, at its listed base rate plus its margin.
    const included = row.included === 0 && meter.words.included_none ? meter.words.included_none : meter.words.included;
    return {
      meter, included: row.included, included_amount: row.included * meter.per_unit,
      price_option_id: row.price_option_id, currency: row.currency,
      cents_per_unit: cents, cost_dollars: cost, unit_amount_decimal: decimalCents(cents / meter.days_per), interval: meter.per,
      words: { included: fill(included, parts), checkout_note: fill(meter.words.checkout_note, parts) },
    };
  });
}

/** Whole units read above what is included, or null when the reading could not be read. */
export function unitsAbove(amount, usage) {
  if (!Number.isFinite(amount)) return null;
  const row = usageRow(usage);
  return Math.max(0, Math.floor((amount - row.included_amount) / row.meter.per_unit));
}

/** What a usage row charges for one day's `amount` read, in cents (its counted units at the provider's daily unit price). */
export function chargedCents(amount, usage) {
  const units = unitsAbove(amount, usage);
  if (units === null) return null;
  const row = usageRow(usage);
  return units * row.cents_per_unit / row.meter.days_per;
}

/** What Plan and Billing say about one usage row for an `amount` read; `counting` false says it starts at renewal. */
export function keptWords(amount, usage, counting = true) {
  if (!Number.isFinite(amount)) return null;
  const row = usageRow(usage);
  const meter = row.meter;
  const unitsKept = amount / meter.per_unit;
  const kept = meter.shown ? amountWords(unitsKept, meter)
    : unitsKept >= (meter.larger_unit?.units ?? Infinity)
      ? `${(unitsKept / meter.larger_unit.units).toFixed(2).replace(/\.?0+$/, '')} ${meter.larger_unit.unit}`
      : `${unitsKept < 10 ? unitsKept.toFixed(2).replace(/\.?0+$/, '') : Math.round(unitsKept).toLocaleString('en-US')} ${meter.unit}`;
  const over = unitsAbove(amount, row);
  const words = meter.words ?? meterOf(meter.id).words;
  const parts = { kept, over: amountWords(over, meter), included: amountWords(row.included, meter), price: dollars(row.cents_per_unit), unit: meter.unit, per: meter.per,
    margin: marginWords(meter), charged: dollars(chargedCents(amount, row) ?? 0) };
  return fill(!counting ? words.kept_until_renewal : over > 0 ? words.kept_over : words.kept, parts);
}

/** An offer as Stripe's set-up should see it: its usage rows as counted prices, and its checkout note saying them. */
export function offerWithUsage(offer, selected = null) {
  const usage = Array.isArray(selected) ? selected : offerUsage(offer);
  if (!usage.length) return offer;
  return {
    ...offer,
    checkout_note: [offer.checkout_note, ...usage.map(row => row.words.checkout_note)].filter(Boolean).join(' '),
    usage_prices: usage.map(row => ({
      id: row.price_option_id, currency: row.currency, interval: row.interval,
      unit_amount_decimal: row.unit_amount_decimal,
      meter: { event_name: row.meter.event_name, display_name: row.meter.label },
    })),
  };
}

/** A prospective exact provider price and its immutable resource-rule basis.
 * Existing usage rows are never mutated; the caller keeps the returned row with
 * the new agreement and creates a different provider price identity for it. */
export function usageAtPrice(usage, { unit_amount_decimal, pricing_terms, price_option_id }) {
  if (typeof unit_amount_decimal !== 'string' || !/^\d+(?:\.\d{1,12})?$/.test(unit_amount_decimal)
    || !(Number(unit_amount_decimal) > 0) || !/^\d+$/.test(String(pricing_terms?.markup_bps))
    || pricing_terms.resource_id !== usage.meter.id || !pricing_terms.rule_ref || !price_option_id) throw new Error('A prospective usage price needs its exact provider amount and purchased resource rule.');
  const margin = 1 + Number(pricing_terms.markup_bps) / 10000;
  const cents = Number(unit_amount_decimal) * usage.meter.days_per;
  if (!Number.isFinite(cents) || cents <= 0 || margin < 1 || cents < usage.cost_dollars * 100 - 1e-12) throw new Error('A prospective usage price cannot be below its known base rate.');
  const meter = { ...usage.meter, cost: { ...usage.meter.cost, margin } };
  const price = `$${Number((cents / 100).toFixed(12))}`;
  const parts = { included: amountWords(usage.included, meter), price, unit: meter.unit, per: meter.per,
    units_word: meter.units_word, margin: marginWords(meter), cost: costWords(usage.cost_dollars) };
  const included = usage.included === 0 && meter.words.included_none ? meter.words.included_none : meter.words.included;
  return { ...usage, meter, price_option_id, unit_amount_decimal, cents_per_unit: cents, pricing_terms: structuredClone(pricing_terms),
    words: { included: fill(included, parts), checkout_note: fill(meter.words.checkout_note, parts) } };
}

// Required native-owner API, retained from verified main.
export async function usageReadings({ day, names, storedBytes, workDollars }) {
  const readers = {
    'stored-bytes': () => storedBytes(),
    'work-cost': async () => {
      const dollars = await workDollars(day);
      if (!Number.isFinite(dollars) || dollars < 0) throw new Error('The work of that day could not be priced.');
      return Math.round(dollars * 100_000);
    },
  };
  const read = {};
  for (const name of names) {
    if (!readers[name]) throw new Error(`No reader answers the usage reading ${name}.`);
    read[name] = await readers[name]();
  }
  return read;
}

// Required current native-owner API; existing owner behavior is retained.
export const meterDayDollars = meterUse => async day => (await meterUse({ days: 8 })).days.filter(row => row.day === day)
  .reduce((sum, row) => sum + (Number.isFinite(row.dollars) ? row.dollars : 0), 0);

/**
 * What a plan charges by use reads now: the agreement of the plan itself (no allocation_offer_id) among `agreements`
 * (the `plan_usage` fact, src/plan-usage.mjs planUsageAgreements), and every reading a meter names for the day that
 * ended last (what was kept, and yesterday's work at listed rates), read with usageReadings.
 */
export async function planUsageState({ agreements, storedBytes, workDollars, now = Date.now() }) {
  const day = new Date(now - 86_400_000).toISOString().slice(0, 10);
  return { usage: agreements.find(row => !row.allocation_offer_id) ?? null, agreements, day, readings: await usageReadings({ day, names: [...new Set(meters().map(meter => meter.reading))], storedBytes, workDollars }) };
}
