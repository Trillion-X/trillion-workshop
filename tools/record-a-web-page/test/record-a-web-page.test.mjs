// The web page recorder (tools/record-a-web-page, tool:record-a-web-demo in tool-rows.json): every flag the row passes
// is one the script reads, and the script, run from its folder as the container runs it from /opt/record-a-web-page, on a small page served from this folder. Checks the
// video's size and length, that a click ripple in the accent colour is drawn where the pointer clicked, that every
// output the row names exists, and that a step whose target is missing stops the run with a message naming it.
// Needs Chromium (Playwright's, from devDependencies), python3 with Pillow, and ffmpeg, as the container has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchChromium } from '../../../test-helpers/chromium.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [tool] = JSON.parse(readFileSync(resolve(root, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const page = readFileSync(resolve(root, 'test/menu-page.html'));

async function withPage(run) {
  const server = createServer((_, answer) => answer.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { return await run(`http://127.0.0.1:${server.address().port}/`); } finally { server.close(); }
}

// The script with each input field as its --flag (an object or list as JSON), and the output folder here. Run without
// blocking, so the page server in this process keeps answering the browser.
async function runTool(input, out) {
  const flags = Object.entries(input).flatMap(([name, value]) => [`--${name.replaceAll('_', '-')}`, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const args = ['do-work/record-a-web-demo.mjs', ...flags, '--out', out];
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, BROWSER_EXECUTABLE: chromium.executablePath() } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise(done => child.on('close', done));
  return { status, stdout, stderr };
}

// One pixel of one frame of the video, as [r, g, b].
function pixelAt(video, seconds, x, y) {
  const bytes = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(seconds), '-i', video, '-frames:v', '1', '-vf', `crop=2:2:${2 * Math.round(x / 2)}:${2 * Math.round(y / 2)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...bytes.subarray(0, 3)];
}

test('every flag the row passes is one the script reads', () => {
  const script = readFileSync(resolve(root, 'do-work/record-a-web-demo.mjs'), 'utf8');
  for (const flag of tool.invoke.argv.filter(part => typeof part === 'string' && part.startsWith('--'))) {
    assert.ok(script.includes(`args['${flag.slice(2)}']`) || script.includes(`args.${flag.slice(2)}`), `the script reads ${flag}`);
  }
});

test('a recording has the asked size, a ripple where the pointer clicked, and every output the row names', { timeout: 300000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'record-a-web-page-test-'));
  try {
    const { ran, button } = await withPage(async url => {
      const browser = await launchChromium();
      const tab = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await tab.goto(url);
      const box = await tab.locator('#go').boundingBox();
      await browser.close();
      return {
        button: box,
        ran: await runTool({
          url,
          steps: [
            { do: 'hover', target: { text: 'Features' }, caption: 'Open the menu' },
            { do: 'type', target: { selector: '#name' }, text: 'Ada' },
            { do: 'click', target: { text: 'Say hello' }, caption: 'Say hello' },
            { do: 'scroll', by: 600 },
          ],
          output_width: 960, fps: 30, zoom: 1, look: { accent: '#ff1d1d' },
        }, out),
      };
    });
    assert.equal(ran.status, 0, ran.stderr);
    const result = JSON.parse(ran.stdout.trim().split('\n').at(-1));
    assert.equal(result.width, 960);
    assert.equal(result.height, 540);
    assert.equal(result.fps, 30);
    const video = join(out, 'demo.mp4');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', video], { encoding: 'utf8' })).streams[0];
    assert.equal(probe.width, 960);
    assert.ok(Math.abs(Number(probe.nb_read_frames) - result.frames) <= 1, `${probe.nb_read_frames} frames against ${result.frames}`);
    assert.deepEqual(result.steps.map(step => step.found), [true, true, true, false]);

    // With zoom 1 the page fills the frame, so the click lands at the button's place in video pixels, and the
    // ripple's ring, growing outward, crosses the line to the click's left shortly after the click.
    const k = 960 / 1280;
    const cx = (button.x + button.width / 2) * k;
    const cy = (button.y + button.height / 2) * k;
    const click = result.steps[2].at_seconds;
    const along = Array.from({ length: 24 }, (_, i) => 8 + i * 4);
    const rednessAt = seconds => along.map(left => pixelAt(video, seconds, cx - left, cy)).map(([r, g, b]) => r - (g + b) / 2);
    const before = rednessAt(0.2);
    const after = rednessAt(click + 0.2);
    assert.ok(Math.max(...after) > Math.max(...before) + 25, `a red ripple beside the click (before ${before.join(', ')}; after ${after.join(', ')})`);

    for (const output of tool.invoke.outputs) {
      const path = (output.path ?? output.folder).replace('/opt/record-a-web-page/out', out);
      assert.ok(existsSync(path), `${output.name} at ${path}`);
    }
    assert.deepEqual(readdirSync(join(out, 'step-pictures')).sort(), ['cover.png', 'step-01.png', 'step-02.png', 'step-03.png']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a step whose target is not on the page stops the run with a message naming the step', { timeout: 120000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'record-a-web-page-test-'));
  try {
    const ran = await withPage(url => runTool({ url, steps: [{ do: 'wait', seconds: 0.2 }, { do: 'click', target: { text: 'Nowhere on this page' } }], fps: 15 }, out));
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /Step 2 \(click\) could not find the words "Nowhere on this page"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
