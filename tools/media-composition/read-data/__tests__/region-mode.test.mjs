/**
 * #142 Region mode inside/outside. 'inside' (default) = censor: the filter hits the region (blur/pixelate/black
 * the rectangle). 'outside' = spotlight: the filter hits everything EXCEPT the region, so the region stays
 * original and pops (dim/desaturate the surroundings to emphasize a subject). One DATA field flips it and reuses
 * all position (#138/#139) / ease (#140) / fade (#141) unchanged (L069).
 *
 * Proof (L155): DATA resolution ('outside' kept, anything else default inside), materialize pass-through, AND a
 * real offline render where in 'outside' the region is BRIGHTER (original) than the dimmed surround, the mirror
 * image of an 'inside' blackout where the region is the DARK one; plus 'outside' composing with motion.
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
let work, src;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function meanGray(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0; for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'rm2-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'rm2-render-'));
  src = join(work, 'flat.mp4');
  // a flat mid-gray source (2s so the motion clip samples through t=1.9), so a dim on the outside is
  // unambiguous (region stays 128, surround drops).
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions, dur = 2) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: dur, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

const DIM = 'eq=brightness=-0.5';
const REGION = { x: 176, y: 96, w: 40, h: 48 };   // inside x=0.5,y=0.35,w=0.3,h=0.35 at 320x240
const OUTSIDE = { x: 20, y: 20, w: 40, h: 40 };

test('mode resolves outside; unknown / absent / inside default to plain inside', () => {
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: DIM, mode: 'outside' } })])).regionFilter.mode, 'outside');
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: DIM, mode: 'inside' } })])).regionFilter.mode, undefined);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: DIM, mode: 'bogus' } })])).regionFilter.mode, undefined);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: DIM } })])).regionFilter.mode, undefined);
});

test('materialize emits region_filter.mode on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: DIM, mode: 'outside' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.equal(edl.spine.segments[0].region_filter.mode, 'outside');
});

test('OFFLINE RENDER: outside spotlights the region (region bright, surround dimmed) (L155)', () => {
  const out = render({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: DIM, mode: 'outside' } }, 'rm2-spot');
  const region = meanGray(out, 0.5, REGION);
  const surround = meanGray(out, 0.5, OUTSIDE);
  assert.ok(region > surround + 40, `region (${region.toFixed(0)}) pops above dimmed surround (${surround.toFixed(0)})`);
  assert.ok(region > 100, `region kept its original mid-gray: ${region.toFixed(0)}`);
});

test('OFFLINE RENDER: inside is the mirror image (region dark, surround original) (L155)', () => {
  const out = render({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: DIM, mode: 'inside' } }, 'rm2-cens');
  const region = meanGray(out, 0.5, REGION);
  const surround = meanGray(out, 0.5, OUTSIDE);
  assert.ok(surround > region + 40, `inside: surround (${surround.toFixed(0)}) brighter than dimmed region (${region.toFixed(0)})`);
});

test('OFFLINE RENDER: outside composes with motion (the spotlight follows the moving region)', () => {
  // spotlight starts left, pans right; at t=0 the left region is bright, at end the right region is bright.
  const LEFT = { x: 24, y: 96, w: 40, h: 48 };
  const RIGHT = { x: 236, y: 96, w: 40, h: 48 };
  const out = render({ regionFilter: { x: 0.05, y: 0.4, w: 0.2, h: 0.2, filter: DIM, mode: 'outside',
    motion: { toX: 0.75, toY: 0.4, start: 0, duration: 1.5 } } }, 'rm2-move');
  assert.ok(meanGray(out, 0, LEFT) > meanGray(out, 0, RIGHT) + 30, 'spotlight on the left at t=0');
  assert.ok(meanGray(out, 1.9, RIGHT) > meanGray(out, 1.9, LEFT) + 30, 'spotlight moved to the right by the end');
});
