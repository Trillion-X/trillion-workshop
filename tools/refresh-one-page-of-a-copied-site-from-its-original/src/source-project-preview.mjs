// Check the rendered app after its own build/deploy pipeline runs. This reads
// only the public HTTPS address recorded on the connected project.
// The browser library is loaded only when a preview is opened, never at a Worker's start.
const browserLibrary = async () => (await import('@cloudflare/puppeteer')).default;

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

// Browser Rendering never makes its own network request. Every same-origin
// resource goes through the Worker's strictly-public fetch policy, with
// redirects left for this gate to check again before the browser follows them.
export async function proxyPreviewRequest(request, origin, fetcher = fetch) {
  try {
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET') return request.respond({ status: 403, body: '' });
    const response = await fetcher(url.toString(), { redirect: 'manual' });
    const location = response.headers.get('location');
    if (location && new URL(location, url).origin !== origin) return request.respond({ status: 403, body: '' });
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 8_000_000) return request.respond({ status: 413, body: '' });
    const chunks = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8_000_000) { await reader.cancel(); return request.respond({ status: 413, body: '' }); }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { body.set(chunk, at); at += chunk.byteLength; }
    return request.respond({ status: response.status,
      headers: Object.fromEntries(['content-type', 'location', 'cache-control'].filter(name => response.headers.has(name))
        .map(name => [name, response.headers.get(name)])), body: Buffer.from(body) });
  } catch { return request.respond({ status: 502, body: '' }).catch(() => {}); }
}

export async function inspectRenderedSource(binding, baseUrl, selection, intent) {
  if (!baseUrl) return { status: 'unconfigured' };
  if (!binding) return { status: 'unavailable', reason: 'Browser Rendering is unavailable.' };
  const target = sourcePreviewTarget(baseUrl, selection?.route);
  if (!target) return { status: 'unsupported', reason: 'The selected route leaves the connected public HTTPS host.' };
  let browser;
  try {
    browser = await (await browserLibrary()).launch(binding);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', request => { void proxyPreviewRequest(request, target.origin).catch(() => {}); });
    const response = await page.goto(target.toString(), { waitUntil: 'networkidle0', timeout: 20_000 });
    if (!sourcePreviewPageMatches(baseUrl, page.url())) return { status: 'unavailable', reason: 'The app redirected outside its connected project path.' };
    if (!response?.ok()) return { status: 'unavailable', reason: `The app page answered ${response?.status() ?? 'without a response'}.` };
    const result = await page.evaluate(({ element, intent }) => {
      const values = element?.attributes ?? {};
      const keys = ['data-trillion-source', 'id', 'data-testid', 'aria-label', 'name', 'href', 'src', 'title'];
      const usable = keys.filter(key => typeof values[key] === 'string' && values[key]);
      if (!usable.length) return { status: 'unsupported', reason: 'The rendered element has no stable attribute for readback.' };
      const matches = [...document.querySelectorAll(element.tag)].filter(node => usable.every(key => node.getAttribute(key) === values[key]));
      if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'unavailable', reason: `The rendered page has ${matches.length} matching elements.` };
      const node = matches[0];
      if (intent.kind === 'selection') {
        const observed = node.textContent?.trim().replace(/\s+/g, ' ') ?? '';
        const expected = element.text?.trim().replace(/\s+/g, ' ') ?? '';
        return { status: expected && observed === expected ? 'matched' : 'unavailable', observed };
      }
      if (intent.kind === 'text') return { status: node.textContent?.trim().replace(/\s+/g, ' ') === intent.value.trim().replace(/\s+/g, ' ') ? 'matched' : 'unavailable',
        observed: node.textContent?.trim().replace(/\s+/g, ' ') ?? '' };
      if (intent.kind === 'style') {
        const probe = document.createElement(node.tagName);
        probe.style.setProperty(intent.property, intent.value);
        const expected = probe.style.getPropertyValue(intent.property).trim();
        const observed = node.style.getPropertyValue(intent.property).trim();
        return { status: expected && observed === expected ? 'matched' : 'unavailable', observed,
          computed: getComputedStyle(node).getPropertyValue(intent.property).trim() };
      }
      return { status: 'unsupported', reason: 'This edit cannot be checked in the rendered page.' };
    }, { element: selection.element, intent });
    return { ...result, url: page.url(), http_status: response.status() };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'The rendered page could not be checked.' };
  } finally { await browser?.close().catch(() => {}); }
}

