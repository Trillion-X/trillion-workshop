// tools/turn-a-finished-decision-into-an-anonymous-public/read-data/story-shelf.mjs
//
// The public shelf of stories: newest first, a page at a time, filtered by kind, with counts and take-down. Ported from
// the old app's src/story-shelf.mjs and its pool methods (stories, storyCounts, unpublishStory). Pure: the caller hands
// in the stories it holds; the storage is the caller's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A story taken down is never listed, counted or returned again (`withdrawn`). Taking down is permanent here.
//   2. Order is published_at descending, then id descending, so a page cut is stable when stories arrive between pages.
//   3. The page cursor is the last story's `published_at|id`, not an offset, so no story is skipped or repeated.
//   4. A story whose kind is not listed is counted and filtered under the fallback kind (story-facts kindOf).
import { readFileSync } from 'node:fs';
import { kindOf } from './story-facts.mjs';

const settings = JSON.parse(readFileSync(new URL('./story-settings.json', import.meta.url), 'utf8'));

const cursorOf = story => `${story.published_at}|${story.id}`;
const visible = stories => stories.filter(story => !story.withdrawn);
const newestFirst = stories => [...stories].sort((a, b) => cursorOf(b).localeCompare(cursorOf(a)));

/** The stories a reader may see, newest first. */
export const shelfOf = stories => newestFirst(visible(stories));

/**
 * One page of the shelf. `kind` filters to one kind (an unknown kind is never a filter: it is the fallback's). `after` is
 * the `next` cursor of the page before. `next` is null on the last page.
 */
export function shelfPage(stories, { kind = null, after = null, limit = settings.page_size } = {}) {
  let rows = shelfOf(stories);
  if (kind) rows = rows.filter(story => kindOf(story.kind) === kind);
  if (after !== null) rows = rows.filter(story => cursorOf(story) < after);
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  return { stories: page, next: more && page.length ? cursorOf(page.at(-1)) : null };
}

/** How many visible stories each kind holds, every listed kind present (zero when none), unlisted kinds under the fallback. */
export function storyCounts(stories) {
  const counts = Object.fromEntries(settings.kinds.map(kind => [kind.id, 0]));
  for (const story of visible(stories)) counts[kindOf(story.kind)] += 1;
  return counts;
}

/** A story taken down: no longer listed, counted or returned, and marked so it is never written again. */
export function takeDown(story, at) {
  return { ...story, published: false, withdrawn: true, withdrawn_at: at };
}
