// The page routes GET and POST /work/api/needs-you-hold as one Workshop route tool. It reads and writes no store: the
// records come in as stored.records, and what it would keep (keep) and the device runs it would start (runs) come back.
// Old trillion answered them at src/worker.mjs:1100-1121 over src/native-waiting-account-owner.mjs needsYouHold (tag
// old-trillion-before-worker-retire): the read with its `said` and `words`, busy (503) when the read fails, each change by
// its old op name answered with the read after it, its jobs handed to the person's AIs once. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerNeedsYouHoldRoute } from '../do-work/needs-you-hold-route.mjs';
import { answerOfRows } from '../do-work/hold.mjs';
import { makeTellThePerson } from '../../tell-one-person-something-through-every-way-they/read-data/tell-the-person.mjs';
import tellRows from '../../tell-one-person-something-through-every-way-they/read-data/tell-the-person.json' with { type: 'json' };
import { keptAfter } from './kept-rows.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const ROUTE = rowOf(ROWS, 'tool:answer-the-needs-you-hold-route');
const NOW = Date.parse('2026-01-10T12:00:00.000Z');
const HELD_ID = 'setting:needs_you_held';
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
// Free-state assertions use this explicit complete synthetic scope. Known held facts also exercise the current
// default adapter, whose partial coverage cannot establish that the whole person is free.
const completePage = (method, records, body = {}) => ({ ...page(method, body), things: {
  ...answerOfRows(records.filter(record => record.type === 'record:waiting-on-you')), complete: true,
} });

// One run of the route over the records handed in: the answer, and the store after its keep rows land.
async function answer(input, records) {
  const result = await answerNeedsYouHoldRoute({ ...input, stored: { records } }, { now: () => NOW });
  return { result, status: result.status, body: result.body, runs: result.runs ?? [], keep: result.keep ?? [], kept: keptAfter(records, result.keep) };
}
const heldOf = kept => kept.find(record => record.id === HELD_ID)?.value?.value;

test('the row declares no records door, and the route reads only the records it is handed', async () => {
  assert.equal(ROUTE.invoke.records, undefined);
  assert.equal(ROUTE.invoke.run[1], '/opt/hold-one-thing-until-done/do-work/run-given.mjs');
  const run = await answer(page('GET'), []);
  assert.equal(run.status, 503, 'with no setting handed in there are no rules to read, so the read is busy');
  assert.deepEqual(run.keep, []);
});

test('the read answers the one thing held, with what it says and the words', async () => {
  const run = await answer(page('GET'), PERSON);
  assert.equal(run.status, 200);
  assert.equal(run.body.held.card.title, 'Sign in to the sample service', 'the row another waits on holds first');
  assert.equal(run.body.said, 'Holding: Sign in to the sample service');
  assert.deepEqual(run.body.words, RULES.words);
});

test('nothing waiting answers free in the words of the rules', async () => {
  const run = await answer(completePage('GET', []), [PERSON[0]]);
  assert.equal(run.status, 200);
  assert.equal(run.body.held, null);
  assert.equal(run.body.said, 'Nothing is holding you.');
});

test('a read that fails answers busy, as the page retries it', async () => {
  const run = await answer(page('GET'), PERSON.slice(1));
  assert.equal(run.status, 503);
  assert.deepEqual(run.body, { error: 'Busy for a moment. Try again.', busy: true });
  assert.deepEqual(run.keep, [], 'a failed read keeps nothing');
});

test('setting the held thing aside keeps the setting and its job once, and answers the read after it', async () => {
  const body = { op: 'aside', key: 'record:waiting-on-you:sign-in', title: 'Sign in to the sample service', reason: 'the sample service is down today' };
  const run = await answer(page('POST', body), PERSON);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.until, 'the change says until when');
  assert.notEqual(run.body.held?.key, 'record:waiting-on-you:sign-in', 'the thing set aside leaves the hold');
  const state = run.kept.find(record => record.id === 'setting:needs_you_hold').value.value;
  assert.ok(state.aside['record:waiting-on-you:sign-in']);
  const jobs = run.keep.filter(row => row.type === 'calendar-task');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].value.status, 'To do');
  assert.equal(jobs[0].value.sent_by, null);
  assert.equal(jobs[0].value.producer.ref, 'setting:needs_you_hold');
  assert.match(jobs[0].value.source_task, /^hold-aside:/);
  assert.match(jobs[0].value.description, /the sample service is down today/);
  assert.equal(run.keep.find(row => row.id === 'setting:needs_you_hold').expected, null, 'the setting was not handed in, so it is kept as new');
});

