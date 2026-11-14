// packages/hosted-public-app/processes/offer-price-observations.mjs
//
// Purpose: give a price-discovery rule (`voluntary_amount_policy.price_discovery`,
// derived in packages/checkout/read-data/read-offers.ts) its two observed counts:
//   sales          paid checkouts for the offer, read from the payment provider
//   reached_price  distinct people who had the offer's price on screen
// and merge them into the offer records before anything reads a price.
//
// Non-negotiable invariants:
// - Sales come from the payment provider, never from a browser coming back to
//   a thank-you page: a buyer who closes the tab after paying still paid.
// - A person who reached the price is counted ONCE per offer, keyed by a salted
//   fingerprint of their network address. A visitor id alone is whatever the
//   caller sends, so a script could invent thousands of people who "saw the
//   price and left" and drive the price to its floor. The raw address is never
//   stored.
// - Counts are facts, the price is derived. Nothing here writes a price.
// - Offers without a price-discovery rule pass through untouched.
//
// The network, the clock and the disk are injected so every rule here is
// testable without any of them.

import { blake3 } from '@noble/hashes/blake3.js';

const PROVIDER_SESSIONS_URL = 'https://api.stripe.com/v1/checkout/sessions';
const PAID = new Set(['paid', 'no_payment_required']);

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Every offer id whose price options carry a price-discovery rule. */
export function offersWithPriceDiscovery(payload) {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  return records
    .filter((offer) => Array.isArray(offer?.price_options)
      && offer.price_options.some((option) => option?.voluntary_amount_policy?.price_discovery))
    .map((offer) => offer.id)
    .filter((id) => typeof id === 'string' && id);
}

/** A copy of the offer records with each rule's observed counts filled in. */
export function withObservedCounts(payload, counts) {
  if (!payload || !Array.isArray(payload.records)) return payload;
  return {
    ...payload,
    records: payload.records.map((offer) => {
      if (!Array.isArray(offer?.price_options)) return offer;
      const observed = counts.get(offer.id) ?? { sales: 0, reached_price: 0 };
      let changed = false;
      const priceOptions = offer.price_options.map((option) => {
        const rule = option?.voluntary_amount_policy?.price_discovery;
        if (!rule) return option;
        changed = true;
        const saleOfferIds = rule.sales_offer_ids === undefined ? [offer.id] : rule.sales_offer_ids;
        if (!Array.isArray(saleOfferIds) || saleOfferIds.length === 0
          || saleOfferIds.some((id) => typeof id !== 'string' || !id.trim())) {
          throw new Error('price_discovery.sales_offer_ids must name at least one offer.');
        }
        const distinctSaleOfferIds = [...new Set(saleOfferIds)];
        const sales = distinctSaleOfferIds
          .reduce((total, id) => total + (counts.get(id)?.sales ?? 0), 0);
        const ownSales = observed.sales ?? 0;
        const externalSales = distinctSaleOfferIds
          .filter((id) => id !== offer.id)
          .reduce((total, id) => total + (counts.get(id)?.sales ?? 0), 0);
        return {
          ...option,
          voluntary_amount_policy: {
            ...option.voluntary_amount_policy,
            // Sales from other offers add wins without erasing this offer's price views.
            price_discovery: { ...rule, sales, reached_price: Math.max(observed.reached_price, ownSales) + externalSales },
          },
        };
      });
      return changed ? { ...offer, price_options: priceOptions } : offer;
    }),
  };
}

/** Paid checkouts per offer id, read page by page from the provider. */
export async function countPaidCheckouts({ secret, fetchImplementation, maxPages = 50 }) {
  const counts = new Map();
  let startingAfter = null;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(PROVIDER_SESSIONS_URL);
    url.searchParams.set('limit', '100');
    url.searchParams.set('status', 'complete');
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);
    const response = await fetchImplementation(url, { headers: { Authorization: `Bearer ${secret}` } });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body?.data)) {
      throw new Error(`the payment provider did not list checkouts (${response.status})`);
    }
    for (const session of body.data) {
      const offerId = session?.metadata?.offer_id;
      if (typeof offerId !== 'string' || !offerId || !PAID.has(session?.payment_status)) continue;
      counts.set(offerId, (counts.get(offerId) ?? 0) + 1);
    }
    if (!body.has_more || body.data.length === 0) return counts;
    startingAfter = body.data[body.data.length - 1].id;
  }
  return counts;
}

/**
 * One store per process.
 * - `readPaidCounts()` asks the provider at most once per `salesRefreshMs`
 *   and keeps the last good answer when the provider cannot be reached.
 * - `recordReachedPrice()` appends one line per new (person, offer) pair.
 */
export function createOfferPriceObservations({
  file,
  saltFile,
  readText,
  appendText,
  writeText,
  randomBytes,
  providerSecret,
  fetchImplementation,
  now = () => Date.now(),
  salesRefreshMs = 60_000,
}) {
  let reached = null; // Map offerId -> Set(fingerprint)
  let salt = null;
  let paid = new Map();
  let paidReadAt = -Infinity;
  let paidInFlight = null;

  async function load() {
    if (reached) return;
    reached = new Map();
    const text = await readText(file).catch((error) => (error?.code === 'ENOENT' ? '' : Promise.reject(error)));
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row?.offer_id !== 'string' || typeof row?.person !== 'string') continue;
        if (!reached.has(row.offer_id)) reached.set(row.offer_id, new Set());
        reached.get(row.offer_id).add(row.person);
      } catch {
        // A torn last line from a crash is dropped; every whole line still counts.
      }
    }
    salt = (await readText(saltFile).catch(() => '')).trim();
    if (!salt) {
      salt = hex(randomBytes(32));
      await writeText(saltFile, `${salt}\n`);
    }
  }

  function fingerprint(address) {
    return hex(blake3(new TextEncoder().encode(`${salt}\n${address}`))).slice(0, 32);
  }

  async function recordReachedPrice({ address, offerIds, knownOfferIds }) {
    if (typeof address !== 'string' || !address) return 0;
    await load();
    const person = fingerprint(address);
    let added = 0;
    for (const offerId of new Set(offerIds)) {
      if (!knownOfferIds.includes(offerId)) continue;
      if (!reached.has(offerId)) reached.set(offerId, new Set());
      const people = reached.get(offerId);
      if (people.has(person)) continue;
      people.add(person);
      await appendText(file, `${JSON.stringify({ offer_id: offerId, person, at: new Date(now()).toISOString() })}\n`);
      added += 1;
    }
    return added;
  }

  async function readPaidCounts() {
    if (!providerSecret) return paid;
    if (now() - paidReadAt < salesRefreshMs) return paid;
    paidInFlight ??= countPaidCheckouts({ secret: providerSecret, fetchImplementation })
      .then((counts) => { paid = counts; paidReadAt = now(); return paid; })
      .catch((error) => {
        console.error('[public-entry] paid checkouts could not be counted; keeping the last count:', String(error?.message ?? error).slice(0, 160));
        return paid;
      })
      .finally(() => { paidInFlight = null; });
    return paidInFlight;
  }

  /** Forget the cached sales so the next read asks the provider (after a payment). */
  function salesMayHaveChanged() {
    paidReadAt = -Infinity;
  }

  async function counts() {
    await load();
    const sales = await readPaidCounts();
    const result = new Map();
    for (const offerId of new Set([...sales.keys(), ...reached.keys()])) {
      result.set(offerId, { sales: sales.get(offerId) ?? 0, reached_price: reached.get(offerId)?.size ?? 0 });
    }
    return result;
  }

  return { counts, recordReachedPrice, salesMayHaveChanged };
}
