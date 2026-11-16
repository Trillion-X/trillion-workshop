// tools/send-messages/read-data/rows-handed-in.mjs
//
// The rows a send works over, and what it would leave changed. The tools here keep nothing: the caller's AI reads the
// rows a run needs from the person's store and hands them in (`records`: [{ id, type, value }]); a run reads and
// changes them in memory, and its answer says which rows to keep (`keep`: [{ id, type, value, expected }], value null
// to remove a row, `expected` the row as it was handed in, or null when it was absent, so the caller's own write is
// refused if the row moved meanwhile). Nothing is read from or written to any store here.
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The conflict a write whose `expected` row is not the row now held answers (the code a store's own refusal carries). */
const conflict = () => Object.assign(new Error('The row changed while it was being kept.'), { code: 'original_command_conflict' });

/** The rows handed in, read and changed in memory: read(type, id), readRecord(type, id), list({ type }), write(records), keep(). */
export function rowsHandedIn(records) {
  if (!Array.isArray(records) || !records.every(row => isObject(row) && typeof row.id === 'string' && row.id && typeof row.type === 'string' && row.type)) {
    throw new Error('records is a list of the rows this send works over, each { id, type, value }, read from the person\'s store.');
  }
  const first = new Map(records.map(row => [row.id, { type: row.type, value: structuredClone(row.value ?? null) }]));
  const held = new Map([...first].map(([id, row]) => [id, { type: row.type, value: structuredClone(row.value) }]));
  const touched = new Map();
  const found = (type, id) => (held.get(id)?.type === type ? held.get(id) : null);
  return {
    async read(type, id) { const row = found(type, id); return row ? structuredClone(row.value) : null; },
    async readRecord(type, id) { const row = found(type, id); return row ? { id, type, value: structuredClone(row.value) } : null; },
    async *list({ type }) { for (const [id, row] of [...held].filter(([, row]) => row.type === type)) yield { id, type, value: structuredClone(row.value) }; },
    async write(writes) {
      for (const write of writes) {
        if (write.expected === undefined) continue;
        const row = held.get(write.id);
        if (write.expected === null ? row !== undefined : !(row && row.type === write.expected.type && same(row.value, write.expected.value))) throw conflict();
      }
      for (const write of writes) {
        touched.set(write.id, write.type);
        if (write.value === null) held.delete(write.id); else held.set(write.id, { type: write.type, value: structuredClone(write.value) });
      }
      return { ok: true };
    },
    /** The rows this run changed, as the caller should keep them. */
    keep() {
      return [...touched].map(([id, type]) => {
        const before = first.get(id);
        return { id, type, value: held.get(id)?.value ?? null, expected: before ? { type: before.type, value: before.value } : null };
      }).filter(row => !(row.expected === null && row.value === null) && !(row.expected && same(row.expected.value, row.value) && row.value !== null));
    },
  };
}