test('a refused change answers 400 with its words and keeps nothing', async () => {
  const run = await answer(page('POST', { op: 'aside', key: 'record:waiting-on-you:pay', title: 'Pay', reason: 'no' }), PERSON);
  assert.equal(run.status, 400);
  assert.match(run.body.error, /at least 3 words/);
  assert.deepEqual(run.keep, []);
  const unknown = await answer(page('POST', { op: 'sideways' }), PERSON);
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Say what to do/);
});

test('the read keeps the held thing as setting:needs_you_held, kept again only when it changed', async () => {
  const run = await answer(page('GET'), PERSON);
  assert.deepEqual(heldOf(run.kept), { key: 'record:waiting-on-you:sign-in', title: 'Sign in to the sample service' });
  const again = await answer(page('GET'), run.kept);
  assert.equal(again.status, 200);
  assert.deepEqual(again.keep.filter(row => row.id === HELD_ID), [], 'the same thing held is not kept again');
  const held = run.kept.find(record => record.id === HELD_ID);
  const free = await answer(completePage('GET', []), [PERSON[0], held]);
  assert.equal(free.keep.find(row => row.id === HELD_ID).value.value, null, 'nothing held any more is kept as null');
  assert.equal(heldOf(free.kept), null);
});

// Old keepHeld (src/native-waiting-account-owner.mjs:440-451 at the tag): a new thing held runs `hold.devices.when_held`
// once, each input filled with the held thing; nothing held any more runs `when_free`; the same thing held runs nothing.
// Each run is answered in `runs` with its key; the caller starts it after the setting it follows is kept.
test('a new thing held starts the when_held device tools, nothing held any more starts when_free, the same thing nothing', async () => {
  const devices = {
    when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: { id: 'needs-you-hold', only: ['Trillion'] } }, { tool_id: 'tool:take-me-there', input: { thing: '{key}', say: { title: '{title}' }, key: 'hold:{key}' } }],
    when_free: [{ tool_id: 'tool:release-a-device', input: { id: 'needs-you-hold' } }],
  };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), ...PERSON.slice(1)];
  const run = await answer(page('GET'), records);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(run.runs.map(({ tool_id, input }) => ({ tool_id, input })), [
    { tool_id: 'tool:hold-a-device-quiet', input: { id: 'needs-you-hold', only: ['Trillion'] } },
    { tool_id: 'tool:take-me-there', input: { thing: 'record:waiting-on-you:sign-in', say: { title: 'Sign in to the sample service' }, key: 'hold:record:waiting-on-you:sign-in' } },
  ]);
  assert.equal(run.runs[0].key, `native-hold-devices:tool:hold-a-device-quiet:record:waiting-on-you:sign-in:${run.kept.find(record => record.id === HELD_ID).value.held_transition}`);
  const again = await answer(page('GET'), run.kept);
  assert.deepEqual(again.runs, [], 'the same thing held starts nothing');
  const done = run.kept.filter(record => record.type !== 'record:waiting-on-you');
  const free = await answer(completePage('GET', done), done);
  assert.deepEqual(free.runs.map(({ tool_id, input }) => ({ tool_id, input })), [{ tool_id: 'tool:release-a-device', input: { id: 'needs-you-hold' } }]);
  const never = await answer(page('GET'), [setting('setting:needs_you_hold_rules', { ...RULES, devices })]);
  assert.deepEqual(never.runs, [], 'nothing held before and nothing now starts nothing');
});

test('repeated held/free cycles and recreated settings each start their device tools once per transition', async () => {
  const devices = { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: {} }], when_free: [{ tool_id: 'tool:release-a-device', input: {} }] };
  let records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), PERSON[2]];
  const effects = [];
  const keys = new Set();
  const show = async held => {
    const run = await answer(completePage('GET', held ? records : records.slice(0, 1)), records);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    records = run.kept;
    for (const item of run.runs) { effects.push(item.tool_id); keys.add(item.key); }
    assert.equal(heldOf(records)?.key ?? null, held ? PERSON[2].id : null);
  };
  for (const held of [true, false, true, false, true]) await show(held);
  await show(true);
  records = records.filter(record => record.id !== HELD_ID);
  await show(true);
  records = records.map(record => (record.id === HELD_ID ? setting(HELD_ID, null) : record));
  await show(true);
  assert.deepEqual(effects, ['tool:hold-a-device-quiet', 'tool:release-a-device', 'tool:hold-a-device-quiet', 'tool:release-a-device', 'tool:hold-a-device-quiet', 'tool:hold-a-device-quiet', 'tool:hold-a-device-quiet']);
  assert.equal(keys.size, 7, 'each transition has its own key, even at the same time and target');
});

