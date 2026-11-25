// tools/check-a-site-build-in-a-browser/do-work/measure-page.mjs
//
// Purpose
//   Opens one address in a headless Chromium (tools/headless-browser) and reads what a person would see: the page's full
//   height, every uncaught page error, the computed font-family of the reading element, the visible text length, and the
//   path the browser ends on (after any redirect the page's script makes). A picture
//   of the whole page is kept.
//
// Non-negotiable invariants
//   1. The page is waited for until its load event (never network idle), then given settle_ms for scripts to draw.
//   2. The reading font is read from the settings' reading_selector, never from body.
//   3. A page error is the first line of the uncaught exception's description, so the same error on two pages compares equal.
//   4. However it ends, the browser ends with it.
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../headless-browser/devtools.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));

const IN_PAGE = selector => `(() => {
  const reading = document.querySelector(${JSON.stringify(selector)});
  return {
    height: document.documentElement.scrollHeight,
    font: reading ? getComputedStyle(reading).fontFamily : null,
    text: (document.body ? document.body.innerText : '').trim().length,
    path: location.pathname,
  };
})()`;

const messageOf = details => {
  const said = details.exception?.description ?? details.exception?.value ?? details.text ?? 'error';
  return String(said).split('\n')[0].replace(/^Uncaught\s+/, '').slice(0, 300);
};

/** Opens `url`, answers { height, font, text, path, errors } and writes a whole-page picture to `shot`. Throws when the page does not load. */
export async function measurePage({ url, shot, settings, browser }) {
  const page = await openBrowser(browser || process.env.BROWSER_EXECUTABLE || 'chromium', settings.viewport);
  try {
    const errors = [];
    let loaded;
    const loadEvent = new Promise(done => { loaded = done; });
    page.on(event => {
      if (event.method === 'Runtime.exceptionThrown') errors.push(messageOf(event.params.exceptionDetails));
      if (event.method === 'Page.loadEventFired') loaded();
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { ...settings.viewport, deviceScaleFactor: 1, mobile: false });
    const { errorText } = await page.send('Page.navigate', { url });
    if (errorText) throw new Error(errorText);
    let timer;
    const late = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`no load event within ${settings.navigation_timeout_ms} ms`)), settings.navigation_timeout_ms); });
    try { await Promise.race([loadEvent, late]); } finally { clearTimeout(timer); }
    await wait(settings.settle_ms);
    const { result } = await page.send('Runtime.evaluate', { expression: IN_PAGE(settings.reading_selector), returnByValue: true });
    const seen = result.value;
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: settings.viewport.width, height: Math.min(seen.height, settings.max_screenshot_px), scale: 1 } });
    writeFileSync(shot, Buffer.from(data, 'base64'));
    return { ...seen, errors };
  } finally {
    page.close();
  }
}
