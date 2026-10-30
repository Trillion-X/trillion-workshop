// tools/copy-a-site/do-work/copy-a-site.mjs
//
// Copies a live website into the file map a public app is published from: each page of the site is opened
// in a headless browser and kept as the visitor sees it once its scripts have run, with the scripts themselves taken
// out; every picture, style sheet and font the pages use from the same site is fetched and kept beside them; and
// addresses for kept pages and files point at the copy; omitted ones keep their original site address.
//
// Invariants:
//   - Nothing here names a site, product or brand. The start address, the page limit and any extra paths are input.
//   - Only the start address's own origin is copied or followed. Other sites stay linked where they are.
//   - A kept page carries no script, no inline event handler and no frame: what it shows is its rendered markup.
//   - A page or file that cannot be copied is listed under `skipped` with the reason; the rest still copy.
//   - The browser is driven over the DevTools protocol (tools/headless-browser/devtools.mjs): no browser library.
//   - Where it reaches is not decided here. The engine runs it as an internet:true tool, so its fetches (Node's own
//     fetch) and its browser go only through the engine's public-only proxy, which judges every address and redirect.
//
// Usage:
//   node do-work/copy-a-site.mjs --url <address> --out <folder> [--max-pages 60] [--paths '["/a","/b"]']
//     [--exclude-paths '["/already-copied"]']
//     [--width 1280] [--height 900] [--max-file-bytes 20000000] [--browser chromium, or BROWSER_EXECUTABLE]
//
// Leaves <out>/site.json: { files: { "<path>": "<text>" | "data:<type>;base64,..." } }, the input publish takes as
// it is, and prints one JSON line: { origin, pages[], files, bytes, skipped[] }. On failure prints the reason on
// standard error and exits 1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserProblem, openBrowser } from '../../headless-browser/devtools.mjs';
import { pageFile, rewrite } from './copy-addresses.mjs';
export { pageFile, rewrite } from './copy-addresses.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
// Waits for `promise` at most `ms`; the timer is cleared either way, so a finished copy never waits it out.
const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(done => { timer = setTimeout(done, ms); })]).finally(() => clearTimeout(timer));
};

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new BrowserProblem(`Unexpected argument ${name}.`);
    args[name.slice(2)] = argv[index + 1] ?? '';
  }
  return args;
}

// The extension a file is kept under when its address has none the host serves, read from what the site says it is.
const EXTENSION_OF_TYPE = {
  'text/css': 'css', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'font/woff2': 'woff2', 'font/woff': 'woff',
  'font/ttf': 'ttf', 'font/otf': 'otf', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf', 'application/json': 'json',
  'text/plain': 'txt', 'application/manifest+json': 'webmanifest',
};
const TEXT_EXTENSIONS = new Set(['html', 'css', 'json', 'webmanifest', 'svg', 'txt']);
// The published app admits one media type per binary extension. Source servers commonly send aliases.
const PUBLISHED_BINARY_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', mp3: 'audio/mpeg', pdf: 'application/pdf',
};
const SAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g;
const routePath = path => path === '/' ? '/' : path.replace(/\/$/, '');
const retryableResponse = response => [408, 425, 429].includes(Number(response?.status)) ||
  (Number(response?.status) >= 500 && Number(response?.status) < 600) ||
  /network|fetch failed|timed? ?out|connection|socket/i.test(String(response?.status ?? ''));

// One path segment the host accepts: letters, digits, dot, dash, underscore, never starting with a dot.
const segment = value => (decodeURIComponent(value).replace(SAFE_SEGMENT, '-').replace(/^[.-]+/, '') || 'x');

