// Generic contract entitlements for negotiated sales contracts.
//
// Contract terms are DATA. The interpreter deliberately knows no offer, feature,
// space, customer or provider id. It accepts the sales-contract-builder rule
// vocabulary (GrantAccess, MeterUsage, Entitlement) and the compact `limits` /
// `grants` form used by account tools.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const rows = value => Array.isArray(value) ? value.filter(object) : [];
const positive = value => Number.isSafeInteger(value) && value >= 0;

export class ContractEntitlementError extends Error {}

/** The contract's rules, including the compact entitlement form. */
export function contractRules(contract = {}) {
  if (!object(contract)) return [];
  const rules = rows(contract.rules).map(row => row.type === 'Entitlement'
    ? { ...row, resource: row.resource ?? row.item_name ?? row.key }
    : row);
  const source = object(contract.entitlements) ? contract.entitlements : contract;
  const grants = Array.isArray(source.grants ?? source.access_grants ?? source.accesses)
    ? (source.grants ?? source.access_grants ?? source.accesses).flatMap(row => object(row) ? [row] : text(row) ? [{ resource: row }] : [])
    : [];
  const limits = rows(source.limits ?? source.feature_limits ?? source.space_limits);
  const entitlementRows = rows(source.entitlements);
  return [
    ...rules,
    ...grants.map(row => ({ type: 'GrantAccess', ...row, resource: row.resource ?? row.access ?? row.key })),
    ...limits.map(row => ({ type: 'GrantAccess', ...row, resource: row.resource ?? row.access ?? row.key, usage_limit: row.usage_limit ?? row.quantity ?? row.count })),
    ...entitlementRows.map(row => ({ type: 'Entitlement', ...row, resource: row.resource ?? row.item_name ?? row.key })),
  ];
}

/** GrantAccess rows, filtered to usable resource references. */
export const accessGrants = contract => contractRules(contract).filter(row => ['GrantAccess', 'Entitlement'].includes(row.type) && text(row.resource));
export const accessGrantsFor = accessGrants;

/** Whether these are spending terms a contract may carry: a daily cap in dollars or null for none, and a billing choice. */
export const isSpendingTerms = value => object(value) && typeof value.bill_overage === 'boolean'
  && (value.daily_cap_dollars === null || Number.isFinite(value.daily_cap_dollars) && value.daily_cap_dollars >= 0);

/** The spending terms a contract names with one SpendingTerms rule ({ daily_cap_dollars: number | null, bill_overage }), or null. */
export function contractSpendingTerms(contract) {
  const named = contractRules(contract).filter(row => row.type === 'SpendingTerms');
  if (!named.length) return null;
  const terms = { daily_cap_dollars: named[0].daily_cap_dollars, bill_overage: named[0].bill_overage };
  if (named.length > 1 || !isSpendingTerms(terms)) throw new ContractEntitlementError('A contract names its spending terms once, with a daily cap in dollars (or null for none) and whether usage is billed.');
  return terms;
}

/** The terms that serve a person best when several contracts name some: no cap beats any cap, a larger cap beats a smaller, unbilled beats billed. */
export const mostGenerousSpendingTerms = list => list.filter(isSpendingTerms).reduce((best, terms) => best === null ? { ...terms } : {
  daily_cap_dollars: best.daily_cap_dollars === null || terms.daily_cap_dollars === null ? null : Math.max(best.daily_cap_dollars, terms.daily_cap_dollars),
  bill_overage: best.bill_overage && terms.bill_overage }, null);

/** A contract's bundled offer ids. `includes` remains available for direct access refs. */
export const bundledOffers = contract => accessGrants(contract)
  .flatMap(row => [row.offer_id, row.offer, row.resource].filter(value => text(value) && /^(offer|product):/.test(value)))
  .filter((id, index, all) => all.indexOf(id) === index);

/** Access refs granted directly or through supplied commercial-offer DATA rows. */
export function contractAccessRefs(contract, offers = []) {
  const byId = new Map(rows(offers).map(offer => [offer.id, offer]));
  const refs = new Set();
  for (const row of accessGrants(contract)) {
    if (text(row.resource)) {
      const offer = byId.get(row.resource);
      if (offer) {
        for (const ref of offer.access_refs ?? []) if (text(ref)) refs.add(ref);
      } else refs.add(row.resource);
    }
    for (const ref of [...(row.includes ?? []), row.access].filter(text)) refs.add(ref);
  }
  for (const row of quantityLimits(contract)) refs.add(row.resource);
  return [...refs].sort();
}

