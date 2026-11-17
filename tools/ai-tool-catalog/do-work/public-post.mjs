// tools/ai-tool-catalog/do-work/public-post.mjs
//
// Purpose: `fetch` in the shape a reader's `post` takes: only to a public address, every redirect judged again
// (tools/refuse-requests-to-private-addresses/public-address.mjs). Used by the live source reader to read an API's own
// description. A server's tools are the engine's own tool sources now (tool:add-tool-source), never read here.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { fetchPublic } from '../../refuse-requests-to-private-addresses/public-address.mjs';

export const postWithFetch = (request = fetch, timeoutMs = 60000) => async ({ url, method, headers, body }) => {
  const response = await fetchPublic(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(timeoutMs) }, { fetchImpl: request });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text: await response.text() };
};
