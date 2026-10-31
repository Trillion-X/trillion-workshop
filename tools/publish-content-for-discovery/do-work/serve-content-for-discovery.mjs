import { prepareContentForDiscovery } from './prepare-content-for-discovery.mjs';
import { prefersMarkdown } from '../../ai-readiness/do-work/negotiate-markdown.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const tag = (name, value) => `${LT}${name}${GT}${xml(value)}${LT}/${name}${GT}`;
const isHttps = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
const digest = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text));
const unavailable = () => new Response('Current public content is unavailable.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** Serializes a page model returned by prepareContentForDiscovery. */
export function serializeSitemapXml(sitemapPage) {
  if (!sitemapPage || !Array.isArray(sitemapPage.urls)) throw new TypeError('A sitemap page model is required.');
  const urls = sitemapPage.urls.map(url => {
    if (!isHttps(url.loc)) throw new TypeError('Every sitemap location must be an HTTPS URL.');
    if (url.lastmod && !Number.isFinite(Date.parse(url.lastmod))) throw new TypeError('Sitemap dates must be valid.');
    return `${LT}url${GT}${tag('loc', url.loc)}${url.lastmod ? tag('lastmod', url.lastmod) : ''}${LT}/url${GT}`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>${LT}urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${GT}${urls}${LT}/urlset${GT}`;
}

/** Serializes an explicit index of sitemap page URLs, including a continuation page when supplied. */
export function serializeSitemapIndexXml({ pages }) {
  if (!Array.isArray(pages) || pages.some(url => !isHttps(url))) throw new TypeError('A sitemap index needs HTTPS page URLs.');
  return `<?xml version="1.0" encoding="UTF-8"?>${LT}sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${GT}${pages.map(url => `${LT}sitemap${GT}${tag('loc', url)}${LT}/sitemap${GT}`).join('')}${LT}/sitemapindex${GT}`;
}

/** Serializes a feed model; callers may pass their existing site's aggregate title/link. */
export function serializeRssXml(rssPage, { title = rssPage?.title, link = rssPage?.link } = {}) {
  if (!rssPage || !Array.isArray(rssPage.items) || typeof title !== 'string' || typeof link !== 'string') throw new TypeError('An RSS page model, title, and link are required.');
  if (!isHttps(link)) throw new TypeError('The RSS link must be an HTTPS URL.');
  const items = rssPage.items.map(item => {
    if (!isHttps(item.link) || !isHttps(item.guid)) throw new TypeError('RSS item links must be HTTPS URLs.');
    const sources = (item.sources ?? []).map(source => {
      if (!isHttps(source.url)) throw new TypeError('RSS source links must be HTTPS URLs.');
      return `${LT}source url="${xml(source.url)}"${GT}${xml(source.label)}${LT}/source${GT}`;
    }).join('');
    return `${LT}item${GT}${tag('title', item.title)}${tag('link', item.link)}${LT}guid isPermaLink="true"${GT}${xml(item.guid)}${LT}/guid${GT}${tag('description', item.description)}${tag('pubDate', item.pubDate)}${sources}${LT}/item${GT}`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>${LT}rss version="2.0"${GT}${LT}channel${GT}${tag('title', title)}${tag('link', link)}${tag('description', `Public updates from ${title}`)}${items}${LT}/channel${GT}${LT}/rss${GT}`;
}

/**
 * Builds a read-only Request handler. `loadCurrentPublicSnapshot` must resolve current account visibility and rights
 * on every request and return only the requested public route or requested discovery page in
 * prepareContentForDiscovery's input shape. For lists, it accepts `{ request, path, cursor, limit }` and returns an
 * explicit `complete` flag and continuation cursor. It must throw when a source is unavailable; no stale fallback.
 */
export function createContentDiscoveryHandler({ loadCurrentPublicSnapshot, paths = {}, feed = {} }) {
  if (typeof loadCurrentPublicSnapshot !== 'function') throw new TypeError('loadCurrentPublicSnapshot must be a function.');
  const endpoints = { sitemap: '/sitemap.xml', sitemapPage: '/sitemap-page.xml', feed: '/feed.xml', llms: '/llms.txt', ...paths };
  if (Object.values(endpoints).some(path => typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) || new Set(Object.values(endpoints)).size !== Object.values(endpoints).length) throw new TypeError('Discovery endpoint paths must be distinct origin-relative paths.');
  return async function handleContentDiscovery(request) {
    if (!(request instanceof Request)) throw new TypeError('A Request is required.');
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed.', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor');
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? undefined : Number(limitText);
    if (limitText !== null && (!Number.isSafeInteger(limit) || limit < 1)) return new Response('Invalid limit.', { status: 400, headers: { 'cache-control': 'no-store' } });
    let projection;
    try {
      const format = url.pathname === endpoints.sitemap ? 'sitemap-index'
        : url.pathname === endpoints.sitemapPage ? 'sitemap'
          : url.pathname === endpoints.feed ? 'rss'
            : url.pathname === endpoints.llms ? 'llms'
              : prefersMarkdown(request.headers.get('accept')) ? 'markdown' : 'html';
      const current = await loadCurrentPublicSnapshot({ request, path: url.pathname, format, cursor, limit });
      if (current?.source?.requestedCursor !== cursor) throw new TypeError('Source page did not match the requested cursor.');
      projection = prepareContentForDiscovery(current);
    } catch {
      return unavailable();
    }
    const doc = projection.outputs.documents.find(item => item.path === url.pathname);
    if (doc && Object.values(endpoints).includes(url.pathname)) return new Response('A document route conflicts with a discovery endpoint.', { status: 500, headers: { 'cache-control': 'no-store' } });
    let body;
    let type;
    if (doc) {
      if (prefersMarkdown(request.headers.get('accept'))) {
        body = doc.markdown;
        type = 'text/markdown; charset=utf-8';
      } else {
        body = doc.html;
        type = 'text/html; charset=utf-8';
      }
    } else if (url.pathname === endpoints.sitemap) {
      const firstPage = new URL(endpoints.sitemapPage, projection.manifest.site.origin).href;
      const firstPageUrl = new URL(firstPage);
      if (limit !== undefined) firstPageUrl.searchParams.set('limit', String(limit));
      const pages = [firstPageUrl.href];
      if (projection.manifest.source.continuation) {
        const next = new URL(firstPageUrl.href);
        next.searchParams.set('cursor', projection.manifest.source.continuation);
        pages.push(next.href);
      }
      body = serializeSitemapIndexXml({ pages });
      type = 'application/xml; charset=utf-8';
    } else if (url.pathname === endpoints.sitemapPage) {
      body = serializeSitemapXml(projection.outputs.sitemap);
      type = 'application/xml; charset=utf-8';
    } else if (url.pathname === endpoints.feed) {
      body = serializeRssXml(projection.outputs.rss, { title: feed.title ?? projection.outputs.rss.title, link: feed.link ?? projection.outputs.rss.link });
      type = 'application/rss+xml; charset=utf-8';
    } else if (url.pathname === endpoints.llms) {
      body = projection.outputs.llms;
      type = 'text/plain; charset=utf-8';
    } else {
      return new Response('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    const headers = new Headers({ 'content-type': type, 'cache-control': 'no-store', vary: 'Accept', etag: `"${digest(body)}"`, 'x-source-complete': String(projection.manifest.source.complete) });
    if (projection.manifest.source.continuation && url.pathname !== endpoints.sitemap) {
      const next = new URL(request.url);
      if (url.pathname === endpoints.sitemapPage) next.pathname = endpoints.sitemapPage;
      next.searchParams.set('cursor', projection.manifest.source.continuation);
      headers.set('link', `<${next.pathname}${next.search}>; rel="next"`);
    }
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  };
}
