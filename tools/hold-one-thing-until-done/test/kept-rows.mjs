// The person's store after the caller keeps a run's `keep` rows: each row lands only where its expected record is still
// what the run was handed (a null expected is a new record), and a null value removes the record. Made-up rows only.
import { isDeepStrictEqual } from 'node:util';

export function keptAfter(records, keep = []) {
  const held = new Map(records.map(record => [record.id, record]));
  for (const row of keep) {
    const current = held.get(row.id) ?? null;
    const same = row.expected === null || row.expected === undefined ? current === null : isDeepStrictEqual(current?.value, row.expected.value);
    if (!same) throw Object.assign(new Error(`The record ${row.id} changed meanwhile.`), { code: 'original_command_conflict' });
    if (row.value === null) held.delete(row.id);
    else held.set(row.id, { id: row.id, type: row.type, value: row.value });
  }
  return [...held.values()];
}
