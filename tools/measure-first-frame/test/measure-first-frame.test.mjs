// A loopback server that serves a generated video by Range, a real Chromium measuring it, and the result shaping on made-up numbers.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkInput, findBrowser, MeasureProblem, measureFirstFrame } from '../do-work/measure-first-frame.mjs';
import { againstBar, deliveredBytes, median, shapeResult } from '../do-work/shape-the-result.mjs';

const DATA = JSON.parse(readFileSync(new URL('../read-data/measure-first-frame.json', import.meta.url), 'utf8'));

/** Serve `file` with Range support; `seen` collects each request's range header. */
function rangeServer(file, seen = []) {
  const size = statSync(file).size;
  const bytes = readFileSync(file);
  const server = createServer((request, response) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    seen.push(request.headers.range ?? null);
    const base = { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
    if (!range) { response.writeHead(200, { ...base, 'content-length': size }); return response.end(request.method === 'HEAD' ? undefined : bytes); }
    const start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start > end || start >= size) { response.writeHead(416, { 'content-range': `bytes */${size}` }); return response.end(); }
    response.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    response.end(bytes.subarray(start, end + 1));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v.webm`, seen })));
}

test('the median, the delivered bytes and the bar', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([null, NaN]), null);
  assert.equal(deliveredBytes([{ contentLength: '10' }, { contentLength: null }, { contentLength: '5' }]), 15);
  const visit = (first, bytes) => ({ first_frame_seconds: first, play_to_moving_seconds: 0.3, seek_seconds: 0.1, bytes, responses: 2 });
  const result = shapeResult({
    host: 'h', browser: 'b', bar: DATA.bar,
    samples: [{ fresh: visit(6, 20e6), returning: visit(1, 0) }, { fresh: visit(5, 10e6), returning: visit(2, 0) }, { fresh: visit(4, 12e6), returning: visit(3, 0) }],
  });
  assert.equal(result.medians.fresh.first_frame_seconds, 5);
  assert.equal(result.against_bar.fresh.first_frame_seconds.within, true);
  assert.equal(result.against_bar.fresh.bytes.within, true);
  assert.equal(result.against_bar.returning.first_frame_seconds.within, true);
  assert.equal(result.against_bar.returning.first_frame_seconds.at_most, 2.9);
  const slow = againstBar({ fresh: { first_frame_seconds: 7, bytes: null, play_to_moving_seconds: 1, seek_seconds: 0.5 }, returning: { first_frame_seconds: 3, play_to_moving_seconds: null, seek_seconds: 0.1 } }, DATA.bar);
  assert.equal(slow.fresh.first_frame_seconds.within, false);
  assert.equal(slow.fresh.bytes.within, null, 'a number that was not measured is not judged');
  assert.equal(slow.returning.first_frame_seconds.within, false);
});

test('the input is checked and a share URL is never answered', () => {
  assert.throws(() => checkInput({ url: 'nope' }), MeasureProblem);
  assert.throws(() => checkInput({ url: 'http://example.com/v' }), /https/);
  assert.throws(() => checkInput({ url: 'https://example.com/v', samples: 0 }), /samples/);
  assert.throws(() => checkInput({ url: 'https://example.com/v', seek_fraction: 1 }), /seek_fraction/);
  const checked = checkInput({ url: 'https://example.com/share/label/shr_secretkey' });
  assert.equal(checked.host, 'example.com');
  assert.equal(checked.samples, DATA.defaults.samples);
  const shaped = shapeResult({ host: checked.host, samples: [], bar: DATA.bar, browser: 'b' });
  assert.ok(!JSON.stringify(shaped).includes('shr_secretkey'));
});

test('the browser named is the browser used', () => {
  assert.equal(findBrowser(process.execPath), process.execPath);
});

const browser = (() => { try { return findBrowser(); } catch { return null; } })();
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('a real Chromium measures a video served by Range, fresh and returning', { skip: !browser ? 'no Chromium on this computer' : !haveFfmpeg ? 'ffmpeg is not installed to generate the video' : false, timeout: 120000 }, async () => {
  const folder = tempFolder(join(tmpdir(), 'measure-first-frame-'));
  const file = join(folder, 'v.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=4', '-c:v', 'libvpx', '-b:v', '200k', '-g', '25', '-y', file]);
  assert.ok(existsSync(file));
  const { server, url, seen } = await rangeServer(file);
  try {
    const result = await measureFirstFrame({ url, samples: 2, timeout_ms: 20000 });
    assert.equal(result.samples.length, 2);
    for (const sample of result.samples) for (const kind of ['fresh', 'returning']) {
      const visit = sample[kind];
      assert.equal(visit.error, null, `${kind}: ${visit.error}`);
      assert.ok(visit.first_frame_seconds > 0 && visit.first_frame_seconds < 20, `first frame ${visit.first_frame_seconds}`);
      assert.ok(visit.play_to_moving_seconds > 0, 'a moving frame after Play');
      assert.ok(visit.seek_seconds > 0, 'a frame after the seek');
    }
    assert.ok(result.samples[0].fresh.responses >= 1 && result.samples[0].fresh.bytes > 0, 'the bytes the browser asked for are counted');
    assert.ok(seen.some(range => range !== null), 'the browser asked by Range');
    assert.ok(result.medians.fresh.first_frame_seconds > 0);
    assert.equal(typeof result.against_bar.fresh.first_frame_seconds.within, 'boolean');
    assert.ok(!JSON.stringify(result).includes('v.webm'), 'the path is not answered');
    console.log(JSON.stringify({ medians: result.medians, content_ranges: result.samples[0].fresh.content_ranges, browser: result.browser }));
  } finally {
    server.close();
  }
});
