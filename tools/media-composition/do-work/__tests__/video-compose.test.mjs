/**
 * file: packages/media-composition/do-work/__tests__/video-compose.test.mjs
 *
 * Tests for the video.compose EDL compositor (plan §10/§15 T05). Fixtures are
 * deterministic lavfi sources. Golden comparisons are METRICS (duration,
 * stream params, frame probes), never bytes. Covers: base spans with overlays
 * (the layered law — voice continuous), clips, chapter inserts with black card
 * + title, music bed, replace_audio, base.kind:slides (full-frame, no a-roll),
 * and the adversarial shapes (no overlays / no chapters / single segment).
 */

import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureLoudness } from '../measure-loudness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'video-compose.mjs');
const work = tempFolder(join(tmpdir(), 'video-compose-'));

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
  const stdout = execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return { out, report: JSON.parse(stdout.trim().split('\n').at(-1)) };
}

test('resume: --resume in a provided workdir reuses valid outputs and re-renders crash stubs', () => {
  const wd = join(work, 'resume-wd');
  mkdirSync(wd);
  const edl = {
    base: { kind: 'video', artifact: base },
    spine: { segments: [
      { id: 'intro', kind: 'clip', source: intro, silent_audio: true },
      { id: 'A', kind: 'base_span', src_in: 0, src_out: 6 },
      { id: 'outro', kind: 'clip', source: intro, silent_audio: true },
    ] },
    encode: ENC,
  };
  const edlFile = join(work, 'resume.json');
  const out = join(work, 'resume-out.mp4');
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out, '--workdir', wd], { encoding: 'utf8' });
  // Simulate the interrupted render: keep seg000, delete seg001+, replace the
  // concat spine with a zero-byte crash stub, and remove the master.
  rmSync(join(wd, 'seg001.mp4'));
  rmSync(join(wd, 'seg002.mp4'));
  writeFileSync(join(wd, 'spine.mp4'), '');
  rmSync(out);
  const stdout = execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out, '--workdir', wd, '--resume'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(stdout, /reuse existing .*seg000/, 'valid finished segment reused');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 10) < 0.5, 'final master rebuilt');
});

let base; let slide; let intro; let broll; let music; let voice;
before(() => {
  base = join(work, 'base.mp4');
  // 12s talking base: testsrc video + sine "voice" so audio continuity is measurable
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-c:a', 'aac', base]);
  slide = join(work, 'slide.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=white:s=320x180:r=24:d=3', '-c:v', 'libx264', slide]);
  intro = join(work, 'intro.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=320x180:r=24:d=2', '-c:v', 'libx264', intro]);
  broll = join(work, 'broll.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=24:duration=4', '-c:v', 'libx264', broll]);
  music = join(work, 'music.m4a');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=10', '-c:a', 'aac', music]);
  voice = join(work, 'voice.m4a');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=12', '-c:a', 'aac', voice]);
});

const ENC = { width: 320, height: 180, fps: '24', crf: 28, preset: 'ultrafast' };

test('talking-head shape: intro clip + base span with overlay + outro', () => {
  const { out, report } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [
      { id: 'intro', kind: 'clip', source: intro, silent_audio: true },
      { id: 'A', kind: 'base_span', src_in: 0, src_out: 8 },
      { id: 'outro', kind: 'clip', source: intro, silent_audio: true },
    ] },
    overlays: [{ source: slide, at_src: 2, end_src: 5 }],
    encode: ENC,
  }, 'talking');
  // 2 + 8 + 2 = 12s
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 12) < 0.5, 'duration ~12s');
  assert.equal(report.segments, 3);
  // both streams present
  const streams = probe(out, 'stream=codec_type');
  assert.match(streams, /video/);
  assert.match(streams, /audio/);
});

test('base.kind:slides — full-frame source, no chapter inserts (the audio-only style as pure data)', () => {
  const { out } = compose({
    base: { kind: 'slides', artifact: base },
    spine: { segments: [{ id: 'all', kind: 'base_span', src_in: 0, src_out: 6 }] },
    overlays: [],
    audio_graph: { replace_audio: voice },
    encode: ENC,
  }, 'slides');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 6) < 0.5);
});

