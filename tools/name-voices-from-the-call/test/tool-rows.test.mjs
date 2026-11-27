import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { name } from '../read-data/name-from-the-call.mjs';

const [row] = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);

test('the row reads only what it is handed and runs the name export', () => {
  assert.deepEqual([row.id, row.invoke.kind, row.invoke.run.at(-1)], ['tool:name-voices-from-the-call', 'computer', 'name']);
  assert.deepEqual(row.invoke.capabilities, []);
  assert.equal(row.invoke.records, undefined);
});

test('apply answers each name as a name_speaker write, and nothing is written without apply', async () => {
  const turns = [{ start: 0, end: 10, who: 'Someone (voice-1)' }];
  const samples = Array.from({ length: 10 }, (_, index) => ({ at: index * 1000 + 600, names: ['Sample Person'] }));
  const plain = await name({ turns, samples });
  assert.deepEqual(plain.assignments.map(a => a.name), ['Sample Person']);
  assert.equal(plain.writes, undefined);
  const applied = await name({ turns, samples, apply: { app: 'Listening', since: '2026-11-03T09:00:00Z', until: '2026-11-03T09:01:00Z' } });
  assert.deepEqual(applied.writes.map(w => [w.tool, w.args.speaker, w.args.name, w.args.app]), [['name_speaker', 'Someone (voice-1)', 'Sample Person', 'Listening']]);
});
