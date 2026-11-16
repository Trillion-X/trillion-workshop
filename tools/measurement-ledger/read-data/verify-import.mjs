// Pure reconciliation of a prepared import with the account records the caller read from its store. Reads and keeps nothing.
import { isDeepStrictEqual } from 'node:util';
import { observationRecord } from './ledger.mjs';

export async function run(input) {
  if (!Array.isArray(input.observations)) throw new TypeError('observations are required');
  if (!Array.isArray(input.records)) throw new TypeError('records are required: the observation rows the caller read from its store');
  const expectedRows = input.observations.map(observationRecord);
  const expectedById = new Map(expectedRows.map(row => [row.id, row]));
  if (expectedById.size !== expectedRows.length) throw new TypeError('duplicate event IDs in import');
  const missing = [], different = [], seen = new Set();
  let exact = 0;
  for (const actual of input.records) {
    const expected = expectedById.get(actual.id);
    if (!expected) continue;
    if (seen.has(actual.id)) throw new Error('the records repeat an id');
    seen.add(actual.id);
    if (isDeepStrictEqual(actual.value, expected.value)) { exact++; continue; }
    const keys = new Set([...Object.keys(expected.value), ...Object.keys(actual.value ?? {})]);
    different.push({ id: expected.id, fields: [...keys].filter(key => !isDeepStrictEqual(actual.value?.[key], expected.value[key])) });
  }
  for (const row of expectedRows) if (!seen.has(row.id)) missing.push(row.id);
  return { expected: input.observations.length, exact, missing_count: missing.length, different_count: different.length,
    complete: missing.length === 0 && different.length === 0, records_read: input.records.length, missing, different };
}
