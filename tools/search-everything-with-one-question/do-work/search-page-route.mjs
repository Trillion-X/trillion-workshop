// tools/search-everything-with-one-question/do-work/search-page-route.mjs
//
// The signed-in page's GET /work/api/search, answered as a Workshop route tool (the engine's @workshop-routes family:
// input { path, method, query, body, browser }, answer { status, body }). Old trillion (Trillion-X/trillion tag
// old-trillion-before-worker-retire) answered it in src/worker.mjs:865-866: a GET of /work/api/search went to the
// account's own Namespace at /namespace/search with the same query (src/namespace-account-route.mjs:15), where
// src/namespace.mjs:2117 answered person.namespaceSearch(q, searchOptions(query)): q the question (empty when absent),
// and src/search.mjs:2221 searchOptions's `limit` a whole number above 0, at most 200. That search is this folder's
// searchEverything (the port of old src/file-tools.mjs:125 `search`, which called that same path), so the route asks it
// with the same question and limit and answers 200 with what it answers.
//
// Dropped, as searchEverything's own port dropped them (ports/search-everything.json): `places`, `sources` and
// `matches`, the old lanes' narrowing (connected services and the content lanes have no engine owner); they are read
// and left out, never refused, as the old route never refused a narrowing it could not apply.
import { searchEverything } from './search-everything.mjs';

const MOST = 200;
const first = value => (Array.isArray(value) ? value[0] : value);

/** `{ path, method, query }` of the page's request in; `{ status, body }` out. */
export async function answerSearchPage(input, { door }) {
  if (input?.method !== 'GET' || input?.path !== '/search') return { status: 404, body: { error: 'Not found' } };
  const query = input.query && typeof input.query === 'object' ? input.query : {};
  const limit = Number(first(query.limit));
  const asked = { question: String(first(query.q) ?? ''), ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, MOST) } : {}) };
  return { status: 200, body: await searchEverything(asked, { door }) };
}
