import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/measure-first-frame/do-work/measure-first-frame.mjs
//
// Purpose: Measure what a person sees when a video served by byte ranges starts: the first presented frame, the time from Play to a
// moving frame, the time to a frame after a seek, and the bytes the browser asked for, in a real Chromium, fresh and returning. The page
// is one blank page with one `<video src=URL>`, so it is the same decoder and the same Range requests any player makes; nothing about
// a share page, a poster or a player's own markup is read.
//
// Non-Negotiable Invariants:
// - The URL is never printed or returned: it may hold a share's key. The answer names the host only.
// - Only the page's own timers and `requestVideoFrameCallback` are read; the tool sends no request but the browser's own for the URL.
// - A visit that never presents a frame in `timeout_ms` is answered with null for that number, never zero.
//
// Key Concepts:
// - `fresh`: a new browser context (nothing cached). `returning`: a second visit in the same context (the browser's own cache and the
//   server's warm paths). Each sample is one fresh and one returning visit.
// - The bar (read-data/measure-first-frame.json) is what the Oct 2026 files path achieved; the answer judges each median against it.
//
// Run: echo '{"url":"https://.../video"}' | node do-work/measure-first-frame.mjs     (answers {"result": {...}} on stdout)

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { deliveredBytes, shapeResult } from './shape-the-result.mjs';

const DATA = JSON.parse(readFileSync(new URL('../read-data/measure-first-frame.json', import.meta.url), 'utf8'));
const QUIET = JSON.parse(readFileSync(new URL('../../headless-browser/quiet-switches.json', import.meta.url), 'utf8')).switches;

export class MeasureProblem extends Error {}

/** The browser to start: the one named, else BROWSER_EXECUTABLE, else Playwright's own Chromium if installed, else a place DATA lists. */
export function findBrowser(named) {
  const wanted = [named, process.env.BROWSER_EXECUTABLE, ...DATA.browser_paths, chromium.executablePath()].filter(Boolean);
  const found = wanted.find(path => existsSync(path));
  if (!found) throw new MeasureProblem('no browser found: give browser_path, set BROWSER_EXECUTABLE, or install Playwright Chromium (npx playwright install chromium)');
  return found;
}

function inRange(name, value, [least, most]) {
  if (!Number.isFinite(value) || value < least || value > most) throw new MeasureProblem(`${name} must be a number from ${least} to ${most}`);
  return value;
}

/** The input with its defaults, checked against the DATA bounds. */
export function checkInput(input) {
  const url = typeof input?.url === 'string' ? input.url : '';
  let parsed;
  try { parsed = new URL(url); } catch { throw new MeasureProblem('url must be an address'); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) {
    throw new MeasureProblem('url must be https (plain http only for this computer)');
  }
  const { defaults, bounds } = DATA;
  return {
    url,
    host: parsed.host,
    samples: inRange('samples', input.samples ?? defaults.samples, bounds.samples),
    seekFraction: inRange('seek_fraction', input.seek_fraction ?? defaults.seek_fraction, bounds.seek_fraction),
    timeoutMs: inRange('timeout_ms', input.timeout_ms ?? defaults.timeout_ms, bounds.timeout_ms),
    browserPath: input.browser_path,
  };
}

/** Runs in the page: one video, first frame, Play to a moving frame, a seek. Answers seconds from the video's mount. */
async function inPage({ url, seekFraction, timeoutMs, seekTolerance, movingAfter }) {
  const waitFor = (test, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what)), timeoutMs);
    test(value => { clearTimeout(timer); resolve(value); });
  });
  const seconds = (from, to) => (to === null || from === null ? null : (to - from) / 1000);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  const frames = [];
  let onFrame = () => {};
  const watch = () => video.requestVideoFrameCallback((now, meta) => { frames.push({ now, mediaTime: meta.mediaTime }); onFrame(); watch(); });
  watch();
  const mountedAt = performance.now();
  video.src = url;
  document.body.append(video);
  const answer = { first_frame_seconds: null, play_to_moving_seconds: null, seek_seconds: null, duration_seconds: null, error: null };
  try {
    await waitFor(done => { onFrame = () => frames.length && done(); if (frames.length) done(); }, 'no frame was presented');
    answer.first_frame_seconds = seconds(mountedAt, frames[0].now);
    answer.duration_seconds = video.duration;
    const playAt = performance.now();
    const movingFrom = frames.length;
    await video.play();
    const moving = await waitFor(done => {
      const check = () => { const hit = frames.slice(movingFrom - 1).find(frame => frame.mediaTime > movingAfter); if (hit) done(hit); };
      onFrame = check; check();
    }, 'no moving frame after Play');
    answer.play_to_moving_seconds = seconds(playAt, moving.now);
    const target = video.duration * seekFraction;
    if (Number.isFinite(target)) {
      const seekAt = performance.now();
      const before = frames.length;
      video.currentTime = target;
      const landed = await waitFor(done => {
        const check = () => { const hit = frames.slice(before).find(frame => frame.mediaTime >= target - seekTolerance); if (hit) done(hit); };
        onFrame = check; check();
      }, 'no frame after the seek');
      answer.seek_seconds = seconds(seekAt, landed.now);
    }
  } catch (error) {
    answer.error = String(error.message ?? error);
  }
  video.pause();
  return answer;
}

/** One visit: a new page in `context`, the video, and the responses the browser got for the URL. */
async function visit(context, options) {
  const page = await context.newPage();
  const responses = [];
  page.on('response', response => {
    if (response.url() !== options.url) return;
    const headers = response.headers();
    responses.push({ status: response.status(), contentRange: headers['content-range'] ?? null, contentLength: headers['content-length'] ?? null });
  });
  try {
    // The blank page is served by the browser itself at the video's own origin (it never reaches the server): a page at about:blank is
    // refused a request to a loopback address, and the same origin needs no CORS from a server that does not send it.
    const blank = new URL('/measure-first-frame.html', options.url).href;
    await page.route(blank, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>measure</title>' }));
    await page.goto(blank);
    const measured = await page.evaluate(inPage, {
      url: options.url, seekFraction: options.seekFraction, timeoutMs: options.timeoutMs,
      seekTolerance: DATA.defaults.seek_tolerance_seconds, movingAfter: DATA.defaults.moving_after_seconds,
    });
    return { ...measured, bytes: deliveredBytes(responses), responses: responses.length, statuses: responses.map(response => response.status), content_ranges: responses.map(response => response.contentRange) };
  } finally {
    await page.close();
  }
}

/** The tool: `launch(executable, args)` is the browser start (a test may stand one in). */
export async function measureFirstFrame(input, { launch } = {}) {
  const options = checkInput(input ?? {});
  const executable = findBrowser(options.browserPath);
  const start = launch ?? ((path, args) => chromium.launch({ executablePath: path, args }));
  const browser = await start(executable, [...QUIET, '--autoplay-policy=no-user-gesture-required']);
  try {
    const samples = [];
    for (let at = 0; at < options.samples; at += 1) {
      const context = await browser.newContext();
      try {
        const fresh = await visit(context, options);
        const returning = await visit(context, options);
        samples.push({ fresh, returning });
      } finally {
        await context.close();
      }
    }
    return shapeResult({ host: options.host, samples, bar: DATA.bar, browser: executable.split('/').pop() });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    process.stdout.write(JSON.stringify({ result: await measureFirstFrame(input) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof MeasureProblem ? error.message : 'the measurement did not run' }) + '\n');
    process.exitCode = 1;
  }
}
