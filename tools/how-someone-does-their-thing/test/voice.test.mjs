// The person's writing voice (src/voice.mjs through the posts owner): a change the person makes to a draft's words is kept
// as their edit, an AI saves what it learned as a profile, every drafting AI reads both, and each can be forgotten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PERSON_APP } from '../src/activity.mjs';
import { handlePostsRequest } from '../src/social-posts.mjs';
import { posts } from './social-posts-for-tests.mjs';

test('the person changing an AI draft\'s words is kept as an edit; an AI changing them is not', async () => {
  const { owner } = posts();
  const { post } = await owner.draft({ caption: 'Excited to announce our synergistic launch!', destinations: ['first-vendor'] }, { app: 'Claude' });
  await owner.draft({ post_id: post.post_id, caption: 'Excited to announce our synergistic launch! Version 2' }, { app: 'Claude' });
  assert.equal(owner.voice.read({}).edits.length, 0, 'an AI revising its own draft says nothing about the person');
  const edited = await owner.draft({ post_id: post.post_id, caption: 'We launched today.' }, { app: PERSON_APP });
  const read = owner.voice.read({});
  console.log('VOICE READBACK edits:', JSON.stringify(read.edits.map(({ before, after, before_by }) => ({ before, after, before_by }))));
  assert.deepEqual(read.edits.map(({ before, after, before_by }) => ({ before, after, before_by })), [{ before: 'Excited to announce our synergistic launch! Version 2', after: 'We launched today.', before_by: 'Claude' }]);
  assert.equal(edited.post.drafted_by, 'Claude', 'the AI that wrote the draft stays on it');
  assert.ok(edited.post.edited_by_person_at, 'the post says the person changed its words');
  await owner.draft({ post_id: post.post_id, scheduled_for: '2030-01-01T10:00:00Z' }, { app: PERSON_APP });
  assert.equal(owner.voice.read({}).edits.length, 1, 'moving the time is not an edit of the words');
});

test('an AI saves a profile by the DATA fields, a stale save is refused, and read gives profiles, edits and sent words together', async () => {
  const { owner } = posts();
  const { post } = await owner.draft({ caption: 'Stronger together', destinations: ['first-vendor'] }, { app: 'Claude' });
  await owner.draft({ post_id: post.post_id, caption: 'Short and plain.' }, { app: PERSON_APP });
  const saved = owner.voice.save({ kind: 'post', name: 'Posts', fields: { how_they_write: 'Short, plain, no slogans.', words_they_avoid: 'synergy' } });
  await assert.rejects(async () => owner.voice.save({ kind: 'post', fields: { tone: 'warm' } }), /tone is not a field of a voice profile\. The fields are: how_they_write/);
  await assert.rejects(async () => owner.voice.save({ kind: 'Post!', fields: { how_they_write: 'x' } }), /short lower-case name/);
  owner.voice.save({ kind: 'post', fields: { examples: 'We launched today.' }, expected_set_at: saved.profile.set_at });
  assert.throws(() => owner.voice.save({ kind: 'post', fields: { examples: 'older' }, expected_set_at: saved.profile.set_at }), /Read it again with read_voice|saved again at/);
  const read = owner.voice.read({ kind: 'post' });
  console.log('VOICE READBACK profile:', JSON.stringify(read.profiles[0].fields));
  assert.deepEqual(read.profiles[0].fields, { how_they_write: 'Short, plain, no slogans.', words_they_avoid: 'synergy', examples: 'We launched today.' });
  assert.equal(read.profiles[0].name, 'Posts');
  assert.equal(read.edits.length, 1);
  assert.deepEqual(read.fields.map(field => field.id), ['how_they_write', 'words_they_use', 'words_they_avoid', 'examples']);
});

test('forget removes a profile, one edit or every edit, and says how many', async () => {
  const { owner } = posts();
  const { post } = await owner.draft({ caption: 'a', destinations: ['first-vendor'] }, { app: 'Claude' });
  for (const words of ['b', 'c']) await owner.draft({ post_id: post.post_id, caption: words }, { app: PERSON_APP });
  owner.voice.save({ fields: { how_they_write: 'brief' } });
  const { edits, profiles } = owner.voice.read({});
  assert.equal(edits.length, 2);
  assert.equal(owner.voice.forget({ edit_id: edits[0].edit_id }).forgot, 1);
  assert.equal(owner.voice.forget({ profile_id: profiles[0].profile_id }).forgot, 1);
  assert.equal(owner.voice.forget({ all_edits: true }).forgot, 1);
  const after = owner.voice.read({});
  console.log('VOICE READBACK after forgetting:', JSON.stringify({ edits: after.edits.length, profiles: after.profiles.length }));
  assert.deepEqual([after.edits.length, after.profiles.length], [0, 0]);
  assert.throws(() => owner.voice.forget({}), /Name what to forget/);
});

test('the routes: the person\'s page saves as the person, a refusal is plain words with status 400', async () => {
  const { owner } = posts();
  const call = (path, body, app) => handlePostsRequest(owner, new Request(`https://person${path}`, { method: 'POST', headers: { 'x-trillion-app': app }, body: JSON.stringify(body) }));
  const saved = await (await call('/posts/voice/save', { fields: { how_they_write: 'brief' } }, PERSON_APP)).json();
  assert.equal(saved.profile.set_by, 'person');
  const refused = await call('/posts/voice/save', { fields: { nope: 'x' } }, 'Claude');
  assert.equal(refused.status, 400);
  assert.equal((await (await call('/posts/voice/read', {}, 'Claude')).json()).profiles.length, 1);
});
