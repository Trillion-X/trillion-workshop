// The community jobs a space holds, run as the container runs them: posting and reading a space's posts, and a person's spaces
// and events. The records are handed in, nothing is read from a store, and the test stores `keep` back the way the caller's AI
// would. A post is kept once: asking again with the same key keeps nothing. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { listASpacesPosts, listMySpacesAndEvents, postInASpace } from '../do-work/space-members.mjs';
import { KINDS, rowId } from '../read-data/space-rows.mjs';

const OWNER = 'owner@example.com';
const ANA = 'ana@example.com';
const BO = 'bo@example.com';
const spaceRow = (id, extra = {}) => ({ type: KINDS.space, id: rowId('space', id), value: { title: 'Sample club', owner: OWNER, label: 'group', config: { join: [{ free: true }] }, ...extra } });
const memberRow = (space, subject, state = 'member') => ({ type: KINDS.member, id: rowId('member', space, subject), value: { space, subject, member_type: 'member', state, how: 'free', joined_at: '2026-01-01T00:00:00.000Z' } });
const itemRow = (space, key, fields, posted_at = '2026-02-01T00:00:00.000Z') => ({ type: KINDS.item, id: rowId('item', space, key), value: { space, author: OWNER, fields, idempotency_ref: key, revision: 1, posted_at } });

test('a member who counts now posts once: the item is kept, and asking again with the same key keeps nothing', () => {
  const records = [spaceRow('club'), memberRow('club', ANA)];
  const made = postInASpace({ space: 'club', subject: ANA, records, idempotency_ref: 'post-1', fields: { text: 'Hello' } });
  assert.equal(made.posted, true);
  assert.equal(made.replay, false);
  assert.equal(made.keep.length, 1);
  assert.equal(made.keep[0].id, rowId('item', 'club', 'post-1'));
  assert.equal(made.keep[0].expected, null);
  assert.equal(made.keep[0].value.author, ANA);
  const again = postInASpace({ space: 'club', subject: ANA, records: [...records, { type: made.keep[0].type, id: made.keep[0].id, value: made.keep[0].value }], idempotency_ref: 'post-1', fields: { text: 'Hello' } });
  assert.equal(again.posted, false);
  assert.equal(again.replay, true);
  assert.equal(again.keep, undefined);
});

test('a person who is not in the space, or has left it, cannot post', () => {
  assert.throws(() => postInASpace({ space: 'club', subject: BO, records: [spaceRow('club')], idempotency_ref: 'post-2', fields: { text: 'Hi' } }), /not|join|member/i);
  assert.throws(() => postInASpace({ space: 'club', subject: ANA, records: [spaceRow('club'), memberRow('club', ANA, 'left')], idempotency_ref: 'post-3', fields: { text: 'Hi' } }));
});

test('a post must name its key, and its fields may not set what the post sets itself', () => {
  const records = [spaceRow('club'), memberRow('club', ANA)];
  assert.throws(() => postInASpace({ space: 'club', subject: ANA, records, fields: { text: 'Hi' } }), /idempotency_ref/);
  assert.throws(() => postInASpace({ space: 'club', subject: ANA, records, idempotency_ref: 'post-4', fields: { author: BO } }), /may not set author/);
  assert.throws(() => postInASpace({ space: 'club', subject: ANA, records, idempotency_ref: 'post-5', fields: [] }), /fields must be an object/);
});

test('the posts of a space are read by its members only, newest first, and only that space\'s posts', () => {
  const records = [spaceRow('club'), spaceRow('other'), memberRow('club', ANA), itemRow('club', 'a', { text: 'old' }, '2026-02-01T00:00:00.000Z'), itemRow('club', 'b', { text: 'new' }, '2026-03-01T00:00:00.000Z'), itemRow('other', 'c', { text: 'elsewhere' })];
  const read = listASpacesPosts({ space: 'club', subject: ANA, records });
  assert.deepEqual(read.items.map(item => item.fields.text), ['new', 'old']);
  assert.throws(() => listASpacesPosts({ space: 'club', subject: BO, records }), /not|join|member/i);
});

test('a person\'s spaces and events: the spaces they count in now, and the events in them between from and to, soonest first', () => {
  const records = [
    spaceRow('club'), spaceRow('gone'), memberRow('club', ANA), memberRow('gone', ANA, 'left'),
    itemRow('club', 'e2', { title: 'Late', starts_at: '2026-05-02T10:00:00.000Z' }),
    itemRow('club', 'e1', { title: 'Early', about: 'Bring a racket', starts_at: '2026-05-01T10:00:00.000Z', ends_at: '2026-05-01T11:00:00.000Z' }),
    itemRow('club', 'p', { text: 'not an event' }),
    itemRow('gone', 'e3', { title: 'Gone', starts_at: '2026-05-01T12:00:00.000Z' }),
  ];
  const all = listMySpacesAndEvents({ subject: ANA, records });
  assert.deepEqual(all.spaces.map(space => space.space), ['club']);
  assert.deepEqual(all.events.map(event => event.title), ['Early', 'Late']);
  assert.equal(all.events[0].about, 'Bring a racket');
  assert.equal(all.events[0].space_title, 'Sample club');
  const window = listMySpacesAndEvents({ subject: ANA, records, from: '2026-05-02T00:00:00.000Z', to: '2026-05-03T00:00:00.000Z' });
  assert.deepEqual(window.events.map(event => event.title), ['Late']);
});

test('the three tool rows sit beside the membership rows and run their functions', () => {
  const expect = { 'tool:post-in-a-space': 'postInASpace', 'tool:list-a-spaces-posts': 'listASpacesPosts', 'tool:list-my-spaces-and-events': 'listMySpacesAndEvents' };
  for (const [id, fn] of Object.entries(expect)) {
    const row = rows.records.find(record => record.payload.id === id);
    assert.ok(row, `${id} exists`);
    assert.equal(row.payload.invoke.run.at(-1), fn);
  }
});
