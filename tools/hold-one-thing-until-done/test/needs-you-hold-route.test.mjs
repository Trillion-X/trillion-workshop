// The page routes GET and POST /work/api/needs-you-hold as one Workshop route tool, against the records door
// stand-in with exactly the row's rights. Old trillion answered them at src/worker.mjs:1100-1121 over
// src/native-waiting-account-owner.mjs needsYouHold (tag old-trillion-before-worker-retire): the read with its `said`
// and `words`, busy (503) when the read fails, each change by its old op name answered with the read after it, its jobs
// handed to the person's AIs once. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerNeedsYouHoldRoute } from '../do-work/needs-you-hold-route.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const ROUTE = rowOf(ROWS, 'tool:answer-the-needs-you-hold-route');
const NOW = Date.parse('2026-01-10T12:00:00.000Z');
const RULES = {
  after_minutes: 0,
  rank: [{ by: 'waited_on', field: 'waits_on' }],
  aside: { min_words: 3, minutes: 60, most_per_day: 1, job: 'Weigh why {title} was set aside: {reason}', said: 'Set aside: {title}' },
  hand_back: { min_words: 2, keep_days: 1, ways: [{ id: 'done', label: 'I did my part', job: 'Finish {title}: {reason}', said: 'Handed back: {title}' }] },
  off: { default_stake: 'wait', lasts_minutes: 60, stakes: [{ id: 'wait', label: 'Wait an hour', delay_minutes: 60 }] },
  words: { held: 'Holding: {title}', free: 'Nothing is holding you.', off: 'The hold is off.', no_asides_left: 'Nothing more can be set aside today.' },
};
const setting = (id, value) => ({ id, type: 'setting', value: { value } });
const mustDo = (id, value) => ({ id: `record:waiting-on-you:${id}`, type: 'record:waiting-on-you', value: { added: '2026-01-01T00:00:00.000Z', ...value } });
const PERSON = [
  setting('setting:needs_you_hold_rules', RULES),
  mustDo('pay', { what: 'Pay the sample invoice', do_it_in: '/sample/pay' }),
  mustDo('sign-in', { what: 'Sign in to the sample service', do_it_in: '/sample/sign-in' }),
  mustDo('upload', { what: 'Upload the sample file', do_it_in: '/sample/upload', waits_on: 'sign-in' }),
];
const page = (method, body = {}) => ({ path: '/needs-you-hold', method, query: {}, body, browser: { user_agent: 'Sample browser', origin: 'https://app.example', visitor: 'sample' } });

test('the read answers the one thing held, with what it says and the words', async () => {
  const run = await answerOf(ROUTE, page('GET'), { records: PERSON });
  assert.equal(run.status, 0, run.error);
  assert.equal(run.result.status, 200);
  const view = run.result.body;
  assert.equal(view.held.card.title, 'Sign in to the sample service', 'the row another waits on holds first');
  assert.equal(view.said, 'Holding: Sign in to the sample service');
  assert.deepEqual(view.words, RULES.words);
});

test('nothing waiting answers free in the words of the rules', async () => {
  const run = await answerOf(ROUTE, page('GET'), { records: [PERSON[0]] });
  assert.equal(run.result.status, 200);
  assert.equal(run.result.body.held, null);
  assert.equal(run.result.body.said, 'Nothing is holding you.');
});

test('a read that fails answers busy, as the page retries it', async () => {
  const run = await answerOf(ROUTE, page('GET'), { records: PERSON.slice(1) });
  assert.equal(run.result.status, 503);
  assert.deepEqual(run.result.body, { error: 'Busy for a moment. Try again.', busy: true });
});

test('setting the held thing aside writes the setting, hands its job once and answers the read after it', async () => {
  const body = { op: 'aside', key: 'record:waiting-on-you:sign-in', title: 'Sign in to the sample service', reason: 'the sample service is down today' };
  const run = await answerOf(ROUTE, page('POST', body), { records: PERSON });
  assert.equal(run.result.status, 200, JSON.stringify(run.result.body));
  assert.ok(run.result.body.until, 'the change says until when');
  assert.notEqual(run.result.body.held?.key, 'record:waiting-on-you:sign-in', 'the thing set aside leaves the hold');
  const state = run.kept.find(record => record.id === 'setting:needs_you_hold').value.value;
  assert.ok(state.aside['record:waiting-on-you:sign-in']);
  const jobs = run.kept.filter(record => record.type === 'ai-job');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].value.status, 'waiting');
  assert.equal(jobs[0].value.from, 'ai:trillion-waiting');
  assert.match(jobs[0].value.job, /the sample service is down today/);
});

test('a refused change answers 400 with its words and writes nothing', async () => {
  const run = await answerOf(ROUTE, page('POST', { op: 'aside', key: 'record:waiting-on-you:pay', title: 'Pay', reason: 'no' }), { records: PERSON });
  assert.equal(run.result.status, 400);
  assert.match(run.result.body.error, /at least 3 words/);
  assert.equal(run.kept.find(record => record.id === 'setting:needs_you_hold'), undefined);
  const unknown = await answerOf(ROUTE, page('POST', { op: 'sideways' }), { records: PERSON });
  assert.equal(unknown.result.status, 400);
  assert.match(unknown.result.body.error, /Say what to do/);
});

test('seen names the held thing and changes nothing; read is the read', async () => {
  const door = { readRecord: () => { throw new Error('read'); } };
  assert.deepEqual(await answerNeedsYouHoldRoute(page('POST', { op: 'seen', key: 'thing-1' }), { door }), { status: 200, body: { seen: 'thing-1', read: [] } });
  assert.deepEqual(await answerNeedsYouHoldRoute(page('POST', { op: 'seen' }), { door }), { status: 200, body: { seen: null, read: [] } });
  const run = await answerOf(ROUTE, page('POST', { op: 'read' }), { records: PERSON });
  assert.equal(run.result.body.said, 'Holding: Sign in to the sample service');
});

test('a hold setting changed between the read and the write answers 409 and hands nothing', async () => {
  const writes = [];
  const held = { type: 'setting', value: { value: {} } };
  const door = {
    readRecord: async (type, id) => (id === 'setting:needs_you_hold_rules' ? { type, value: { value: RULES } } : id === 'setting:needs_you_hold' ? held : null),
    list: async function* () { yield PERSON[2]; },
    write: async records => { writes.push(records); throw Object.assign(new Error('changed'), { code: 'original_command_conflict' }); },
  };
  const reply = await answerNeedsYouHoldRoute(page('POST', { op: 'off' }), { door, now: () => NOW });
  assert.equal(reply.status, 409);
  assert.equal(writes.length, 1, 'no job is handed after a refused write');
});

test('another path or method answers 404', async () => {
  assert.deepEqual(await answerNeedsYouHoldRoute({ ...page('GET'), path: '/needs-you-hold/other' }, { door: null }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await answerNeedsYouHoldRoute(page('DELETE'), { door: null }), { status: 404, body: { error: 'Not found' } });
});
