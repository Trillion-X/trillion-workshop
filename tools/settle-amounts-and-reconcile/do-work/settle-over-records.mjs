// tools/settle-amounts-and-reconcile/do-work/settle-over-records.mjs
//
// Purpose
//   The seam a row runs: read-data/list-settlements.mjs (moved unchanged from the earlier Trillion app) over the lists
//   the request hands in. The run reads no store and keeps nothing: the person's AI reads the lists the action names from
//   a store (a list's own definition and its rows), hands them in as `lists`, and stores what the answer says to keep.
//
// Non-Negotiable Invariants
//   1. The settlement code is the moved module; this file only gives it the lists it asks for (find, ensure, read,
//      putRows) and answers what its request handler answers. A refusal comes back as an error with its words.
//   2. A row is merged, never replaced: putRows writes the given values over the row's current value, a null value takes
//      that field out, `remove` takes the row away. These changes are made on the lists handed in, so the rest of the
//      action reads what it wrote, and they are answered as `keep`, never stored here.
//   3. A row named with `if_values` is written only when each named field still holds that value (absent is null); one
//      that does not is answered under `conflicts` and left as it was, the others are written.
//   4. `find` answers at once from the lists handed in; a list this run makes is found at once and answered in `keep`.
//
// Shapes
//   settle({ action, list_id, lists, ...input }) -> what the settlement action answers, with `keep` when rows or lists
//   are to be stored: { lists: [<list definitions made>], rows: [{ list_id, row_type, id, values | null }] }, where
//   `values` is the whole row to store and null takes the row away. A list in `lists` is { id, row_type, fields, ...
//   its definition, rows: [{ id, values }] } with its rows in any order (they are read by id, ascending).
//   action: propose | apply | remove | position | close | check | undo | balance | post | reverse | totals | basis
import { handleSettlementRequest } from '../read-data/list-settlements.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** The lists handed in, in the shape read-data/list-settlements.mjs reaches lists, and the changes made on them. */
export function settlementListsFromInput(given = []) {
  const lists = new Map();
  const rows = new Map();
  for (const entry of Array.isArray(given) ? given : []) {
    if (!object(entry) || typeof entry.id !== 'string') continue;
    const { rows: listRows = [], ...definition } = entry;
    const id = entry.id.replace(/^list:/, '');
    lists.set(id, { ...definition, id });
    rows.set(id, new Map((Array.isArray(listRows) ? listRows : []).filter(row => object(row) && typeof row.id === 'string' && object(row.values)).map(row => [row.id, row.values])));
  }
  const made = new Set();
  const first = new Map();
  const changed = new Map();
  const must = id => {
    const list = lists.get(id);
    if (!list) throw new Error(`There is no list ${id} in the lists handed in.`);
    return list;
  };

  return {
    find: id => lists.get(String(id).replace(/^list:/, '')) ?? null,
    async ensure({ id, ...definition }) {
      if (lists.has(id)) return lists.get(id);
      lists.set(id, { id, row_type: id, indexes: [], ...definition });
      rows.set(id, new Map());
      made.add(id);
      return lists.get(id);
    },
    async read(id, { row_ids: rowIds, keep } = {}) {
      const list = must(id);
      const held = rows.get(id);
      const found = (rowIds ? rowIds.filter(rowId => held.has(rowId)) : [...held.keys()].sort()).map(rowId => ({ id: rowId, values: held.get(rowId) }));
      const kept = typeof keep === 'function' ? found.filter(row => keep(row.values)) : found;
      return { list, rows: kept, page: { complete: true, scanned: found.length } };
    },
    async putRows(id, { rows: given = [], remove = [] } = {}) {
      const list = must(id);
      const held = rows.get(id);
      const notice = rowId => { if (!first.has(`${id}:${rowId}`)) first.set(`${id}:${rowId}`, held.has(rowId)); };
      const kept = [];
      const removed = [];
      const conflicts = [];
      for (const row of given) {
        const current = held.get(row.id);
        if (object(row.if_values) && Object.entries(row.if_values).some(([field, wanted]) => !same(object(current) ? current[field] : null, wanted))) {
          conflicts.push({ row_id: row.id });
          continue;
        }
        const value = { ...(object(current) ? current : {}) };
        for (const [field, next] of Object.entries(row.values ?? {})) {
          if (next === null || next === undefined) delete value[field];
          else value[field] = next;
        }
        notice(row.id);
        held.set(row.id, value);
        changed.set(`${id}:${row.id}`, { list_id: id, row_type: list.row_type, id: row.id, values: value });
        kept.push({ id: row.id, values: value });
      }
      for (const rowId of remove) {
        if (!held.has(rowId)) continue;
        notice(rowId);
        held.delete(rowId);
        changed.set(`${id}:${rowId}`, { list_id: id, row_type: list.row_type, id: rowId, values: null });
        removed.push(rowId);
      }
      return { list_id: id, kept, removed, ...(conflicts.length ? { conflicts } : {}) };
    },
    /** What the caller stores: the lists made, and each row as it ends (a row made and taken back in this run is not named). */
    keep() {
      const rowsToKeep = [...changed].filter(([key, row]) => !(row.values === null && first.get(key) === false)).map(([, row]) => row);
      const listsToKeep = [...made].map(id => lists.get(id));
      return listsToKeep.length || rowsToKeep.length ? { lists: listsToKeep, rows: rowsToKeep } : null;
    },
  };
}

/** One settlement action over the lists handed in: the moved request handler's answer and what to keep, or its refusal as an error. */
export async function settle({ action, list_id: listId, lists: given, ...rest } = {}) {
  // The record kinds a row names (source_kind, target_kind, lines_kind) are not the action's input.
  const input = Object.fromEntries(Object.entries(rest).filter(([name]) => !name.endsWith('_kind')));
  const lists = settlementListsFromInput(given);
  const response = await handleSettlementRequest(lists, String(listId ?? '').replace(/^list:/, ''), String(action ?? ''), input);
  const answer = await response.json();
  if (!response.ok) throw Object.assign(new Error(answer.error), { status: response.status });
  const keep = lists.keep();
  return keep ? { ...answer, keep } : answer;
}
