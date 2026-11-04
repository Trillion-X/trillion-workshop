/**
 * file: packages/media-composition/do-work/author-concat-edl.mjs
 *
 * =============================================================================
 * authorConcatEdl — the generic "windows → base_span concat EDL" author
 * =============================================================================
 *
 * Given ONE base video artifact + a list of time WINDOWS (seconds), emit the
 * render EDL that `video-compose.mjs` consumes: a `spine` of `base_span` segments,
 * chronologically ordered, one per window (each trims the base to [src_in,src_out]
 * and the compositor concats them). Optional per-window `overlaySource` becomes an
 * `overlays` entry riding that window (a stat label, a corner badge). `encode`
 * (width/height/fps/…) rides straight onto the EDL.
 *
 * This is the RENDER-INPUT half of a highlight reel — but it names NO domain. The
 * "which windows" decision is UPSTREAM and generic (the progression-evaluator
 * selection pipeline: `derive-spans` → `constrained-span-pack`, proven in
 * csp01/csp02); this author simply TRANSLATES a window list into media-composition's
 * EDL. It is the L098 translation boundary: a caller hands over windows in ITS
 * language ({start,end}) and receives an EDL, never needing to know the EDL's
 * internal field names (`src_in`/`base_span`). It consumes the exact
 * `constrained-span-pack` output shape ({id,start,end,score,category}) directly.
 *
 * Pure + total: windows with a non-finite / non-positive-length range are SKIPPED
 * with a reason (never a broken segment); a missing base fails closed (no EDL with
 * an undefined base). All base_span segments share `edl.base.artifact` — the
 * single-recording highlight-reel case (a multi-source montage is the `clip`
 * segment variant, a separate author).
 *
 * =============================================================================
 * The extensive documentation in this codebase is a critical design feature.
 * You are forbidden from simplifying or removing it.
 * =============================================================================
 */

/**
 * @param {object} input
 * @param {string} input.baseArtifact - path/ref to the single base video the windows are cut from (required).
 * @param {Array<{start:number,end:number,overlaySource?:string}>} [input.windows] - time windows in seconds.
 * @param {object} [input.encode] - media-composition encode block (width/height/fps/crf/preset/audio_bitrate).
 * @param {string} [input.idPrefix='h'] - id prefix for generated segments.
 * @returns {{edl:object, segmentCount:number, skipped:Array<{index:number,reason:string}>, totalDurationS:number}}
 */
export function authorConcatEdl(input = {}) {
  const { baseArtifact, windows = [], encode, idPrefix = 'h' } = input;
  if (!baseArtifact) throw new Error('[author-concat-edl] baseArtifact is required');

  const valid = [];
  const skipped = [];
  windows.forEach((w, index) => {
    const start = Number(w?.start);
    const end = Number(w?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      skipped.push({ index, reason: 'invalid-window' });
      return;
    }
    valid.push({ start, end, overlaySource: w.overlaySource });
  });

  // Chronological order for playback (selection PRIORITY was salience upstream).
  valid.sort((a, b) => a.start - b.start);

  const round = (n) => +n.toFixed(4);
  const segments = valid.map((w, n) => ({
    id: `${idPrefix}${n}`,
    kind: 'base_span',
    src_in: round(w.start),
    src_out: round(w.end),
  }));

  const overlays = [];
  valid.forEach((w, n) => {
    if (typeof w.overlaySource === 'string' && w.overlaySource !== '') {
      overlays.push({ id: `ov${n}`, source: w.overlaySource, at_src: round(w.start), end_src: round(w.end) });
    }
  });

  const edl = {
    ...(encode ? { encode } : {}),
    base: { kind: 'video', artifact: baseArtifact },
    spine: { segments },
    ...(overlays.length ? { overlays } : {}),
  };

  return {
    edl,
    segmentCount: segments.length,
    skipped,
    totalDurationS: round(segments.reduce((s, seg) => s + (seg.src_out - seg.src_in), 0)),
  };
}
