// The cover and the hold, from the rows a request carries. Neither tool is handed a records door: what they work from
// is in the request and what they make is in the answer. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { DEFAULT_COVER_KEY, requiredCover, requiredCoverOfRows, setupScreenComplete } from '../read-data/required-cover.mjs';
import { changeWhatHoldsMe, seeWhatHoldsMe } from '../do-work/hold.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const SEE = rowOf(ROWS, 'tool:see-what-holds-me');
const CHANGE = rowOf(ROWS, 'tool:change-what-holds-me');
const NOW = '2026-01-10T12:00:00.000Z';
const RULES = {
  after_minutes: 0,
  rank: [{ by: 'waited_on', field: 'waits_on' }],
  aside: { min_words: 3, minutes: 60, most_per_day: 1, job: 'Weigh why {title} was set aside: {reason}' },
  hand_back: { min_words: 2, keep_days: 1, ways: [{ id: 'done', label: 'I did my part', job: 'Finish {title}: {reason}' }] },
  off: { default_stake: 'wait', lasts_minutes: 60, stakes: [{ id: 'wait', label: 'Wait an hour', delay_minutes: 60 }] },
  words: { no_asides_left: 'Nothing more can be set aside today.' },
};
const setting = (id, value) => ({ id, type: 'setting', value: { value } });
const mustDo = (id, value) => ({ id: `record:waiting-on-you:${id}`, type: 'record:waiting-on-you', value: { added: '2026-01-01T00:00:00.000Z', ...value } });
const step = (id, value) => ({ id: `record:setup-steps:${id}`, type: 'record:setup-steps', value });
const GATE = { key: 'sample-gate' };
const MUST_DO = [
  mustDo('pay', { what: 'Pay the sample invoice', do_it_in: '/sample/pay' }),
  mustDo('sign-in', { what: 'Sign in to the sample service', do_it_in: '/sample/sign-in' }),
  mustDo('upload', { what: 'Upload the sample file', do_it_in: '/sample/upload', waits_on: 'sign-in' }),
  mustDo('old', { what: 'Something already finished', do_it_in: '/sample/old', status: 'Done' }),
];

test('the cover stands until required setup is proved, and a gate row with no key still covers', () => {
  assert.equal(setupScreenComplete({ ready: false }), false);
  assert.equal(setupScreenComplete({ progress: { done: 2, total: 3 } }), false);
  assert.equal(setupScreenComplete(undefined), false);
  assert.deepEqual(requiredCover({ ready: false }, { key: 'sample-gate' }), { covered: true, key: 'sample-gate' });
  // The installed build that lost its gate key never engaged the lock; here the cover stands under the default key.
  assert.deepEqual(requiredCover({ ready: false }, undefined), { covered: true, key: DEFAULT_COVER_KEY });
  assert.deepEqual(requiredCover({ ready: false }, { key: '  ' }), { covered: true, key: DEFAULT_COVER_KEY });
  assert.deepEqual(requiredCover({ ready: true }, {}), { covered: false, key: DEFAULT_COVER_KEY });
  assert.deepEqual(requiredCoverOfRows([], {}), { covered: null, key: DEFAULT_COVER_KEY }, 'no rows decide nothing, never open');
  assert.equal(requiredCoverOfRows([{ required: true, done: false }, { required: false, done: false }]).covered, true);
  assert.equal(requiredCoverOfRows([{ required: true, done: true }, { required: false, done: false }]).covered, false);
});

const see = (input = {}) => seeWhatHoldsMe({ now: NOW, rules: RULES, gate: GATE, must_do: MUST_DO, ...input });

test('while a required setup row is not done the cover stands and nothing else is held', async () => {
  const result = await see({ setup_steps: [step('connect', { required: true, status: 'Waiting' }), step('extra', { required: false })] });
  assert.deepEqual(result.cover, { covered: true, key: 'sample-gate' });
  assert.equal(result.hold.held, null);
  assert.deepEqual(result.hold.ranked, []);
});

