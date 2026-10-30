// tools/record-a-web-page/do-work/record-a-web-demo.mjs
//
// Records a web page as a demo: opens the address in a headless Chromium, plays a list of steps on it the way a
// person would (the pointer travels to each target, clicks, types, scrolls), keeps every frame the browser paints
// with its time, a sharp picture after each step, and one timed list of what happened. Then it hands that list to
// draw-the-demo.py, which draws a large pointer, click ripples and zoom over the real frames, encodes the video
// and the GIF, and marks each step's picture with a ring and an arrow.
//
// Invariants:
//   - Nothing here names a site, product or brand. The page, the steps, the sizes and the colours are input.
//   - The browser is driven over the DevTools protocol (tools/headless-browser/devtools.mjs): no browser library.
//   - Every step either finds its target or the run stops with one message naming the step and what to change.
//   - One timed list (events.json) is the only timeline: frames, pointer path, clicks and stills are all read from it.
//
// Usage:
//   node do-work/record-a-web-demo.mjs --url <address> --steps '<json list>' --out <folder>
//     [--width 1280] [--height 720] [--scale 2] [--output-width 1920] [--fps 60] [--cursor-size 72]
//     [--zoom 1.6] [--look '{"accent":"#ff1d1d","ink":"#191919","paper":"#fbf8f2","font_file":"..."}']
//     [--cookies '[{"name","value","url" | "domain","path","secure","httpOnly"}]']
//     [--deterministic true] [--capture-fps 30]   the page's clock moves one frame at a time, so the same steps give the same frames
//     [--gif-width 800] [--gif-fps 12] [--max-idle 0.9] [--browser chromium, or BROWSER_EXECUTABLE] [--python python3]
//
// A step is one object: { "do": <action>, "target": { "selector" | "text" }, "text", "key", "by", "seconds",
// "url", "caption", "pause", "timeout", "optional" }. Actions are the keys of ACTIONS below; each says what it needs.
// Prints one JSON line on success: { seconds, frames, width, height, fps, steps[] }. On failure prints the reason
// on standard error and exits 1.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserProblem, openBrowser } from '../../headless-browser/devtools.mjs';
import { createVirtualClock, virtualClockSwitches } from '../../headless-browser/virtual-clock.mjs';
import capture from './capture-settings.json' with { type: 'json' };
import { captureSourceFrames } from './capture-source-frames.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// A problem with the steps; shown as it is, like a browser that would not start (the tool row places that part beside us).
class StepProblem extends BrowserProblem {}

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new StepProblem(`Unexpected argument ${name}.`);
    args[name.slice(2)] = argv[index + 1] ?? '';
  }
  return args;
}

const number = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));
const json = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
const now = () => Date.now() / 1000;
const smoothstep = value => { const v = Math.max(0, Math.min(1, value)); return v * v * (3 - 2 * v); };

// Finds a step's target in the page and answers its box in page pixels (CSS), or null. A target by text prefers
// the smallest visible element that can be pressed whose own words are the text, then any element that contains it.
const FIND_TARGET = `(target) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0; };
  let found = null;
  if (target.selector) found = [...document.querySelectorAll(target.selector)].find(visible) ?? null;
  else if (target.text) {
    const want = target.text.trim().toLowerCase();
    const words = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').toLowerCase();
    // Candidates come from the text itself: each text node that holds the words, and a few of its ancestors,
    // plus anything labelled with them. Reading every element's words would be slow on a large page.
    const found_in = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.toLowerCase().includes(want.split(' ')[0])) continue;
      for (let el = node.parentElement, up = 0; el && el !== document.body && up < 5; el = el.parentElement, up += 1) found_in.add(el);
    }
    for (const el of document.querySelectorAll('[aria-label],input,textarea')) found_in.add(el);
    const all = [...found_in].filter(visible);
    const pressable = (el) => el.matches('a,button,summary,label,input,select,textarea,[role=button],[role=link],[role=menuitem],[role=tab],[tabindex]');
    const exact = all.filter((el) => words(el) === want);
    const containing = all.filter((el) => words(el).includes(want));
    // What the person can already see comes first, then the smallest match.
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? 0 : 1; };
    const smallest = (list) => list.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return inView(a) - inView(b) || ra.width * ra.height - rb.width * rb.height; })[0] ?? null;
    const seen = (list) => list.filter((el) => inView(el) === 0);
    found = smallest(seen(exact).filter(pressable)) ?? smallest(seen(exact)) ?? smallest(seen(containing).filter(pressable)) ?? smallest(seen(containing))
      ?? smallest(exact.filter(pressable)) ?? smallest(exact) ?? smallest(containing.filter(pressable)) ?? smallest(containing);
  }
  if (!found) return null;
  const r = found.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) { found.scrollIntoView({ block: 'center', inline: 'center' }); }
  const b = found.getBoundingClientRect();
  return { x: b.left, y: b.top, width: b.width, height: b.height, moved: b.top !== r.top || b.left !== r.left };
}`;

