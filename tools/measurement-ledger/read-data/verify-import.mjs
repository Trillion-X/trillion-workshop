// Read-only reconciliation of a prepared import with the real account.
import { isDeepStrictEqual } from 'node:util';
import { observationRecord, OBSERVATION_TYPE } from './ledger.mjs';

export async function run(input, { door }) {
  if (!Array.isArray(input.observations)) throw new TypeError('observations are required');
  const expectedRows = input.observations.map(observationRecord);
  const expectedById = new Map(expectedRows.map(row => [row.id, row]));
  if (expectedById.size !== expectedRows.length) throw new TypeError('duplicate event IDs in import');
  const bound = input.max_records ?? 100000;
  if (!Number.isSafeInteger(bound) || bound < 1) throw new TypeError('max_records must be a positive integer');
  const missing = [], different = [], seen = new Set();
  let exact = 0, account_records_read = 0;
  for await (const actual of door.list({ type: OBSERVATION_TYPE, prefix: 'record:cost-measurement-observation:', limit: 100 })) {
    if (++account_records_read > bound) throw new RangeError('import verification account read bound exceeded');
    const expected = expectedById.get(actual.id);
    if (!expected) continue;
    if (seen.has(actual.id)) throw new Error('the account repeated a record across import verification pages');
    seen.add(actual.id);
    if (isDeepStrictEqual(actual.value, expected.value)) { exact++; continue; }
    const keys = new Set([...Object.keys(expected.value), ...Object.keys(actual.value ?? {})]);
    different.push({ id: expected.id, fields: [...keys].filter(key => !isDeepStrictEqual(actual.value?.[key], expected.value[key])) });
  }
  for (const row of expectedRows) if (!seen.has(row.id)) missing.push(row.id);
  return { expected: input.observations.length, exact, missing_count: missing.length, different_count: different.length,
    complete: missing.length === 0 && different.length === 0, account_records_read, missing, different };
}
