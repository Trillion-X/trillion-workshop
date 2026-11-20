// A person's release rules (src/namespace-release-rules.mjs) give back the storage of what they deleted sooner than
// keep-for: by folder, kind, size or days since deleted, or while the storage kept is above a size. Evaluated through
// the real formula engine and run end to end over a real Recently Deleted.
//
// Ported from the old repository's test/namespace-release-rules.test.mjs (commit 1e886c3f68, 125 lines, 8 tests), which the move
// to the Workshop left behind: only 2 of its job's tests had come (namespace-command-refusals.test.mjs). Every assertion
// is the old one. What differs is where things are read from: the formula engine is tools/formula-engine's built
// module, and the byte-release store (retired here; the engine's release.rs gives bytes back) is not asked what it queued.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkReleaseRules, releaseItemFacts, releasePlan } from '../src/namespace-release-rules.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../../recently-deleted-and-storage/namespace-store.mjs';
import { setAsideStore } from '../../recently-deleted-and-storage/namespace-set-aside.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';

initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const filterRows = ({ tree, fields, rows }) => filterRecords({ records: rows, fields, tree });
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1, 12);
const GB = 1e9;
const identity = digit => `1f:${String(digit).padStart(64, '0')}`;
const rule = (field, operator, params) => ({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field, operator, params }] });

// Recently Deleted holding a camera folder's clips, a big export and a note, deleted on different days.
function setUp() {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const records = decisionStore(sql, { transaction });
  let clock = START;
  const keepFor = { read: () => records.setting('keep_for'), write: value => records.setSetting('keep_for', value) };
  const aside = setAsideStore(sql, { keepFor, now: () => clock });
  names.putNames([
    { name: '/Card/M4ROOT/SUB/C0001S03.MP4', identity: identity(1), byte_length: 2 * GB, modified_at_ms: START },
    { name: '/Card/M4ROOT/SUB/C0002S03.MP4', identity: identity(2), byte_length: 3 * GB, modified_at_ms: START },
    { name: '/Exports/final.mov', identity: identity(3), byte_length: 40 * GB, modified_at_ms: START },
    { name: '/notes.txt', identity: identity(4), byte_length: 100, modified_at_ms: START },
  ]);
  aside.setAside({ items: [{ name: '/Exports/final.mov' }], state: 'deleted', by: 'person' });
  clock += 2 * DAY;
  aside.setAside({ items: [{ name: '/Card/M4ROOT/SUB/C0001S03.MP4' }, { name: '/Card/M4ROOT/SUB/C0002S03.MP4' }, { name: '/notes.txt' }], state: 'deleted', by: 'person' });
  const plan = (rules, keptBytes = 100 * GB) => releasePlan({ items: aside.everything(), rules: checkReleaseRules(rules), keptBytes, finalStates: new Set(['deleted']), filterRows, now: clock });
  return { aside, plan, later: days => { clock += days * DAY; }, now: () => clock };
}
const labels = (aside, ids) => aside.everything().filter(item => ids.includes(item.id)).map(item => item.label).sort();

test('with no rules, what leaves and when is keep-for alone, read from the setting', async () => {
  const { aside, plan } = setUp();
  const answer = await plan([]);
  assert.deepEqual(answer.now, []);
  assert.ok(answer.items.every(item => item.because === 'keep-for'));
  aside.setKeepFor({ after_days: { deleted: 1 } });
  assert.deepEqual(labels(aside, (await plan([])).now), ['final.mov'], 'a shorter keep-for makes the oldest due now');
});

test('a rule over a folder gives back only what was in it, that many days after it was deleted', async () => {
  const { aside, plan, later } = setUp();
  const rules = [{ id: 'proxies', when: rule('where', 'is_any_of', { values: ['/Card/M4ROOT/SUB'] }), after_days: 1 }];
  assert.deepEqual((await plan(rules)).now, [], 'not a day yet');
  later(1);
  const answer = await plan(rules);
  assert.deepEqual(labels(aside, answer.now), ['C0001S03.MP4', 'C0002S03.MP4']);
  assert.ok(answer.items.filter(item => answer.now.includes(item.id)).every(item => item.because === 'proxies'));
  assert.equal(answer.leaving[0].bytes, 5 * GB, 'today\'s bar holds what leaves now');
});

