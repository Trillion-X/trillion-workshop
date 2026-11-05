// Ported from old trillion test/erase-record-route.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. Its second test, the erase_record tool row, runs here as it was against this tool's
// src/record-model-tools.mjs. Not ported here: its first test, which drove POST /records/erase on the retired PersonStore
// (src/person-store.mjs eraseRecord): the route is the engine's now (trillion-rust src/record_value/account_routes.rs,
// records-routes.json), so that test belongs beside it in trillion-rust.
// Decision: source:cmVjb3JkLWVyYXN1cmUtMjAyNi0xMC0xMQ (declared-erasable-fields).
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelAnnotations, modelTools } from '../src/record-model-tools.mjs';

test('erase_record is one tool over that route, marked as destroying what it erases', async () => {
  const calls = [];
  const tool = modelTools((path, input) => { calls.push([path, input]); return { ok: true }; }).find(row => row.name === 'erase_record');
  assert.deepEqual(tool.inputSchema.required, ['record']);
  await tool.run({ record: 'message:x' });
  assert.deepEqual(calls, [['/records/erase', { record: 'message:x' }]]);
  assert.match(tool.description, /Replies and results that quoted it keep their own words\./);
  assert.equal(modelAnnotations.erase_record.destructiveHint, true);
  assert.equal(modelAnnotations.erase_record.readOnlyHint, false);
});
