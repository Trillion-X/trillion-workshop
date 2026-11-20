/**
 * #170 Reproducible / deterministic render mode. `edl.encode.deterministic` (a boolean DATA field,
 * default OFF so production keeps full multi-threading) pins the ffmpeg filtergraph (-filter_threads 1)
 * and the x264 encoder (-threads 1) to a single thread, so the SAME EDL renders BIT-IDENTICAL every run.
 * This is a real editor capability (reproducible exports, render-cache keys, CI render diffing) that
 * CapCut / Premiere / DaVinci do not reliably offer, AND it is the structural fix (L063) for the geq
 * slice-thread nondeterminism that otherwise flakes frame/pixel checks in the sibling effect suites.
 *
 * Proof: DATA carry-through (encode.deterministic reaches edl.encode), and a REAL offline render of a
 * geq-heavy TEMPORAL effect (film damage: scratches/dust that jump per frame) rendered TWICE with the
 * flag ON producing BYTE-IDENTICAL mp4s (sha256), while the effect still visibly renders (not an empty
 * frame) so the identity is of real content, not of nothing (L155).
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
let work, gray;
const W = 320, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// count bright columns on the center scanline (a rendered film-damage scratch = a bright vertical line).
function brightCols(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray,crop=320:1:0:120', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  let n = 0;
  for (let x = 0; x < raw.length; x++) if (raw[x] > 160) n++;
  return n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'det-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'det-render-'));
  gray = join(work, 'gray.mp4'); // flat mid-gray so effect content is unambiguous
  ffmpeg(['-f', 'lavfi', '-i', `color=0x555555:s=320x240:d=2:r=${FPS}`, '-pix_fmt', 'yuv420p', gray]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-09T00:00:00.000Z', parameters: params });

// render the SAME geq-heavy temporal EDL; `deterministic` toggles the reproducible mode.
const render = (name, deterministic) => {
  const comp = composeTimeline(view([setTx({ film_damage: { scratches: 8, dust: 0, strength: 1 } })]));
  const { edl } = materializeExportEdl(comp, () => gray, { width: 320, height: 240, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('encode.deterministic is DATA that carries through materialize to edl.encode', () => {
  const comp = composeTimeline(view([setTx({ film_damage: true })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', { width: 320, height: 240, fps: FPS, deterministic: true });
  assert.equal(edl.encode.deterministic, true);
  assert.equal(edl.encode.width, 320);
  // default OFF: absent flag stays absent, never coerced true.
  const plain = materializeExportEdl(composeTimeline(view([setTx({ film_damage: true })])), () => 'r.mp4', { width: 320, height: 240, fps: FPS });
  assert.notEqual(plain.edl.encode.deterministic, true);
});

test('OFFLINE RENDER: deterministic mode renders the SAME geq-heavy EDL BYTE-IDENTICAL across two runs (L063 flake kill)', () => {
  const a = render('det-a', true);
  const b = render('det-b', true);
  // real content: the film-damage scratches actually rendered (not an empty/plain frame).
  const scratchFrames = [0, 1, 2, 3, 4, 5, 6, 7].filter((n) => brightCols(a, n / FPS) > 0).length;
  assert.ok(scratchFrames >= 3, `deterministic render still shows real scratch content: frames=${scratchFrames}`);
  // reproducibility: identical bytes.
  assert.equal(hashFile(a), hashFile(b), 'two deterministic renders of the same EDL are byte-identical');
});
