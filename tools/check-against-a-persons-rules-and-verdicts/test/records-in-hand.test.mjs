// tools/check-against-a-persons-rules-and-verdicts: the rows a check is handed (do-work/records-in-hand.mjs). Leaving the rows
// out is a refusal, never an empty store; an explicit [] is an empty store that was read. A guard that takes its rows as
// input must not pass silently when they are left out (rule a-guard-cannot-be-skipped-by-leaving-its-input-out).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { recordsHandedIn } from '../do-work/records-in-hand.mjs';

const folder = resolve(import.meta.dirname, '..');
const run = (argv, input) => spawnSync(process.execPath, argv, { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });

test('rows left out (undefined) are refused with a plain message, not read as an empty store', () => {
  assert.throws(() => recordsHandedIn(undefined), /records is missing: send the rows read from the person's store as records, or \[\]/);
});

test('an explicit empty list is an empty store that was read, and goes through', () => {
  assert.deepEqual(recordsHandedIn([]), []);
});

test('rows handed in are returned as they are, and a row without id, type or value is refused', () => {
  const rows = [{ id: 'made-up-1', type: 'record:check', value: {} }];
  assert.equal(recordsHandedIn(rows), rows);
  assert.throws(() => recordsHandedIn([{ id: 7, type: 'record:check', value: {} }]), /each \{ id, type, value \}/);
  assert.throws(() => recordsHandedIn(null), /each \{ id, type, value \}/);
});

test('the check-every-piece-is-covered tool refuses a request with no records; an explicit empty list reaches the sweep and is refused for having no piece rows', () => {
  const left = run(['do-work/check-against-their-rules-and-verdicts.mjs', 'check-every-piece-is-covered'], { file: 'made-up.md' });
  assert.equal(left.status, 1);
  assert.match(JSON.parse(left.stdout.trim().split('\n').at(-1)).error, /records is missing/);
  const empty = run(['do-work/check-against-their-rules-and-verdicts.mjs', 'check-every-piece-is-covered'], { records: [] });
  assert.equal(empty.status, 1);
  const message = JSON.parse(empty.stdout.trim().split('\n').at(-1)).error;
  assert.match(message, /no piece rows/);
  assert.doesNotMatch(message, /records is missing/);
});
