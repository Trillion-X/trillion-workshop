#!/usr/bin/env node
/**
 * file: packages/media-composition/do-work/video-compose.mjs
 *
 * PURPOSE: The video.compose capability executable (plan §10/§15 T05) — a
 * data-driven EDL (edit-decision list) compositor. Ports the PROVEN layered
 * assembly from show-up-video's build-final.sh / build-chapter.sh one-to-one
 * onto EDL fields: spine segments (clips / base spans / chapter inserts),
 * slide overlays riding ON TOP of a continuous base (voice never cut),
 * chapter-insert sub-timelines (tail / b-roll / black card / title / resume),
 * a music bed with qsin fades, optional replace-audio, segment normalization
 * for clean concat, and zero-start (setts) + faststart encoding.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. ZERO style vocabulary — no style names anywhere in this file; behavior
 *    comes only from EDL data (base.kind ∈ video|slides|color is generic)
 * 2. The base is ONE continuous source; overlays never cut its audio
 * 3. Every segment is normalized to canonical params before concat -c copy
 * 4. The final encode zeroes PTS (setts) and sets +faststart (no black poster)
 * 5. Failures name the segment and stage — no silent fallbacks
 *
 * Usage: node video-compose.mjs --edl <edl.json> --out <final.mp4> [--workdir <dir>]
 * The EDL contract is published as record contract::edl in this package's
 * things-to-store-and-run.json (a NEW contract this plan authors — Round-6 finding 6).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visualOverlayBatches } from './visual-overlay-order.mjs';
import { chooseByThreshold } from './choose-by-threshold.mjs';
import { resolveRenderDimensions } from './resolve-render-dimensions.mjs';
import { channelStats, computeColorTransfer, colorMatchFilter } from './color-match.mjs';
import { measureLoudness } from './measure-loudness.mjs';
import { markStage, reusable, stageIdentity, stageInputChunks } from './stage-reuse.mjs';
import { makeHashCodeHexFromChunks } from '../../content-identity/read-data/identity.mjs';

import { createKeyframeEffects, resolveEffectFragment, createTransitionRenderers, resolveTemplateEffect, VIZ_PRODUCERS, createEffectProducers, createComputeEffects, createPulseEffects, createStabilizeEffect, resolveLookStack } from './effect-registry.mjs';

// A render that cannot go on says why in its own words and exits non-zero; it never prints a stack.
process.on('uncaughtException', error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const EDL_PATH = args.get('edl');
const OUT = args.get('out');
if (!EDL_PATH || !OUT) {
  console.error('usage: video-compose.mjs --edl <edl.json> --out <final.mp4> [--workdir <dir>] [--resume]');
  process.exit(2);
}
// The --edl value is SELF-DESCRIBING (L090): an http(s) URL is fetched, a JSON
// literal (starts with '{') is parsed directly (lets any caller — including the
// browser surface, which has no filesystem — pass the EDL inline through the
// workflow-action argv binding), anything else is a file path.
const edlText = /^https?:\/\//.test(EDL_PATH)
  ? await (async () => {
      const response = await fetch(EDL_PATH);
      if (!response.ok) throw new Error(`[video.compose] EDL fetch failed at load: ${EDL_PATH} → ${response.status}`);
      return response.text();
    })()
  : EDL_PATH.trimStart().startsWith('{')
    ? EDL_PATH
    : readFileSync(EDL_PATH, 'utf8');
const edl = JSON.parse(edlText);
const T = (args.get('workdir') ?? mkdtempSync(join(tmpdir(), 'video-compose-'))).replace(/\/+$/, '');
// #resume Interrupted-render continuation: with an explicit --workdir (the stable
// output root) and --resume, any render stage whose output file ALREADY exists and
// decodes is reused instead of re-rendered. The render graph is deterministic for a
// given EDL, so identical bytes-in produce identical stage outputs; a zero-byte or
// non-decoding file (the classic crash-moment stub) fails the validity probe and is
// re-rendered. This is the generic interrupted-render primitive: it composes with
// every segment kind, transition renderer, and concat stage because they all pass
// through ff() below — no per-builder resume branches (L069 clay, not LEGO).
const RESUME = process.argv.includes('--resume');

// ---- stored-bytes ref materialization (engine-native artifacts, ZERO machine paths — L136/Physics-vs-Society) ----
// DATA references shipped package artifacts (LUT `.cube`, transition scripts, any bytes) by their
// stored-bytes ADDRESS `package::media-composition::stored-bytes::<name>` — never a raw machine path
// (which the compiler rejects: BRTK3002_LOCAL_PATH_LEAK). Here we resolve that address to the
// package's OWN bytes (via its `stored_bytes` things) and materialize a temp file, so the compiled
// DATA carries no local path yet the renderer runs the real artifact — portable on any machine.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STORED_BYTES = (() => {
  const map = new Map();
  // The part's own declarations, and read-data/stored-bytes.json (the colour LUTs), which travels with read-data
  // into every container tool that carries it.
  for (const file of ['things-to-store-and-run.json', join('read-data', 'stored-bytes.json')]) {
    try {
      const things = JSON.parse(readFileSync(join(PKG_ROOT, file), 'utf8')).things ?? [];
      for (const t of things) {
        if (t && t.type === 'stored_bytes' && t.name && t.source_path) {
          map.set(`package::media-composition::stored-bytes::${t.name}`, t.source_path);
        }
      }
    } catch { /* declarations file not reachable → refs will error explicitly below */ }
  }
  return map;
})();
const _refCache = new Map();
function materializeRef(ref) {
  if (_refCache.has(ref)) return _refCache.get(ref);
  const rel = STORED_BYTES.get(ref);
  if (!rel) throw new Error(`[video.compose] unknown stored-bytes ref ${JSON.stringify(ref)} — declare it as a stored_bytes thing`);
  const ext = rel.match(/\.[a-z0-9]+$/i)?.[0] ?? '';
  const out = join(T, `artifact-${ref.split('::').pop()}${ext}`);
  // The colour grade files are supplied by the account and are not in this repository.
  if (!existsSync(join(PKG_ROOT, rel))) throw new Error(`[video.compose] ${ref.split('::').pop()} needs ${rel}, which the account supplies; it is not in this repository, so this run has no copy of it`);
  writeFileSync(out, readFileSync(join(PKG_ROOT, rel)));
  if (/\.(sh|py)$/i.test(rel)) { try { chmodSync(out, 0o755); } catch { /* best-effort exec bit */ } }
  _refCache.set(ref, out);
  return out;
}

