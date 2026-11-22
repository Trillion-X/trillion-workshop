// tools/ui/show/consent-banner/consent-banner-layout.test.mjs: while the bar is open it sits flush at the bottom and the page's last
// content scrolls above it; after the visitor chooses, the reserved space is gone. Runs in a fresh headless Chromium at a phone
// and a laptop width (consent-banner-check.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withConsentPage } from './consent-banner-check.mjs';

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`at ${viewport.width}x${viewport.height} the bar sits flush at the bottom and the last content scrolls above it`, async () => {
    await withConsentPage({ viewport }, async (page) => {
      await page.waitForSelector('.consent-banner');
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const layout = await page.evaluate(() => {
        const last = document.getElementById('last').getBoundingClientRect();
        const bar = document.querySelector('.consent-banner').getBoundingClientRect();
        return { lastBottom: last.bottom, barTop: bar.top, barBottom: bar.bottom, viewportHeight: window.innerHeight, reserve: document.documentElement.style.getPropertyValue('--consent-banner-reserve') };
      });
      assert.equal(layout.barBottom, layout.viewportHeight, `the bar bottom ${layout.barBottom} is not at the window bottom ${layout.viewportHeight}`);
      assert.ok(layout.lastBottom <= layout.barTop, `last content bottom ${layout.lastBottom} is under the bar top ${layout.barTop}`);
      assert.notEqual(layout.reserve, '', 'the page reserves the bar height');
    });
  });

  test(`at ${viewport.width}x${viewport.height} accepting gives the reserved space back`, async () => {
    await withConsentPage({ viewport }, async (page) => {
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
