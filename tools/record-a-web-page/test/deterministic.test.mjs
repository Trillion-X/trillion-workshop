// test/record-a-web-page-deterministic.test.mjs
//
// The page recorder in deterministic mode (tools/record-a-web-page, tools/headless-browser/virtual-clock.mjs): the page's own clock
// moves one frame at a time, so every frame sits on its grid second, two runs of the same steps give the same timeline, the page's
// timers and Date.now() move by exactly the virtual time, and the demo is still drawn. Needs Chromium, python3 with Pillow and ffmpeg.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createVirtualClock, virtualClockSwitches } from '../../headless-browser/virtual-clock.mjs';
import { openBrowser } from '../../headless-browser/devtools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const menu = readFileSync(resolve(root, 'test/menu-page.html'));
const CAPTURE_FPS = 10;

async function withServer(body, run) {
  const server = createServer((_, answer) => answer.writeHead(200, { 'content-type': 'text/html' }).end(body));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try { return await run(`http://127.0.0.1:${server.address().port}/`); } finally { server.close(); }
}

async function record(url, out) {
  const args = ['do-work/record-a-web-demo.mjs', '--url', url, '--out', out, '--width', '640', '--height', '360', '--scale', '1', '--output-width', '640',
    '--fps', '15', '--gif-width', '320', '--deterministic', 'true', '--capture-fps', String(CAPTURE_FPS),
    '--steps', JSON.stringify([{ do: 'hover', target: { text: 'Features' }, caption: 'Open the menu' }, { do: 'wait', seconds: 0.5 }])];
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, BROWSER_EXECUTABLE: chromium.executablePath() } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((done) => child.on('close', done));
  assert.equal(status, 0, stderr);
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  const cover = createHash('sha256').update(readFileSync(join(out, 'step-pictures', 'cover.png'))).digest('hex');
  return { result, cover };
}

test('two deterministic recordings of the same steps give the same demo: same length, same frames, same step times, same picture', { timeout: 300000 }, async () => {
  const folders = [mkdtempSync(join(tmpdir(), 'det-a-')), mkdtempSync(join(tmpdir(), 'det-b-'))];
  try {
    const [a, b] = await withServer(menu, async (url) => [await record(url, folders[0]), await record(url, folders[1])]);
    assert.deepEqual(a.result, b.result, 'seconds, frames and each step\'s time are identical');
    assert.equal(a.cover, b.cover, 'the picture at the first click is byte-identical');
    assert.ok(a.result.frames > 10 && a.result.seconds > 1);
    assert.ok(existsSync(join(folders[0], 'demo.mp4')) && existsSync(join(folders[1], 'demo.mp4')), 'the demo is drawn');
  } finally { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); }
});

test('the page\'s timers and Date.now() move by exactly the virtual time, and a frame is taken for every grid second inside it', { timeout: 120000 }, async () => {
  const page = '<!doctype html><title>t</title><div id="out"></div><script>const start = Date.now(); const log = []; let ticks = 0;'
    + 'setInterval(() => { ticks += 1; document.getElementById("out").textContent = ticks + ":" + (Date.now() - start); }, 100);</script>';
  await withServer(page, async (url) => {
    const browser = await openBrowser(chromium.executablePath(), { width: 320, height: 180, switches: virtualClockSwitches });
    try {
      await browser.send('Page.enable');
      await browser.send('Runtime.enable');
      const loaded = new Promise((done) => browser.on((data) => { if (data.method === 'Page.loadEventFired') done(); }));
      await browser.send('Page.navigate', { url });
      await loaded;
      const taken = [];
      const clock = createVirtualClock({ browser, fps: 10, capture: async (t, index) => { taken.push([index, t]); } });
      await clock.start();
      const read = async () => (await browser.send('Runtime.evaluate', { expression: 'document.getElementById("out").textContent', returnByValue: true })).result.value;
      await clock.sleep(100);
      const [ticksBefore, elapsedBefore] = (await read()).split(':').map(Number);
      await new Promise((done) => setTimeout(done, 400));
      assert.equal(await read(), `${ticksBefore}:${elapsedBefore}`, 'paused: real time passing moves nothing');
      await clock.sleep(1000);
      assert.equal(clock.now(), 1.1);
      const [ticksAfter, elapsedAfter] = (await read()).split(':').map(Number);
      assert.equal(ticksAfter - ticksBefore, 10, 'ten timer ticks in one virtual second');
      assert.equal(elapsedAfter - elapsedBefore, 1000, 'Date.now moved by exactly 1000 ms');
      assert.deepEqual(taken, Array.from({ length: 12 }, (_, index) => [index, index / 10]), 'a frame at 0, 0.1 ... 1.1');
      await clock.sleep(50);
      assert.equal(clock.now(), 1.15);
      assert.equal(taken.length, 12, 'no grid second inside 50 ms: no frame');
      await clock.sleep(50);
      assert.equal(taken.at(-1)[1], 1.2);
    } finally { browser.close(); }
  });
});