test('a held setting that moved since the read is refused by the store, so its device runs are not started', async () => {
  const devices = { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: {} }] };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), PERSON[2]];
  const run = await answer(completePage('GET', records), records);
  assert.equal(run.runs.length, 1);
  for (const moved of [[...records, setting(HELD_ID, { key: 'other', title: 'A concurrent hold' })], [...records, setting(HELD_ID, null)]]) {
    assert.throws(() => keptAfter(moved, run.keep), /changed meanwhile/);
  }
});

test('partial empty coverage keeps the persisted held fact and devices; an explicit off may release them', async () => {
  const held = setting(HELD_ID, { key: 'record:waiting-on-you:sample', title: 'A known held sample' });
  const devices = { when_free: [{ tool_id: 'tool:release-a-device', input: { id: 'needs-you-hold' } }] };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), held];
  const partial = await answer(page('GET'), records);
  assert.equal(partial.body.waiting_sources.complete, false);
  assert.equal(partial.body.on, true);
  assert.equal(partial.body.held, null);
  assert.notEqual(partial.body.said, 'Nothing is holding you.');
  assert.deepEqual(partial.runs, []);
  assert.equal(partial.keep.find(row => row.id === HELD_ID), undefined, 'the persisted held fact is not kept again');
  const off = await answer(page('GET'), [...records, setting('setting:needs_you_hold', { on: false })]);
  assert.equal(off.body.on, false);
  assert.equal(off.body.waiting_sources.complete, false);
  assert.deepEqual(off.runs.map(({ tool_id, input }) => ({ tool_id, input })), [{ tool_id: 'tool:release-a-device', input: { id: 'needs-you-hold' } }]);
  assert.equal(off.keep.find(row => row.id === HELD_ID).value.value, null);
});

test('every device tool is answered in runs, declared or not, and the read still answers', async () => {
  const devices = { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: {} }, { tool_id: 'tool:not-declared', input: {} }, { tool_id: 'tool:take-me-there', input: { thing: '{key}' } }] };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), ...PERSON.slice(1)];
  const run = await answer(page('GET'), records);
  assert.equal(run.status, 200);
  assert.deepEqual(run.runs.map(item => item.tool_id), ['tool:hold-a-device-quiet', 'tool:not-declared', 'tool:take-me-there'], 'the caller refuses a tool it does not run');
});

// Old src/native-waiting-account-owner.mjs reader: every card is weighed by the doer gate (src/waiting-weigh.mjs over
// src/who-does-it.mjs) before the person sees it, and one Trillion can do, or one with nothing to press, is left out of
// the person's view (its hand-off goes to the AIs from the nudge's own wake, runDue, not from this read). The hold's
// prepareForHold then weighs what waited long enough again and hands what it finds once per card.
test('a waiting row Trillion can do, or with nothing to press, is not held; one only the person can do is', async () => {
  const records = [PERSON[0],
    mustDo('draft', { what: 'Draft the sample reply', needs: 'write a draft', added: '2026-01-01T00:00:00.000Z' }),
    mustDo('nothing', { what: 'Think about the sample', finish: 'Tap done' }),
    mustDo('body', { what: 'Sign the sample form by hand', needs: 'sign by hand', reason_id: 'their-own-body', do_it_in: '/sample/sign' })];
  const run = await answer(page('GET'), records);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.held.key, 'record:waiting-on-you:body');
  assert.deepEqual(run.body.ranked.map(thing => thing.key), ['record:waiting-on-you:body'], 'the AI-doable and the uncontrollable rows are left out');
  assert.equal(run.keep.filter(row => row.type === 'calendar-task').length, 2, 'removed cards are kept as tasks before leaving the person\'s view');
});

test('a completion button remains a valid control for an explicit physical step without a screen address', async () => {
  const records = [PERSON[0], mustDo('physical-step', { what: 'Sign the sample form by hand', needs: 'sign by hand',
    reason_id: 'their-own-body', finish: 'Tap done' })];
  const run = await answer(page('GET'), records);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.held.key, 'record:waiting-on-you:physical-step');
  assert.equal(run.keep.filter(row => row.type === 'calendar-task').length, 0);
});

test('prepareForHold hands what it weighs to the AIs once per card, and the hold is weighed over the rest', async () => {
  const { makeWaitingNudge } = await import('../read-data/waiting-nudge.mjs');
  const WAITING = JSON.parse(readFileSync(new URL('../read-data/waiting-on-you.json', import.meta.url), 'utf8'));
  const handed = [];
  const nudge = makeWaitingNudge({ read: async () => null, tell: async () => null, handOff: async job => { handed.push(job); },
    weigh: () => ({ steps: [{ who: 'trillion', said: 'Trillion can.', doers: [{ id: 'your-ais' }], uncovered: [] }] }),
    kept: { read: () => null, write: () => {} }, alongside: async () => null, settings: { ...WAITING, hold: { ...WAITING.hold, ...RULES } }, now: () => NOW });
  const card = { id: 'record:waiting-on-you:draft', title: 'Draft the sample reply', needs: 'write a draft', does_in: '/sample/draft', at: '2026-01-01T00:00:00.000Z' };
  const fresh = { ...card, id: 'record:waiting-on-you:fresh', at: new Date(NOW).toISOString() };
  const prepared = await nudge.prepareForHold({ sections: [{ id: 'asks', cards: [card, fresh] }] }, 60);
  assert.deepEqual(prepared.handed, ['record:waiting-on-you:draft'], 'only what waited long enough');
  assert.equal(handed[0].once_per, 'weighed:record:waiting-on-you:draft');
  assert.match(handed[0].job, /Draft the sample reply/);
});

