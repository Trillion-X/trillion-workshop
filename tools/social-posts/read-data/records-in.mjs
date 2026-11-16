// tools/social-posts/read-data/records-in.mjs
//
// The records a tool reads, handed in by the caller, and the rows it would keep, handed back. The run reads no store and
// keeps nothing: the person's AI reads the records the ask needs (the post, the person's connection records) from a
// store and gives them as `records` ([{ id, type, value }]); whatever the run would have written comes back as `keep`
// ([{ id, type, value }], the whole row), for the caller to store.
//
//   recordsIn(input) -> { door, kept }
//     door.read(type, id)        the value of the record handed in, or null
//     door.readRecord(type, id)  the whole record { id, type, value }, or null
//     door.list({ type })        the records of that kind handed in, greatest id first
//     door.write(items)          takes each { id, type, value } into `kept`; nothing is stored
//   withKept(answer, kept)      the answer with `keep` when there is something to store
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function recordsIn(input) {
  const records = (Array.isArray(input?.records) ? input.records : []).filter(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string' && object(record.value));
  const kept = [];
  const door = {
    async readRecord(type, id) { return records.find(record => record.type === type && record.id === id) ?? null; },
    async read(type, id) { return (await door.readRecord(type, id))?.value ?? null; },
    async *list({ type } = {}) {
      for (const record of records.filter(one => one.type === type).sort((a, b) => (a.id < b.id ? 1 : -1))) yield record;
    },
    async write(items) { for (const { id, type, value } of items) kept.push({ id, type, value }); },
  };
  return { door, kept };
}

export const withKept = (answer, kept) => (kept.length ? { ...answer, keep: kept } : answer);
