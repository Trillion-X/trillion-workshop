/**
 * #188 Invert: a photographic negative (the iconic "invert colors" look) that flips every tone via the ffmpeg
 * `negate` filter, so bright becomes dark and dark becomes bright. DATA invert: true (bare boolean, no params).
 * Distinct from #173 solarize (inverts only ABOVE a cutoff), #175 posterize (N levels), #177 binarize (2-level).
 * The safest effect in the family: a constant filter string with ZERO DATA interpolation.
 *
 * Proof: DATA resolution (bare true enables; anything else, including {}, stays undefined), materialize
 * pass-through, AND a real OFFLINE render whose oracle is a tonal SWAP: a source with a BRIGHT bar on a DARK
 * background becomes a DARK bar on a BRIGHT background (the bar and background mean brightness cross over).
 * PLUS a byte-identical determinism proof. L155.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
let composeTimeline, materializeExportEdl;
let work, bar;
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function grayRow(file, ss, y) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const r = []; for (let x = 0; x < W; x++) r.push(raw[y * W + x]); return r;
}
const mean = (row, lo, hi) => { let s = 0, n = 0; for (let x = lo; x < hi; x++) { s += row[x]; n++; } return Math.round(s / n); };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'inv-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'inv-render-'));
  bar = join(work, 'bar.mp4'); // a BRIGHT bar (x=80..90) on a DARK background.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,80,90),240,20)':g='if(between(X,80,90),240,20)':b='if(between(X,80,90),240,20)'", '-pix_fmt', 'yuv420p', bar]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'b.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-10T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, deterministic) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => bar, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves invert: bare `true` enables; anything else stays undefined', () => {
  assert.equal(clipTx(view([setTx({ invert: true })])).invert, true);
  assert.equal(clipTx(view([setTx({ invert: false })])).invert, undefined);
  assert.equal(clipTx(view([setTx({ invert: { on: true } })])).invert, undefined);
  assert.equal(clipTx(view([setTx({})])).invert, undefined);
});

test('materialize emits invert (verbatim boolean)', () => {
  const comp = composeTimeline(view([setTx({ invert: true })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.equal(edl.spine.segments[0].invert, true);
});

test('OFFLINE RENDER: invert swaps the bright bar and dark background (L155)', () => {
  const y = Math.floor(H / 2);
  const base = grayRow(render({}, 'inv-off', true), 0.5, y);
  const inv = grayRow(render({ invert: true }, 'inv-on', true), 0.5, y);

  const baseBar = mean(base, 80, 91), baseBg = mean(base, 0, 60);
  const invBar = mean(inv, 80, 91), invBg = mean(inv, 0, 60);

  assert.ok(baseBar > 180 && baseBg < 60, `base is a bright bar on a dark bg: bar=${baseBar} bg=${baseBg}`);
  assert.ok(invBar < 60, `after invert the bar goes dark: ${invBar}`);
  assert.ok(invBg > 180, `after invert the background goes bright: ${invBg}`);
  // the tones crossed over: the bar was brighter than the bg, now it is darker.
  assert.ok(baseBar - baseBg > 120 && invBg - invBar > 120, `the tones swapped (crossover): base ${baseBar}/${baseBg} inv ${invBar}/${invBg}`);

  const a = render({ invert: true }, 'inv-det-a', true);
  const b = render({ invert: true }, 'inv-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic invert renders of the same EDL are byte-identical');
});
