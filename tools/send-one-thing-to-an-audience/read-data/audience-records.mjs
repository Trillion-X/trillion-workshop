// The existing records door is the store. A delivery claim compares the exact
// observed record; two independently launched tools cannot both dispatch it.
export function audienceRecords(door) {
  const observed = new Map();
  const typeOf = id => id.startsWith('audience-delivery:') ? id.slice(0, id.lastIndexOf(':')) : id.slice(0, id.indexOf(':'));
  return {
    async read(id) {
      const record = await door.readRecord(typeOf(id), id);
      observed.set(id, record);
      return record?.value ?? null;
    },
    async ids(type) {
      const ids = [];
      for await (const record of door.list({ type })) ids.push(record.id);
      return ids;
    },
    async write(records) {
      const writes = records.map(record => {
        if (!observed.has(record.id)) return record;
        const before = observed.get(record.id);
        return { ...record, expected: before === null ? null : { type: before.type, value: before.value,
          ...(before.identity ? { identity: before.identity } : {}) } };
      });
      const answer = await door.write(writes);
      for (const record of records) observed.set(record.id, { type: record.type, value: structuredClone(record.value) });
      return answer;
    },
    async claim(id, type, value) {
      if (!observed.has(id)) throw new Error('Read the exact delivery before claiming it.');
      const before = observed.get(id);
      const expected = before === null ? null : { type: before.type, value: before.value,
        ...(before.identity ? { identity: before.identity } : {}) };
      try { await door.write([{ id, type, value, expected }]); }
      catch (error) {
        if (error?.code === 'original_command_conflict') return false;
        throw error;
      }
      observed.set(id, { type, value: structuredClone(value) });
      return true;
    },
  };
}