/** Every modular quantity declaration, retaining its feature/space key and period. */
export function quantityLimits(contract) {
  return contractRules(contract)
    .filter(row => ['GrantAccess', 'Entitlement', 'MeterUsage'].includes(row.type) && text(row.resource))
    .map(row => {
      const includedUnits = row.pricing_rules?.included_units ?? row.included_units;
      const quantity = positive(row.usage_limit) ? row.usage_limit
        : positive(row.quantity) ? row.quantity
          : positive(row.count) ? row.count
            : row.type === 'MeterUsage' && positive(includedUnits) ? includedUnits
              : null;
      return {
        resource: row.resource,
        quantity,
        unit: row.unit ?? row.metric ?? row.item_type ?? row.pricing_rules?.unit ?? null,
        period: row.period ?? row.per ?? null,
        condition: row.condition ?? null,
      };
    })
    .filter(row => row.quantity !== null);
}
export const featureLimits = quantityLimits;
export const spaceLimits = quantityLimits;

/** Compact grants and quantity limits for a payment record or checkout metadata. */
export function contractEntitlementSnapshot(contract, offers = []) {
  const grants = contractAccessRefs(contract, offers);
  const limits = quantityLimits(contract).map(row => ({
    key: row.resource,
    quantity: row.quantity,
    ...(row.unit ? { unit: row.unit } : {}),
    ...(row.period ? { per: row.period } : {}),
    ...(row.condition ? { condition: row.condition } : {}),
  }));
  const spending = contractSpendingTerms(contract);
  return { grants, limits, ...(spending ? { spending } : {}) };
}

/** The most generous active quantity for one feature/access. `null` means unlimited. */
export function quantityFor(contract, resource, { used = 0 } = {}) {
  if (!text(resource)) return { resource, granted: false, quantity: 0, used, remaining: 0 };
  const rowsFor = quantityLimits(contract).filter(row => row.resource === resource);
  if (!rowsFor.length) return { resource, granted: contractAccessRefs(contract).includes(resource), quantity: null, used, remaining: null };
  const quantity = Math.max(...rowsFor.map(row => row.quantity));
  return { resource, granted: true, quantity, used, remaining: Math.max(0, quantity - used), period: rowsFor.find(row => row.quantity === quantity)?.period ?? null, unit: rowsFor.find(row => row.quantity === quantity)?.unit ?? null };
}

function usageMap(contract) {
  const usage = contract?.usage ?? contract?.entitlement_usage ?? {};
  if (object(usage)) return { ...usage };
  if (Array.isArray(usage)) return Object.fromEntries(usage.filter(object).map(row => [row.resource ?? row.key, Number(row.used ?? row.quantity ?? 0)]).filter(([key]) => text(key)));
  return {};
}

/** Current usage for a resource in a contract. */
export const usageFor = (contract, resource) => Number(usageMap(contract)[resource] ?? 0);

/**
 * Consume finite contract usage atomically in memory. The returned contract is
 * a clone suitable for the account record's next write; the input is untouched.
 * Unlimited grants return a clone with no usage counter.
 */
export function consumeEntitlement(contract, resource, amount = 1) {
  if (!object(contract) || !text(resource)) throw new ContractEntitlementError('A contract and resource are required.');
  if (!positive(amount) || amount === 0) throw new ContractEntitlementError('Usage must be a whole number above zero.');
  const used = usageFor(contract, resource);
  const allowance = quantityFor(contract, resource, { used });
  if (!allowance.granted) throw new ContractEntitlementError(`The contract does not grant ${resource}.`);
  if (allowance.quantity !== null && used + amount > allowance.quantity) {
    throw new ContractEntitlementError(`The contract has ${allowance.remaining} ${allowance.unit ?? 'uses'} left for ${resource}.`);
  }
  const next = structuredClone(contract);
  const usage = usageMap(next);
  usage[resource] = used + amount;
  next.usage = usage;
  return { contract: next, resource, consumed: amount, used: used + amount, remaining: allowance.quantity === null ? null : allowance.quantity - used - amount };
}

/** A compact read model for screens and Workshop tools. */
export function entitlementSummary(contract, offers = []) {
  const accesses = contractAccessRefs(contract, offers);
  const limits = quantityLimits(contract).map(row => ({ ...row, used: usageFor(contract, row.resource), remaining: Math.max(0, row.quantity - usageFor(contract, row.resource)) }));
  return { accesses, bundled_offers: bundledOffers(contract), limits };
}
export const contractEntitlements = entitlementSummary;
