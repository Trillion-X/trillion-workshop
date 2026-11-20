// Old codebase test/catalogue-screen-privacy.test.mjs (at commit b6ae0ebf815f): the sharing and stories assertions, run
// against the row's read in do-work/read-sharing-state.mjs. The HQ-sharing, who-may-look and counting sections of the old
// read are not here: each needs an owner that is not on origin/main (see the research row).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSharingState } from '../do-work/read-sharing-state.mjs';
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/pool-settings.json' with { type: 'json' };
import { fromDayWords } from '../src/sharing-choice.mjs';

const storyRows = [
  { name: 'story:case_a', value: { published: true, id: 'st_a', title: 'A', at: '2026-10-01T00:00:00Z' } },
  { name: 'story:case_b', value: { published: true, id: 'st_b', title: 'B', at: '2026-10-05T00:00:00Z' } },
  { name: 'story:case_c', value: { published: false, id: 'st_c', title: 'C', at: '2026-10-09T00:00:00Z' } },
];

test('the read gathers sharing and stories: the default, the day it began in words, the pool counts and the published stories', async () => {
  const facts = await readSharingState({ share: null, stories: { on: false }, sharedCount: 12, storyCounts: { career: 2, money: 1 }, storyRows });
  assert.deepEqual([facts.sharing.on, facts.sharing.chosen, facts.sharing.shared_so_far], [true, false, 12]);
  assert.equal(fromDayWords(facts.sharing.from_day), 'September 28, 2026');
  assert.equal(facts.sharing.from_day, settings.sharing_defaults.share.from_day);
  assert.deepEqual([facts.stories.on, facts.stories.chosen, facts.stories.published_so_far], [false, true, 3]);
  assert.deepEqual(facts.stories.stories.map(story => story.story_id), ['st_b', 'st_a'], 'only published stories, newest first');
});

test('a count the pool cannot give is null, not zero, and the screen still answers', async () => {
  const facts = await readSharingState({ share: { anonymized: false }, stories: null, sharedCount: null, storyCounts: null, storyRows: [] });
  assert.deepEqual([facts.sharing.on, facts.sharing.chosen, facts.sharing.shared_so_far], [false, true, null]);
  assert.equal(facts.stories.published_so_far, null);
  assert.deepEqual(facts.stories.stories, []);
});

test('an explicit choice always wins over the default', async () => {
  const facts = await readSharingState({ share: { anonymized: false }, stories: { on: true }, sharedCount: 0, storyCounts: {}, storyRows: [] });
  assert.equal(facts.sharing.on, false);
  assert.equal(facts.stories.on, true);
});
