// Internal platform plan-refusal producer, lifted from PersonStore at b6ae0eb.
// The complete original methods were committed as an inert baseline before this
// adaptation; ports/platform-plan-refusal.json records the exact source and limits.
//
// Suppliers belong to the canonical account owner. Request JSON cannot select
// capabilities, policy, catalogue rows or words. This composition does not authenticate,
// execute a tool, change a plan or install a native/MCP/public binding.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

export class PlanPolicyUnavailable extends Error {
  constructor(source) {
    super(`Current platform plan source is unavailable: ${source}.`);
    this.name = 'PlanPolicyUnavailable';
    this.source = source;
  }
}

const unavailable = source => { throw new PlanPolicyUnavailable(source); };

/** Trusted owner suppliers, never client input:
 * { access, decisionAllowance, fact, loadWorkshopRows, withheldFeature,
 *   withheldWords, upgradeArmFor, env? }.
 * access is the owner's synchronous current capabilities/limits snapshot.
 * withheldFeature is the existing plan-comparison predicate, not an auth result.
 */
export function platformPlanRefusalFor(owners) {
  const names = ['access', 'decisionAllowance', 'fact', 'loadWorkshopRows',
    'withheldFeature', 'withheldWords', 'upgradeArmFor'];
  if (!object(owners)) unavailable('owner suppliers');
  for (const name of names) if (typeof owners[name] !== 'function') unavailable(name);

  const readAccess = () => {
    const access = owners.access();
    if (!object(access) || !Array.isArray(access.capabilities) || !access.capabilities.every(text)
      || !object(access.limits) || !Object.values(access.limits).every(rows => Array.isArray(rows) && rows.every(object))) {
      unavailable('account.access');
    }
    return access;
  };
  const loadWorkshopRows = async env => {
    const rows = await owners.loadWorkshopRows(env);
    if (!object(rows) || !Array.isArray(rows.tools) || !Array.isArray(rows.placements)) unavailable('workshop rows');
    for (const list of [rows.tools, rows.placements]) {
      if (list.some(row => !object(row) || !text(row.id)) || new Set(list.map(row => row.id)).size !== list.length) {
        unavailable('workshop rows');
      }
    }
    if (rows.tools.some(row => row.placements != null && (!Array.isArray(row.placements) || !row.placements.every(text)))) {
      unavailable('tool placements');
    }
    return rows;
  };
  const withheldFeature = (access, path, method) => {
    const feature = owners.withheldFeature(access, path, method);
    if (feature !== null && (!object(feature) || !text(feature.id) || !text(feature.label))) unavailable('feature predicate');
    return feature;
  };
  const withheldWords = input => {
    const words = owners.withheldWords(input);
    if (!text(words)) unavailable('refusal words');
    return words;
  };
  const upgradeArmFor = (env, owner) => owners.upgradeArmFor(env, owner);

  class PlanRefusal {
    constructor() {
      // Supplier state is internal, not part of a serialized refusal body.
      Object.defineProperties(this, {
        env: { value: owners.env },
        access: { value: readAccess },
        decisionAllowance: { value: access => owners.decisionAllowance(access) },
        fact: { value: name => owners.fact(name) },
      });
    }

  // The refusal body for a request path this person's plan does not include, or null (also asked by the Worker for the
  // requests it answers itself, such as the person's files): the words an AI reads in `error`, `upgrade_needed`, and
  // the feature row it is (`{ id, label }`), so a screen names what a paid plan unlocks from that row.
  // A run of a tool whose every placement is included in every plan (placement:this-account: Trillion's own behaviors
  // in this account, which it did by itself before they were tools) is never withheld by the person's plan.
  async runsInEveryPlan(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/tools/run') return false;
    const toolId = (await request.clone().json().catch(() => ({})))?.tool_id;
    const { tools, placements } = await loadWorkshopRows(this.env);
    const tool = tools.find(row => row.id === toolId);
    const byId = new Map(placements.map(place => [place.id, place]));
    return Boolean(tool?.placements?.length) && tool.placements.every(id => byId.get(id)?.settings?.included_in_every_plan === true);
  }
  async withheld(path, origin = '', offerId = null, method = 'GET') {
    const access = this.access();
    const feature = withheldFeature(access, path, method);
    return feature ? { error: withheldWords({ feature, allowance: await this.decisionAllowance(access), origin, offerId: await this.upgradeOfferFor(offerId) }), upgrade_needed: true, feature } : null;
  }

  // The offer this person is pointed to past the free plan: the arm the Worker named for this request, else their own
  // arm of the upgrade price test read here, so every road (the app's screens, an AI, a tool run) quotes one price.
  async upgradeOfferFor(named = null) {
    if (named) return named;
    const owner = this.fact('owner_user_id');
    return owner ? upgradeArmFor(this.env, owner).catch(() => null) : null;
  }

    /** The original dispatch order: produce the plan refusal, then check the
     * every-plan placement exemption. Null answers only this plan question.
     * The account/resource authority still owns auth, reach and execution.
     */
    async refusalFor(request, { origin = '', offerId = null } = {}) {
      const withheld = await this.withheld(new URL(request.url).pathname, origin, offerId, request.method);
      if (withheld && !(await this.runsInEveryPlan(request))) return withheld;
      return null;
    }
  }
  return new PlanRefusal();
}
