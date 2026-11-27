// Approval is the social-posts row's action: it requires the exact reviewed values and answers the approved post to
// keep; the run is handed the post as records and no records door, and stores nothing.
// Attribution records who approved; it is not a claim that the person saw or pressed on a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const row = id => rowOf(rows, `tool:${id}`);
const accountId = 'service_connection:x:second';
const account = {
  id: `connection:${encodeURIComponent(accountId)}`,
  type: 'connection',
  value: { connection_id: accountId, vendor: 'x', plain: { user_id: '1000000001' }, held: ['access_token'] },
};
// The records after an answer: what was handed in, with each row the answer says to keep put over it by id.
const after = (records, ran) => [...records.filter(one => !(ran.result.keep ?? []).some(kept => kept.id === one.id)), ...(ran.result.keep ?? [])];
const drafted = async () => {
  const ran = await answerOf(row('draft-a-post'), { caption: 'Thanks @proof_ana for the idea', destinations: [accountId], records: [account] });
  assert.equal(ran.status, 0, ran.error);
  return { ran, records: after([account], ran) };
};

test('a named post can be approved as reviewed and comes back under keep, without claiming page origin', async () => {
  const { ran, records } = await drafted();
  const { post_id: postId, approval_values: reviewed } = ran.result.post;
  const approve = row('approve-a-post');
  assert.equal(approve.input_schema.additionalProperties, false);
  assert.ok(!('run_origin' in approve.invoke.stdin) && !('origin' in approve.input_schema.properties));
  assert.deepEqual(approve.input_schema.required, ['post_id', 'expected_values', 'records']);
  assert.equal(approve.invoke.records, undefined);

  const accepted = await answerOf(approve, { post_id: postId, expected_values: reviewed, approved_by: 'Sample AI', records });
  assert.equal(accepted.status, 0, accepted.error);
  assert.equal(accepted.result.post.status, 'approved');
  assert.equal(accepted.result.post.approved_by, 'Sample AI');
  assert.equal(accepted.result.keep.find(record => record.id === postId).value.approved_from, undefined);
  assert.deepEqual(accepted.calls, [], 'the run stores nothing: it calls no door');
});

test('a post changed after review cannot be approved from the stale snapshot', async () => {
  const { ran, records } = await drafted();
  const { post_id: postId, approval_values: reviewed } = ran.result.post;
  const changed = await answerOf(row('draft-a-post'), { post_id: postId, caption: 'Thanks @proof_ana for the updated idea', records });
  assert.equal(changed.status, 0, changed.error);

  const stale = await answerOf(row('approve-a-post'), { post_id: postId, expected_values: reviewed, records: after(records, changed) });
  assert.equal(stale.status, 1);
  assert.match(stale.error, /changed after it was reviewed/);
});

test('page-origin claims supply no reviewed snapshot', async () => {
  const { ran, records } = await drafted();
  const claimedPage = { by_person: true, origin: 'signed-in-page', approved_by: 'person',
    sign_in: 'session:page-one', 'x-trillion-typed-on-signed-in-screen': 'yes' };
  const noReview = await answerOf(row('approve-a-post'), { post_id: ran.result.post.post_id, ...claimedPage, records });
  assert.equal(noReview.status, 1);
  assert.deepEqual(noReview.kept, []);
});
