// tools/paid-access/read-data/seats.mjs
//
// Contract: moved from trillion src/seats.mjs (commit 2358e13acc, its last change; the team purchase spots of
// 577450ba03 and the Space seats of 4f0144ba46 run through it). Every function keeps its old signature and behavior. What
// changed is only where its three inputs come from, so nothing here names a product: the offer rows are the person's
// (the old saleOffers()), a purchase's episodes come from effect-lifecycle.mjs currentCapabilityState with the
// person's lifecycle row (the old payment.mjs accessFrom wrapped the same fold), and the words are the person's
// (the old src/seats.json `words`, same keys). `seatsFor({ offers, lifecycle, words })` gives the functions.
//
// Seats: one purchase that pays for several people. An offer row names its seats (`seats: { grants_offer,
// keeps_for_life }`, or `allocation`, offer-allocation.mjs) and its price option the count a buyer may pick (`seats` or
// `quantity`: { minimum, maximum }). Each seat is taken by another account accepting the buyer's invitation, which
// records two effects in that account's own records: the plan the seat holds (`grants_offer`, ended when the purchase
// ends) and the offer it keeps for life (`keeps_for_life`, never ended). Every effect is the same payment effect every
// plan is judged by.
//
//   seatPurchases(effects, quantities?)             → the buyer's active purchases that sell seats: [{ episode_ref, offer, total, pending }]
//   takeSeat({ purchases, taken, buyer, taker, taker_access, episode_ref?, at }) → { seat, effects, purchase } | { refused, words }
//   ownsFirstSpot({ owner, purchases, taken, episode }) → whether a buyer's first purchase of spots gives them one at once
//   seatEndEffects({ purchase_offer, episode_ref, taken, at }) → one ending effect per seat taken on that purchase
//   seatWords(purchase, taken, link)                → the count and the copy button the buyer sees
//   singleSeatWords()                               → the seat line on a plan bought for one person
//   endsSeatPurchase(effect, effects)               → the seat purchase an ending effect ends, or null
//   tookWords(purchase), allocatedUnits, availableUnits, seatsBought, seatLinkCodeIn
//
// Pure: the caller decides nothing else. A repeated take or end gives effects with the same ids, so recording them
// again changes nothing.
import { allocationOf, explicitlyAllocated, payerUnits, quantityOf } from './offer-allocation.mjs';
import { currentCapabilityState } from './effect-lifecycle.mjs';

const fill = (template, parts) => template.replace(/\{(\w+)\}/g, (_, name) => String(parts[name] ?? ''));
const isForSale = offer => offer.for_sale !== false;

export const allocatedUnits = (purchase, taken) => payerUnits(purchase.offer)
  + taken.filter(row => row.episode_ref === purchase.episode_ref && !row.revoked_at).length;
export const availableUnits = (purchase, taken) => Number.isSafeInteger(purchase?.total)
  ? Math.max(0, purchase.total - allocatedUnits(purchase, taken)) : 0;

const grantEffect = (kind, offerId, episode, at, proof) => ({
  effect_id: `${kind === 'payment.confirmed' ? 'seat' : 'seat-ended'}:${episode}`, kind, subject: 'this-person', object: offerId,
  material: { occurred_at: at, offer_id: offerId, ...(kind === 'payment.confirmed' ? { payment_status: 'no_payment_required' } : {}), episode_ref: episode },
  proof, source_event_ids: [],
});
const seatEpisode = (purchaseEpisode, taker) => `${purchaseEpisode}:${taker}`;

/** Whether `episode`, just verified, is `owner`'s first purchase of spots and so gives them one spot of it at once: their
 *  only purchase of spots, while they hold no spot. A later purchase is for others. (The plan they may already hold is
 *  judged by takeSeat, which refuses a spot to someone the plan already covers.) */
export const ownsFirstSpot = ({ owner, purchases, taken, episode }) => {
  const own = purchases.filter(row => allocationOf(row.offer));
  return Boolean(owner) && own.length === 1 && own[0].episode_ref === episode && !own[0].pending && !taken.some(row => row.taker === owner && !row.revoked_at);
};

