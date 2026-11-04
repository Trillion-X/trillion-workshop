// Carries a person's decisions from the two earlier storage shapes into the EEAF tables with their whole history:
//   - `cases` + `changes`: one JSON document per case, and every earlier version of it with its time;
//   - `decision_entities` + `decision_facts`: one linked entity per case and list item, and one row per changed value.
// Each earlier write is replayed in time order as its own EEAF transaction whose application time is the time it
// was first made, so the EEAF log reads as if the person's data had always been stored there. Settings (plan,
// sharing, sign-in cut-off) had no history and are carried as they stand. The carry-forward then checks that
// every record reads back exactly as the earlier store held it; only then are the earlier tables removed.
import { canonical } from '../../shared-code/src/record-identity.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The earlier fact store's own read rule: newest value per attribute; a list item joins its parent by position.
function recomposeFacts(links, values, root) {
  const records = new Map();
  for (const [id, own] of values) {
    if (own.size > 0 && [...own.values()].every(text => text === null)) continue;
    const record = {};
    for (const [attribute, text] of own) if (text !== null) record[attribute] = JSON.parse(text);
    records.set(id, record);
  }
  const children = [...links].filter(([, link]) => link.of_entity !== null).sort(([, a], [, b]) => a.position - b.position);
  for (const [id, link] of children) {
    const parent = records.get(link.of_entity);
    if (parent && records.has(id)) (parent[link.of_attribute] ??= []).push(records.get(id));
  }
  return records.get(root) ?? null;
}

const kindOf = record => record?.kind === 'pursuit' ? 'pursuit' : 'decision';

/**
 * The earlier writes, oldest first: [{ at, records: [{ id, type, value }] }].
 *   changes:  [{ at, case_id, record (JSON text) }]
 *   links:    [{ entity, of_entity, of_attribute, position }]
 *   facts:    [{ at, entity, attribute, value (JSON text or null) }] in the order they were appended
 */
export function earlierWrites({ changes = [], links = [], facts = [] }) {
  const writes = [];
  for (const change of changes) {
    const value = JSON.parse(change.record);
    writes.push({ at: change.at, records: [{ id: change.case_id, type: kindOf(value), value }] });
  }
  const linkOf = new Map(links.map(row => [row.entity, { of_entity: row.of_entity, of_attribute: row.of_attribute, position: row.position }]));
  const rootOf = entity => { let id = entity; while (linkOf.get(id)?.of_entity) id = linkOf.get(id).of_entity; return id; };
  const values = new Map();
  let group = null;
  const flush = () => {
    if (!group) return;
    writes.push({ at: group.at, records: [...group.roots].map(id => {
      const value = recomposeFacts(linkOf, values, id);
      return { id, type: kindOf(value), value };
    }) });
    group = null;
  };
  for (const fact of facts) {
    if (group && group.at !== fact.at) flush();
    group ??= { at: fact.at, roots: new Set() };
    if (!values.has(fact.entity)) values.set(fact.entity, new Map());
    values.get(fact.entity).set(fact.attribute, fact.value);
    group.roots.add(rootOf(fact.entity));
  }
  flush();
  // Oldest first; a store that was carried from documents into facts wrote both, and both replay in time order.
  return writes.map((write, order) => ({ ...write, order })).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.order - b.order);
}

// The current records the earlier store would read now, for the check after carrying forward.
export function earlierCurrent({ changes = [], links = [], facts = [] }) {
  const current = new Map();
  for (const write of earlierWrites({ changes, links, facts })) for (const record of write.records) current.set(record.id, record);
  return current;
}

/** Replays the earlier writes into the store, carries the settings, and checks every record reads back the same. */
export function carryForward(store, earlier, settings = []) {
  const writes = earlierWrites(earlier);
  for (const write of writes) {
    store.eeaf.write(write.records.map(({ id, type, value }) => ({ id, type, value: object(value) ? value : null })), {
      application_time: write.at, actor: { by: 'carry-forward', from: 'earlier trillion store' },
    });
  }
  for (const { name, value } of settings) store.setSetting(name, value, { actor: { by: 'carry-forward', from: 'earlier settings table' } });
  const expected = earlierCurrent(earlier);
  for (const [id, { value }] of expected) {
    const read = store.eeaf.read(id);
    if (canonical(read) !== canonical(object(value) ? value : null)) throw new Error(`Carrying ${id} forward changed it; the earlier store is kept.`);
  }
  for (const { name, value } of settings) if (canonical(store.setting(name)) !== canonical(value)) throw new Error(`Carrying setting ${name} forward changed it; the earlier store is kept.`);
  return { writes: writes.length, records: expected.size, settings: settings.length };
}
