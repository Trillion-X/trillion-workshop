/**
 * #211 Color-match: make a SOURCE clip's colours match a REFERENCE clip's, so footage from different cameras /
 * lighting looks like one coherent video when auto-assembled. `do-work/color-match.mjs` measures both clips'
 * per-channel mean/std and emits the Reinhard linear transfer as an injection-safe `lutrgb` GRADE string, which
 * rides the EXISTING grade seam (zero new render code, L069). Producer pattern (like detect-silence).
 *
 * Proof (L155): a blue-cast SOURCE gradient and a warm-cast REFERENCE gradient. computeColorTransfer(src->ref);
 * apply the emitted grade to the source and RENDER. Oracle = the DEFINING behavior: each of the source's
 * channel means moves substantially TOWARD the reference's mean (so the blue/warm split reverses), plus a pure
 * unit on the transfer math and byte-determinism.
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
import { channelStats, computeColorTransfer, colorMatchFilter } from '../../do-work/color-match.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 320, H = 240, FPS = 24;
let composeTimeline, materializeExportEdl, work, srcClip, refClip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const digestHex = (file) => Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function meanRGB(file) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0; const n = raw.length / 3;
  for (let i = 0; i < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'cm-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'cm-render-'));
  // Same neutral gradient content (gives per-channel spatial variance = non-zero std), two DIFFERENT casts:
  // source is cool/blue, reference is warm/orange. Matching src->ref must reverse the cast.
  srcClip = join(work, 'src.mp4');
  refClip = join(work, 'ref.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=1:r=${FPS}`,
    '-vf', "geq=lum='X/W*255':cb=128:cr=128,colorbalance=bs=.35:bm=.2:rs=-.25:rm=-.15", '-pix_fmt', 'yuv420p', srcClip]);
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=1:r=${FPS}`,
    '-vf', "geq=lum='X/W*255':cb=128:cr=128,colorbalance=rs=.35:rm=.2:bs=-.25:bm=-.15", '-pix_fmt', 'yuv420p', refClip]);
});

const view = (grade) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: grade ? [{ action: 'set-transform', label: 'grade', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-12T00:00:00.000Z', parameters: { grade } }] : [],
  markers: [],
});
const render = (name, grade, clip) => {
  const comp = composeTimeline(view(grade));
  const { edl } = materializeExportEdl(comp, () => clip, { width: W, height: H, fps: FPS, deterministic: true });
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
};

test('unreadable recordings and seeks beyond the last frame reject instead of producing a black reference', () => {
  assert.throws(() => channelStats(join(work, 'missing.mp4')), /Could not measure/);
  assert.throws(() => channelStats(srcClip, { ss: 100 }), /Could not measure/);
});

test('PURE unit: computeColorTransfer maps src stats onto ref stats + colorMatchFilter is injection-safe lutrgb', () => {
  const t = computeColorTransfer({ r: { mean: 100, std: 20 }, g: { mean: 100, std: 20 }, b: { mean: 100, std: 20 } },
    { r: { mean: 150, std: 40 }, g: { mean: 100, std: 20 }, b: { mean: 60, std: 10 } });
  assert.equal(t.r.gain, 2); assert.equal(t.r.off, -50);   // 150 = 100*2 - 50
  assert.equal(t.g.gain, 1); assert.equal(t.g.off, 0);
  assert.equal(t.b.gain, 0.5); assert.equal(t.b.off, 10);  // 60 = 100*0.5 + 10
  const grade = colorMatchFilter(t);
  assert.equal(grade, "lutrgb=r='clip(val*2-50,0,255)':g='clip(val*1+0,0,255)':b='clip(val*0.5+10,0,255)'");
  assert.ok(!/[a-z]\(/.test(grade.replace(/clip|val/g, '')), 'no free-form tokens beyond clip/val (injection-safe)');
});

test('OFFLINE RENDER: matching a blue source to a warm reference reverses its cast toward the reference (L155)', () => {
  const srcStats = channelStats(srcClip);
  const refStats = channelStats(refClip);
  // sanity: the two clips really are oppositely cast.
  assert.ok(srcStats.b.mean > srcStats.r.mean + 8, `source is blue-cast (R ${srcStats.r.mean} < B ${srcStats.b.mean})`);
  assert.ok(refStats.r.mean > refStats.b.mean + 8, `reference is warm-cast (R ${refStats.r.mean} > B ${refStats.b.mean})`);

  const transfer = computeColorTransfer(srcStats, refStats);
  const matched = render('matched', colorMatchFilter(transfer), srcClip);
  const before = meanRGB(srcClip), after = meanRGB(matched);

  // defining behavior: each channel mean moves substantially toward the reference mean.
  for (const c of ['r', 'g', 'b']) {
    const target = refStats[c].mean;
    const distBefore = Math.abs(before[c] - target), distAfter = Math.abs(after[c] - target);
    assert.ok(distAfter < distBefore * 0.5 + 4, `${c} mean moved toward ref (|${before[c].toFixed(0)}-${target}|=${distBefore.toFixed(0)} -> |${after[c].toFixed(0)}-${target}|=${distAfter.toFixed(0)})`);
  }
  // the cast reversed: matched source is now warm (R > B), like the reference.
  assert.ok(after.r > after.b, `matched source is now warm like the reference (R ${after.r.toFixed(0)} > B ${after.b.toFixed(0)})`);

  const matched2 = render('matched2', colorMatchFilter(transfer), srcClip);
  assert.equal(digestHex(matched), digestHex(matched2), 'two color-matched renders are byte-identical');
});
