// tools/save-what-you-watch-and-read/do-work/api-source.mjs
//
// Reads a person's saved X posts (their bookmarks or their likes), newest first, through X's API with the access token
// the person's X connection holds. It replaces the old Bitfield x-bookmarks-connector and x-bookmarks-decoder (a snapshot
// file with a saved cursor, for a ledger that no longer runs): this read keeps no state; what the person already has is
// `already_kept`, and the posts come back in the one shape of x-posts.mjs.
//
// Invariants:
//   - No token handed to the run means no network call at all, and the run says so.
//   - The token comes in on the file descriptor the request names (descriptor 3 unless `token_fd` names another; a held value mounted by the engine); it
//     is sent only in the Authorization header to the API address in the conventions, and appears in no answer or error.
//   - Any refusal ends the run with X's own words and what they usually mean (expired token, plan without bookmarks);
//     a refusal never becomes an empty list.
//   - Only GET requests are made: nothing is posted, liked, followed or changed on X.
import { readFileSync } from 'node:fs';
import { conventions, listFor } from './saved-source.mjs';
import { apiPostsIn } from './x-posts.mjs';

const meaning = {
  401: 'the access token has expired or was revoked; the person has to connect X again',
  403: "X's plan for this app does not allow this list, or the connection lacks the bookmark.read / like.read permission",
  429: 'X is limiting reads; wait for the time named in x-rate-limit-reset',
};

async function ask(fetchImpl, token, address) {
  const { api } = conventions;
  let answer;
  try {
    answer = await fetchImpl(address, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(api.answer_seconds * 1000) });
  } catch (error) {
    throw new Error(`X did not answer ${new URL(address).pathname}: ${error.message}`);
  }
  const text = await answer.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (!answer.ok) {
    const said = body?.detail ?? body?.title ?? text.slice(0, 200);
    const reset = answer.headers.get('x-rate-limit-reset');
    throw new Error(`X refused ${new URL(address).pathname} (${answer.status} ${said}): ${meaning[answer.status] ?? 'no reason known'}${answer.status === 429 && reset ? ` (resets at ${new Date(Number(reset) * 1000).toISOString()})` : ''}.`);
  }
  if (!body || typeof body !== 'object') throw new Error(`X answered ${new URL(address).pathname} with something that is not JSON.`);
  return body;
}

/** The token on the descriptor the request names; refuses before any network call when there is none. */
export function tokenFrom(request, read = readFileSync) {
  const descriptor = request.token_fd ?? conventions.api.token_fd;
  let token;
  try { token = String(read(descriptor, 'utf8')).trim(); } catch { throw new Error(`No X token was handed to this run (descriptor ${descriptor}): the person connects X first.`); }
  if (!token) throw new Error('The X token handed to this run is empty: the person connects X again.');
  return token;
}

/** The address of one page of the request's list. */
export function pageAddress(kind, userId, after) {
  const { api } = conventions;
  const params = new URLSearchParams({ ...api.params, max_results: String(kind.page_size) });
  if (after) params.set('pagination_token', after);
  return `${api.base}/${kind.path.replace('{id}', encodeURIComponent(userId))}?${params}`;
}

/**
 * Reads the request's list page by page, feeding `collected.onPage`, until the collector has what it needs, X has no
 * more, or the list's page limit is reached. Answers the number of pages read.
 */
export async function readFromApi(request, collected, { fetchImpl = fetch, read = readFileSync } = {}) {
  const kind = listFor(request);
  const token = tokenFrom(request, read);
  const { api } = conventions;
  const me = await ask(fetchImpl, token, `${api.base}/${api.me}`);
  const userId = me.data?.id;
  if (!userId) throw new Error('X did not say whose token this is (users/me has no id).');
  let after;
  let pages = 0;
  while (pages < kind.max_pages) {
    const page = await ask(fetchImpl, token, pageAddress(kind, userId, after));
    pages += 1;
    collected.onPage(apiPostsIn(page));
    after = page.meta?.next_token;
    if (!after || collected.onPage.finished()) break;
  }
  return pages;
}