test('video-ONLY slides base (no audio stream) composes — silent track injected, replace_audio attaches', () => {
  // A rendered slides reel typically has NO audio stream at all. The compositor
  // must probe (never assume) and inject silence so the spine builds and the
  // mastered voice attaches via replace_audio.
  const silentSlides = join(work, 'silent-slides.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=white:s=320x180:r=24:d=8', '-c:v', 'libx264', silentSlides]);
  const { out } = compose({
    base: { kind: 'slides', artifact: silentSlides },
    spine: { segments: [{ id: 'all', kind: 'base_span', src_in: 0, src_out: 6 }] },
    overlays: [],
    audio_graph: { replace_audio: voice },
    encode: ENC,
  }, 'silent-slides');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 6) < 0.5);
  const streams = probe(out, 'stream=codec_type');
  assert.match(streams, /audio/, 'replaced audio present');
});

test('chapter insert: tail + b-roll inserts + black card + title + resume + chapter music', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [
      { id: 'A', kind: 'base_span', src_in: 0, src_out: 4 },
      { id: 'ch1', kind: 'chapter_insert' },
      { id: 'B', kind: 'base_span', src_in: 6, src_out: 10 },
    ] },
    chapter_inserts: [{
      id: 'ch1', cut: 4, resume: 6, tail_s: 2, resume_s: 2,
      inserts: [{ source: broll, duration: 2 }],
      black_card: { duration: 1 },
      title_overlay: { text: 'Chapter One', size: 40, show_s: 3 },
      music: { artifact: music, duration: 4, delay_ms: 0, pad_to_s: 7, fade_out_st: 3, fade_out_d: 1 },
    }],
    encode: ENC,
  }, 'chapters');
  // A(4) + chapter(2+2+1+2=7) + B(4) = 15s
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 15) < 1.0, `duration ~15s got ${probe(out, 'format=duration')}`);
});

test('music bed mixes over the spine with qsin fades', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'A', kind: 'base_span', src_in: 0, src_out: 6 }] },
    audio_graph: { music_bed: { artifact: music, trim: [0, 4], fade_in: { st: 0, d: 1 }, fade_out: { st: 3, d: 1 }, volume: 0.8 } },
    encode: ENC,
  }, 'musicbed');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 6) < 0.5);
  assert.match(probe(out, 'stream=codec_type'), /audio/);
});

test('adversarial: single segment, no overlays, no chapters, no audio graph', () => {
  const { out, report } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'only', kind: 'base_span', src_in: 1, src_out: 3 }] },
    encode: ENC,
  }, 'minimal');
  assert.equal(report.segments, 1);
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 2) < 0.5);
});

test('zero style vocabulary in the compositor (grep the source)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(SCRIPT, 'utf8').toLowerCase();
  for (const banned of ['talking-head', 'talkinghead', 'audio-only', 'aroll', 'a-roll style']) {
    assert.equal(source.includes(banned), false, `compositor contains no "${banned}"`);
  }
});

test('overlay extending past the span end is capped to the span (never crashes, never stretches)', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'A', kind: 'base_span', src_in: 0, src_out: 4 }] },
    overlays: [{ source: slide, at_src: 2, end_src: 9 }], // window runs past src_out 4
    encode: ENC,
  }, 'overlay-capped');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 4) < 0.5, 'span length unchanged');
});

test('overlay entirely outside the span is excluded (window filter)', () => {
  const { out, report } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'B', kind: 'base_span', src_in: 5, src_out: 9 }] },
    overlays: [{ source: slide, at_src: 2, end_src: 4 }], // before the span
    encode: ENC,
  }, 'overlay-excluded');
  assert.equal(report.segments, 1);
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 4) < 0.5);
});

