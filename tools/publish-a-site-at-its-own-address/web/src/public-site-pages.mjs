// Pages that belong to gettrillion.ai, not the signed-in app. Links inside the
// workspace are relative, so opening one on app.gettrillion.ai must move to
// the public owner instead of falling through to the app's 404 page.
export const PUBLIC_SITE_ORIGIN = 'https://gettrillion.ai';

const ARTICLE_PATH = /^\/articles(?:\/|$)/;

/** Return the canonical public-site redirect for an article read, else null. */
export function publicSitePage(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const asked = new URL(request.url);
  if (!ARTICLE_PATH.test(asked.pathname)) return null;
  return new Response(null, {
    status: 301,
    headers: { location: new URL(`${asked.pathname}${asked.search}`, PUBLIC_SITE_ORIGIN).href },
  });
}
