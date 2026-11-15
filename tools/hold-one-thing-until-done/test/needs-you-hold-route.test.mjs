// The page routes GET and POST /work/api/needs-you-hold as one Workshop route tool, against the records door
// stand-in with exactly the row's rights. Old trillion answered them at src/worker.mjs:1100-1121 over
// src/native-waiting-account-owner.mjs needsYouHold (tag old-trillion-before-worker-retire): the read with its `said`
// and `words`, busy (503) when the read fails, each change by its old op name answered with the read after it, its jobs
// handed to the person's AIs once. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerHoldWithTools } from './hold-tools-door.mjs';
import { answerNeedsYouHoldRoute } from '../do-work/needs-you-hold-route.mjs';
import { answerOfRows } from '../do-work/hold.mjs';
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
// Free-state assertions use this explicit complete synthetic scope. Known held facts also exercise the current
// default adapter, whose partial coverage cannot establish that the whole person is free.
const completePage = (method, records, body = {}) => ({ ...page(method, body), things: {
  ...answerOfRows(records.filter(record => record.type === 'record:waiting-on-you')), complete: true,
} });

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
  const run = await answerOf(ROUTE, completePage('GET', []), { records: [PERSON[0]] });
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
  assert.equal(jobs[0].value.from, null);
  assert.equal(jobs[0].value.producer.ref, 'setting:needs_you_hold');
  assert.match(jobs[0].value.source_job, /^hold-aside:/);
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
  const free = await answerOf(ROUTE, completePage('GET', []), { records: [PERSON[0], held] });
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
  const run = await answerHoldWithTools(ROUTE, page('GET'), { records });
  assert.equal(run.result.status, 200, JSON.stringify(run.result.body));
  assert.deepEqual(run.runs.map(({ tool, input }) => ({ tool, input })), [
    { tool: 'tool:hold-a-device-quiet', input: { id: 'needs-you-hold', only: ['Trillion'] } },
    { tool: 'tool:take-me-there', input: { thing: 'record:waiting-on-you:sign-in', say: { title: 'Sign in to the sample service' }, key: 'hold:record:waiting-on-you:sign-in' } },
  ]);
  assert.equal(run.runs[0].key, `native-hold-devices:tool:hold-a-device-quiet:record:waiting-on-you:sign-in:${run.kept.find(record => record.id === 'setting:needs_you_held').value.held_transition}`);
  const again = await answerHoldWithTools(ROUTE, page('GET'), { records: run.kept });
  assert.deepEqual(again.runs, [], 'the same thing held starts nothing');
  const done = run.kept.filter(record => record.type !== 'record:waiting-on-you');
  const free = await answerHoldWithTools(ROUTE, completePage('GET', done), { records: done });
  assert.deepEqual(free.runs.map(({ tool, input }) => ({ tool, input })), [{ tool: 'tool:release-a-device', input: { id: 'needs-you-hold' } }]);
  const never = await answerHoldWithTools(ROUTE, page('GET'), { records: [setting('setting:needs_you_hold_rules', { ...RULES, devices })] });
  assert.deepEqual(never.runs, [], 'nothing held before and nothing now starts nothing');
});

test('repeated held/free cycles and recreated settings retain each new transition before device effects', async () => {
  const heldId = 'setting:needs_you_held';
  const devices = { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: {} }], when_free: [{ tool_id: 'tool:release-a-device', input: {} }] };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), PERSON[2]];
  const kept = new Map(records.map(record => [record.id, structuredClone(record)]));
  const receipts = new Set(), toolReceipts = new Set(), writes = [], effects = [], events = [];
  const door = {
    readRecord: async (type, id) => { events.push(`read:${id}`); return structuredClone(kept.get(id) ?? null); },
    async write(items, { key } = {}) {
      if (receipts.has(key)) return;
      for (const item of items) {
        const current = kept.get(item.id) ?? null;
        if (item.expected === null ? current !== null : !isDeepStrictEqual(current?.value, item.expected.value)) throw Object.assign(new Error('Changed'), { code: 'original_command_conflict' });
      }
      for (const item of items) kept.set(item.id, { id: item.id, type: item.type, value: structuredClone(item.value) });
      receipts.add(key); writes.push({ key, transition: kept.get(heldId).value.held_transition }); events.push('write:held');
    },
    async run(tool, input, { key } = {}) {
      if (toolReceipts.has(key)) return;
      assert.equal(events.at(-1), `read:${heldId}`, 'the exact setting was read back before any device effect');
      const transition = kept.get(heldId).value.held_transition;
      assert.equal(key, `native-hold-devices:${tool}:${kept.get(heldId).value.value?.key ?? 'free'}:${transition}`);
      effects.push(tool); toolReceipts.add(key);
    },
  };
  const show = async held => {
    const answer = await answerNeedsYouHoldRoute(completePage('GET', held ? records : records.slice(0, 1)), { door, now: () => NOW });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(kept.get(heldId).value.value?.key ?? null, held ? PERSON[2].id : null);
  };
  for (const held of [true, false, true, false, true]) await show(held);
  await show(true);
  assert.equal(effects.length, 5, 'the unchanged held item causes no additional effect');
  kept.delete(heldId);
  await show(true);
  kept.set(heldId, setting(heldId, null));
  await show(true);
  assert.deepEqual(effects, ['tool:hold-a-device-quiet', 'tool:release-a-device', 'tool:hold-a-device-quiet', 'tool:release-a-device', 'tool:hold-a-device-quiet', 'tool:hold-a-device-quiet', 'tool:hold-a-device-quiet']);
  assert.equal(new Set(writes.map(write => write.key)).size, 7);
  assert.equal(new Set(writes.map(write => write.transition)).size, 7, 'same time and same target still identify distinct persisted transitions');
});

