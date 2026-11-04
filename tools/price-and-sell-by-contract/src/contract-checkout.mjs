// Turn every payable line in a saved sales contract into one Checkout offer.
// Checkout cannot represent every builder rule. Refuse those terms before sharing
// instead of silently charging for only the first commitment.
import { contractEntitlementSnapshot } from './contract-entitlements.mjs';

const intervalFor = rule => ({
  weekly: ['week', 1], bi_weekly: ['week', 2], monthly: ['month', 1],
  quarterly: ['month', 3], yearly: ['year', 1],
  custom: rule.metadata?.custom_interval_unit === 'quarter'
    ? ['month', Number(rule.metadata?.custom_interval ?? 1) * 3]
    : [rule.metadata?.custom_interval_unit, Number(rule.metadata?.custom_interval ?? 1)],
})[rule.recurrence];
const humanLabel = value => String(value ?? 'Included access').replace(/^[^:]+:/, '').replace(/[-_]/g, ' ');

// A deal that asks for no money: every payment line is zero. It is agreed by signing its link, with no checkout.
export function isFreeDeal(saved) {
  const contract = saved?.contract ?? {};
  const commitments = (Array.isArray(contract.rules) ? contract.rules : []).filter(row => row?.type === 'Commitment');
  return commitments.length > 0 && Number(contract.total_amount ?? 0) === 0
    && commitments.every(row => Number(row.amount ?? row.total_amount ?? 0) === 0);
}

// The offer a deal gives access to: the one it names, else the catalogue offer its agreed terms came from.
export function dealOfferId(contract = {}) {
  const source = (contract.agreement_terms?.known_terms ?? []).find(row => typeof row?.source === 'string' && row.source.startsWith('offer:'))?.source;
  return typeof contract.entitlement_offer_id === 'string' ? contract.entitlement_offer_id : source ?? 'offer:custom-contract';
}

