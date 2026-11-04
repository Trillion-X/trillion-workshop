// test/device-facts.test.mjs
//
// What a device reports about itself is kept whole and bounded, and a waiting step whose rule passes on ONE device's
// facts is the one that ticks: a sample camera seen by the Mac, a switch turned on by the iPhone. Facts from two devices are
// never mixed to pass a rule.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { DeviceFactsError, deviceFacts, passedOnSomeDevice } from '../../walk-a-new-person-through-setup/device-facts.mjs';
import lists from '../src/lists.json' with { type: 'json' };
import waiting from '../src/waiting-on-you.json' with { type: 'json' };

const wasm = () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const { filterRowsByRules: filterRows } = makeRowFilter({ operators, wasm });

const kept = () => { let rows = []; return { read: () => rows, write: next => { rows = next; } }; };
const rule = (field, operator, params) => ({ kind: 'rule', field, operator, params });
const group = (combinator, rules) => ({ kind: 'group', combinator, negate: false, rules });

test('a report replaces the device\'s facts whole, writes nothing when nothing changed, and refuses what does not fit', () => {
  const store = kept();
  const facts = deviceFacts(store);
  assert.equal(facts.report({ device: 'Mac', facts: { cameras: 'FaceTime HD Camera, SMP-100' } }).changed, true);
  assert.equal(facts.report({ device: 'Mac', facts: { cameras: 'FaceTime HD Camera, SMP-100' } }).changed, false);
  facts.report({ device: 'Mac', facts: { cameras: 'FaceTime HD Camera' } });
  assert.deepEqual(facts.all().map(row => row.facts), [{ cameras: 'FaceTime HD Camera' }], 'the camera unplugged is gone, not kept');
  assert.throws(() => facts.report({ device: '', facts: {} }), DeviceFactsError);
  assert.throws(() => facts.report({ device: 'Mac', facts: { 'Not A Name': 'x' } }), DeviceFactsError);
  assert.throws(() => facts.report({ device: 'Mac', facts: { cameras: 3 } }), DeviceFactsError);
});

test('profile identities separate same-label devices, source snapshots merge without stale keys, and older generations are ignored', () => {
  const accountA = kept(), accountB = kept();
  const a = deviceFacts(accountA), b = deviceFacts(accountB);
  assert.equal(a.report({ device: 'Mac', device_id: 'profile-a', source: 'always-recording', generation: 1, facts: { cameras: 'Camera A, Camera B' } }).changed, true);
  a.report({ device: 'Mac', device_id: 'profile-a', source: 'device-switches', generation: 1, facts: { 'switch-a.on': 'on' } });
  assert.equal(a.report({ device: 'Mac', device_id: 'profile-a', source: 'always-recording', generation: 2, facts: { cameras: 'Camera A' } }).changed, true);
  assert.deepEqual(a.all()[0].facts, { cameras: 'Camera A', 'switch-a.on': 'on' }, 'refresh replaces that source and keeps the separate switch source');
  assert.equal(a.report({ device: 'Mac', device_id: 'profile-a', source: 'always-recording', generation: 3, facts: { cameras: 'Camera A' } }).changed, false);
  assert.equal(a.report({ device: 'Mac', device_id: 'profile-a', source: 'always-recording', generation: 2, facts: { cameras: 'Camera A, Camera B' } }).stale, true, 'an unchanged newer report still advances the ordering watermark');
  assert.equal(a.report({ device: 'Mac', device_id: 'profile-a', source: 'always-recording', generation: 1, facts: { cameras: 'Camera A, Camera B' } }).stale, true);
  assert.deepEqual(a.all()[0].facts, { cameras: 'Camera A', 'switch-a.on': 'on' }, 'a late older report cannot restore removed facts');
  a.report({ device: 'Mac', device_id: 'profile-b', source: 'always-recording', generation: 1, facts: { cameras: 'Other Camera' } });
  assert.equal(a.all().length, 2, 'same display label does not collapse separate profile identities');
  assert.equal(a.all()[1].identity, 'profile-b');
  assert.equal(b.all().length, 0, 'another account owner has a separate fact store');
});

test('legacy device/facts reports remain accepted and source bounds stay enforced', () => {
  const store = kept();
  const facts = deviceFacts(store);
  assert.equal(facts.report({ device: 'Mac', facts: { cameras: 'A' } }).changed, true);
  assert.equal(facts.report({ device: 'Mac', device_id: 'profile-a', source: 'always-recording', generation: 1, facts: { cameras: 'B' } }).changed, true);
  assert.throws(() => facts.report({ device: 'Mac', device_id: 'profile-a', source: 'bad source', generation: 2, facts: {} }), DeviceFactsError);
  assert.equal(facts.all().length, 2, 'legacy label and identified profile remain separate rows');
});

test('a waiting step ticks when one device\'s facts pass its rule, and never on facts mixed from two devices', async () => {
  const sample = group('or', [rule('cameras', 'contains', { text: 'SMP' }), rule('cameras', 'contains', { text: 'Sample Cam' })]);
  const switchedOn = group('and', [rule('photos.on', 'is_text', { text: 'on' })]);
  const both = group('and', [rule('photos.on', 'is_text', { text: 'on' }), rule('cameras', 'contains', { text: 'SMP' })]);
  const rows = [{ id: 'sample', tree: sample }, { id: 'phone', tree: switchedOn }, { id: 'both', tree: both }];
  const before = [{ device: 'Mac', facts: { cameras: 'FaceTime HD Camera' } }, { device: 'iPhone', facts: { 'photos.on': 'off' } }];
  assert.deepEqual(await passedOnSomeDevice(rows, before, filterRows), []);
  const after = [{ device: 'Mac', facts: { cameras: 'FaceTime HD Camera, SMP-100' } }, { device: 'iPhone', facts: { 'photos.on': 'on' } }];
  assert.deepEqual(await passedOnSomeDevice(rows, after, filterRows), ['sample', 'phone'], 'the Mac\'s camera and the iPhone\'s switch tick their own steps; neither device alone passes both');
  const unfinished = [{ id: 'unfinished', tree: group('and', [rule('photos.on', 'is_any_of', { values: ['on'] })]) }];
  assert.deepEqual(await passedOnSomeDevice(unfinished, after, filterRows), [], 'a rule the engine cannot finish never ticks a step');
});

test('the Waiting on you list carries a Done once field whose kind is a rule over device facts, never shown in a copy', () => {
  const field = waiting.list.fields.find(item => item.id === 'checked_by');
  const kind = lists.field_kinds.find(item => item.id === field?.kind);
  assert.equal(kind?.value, 'rule');
  assert.equal(kind?.rule_over, 'device-facts');
});
