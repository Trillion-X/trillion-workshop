// tools/check-every-screen-at-every-width/check-live-screens.mjs
//
// PURPOSE
//   The live check: opens each page at its real address the way a person's phone or computer opens it (a cold load in its
//   own browser context, the phone's processor and network slowed as live-screens.json says), and measures what the person
//   waits for: when the first paint and the first contentful paint come, when the screen first shows anything (blank_ms),
//   when it is usable (usable_ms: the ready selector is visible and the main thread has been idle for usable_idle_ms), the
//   longest task, the console errors and the failed requests. Then it taps the controls the input names and reports whether
//   each tap showed what its expect names, how long that took, and a picture of the screen. It judges nothing: it reports
//   the numbers and the pictures, and the workflow that calls it compares them with the bar kept as DATA.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Measures only. A page is never passed or failed here, and no threshold is named here.
//   2. Every view of a page is a cold load in a new browser context, so nothing of one view is cached into another.
//   3. The pictures are the person's own: each is kept in their Files under /live-screens/<run>/ through the run's files right
//      (read-data/whole-file.mjs writeWholeFile), and returned by its 1f: identity. A picture the files right cannot keep is
//      returned as base64 only when it is at most inline_png_bytes, and the answer says why it was not kept.
//   4. A sign-in is the owner's handoff: its cookies are added to the page's context and never printed, returned, logged or
//      put in a failure. A URL in the report has its query and fragment removed, where a sign-in token would sit.
//   5. A view not begun by `until` is answered as skipped with its reason, never started late.
//   6. Pages are opened by a browser that goes where the page sends its requests, as a phone's does; nothing here names a page.
//
// SHAPE
//   checkLiveScreens({ pages, views?, until? }, host) -> { run, seconds, pages: [{ id, views: [{ view, new, old?, taps? }] }] }
//     pages   [{ id, url, old_url?, sign_in?, ready?, taps? }]: id is a name for the page; url is the address a person opens;
//             old_url is the address of the old way, measured the same way; sign_in is { cookies: [{ name, value, domain?,
//             path?, secure?, httpOnly?, expires? }] }; ready is a CSS selector that must be visible before the page is usable;
//             taps is [{ name, selector, expect: { appears?: css, text?: string, url_changes?: true, changes?: true } }], each tap
//             made on the new side after its load, one after another, with every expect named there holding to count as worked.
//     views   the view ids of views.json (phone, tablet, desktop); all of them when left out. A view's throttle is in live-screens.json.
//     until   epoch milliseconds; a view not begun by then is answered as { view, skipped: 'until' }.
//   A side is { status, first_paint_ms, first_contentful_paint_ms, usable_ms, blank_ms, longest_task_ms, console_errors,
//   console_error_count, failed_requests, failed_request_count, picture, picture_kept, reason?, png_base64?, error? }.
//   A tap is { name, worked, ms, detail, picture, picture_kept, reason?, png_base64? }.
//   window  true to add the picture of the Trillion app's window as the person sees it (window-picture.mjs); passive, on the Mac only.
//   Refuses (code refused, nothing is opened) a page without an id, url or unique id, an address that is not http or https, a
//   view views.json does not name, an expect with no known key, and a sign-in cookie without a name or value.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { launchChromium, onThisPath } from '../headless-browser/launch.mjs';
import { readViews } from './check-screens.mjs';
import { makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';
import { writeWholeFile } from '../workflows/read-data/whole-file.mjs';
import { windowPicture } from './window-picture.mjs';

export const LIVE = JSON.parse(readFileSync(new URL('./live-screens.json', import.meta.url), 'utf8'));

const EXPECT_KEYS = ['appears', 'text', 'url_changes', 'changes'];
const LIST_LIMIT = 20;
const TEXT_LIMIT = 300;
const POLL_MS = 50;
const SHOT_FOLDER = '/live-screens';

function refuse(message) {
  return Object.assign(new Error(message), { code: 'refused' });
}

// The short, safe words of a name in Files and of a row's id: lower case letters, digits and dashes.
export function slugOf(text, fallback) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
}

// A URL with its query and fragment removed: a sign-in token or a page's state can sit there.
export function addressOf(url) {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
}

const clip = text => String(text).replace(/\s+/g, ' ').slice(0, TEXT_LIMIT);
const firstLine = error => clip(String(error?.message ?? error).split('\n')[0]);
const ms = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);

