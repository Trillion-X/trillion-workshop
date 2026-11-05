// tools/browse-public-page/do-work/list-the-videos-a-site-plays.mjs
//
// Lists every video a website plays: each page of the site is drawn in a headless browser, scrolled through so late
// players load, and its videos are played, and every video address the page asks for (files, streams, hosted
// players) is kept with the pages it was on, plus every video, video source and frame the page shows, with the link
// around it and that link's words.
//
// Invariants:
//   - Nothing here names a site, product or brand. The start address, the pages no link reaches and the limits are input;
//     which addresses are videos is DATA (video-addresses.json).
//   - Only the start address's own pages are visited; a video from any site is listed.
//   - Nothing is kept: the run answers one JSON line and leaves no file.
//   - The browser is driven over the DevTools protocol (tools/headless-browser/devtools.mjs): no browser library.
//   - Where it reaches is not decided here. The engine runs it as an internet:true tool, so its browser goes only through
//     the engine's public-only proxy, which judges every address and redirect.
//
// Usage:
//   node do-work/list-the-videos-a-site-plays.mjs --url <address> [--max-pages 25] [--paths '["/films/a"]']
//     [--scrolls 10] [--play true] [--width 1440] [--height 900] [--browser chromium, or BROWSER_EXECUTABLE]
//
// Prints one JSON line: { origin, pages[], videos[{ address, found, pages[], link, words }], remaining_paths[], skipped[] }.
// On a request it cannot run prints the reason on standard error and exits 1.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserProblem, openBrowser } from '../../headless-browser/devtools.mjs';

const RULES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'video-addresses.json'), 'utf8'));

const sleep = ms => new Promise(done => setTimeout(done, ms));
const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(done => { timer = setTimeout(done, ms); })]).finally(() => clearTimeout(timer));
};

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new BrowserProblem(`Unexpected argument ${name}.`);
    args[name.slice(2)] = argv[index + 1] ?? '';
  }
  return args;
}

const routePath = path => path === '/' ? '/' : path.replace(/\/$/, '');
/** A path that names a page, not a file: no file extension, or an HTML one. */
export const isPagePath = path => !/\.[a-z0-9]{1,5}$/i.test(path) || /\.html?$/i.test(path);

/**
 * The address a request is listed under when it is a video, else null. `type` is the browser's resource type for it
 * (Media for what a video element loads); `rules` is video-addresses.json.
 */
