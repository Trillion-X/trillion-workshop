// The database approval reads the post and the person's setting from the pursuit database, never from the request. A fake client
// stands in for the database here; every name and handle is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { approveInDatabase, ApproveInDatabaseError } from '../do-work/approve-a-post-in-database.mjs';
import { approvalValues } from '../read-data/post-shape.mjs';

const postValue = (fields = {}) => ({ post_id: 'post:p1', person: 'person:sample', status: 'draft', caption: 'A plain post.', caption_by_platform: {}, settings_by_platform: {}, destinations: ['x-account'], link: null, scheduled_for: null, time_zone: null, source: null, format_id: null, reaches: [], media: null, ...fields });
const reaching = fields => postValue({ caption: 'Hi @sample_person.', ...fields });

// A fake of the three tables the program touches: post, approval_setting and approval_decision.
function fakeDatabase({ posts = [], settings = [] }) {
  const db = { posts, settings, decisions: [] };
  const client = {
    async query(text, values = []) {
      if (text.startsWith('SELECT post_id, person, value FROM post')) return { rows: db.posts.filter(row => row.post_id === values[0]) };
      if (text.startsWith('SELECT mode FROM approval_setting')) return { rows: db.settings.filter(row => row.person === values[0] && row.scope === values[1]) };
      if (text.startsWith('UPDATE post')) {
        const row = db.posts.find(item => item.post_id === values[0]);
        row.value = JSON.parse(values[1]); row.status = values[2];
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO approval_decision')) {
        db.decisions.push({ id: values[0], post_id: values[1], person: values[2], at: values[3], decision: values[4], approved_how: values[5], setting_id: values[6], mode: values[7], reason: values[8], approved_by: values[9] });
        return { rows: [] };
      }
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
      throw new Error(`unexpected SQL in the fake: ${text}`);
    },
  };
  return { db, client };
}

const row = (value, extra = {}) => ({ post_id: value.post_id, person: value.person, status: value.status, value, ...extra });
const request = (value, extra = {}) => ({ post_id: value.post_id, expected_values: approvalValues(value), approved_by: 'Sample AI', ...extra });
const at = () => new Date('2099-06-01T09:00:00.000Z');

test('a database auto row approves the reaching post and keeps an approved decision row', async () => {
  const value = reaching();
  const { db, client } = fakeDatabase({ posts: [row(value)], settings: [{ person: 'person:sample', scope: 'reaching-posts', mode: 'auto' }] });
  const answer = await approveInDatabase(request(value), client, { now: at });
  assert.equal(answer.post.status, 'approved');
  assert.equal(db.posts[0].status, 'approved');
  assert.equal(db.decisions.length, 1);
  assert.equal(db.decisions[0].decision, 'approved');
  assert.equal(db.decisions[0].approved_how, 'auto-setting');
  assert.equal(db.decisions[0].setting_id, 'approval-setting:reaching-posts');
  assert.equal(db.decisions[0].mode, 'auto');
  assert.equal(db.decisions[0].at, '2099-06-01T09:00:00.000Z');
  assert.equal(answer.database_decisions.length, 1);
});

test('a database ask row refuses the reaching post and keeps a refused decision row; the post stays a draft', async () => {
  const value = reaching();
  const { db, client } = fakeDatabase({ posts: [row(value)], settings: [{ person: 'person:sample', scope: 'reaching-posts', mode: 'ask' }] });
  const answer = await approveInDatabase(request(value), client, { now: at });
  assert.equal(answer.post, undefined);
  assert.equal(db.posts[0].status, 'draft');
  assert.equal(db.decisions[0].decision, 'refused');
  assert.equal(db.decisions[0].mode, 'ask');
});

test('a person with no setting row is asked, and their refusal is kept', async () => {
  const value = reaching({ post_id: 'post:p2', person: 'stranger-with-no-row' });
  const { db, client } = fakeDatabase({ posts: [row(value)], settings: [{ person: 'person:sample', scope: 'reaching-posts', mode: 'auto' }] });
  const answer = await approveInDatabase(request(value), client, { now: at });
  assert.equal(answer.post, undefined);
  assert.equal(db.decisions[0].decision, 'refused');
  assert.equal(db.decisions[0].mode, 'ask');
  assert.equal(db.decisions[0].setting_id, 'approval-setting:reaching-posts');
});

test('a caller-supplied auto setting in the request is ignored: the database says ask (no row)', async () => {
  const value = reaching({ post_id: 'post:p3', person: 'stranger-with-no-row' });
  const { db, client } = fakeDatabase({ posts: [row(value)] });
  const forged = request(value, { records: [{ id: 'approval-setting:reaching-posts', type: 'approval-setting', value: { mode: 'auto' } }] });
  const answer = await approveInDatabase(forged, client, { now: at });
  assert.equal(answer.post, undefined);
  assert.equal(db.posts[0].status, 'draft');
  assert.equal(db.decisions[0].decision, 'refused');
});

test('a by_person field in the request is ignored: only the host page can approve a reaching post by hand', async () => {
  const value = reaching({ post_id: 'post:p4', person: 'stranger-with-no-row' });
  const { db, client } = fakeDatabase({ posts: [row(value)] });
  const answer = await approveInDatabase(request(value, { by_person: true }), client, { now: at });
  assert.equal(answer.post, undefined);
  assert.equal(db.decisions[0].decision, 'refused');
});

test('the setting read is the post owner\'s: another person\'s auto row does not approve this person\'s post', async () => {
  const value = reaching({ post_id: 'post:p5', person: 'stranger-with-no-row' });
  const { db, client } = fakeDatabase({ posts: [row(value)], settings: [{ person: 'person:sample', scope: 'reaching-posts', mode: 'auto' }] });
  const answer = await approveInDatabase(request(value), client, { now: at });
  assert.equal(answer.post, undefined);
  assert.equal(db.decisions[0].decision, 'refused');
});

test('a post that reaches nobody needs no setting, and its decision says no-reach', async () => {
  const value = postValue({ post_id: 'post:p6' });
  const { db, client } = fakeDatabase({ posts: [row(value)] });
  const answer = await approveInDatabase(request(value), client, { now: at });
  assert.equal(answer.post.status, 'approved');
  assert.equal(db.decisions[0].approved_how, 'no-reach');
});

test('a reviewed snapshot that no longer matches approves nothing and writes nothing', async () => {
  const value = reaching({ post_id: 'post:p7' });
  const { db, client } = fakeDatabase({ posts: [row(value)], settings: [{ person: 'person:sample', scope: 'reaching-posts', mode: 'auto' }] });
  const stale = request(value, { expected_values: approvalValues({ ...value, caption: 'Changed after review.' }) });
  await assert.rejects(approveInDatabase(stale, client, { now: at }), /changed after it was reviewed/);
  assert.equal(db.posts[0].status, 'draft');
  assert.equal(db.decisions.length, 0);
});

test('an unknown post is refused with a plain message, before anything is read beyond the post', async () => {
  const { client } = fakeDatabase({});
  await assert.rejects(approveInDatabase({ post_id: 'post:nope', expected_values: {} }, client), ApproveInDatabaseError);
});
