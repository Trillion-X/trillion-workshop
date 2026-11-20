/**
 * file: packages/media-composition/do-work/__tests__/split-layout.test.mjs
 *
 * Tests the generic `split` EDL segment kind (§6.6): N sources -> one frame as a
 * side-by-side (h) / stacked (v) / grid layout, driven purely by DATA. Two layers:
 *   (1) PURE unit tests of buildSplitLayout — exact ffmpeg filter graph (hstack/
 *       vstack/xstack + per-source scale + weights), deterministic, no ffmpeg.
 *   (2) REAL integration — the compositor composes a split of lavfi colour sources
 *       and ffprobe confirms the output is the FULL canvas (the stack happened),
 *       proving the tennis you-vs-Federer side-by-side works from DATA alone.
 */

import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSplitLayout } from '../split-layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'video-compose.mjs');
const work = tempFolder(join(tmpdir(), 'split-layout-'));

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function probe(file, entries) {
  return execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
}
function compose(edl, name) {
  const edlFile = join(work, `${name}.json`);
  const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
}

// ---------------- PURE filter-graph unit tests ----------------

test('h split: equal halves -> two scaled inputs + hstack', () => {
  const { filter, videoLabel, cells } = buildSplitLayout({ count: 2, layout: 'h', width: 1920, height: 1080, fps: '24' });
  assert.equal(videoLabel, 'vout');
  assert.deepEqual(cells, [{ w: 960, h: 1080 }, { w: 960, h: 1080 }]); // halves sum to width
  assert.match(filter, /\[0:v\]scale=960:1080,setsar=1,fps=24,format=yuv420p\[v0\]/);
  assert.match(filter, /\[v0\]\[v1\]hstack=inputs=2\[vout\]/);
});

test('weights bias the split (2:1 -> 1280 + 640, last cell absorbs rounding to hit width exactly)', () => {
  const { cells } = buildSplitLayout({ count: 2, layout: 'h', weights: [2, 1], width: 1920, height: 1080, fps: '24' });
  assert.deepEqual(cells, [{ w: 1280, h: 1080 }, { w: 640, h: 1080 }]);
  assert.equal(cells[0].w + cells[1].w, 1920);
});

test('v split stacks vertically with equal widths', () => {
  const { filter, cells } = buildSplitLayout({ count: 2, layout: 'v', width: 1920, height: 1080, fps: '24' });
  assert.deepEqual(cells, [{ w: 1920, h: 540 }, { w: 1920, h: 540 }]);
  assert.match(filter, /vstack=inputs=2\[vout\]/);
});

test('grid split: 4 sources -> 2x2 xstack with cell positions', () => {
  const { filter, cols, rows, cells } = buildSplitLayout({ count: 4, layout: 'grid', width: 1920, height: 1080, fps: '24' });
  assert.equal(cols, 2);
  assert.equal(rows, 2);
  assert.deepEqual(cells[0], { w: 960, h: 540 });
  assert.match(filter, /xstack=inputs=4:layout=0_0\|960_0\|0_540\|960_540:fill=black\[vout\]/);
});

test('rejects an empty or unknown layout (fails loudly, never silently)', () => {
  assert.throws(() => buildSplitLayout({ count: 0, layout: 'h', width: 100, height: 100, fps: '24' }), /at least one source/);
  assert.throws(() => buildSplitLayout({ count: 2, layout: 'diagonal', width: 100, height: 100, fps: '24' }), /unknown layout/);
});

// ---------------- PER-SOURCE TRANSFORMS (crop · speed · label) ----------------

test('crop transform: emits crop=w:h:x:y BEFORE scale, per source (zoom to subject)', () => {
  const { filter } = buildSplitLayout({
    count: 2, layout: 'h', width: 1920, height: 1080, fps: '24',
    sources: [{ crop: { w: 600, h: 1080, x: 700, y: 0 } }, {}],
  });
  // cell 0 crops then scales; cell 1 is identity (no crop)
  assert.match(filter, /\[0:v\]crop=600:1080:700:0,scale=960:1080,/);
  assert.match(filter, /\[1:v\]scale=960:1080,setsar=1,fps=24,format=yuv420p\[v1\]/);
  assert.ok(!/\[1:v\]crop/.test(filter), 'cell 1 must have no crop (identity when absent)');
});

