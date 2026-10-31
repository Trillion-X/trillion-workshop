// tools/take-payments/read-data/offer-eligibility.ts
//
// Upsell/downsell eligibility as DATA.
//
// The question "which offers should THIS account see?" is a pure function of
// three inputs, none of which this module owns:
//   1. the offer list        (commercial-offer records)
//   2. the account's held access refs (the caller
//      derives them from the buyer's payment events; that reader already
//      honors `access_granted === false`, so a refund/revocation SHRINKS the
//      held set and every eligibility decision below reverses automatically —
//      "reversible by policy" is structural, not a feature)
//   3. eligibility rules      (DATA — offer-eligibility-rule records)
//
// Rule grammar (self-describing DATA, L090 — the engine enumerates nothing):
//   { kind: 'offer-eligibility-rule', id, offer_id,
//     requires_held?: string[],   // eligible only if EVERY ref is held (upsell gate)
//     excludes_held?: string[],   // ineligible if ANY ref is held (already-owns / downsell guard)
//     when_ineligible?: 'hide' | 'show' }  // default 'hide'
//
// Composition: offers with NO rule are untouched (additive DATA — a new offer
// needs zero rules to sell). Multiple rules for one offer AND together.
// Adding an upsell path, retiring one, or changing a downsell guard is a DATA
// row edit — zero code (L063: the category "who may see which offer" is closed
// by one predicate shape over the one entitlement truth).

export type EligibilityRule = {
  id: string;
  offer_id: string;
  requires_held: string[];
  excludes_held: string[];
  when_ineligible: 'hide' | 'show';
};

export type OfferEligibilityDecision = {
  offer_id: string;
  eligible: boolean;
  rule_ids: string[];
  missing_required: string[];
  blocking_held: string[];
};

type EligibilityProjection = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function recordList(projection: EligibilityProjection): unknown[] {
  if (isRecord(projection) && Array.isArray(projection.records)) return projection.records;
  if (Array.isArray(projection)) return projection;
  return [];
}

/** Decode the eligibility rules DATA projection. Malformed rows are dropped (fail-closed to "no rule"). */
export function readOfferEligibilityRules(projection: EligibilityProjection): EligibilityRule[] {
  return recordList(projection).flatMap((record) => {
    if (!isRecord(record) || record.kind !== 'offer-eligibility-rule') return [];
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const offerId = typeof record.offer_id === 'string' ? record.offer_id.trim() : '';
    if (!id || !offerId) return [];
    return [{
      id,
      offer_id: offerId,
      requires_held: readStringArray(record.requires_held),
      excludes_held: readStringArray(record.excludes_held),
      when_ineligible: record.when_ineligible === 'show' ? 'show' as const : 'hide' as const,
    }];
  });
}

/**
 * Decide eligibility for every offer against the account's CURRENT held refs.
 * Pure and order-preserving. Offers without rules are always eligible.
 */
export function decideOfferEligibility<T extends { id: string }>(
  offers: readonly T[],
  heldRefs: readonly string[],
  rules: readonly EligibilityRule[],
): { offers: T[]; decisions: OfferEligibilityDecision[] } {
  const held = new Set(heldRefs);
  const decisions: OfferEligibilityDecision[] = [];
  const visible: T[] = [];
  for (const offer of offers) {
    const offerRules = rules.filter((rule) => rule.offer_id === offer.id);
    if (offerRules.length === 0) {
      visible.push(offer);
      continue;
    }
    const missingRequired = offerRules.flatMap((rule) => rule.requires_held.filter((ref) => !held.has(ref)));
    const blockingHeld = offerRules.flatMap((rule) => rule.excludes_held.filter((ref) => held.has(ref)));
    const eligible = missingRequired.length === 0 && blockingHeld.length === 0;
    decisions.push({
      offer_id: offer.id,
      eligible,
      rule_ids: offerRules.map((rule) => rule.id),
      missing_required: missingRequired,
      blocking_held: blockingHeld,
    });
    const hide = !eligible && offerRules.some((rule) => rule.when_ineligible === 'hide');
    if (!hide) visible.push(offer);
  }
  return { offers: visible, decisions };
}

/** One-call composition for surfaces: projection in, filtered offers out. */
export function applyOfferEligibility<T extends { id: string }>(
  offers: readonly T[],
  heldRefs: readonly string[],
  projection: EligibilityProjection,
): { offers: T[]; decisions: OfferEligibilityDecision[] } {
  return decideOfferEligibility(offers, heldRefs, readOfferEligibilityRules(projection));
}
