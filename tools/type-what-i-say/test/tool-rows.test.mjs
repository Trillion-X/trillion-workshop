import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dictate, typeDictatedText } from '../read-data/dictation.mjs';

const rows = Object.fromEntries(JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => [record.payload.id, record.payload]));

test('dictate holds only the granted folder; typing at the cursor also names the capability it needs', () => {
  assert.deepEqual(rows['tool:dictate'].invoke.capabilities, ['change-a-folder']);
  assert.deepEqual(rows['tool:type-dictated-text'].invoke.capabilities, ['change-a-folder', 'type-into-the-front-app']);
  for (const row of Object.values(rows)) assert.deepEqual(row.invoke.stdin.folder, { fill: { from: 'task', field: 'grants.change-a-folder.folder' } });
});

test('the exports keep rows in the granted folder, refuse without one, and send insert to its own row', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'dictation-'));
  await dictate({ input: { action: 'add', from: 'sample co', to: 'SampleCo' }, folder });
  assert.equal((await dictate({ input: { action: 'clean', text: 'hello sample co' }, folder })).text, 'hello SampleCo');
  assert.ok(readFileSync(path.join(folder, 'rows.json'), 'utf8').includes('SampleCo'));
  await assert.rejects(dictate({ input: { action: 'list' } }), /Grant a folder/);
  await assert.rejects(dictate({ input: { action: 'insert', text: 'x' }, folder }), /tool:type-dictated-text/);
  await assert.rejects(typeDictatedText({ input: { text: 'x' } }), /Grant a folder/);
});