/** The code of the invitation that gives a spot of one purchase, made once and kept where `read`/`write` keep it. */
export async function seatLinkCodeIn({ read, write }, key = 'seat_link_code') {
  const kept = await read(key);
  if (kept) return kept;
  const code = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  await write(key, code);
  return code;
}

/** The seat functions over the person's offer rows, their lifecycle row and their words (the old src/seats.json keys). */
export function seatsFor({ offers, lifecycle, words }) {
  if (!Array.isArray(offers)) throw new Error('Seats need the offer rows.');
  if (!lifecycle || typeof lifecycle !== 'object') throw new Error('Seats need the lifecycle row that folds payment effects into purchases.');
  if (!words || typeof words !== 'object' || !words.refused) throw new Error('Seats need the words the buyer and a seat taker are told.');
  const offerOf = id => offers.find(offer => offer.id === id) ?? null;
  const episodesOf = effects => currentCapabilityState({ effects, offers, lifecycle }).episodes;
  const refusal = (reason, parts) => ({ refused: reason, words: fill(words.refused[reason], parts) });

  /** The seats one payment bought: its amount before any code over the seat price, or null when it bought none. */
  function seatsBought(effect) {
    const offer = offerOf(effect?.material?.offer_id);
    if (!allocationOf(offer) || explicitlyAllocated(offer)) return null;
    const option = (offer.price_options ?? []).find(item => item.id === effect.material.price_option_id) ?? (offer.price_options ?? []).find(item => quantityOf(item));
    const count = Number(effect.material.subtotal_cents) / option?.amount_cents;
    return Number.isSafeInteger(count) && count >= 1 ? count : null;
  }

  /** The buyer's purchases that sell seats and are still active, newest first. */
  function seatPurchases(effects, quantities = {}) {
    const byId = new Map(effects.map(effect => [effect.effect_id, effect]));
    return episodesOf(effects)
      .filter(episode => episode.state === 'active')
      .flatMap(episode => {
        const bought = episode.events.map(event => byId.get(event.effect_id)).find(effect => effect?.kind === 'payment.confirmed' && allocationOf(offerOf(effect.material?.offer_id)));
        if (!bought) return [];
        const offer = offerOf(bought.material.offer_id);
        // An explicit allocation is admitted from the provider's actual fixed item quantity,
        // never by dividing a discounted or zero-dollar trial invoice by today's price.
        const quantity = quantities[episode.episode_ref];
        const verified = quantity?.offer_id === offer.id && quantity?.source === 'provider-subscription'
          && Number.isSafeInteger(quantity.count) && quantity.count >= 1 ? quantity.count : null;
        const total = explicitlyAllocated(offer) ? verified : verified ?? seatsBought(bought);
        return total === null && !explicitlyAllocated(offer) ? [] : [{ episode_ref: episode.episode_ref, offer, total, pending: total === null, started_at: episode.started_at }];
      })
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || a.episode_ref.localeCompare(b.episode_ref));
  }

  /**
   * Whether `taker` gets a seat on the buyer's newest seat purchase, and the effects to record in the taker's records.
   * purchases: seatPurchases(buyer's effects); taken: [{ taker, episode_ref }] the buyer keeps; taker_access: the taker's
   * current access ({ active_offers, capabilities, limits }). Refused when there is no active purchase, when the taker
   * already holds everything a seat gives (the buyer, or someone paying for their own plan), or when every seat is taken.
   */
  function takeSeat({ purchases, taken, buyer, taker, taker_access: takerAccess, episode_ref: wanted, at = new Date().toISOString() }) {
    const eligible = wanted ? purchases.filter(row => row.episode_ref === wanted) : purchases;
    // Retry the original reservation first, even when another purchase has since arrived.
    const existing = taken.find(row => row.taker === taker && !row.revoked_at && eligible.some(item => item.episode_ref === row.episode_ref));
    const purchase = existing ? eligible.find(row => row.episode_ref === existing.episode_ref)
      : eligible.find(row => availableUnits(row, taken) > 0) ?? eligible[0];
    if (!purchase) return refusal('ended', {});
    if (purchase.pending) return refusal('unverified', {});
    const allocation = allocationOf(purchase.offer);
    const plan = offerOf(allocation.grants_offer);
    if (!plan) return refusal('unverified', {});
    const seat = existing ?? { taker, episode_ref: purchase.episode_ref, taken_at: at };
    const proof = { granted_by: 'seat', buyer, purchase: purchase.episode_ref };
    const effects = [grantEffect('payment.confirmed', plan.id, seatEpisode(purchase.episode_ref, taker), seat.taken_at, proof)];
    if (allocation.keeps_for_life) effects.push({ ...grantEffect('payment.confirmed', allocation.keeps_for_life, `for-life:${taker}`, seat.taken_at, proof), effect_id: `for-life:${taker}` });
    if (existing) return { seat, effects, purchase };
    const covered = (payerUnits(purchase.offer) > 0 && taker === buyer)
      || (takerAccess.active_offers ?? []).includes(plan.id)
      || ((plan.access_refs ?? []).length > 0 && plan.access_refs.every(access => (takerAccess.capabilities ?? []).includes(access) && !takerAccess.limits?.[access]));
    if (covered) return refusal('covered', { plan: plan.label });
    if (!availableUnits(purchase, taken)) return refusal('full', { total: purchase.total });
    return { seat, effects, purchase };
  }

  /** Every seat taken on one purchase, ended: the effect each taker records when the purchase ends. */
  function seatEndEffects({ purchase_offer: offerId, episode_ref: episode, taken, at = new Date().toISOString() }) {
    const plan = offerOf(allocationOf(offerOf(offerId))?.grants_offer);
    if (!plan) return [];
    return taken.filter(row => row.episode_ref === episode)
      .map(row => ({ taker: row.taker, effect: grantEffect('subscription.ended', plan.id, seatEpisode(episode, row.taker), at, { granted_by: 'seat', purchase: episode }) }));
  }

  /** Whether an effect ends a purchase that sold seats, and which: { offer_id, episode_ref } or null. */
  function endsSeatPurchase(effect, effects) {
    if (!['subscription.ended', 'payment.refunded'].includes(effect?.kind)) return null;
    const episode = episodesOf(typeof effects === 'function' ? effects() : effects).find(row => row.events.some(event => event.effect_id === effect.effect_id));
    return episode && allocationOf(offerOf(episode.offer_id)) ? { offer_id: episode.offer_id, episode_ref: episode.episode_ref } : null;
  }

  /** What the buyer sees on their seat purchase: `N of M seats taken` and the button that copies the seat link. */
  function seatWords(purchase, taken, link) {
    const used = allocatedUnits(purchase, taken);
    return {
      detail: purchase.pending ? words.pending : fill(explicitlyAllocated(purchase.offer) ? words.allocated : words.taken, { taken: used, total: purchase.total }),
      action: { label: words.copy, tone: 'primary', copy: fill(explicitlyAllocated(purchase.offer) ? words.invitation : words.copied_text, { link }) },
    };
  }

  /** The seat line on a plan bought for one person: their one seat, and the offer that sells seats while one is for sale. */
  const singleSeatWords = () => {
    const team = offers.find(offer => allocationOf(offer) && isForSale(offer));
    return team ? fill(words.single_team, { team: team.label }) : words.single;
  };

  /** What a seat taker reads once the seat is theirs. */
  const tookWords = purchase => fill(explicitlyAllocated(purchase.offer) ? words.assigned : words.took, { plan: offerOf(allocationOf(purchase.offer).grants_offer).label });

  return { seatsBought, seatPurchases, takeSeat, seatEndEffects, endsSeatPurchase, seatWords, singleSeatWords, tookWords, allocatedUnits, availableUnits, ownsFirstSpot };
}
