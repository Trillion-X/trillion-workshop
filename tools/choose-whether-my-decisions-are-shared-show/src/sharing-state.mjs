// src/sharing-state.mjs
//
// Purpose: what the Privacy screen shows about sharing and stories, read by the account's own records resource
//   (src/native-owner-routes.json sharing-state, GET /sharing/state): whether each is on, whether that is the person's own
//   choice or the default, the day the default began, and how many decisions everyone has shared or published so far
//   (null when the shared pool cannot answer, which the screen says instead of a number).
//
// Non-Negotiable Invariants:
//   1. The choice is read through sharingView (src/sharing-choice.mjs), the one rule the publication owner decides with, so
//      the screen never shows a state the publication would not act on.
//   2. A pool that cannot answer is null, never zero: a count the screen cannot read is not shown as none.
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/pool-settings.json' with { type: 'json' };
import { sharingView } from './sharing-choice.mjs';

/** Sharing: { on, chosen, from_day, shared_so_far }, from the person's `share` choice and the shared pool's count. */
export async function sharingStateOf(share, pool) {
  const shared_so_far = await pool.sharedCount().catch(() => null);
  return { ...sharingView(share?.anonymized, settings.sharing_defaults.share), shared_so_far };
}

/** The stories this person published, newest first, with the decision each came from (rows are store.settings('story:')). */
export const publishedStoriesOf = rows => rows.filter(({ value }) => value?.published).map(({ name, value }) => ({ case_id: name.slice('story:'.length), story_id: value.id, title: value.title, at: value.at }))
  .sort((a, b) => String(b.at).localeCompare(String(a.at)));

/** Stories: { on, chosen, from_day, published_so_far, stories }, from the `stories` choice, the pool's counts and the stories
 *  this person published (newest first, for their own screen only). */
export async function storiesStateOf(stories, pool, publishedStories) {
  const counts = await pool.storyCounts().catch(() => null);
  const published_so_far = counts && Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { ...sharingView(stories?.on, settings.sharing_defaults.stories), published_so_far, stories: publishedStories };
}
