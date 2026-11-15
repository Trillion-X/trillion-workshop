// Source-first port of private-film-source capture/site-media.mjs; the active crawl below retains its mechanisms.
import { launchChromium as startChromium } from '../../headless-browser/launch.mjs';
import { browserExecutable } from '../../headless-browser/devtools.mjs';

// The engine passes the first page positionally and supplies the public-only proxy for internet runs.
const supplied = new URL(process.argv[2]);
if (!['http:', 'https:'].includes(supplied.protocol) || supplied.username || supplied.password) {
  throw new Error('Give a public HTTP or HTTPS address without credentials.');
}
const proxyAddress = process.env.HTTPS_PROXY || process.env.https_proxy;
let browserForCleanup;
const launchChromium = async () => browserForCleanup = await startChromium({
  executablePath: browserExecutable(process.env.BROWSER_EXECUTABLE),
  ...(proxyAddress ? { proxy: { server: proxyAddress, bypass: '<-loopback>' } } : {}),
});

const start = process.argv[2]; const origin = new URL(start).origin;
try {
const b = await launchChromium(); const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
const media = new Set(), pages = new Set([start]), seen = new Set();
const visit = async u => {
  const p = await c.newPage();
  p.on('request', r => { const x = r.url(); if (/\.(mp4|webm|mov|m3u8)(\?|$)/i.test(x) || /stream\.mux\.com|vimeo\.com\/.*\/video|player\.vimeo/.test(x)) media.add(x.split('?')[0].includes('mux.com') ? x.split('?')[0] : x); });
  await p.goto(u, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, 1400); await p.waitForTimeout(500); }
  const found = await p.evaluate(() => ({ v: [...document.querySelectorAll('video, video source, iframe')].map(e => e.currentSrc || e.src).filter(Boolean), a: [...document.querySelectorAll('a[href]')].map(a => a.href) }));
  // The original prefix filter is retained below; this exact-origin check prevents lookalike hosts.
  found.a = found.a.filter(address => { try { return new URL(address).origin === origin; } catch { return false; } });
  found.v.forEach(x => media.add(x)); found.a.filter(x => x.startsWith(origin) && !x.includes('#')).forEach(x => pages.add(x.split('?')[0]));
  await p.close();
};
while (seen.size < 25) { const next = [...pages].find(x => !seen.has(x)); if (!next) break; seen.add(next); await visit(next); }
console.log(JSON.stringify({ result: { origin, pages: [...seen], videos: [...media], remaining_pages: [...pages].filter(x => !seen.has(x)) } }));
} finally { await browserForCleanup?.close(); }
