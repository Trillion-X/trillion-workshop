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
//       - fit  {fill:'blur', cell:[w,h], inner:{w,h,x,y}, sigma?, dim?}  the crop is shown WHOLE, scaled to `inner`
//                          (cell px) and laid on a fill made of the same picture scaled to cover the cell, blurred
//                          (gaussian `sigma`) and darkened (`dim`, the fraction of light kept): the usual vertical
//                          video fill, for a movement whose crop cannot take the cell's shape inside its source.
//                          The producer that measured the movement places `inner`; `cell` must be this cell's size.
//   • TEMPORAL, PER-SOURCE, LENGTH-CHECKED (`sources[i].hold|ramp|smooth`): a cell may hold
//       one frame or play its own speed envelope (a phase-synced reference) when the
//       compositor has checked that every cell still comes out the same length, which
//       keeps the stack from desyncing. Identity when absent.

/**
 * Build the video filter graph for a split.
 * @param {{count:number, layout?:string, weights?:number[], width:number, height:number, fps:string|number, speed?:number, sources?:SourceTransform[]}} spec
 * @typedef {{crop?:{w:number,h:number,x:number,y:number}, flip?:'h'|'v'|'hv', hold?:string, ramp?:string, smooth?:string, frames?:number, fit?:FitSpec, label?:LabelSpec}} SourceTransform
 * @typedef {{fill:'blur', cell:[number,number], inner:{w:number,h:number,x:number,y:number}, sigma?:number, dim?:number}} FitSpec
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
    // A cell's own time: a held frame (`hold`, the compositor's hold fragment, the same one a clip's still uses), or a speed envelope (`ramp`, a setpts expression of
    // input time made by the compositor), then the segment-wide speed on top. `smooth` (a filter fragment) makes the
    // in-between frames of a slowed cell. Every cell must come out the same length; the compositor checks that.
    if (t.hold) parts.push(t.hold);
    if (t.ramp) parts.push(`setpts=(${t.ramp})/TB`);
    if (retime) parts.push(`setpts=PTS/${speed}`);
    if (t.smooth) parts.push(t.smooth);
    const after = [norm];
    // `frames`: the cell's exact length; its last frame is held past its end and the compositor stops the output there.
    if (Number.isInteger(t.frames)) after.push(`tpad=stop_mode=clone:stop=${t.frames}`);
    if (t.label && t.label.textfile) after.push(drawtextFilter(t.label, ch));
    if (!t.fit) return `[${i}:v]${[...parts, `scale=${cw}:${ch}`, ...after].join(',')}[${scaleLabel(i)}]`;
    const { inner, sigma, dim } = fitOf(t.fit, cw, ch);
    return [`[${i}:v]${parts.join(',')},split[f${i}a][f${i}b]`,
      `[f${i}a]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},gblur=sigma=${sigma},colorchannelmixer=rr=${dim}:gg=${dim}:bb=${dim}[f${i}fill]`,
      `[f${i}b]scale=${inner.w}:${inner.h}[f${i}whole]`,
      `[f${i}fill][f${i}whole]overlay=${inner.x}:${inner.y},${after.join(',')}[${scaleLabel(i)}]`].join(';');
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

/** A fitted cell's checked geometry (made for this very cell size, its whole picture inside the cell) and its fill's
 *  look: blur strength (gaussian sigma, cell px, 40 when the fit names none) and the fraction of light kept (0.45). */
function fitOf(fit, cw, ch) {
  if (fit.fill !== 'blur') throw new Error(`[split] fit.fill must be 'blur', not ${JSON.stringify(fit.fill)}`);
  if (!Array.isArray(fit.cell) || fit.cell[0] !== cw || fit.cell[1] !== ch)
    throw new Error(`[split] the fit was made for a ${fit.cell} cell, this cell is ${cw}x${ch}`);
  const { w, h, x, y } = fit.inner ?? {};
  if (![w, h, x, y].every(Number.isInteger) || w < 2 || h < 2 || x < 0 || y < 0 || x + w > cw || y + h > ch)
    throw new Error(`[split] fit.inner ${JSON.stringify(fit.inner)} is not a picture inside the ${cw}x${ch} cell`);
  const sigma = Number.isFinite(fit.sigma) && fit.sigma >= 0 ? fit.sigma : 40;
  const dim = Number.isFinite(fit.dim) && fit.dim >= 0 && fit.dim <= 1 ? fit.dim : 0.45;
  return { inner: fit.inner, sigma, dim };
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
