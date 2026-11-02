// The cover and the hold, from a person's own rows, against the records door stand-in
// (tools/records-door/test/fake-door.mjs), which checks rights and `expected` the way the engine does. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { runRow, rowOf } from '../../records-door/test/run-row.mjs';
import { DEFAULT_COVER_KEY, requiredCover, requiredCoverOfRows, setupScreenComplete } from '../read-data/required-cover.mjs';
import { changeWhatHoldsMe, seeWhatHoldsMe } from '../do-work/hold.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
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
const PERSON = [
  setting('setting:needs_you_hold_rules', RULES),
  setting('setting:required_setup_gate', { key: 'sample-gate' }),
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

test('while a required setup row is not done the cover stands and nothing else is held', async () => {
  const records = [...PERSON, step('connect', { required: true, status: 'Waiting' }), step('extra', { required: false })];
  const { status, result } = await runRow(SEE, { now: NOW }, { records });
  assert.equal(status, 0);
  assert.deepEqual(result.cover, { covered: true, key: 'sample-gate' });
  assert.equal(result.hold.held, null);
  assert.deepEqual(result.hold.ranked, []);
});

test('once setup is done the one row held is the one that unblocks the most; finished rows wait no longer', async () => {
  const records = [...PERSON, step('connect', { required: true, status: 'Done' })];
  const { status, result } = await runRow(SEE, { now: NOW }, { records });
  assert.equal(status, 0);
  assert.equal(result.cover.covered, false);
  assert.equal(result.hold.held.key, 'record:waiting-on-you:sign-in', 'the upload waits on the sign-in, so the sign-in is held');
  assert.equal(result.hold.held.card.title, 'Sign in to the sample service');
  assert.deepEqual(result.hold.ranked.map(thing => thing.key).sort(),
    ['record:waiting-on-you:pay', 'record:waiting-on-you:sign-in', 'record:waiting-on-you:upload']);
  assert.equal(result.hold.asides_left, 1);
});

test('a person with no setup rows gets covered null from the rows, and the Get started answer they send decides', async () => {
  const none = await runRow(SEE, { now: NOW }, { records: PERSON });
  assert.equal(none.result.cover.covered, null);
  const sent = await runRow(SEE, { now: NOW, setup: { progress: { done: 1, total: 2 } } }, { records: PERSON });
  assert.equal(sent.result.cover.covered, true);
});

test('setting the held row aside writes the setting on condition of what was read; it then leaves the hold', async () => {
  const records = [...PERSON, setting('setting:needs_you_hold', { on: true })];
  const change = { change: 'set-aside', request_key: 'aside-1', key: 'record:waiting-on-you:sign-in', title: 'Sign in', reason: 'the sample site is down today', now: NOW };
  const { status, result, kept } = await runRow(CHANGE, change, { records });
  assert.equal(status, 0);
  assert.equal(result.changed, true);
  assert.equal(result.jobs.length, 1);
  assert.match(result.jobs[0].job, /the sample site is down today/);
  const written = kept.find(record => record.id === 'setting:needs_you_hold');
  assert.ok(written.value.value.aside['record:waiting-on-you:sign-in']);
  const after = await runRow(SEE, { now: NOW, setup: { ready: true } }, { records: kept });
  assert.notEqual(after.result.hold.held.key, 'record:waiting-on-you:sign-in');
  assert.equal(after.result.hold.asides_left, 0);
});

test('a refused change writes nothing: too few words, or no asides left today', async () => {
  const records = [...PERSON, setting('setting:needs_you_hold', { asides: { day: '2026-01-10', count: 1 } })];
  const short = await runRow(CHANGE, { change: 'set-aside', request_key: 'k1', key: 'x', reason: 'busy', now: NOW }, { records });
  assert.equal(short.status, 1);
  assert.match(short.error, /at least 3 words/);
  const spent = await runRow(CHANGE, { change: 'set-aside', request_key: 'k2', key: 'x', reason: 'one two three four', now: NOW }, { records });
  assert.equal(spent.error, 'Nothing more can be set aside today.');
  assert.deepEqual(spent.kept, records);
});

test('a setting changed between the read and the write answers conflict and changes nothing', async () => {
  const fake = await startFakeDoor({ rights: CHANGE.invoke.records.rights, records: [...PERSON, setting('setting:needs_you_hold', { on: true })] });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    const racing = {
      ...door,
      async readRecord(type, id) {
        const held = await door.readRecord(type, id);
        if (id === 'setting:needs_you_hold') await door.write([{ id, type, value: { value: { on: false } } }], { key: 'other-page' });
        return held;
      },
    };
    const answer = await changeWhatHoldsMe({ change: 'turn-on', request_key: 'on-1', now: NOW }, { door: racing });
    assert.deepEqual(answer, { changed: false, conflict: true, jobs: [] });
    assert.deepEqual(fake.kept.get('setting:needs_you_hold').value, { value: { on: false } }, 'the other page\'s write stands');
  } finally { await fake.close(); }
});

test('the same change sent again with its request key changes nothing twice', async () => {
  const fake = await startFakeDoor({ rights: CHANGE.invoke.records.rights, records: PERSON });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    const off = { change: 'turn-off', request_key: 'off-1', now: NOW };
    const first = await changeWhatHoldsMe(off, { door });
    assert.equal(first.changed, true);
    assert.equal(first.at, '2026-01-10T13:00:00.000Z', 'off waits the stake\'s delay');
    const kept = fake.kept.get('setting:needs_you_hold').value;
    await changeWhatHoldsMe(off, { door });
    assert.deepEqual(fake.kept.get('setting:needs_you_hold').value, kept);
  } finally { await fake.close(); }
});

test('the rows reach only the records they name, and the sample run answers what it says', async () => {
  assert.deepEqual(CHANGE.invoke.records.rights.filter(right => right.operations.includes('records:write')).map(right => right.id), ['setting:needs_you_hold']);
  assert.ok(SEE.invoke.records.rights.every(right => !right.operations.includes('records:write')), 'seeing changes nothing');
  for (const row of [SEE, CHANGE]) {
    for (const sample of row.verify ?? []) {
      const { status, result } = await runRow(row, sample.input);
      assert.equal(status, 0);
      const value = sample.output_selector.slice(2).split('.').reduce((at, key) => at?.[key], result);
      assert.ok(JSON.stringify(value).includes(sample.contains));
    }
  }
});

test('a request that is not one the rows describe is refused with what to send', async () => {
  await assert.rejects(seeWhatHoldsMe({ things: { sections: 'none' }, rules: RULES, setup: { ready: true }, gate: {}, state: {} }), /sections/);
  await assert.rejects(changeWhatHoldsMe({ change: 'forget', request_key: 'x' }), /change must be one of/);
  await assert.rejects(changeWhatHoldsMe({ change: 'turn-on' }), /request_key/);
  await assert.rejects(seeWhatHoldsMe({ now: 'soon', rules: RULES }), /ISO time/);
});
