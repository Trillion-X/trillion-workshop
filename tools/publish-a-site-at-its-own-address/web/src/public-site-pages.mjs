// Pages that belong to the public site, not the signed-in app. Links inside the
// workspace are relative, so opening one on the app's own host must move to
// the public owner instead of falling through to the app's 404 page. The public
// site's origin is the caller's: this tool names no site.

const ARTICLE_PATH = /^\/articles(?:\/|$)/;

/** Return the canonical public-site redirect for an article read, else null. `publicSiteOrigin` is the public site's origin, such as https://www.example.com. */
export function publicSitePage(request, publicSiteOrigin) {
  if (typeof publicSiteOrigin !== 'string' || !URL.canParse(publicSiteOrigin)) throw new TypeError('publicSitePage needs the public site origin as its second argument.');
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const asked = new URL(request.url);
  if (!ARTICLE_PATH.test(asked.pathname)) return null;
  return new Response(null, {
    status: 301,
    headers: { location: new URL(`${asked.pathname}${asked.search}`, publicSiteOrigin).href },
  });
}
