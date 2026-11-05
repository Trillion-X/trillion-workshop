// The page route GET /work/api/tell/notices as a Workshop route tool, against the records door stand-in with exactly
// the row's rights. Old trillion answered it with src/tell-the-person.mjs handleTellRequest 'GET /tell/notices' (tag
// old-trillion-before-worker-retire): recent() for the open page, forDevice() with ?channel, 400 for a channel that does
// not exist, 404 for a path it has no row for. The answers are checked against the moved owner over the same notices.
// Made-up notices only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerTellNoticesRoute } from '../do-work/tell-routes.mjs';
import { makeTellThePerson } from '../read-data/tell-the-person.mjs';

const rows = JSON.parse(readFileSync(new URL('../read-data/tell-the-person.json', import.meta.url), 'utf8'));
const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const ROUTE = rowOf(ROWS, 'tool:answer-the-tell-notices-route');
const NOW = new Date('2026-01-10T12:00:00.000Z');
const page = (query = {}, method = 'GET', path = '/tell/notices') => ({ path, method, query, body: {}, browser: { user_agent: 'Sample browser', origin: 'https://app.example', visitor: 'sample' } });

// Three notices the way the person's store keeps them: one shown on the page, one on the page and a Mac, one only on a Mac.
const notices = [
  { seq: 1, key: 'sample:1', kind: rows.default_kind, title: 'First sample notice', body: 'Made up.', open: '/', at: '2026-01-10T10:00:00.000Z', results: { [rows.shown_here]: { sent: true, said: 'Shown in Trillion.' } } },
  { seq: 2, key: 'sample:2', kind: rows.default_kind, title: 'Second sample notice', body: 'Made up.', open: '/', at: '2026-01-10T11:00:00.000Z', read: true, results: { [rows.shown_here]: { sent: true, said: 'Shown in Trillion.' }, 'mac-app': { sent: true, said: 'Queued.' } } },
  { seq: 3, key: 'sample:3', kind: rows.default_kind, title: 'Third sample notice', body: 'Made up.', open: '/', at: '2026-01-10T11:30:00.000Z', results: { 'mac-app': { sent: true, said: 'Queued.' } } },
];
const RECORDS = [
  { id: 'told-the-person', type: 'told-the-person', value: { seqs: [1, 2, 3] } },
  ...notices.map(item => ({ id: `told-the-person:${item.seq}`, type: 'told-the-person', value: { item } })),
];
const moved = () => makeTellThePerson({ rows, senders: {}, now: () => NOW, store: { choices: () => null, notices: () => notices, putNotices: () => {} } });

test('the open page reads the notices its own channel carried, newest first, as the moved owner answers', async () => {
  const run = await answerOf(ROUTE, page(), { records: RECORDS });
  assert.equal(run.status, 0, run.error);
  assert.equal(run.result.status, 200);
  assert.deepEqual(run.result.body, moved().recent());
  assert.deepEqual(run.result.body.notices.map(item => item.id), ['told:2', 'told:1']);
  assert.equal(run.result.body.notices[0].read, true);
});

test('with a channel, its devices read what it carried after `after`, oldest first', async () => {
  const run = await answerOf(ROUTE, page({ channel: 'mac-app', after: '2' }), { records: RECORDS });
  assert.equal(run.result.status, 200);
  assert.deepEqual(run.result.body, moved().forDevice({ channel: 'mac-app', after: '2' }));
  assert.equal(run.result.body.notices.length, 1, 'only what it carried after notice 2');
  const all = await answerOf(ROUTE, page({ channel: 'mac-app' }), { records: RECORDS });
  assert.equal(all.result.body.notices.length, 2);
});

test('a channel that does not exist answers 400 with its words; another path or method 404', async () => {
  const run = await answerOf(ROUTE, page({ channel: 'carrier-pigeon' }), { records: RECORDS });
  assert.equal(run.result.status, 400);
  assert.match(run.result.body.error, /no way to be told called carrier-pigeon/);
  assert.deepEqual(await answerTellNoticesRoute(page({}, 'POST'), { door: null }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await answerTellNoticesRoute(page({}, 'GET', '/tell'), { door: null }), { status: 404, body: { error: 'Not found' } });
});

test('a person with no notices kept reads none', async () => {
  const run = await answerOf(ROUTE, page(), { records: [] });
  assert.deepEqual(run.result, { status: 200, body: { notices: [] } });
});
