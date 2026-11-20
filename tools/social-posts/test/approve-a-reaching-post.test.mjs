// A post that reaches someone is approved only on the person's yes: the host's by_person (their page), or their standing setting for
// reaching posts set to auto. Each answer keeps an approval-decision row. Every name and handle here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { approveAPost } from '../read-data/posts.mjs';
import { sendAPost } from '../read-data/send-a-post.mjs';
import { approvalValues } from '../read-data/post-shape.mjs';
import settings from '../read-data/posts.json' with { type: 'json' };

const draft = (fields = {}) => ({ post_id: `${settings.record_type}:p1`, status: 'draft', caption: 'A plain post.', destinations: ['x-account'], scheduled_for: null, ...fields });
const input = post => ({ post_id: 'p1', expected_values: approvalValues(post), records: [{ id: `${settings.record_type}:p1`, type: settings.record_type, value: post }] });
const setting = mode => ({ id: 'approval-setting:reaching-posts', type: 'approval-setting', value: { mode } });
const withSetting = (post, mode) => ({ ...input(post), records: [...input(post).records, setting(mode)] });
const decisionOf = answer => answer.keep.find(row => row.type === 'approval-decision').value;
const reachingPost = () => draft({ caption: 'Hi @sample_person.' });

test('a post that lists someone in reaches is refused with no setting row, and the refusal is kept', async () => {
  const post = draft({ reaches: [{ network: 'x', handle: 'sample_person', profile_url: 'https://x.example/sample_person', provenance: [{ source: 'x', url: 'https://x.example/post/1' }] }] });
  const refused = await approveAPost(input(post));
  assert.equal(refused.post, undefined);
  assert.match(refused.said, /only the person can approve it/);
  assert.equal(decisionOf(refused).decision, 'refused');
  assert.equal(decisionOf(refused).approved_how, null);
});

test('a post whose words name an @handle is refused under an ask setting', async () => {
  const refused = await approveAPost(withSetting(reachingPost(), 'ask'));
  assert.equal(refused.post, undefined);
  assert.equal(decisionOf(refused).mode, 'ask');
  assert.equal(decisionOf(refused).decision, 'refused');
});

test('an auto setting approves a reaching post, marks it approved by the person, and keeps a decision row', async () => {
  const post = reachingPost();
  const approved = await approveAPost(withSetting(post, 'auto'));
  assert.equal(approved.post.status, 'approved');
  const kept = approved.keep.find(row => row.id === post.post_id).value;
  assert.equal(kept.approved_by_person, true);
  assert.equal(kept.approved_how, 'auto-setting');
  const decision = decisionOf(approved);
  assert.equal(decision.decision, 'approved');
  assert.equal(decision.approved_how, 'auto-setting');
  assert.equal(decision.setting_id, 'approval-setting:reaching-posts');
  assert.equal(decision.mode, 'auto');
  assert.equal(decision.post_id, post.post_id);
});

test('the host yes approves a reaching post even under an ask setting, and the decision says by-person', async () => {
  const approved = await approveAPost(withSetting(reachingPost(), 'ask'), { by_person: true });
  assert.equal(approved.post.status, 'approved');
  assert.equal(decisionOf(approved).approved_how, 'by-person');
  assert.equal(decisionOf(approved).setting_id, null);
});

test('a post that reaches nobody needs no setting, and its decision says no-reach', async () => {
  const approved = await approveAPost(input(draft()));
  assert.equal(approved.post.status, 'approved');
  assert.equal(decisionOf(approved).approved_how, 'no-reach');
});

test('a by_person field in the input is not a setting: a reaching post under no setting is still refused', async () => {
  const refused = await approveAPost({ ...input(reachingPost()), by_person: true });
  assert.equal(refused.post, undefined);
  assert.equal(decisionOf(refused).decision, 'refused');
});

test('the sender refuses a reaching post that the person never approved, even if approved_at is set', async () => {
  const post = draft({ caption: 'Hi @sample_person.', approved_at: '2099-01-01T00:00:00.000Z', status: 'approved', approved_by_person: false });
  await assert.rejects(sendAPost({ post_id: 'post:p1', place: 'x', account_id: 'x-account', records: [{ id: `${settings.record_type}:p1`, type: settings.record_type, value: post }] }), /the person never approved it/);
});
