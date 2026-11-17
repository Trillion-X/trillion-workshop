// Check the rendered app after its own build/deploy pipeline runs. This reads
// only the public HTTPS address recorded on the connected project.

export function sourcePreviewTarget(baseUrl, route) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return null;
  let base;
  let target;
  let basePath;
  try {
    base = new URL(baseUrl);
    // A project can be hosted below an origin, as with GitHub Pages. The
    // editor's / route means this connected app's root, not the host's root.
    const lastSegment = base.pathname.split('/').at(-1) ?? '';
    basePath = base.pathname.endsWith('/') ? base.pathname
      : /\.[A-Za-z0-9]{1,12}$/.test(lastSegment) ? base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1)
        : `${base.pathname}/`;
    target = new URL(route.slice(1), new URL(basePath, base.origin));
  } catch { return null; }
  if (base.protocol !== 'https:' || target.protocol !== 'https:' || target.origin !== base.origin ||
      !target.pathname.startsWith(basePath) ||
      base.username || base.password || base.port || !base.hostname.includes('.') || base.hostname.endsWith('.') ||
      /(?:^|\.)(?:localhost|local|internal)\.?$/.test(base.hostname) ||
      /^\d+(?:\.\d+){3}$/.test(base.hostname) || base.hostname.includes(':')) return null;
  return target;
}

export function sourcePreviewPageMatches(baseUrl, pageUrl) {
  const root = sourcePreviewTarget(baseUrl, '/');
  if (!root) return false;
  try {
    const page = new URL(pageUrl);
    return page.protocol === 'https:' && page.origin === root.origin && page.pathname.startsWith(root.pathname);
  } catch { return false; }
}

/** Keep clean, same-app paths from links or sitemap locations. These are discovery hints, not source locators. */
export function sourcePreviewRoutes(baseUrl, links) {
  const root = sourcePreviewTarget(baseUrl, '/');
  if (!root || !Array.isArray(links)) return ['/'];
  const routes = new Set(['/']);
  for (const link of links) {
    if (typeof link !== 'string') continue;
    const rawPath = link.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
    let decodedRawPath;
    try { decodedRawPath = decodeURIComponent(rawPath); } catch { continue; }
    if (decodedRawPath.split('/').some(part => part === '.' || part === '..')) continue;
    let target;
    try { target = new URL(link, root); } catch { continue; }
    if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname) || target.search || target.hash) continue;
    const path = `/${target.pathname.slice(root.pathname.length)}`;
    if (path === '//' || path.length > 500 || path.includes('\\')) continue;
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { continue; }
    if (decoded.split('/').some(part => part === '.' || part === '..') || decoded.startsWith('//')) continue;
    routes.add(path);
    if (routes.size >= 100) break;
  }
  return [...routes].sort((left, right) => left === '/' ? -1 : right === '/' ? 1 : left.localeCompare(right));
}

/** Read a bounded public sitemap without following a redirect away from the connected app. */
export async function sourceSitemapRoutes(baseUrl, fetcher = fetch) {
  const root = sourcePreviewTarget(baseUrl, '/');
  if (!root) return [];
  const address = new URL('sitemap.xml', root);
  try {
    const response = await fetcher(address.href, { redirect: 'manual', headers: { accept: 'application/xml, text/xml' } });
    if (response.status !== 200 || !/\b(?:application|text)\/xml\b/i.test(response.headers.get('content-type') ?? '') ||
        Number(response.headers.get('content-length') ?? 0) > 1_000_000) {
      await response.body?.cancel();
      return [];
    }
    const reader = response.body?.getReader();
    if (!reader) return [];
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); return []; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/<urlset(?:\s|>)/i.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) return [];
    const links = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].slice(0, 500)
      .map(match => match[1].replaceAll('&amp;', '&').trim());
    return sourcePreviewRoutes(baseUrl, links);
  } catch { return []; }
}
