// tools/workspace-screens/test/members-page-rows.test.mjs
//
// The members page's pure rules (web/members-page/rows.mjs) over the Workshop's own packages: a screen module is found by its
// file and keyed the way a sidebar row names it; two files sharing a key are refused; a row takes only the host values it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenInputOf, screenKeyOf, surfaceKeyOf, tourDefinitionsOf } from '../web/members-page/rows.mjs';
import { screenModulesIn, screenModulesOf } from '../web/members-page/registry.mjs';

const tools = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

test('a screen module is keyed by its package and its file name, the key a row names', () => {
  assert.equal(screenKeyOf('lessons-and-learning-paths', 'web/course-lesson-screen-mount.tsx'), 'lessons-and-learning-paths/course-lesson-screen-mount');
  assert.equal(screenKeyOf('take-payments', '/x/web/src/workspace/billing-screen-mount.tsx'), 'take-payments/billing-screen-mount');
});

test('a sidebar row names its screen by its package_entry', () => {
  const row = { payload: { package_entry: { package_name: 'take-payments', entry_name: 'billing-screen-mount' } } };
  assert.equal(surfaceKeyOf(row), 'take-payments/billing-screen-mount');
});

test('the Workshop packages hold the screens the members site names, found under web/ wherever they sit', () => {
  const keysOf = packageName => screenModulesIn(tools, packageName).map(module => module.key);
  assert.ok(keysOf('lessons-and-learning-paths').includes('lessons-and-learning-paths/course-list-screen-mount'));
  assert.ok(keysOf('lessons-and-learning-paths').includes('lessons-and-learning-paths/course-lesson-screen-mount'));
  assert.ok(keysOf('take-payments').includes('take-payments/billing-screen-mount'));
  assert.ok(keysOf('referral-codes-and-rewards').includes('referral-codes-and-rewards/invite-a-friend-screen-mount'));
  assert.ok(keysOf('better-auth-official').includes('better-auth-official/account-screen-mount'));
  assert.ok(keysOf('keep-lists-of-rows').includes('keep-lists-of-rows/lists-screen-mount'));
});

test('two screen modules that share a key are refused', () => {
  assert.throws(() => screenModulesOf(tools, ['lessons-and-learning-paths', 'lessons-and-learning-paths']), /share the key/);
});

test('a row takes only the host values its host_input names, and nothing else reaches the screen', () => {
  const host = { subject_email: 'a@example.test', subscription_id: 'sub_1', secret: 'x' };
  assert.deepEqual(screenInputOf({ host_input: ['subject_email'], video_field: 'video_url' }, host), { subject_email: 'a@example.test', video_field: 'video_url' });
  assert.deepEqual(screenInputOf({ host_input: ['missing'] }, host), {});
  assert.deepEqual(screenInputOf(undefined, host), {});
});

test('a page whose host answers no tour records gets no tour, so no tour host is mounted', () => {
  for (const none of [undefined, null, {}, [], { definitions: [] }, 'own-tours', [{ kind: 'something-else', id: 'x' }], [{ kind: 'walkthrough-definition' }]]) {
    assert.deepEqual(tourDefinitionsOf(none), []);
  }
});

test('the person\'s own tours are taken as records or as { payload } entries', () => {
  const tour = { kind: 'walkthrough-definition', id: 'own-tour:a', entry_step: 'one', steps: [], triggers: [] };
  assert.deepEqual(tourDefinitionsOf([tour]), [tour]);
  assert.deepEqual(tourDefinitionsOf([{ payload: tour }]), [tour]);
  assert.deepEqual(tourDefinitionsOf({ definitions: [tour] }), [tour]);
});
