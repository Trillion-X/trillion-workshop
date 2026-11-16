// tools/watch-my-sources/do-work/records-in-hand.mjs
//
// The records the caller handed in, kept in memory for one run, as watch-sources reaches them through
// tools/records-door/read-data/lists-door.mjs: read one record, list a kind (greatest id first, `fields` narrowing each
// value), and write records with the door's conditions (`expected` null for absent, { type, value } for the exact current
// record; a mismatch refuses the whole write) and receipts by key. Nothing here reaches a store: when the run ends,
// `changes()` is what it would have written, the records:write input the caller sends, each record expecting the value it
// was handed in with.
import { isDeepStrictEqual } from 'node:util';

export function memoryDoor(records = []) {
  const handed = new Map(records.map(record => [record.id, structuredClone(record)]));
  const kept = new Map(handed);
  const receipts = new Map();
  const door = {
    kept,
    writes: [],
    async read(type, id) {
      const held = kept.get(id);
      return held?.type === type ? structuredClone(held.value) : null;
    },
    async *list({ type, fields } = {}) {
      const ids = [...kept.values()].filter(record => record.type === type).map(record => record.id).sort().reverse();
      for (const id of ids) {
        const { value } = kept.get(id);
        yield { id, type, value: fields ? Object.fromEntries(fields.filter(name => name in value).map(name => [name, structuredClone(value[name])])) : structuredClone(value) };
      }
    },
    async write(items, { key } = {}) {
      if (key && receipts.has(key)) return receipts.get(key);
      for (const item of items) {
        if (!Object.hasOwn(item, 'expected')) continue;
        const current = kept.get(item.id) ?? null;
        const holds = item.expected === null ? !current : current && current.type === item.expected.type && isDeepStrictEqual(current.value, item.expected.value);
        if (!holds) throw Object.assign(new Error('The door refused the write: original_command_conflict'), { code: 'original_command_conflict' });
      }
      for (const { expected: _expected, ...record } of items) {
        if (record.value === null) kept.delete(record.id);
        else kept.set(record.id, structuredClone(record));
      }
      door.writes.push(items.length);
      const receipt = { changed: items.length, write_count: items.length };
      if (key) receipts.set(key, receipt);
      return receipt;
    },
    /** The records:write input for what the run changed, against what was handed in: a new or changed record expects what
     * it was handed in with (null when it was not), a record taken out is written with value null. */
    changes() {
      const expectedOf = id => (handed.has(id) ? { type: handed.get(id).type, value: handed.get(id).value } : null);
      const write = [...kept.values()]
        .filter(record => !handed.has(record.id) || !isDeepStrictEqual(handed.get(record.id).value, record.value))
        .map(record => ({ id: record.id, type: record.type, value: record.value, expected: expectedOf(record.id) }));
      for (const record of handed.values()) if (!kept.has(record.id)) write.push({ id: record.id, type: record.type, value: null, expected: expectedOf(record.id) });
      return write;
    },
  };
  return door;
}
