// test/sharing-state.test.mjs
// The Privacy screen's sharing and stories facts (src/sharing-state.mjs), read by the account's own records resource
// (src/native-owner-routes.json sharing-state, GET /sharing/state): a default covers only decisions from its day, an
// explicit choice always wins, and a count the pool cannot give is null, never zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/pool-settings.json' with { type: 'json' };
import { sharingChoice } from '../src/sharing-choice.mjs';
import { publishedStoriesOf, sharingStateOf, storiesStateOf } from '../src/sharing-state.mjs';
import { ownerRouteCommand } from '../../address-installed-capabilities/src/native-owner-routes.mjs';

const pool = (counts = {}) => ({
  sharedCount: async () => counts.shared ?? 7,
  storyCounts: async () => counts.stories ?? { career: 2, money: 1 },
});
const down = () => ({ sharedCount: async () => { throw new Error('down'); }, storyCounts: async () => { throw new Error('down'); } });

test('a default covers only decisions made on or after its day; an explicit choice always wins', () => {
  const share = settings.sharing_defaults.share;
  const before = `${share.from_day.slice(0, 8)}01T00:00:00Z`;
  assert.equal(sharingChoice(undefined, share, before), false, 'a decision before the default is never shared under it');
  assert.equal(sharingChoice(undefined, share, new Date().toISOString()), true, 'a decision today is shared under the default');
  assert.equal(sharingChoice(false, share, new Date().toISOString()), false, 'turning it off is kept');
  assert.equal(sharingChoice(true, share, before), true, 'turning it on is kept, even for an earlier decision');
});

test('sharing: its state and the pool\'s count; a pool that cannot answer reads null, not zero', async () => {
  const share = settings.sharing_defaults.share;
  assert.deepEqual(await sharingStateOf(undefined, pool()), { on: true, chosen: false, from_day: share.from_day, shared_so_far: 7 });
  assert.deepEqual(await sharingStateOf({ anonymized: false }, pool()), { on: false, chosen: true, from_day: share.from_day, shared_so_far: 7 });
  assert.equal((await sharingStateOf(undefined, down())).shared_so_far, null);
});

test('stories: the state, the published total, and the stories this person published, newest first', async () => {
  const rows = [
    { name: 'story:case_a', value: { published: true, id: 'st_a', title: 'A', at: '2026-10-01T00:00:00Z' } },
    { name: 'story:case_b', value: { published: true, id: 'st_b', title: 'B', at: '2026-10-05T00:00:00Z' } },
    { name: 'story:case_c', value: { published: false, id: 'st_c', title: 'C', at: '2026-10-09T00:00:00Z' } },
  ];
  const published = publishedStoriesOf(rows);
  assert.deepEqual(published.map(story => story.story_id), ['st_b', 'st_a'], 'only published stories, newest first');
  assert.deepEqual(published[0], { case_id: 'case_b', story_id: 'st_b', title: 'B', at: '2026-10-05T00:00:00Z' });
  const state = await storiesStateOf(undefined, pool(), published);
  assert.equal(state.published_so_far, 3);
  assert.equal(state.on, true);
  assert.equal(state.chosen, false);
  assert.equal((await storiesStateOf({ on: false }, down(), [])).published_so_far, null);
});

test('the Privacy screen reads its sharing state from the account\'s own records resource, GET /sharing/state', () => {
  const [operation, body] = ownerRouteCommand('/sharing/state', 'GET', undefined);
  assert.equal(operation, 'sharing-state:request');
  assert.deepEqual(body, { path: '/sharing/state', method: 'GET', body: {} });
});
