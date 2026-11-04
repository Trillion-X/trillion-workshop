// tools/build-and-send-a-sales-contract/do-work/sales-contract-builder.mjs (moved from Trillion-X/trillion src/sales-contract-builder.mjs)
//
// PURPOSE
//   What the sales contract builder reads from the person's own business, and what it sets up after a deal is sent.
//   1. readDealResources: every source in src/sales-contract-builder.json (their offers and prices on their own
//      payment service, their customers from their lists and that service, their saved deals, rules, schedules and
//      workflows), each read through one of the readers the account owner hands in, so tool:manage-sales-contracts
//      operation `resources` answers an AI and the builder screen the same.
//   2. dealFollowUps: a sent deal's follow-ups (`contract.follow_ups`) turned into the person's own rules (when the
//      deal is paid) and schedules (at a set time), set through the one automations owner. No scheduler of its own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a payment service, a list, a tool or a kind of offer. Which sources exist, where their
//      lists sit, which fields map to what, and the paid trigger are DATA; readers come from the caller by name.
//   2. One source failing never hides another: each answers its own state (read, not connected, could not be read) and
//      the reason in words, with no items.
//   3. A follow-up's words are filled only from the facts of the deal being sent ({to}, {contract_name},
//      {contract_id}, {address}); a brace that names anything else stays as written.
//   4. A paid follow-up's rule always carries the deal's own id, so one deal's payment never runs another's steps.
//
import builder from '../sales-contract-builder.json' with { type: 'json' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const MAX_ITEMS = 200;

// readSalesContractBuilder (the hosted builder's current content, read through the Worker's marketplace content
// documents) stays with the hosted service: this folder reads its own sales-contract-builder.json.

/** The value at a path of keys and list positions, or undefined. */
export function valueAt(value, path) {
  return (Array.isArray(path) ? path : []).reduce((at, key) => (at === null || at === undefined ? undefined : at[key]), value);
}

const passes = (row, keep = []) => keep.every(test => valueAt(row, test.path) === test.equals);

/** One row of a source's answer in the builder's own fields; fields with no value are left out. */
function mapped(row, each) {
  return Object.fromEntries(Object.entries(each).map(([field, path]) => [field, valueAt(row, path)]).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

/**
 * Read every source. readers: { [from]: (read) => answer } (each may throw); connected: (vendor) => boolean.
 * → { sources: [{ id, group, label, state: 'read' | 'not_connected' | 'unread', reason?, items: [...] }] }
 */
export async function readDealResources({ readers, connected = () => true, sources = builder.sources }) {
  return {
    sources: await Promise.all(sources.map(async source => {
      const shown = { id: source.id, group: source.group, label: source.label };
      if (source.needs_connection && !connected(source.needs_connection)) return { ...shown, state: 'not_connected', connection: source.needs_connection, items: [] };
      const reader = readers[source.read?.from];
      if (typeof reader !== 'function') return { ...shown, state: 'unread', reason: `Nothing here reads ${source.read?.from ?? 'this source'}.`, items: [] };
      try {
        const answer = await reader(source.read);
        const rows = valueAt(answer, source.items);
        if (!Array.isArray(rows)) return { ...shown, state: 'unread', reason: 'Its answer held no list.', items: [] };
        return { ...shown, state: 'read', items: rows.filter(row => object(row) && passes(row, source.keep)).slice(0, MAX_ITEMS).map(row => mapped(row, source.each)).filter(item => text(item.id)) };
      } catch (error) {
        return { ...shown, state: 'unread', reason: String(error?.message ?? error), items: [] };
      }
    })),
  };
}

/** Every string inside `value` with {name} filled from `facts`; names not in facts stay as written. */
export function fillWords(value, facts) {
  if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(facts, name) ? String(facts[name]) : whole));
  if (Array.isArray(value)) return value.map(item => fillWords(item, facts));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillWords(item, facts)]));
  return value;
}

/**
 * The rules and schedules a sent deal's follow-ups ask for, ready for the automations owner.
 * followUps: [{ id?, label, on: 'paid' | { once_at }, then: { tool_id | workflow_id, input } }]
 * → [{ kind: 'rule', input } | { kind: 'schedule', input }]
 */
export function dealFollowUps({ contract, followUps, facts, trigger = builder.after_payment.trigger }) {
  if (followUps === undefined || followUps === null) return [];
  if (!Array.isArray(followUps)) throw new Error('A deal\'s follow-ups must be a list.');
  return followUps.map((step, index) => {
    if (!object(step) || !object(step.then) || !(text(step.then.tool_id) || text(step.then.workflow_id))) throw new Error(`Follow-up ${index + 1} needs then: { tool_id or workflow_id, input }.`);
    const label = `${text(step.label) ? step.label.trim() : `Follow-up ${index + 1}`}: ${contract.name}`;
    const then = fillWords(step.then, facts);
    if (step.on === 'paid') {
      if(!object(trigger))throw new Error('The paid-deal follow-up condition is unavailable; choose its current condition before sending.');
      return { kind: 'rule', input: { label, when: { ...trigger, where: [...(trigger.where ?? []), { field: 'contract_id', equals: contract.id }] }, then } };
    }
    if (object(step.on) && text(step.on.once_at) && Number.isFinite(Date.parse(step.on.once_at))) return { kind: 'schedule', input: { label, once_at: step.on.once_at, then } };
    throw new Error(`Follow-up ${index + 1} needs on: "paid" or { once_at }.`);
  });
}
