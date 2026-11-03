// tools/ask-a-small-model-for-a-verdict/do-work/fresh-local-classifier-fetch.mjs
//
// Local classification can pause for a long time while prior observations are
// verified and written. Close each request's connection so the next inference
// does not depend on an idle pooled socket. This adds no retry or model sample.
// The locally-served adapter and answer-state-questions post through it by default.
export function freshLocalClassifierFetch(url, init = {}, fetchImpl = fetch) {
  const headers = new Headers(init.headers);
  headers.set('connection', 'close');
  return fetchImpl(url, {...init, headers});
}
