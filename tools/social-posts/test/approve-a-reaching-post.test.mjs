// A post that reaches someone is approved only by the person on their own Posts screen: the host sets by_person, and no
// caller's input can. Every name and handle here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { approveAPost } from '../read-data/posts.mjs';
import { sendAPost } from '../read-data/send-a-post.mjs';
import { approvalValues } from '../read-data/post-shape.mjs';
import settings from '../read-data/posts.json' with { type: 'json' };

const draft = (fields = {}) => ({ post_id: `${settings.record_type}:p1`, status: 'draft', caption: 'A plain post.', destinations: ['x-account'], scheduled_for: null, ...fields });
const input = post => ({ post_id: 'p1', expected_values: approvalValues(post), records: [{ id: `${settings.record_type}:p1`, type: settings.record_type, value: post }] });

test('a post that lists someone in reaches is refused an AI approval', async () => {
  const post = draft({ reaches: [{ network: 'x', handle: 'sample_person', profile_url: 'https://x.example/sample_person', provenance: [{ source: 'x', url: 'https://x.example/post/1' }] }] });
  await assert.rejects(approveAPost(input(post)), /only the person can approve it/);
});

test('a post whose words name an @handle is refused an AI approval, in any place', async () => {
  const post = draft({ caption_by_platform: { x: 'Thanks @sample_person for the tip.' } });
  await assert.rejects(approveAPost(input(post)), /only the person can approve it/);
});

test('the host, not the caller, can approve a reaching post', async () => {
  const post = draft({ caption: 'Hi @sample_person.' });
  const approved = await approveAPost(input(post), { by_person: true });
  assert.equal(approved.post.status, 'approved');
});

test('a by_person field in the caller input never approves a reaching post', async () => {
  const post = draft({ caption: 'Hi @sample_person.' });
  await assert.rejects(approveAPost({ ...input(post), by_person: true }), /only the person can approve it/);
});

test('a post that reaches nobody is approved as before', async () => {
  const approved = await approveAPost(input(draft()));
  assert.equal(approved.post.status, 'approved');
});

test('the sender refuses a reaching post that the person never approved, even if approved_at is set', async () => {
  const post = draft({ caption: 'Hi @sample_person.', approved_at: '2099-01-01T00:00:00.000Z', status: 'approved', approved_by_person: false });
  await assert.rejects(sendAPost({ post_id: 'post:p1', place: 'x', account_id: 'x-account', records: [{ id: `${settings.record_type}:p1`, type: settings.record_type, value: post }] }), /the person never approved it/);
});