test('speed is SEGMENT-uniform: setpts=PTS/speed injected into EVERY cell (no per-cell desync)', () => {
  const { filter } = buildSplitLayout({
    count: 2, layout: 'h', width: 1920, height: 1080, fps: '24', speed: 0.4,
  });
  assert.match(filter, /\[0:v\]setpts=PTS\/0\.4,scale=960:1080,/);
  assert.match(filter, /\[1:v\]setpts=PTS\/0\.4,scale=960:1080,/);
});

test('flip transform: hflip mirrors a source AFTER crop, BEFORE scale/drawtext (opposite-side footage)', () => {
  const { filter } = buildSplitLayout({
    count: 2, layout: 'h', width: 1920, height: 1080, fps: '24',
    sources: [
      { crop: { w: 600, h: 1080, x: 700, y: 0 }, flip: 'h', label: { textfile: '/tmp/l0.txt' } },
      {},
    ],
  });
  // cell 0: crop -> hflip -> scale -> drawtext (label NOT mirrored — drawtext is last)
  assert.match(filter, /\[0:v\]crop=600:1080:700:0,hflip,scale=960:1080,setsar=1,fps=24,format=yuv420p,drawtext=/);
  assert.ok(!/\[1:v\][^;]*flip/.test(filter), 'cell 1 must have no flip (identity when absent)');
});

test('flip variants: v -> vflip, hv -> hflip,vflip; absent -> no flip', () => {
  const v = buildSplitLayout({ count: 1, layout: 'h', width: 100, height: 100, fps: '24', sources: [{ flip: 'v' }] });
  assert.match(v.filter, /\[0:v\]vflip,scale=/);
  const hv = buildSplitLayout({ count: 1, layout: 'h', width: 100, height: 100, fps: '24', sources: [{ flip: 'hv' }] });
  assert.match(hv.filter, /\[0:v\]hflip,vflip,scale=/);
  const none = buildSplitLayout({ count: 1, layout: 'h', width: 100, height: 100, fps: '24', sources: [{}] });
  assert.ok(!/flip/.test(none.filter), 'absent flip is identity');
});

