// tools/watch-my-sources/read-data/lists-door.mjs
//
// Purpose
//   The person's lists as watch-sources.mjs reaches them (has, find, ensure, save, read, putRows), over their own records
//   door (tools/records-door). A list is the record `list:<id>` of type `list` ({ label, row_type, title_field, fields,
//   indexes, ... }); its rows are the person's records `record:<row_type>:<row id>` of type `record:<row_type>`, the shape
//   a Trillion list keeps them in, so a row kept here is the same row the person's list shows.
//
// Non-Negotiable Invariants
//   1. A row is merged, never replaced: putRows writes the given values over the row's current value, a null value takes
//      that field out, and every other field stays as it was.
//   2. Every write is conditional on what was read: a new list or row expects to be absent, a changed one expects the
//      exact value read before it. A row someone else changed in between refuses the whole write (the door's
//      original_command_conflict) and nothing of it is written, so a run never overwrites what it did not see.
//   3. A write is sent with a key made from what it writes, so a write the door answered with an unknown outcome is sent
//      again with the same key and answers its first receipt.
//   4. ensure keeps a list once, with its starter rows: an existing list is never rewritten, a field the person added or
//      changed stays, and a starter row the person took out is never put back.
//   5. Nothing here names a list, a field or a kind of row: the caller's list definitions do.
//
// Shapes
//   listsOverDoor(door) -> { has(id), find(id), ensure(definition), save({ id, ...definition }), read(id, { only?, row_ids? }),
//                            putRows(id, { rows: [{ id, values }] }) }   every one answers a promise
//     find -> { id, ...list } | null; read -> { list, rows: [{ id, values }] }; putRows -> { written, kept: [{ id }] }
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const LIST_TYPE = 'list';
const listId = id => `${LIST_TYPE}:${id}`;
const rowType = list => `record:${list.row_type}`;
const rowPrefix = list => `${rowType(list)}:`;
const keyOf = (what, records) => `watch-my-sources:${what}:${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(records)))}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ListsDoorError extends Error {}

export function listsOverDoor(door) {
  const found = new Map();
  async function find(id) {
    if (found.has(id)) return found.get(id);
    const value = await door.read(LIST_TYPE, listId(id));
    const list = object(value) ? { id, ...value } : null;
    if (list) found.set(id, list);
    return list;
  }
  async function must(id) {
    const list = await find(id);
    if (!list) throw new ListsDoorError(`There is no list ${id} in the person's records.`);
    return list;
  }
  const own = ({ id: _id, ...value }) => value;

  return {
    async has(id) { return Boolean(await find(id)); },
    find,
    // A missing list is made with its definition, then its starter rows ([{ id, values }]) that are not kept yet.
    async ensure({ id, starters = [], ...definition }) {
      if (await find(id)) return find(id);
      const value = { row_type: id, indexes: [], ...definition };
      await door.write([{ id: listId(id), type: LIST_TYPE, value, expected: null }], { key: keyOf('ensure', [id, value]) });
      found.set(id, { id, ...value });
      if (starters.length) await this.putRows(id, { rows: starters });
      return found.get(id);
    },
    // A list's definition kept: a missing list is made with it, an existing one keeps what the save leaves out.
    async save({ id, starters: _starters, ...definition }) {
      const list = await find(id);
      const value = list ? { ...own(list), ...definition } : { row_type: id, indexes: [], ...definition };
      await door.write([{ id: listId(id), type: LIST_TYPE, value, expected: list ? { type: LIST_TYPE, value: own(list) } : null }], { key: keyOf('save', [id, value]) });
      found.set(id, { id, ...value });
      return found.get(id);
    },
    async read(id, { only, row_ids: rowIds } = {}) {
      const list = await must(id);
      const prefix = rowPrefix(list);
      const pick = values => (only ? Object.fromEntries(Object.entries(values ?? {}).filter(([field]) => only.includes(field))) : { ...(values ?? {}) });
      if (rowIds) {
        const rows = [];
        for (const rowId of rowIds) {
          const values = await door.read(rowType(list), `${prefix}${rowId}`);
          if (object(values)) rows.push({ id: rowId, values: pick(values) });
        }
        return { list, rows };
      }
      const rows = [];
      for await (const record of door.list({ type: rowType(list), ...(only ? { fields: only } : {}) })) {
        if (typeof record?.id === 'string' && record.id.startsWith(prefix)) rows.push({ id: record.id.slice(prefix.length), values: pick(record.value) });
      }
      return { list, rows: rows.reverse() };
    },
    // Each row's values merged over what it holds now (a null takes the field out), written in one conditional write.
    async putRows(id, { rows }) {
      const list = await must(id);
      const type = rowType(list);
      const records = [];
      for (const row of rows) {
        const recordId = `${rowPrefix(list)}${row.id}`;
        const held = await door.read(type, recordId);
        const value = { ...(object(held) ? held : {}) };
        for (const [field, given] of Object.entries(row.values ?? {})) {
          if (given === null || given === undefined) delete value[field];
          else value[field] = given;
        }
        records.push({ id: recordId, type, value, expected: object(held) ? { type, value: held } : null });
      }
      if (records.length) await door.write(records, { key: keyOf('rows', records) });
      return { written: records.length, kept: rows.map(row => ({ id: row.id })) };
    },
  };
}
