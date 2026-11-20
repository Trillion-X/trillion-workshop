// The negotiated offer a deal's link pays through: the price the seller agreed (whole cents above zero), the checkout
// terms, the return addresses, the funnel, and when it ends. Port of createNegotiatedOfferForShare in the old native
// commercial owner (src/native-commercial-domain.mjs at 3b7063d6f3). Storage-free: the caller reads the link, the saved
// deal and its checkout terms, and creates the offer from the request this returns.
import data from './negotiated-offer-per-deal.json' with { type: 'json' };

/**
 * code: the share code; grant: { share_id, expires_at? } of the link; recordId: the link's record id; saved: the saved
 * deal; checkout: { terms, entitlements, allowPromotionCodes, promotionCodeId } from its checkout terms;
 * entitlementOfferId: the offer the deal gives access to; origin: the address the deal was opened from;
 * amount_cents: the price a price test or the seller gave, or null to keep the deal's own terms.
 */
export function negotiatedOfferRequest({ code, grant, recordId, saved, checkout, entitlementOfferId, origin, amount_cents: amountCents = null }) {
  if (!recordId.startsWith(data.contract_prefix)) throw new Error(data.messages.not_a_contract);
  const contract = saved.contract ?? {};
  const { entitlements, allowPromotionCodes, promotionCodeId } = checkout;
  if (amountCents !== null && (!Number.isSafeInteger(amountCents) || amountCents < 1)) throw new Error(data.messages.amount);
  const terms = amountCents === null
    ? checkout.terms
    : { ...checkout.terms, amount_cents: amountCents, line_items: [{ label: checkout.terms.label, amount_cents: amountCents }] };
  const prefix = String(origin ?? '').replace(/\/+$/, '');
  if (!URL.canParse(prefix) || new URL(prefix).protocol !== 'https:') throw new Error(data.messages.secure_origin);
  const route = `${prefix}${data.route_prefix}${encodeURIComponent(code)}`;
  return {
    contract_id: recordId,
    entitlement_offer_id: entitlementOfferId,
    share_id: grant.share_id,
    ...(typeof contract.funnel_id === 'string' ? { funnel_id: contract.funnel_id } : {}),
    entitlements: entitlements.grants.length || entitlements.limits.length ? entitlements : undefined,
    terms,
    checkout: {
      success_url: `${route}${data.paid_query}`,
      cancel_url: route,
      ...(allowPromotionCodes ? { allow_promotion_codes: true } : {}),
      ...(promotionCodeId ? { promotion_code_id: promotionCodeId } : {}),
    },
    ...(typeof grant.expires_at === 'string' ? { expires_at: grant.expires_at } : {}),
  };
}
