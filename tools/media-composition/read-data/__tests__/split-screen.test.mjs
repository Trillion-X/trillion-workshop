/**
 * Split-screen / grid (you-vs-Federer side-by-side, before/after, a 4-up grid) as authorable DATA.
 *
 * The render ALREADY had the compositor (video-compose SEGMENT_BUILDERS['split'] to buildSplit reads
 * a spine segment `sources`/`layout`/`weights`/`duration`), but NOTHING authored it: no fold op, no
 * materialize output, no UI. This closes that gap with ZERO new render code (L069):
 *   1. `splitScreen` {with, layout, weights, labels} on ClipTransform (compose-timeline).
 *   2. extractTransform resolves it, so the EXISTING set-transform fold authors it (no new fold op).
 *   3. materialize emits a kind:'split' segment (splitRow) when a spine clip carries splitScreen,
 *      resolving each `with` ref through the same SourceResolver as the primary clip.
 *
 * Proof: DATA resolution, materialize shape, AND a REAL offline render whose pixels actually split
 * (left half red, right half blue). The pixels are the proof, not the receipt (L155).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
let composeTimeline, materializeExportEdl;
let work, red, blue, half, phase;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}

// Average RGB of a w x h region at (x,y) in the first frame: a dependency-free pixel probe.
function avgColor(file, x, y, w = 16, h = 16) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `crop=${w}:${h}:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0; const n = raw.length / 3;
  for (let i = 0; i < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'split-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'split-render-'));
  red = join(work, 'red.mp4');
  blue = join(work, 'blue.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);
  // An asymmetric source: white LEFT half, black RIGHT half. Flipping it swaps which side is bright,
  // so a per-cell flip is provable by pixels.
  half = join(work, 'half.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=white:s=160x180:r=24:d=2', '-f', 'lavfi', '-i', 'color=black:s=160x180:r=24:d=2',
    '-filter_complex', 'hstack=inputs=2', '-pix_fmt', 'yuv420p', half]);
  // A temporal source: BLACK for 0..1s then WHITE for 1..2s. Starting a cell at 1s shows white at
  // the split's frame 0, so a per-cell start_at (sync offset) is provable by pixels.
  phase = join(work, 'phase.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=320x180:r=24:d=1', '-f', 'lavfi', '-i', 'color=white:s=320x180:r=24:d=1',
    '-filter_complex', '[0][1]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', phase]);
});

// A single video clip (source_id 's1'); the extra split sources are refs the resolver maps.
const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'You', start: 0, end: 2, source_ref: { artifact_ref: 'me.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setSplit = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });

test('split_with + layout + labels resolve onto the clip transform', () => {
  const comp = composeTimeline(view([setSplit({ split_with: ['fed'], split_layout: 'h', split_labels: ['You', 'Federer'] })]));
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.deepEqual(clip.transform.splitScreen, { with: ['fed'], layout: 'h', labels: ['You', 'Federer'] });
});

test('a nested split_screen object resolves the same as flat params', () => {
  const comp = composeTimeline(view([setSplit({ split_screen: { with: ['a', 'b', 'c'], layout: 'grid', weights: [1, 1, 1] } })]));
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.deepEqual(clip.transform.splitScreen, { with: ['a', 'b', 'c'], layout: 'grid', weights: [1, 1, 1] });
});

test('an empty split_with clears any prior split-screen', () => {
  const comp = composeTimeline(view([
    setSplit({ split_with: ['fed'] }),
    setSplit({ split_with: [] }),
  ]));
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.equal(clip.transform.splitScreen, undefined);
});

test('materialize emits a kind:split segment with both cells resolved + labels', () => {
  const comp = composeTimeline(view([setSplit({ split_with: ['fed'], split_layout: 'h', split_labels: ['You', 'Federer'] })]));
  const resolve = (id) => ({ s1: 'me.mp4', fed: 'federer.mp4' }[id] ?? null);
  const { edl } = materializeExportEdl(comp, resolve, { width: 320, height: 180 });
  const seg = edl.spine.segments[0];
  assert.equal(seg.kind, 'split');
  assert.equal(seg.layout, 'h');
  assert.equal(seg.sources.length, 2);
  assert.equal(seg.sources[0].source, 'me.mp4');
  assert.equal(seg.sources[1].source, 'federer.mp4');
  assert.equal(seg.sources[0].label.text, 'You');
  assert.equal(seg.sources[1].label.text, 'Federer');
});

test('falls back to a normal clip row when fewer than 2 cells resolve', () => {
  const comp = composeTimeline(view([setSplit({ split_with: ['missing'] })]));
  const resolve = (id) => (id === 's1' ? 'me.mp4' : null); // 'missing' does not resolve
  const { edl, unresolvedSourceIds } = materializeExportEdl(comp, resolve, { width: 320, height: 180 });
  assert.equal(edl.spine.segments[0].kind, 'clip', 'a 1-cell split is not emitted; it degrades to a clip');
  assert.ok(unresolvedSourceIds.includes('missing'), 'the unresolved extra ref is reported');
});

test('OFFLINE RENDER puts red on the left and blue on the right for an h split (L155)', () => {
  const comp = composeTimeline(view([setSplit({ split_with: ['fed'], split_layout: 'h' })]));
  const resolve = (id) => ({ s1: red, fed: blue }[id] ?? null);
  const { edl } = materializeExportEdl(comp, resolve, { width: 320, height: 180, fps: 24 });
  const edlFile = join(work, 'split.json');
  const out = join(work, 'split.mp4');
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });

  const [lr, lg, lb] = avgColor(out, 72, 82); // left-center
  const [rr, rg, rb] = avgColor(out, 232, 82); // right-center
  assert.ok(lr > 150 && lb < 90, `left cell is red-dominant, got ${lr},${lg},${lb}`);
  assert.ok(rb > 150 && rr < 90, `right cell is blue-dominant, got ${rr},${rg},${rb}`);
  assert.ok(lr - lb > 90 && rb - rr > 90, 'the two halves are clearly different colors (a real split)');
});

test('materialize threads per-cell crop + flip onto the split sources', () => {
  const comp = composeTimeline(view([setSplit({
    split_with: ['fed'],
    split_cells: [{ crop: { w: 200, h: 200, x: 10, y: 20 } }, { flip: 'h' }],
  })]));
  const resolve = (id) => ({ s1: 'me.mp4', fed: 'federer.mp4' }[id] ?? null);
  const { edl } = materializeExportEdl(comp, resolve, { width: 320, height: 180 });
  const seg = edl.spine.segments[0];
  assert.equal(seg.kind, 'split');
  assert.deepEqual(seg.sources[0].crop, { w: 200, h: 200, x: 10, y: 20 });
  assert.equal(seg.sources[0].flip, undefined);
  assert.equal(seg.sources[1].crop, undefined);
  assert.equal(seg.sources[1].flip, 'h');
});

test('OFFLINE RENDER: flipping the compare cell mirrors it, so both faces align (L155)', () => {
  // Same asymmetric source (white left / black right) in both cells; only cell 1 is flipped.
  const comp = composeTimeline(view([setSplit({ split_with: ['other'], split_layout: 'h', split_cells: [{}, { flip: 'h' }] })]));
  const resolve = (id) => ({ s1: half, other: half }[id] ?? null);
  const { edl } = materializeExportEdl(comp, resolve, { width: 320, height: 180, fps: 24 });
  const edlFile = join(work, 'split-flip.json');
  const out = join(work, 'split-flip.mp4');
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });

  // Cell 0 occupies x 0..160 (unflipped): white on its LEFT, black on its RIGHT.
  const c0L = avgColor(out, 40, 82)[0];
  const c0R = avgColor(out, 120, 82)[0];
  // Cell 1 occupies x 160..320 (flipped h): black on its LEFT, white on its RIGHT.
  const c1L = avgColor(out, 200, 82)[0];
  const c1R = avgColor(out, 280, 82)[0];
  assert.ok(c0L > 150 && c0R < 100, `cell0 unflipped: bright left, dark right (got ${c0L}/${c0R})`);
  assert.ok(c1L < 100 && c1R > 150, `cell1 flipped: dark left, bright right (got ${c1L}/${c1R})`);
  assert.ok(c0L > c0R && c1R > c1L, 'the flipped cell is the horizontal mirror of the unflipped one');
});

test('materialize threads per-cell start_at onto the source in/out (sync offset)', () => {
  const comp = composeTimeline(view([setSplit({ split_with: ['fed'], split_cells: [{}, { start_at: 1.5 }] })]));
  const resolve = (id) => ({ s1: 'me.mp4', fed: 'federer.mp4' }[id] ?? null);
  const { edl } = materializeExportEdl(comp, resolve, { width: 320, height: 180 });
  const seg = edl.spine.segments[0];
  // The clip is trimmed 0..2 so the split duration is 2; cell 1 starts at 1.5 and runs 2s.
  assert.equal(seg.sources[1].in, 1.5);
  assert.equal(seg.sources[1].out, 3.5);
});

test('OFFLINE RENDER: a per-cell start_at shifts that cell in time so the phases align (L155)', () => {
  // phase source is black 0..1s then white 1..2s. Cell 0 starts at 0 (frame 0 = black); cell 1
  // starts at 1s (frame 0 = white). Both cells sourced from the same clip, only the offset differs.
  const comp = composeTimeline(view([setSplit({ split_with: ['later'], split_layout: 'h', split_cells: [{}, { start_at: 1 }] })]));
  const resolve = (id) => ({ s1: phase, later: phase }[id] ?? null);
  const { edl } = materializeExportEdl(comp, resolve, { width: 320, height: 180, fps: 24 });
  const edlFile = join(work, 'split-sync.json');
  const out = join(work, 'split-sync.mp4');
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });

  const c0 = avgColor(out, 72, 82)[0]; // cell 0 first frame: source at 0s = black
  const c1 = avgColor(out, 232, 82)[0]; // cell 1 first frame: source at 1s = white
  assert.ok(c0 < 100, `cell0 (offset 0) is dark at frame 0, got ${c0}`);
  assert.ok(c1 > 150, `cell1 (offset 1s) is bright at frame 0, got ${c1}`);
  assert.ok(c1 - c0 > 90, 'the offset genuinely shifted cell 1 forward in time');
});
