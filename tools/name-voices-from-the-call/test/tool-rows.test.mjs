import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { name } from '../read-data/name-from-the-call.mjs';

const [row] = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

test('the row reads only what it is handed and runs the name export', () => {
  assert.deepEqual([row.id, row.invoke.kind, row.invoke.argv.at(-1)], ['tool:name-voices-from-the-call', 'computer', 'name']);
  assert.deepEqual(row.invoke.capabilities, []);
  assert.equal(row.invoke.records, undefined);
});

test('without a name_speaker door handed in, apply is refused and nothing is written', async () => {
  const turns = [{ start: 0, end: 10, who: 'Someone (voice-1)' }];
  const samples = Array.from({ length: 10 }, (_, index) => ({ at: index * 1000 + 600, names: ['Sample Person'] }));
  assert.deepEqual((await name({ turns, samples })).assignments.map(a => a.name), ['Sample Person']);
  await assert.rejects(name({ turns, samples, apply: { app: 'Listening', since: '2026-11-03T09:00:00Z', until: '2026-11-03T09:01:00Z' } }, { door: null }), /caller that holds the name_speaker door/);
});
