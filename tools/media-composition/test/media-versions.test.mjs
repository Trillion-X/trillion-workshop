// test/media-versions.test.mjs
//
// Edits are versions beside an untouched original (tools/media-composition/read-data/media-versions.mjs): publish with or without
// making the version the default, refusals before any work, links that always resolve, and the original never lost.
import assert from 'node:assert/strict';
import test from 'node:test';
import rules from '../read-data/media-versions.json' with { type: 'json' };
import { canPublish, newVersionsState, publishVersion, removeVersion, setDefaultVersion, versionServed } from '../read-data/media-versions.mjs';

const T0 = '2026-10-19T12:00:00.000Z';
const later = (seconds) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const edit = (id, over = {}) => ({ id, label: id, title: `Title ${id}`, seconds: 30, now: T0, make_default: false, ...over });

test('a new recording has only its original, and every link shows it', () => {
  const state = newVersionsState();
  assert.deepEqual(state.versions.map((v) => v.id), ['original']);
  assert.equal(versionServed(state, undefined).id, 'original');
  assert.equal(versionServed(state, 'ghost').id, 'original');
});

test('publish and watch only adds a version a link can ask for, and leaves the default alone', () => {
  const made = publishVersion(newVersionsState(), edit('v2'));
  assert.equal(made.ok, true);
  assert.equal(made.state.default_id, null);
  assert.equal(versionServed(made.state, undefined).id, 'original');
  assert.equal(versionServed(made.state, 'v2').title, 'Title v2');
  assert.equal(made.state.last_published_at, T0);
});

test('publish and set as default makes every link without a version show it, and the original is still asked for by id', () => {
  const made = publishVersion(newVersionsState(), edit('v2', { make_default: true }));
  assert.equal(versionServed(made.state, undefined).id, 'v2');
  assert.equal(versionServed(made.state, 'original').id, 'original');
  const back = setDefaultVersion(made.state, 'original');
  assert.equal(versionServed(back.state, undefined).id, 'original');
  assert.equal(setDefaultVersion(made.state, 'ghost').code, 'NOT_FOUND');
});

test('a publish that cannot succeed is refused before any work, with plain words', () => {
  const base = newVersionsState();
  assert.equal(canPublish({ ...base, renders_running: 1 }, { seconds: 30, now: T0 }).code, 'RENDERING');
  assert.equal(canPublish({ ...base, publishing: true }, { seconds: 30, now: T0 }).code, 'PUBLISHING');
  assert.equal(canPublish(base, { seconds: rules.min_seconds - 1, now: T0 }).code, 'TOO_SHORT');
  assert.equal(canPublish(base, { seconds: rules.min_seconds, now: T0 }).ok, true);
  const once = publishVersion(base, edit('v2')).state;
  const soon = canPublish(once, { seconds: 30, now: later(10) });
  assert.deepEqual([soon.code, soon.message], ['TOO_SOON', 'A version of this recording was published a moment ago. Wait 50 seconds, then publish again.']);
  assert.equal(canPublish(once, { seconds: 30, now: later(rules.min_gap_seconds) }).ok, true);
  assert.equal(publishVersion(once, edit('v2', { now: later(120) })).code, 'DUPLICATE');
});

test('the original and the default cannot be removed; an old version can', () => {
  let state = publishVersion(newVersionsState(), edit('v2', { make_default: true })).state;
  state = publishVersion(state, edit('v3', { now: later(120) })).state;
  assert.equal(removeVersion(state, 'original').code, 'ORIGINAL');
  assert.equal(removeVersion(state, 'v2').code, 'DEFAULT');
  assert.equal(removeVersion(state, 'ghost').code, 'NOT_FOUND');
  const removed = removeVersion(state, 'v3');
  assert.deepEqual(removed.state.versions.map((v) => v.id), ['original', 'v2']);
  assert.deepEqual(state.versions.map((v) => v.id), ['original', 'v2', 'v3'], 'the state in hand is not changed');
});
