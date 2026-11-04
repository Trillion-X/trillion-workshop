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
//       - label {textfile,corner?,size?,color?,box?,box_color?,pad?}  drawtext burned
//                          into the cell AFTER scale (size/position in OUTPUT px).
//                          `textfile` is a path the I/O layer (video-compose) wrote —
//                          using textfile, NOT text=, sidesteps ffmpeg's multi-level
//                          escaping entirely (text with `:` `%` `'` etc. breaks text=;
//                          textfile is bulletproof — verified). corner ∈ tl|tr|bl|br.
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
 * @typedef {{textfile:string, corner?:'tl'|'tr'|'bl'|'br', size?:number, color?:string, box?:boolean, box_color?:string, pad?:number}} LabelSpec
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
function drawtextFilter(label, ch) {
  const pad = Number.isFinite(label.pad) ? label.pad : Math.round(ch * 0.03);
  const size = Number.isFinite(label.size) ? label.size : Math.round(ch * 0.05);
  const color = label.color || 'white';
  const corner = label.corner || 'tl';
  const x = corner === 'tr' || corner === 'br' ? `w-text_w-${pad}` : `${pad}`;
  const y = corner === 'bl' || corner === 'br' ? `h-text_h-${pad}` : `${pad}`;
  const parts = [
    `textfile='${label.textfile}'`,
    'expansion=none',
    `x=${x}`,
    `y=${y}`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
  ];
  if (label.box !== false) {
    parts.push('box=1', `boxcolor=${label.box_color || 'black@0.5'}`, `boxborderw=${Math.round(size * 0.3)}`);
  }
  return `drawtext=${parts.join(':')}`;
}