function httpAddress(url, what) {
  let parsed;
  try { parsed = new URL(url); } catch { throw refuse(`${what} is a full address (http or https).`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw refuse(`${what} is a full address (http or https).`);
  return url;
}

function cookiesOf(signIn, what) {
  if (signIn === undefined) return null;
  if (!signIn || !Array.isArray(signIn.cookies) || signIn.cookies.length === 0) throw refuse(`${what}: sign_in is { cookies: [{ name, value }] }.`);
  return signIn.cookies.map((cookie, at) => {
    if (!cookie || typeof cookie.name !== 'string' || !cookie.name || typeof cookie.value !== 'string') {
      throw refuse(`${what}: sign_in.cookies[${at}] needs a name and a value.`);
    }
    return cookie;
  });
}

function tapsOf(taps, what) {
  if (taps === undefined) return [];
  if (!Array.isArray(taps)) throw refuse(`${what}: taps is a list of { name, selector, expect }.`);
  return taps.map((tap, at) => {
    if (!tap || typeof tap.name !== 'string' || !tap.name || typeof tap.selector !== 'string' || !tap.selector) {
      throw refuse(`${what}: taps[${at}] needs a name and a selector.`);
    }
    const expect = tap.expect ?? {};
    const keys = Object.keys(expect);
    if (keys.length === 0 || keys.some(key => !EXPECT_KEYS.includes(key))) throw refuse(`${what}: taps[${at}].expect names ${EXPECT_KEYS.join(', ')}.`);
    if (expect.appears !== undefined && typeof expect.appears !== 'string') throw refuse(`${what}: taps[${at}].expect.appears is a CSS selector.`);
    if (expect.text !== undefined && typeof expect.text !== 'string') throw refuse(`${what}: taps[${at}].expect.text is a string.`);
    if (expect.url_changes !== undefined && expect.url_changes !== true) throw refuse(`${what}: taps[${at}].expect.url_changes is true.`);
    if (expect.changes !== undefined && expect.changes !== true) throw refuse(`${what}: taps[${at}].expect.changes is true.`);
    return { name: tap.name, selector: tap.selector, expect };
  });
}

// The plan the input asks for, checked before a browser is started.
export function planOf(input) {
  const { pages, views, until, window } = input ?? {};
  if (!Array.isArray(pages) || pages.length === 0) throw refuse('Give pages: [{ id, url, old_url?, sign_in?, ready?, taps? }].');
  const known = readViews().widths;
  const ids = views === undefined ? known.map(view => view.id) : views;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !known.some(view => view.id === id))) {
    throw refuse(`views is a list of ${known.map(view => view.id).join(', ')}.`);
  }
  if (until !== undefined && !Number.isFinite(until)) throw refuse('until is epoch milliseconds.');
  if (window !== undefined && typeof window !== 'boolean') throw refuse('window is true or false: the app window as the person sees it.');
  const slugs = new Set();
  const planned = pages.map((page, at) => {
    if (!page || typeof page.id !== 'string' || !page.id) throw refuse(`pages[${at}] needs an id: a name for the page.`);
    const what = `pages[${at}] (${page.id})`;
    const slug = slugOf(page.id, `page-${at}`);
    if (slugs.has(slug)) throw refuse(`${what}: another page has the name ${slug}; give each its own id.`);
    slugs.add(slug);
    if (typeof page.url !== 'string') throw refuse(`${what} needs url: the address a person opens.`);
    if (page.ready !== undefined && (typeof page.ready !== 'string' || !page.ready)) throw refuse(`${what}: ready is a CSS selector.`);
    return {
      id: page.id,
      slug,
      url: httpAddress(page.url, `${what}: url`),
      oldUrl: page.old_url === undefined ? null : httpAddress(page.old_url, `${what}: old_url`),
      cookies: cookiesOf(page.sign_in, what),
      ready: page.ready ?? null,
      taps: tapsOf(page.taps, what),
    };
  });
  return {
    pages: planned,
    views: known.filter(view => ids.includes(view.id)).map(view => ({ ...view, throttle: LIVE.throttle[view.id] ?? null })),
    until: until ?? null,
    window: window === true,
  };
}

