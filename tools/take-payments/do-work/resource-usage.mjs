// Records-backed resource pricing and supplier settlement. These functions use
// the same records door as take-payments. They never send a payment or turn a
// caller assertion into a verified provider receipt. The caller is the seller's
// authorized run; a customer's display receives only its projected allocations.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { validatePricingRule, resolveUsagePricing, priceUsageTree, settleResourcePool, addAmounts, subtractAmounts, compareAmounts, settlementKey, rational, exactAmount } from '../read-data/resource-usage.mjs';

export const usageRecordTypes = Object.freeze({ rule: 'usage-pricing-rule', ruleVersion: 'usage-pricing-rule-version', observation: 'resource-usage-observation', settlement: 'resource-usage-settlement', version: 'resource-usage-settlement-version', allocation: 'resource-usage-allocation', evidence: 'resource-usage-settlement-evidence', receipt: 'resource-usage-receipt' });
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

/** Read/list current rule DATA, or append a new immutable version. Deleting a
 * rule retires it for new purchases; already purchased snapshots stay intact. */
export async function manageUsagePricing(input, { door }) {
  const type = usageRecordTypes.rule;
  if (input.action === 'list') {
    const limit = input.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('List from 1 to 100 pricing rules.');
    const rules = []; let next = null;
    for await (const record of door.list({ type, reverse: false, ...(input.after ? { above: input.after } : {}) })) {
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

/** A calculation can take explicit rules, or read the seller's current rules.
 * Purchased snapshots override current rules. Nothing here attaches a Stripe
 * price or changes an existing subscription. */
export async function priceResourceUsage(input, context) {
  let rules = input.rules;
  if (!rules) { rules = []; for await (const row of context.door.list({ type: usageRecordTypes.ruleVersion })) { if (rules.length >= 10000) throw new Error('Narrow this pricing rule set before pricing usage.'); rules.push(row.value); } }
  if (input.tree) return { tree: priceUsageTree({ ...input, rules }) };
  return { terms: resolveUsagePricing({ ...input, rules }) };
}

/** Immutable physical observations. A correction is a new event with its own
 * identity and supersedes reference, never a rewrite of measured history. */
export async function keepResourceUsageObservation(input, { door }) {
  const receipt = await replay(door, input, 'observation'); if (receipt.prior) return receipt.prior.result;
  const observation = structuredClone(input.observation ?? {});
  word(observation.event_id, 'event_id'); word(observation.payer_id, 'payer_id'); word(observation.evidence_ref, 'observation evidence_ref');
  observation.settlement_key = settlementKey(observation.settlement_key);
  if (!['observed', 'unknown'].includes(observation.state)) throw new Error('An observation state is observed or unknown.');
  if (!Number.isFinite(Date.parse(observation.observed_at))) throw new Error('Give observed_at as an ISO date/time.');
  for (const field of ['source_units', 'delivered_units', 'excess_units']) {
    if (observation.state === 'observed') observation[field] = exactAmount(rational(observation[field], field));
    else if (observation[field] !== undefined) throw new Error('Unknown observation amounts stay unknown, never zero.');
  }
  if (observation.state === 'observed' && compareAmounts(observation.excess_units, observation.source_units) > 0) throw new Error('Excess source units cannot exceed observed source units.');
  const id = recordKey(usageRecordTypes.observation, observation.event_id);
  const old = await door.read(usageRecordTypes.observation, id);
  if (old && canonical(old) !== canonical(observation)) throw new Error('That observation is immutable; keep a new correcting event with supersedes.');
  if (observation.supersedes) {
    const prior = await door.read(usageRecordTypes.observation, observation.supersedes);
    if (!prior || prior.payer_id !== observation.payer_id || canonical(prior.settlement_key) !== canonical(observation.settlement_key)) throw new Error('A correction must point to the same payer and supplier scope.');
  }
  return commit(door, receipt, { record_id: id, observation }, old ? [] : [{ id, type: usageRecordTypes.observation, value: observation, expected: null }]);
}

async function observedInput(input, door) {
  // Input amounts are seller-adopted snapshots. When observation refs are given,
  // aggregate those exact immutable source attempts once, not delivery/cache bytes.
  if (!input.observation_refs) return input;
  if (!Array.isArray(input.observation_refs) || input.observation_refs.length > 10000 || new Set(input.observation_refs).size !== input.observation_refs.length) throw new Error('Give distinct observation_refs, at most 10000.');
  const byPayer = new Map((input.payers ?? []).map(row => [row.payer_id, { ...row, excess_units: { n: '0', d: '1' } }]));
  const observations = [];
  for (const id of input.observation_refs) {
    const value = await door.read(usageRecordTypes.observation, word(id, 'observation_ref'));
    if (!value) throw new Error('Every source observation must be present before final settlement.');
    if (canonical(value.settlement_key) !== canonical(settlementKey(input.settlement_key))) throw new Error('Do not reconcile observations from independent supplier scopes together.');
    observations.push({ id, value });
  }
  const superseded = new Set(observations.map(row => row.value.supersedes).filter(Boolean));
  for (const { id, value } of observations) {
    if (superseded.has(id)) continue;
    if (value.state !== 'observed') throw new Error('Every current source observation must be measured before final settlement.');
    const payer = byPayer.get(value.payer_id); if (!payer) throw new Error('Every observed source attempt needs its attributed payer terms.');
    payer.excess_units = addAmounts(payer.excess_units, value.excess_units);
  }
  return { ...input, payers: [...byPayer.values()] };
}

async function settle(input, { door }, correction) {
  const receipt = await replay(door, input, correction ? 'correction' : 'settlement'); if (receipt.prior) return receipt.prior.result;
  const id = recordKey(usageRecordTypes.settlement, input.settlement_id); const current = await door.read(usageRecordTypes.settlement, id);
  if (!correction && current) throw new Error('This settlement already exists; read it or append a correction.');
  if (correction && (!current || current.version !== versionNumber(input.expected_version))) throw new Error('Read the settlement and correct its current version.');
  const adopted = await observedInput(input, door); const calculated = settleResourcePool(adopted);
  if (current && canonical(current.result.settlement_key) !== canonical(calculated.settlement_key)) throw new Error('A correction cannot move costs into another supplier settlement scope.');
  const priorAllocations = current ? await allocationsOf(door, current) : [];
  const deltas = current ? calculated.allocations.map(row => {
    const prior = priorAllocations.find(item => item.payer_id === row.payer_id);
    if (prior && (canonical(prior.terms ?? null) !== canonical(row.terms ?? null) || canonical(prior.limits ?? null) !== canonical(row.limits ?? null))) throw new Error('A correction must preserve the original purchased terms and authorized ceilings.');
    const before = prior?.charged ?? '0';
    return { payer_id: row.payer_id, amount: subtractAmounts(row.charged, before), action: compareAmounts(row.charged, before) < 0 ? 'refund_or_credit_required' : compareAmounts(row.charged, before) > 0 ? 'additional_collection_requires_original_authority' : 'unchanged' };
  }) : [];
  if (current) for (const prior of priorAllocations.filter(row => !calculated.allocations.some(next => next.payer_id === row.payer_id))) {
    deltas.push({ payer_id: prior.payer_id, amount: subtractAmounts('0', prior.charged), action: 'refund_or_credit_required' });
  }
  const version = (current?.version ?? 0) + 1;
  // A large pool is many small immutable allocation records, not a multi-megabyte
  // head/receipt write. The final expected-head commit alone makes this version
  // current; staged immutable rows never authorize collection on their own.
  const prefix = `${id}:v${version}:${receipt.fingerprint}:allocation:`;
  const allocated = calculated.allocations.map((row, index) => ({ id: `${prefix}${String(index).padStart(5, '0')}`, type: usageRecordTypes.allocation,
    value: { ...row, ...(deltas.find(delta => delta.payer_id === row.payer_id) ? { delta: deltas.find(delta => delta.payer_id === row.payer_id) } : {}) } }));
  const removed = deltas.filter(delta => !calculated.allocations.some(row => row.payer_id === delta.payer_id));
  for (const delta of removed) allocated.push({ id: `${prefix}${String(allocated.length).padStart(5, '0')}`, type: usageRecordTypes.allocation, value: { payer_id: delta.payer_id, kind: 'removed', delta } });
  for (let at = 0; at < allocated.length; at += 16) {
    const writes = [];
    for (const row of allocated.slice(at, at + 16)) {
      const prior = await door.read(row.type, row.id);
      if (prior !== null && canonical(prior) !== canonical(row.value)) throw new Error('An immutable staged allocation changed; retain this settlement for investigation.');
      if (prior === null) writes.push({ ...row, expected: null });
    }
    if (writes.length) await door.write(writes, { key: `${receipt.id}:allocations:${at / 16}` });
  }
  const evidencePrefix = `${id}:v${version}:${receipt.fingerprint}:evidence:`;
  const refs = input.observation_refs ?? [];
  for (let at = 0; at < refs.length; at += 64) {
    const evidenceId = `${evidencePrefix}${String(at / 64).padStart(5, '0')}`;
    const value = { observation_refs: refs.slice(at, at + 64) };
    const prior = await door.read(usageRecordTypes.evidence, evidenceId);
    if (prior && canonical(prior) !== canonical(value)) throw new Error('The immutable source evidence page changed.');
    if (!prior) await door.write([{ id: evidenceId, type: usageRecordTypes.evidence, value, expected: null }], { key: `${receipt.id}:evidence:${at / 64}` });
  }
  const { allocations: _allocations, ...summary } = calculated;
  const record = { id: input.settlement_id, version, version_ref: `${id}:v${version}`, ...(current ? { supersedes: current.version_ref, reason: word(input.reason, 'correction reason') } : {}),
    result: summary, allocation_prefix: prefix, allocation_count: allocated.length, evidence_prefix: evidencePrefix, observation_count: refs.length, input_identity: identity(adopted), collection_state: 'not_sent_to_payment_provider' };
  const result = { record_id: id, settlement: record };
  return commit(door, receipt, result, [
    { id, type: usageRecordTypes.settlement, value: record, expected: expected(usageRecordTypes.settlement, current) },
    { id: record.version_ref, type: usageRecordTypes.version, value: record, expected: null },
  ]);
}
export const settleSharedResourceCost = (input, context) => settle(input, context, false);
export const correctResourceUsageSettlement = (input, context) => settle(input, context, true);
async function allocationsOf(door, record) {
  if (Array.isArray(record.result.allocations)) return record.result.allocations;
  const rows = []; let count = 0;
  for await (const row of door.list({ type: usageRecordTypes.allocation, prefix: record.allocation_prefix, reverse: false })) {
    if (++count > 20000) throw new Error('This settlement exceeds the bounded correction input; reconcile it in separate scopes.');
    if (row.value.kind !== 'removed') rows.push(row.value);
  }
  // Removed payers also have an allocation record carrying their credit delta.
  if (count !== record.allocation_count) throw new Error('Allocation count does not match its committed settlement.');
  return rows;
}
export async function readResourceUsageSettlement(input, { door }) {
  const id = recordKey(usageRecordTypes.settlement, input.settlement_id);
  const record = input.version === undefined ? await door.read(usageRecordTypes.settlement, id) : await door.read(usageRecordTypes.version, `${id}:v${versionNumber(input.version)}`);
  if (!record) return { record_id: id, settlement: null, allocations: [], next: null };
  const limit = input.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Read from 1 to 100 settlement allocations per page.');
  if (input.after && !input.after.startsWith(record.allocation_prefix)) throw new Error('The allocation cursor is for another settlement version.');
  const allocations = []; let next = null;
  for await (const row of door.list({ type: usageRecordTypes.allocation, prefix: record.allocation_prefix, reverse: false, ...(input.after ? { above: input.after } : {}) })) {
    if (allocations.length === limit) { next = allocations.at(-1).record_id; break; }
    allocations.push({ record_id: row.id, ...row.value });
  }
  return { record_id: id, settlement: record, allocations, next };
}
