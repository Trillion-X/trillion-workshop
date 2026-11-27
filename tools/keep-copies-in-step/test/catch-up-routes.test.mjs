// The page route POST /work/api/catch-up/here as a Workshop route tool, over the device row the request carries. The cases
// are old trillion's for the same route (test/catch-up.test.mjs 'the routes answer through the store road' and 'a device
// is written when what the person sees changes', tag old-trillion-before-worker-retire): a report answers 200, a
// refused report 400 with its words, another path 404, and the same report again is not written. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerCatchUpRoute } from '../do-work/catch-up-routes.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const ROUTE = rowOf(ROWS, 'tool:answer-the-catch-up-here-route');
const DEVICES = 'setting:catch_up_devices';
const SAMPLE = { device_id: 'd-sample01', title: 'Sample laptop', kind: 'computer', state: 'caught-up', waiting: 0, at: '2026-01-10T11:00:00.000Z', seen_at: '2026-01-10T11:00:00.000Z' };
const PERSON = [{ id: DEVICES, type: 'setting', value: { value: [SAMPLE] } }];
const NOW = '2026-01-10T12:00:00.000Z';
const page = (path, method, body = {}, records = PERSON) => ({ path, method, query: {}, body, browser: { user_agent: 'Sample browser', origin: 'https://app.example', visitor: 'sample' }, now: NOW, stored: { records } });

test('the route row runs the workflows runner and declares no records door', () => {
  assert.equal(ROUTE.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.ok(!ROUTE.invoke.files.package_files.some(files => files.package === 'records-door'));
});

test('a device report answers 200 and keeps the device row, newest first, beside the others', async () => {
  const run = await answerCatchUpRoute(page('/catch-up/here', 'POST', { device_id: 'd-1234abcd', state: 'offline' }));
  assert.equal(run.status, 200);
  assert.equal(run.body.written, true);
  assert.equal(run.body.device.device_id, 'd-1234abcd');
  assert.equal(run.body.device.state, 'offline');
  assert.equal(run.keep.length, 1);
  assert.equal(run.keep[0].id, DEVICES);
  assert.deepEqual(run.keep[0].value.value.map(device => device.device_id), ['d-1234abcd', 'd-sample01']);
});

test('the kept row stands on the row as it was handed in', async () => {
  const run = await answerCatchUpRoute(page('/catch-up/here', 'POST', { device_id: 'd-1234abcd', state: 'offline' }));
  assert.deepEqual(run.keep[0].expected, { type: 'setting', value: PERSON[0].value });
  const fresh = await answerCatchUpRoute(page('/catch-up/here', 'POST', { device_id: 'd-1234abcd', state: 'offline' }, []));
  assert.equal(fresh.keep[0].expected, null);
  assert.deepEqual(fresh.keep[0].value.value.map(device => device.device_id), ['d-1234abcd']);
});

test('the same report again is answered and nothing is kept', async () => {
  const report = { device_id: 'd-sample01', title: 'Sample laptop', kind: 'computer', state: 'caught-up', at: '2026-01-10T11:00:00.000Z' };
  const run = await answerCatchUpRoute(page('/catch-up/here', 'POST', report));
  assert.equal(run.status, 200);
  assert.equal(run.body.written, false);
  assert.deepEqual(run.keep, []);
});

test('a refused report answers 400 with the words of what is missing', async () => {
  const run = await answerCatchUpRoute(page('/catch-up/here', 'POST', { device_id: 'x', state: 'caught-up' }));
  assert.equal(run.status, 400);
  assert.match(run.body.error, /which device/);
  const unsaid = await answerCatchUpRoute(page('/catch-up/here', 'POST', { device_id: 'd-1234abcd' }));
  assert.equal(unsaid.status, 400);
  assert.match(unsaid.body.error, /how this device stands/);
  assert.deepEqual(unsaid.keep, []);
});

test('a body that is not JSON answers 400, and another path or method answers 404', async () => {
  const bad = await answerCatchUpRoute(page('/catch-up/here', 'POST', '{not json'));
  assert.equal(bad.status, 400);
  assert.deepEqual(await answerCatchUpRoute(page('/catch-up/nothing', 'GET')), { status: 404, body: { error: 'Not found' }, keep: [] });
  assert.deepEqual(await answerCatchUpRoute(page('/catch-up/here', 'GET')), { status: 404, body: { error: 'Not found' }, keep: [] });
});

test('a report is decided on the device row the request carries, so another device row in it is kept', async () => {
  const other = { device_id: 'd-other999', state: 'waiting', waiting: 1 };
  const run = await answerCatchUpRoute(page('/catch-up/here', 'POST', { device_id: 'd-1234abcd', state: 'offline' }, [{ id: DEVICES, type: 'setting', value: { value: [other] } }]));
  assert.equal(run.status, 200);
  assert.deepEqual(run.keep[0].value.value.map(device => device.device_id), ['d-1234abcd', 'd-other999']);
});