// Runs in the page before any of its own scripts: the paint and long-task observers, and a frame loop that records when the
// screen first shows anything, when the ready selector is visible, when the page has loaded, and when it is usable.
// Self-contained (addInitScript sends its source): it names nothing outside itself.
function measureInit({ idleMs, ready }) {
  const live = { firstPaint: null, firstContentful: null, longest: 0, lastLongEnd: 0, blankAt: null, readyAt: null, loadAt: null, usableAt: null };
  window.__live = live;
  const watch = (type, take) => {
    try { new PerformanceObserver(list => list.getEntries().forEach(take)).observe({ type, buffered: true }); } catch { /* not in this browser */ }
  };
  watch('paint', entry => {
    if (entry.name === 'first-paint') live.firstPaint ??= entry.startTime;
    if (entry.name === 'first-contentful-paint') live.firstContentful ??= entry.startTime;
  });
  watch('longtask', entry => {
    live.longest = Math.max(live.longest, entry.duration);
    live.lastLongEnd = Math.max(live.lastLongEnd, entry.startTime + entry.duration);
  });
  const shown = element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
  };
  const painted = element => {
    if (!shown(element)) return false;
    if (/^(IMG|SVG|CANVAS|VIDEO|PICTURE|IFRAME|INPUT|BUTTON|SELECT|TEXTAREA)$/i.test(element.tagName)) return true;
    return [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '');
  };
  const frame = () => {
    const now = performance.now();
    if (live.blankAt === null && document.body && [...document.body.querySelectorAll('*')].some(painted)) live.blankAt = now;
    if (live.readyAt === null && ready) {
      try { if ([...document.querySelectorAll(ready)].some(shown)) live.readyAt = now; } catch { /* a selector the page cannot match */ }
    }
    if (live.loadAt === null && document.readyState === 'complete') live.loadAt = now;
    const settled = ready ? live.readyAt : live.loadAt;
    if (live.usableAt === null && settled !== null && now - live.lastLongEnd >= idleMs) live.usableAt = now;
    if (live.usableAt === null) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// The phone's processor and network, as the page's own session asks for them (the emulation is per page).
async function applyThrottle(cdp, throttle) {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: throttle.latency_ms,
    downloadThroughput: (throttle.download_kbps * 1024) / 8,
    uploadThroughput: (throttle.upload_kbps * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle.cpu_rate });
}

function listen(page, errors, failed) {
  page.on('console', message => { if (message.type() === 'error') errors.push(clip(message.text())); });
  page.on('pageerror', error => errors.push(clip(error.message)));
  page.on('requestfailed', request => failed.push(clip(`${request.method()} ${addressOf(request.url())} ${request.failure()?.errorText ?? 'failed'}`)));
  page.on('response', response => {
    const request = response.request();
    if (response.status() >= 400 && !request.isNavigationRequest()) failed.push(clip(`${request.method()} ${addressOf(response.url())} ${response.status()}`));
  });
}

const waitForUsable = page => page.waitForFunction(() => window.__live?.usableAt != null, null, { timeout: LIVE.usable_within_ms, polling: 'raf' }).then(() => true, () => false);

// A picture kept in the person's Files under its name, or else returned inline when it is small enough; the identity is the
// BLAKE3 of the exact bytes, the same whether or not the picture was kept.
export async function keepPicture(host, name, bytes) {
  const picture = makeHashCodeHexFromBytes(bytes);
  try {
    await writeWholeFile(host, name, bytes, { mediaType: 'image/png' });
    return { picture, picture_kept: true };
  } catch (error) {
    const reason = clip(error?.code ?? error?.message ?? 'keep_failed');
    if (bytes.length <= LIVE.inline_png_bytes) return { picture, picture_kept: false, reason, png_base64: bytes.toString('base64') };
    return { picture, picture_kept: false, reason };
  }
}

// The page's DOM as one number, so a change of the screen is seen without keeping the markup.
const digestOf = page => page.evaluate(() => {
  const markup = document.body ? document.body.innerHTML : '';
  let hash = 0;
  for (let at = 0; at < markup.length; at += 1) hash = (hash * 31 + markup.charCodeAt(at)) | 0;
  return `${hash}:${markup.length}`;
}).catch(() => '');

async function expectationsMissed(page, expect, before) {
  const missed = [];
  if (expect.appears !== undefined && !(await page.locator(expect.appears).first().isVisible().catch(() => false))) missed.push(`${expect.appears} is not visible`);
  if (expect.text !== undefined && !(await page.evaluate(text => (document.body?.innerText ?? '').includes(text), expect.text).catch(() => false))) missed.push(`the text "${clip(expect.text)}" is not shown`);
  if (expect.url_changes && page.url() === before.url) missed.push('the address did not change');
  if (expect.changes && (await digestOf(page)) === before.digest) missed.push('the screen did not change');
  return missed;
}