test('once setup is done the one row held is the one that unblocks the most; finished rows wait no longer', async () => {
  const result = await see({ setup_steps: [step('connect', { required: true, status: 'Done' })] });
  assert.equal(result.cover.covered, false);
  assert.equal(result.hold.held.key, 'record:waiting-on-you:sign-in', 'the upload waits on the sign-in, so the sign-in is held');
  assert.equal(result.hold.held.card.title, 'Sign in to the sample service');
  assert.deepEqual(result.hold.ranked.map(thing => thing.key).sort(),
    ['record:waiting-on-you:pay', 'record:waiting-on-you:sign-in', 'record:waiting-on-you:upload']);
  assert.equal(result.hold.asides_left, 1);
  assert.deepEqual(result.held_fact, { key: 'record:waiting-on-you:sign-in', title: 'Sign in to the sample service' }, 'the held fact to keep is answered');
});

test('a person with no setup rows gets covered null from the rows, and the Get started answer they send decides', async () => {
  assert.equal((await see()).cover.covered, null);
  assert.equal((await see({ setup: { progress: { done: 1, total: 2 } } })).cover.covered, true);
});

test('the held thing last kept decides whether the device runs start: a changed held thing answers them, the same one answers none', async () => {
  const rules = { ...RULES, devices: { when_held: [{ tool_id: 'tool:sample-device', input: { key: '{key}' } }], when_free: [{ tool_id: 'tool:sample-release', input: {} }] } };
  const first = await see({ rules, setup: { ready: true } });
  assert.deepEqual(first.device_runs.map(run => run.tool_id), ['tool:sample-device']);
  const again = await see({ rules, setup: { ready: true }, kept_held: first.held_fact });
  assert.deepEqual(again.device_runs, [], 'the same held thing starts nothing twice');
  const freed = await see({ rules, setup: { ready: false }, things: { complete: true, sections: [{ id: 'asks', cards: [] }] }, kept_held: first.held_fact });
  assert.deepEqual(freed.device_runs.map(run => run.tool_id), ['tool:sample-release'], 'nothing held any more starts the when_free runs');
});

test('setting the held row aside answers the next setting and its job; it then leaves the hold', async () => {
  const change = { change: 'set-aside', key: 'record:waiting-on-you:sign-in', title: 'Sign in', reason: 'the sample site is down today', now: NOW, rules: RULES, state: { on: true } };
  const result = changeWhatHoldsMe(change);
  assert.equal(result.changed, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].type, 'calendar-task');
  assert.match(result.jobs[0].value.description, /the sample site is down today/);
  assert.ok(result.state.aside['record:waiting-on-you:sign-in']);
  const after = await see({ setup: { ready: true }, state: result.state });
  assert.notEqual(after.hold.held.key, 'record:waiting-on-you:sign-in');
  assert.equal(after.hold.asides_left, 0);
});

test('a refused change answers its words: too few words, or no asides left today', () => {
  const rules = RULES;
  assert.throws(() => changeWhatHoldsMe({ change: 'set-aside', key: 'x', reason: 'busy', now: NOW, rules, state: {} }), /at least 3 words/);
  assert.throws(() => changeWhatHoldsMe({ change: 'set-aside', key: 'x', reason: 'one two three four', now: NOW, rules, state: { asides: { day: '2026-01-10', count: 1 } } }), /Nothing more can be set aside today\./);
});

test('turning the hold off answers the delayed time and the setting; nothing is kept by the tool', () => {
  const off = changeWhatHoldsMe({ change: 'turn-off', now: NOW, rules: RULES, state: {} });
  assert.equal(off.changed, true);
  assert.equal(off.at, '2026-01-10T13:00:00.000Z', 'off waits the stake\'s delay');
  assert.deepEqual(changeWhatHoldsMe({ change: 'turn-off', now: NOW, rules: RULES, state: {} }), off, 'the same change over the same setting answers the same');
});

