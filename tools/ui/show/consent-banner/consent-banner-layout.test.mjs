// tools/ui/show/consent-banner/consent-banner-layout.test.mjs: while the bar is open the page's last content scrolls above it, and the
// space is given back when the visitor chooses. Runs in a fresh headless Chromium at a phone and a laptop width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { consentBannerScript, consentBannerStyle, consentDefaultScript } from './consent-banner.mjs';

const consent = {
  default: 'denied',
  storage_types: ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'],
  cookie: { name: 'school_consent', max_age_seconds: 15552000 },
  banner: { label: 'Cookie choice', message: 'We measure visits only if you accept.', accept: 'Accept', decline: 'Decline' },
};

// A page whose last paragraph sits at the bottom of a page taller than the window, with the bar's parts in its head.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>layout</title>${consentDefaultScript(consent)}<style>${consentBannerStyle()}</style><style>.filler{height:2400px}</style>${consentBannerScript(consent)}</head><body><main><div class="filler"></div><p id="last">Last content</p></main></body></html>`;

async function withPage(viewport, run) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    return await run(page);
  } finally {
    await browser.close();
    server.close();
  }
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`at ${viewport.width}x${viewport.height} the last content scrolls above the open bar`, async () => {
    await withPage(viewport, async (page) => {
      await page.waitForSelector('.consent-banner');
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const clearance = await page.evaluate(() => {
        const last = document.getElementById('last').getBoundingClientRect();
        const bar = document.querySelector('.consent-banner').getBoundingClientRect();
        return { lastBottom: last.bottom, barTop: bar.top, reserve: document.documentElement.style.getPropertyValue('--consent-banner-reserve') };
      });
      assert.ok(clearance.lastBottom <= clearance.barTop, `last content bottom ${clearance.lastBottom} is under the bar top ${clearance.barTop}`);
      assert.notEqual(clearance.reserve, '', 'the page reserves the bar height');
    });
  });

  test(`at ${viewport.width}x${viewport.height} accepting gives the reserved space back`, async () => {
    await withPage(viewport, async (page) => {
      await page.waitForSelector('.consent-banner');
      await page.getByRole('button', { name: 'Accept' }).click();
      await page.waitForSelector('.consent-banner', { state: 'detached' });
      const after = await page.evaluate(() => ({
        openClass: document.body.classList.contains('consent-banner-open'),
        reserve: document.documentElement.style.getPropertyValue('--consent-banner-reserve'),
        spacer: getComputedStyle(document.body, '::after').content,
      }));
      assert.equal(after.openClass, false);
      assert.equal(after.reserve, '');
      assert.equal(after.spacer, 'none');
    });
  });
}
