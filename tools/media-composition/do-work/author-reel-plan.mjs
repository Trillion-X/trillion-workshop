/**
 * #225 Reel-plan authorer (the "brain" that composes the intelligence producers into ONE edit-decision plan).
 * The producers I built each MEASURE one thing (quality, motion, subject track, best poster frame); nothing
 * composed them, so batch-produce-reels rendered "dumbly" (fixed poster timestamp, fixed window, no take
 * selection, no action trim, no reframe follow). This authors a per-clip PLAN by running those producers and
 * assembling their DATA: is the clip usable, WHERE the action is (trim), the vertical reframe track, the best
 * poster time, and the publish loudness target. It is pure DECISION authoring over existing producers (the
 * deterministic-substrate pattern: the brain decides, the hands render); the plan's fields are exactly the DATA
 * the existing render consumes (`segment.in/out`, `segment.reframe`, extract-poster's timestamp, `master_loudnorm`),
 * so there is ZERO new render code (L069). It owns no ffmpeg and no look math; swapping a producer for a smarter
 * one (a pose detector, an aesthetic model) changes the plan with no change here (L090).
 */
import { measureQuality, scoreQuality } from './detect-quality.mjs';
import { measureMotion } from './detect-motion.mjs';
import { trackSubject, trackToReframe } from './auto-reframe.mjs';
import { bestPosterTime } from './pick-poster-frame.mjs';
import { loudnessGate } from './measure-loudness.mjs';
import { captionPlacement } from './place-captions.mjs';
import { karaokeAss } from './author-karaoke-captions.mjs';

/**
 * PURE: pick the ACTION window from motion segments (energy is per-clip max-normalized, peak = 1.0). Returns the
 * contiguous run of windows around the peak whose energy stays at or above `threshold`, i.e. the moment the swing
 * / dunk / contact happens. Null when there is no motion at all (caller keeps the whole clip).
 */
export function actionWindow(segments, { threshold = 0.5 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  let peak = 0;
  for (let i = 1; i < segments.length; i += 1) if (segments[i].energy > segments[peak].energy) peak = i;
  if (!(segments[peak].energy > 0)) return null;
  let lo = peak, hi = peak;
  while (lo > 0 && segments[lo - 1].energy >= threshold) lo -= 1;
  while (hi < segments.length - 1 && segments[hi + 1].energy >= threshold) hi += 1;
  return { start: segments[lo].start, end: segments[hi].end };
}

/**
 * Author a reel plan for one clip. Options: aspectW/aspectH (target reel aspect, default 9:16), targetLufs
 * (publish loudness, default -14), minQualityScore (usable floor), motionWindow (motion analysis window secs),
 * actionThreshold. Returns a DATA plan the render/poster/loudnorm consume directly.
 */
export function authorReelPlan(file, opts = {}) {
  const aspectW = Number.isFinite(opts.aspectW) ? opts.aspectW : 9;
  const aspectH = Number.isFinite(opts.aspectH) ? opts.aspectH : 16;
  const targetLufs = Number.isFinite(opts.targetLufs) ? opts.targetLufs : -14;
  const minQualityScore = Number.isFinite(opts.minQualityScore) ? opts.minQualityScore : 0.5;

  const quality = measureQuality(file, opts);
  const qualityScore = scoreQuality(quality, opts);
  const usable = qualityScore >= minQualityScore;

  const { segments } = measureMotion(file, { windowSeconds: opts.motionWindow ?? 1 });
  const action = actionWindow(segments, { threshold: opts.actionThreshold ?? 0.5 });

  const subject = trackSubject(file, opts);
  const reframe = trackToReframe(subject.path, { aspectW, aspectH, source: { width: subject.width, height: subject.height }, camera: opts.camera });
  const posterTime = bestPosterTime(file, opts).t;

  // #231/#230 CAPTIONS: when the caller supplies grouped caption `lines` ([{start,end,words:[{text,start,end}]}],
  // the caption-lines.ts output shape), author a subtitle-ready karaoke burn as part of the finished plan. The
  // subject track is REUSED from the reframe above (no second detect-track run; the subject's own path, not the camera's) to place the caption in the CLEAR
  // region; karaokeAss turns the word timings into the ASS the render burns via edl.subtitles. ASR (making the
  // words) stays out of this package; consuming DATA words is in-lane. Absent lines -> no captions (unchanged).
  const reelW = Number.isFinite(opts.width) ? opts.width : 1080;
  const reelH = Number.isFinite(opts.height) ? opts.height : 1920;
  let captions = null;
  if (Array.isArray(opts.lines) && opts.lines.length) {
    const placement = captionPlacement(subject.path, { frameHeight: reelH, marginFrac: opts.captionMarginFrac ?? 0.08 });
    const style = opts.captionStyle ?? {};
    const ass = karaokeAss(opts.lines, { ...style, alignment: placement.alignment, marginV: placement.marginV, playResX: reelW, playResY: reelH });
    captions = { placement, subtitles: { ass } };   // -> edl.subtitles
  }

  return {
    usable,
    quality: { ...quality, score: qualityScore },
    action,                         // { start, end } -> segment.in / segment.out (null = keep whole clip)
    reframe,                        // { aspect_w, aspect_h, track } -> segment.reframe
    poster_time: posterTime,        // -> extract-poster timestamp
    target_lufs: targetLufs,        // -> master_loudnorm; verify after render with measure-loudness + loudnessGate
    publish_gate: { targetLufs, tolerance: opts.tolerance ?? 1, maxTruePeak: opts.maxTruePeak ?? -1 },
    captions,                       // { placement, subtitles:{ass} } -> edl.subtitles (null when no lines given)
  };
}

/** PURE: apply a full reel plan onto an EDL (trim+reframe the first spine segment, attach the caption burn). */
export function applyPlanToEdl(edl, plan) {
  const next = { ...edl };
  if (next.spine && Array.isArray(next.spine.segments) && next.spine.segments.length) {
    const segs = [...next.spine.segments];
    segs[0] = applyPlanToSegment(segs[0], plan);
    next.spine = { ...next.spine, segments: segs };
  }
  if (plan.captions && plan.captions.subtitles) next.subtitles = plan.captions.subtitles;
  if (Number.isFinite(plan.target_lufs)) next.master_loudnorm = plan.target_lufs;
  return next;
}

/** PURE: apply a plan onto an EDL segment (trim to action + attach the reframe). The render already applies both. */
export function applyPlanToSegment(segment, plan) {
  const s = { ...segment };
  if (plan.action) { s.in = plan.action.start; s.out = plan.action.end; }
  if (plan.reframe && Array.isArray(plan.reframe.track)) s.reframe = plan.reframe;
  return s;
}

// re-export the loudness gate so a caller can verify the rendered reel against the plan's target in one import.
export { loudnessGate };

// CLI: node author-reel-plan.mjs <file> [--aspect-w N] [--aspect-h N] [--target-lufs L]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('usage: author-reel-plan.mjs <file> [--aspect-w N] [--aspect-h N] [--target-lufs L]'); process.exit(2); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = Number(rest[i + 1]);
    if (k === '--aspect-w') opt.aspectW = v; else if (k === '--aspect-h') opt.aspectH = v; else if (k === '--target-lufs') opt.targetLufs = v;
  }
  process.stdout.write(JSON.stringify(authorReelPlan(file, opt)) + '\n');
}
