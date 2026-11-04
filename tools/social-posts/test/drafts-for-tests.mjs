// The snippets and thread summaries of one person for the tests moved from trillion (test/snippets.test.mjs and
// test/thread-summaries.test.mjs), standing in for trillion's test/social-posts-for-tests.mjs `posts()`: the same
// owner fields (`snippets`, `summaries`) and the same clock (a second later each time it is read), over an eeaf
// held in memory (read-data/drafts-over-door.mjs heldEeafOver) instead of trillion's local store.
import { heldEeafOver } from '../read-data/drafts-over-door.mjs';
import { makeSnippets } from '../read-data/snippets.mjs';
import { makeThreadSummaries } from '../read-data/thread-summaries.mjs';

export function posts({ clock = '2026-09-29T17:00:00Z', threadEnds = { latest: () => null, newer: () => 0 } } = {}) {
  const { eeaf } = heldEeafOver();
  let at = Date.parse(clock);
  const now = () => new Date((at += 1000));
  const owner = { snippets: makeSnippets({ eeaf, now }), summaries: makeThreadSummaries({ eeaf, now, ...threadEnds }) };
  return { owner, store: { eeaf } };
}