test('an unconfirmed or concurrently changed held write starts no device effects', async () => {
  for (const outcome of ['not-kept', 'changed', 'conflict']) {
    const devices = { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: {} }] };
    const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), PERSON[2]];
    const kept = new Map(records.map(record => [record.id, structuredClone(record)]));
    const effects = [];
    const door = {
      readRecord: async (type, id) => structuredClone(kept.get(id) ?? null),
      async write() {
        if (outcome === 'conflict') throw Object.assign(new Error('Changed'), { code: 'original_command_conflict' });
        if (outcome === 'changed') kept.set('setting:needs_you_held', setting('setting:needs_you_held', { key: 'other', title: 'A concurrent hold' }));
      },
      run: async tool => { effects.push(tool); },
    };
    const answer = await answerNeedsYouHoldRoute(completePage('GET', records), { door, now: () => NOW });
    assert.equal(answer.status, 409);
    assert.deepEqual(effects, []);
  }
});

test('partial empty coverage preserves the persisted held fact and devices; an explicit off may release them', async () => {
  const held = setting('setting:needs_you_held', { key: 'record:waiting-on-you:sample', title: 'A known held sample' });
  const devices = { when_free: [{ tool_id: 'tool:release-a-device', input: { id: 'needs-you-hold' } }] };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), held];
  const partial = await answerHoldWithTools(ROUTE, page('GET'), { records });
  assert.equal(partial.result.body.waiting_sources.complete, false);
  assert.equal(partial.result.body.on, true);
  assert.equal(partial.result.body.held, null);
  assert.notEqual(partial.result.body.said, 'Nothing is holding you.');
  assert.deepEqual(partial.runs, []);
  assert.deepEqual(partial.kept.find(record => record.id === held.id), held);
  const off = await answerHoldWithTools(ROUTE, page('GET'), { records: [...records, setting('setting:needs_you_hold', { on: false })] });
  assert.equal(off.result.body.on, false);
  assert.equal(off.result.body.waiting_sources.complete, false);
  assert.deepEqual(off.runs.map(({ tool, input }) => ({ tool, input })), [{ tool: 'tool:release-a-device', input: { id: 'needs-you-hold' } }]);
  assert.equal(off.kept.find(record => record.id === held.id).value.value, null);
});

test('a device tool that fails or is refused is let go: the read still answers', async () => {
  const devices = { when_held: [{ tool_id: 'tool:hold-a-device-quiet', input: {} }, { tool_id: 'tool:not-declared', input: {} }, { tool_id: 'tool:take-me-there', input: { thing: '{key}' } }] };
  const records = [setting('setting:needs_you_hold_rules', { ...RULES, devices }), ...PERSON.slice(1)];
  const run = await answerHoldWithTools(ROUTE, page('GET'), { records, tool_runs: { 'tool:hold-a-device-quiet': new Error('tool_unavailable') } });
  assert.equal(run.result.status, 200);
  assert.deepEqual(run.runs.map(item => item.tool), ['tool:hold-a-device-quiet', 'tool:take-me-there'], 'an undeclared tool is refused by the door');
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
  const run = await answerOf(ROUTE, page('GET'), { records });
  assert.equal(run.result.status, 200, JSON.stringify(run.result.body));
  assert.equal(run.result.body.held.key, 'record:waiting-on-you:body');
  assert.deepEqual(run.result.body.ranked.map(thing => thing.key), ['record:waiting-on-you:body'], 'the AI-doable and the uncontrollable rows are left out');
  assert.equal(run.kept.filter(record => record.type === 'ai-job').length, 2, 'removed cards are published before leaving the person\'s view');
});

test('a completion button remains a valid control for an explicit physical step without a screen address', async () => {
  const records = [PERSON[0], mustDo('physical-step', { what: 'Sign the sample form by hand', needs: 'sign by hand',
    reason_id: 'their-own-body', finish: 'Tap done' })];
  const run = await answerOf(ROUTE, page('GET'), { records });
  assert.equal(run.result.status, 200, JSON.stringify(run.result.body));
  assert.equal(run.result.body.held.key, 'record:waiting-on-you:physical-step');
  assert.equal(run.kept.filter(record => record.type === 'ai-job').length, 0);
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
