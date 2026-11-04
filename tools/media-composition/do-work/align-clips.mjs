/**
 * #218 Clip-alignment PRODUCER (multi-source SYNC by a shared event). Two clips of the same moment (two camera
 * angles, or the athlete's swing vs a reference swing) start at different times, so a side-by-side (split-layout)
 * plays them out of phase. This measures the strongest audio transient (a clap, a racket/ball contact, a step)
 * in each clip and emits the TRIM offsets that make those events coincide, so the swings line up. It is a
 * PRODUCER: it only MEASURES; the alignment is expressed as each clip's existing `segment.in` trim (which
 * video-compose already applies), so there is ZERO new render code (L069). The mission's you-vs-a-pro side-by-side
 * needs the two strokes phase-locked at contact; pose-phase matching is motion-analysis's job (no god package),
 * but aligning two clips by a signal is composition, and a smarter anchor (a pose-contact frame) is a drop-in
 * producer emitting the SAME {aIn,bIn} shape.
 *
 * The onset envelope is the ONE shared `frameEnergyFlux` (beat-onset-picker.mjs) and PCM extraction is the ONE
 * shared `extractMonoPcm` (detect-beats.mjs), so alignment, beat-cut, and offline beat-detect all read the same
 * signal (SSOT). Blind to genre (L090): any transient anchors it (racket, ball, clap, footfall, downbeat).
 */
import { extractMonoPcm } from './detect-beats.mjs';
import { frameEnergyFlux } from './beat-onset-picker.mjs';

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Time (seconds) of the single strongest onset (max positive energy flux) in a file's audio. This is the
 * alignment anchor: the loudest transient, which is what a human syncs two angles on (the clap / the contact).
 */
export function detectStrongestOnset(file, opts = {}) {
  const { samples, sampleRate } = extractMonoPcm(file, opts);
  const { flux, nFrames, hop } = frameEnergyFlux(samples, opts.hop ?? 512);
  if (nFrames <= 2) return null;
  let bestF = -1, best = -Infinity;
  for (let f = 1; f < nFrames; f += 1) if (flux[f] > best) { best = flux[f]; bestF = f; }
  if (bestF < 0 || best <= 0) return null;
  return round3((bestF * hop) / sampleRate);
}

/**
 * Measure the alignment of clip B relative to clip A by their strongest shared event.
 * @returns {{eventA:number|null, eventB:number|null, offset:number|null}} offset = eventA - eventB (seconds):
 *   positive means A's event happens LATER, so A must be trimmed more to catch up.
 */
export function computeAlignmentOffset(fileA, fileB, opts = {}) {
  const eventA = detectStrongestOnset(fileA, opts);
  const eventB = detectStrongestOnset(fileB, opts);
  const offset = eventA === null || eventB === null ? null : round3(eventA - eventB);
  return { eventA, eventB, offset };
}

/**
 * Turn two event times into the per-clip `in` trims that make the events coincide `lead` seconds into each
 * trimmed clip (default 0 = events at t=0). Never trims below 0. The caller sets each clip's `segment.in`.
 * @returns {{aIn:number, bIn:number}}
 */
export function alignTrims(eventA, eventB, { lead = 0 } = {}) {
  const ld = Number.isFinite(lead) ? Math.max(0, lead) : 0;
  return { aIn: Math.max(0, round3(eventA - ld)), bIn: Math.max(0, round3(eventB - ld)) };
}

/** Convenience: measure both clips and return the trims that align them (lead seconds of pre-roll kept). */
export function alignClips(fileA, fileB, opts = {}) {
  const { eventA, eventB, offset } = computeAlignmentOffset(fileA, fileB, opts);
  if (eventA === null || eventB === null) return { eventA, eventB, offset: null, aIn: 0, bIn: 0 };
  return { eventA, eventB, offset, ...alignTrims(eventA, eventB, opts) };
}

// CLI: node align-clips.mjs <fileA> <fileB> [--lead S] [--hop N]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b, ...rest] = process.argv.slice(2);
  if (!a || !b) { console.error('usage: align-clips.mjs <fileA> <fileB> [--lead S] [--hop N]'); process.exit(2); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = Number(rest[i + 1]);
    if (k === '--lead') opt.lead = v;
    else if (k === '--hop') opt.hop = v;
  }
  process.stdout.write(JSON.stringify(alignClips(a, b, opt)) + '\n');
}