/** The file an asset address is kept as, given the type the site answered with. */
export function assetFile(url, contentType) {
  const parts = url.pathname.split('/').filter(Boolean).map(segment);
  const extension = EXTENSION_OF_TYPE[(contentType ?? '').split(';')[0].trim().toLowerCase()];
  let name = parts.pop() ?? 'file';
  const own = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  if (extension && own !== extension && !(extension === 'jpg' && own === 'jpeg')) name = `${name}.${extension}`;
  // A query string makes a different file (a resized picture): its words join the name so both are kept.
  if (url.search) name = name.replace(/(\.[^.]+)$/, `-${segment(url.search.slice(1)).slice(0, 40)}$1`);
  return [...parts, name].join('/');
}

// Runs in the page once it has settled: scrolls it through so late pictures load, takes out what a copy cannot run,
// and answers the markup plus every address the page uses on its own origin.
const TAKE_PAGE = `async (origin) => {
  for (let y = 0; y < document.documentElement.scrollHeight; y += Math.max(400, innerHeight * 0.8)) {
    scrollTo(0, y); await new Promise(done => setTimeout(done, 120));
  }
  scrollTo(0, 0); await new Promise(done => setTimeout(done, 300));
  for (const element of document.querySelectorAll('img[loading="lazy"]')) element.removeAttribute('loading');
  for (const element of document.querySelectorAll('script, noscript, iframe, frame, object, embed, link[rel="modulepreload"], link[as="script"], base')) element.remove();
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || /^\\s*javascript:/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  // Scripts and event handlers are gone, so standard controls must lead to the working source page.
  // The marker keeps this deliberate original-site link from being relinked to the static copy.
  const originalPage = location.href.split('#')[0];
  const sourceLink = (element, label, styledAs = element) => {
    const link = document.createElement('a');
    link.href = originalPage;
    link.setAttribute('data-site-copy-original', '');
    link.className = styledAs.getAttribute('class') || '';
    link.textContent = (label || 'Use this') + ' on the original site';
    element.replaceWith(link);
  };
  for (const form of [...document.querySelectorAll('form')]) {
    const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    sourceLink(form, submit?.textContent?.trim() || submit?.getAttribute('value') || 'Use this form', submit || form);
  }
  for (const control of [...document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="button"]:not(a)')]) {
    sourceLink(control, control.textContent?.trim() || control.getAttribute('aria-label') || control.getAttribute('value') || 'Use this');
  }
  // What the page has open (a menu, a slide) is kept as shown; a video keeps its first picture.
  for (const video of document.querySelectorAll('video')) { video.removeAttribute('autoplay'); video.setAttribute('preload', 'metadata'); }
  const used = new Set();
  const take = value => { try { const url = new URL(value, location.href); if (url.origin === origin) used.add(url.href.split('#')[0]); } catch {} };
  for (const element of document.querySelectorAll('[src]')) take(element.getAttribute('src'));
  for (const element of document.querySelectorAll('[poster]')) take(element.getAttribute('poster'));
  for (const element of document.querySelectorAll('link[href]')) if (!/^(canonical|alternate|preconnect|dns-prefetch)$/i.test(element.rel)) take(element.getAttribute('href'));
  for (const element of document.querySelectorAll('[srcset]')) for (const part of element.getAttribute('srcset').split(',')) take(part.trim().split(/\\s+/)[0]);
  for (const element of document.querySelectorAll('[style]')) for (const match of element.getAttribute('style').matchAll(/url\\((['"]?)([^'")]+)\\1\\)/g)) take(match[2]);
  for (const style of document.querySelectorAll('style')) for (const match of style.textContent.matchAll(/url\\((['"]?)([^'")]+)\\1\\)/g)) take(match[2]);
  const links = [...document.querySelectorAll('a[href]')].map(a => { try { return new URL(a.getAttribute('href'), location.href); } catch { return null; } })
    .filter(url => url && url.origin === origin && !url.search).map(url => url.origin + url.pathname);
  const query_links = [...document.querySelectorAll('a[href]')].map(a => { try { return new URL(a.getAttribute('href'), location.href); } catch { return null; } })
    .filter(url => url && url.origin === origin && url.search).map(url => url.href.split('#')[0]);
  const doctype = document.doctype ? '<!doctype ' + document.doctype.name + '>' : '';
  return { html: doctype + document.documentElement.outerHTML, used: [...used], links: [...new Set(links)], query_links: [...new Set(query_links)], status: document.title };
}`;

