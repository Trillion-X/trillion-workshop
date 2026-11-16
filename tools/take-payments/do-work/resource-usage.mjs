// Resource pricing and supplier settlement. Only manageUsagePricing and
// readResourceUsageSettlement touch rows through the records door (they are the
// create/read/update/delete of pricing rules and a stored settlement). Pricing,
// observation checking and settlement take the rows they work from in the
// request and answer their result; they keep nothing. They never send a payment
// or turn a caller assertion into a verified provider receipt.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { validatePricingRule, resolveUsagePricing, priceUsageTree, settleResourcePool, addAmounts, subtractAmounts, compareAmounts, settlementKey, rational, exactAmount } from '../read-data/resource-usage.mjs';

export const usageRecordTypes = Object.freeze({ rule: 'usage-pricing-rule', ruleVersion: 'usage-pricing-rule-version', observation: 'resource-usage-observation', settlement: 'resource-usage-settlement', version: 'resource-usage-settlement-version', allocation: 'resource-usage-allocation', receipt: 'resource-usage-receipt' });
const sorted = x => Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(key => [key, sorted(x[key])])) : x;
const canonical = x => JSON.stringify(sorted(x));
const identity = x => makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(x)));
const word = (x, label) => { if (typeof x !== 'string' || !x.trim() || x.length > 512) throw new Error(`Give ${label} as nonempty text of at most 512 characters.`); return x; };
const expected = (type, value) => value === null ? null : { type, value };
const recordKey = (kind, id) => `${kind}:${encodeURIComponent(word(id, 'record id'))}`;
const receiptId = key => `resource-usage-receipt:${identity(word(key, 'request_key'))}`;
function versionNumber(value) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Give expected_version as a nonnegative safe integer.'); return value; }

async function replay(door, input, operation) {
  const id = receiptId(input.request_key); const prior = await door.read(usageRecordTypes.receipt, id); const fingerprint = identity({ operation, input });
  if (prior && prior.input_identity !== fingerprint) throw new Error('This request_key already belongs to different input; retain it for a retry or use a new key for new work.');
  return { id, fingerprint, prior };
}
async function commit(door, receipt, result, writes) {
  const value = { input_identity: receipt.fingerprint, result };
  await door.write([...writes, { id: receipt.id, type: usageRecordTypes.receipt, value, expected: null }], { key: receipt.id });
  const kept = await door.read(usageRecordTypes.receipt, receipt.id);
  if (kept?.input_identity !== receipt.fingerprint) throw new Error('The pricing result was not read back; retry the same request_key.');
  return kept.result;
}

/** Read/list current rule DATA (or, with versions, every immutable version, the
 * rules price-resource-usage prices from), or append a new immutable version.
 * Deleting a rule retires it for new purchases; already purchased snapshots stay intact. */
export async function manageUsagePricing(input, { door }) {
  const type = usageRecordTypes.rule;
  if (input.action === 'list') {
    const limit = input.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('List from 1 to 100 pricing rules.');
    const rules = []; let next = null;
    for await (const record of door.list({ type: input.versions ? usageRecordTypes.ruleVersion : type, reverse: true, ...(input.after ? { below: input.after } : {}) })) {
      if (rules.length === limit) { next = rules.at(-1).record_id; break; }
      rules.push({ record_id: record.id, ...record.value });
    }
    return { rules, next };
  }
  const id = recordKey(type, input.rule_id); const current = await door.read(type, id);
  if (input.action === 'read') {
    const value = input.version === undefined ? current : await door.read(usageRecordTypes.ruleVersion, `${id}:v${versionNumber(input.version)}`);
    return { record_id: id, rule: value };
  }
  if (!['save', 'retire', 'delete'].includes(input.action)) throw new Error('Choose pricing action read, list, save, retire or delete.');
  const receipt = await replay(door, input, 'pricing'); if (receipt.prior) return receipt.prior.result;
  const version = versionNumber(input.expected_version);
  if ((current?.version ?? 0) !== version) throw new Error('The pricing rule changed; read it and use its current version.');
  if (input.action !== 'save' && current === null) throw new Error('There is no pricing rule to retire.');
  const next = version + 1;
  const rule = validatePricingRule({ ...(input.action === 'save' ? input.rule : current), id: input.rule_id, version: next,
    ...(input.action !== 'save' ? { effective_at: word(input.effective_at, 'retirement effective_at') } : {}),
    version_ref: `${id}:v${next}`, state: input.action === 'delete' ? 'deleted' : input.action === 'retire' ? 'retired' : 'active' });
  const result = { record_id: id, rule };
  return commit(door, receipt, result, [
    { id, type, value: rule, expected: expected(type, current) },
    { id: rule.version_ref, type: usageRecordTypes.ruleVersion, value: rule, expected: null },
  ]);
}

