// Capture the page's unadorned frame grid. Encoding, sound and editing remain
// with media-composition; this producer only keeps the pixels it observed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVirtualClock } from '../../headless-browser/virtual-clock.mjs';

const FUNCTION_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
export function frameFunctionPath(value) {
  if (value == null || value === '') return null;
  if (!FUNCTION_PATH.test(value) || value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)))
    throw new TypeError('A frame function must be a dotted page function path.');
  return value;
}

export async function captureSourceFrames(browser, { url, out, width, height, scale = 1, fps, duration, readyFunction = null, seekFunction = null }) {
  readyFunction = frameFunctionPath(readyFunction); seekFunction = frameFunctionPath(seekFunction);
  if (![width, height, scale, fps, duration].every(value => Number.isFinite(value) && value > 0))
    throw new TypeError('Source capture needs positive dimensions, scale, frame rate and duration.');
  const count = Math.max(1, Math.ceil(duration * fps - 1e-10));
  if (!Number.isSafeInteger(count)) throw new TypeError('Source capture frame count must be a safe integer.');
  const frames = [], errors = [];
  const directory = join(out, 'frames');
  if (existsSync(directory) || existsSync(join(out, 'source-frames.json')))
    throw new Error('Source capture output already holds an epoch; use a fresh output directory.');
  mkdirSync(out, { recursive: true });
  mkdirSync(directory); // A retry uses a fresh output epoch, retaining failed frames.
  browser.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text ?? 'Page exception.');
  });
  const evaluate = async expression => {
    const answer = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
    if (errors.length) throw new Error(errors.join('\n'));
    return answer.result.value;
  };
  const call = (path, args) => evaluate(`(async () => {
    const parts = ${JSON.stringify(path)}.split('.'); let receiver = globalThis;
    for (const part of parts.slice(0, -1)) receiver = receiver[part];
    const fn = receiver[parts.at(-1)];
    if (typeof fn !== 'function') throw new Error('The declared page function is unavailable.');
    await fn.apply(receiver, ${JSON.stringify(args)}); return true;
  })()`);
  await browser.send('Page.enable'); await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  let loaded;
  const arrived = new Promise(resolve => { loaded = resolve; });
  browser.on(event => { if (event.method === 'Page.loadEventFired') loaded(); });
  const navigation = await browser.send('Page.navigate', { url });
  if (navigation.errorText) throw new Error(navigation.errorText);
  let timer;
  try {
    await Promise.race([arrived, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The source page did not finish loading.')), 20000); })]);
  } finally { clearTimeout(timer); }
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
  if (readyFunction) await call(readyFunction, []);
  const clock = createVirtualClock({ browser, fps, capture: async (_clockTime, index) => {
    if (index >= count) return;
    const t = index / fps;
    if (seekFunction) await call(seekFunction, [t]);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' });
    if (errors.length) throw new Error(errors.join('\n'));
    const file = join(directory, `${String(index).padStart(6, '0')}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ index, t, file });
  } });
  await clock.start();
  await clock.sleep((count - 1) / fps * 1000);
  if (frames.length !== count) throw new Error(`Source capture returned ${frames.length} frames; ${count} were required.`);
  const result = { schema: 'page-source-frames/v1', width: width * scale, height: height * scale, fps,
    requested_duration: duration, duration: count / fps, frame_count: count,
    source: join(directory, '%06d.png'), ready_function: readyFunction, seek_function: seekFunction,
    timing_scope: 'Page timers use the shared virtual clock; an explicit seek receives exact index/fps seconds before each frame.',
    frames };
  writeFileSync(join(out, 'source-frames.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