// ---------------------------------------------------------------------------------------------------------------
// The recording session: one timed list of everything that happened.

function describeTarget(target) {
  if (!target) return 'its target';
  return target.selector ? `the element "${target.selector}"` : `the words "${target.text}"`;
}

async function recordSession(browser, request) {
  const { url, steps, width, height, scale, cookies } = request;
  const events = { started_at: null, pointer: [], clicks: [], steps: [], frames: [] };
  // The clock every wait and every timestamp reads: the real one, or (deterministic) the page's own clock moved one frame at a time.
  let clock = { now, sleep, input: work => work() };
  let virtual = null;
  const framesFolder = join(request.out, 'frames');
  mkdirSync(framesFolder, { recursive: true });

  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

  let loaded = null;
  browser.on(data => {
    if (data.method === 'Page.loadEventFired' && loaded) loaded();
    if (data.method === 'Page.screencastFrame') {
      const { data: base64, metadata, sessionId } = data.params;
      const file = join(framesFolder, `${String(events.frames.length).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(base64, 'base64'));
      events.frames.push({ t: metadata.timestamp ?? clock.now(), file });
      browser.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    }
  });
  const evaluate = async (expression, arg) => {
    const { result, exceptionDetails } = await browser.send('Runtime.evaluate', {
      expression: arg === undefined ? expression : `(${expression})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new StepProblem(`The page answered with an error: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  const go = async address => {
    const arrived = new Promise(done => { loaded = done; });
    await browser.send('Page.navigate', { url: address });
    await Promise.race([arrived, sleep(20000)]);
    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
    await sleep(700);
  };

  // A signed-in page: the cookies are set before the first address opens, so the first frame is already signed in.
  if (cookies.length) await browser.send('Network.setCookies', { cookies });
  await go(url);
  if (request.deterministic) {
    // The page's time is paused and moved one frame at a time (tools/headless-browser/virtual-clock.mjs): every frame is taken
    // at its own grid second, so the same steps give the same frames whatever load the machine is under.
    virtual = createVirtualClock({
      browser, fps: request.captureFps,
      capture: async (t, index) => {
        const { data } = await browser.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
        const file = join(framesFolder, `${String(index).padStart(6, '0')}.jpg`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        events.frames.push({ t, file });
      },
    });
    await virtual.start();
    clock = { now: virtual.now, sleep: virtual.sleep, input: virtual.input };
  } else {
    await browser.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: width * scale, maxHeight: height * scale });
  }
  await clock.sleep(400);
  events.started_at = events.frames[0]?.t ?? clock.now();

  let pointer = { x: width * 0.5, y: height * 0.78 };
  events.pointer.push({ t: clock.now(), ...pointer });
  // Every input goes through the clock: a paused page takes an input in only once some of its time passes.
  const send = (method, params) => clock.input(() => browser.send(method, params));
  const mouse = (type, extra = {}) => send('Input.dispatchMouseEvent', { type, x: pointer.x, y: pointer.y, ...extra });

  const travel = async to => {
    const from = { ...pointer };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const seconds = Math.min(1.1, Math.max(0.45, 0.35 + distance / 1400));
    // A gentle arc: the path bows a little to one side, the way a hand moves, and settles on the target.
    const bow = { x: -(to.y - from.y) * 0.08, y: (to.x - from.x) * 0.08 };
    const start = clock.now();
    for (;;) {
      const progress = Math.min(1, (clock.now() - start) / seconds);
      const eased = smoothstep(progress);
      const lift = Math.sin(Math.PI * eased);
      pointer = { x: from.x + (to.x - from.x) * eased + bow.x * lift, y: from.y + (to.y - from.y) * eased + bow.y * lift };
      await mouse('mouseMoved');
      events.pointer.push({ t: clock.now(), ...pointer });
      if (progress >= 1) break;
      await clock.sleep(12);
    }
  };

  const locate = async (step, index) => {
    const deadline = clock.now() + number(step.timeout, 6);
    for (;;) {
      const box = await evaluate(FIND_TARGET, step.target);
      if (box) {
        if (box.moved) { await clock.sleep(500); return evaluate(FIND_TARGET, step.target); }
        return box;
      }
      if (clock.now() > deadline) throw new StepProblem(`Step ${index + 1} (${step.do}) could not find ${describeTarget(step.target)} on the page. Check the selector or the visible words, or add a wait step before it.`);
      await clock.sleep(250);
    }
  };

  const present = async step => {
    const deadline = clock.now() + number(step.timeout, 2);
    for (;;) {
      if (await evaluate(FIND_TARGET, step.target)) return true;
      if (clock.now() > deadline) return false;
      await clock.sleep(250);
    }
  };

  const clickHere = async () => {
    await clock.sleep(120);
    events.clicks.push({ t: clock.now(), ...pointer });
    await mouse('mousePressed', { button: 'left', clickCount: 1 });
    await clock.sleep(70);
    await mouse('mouseReleased', { button: 'left', clickCount: 1 });
  };

  // Named keys the DOM defines a fixed code for; any single character is typed as text.
  const NAMED_KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
  const pressKey = async key => {
    const code = NAMED_KEYS[key];
    if (code === undefined) {
      if ([...key].length !== 1) throw new StepProblem(`The key "${key}" is not one character or one of ${Object.keys(NAMED_KEYS).join(', ')}.`);
      await send('Input.insertText', { text: key });
      return;
    }
    const base = { key: key === 'Space' ? ' ' : key, code: key === 'Space' ? 'Space' : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const moveToTarget = async (step, index) => {
    const box = await locate(step, index);
    await travel({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    return box;
  };

  // What each action does. A new action is one entry here; each returns the target box it acted on, if any.
  const ACTIONS = {
    hover: async (step, index) => moveToTarget(step, index),
    click: async (step, index) => { const box = await moveToTarget(step, index); await clickHere(); return box; },
    type: async (step, index) => {
      const box = step.target ? await moveToTarget(step, index) : null;
      if (box) await clickHere();
      if (typeof step.text !== 'string') throw new StepProblem(`Step ${index + 1} (type) needs "text", the words to type.`);
      for (const character of step.text) { await send('Input.insertText', { text: character }); await clock.sleep(number(step.per_character, 0.055) * 1000); }
      return box;
    },
    press: async (step, index) => {
      if (typeof step.key !== 'string' || !step.key) throw new StepProblem(`Step ${index + 1} (press) needs "key", like "Enter".`);
      await pressKey(step.key);
      return null;
    },
    scroll: async step => {
      const total = number(step.by, height * 0.8);
      const seconds = number(step.seconds, Math.min(1.6, Math.max(0.6, Math.abs(total) / 900)));
      const start = clock.now();
      let done = 0;
      for (;;) {
        const progress = Math.min(1, (clock.now() - start) / seconds);
        const want = total * smoothstep(progress);
        const delta = want - done;
        if (Math.abs(delta) >= 1) { await mouse('mouseWheel', { deltaX: 0, deltaY: delta }); done = want; }
        if (progress >= 1) break;
        await clock.sleep(16);
      }
      return null;
    },
    wait: async step => { await clock.sleep(number(step.seconds, 1) * 1000); return null; },
    go: async (step, index) => {
      if (typeof step.url !== 'string' || !step.url) throw new StepProblem(`Step ${index + 1} (go) needs "url", the address to open.`);
      const address = new URL(step.url, url).href;
      await (virtual ? virtual.live(() => go(address)) : go(address));
      return null;
    },
  };

  for (const [index, step] of steps.entries()) {
    const act = ACTIONS[step?.do];
    if (!act) throw new StepProblem(`Step ${index + 1} says "do": "${step?.do}", which is not one of ${Object.keys(ACTIONS).join(', ')}.`);
    if (['hover', 'click'].includes(step.do) && !step.target) throw new StepProblem(`Step ${index + 1} (${step.do}) needs "target": { "selector" } or { "text" }.`);
    // An optional step (a cookie banner, a notice that may or may not show) is left out when its target is not on
    // the page within its timeout (default 2 s): no pointer move, no picture, nothing drawn.
    if (step.optional === true && step.target && !(await present(step))) continue;
    const began = clock.now();
    const box = await act(step, index);
    const acted = clock.now();
    await clock.sleep(number(step.pause, 0.8) * 1000);
    // The step's picture is taken after the page settles; its target is measured again at that moment.
    const settled = box && step.target ? await evaluate(FIND_TARGET, step.target) : null;
    // Only a step with a target or a caption gets a picture: there is something in it to point at.
    let still = null;
    if (step.target || typeof step.caption === 'string') {
      still = join(request.out, 'step-pictures', `step-${String(index + 1).padStart(2, '0')}-source.png`);
      mkdirSync(dirname(still), { recursive: true });
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(still, Buffer.from(data, 'base64'));
    }
    events.steps.push({
      index: index + 1, do: step.do, caption: typeof step.caption === 'string' ? step.caption : null,
      began, acted, ended: clock.now(), target: settled ?? box ?? null, still,
    });
  }
  await clock.sleep(number(request.hold, 1.2) * 1000);
  // A final frame at the very end, so the video holds the last state for the hold time.
  const { data: last } = await browser.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  const lastFile = join(framesFolder, 'last.jpg');
  writeFileSync(lastFile, Buffer.from(last, 'base64'));
  events.frames.push({ t: clock.now(), file: lastFile });
  if (!virtual) await browser.send('Page.stopScreencast');
  events.ended_at = clock.now();
  return events;
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.url) throw new StepProblem('Give --url, the address of the page to record.');
  if (!args.out) throw new StepProblem('Give --out, the folder to leave the video in.');
  const request = {
    url: new URL(args.url).href,
    steps: json(args.steps, []),
    width: number(args.width, 1280),
    height: number(args.height, 720),
    scale: number(args.scale, 2),
    hold: number(args.hold, 1.2),
    out: resolve(args.out),
    cookies: json(args.cookies, []),
    deterministic: args.deterministic === 'true',
    captureFps: number(args['capture-fps'], capture.fps),
  };
  if (!Array.isArray(request.cookies)) throw new StepProblem('--cookies must be a list of cookies, each with name, value and url or domain.');
  if (!Array.isArray(request.steps)) throw new StepProblem('--steps must be a list of steps.');
  mkdirSync(request.out, { recursive: true });
  const sourceOnly = args['capture-only'] === 'true';
  const browser = await openBrowser(args.browser || process.env.BROWSER_EXECUTABLE || 'chromium', { ...request, switches: request.deterministic || sourceOnly ? virtualClockSwitches : [] });
  if (sourceOnly) {
    try {
      const result = await captureSourceFrames(browser, { ...request, fps: request.captureFps,
        duration: number(args.duration, NaN), readyFunction: args['ready-function'], seekFunction: args['seek-function'] });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally { browser.close(); }
    return;
  }
  let events;
  try { events = await recordSession(browser, request); } finally { browser.close(); }
  const recording = {
    ...events,
    view: { width: request.width, height: request.height, scale: request.scale },
    render: {
      output_width: number(args['output-width'], 1920),
      fps: number(args.fps, 60),
      cursor_size: number(args['cursor-size'], 72),
      zoom: number(args.zoom, 1.6),
      gif_width: number(args['gif-width'], 800),
      gif_fps: number(args['gif-fps'], 12),
      max_idle: number(args['max-idle'], 0.9),
      look: json(args.look, {}),
    },
  };
  const eventsFile = join(request.out, 'events.json');
  writeFileSync(eventsFile, JSON.stringify(recording));
  const drawn = spawnSync(args.python || 'python3', [join(here, 'draw-the-demo.py'), eventsFile, request.out], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (drawn.status !== 0) throw new StepProblem(`Drawing the demo failed (exit ${drawn.status}).`);
  rmSync(join(request.out, 'frames'), { recursive: true, force: true });
  process.stdout.write(drawn.stdout);
}

main().catch(error => {
  process.stderr.write(`${error instanceof BrowserProblem ? error.message : error.stack}\n`);
  process.exit(1);
});
