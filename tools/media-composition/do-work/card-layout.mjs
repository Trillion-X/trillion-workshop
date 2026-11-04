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
    return [
      `drawtext=textfile='${line.textfile}'`,
      'expansion=none',
      'x=(w-text_w)/2',
      `y=${y}`,
      `fontsize=${size}`,
      `fontcolor=${color}`,
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
