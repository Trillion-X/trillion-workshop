// The Trillion checkout is the one this place reports (TRILLION_CHECKOUT); no home folder is assumed.
if (!process.env.TRILLION_CHECKOUT) throw new Error('TRILLION_CHECKOUT');
const trillion = name => new URL(name, `file://${process.env.TRILLION_CHECKOUT.replace(/\/?$/, '/')}`).href;
const { launchChromium } = await import(trillion('parts/headless-browser/launch.mjs'));
// List every video a JS-rendered site plays (video tags, m3u8/mp4 requests) across its pages. usage: node site-media.mjs <url>
const start = process.argv[2]; const origin = new URL(start).origin;
const b = await launchChromium(); const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
const media = new Set(), pages = new Set([start]), seen = new Set();
const visit = async u => {
  const p = await c.newPage();
  p.on('request', r => { const x = r.url(); if (/\.(mp4|webm|mov|m3u8)(\?|$)/i.test(x) || /stream\.mux\.com|vimeo\.com\/.*\/video|player\.vimeo/.test(x)) media.add(x.split('?')[0].includes('mux.com') ? x.split('?')[0] : x); });
  await p.goto(u, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, 1400); await p.waitForTimeout(500); }
  const found = await p.evaluate(() => ({ v: [...document.querySelectorAll('video, video source, iframe')].map(e => e.currentSrc || e.src).filter(Boolean), a: [...document.querySelectorAll('a[href]')].map(a => a.href) }));
  found.v.forEach(x => media.add(x)); found.a.filter(x => x.startsWith(origin) && !x.includes('#')).forEach(x => pages.add(x.split('?')[0]));
  await p.close();
};
while (seen.size < 25) { const next = [...pages].find(x => !seen.has(x)); if (!next) break; seen.add(next); await visit(next); }
console.log('PAGES', seen.size); [...media].forEach(x => console.log(x)); await b.close();
