// tools/ui/show/consent-banner/consent-banner-check.mjs
//
// The fresh-browser check helper for the consent bar: a page the part draws on, and a launcher that gives each check its own
// Chromium and page at the viewport it names. A site imports this to check its own page the same way the part's tests do.
//   import { withConsentPage } from 'trillion-workshop/tools/ui/show/consent-banner/consent-banner-check.mjs';
//   await withConsentPage({ viewport: { width: 390, height: 844 } }, async (page) => { ... });
// Never connectOverCDP: each call launches its own headless Chromium and closes it when the run ends.
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { consentBannerScript, consentBannerStyle, consentDefaultScript } from './consent-banner.mjs';

export const SAMPLE_CONSENT = {
  default: 'denied',
  storage_types: ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'],
  cookie: { name: 'school_consent', max_age_seconds: 15552000 },
  banner: { label: 'Cookie choice', message: 'We measure visits only if you accept.', accept: 'Accept', decline: 'Decline' },
};

/** A page with a tall body whose last paragraph (#last) ends the page, with the part's default, style and bar in its head. */
export function consentPageHtml(consent = SAMPLE_CONSENT) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>consent check</title>${consentDefaultScript(consent)}<style>${consentBannerStyle()}</style><style>.filler{height:2400px}</style>${consentBannerScript(consent)}</head><body><main><div class="filler"></div><p id="last">Last content</p></main></body></html>`;
}

/**
 * Runs `run(page)` on a page at `viewport` in a fresh headless Chromium, served over local HTTP so cookies work. Browser and server
 * are closed when `run` ends, whether it passes or throws.
 */
export async function withConsentPage({ viewport, consent = SAMPLE_CONSENT, html = consentPageHtml(consent) }, run) {
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
