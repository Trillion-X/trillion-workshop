// Approval is the social-posts row's action: it requires the exact reviewed values and the row's post read/write grant.
// Attribution records who approved; it is not a claim that the person saw or pressed on a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = id => rowOf(rows, `tool:${id}`);
const accountId = 'service_connection:x:second';
const account = {
  id: `connection:${encodeURIComponent(accountId)}`,
  type: 'connection',
  value: { connection_id: accountId, vendor: 'x', plain: { user_id: '1000000001' }, held: ['access_token'] },
};

test('a named post can be approved as reviewed under the row grant, without claiming page origin', async () => {
  const drafted = await answerOf(row('draft-a-post'), {
    caption: 'Thanks @proof_ana for the idea', destinations: [accountId],
  }, { records: [account] });
  assert.equal(drafted.status, 0, drafted.error);
  const { post_id: postId, approval_values: reviewed } = drafted.result.post;
  const approve = row('approve-a-post');
  assert.equal(approve.input_schema.additionalProperties, false);
  assert.ok(!('run_origin' in approve.invoke.stdin) && !('origin' in approve.input_schema.properties));
  assert.deepEqual(approve.input_schema.required, ['post_id', 'expected_values']);
  assert.deepEqual(approve.invoke.records.rights, [{ kind: 'post', operations: ['records:read', 'records:write'] }]);

  const accepted = await answerOf(approve, {
    post_id: postId, expected_values: reviewed, approved_by: 'Sample AI',
  }, { records: drafted.kept });
  assert.equal(accepted.status, 0, accepted.error);
  assert.equal(accepted.result.post.status, 'approved');
  assert.equal(accepted.result.post.approved_by, 'Sample AI');
  assert.equal(accepted.kept.find(record => record.id === postId).value.approved_from, undefined);

  const readOnly = structuredClone(approve);
  readOnly.invoke.records.rights[0].operations = ['records:read'];
  const denied = await answerOf(readOnly, {
    post_id: postId, expected_values: reviewed, approved_by: 'Sample AI',
  }, { records: drafted.kept });
  assert.equal(denied.status, 1);
  assert.equal(denied.kept.find(record => record.id === postId).value.status, 'draft');
});

test('a post changed after review cannot be approved from the stale snapshot', async () => {
  const drafted = await answerOf(row('draft-a-post'), {
    caption: 'Thanks @proof_ana for the idea', destinations: [accountId],
  }, { records: [account] });
  assert.equal(drafted.status, 0, drafted.error);
  const { post_id: postId, approval_values: reviewed } = drafted.result.post;
  const changed = await answerOf(row('draft-a-post'), {
    post_id: postId, caption: 'Thanks @proof_ana for the updated idea',
  }, { records: drafted.kept });
  assert.equal(changed.status, 0, changed.error);

  const stale = await answerOf(row('approve-a-post'), {
    post_id: postId, expected_values: reviewed,
  }, { records: changed.kept });
  assert.equal(stale.status, 1);
  assert.match(stale.error, /changed after it was reviewed/);
  assert.equal(stale.kept.find(record => record.id === postId).value.status, 'draft');
});
