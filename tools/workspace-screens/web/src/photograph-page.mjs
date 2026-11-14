// src/photograph-page.mjs
//
// Purpose
//   A page drawn by the shared parts (a share card, parts/ui/show/document-page shareCardHtml) photographed into a
//   PNG by Cloudflare's Browser Rendering binding, for a link preview that has to be a picture.
//
// Non-negotiable invariants
//   1. Never throws: a missing binding or a failed photograph answers null, and the caller says the picture is not
//      ready; nothing is kept from a failed try.
//   2. The browser is closed on every path, so one photograph never holds a browser for the next.
//

/** { html, width, height } -> PNG bytes, or null. `binding` is the Worker's Browser Rendering binding. */
export async function photographPage(binding, { html, width, height }) {
  if (!binding) return null;
  let browser = null;
  try {
    // The browser library is loaded only when a page is photographed, never at a Worker's start.
    const { default: puppeteer } = await import('@cloudflare/puppeteer');
    browser = await puppeteer.launch(binding);
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    return await page.screenshot({ type: 'png' });
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
