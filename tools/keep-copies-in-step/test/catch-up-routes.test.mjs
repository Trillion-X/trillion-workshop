// The page route POST /work/api/catch-up/here as a Workshop route tool, against the records door stand-in. The cases
// are old trillion's for the same route (test/catch-up.test.mjs 'the routes answer through the store road' and 'a device
// is written when what the person sees changes', tag old-trillion-before-worker-retire): a report answers 200, a
// refused report 400 with its words, another path 404, and the same report again is not written. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerCatchUpRoute } from '../do-work/catch-up-routes.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const ROUTE = rowOf(ROWS, 'tool:answer-the-catch-up-here-route');
const DEVICES = 'setting:catch_up_devices';
const PERSON = [
  { id: DEVICES, type: 'setting', value: { value: [{ device_id: 'd-sample01', title: 'Sample laptop', kind: 'computer', state: 'caught-up', waiting: 0, at: '2026-01-10T11:00:00.000Z', seen_at: '2026-01-10T11:00:00.000Z' }] } },
];
const page = (path, method, body = {}) => ({ path, method, query: {}, body, browser: { user_agent: 'Sample browser', origin: 'https://app.example', visitor: 'sample' } });

test('a device report answers 200 with the device kept, newest first, beside the others', async () => {
  const run = await answerOf(ROUTE, page('/catch-up/here', 'POST', { device_id: 'd-1234abcd', state: 'offline' }), { records: PERSON });
  assert.equal(run.status, 0);
  assert.equal(run.result.status, 200);
  assert.equal(run.result.body.written, true);
  assert.equal(run.result.body.device.device_id, 'd-1234abcd');
  assert.equal(run.result.body.device.state, 'offline');
  const rows = run.kept.find(record => record.id === DEVICES).value.value;
  assert.deepEqual(rows.map(device => device.device_id), ['d-1234abcd', 'd-sample01']);
});

test('the same report again is answered and not written again', async () => {
  const report = { device_id: 'd-sample01', title: 'Sample laptop', kind: 'computer', state: 'caught-up', at: '2026-01-10T11:00:00.000Z' };
  const run = await answerOf(ROUTE, page('/catch-up/here', 'POST', report), { records: PERSON });
  assert.equal(run.result.status, 200);
  assert.equal(run.result.body.written, false);
});

test('a refused report answers 400 with the words of what is missing', async () => {
  const run = await answerOf(ROUTE, page('/catch-up/here', 'POST', { device_id: 'x', state: 'caught-up' }), { records: PERSON });
  assert.equal(run.result.status, 400);
  assert.match(run.result.body.error, /which device/);
  const unsaid = await answerOf(ROUTE, page('/catch-up/here', 'POST', { device_id: 'd-1234abcd' }), { records: PERSON });
  assert.equal(unsaid.result.status, 400);
  assert.match(unsaid.result.body.error, /how this device stands/);
});

test('a body that is not JSON answers 400, and another path or method answers 404', async () => {
  const bad = await answerCatchUpRoute(page('/catch-up/here', 'POST', '{not json'), { door: null });
  assert.equal(bad.status, 400);
  assert.deepEqual(await answerCatchUpRoute(page('/catch-up/nothing', 'GET'), { door: null }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await answerCatchUpRoute(page('/catch-up/here', 'GET'), { door: null }), { status: 404, body: { error: 'Not found' } });
});

test('a report another device changed meanwhile is decided again on the rows as they are now', async () => {
  let reads = 0;
  const written = [];
  const door = {
    readRecord: async () => ({ type: 'setting', value: { value: reads++ === 0 ? [] : [{ device_id: 'd-other999', state: 'waiting', waiting: 1 }] } }),
    write: async records => {
      if (written.length === 0) { written.push(null); throw Object.assign(new Error('changed'), { code: 'original_command_conflict' }); }
      written.push(records);
    },
  };
  const reply = await answerCatchUpRoute(page('/catch-up/here', 'POST', { device_id: 'd-1234abcd', state: 'offline' }), { door, now: () => Date.parse('2026-01-10T12:00:00.000Z') });
  assert.equal(reply.status, 200);
  assert.deepEqual(written[1][0].value.value.map(device => device.device_id), ['d-1234abcd', 'd-other999']);
});