/** Price from the rules handed in: `rules` is the seller's pricing rule versions
 * (as manage-usage-pricing lists them), or pinned_terms alone for a purchased
 * snapshot. A purchased snapshot is never repriced from current rules. Nothing
 * here reads rows, attaches a Stripe price or changes a subscription. */
export function priceResourceUsage(input) {
  const rules = input.rules ?? [];
  if (input.tree) return { tree: priceUsageTree({ ...input, rules }) };
  return { terms: resolveUsagePricing({ ...input, rules }) };
}

export const observationId = eventId => recordKey(usageRecordTypes.observation, eventId);

/** One attributed physical observation, checked and made exact. */
function checkedObservation(raw) {
  const observation = structuredClone(raw ?? {});
  word(observation.event_id, 'event_id'); word(observation.payer_id, 'payer_id'); word(observation.evidence_ref, 'observation evidence_ref');
  observation.settlement_key = settlementKey(observation.settlement_key);
  if (!['observed', 'unknown'].includes(observation.state)) throw new Error('An observation state is observed or unknown.');
  if (!Number.isFinite(Date.parse(observation.observed_at))) throw new Error('Give observed_at as an ISO date/time.');
  for (const field of ['source_units', 'delivered_units', 'excess_units']) {
    if (observation.state === 'observed') observation[field] = exactAmount(rational(observation[field], field));
    else if (observation[field] !== undefined) throw new Error('Unknown observation amounts stay unknown, never zero.');
  }
  if (observation.state === 'observed' && compareAmounts(observation.excess_units, observation.source_units) > 0) throw new Error('Excess source units cannot exceed observed source units.');
  return observation;
}

/** Check one physical observation and answer it exact. A correction is a new
 * event with its own identity and a `supersedes` reference; give the earlier
 * observation as `supersedes_observation` so the same payer and supplier scope
 * can be proved. The caller keeps the answer wherever it keeps its history. */
export function keepResourceUsageObservation(input) {
  const observation = checkedObservation(input.observation);
  if (observation.supersedes) {
    const prior = input.supersedes_observation ? checkedObservation(input.supersedes_observation) : null;
    if (!prior || observationId(prior.event_id) !== observation.supersedes || prior.payer_id !== observation.payer_id || canonical(prior.settlement_key) !== canonical(observation.settlement_key)) throw new Error('A correction must give the earlier observation it supersedes, for the same payer and supplier scope.');
  }
  return { record_id: observationId(observation.event_id), observation };
}

function adoptObservations(input) {
  // Input amounts are seller-adopted snapshots. When observations are given,
  // aggregate those exact source attempts once, not delivery/cache bytes.
  if (input.observations === undefined) return input;
  if (!Array.isArray(input.observations) || input.observations.length > 10000) throw new Error('Give at most 10000 observations.');
  const observations = input.observations.map(raw => { const value = checkedObservation(raw); return { id: observationId(value.event_id), value }; });
  if (new Set(observations.map(row => row.id)).size !== observations.length) throw new Error('Give distinct observations.');
  const scope = canonical(settlementKey(input.settlement_key));
  for (const { value } of observations) if (canonical(value.settlement_key) !== scope) throw new Error('Do not reconcile observations from independent supplier scopes together.');
  const byPayer = new Map((input.payers ?? []).map(row => [row.payer_id, { ...row, excess_units: { n: '0', d: '1' } }]));
  const superseded = new Set(observations.map(row => row.value.supersedes).filter(Boolean));
  for (const { id, value } of observations) {
    if (superseded.has(id)) continue;
    if (value.state !== 'observed') throw new Error('Every current source observation must be measured before final settlement.');
    const payer = byPayer.get(value.payer_id); if (!payer) throw new Error('Every observed source attempt needs its attributed payer terms.');
    payer.excess_units = addAmounts(payer.excess_units, value.excess_units);
  }
  return { ...input, payers: [...byPayer.values()], observation_ids: observations.map(row => row.id) };
}

