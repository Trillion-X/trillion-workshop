// The edge-cache key of one kept public sitemap or llms.txt document (src/record-share-pages.mjs keeps them; account deletion,
// src/account-share-index-erasure.mjs, deletes them). Keyed by path and query alone, never by host, so deletion can name
// a kept document without knowing which host asked. The fixed host is the service's own origin: Cloudflare's Cache
// API PURGE is restricted to the Worker's own origin, so a synthetic foreign host can be read but refuses deletion.
export const crawlerDocumentKey = (pathname, search = '') => new Request('https://app.gettrillion.ai' + pathname + search);
