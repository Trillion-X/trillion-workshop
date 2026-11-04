/**
 * #226 Aligned side-by-side authorer (the mission's literal "put them side-by-side" for the you-vs-a-pro
 * swing). Two swing clips start at different times, so a plain split-screen plays them out of phase and the
 * comparison is useless. This composes `align-clips` (measure the offset by the strongest shared event, e.g. the
 * racket/ball contact) with the existing `split` segment, setting each source's per-source `in` trim so the two
 * contacts COINCIDE, then hands back the `kind:'split'` DATA the compositor already renders (per-source in/out is
 * supported, video-compose.mjs:1723). ZERO new render code (L069): alignment is per-source `in` and the layout
 * is the existing split. The FRAME-level pose matching (which stroke phase equals which) is motion-analysis's job
 * (no god package); aligning two clips by a shared signal is composition, and a pose-contact anchor is a drop-in
 * producer emitting the same offset (L090). Works identically for basketball, a golf swing, two dance takes, any
 * two clips of the same action (the deletion test: swap the footage, zero code change).
 */
import { alignClips } from './align-clips.mjs';

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Author a phase-locked side-by-side split of two clips.
 * @param {string} fileA @param {string} fileB
 * @param {{lead?:number, durationSec?:number, layout?:string, weights?:number[], labelA?:string, labelB?:string}} opts
 *   lead = seconds of pre-roll kept before the aligned contact (default 0.5); durationSec = length of the
 *   side-by-side window (default 2); layout = 'h' | 'v' | 'grid' (default 'h'); labelA/labelB = cell captions.
 * @returns {{kind:'split', layout:string, duration:number, sources:object[], alignment:object}}
 */
export function authorAlignedSplit(fileA, fileB, opts = {}) {
  const lead = Number.isFinite(opts.lead) ? Math.max(0, opts.lead) : 0.5;
  const duration = Number.isFinite(opts.durationSec) ? Math.max(0.1, opts.durationSec) : 2;
  const layout = typeof opts.layout === 'string' ? opts.layout : 'h';

  const { aIn, bIn, eventA, eventB, offset } = alignClips(fileA, fileB, { lead });
  const cell = (source, inSec, label) => {
    const s = { source, in: round3(inSec), out: round3(inSec + duration) };
    if (typeof label === 'string' && label.trim()) s.label = { text: label };
    return s;
  };
  const seg = {
    kind: 'split',
    layout,
    duration,
    sources: [cell(fileA, aIn, opts.labelA), cell(fileB, bIn, opts.labelB)],
    alignment: { eventA, eventB, offset, aIn: round3(aIn), bIn: round3(bIn), lead },
  };
  if (Array.isArray(opts.weights)) seg.weights = opts.weights;
  return seg;
}

// CLI: node author-aligned-split.mjs <fileA> <fileB> [--lead S] [--duration S] [--layout h|v|grid] [--label-a X] [--label-b Y]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b, ...rest] = process.argv.slice(2);
  if (!a || !b) { console.error('usage: author-aligned-split.mjs <fileA> <fileB> [--lead S] [--duration S] [--layout h|v|grid] [--label-a X] [--label-b Y]'); process.exit(2); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = rest[i + 1];
    if (k === '--lead') opt.lead = Number(v);
    else if (k === '--duration') opt.durationSec = Number(v);
    else if (k === '--layout') opt.layout = v;
    else if (k === '--label-a') opt.labelA = v;
    else if (k === '--label-b') opt.labelB = v;
  }
  process.stdout.write(JSON.stringify(authorAlignedSplit(a, b, opt)) + '\n');
}
