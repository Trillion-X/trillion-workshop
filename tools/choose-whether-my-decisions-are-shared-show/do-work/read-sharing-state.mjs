// tools/choose-whether-my-decisions-are-shared-show/do-work/read-sharing-state.mjs
//
// tool:read-sharing-state: what the Privacy screen shows about sharing and stories for one account: whether each is on,
// whether that is the person's own choice or the default, the day the default began, how many decisions everyone has
// shared or published so far, and the stories this person published. Ported from the old codebase's readPrivacy
// (src/screen-reads.mjs, at commit b6ae0ebf815f), whose sharing part read the same owner rules. The caller hands in the
// person's stored choices and the pool's counts; a count the pool could not give is null, never zero.
import { sharingStateOf, publishedStoriesOf, storiesStateOf } from '../src/sharing-state.mjs';

/** Sharing and stories for one account. `share` and `stories` are the person's stored choices (or null), `sharedCount` and
 *  `storyCounts` the pool's counts (null when the pool could not answer), `storyRows` the person's story records. */
export async function readSharingState({ share = null, stories = null, sharedCount = null, storyCounts = null, storyRows = [] } = {}) {
  const sharedPool = { sharedCount: async () => { if (sharedCount === null) throw new Error('the pool could not answer'); return sharedCount; } };
  const storiesPool = { storyCounts: async () => { if (storyCounts === null) throw new Error('the pool could not answer'); return storyCounts; } };
  return {
    sharing: await sharingStateOf(share ?? undefined, sharedPool),
    stories: await storiesStateOf(stories ?? undefined, storiesPool, publishedStoriesOf(storyRows)),
  };
}