test('seen marks read the notices the held thing\'s device runs told, on this page, from the thing; read is the read', async () => {
  const rules = { ...RULES, devices: { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: { id: 'needs-you-hold' } }, { tool_id: 'tool:take-me-there', input: { thing: '{key}', key: 'hold:{key}' } }] } };
  const told = (seq, key) => ({ id: `told-the-person:${seq}`, type: 'told-the-person', value: { item: { seq, key, kind: 'update', title: `Sample ${seq}`, at: '2026-01-10T11:00:00.000Z', results: { 'in-app': { sent: true, said: 'Shown in Trillion.' } } } } });
  const records = [setting('setting:needs_you_hold_rules', rules), ...PERSON.slice(1),
    { id: 'told-the-person', type: 'told-the-person', value: { seqs: [1, 2] } }, told(1, 'hold:record:waiting-on-you:sign-in'), told(2, 'another')];
  const run = await answer(page('POST', { op: 'seen', key: 'record:waiting-on-you:sign-in', device_id: 'browser-sample' }), records);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.seen, 'record:waiting-on-you:sign-in');
  assert.deepEqual(run.body.read.map(item => item.ids), [['told:1']], 'only the take-me-there notice names the thing');
  const one = run.kept.find(record => record.id === 'told-the-person:1').value.item;
  assert.equal(one.read, true);
  assert.deepEqual({ ...one.read_on, at: undefined }, { channel: 'in-app', device_id: 'browser-sample', from: 'thing', at: undefined });
  assert.equal(run.kept.find(record => record.id === 'told-the-person:2').value.item.read, undefined, 'another notice stays as it was');
  const nothing = await answerNeedsYouHoldRoute(page('POST', { op: 'seen' }));
  assert.deepEqual({ status: nothing.status, body: nothing.body }, { status: 200, body: { seen: null, read: [] } });
  const read = await answer(page('POST', { op: 'read' }), PERSON);
  assert.equal(read.body.said, 'Holding: Sign in to the sample service');
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
  records = (await answer(page('POST', { op: 'seen', key: 'asks:mom', device_id: 'd-page-in-app' }), records)).kept;
  assert.equal(item().read_on.from, 'thing');
  // The phone's own read, as the moved owner keeps it.
  let notices = [item()];
  const tell = makeTellThePerson({ rows: tellRows, senders: {}, store: { choices: () => null, notices: () => notices, putNotices: list => { notices = list; } } });
  tell.markRead({ ids: ['told:1'], on: { channel: 'phone', device_id: 'apns-phone-1' } });
  assert.deepEqual([notices[0].read_on.channel, notices[0].read_on.device_id, notices[0].read_on.from], ['phone', 'apns-phone-1', undefined]);
  records = records.map(record => (record.id === 'told-the-person:1' ? { ...record, value: { item: notices[0] } } : record));
  records = (await answer(page('POST', { op: 'seen', key: 'asks:mom', device_id: 'd-page-2' }), records)).kept;
  assert.equal(item().read_on.device_id, 'apns-phone-1');
});

test('a hold setting changed between the read and the write is kept with what was read, so the store refuses it', async () => {
  const held = setting('setting:needs_you_hold', {});
  const records = [setting('setting:needs_you_hold_rules', RULES), PERSON[2], held];
  const reply = await answer(page('POST', { op: 'off' }), records);
  assert.equal(reply.status, 200);
  const row = reply.keep.find(item => item.id === 'setting:needs_you_hold');
  assert.deepEqual(row.expected, { type: 'setting', value: held.value }, 'the row names the setting it was changed from');
  const moved = records.map(record => (record.id === 'setting:needs_you_hold' ? setting('setting:needs_you_hold', { on: true }) : record));
  assert.throws(() => keptAfter(moved, reply.keep), /changed meanwhile/);
});

test('another path or method answers 404', async () => {
  assert.deepEqual(await answerNeedsYouHoldRoute({ ...page('GET'), path: '/needs-you-hold/other' }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await answerNeedsYouHoldRoute(page('DELETE')), { status: 404, body: { error: 'Not found' } });
});
