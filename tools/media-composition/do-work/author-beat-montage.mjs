/**
 * #228 Beat-synced multi-clip montage authorer (the music-montage that gets the views). Given a list of clips and
 * a list of CUT TIMES (the beats to cut on, from detect-beats -> beat-sync), this assigns each successive clip to
 * the interval between two cuts, trimmed to that length, so every clip change lands ON the beat. It composes the
 * beat producer (#217) + the beat-sync cut selection with the existing `clip` segment (the multi-source montage
 * case, author-concat-edl.mjs:27), returning the render EDL video-compose already consumes. ZERO new render code
 * (L069): a montage is a spine of trimmed `clip` segments the compositor concats; WHERE the cuts fall is DATA
 * (the beat list). Blind to genre (L090): footsteps, a spoken cadence, or a manual cut list drive it identically;
 * the deletion test (swap the clips + the beats) works with zero code change.
 */
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * PURE: map clips onto the intervals between cut times. Clip i plays the interval [cuts[i], cuts[i+1]], trimmed
 * to that length from `clipStart` (default 0), so the concatenated output changes clip exactly at each cut.
 * Clips cycle if there are more intervals than clips. Non-finite / zero-length intervals are skipped.
 * @returns {{kind:'clip', id:string, source:string, in:number, out:number}[]}
 */
export function montageSegments(clips, cutTimes, { clipStart = 0 } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) return [];
  const cuts = [...(Array.isArray(cutTimes) ? cutTimes : [])].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const start = Number.isFinite(clipStart) ? Math.max(0, clipStart) : 0;
  const segs = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const dur = round3(cuts[i + 1] - cuts[i]);
    if (dur <= 0) continue;
    segs.push({ kind: 'clip', id: `m${segs.length}`, source: clips[segs.length % clips.length], in: round3(start), out: round3(start + dur) });
  }
  return segs;
}

/**
 * Author the full montage EDL. `opts`: clipStart, bg (base color), width/height/fps.
 * @returns {{base:object, tracks:[], spine:{segments:object[]}, encode:object}}
 */
export function authorBeatMontage(clips, cutTimes, opts = {}) {
  const segments = montageSegments(clips, cutTimes, opts);
  return {
    base: { color: typeof opts.bg === 'string' ? opts.bg : 'black' },
    tracks: [],
    spine: { segments },
    encode: { width: opts.width ?? 1080, height: opts.height ?? 1920, fps: opts.fps ?? 30 },
  };
}

// CLI: node author-beat-montage.mjs --clips a.mp4,b.mp4,c.mp4 --cuts 0,0.5,1,1.5 [--clip-start S] [--width W] [--height H] [--fps F]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = {}; let clips = [], cuts = [];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i], v = args[i + 1];
    if (k === '--clips') clips = v.split(',').filter(Boolean);
    else if (k === '--cuts') cuts = v.split(',').map(Number).filter(Number.isFinite);
    else if (k === '--clip-start') opt.clipStart = Number(v);
    else if (k === '--width') opt.width = Number(v);
    else if (k === '--height') opt.height = Number(v);
    else if (k === '--fps') opt.fps = Number(v);
  }
  if (!clips.length || cuts.length < 2) { console.error('usage: author-beat-montage.mjs --clips a,b,c --cuts 0,0.5,1,1.5 [--clip-start S] [--width W] [--height H] [--fps F]'); process.exit(2); }
  process.stdout.write(JSON.stringify(authorBeatMontage(clips, cuts, opt)) + '\n');
}