export function omittedPages(queue, seen, origin, maxPages) {
  return [...new Set(queue.map(value => routePath(new URL(value, origin).pathname)))]
    .filter(path => !seen.has(path))
    .map(path => ({ address: origin + path,
      reason: 'not copied because the ' + maxPages + '-page limit was reached; its link stays on the original site' }));
}

export function reportedSkipped(rows, origin, limit = 100) {
  if (rows.length <= limit) return rows;
  return [...rows.slice(0, limit - 1), {
    address: origin,
    reason: String(rows.length - limit + 1) + ' more pages or files were not copied; their links stay on the original site',
  }];
}

export function continuationPaths(queue, seen, origin) {
  return [...new Set(queue.map(value => routePath(new URL(value, origin).pathname)))].filter(path => !seen.has(path));
}

// A sitemap can name pages that the rendered navigation does not link to. Read it as a fallback after visible links,
// so a large article sitemap cannot displace the site's primary navigation under the page limit.
const SITEMAP_BYTES = 1_000_000;
const SITEMAP_FILES = 8;
async function sitemapText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SITEMAP_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function sitemapLocations(xml, origin) {
  const locations = [];
  for (const match of xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)) {
    const value = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/gi, '&').trim();
    try {
      const url = new URL(value);
      if (url.origin === origin) locations.push(url);
    } catch { /* A malformed or relative entry is not a public page address. */ }
  }
  return locations;
}

/** Same-origin page paths in a standard sitemap or sitemap index; optional when a site has neither. */
export async function sitemapPages(origin, fetchPage = fetch) {
  const pending = [`${origin}/sitemap.xml`];
  const visited = new Set();
  const pages = new Set();
  while (pending.length && visited.size < SITEMAP_FILES) {
    const address = pending.shift();
    if (visited.has(address)) continue;
    visited.add(address);
    const response = await fetchPage(address).catch(() => null);
    if (!response?.ok || new URL(response.url || address).origin !== origin) {
      await response?.body?.cancel?.().catch(() => {});
      continue;
    }
    const xml = await sitemapText(response);
    if (!xml) continue;
    const locations = sitemapLocations(xml, origin);
    if (/<sitemapindex(?:\s|>)/i.test(xml)) {
      for (const url of locations) if (/\.xml$/i.test(url.pathname) && !visited.has(url.href)) pending.push(url.href);
    } else if (/<urlset(?:\s|>)/i.test(xml)) {
      for (const url of locations) if (!url.search && !url.hash) pages.add(routePath(url.pathname));
    }
  }
  return [...pages];
}