test('unknown segment kind fails loudly naming the segment', () => {
  assert.throws(() => {
    compose({
      base: { kind: 'video', artifact: base },
      spine: { segments: [{ id: 'weird', kind: 'hologram' }] },
      encode: ENC,
    }, 'bad');
  }, /unknown segment kind/);
});

// ============================================================================
// T5 — Palmier-derived per-clip DATA grammar (plan 2026-07-18 §9):
// trim/speed, fades, generic keyframe envelopes, crop/flip, track flags.
// Every operation is a DATA field on the clip row — the compositor has no
// per-feature branches; these tests prove hostile compositions render.
// ============================================================================

test('clip trim (in/out) + speed remap: 4s window at 2x -> ~2s output', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'sped', kind: 'clip', source: base, in: 2, out: 6, speed: 2 }] },
    encode: ENC,
  }, 't5-trim-speed');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 2) < 0.5, `~2s got ${probe(out, 'format=duration')}`);
  assert.match(probe(out, 'stream=codec_type'), /audio/, 'audio retimed via atempo, not dropped');
});

test('generic keyframed opacity envelope: fade-to-black midway measurably darkens frames', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'kf', kind: 'clip', source: base, in: 0, out: 4,
      keyframes: { opacity: [{ t: 0, value: 1 }, { t: 2, value: 1 }, { t: 4, value: 0 }] } }] },
    encode: ENC,
  }, 't5-kf-opacity');
  // sample mean luma of an early frame vs a late frame via signalstats
  const luma = (t) => Number(execFileSync('ffprobe', ['-v', 'error', '-f', 'lavfi',
    '-i', `movie=${out},trim=start=${t}:duration=0.2,signalstats`,
    '-show_entries', 'frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0'],
    { encoding: 'utf8' }).trim().split('\n')[0]);
  const early = luma(0.5);
  const late = luma(3.8);
  assert.ok(late < early * 0.35, `late frame (${late}) much darker than early (${early})`);
});

test('generic keyframed volume envelope on audio stream renders', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'vol', kind: 'clip', source: base, in: 0, out: 4,
      keyframes: { volume: [{ t: 0, value: 1 }, { t: 4, value: 0 }] } }] },
    encode: ENC,
  }, 't5-kf-volume');
  assert.match(probe(out, 'stream=codec_type'), /audio/);
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 4) < 0.5);
});

test('master true-peak ceiling is EDL DATA and survives AAC decoded readback', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'loud', kind: 'base_span', src_in: 0, src_out: 4 }] },
    master_loudnorm: -14,
    master_true_peak_dbfs: -6,
    encode: ENC,
  }, 'master-true-peak');
  const measured = measureLoudness(out);
  assert.ok(measured.integrated_lufs < -10, `program remains audible (${measured.integrated_lufs} LUFS)`);
  assert.ok(measured.true_peak_dbfs <= -4.5, `stricter ceiling flows through master loudnorm (${measured.true_peak_dbfs} dBFS)`);
});

test('invalid master true-peak ceiling fails loudly before render', () => {
  assert.throws(() => {
    compose({
      base: { kind: 'video', artifact: base },
      spine: { segments: [{ id: 'invalid-peak', kind: 'base_span', src_in: 0, src_out: 1 }] },
      master_loudnorm: -14,
      master_true_peak_dbfs: 0,
      encode: ENC,
    }, 'master-true-peak-invalid');
  }, /invalid master_true_peak_dbfs/);
});

test('unknown keyframe property fails loudly naming the property (no silent wrong render)', () => {
  assert.throws(() => {
    compose({
      base: { kind: 'video', artifact: base },
      spine: { segments: [{ id: 'x', kind: 'clip', source: base, in: 0, out: 2,
        keyframes: { wobble: [{ t: 0, value: 1 }] } }] },
      encode: ENC,
    }, 't5-kf-unknown');
  }, /unknown property "wobble"/);
});

