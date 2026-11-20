// tools/save-and-list-my-stays/read-data/stays.mjs
//
// A person's own stay (a place they offer to host people in), checked the way the old Network checked one: saveStay,
// stayDates, stayPrice and visible in the old src/network-stays.mjs at b6ae0ebf815f. Pure: no database here.
import { STAY_RULES } from './stay-rules.mjs';

const words = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is needed.`);
  return value.trim().slice(0, max);
};
const optional = (value, max) => String(value ?? '').trim().slice(0, max);
const dateMs = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Choose a start and end date.');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('Choose valid dates.');
  return ms;
};

/** The start and end dates of a stay, and its nights (1 to 60). */
export function stayDates(start_date, end_date) {
  const start = dateMs(start_date);
  const end = dateMs(end_date);
  const nights = (end - start) / 86400000;
  if (!Number.isInteger(nights) || nights < 1 || nights > 60) throw new Error('A stay needs 1 to 60 nights.');
  return { start_date, end_date, nights };
}

/** The price of a stay: free, ask, or a per-night amount in whole cents with a three-letter currency. */
export function stayPrice(value, rules = STAY_RULES) {
  const kind = String(value?.kind ?? '');
  if (!Object.hasOwn(rules.price_kinds, kind)) throw new Error('Choose how this stay is priced.');
  if (kind !== 'per-night') return { kind, amount_cents: null, currency: null };
  const amount = Number(value?.amount_cents);
  const currency = String(value?.currency ?? rules.default_currency).toUpperCase();
  if (!Number.isInteger(amount) || amount < 1 || amount > rules.max_amount_cents) throw new Error('Choose a valid nightly price.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Choose a three-letter currency.');
  return { kind, amount_cents: amount, currency };
}

/** The checked values of one stay as they are stored: a city or area, never a street address, and the price. */
export function stayValues({ title, where, about = '', when = '', price, active = true }, rules = STAY_RULES) {
  const priced = stayPrice(price, rules);
  return {
    title: words(title, 'A stay name', rules.lengths.title),
    where_text: words(where, 'A city or area', rules.lengths.where),
    about: optional(about, rules.lengths.about),
    when_text: optional(when, rules.lengths.when),
    price_kind: priced.kind,
    amount_cents: priced.amount_cents,
    currency: priced.currency,
    active: active === true,
  };
}

/** A stay as the person sees it. */
export const visible = row => ({
  stay_id: row.id,
  title: row.title,
  where: row.where_text,
  about: row.about,
  when: row.when_text,
  price: { kind: row.price_kind, ...(row.price_kind === 'per-night' ? { amount_cents: row.amount_cents, currency: row.currency } : {}) },
  active: row.active === true || row.active === 1,
});
