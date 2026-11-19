// tools/watch-my-sources/read-data/lists-in-hand.mjs
//
// Purpose
//   The person's lists as watch-sources.mjs reaches them (has, find, ensure, save, read, putRows), over the records the
//   caller handed in for one run. A list is the record `list:<id>` of type `list` ({ label, row_type, title_field, fields,
//   indexes, ... }); its rows are the records `record:<row_type>:<row id>` of type `record:<row_type>`, the shape the
//   person's lists keep them in, so a row kept here is the same row the person's list shows. Nothing here reaches a store:
//   `keep()` is what the run changed, for the caller to put where the person keeps their rows.
//
// Non-Negotiable Invariants
//   1. A row is merged, never replaced: putRows writes the given values over the row's current value, a null value takes
//      that field out, and every other field stays as it was.
//   2. Every kept record expects what was handed in: { type, value } as it came, or null for one that was not there. A
//      store refuses a keep whose record moved in between, so a run never overwrites what it did not see.
//   3. ensure keeps a list once, with its starter rows: an existing list is never rewritten, a field the person added or
//      changed stays, and a starter row the person took out is never put back.
//   4. Nothing here names a list, a field or a kind of row: the caller's list definitions do.
//
// Shapes
//   listsInHand(records) -> { has(id), find(id), ensure(definition), save({ id, ...definition }), read(id, { only?, row_ids? }),
//                             putRows(id, { rows: [{ id, values }] }), rowsOfType(type, fields?), keep() }
//     records: [{ id, type, value }]; find -> { id, ...list } | null; read -> { list, rows: [{ id, values }] } in id order;
//     putRows -> { written, kept: [{ id }] }; keep -> [{ id, type, value, expected }] for each new or changed record
import { isDeepStrictEqual } from 'node:util';

const LIST_TYPE = 'list';
const listId = id => `${LIST_TYPE}:${id}`;
const rowType = list => `record:${list.row_type}`;
const rowPrefix = list => `${rowType(list)}:`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = ({ id: _id, ...value }) => value;

export class ListsInHandError extends Error {}

export function listsInHand(records = []) {
  const handed = new Map(records.map(record => [record.id, structuredClone(record)]));
  const held = new Map(handed);
  const valueOf = (type, id) => (held.get(id)?.type === type && object(held.get(id).value) ? structuredClone(held.get(id).value) : null);
  const put = (id, type, value) => held.set(id, { id, type, value: structuredClone(value) });
  const find = id => {
    const value = valueOf(LIST_TYPE, listId(id));
    return value ? { id, ...value } : null;
  };
  const must = id => {
    const list = find(id);
    if (!list) throw new ListsInHandError(`There is no list ${id} in the person's records.`);
    return list;
  };

  const lists = {
    async has(id) { return Boolean(find(id)); },
    async find(id) { return find(id); },
    // A missing list is made with its definition, then its starter rows ([{ id, values }]) that are not kept yet.
    async ensure({ id, starters = [], ...definition }) {
      if (find(id)) return find(id);
      put(listId(id), LIST_TYPE, { row_type: id, indexes: [], ...definition });
      if (starters.length) await lists.putRows(id, { rows: starters });
      return find(id);
    },
    // A list's definition kept: a missing list is made with it, an existing one keeps what the save leaves out.
    async save({ id, starters: _starters, ...definition }) {
      const list = find(id);
      put(listId(id), LIST_TYPE, list ? { ...own(list), ...definition } : { row_type: id, indexes: [], ...definition });
      return find(id);
    },
    async read(id, { only, row_ids: rowIds } = {}) {
      const list = must(id);
      const type = rowType(list);
      const prefix = rowPrefix(list);
      const pick = values => (only ? Object.fromEntries(Object.entries(values).filter(([field]) => only.includes(field))) : values);
      const ids = rowIds
        ? rowIds.map(rowId => `${prefix}${rowId}`)
        : [...held.values()].filter(record => record.type === type && record.id.startsWith(prefix)).map(record => record.id).sort();
      const rows = ids.map(recordId => [recordId, valueOf(type, recordId)]).filter(([, values]) => values)
        .map(([recordId, values]) => ({ id: recordId.slice(prefix.length), values: pick(values) }));
      return { list, rows };
    },
    // Each row's values merged over what it holds now (a null takes the field out).
    async putRows(id, { rows }) {
      const list = must(id);
      const type = rowType(list);
      for (const row of rows) {
        const recordId = `${rowPrefix(list)}${row.id}`;
        const value = valueOf(type, recordId) ?? {};
        for (const [field, given] of Object.entries(row.values ?? {})) {
          if (given === null || given === undefined) delete value[field];
          else value[field] = given;
        }
        put(recordId, type, value);
      }
      return { written: rows.length, kept: rows.map(row => ({ id: row.id })) };
    },
    /** The handed-in records of one type that are not list rows (the person's pursuits), each { id, value } narrowed to `fields`. */
    rowsOfType(type, fields) {
      return [...held.values()].filter(record => record.type === type && object(record.value)).sort((a, b) => (a.id < b.id ? 1 : -1))
        .map(({ id, value }) => ({ id, value: fields ? Object.fromEntries(fields.filter(name => name in value).map(name => [name, structuredClone(value[name])])) : structuredClone(value) }));
    },
    /** What the run changed, each record expecting what it was handed in with (null when it was not). */
    keep() {
      const expectedOf = id => (handed.has(id) ? { type: handed.get(id).type, value: handed.get(id).value } : null);
      return [...held.values()]
        .filter(record => !handed.has(record.id) || !isDeepStrictEqual(handed.get(record.id).value, record.value))
        .map(record => ({ id: record.id, type: record.type, value: structuredClone(record.value), expected: expectedOf(record.id) }));
    },
  };
  return lists;
}
