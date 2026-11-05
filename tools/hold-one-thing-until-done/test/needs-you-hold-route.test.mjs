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
import { makeTellThePerson } from '../../tell-one-person-something-through-every-way-they/read-data/tell-the-person.mjs';
import tellRows from '../../tell-one-person-something-through-every-way-they/read-data/tell-the-person.json' with { type: 'json' };

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

test('the read keeps the held thing as setting:needs_you_held, written again only when it changed', async () => {
  const run = await answerOf(ROUTE, page('GET'), { records: PERSON });
  const held = run.kept.find(record => record.id === 'setting:needs_you_held');
  assert.deepEqual(held.value.value, { key: 'record:waiting-on-you:sign-in', title: 'Sign in to the sample service' });
  const writes = [];
  const kept = new Map(run.kept.map(record => [record.id, record]));
  const door = {
    readRecord: async (type, id) => { const record = kept.get(id); return record ? { type: record.type, value: record.value } : null; },
    list: async function* ({ type }) { for (const record of kept.values()) if (record.type === type) yield record; },
    write: async records => { writes.push(records); },
  };
  const again = await answerNeedsYouHoldRoute(page('GET'), { door, now: () => NOW });
  assert.equal(again.status, 200);
  assert.deepEqual(writes, [], 'the same thing held is not written again');
  const free = await answerOf(ROUTE, page('GET'), { records: [PERSON[0], held] });
  assert.equal(free.kept.find(record => record.id === 'setting:needs_you_held').value.value, null, 'nothing held any more is kept as null');
});

// Old keepHeld (src/native-waiting-account-owner.mjs:440-451 at the tag): a new thing held runs `hold.devices.when_held`
// once, each input filled with the held thing; nothing held any more runs `when_free`; the same thing held runs nothing.
// Each run is another Workshop tool the row declares in `runs`, started through the run's door.
test('a new thing held starts the when_held device tools, nothing held any more starts when_free, the same thing nothing', async () => {
  const devices = {
    when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: { id: 'needs-you-hold', only: ['Trillion'] } }, { tool_id: 'tool:take-me-there', input: { thing: '{key}', say: { title: '{title}' }, key: 'hold:{key}' } }],
    when_free: [{ tool_id: 'tool:release-a-device', input: { id: 'needs-you-hold' } }],
  };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), ...PERSON.slice(1)];
  const run = await answerOf(ROUTE, page('GET'), { records });
  assert.equal(run.result.status, 200, JSON.stringify(run.result.body));
  assert.deepEqual(run.runs.map(({ tool, input }) => ({ tool, input })), [
    { tool: 'tool:hold-a-device-quiet', input: { id: 'needs-you-hold', only: ['Trillion'] } },
    { tool: 'tool:take-me-there', input: { thing: 'record:waiting-on-you:sign-in', say: { title: 'Sign in to the sample service' }, key: 'hold:record:waiting-on-you:sign-in' } },
  ]);
  assert.match(run.runs[0].key, /^native-hold-devices:tool:hold-a-device-quiet:record:waiting-on-you:sign-in:\d+$/);
  const again = await answerOf(ROUTE, page('GET'), { records: run.kept });
  assert.deepEqual(again.runs, [], 'the same thing held starts nothing');
  const done = run.kept.filter(record => record.type !== 'record:waiting-on-you');
  const free = await answerOf(ROUTE, page('GET'), { records: done });
  assert.deepEqual(free.runs.map(({ tool, input }) => ({ tool, input })), [{ tool: 'tool:release-a-device', input: { id: 'needs-you-hold' } }]);
  const never = await answerOf(ROUTE, page('GET'), { records: [setting('setting:needs_you_hold_rules', { ...RULES, devices })] });
  assert.deepEqual(never.runs, [], 'nothing held before and nothing now starts nothing');
});

test('a device tool that fails or is refused is let go: the read still answers', async () => {
  const devices = { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: {} }, { tool_id: 'tool:not-declared', input: {} }, { tool_id: 'tool:take-me-there', input: { thing: '{key}' } }] };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), ...PERSON.slice(1)];
  const run = await answerOf(ROUTE, page('GET'), { records, tool_runs: { 'tool:hold-a-device-quiet': new Error('tool_unavailable') } });
  assert.equal(run.result.status, 200);
  assert.deepEqual(run.runs.map(item => item.tool), ['tool:hold-a-device-quiet', 'tool:take-me-there'], 'an undeclared tool is refused by the door');
});