function previousSettlement(input) {
  const previous = input.previous;
  if (!previous?.settlement || !Array.isArray(previous.allocations) || previous.settlement.id !== input.settlement_id || !Number.isSafeInteger(previous.settlement.version) || previous.settlement.version < 1) throw new Error('Give previous, the settlement and allocations this settlement_id last answered, to correct them.');
  return previous;
}

function settle(input, correction) {
  const id = recordKey(usageRecordTypes.settlement, input.settlement_id);
  const previous = correction ? previousSettlement(input) : null;
  const adopted = adoptObservations(input); const calculated = settleResourcePool(adopted);
  if (previous && canonical(previous.settlement.result.settlement_key) !== canonical(calculated.settlement_key)) throw new Error('A correction cannot move costs into another supplier settlement scope.');
  const priorAllocations = previous ? previous.allocations.filter(row => row.kind !== 'removed') : [];
  const deltas = previous ? calculated.allocations.map(row => {
    const prior = priorAllocations.find(item => item.payer_id === row.payer_id);
    if (prior && (canonical(prior.terms ?? null) !== canonical(row.terms ?? null) || canonical(prior.limits ?? null) !== canonical(row.limits ?? null))) throw new Error('A correction must preserve the original purchased terms and authorized ceilings.');
    const before = prior?.charged ?? '0';
    return { payer_id: row.payer_id, amount: subtractAmounts(row.charged, before), action: compareAmounts(row.charged, before) < 0 ? 'refund_or_credit_required' : compareAmounts(row.charged, before) > 0 ? 'additional_collection_requires_original_authority' : 'unchanged' };
  }) : [];
  if (previous) for (const prior of priorAllocations.filter(row => !calculated.allocations.some(next => next.payer_id === row.payer_id))) {
    deltas.push({ payer_id: prior.payer_id, amount: subtractAmounts('0', prior.charged), action: 'refund_or_credit_required' });
  }
  const version = (previous?.settlement.version ?? 0) + 1;
  const allocations = calculated.allocations.map(row => ({ ...row, ...(deltas.find(delta => delta.payer_id === row.payer_id) ? { delta: deltas.find(delta => delta.payer_id === row.payer_id) } : {}) }));
  for (const delta of deltas.filter(delta => !calculated.allocations.some(row => row.payer_id === delta.payer_id))) allocations.push({ payer_id: delta.payer_id, kind: 'removed', delta });
  const { allocations: _allocations, ...summary } = calculated;
  const refs = adopted.observation_ids ?? [];
  const settlement = { id: input.settlement_id, version, version_ref: `${id}:v${version}`, ...(previous ? { supersedes: previous.settlement.version_ref, reason: word(input.reason, 'correction reason') } : {}),
    result: summary, allocation_count: allocations.length, observation_count: refs.length, observation_identity: identity(refs), input_identity: identity(adopted), collection_state: 'not_sent_to_payment_provider' };
  return { record_id: id, settlement, allocations };
}
/** Allocate one confirmed supplier invoice among its attributed payers and answer the settlement with every allocation. */
export const settleSharedResourceCost = input => settle(input, false);
/** Answer the next version of a settlement, with the refund, credit or extra-authority delta each payer owes against `previous`. */
export const correctResourceUsageSettlement = input => settle(input, true);
export async function readResourceUsageSettlement(input, { door }) {
  const id = recordKey(usageRecordTypes.settlement, input.settlement_id);
  const record = input.version === undefined ? await door.read(usageRecordTypes.settlement, id) : await door.read(usageRecordTypes.version, `${id}:v${versionNumber(input.version)}`);
  if (!record) return { record_id: id, settlement: null, allocations: [], next: null };
  const limit = input.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Read from 1 to 100 settlement allocations per page.');
  if (input.after && !input.after.startsWith(record.allocation_prefix)) throw new Error('The allocation cursor is for another settlement version.');
  const allocations = []; let next = null;
  for await (const row of door.list({ type: usageRecordTypes.allocation, prefix: record.allocation_prefix, reverse: true, ...(input.after ? { below: input.after } : {}) })) {
    if (allocations.length === limit) { next = allocations.at(-1).record_id; break; }
    allocations.push({ record_id: row.id, ...row.value });
  }
  return { record_id: id, settlement: record, allocations, next };
}
