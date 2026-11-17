// Prospective service usage terms come from the seller's existing Workshop
// pricing owner. The caller binds runTool to the admitted service seller; neither
// an offer nor customer input may select that account. Existing purchases keep
// their own saved terms and do not pass through this adapter again.
import settings from './usage-meters.json' with { type: 'json' };

const DEFAULT = settings.resource_pricing.default_rule;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const checked = result => {
  if (!object(result) || result.error) throw new Error('The service usage pricing owner did not return a usable result.');
  return result;
};

/** Every pricing rule the seller's owner lists, page by page: the current rules, or with `versions` every version
 * (what pricing reads, so a retirement dated later still prices an earlier time). */
async function listPricingRules(runTool, { versions = false } = {}) {
  const rules = []; let after;
  do {
    const page = checked(await runTool('tool:manage-usage-pricing', { action: 'list', limit: 100, ...(versions ? { versions: true } : {}), ...(after ? { after } : {}) }));
    if (!Array.isArray(page.rules) || page.rules.length > 100 || (page.next != null && typeof page.next !== 'string')) throw new Error('The current default pricing rules could not be read.');
    rules.push(...page.rules);
    if (rules.length > 10000) throw new Error('Narrow the seller pricing configuration before pricing usage.');
    if (page.next === after && page.next != null) throw new Error('The pricing owner repeated its cursor.');
    after = page.next;
  } while (after);
  return rules;
}

/** Seed the declared service default once through the same public configuration
 * action the seller's editor uses. A failed read never becomes an empty rule. */
export async function ensureServiceUsagePricing(runTool) {
  if (typeof runTool !== 'function') throw new Error('Bind the admitted service seller pricing tool before selling resource usage.');
  let result = checked(await runTool('tool:manage-usage-pricing', { action: 'read', rule_id: DEFAULT.id }));
  if (!Object.hasOwn(result, 'rule')) throw new Error('The pricing owner did not prove whether the service default exists.');
  if (result.rule === null) {
    // Existing seller defaults can have another identity. Never introduce an
    // equally specific competing default or silently restore a retired one.
    const existing = (await listPricingRules(runTool)).find(rule => object(rule) && object(rule.scope) && !Object.keys(rule.scope).length);
    if (existing) return structuredClone(existing);
    result = checked(await runTool('tool:manage-usage-pricing', { action: 'save', rule_id: DEFAULT.id, expected_version: 0,
      request_key: `service-default:${DEFAULT.id}:v1`, rule: structuredClone(DEFAULT) }));
  }
  if (!object(result.rule) || result.rule.id !== DEFAULT.id || !Number.isSafeInteger(result.rule.version) || result.rule.version < 1) throw new Error('Read back the actual service default before selling usage.');
  // A retired default stays retired. It is never silently restored or replaced.
  return result.rule;
}

/** Pin a new purchase's resource rules through the seller owner. The seller's rule versions are listed once and
 * handed to the pricing tool, which resolves defaults and resource/plan/customer overrides exactly once.
 * This does not create provider prices or grant a funded allowance/reservation. */
export async function pinServiceResourceTerms({ runTool, resource_ids, plan_id, client_id, at }) {
  if (!Array.isArray(resource_ids) || !resource_ids.length || resource_ids.length > 100 || new Set(resource_ids).size !== resource_ids.length
    || resource_ids.some(id => typeof id !== 'string' || !id || id.length > 512)) throw new Error('Name from 1 to 100 distinct resource identities for the new purchase.');
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new Error('Pin the actual purchase time before resolving its prices.');
  await ensureServiceUsagePricing(runTool);
  const rules = await listPricingRules(runTool, { versions: true });
  const terms = [];
  for (const resource_id of resource_ids) {
    const answer = checked(await runTool('tool:price-resource-usage', { rules, at, resource_id, ...(plan_id ? { plan_id } : {}), ...(client_id ? { client_id } : {}) }));
    const term = answer.terms;
    if (!object(term) || term.resource_id !== resource_id || typeof term.rule_ref !== 'string' || !term.rule_ref
      || typeof term.markup_bps !== 'string' || !/^\d+$/.test(term.markup_bps)) throw new Error('The pricing owner did not return this resource\'s exact purchased rule.');
    const resource = settings.resource_pricing.resources.find(row => row.id === resource_id);
    // Retail inclusion is an explicit purchased promise, separate from B2's
    // supplier credit and from the protected funding capture. Zero inclusion
    // cannot be mistaken for a free financial authorization.
    terms.push({ ...structuredClone(term), ...(resource?.default_included_units !== undefined
      ? { allowance: { included_units: resource.default_included_units, unit: resource.unit, funding_ref: null } } : {}) });
  }
  return terms;
}

/** Declared resource identities are DATA, including physical source reads used by
 * byte streaming. A new resource can also be passed directly to the pin action. */
export const serviceUsageResources = () => structuredClone(settings.resource_pricing.resources);
