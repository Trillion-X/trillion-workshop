// tools/ui/show/consent-banner/consent-banner-layout.test.mjs: while the bar is open it sits flush at the bottom and the page's last
// content scrolls above it; after the visitor chooses, the reserved space is gone. Runs in a fresh headless Chromium at a phone
// and a laptop width (consent-banner-check.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consentBannerScript, consentBannerStyle, consentDefaultScript } from './consent-banner.mjs';
import { SAMPLE_CONSENT, withConsentPage } from './consent-banner-check.mjs';
import { windowEdgeInset } from '../../../sidebar/show/window-edge-inset.ts';

// The members page's frame (tools/workspace-screens/web/members-page) with a sidebar and a screen area taller than the window: a
// frame as tall as the window whose columns scroll themselves. The page itself must not scroll: its columns end above the bar.
// The sidebar's own rail is a window-level frame portalled into the body (tools/sidebar DesktopSidebar), fixed from the window's
// top to its bottom inset (window-edge-inset.ts): it too must end above the bar.
const membersCss = readFileSync(new URL('../../../workspace-screens/web/members-page/members-page.css', import.meta.url), 'utf8');
const rows = (id) => `${Array.from({ length: 80 }, (_, n) => `<p>Row ${n}</p>`).join('')}<p id="${id}">Last row</p>`;
const membersPageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>members frame</title>${consentDefaultScript(SAMPLE_CONSENT)}`
  + `<style>${consentBannerStyle()}</style><style>${membersCss}</style><style>.members-page__arrangement{overflow:auto}.rail{position:fixed;left:0;width:240px;overflow:auto;top:${windowEdgeInset('top', 8)};bottom:${windowEdgeInset('bottom', 8)}}</style>${consentBannerScript(SAMPLE_CONSENT)}</head>`
  + `<body><div class="members-page__frame"><aside class="members-page__sidebar">${rows('sidebar-last')}</aside>`
  + `<main class="members-page__arrangement">${rows('screen-last')}</main></div><aside class="rail">${rows('rail-last')}</aside></body></html>`;

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

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`at ${viewport.width}x${viewport.height} the members page's sidebar and screens end above the bar, and fill the window after a choice`, async () => {
    await withConsentPage({ viewport, html: membersPageHtml }, async (page) => {
      await page.waitForSelector('.consent-banner');
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      const ends = () => page.evaluate(() => {
        for (const column of document.querySelectorAll('.members-page__sidebar, .members-page__arrangement, .rail')) column.scrollTop = column.scrollHeight;
        const bar = document.querySelector('.consent-banner')?.getBoundingClientRect() ?? null;
        return {
          barTop: bar?.top ?? null,
          sidebarLast: document.getElementById('sidebar-last').getBoundingClientRect().bottom,
          screenLast: document.getElementById('screen-last').getBoundingClientRect().bottom,
          railBottom: document.querySelector('.rail').getBoundingClientRect().bottom,
          frameBottom: document.querySelector('.members-page__frame').getBoundingClientRect().bottom,
          windowHeight: window.innerHeight,
          pageHeight: document.documentElement.scrollHeight,
        };
      });
      const open = await ends();
      assert.equal(open.pageHeight, open.windowHeight, 'the page itself does not scroll while the bar is open');
      assert.ok(open.sidebarLast <= open.barTop, `the sidebar's last row ends at ${open.sidebarLast}, under the bar top ${open.barTop}`);
      assert.ok(open.screenLast <= open.barTop, `the screens' last row ends at ${open.screenLast}, under the bar top ${open.barTop}`);
      // The bar measures itself in whole pixels (offsetHeight), so its top may sit up to a pixel from that.
      assert.ok(Math.abs(open.railBottom - (open.barTop - 8)) < 1, `the sidebar rail ends at ${open.railBottom}, not 8 px above the bar top ${open.barTop}`);
      await page.getByRole('button', { name: 'Accept' }).click();
      await page.waitForSelector('.consent-banner', { state: 'detached' });
      const closed = await ends();
      assert.equal(closed.frameBottom, closed.windowHeight, 'with the bar gone the frame reaches the bottom of the window again');
      assert.equal(closed.pageHeight, closed.windowHeight);
      assert.equal(closed.railBottom, closed.windowHeight - 8, 'with the bar gone the rail reaches 8 px from the window bottom again');
    });
  });
}