// A connected project can be selected directly, without first importing its
// compiled HTML into a separate Trillion app. The returned image is the public
// preview rendered by the same strictly-public fetch gate used for readback.
const GIVEN_TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', json: 'application/json' };
/** The given words for a requested address under `root`, or null: a folder address is its index.html. */
export function givenFile(files, root, address) {
  let url;
  try { url = new URL(address); } catch { return null; }
  if (!root || url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
  const below = decodeURIComponent(url.pathname.slice(root.pathname.length));
  const path = !below || below.endsWith('/') ? `${below}index.html` : below;
  const words = files[path] ?? (path.includes('.') ? undefined : files[`${path}/index.html`]);
  if (typeof words !== 'string') return null;
  const extension = (path.includes('.') ? path.split('.').pop() : 'html').toLowerCase();
  return { body: words, type: GIVEN_TYPES[extension] ?? 'text/plain; charset=utf-8' };
}

// A page is rendered at the width it is asked for (each size the canvas lays side by side) and as tall as it is, up to
// PREVIEW_MAX_HEIGHT, so a frame shows the whole page and a point anywhere in it can be chosen.
export const PREVIEW_MIN_WIDTH = 320;
export const PREVIEW_MAX_WIDTH = 1920;
export const PREVIEW_MAX_HEIGHT = 3200;
const PREVIEW_FIRST_HEIGHT = 800;

// `files` (optional) answers some addresses under the base from given words instead of the network, keyed by their
// path below the base ("index.html", "about/index.html", "styles.css"), so a page not yet published (a draft) is
// drawn with its own words while the published app supplies anything else it uses. `fetcher` answers every other
// address (a host answering its own pages passes itself, since a Worker's fetch of its own hostname skips it).
export async function browseRenderedSource(binding, baseUrl, route, point, width = 1280, { files = null, fetcher = fetch } = {}) {
  if (!binding) return { status: 'unavailable', reason: 'Browser Rendering is unavailable.' };
  const target = sourcePreviewTarget(baseUrl, route);
  if (!target || target.search || target.hash) return { status: 'unsupported', reason: 'Choose a route within the connected public HTTPS app.' };
  if (!Number.isInteger(width) || width < PREVIEW_MIN_WIDTH || width > PREVIEW_MAX_WIDTH) return { status: 'unsupported', reason: `Choose a width from ${PREVIEW_MIN_WIDTH} to ${PREVIEW_MAX_WIDTH} pixels.` };
  if (point && (!Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= width || point.y >= PREVIEW_MAX_HEIGHT)) {
    return { status: 'unsupported', reason: 'Choose a point inside the rendered preview.' };
  }
  let browser;
  try {
    browser = await (await browserLibrary()).launch(binding);
    const page = await browser.newPage();
    await page.setViewport({ width, height: PREVIEW_FIRST_HEIGHT, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    const root = sourcePreviewTarget(baseUrl, '/');
    page.on('request', request => {
      const given = files ? givenFile(files, root, request.url()) : null;
      void (given ? request.respond({ status: 200, headers: { 'content-type': given.type }, body: given.body }) : proxyPreviewRequest(request, target.origin, fetcher)).catch(() => {});
    });
    const response = await page.goto(target.toString(), { waitUntil: 'networkidle0', timeout: 20_000 });
    if (!sourcePreviewPageMatches(baseUrl, page.url()) || !response?.ok()) return { status: 'unavailable', reason: 'The connected preview did not render this route.' };
    const height = Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_FIRST_HEIGHT, Math.ceil(await page.evaluate(() => document.documentElement.scrollHeight))));
    if (height !== PREVIEW_FIRST_HEIGHT) await page.setViewport({ width, height, deviceScaleFactor: 1 });
    if (!point) {
      const routes = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(anchor => anchor.getAttribute('href')));
      return { status: 'ready', route, routes: sourcePreviewRoutes(baseUrl, routes),
        image_base64: await page.screenshot({ encoding: 'base64' }), width, height };
    }
    if (point.y >= height) return { status: 'unsupported', reason: 'Choose a point inside the rendered preview.' };
    const selected = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      const node = hit?.closest('a, button, label') ?? hit;
      if (!node || node === document.documentElement || node === document.body) return null;
      const attributes = Object.fromEntries([...node.attributes].filter(item =>
        ['id', 'data-testid', 'aria-label', 'name', 'href', 'src', 'title', 'class', 'style', 'data-trillion-source'].includes(item.name))
        .map(item => [item.name, item.value]));
      const styles = Object.fromEntries((attributes.style ?? '').split(';').map(part => part.split(':')).filter(part => part.length >= 2)
        .map(([name, ...value]) => [name.trim(), value.join(':').trim()]));
      const ancestors = [];
      for (let parent = node.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
        const stable = Object.fromEntries(['id', 'data-testid'].filter(name => parent.hasAttribute(name)).map(name => [name, parent.getAttribute(name)]));
        if (Object.keys(stable).length) ancestors.unshift({ tag: parent.tagName.toLowerCase(), attributes: stable });
      }
      const rect = node.getBoundingClientRect();
      return { selector: node.tagName.toLowerCase(), tag: node.tagName.toLowerCase(), text: node.textContent?.trim() ?? '',
        attributes, ancestors, ancestry: ancestors.map(item => item.tag),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles };
    }, point);
    return selected ? { status: 'selected', route, element: selected } : { status: 'unsupported', reason: 'No editable element was found at that point.' };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'The connected preview could not be rendered.' };
  } finally { await browser?.close().catch(() => {}); }
}
