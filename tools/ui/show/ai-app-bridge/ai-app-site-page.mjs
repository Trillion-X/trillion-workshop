// file: parts/ui/show/ai-app-bridge/ai-app-site-page.mjs
//
// A SITE'S OWN PAGE, DRAWN INSIDE AN AI APP.
//
// A site made with Trillion opens inside an AI app (ChatGPT, Claude) as an MCP Apps view: the app loads the page's HTML
// in its own sandboxed frame, at an address that is not the site's. This turns the site's page into that view: every
// address the page names is made absolute against the page's real address (an app's frame may refuse a <base>), and a
// small script runs first that speaks the MCP Apps bridge (./ai-app-bridge.mjs) and sends every request the page makes
// to its own site through the request tool the site's server names, so a form inside the chat records exactly as on
// the web. A link opens in the person's browser through the app.
//
// Invariants
// - The page's own markup is kept as it is; only address values and one leading script are changed.
// - Only addresses on the page's own origin go through the request tool; every other request is the browser's own.
// - The script carries the bridge as source (the same function the service's own views use) and its settings as JSON,
//   never markup.
// - IT LIVES IN THE SHARED UI PART because it is an HTML sink: callers hand a page and addresses, never tags.

import { connectToAiApp } from './ai-app-bridge.mjs';

// A value that already names where it is (a scheme, a protocol-relative address or a fragment) stays as it is.
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|#)/i;
const absolute = (value, pageUrl) => {
  const trimmed = value.trim();
  if (!trimmed || ABSOLUTE.test(trimmed)) return value;
  try { return new URL(trimmed, pageUrl).href; } catch { return value; }
};
const cssAddresses = (css, pageUrl) => css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, quote, value) => `url(${quote}${absolute(value, pageUrl)}${quote})`);
const srcset = (value, pageUrl) => value.split(',').map(part => {
  const [address, ...descriptor] = part.trim().split(/\s+/);
  return address ? [absolute(address, pageUrl), ...descriptor].join(' ') : part;
}).join(', ');
// Attributes that name an address; `srcset` names several, `style` may name some inside url().
const ATTRIBUTE = /(\s)(src|href|poster|action|data|srcset|style|xlink:href)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const rewriteTag = (tag, pageUrl) => tag.replace(ATTRIBUTE, (whole, space, name, equals, doubleQuoted, singleQuoted) => {
  const value = doubleQuoted ?? singleQuoted;
  const lower = name.toLowerCase();
  const changed = lower === 'srcset' ? srcset(value, pageUrl) : lower === 'style' ? cssAddresses(value, pageUrl) : absolute(value, pageUrl);
  const quote = doubleQuoted === undefined ? "'" : '"';
  return `${space}${name}${equals}${quote}${changed}${quote}`;
});

/** Runs in the page inside the AI app: the bridge, the page's own requests through `requestTool`, links opened outside. */
function siteInAiApp(connect, settings) {
  const bridge = connect(window, { appName: 'site', content: document.documentElement });
  const own = value => {
    try { const url = new URL(value, settings.pageUrl); return url.origin === settings.origin ? url : null; } catch { return null; }
  };
  const browserFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const asked = typeof Request === 'function' && input instanceof Request ? input : null;
    const url = own(asked ? asked.url : String(input));
    if (!url) return browserFetch(input, init);
    const method = String(init.method ?? asked?.method ?? 'GET').toUpperCase();
    const given = new Headers(init.headers ?? asked?.headers ?? {});
    const headers = {};
    for (const name of settings.headers) if (given.has(name)) headers[name] = given.get(name);
    const body = init.body !== undefined ? init.body : asked && method !== 'GET' && method !== 'HEAD' ? await asked.text() : undefined;
    const answer = await bridge.callTool(settings.requestTool, { method, path: `${url.pathname}${url.search}`, headers,
      ...(typeof body === 'string' ? { text: body } : body instanceof URLSearchParams ? { text: body.toString() } : {}) });
    const bytes = typeof answer?.base64 === 'string' ? Uint8Array.from(atob(answer.base64), character => character.charCodeAt(0)) : answer?.text ?? '';
    return new Response(method === 'HEAD' || answer?.status === 204 ? null : bytes,
      { status: answer?.status ?? 502, headers: answer?.content_type ? { 'content-type': answer.content_type } : {} });
  };
  document.addEventListener('click', event => {
    const link = event.target?.closest?.('a[href]');
    if (!link || event.defaultPrevented) return;
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    let url;
    try { url = new URL(href, settings.pageUrl); } catch { return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') return;
    event.preventDefault();
    bridge.openLink(url.href);
  }, true);
  const report = () => bridge.reportSize();
  window.addEventListener('load', report);
  if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.documentElement);
  report();
}

/** The script text that runs first in the page: the bridge and `siteInAiApp` as source, with their settings as JSON. */
export function aiAppSiteScript({ origin, pageUrl, requestTool, headers }) {
  const settings = JSON.stringify({ origin, pageUrl, requestTool, headers }).replace(/</g, '\\u003c');
  return `(${siteInAiApp.toString()})(${connectToAiApp.toString()},${settings});`;
}

/** The site's page `html`, at `pageUrl` on `origin`, as the AI app's view: absolute addresses and the bridge first. */
export function aiAppSitePage(html, { origin, pageUrl, requestTool, headers = ['accept', 'content-type', 'idempotency-key'] }) {
  const script = `<script>${aiAppSiteScript({ origin, pageUrl, requestTool, headers }).replace(/<\/script/gi, '<\\/script')}</script>`;
  const addressed = String(html)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (whole, open, css, close) => `${open}${cssAddresses(css, pageUrl)}${close}`)
    .replace(/<[a-z][a-z0-9:-]*\b[^>]*>/gi, tag => rewriteTag(tag, pageUrl));
  const head = /<head\b[^>]*>/i.exec(addressed);
  if (head) return `${addressed.slice(0, head.index + head[0].length)}${script}${addressed.slice(head.index + head[0].length)}`;
  const opened = /<html\b[^>]*>/i.exec(addressed);
  if (opened) return `${addressed.slice(0, opened.index + opened[0].length)}<head>${script}</head>${addressed.slice(opened.index + opened[0].length)}`;
  return `<!doctype html><html><head>${script}</head><body>${addressed}</body></html>`;
}