test('the rows declare no records door and take the rows they work from in the request', async () => {
  for (const row of [SEE, CHANGE]) {
    assert.equal(row.invoke.records, undefined);
    assert.ok(row.input_schema.properties.rules && row.input_schema.required.includes('rules'));
  }
  assert.ok(SEE.input_schema.properties.must_do && SEE.input_schema.properties.things && SEE.input_schema.properties.setup_steps && SEE.input_schema.properties.kept_held);
  assert.ok(CHANGE.input_schema.properties.state);
});

test('a hand-back answers its real producer job with the setting, and repeats answer the same job id', () => {
  const input = { change: 'hand-back', key: 'sample-form', title: 'Sample form', way: 'done', reason: 'I signed it', now: NOW, rules: RULES, state: {} };
  const result = changeWhatHoldsMe(input);
  const [job] = result.jobs;
  assert.equal(job.type, 'calendar-task');
  assert.equal(job.value.sent_by, null);
  assert.equal(job.value.producer.kind, 'record');
  assert.equal(job.value.producer.ref, 'setting:needs_you_hold');
  assert.equal(job.value.source_task, 'hold-hand-back:sample-form');
  assert.equal(changeWhatHoldsMe(input).jobs[0].id, job.id);
});

test('the canonical read preserves non-ask sections and their finish controls', async () => {
  const things = { complete: true, finishes: [{ choice: 'pick', press: { tool: 'sample:choose' } }], sections: [
    { id: 'decide', finish: 'pick', cards: [{ id: 'decision:sample', title: 'Choose the sample option' }] },
    { id: 'stuck', step: { already_ais: true, needs: 'write a draft' }, cards: [{ id: 'record:calendar-task:sample', title: 'An AI already owns this' }] },
  ] };
  const result = await seeWhatHoldsMe({ now: NOW, rules: RULES, setup: { ready: true }, gate: {}, state: {}, things });
  assert.equal(result.hold.held.key, 'decision:sample');
  assert.equal(result.hold.held.section.id, 'decide');
  assert.deepEqual(result.hold.finishes, things.finishes);
  assert.deepEqual(result.hold.waiting_sources, { from: 'caller', complete: true });
  assert.equal(result.jobs.length, 0, 'a section already owned by AIs does not create a helper job');
});

test('AI work removed by the canonical read is answered once with the original source and structured input', async () => {
  const input = { now: NOW, rules: RULES, setup: { ready: true }, gate: {}, state: {}, things: { sections: [
    { id: 'asks', cards: [{ id: 'asks:sample-draft', title: 'Write the sample draft', needs: 'write a draft' }] },
  ] } };
  const first = await seeWhatHoldsMe(input);
  assert.equal(first.hold.held, null);
  assert.equal(first.jobs.length, 1);
  const [job] = first.jobs;
  assert.equal(job.value.source_task, 'weighed:asks:sample-draft');
  assert.equal(job.value.input.card_id, 'asks:sample-draft');
  assert.equal(job.value.sent_by, null);
  assert.deepEqual((await seeWhatHoldsMe(input)).jobs.map(each => each.id), [job.id], 'the same trigger is the same job id');
});

test('a request that is not one the rows describe is refused with what to send', async () => {
  await assert.rejects(seeWhatHoldsMe({ things: { sections: 'none' }, rules: RULES, setup: { ready: true }, gate: {}, state: {} }), /sections/);
  await assert.rejects(seeWhatHoldsMe({ now: NOW, rules: RULES, setup: { ready: true } }), /waiting rows/);
  assert.throws(() => changeWhatHoldsMe({ change: 'forget' }), /change must be one of/);
  assert.throws(() => changeWhatHoldsMe({ change: 'turn-on' }), /Send rules/);
  await assert.rejects(seeWhatHoldsMe({ now: 'soon', rules: RULES }), /ISO time/);
});