// The start is a web address with no user name or password; whether it is public is the engine's to judge.
function webAddress(text) {
  let url;
  try { url = new URL(String(text)); } catch { throw new BrowserProblem('Give a full web address, like https://example.com/.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new BrowserProblem('The address must be a web address (https:// or http://) with no user name or password.');
  }
  return url;
}

function inputPaths(value, origin, label) {
  let paths;
  try { paths = JSON.parse(value || '[]'); } catch { throw new BrowserProblem(`${label} needs a list of page paths.`); }
  if (!Array.isArray(paths) || paths.length > 200 || paths.some(path =>
    typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
    new URL(path, origin).origin !== origin || new URL(path, origin).search || new URL(path, origin).hash)) throw new BrowserProblem(`${label} needs at most 200 paths on this site.`);
  return paths.map(path => routePath(new URL(path, origin).pathname));
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.url) throw new BrowserProblem('Give --url, the address of the site to copy.');
  if (!args.out) throw new BrowserProblem('Give --out, the folder to leave the copy in.');
  const start = webAddress(args.url);
  if (start.search) throw new BrowserProblem('The starting address has a query. Copy its page address without the query; links with queries stay on the original site.');
  const origin = start.origin;
  const maxPages = Number(args['max-pages'] || 60);
  const maxFileBytes = Number(args['max-file-bytes'] || 20_000_000);
  const width = Number(args.width || 1280);
  const height = Number(args.height || 900);
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });

  const paths = inputPaths(args.paths, origin, '--paths');
  const startPath = routePath(start.pathname);
  const excluded = inputPaths(args['exclude-paths'], origin, '--exclude-paths').filter(path => path !== startPath);
  // Requested continuation paths come before newly discovered links. Each batch includes its start page.
  const queue = [startPath, ...paths];
  const seen = new Set(excluded);
  const pages = new Map();
  const assets = new Map();
  const skipped = [];
  const redirects = [];
  const listedPages = await sitemapPages(origin);
  const sitemap = { paths: listedPages.slice(0, 200) };
  if (listedPages.length > 200) skipped.push({ address: `${origin}/sitemap.xml`,
    reason: `${listedPages.length - 200} more site map pages were found; their links stay on the original site` });

  const browser = await openBrowser(args.browser || process.env.BROWSER_EXECUTABLE || 'chromium', { width, height });
  try {
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    let loaded = () => {};
    browser.on(event => { if (event.method === 'Page.loadEventFired') loaded(); });
    while (queue.length && pages.size < maxPages) {
      const path = routePath(new URL(queue.shift(), origin).pathname);
      if (seen.has(path)) continue;
      seen.add(path);
      const address = origin + path;
      const head = await fetch(address).catch(error => ({ ok: false, status: error.message, headers: new Headers(), url: address }));
      if (!head.ok || new URL(head.url).origin !== origin || !(head.headers.get('content-type') ?? '').includes('text/html')) {
        skipped.push({ kind: 'page', address, reason: !head.ok ? `the site answered ${head.status}` : 'the page leaves this site or does not answer HTML',
          retryable: !head.ok && retryableResponse(head) });
        await head.body?.cancel?.();
        continue;
      }
      await head.body?.cancel?.();
      const arrivedAt = routePath(new URL(head.url).pathname);
      if (arrivedAt !== path) redirects.push({ from: path, to: arrivedAt });
      const arrived = new Promise(done => { loaded = done; });
      await browser.send('Page.navigate', { url: head.url });
      await within(arrived, 20000);
      await sleep(1200);
      const { result, exceptionDetails } = await browser.send('Runtime.evaluate', { expression: `(${TAKE_PAGE})(${JSON.stringify(origin)})`, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) { skipped.push({ kind: 'page', address, reason: exceptionDetails.exception?.description ?? exceptionDetails.text, retryable: false }); continue; }
      pages.set(path, result.value);
      if (arrivedAt !== path && !seen.has(arrivedAt)) queue.push(arrivedAt);
      for (const address of result.value.query_links ?? []) skipped.push({ address,
        reason: 'this address has a query and was not copied; its link stays on the original site' });
      for (const link of result.value.links) {
        const linkedPath = routePath(new URL(link).pathname);
        if (!seen.has(linkedPath)) queue.push(linkedPath);
      }
      if (pages.size === 1) for (const path of sitemap.paths) if (!seen.has(path)) queue.push(path);
      for (const used of result.value.used) if (!assets.has(used)) assets.set(used, null);
    }
  } finally { browser.close(); }

  const remaining_paths = continuationPaths(queue, seen, origin);
  if (remaining_paths.length) skipped.push(...omittedPages(queue, seen, origin, maxPages));

  // Every file the pages use, and every file their style sheets use in turn, is fetched once.
  const pending = [...assets.keys()];
  while (pending.length) {
    const address = pending.shift();
    const response = await fetch(address).catch(error => ({ ok: false, status: error.message, headers: new Headers(), url: address }));
    if (!response.ok || new URL(response.url).origin !== origin) { skipped.push({ kind: 'asset', address,
      reason: !response.ok ? `the site answered ${response.status}` : 'the file leaves this site', retryable: !response.ok && retryableResponse(response) }); assets.delete(address); continue; }
    const type = response.headers.get('content-type') ?? '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxFileBytes) { skipped.push({ address, reason: `${bytes.length} bytes is over the ${maxFileBytes}-byte file limit; it stays linked to the site` }); assets.delete(address); continue; }
    const file = assetFile(new URL(address), type);
    if (!TEXT_EXTENSIONS.has(file.split('.').at(-1)) && !EXTENSION_OF_TYPE[type.split(';')[0].trim().toLowerCase()] && !/\.(png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf|mp4|mp3|pdf|js)$/i.test(file)) {
      skipped.push({ address, reason: `its type (${type || 'none'}) is not one a public app serves` }); assets.delete(address); continue;
    }
    assets.set(address, { file, type, bytes });
    if (file.endsWith('.css')) {
      for (const match of new TextDecoder().decode(bytes).matchAll(/(?:url\((['"]?)([^'")]+)\1\)|@import\s+["']([^"']+)["'])/g)) {
        const target = match[2] ?? match[3];
        if (target.startsWith('data:')) continue;
        const url = new URL(target, address);
        if (url.origin === origin && !assets.has(url.href)) { assets.set(url.href, null); pending.push(url.href); }
      }
    }
  }
  // Scripts are never served from the copy: a page keeps its rendered markup, so the old script files are dropped.
  for (const [address, kept] of assets) if (kept?.file.endsWith('.js')) { assets.delete(address); }

  const byPath = new Map();
  for (const [address, kept] of assets) byPath.set(new URL(address).pathname + new URL(address).search, `/${kept.file}`);
  for (const path of pages.keys()) byPath.set(path, path);
  const fileOf = rest => {
    const url = new URL(rest, origin);
    const pagePath = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
    return byPath.get(url.pathname + url.search) ?? (url.search ? null : byPath.get(pagePath)) ?? null;
  };

  const files = {};
  let bytes = 0;
  for (const [path, page] of pages) {
    const text = rewrite(page.html, origin, fileOf);
    files[pageFile(path)] = text;
    bytes += Buffer.byteLength(text);
  }
  for (const [address, kept] of assets) {
    if (TEXT_EXTENSIONS.has(kept.file.split('.').at(-1))) {
      const text = new TextDecoder().decode(kept.bytes);
      files[kept.file] = kept.file.endsWith('.css') ? rewrite(text.replace(/url\((['"]?)(?!data:|https?:|\/)([^'")]+)\1\)/g, (whole, quote, relative) => `url(${quote}${new URL(relative, address).pathname}${quote})`), origin, fileOf) : text;
    } else files[kept.file] = `data:${PUBLISHED_BINARY_TYPE[kept.file.split('.').at(-1).toLowerCase()]};base64,${Buffer.from(kept.bytes).toString('base64')}`;
    bytes += kept.bytes.length;
  }
  if (!files['index.html']) throw new BrowserProblem(`The start page ${start.href} could not be copied: ${skipped.map(s => s.reason).join('; ') || 'it answered no page'}.`);
  writeFileSync(join(out, 'site.json'), JSON.stringify({ files }));
  process.stdout.write(`${JSON.stringify({ origin, pages: [...pages.keys()], remaining_paths, redirects,
    asset_paths: [...assets].map(([address, kept]) => ({ address, file: kept.file })),
    files: Object.keys(files).length, bytes, skipped: reportedSkipped(skipped, origin), all_skipped: skipped })}\n`);
}

// Run as a script (the Workshop row runs it); imported, it only lends its naming rules (pageFile, assetFile).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof BrowserProblem ? error.message : error.stack}\n`);
    process.exit(1);
  });
}