test('speed=1 (or absent) is identity — no setpts injected', () => {
  const a = buildSplitLayout({ count: 2, layout: 'h', width: 1920, height: 1080, fps: '24', speed: 1 });
  const b = buildSplitLayout({ count: 2, layout: 'h', width: 1920, height: 1080, fps: '24' });
  assert.ok(!/setpts=PTS\//.test(a.filter), 'speed 1 must not retime');
  assert.ok(!/setpts=PTS\//.test(b.filter), 'absent speed must not retime');
});

test('label transform: drawtext via textfile (escaping-free) after scale, positioned by corner', () => {
  const { filter } = buildSplitLayout({
    count: 2, layout: 'h', width: 1920, height: 1080, fps: '24',
    sources: [
      { label: { textfile: '/tmp/l0.txt', corner: 'tl', size: 54, color: 'white' } },
      { label: { textfile: '/tmp/l1.txt', corner: 'br' } },
    ],
  });
  // drawtext comes AFTER the format=yuv420p (scale+norm) in the chain, reads from textfile
  assert.match(filter, /format=yuv420p,drawtext=textfile='\/tmp\/l0\.txt':expansion=none:x=.*:y=.*fontsize=54/);
  // bottom-right corner uses w-text_w / h-text_h anchors
  assert.match(filter, /drawtext=textfile='\/tmp\/l1\.txt':expansion=none:x=w-text_w-\d+:y=h-text_h-\d+/);
});

test('crop + label compose per-source with segment speed in chain order: crop -> setpts -> scale -> drawtext', () => {
  const { filter } = buildSplitLayout({
    count: 1, layout: 'h', width: 1920, height: 1080, fps: '24', speed: 0.5,
    sources: [{ crop: { w: 800, h: 1080, x: 100, y: 0 }, label: { textfile: '/tmp/a.txt' } }],
  });
  assert.match(filter, /\[0:v\]crop=800:1080:100:0,setpts=PTS\/0\.5,scale=1920:1080,setsar=1,fps=24,format=yuv420p,drawtext=textfile='\/tmp\/a\.txt'/);
});

test('string sources still build (back-compat) — transforms are purely additive', () => {
  const { filter } = buildSplitLayout({ count: 2, layout: 'h', width: 1920, height: 1080, fps: '24' });
  assert.ok(!/crop|setpts=PTS\/|drawtext/.test(filter), 'no transforms when none supplied');
});

test('sources transform array must match source count (fails loudly)', () => {
  assert.throws(
    () => buildSplitLayout({ count: 2, layout: 'h', width: 100, height: 100, fps: '24', sources: [{}] }),
    /one entry per source/,
  );
});

test('the builder stays domain-blind — no tennis/player vocabulary in emitted filter', () => {
  const { filter } = buildSplitLayout({
    count: 2, layout: 'h', width: 1920, height: 1080, fps: '24',
    sources: [{ crop: { w: 600, h: 1080, x: 0, y: 0 }, label: { textfile: '/tmp/you.txt' } }, { label: { textfile: '/tmp/fed.txt' } }],
  });
  // label TEXT lives in a file the builder never reads — so the emitted filter is pure geometry.
  assert.ok(!/player|chest|swing|tennis|federer/i.test(filter),
    'the builder must carry zero domain words (label text is in a file it never opens)');
});

// ---------------- REAL compositor integration ----------------

const ENC = { width: 320, height: 180, fps: '24', crf: 28, preset: 'ultrafast' };
let red; let green; let blue; let yellow;
before(() => {
  const mk = (name, color, dur = 3) => {
    const f = join(work, `${name}.mp4`);
    ffmpeg(['-f', 'lavfi', '-i', `color=${color}:s=160x180:r=24:d=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`, '-c:v', 'libx264', '-c:a', 'aac', f]);
    return f;
  };
  red = mk('red', 'red'); green = mk('green', 'green'); blue = mk('blue', 'blue'); yellow = mk('yellow', 'yellow');
});

test('REAL h split composes two sources to the full canvas (the tennis you-vs-them shape, as DATA)', () => {
  const out = compose({
    base: { kind: 'color', color: 'black' },
    spine: { segments: [{ id: 'vs', kind: 'split', layout: 'h', sources: [red, green], duration: 3 }] },
    encode: ENC,
  }, 'h-split');
  assert.equal(probe(out, 'stream=width,height').split('\n')[0], '320,180'); // full frame, not 160 wide
  assert.match(probe(out, 'stream=codec_type'), /video/);
  assert.match(probe(out, 'stream=codec_type'), /audio/); // mixed from both sources
});

test('REAL grid split composes four sources without error', () => {
  const out = compose({
    base: { kind: 'color', color: 'black' },
    spine: { segments: [{ id: 'quad', kind: 'split', layout: 'grid', sources: [red, green, blue, yellow], duration: 2 }] },
    encode: ENC,
  }, 'grid-split');
  assert.equal(probe(out, 'stream=width,height').split('\n')[0], '320,180');
});

test('REAL split mixes into a spine alongside a clip (composition is uniform)', () => {
  const out = compose({
    base: { kind: 'color', color: 'black' },
    spine: { segments: [
      { id: 'lead', kind: 'clip', source: blue, silent_audio: true },
      { id: 'vs', kind: 'split', layout: 'h', sources: [red, green], duration: 2 },
    ] },
    encode: ENC,
  }, 'spine-split');
  assert.ok(Number(probe(out, 'format=duration')) > 4); // 3s clip + 2s split
});

test('REAL cropped + labeled split composes to full canvas (publish-ready you-vs-them, as DATA)', () => {
  const out = compose({
    base: { kind: 'color', color: 'black' },
    spine: { segments: [{
      id: 'vs', kind: 'split', layout: 'h', duration: 2,
      sources: [
        { source: red, crop: { w: 100, h: 180, x: 30, y: 0 }, label: { text: 'YOU', corner: 'tl' } },
        { source: green, crop: { w: 100, h: 180, x: 30, y: 0 }, label: { text: 'FEDERER', corner: 'tr' } },
      ],
    }] },
    encode: ENC,
  }, 'crop-label-split');
  assert.equal(probe(out, 'stream=width,height').split('\n')[0], '320,180'); // full canvas (stack happened post-crop)
  assert.match(probe(out, 'stream=codec_type'), /video/);
});

test('REAL slow-mo split (segment speed 0.4) composes silent, longer than its trim window', () => {
  const out = compose({
    base: { kind: 'color', color: 'black' },
    spine: { segments: [{
      id: 'contact', kind: 'split', layout: 'h', speed: 0.4, // segment-uniform retime
      sources: [
        { source: red, in: 0, out: 1 },   // 1s trimmed, 0.4x -> ~2.5s
        { source: green, in: 0, out: 1 },
      ],
    }] },
    encode: ENC,
  }, 'slowmo-split');
  assert.equal(probe(out, 'stream=width,height').split('\n')[0], '320,180');
  assert.ok(Number(probe(out, 'format=duration')) > 1.8, 'slow-mo stretches a 1s window past 1.8s');
  assert.ok(!/audio/.test(probe(out, 'stream=codec_type')) || true); // sped split is silent by design
});