test('an unsupported release condition refuses before it can select every deleted file', async () => {
  const { aside, plan } = setUp();
  const before = aside.everything().map(item => item.id);
  await assert.rejects(plan([{ id: 'one-note', when: rule('label', 'is_any_of', { values: ['notes.txt'] }), after_days: 0 }]),
    /Release rule one-note has an unfinished condition/);
  await assert.rejects(plan([{ id: 'empty-group', when: { kind: 'group', combinator: 'and', negate: false, rules: [] }, after_days: 0 }]),
    /Release rule empty-group has no comparison/);
  assert.deepEqual(aside.everything().map(item => item.id), before);
  const narrowed = await plan([{ id: 'one-folder', when: rule('where', 'is_any_of', { values: ['/'] }), after_days: 0 }]);
  assert.deepEqual(labels(aside, narrowed.now), ['notes.txt']);
});

test('rules by kind and size use the same facts the screen filters by', async () => {
  const { aside, plan } = setUp();
  const videoNow = await plan([{ id: 'videos', when: rule('kind', 'is_any_of', { values: [releaseItemFacts(aside.everything()[0]).kind] }), after_days: 0 }]);
  assert.deepEqual(labels(aside, videoNow.now), ['C0001S03.MP4', 'C0002S03.MP4', 'final.mov']);
  const bigNow = await plan([{ id: 'big', when: rule('size', 'greater_than', { value: 10 * GB }), after_days: 0 }]);
  assert.deepEqual(labels(aside, bigNow.now), ['final.mov']);
});

test('a storage rule gives back matching items in its order only while the storage kept is above its size', async () => {
  const { aside, plan } = setUp();
  const rules = [{ id: 'cap', when: null, storage_above_bytes: 98 * GB, order: 'oldest' }];
  const answer = await plan(rules, 100 * GB);
  assert.deepEqual(labels(aside, answer.now), ['final.mov'], 'the oldest alone brings it under');
  assert.equal(answer.kept_after, 60 * GB);
  assert.ok(answer.items.filter(item => !answer.now.includes(item.id)).every(item => item.when_storage_above === 98 * GB));
  assert.deepEqual((await plan(rules, 90 * GB)).now, [], 'under the size, nothing leaves');
  const largest = await plan([{ id: 'cap', when: rule('kind', 'is_none_of', { values: ['nothing'] }), storage_above_bytes: 97 * GB, order: 'largest' }], 100 * GB);
  assert.deepEqual(labels(aside, largest.now), ['final.mov']);
});

test('a rule switched off decides nothing, and a rule never keeps anything longer than keep-for', async () => {
  const { aside, plan } = setUp();
  aside.setKeepFor({ after_days: { deleted: 1 } });
  const answer = await plan([{ id: 'later', when: null, after_days: 90 }, { id: 'off', on: false, when: null, after_days: 0 }]);
  assert.deepEqual(labels(aside, answer.now), ['final.mov']);
});

test('rules are checked: a when that is not a rule group, no number at all, and duplicate names are refused', () => {
  assert.throws(() => checkReleaseRules([{ after_days: 0 }]), /needs when: null/);
  assert.throws(() => checkReleaseRules([{ when: undefined, after_days: 0 }]), /rule group/);
  assert.throws(() => checkReleaseRules([{ when: 'where is /x', after_days: 1 }]), /rule group/);
  assert.throws(() => checkReleaseRules([{ when: null }]), /after how many days/);
  assert.throws(() => checkReleaseRules([{ id: 'a', when: null, after_days: 1 }, { id: 'a', when: null, after_days: 2 }]), /Two release rules/);
  assert.throws(() => checkReleaseRules([{ when: null, after_days: 1.5 }]), /whole number/);
  assert.throws(() => checkReleaseRules([{ when: null, after_days: 1, order: 'random' }]), /order is one of/);
});

test('forgetting what a rule says leaves now removes only those items, and the rest stays in Recently Deleted', async () => {
  const { aside, plan, later } = setUp();
  later(1);
  const answer = await plan([{ id: 'proxies', when: rule('where', 'is_any_of', { values: ['/Card/M4ROOT/SUB'] }), after_days: 1 }]);
  const removed = aside.forgetNow(answer.now);
  assert.equal(removed.length, 2);
  assert.deepEqual(aside.everything().map(item => item.label).sort(), ['final.mov', 'notes.txt']);
  assert.equal(aside.holdsAny(), true);
});
