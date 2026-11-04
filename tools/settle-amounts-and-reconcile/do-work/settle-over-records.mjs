// tools/settle-amounts-and-reconcile/do-work/settle-over-records.mjs
//
// Purpose
//   The seam a row runs: read-data/list-settlements.mjs (moved unchanged from the earlier Trillion app) over the person's
//   own lists, reached through their records door (tools/records-door). A list is the record `list:<id>` of type `list`;
//   its rows are the records `record:<row_type>:<row id>` of type `record:<row_type>`, the shape a Trillion list keeps
//   them in (tools/records-door/read-data/lists-door.mjs), so a row settled here is the row the person's list shows.
//
// Non-Negotiable Invariants
//   1. The settlement code is the moved module; this file only gives it the lists it asks for (find, ensure, read,
//      putRows) and answers what its request handler answers. A refusal comes back as an error with its words.
//   2. A row is merged, never replaced: putRows writes the given values over the row's current value, a null value takes
//      that field out, `remove` takes the row away; every write is conditional on the record as it was read.
//   3. A row named with `if_values` is written only when each named field still holds that value (absent is null); one
//      that does not is answered under `conflicts` and left as it was, the others are written.
//   4. `find` answers at once from the person's lists read when the run starts; a list this run makes is found at once.
//
// Shapes
//   settle({ action, list_id, ...input }, { door }) -> what the settlement action answers (fields ending in _kind are
//   the record kinds the row's rights are filled from, and are not passed on)
//   action: propose | apply | remove | position | close | check | undo | balance | post | reverse | totals | basis
import { randomUUID } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { handleSettlementRequest } from '../read-data/list-settlements.mjs';

const LIST_TYPE = 'list';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** The person's lists over their records door, in the shape read-data/list-settlements.mjs reaches lists. */
export async function settlementListsOverDoor(door) {
  const lists = new Map();
  for await (const record of door.list({ type: LIST_TYPE })) {
    if (typeof record?.id === 'string' && record.id.startsWith(`${LIST_TYPE}:`) && object(record.value)) {
      const id = record.id.slice(LIST_TYPE.length + 1);
      lists.set(id, { id, ...record.value });
    }
  }
  // A key per write in this run: the same write sent again after an unknown outcome is sent by the door with its key.
  const run = randomUUID();
  let count = 0;
  const keyOf = records => `settle-amounts-and-reconcile:${run}:${count += 1}:${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(records)))}`;
  const must = id => {
    const list = lists.get(id);
    if (!list) throw new Error(`There is no list ${id} in the person's records.`);
    return list;
  };
  const rowType = list => `record:${list.row_type}`;
  const rowPrefix = list => `${rowType(list)}:`;

  return {
    find: id => lists.get(String(id).replace(/^list:/, '')) ?? null,
    async ensure({ id, ...definition }) {
      if (lists.has(id)) return lists.get(id);
      const value = { row_type: id, indexes: [], ...definition };
      lists.set(id, { id, ...value });
      await door.write([{ id: `${LIST_TYPE}:${id}`, type: LIST_TYPE, value, expected: null }], { key: keyOf([id, value]) });
      return lists.get(id);
    },
    async read(id, { row_ids: rowIds, keep } = {}) {
      const list = must(id);
      const prefix = rowPrefix(list);
      const rows = [];
      if (rowIds) {
        for (const rowId of rowIds) {
          const values = await door.read(rowType(list), `${prefix}${rowId}`);
          if (object(values)) rows.push({ id: rowId, values });
        }
      } else {
        for await (const record of door.list({ type: rowType(list) })) {
          if (typeof record?.id === 'string' && record.id.startsWith(prefix) && object(record.value)) rows.push({ id: record.id.slice(prefix.length), values: record.value });
        }
        rows.reverse();
      }
      const kept = typeof keep === 'function' ? rows.filter(row => keep(row.values)) : rows;
      return { list, rows: kept, page: { complete: true, scanned: rows.length } };
    },
    async putRows(id, { rows = [], remove = [] } = {}) {
      const list = must(id);
      const type = rowType(list);
      const records = [];
      const kept = [];
      const conflicts = [];
      for (const row of rows) {
        const recordId = `${rowPrefix(list)}${row.id}`;
        const held = await door.read(type, recordId);
        if (object(row.if_values) && Object.entries(row.if_values).some(([field, wanted]) => !same(object(held) ? held[field] : null, wanted))) {
          conflicts.push({ row_id: row.id });
          continue;
        }
        const value = { ...(object(held) ? held : {}) };
        for (const [field, given] of Object.entries(row.values ?? {})) {
          if (given === null || given === undefined) delete value[field];
          else value[field] = given;
        }
        records.push({ id: recordId, type, value, expected: object(held) ? { type, value: held } : null });
        kept.push({ id: row.id, values: value });
      }
      const removed = [];
      for (const rowId of remove) {
        const recordId = `${rowPrefix(list)}${rowId}`;
        const held = await door.read(type, recordId);
        if (!object(held)) continue;
        records.push({ id: recordId, type, value: null, expected: { type, value: held } });
        removed.push(rowId);
      }
      if (records.length) await door.write(records, { key: keyOf(records) });
      return { list_id: id, kept, removed, ...(conflicts.length ? { conflicts } : {}) };
    },
  };
}

/** One settlement action over the person's lists: the moved request handler's answer, or its refusal as an error. */
export async function settle({ action, list_id: listId, ...given } = {}, { door } = {}) {
  if (!door) throw new Error('settle needs the person\'s records door.');
  // The record kinds a row names for its rights (source_kind, target_kind, lines_kind) are for the engine, not the action.
  const input = Object.fromEntries(Object.entries(given).filter(([name]) => !name.endsWith('_kind')));
  const lists = await settlementListsOverDoor(door);
  const response = await handleSettlementRequest(lists, String(listId ?? '').replace(/^list:/, ''), String(action ?? ''), input);
  const answer = await response.json();
  if (!response.ok) throw Object.assign(new Error(answer.error), { status: response.status });
  return answer;
}
