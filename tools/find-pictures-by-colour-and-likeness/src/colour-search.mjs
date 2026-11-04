// src/colour-search.mjs
//
// PURPOSE
//   Finding pictures by colour and by likeness from facts a picture carries: its palette (`palette`, a list of #rrggbb,
//   src/workspace/file-facts.json) and, when an encoder made one, its embedding. Pure: callers hand rows
//   ({ id, palette?, embedding? }) and read ids back, the way src/workspace/file-facts.mjs reads rows. Thresholds and
//   sizes are DATA (src/colour-search.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Colour is compared in CIE-LAB (delta-E 1976), never in RGB.
//   2. A palette is the picture's leading colours plus a diverse top-up from its pixel histogram; two near-identical
//      colours never both take a slot.
//   3. "More like this" never goes silent: no usable embedding, too few pictures, or nothing over the floor falls back to
//      palette distance, a deterministic non-AI signal. The two are a fallback chain, not a fused score.
//   4. The anchor itself is never its own result.
import settings from './colour-search.json' with { type: 'json' };
import { cosine } from './meaning.mjs';

const HEX = /^#?([0-9a-f]{6})$/i;
export const rgbOf = hex => {
  const match = HEX.exec(String(hex ?? '').trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const hexOf = ([r, g, b]) => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;

const linear = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const pivot = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
/** sRGB [r,g,b] (0..255) as CIE-LAB under D65. */
export function labOf([r, g, b]) {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const x = pivot((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const y = pivot(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const z = pivot((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const labs = palette => (Array.isArray(palette) ? palette : []).map(rgbOf).filter(Boolean).map(labOf);

/**
 * A palette from RGBA pixels (Uint8ClampedArray, any size already scaled down by the caller): `leading` colours first
 * (hex), then the most common histogram colours, each at least `diversity_l1` away from every colour already kept.
 */
export function paletteOf(pixels, leading = [], config = settings) {
  const shift = 8 - config.histogram_bits;
  const counts = new Map();
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    if (pixels[at + 3] < 128) continue;
    const key = ((pixels[at] >> shift) << (2 * config.histogram_bits)) | ((pixels[at + 1] >> shift) << config.histogram_bits) | (pixels[at + 2] >> shift);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const mask = (1 << config.histogram_bits) - 1;
  const centre = key => [((key >> (2 * config.histogram_bits)) & mask), ((key >> config.histogram_bits) & mask), key & mask].map(v => Math.min(255, (v << shift) + (1 << shift >> 1)));
  const kept = [];
  const take = rgb => {
    if (kept.length >= config.palette_size) return;
    if (kept.some(other => Math.abs(other[0] - rgb[0]) + Math.abs(other[1] - rgb[1]) + Math.abs(other[2] - rgb[2]) < config.diversity_l1)) return;
    kept.push(rgb);
  };
  for (const hex of leading) { const rgb = rgbOf(hex); if (rgb) take(rgb); }
  for (const [key] of [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])) take(centre(key));
  return kept.map(hexOf);
}

/** Ids of rows whose palette holds a colour within `ceiling` of `hex`, over the leading `top` colours when given. */
export function matchColour(rows, hex, { ceiling = settings.typed_hex_ceiling, top = null } = {}) {
  const wanted = rgbOf(hex);
  if (!wanted) return [];
  const want = labOf(wanted);
  return rows.filter(row => labs(top ? (row.palette ?? []).slice(0, top) : row.palette).some(lab => deltaE(lab, want) <= ceiling)).map(row => row.id);
}

/** A colour the person named in words (already looked up as a hex): the stricter ceiling over the leading colours. */
export const matchNamedColour = (rows, hex, config = settings) => matchColour(rows, hex, config.named_colour);

const paletteGap = (a, b) => {
  const left = labs(a), right = labs(b);
  if (!left.length || !right.length) return Infinity;
  const side = (from, to) => from.reduce((sum, lab) => sum + Math.min(...to.map(other => deltaE(lab, other))), 0) / from.length;
  return (side(left, right) + side(right, left)) / 2;
};

/** Rows like the anchor: { ids, by } where by is 'embedding' or 'palette'. */
export function similarTo(rows, anchorId, config = settings.similar) {
  const anchor = rows.find(row => row.id === anchorId);
  const others = rows.filter(row => row.id !== anchorId);
  if (!anchor) return { ids: [], by: 'palette' };
  if (Array.isArray(anchor.embedding) && rows.length >= config.min_rows) {
    const scored = others.filter(row => Array.isArray(row.embedding) && row.embedding.length === anchor.embedding.length)
      .map(row => ({ id: row.id, score: cosine(anchor.embedding, row.embedding) })).filter(row => row.score >= config.embedding_floor)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    if (scored.length) return { ids: scored.slice(0, config.limit).map(row => row.id), by: 'embedding' };
  }
  const near = others.map(row => ({ id: row.id, gap: paletteGap(anchor.palette, row.palette) })).filter(row => row.gap <= config.palette_ceiling)
    .sort((a, b) => a.gap - b.gap || (a.id < b.id ? -1 : 1));
  return { ids: near.slice(0, config.limit).map(row => row.id), by: 'palette' };
}

/** The colours a question asks for: each typed #rrggbb (typed ceiling) and each colour word of `names` (named ceiling, leading colours only). */
export function coloursIn(question, config = settings) {
  const text = String(question ?? '');
  const asked = [...text.matchAll(/#[0-9a-f]{6}\b/gi)].map(match => ({ hex: match[0].toLowerCase(), ceiling: config.typed_hex_ceiling, top: null }));
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const hex = Object.hasOwn(config.names, word) ? config.names[word] : null;
    if (hex) asked.push({ hex, ceiling: config.named_colour.ceiling, top: config.named_colour.top });
  }
  return asked;
}