export function checkoutFromSalesContract(saved) {
  const contract = saved?.contract ?? {};
  const rules = Array.isArray(contract.rules) ? contract.rules : [];
  const commitments = rules.filter(row => row?.type === 'Commitment');
  if (!commitments.length) throw new Error('Add the payment terms you agreed with the customer before creating a checkout link.');
  if (rules.some(row => ['Royalty', 'TransactionFee'].includes(row?.type))) {
    throw new Error('Resolve royalties and transaction fees into simple payment lines before creating a checkout link.');
  }
  if (rules.some(row => row?.type === 'GrantAccess' && Array.isArray(row.constraint_rules) && row.constraint_rules.length)) {
    throw new Error('Remove access conditions that Checkout cannot enforce before creating a checkout link.');
  }
  if (rules.some(row => row?.type === 'GrantAccess' && (row.condition === 'time_limited' || row.duration_amount))) {
    throw new Error('Resolve time-limited access before creating a checkout link.');
  }
  if (rules.some(row => row?.type === 'Entitlement' && row.transferable)) {
    throw new Error('Resolve transferable entitlements before creating a checkout link.');
  }
  if (rules.some(row => row?.type === 'MeterUsage' && (Number(row.pricing_rules?.per_unit_cents ?? 0) > 0 || row.pricing_rules?.tiers?.length))) {
    throw new Error('Resolve metered charges into simple payment lines before creating a checkout link.');
  }
  const lines = commitments.map(row => {
    if (row.metadata?.payment_structure !== 'simple') throw new Error('Choose simple payment terms for every payment line before creating a checkout link.');
    if (Number(row.metadata?.grace_period_days ?? 0) > 0 || Number(row.metadata?.late_fee_cents ?? 0) > 0) {
      throw new Error('Resolve grace periods and late fees before creating a checkout link.');
    }
    const amount = Number(row.amount ?? row.total_amount);
    const billingCycles = row.metadata?.billing_cycles ?? null;
    if (billingCycles !== null && (!Number.isSafeInteger(billingCycles) || billingCycles < 1 || row.recurrence === 'one_time')) {
      throw new Error('The number of payments must be a whole number above zero on a recurring payment line.');
    }
    const lineTotal = amount * (billingCycles ?? 1);
    if (!Number.isSafeInteger(lineTotal)) throw new Error('The full payment amount is too large.');
    if (row.total_amount !== undefined && row.total_amount !== lineTotal) throw new Error('Make the payment line amount match its total before creating a checkout link.');
    const currency = String(row.currency ?? contract.currency ?? '').toLowerCase();
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Each payment line needs a whole amount in cents above zero.');
    if (!/^[a-z]{3}$/.test(currency)) throw new Error('Each payment line needs a three-letter currency.');
    const recurring = row.recurrence !== 'one_time';
    const interval = recurring ? intervalFor(row) : null;
    if (recurring && (!interval || !['day', 'week', 'month', 'year'].includes(interval[0]) || !Number.isSafeInteger(interval[1]) || interval[1] < 1)) {
      throw new Error('Choose a recurring interval Stripe can bill for every payment line.');
    }
    // Free days first are carried to checkout, never dropped: a repeating line starts its subscription with them; a
    // line paid once cannot, so it is refused instead of silently charging at once.
    const trialDays = Number(row.metadata?.trial_period_days ?? 0);
    if (trialDays !== 0 && (!Number.isSafeInteger(trialDays) || trialDays < 0)) throw new Error('Free days first must be a whole number of days.');
    if (trialDays > 0 && !recurring) throw new Error('Free days first need a payment that repeats; remove them or make the payment repeat.');
    return {
      label: String(row.label ?? saved.name), amount_cents: amount, currency,
      payment_timing: recurring ? 'subscription' : 'one_time',
      billing_cycles: billingCycles,
      ...(recurring ? { interval: interval[0], interval_count: interval[1] } : {}),
      trial_days: trialDays,
    };
  });
  const first = lines[0];
  if (lines.some(row => row.currency !== first.currency || row.payment_timing !== first.payment_timing || row.interval !== first.interval || row.interval_count !== first.interval_count || row.billing_cycles !== first.billing_cycles || row.trial_days !== first.trial_days)) {
    throw new Error('Use one currency and one payment schedule for this checkout.');
  }
  const amount = lines.reduce((sum, row) => sum + row.amount_cents, 0);
  if (!Number.isSafeInteger(amount)) throw new Error('The total payment amount is too large.');
  const totalContractAmount = amount * (first.billing_cycles ?? 1);
  if (!Number.isSafeInteger(totalContractAmount)) throw new Error('The full payment amount is too large.');
  if (contract.total_amount !== undefined && contract.total_amount !== totalContractAmount) {
    throw new Error('Make the contract total match its payment lines before creating a checkout link.');
  }
  const terms = {
    label: String(saved.name ?? contract.name), amount_cents: amount, currency: first.currency,
    payment_timing: first.payment_timing,
    ...(first.payment_timing === 'subscription' ? { interval: first.interval, interval_count: first.interval_count } : {}),
    ...(first.billing_cycles ? { billing_cycles: first.billing_cycles, total_contract_amount_cents: totalContractAmount } : {}),
    ...(first.trial_days > 0 ? { trial_days: first.trial_days } : {}),
    line_items: lines.map(({ label, amount_cents }) => ({ label, amount_cents })),
    included: rules.filter(row => ['GrantAccess', 'Entitlement', 'MeterUsage'].includes(row?.type)).map(row => ({
      label: humanLabel(row.label ?? row.item_name ?? row.resource),
      ...(row.type === 'Entitlement' && Number.isSafeInteger(row.quantity) ? { quantity: row.quantity } : {}),
      ...(row.type === 'MeterUsage' && Number.isSafeInteger(row.pricing_rules?.included_units) ? { quantity: row.pricing_rules.included_units } : {}),
      ...(row.type === 'MeterUsage' && row.metric ? { unit: String(row.metric) } : {}),
      ...(row.type === 'MeterUsage' && row.period ? { per: String(row.period) } : {}),
    })),
  };
  const promotionCodeId = contract.checkout?.promotion_code_id;
  if (promotionCodeId !== undefined && !/^promo_[A-Za-z0-9]+$/.test(promotionCodeId)) {
    throw new Error('Choose a Stripe promotion code for the discount before sharing this contract.');
  }
  if (promotionCodeId && contract.checkout?.allow_promotion_codes === true) {
    throw new Error('Choose either a saved discount or buyer-entered promotion codes for this checkout.');
  }
  return {
    terms, entitlements: contractEntitlementSnapshot(contract),
    allowPromotionCodes: contract.checkout?.allow_promotion_codes === true,
    ...(promotionCodeId ? { promotionCodeId } : {}),
  };
}