export function videoAddress(address, type = '', rules = RULES) {
  let url;
  try { url = new URL(address); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const extension = url.pathname.split('/').at(-1).split('.').slice(1).at(-1)?.toLowerCase() ?? '';
  const isVideo = rules.request_types.includes(type) || rules.extensions.includes(extension)
    || rules.players.some(pattern => new RegExp(pattern).test(url.href));
  if (!isVideo) return null;
  return rules.strip_query_hosts.includes(url.hostname) ? url.origin + url.pathname : url.href.split('#')[0];
}

// Runs in the page once it has settled and been scrolled: plays every video when asked, and answers every video,
// video source and frame it shows (with the link around it and that link's words) and its own same-site page links.
const READ_PAGE = `async ({ origin, play }) => {
  if (play) {
    // A play that never settles (no source, or one the browser cannot decode) is not waited for.
    for (const video of document.querySelectorAll('video')) { video.muted = true; try { video.play()?.catch(() => {}); } catch {} }
    await new Promise(done => setTimeout(done, 3000));
  }
  const shown = [];
  for (const element of document.querySelectorAll('video, video source, iframe')) {
    const address = element.currentSrc || element.src;
    if (!address) continue;
    const link = element.closest('a[href]');
    shown.push({ address, found: element.tagName === 'IFRAME' ? 'frame' : 'shown',
      link: link ? link.href : null, words: link ? link.innerText.trim().replace(/\\s+/g, ' ').slice(0, 120) || null : null });
  }
  const links = [...document.querySelectorAll('a[href]')].map(a => { try { return new URL(a.getAttribute('href'), location.href); } catch { return null; } })
    .filter(url => url && url.origin === origin).map(url => url.origin + url.pathname);
  return { shown, links: [...new Set(links)] };
}`;

// One page scrolled `scrolls` times, a screen and a half each, waiting for what each scroll loads.
const SCROLL = `async (scrolls) => {
  for (let index = 0; index < scrolls; index++) { scrollBy(0, Math.max(1200, innerHeight * 1.5)); await new Promise(done => setTimeout(done, 500)); }
}`;

// How a video was found, weakest first: a sighting on the page itself says more than a request or a link to its file.
const FOUND_RANK = { requested: 0, linked: 1, shown: 2, frame: 2 };

/** Adds one sighting of a video to `videos` (address -> entry): its pages, and the link around it when one is known. */
export function noteVideo(videos, { address, found, link = null, words = null }, page) {
  const kept = videos.get(address) ?? { address, found, pages: [], link: null, words: null };
  if (!kept.pages.includes(page)) kept.pages.push(page);
  if (FOUND_RANK[found] > FOUND_RANK[kept.found]) kept.found = found;
  kept.link ??= link;
  kept.words ??= words;
  videos.set(address, kept);
}

function webAddress(text) {
  let url;
  try { url = new URL(String(text)); } catch { throw new BrowserProblem('Give a full web address, like https://example.com/.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new BrowserProblem('The address must be a web address (https:// or http://) with no user name or password.');
  }
  return url;
}

function inputPaths(value, origin) {
  let paths;
  try { paths = JSON.parse(value || '[]'); } catch { throw new BrowserProblem('--paths needs a list of page paths, like ["/films/a"].'); }
  if (!Array.isArray(paths) || paths.length > 200 || paths.some(path => typeof path !== 'string' || !path.startsWith('/')
    || path.startsWith('//') || new URL(path, origin).origin !== origin)) throw new BrowserProblem('--paths needs at most 200 paths on this site, each starting with /.');
  return paths.map(path => routePath(new URL(path, origin).pathname));
}

function count(value, name, lowest, highest, otherwise) {
  const number = value === undefined || value === '' ? otherwise : Number(value);
  if (!Number.isInteger(number) || number < lowest || number > highest) throw new BrowserProblem(`--${name} must be a whole number from ${lowest} to ${highest}.`);
  return number;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.url) throw new BrowserProblem('Give --url, the address of the site whose videos to list.');
  const start = webAddress(args.url);
  const origin = start.origin;
  const maxPages = count(args['max-pages'], 'max-pages', 1, 100, 25);
  const scrolls = count(args.scrolls, 'scrolls', 0, 60, 10);
  const play = args.play !== 'false';
  const width = count(args.width, 'width', 320, 2560, 1440);
  const height = count(args.height, 'height', 320, 2560, 900);
  const queue = [routePath(start.pathname), ...inputPaths(args.paths, origin)];
  const seen = new Set();
  const pages = [];
  const videos = new Map();
  const skipped = [];

  const browser = await openBrowser(args.browser || process.env.BROWSER_EXECUTABLE || 'chromium', { width, height });
  try {
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    await browser.send('Network.enable');
    let loaded = () => {};
    let page = null;
    let navigationFailed = null;
    browser.on(event => {
      if (event.method === 'Page.loadEventFired') loaded();
      if (event.method === 'Network.requestWillBeSent' && page) {
        const address = videoAddress(event.params.request.url, event.params.type);
        if (address) noteVideo(videos, { address, found: 'requested' }, page);
      }
    });
    while (queue.length && pages.length < maxPages) {
      const path = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      page = path;
      const arrived = new Promise(done => { loaded = done; });
      const navigated = await browser.send('Page.navigate', { url: origin + path }).catch(error => ({ errorText: error.message }));
      navigationFailed = navigated?.errorText || null;
      if (navigationFailed) { skipped.push({ address: origin + path, reason: `the page did not open: ${navigationFailed}` }); continue; }
      await within(arrived, 30000);
      await sleep(1200);
      await browser.send('Runtime.evaluate', { expression: `(${SCROLL})(${scrolls})`, awaitPromise: true });
      const { result, exceptionDetails } = await browser.send('Runtime.evaluate', {
        expression: `(${READ_PAGE})(${JSON.stringify({ origin, play })})`, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) { skipped.push({ address: origin + path, reason: exceptionDetails.exception?.description ?? exceptionDetails.text }); continue; }
      pages.push(path);
      for (const shown of result.value.shown) {
        const address = videoAddress(shown.address, shown.found === 'frame' ? '' : 'Media') ?? (shown.found === 'frame' ? null : shown.address);
        if (address) noteVideo(videos, { ...shown, address }, path);
      }
      // A link to a video file is a video the site offers; a link to any other file is not a page to visit.
      for (const link of result.value.links) {
        const linkedVideo = videoAddress(link);
        if (linkedVideo) { noteVideo(videos, { address: linkedVideo, found: 'linked' }, path); continue; }
        const linked = routePath(new URL(link).pathname);
        if (isPagePath(linked) && !seen.has(linked) && !queue.includes(linked)) queue.push(linked);
      }
    }
    page = null;
  } finally { browser.close(); }

  const remaining_paths = queue.filter(path => !seen.has(path));
  process.stdout.write(`${JSON.stringify({ origin, pages, videos: [...videos.values()], remaining_paths, skipped })}\n`);
}

// Run as a script (the Workshop row runs it); imported, it only lends its video rules (videoAddress, noteVideo).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof BrowserProblem ? error.message : error.stack}\n`);
    process.exit(1);
  });
}