// ---- encode defaults (every value overridable from edl.encode) ----
const enc = edl.encode ?? {};
function probeFirstSpineFrameDimensions() {
  const segments = Array.isArray(edl.spine?.segments) ? edl.spine.segments : [];
  const firstSegment = segments[0];
  const firstSource = firstSegment?.kind === 'base_span' && typeof edl.base?.artifact === 'string'
    ? edl.base.artifact
    : typeof firstSegment?.source === 'string'
      ? firstSegment.source
      : typeof firstSegment?.sources?.[0]?.source === 'string'
        ? firstSegment.sources[0].source
        : undefined;
  if (!firstSource) return undefined;
  try {
    const result = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0', firstSource,
    ], { encoding: 'utf8' }).trim();
    const match = result.match(/^(\d+)x(\d+)$/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
  } catch (error) {
    throw new Error(`[video.compose] could not read the first spine clip dimensions for Source resolution: ${error.stderr?.toString().slice(-300) ?? error.message}`);
  }
}
const { width: W, height: H } = resolveRenderDimensions(
  enc,
  enc.resolution === 'source' ? probeFirstSpineFrameDimensions() : undefined,
);
const FPS = enc.fps ?? '24000/1001';
// FPS may be a fraction string ('24000/1001') that ffmpeg accepts verbatim in filters/-r,
// but arithmetic (e.g. transition cut-floor) needs a real number. Parse num/den or plain number,
// fall back to 30. Without this, `2 / '24000/1001'` is NaN and every comparison silently fails.
const fpsNum = (() => {
  if (typeof FPS === 'number' && Number.isFinite(FPS)) return FPS;
  const frac = String(FPS).match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
  if (frac) { const d = Number(frac[2]); return d ? Number(frac[1]) / d : 30; }
  const n = Number(FPS);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();
const CRF = enc.crf ?? 18;
// #170 Reproducible/deterministic render mode. `edl.encode.deterministic` (a boolean
// DATA field, default OFF so production keeps full multi-threading and speed) pins BOTH
// filter-graph threads and the x264 encoder to a single thread, so the SAME EDL renders
// BIT-IDENTICAL every time. This is a real editor capability (reproducible exports,
// render-cache keys, CI render diffing) that CapCut/Premiere/DaVinci do not reliably
// offer, and it is the structural fix (L063) for filter slice-thread nondeterminism that
// otherwise flakes frame/pixel checks. Boolean = zero injection surface.
const DETERMINISTIC = enc.deterministic === true;
const V = ['-c:v', 'libx264', '-crf', String(CRF), '-preset', enc.preset ?? 'medium', '-pix_fmt', 'yuv420p', ...(DETERMINISTIC ? ['-threads', '1'] : [])];
const A = ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', enc.audio_bitrate ?? '256k'];
const VF_NORM = `scale=${W}:${H},setsar=1,fps=${FPS},format=yuv420p`;

// `-filter_threads 1` (a global option, valid right after -y) forces single-threaded
// filtergraph evaluation so geq/eq/blend slice threads cannot introduce per-run pixel
// drift. Empty in normal mode.
const DET_FILTER_ARGS = DETERMINISTIC ? ['-filter_threads', '1'] : [];

function ff(ffArgs, stage) {
  const out = ffArgs[ffArgs.length - 1];
  const fullArgs = ['-hide_banner', '-loglevel', 'error', '-y', ...DET_FILTER_ARGS, ...ffArgs];
  const sidecarOk = typeof out === 'string';
  if (RESUME && sidecarOk && out.startsWith(T + '/')) {
    // A stage is reused only when it was made by these exact args from these exact inputs (stage-reuse.mjs), and decodes.
    let canReuse = false;
    try {
      canReuse = reusable(out, fullArgs) && probeDuration(out) > 0;
    } catch { /* missing or non-decoding output (crash stub) → re-render */ }
    if (canReuse) {
      console.log(`[video.compose] resume: reuse existing ${stage} → ${out}`);
      return;
    }
  }
  // Invalidate the sidecar first, so a run that fails midway cannot leave a sidecar vouching for a clobbered output.
  if (sidecarOk) markStage(out, null);
  const identity = stageIdentity(fullArgs);
  try {
    execFileSync('ffmpeg', fullArgs, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`[video.compose] ffmpeg failed at ${stage}: ${error.stderr?.toString().slice(-400) ?? error.message}`);
  }
  if (sidecarOk) markStage(out, identity);
}

let segIndex = 0;
const segments = [];
const segPath = () => join(T, `seg${String(segIndex).padStart(3, '0')}.mp4`);
const push = (file) => { segments.push(file); segIndex += 1; };

/** Probe whether a file actually carries an audio stream — never assumed from kind. */
function fileHasAudio(file) {
  try {
    const streams = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    return streams.length > 0;
  } catch {
    return false;
  }
}

const baseHasAudio = edl.base?.artifact ? fileHasAudio(edl.base.artifact) : false;

// #75 External denoise pre-processors (DATA, enum-dissolution): a clip's `denoise`
// value that names a key here is cleaned by a SEPARATE binary before the ffmpeg clip
// build (the WASM-is-brain process pattern); anything else is treated as an opaque
// in-graph ffmpeg audio-filter string (afftdn/arnndn/anlmdn...). Each entry declares
// how to turn a clip source into a cleaned WAV; adding a new engine is ONE row.
// `deepfilternet` = DeepFilterNet 0.5.x CLI (`deepFilter <wav> -o <dir>` writes
// `<stem>_DeepFilter.wav`), the SoTA learned real-time denoiser.
// #plugin-arch Stage 4: the out-of-process producer taxonomy (denoise/matte/translation) is owned by the
// effect-registry; the compositor injects its process leaf (execFileSync) and path leaf (PKG_ROOT, join).
// The wrapper fns below (denoisePreprocess/matteProduce/translateText) invoke these maps fail-soft, blind
// to which engine runs. Adding a denoiser/segmentation model/translator is ONE registry row, zero edit here.
const { denoise: DENOISE_PREPROCESSORS, matte: MATTE_PRODUCERS, translation: TRANSLATION_PRODUCERS } =
  createEffectProducers({ execFileSync, PKG_ROOT, join });

/**
 * Run an external denoiser on a clip's audio, returning the cleaned WAV path.
 * Extract the clip's (already-seeked) audio to 48k stereo WAV, hand it to the
 * declared binary, and return its output. Fail-soft: if the binary is missing or
 * errors, return null so the caller keeps the original audio (never a hard crash).
 */
function denoisePreprocess(segment, pre, seek) {
  try {
    const inWav = join(T, `denoise-in-${segment.id}.wav`);
    ff([...seek, '-i', segment.source, '-vn', '-ar', '48000', '-ac', '2', inWav], `denoise-extract ${segment.id}`);
    pre.run(pre.bin, inWav, T);
    const cleaned = join(T, pre.cleanedName(`denoise-in-${segment.id}`));
    execFileSync('test', ['-f', cleaned]);
    return cleaned;
  } catch (e) {
    console.error(`[video.compose] denoise preprocess (${pre.bin}) failed for clip ${segment.id}, keeping original audio:`, e?.message ?? e);
    return null;
  }
}

/**
 * #107 Ramped-audio preprocessor: retime the clip's audio THROUGH a speed_ramp so it stays in
 * sync with the setpts-remapped video (Premiere/DaVinci behavior) instead of muting. Each ramp
 * span [t_i, t_i+1) is extracted from the seeked source and tempo-shifted by its span speed via
 * atempoChain, then the spans are concatenated. Opt-in DATA (`speed_ramp_audio: true`); default
 * stays mute. Fail-soft: any error returns null and the clip renders silent (never a crash).
 */
function rampAudioPreprocess(segment, pts, seek, srcLen) {
  try {
    const inWav = join(T, `ramp-in-${segment.id}.wav`);
    ff([...seek, '-i', segment.source, '-vn', '-ar', '48000', '-ac', '2', inWav], `ramp-audio-extract ${segment.id}`);
    const spans = [];
    for (let i = 0; i < pts.length; i += 1) {
      const start = pts[i].t;
      const end = i + 1 < pts.length ? pts[i + 1].t : Math.max(srcLen, start);
      if (end <= start) continue;
      const spanWav = join(T, `ramp-span-${segment.id}-${i}.wav`);
      ff(['-ss', String(round3(start)), '-t', String(round3(end - start)), '-i', inWav,
        '-af', atempoChain(pts[i].s).join(','), spanWav], `ramp-audio-span ${segment.id}#${i}`);
      spans.push(spanWav);
    }
    if (spans.length === 0) return null;
    const out = join(T, `ramp-audio-${segment.id}.wav`);
    const inputs = spans.flatMap((s) => ['-i', s]);
    const graph = `${spans.map((_, i) => `[${i}:a]`).join('')}concat=n=${spans.length}:v=0:a=1[a]`;
    ff([...inputs, '-filter_complex', graph, '-map', '[a]', out], `ramp-audio-concat ${segment.id}`);
    return out;
  } catch (e) {
    console.error(`[video.compose] ramp-audio preprocess failed for clip ${segment.id}, muting:`, e?.message ?? e);
    return null;
  }
}

// ---- matte producers (MATTE_PRODUCERS): turn a source video into a grayscale alpha matte (a
// DATA-selected segmentation process); now owned by the effect-registry (destructured above from
// createEffectProducers). The composite just alphamerges whatever matte it is handed (L069).

/** #89 Loop / boomerang: repeat a built clip `count` times via the concat demuxer. When
 *  `boomerang`, every ODD copy is the reversed clip (forward, back, forward, ...) so the motion
 *  ping-pongs seamlessly. All copies share the clip's own codec/params, so concat can stream-copy.
 *  The looped clip's duration is count x the clip length; the spine concats its ACTUAL length. */
let _loopCounter = 0;
function buildClipLoop(srcFile, count, boomerang) {
  let rev = null;
  if (boomerang) {
    rev = join(T, `boomerev-${_loopCounter}.mp4`);
    ff(['-i', srcFile, '-vf', 'reverse', '-af', 'areverse', ...V, ...A, rev], 'boomerang reverse');
  }
  const lines = [];
  for (let i = 0; i < count; i += 1) lines.push(`file '${(boomerang && i % 2 === 1) ? rev : srcFile}'`);
  const listPath = join(T, `looplist-${_loopCounter}.txt`);
  writeFileSync(listPath, `${lines.join('\n')}\n`);
  const out = join(T, `loop-${_loopCounter++}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out], 'clip loop concat');
  return out;
}

/** Run a matte producer on a source video, returning the produced grayscale matte path.
 *  Fail-soft: on any error return null so the overlay stays opaque rather than crashing. */
let _matteCounter = 0;
function matteProduce(srcFile, mode) {
  const p = MATTE_PRODUCERS[mode];
  if (!p) return null;
  try {
    const out = join(T, `matte-${_matteCounter++}.mp4`);
    execFileSync(p.bin, [p.script, srcFile, out, ...(p.args || [])], { encoding: 'utf8' });
    execFileSync('test', ['-f', out]);
    return out;
  } catch (e) {
    console.error(`[video.compose] matte producer '${mode}' failed for ${srcFile}, overlay stays opaque:`, e?.message ?? e);
    return null;
  }
}

/* ---- #90 Caption translation (L069 enum-dissolution): burned text is resolved through a
 * DATA-selected translation producer before it is drawn. LANGUAGES are DATA (any BCP-47 code);
 * ENGINES are DATA producer keys (never a per-language code branch). The render is blind: it draws
 * whatever text the producer returns, fail-soft to the original. `edl.caption_translate` = the
 * composition-wide default `{to, producer, glossary?}`; a per-overlay `{translate_to, translate_producer}`
 * overrides it. A NEW translator is ONE row in TRANSLATION_PRODUCERS (or a new `producer` command),
 * zero engine changes, so deepl / google / offline argos / an AI provider are all data. */
/* #96 Audio-reactive visualizer (L069 enum-dissolution): an overlay whose VIDEO is GENERATED from
 * the program audio (the podcast / music-video signature). Each producer maps {rw,rh,color,fps} to an
 * ffmpeg source-filter string that turns one audio input into a video. A new visualizer is ONE row;
 * the render is blind to what it draws. `[aud]<producer>[viz]` is keyed on black and overlaid. */
// #plugin-arch Stage 4: VIZ_PRODUCERS now lives in effect-registry.mjs (imported above); the visualizer
// taxonomy is owned by the registry, not the compositor. Adding a visualizer stays a ONE-row DATA change.

// #plugin-arch Stage 4: TRANSLATION_PRODUCERS (glossary/argos) now lives in the effect-registry
// (destructured above from createEffectProducers); translateText below invokes it fail-soft.
const _xlateCache = new Map();
/** Resolve `text` through the effective translation config (per-overlay override else the EDL
 *  default). No config, no producer, empty result -> the original text (fail-soft, never blank). */
function translateText(text, override) {
  if (typeof text !== 'string' || text === '') return text;
  const cfg = override ?? edl.caption_translate;
  if (!cfg || !cfg.to || !cfg.producer) return text;
  const prod = TRANSLATION_PRODUCERS[cfg.producer];
  if (!prod) return text;
  const key = `${cfg.producer}\u0000${cfg.to}\u0000${text}`;
  if (_xlateCache.has(key)) return _xlateCache.get(key);
  let result = text;
  try {
    const t = prod(text, cfg.to, cfg);
    if (typeof t === 'string' && t.trim()) result = t;
  } catch (e) {
    console.error(`[video.compose] translate producer '${cfg.producer}'->${cfg.to} failed, keeping original:`, e?.message ?? e);
  }
  _xlateCache.set(key, result);
  return result;
}

/** Probe a file's container duration in seconds (used to place fade-outs when the EDL gives no trim). */
function probeDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const n = Number(out);
  if (!Number.isFinite(n)) throw new Error(`[video.compose] could not probe duration of ${file}`);
  return n;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** The `volume=<dB>dB,` that brings a narration placement's stretch to its `level`, or '' when it names none. */
function narrationLevel(placement, file, from, seconds, k) {
  const level = placement.level;
  if (level === undefined) return '';
  const bounds = level?.gain_db ?? [-Infinity, Infinity];
  if (!Number.isFinite(level?.lufs) || !Array.isArray(bounds) || bounds.length !== 2 || !(bounds[0] <= bounds[1]))
    throw new Error(`[video.compose] narration entry ${k} level needs lufs and gain_db [lowest, highest]`);
  const measured = measureLoudness(file, { from, seconds, channels: 2 }).integrated_lufs;
  // A silent stretch has no loudness to bring anywhere; it takes the highest gain allowed, which is still silence.
  const gain = measured === null ? bounds[1] : Math.max(bounds[0], Math.min(bounds[1], level.lufs - measured));
  if (!Number.isFinite(gain)) throw new Error(`[video.compose] narration entry ${k} is silent and its level names no highest gain`);
  return `volume=${round3(gain)}dB,`;
}
// #plugin-arch Stage 5: the compute-effect taxonomy (color_adjust/letterbox/scrim), built once. The
// compositor resolves an entry and pushes its fragment(s) IN PLACE (L179: vParts is the ordered -vf list).
// safeColor/colorToRgb255 are hoisted function declarations, so referencing them here is fine.
const COMPUTE_EFFECTS = createComputeEffects({ round3, W, H, safeColor, colorToRgb255, fpsNum, FPS });
const PULSE_EFFECTS = createPulseEffects({ round3, fpsNum, W, H, colorToRgb255 });
// #85 stabilize (2-pass vidstab) is a PROCESS capability: it shells an ffmpeg detect pass, so it takes
// the I/O leaf (ff, T, join, execFileSync) and resolves the vidstabtransform fragment IN PLACE (L179).
const STABILIZE_EFFECT = createStabilizeEffect({ ff, T, join, execFileSync });
// #127 Parse a 6-hex color (with or without '#') to [r,g,b] floats 0..1, or null if invalid.
function hexToRgbFloats(s) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(s ?? ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [round3(((n >> 16) & 255) / 255), round3(((n >> 8) & 255) / 255), round3((n & 255) / 255)];
}
// #128 Parse a DATA color (6-hex with/without '#', or a common name) to [r,g,b] ints 0..255. Output is
// ALWAYS three ints, so a hostile value can never inject filtergraph syntax (unknown -> black fallback).
const NAMED_RGB255 = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], yellow: [255, 255, 0],
  cyan: [0, 255, 255], magenta: [255, 0, 255], orange: [255, 165, 0],
};
function colorToRgb255(s) {
  const f = hexToRgbFloats(s);
  if (f) return f.map((v) => Math.round(v * 255));
  const name = String(s ?? '').trim().toLowerCase();
  return NAMED_RGB255[name] ?? [0, 0, 0];
}

// #114 Split edit (J-cut / L-cut): a clip's audio DETACHED from its video. `audio_offset_s` is one
// scalar. Negative places the clip's audio BEFORE its video cut (audio leads, a J-cut), positive
// AFTER (audio lags, an L-cut), zero is normal sync. Returns the offset when a clip qualifies, else
// null. The detach uses the clip's RENDERED segment audio (whatever produced it, so speed, ramp,
// freeze, or reverse all compose with zero special case), which is gated out of its natural spine
// window and re-added at videoStart+offset through the audio.narration placement primitive (L093).
function splitEditOffset(seg) {
  const o = Number(seg?.audio_offset_s);
  if (!Number.isFinite(o) || o === 0) return null;
  if (seg.muted === true || seg.silent_audio === true) return null;
  return o;
}

// ─── THE piecewise-time-function primitive (L069) ──────────────────────────────────────────────
// Compile a list of time KNOTS into a nested-if ffmpeg expression f(time). EVERY keyframed feature
// is a configuration of THIS ONE function: the volume/opacity/zoom envelopes (#68), the subject-
// track follow (#101), the speed-ramp output-time curve (#102), and the adjustment strength (#109)
// all differ ONLY in (a) how their DATA becomes {t, value} knots and (b) which time symbol plus
// comma-escaping the filter context needs. There is no second copy of the nested-if construction.
//   knots : [{ t, value, interp? }]  (finite; sorted here; at least 1)
//   time  : the ffmpeg time symbol the expr reads, one of 'T' (frame time s), 't' (timeline s), or
//           '__T__' (a placeholder KEYFRAME_BINDINGS substitutes per stream)
//   esc   : escape the if() commas as '\,' for UNQUOTED filtergraph option values (setpts); a
//           single-quoted option value ('...') takes plain commas
// Holds the first value before the first knot and the last value after the last knot. Within a span
// the END knot's interp governs the shape: 'hold' (step), 'linear' (default), or an EASE (a cubic
// remap of the 0..1 span fraction before the lerp: ease-in, ease-out, ease-in-out / smooth). Because
// EVERY keyframed feature (opacity, zoom, punch-in, Ken Burns, adjustment strength) is a config of
// this one function, easing is available to all of them from DATA with ZERO per-feature code (L069).
// An extrapolating tail (the speed ramp past its last keyframe) is an ordinary END knot, no special case.
const PIECEWISE_INTERPS = new Set(['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out', 'smooth']);
// A cubic (or quadratic) remap of the normalized span fraction F in [0,1]; F carries no commas so it
// is escape-safe. Named eases are DATA presets over this seam; a novel curve is a new row here.
function easeFrac(F, interp) {
  switch (interp) {
    case 'ease-in': return `(${F})*(${F})`;
    case 'ease-out': return `(1-(1-(${F}))*(1-(${F})))`;
    case 'ease-in-out':
    case 'smooth': return `(${F})*(${F})*(3-2*(${F}))`;
    default: return `(${F})`;
  }
}
function piecewiseExpr(knots, { time = 'T', esc = false } = {}) {
  const pts = [...knots]
    .map((p) => ({ t: Number(p.t), value: Number(p.value), interp: p.interp ?? 'linear' }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) throw new Error('[video.compose] piecewise expr needs at least one knot');
  for (const p of pts) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.value)) throw new Error('[video.compose] piecewise knot needs finite t and value');
    if (!PIECEWISE_INTERPS.has(p.interp)) throw new Error(`[video.compose] piecewise interp ${JSON.stringify(p.interp)} not in ${JSON.stringify([...PIECEWISE_INTERPS])}`);
  }
  const C = esc ? '\\,' : ',';
  const n = (x) => String(round3(x));
  const segments = pts.slice(1).map((b, i) => {
    const a = pts[i];
    const span = b.t - a.t;
    if (b.interp === 'hold' || span <= 0) return n(a.value);
    if (b.interp === 'linear') return `(${n(a.value)}+(${n(b.value)}-${n(a.value)})*(${time}-${n(a.t)})/${n(span)})`; // exact prior form
    return `(${n(a.value)}+(${n(b.value)}-${n(a.value)})*${easeFrac(`(${time}-${n(a.t)})/${n(span)}`, b.interp)})`;
  });
  return chooseByThreshold(time, pts.map((p) => n(p.t)), [n(pts[0].value), ...segments, n(pts[pts.length - 1].value)], C);
}

// ONE still-to-motion zoompan compiler (L069). z / x / y arrive as ffmpeg expressions already in
// zoompan's per-frame time (use `(on/fps)` for clip seconds); x/y are NORMALIZED 0..1 pan centers.
// Ken Burns (#67, 2-knot from/to) and punch-in (#88, N-knot zoom, centered) both build their z/x/y
// as piecewiseExpr envelopes and call THIS; there is one zoompan string, and Ken Burns is now a
// keyframe envelope (so a multi-stop pan/zoom is free, not a second implementation).
function zoompanFilter(zExpr, xExpr, yExpr, fps) {
  return `zoompan=z='${zExpr}':x='(iw-iw/zoom)*(${xExpr})':y='(ih-ih/zoom)*(${yExpr})':d=1:s=${W}x${H}:fps=${fps}`;
}

// #101 Motion tracking: ONE normalized 0..1 axis of a subject track `[{t, x, y}]`, clamped, as a
// piecewise expr in timeline seconds `t` (escaped for the filtergraph). A configuration of
// piecewiseExpr where the knots are the chosen axis; the compositor is blind to WHERE the track
// came from (a face/person detector is a separate producer). Returns null when the axis has no points.
function trackNormExpr(track, key) {
  const knots = (Array.isArray(track) ? track : [])
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p[key]))
    .map((p) => ({ t: p.t, value: Math.max(0, Math.min(1, p[key])) }));
  if (knots.length === 0) return null;
  return piecewiseExpr(knots, { time: 't', esc: true });
}

// #102 Speed-ramp velocity curve: a keyframed speed envelope `[{t, speed}]` (input-time seconds,
// speed>0, piecewise-constant between keyframes) becomes the setpts OUTPUT-seconds function f(T) =
// cumulative output time. Integrating 1/speed turns the speed keyframes into OUTPUT-TIME knots
// (t_i, out_i): out_i = out_{i-1} + (t_i - t_{i-1})/s_{i-1}, so the span i-1..i has slope 1/s_{i-1}
// = exactly linear interp between (t_{i-1}, out_{i-1}) and (t_i, out_i). The clip plays past its
// last keyframe at that speed, so we append an END knot at inLen: the ramp is then just knots fed
// to piecewiseExpr, with NO extrapolation special case (the tail is an ordinary segment).
function rampCumulative(ramp) {
  const pts = (Array.isArray(ramp) ? ramp : [])
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.speed) && p.speed > 0)
    .map((p) => ({ t: Math.max(0, p.t), s: p.speed }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;
  if (pts[0].t > 0) pts.unshift({ t: 0, s: pts[0].s });
  const out = [0];
  for (let i = 1; i < pts.length; i += 1) out[i] = out[i - 1] + (pts[i].t - pts[i - 1].t) / pts[i - 1].s;
  return { pts, out };
}
// Output-time knots (t, value=output seconds) for a speed ramp over `inLen` input seconds,
// including the clip-end knot that turns the after-last-keyframe span into an ordinary segment.
function rampKnots(ramp, inLen) {
  const c = rampCumulative(ramp);
  if (!c) return null;
  const { pts, out } = c;
  const knots = pts.map((p, i) => ({ t: p.t, value: out[i] }));
  const last = pts.length - 1;
  const end = Math.max(pts[last].t, Number.isFinite(inLen) ? inLen : pts[last].t);
  if (end > pts[last].t) knots.push({ t: end, value: out[last] + (end - pts[last].t) / pts[last].s });
  return knots;
}
function speedRampSecondsExpr(ramp, inLen) {
  const knots = rampKnots(ramp, inLen);
  if (!knots) return null;
  return piecewiseExpr(knots, { time: 'T', esc: true });
}
// Total output seconds a speed_ramp yields for `inLen` input seconds: the last knot's value.
// The silent-audio track and any downstream duration must use THIS, not the raw clipLen, or
// `-shortest` truncates the remapped video (a slow-down grows the clip beyond clipLen).
function speedRampOutSeconds(ramp, inLen) {
  const knots = rampKnots(ramp, inLen);
  if (!knots) return null;
  return round3(knots[knots.length - 1].value);
}

/** atempo only accepts 0.5–2 per instance — chain factors to reach any speed. */
function atempoChain(speed) {
  const chain = [];
  let s = speed;
  while (s > 2) { chain.push('atempo=2'); s /= 2; }
  while (s < 0.5) { chain.push('atempo=0.5'); s *= 2; }
  chain.push(`atempo=${round3(s)}`);
  return chain;
}

/** Resolve the spine's base input for base_span segments: a video file, a slides full-frame source, or a color. */
function baseInputArgs(durationArgs) {
  const base = edl.base ?? {};
  if (base.kind === 'color') {
    return { input: ['-f', 'lavfi', ...durationArgs, '-i', `color=${base.color ?? 'black'}:s=${W}x${H}:r=${FPS}`], hasAudio: false };
  }
  // video and slides are both file-backed full-frame sources — the EDL decides
  // what the artifact contains; the compositor PROBES for audio (a video-only
  // artifact gets silent audio so replace_audio/music can attach downstream).
  return { input: [...durationArgs, '-i', base.artifact], hasAudio: baseHasAudio };
}

/** clip — normalize a whole (or trimmed) file to canonical params, applying the
 * generic per-clip property grammar (contract::edl per-clip fields, ported from
 * the Palmier reference AS DATA — never as named feature functions):
 *
 *   in / out        source-seconds trim window (identity when absent)
 *   speed           temporal remap (setpts + atempo chain; identity 1)
 *   crop {w,h,x,y}  source-px crop (pre-scale)
 *   flip h|v|hv     mirror (after crop, before scale)
 *   fade_in_s / fade_out_s   linear video+audio fades at the clip's edges
 *   keyframes {property → [{t,value,interp}]}  generic envelopes — ANY property
 *       with a registered binding animates; t is CLIP-LOCAL seconds (post-trim,
 *       post-speed); interp ∈ linear|hold per preceding point
 *   silent_audio / muted     replace the track with silence
 *   hidden          handled by the spine walk (segment skipped entirely)
 *
 * Fixed evaluation order (contract::edl): trim → speed → crop/flip → scale-norm
 * → keyframe envelopes → fades. The order is Physics (deterministic composition);
 * every value is Society DATA.
 */
function buildClip(segment) {
  const out = segPath();
  const speed = typeof segment.speed === 'number' && segment.speed > 0 ? segment.speed : 1;
  // #102 A speed_ramp [{t,speed}] envelope varies the speed over the clip (velocity curve); it
  // overrides constant speed and mutes the clip audio (variable-speed audio is a separate concern).
  // `frames` (a whole number) is the clip's exact length in output frames: the picture is cut (or its last frame
  // held) to that count and the sound padded or cut to the same seconds, so a cut of many clips lands frame-exact.
  const frameCount = segment.frames ?? null;
  if (frameCount !== null && (!Number.isInteger(frameCount) || frameCount < 1))
    throw new Error(`[video.compose] clip ${segment.id} frames must be a whole number of frames, 1 or more`);
  // `still: {at, duration?}` holds the source frame at `at` seconds for `duration` seconds (or `frames`): one
  // picture that the rest of the chain (grade, ken_burns, fades) treats as a clip of that length. It has no sound.
  const still = segment.still && typeof segment.still === 'object' ? segment.still : null;
  if (still && !(Number.isFinite(still.at) && still.at >= 0))
    throw new Error(`[video.compose] clip ${segment.id} still needs at, the source second of the held frame`);
  const stillLen = still ? (Number.isFinite(still.duration) && still.duration > 0 ? still.duration : frameCount ? frameCount / fpsNum : NaN) : null;
  if (still && !Number.isFinite(stillLen))
    throw new Error(`[video.compose] clip ${segment.id} still needs duration or frames, how long the frame is held`);
  // trim window (source seconds)
  const seek = [];
  if (still) seek.push('-ss', String(still.at));
  if (!still && Number.isFinite(segment.in)) seek.push('-ss', String(segment.in));
  // Preserve source-clock precision through both input trim and the silent
  // output track below; rounding574/30 down to19.133 can lose its final frame.
  if (!still && Number.isFinite(segment.out)) seek.push('-t', String(segment.out - (segment.in ?? 0)));

  // effective clip length on the FINAL timeline (for fades + envelope domain)
  const srcLen = still ? stillLen : Number.isFinite(segment.out)
    ? segment.out - (segment.in ?? 0)
    : probeDuration(segment.source) - (segment.in ?? 0);
  // #102 speed_ramp keyframe times are source SECONDS by default; `speed_ramp_unit:'fraction'`
  // declares them as fractions of the clip's source length (a preset authored without knowing
  // the clip duration), resolved here where srcLen is known. Self-describing DATA (L090).
  const rampPts = segment.speed_ramp_unit === 'fraction' && Array.isArray(segment.speed_ramp)
    ? segment.speed_ramp.map((p) => ({ ...p, t: (Number(p?.t) || 0) * srcLen }))
    : segment.speed_ramp;
  const rampExpr = speedRampSecondsExpr(rampPts, srcLen);
  const retime = speed !== 1 || rampExpr !== null;
  const clipLen = srcLen / speed;
  // #102 A velocity ramp remaps `srcLen` input seconds to a different output length; the silent
  // audio + `-shortest` mux must span the RAMPED length or the remapped video is truncated back.
  const rampOutLen = rampExpr ? speedRampOutSeconds(rampPts, srcLen) : null;
  const outLen = rampOutLen ?? clipLen;

  // ---- video chain ----
  const vParts = [];
  // A still is its one frame, held: everything after this sees a clip `stillLen` seconds long.
  if (still) vParts.push(`trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${stillLen}`);
  // #85 Stabilization / deshake (DaVinci warp-stabilizer class) as a DATA flag. vidstab is two passes;
  // STABILIZE_EFFECT.resolve (effect-registry) runs pass 1 (vidstabdetect on the seeked source) and returns
  // the pass-2 vidstabtransform fragment (or null, fail-soft). It goes FIRST on the raw forward frames
  // (before reverse/crop/grade), matching the forward order pass 1 analyzed, pushed IN PLACE here (L179).
  // `stabilize` is a DATA boolean; `stabilize_smoothing` (frames, default 10) is the strength knob.
  if (segment.stabilize) {
    const frag = STABILIZE_EFFECT.resolve(segment, seek);
    if (frag) vParts.push(frag);
  }
  // #76 Reverse: play the clip backward. `reverse` buffers + flips the frame order, so it
  // goes FIRST (downstream crop/grade/fades ride the reversed stream). `areverse` mirrors it
  // on the audio side below. DATA flag, zero branch per direction.
  const reversed = segment.reverse === true;
  if (reversed) vParts.push('reverse');
  // #76 Freeze-frame / hold: clone the first ('head') or last ('tail') frame for `duration`
  // seconds via tpad, extending the clip (the spine concats actual rendered lengths, so the
  // held frame just lengthens the movie). {mode, duration} is DATA; head/tail are the ffmpeg
  // start/stop pad sides. Applied LAST so it holds the FINAL composed frame.
  const freeze = (segment.freeze && typeof segment.freeze === 'object') ? segment.freeze : null;
  const freezeMode = freeze && freeze.mode === 'head' ? 'start' : 'stop';
  const freezeDur = freeze && Number.isFinite(freeze.duration) && freeze.duration > 0 ? round3(freeze.duration) : 0;
  // #plugin-arch Stage 5: the whole geometric band (crop/crop_rect/reframe/ken_burns/rotate/flip) is
  // collected into ONE ordered `geomEffects` list in its exact vf order, walked once below. A filter
  // chain is order-sensitive so the walk sits in the band; fully-computed fragments are zero-placeholder
  // template nodes (resolveTemplateEffect returns them unchanged). Byte-identical: append order preserved.
  const geomEffects = [];
  if (segment.crop) {
    const { w, h, x, y } = segment.crop;
    geomEffects.push({ template: `crop=${w}:${h}:${x}:${y}` });
  }
  // #120 Manual crop / zoom rect: crop a NORMALIZED 0..1 sub-rectangle {x,y,w,h} of the source (as
  // fractions of iw/ih, so it is resolution-independent), then the downstream VF_NORM scales that
  // region up to fill the canvas. The explicit-region twin of auto-reframe / Ken Burns; placed before
  // reframe so a manual crop selects the region the rest of the chain operates on. Blind DATA (L090).
  const cropRect = segment.crop_rect && typeof segment.crop_rect === 'object' ? segment.crop_rect : null;
  if (cropRect && Number.isFinite(cropRect.w) && Number.isFinite(cropRect.h) && cropRect.w > 0 && cropRect.h > 0) {
    const cx = round3(Math.min(1, Math.max(0, Number(cropRect.x) || 0)));
    const cy = round3(Math.min(1, Math.max(0, Number(cropRect.y) || 0)));
    const cw = round3(Math.min(1 - cx, Math.max(0, cropRect.w)));
    const ch = round3(Math.min(1 - cy, Math.max(0, cropRect.h)));
    if (cw > 0 && ch > 0) geomEffects.push({ template: `crop=w=iw*${cw}:h=ih*${ch}:x=iw*${cx}:y=ih*${cy}` });
  }
  // ---- Auto-reframe / subject-follow crop (L069: aspect-retarget primitive) ----
  // Semantic DATA `reframe` {aspect_w, aspect_h, track:[{t,cx,cy?}], blur?:[{from,to,streak_x,streak_y}]} retargets a shot to a
  // new aspect (16:9 -> 9:16) by cropping a window of the target aspect that FOLLOWS a
  // normalized 0..1 subject-center track over time, then VF_NORM scales the crop to output.
  // The crop window dims are computed from iw/ih at render (the pure builder has no source
  // dims), and the horizontal center is a piecewise-linear expr in seconds `t`. No track ->
  // static centered crop (plain "reframe to vertical"). One DATA shape gives every aspect +
  // any follow path with zero new code; WHERE the track comes from (face/person detector) is
  // a separate producer that writes the DATA, not the compositor's concern.
  if (segment.reframe) {
    const r = segment.reframe;
    const arW = Number.isFinite(r.aspect_w) ? r.aspect_w : 9;
    const arH = Number.isFinite(r.aspect_h) ? r.aspect_h : 16;
    // cover-crop: the window is the largest rect of AR arW:arH that fits inside iw x ih.
    const cropW = `min(iw\\,ih*${arW}/${arH})`;
    const cropH = `min(ih\\,iw*${arH}/${arW})`;
    // piecewise-linear normalized center from the track (t in seconds): a configuration of the
    // piecewiseExpr primitive over the chosen axis, with a per-point fallback for missing values.
    // No 0..1 clamp here (the outer clip() below bounds the pixel result).
    const pts = Array.isArray(r.track) ? r.track.filter((p) => Number.isFinite(p.t)) : [];
    const centerExpr = (key, fallback) => {
      const knots = pts.map((p) => ({ t: p.t, value: Number.isFinite(p[key]) ? p[key] : fallback }));
      if (knots.length === 0) return String(fallback);
      return piecewiseExpr(knots, { time: 't', esc: true });
    };
    // #94 Fill mode: how the retargeted frame fills the canvas. 'crop' (default) COVER-crops a
    // window that follows the subject (loses the sides). 'blur' CONTAIN-fits the whole frame and
    // fills the empty bars with a scaled-up blurred copy of itself (the Instagram/CapCut vertical
    // look, no black bars, no lost content). Any other value is treated as a solid pad COLOR. The
    // mode is DATA; adding a fill style never touches the crop math (L069).
    const fillMode = typeof r.fill_mode === 'string' ? r.fill_mode.trim() : '';
    if (fillMode === 'blur') {
      const sigma = Number.isFinite(r.fill_blur) && r.fill_blur > 0 ? r.fill_blur : 20;
      // split the source: one copy COVERS the canvas + heavy blur (the fill background), the other
      // CONTAINS (fits inside, sharp) and overlays centered. A single self-contained filtergraph;
      // the following comma-chained filters (VF_NORM etc.) continue from the overlay output.
      geomEffects.push({ template: `split=2[bgsrc][fgsrc];[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${round3(sigma)}[bg];[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2` });
    } else if (fillMode && fillMode !== 'crop') {
      geomEffects.push({ template: `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${fillMode}` });
    } else {
      const cxE = centerExpr('cx', 0.5);
      const cyE = centerExpr('cy', 0.5);
      // x,y in crop reference ow/oh (the just-computed window dims); clamp keeps it in-frame.
      const xE = `clip((${cxE})*iw-ow/2\\,0\\,iw-ow)`;
      const yE = `clip((${cyE})*ih-oh/2\\,0\\,ih-oh)`;
      geomEffects.push({ template: `crop=w=${cropW}:h=${cropH}:x='${xE}':y='${yE}'` });
      // The motion blur a shutter leaves while the crop window moves (auto-reframe.mjs planMotionBlur): each span
      // `{from, to, streak_x, streak_y}` (the smear as a share of the window) is a directional blur drawn only between
      // `from` and `to`, on the crop's own clock. The window is scaled to the output first, so a streak is pixels of
      // what is seen; a box smear of length L is a gaussian of sigma L/sqrt(12).
      const blur = Array.isArray(r.blur) ? r.blur.filter((span) => Number.isFinite(span?.from) && Number.isFinite(span?.to) && span.to > span.from) : [];
      if (blur.length) geomEffects.push({ template: `scale=${W}:${H}` });
      for (const span of blur) {
        const sx = round3((Math.max(0, Number(span.streak_x) || 0) * W) / Math.sqrt(12));
        const sy = round3((Math.max(0, Number(span.streak_y) || 0) * H) / Math.sqrt(12));
        if (sx <= 0 && sy <= 0) continue;
        geomEffects.push({ template: `gblur=sigma=${sx}:sigmaV=${sy}:enable='between(t\\,${round3(span.from)}\\,${round3(span.to)})'` });
      }
    }
  }
  // ---- Ken Burns pan/zoom (L069: still-to-motion primitive) ----
  // Semantic DATA `ken_burns` {zoom_from, zoom_to, x_from, x_to, y_from, y_to} (zoom is a
  // multiplier, x/y are the NORMALIZED 0..1 center the window pans between) compiles to a
  // zoompan whose z/x/y ramp linearly over the clip's own frame count. The DATA never carries
  // an ffmpeg expression; the engine owns the still-to-motion compilation. A single value set
  // gives zoom-in, zoom-out, pan, or a combined move with zero new code.
  if (segment.ken_burns) {
    const k = segment.ken_burns;
    const zf = Number.isFinite(k.zoom_from) ? k.zoom_from : 1;
    const zt = Number.isFinite(k.zoom_to) ? k.zoom_to : 1.25;
    const xf = Number.isFinite(k.x_from) ? k.x_from : 0.5;
    const xt = Number.isFinite(k.x_to) ? k.x_to : xf;
    const yf = Number.isFinite(k.y_from) ? k.y_from : 0.5;
    const yt = Number.isFinite(k.y_to) ? k.y_to : yf;
    // #113 Each axis is a piecewiseExpr envelope over clip-local seconds. `ken_burns.keyframes`
    // {zoom:[{t,value,interp?}], cx:[...], cy:[...]} authors an N-STOP cinematic move (zoom in, hold,
    // pan, zoom out); each keyframe can ease (#112). Absent an axis, the 2-knot from/to shorthand is
    // used (byte-identical to before). `unit:'fraction'` declares t as a fraction of the clip length.
    const secs = `(on/${fpsNum})`;
    const kf = k.keyframes && typeof k.keyframes === 'object' ? k.keyframes : null;
    const scaleT = (arr) => (k.unit === 'fraction' ? arr.map((p) => ({ ...p, t: (Number(p?.t) || 0) * clipLen })) : arr);
    const axis = (name, from, to) => {
      const list = kf && Array.isArray(kf[name]) && kf[name].length > 0
        ? scaleT(kf[name])
        : [{ t: 0, value: from }, { t: clipLen, value: to }];
      return piecewiseExpr(list, { time: '__T__' }).replaceAll('__T__', secs);
    };
    geomEffects.push({ template: `scale=${W}:${H},` + zoompanFilter(`max(1,${axis('zoom', zf, zt)})`, axis('cx', xf, xt), axis('cy', yf, yt), fpsNum) });
  }
  // ---- whole-clip orientation: rotate quarter-turns then mirror (the "shot sideways" fix + creative
  // mirror). rotate_degrees in {90,180,270} maps to transpose (90 = clockwise, 270 = counter-clockwise,
  // 180 = two turns); the downstream normalize re-fits the reoriented frame to the target aspect. flip
  // mirrors after the rotate. Both are blind DATA; absent = identity (L069/L090). ----
  // #plugin-arch Stage 5 (geometric band tail): rotate_degrees + flip append to the same ordered
  // geomEffects list (declared at the band head above), after crop/crop_rect/reframe/ken_burns, in
  // their original vf order. The list is walked ONCE here through the registry; a filter chain is
  // order-sensitive so the walk sits at the band tail, not the late effects loop. Byte-identical.
  if (segment.rotate_degrees === 90) geomEffects.push({ template: 'transpose=1' });
  else if (segment.rotate_degrees === 270) geomEffects.push({ template: 'transpose=2' });
  else if (segment.rotate_degrees === 180) geomEffects.push({ template: 'transpose=1' }, { template: 'transpose=1' });
  if (segment.flip === 'h' || segment.flip === 'hv') geomEffects.push({ template: 'hflip' });
  if (segment.flip === 'v' || segment.flip === 'hv') geomEffects.push({ template: 'vflip' });
  for (const node of geomEffects) vParts.push(resolveTemplateEffect(node.template, { W, H, fps: FPS }));
  // #146 Camera shake (creative INVERSE of #85 stabilize): crop an aspect-preserving inset window and
  // OSCILLATE its x/y offset over time, then let VF_NORM scale it back to fill (a jittered zoom). The
  // window is iw*(1-2m) x ih*(1-2m) so the aspect is preserved exactly; the offset slides in [0, 2m] of
  // the frame, i.e. swings +/- m*env around a center of m, via sin/cos at slightly different frequencies
  // so the wobble reads organic (not a clean circle). `decay`>0 fades the amplitude to 0 over the clip
  // (a single impact hit); 0 = sustained handheld rumble. ffmpeg crop x/y are per-frame `t` expressions,
  // so this is ONE animated-crop string, no keyframes, the same primitive as reframe/ken-burns (L090).
  const shake = segment.shake && typeof segment.shake === 'object' ? segment.shake : null;
  // #plugin-arch Stage 5: camera-shake resolves through the registry compute-effect map, pushed IN PLACE.
  if (shake && Number.isFinite(shake.amplitude) && shake.amplitude > 0) {
    vParts.push(COMPUTE_EFFECTS.camera_shake(shake));
  }
  if (retime) {
    // #102 A velocity ramp remaps time non-uniformly via setpts=(f(T))/TB; else uniform PTS/speed.
    vParts.push(rampExpr ? `setpts=(${rampExpr})/TB` : `setpts=PTS/${speed}`);
    // #95 Smooth slow-mo: when SLOWING with `speed_smooth`, regenerate the in-between frames with
    // motion-compensated optical-flow interpolation (the DaVinci Optical Flow / Twixtor look) instead
    // of leaving duplicated frames. Only for slow-downs (speed<1); a speed-up drops frames, no interp
    // needed. mci = motion-compensated interpolation; the DATA is just a boolean, the render is blind.
    if (speed < 1 && segment.speed_smooth === true) {
      vParts.push(COMPUTE_EFFECTS.smooth_motion());
    }
  }
  // Motion blur: blend the last N frames into each output frame (the After Effects / DaVinci
  // frame-blend look), a smear that reads as motion. `motion_blur_frames` (default 3, >=2) is the
  // strength; the render is blind to the number (L090). Applied AFTER the retime so it smears the
  // final motion; most visible on sped/fast clips, a no-op on a still frame. Complements
  // speed_smooth (interpolation for slow-downs); this is blending for the stylized fast look.
  if (segment.motion_blur === true) {
    vParts.push(COMPUTE_EFFECTS.motion_blur(segment.motion_blur_frames));
  }
  vParts.push(VF_NORM, 'setpts=PTS-STARTPTS');

  // ---- generic color-grade / look seam (L090: self-describing DATA, blind handler) ----
  // `grade` is an opaque ffmpeg video-filter string supplied by DATA (a STYLE row).
  // The compositor never knows what the look IS (teal-orange, VHS, noir, letterbox,
  // vignette, LUT via lut3d=…) — it just applies it. Infinite looks, zero code per look.
  // #plugin-arch Stage 5 (color band seed): grade + duotone collect into an ordered colorEffects list
  // walked ONCE below, at their original vf position (grade before duotone). Each node carries its OWN
  // vars: grade keeps ONLY its lutVars (a look may legitimately contain ${W}/${H}, so a global W/H/fps
  // substitution would corrupt it), duotone needs none. Byte-identical; the color band extends downward.
  const colorEffects = [];
  // #211 colour match: `colour_match: { reference, at? }` measures this clip at its in-point and the reference file
  // at `at` (default 0), and applies the per-channel transfer that makes this clip's colours match (color-match.mjs).
  // It is the first colour operation, so any look grades the already-matched picture. Numeric-only filter.
  if (segment.colour_match && typeof segment.colour_match.reference === 'string') {
    const transfer = computeColorTransfer(channelStats(segment.source, { ss: segment.in }), channelStats(segment.colour_match.reference, { ss: segment.colour_match.at }));
    colorEffects.push({ template: colorMatchFilter(transfer) });
  }
  if (typeof segment.grade === 'string' && segment.grade.trim()) {
    // An opaque look IS a `template` effect: it resolves through the registry ${var} seam. A `${LUT}`
    // placeholder + a `grade_lut_ref` stored-bytes address resolves to the shipped .cube at render time
    // (BRTK3002-clean); any other ${...} the look declares is left intact.
    const lutVars = segment.grade_lut_ref ? { LUT: materializeRef(segment.grade_lut_ref) } : {};
    colorEffects.push({ template: segment.grade.trim(), vars: lutVars });
  }
  // Each ordered layer owns its LUT. Never substitute one layer's file into
  // another layer's template; legacy grade remains the first color operation.
  if (segment.grade_layers !== undefined) {
    if (!Array.isArray(segment.grade_layers) || segment.grade_layers.length > 32)
      throw new Error('Color layers must be an ordered list of up to 32 entries.');
    for (const layer of segment.grade_layers) {
      if (!layer || typeof layer.grade !== 'string' || !layer.grade.trim() ||
          (layer.grade_lut_ref !== undefined && typeof layer.grade_lut_ref !== 'string'))
        throw new Error('Each color layer needs a filter and a valid optional LUT reference.');
      if (layer.grade.includes('${LUT}') && !layer.grade_lut_ref)
        throw new Error('A color layer is missing its LUT reference.');
      const vars = layer.grade_lut_ref ? { LUT: materializeRef(layer.grade_lut_ref) } : {};
      colorEffects.push({ template: layer.grade.trim(), vars });
    }
  }

  // #127 Duotone: map the clip's LUMA to a gradient between two colors (shadow -> highlight). Flatten to
  // gray so R=G=B=luma, then per-channel `curves` remap each channel from the shadow color's channel (at
  // luma 0) to the highlight color's channel (at luma 1). A linear chain, applied after grade so a look's
  // luma carries. Both colors are validated hex (reducer); the render re-parses. Blind DATA (L090).
  if (segment.duotone && typeof segment.duotone === 'object') {
    const lo = hexToRgbFloats(segment.duotone.shadow);
    const hi = hexToRgbFloats(segment.duotone.highlight);
    if (lo && hi) {
      colorEffects.push({ template: `format=gray,format=rgb24,curves=r='0/${lo[0]} 1/${hi[0]}':g='0/${lo[1]} 1/${hi[1]}':b='0/${lo[2]} 1/${hi[2]}'` });
    }
  }
  // #plugin-arch Stage 5: walk the color band seed once, each node with its own vars (grade -> lutVars,
  // duotone -> none). More post-normalize effects (eq/colorbalance/tint/letterbox/...) fold in above this.
  for (const node of colorEffects) vParts.push(resolveTemplateEffect(node.template, node.vars ?? {}));

  // #121 Manual color adjustment (the CapCut "Adjust" / Lumetri-basic daily driver): compose an eq=
  // filter from {brightness,contrast,saturation,gamma}, applied AFTER the grade seam so a manual tweak
  // STACKS on top of a preset look. Only non-identity terms are emitted (the reducer already dropped
  // identity values). Blind DATA (L090); this uses the SAME eq= mechanism the LOOK_CATALOG presets do.
  // #plugin-arch Stage 5: color_adjust resolves through the registry compute-effect map, pushed IN PLACE.
  const ca = segment.color_adjust && typeof segment.color_adjust === 'object' ? segment.color_adjust : null;
  if (ca) {
    const frag = COMPUTE_EFFECTS.color_adjust(ca);
    if (frag) vParts.push(frag);
  }

  // #171 Hue rotation: spin the color wheel by `degrees` (static) plus an optional `cycleRate` (deg/sec)
  // for a continuous animated rainbow cycle. ffmpeg `hue` h= accepts a `t` (seconds) expression, so a
  // cycle is h='<deg>+/-<rate>*t'. `saturation` scales chroma (1 = unchanged). Every value is numeric,
  // clamped + round3'd, so the h/s expressions carry NO free text (injection-safe). Applied after
  // color-adjust so a hue spin stacks on the corrected image. Pushed IN PLACE (L179). Blind DATA (L090).
  // #plugin-arch Stage 5: hue rotation resolves through the registry compute-effect map, pushed IN PLACE
  // (L179). The entry owns the deg/rate/sat clamp + h/s expression build and returns the fragment or null.
  const hs = segment.hue_shift && typeof segment.hue_shift === 'object' ? segment.hue_shift : null;
  if (hs) {
    const frag = COMPUTE_EFFECTS.hue_shift(hs);
    if (frag) vParts.push(frag);
  }

  // #136 Split-tone color grade (the cinematic 3-way "color wheels" look): shift the RGB balance of
  // shadows / midtones / highlights independently via ffmpeg colorbalance. Every param is a clamped
  // number (-1..1), so injection is impossible. Applied after color-adjust so it grades the corrected
  // image. Only nonzero channels are emitted; nothing pushed when the whole grade is neutral. Blind (L090).
  // #plugin-arch Stage 5: split-tone resolves through the registry compute-effect map, pushed IN PLACE
  // (L179: vParts is the ordered -vf list). Returns the colorbalance= fragment or null (neutral grade).
  const st = segment.split_tone && typeof segment.split_tone === 'object' ? segment.split_tone : null;
  if (st) {
    const frag = COMPUTE_EFFECTS.split_tone(st);
    if (frag) vParts.push(frag);
  }

  // #148/#150 Marker-synced pulses (beat sync): a DATA list of clip-local timestamps, each a transient effect
  // peaking at `at`. `kind` selects WHICH transient (L069): 'flash' (#148, default) brightens the frame,
  // 'punch' (#150) zooms it in. Both are COMPUTED timing the static grade seam cannot express (it folds an
  // arbitrary timestamp list). A triangular bump strength*max(0,1-|t-at|/halfdur) drives each; the render owns
  // the timing math, the DATA is blind scalars (L090). A beat-detector producer writes the list.
  // #plugin-arch Stage 5: the beat-reactive pulse cluster (flash/punch/shake/glitch/tint, shared bumpExpr
  // envelope) resolves through the registry; each fragment is pushed IN PLACE in the same order (L179,
  // vParts is the ordered -vf list). The kind filters + math left the compositor into createPulseEffects.
  const pulses = Array.isArray(segment.pulses) ? segment.pulses.filter((p) => p && Number.isFinite(p.at)) : [];
  for (const frag of PULSE_EFFECTS.resolve(pulses)) vParts.push(frag);

  // #149 Letterbox / cinematic bars: mask the frame to a target aspect ratio with solid bars, the bar
  // thickness COMPUTED from the frame ratio vs the target (top/bottom when the target is wider, left/right
  // when it is taller). A computed-geometry primitive a static `grade` filter cannot express portably (it
  // needs W/H). aspect default 2.39 (cinemascope); color via safeColor (injection-safe, L090).
  // #plugin-arch Stage 5: letterbox resolves through the registry compute-effect map (0 or 2 drawbox
  // fragments), each pushed IN PLACE.
  const lb = segment.letterbox && typeof segment.letterbox === 'object' ? segment.letterbox : null;
  if (lb) {
    for (const frag of COMPUTE_EFFECTS.letterbox(lb)) vParts.push(frag);
  }

  // #152 Gradient scrim: a linear darken/tint ramp toward one edge (for caption legibility), computed via geq
  // as a per-pixel blend toward the scrim color with opacity A = strength*ramp, ramp = Y/H (bottom), 1-Y/H
  // (top), X/W (right), 1-X/W (left). Distinct from the UNIFORM grade: A varies across the frame. Applied
  // before the burned caption/HUD so text sits ON the scrim. Color to RGB ints (injection-safe, L090).
  // #plugin-arch Stage 5: scrim resolves through the registry compute-effect map, pushed IN PLACE.
  const sc = segment.scrim && typeof segment.scrim === 'object' ? segment.scrim : null;
  if (sc) {
    vParts.push(COMPUTE_EFFECTS.scrim(sc));
  }

  // #153 Highlight sweep (kinetic-caption highlighter): a translucent colored box over a normalized {x,y,w,h}
  // region that WIPES left-to-right over [start, start+duration]. Same geq single-color-blend + T-in-geq family
  // (geq's time var is the capital T; `clip` is unavailable so the wipe uses min/max). A pixel is highlighted
  // iff it is in the box AND left of the wipe front bx + bw*min(1,max(0,(T-start)/dur)). Blind DATA (L090); the
  // render composites the effective list [highlight, ...highlights], one geq per highlight (many phrases).
  const highlights = [segment.highlight_sweep, ...(Array.isArray(segment.highlight_sweeps) ? segment.highlight_sweeps : [])]
    .filter((o) => o && typeof o === 'object' && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.w) && Number.isFinite(o.h) && o.w > 0 && o.h > 0);
  // #plugin-arch Stage 5: each highlight-sweep resolves through the registry compute-effect map, pushed
  // IN PLACE in list order (L179); the compositor composites the effective list [highlight, ...highlights].
  for (const hl of highlights) vParts.push(COMPUTE_EFFECTS.highlight_sweep(hl));

  // #123 Sharpen / clarity (the CapCut "Sharpen" daily driver): an unsharp mask on luma. `sharpen`
  // 0..1 scales the luma amount (0..2, a sensible unsharp range). A linear detail filter, applied
  // after color-adjust and before glow so glow blooms the sharpened highlights. Blind DATA (L090).
  if (Number.isFinite(segment.sharpen) && segment.sharpen > 0) {
    vParts.push(COMPUTE_EFFECTS.sharpen(segment.sharpen));
  }

  // #122 Self-glow / bloom (the CapCut "Glow" / cinematic bloom): the clip's own bright areas bleed a
  // soft halo. Split the stream, heavily blur one copy, and SCREEN-blend it back over the original, so
  // only highlights bloom (screen brightens toward white where the blurred highlights spread). A
  // self-contained split/blend graph (same shape as the fill_mode=blur reframe above), applied after
  // grade/color-adjust so it blooms the finished image. `glow_strength` 0..1 scales spread+intensity.
  // Blind DATA (L090); NOT a linear LOOK_CATALOG filter because it needs the parallel blur branch.
  // #plugin-arch Stage 5: glow resolves through the registry compute-effect map, pushed IN PLACE. The
  // compositor owns the `glow === true` gate; the registry entry owns the split/blur/screen-blend math.
  if (segment.glow === true) {
    vParts.push(COMPUTE_EFFECTS.glow({ strength: segment.glow_strength }));
  }

  // #156 Trails / echo: temporal persistence where each pixel keeps max(current, decay*previous), so
  // moving bright areas leave a fading light-trail (the long-exposure / persistence-of-vision look for
  // dance / music / light-painting / sports). Distinct from #motion_blur (tmix averages the last N
  // frames uniformly); this is exponential decay that lingers. A TEMPORAL-accumulation primitive the
  // per-frame stateless grade seam cannot express. `decay` 0..1 (higher = longer trails); blind DATA (L090).
  const tr = segment.trails && typeof segment.trails === 'object' ? segment.trails : null;
  if (tr && Number.isFinite(tr.decay) && tr.decay > 0) {
    vParts.push(COMPUTE_EFFECTS.trails(tr.decay));
  }

  // #157 Wobble / wave-warp: a per-frame sinusoidal horizontal displacement (underwater / dream / heat-haze).
  // Each output pixel samples the source at X + amplitude*sin(2*PI*(Y/wavelength + speed*T)), so every row
  // shifts by a phase that depends on Y (wavy down the frame) and animates with T. wavelength = H/frequency.
  // COMPUTED per-frame geometry the static grade seam cannot express. geq time var is T; coords clamped with
  // min/max (no clip); commas escaped \\, (filtergraph separator). All 3 channels share the displacement so
  // it is a clean geometric warp, not a chromatic split.
  const wob = segment.wobble && typeof segment.wobble === 'object' ? segment.wobble : null;
  if (wob && Number.isFinite(wob.amplitude) && wob.amplitude > 0) {
    vParts.push(COMPUTE_EFFECTS.wobble(wob));
  }

  // #158 Warmth ramp: an ANIMATED white-balance shift over the clip. warmth K ramps linearly from `from`
  // to `to` over [start, start+dur] (dur defaults to the clip length), then red *= (1+K), blue *= (1-K)
  // (positive K = warmer/oranger, negative = cooler/bluer). A COMPUTED time-ramp the static grade/eq seam
  // cannot express. geq time var is T; channels clamped with min(255,...); commas escaped \\,. green untouched.
  const wm = segment.warmth_ramp && typeof segment.warmth_ramp === 'object' ? segment.warmth_ramp : null;
  if (wm && Number.isFinite(wm.from) && Number.isFinite(wm.to)) {
    // #plugin-arch Stage 5: warmth-ramp resolves through the registry compute-effect map, pushed IN PLACE.
    // The entry owns the dur derivation (wm.duration | clip length) + returns null when unresolved (uniform
    // (params, timing) shape so the ordered-effects list can invoke it like spotlight/timer).
    const frag = COMPUTE_EFFECTS.warmth_ramp(wm, { duration: segment.duration, out: segment.out, in: segment.in });
    if (frag) {
      vParts.push(frag);
    }
  }

  // #159 Strobe / stop-motion: quantize motion to `rate` updates/sec by decimating to `rate` fps then
  // restoring the output fps, so each visible frame is HELD (choppy stutter) while the clip duration is
  // unchanged. Only applies when 0 < rate < output fps. Distinct from speed (duration) and motionBlur/trails.
  const strobe = segment.strobe && typeof segment.strobe === 'object' ? segment.strobe : null;
  if (strobe && Number.isFinite(strobe.rate) && strobe.rate > 0 && strobe.rate < fpsNum) {
    for (const frag of COMPUTE_EFFECTS.strobe(strobe)) vParts.push(frag);
  }

  // #160 Scanlines (CRT / retro): darken periodic horizontal lines. Each row is scaled by
  // 1 - depth*(0.5+0.5*cos(2*PI*(Y/period + roll*T))), so the dark band repeats every `period` px and, when
  // roll > 0, scrolls over time (the CRT roll). A COMPUTED per-pixel pattern the static grade seam cannot
  // express portably (needs Y + T). geq time var is T; commas escaped \\,; all channels share the attenuation.
  const sl = segment.scanlines && typeof segment.scanlines === 'object' ? segment.scanlines : null;
  if (sl && Number.isFinite(sl.depth) && sl.depth > 0) {
    vParts.push(COMPUTE_EFFECTS.scanlines(sl));
  }

  // #161 Lens fringe (radial chromatic aberration): split channels RADIALLY, zero at center, growing to the
  // corners. Red samples a point pushed OUTWARD from center by (1 + strength*normRadius), blue pushed INWARD
  // by (1 - strength*normRadius); green unchanged. normRadius = hypot(X-cx,Y-cy)/maxr. A COMPUTED per-pixel
  // geometry the linear grade seam cannot express (the uniform rgbashift preset shifts everywhere equally).
  // Sample coords clamped with min/max; commas escaped \\, (filtergraph separator).
  const lf = segment.lens_fringe && typeof segment.lens_fringe === 'object' ? segment.lens_fringe : null;
  if (lf && Number.isFinite(lf.strength) && lf.strength > 0) {
    vParts.push(COMPUTE_EFFECTS.lens_fringe(lf));
  }

  // #162 Posterize: quantize each channel to `levels` discrete steps (poster / comic / retro-print look),
  // flattening smooth gradients into bands. step = 255/(levels-1); each channel -> min(255, round(v/step)*step).
  // Distinct from the CONTINUOUS grade/eq (this reduces the color COUNT). Only levels >= 2. Commas escaped \\,.
  const po = segment.posterize && typeof segment.posterize === 'object' ? segment.posterize : null;
  if (po && Number.isFinite(po.levels) && po.levels >= 2) {
    vParts.push(COMPUTE_EFFECTS.posterize(po));
  }

  // #173 Solarize: partial per-channel tone inversion ABOVE a threshold (the darkroom / psychedelic
  // reflect-the-highlights look). thr = round(threshold*255); each channel c -> if(c > thr, 255-c, c).
  // Distinct from posterize (quantize the color count) and gradient_map (remap luma to a color ramp):
  // this reflects the highlights. One geq, numeric-only (injection-safe). Pushed IN PLACE (L179).
  const sol = segment.solarize && typeof segment.solarize === 'object' ? segment.solarize : null;
  if (sol && Number.isFinite(sol.threshold)) {
    vParts.push(COMPUTE_EFFECTS.solarize(sol));
  }

  // #174 Pixelate: quantize the whole frame into blockSize-px square blocks (retro 8-bit / mosaic look) via
  // ffmpeg's dimension-preserving `pixelize` filter. Distinct from #130 region censor (which pixelates a
  // numeric RECT): this is a full-frame stylistic quantization. Numeric-only (injection-safe). IN PLACE (L179).
  const pix = segment.pixelate && typeof segment.pixelate === 'object' ? segment.pixelate : null;
  if (pix && Number.isFinite(pix.blockSize)) {
    vParts.push(COMPUTE_EFFECTS.pixelate(pix));
  }

  // #175 Grain: composable, tunable, seeded film / sensor grain (ffmpeg `noise`). Distinct from the fixed
  // film-grain LOOK preset (layers on ANY grade at a tunable strength) and from #169 filmDamage (even grain
  // vs sparse flecks). Numeric-only (injection-safe). Pushed IN PLACE (L179).
  const grain = segment.grain && typeof segment.grain === 'object' ? segment.grain : null;
  if (grain && Number.isFinite(grain.amount)) {
    vParts.push(COMPUTE_EFFECTS.grain(grain));
  }

  // #176 Emboss: monochrome relief / engraving via a 3x3 convolution (flat tone -> mid-gray, edges -> relief).
  // Structural, not a color grade or blur. Numeric-only (injection-safe). Pushed IN PLACE (L179).
  const emboss = segment.emboss && typeof segment.emboss === 'object' ? segment.emboss : null;
  if (emboss && Number.isFinite(emboss.depth)) {
    vParts.push(COMPUTE_EFFECTS.emboss(emboss));
  }

  // #177 Defocus: uniform full-frame gaussian blur (focus pull / out-of-focus). The plain isotropic blur none
  // of the directional/radial/band/highlight blurs provide. Numeric-only (injection-safe). IN PLACE (L179).
  const defocus = segment.defocus && typeof segment.defocus === 'object' ? segment.defocus : null;
  if (defocus && Number.isFinite(defocus.amount)) {
    vParts.push(COMPUTE_EFFECTS.defocus(defocus));
  }

  // #178 Fisheye: barrel / pincushion lens distortion (optical warp, moves pixels). strength -1..1 (k1).
  // The first geometric-distortion effect. Numeric-only (injection-safe). Pushed IN PLACE (L179).
  const fisheye = segment.fisheye && typeof segment.fisheye === 'object' ? segment.fisheye : null;
  if (fisheye && Number.isFinite(fisheye.strength)) {
    vParts.push(COMPUTE_EFFECTS.fisheye(fisheye));
  }

  // #179 Warmth: static white-balance / color-temperature tint (positive warm, negative cool). Distinct from
  // warmthRamp (which animates warmth). Numeric-only (injection-safe). Pushed IN PLACE (L179).
  const warmth = segment.warmth && typeof segment.warmth === 'object' ? segment.warmth : null;
  if (warmth && Number.isFinite(warmth.amount)) {
    vParts.push(COMPUTE_EFFECTS.warmth(warmth));
  }

  // #180 Color splash (selective color): keep one hue, grey the rest (colorhold). The camelCase DATA field
  // `colorSplash` materializes to the snake-cased `color_splash` on the EDL. Color is sanitized in the
  // handler. Pushed IN PLACE (L179).
  const colorSplash = segment.color_splash && typeof segment.color_splash === 'object' ? segment.color_splash : null;
  if (colorSplash && typeof colorSplash.color === 'string') {
    vParts.push(COMPUTE_EFFECTS.colorSplash(colorSplash));
  }

  // #181 Perspective: keystone trapezoid warp (a second geometric effect after fisheye). Numeric-only
  // (injection-safe). Pushed IN PLACE (L179).
  const perspective = segment.perspective && typeof segment.perspective === 'object' ? segment.perspective : null;
  if (perspective && Number.isFinite(perspective.tilt)) {
    vParts.push(COMPUTE_EFFECTS.perspective(perspective));
  }

  // #182 Smooth: edge-preserving light smooth (smartblur "beauty"), distinct from #123 sharpen and #177
  // defocus. Numeric-only (injection-safe). Pushed IN PLACE (L179).
  const smooth = segment.smooth && typeof segment.smooth === 'object' ? segment.smooth : null;
  if (smooth && Number.isFinite(smooth.amount)) {
    vParts.push(COMPUTE_EFFECTS.smooth(smooth));
  }

  // #183 Directional blur: single-axis motion streak (avgblur), axis-selectable DATA. Numeric-only radius
  // + fixed axis keyword (injection-safe). Pushed IN PLACE (L179).
  const directionalBlur = segment.directional_blur && typeof segment.directional_blur === 'object' ? segment.directional_blur : null;
  if (directionalBlur && Number.isFinite(directionalBlur.amount)) {
    vParts.push(COMPUTE_EFFECTS.directionalBlur(directionalBlur));
  }

  // #184 Binarize: pure 1-bit black/white at a luma cutoff (notan stamp). Numeric-only (injection-safe).
  // Pushed IN PLACE (L179).
  const binarize = segment.binarize && typeof segment.binarize === 'object' ? segment.binarize : null;
  if (binarize && Number.isFinite(binarize.cutoff)) {
    vParts.push(COMPUTE_EFFECTS.binarize(binarize));
  }

  // #185 Swirl: rotational twist via geq coordinate remap (numeric-only, internal commas escaped). Pushed
  // IN PLACE (L179).
  const swirl = segment.swirl && typeof segment.swirl === 'object' ? segment.swirl : null;
  if (swirl && Number.isFinite(swirl.strength)) {
    vParts.push(COMPUTE_EFFECTS.swirl(swirl));
  }

  // #186 Mirror: kaleidoscope-style self-fold via geq coordinate remap (numeric axis keyword, escaped commas).
  // Pushed IN PLACE (L179).
  const mirror = segment.mirror && typeof segment.mirror === 'object' ? segment.mirror : null;
  if (mirror && (mirror.axis === 'h' || mirror.axis === 'v')) {
    vParts.push(COMPUTE_EFFECTS.mirror(mirror));
  }

  // #187 Tile: repeat the frame in an NxN grid via geq modulo remap (numeric count, escaped commas). Pushed
  // IN PLACE (L179).
  const tile = segment.tile && typeof segment.tile === 'object' ? segment.tile : null;
  if (tile && Number.isFinite(tile.count) && tile.count >= 2) {
    vParts.push(COMPUTE_EFFECTS.tile(tile));
  }
  // #188 invert: photographic negative (bare boolean; constant `negate` filter).
  if (segment.invert === true) {
    vParts.push(COMPUTE_EFFECTS.invert());
  }
  // #189 vibrance: nonlinear smart-saturation via the native vibrance filter (intensity != 0).
  const vibrance = segment.vibrance && typeof segment.vibrance === 'object' ? segment.vibrance : null;
  if (vibrance && Number.isFinite(vibrance.intensity) && vibrance.intensity !== 0) {
    vParts.push(COMPUTE_EFFECTS.vibrance(vibrance));
  }
  // #190 channel swap: swap two RGB channels (colorchannelmixer). camelToSnake => `channel_swap`.
  const channelSwap = segment.channel_swap && typeof segment.channel_swap === 'object' ? segment.channel_swap : null;
  if (channelSwap && typeof channelSwap.pair === 'string') {
    vParts.push(COMPUTE_EFFECTS.channelSwap(channelSwap));
  }
  // #191 exposure: brighten/darken in linear light by N stops via the native exposure filter (stops != 0).
  const exposure = segment.exposure && typeof segment.exposure === 'object' ? segment.exposure : null;
  if (exposure && Number.isFinite(exposure.stops) && exposure.stops !== 0) {
    vParts.push(COMPUTE_EFFECTS.exposure(exposure));
  }
  // #192 shear: parallelogram slant via a geq coordinate remap (amount != 0).
  const shear = segment.shear && typeof segment.shear === 'object' ? segment.shear : null;
  if (shear && Number.isFinite(shear.amount) && shear.amount !== 0) {
    vParts.push(COMPUTE_EFFECTS.shear(shear));
  }
  // #193 auto-contrast: histogram equalization via the native histeq filter (strength > 0).
  const histeq = segment.histeq && typeof segment.histeq === 'object' ? segment.histeq : null;
  if (histeq && Number.isFinite(histeq.strength) && histeq.strength > 0) {
    vParts.push(COMPUTE_EFFECTS.histeq(histeq));
  }
  // #194 morphology: dilate/erode bright regions via the native dilation/erosion filters.
  const morphology = segment.morphology && typeof segment.morphology === 'object' ? segment.morphology : null;
  if (morphology && (morphology.mode === 'dilate' || morphology.mode === 'erode')) {
    vParts.push(COMPUTE_EFFECTS.morphology(morphology));
  }
  // #195 colorize: single-hue wash via the native colorize filter (strength > 0).
  const colorize = segment.colorize && typeof segment.colorize === 'object' ? segment.colorize : null;
  if (colorize && Number.isFinite(colorize.strength) && colorize.strength > 0) {
    vParts.push(COMPUTE_EFFECTS.colorize(colorize));
  }
  // #196 normalize: auto white-balance via the native normalize filter (strength > 0).
  const normalize = segment.normalize && typeof segment.normalize === 'object' ? segment.normalize : null;
  if (normalize && Number.isFinite(normalize.strength) && normalize.strength > 0) {
    vParts.push(COMPUTE_EFFECTS.normalize(normalize));
  }
  // #197 chroma bleed: chroma-only boxblur (color smear). camelToSnake => `chroma_bleed`.
  const chromaBleed = segment.chroma_bleed && typeof segment.chroma_bleed === 'object' ? segment.chroma_bleed : null;
  if (chromaBleed && Number.isFinite(chromaBleed.radius) && chromaBleed.radius >= 1) {
    vParts.push(COMPUTE_EFFECTS.chromaBleed(chromaBleed));
  }

  // #198 RGB split: linear red/blue channel offset (chromatic glitch). camelToSnake => `rgb_split`.
  const rgbSplit = segment.rgb_split && typeof segment.rgb_split === 'object' ? segment.rgb_split : null;
  if (rgbSplit && Number.isFinite(rgbSplit.amount) && rgbSplit.amount >= 1) {
    vParts.push(COMPUTE_EFFECTS.rgbSplit(rgbSplit));
  }

  // #199 Mono mix: weighted monochrome (B&W color-filter). camelToSnake => `mono_mix`. Enabled when weights sum > 0.
  const monoMix = segment.mono_mix && typeof segment.mono_mix === 'object' ? segment.mono_mix : null;
  if (monoMix && (Number(monoMix.r) || 0) + (Number(monoMix.g) || 0) + (Number(monoMix.b) || 0) > 0) {
    vParts.push(COMPUTE_EFFECTS.monoMix(monoMix));
  }

  // #200 Faded film: lifted-blacks matte via colorlevels. camelToSnake => `faded_film`.
  const fadedFilm = segment.faded_film && typeof segment.faded_film === 'object' ? segment.faded_film : null;
  if (fadedFilm && Number.isFinite(fadedFilm.lift) && fadedFilm.lift > 0) {
    vParts.push(COMPUTE_EFFECTS.fadedFilm(fadedFilm));
  }

  // #172 Gradient map: map the clip's normalized LUMA to a MULTI-STOP color ramp (the CapCut / Premiere
  // Lumetri / DaVinci "gradient map" tonal grade). `stops` is a DATA list [{at, color}] (>= 2, sorted by
  // the reducer); each pixel's luma picks the two surrounding stops and blends their colors piecewise-
  // linearly, REPLACING color. The N-stop generalization of #127 duotone (exactly two stops). Applied in
  // the color band so a graded luma carries. Colors -> RGB ints (injection-safe, L090); at/luma numeric.
  // #plugin-arch Stage 5: gradient-map resolves through the registry compute-effect map, pushed IN PLACE.
  const gm = segment.gradient_map && typeof segment.gradient_map === 'object' ? segment.gradient_map : null;
  if (gm && Array.isArray(gm.stops) && gm.stops.length >= 2) {
    vParts.push(COMPUTE_EFFECTS.gradient_map(gm));
  }

  // #163 Halftone: comic / newspaper dot-screen. Each `size`-px cell becomes a black dot on white whose
  // radius grows as the local brightness drops. lum = Rec.601 luma; the pixel is INK (0) when its distance
  // to the cell center (normalized to the cell half-size) is below 1.42*sqrt(1-lum), so the dot AREA is
  // linear in darkness (dark = big dots, bright = none). A COMPUTED per-pixel pattern the grade seam cannot
  // express. Output is monochrome 1-bit (all channels equal). geq: mod/hypot/sqrt valid; commas escaped \\,.
  const ht = segment.halftone && typeof segment.halftone === 'object' ? segment.halftone : null;
  if (ht && Number.isFinite(ht.size) && ht.size >= 2) {
    vParts.push(COMPUTE_EFFECTS.halftone(ht));
  }

  // #164 Tilt-shift / focus band: keep a horizontal band SHARP and blur above/below it (toy-miniature /
  // subject-focus). Split the stream, blur one branch, then blend sharp inside the band and blurred outside
  // via a feathered per-pixel mask M(Y) = max(0, 1 - dOutside/feather), dOutside = how far Y is beyond the
  // band. blend all_expr A*(1-M)+B*M with A=blurred, B=sharp. A SPATIALLY-VARYING blur the uniform gblur/
  // grade seam cannot express. Unique ts* labels avoid collision with the glow/frame split-blend fragments.
  const ts = segment.tilt_shift && typeof segment.tilt_shift === 'object' ? segment.tilt_shift : null;
  if (ts && Number.isFinite(ts.height) && ts.height > 0) {
    vParts.push(COMPUTE_EFFECTS.tilt_shift(ts));
  }

  // #165 Sketch / edge-detect: render the frame as line-art or a cartoon-shaded drawing. edgedetect finds
  // edges; mode selects the look ('colormix' = cartoon shading over the image, 'canny'/'wires' = white
  // lines on black). strength 0..1 lowers the detector thresholds so more/busier edges are found. mode is
  // ALLOWLISTED to edgedetect's fixed capability set (Physics of the filter, not a Society enum) so no free
  // text reaches the filter graph. Applied as a whole-frame look, post-VF_NORM. Blind DATA (L090).
  const sk = segment.sketch && typeof segment.sketch === 'object' ? segment.sketch : null;
  if (sk) {
    vParts.push(COMPUTE_EFFECTS.sketch(sk));
  }

  // #167 Zoom / radial blur: motion streaks radiating from a center point (the "speed zoom" hype look). geq
  // has no radial-blur primitive, so this AVERAGES TAPS sampled toward the center: out = mean over k of
  // src(cx+(X-cx)*f_k, cy+(Y-cy)*f_k), f_k stepping from 1 down to 1-spread. spread = 0.26*strength (a 26%
  // inward pull at full strength). Between the pixel and the shrunk copies the average smears along the radial
  // line, which reads as zoom streaks. A spatially-varying resample the uniform gblur/tilt-shift cannot make.
  // geq's coords are clamped with min/max (no clip); commas are \\, in the filtergraph; all inputs numeric
  // (spread/center rounded), so no free text reaches the graph. Blind DATA (L090).
  const zb = segment.zoom_blur && typeof segment.zoom_blur === 'object' ? segment.zoom_blur : null;
  if (zb && Number.isFinite(zb.strength) && zb.strength > 0) {
    vParts.push(COMPUTE_EFFECTS.zoom_blur(zb));
  }

  // #168 Light leak: a soft colored bloom of light bleeding in from a point (the film "light leak" look). A
  // radial falloff A = strength*max(0, 1 - dist/radiusPx) around the source (x,y) is SCREEN-blended with the
  // leak color: out = 255-(255-src)*(255-color*A)/255, which LIGHTENS toward the color, strongest at the
  // point and fading to identity (A=0) far away. Distinct from spotlight (radial DARKEN) and scrim (linear
  // edge darken): this ADDS colored light. geq uses X/Y (no time); commas \\,; color via colorToRgb255 and
  // all geometry numeric (rounded), so no free text hits the graph. Blind DATA (L090).
  const ll = segment.light_leak && typeof segment.light_leak === 'object' ? segment.light_leak : null;
  if (ll && Number.isFinite(ll.strength) && ll.strength > 0) {
    vParts.push(COMPUTE_EFFECTS.light_leak(ll));
  }

  // #169 Film damage (old-film look): flickering vertical scratch lines and dust specks that JUMP position
  // each frame. drawbox cannot do this (its expressions split on the comma inside mod/if/lt in a -vf graph),
  // so it is built in geq, which handles escaped commas. geq has no frame-number var, so the per-frame index
  // is fk = floor(T*fps); each scratch/dust uses a distinct prime seed to jump independently, and a per-frame
  // hash lt(mod(fk*p,10),thr) makes it flicker on and off. Scratches ADD light (bright vertical lines,
  // abs(X-col)<1); dust SUBTRACTS light (dark specks, hypot(X-dx,Y-dy)<size). The same delta is applied to
  // all channels (monochrome flecks). All inputs numeric, commas \\,, so no free text hits the graph (L090).
  const fd = segment.film_damage && typeof segment.film_damage === 'object' ? segment.film_damage : null;
  if (fd && ((Number.isFinite(fd.scratches) && fd.scratches > 0) || (Number.isFinite(fd.dust) && fd.dust > 0))) {
    vParts.push(COMPUTE_EFFECTS.film_damage(fd));
  }

  // #125 Spotlight / positioned radial focus: darken the frame away from a chosen center to pull the
  // eye to a subject. A POSITIONED vignette (x0/y0 accept w/h expressions), so it is distinct from the
  // fixed centered `vignette` look: cx/cy place the focus anywhere, strength scales the falloff angle.
  // Applied late (after grade/color/sharpen/glow), before the border. Blind DATA (L090).
  // #plugin-arch Stage 5: the spotlight (incl. #154 keyframed follow track) resolves through the registry
  // compute-effect map, pushed IN PLACE (L179). The entry owns the cx/cy/angle + piecewise-track build; the
  // compositor owns the strength>0 gate and passes the segment timing that resolves the track length.
  const spot = segment.spotlight && typeof segment.spotlight === 'object' ? segment.spotlight : null;
  if (spot && Number.isFinite(spot.strength) && spot.strength > 0) {
    vParts.push(COMPUTE_EFFECTS.spotlight(spot, { duration: segment.duration, out: segment.out, in: segment.in }));
  }

  // #124 Border / frame: draw a solid colored border inside the clip's edges (drawbox with thickness),
  // ON TOP of every effect so the frame is never blurred/graded away. width px at the canvas scale; the
  // color is DATA, sanitized to ffmpeg color chars (name / 0xRRGGBB / #RRGGBB / name@alpha). Blind (L090).
  // #plugin-arch Stage 5: border resolves through the registry compute-effect map, pushed IN PLACE (L179).
  const border = segment.border && typeof segment.border === 'object' ? segment.border : null;
  if (border && Number.isFinite(border.width) && border.width > 0) {
    vParts.push(COMPUTE_EFFECTS.border(border));
  }

  // #126 Framed clip (Screen Studio / CleanShot look): shrink the (already bordered/graded) clip to
  // `scale` and center it on a background so it sits inside padding. Pushed LAST so the whole finished
  // clip (incl. #124 border) is what gets framed. background 'blur' fills the bars with a blurred zoomed
  // copy (same graph as the reframe fill_mode=blur); any other value is a solid pad color (sanitized).
  // #plugin-arch Stage 5: the framed-clip look resolves through the registry compute-effect map, pushed IN
  // PLACE (L179). The entry owns the shrink/blur-bg-vs-pad build; the compositor owns the 0<scale<1 gate.
  const frame = segment.frame && typeof segment.frame === 'object' ? segment.frame : null;
  if (frame && Number.isFinite(frame.scale) && frame.scale > 0 && frame.scale < 1) {
    vParts.push(COMPUTE_EFFECTS.frame(frame));
  }

  // #129 Drop shadow (Screen Studio "floating card"): shrink the clip to `scale`, cast a blurred offset
  // dark copy behind it on `background`, and overlay the sharp card on top. A self-contained compositing
  // subgraph (a split of the single input: one branch is the sharp card, the other becomes the shadow
  // layer = a solid `color` rect at the card size, padded onto the `background` canvas at the offset
  // position, then blurred so its edges bleed softly). No extra input source. Superset of #126 frame.
  // Both `color` and `background` are sanitized to ffmpeg color chars (drawbox/pad args), blind (L090).
  // #plugin-arch Stage 5: the drop shadow (incl. #134 rounded card) resolves through the registry compute-
  // effect map, pushed IN PLACE (L179). The entry owns the shrink/shadow/blur/rounded-card subgraph build;
  // the compositor owns the 0<scale<1 gate.
  const shadow = segment.drop_shadow && typeof segment.drop_shadow === 'object' ? segment.drop_shadow : null;
  if (shadow && Number.isFinite(shadow.scale) && shadow.scale > 0 && shadow.scale < 1) {
    vParts.push(COMPUTE_EFFECTS.drop_shadow(shadow));
  }

  // #128 Rounded corners (Screen Studio / Arc "beautiful card" finisher): round the FINAL composited
  // frame (after border + frame), filling the four cut corners with `background`. `radius` is a 0..0.5
  // fraction of the shorter side, so R (px) = radius * min(W,H). A pixel is in a cut corner iff it is
  // within R of BOTH a vertical and a horizontal edge AND beyond the corner arc (dx^2+dy^2 > R^2);
  // that geometry is a per-pixel geq single-color replace over rgb (no alpha/extra input, one linear
  // filter). The corner color is PARSED to RGB ints (0..255), so a hostile DATA value can never inject
  // filtergraph syntax (worst case it falls back to black). Blind (L090); dropped when radius <= 0.
  // #plugin-arch Stage 5: rounded corners (incl. #133 feather) resolve through the registry compute-effect
  // map, pushed IN PLACE (L179). The entry owns the corner-geometry geq build; the compositor owns the gate.
  const rounded = segment.rounded_corners && typeof segment.rounded_corners === 'object' ? segment.rounded_corners : null;
  if (rounded && Number.isFinite(rounded.radius) && rounded.radius > 0) {
    vParts.push(COMPUTE_EFFECTS.rounded_corners(rounded));
  }

  // #131 Ellipse / circle mask: show the clip through an ellipse (iris reveal, circular video, oval
  // spotlight) and fill everything OUTSIDE it with `background`. Same geq single-color-replace family as
  // #128 rounded corners: a pixel is outside when ((X-CX)/RX)^2 + ((Y-CY)/RY)^2 > 1 (CX/CY the pixel
  // center, RX/RY the pixel radii). The bg is PARSED to RGB ints, so injection is impossible. Blind (L090).
  // #plugin-arch Stage 5: the ellipse mask (incl. #135 iris reveal, #132 feather) resolves through the
  // registry compute-effect map, pushed IN PLACE (L179). The entry owns the ellipse-ratio geq + reveal-factor
  // build; the compositor owns the rx>0 && ry>0 gate.
  const ellipse = segment.ellipse_mask && typeof segment.ellipse_mask === 'object' ? segment.ellipse_mask : null;
  if (ellipse && Number.isFinite(ellipse.rx) && ellipse.rx > 0 && Number.isFinite(ellipse.ry) && ellipse.ry > 0) {
    vParts.push(COMPUTE_EFFECTS.ellipse_mask(ellipse));
  }

  // #130 Region filter / censor: apply an OPAQUE ffmpeg filter to only a normalized sub-rectangle, then
  // composite it back (split -> crop the region -> filter it -> overlay at the same spot). Blur a face,
  // pixelate a plate, black out private info, or apply ANY effect locally. The region is numeric (rounded
  // + bounds-clamped, even dims for yuv420p), so only the OPAQUE `filter` is free DATA -- the same L090/L111
  // opaque seam as grade / denoise / viz_filter (authored by the UI presets or the AI worker). Blind (L090).
  // #137 The effective region list = the singular region_filter (n=1) followed by any region_filters array.
  // ONE loop composites all of them (blur a face AND pixelate a plate AND black out a badge), so the render
  // has no per-region branch: each element is its own split -> crop -> opaque filter -> overlay, chained on
  // the running stream. `rf${i}` labels keep every stage's pads distinct.
  const singleRegion = segment.region_filter && typeof segment.region_filter === 'object' ? segment.region_filter : null;
  const regionList = Array.isArray(segment.region_filters) ? segment.region_filters : [];
  const regions = [...(singleRegion ? [singleRegion] : []), ...regionList];
  regions.forEach((region, i) => {
    if (!region || typeof region !== 'object' || typeof region.filter !== 'string' || !region.filter.trim()
        || !Number.isFinite(region.w) || region.w <= 0 || !Number.isFinite(region.h) || region.h <= 0) return;
    const c01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    let cw = Math.max(2, Math.round((W * c01(region.w)) / 2) * 2);
    let ch = Math.max(2, Math.round((H * c01(region.h)) / 2) * 2);
    let cx = Math.round(W * c01(region.x));
    let cy = Math.round(H * c01(region.y));
    cx = Math.min(cx, W - cw); cy = Math.min(cy, H - ch); // keep the crop fully inside the frame
    if (cx < 0) { cx = 0; cw = Math.min(cw, W); }
    if (cy < 0) { cy = 0; ch = Math.min(ch, H); }
    const eff = region.filter.trim();
    // #138 Tracking motion: when `motion` {toX,toY,start,duration} is present, the crop AND overlay x/y
    // become per-frame ffmpeg expressions that slide from the start rect to the end rect linearly over
    // [start, start+duration] (crop x/y are per-frame expressions in ffmpeg 8; overlay x/y accept `t`).
    // The end position is clamped inside the frame too. Commas inside clip(...) are escaped (\\,) because
    // vParts is joined into -vf by commas. Static (no motion) keeps the exact positional form (no regression).
    // #139 Keyframe path (precedence path > motion > static): build a piecewise-linear per-frame expression
    // over N waypoint pixel positions, so the censor traces an arbitrary route. Each `coords[i]` at time
    // `times[i]`; before the first waypoint hold coords[0], after the last hold coords[last], between two
    // waypoints lerp. Commas escaped (\\,) for the -vf comma-join.
    // #140 Ease: wrap a raw 0..1 interpolation factor expression with an acceleration curve. 'smooth' =
    // smoothstep (f*f*(3-2f), accel+decel), 'in' = f*f (accel), 'out' = 1-(1-f)^2 (decel); default linear.
    // The factor is inlined (ffmpeg exprs have no cheap local vars), so smooth repeats it 3x -- fine.
    const easeVal = region.ease === 'smooth' || region.ease === 'in' || region.ease === 'out' ? region.ease : null;
    const easeFac = (f) => {
      if (easeVal === 'smooth') return `(${f}*${f}*(3-2*${f}))`;
      if (easeVal === 'in') return `(${f}*${f})`;
      if (easeVal === 'out') return `(1-(1-${f})*(1-${f}))`;
      return f;
    };
    const buildPathExpr = (coords, times) => {
      const segments = coords.slice(1).map((next, k) => {
        const dt = round3(times[k + 1] - times[k]);
        return dt > 0 ? `${coords[k]}+(${next - coords[k]})*${easeFac(`(t-${round3(times[k])})/${dt}`)}` : String(coords[k]);
      });
      return chooseByThreshold('t', times.map(round3), [coords[0], ...segments, coords[coords.length - 1]], '\\,');
    };
    const path = Array.isArray(region.path) && region.path.length >= 2 ? region.path : null;
    const mot = region.motion && typeof region.motion === 'object' && Number.isFinite(region.motion.duration) && region.motion.duration > 0 ? region.motion : null;
    // #141 Opacity fade: build a per-frame 0..1 opacity expression (T = clip-relative seconds after setpts).
    // in ramps up from 0; out ramps down before the clip end (needs segment.duration). min() combines both.
    let op = null;
    const fade = region.fade && typeof region.fade === 'object' ? region.fade : null;
    if (fade) {
      const opParts = [];
      const inS = Number(fade.in);
      const outS = Number(fade.out);
      // Clip display length (seconds, after setpts resets to 0): explicit duration, else the trim span out-in.
      const clipDur = Number.isFinite(segment.duration) && segment.duration > 0
        ? segment.duration
        : (Number.isFinite(segment.out) && Number.isFinite(segment.in) && segment.out > segment.in ? segment.out - segment.in : null);
      if (Number.isFinite(inS) && inS > 0) opParts.push(`clip(T/${round3(inS)}\\,0\\,1)`);
      if (Number.isFinite(outS) && outS > 0 && clipDur !== null) {
        opParts.push(`clip((${round3(clipDur)}-T)/${round3(outS)}\\,0\\,1)`);
      }
      if (opParts.length === 1) op = opParts[0];
      else if (opParts.length === 2) op = `min(${opParts[0]}\\,${opParts[1]})`;
    }
    // Unified position expression: path (piecewise) > motion (2-point) > static (constant). `moving` marks
    // when the expr form is needed; a pure-static no-fade region keeps the exact legacy positional emit.
    let xE, yE, moving = false;
    if (path) {
      const times = path.map((p) => Math.max(0, Number(p.at) || 0));
      const xs = path.map((p) => Math.min(Math.max(0, Math.round(W * c01(p.x))), W - cw));
      const ys = path.map((p) => Math.min(Math.max(0, Math.round(H * c01(p.y))), H - ch));
      xE = buildPathExpr(xs, times); yE = buildPathExpr(ys, times); moving = true;
    } else if (mot) {
      const ex = Math.min(Math.max(0, Math.round(W * c01(mot.toX))), W - cw);
      const ey = Math.min(Math.max(0, Math.round(H * c01(mot.toY))), H - ch);
      const start = round3(Math.max(0, Number(mot.start) || 0));
      const dur = round3(mot.duration);
      const fac = easeFac(`clip((t-${start})/${dur}\\,0\\,1)`);
      xE = `${cx}+(${ex - cx})*${fac}`; yE = `${cy}+(${ey - cy})*${fac}`; moving = true;
    } else {
      xE = String(cx); yE = String(cy);
    }
    // #142 Mode 'outside' = spotlight: the filter hits the WHOLE FRAME (dim/desaturate) and the ORIGINAL region
    // is overlaid back on top, so the region pops. Reuses the same position (xE/yE) and fade (op). 'inside'
    // (default) is the censor: filter the region, keep the frame.
    // #plugin-arch Stage 5: the split/crop/opaque-filter/overlay emit resolves through the registry compute-
    // effect map, pushed IN PLACE (L179). The entry owns the outside/inside branch + fade-blend + position
    // form assembly; the compositor owns the per-region geometry/position/fade math above.
    vParts.push(COMPUTE_EFFECTS.region_filter({ i, mode: region.mode, moving, op, eff, cw, ch, cx, cy, xE, yE }));
  });

  // #143 Animated progress bar: a colored band along the top/bottom that fills left-to-right over the clip
  // (T = clip-relative secs after setpts; D = clip display length = duration or out-in). Same geq single-color-
  // replace + T-in-geq family as #128/#135, so it is per-frame with no crop-size issue. Color parsed to RGB
  // ints (injection-safe, L090). A pixel is bar iff it is in the edge band AND X < W*T/D.
  // #plugin-arch Stage 5: the progress bar (incl. #145 chapter markers) resolves through the registry
  // compute-effect map, pushed IN PLACE (L179). The entry owns the band/fill/marker geq build and returns
  // the fragment or null (display length unresolved); the compositor owns the height>0 gate + segment timing.
  const pb = segment.progress_bar && typeof segment.progress_bar === 'object' ? segment.progress_bar : null;
  if (pb && Number.isFinite(pb.height) && pb.height > 0) {
    const frag = COMPUTE_EFFECTS.progress_bar(pb, { duration: segment.duration, out: segment.out, in: segment.in });
    if (frag) vParts.push(frag);
  }

  // #147 Countdown ring: a circular arc HUD that sweeps clockwise from 12 o'clock over the clip (the
  // Instagram-story / intro countdown the LINEAR #143 progress bar cannot express). Same geq single-color-
  // replace + T-in-geq HUD family, but POLAR: a pixel is on the ring iff its distance from the center is in
  // the [R-w, R+w] band AND its clockwise angle-from-top is <= the swept fraction of a full turn. `mode`
  // 'fill' GROWS the arc (elapsed), 'deplete' SHRINKS it (a true countdown, the default). radius/thickness
  // are fractions of the short side; x/y the normalized center. Color to RGB ints (injection-safe, L090).
  // #plugin-arch Stage 5: the countdown ring resolves through the registry compute-effect map, pushed IN
  // PLACE (L179). The entry owns the polar geq build and returns the fragment or null (display length
  // unresolved); the compositor owns the presence gate + segment timing.
  const cr = segment.countdown_ring && typeof segment.countdown_ring === 'object' ? segment.countdown_ring : null;
  if (cr) {
    const frag = COMPUTE_EFFECTS.countdown_ring(cr, { duration: segment.duration, out: segment.out, in: segment.in });
    if (frag) vParts.push(frag);
  }
  // #144 Live timer: a drawtext with EXPANSION (unlike the static caption's textfile+expansion=none) so
  // ffmpeg evaluates the time token per frame. 'elapsed' = %{pts:hms} counting up; 'countdown' = the whole
  // seconds remaining ceil(D-t) via %{eif}. Colons/commas in the token are escaped (\:, \,) for the -vf join.
  // Position reuses the pad->pixel corner mapping; color via safeColor (injection-safe, L090).
  // #plugin-arch Stage 5: the timer HUD resolves through the registry compute-effect map, pushed IN PLACE
  // (L179). The entry owns the size/color/corner/countdown-token build; the compositor owns the mode gate
  // and passes the segment timing ({duration,out,in}) that resolves the countdown duration.
  const tm = segment.timer && typeof segment.timer === 'object' ? segment.timer : null;
  if (tm && (tm.mode === 'elapsed' || tm.mode === 'countdown')) {
    vParts.push(COMPUTE_EFFECTS.timer(tm, { duration: segment.duration, out: segment.out, in: segment.in }));
  }

  // #78 Chroma key on a spine clip: apply the opaque key filter, then flatten the keyed color
  // to black (a standalone spine clip has no layer behind it, so the keyed color reads as black).
  // A green-screen REVEAL over real footage is the video_overlays composite (a keyed video over
  // the spine); this clip-level seam is the same DATA value, blind (L090).
  if (typeof segment.chroma_key === 'string' && segment.chroma_key.trim()) {
    vParts.push(COMPUTE_EFFECTS.chroma_key(segment.chroma_key));
  }

  // ---- caption overlay (L090: text rides the clip transform, burned via drawtext) ----
  // A per-clip caption is the SAME mechanism as a split source label: inline `text`
  // is written to a textfile (sidesteps ffmpeg escaping) and drawn on the normalized
  // WxH frame. The compositor never knows the caption MEANS anything (Physics); the
  // {text, corner, size, color} is Society DATA riding the clip transform.
  if (segment.label && segment.label.text) {
    const lf = join(T, `label-${segment.id}.txt`);
    writeFileSync(lf, translateText(String(segment.label.text), segment.label.translate));
    vParts.push(drawtextFilter({ ...segment.label, textfile: lf }, H));
  }

  // ---- audio chain ----
  // #107 A ramp mutes clip audio by default; `speed_ramp_audio: true` opts into retiming the
  // audio THROUGH the ramp (per-span atempo, preprocessed below) so it stays in sync.
  const rampAudio = rampExpr !== null && segment.speed_ramp_audio === true;
  const silent = Boolean(still) || segment.silent_audio || segment.muted || (rampExpr !== null && !rampAudio) || !fileHasAudio(segment.source);
  const aParts = [];
  // #76 Reverse the audio to mirror the reversed video (FIRST, so the rest of the chain
  // rides the reversed signal).
  if (!silent && reversed) aParts.push('areverse');
  // #75 Noise reduction as DATA (the audio twin of `grade`): `denoise` is either an
  // opaque in-graph ffmpeg audio-filter string (afftdn/arnndn/anlmdn/highpass...),
  // applied blind + FIRST so downstream gain/fades ride the cleaned signal, OR a key
  // into DENOISE_PREPROCESSORS (deepfilternet), which cleans via an external binary.
  const denoise = typeof segment.denoise === 'string' ? segment.denoise.trim() : '';
  const denoisePre = denoise ? DENOISE_PREPROCESSORS[denoise] : undefined;
  let cleanedAudio = null;
  if (!silent && denoise && denoisePre) cleanedAudio = denoisePreprocess(segment, denoisePre, seek);
  if (!silent && denoise && !denoisePre) aParts.push(denoise);
  // #107 Ramped audio replaces the whole retime tempo step: the preprocessor bakes per-span
  // atempo + concat into a replacement WAV (input 1 in the mux, like external denoise). When
  // it fails, fall back to silent via the anullsrc path below (fail-soft, never desynced audio).
  let rampedAudio = null;
  if (!silent && rampAudio) {
    rampedAudio = rampAudioPreprocess(segment, rampCumulative(rampPts).pts, seek, srcLen);
    if (rampedAudio) cleanedAudio = rampedAudio;
    else aParts.push('volume=0'); // fail-soft: mute rather than play desynced un-retimed audio
  }
  if (!silent && retime && rampExpr === null) aParts.push(...atempoChain(speed));
  // scalar per-clip gain (identity 1). A keyframed `volume` envelope still rides the
  // generic keyframe seam below; this is the constant-gain convenience for an inspector.
  if (!silent && typeof segment.volume === 'number' && segment.volume >= 0 && segment.volume !== 1) {
    aParts.push(`volume=${round3(segment.volume)}`);
  }

  // ---- generic keyframe envelopes (property-agnostic evaluator + binding seam) ----
  for (const [property, points] of Object.entries(segment.keyframes ?? {})) {
    const binding = KEYFRAME_BINDINGS[property];
    if (!binding) throw new Error(`[video.compose] clip ${segment.id} keyframes unknown property ${JSON.stringify(property)} (no registered binding)`);
    const expr = envelopeExpr(points, clipLen);
    if (binding.stream === 'video') vParts.push(binding.filter(expr));
    else if (!silent) aParts.push(binding.filter(expr));
  }

  // ---- blind effect-node dispatch (recursive plugin architecture, plan 2026-08-06) ----
  // An ORDERED `segment.effects` list is the emergent end-state the flat effect fields resolve onto. The
  // compositor NEVER names an effect: resolveEffectFragment dispatches by SELF-DESCRIBING DATA (L090), not a
  // kind enum, so the node's shape names its capability: `template` = an opaque ${var}-substituted -vf string
  // (the Johnny path); `effect_id` = a keyframe-envelope capability (opacity/volume/zoom/rotate); `compute` =
  // ANY of the 33 registry compute effects (glow/spotlight/scanlines/drop_shadow/...) via the uniform
  // (params, timing) convention. So an authored list stacks ANY effect in ANY order/count as pure DATA (the
  // L069 combinatorial explosion, zero code per combination). A node yields 0 (neutral/null), 1, or N -vf
  // fragments. Nothing emits this list yet (flat fields remain the active path), so existing renders are
  // byte-identical; this path is purely additive and cannot change a flat-field render.
  // `look_stack` names a multi-effect LOOK preset (DATA): its effect nodes are prepended to the clip's own
  // ordered `effects`, so a preset applies its whole stack then explicit per-clip effects layer on top. Pure
  // DATA, zero per-look code (L069). Both fields are optional and additive (a flat-field render is untouched).
  const effectNodes = [
    ...resolveLookStack(segment.look_stack),
    ...(Array.isArray(segment.effects) ? segment.effects : []),
  ];
  for (const node of effectNodes) {
    const { stream, fragments } = resolveEffectFragment(node, {
      keyframeEffects: KEYFRAME_BINDINGS,
      computeEffects: COMPUTE_EFFECTS,
      compileEnvelope: (pts) => envelopeExpr(pts, clipLen),
      timing: { duration: segment.duration, out: segment.out, in: segment.in },
      vars: { W, H, fps: FPS, clipLen, ...(node.params ?? {}) },
    });
    const target = stream === 'video' ? vParts : (silent ? null : aParts);
    if (target) for (const frag of fragments) target.push(frag);
  }

  // ---- edge fades (video + audio), placed on the FINAL clip-local timeline ----
  if (Number.isFinite(segment.fade_in_s) && segment.fade_in_s > 0) {
    vParts.push(COMPUTE_EFFECTS.fade_in(segment.fade_in_s));
    if (!silent) aParts.push(`afade=t=in:st=0:d=${round3(segment.fade_in_s)}`);
  }
  if (Number.isFinite(segment.fade_out_s) && segment.fade_out_s > 0) {
    // #102 fix (D4): a ramped clip's real length is outLen (remapped), not clipLen; the
    // out-fade must start relative to the REMAPPED end or it fires early on a velocity curve.
    const st = round3(Math.max(0, outLen - segment.fade_out_s));
    vParts.push(COMPUTE_EFFECTS.fade_out(st, segment.fade_out_s));
    if (!silent) aParts.push(`afade=t=out:st=${st}:d=${round3(segment.fade_out_s)}`);
  }

  // #76 Freeze-frame / hold: clone the first or last frame for `duration` seconds (LAST, so
  // it holds the final composed frame). Audio holds silence over the freeze: a tail freeze
  // pads silence after, a head freeze delays the audio in by the hold length.
  if (freezeDur > 0) {
    vParts.push(COMPUTE_EFFECTS.freeze(freezeMode, freezeDur));
    if (!silent) aParts.push(freezeMode === 'start' ? `adelay=${Math.round(freezeDur * 1000)}|${Math.round(freezeDur * 1000)}` : `apad=pad_dur=${freezeDur}`);
  }

  // #100 Audio effect chain: an OPAQUE ffmpeg audio-filter chain (EQ/compressor/de-reverb/de-esser/
  // pitch/"Studio Sound") the render appends blind (L090). After denoise/volume, before loudnorm, so
  // the effect is normalized. A full ;/,-joined chain is one entry; the render never parses it.
  if (!silent && typeof segment.audio_filters === 'string' && segment.audio_filters.trim()) {
    aParts.push(segment.audio_filters.trim());
  }

  // #202 Echo / reverb: add spatial depth (delayed copies) to the clip audio. Resolves through the registry
  // compute-effect map and is pushed IN PLACE into the audio chain (L179), after audio_filters and before
  // loudnorm so the wet signal is normalized. Gated on a positive amount; the entry owns the aecho fragment.
  if (!silent && segment.echo && typeof segment.echo === 'object') {
    const frag = COMPUTE_EFFECTS.echo(segment.echo);
    if (frag) aParts.push(frag);
  }

  // #93 Loudness normalization (EBU R128 loudnorm): normalize this clip's perceived loudness to a
  // target integrated LUFS (-14 social default; DATA, so -16 podcast / -23 broadcast are just values).
  // Last in the chain so it measures the final mixed clip audio. The render is blind to the number.
  if (!silent && segment.loudnorm !== undefined && segment.loudnorm !== false) {
    const lufs = typeof segment.loudnorm === 'number' ? segment.loudnorm : -14;
    aParts.push(`loudnorm=I=${round3(lufs)}:TP=-1.5:LRA=11`);
  }

  // `frames`: the composed picture's last frame is held past its end (when the source runs short) and the output
  // stops at exactly that many frames; the sound is padded and cut to the same seconds.
  const exactLen = frameCount ? frameCount / fpsNum : null;
  if (frameCount) {
    vParts.push(`tpad=stop_mode=clone:stop=${frameCount}`);
    if (!silent) aParts.push(`apad=whole_dur=${exactLen}`, `atrim=end=${exactLen}`);
  }

  const sourceFrameRate = segment.source_frame_rate;
  if (sourceFrameRate !== undefined && (!Number.isFinite(sourceFrameRate) || sourceFrameRate <= 0))
    throw new Error('[video.compose] source_frame_rate must be finite and positive.');
  const inputRate = sourceFrameRate === undefined ? [] : ['-framerate', String(sourceFrameRate)];
  const ffArgs = [...inputRate, ...seek, '-i', segment.source];
  if (silent) {
    // #102 fix (D3): the silent track must span the FULL final video length: the ramped
    // output length PLUS any freeze extension (tpad grows the video by freezeDur), or
    // `-shortest` truncates the freeze/ramp tail against a too-short anullsrc.
    ffArgs.push('-f', 'lavfi', '-t', String(exactLen ?? outLen + freezeDur), '-i', 'anullsrc=r=48000:cl=stereo',
      '-vf', vParts.join(','), '-map', '0:v', '-map', '1:a', '-shortest');
  } else if (cleanedAudio) {
    // External-denoised audio: take video from input 0, audio from the cleaned WAV
    // (input 1). The cleaned track is already trimmed by the same seek at extract.
    ffArgs.push('-i', cleanedAudio, '-vf', vParts.join(','), '-map', '0:v', '-map', '1:a');
    if (aParts.length > 0) ffArgs.push('-af', aParts.join(','));
  } else {
    ffArgs.push('-vf', vParts.join(','));
    if (aParts.length > 0) ffArgs.push('-af', aParts.join(','));
  }
  ff([...ffArgs, ...(frameCount ? ['-frames:v', String(frameCount)] : []), ...V, ...A, out], `clip ${segment.id}`);
  // #89 Loop / boomerang: repeat the built clip N times (odd copies reversed when boomerang).
  const loopCount = Number.isInteger(segment.loop_count) && segment.loop_count > 1 ? segment.loop_count : 1;
  push(loopCount > 1 ? buildClipLoop(out, loopCount, segment.loop_boomerang === true) : out);
}

/**
 * PURE property-agnostic keyframe envelope. Points are {t (clip-local seconds), value, interp?
 * linear|hold}. A configuration of piecewiseExpr over the `__T__` placeholder that KEYFRAME_BINDINGS
 * substitutes with each stream's own time symbol. Adding a NEW animatable property is ONE entry in
 * KEYFRAME_BINDINGS; this compiler never knows property names (enum dissolution / L090). `clipLen`
 * is retained for the binding contract but the domain is carried entirely by the point times.
 */
export function envelopeExpr(points, _clipLen) {
  if (!Array.isArray(points) || points.length === 0) throw new Error('[video.compose] keyframe envelope needs at least one point');
  return piecewiseExpr(points, { time: '__T__', esc: false });
}

/**
 * Property → filter binding seam (the injected-capability map of
 * 1000x-enum-dissolution.md). The envelope compiler is property-agnostic; a
 * property becomes animatable by registering ONE binding row here — the clip
 * builder dispatches generically and never branches on property names. `expr`
 * arrives with the `__T__` placeholder; the binding substitutes its stream's
 * time symbol (video filters use T, the volume filter uses t).
 */
// #plugin-arch The keyframe-envelope effects now live in the effect-registry as `compute`
// capabilities (opacity/volume/zoom/rotate), dispatched blindly by the loop below. The compositor
// injects its own fpsNum + zoompanFilter leaf, so the registry owns no compositor state. Adding an
// animatable property is a registry row (or a `template` DATA record), zero edit to this file.
const KEYFRAME_BINDINGS = createKeyframeEffects({ fpsNum, zoompanFilter });

/** base_span: a span of the continuous base with overlays riding on top for their windows. */
function buildBaseSpan(segment) {
  const out = segPath();
  const start = segment.src_in;
  const duration = +(segment.src_out - segment.src_in).toFixed(4);
  const { input, hasAudio } = baseInputArgs(['-ss', String(start), '-t', String(duration)]);
  const overlays = (edl.overlays ?? []).filter((o) =>
    o.at_src >= start - 0.01 && o.at_src < segment.src_out);

  const inputs = [...input];
  let fc = `[0:v]${VF_NORM},setpts=PTS-STARTPTS[bv]`;
  let cur = 'bv';
  overlays.forEach((overlay, index) => {
    const idx = index + 1;
    const relStart = +(overlay.at_src - start).toFixed(2);
    const relEnd = +(Math.min(overlay.end_src, segment.src_out) - start).toFixed(2);
    const windowLength = +(relEnd - relStart).toFixed(2);
    inputs.push('-i', overlay.source);
    fc += `;[${idx}:v]${VF_NORM},trim=0:${windowLength},setpts=PTS-STARTPTS+${relStart}/TB[s${idx}]`;
    fc += `;[${cur}][s${idx}]overlay=0:0:enable='between(t,${relStart},${relEnd})'[o${idx}]`;
    cur = `o${idx}`;
  });
  // Audio: the base's own track when present; a silent track otherwise
  // (appended AFTER the overlay inputs so their indexes stay stable).
  if (!hasAudio) inputs.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo');
  const audioMap = hasAudio ? '0:a' : `${overlays.length + 1}:a`;
  ff([...inputs, '-filter_complex', fc, '-map', `[${cur}]`, '-map', audioMap, ...V, ...A, out], `base_span ${segment.id}`);
  push(out);
}

/** chapter_insert — a sub-timeline: tail (from base, voice) > inserts (silent) +
 *  title overlay + scrim > black card > resume (from base, voice), with its own music bed. */
function buildChapterInsert(segment) {
  const sub = (edl.chapter_inserts ?? []).find((c) => c.id === segment.source_chapter ?? segment.id) ??
    (edl.chapter_inserts ?? []).find((c) => c.id === segment.id);
  if (!sub) throw new Error(`[video.compose] chapter_insert ${segment.id} has no matching edl.chapter_inserts entry`);

  // Pre-built chapter artifact: normalize and use (the build-chapter output path).
  if (sub.artifact) {
    const out = segPath();
    ff(['-i', sub.artifact, '-vf', VF_NORM, ...V, ...A, out], `chapter ${sub.id} (artifact)`);
    push(out);
    return;
  }

  const parts = [];
  const part = (name) => join(T, `${sub.id}-${name}.mp4`);
  const tailS = sub.tail_s ?? 7;
  const resumeS = sub.resume_s ?? 7;

  // tail from the base WITH its voice (silent track when the base has none)
  const baseAudioArgs = baseHasAudio
    ? []
    : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-shortest'];
  ff(['-ss', String(sub.cut - tailS), '-t', String(tailS), '-i', edl.base.artifact, ...baseAudioArgs,
    '-vf', VF_NORM, ...V, ...A, part('tail')], `chapter ${sub.id} tail`);
  parts.push(part('tail'));

  // inserts (silent) — any number, any source (b-roll etc.)
  (sub.inserts ?? []).forEach((insert, index) => {
    ff(['-i', insert.source, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(insert.duration ?? 4), '-vf', VF_NORM, '-map', '0:v', '-map', '1:a', '-shortest',
      ...V, ...A, part(`insert${index}`)], `chapter ${sub.id} insert ${index}`);
    parts.push(part(`insert${index}`));
  });

  // black card
  if (sub.black_card) {
    const cardDuration = sub.black_card.duration ?? 3;
    ff(['-f', 'lavfi', '-t', String(cardDuration), '-i', `color=black:s=${W}x${H}:r=${FPS}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(cardDuration),
      '-vf', 'format=yuv420p', '-shortest', ...V, ...A, part('card')], `chapter ${sub.id} card`);
    parts.push(part('card'));
  }

  // interlude concat (inserts + card) with optional title overlay + scrim
  const interludeParts = parts.slice(1);
  let interlude = null;
  if (interludeParts.length > 0) {
    const listFile = join(T, `${sub.id}-il.txt`);
    writeFileSync(listFile, interludeParts.map((p) => `file '${p}'`).join('\n') + '\n');
    interlude = part('broll');
    ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', interlude], `chapter ${sub.id} interlude concat`);
    if (sub.title_overlay) {
      const t = sub.title_overlay;
      const assFile = join(T, `${sub.id}.ass`);
      writeFileSync(assFile, `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,${t.font ?? 'Apple Garamond'},${t.size ?? 76},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,${t.spacing ?? -3},0,1,0,0,5,200,200,0,1
[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:${String(t.show_s ?? 11).padStart(2, '0')}.00,T,,,,,${t.text}
`);
      const titled = part('inter');
      const scrim = t.scrim_opacity ?? 0.12;
      ff(['-i', interlude, '-filter_complex',
        `color=black@${scrim}:s=${W}x${H}:r=${FPS}:d=${t.show_s ?? 11}[scr];[0:v][scr]overlay=shortest=1[bg];[bg]ass=${assFile}${t.fontsdir ? `:fontsdir=${t.fontsdir}` : ''}[v]`,
        '-map', '[v]', '-map', '0:a', ...V, '-c:a', 'copy', titled], `chapter ${sub.id} title`);
      interlude = titled;
    }
  }

  // resume from the base WITH its voice (silent track when the base has none)
  ff(['-ss', String(sub.resume), '-t', String(resumeS), '-i', edl.base.artifact, ...baseAudioArgs,
    '-vf', VF_NORM, ...V, ...A, part('resume')], `chapter ${sub.id} resume`);

  // body concat: tail + interlude + resume
  const bodyList = join(T, `${sub.id}-body.txt`);
  writeFileSync(bodyList, [parts[0], ...(interlude ? [interlude] : []), part('resume')].map((p) => `file '${p}'`).join('\n') + '\n');
  const body = part('body');
  ff(['-f', 'concat', '-safe', '0', '-i', bodyList, '-c', 'copy', body], `chapter ${sub.id} body concat`);

  // chapter music bed (qsin fades, delayed under the tail, padded to the chapter length)
  let final = body;
  if (sub.music) {
    const m = sub.music;
    const music = part('music');
    ff(['-ss', String(m.trim_in ?? 0), '-t', String(m.duration ?? 17), '-i', m.artifact, '-af',
      `volume=${m.volume ?? 0.85},afade=t=in:st=0:d=${m.fade_in_d ?? 2.5}:curve=qsin,afade=t=out:st=${m.fade_out_st ?? 12.5}:d=${m.fade_out_d ?? 2.5}:curve=qsin,adelay=${m.delay_ms ?? 4500}|${m.delay_ms ?? 4500},apad=whole_dur=${m.pad_to_s ?? 25}`,
      '-ar', '48000', '-ac', '2', music.replace(/\.mp4$/, '.wav')], `chapter ${sub.id} music`);
    final = part('final');
    ff(['-i', body, '-i', music.replace(/\.mp4$/, '.wav'), '-filter_complex',
      '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...A, final], `chapter ${sub.id} mix`);
  }
  push(final);
}

/** split — compose N sources into one frame (side-by-side / stacked / grid),
 *  driven purely by EDL data (sources[], layout h|v|grid, weights[]). Audio is the
 *  mix of every source that carries a track (silent when none) — probed, never
 *  assumed. The you-vs-a-pro sports split and a 4-up product grid are the SAME
 *  mechanism, different DATA (no domain code). */
function buildSplit(segment) {
  const out = segPath();
  const specs = (segment.sources ?? []).map((s) => (typeof s === 'string' ? { source: s } : s));
  const sources = specs.map((s) => s.source);
  if (sources.length === 0) throw new Error(`[video.compose] split ${segment.id} has no sources`);

  // SPATIAL per-source transforms (crop/label). TEMPORAL speed is SEGMENT-uniform.
  // Label text is written to a file here (I/O layer) and passed to the pure builder as
  // a `textfile` path — using textfile, not text=, sidesteps ffmpeg's escaping entirely.
  const transforms = specs.map((s, i) => {
    const t = { crop: s.crop };
    if (s.flip) t.flip = s.flip;
    if (s.label && s.label.text) {
      const lf = join(T, `label-${segment.id}-${i}.txt`);
      writeFileSync(lf, translateText(String(s.label.text), s.label.translate));
      t.label = { ...s.label, textfile: lf };
    }
    return t;
  });
  const speed = typeof segment.speed === 'number' ? segment.speed : 1;
  const anySped = speed > 0 && speed !== 1;

  const layout = buildSplitLayout({
    count: sources.length,
    layout: segment.layout ?? 'h',
    weights: segment.weights,
    width: W,
    height: H,
    fps: FPS,
    speed,
    sources: transforms,
  });

  // Per-source trim: in/out seek per source (objects), else the segment-wide duration.
  const inputs = [];
  specs.forEach((s) => {
    const seek = [];
    if (Number.isFinite(s.in)) seek.push('-ss', String(s.in));
    if (Number.isFinite(s.out)) seek.push('-t', String(+(s.out - (s.in ?? 0)).toFixed(3)));
    else if (segment.duration) seek.push('-t', String(segment.duration));
    inputs.push(...seek, '-i', s.source);
  });

  // Audio: a sped split is silent by design (setpts only retimes video; the music bed
  // rides the spine). Otherwise mix the tracks of every source that has one (silent if
  // none — the silent input is appended LAST so the video input indexes stay stable).
  const audioSources = anySped
    ? []
    : sources.map((src, i) => ({ i, has: fileHasAudio(src) })).filter((a) => a.has);
  let fc = layout.filter;
  let audioMap;
  if (audioSources.length > 0) {
    fc += `;${audioSources.map((a) => `[${a.i}:a]`).join('')}amix=inputs=${audioSources.length}:duration=longest:normalize=0[aout]`;
    audioMap = '[aout]';
  } else {
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    audioMap = `${sources.length}:a`;
  }
  ff([...inputs, '-filter_complex', fc, '-map', `[${layout.videoLabel}]`, '-map', audioMap,
    '-shortest', ...V, ...A, out], `split ${segment.id}`);
  push(out);
}

/** A generic text card: solid-color background + N centered lines, held for a
 * duration. Hook / CTA / chapter-title / caption cards are the SAME mechanism with
 * different DATA (L069). Pure geometry/escaping lives in card-layout.mjs; here we do
 * I/O only: write each line's text to a file (textfile sidesteps ffmpeg escaping) and
 * render the lavfi color source. Cards are silent (the spine's music bed rides over
 * them, like a sped split). */
function buildCard(segment) {
  const out = segPath();
  const lines = (segment.lines ?? []).map((line, i) => {
    if (!line || typeof line.text !== 'string' || line.text === '') {
      throw new Error(`[video.compose] card ${segment.id} line ${i} has no text`);
    }
    if (line.font_file !== undefined && (typeof line.font_file !== 'string' || /['\\]/.test(line.font_file))) {
      throw new Error(`[video.compose] card ${segment.id} line ${i} font_file must be a path without quotes or backslashes`);
    }
    const lf = join(T, `card-${segment.id}-${i}.txt`);
    writeFileSync(lf, translateText(line.text, line.translate));
    return { textfile: lf, size: line.size ?? Math.round(H * 0.06), color: line.color, gap: line.gap, font_file: line.font_file, border_px: line.border_px, border_color: line.border_color };
  });
  const duration = typeof segment.duration === 'number' ? segment.duration : 3;
  const { lavfi, vf } = buildCardLayout({ width: W, height: H, fps: FPS, duration, bg: segment.bg, lines });
  // `audio_source` is the card's sound: an opaque lavfi audio source (a room tone such as anoisesrc), silence when absent.
  const sound = typeof segment.audio_source === 'string' && segment.audio_source.trim() ? segment.audio_source.trim() : 'anullsrc=r=48000:cl=stereo';
  ff(['-f', 'lavfi', '-i', lavfi,
    '-f', 'lavfi', '-i', sound,
    '-vf', vf, '-t', String(duration), '-map', '0:v', '-map', '1:a',
    '-shortest', ...V, ...A, out], `card ${segment.id}`);
  push(out);
}

// ---- build the spine ----
// Segment kind -> builder is a DATA-keyed capability map, NOT an if/else chain: a new
// segment kind registers ONE entry here (enum dissolution). The dispatcher never
// enumerates kinds in branches.
const SEGMENT_BUILDERS = {
  clip: buildClip,
  base_span: buildBaseSpan,
  chapter_insert: buildChapterInsert,
  card: buildCard,
  split: buildSplit,
};

console.log(`[video.compose] base=${edl.base?.kind ?? 'video'} segments=${edl.spine.segments.length} overlays=${(edl.overlays ?? []).length} chapters=${(edl.chapter_inserts ?? []).length}`);
// Track flags (contract::edl): edl.tracks[] rows carry {id, hidden, muted}.
// A segment referencing a hidden track (track_id) — or flagged hidden itself —
// is skipped generically; a muted track silences its segments. The compositor
// never knows what a track "means" (Physics); the flags are Society DATA.
const trackById = new Map((edl.tracks ?? []).map((t) => [t.id, t]));
// #114 The DATA segment behind each rendered spine file (aligned 1:1 with `segments`), so a
// detached-audio (split-edit) clip can be placed on the timeline after the spine is assembled.
const renderedSegs = [];
for (const segment of edl.spine.segments) {
  const track = segment.track_id != null ? trackById.get(segment.track_id) : undefined;
  if (segment.hidden === true || track?.hidden === true) continue;
  const builder = SEGMENT_BUILDERS[segment.kind];
  if (!builder) throw new Error(`[video.compose] unknown segment kind ${JSON.stringify(segment.kind)} (${segment.id})`);
  const seg = track?.muted === true ? { ...segment, muted: true } : segment;
  const before = segments.length;
  builder(seg);
  for (let k = before; k < segments.length; k += 1) renderedSegs.push(seg);
}

const spineList = join(T, 'list.txt');
const spine = join(T, 'spine.mp4');
// ---- UNIVERSAL TRANSITION PRIMITIVE (L069 clay, not LEGO) ----------------------------------------
// A transition is self-describing DATA `{renderer, spec, expr?, command?, duration}`. The in-between of
// a boundary is RENDERED AS A SEGMENT by a renderer CAPABILITY dispatched through this injected map (the
// engine never enumerates transition types, per L090/enum-dissolution), then concatenated with the
// clips' trimmed middles. `xfade`/`expr` are built-in convenience capabilities; `process` shells ANY
// binary via a DATA command template (${A} ${B} ${OUT} ${DUR} ${W} ${H} ${FPS}), so gl-transitions GLSL,
// RIFE/FILM AI-morph, or a renderer invented tomorrow is just a DATA row with ZERO engine change.
// Closure: a process renderer can invoke a binary that itself composes renderers. Deletion test: drop
// xfade+expr and a `process` row still produces every transition. No transitions means hard-cut concat.
let trSeq = 0;
const trPath = () => join(T, `tr${String(trSeq++).padStart(4, '0')}.mp4`); // transition helpers get their own names (segPath advances only on push)
function subclip(src, ss, dur) {
  const out = trPath();
  ff(['-ss', String(ss), '-t', String(dur), '-i', src, '-vf', VF_NORM, ...V, ...A, out], 'transition subclip');
  return out;
}
// #plugin-arch Stage 2: the transition renderers now live in the effect-registry as OUT-OF-PROCESS
// capabilities (xfade/expr/process), dispatched blindly by `spec.renderer` in renderTransition below.
// The compositor injects its I/O leaf; adding a renderer (gl-transition, RIFE morph) is a DATA row.
const TRANSITION_RENDERERS = createTransitionRenderers({ trPath, ff, V, A, W, H, FPS, materializeRef, execFileSync });
function renderTransition(a, b, dur, spec) {
  const renderer = (spec && spec.renderer) || 'xfade';
  const fn = TRANSITION_RENDERERS[renderer];
  if (!fn) throw new Error(`[video.compose] unknown transition renderer ${JSON.stringify(renderer)}; renderer is DATA, register a capability (xfade|expr|process|...)`);
  return fn(a, b, dur, spec || {});
}

const transitions = edl.spine?.transitions;
if (Array.isArray(transitions) && transitions.length > 0 && segments.length > 1) {
  const n = segments.length;
  const durs = segments.map((f) => probeDuration(f));
  const d = [];
  const cutFloor = 2 / (fpsNum || 30);
  for (let i = 0; i < n - 1; i += 1) {
    const tr = transitions[i] ?? null;
    const cand = tr && tr.duration > 0 ? round3(Math.min(tr.duration, durs[i], durs[i + 1])) : 0;
    d[i] = cand > cutFloor ? cand : 0;
  }
  const pieces = [];
  for (let i = 0; i < n; i += 1) {
    const head = i > 0 ? d[i - 1] : 0;
    const tail = i < n - 1 ? d[i] : 0;
    const midDur = round3(durs[i] - head - tail);
    if (midDur > 0.02) pieces.push(subclip(segments[i], head, midDur));
    if (i < n - 1 && d[i] > 0) {
      const aTail = subclip(segments[i], round3(durs[i] - d[i]), d[i]);
      const bHead = subclip(segments[i + 1], 0, d[i]);
      pieces.push(renderTransition(aTail, bHead, d[i], transitions[i]));
    }
  }
  const list = join(T, 'trans-list.txt');
  writeFileSync(list, pieces.map((p) => `file '${p}'`).join('\n') + '\n');
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', spine], 'transition concat');
} else {
  writeFileSync(spineList, segments.map((p) => `file '${p}'`).join('\n') + '\n');
  ff(['-f', 'concat', '-safe', '0', '-i', spineList, '-c', 'copy', spine], 'spine concat');
}

// ---- audio graph: optional music bed over the spine + optional replace_audio ----
const audio = edl.audio_graph ?? {};
let mixed = spine;
// #114 Split-edit (J-cut / L-cut): detach a clip's RENDERED audio and shift it on the timeline. The
// clip's own audio is gated to silence over its natural spine window, then re-added as a narration-
// shaped placement at videoStart+offset (reusing the audio.narration primitive, no new mix code).
// Because the detached artifact is the rendered segment, it carries whatever the clip produced (speed,
// ramp, freeze, reverse), so every one composes with zero special case. Timeline start = cumulative
// rendered length minus transition overlaps (the spine's own d[] math). Applied only when the rendered
// clip files align 1:1 with their DATA segments, so a builder emitting a different count is untouched.
if (renderedSegs.length === segments.length && renderedSegs.some((s) => splitEditOffset(s) !== null)) {
  const segDurs = segments.map((f) => probeDuration(f));
  const trs = edl.spine?.transitions;
  const cutFloor = 2 / (fpsNum || 30);
  const overlap = [];
  for (let i = 0; i < segments.length - 1; i += 1) {
    const tr = Array.isArray(trs) ? (trs[i] ?? null) : null;
    const cand = tr && tr.duration > 0 ? round3(Math.min(tr.duration, segDurs[i], segDurs[i + 1])) : 0;
    overlap[i] = cand > cutFloor ? cand : 0;
  }
  const detached = [];
  const gateWindows = [];
  let acc = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const start = round3(acc);
    acc += segDurs[i] - (overlap[i] ?? 0);
    const seg = renderedSegs[i];
    const off = splitEditOffset(seg);
    if (off === null) continue;
    gateWindows.push([start, round3(start + segDurs[i])]);
    detached.push({
      artifact: segments[i],
      in: 0,
      out: segDurs[i],
      start: round3(Math.max(0, start + off)),
      volume: Number.isFinite(seg.volume) ? seg.volume : 1,
    });
  }
  if (detached.length > 0) {
    const gated = join(T, 'spine-splitgate.mp4');
    const en = gateWindows.map(([s, e]) => `between(t,${round3(s)},${round3(e)})`).join('+');
    ff(['-i', mixed, '-af', `volume=0:enable='${en}'`, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', ...A, gated], 'split-edit spine gate');
    mixed = gated;
    audio.narration = [...(audio.narration ?? []), ...detached];
  }
}
if (audio.music_bed) {
  const m = audio.music_bed;
  mixed = join(T, 'mixed.mp4');
  // The music chain: trim to the bed window, qsin edge fades, scalar volume, pad to length.
  const musicChain =
    `[1:a]atrim=${m.trim?.[0] ?? 0}:${m.trim?.[1] ?? 31.5},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=${m.fade_in?.st ?? 0}:d=${m.fade_in?.d ?? 2}:curve=${m.fade_in?.curve ?? 'qsin'},` +
    `afade=t=out:st=${m.fade_out?.st ?? 27.5}:d=${m.fade_out?.d ?? 4}:curve=${m.fade_out?.curve ?? 'qsin'},` +
    `volume=${m.volume ?? 0.9}${m.apad === false ? '' : ',apad'}[m]`;
  // Ducking (DATA `m.duck`): sidechaincompress the music, KEYED by the spine speech,
  // so the bed drops automatically under speech already present in the spine and swells back in the gaps. The
  // narration/TTS pass runs later, so those layers do not key this compressor unless pre-baked into the spine.
  // spine audio is asplit so one copy keys the compressor and one stays in the mix. `duck`
  // may be `true` (defaults) or an object overriding threshold/ratio/attack/release (L090).
  let filter;
  if (m.duck) {
    const d = typeof m.duck === 'object' ? m.duck : {};
    const sc = `threshold=${d.threshold ?? 0.015}:ratio=${d.ratio ?? 20}:attack=${d.attack ?? 5}:release=${d.release ?? 250}`;
    filter =
      `[0:a]asplit=2[spmix][spkey];${musicChain};` +
      `[m][spkey]sidechaincompress=${sc}[mduck];` +
      '[spmix][mduck]amix=inputs=2:duration=first:normalize=0[a]';
  } else {
    filter = `${musicChain};[0:a][m]amix=inputs=2:duration=first:normalize=0[a]`;
  }
  ff(['-i', spine, '-i', m.artifact, '-filter_complex', filter,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...A, mixed], 'music bed mix');
}
// #99 NARRATION: mix each TTS/voiceover clip over the program at its own start time. Every entry
// is DATA {artifact, start, in, out, volume, fade_in?, fade_out?, duck?}; the render trims to [in,out], fades, adelays to `start`, sets
// volume, and amixes all narration streams over the spine audio. Placed AFTER the music bed so voice
// rides over both spine and bed. Blind to the engine that produced the audio (macos-say/espeak/...).
if (Array.isArray(audio.narration) && audio.narration.length > 0) {
  const nar = audio.narration;
  const narrated = join(T, 'narrated.mp4');
  // Resolve each entry to a real audio file: use its `artifact` if present, else GENERATE it at
  // render time from the `tts_text` descriptor via the DATA-selected engine (tts-narrate producer).
  // This is why the UI can stay pure-DATA: it authors the text, the render makes the voice (L069).
  const ttsBin = fileURLToPath(new URL('./tts-narrate.mjs', import.meta.url));
  const narFiles = nar.map((n, k) => {
    if (n.artifact) return n.artifact;
    if (typeof n.tts_text === 'string' && n.tts_text.trim()) {
      const out = join(T, `narr-${k}.wav`);
      const a = [ttsBin, n.tts_text, out, n.tts_producer || 'macos-say'];
      if (n.tts_voice) a.push(n.tts_voice);
      execFileSync('node', a, { stdio: ['ignore', 'ignore', 'inherit'] });
      return out;
    }
    throw new Error(`narration entry ${k} has neither artifact nor tts_text`);
  });
  const narInputs = narFiles.flatMap((f) => ['-i', f]);
  const chains = nar.map((n, k) => {
    const inS = Number.isFinite(n.in) ? n.in : 0;
    const outS = Number.isFinite(n.out) && n.out > inS ? n.out : undefined;
    const trim = outS !== undefined ? `atrim=${round3(inS)}:${round3(outS)},` : '';
    const delayMs = Math.max(0, Math.round((Number(n.start) || 0) * 1000));
    const vol = Number.isFinite(n.volume) ? n.volume : 1;
    // Edge fades (DATA `fade_in` / `fade_out` seconds) on the placed stretch, before it is delayed into place; the
    // fade-out needs the stretch's length, read from the file when `out` is not given.
    const length = (outS ?? probeDuration(narFiles[k])) - inS;
    const fadeIn = Number.isFinite(n.fade_in) && n.fade_in > 0 ? `afade=t=in:st=0:d=${round3(Math.min(n.fade_in, length))}:curve=qsin,` : '';
    const fadeOut = Number.isFinite(n.fade_out) && n.fade_out > 0 && length > 0
      ? `afade=t=out:st=${round3(Math.max(0, length - n.fade_out))}:d=${round3(Math.min(n.fade_out, length))}:curve=qsin,` : '';
    // `level: {lufs, gain_db: [lowest, highest]}` brings the placed stretch to `lufs` integrated loudness, measured on
    // that stretch as heard (stereo), the gain held between the two dB bounds. `audio_filters` is an opaque ffmpeg
    // audio chain (a limiter, an EQ) run after the level and before the fades.
    const level = narrationLevel(n, narFiles[k], inS, length, k);
    const filters = typeof n.audio_filters === 'string' && n.audio_filters.trim() ? `${n.audio_filters.trim()},` : '';
    // input 0 is `mixed`, so narration input k is at ffmpeg index k+1
    return `[${k + 1}:a]${trim}asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${level}${filters}${fadeIn}${fadeOut}adelay=${delayMs}|${delayMs},volume=${round3(vol)}[n${k}]`;
  });
  // Ducking (DATA `duck` on a placement, `true` or {threshold, ratio, attack, release}): a ducked placement is
  // sidechain-compressed, KEYED by everything heard that does not duck (the program so far and every other
  // placement), so music drops under the video's speech and under a voice-over, and swells back in the gaps.
  const ducked = nar.map((n, k) => (n.duck ? k : -1)).filter((k) => k >= 0);
  let filter;
  if (ducked.length === 0) {
    const mixLabels = ['[0:a]', ...nar.map((_, k) => `[n${k}]`)].join('');
    filter = `${chains.join(';')};${mixLabels}amix=inputs=${nar.length + 1}:duration=first:normalize=0[a]`;
  } else {
    const heard = [0, ...nar.map((_, k) => k + 1).filter((i) => !ducked.includes(i - 1))];
    const label = (i) => (i === 0 ? '[0:a]' : `[n${i - 1}]`);
    const splits = heard.map((i) => `${label(i)}asplit=2[h${i}mix][h${i}key]`);
    const key = heard.length === 1
      ? `[h${heard[0]}key]anull[speech]`
      : `${heard.map((i) => `[h${i}key]`).join('')}amix=inputs=${heard.length}:duration=first:normalize=0[speech]`;
    const keys = ducked.length === 1 ? '[speech]anull[key0]' : `[speech]asplit=${ducked.length}${ducked.map((_, j) => `[key${j}]`).join('')}`;
    const compressed = ducked.map((k, j) => {
      const d = typeof nar[k].duck === 'object' ? nar[k].duck : {};
      const sc = `threshold=${d.threshold ?? 0.015}:ratio=${d.ratio ?? 20}:attack=${d.attack ?? 5}:release=${d.release ?? 250}`;
      return `[n${k}][key${j}]sidechaincompress=${sc}[d${k}]`;
    });
    const mixLabels = [...heard.map((i) => `[h${i}mix]`), ...ducked.map((k) => `[d${k}]`)].join('');
    filter = [...chains, ...splits, key, keys, ...compressed, `${mixLabels}amix=inputs=${nar.length + 1}:duration=first:normalize=0[a]`].join(';');
  }
  ff(['-i', mixed, ...narInputs, '-filter_complex', filter,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...A, narrated], 'narration mix');
  mixed = narrated;
}
if (audio.replace_audio) {
  const replaced = join(T, 'replaced.mp4');
  ff(['-i', mixed, '-i', audio.replace_audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...A, '-shortest', replaced], 'replace audio');
  mixed = replaced;
}

// ---- text overlays: first-class timeline TEXT elements -------------------------------------
// A text overlay is self-describing DATA `{text, x, y, start, end, size?, color?}` — the SAME
// {x,y} position primitive as a clip caption, but with its OWN time range on the global
// timeline (independent of any clip), so you can place MULTIPLE texts at different times and
// positions (the true generative primitive: text is an element, not a per-clip property).
// Each becomes a drawtext gated by `enable='between(t,start,end)'` over the concatenated video.
// Reuses the injection-safe `drawtextFilter`; text via textfile (escaping-free). t is the
// final-timeline seconds after concat, so start/end are lane seconds 1:1.
const textOverlays = (Array.isArray(edl.text_overlays) ? edl.text_overlays : [])
  .filter((o) => o && typeof o.text === 'string' && o.text.trim());
if (textOverlays.length > 0) {
  const texted = join(T, 'texted.mp4');
  const filters = textOverlays.map((o, i) => {
    const lf = join(T, `overlay-text-${i}.txt`);
    writeFileSync(lf, translateText(String(o.text), o.translate_to ? { to: o.translate_to, producer: o.translate_producer ?? 'glossary', glossary: o.translate_glossary } : undefined));
    // #101 A tracked text overlay follows the subject: x/y become the normalized-track expression
    // centered on the text box (`*w-text_w/2`), via drawtextFilter's x_expr/y_expr override.
    const tXe = o.track ? trackNormExpr(o.track, 'x') : null;
    const tYe = o.track ? trackNormExpr(o.track, 'y') : null;
    const start = Number.isFinite(o.start) ? Math.max(0, o.start) : 0;
    const end = Number.isFinite(o.end) ? o.end : 1e9;
    // #115 Entrance / exit motion: x, y, alpha are keyframed envelopes over timeline seconds `t`,
    // compiled by the ONE piecewiseExpr primitive (slide = x/y envelope, fade = alpha envelope, pop =
    // an overshoot envelope). x/y knots are NORMALIZED 0..1 (same placement primitive as static x/y).
    // Named presets (slide-left, fade, pop) are DATA rows that generate these knots, never code enums.
    const kf = o.keyframes && typeof o.keyframes === 'object' ? o.keyframes : null;
    const env = (arr) => piecewiseExpr(arr, { time: 't', esc: true });
    const xNorm = kf && Array.isArray(kf.x) && kf.x.length > 0 ? env(kf.x) : null;
    const yNorm = kf && Array.isArray(kf.y) && kf.y.length > 0 ? env(kf.y) : null;
    const base = drawtextFilter({
      textfile: lf, x: o.x, y: o.y, size: o.size, color: o.color, box: o.box, box_color: o.box_color,
      // A keyframed axis overrides a track binding (explicit motion wins); else the track; else static.
      x_expr: xNorm ? undefined : (tXe ? `(${tXe})*w-text_w/2` : undefined),
      y_expr: yNorm ? undefined : (tYe ? `(${tYe})*h-text_h/2` : undefined),
      x_norm_expr: xNorm ?? undefined,
      y_norm_expr: yNorm ?? undefined,
    }, H);
    // Alpha is ONE piecewiseExpr path: an explicit alpha envelope, else fade_in/fade_out expanded to
    // a trapezoid envelope (0->1 over fade_in, hold, 1->0 over fade_out), else full opacity (no alpha).
    const fi = Number.isFinite(o.fade_in) && o.fade_in > 0 ? o.fade_in : 0;
    const fo = Number.isFinite(o.fade_out) && o.fade_out > 0 && Number.isFinite(o.end) ? o.fade_out : 0;
    let alphaKnots = kf && Array.isArray(kf.alpha) && kf.alpha.length > 0 ? kf.alpha : null;
    if (!alphaKnots && (fi > 0 || fo > 0)) {
      alphaKnots = [{ t: round3(start), value: fi > 0 ? 0 : 1 }];
      if (fi > 0) alphaKnots.push({ t: round3(start + fi), value: 1 });
      if (fo > 0) alphaKnots.push({ t: round3(end - fo), value: 1 });
      alphaKnots.push({ t: round3(end), value: fo > 0 ? 0 : 1 });
    }
    const alpha = alphaKnots ? `:alpha='clip(${env(alphaKnots)}\\,0\\,1)'` : '';
    return `${base}${alpha}:enable='between(t,${round3(start)},${round3(end)})'`;
  });
  ff(['-i', mixed, '-vf', filters.join(','), ...V, '-c:a', 'copy', texted], 'text overlays');
  mixed = texted;
}

// ---- image overlays: the shape/arrow/callout/sticker/logo primitive (L069 enum-dissolution) --
// An image overlay is self-describing DATA `{image_ref|image_path, x?, y?, width?|scale?, opacity?,
// start?, end?, rotate?}`. Because a SHAPE IS DATA (a PNG/SVG raster), the compositor never
// enumerates box/line/arrow/handwriting-callout/logo/sticker: EVERY annotation is one image
// overlay row, zero new code per kind. x/y are ffmpeg overlay exprs (numbers or 'W-w-24' etc.,
// default centered), gated to a time window like text overlays. Rotation (radians) turns a
// straight arrow asset into a pointer at any angle. The arrow-plus-handwriting-label L162 idiom
// is one image overlay (the arrow) plus one text overlay (the label).
for (const [batchIndex, batch] of visualOverlayBatches(edl).entries()) {
const imageOverlays = (batch.kind === 'image' ? batch.items : [])
  .filter((o) => o && (typeof o.image_ref === 'string' || typeof o.image_path === 'string'));
if (imageOverlays.length > 0) {
  const imaged = join(T, `imaged-${batchIndex}.mp4`);
  const inputs = ['-i', mixed];
  const chains = [];
  let cur = '0:v';
  imageOverlays.forEach((o, i) => {
    const src = typeof o.image_ref === 'string' ? materializeRef(o.image_ref) : o.image_path;
    inputs.push('-i', src);
    const inIdx = i + 1;
    // pre-process the image: optional scale (width px or scale factor), rotate, opacity.
    const pre = [];
    if (Number.isFinite(o.width)) pre.push(`scale=${Math.round(o.width)}:-1`);
    else if (Number.isFinite(o.scale) && o.scale > 0) pre.push(`scale=iw*${o.scale}:-1`);
    if (Number.isFinite(o.rotate) && o.rotate !== 0) pre.push(`rotate=${o.rotate}:c=none:ow=rotw(${o.rotate}):oh=roth(${o.rotate})`);
    pre.push('format=rgba');
    const opacity = Number.isFinite(o.opacity) ? Math.max(0, Math.min(1, o.opacity)) : 1;
    if (opacity < 1) pre.push(`colorchannelmixer=aa=${opacity}`);
    // Animated callout: fade the image alpha in/out within its window (the fade `st` is on the
    // FINAL timeline, matching the overlay enable window).
    const startForFade = Number.isFinite(o.start) ? Math.max(0, o.start) : 0;
    if (Number.isFinite(o.fade_in) && o.fade_in > 0) pre.push(`fade=t=in:st=${round3(startForFade)}:d=${round3(o.fade_in)}:alpha=1`);
    if (Number.isFinite(o.fade_out) && o.fade_out > 0 && Number.isFinite(o.end)) pre.push(`fade=t=out:st=${round3(o.end - o.fade_out)}:d=${round3(o.fade_out)}:alpha=1`);
    chains.push(`[${inIdx}:v]${pre.join(',')}[img${i}]`);
    // #101 If the overlay carries a `track` [{t,x,y}] path, its position FOLLOWS the subject: x/y
    // become the normalized-track expression centered on the overlay (`*W-w/2`). Else a static expr.
    const txExpr = o.track ? trackNormExpr(o.track, 'x') : null;
    const tyExpr = o.track ? trackNormExpr(o.track, 'y') : null;
    const x = txExpr ? `(${txExpr})*W-w/2` : (o.x !== undefined && o.x !== null ? String(o.x) : '(W-w)/2');
    const y = tyExpr ? `(${tyExpr})*H-h/2` : (o.y !== undefined && o.y !== null ? String(o.y) : '(H-h)/2');
    const start = Number.isFinite(o.start) ? Math.max(0, o.start) : 0;
    const end = Number.isFinite(o.end) ? o.end : 1e9;
    const out = i === imageOverlays.length - 1 ? '[ov]' : `[b${i}]`;
    chains.push(`[${cur}][img${i}]overlay=x=${x}:y=${y}:enable='between(t\\,${round3(start)}\\,${round3(end)})'${out}`);
    cur = `b${i}`;
  });
  ff([...inputs, '-filter_complex', chains.join(';'), '-map', '[ov]', '-map', '0:a?', ...V, '-c:a', 'copy', imaged], 'image overlays');
  mixed = imaged;
}

// ---- #78/#79 video overlays: picture-in-picture / green-screen clips over the spine ----
// A video overlay is composited over `mixed`: optionally keyed transparent (chroma_key, the
// green-screen reveal), scaled/positioned (PiP corner), faded, and gated to its window. Same
// mechanism as image_overlays but the source is a moving clip, so one path covers PiP + keying.
const videoOverlays = (batch.kind === 'video' ? batch.items : [])
  .filter((o) => o && (typeof o.source_ref === 'string' || typeof o.source_path === 'string'));
if (videoOverlays.length > 0) {
  const vided = join(T, `vided-${batchIndex}.mp4`);
  const inputs = ['-i', mixed];
  const chains = [];
  let cur = '0:v';
  let inIdx = 1; // running input index (a matte adds a second input per overlay, so no i+1)
  videoOverlays.forEach((o, i) => {
    const src = typeof o.source_ref === 'string' ? materializeRef(o.source_ref) : o.source_path;
    const timedSource = o.in !== undefined || o.out !== undefined;
    if (timedSource && (!Number.isFinite(o.in) || !Number.isFinite(o.out) || o.in < 0 || o.out <= o.in)) throw Error('A video overlay needs valid source in/out points.');
    const trimArgs = timedSource ? ['-ss', String(o.in), '-t', String(o.out - o.in)] : [];
    inputs.push(...trimArgs, '-i', src);
    const srcIdx = inIdx++;
    // ALPHA SOURCE: three ways to make the overlay transparent, all producing the same rgba.
    //  1. a MATTE video (grayscale alpha from segmentation or any producer): alphamerge the matte
    //     luma into the source alpha. This is the generic "green screen without a screen" primitive,
    //     and person-segmentation is just ONE matte producer (a DATA-selected process), L069.
    //  2. a chroma_key colorkey string (#78).
    //  3. nothing (opaque PiP).
    let matteSrc = typeof o.matte_ref === 'string' ? materializeRef(o.matte_ref)
      : (typeof o.matte_path === 'string' ? o.matte_path : null);
    // A `matte` producer key (e.g. 'person') generates the matte from the source at render time.
    if (!matteSrc && typeof o.matte === 'string' && o.matte.trim()) matteSrc = matteProduce(src, o.matte.trim());
    if (matteSrc) {
      inputs.push(...trimArgs, '-i', matteSrc);
      const matteIdx = inIdx++;
      chains.push(`[${srcIdx}:v]format=rgba[bsrc${i}]`);
      chains.push(`[${matteIdx}:v]format=gray[bmat${i}]`);
      chains.push(`[bsrc${i}][bmat${i}]alphamerge[keyed${i}]`);
    } else if (typeof o.chroma_key === 'string' && o.chroma_key.trim()) {
      chains.push(`[${srcIdx}:v]${o.chroma_key.trim()},format=rgba[keyed${i}]`);
    } else {
      chains.push(`[${srcIdx}:v]format=rgba[keyed${i}]`);
    }
    // #92 Blend mode: an OPAQUE ffmpeg `all_mode` key (screen / multiply / overlay / add / lighten /
    // darken / softlight / ...) DATA-selected per overlay. Screen/add light-leaks + glow, multiply
    // textures, softlight grade, all as DATA over the SAME video-overlay primitive (L069). `blend`
    // needs both inputs the SAME size, so a blend overlay is scaled to the full canvas (a light leak /
    // grain / glow is full-frame anyway); the render is blind to what the mode means (L090).
    const blendMode = typeof o.blend === 'string' && /^[a-z0-9_]+$/i.test(o.blend.trim()) ? o.blend.trim() : null;
    const opacity = Number.isFinite(o.opacity) ? Math.max(0, Math.min(1, o.opacity)) : 1;
    // scale / opacity / fades on the keyed (rgba) source
    const post = [];
    if (timedSource) post.push(`setpts=PTS-STARTPTS+${Number.isFinite(o.start) ? Math.max(0, o.start) : 0}/TB`);
    if (blendMode) post.push(`scale=${W}:${H}`);
    else if (Number.isFinite(o.width)) post.push(`scale=${Math.round(o.width)}:-1`);
    else if (Number.isFinite(o.scale) && o.scale > 0) post.push(`scale=iw*${o.scale}:-1`);
    if (!blendMode && opacity < 1) post.push(`colorchannelmixer=aa=${opacity}`);
    const startForFade = Number.isFinite(o.start) ? Math.max(0, o.start) : 0;
    if (Number.isFinite(o.fade_in) && o.fade_in > 0) post.push(`fade=t=in:st=${round3(startForFade)}:d=${round3(o.fade_in)}:alpha=1`);
    if (Number.isFinite(o.fade_out) && o.fade_out > 0 && Number.isFinite(o.end)) post.push(`fade=t=out:st=${round3(o.end - o.fade_out)}:d=${round3(o.fade_out)}:alpha=1`);
    let vidLabel = `keyed${i}`;
    if (post.length) { chains.push(`[keyed${i}]${post.join(',')}[vid${i}]`); vidLabel = `vid${i}`; }
    const x = o.x !== undefined && o.x !== null ? String(o.x) : '(W-w)/2';
    const y = o.y !== undefined && o.y !== null ? String(o.y) : '(H-h)/2';
    const start = Number.isFinite(o.start) ? Math.max(0, o.start) : 0;
    const end = Number.isFinite(o.end) ? o.end : 1e9;
    const out = i === videoOverlays.length - 1 ? '[vov]' : `[vb${i}]`;
    const gate = `enable='between(t\\,${round3(start)}\\,${round3(end)})'`;
    // blend composites the whole frame (timeline-gated: outside the window the base passes through);
    // overlay positions a smaller layer. `all_opacity` mixes the blended result back over the base.
    chains.push(blendMode
      ? `[${cur}][${vidLabel}]blend=all_mode=${blendMode}:all_opacity=${opacity}:${gate}${out}`
      : `[${cur}][${vidLabel}]overlay=x=${x}:y=${y}:${gate}${out}`);
    cur = `vb${i}`;
  });
  ff([...inputs, '-filter_complex', chains.join(';'), '-map', '[vov]', '-map', '0:a?', ...V, '-c:a', 'copy', vided], 'video overlays');
  mixed = vided;
}
}

// ---- #96 audio-reactive visualizer overlays: a waveform / spectrum / bars video GENERATED from the
// program audio and composited over the frame (podcast / music-video look). The visualizer producer is
// DATA-selected (VIZ_PRODUCERS, L069); x/y/width/height are NORMALIZED 0..1 of the canvas; the viz is
// keyed on black so only the drawn signal shows over the video. Reacts frame-by-frame to the audio.
// An opaque `viz_filter` string is the L090 escape hatch (the twin of grade/denoise/audio_filters):
// any audio-reactive ffmpeg filter, with `${rw} ${rh} ${color} ${fps}` placeholders, works as DATA
// with ZERO engine change. The named VIZ_PRODUCERS are just DATA presets over this same seam.
const audioVizOverlays = (Array.isArray(edl.audio_viz_overlays) ? edl.audio_viz_overlays : [])
  .filter((o) => o && ((typeof o.viz_filter === 'string' && o.viz_filter.trim()) || VIZ_PRODUCERS[o.viz]));
if (audioVizOverlays.length > 0) {
  const clamp01 = (v, d) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
  let cur = '0:v';
  const chains = [];
  audioVizOverlays.forEach((o, i) => {
    const rw = Math.max(2, Math.round(clamp01(o.width, 1) * W));
    const rh = Math.max(2, Math.round(clamp01(o.height, 0.18) * H));
    const x = Math.round(clamp01(o.x, 0) * W);
    const y = o.y !== undefined ? Math.round(clamp01(o.y, 0) * H) : H - rh;
    const opacity = Number.isFinite(o.opacity) ? Math.max(0, Math.min(1, o.opacity)) : 1;
    const color = typeof o.color === 'string' && o.color.trim() ? o.color.trim() : 'white';
    const viz = (typeof o.viz_filter === 'string' && o.viz_filter.trim())
      ? resolveTemplateEffect(o.viz_filter.trim(), { rw, rh, color, fps: FPS }) // #plugin-arch Stage 4: the opaque viz escape-hatch uses the ONE registry ${var} seam
      : VIZ_PRODUCERS[o.viz]({ rw, rh, color, fps: FPS });
    // generate from the program audio, key black to transparent, apply opacity, overlay at x,y.
    chains.push(`[0:a]${viz},format=rgba,colorkey=0x000000:0.30:0.10,colorchannelmixer=aa=${opacity}[viz${i}]`);
    const out = i === audioVizOverlays.length - 1 ? '[avz]' : `[avb${i}]`;
    chains.push(`[${cur}][viz${i}]overlay=${x}:${y}${out}`);
    cur = `avb${i}`;
  });
  const vized = join(T, 'audioviz.mp4');
  ff(['-i', mixed, '-filter_complex', chains.join(';'), '-map', '[avz]', '-map', '0:a?', ...V, '-c:a', 'copy', vized], 'audio visualizer overlays');
  mixed = vized;
}

// ---- #86 region overlays: privacy blur / mosaic censor of a rectangle of the frame itself ----
// Blur or pixelize a rect of the composited frame over a window (censor a face / plate / screen).
// No source: split the running video, crop the rect, blur (boxblur) or mosaic (down/up neighbor
// scale) it, and overlay it back at the same rect gated by enable=between. One path covers both
// modes; `mode` + `strength` are DATA, the compositor is blind to what is being censored (L090).
const regionOverlays = (Array.isArray(edl.region_overlays) ? edl.region_overlays : [])
  .filter((o) => o && Number.isFinite(o.width) && Number.isFinite(o.height));
if (regionOverlays.length > 0) {
  const regioned = join(T, 'regioned.mp4');
  const chains = [];
  let cur = '0:v';
  regionOverlays.forEach((o, i) => {
    // x/y/width/height are NORMALIZED fractions (0..1) of the frame (the canvas-independent
    // position primitive, same as drawtext); resolve against the known canvas W/H to pixels.
    const clampF = (n, d) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : d));
    const rw = Math.max(2, Math.round(clampF(o.width, 0.34) * W));
    const rh = Math.max(2, Math.round(clampF(o.height, 0.34) * H));
    const rx = Math.min(W - rw, Math.round(clampF(o.x, 0.33) * W));
    const ry = Math.min(H - rh, Math.round(clampF(o.y, 0.33) * H));
    const strength = Number.isFinite(o.strength) && o.strength > 0 ? Math.round(o.strength) : 12;
    // mosaic = down-then-up neighbor scale (universally reliable pixelation); blur = boxblur.
    const censor = o.mode === 'mosaic'
      ? `scale=max(1\\,${rw}/${strength}):max(1\\,${rh}/${strength}),scale=${rw}:${rh}:flags=neighbor`
      : `boxblur=${strength}:1`;
    const start = Number.isFinite(o.start) ? Math.max(0, o.start) : 0;
    const end = Number.isFinite(o.end) ? o.end : 1e9;
    const out = i === regionOverlays.length - 1 ? '[rov]' : `[rb${i}]`;
    chains.push(`[${cur}]split=2[base${i}][src${i}]`);
    chains.push(`[src${i}]crop=${rw}:${rh}:${rx}:${ry},${censor}[reg${i}]`);
    chains.push(`[base${i}][reg${i}]overlay=x=${rx}:y=${ry}:enable='between(t\\,${round3(start)}\\,${round3(end)})'${out}`);
    cur = `rb${i}`;
  });
  ff(['-i', mixed, '-filter_complex', chains.join(';'), '-map', '[rov]', '-map', '0:a?', ...V, '-c:a', 'copy', regioned], 'region overlays');
  mixed = regioned;
}

// ---- #108 adjustment layers: time-scoped opaque filter chains over the whole program ----
// An adjustment layer is a clip that contributes NO pixels: its `filter` (opaque ffmpeg chain,
// same DATA grammar as a clip `grade`) applies to the composited frame over [start,end). The
// compositor splits the running video, filters the copy FULL-FRAME, and overlays it back gated
// by enable=between. Overlay gating (not per-filter `enable`) keeps the chain OPAQUE: the filter
// string may contain filters with no timeline support and it still windows correctly (L090).
const adjustmentLayers = (Array.isArray(edl.adjustment_layers) ? edl.adjustment_layers : [])
  .filter((o) => o && typeof o.filter === 'string' && o.filter.trim());
if (adjustmentLayers.length > 0) {
  const adjusted = join(T, 'adjusted.mp4');
  const chains = [];
  const maskInputs=[];
  let cur = '0:v';
  adjustmentLayers.forEach((o, i) => {
    const start = Number.isFinite(o.start) ? Math.max(0, o.start) : 0;
    const end = Number.isFinite(o.end) && o.end > start ? o.end : 1e9;
    const out = i === adjustmentLayers.length - 1 ? '[adj]' : `[aj${i}]`;
    chains.push(`[${cur}]split=2[abase${i}][asrc${i}]`);
    const region=o.region;
    const rx=region?Math.max(0,Math.min(W-2,Math.round(region.x*W))):0,ry=region?Math.max(0,Math.min(H-2,Math.round(region.y*H))):0;
    const rw=region?Math.max(2,Math.min(W-rx,Math.round(region.width*W))):W,rh=region?Math.max(2,Math.min(H-ry,Math.round(region.height*H))):H;
    chains.push(`[asrc${i}]${region?`crop=${rw}:${rh}:${rx}:${ry},`:''}${o.grade_lut_ref ? resolveTemplateEffect(o.filter.trim(), { LUT: materializeRef(o.grade_lut_ref) }) : o.filter.trim()}[afx${i}]`);
    // #109 Keyframed strength: blend base and filtered per-pixel with a time-varying mix
    // e(T) = envelope * window gate (blend's all_expr exposes T; envelopeExpr's __T__ maps
    // to it). A is the FIRST input's pixel (base), B the second (filtered). Without
    // strength keyframes the hard overlay-enable path stays (cheaper, byte-identical).
    if (o.mask_source) {
      const inputIndex=maskInputs.length/2+1;maskInputs.push('-i',o.mask_source);
      const maskStart=Number.isFinite(o.mask_start)?Math.max(0,o.mask_start):start;
      chains.push(`[${inputIndex}:v]scale=${W}:${H},format=gbrp,setpts=PTS-STARTPTS,tpad=start_duration=${round3(maskStart)}:color=black[amask${i}]`);
      chains.push(`[abase${i}]format=gbrp[ambase${i}]`);
      chains.push(`[afx${i}]format=gbrp[amfx${i}]`);
      chains.push(`[ambase${i}][amfx${i}][amask${i}]maskedmerge=enable='gte(t\\,${round3(start)})*lt(t\\,${round3(end)})'${out}`);
    } else if (!region && Array.isArray(o.strength_keyframes) && o.strength_keyframes.length > 0) {
      const env = piecewiseExpr(o.strength_keyframes, { time: 'T', esc: false });
      const gate = `between(T,${round3(start)},${round3(end)})`;
      const e = `clip((${env})*${gate},0,1)`;
      const mix = `A*(1-${e})+B*${e}`;
      chains.push(`[abase${i}][afx${i}]blend=all_expr='${mix}'${out}`);
    } else {
      chains.push(`[abase${i}][afx${i}]overlay=x=${rx}:y=${ry}:enable='gte(t\\,${round3(start)})*lt(t\\,${round3(end)})'${out}`);
    }
    cur = `aj${i}`;
  });
  ff(['-i', mixed, ...maskInputs, '-filter_complex', chains.join(';'), '-map', '[adj]', '-map', '0:a?', ...V, '-c:a', 'copy', adjusted], 'adjustment layers');
  mixed = adjusted;
}

// #93 Master-bus loudness normalization: normalize the WHOLE mixed program to a target integrated
// LUFS (one loudness for the finished video, the delivery-loudness spec). DATA, blind to the number.
if (edl.master_loudnorm !== undefined && edl.master_loudnorm !== false) {
  const lufs = typeof edl.master_loudnorm === 'number' ? edl.master_loudnorm : -14;
  const truePeak = typeof edl.master_true_peak_dbfs === 'number' ? edl.master_true_peak_dbfs : -1.5;
  if (!Number.isFinite(truePeak) || truePeak <= -9 || truePeak >= 0) {
    throw new Error(`[video.compose] invalid master_true_peak_dbfs ${truePeak}: expected a finite number in (-9,0)`);
  }
  const range = edl.master_loudness_range ?? 11;
  if (!Number.isFinite(range) || range < 1 || range > 50) throw new Error(`[video.compose] invalid master_loudness_range ${range}: expected LU in 1..50`);
  const mastered = join(T, 'mastered.mp4');
  let target = `loudnorm=I=${round3(lufs)}:TP=${round3(truePeak)}:LRA=${round3(range)}`;
  // `master_loudnorm_linear: true` measures the whole program first and then applies one gain to all of it (two-pass
  // linear loudnorm), so the mix keeps its own dynamics instead of riding loudnorm's moving gain.
  if (edl.master_loudnorm_linear === true) {
    const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', mixed, '-vn', '-af', `${target}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const said = run.stderr ?? '';
    if (run.status !== 0 || !said.includes('"input_i"')) throw new Error(`[video.compose] ffmpeg failed at master loudness measure: ${said.slice(-400)}`);
    const m = JSON.parse(said.slice(said.lastIndexOf('{'), said.lastIndexOf('}') + 1));
    target += `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  }
  ff(['-i', mixed, '-af', target, '-c:v', 'copy', ...A, mastered], 'master loudnorm');
  mixed = mastered;
}

// #230 Program-level subtitle / karaoke burn: burn a ready ASS subtitle STRING over the WHOLE finished
// program via libass (the same `ass=` filter chapter titles use). `edl.subtitles.ass` is authored upstream
// (author-karaoke-captions.mjs turns caption-lines word timings into a `\k` karaoke ASS), so this is ONE
// generic content-blind burn (L069) placed AFTER the mix so captions sit on the finished frame; the
// compositor never knows the words MEAN anything (Physics). `fontsdir` is an optional font directory.
if (edl.subtitles && typeof edl.subtitles.ass === 'string' && edl.subtitles.ass.trim()) {
  const assFile = join(T, 'program-subs.ass');
  writeFileSync(assFile, edl.subtitles.ass);
  const subbed = join(T, 'subbed.mp4');
  const fontsdir = edl.subtitles.fontsdir ? `:fontsdir=${edl.subtitles.fontsdir}` : '';
  ff(['-i', mixed, '-vf', `ass=${assFile}${fontsdir}`, ...V, '-c:a', 'copy', subbed], 'program subtitles');
  mixed = subbed;
}

// ---- final: zero-start + faststart ----
ff(['-i', mixed, '-c', 'copy',
  '-bsf:v', 'setts=pts=PTS-STARTPTS:dts=DTS-STARTPTS', '-movflags', '+faststart', OUT], 'final encode');

const duration = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' }).trim();

// Bind output bytes through the existing content-identity owner without loading
// a complete movie into memory. Publication is a separate consumer operation.
const videoMultihash = makeHashCodeHexFromChunks(stageInputChunks(OUT));
const result = {
  output: OUT,
  duration_s: Number(duration),
  segments: segments.length,
  workdir: T,
  video_multihash: videoMultihash,
};
console.log(`[video.compose] base=${edl.base?.kind ?? 'video'} tracks=${segments.length} chapters=${(edl.chapter_inserts ?? []).length} -> ${OUT} (${duration}s)`);
console.log(JSON.stringify(result));
// Declared-output file for the workflow boundary (bindings read files, not
// log-prefixed stdout) — written next to the artifact, or where --result says.
writeFileSync(args.get('result') ?? `${OUT}.result.json`, JSON.stringify(result) + '\n');


// ===========================================================================
// INLINED helper modules (were ./split-layout.mjs + ./card-layout.mjs) — the
// compute.process sandbox mounts ONLY this script, so its deps must be inline.
// Docs preserved verbatim per the no-simplify mandate.
// ===========================================================================

// packages/media-composition/do-work/split-layout.mjs
//
// PURE filter-graph builder for the generic `split` EDL segment kind: compose N
// sources into ONE frame as a side-by-side (h), stacked (v), or grid layout.
// Behaviour comes ONLY from EDL data (sources[], layout, weights[], speed) — zero
// domain vocabulary, so a sports you-vs-a-pro side-by-side and a 4-up product grid
// are the SAME mechanism with different DATA (L069). No I/O here (no ffmpeg/ffprobe) —
// this returns the ffmpeg filter pieces, so it is deterministic + unit-testable.
//
// hstack requires equal input HEIGHTS, vstack equal WIDTHS, xstack equal CELLS — the
// per-source scale targets below guarantee each, so the stack never errors.
//
// TWO transform axes, deliberately separated (Codex convergence 2026-06-29):
//   • SPATIAL, PER-SOURCE (`sources[i]`, optional, identity when absent):
//       - crop  {w,h,x,y}  ffmpeg crop=w:h:x:y in SOURCE px (pre-scale). Zoom to a
//                          subject. The DATA producer MUST clamp the rect to the real
//                          source frame — an over-large w/h ERRORS in ffmpeg (verified);
//                          the pure builder has no source dims so it cannot clamp.
//       - label {textfile,x?,y?,size?,color?,box?,box_color?,pad?}  drawtext burned
//                          into the cell AFTER scale (size/position in OUTPUT px).
//                          `textfile` is a path the I/O layer (video-compose) wrote —
//                          using textfile, NOT text=, sidesteps ffmpeg's multi-level
//                          escaping entirely (text with `:` `%` `'` etc. breaks text=;
//                          textfile is bulletproof — verified). Position is the
//                          NORMALIZED {x,y} primitive (0..1): x=0 left/0.5 center/1
//                          right, y=0 top/0.5 middle/1 bottom — the 9 alignment
//                          anchors and any freeform drop are all (x,y). Legacy
//                          `corner ∈ tl|tr|bl|br` maps to an (x,y) preset.
//   • TEMPORAL, SEGMENT-UNIFORM (`speed`, default 1): setpts=PTS/speed applied to
//       EVERY cell so all branches retime identically. Speed is NOT per-source: a
//       per-cell speed would desync an hstack (branches of unequal length; hstack's
//       `shortest` defaults to 0) — a structural footgun. One speed per split keeps
//       every branch the same length. A slow-mo contact pass is its OWN split segment
//       with speed:0.4; video-compose drops audio on a sped split (setpts retimes only
//       video). crop/label are spatial and stay per-cell; speed is temporal and global.

/**
 * Build the video filter graph for a split.
 * @param {{count:number, layout?:string, weights?:number[], width:number, height:number, fps:string|number, speed?:number, sources?:SourceTransform[]}} spec
 * @typedef {{crop?:{w:number,h:number,x:number,y:number}, flip?:'h'|'v'|'hv', label?:LabelSpec}} SourceTransform
 * @typedef {{textfile:string, x?:number, y?:number, corner?:'tl'|'tr'|'bl'|'br', size?:number, color?:string, box?:boolean, box_color?:string, pad?:number}} LabelSpec
 * @returns {{ filter:string, videoLabel:string, cells:{w:number,h:number}[], cols?:number, rows?:number }}
 */
export function buildSplitLayout({ count, layout = 'h', weights, width, height, fps, speed, sources }) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`[split] needs at least one source (got ${count})`);
  }
  if (sources != null && (!Array.isArray(sources) || sources.length !== count)) {
    throw new Error(`[split] sources transform array must have one entry per source (${count})`);
  }
  const retime = typeof speed === 'number' && speed > 0 && speed !== 1;
  const norm = `setsar=1,fps=${fps},format=yuv420p`;
  const scaleLabel = (i) => `v${i}`;
  // Per-source chain for cell i scaled to (cw, ch). Order: crop (source px) → flip
  // (mirror, source px) → setpts (segment-uniform speed) → scale+norm → drawtext
  // (output px). Flip is AFTER crop (mirror the cropped region) and BEFORE drawtext
  // (so a burned-in label is never reversed). hflip mirrors footage shot from the
  // OPPOSITE camera side so two sources face the same way in a side-by-side — a
  // universal spatial transform (any opposite-side comparison), identity when absent.
  const sourceChain = (i, cw, ch) => {
    const t = sources?.[i] ?? {};
    const parts = [];
    if (t.crop) {
      const { w, h, x, y } = t.crop;
      parts.push(`crop=${w}:${h}:${x}:${y}`);
    }
    if (t.flip === 'h' || t.flip === 'hv') parts.push('hflip');
    if (t.flip === 'v' || t.flip === 'hv') parts.push('vflip');
    if (retime) parts.push(`setpts=PTS/${speed}`);
    parts.push(`scale=${cw}:${ch}`, norm);
    if (t.label && t.label.textfile) parts.push(drawtextFilter(t.label, ch));
    return `[${i}:v]${parts.join(',')}[${scaleLabel(i)}]`;
  };

  // A single-source "split" is a full-frame cell — no stack filter at all
  // (hstack/vstack/xstack require ≥2 inputs; ffmpeg rejects inputs=1). The
  // per-source transform chain (crop/flip/speed/label) still applies, so a
  // one-source watermark/slow-mo split is valid DATA, not an error.
  if (count === 1) {
    return { filter: sourceChain(0, width, height), videoLabel: scaleLabel(0), cells: [{ w: width, h: height }] };
  }

  if (layout === 'h' || layout === 'v') {
    const w = normalizedWeights(weights, count);
    const total = w.reduce((a, b) => a + b, 0);
    const cells = [];
    let used = 0;
    for (let i = 0; i < count; i += 1) {
      const isLast = i === count - 1;
      if (layout === 'h') {
        const cw = isLast ? width - used : Math.round((width * w[i]) / total);
        used += cw;
        cells.push({ w: cw, h: height });
      } else {
        const ch = isLast ? height - used : Math.round((height * w[i]) / total);
        used += ch;
        cells.push({ w: width, h: ch });
      }
    }
    const scales = cells.map((c, i) => sourceChain(i, c.w, c.h));
    const ins = cells.map((_, i) => `[${scaleLabel(i)}]`).join('');
    const stack = `${ins}${layout === 'h' ? 'hstack' : 'vstack'}=inputs=${count}[vout]`;
    return { filter: [...scales, stack].join(';'), videoLabel: 'vout', cells };
  }

  if (layout === 'grid') {
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const cw = Math.floor(width / cols);
    const ch = Math.floor(height / rows);
    const scales = [];
    const positions = [];
    const cells = [];
    for (let i = 0; i < count; i += 1) {
      scales.push(sourceChain(i, cw, ch));
      const col = i % cols;
      const row = Math.floor(i / cols);
      positions.push(`${col * cw}_${row * ch}`);
      cells.push({ w: cw, h: ch });
    }
    const ins = cells.map((_, i) => `[${scaleLabel(i)}]`).join('');
    const stack = `${ins}xstack=inputs=${count}:layout=${positions.join('|')}:fill=black[vout]`;
    return { filter: [...scales, stack].join(';'), videoLabel: 'vout', cells, cols, rows };
  }

  throw new Error(`[split] unknown layout ${JSON.stringify(layout)} (use h | v | grid)`);
}

/** Resolve relative weights to a usable per-source array (defaults to equal). */
function normalizedWeights(weights, count) {
  if (Array.isArray(weights) && weights.length === count && weights.every((n) => typeof n === 'number' && n > 0)) {
    return weights;
  }
  return Array(count).fill(1);
}

/**
 * Build a drawtext filter for a label positioned in a cell of OUTPUT height `ch`.
 * Reads the text from `label.textfile` (escaping-free — text= breaks on `:`/`%`/`'`),
 * and disables `%{...}` expansion so the literal text is never reinterpreted.
 */
// A color is safe to interpolate into an ffmpeg filter iff it is a plain color token:
// a name (`white`), a hex (`#RRGGBB[AA]` / `0xRRGGBB`), optionally with an `@alpha`
// suffix (`black@0.5`). Anything with a `:`, `'`, `\`, `%`, `,`, `[`, `]` is a filter-
// graph metacharacter that would break or INJECT into the graph — reject to the
// default. This is the Physics boundary: caption STYLE is Society DATA, but it may
// never carry executable filter syntax into the render (no Society leak into Physics).
function safeColor(value, fallback) {
  return typeof value === 'string' && /^#?[0-9a-zA-Z]+(@[0-9.]+)?$/.test(value) ? value : fallback;
}

function drawtextFilter(label, ch) {
  const pad = Number.isFinite(label.pad) ? Math.max(0, Math.round(label.pad)) : Math.round(ch * 0.03);
  // Size is bounded to [8, ch]: a caption can never be smaller than legible nor taller
  // than the frame (a NaN/negative/absurd DATA value can't corrupt the graph or explode).
  const rawSize = Number.isFinite(label.size) ? label.size : Math.round(ch * 0.05);
  const size = Math.max(8, Math.min(ch, Math.round(rawSize)));
  const color = safeColor(label.color, 'white');
  // NORMALIZED POSITION PRIMITIVE: label.x / label.y ∈ [0,1] place the text box
  // anywhere in the padded frame with ONE formula (no corner enum). x=0 left /
  // 0.5 center / 1 right; y=0 top / 0.5 middle / 1 bottom. The 9 alignment
  // anchors and any freeform drop are all just (x,y). A legacy `corner` maps to
  // an (x,y) preset for back-compat only.
  const LEGACY = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] };
  const legacy = LEGACY[label.corner] || [0, 0];
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const fx = clamp01(Number.isFinite(label.x) ? label.x : legacy[0]);
  const fy = clamp01(Number.isFinite(label.y) ? label.y : legacy[1]);
  // Available travel = frame minus text size minus both pads; anchor is the box's
  // top-left, so fx=1 pins the right edge and fy=1 pins the bottom edge.
  // #101 An x_expr/y_expr (a full ffmpeg position expression, e.g. a motion-track binding) overrides
  // the static normalized placement, letting a caption FOLLOW a moving subject.
  // #115 An x_norm_expr/y_norm_expr is a NORMALIZED 0..1 expression (e.g. a piecewiseExpr entrance/exit
  // envelope) that rides the SAME pad->pixel mapping as a static x/y, so the pad math stays in one place.
  const mapX = (e) => `${pad}+(w-text_w-${2 * pad})*(${e})`;
  const mapY = (e) => `${pad}+(h-text_h-${2 * pad})*(${e})`;
  const x = typeof label.x_expr === 'string' && label.x_expr ? label.x_expr
    : typeof label.x_norm_expr === 'string' && label.x_norm_expr ? mapX(label.x_norm_expr)
    : mapX(String(fx));
  const y = typeof label.y_expr === 'string' && label.y_expr ? label.y_expr
    : typeof label.y_norm_expr === 'string' && label.y_norm_expr ? mapY(label.y_norm_expr)
    : mapY(String(fy));
  const parts = [
    `textfile='${label.textfile}'`,
    'expansion=none',
    `x=${x}`,
    `y=${y}`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
  ];
  if (label.box !== false) {
    parts.push('box=1', `boxcolor=${safeColor(label.box_color, 'black@0.5')}`, `boxborderw=${Math.round(size * 0.3)}`);
  }
  return `drawtext=${parts.join(':')}`;
}

// packages/media-composition/do-work/card-layout.mjs
//
// PURE filter-graph builder for the generic `card` EDL segment kind: a solid-color
// background with N centered text lines, held for a duration. Behaviour comes ONLY
// from EDL data (bg, lines[], duration) — zero domain vocabulary, so a hook card, a
// CTA card, a chapter-title card and a before/after caption card are the SAME
// mechanism with different DATA (L069). No I/O here (no ffmpeg/ffprobe) — this returns
// the ffmpeg pieces, so it is deterministic + unit-testable.
//
// Text is read from a `textfile` path that the I/O layer (video-compose) wrote, with
// `expansion=none` — using textfile, NOT text=, sidesteps ffmpeg's multi-level
// escaping entirely (text with `:` `%` `'` etc. breaks text=; textfile is bulletproof,
// the same proven choice as split-layout's labels).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/**
 * Build the lavfi source + drawtext chain for a text card.
 * @param {{width:number, height:number, fps:string|number, duration:number, bg?:string,
 *          lines:LineSpec[]}} spec
 * @typedef {{textfile:string, size:number, color?:string, gap?:number}} LineSpec
 * @returns {{ lavfi:string, vf:string }} lavfi = the `color=...` source arg; vf = the
 *          comma-joined drawtext filter chain (one drawtext per line).
 */
export function buildCardLayout({ width, height, fps, duration, bg = 'black', lines }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    // A card with no text is a bug, not an empty render — fail closed (L083: the
    // default is maximally safe, never a silent blank frame pretending to be content).
    throw new Error('[card] needs at least one text line');
  }
  if (!(typeof duration === 'number' && duration > 0)) {
    throw new Error(`[card] needs a positive duration (got ${duration})`);
  }

  // Each line reserves size * (1 + gap) of vertical space; default gap 0.45 of the
  // line's own size. The whole block is centered vertically; each line is centered
  // horizontally. No per-line absolute coordinates are required from the caller — a
  // caller that passes only {textfile,size} gets a correctly centered block (L083).
  const heights = lines.map((l) => l.size * (1 + (Number.isFinite(l.gap) ? l.gap : 0.45)));
  const blockH = heights.reduce((a, b) => a + b, 0);
  let cursor = `(h-${round(blockH)})/2`; // top of the centered block, as an ffmpeg expr

  const drawtexts = lines.map((line, i) => {
    if (!line.textfile) throw new Error(`[card] line ${i} has no textfile`);
    const size = line.size;
    const color = line.color || 'white';
    // Horizontal center via ffmpeg's text_w; vertical = running cursor + this line's
    // leading half-gap so the glyph sits centered in its reserved row.
    const lead = round((heights[i] - size) / 2);
    const y = `${cursor}+${lead}`;
    cursor = `${cursor}+${round(heights[i])}`;
    // A line may name its font file and a border (outline) of border_px in border_color (default black).
    return [
      `drawtext=textfile='${line.textfile}'`,
      'expansion=none',
      ...(line.font_file ? [`fontfile='${line.font_file}'`] : []),
      'x=(w-text_w)/2',
      `y=${y}`,
      `fontsize=${size}`,
      `fontcolor=${color}`,
      ...(Number.isFinite(line.border_px) && line.border_px > 0 ? [`borderw=${round(line.border_px)}`, `bordercolor=${safeColor(line.border_color, 'black')}`] : []),
    ].join(':');
  });

  return {
    lavfi: `color=c=${bg}:s=${width}x${height}:r=${fps}:d=${round(duration)}`,
    vf: drawtexts.join(','),
  };
}

/** Round to 3dp so generated expressions are stable + test-comparable. */
function round(n) {
  return Math.round(n * 1000) / 1000;
}
