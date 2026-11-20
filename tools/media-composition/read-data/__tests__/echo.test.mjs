/**
 * #202 Echo / reverb (AUDIO). `echo` mixes delayed copies of the clip audio (a two-tap ffmpeg aecho) to add
 * spatial depth. `amount` 0..1 scales the wet decay (louder, longer tail); optional `delayMs` 20..1000
 * (default 250) sets the tap spacing. It is the ADD half the audio catalog lacked: the `de-reverb` preset
 * REMOVES room, nothing added it. A first-class one-click tunable DATA control distinct from the opaque
 * `audioFilters` power-user seam. Every value is numeric + clamped, so the aecho args carry no free text
 * (injection-safe). Blind DATA (L090).
 *
 * Proof: DATA resolution (nested + flat + bare-number + clamp + disabled-at-zero), materialize pass-through,
 * AND a real OFFLINE render on a source whose audio is a 0.1s tone then SILENCE: the echo lands delayed
 * copies into the originally-silent tail window, so the tail RMS energy jumps from ~0 (dry) to clearly
 * audible (wet), a domain-matched audio measurement, not a pixel check (L155: proof matches the claim's
 * domain).
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
// RMS of the mono audio over [ss, ss+dur] of a file (32-bit float PCM).
function rms(file, ss, dur) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-t', String(dur),
    '-i', file, '-map', '0:a', '-f', 'f32le', '-ac', '1', '-'], { maxBuffer: 1 << 24 });
  let s = 0, n = 0;
  for (let i = 0; i + 3 < raw.length; i += 4) { const v = raw.readFloatLE(i); s += v * v; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'echo-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'echo-render-'));
  src = join(work, 'burst.mp4'); // black video + audio = a 0.1s 440Hz tone then SILENCE (so a tail = echo)
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=64x64:d=2:r=12',
    '-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*440*t)*lt(t,0.1)':d=2:s=48000",
    '-ac', '1', '-shortest', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'b.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-11T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => src, { width: 64, height: 64, fps: 12, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves echo: nested + flat + bare-number; clamps; enabled only above zero amount', () => {
  assert.deepEqual(clipTx(view([setTx({ echo: { amount: 0.5, delayMs: 300 } })])).echo, { amount: 0.5, delayMs: 300 });
  assert.deepEqual(clipTx(view([setTx({ echo_amount: 0.4 })])).echo, { amount: 0.4 }); // flat
  assert.deepEqual(clipTx(view([setTx({ echo: 0.6 })])).echo, { amount: 0.6 }); // bare number = amount
  assert.deepEqual(clipTx(view([setTx({ echo: { amount: 9, delayMs: 9999 } })])).echo, { amount: 1, delayMs: 1000 }); // clamped
  assert.deepEqual(clipTx(view([setTx({ echo: { amount: 0.3, delayMs: 5 } })])).echo, { amount: 0.3, delayMs: 20 }); // delay floor
  assert.equal(clipTx(view([setTx({ echo: { amount: 0 } })])).echo, undefined); // zero = off
  assert.equal(clipTx(view([setTx({ echo: { delayMs: 300 } })])).echo, undefined); // no amount = off
  assert.equal(clipTx(view([setTx({})])).echo, undefined);
});

test('materialize emits echo (already snake, nested object verbatim)', () => {
  const comp = composeTimeline(view([setTx({ echo: { amount: 0.5, delayMs: 300 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].echo, { amount: 0.5, delayMs: 300 });
});

test('OFFLINE RENDER: echo fills the originally-silent tail with delayed copies (L155 audio domain)', () => {
  const TAIL_SS = 0.5, TAIL_DUR = 1.0; // well after the 0.1s tone: dry = silence, wet = echo copies

  const dry = render({}, 'echo-dry');
  const dryTail = rms(dry, TAIL_SS, TAIL_DUR);
  assert.ok(dryTail < 0.01, `dry tail is silent: ${dryTail.toFixed(5)}`);

  const wet = render({ echo: { amount: 0.8, delayMs: 250 } }, 'echo-wet');
  const wetTail = rms(wet, TAIL_SS, TAIL_DUR);
  // the echo taps put real energy where there was silence.
  assert.ok(wetTail > 0.02, `echo tail carries audible energy: ${wetTail.toFixed(5)}`);
  assert.ok(wetTail > dryTail * 5, `echo tail (${wetTail.toFixed(5)}) dwarfs the dry tail (${dryTail.toFixed(5)})`);
});