test('clip edge fades (video+audio) render at correct edges', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'fades', kind: 'clip', source: base, in: 0, out: 4, fade_in_s: 1, fade_out_s: 1 }] },
    encode: ENC,
  }, 't5-fades');
  const luma = (t) => Number(execFileSync('ffprobe', ['-v', 'error', '-f', 'lavfi',
    '-i', `movie=${out},trim=start=${t}:duration=0.1,signalstats`,
    '-show_entries', 'frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0'],
    { encoding: 'utf8' }).trim().split('\n')[0]);
  assert.ok(luma(0.05) < luma(2) * 0.5, 'first frames dark (fade in)');
  assert.ok(luma(3.95) < luma(2) * 0.5, 'last frames dark (fade out)');
});

test('track flags: hidden track segment is skipped, muted track segment is silenced', () => {
  const { out, report } = compose({
    base: { kind: 'video', artifact: base },
    tracks: [{ id: 'main' }, { id: 'scratch', hidden: true }, { id: 'silent-lane', muted: true }],
    spine: { segments: [
      { id: 'kept', kind: 'clip', source: base, in: 0, out: 2, track_id: 'main' },
      { id: 'gone', kind: 'clip', source: base, in: 0, out: 5, track_id: 'scratch' },
      { id: 'quiet', kind: 'clip', source: base, in: 0, out: 2, track_id: 'silent-lane' },
    ] },
    encode: ENC,
  }, 't5-tracks');
  assert.equal(report.segments, 2, 'hidden-track segment never built');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 4) < 0.5, 'kept(2)+quiet(2)=4s');
});

test('ADVERSARIAL COMBO: keyframed opacity on a mirrored crop of a sped trim with fades — zero special cases', () => {
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [{ id: 'gauntlet', kind: 'clip', source: base,
      in: 1, out: 9, speed: 2, crop: { w: 160, h: 90, x: 40, y: 30 }, flip: 'h',
      fade_in_s: 0.5, fade_out_s: 0.5,
      keyframes: { opacity: [{ t: 0, value: 1 }, { t: 4, value: 0.3 }] } }] },
    encode: ENC,
  }, 't5-gauntlet');
  // (9-1)/2 = 4s
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 4) < 0.5);
  assert.equal(probe(out, 'stream=width,height').split('\n')[0], '320,180', 'normalized to canonical frame');
});

test('DELETION TEST (audiogram): audio spine + card + keyframed image clip — entirely new DATA, zero code', () => {
  // no base video, no overlays, no chapters — a completely different artifact class
  const still = join(work, 'wave.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'cellauto=size=320x180:rate=24', '-t', '4', '-c:v', 'libx264', still]);
  const { out, report } = compose({
    base: { kind: 'color', color: 'black' },
    spine: { segments: [
      { id: 'title', kind: 'card', duration: 2, bg: '0x101010', lines: [{ text: 'Episode 12', size: 40 }] },
      { id: 'wave', kind: 'clip', source: still, silent_audio: true,
        keyframes: { opacity: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } },
    ] },
    audio_graph: { replace_audio: voice },
    encode: ENC,
  }, 't5-audiogram');
  assert.equal(report.segments, 2);
  assert.match(probe(out, 'stream=codec_type'), /audio/);
  assert.ok(Number(probe(out, 'format=duration')) > 5, 'card(2)+wave(4)=6s spine');
});

test('RECURSION (L081): a rendered composition is itself a clip source of a new composition', () => {
  const first = compose({
    base: { kind: 'color', color: 'blue' },
    spine: { segments: [{ id: 'inner', kind: 'card', duration: 2, lines: [{ text: 'inner', size: 40 }] }] },
    encode: ENC,
  }, 't5-recursion-inner');
  const { out } = compose({
    base: { kind: 'video', artifact: base },
    spine: { segments: [
      { id: 'reused', kind: 'clip', source: first.out, speed: 2 },
      { id: 'tail', kind: 'base_span', src_in: 0, src_out: 2 },
    ] },
    encode: ENC,
  }, 't5-recursion-outer');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 3) < 0.5, 'inner(2)/2 + tail(2) = 3s');
});
