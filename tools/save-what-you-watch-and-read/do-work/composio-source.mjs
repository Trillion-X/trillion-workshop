// tools/save-what-you-watch-and-read/do-work/composio-source.mjs
//
// Reads a person's saved X posts (their bookmarks) through the person's X account that Composio holds, not through a token
// in the vault: one execute call per page, as the person, on the account's own connection. It reads only: Composio's X
// bookmarks action is a GET, and nothing is posted, liked or changed on X.
//
// Invariants:
//   - The page is X's own v2 page (data, includes, meta) read out of Composio's answer, so the same parser reads both ways.
//   - Paging follows X's next_token, passed back as pagination_token; a page without one ends the read.
//   - A Composio refusal ends the run with Composio's words (makeComposioCall); a refusal never becomes an empty list.
import { conventions, listFor } from './saved-source.mjs';
import { apiPostsIn } from './x-posts.mjs';

/** X's page inside a Composio answer: the tool's data, unwrapped from the nesting Composio puts around it. */
export function pageIn(answer) {
  const wrapped = answer?.data ?? answer?.data_preview ?? answer ?? {};
  if (Array.isArray(wrapped.data)) return wrapped;
  return wrapped.data && typeof wrapped.data === 'object' ? wrapped.data : wrapped;
}

/** The arguments of one page of the list: the authenticated person's own bookmarks, with the fields the parser reads. */
export function argumentsFor(kind, after) {
  const { composio } = conventions;
  return {
    id: 'me',
    max_results: kind.page_size,
    expansions: composio.expansions,
    tweet_fields: composio.tweet_fields,
    user_fields: composio.user_fields,
    media_fields: composio.media_fields,
    ...(after ? { pagination_token: after } : {}),
  };
}

/**
 * Reads the request's bookmarks page by page through `execute(tool, accountId, args, userId)`, feeding `collected.onPage`,
 * until the collector has what it needs, X has no more, or the list's page limit is reached. Answers the number of pages read.
 */
export async function readFromComposio(request, collected, { execute }) {
  if (request.which !== 'bookmarks') throw new Error('Composio reads the bookmarks only; the likes are read by the X API path.');
  const kind = listFor(request);
  if (!request.account) throw new Error('Give account: the Composio account id of the person\'s X connection.');
  let after;
  let pages = 0;
  while (pages < kind.max_pages) {
    const answer = await execute(conventions.composio.bookmarks, request.account, argumentsFor(kind, after), request.user_id ?? conventions.composio.user_id);
    pages += 1;
    const page = pageIn(answer);
    collected.onPage(apiPostsIn(page));
    after = page.meta?.next_token;
    if (!after || collected.onPage.finished()) break;
  }
  return pages;
}