test('seen marks read the notices the held thing\'s device runs told, on this page, from the thing; read is the read', async () => {
  const rules = { ...RULES, devices: { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: { id: 'needs-you-hold' } }, { tool_id: 'tool:take-me-there', input: { thing: '{key}', key: 'hold:{key}' } }] } };
  const told = (seq, key) => ({ id: `told-the-person:${seq}`, type: 'told-the-person', value: { item: { seq, key, kind: 'update', title: `Sample ${seq}`, at: '2026-01-10T11:00:00.000Z', results: { 'in-app': { sent: true, said: 'Shown in Trillion.' } } } } });
  const records = [setting('setting:needs_you_hold_rules', rules), ...PERSON.slice(1),
    { id: 'told-the-person', type: 'told-the-person', value: { seqs: [1, 2] } }, told(1, 'hold:record:waiting-on-you:sign-in'), told(2, 'another')];
  const run = await answerOf(ROUTE, page('POST', { op: 'seen', key: 'record:waiting-on-you:sign-in', device_id: 'browser-sample' }), { records });
  assert.equal(run.result.status, 200, JSON.stringify(run.result.body));
  assert.equal(run.result.body.seen, 'record:waiting-on-you:sign-in');
  assert.deepEqual(run.result.body.read.map(item => item.ids), [['told:1']], 'only the take-me-there notice names the thing');
  const one = run.kept.find(record => record.id === 'told-the-person:1').value.item;
  assert.equal(one.read, true);
  assert.deepEqual({ ...one.read_on, at: undefined }, { channel: 'in-app', device_id: 'browser-sample', from: 'thing', at: undefined });
  assert.equal(run.kept.find(record => record.id === 'told-the-person:2').value.item.read, undefined, 'another notice stays as it was');
  const door = { readRecord: () => { throw new Error('read'); } };
  assert.deepEqual(await answerNeedsYouHoldRoute(page('POST', { op: 'seen' }), { door }), { status: 200, body: { seen: null, read: [] } });
  const read = await answerOf(ROUTE, page('POST', { op: 'read' }), { records: PERSON });
  assert.equal(read.result.body.said, 'Holding: Sign in to the sample service');
});

// Old trillion test/needs-you-hold.test.mjs 'a tap on the phone's notice is where the held thing was seen, even when the
// page it brought forward said so first', on the route: the page's seen marks it read from the thing; the phone's own
// read on a way that carried it replaces that surface; a later seen on another page moves nothing.
test('a tap on the phone\'s notice is where the held thing was seen, even when the page it brought forward said so first', async () => {
  const rules = { ...RULES, devices: { when_held: [{ tool_id: 'tool:take-me-there', input: { thing: '{key}', key: 'hold:{key}' } }] } };
  const notice = { seq: 1, key: 'hold:asks:mom', kind: 'update', title: 'Reply to Mom', at: '2026-01-10T11:00:00.000Z',
    results: { 'in-app': { sent: true, said: 'Shown in Trillion.' }, phone: { sent: true, said: 'Sent.' } } };
  let records = [setting('setting:needs_you_hold_rules', rules),
    { id: 'told-the-person', type: 'told-the-person', value: { seqs: [1] } }, { id: 'told-the-person:1', type: 'told-the-person', value: { item: notice } }];
  const item = () => records.find(record => record.id === 'told-the-person:1').value.item;
  records = (await answerOf(ROUTE, page('POST', { op: 'seen', key: 'asks:mom', device_id: 'd-page-in-app' }), { records })).kept;
  assert.equal(item().read_on.from, 'thing');
  // The phone's own read, as the moved owner keeps it.
  let notices = [item()];
  const tell = makeTellThePerson({ rows: tellRows, senders: {}, store: { choices: () => null, notices: () => notices, putNotices: list => { notices = list; } } });
  tell.markRead({ ids: ['told:1'], on: { channel: 'phone', device_id: 'apns-phone-1' } });
  assert.deepEqual([notices[0].read_on.channel, notices[0].read_on.device_id, notices[0].read_on.from], ['phone', 'apns-phone-1', undefined]);
  records = records.map(record => (record.id === 'told-the-person:1' ? { ...record, value: { item: notices[0] } } : record));
  records = (await answerOf(ROUTE, page('POST', { op: 'seen', key: 'asks:mom', device_id: 'd-page-2' }), { records })).kept;
  assert.equal(item().read_on.device_id, 'apns-phone-1');
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
