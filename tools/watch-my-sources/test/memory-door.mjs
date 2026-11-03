// tools/watch-my-sources/test/memory-door.mjs
//
// The person's records door kept in memory, as watch-sources reaches it through read-data/lists-door.mjs: read one
// record, list a kind (greatest id first, `fields` narrowing each value), and write records with the door's conditions
// (`expected` null for absent, { type, value } for the exact current record; a mismatch refuses the whole write) and
// receipts by key. `writes` counts every write that reached it.
import { isDeepStrictEqual } from 'node:util';

export function memoryDoor(records = []) {
  const kept = new Map(records.map(record => [record.id, structuredClone(record)]));
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
  };
  return door;
}
