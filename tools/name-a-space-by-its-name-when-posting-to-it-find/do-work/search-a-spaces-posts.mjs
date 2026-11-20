// tools/name-a-space-by-its-name-when-posting-to-it-find/do-work/search-a-spaces-posts.mjs
//
// Purpose
//   Finding posts in one shared space by their words, as the asker reads them (the old read_space with `query`,
//   src/space-search.mjs at b6ae0ebf815f in the older source repo). Pure: the caller passes the space's posts as
//   tool:list-a-spaces-posts answers them ({ item_id, author, fields, posted_at }, newest first or not) and the page it asks
//   for. Not wired into any tool row yet: waits for the owner's word.
//
// Non-negotiable invariants
//   1. A word is matched only against a post as its reader sees it: the string values of its fields, the same fields that
//      tool:list-a-spaces-posts returns. Nothing else of the post is searched.
//   2. Every word must be in the post. The words are the distinct lower-cased words of the query, at most terms_most, each cut
//      to term_chars_most. % and _ are plain characters: they match only themselves.
//   3. Newest first, ties broken by item_id. A page resumes below `before` (the next_before the last page answered), so no
//      post repeats across pages.
//   4. One call examines at most scan_batches pages of posts. When it stops with posts still to examine it answers next_before,
//      so the caller goes on, and no call grows with the space.
import settings from './search-a-spaces-posts.json' with { type: 'json' };

/** The distinct lower-cased words of a query (at most terms_most, each cut to term_chars_most), or null when it has none. */
export function searchWords(query) {
  if (typeof query !== 'string') return null;
  const words = [...new Set(query.toLowerCase().split(/\s+/).map(word => [...word].slice(0, settings.term_chars_most).join('')).filter(Boolean))]
    .slice(0, settings.terms_most);
  return words.length ? words : null;
}

/** The page size asked for, or the default; never more than page_most. */
const pageSize = asked => (Number.isInteger(asked) && asked > 0 ? Math.min(asked, settings.page_most) : settings.page_default);

/** The text a reader sees of a post: its string fields, lower-cased. */
const readAs = post => Object.values(post.fields ?? {}).filter(value => typeof value === 'string').join(' ').toLowerCase();

/** The order key of a post: newest first, the item id breaks a tie. */
const keyOf = post => `${post.posted_at}${post.item_id}`;

/**
 * The posts of one space holding every word, newest first, one page at a time.
 * @param {{posts: Array<{item_id: string, author: string, fields: object, posted_at: string}>, query: string, before?: string | null, size?: number}} args
 * @returns {{items: Array<object>, next_before: string | null}} next_before is set when posts remain to be examined
 */
export function searchSpacePosts({ posts, query, before = null, size }) {
  const words = searchWords(query);
  if (!words) throw new Error('query must hold at least one word.');
  const limit = pageSize(size);
  const ordered = [...posts].sort((a, b) => (keyOf(a) < keyOf(b) ? 1 : keyOf(a) > keyOf(b) ? -1 : 0));
  const after = before === null ? ordered : ordered.filter(post => keyOf(post) < String(before));
  const budget = settings.scan_batches * limit;
  const items = [];
  let examined = 0, last = null;
  for (const post of after) {
    if (items.length >= limit || examined >= budget) break;
    examined += 1;
    last = post;
    const text = readAs(post);
    if (words.every(word => text.includes(word))) items.push(post);
  }
  return { items, next_before: examined < after.length ? keyOf(last) : null };
}
