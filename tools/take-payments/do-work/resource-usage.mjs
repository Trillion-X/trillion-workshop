// Resource pricing and supplier settlement. Pricing, observation checking and settlement take the rows they work from
// in the request and answer their result; they keep nothing. manageUsagePricing, readResourceUsageSettlement take the
// rows the caller read from the person's own store and give back the rows to keep (`keep`, the caller writes them where
// the person keeps their records, in one transaction, and checks the version each row was read at). They never send a
// payment or turn a caller assertion into a verified provider receipt.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { validatePricingRule, resolveUsagePricing, priceUsageTree, settleResourcePool, addAmounts, subtractAmounts, compareAmounts, settlementKey, rational, exactAmount } from '../read-data/resource-usage.mjs';

export const usageRecordTypes = Object.freeze({ rule: 'usage-pricing-rule', ruleVersion: 'usage-pricing-rule-version', observation: 'resource-usage-observation', settlement: 'resource-usage-settlement', version: 'resource-usage-settlement-version', allocation: 'resource-usage-allocation', receipt: 'resource-usage-receipt' });
const sorted = x => Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(key => [key, sorted(x[key])])) : x;
const canonical = x => JSON.stringify(sorted(x));
const identity = x => makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(x)));
const word = (x, label) => { if (typeof x !== 'string' || !x.trim() || x.length > 512) throw new Error(`Give ${label} as nonempty text of at most 512 characters.`); return x; };
const recordKey = (kind, id) => `${kind}:${encodeURIComponent(word(id, 'record id'))}`;
const receiptId = key => `resource-usage-receipt:${identity(word(key, 'request_key'))}`;
function versionNumber(value) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Give expected_version as a nonnegative safe integer.'); return value; }

// The receipt of a request_key is kept by the caller (its value carries request_key): it hands back the receipt it kept as prior_receipt, and a repeat
// of the same request answers what the first one answered. The fingerprint leaves out the rows the caller reads (current,
// version_row, prior_receipt), so the same request read again later is still the same request.
function replay(input, operation) {
  const { current: _current, version_row: _version, prior_receipt: prior, ...request } = input;
  const fingerprint = identity({ operation, input: request });
  if (prior && prior.input_identity !== fingerprint) throw new Error('This request_key already belongs to different input; retain it for a retry or use a new key for new work.');
  return { id: receiptId(input.request_key), fingerprint, prior: prior ?? null };
}

/** The rows of one page: `rows` are the caller's rows in the order it lists them (newest first), `after` the record id the
 * last page ended at. Answers at most `limit` rows and the id to continue from. */
function pageOf(rows, { limit = 50, after } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('List from 1 to 100 rows per page.');
  let start = 0;
  if (after !== undefined) { const at = rows.findIndex(row => row.id === after); if (at < 0) throw new Error('The cursor is not among these rows.'); start = at + 1; }
  const page = rows.slice(start, start + limit);
  return { page, next: start + limit < rows.length ? page.at(-1).id : null };
}

/** Read or list pricing rule DATA, or save, retire or delete a rule as its next immutable version. The caller gives the
 * head row it read as `current` (null when there is none) and the version row for a read of one version as `version_row`.
 * Answers `keep`: the head row, the new version row and the receipt row, which the caller writes in one transaction only
 * while the head is still at the version it read (expected_version). Deleting a rule retires it for new purchases; already
 * purchased snapshots stay intact. */
export function manageUsagePricing(input) {
  const type = usageRecordTypes.rule;
  if (input.action === 'list') {
    if (!Array.isArray(input.rows)) throw new Error('Pass the rule rows you read from your store as rows: this tool reads no store.');
    const { page, next } = pageOf(input.rows, input);
    return { rules: page.map(row => ({ record_id: row.id, ...row.value })), next };
  }
  const id = recordKey(type, input.rule_id);
  if (input.current === undefined) throw new Error('Give current: the rule row you read for rule_id from your store, or null when there is none.');
  const current = input.current;
  if (input.action === 'read') {
    const value = input.version === undefined ? current : (input.version_row ?? null);
    return { record_id: id, rule: value };
  }
  if (!['save', 'retire', 'delete'].includes(input.action)) throw new Error('Choose pricing action read, list, save, retire or delete.');
  const receipt = replay(input, 'pricing');
  if (receipt.prior) return { ...receipt.prior.result, keep: [] };
  const version = versionNumber(input.expected_version);
  if ((current?.version ?? 0) !== version) throw new Error('The pricing rule changed; read it and use its current version.');
  if (input.action !== 'save' && current === null) throw new Error('There is no pricing rule to retire.');
  const next = version + 1;
  const rule = validatePricingRule({ ...(input.action === 'save' ? input.rule : current), id: input.rule_id, version: next,
    ...(input.action !== 'save' ? { effective_at: word(input.effective_at, 'retirement effective_at') } : {}),
    version_ref: `${id}:v${next}`, state: input.action === 'delete' ? 'deleted' : input.action === 'retire' ? 'retired' : 'active' });
  const result = { record_id: id, rule };
  return { ...result, keep: [
    { id, type, value: rule },
    { id: rule.version_ref, type: usageRecordTypes.ruleVersion, value: rule },
    { id: receipt.id, type: usageRecordTypes.receipt, value: { request_key: input.request_key, input_identity: receipt.fingerprint, result } },
  ] };
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

/** Page the allocations of a settlement the caller read: `settlement` is the settlement or version row it read (null when
 * there is none), `allocations` the rows it read, in its order (newest first). Keeps nothing. */
export function readResourceUsageSettlement(input) {
  const id = recordKey(usageRecordTypes.settlement, input.settlement_id);
  if (input.settlement === undefined) throw new Error('Give settlement: the row you read for settlement_id from your store, or null when there is none.');
  const record = input.settlement;
  if (!record) return { record_id: id, settlement: null, allocations: [], next: null };
  if (!Array.isArray(input.allocations)) throw new Error('Give allocations: the allocation rows you read for this settlement from your store.');
  if (input.after && !input.after.startsWith(record.allocation_prefix)) throw new Error('The allocation cursor is for another settlement version.');
  const rows = (input.allocations ?? []).filter(row => typeof row.id === 'string' && row.id.startsWith(record.allocation_prefix));
  const { page, next } = pageOf(rows, input);
  return { record_id: id, settlement: record, allocations: page.map(row => ({ record_id: row.id, ...row.value })), next };
}
