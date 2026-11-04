// Allocation is separate from purchase, payer identity and the quantity chosen at checkout.
// Old offers retain their original implicit payer unit. New offers declare every grant explicitly.
import { offerRows as catalog } from './offer-rows.mjs';

export const allocationOf = offer => offer?.allocation ?? (offer?.seats ? {
  grants_offer: offer.seats.grants_offer, keeps_for_life: offer.seats.keeps_for_life, payer_units: 1,
} : null);
export const quantityOf = option => option?.quantity ?? option?.seats ?? null;
export const payerUnits = offer => allocationOf(offer)?.payer_units ?? 0;
export const explicitlyAllocated = offer => Boolean(offer?.allocation);

const hasMalformedAllocation = allocation => typeof allocation !== 'object' || Array.isArray(allocation)
  || typeof allocation.grants_offer !== 'string' || !allocation.grants_offer.trim();
const hasAllocation = offer => offer?.allocation !== undefined && offer?.allocation !== null;

function allocationGraph(offers) {
  if (!Array.isArray(offers)) throw new Error('Offer allocations require an offer catalog.');
  const byId = new Map();
  for (const offer of offers) {
    if (!offer || typeof offer.id !== 'string' || !offer.id.trim()) throw new Error('Every offer allocation target must have an offer id.');
    if (byId.has(offer.id)) throw new Error(`Offer catalog repeats ${offer.id}.`);
    byId.set(offer.id, offer);
  }
  for (const offer of offers) {
    if (!hasAllocation(offer)) continue;
    const allocation = offer.allocation;
    if (hasMalformedAllocation(allocation)) throw new Error(`${offer.id} has a malformed offer allocation.`);
    if (!byId.has(allocation.grants_offer)) throw new Error(`${offer.id} names an unavailable allocation entitlement.`);
  }
  const complete = new Set();
  const active = new Set();
  const visit = offer => {
    if (complete.has(offer.id)) return;
    if (active.has(offer.id)) throw new Error(`Offer allocations contain a cycle at ${offer.id}.`);
    active.add(offer.id);
    const target = hasAllocation(offer) && byId.get(offer.allocation.grants_offer);
    if (target) visit(target);
    active.delete(offer.id);
    complete.add(offer.id);
  };
  for (const offer of offers) visit(offer);
  return byId;
}

/** Display only: the entitlement bought for allocation, not access granted to the payer. */
export function entitlementOffer(offer, offers = catalog.records) {
  const byId = allocationGraph(offers);
  if (hasAllocation(offer)) {
    if (typeof offer.id !== 'string' || !offer.id.trim() || hasMalformedAllocation(offer.allocation)) {
      throw new Error('The offer has a malformed offer allocation.');
    }
    if (!byId.has(offer.allocation.grants_offer)) throw new Error(`${offer.id} names an unavailable allocation entitlement.`);
  }
  const seen = new Set();
  let current = offer;
  while (hasAllocation(current)) {
    if (seen.has(current.id)) throw new Error(`Offer allocations contain a cycle at ${current.id}.`);
    seen.add(current.id);
    const granted = byId.get(current.allocation.grants_offer);
    // Usage belongs to the commercial agreement, not the legacy entitlement's old pricing.
    current = { ...granted, usage: current.usage ?? [] };
  }
  return current ?? {};
}