// One tap: click, then poll what it expects until it holds or tap_within_ms is spent. A tap that moved the address is
// undone by opening the page again, so the next tap starts from the page.
async function runTap({ page, startUrl, tap, index, name, run, keep }) {
  const before = { url: page.url(), digest: await digestOf(page) };
  const began = Date.now();
  let missed = [];
  try {
    await page.locator(tap.selector).first().click({ timeout: LIVE.tap_within_ms });
    do {
      missed = await expectationsMissed(page, tap.expect, before);
      if (missed.length === 0) break;
      await new Promise(done => setTimeout(done, POLL_MS));
    } while (Date.now() - began < LIVE.tap_within_ms);
  } catch (error) {
    missed = [`the tap on ${clip(tap.selector)} did not happen: ${firstLine(error)}`];
  }
  const elapsed = Date.now() - began;
  const worked = missed.length === 0;
  const bytes = await page.screenshot({ type: 'png', caret: 'hide' }).catch(() => null);
  const shot = bytes ? await keep(`${SHOT_FOLDER}/${run}/${name}-tap-${index + 1}-${slugOf(tap.name, 'tap')}.png`, bytes) : { picture: null, picture_kept: false, reason: 'no_picture' };
  if (page.url() !== before.url) {
    await page.goto(startUrl, { waitUntil: 'commit', timeout: LIVE.navigation_within_ms }).catch(() => {});
    await waitForUsable(page);
  }
  return { name: tap.name, worked, ms: worked ? elapsed : null, detail: worked ? 'did what it expects' : missed.join('; '), ...shot };
}

// One side of a view: a cold load in its own context, measured, pictured and (on the new side) tapped.
async function measureSide({ browser, url, view, cookies, ready, name, run, keep, taps = [] }) {
  const context = await browser.newContext({ viewport: view.viewport, isMobile: !!view.mobile, hasTouch: !!view.mobile, deviceScaleFactor: 1 });
  const errors = [];
  const failed = [];
  try {
    if (cookies) await context.addCookies(cookies.map(cookie => ({ domain: new URL(url).hostname, path: '/', ...cookie })));
    const page = await context.newPage();
    if (view.throttle) await applyThrottle(await context.newCDPSession(page), view.throttle);
    await page.addInitScript(measureInit, { idleMs: LIVE.usable_idle_ms, ready });
    listen(page, errors, failed);
    const began = Date.now();
    let status = null;
    let error = null;
    try {
      status = (await page.goto(url, { waitUntil: 'commit', timeout: LIVE.navigation_within_ms }))?.status() ?? null;
      await waitForUsable(page);
    } catch (caught) {
      error = firstLine(caught);
    }
    const live = await page.evaluate(() => window.__live ?? null).catch(() => null);
    const bytes = await page.screenshot({ type: 'png', caret: 'hide' }).catch(() => null);
    const shot = bytes ? await keep(`${SHOT_FOLDER}/${run}/${name}.png`, bytes) : { picture: null, picture_kept: false, reason: 'no_picture' };
    const side = {
      status,
      first_paint_ms: ms(live?.firstPaint),
      first_contentful_paint_ms: ms(live?.firstContentful),
      usable_ms: ms(live?.usableAt),
      // A screen that never showed anything is blank for the whole wait.
      blank_ms: ms(live?.blankAt ?? Date.now() - began),
      longest_task_ms: ms(live?.longest),
      console_errors: errors.slice(0, LIST_LIMIT),
      console_error_count: errors.length,
      failed_requests: failed.slice(0, LIST_LIMIT),
      failed_request_count: failed.length,
      ...shot,
      ...(error ? { error } : {}),
    };
    const tapped = [];
    if (!error) {
      for (const [index, tap] of taps.entries()) tapped.push(await runTap({ page, startUrl: url, tap, index, name, run, keep }));
    }
    return { side, taps: tapped };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Every page at every view on a real browser, measured and pictured; see the header for the shapes. */
export async function checkLiveScreens(input = {}, host, { keep = (name, bytes) => keepPicture(host, name, bytes) } = {}) {
  const plan = planOf(input);
  const started = Date.now();
  const run = randomUUID().slice(0, 8);
  const browser = await launchChromium({ headless: true, executablePath: onThisPath('chrome-headless-shell') });
  try {
    const pages = [];
    for (const page of plan.pages) {
      const views = [];
      for (const view of plan.views) {
        if (plan.until !== null && Date.now() >= plan.until) {
          views.push({ view: view.id, skipped: 'until' });
          continue;
        }
        const name = `${page.slug}-${view.id}`;
        const answer = { view: view.id };
        const shared = { browser, view, ready: page.ready, run, keep };
        const current = await measureSide({ ...shared, url: page.url, cookies: page.cookies, name: `${name}-new`, taps: page.taps });
        answer.new = current.side;
        if (page.taps.length > 0) answer.taps = current.taps;
        if (page.oldUrl) {
          answer.old = (await measureSide({ ...shared, url: page.oldUrl, cookies: page.cookies, name: `${name}-old` })).side;
        }
        views.push(answer);
      }
      pages.push({ id: page.id, views });
    }
    const answer = { run, seconds: Math.round((Date.now() - started) / 100) / 10, pages };
    if (plan.window) answer.window = await windowPicture({ owner: 'Trillion', name: `/live-screens/${run}/window.png`, keep });
    return answer;
  } finally {
    await browser.close().catch(() => {});
  }
}
