// parts/media-composition/read-data/preview-grade.mjs
//
// PURPOSE
//   The fast preview path for a video's colour adjustments: the same render fields grade-a-video sends to ffmpeg
//   (looks.mjs adjustmentFields), applied to a frame's pixels in the browser by a twin of each ffmpeg filter, in the
//   order the compositor pushes them (looks.json `preview_chain`). A person moving a control sees the frame change at
//   once; the full render stays the saved result, and the two are compared on the same frame to prove they agree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One mapping: choices become render fields only through looks.mjs; this file never reads an adjustment id.
//   2. Each twin is keyed by the render field it mirrors (`color_adjust` = eq, `warmth` = colortemperature,
//      `vibrance` = vibrance, `exposure` = exposure). A render field without a twin is reported by `unpreviewed`, so a
//      screen says it shows only in the saved copy instead of pretending it is applied.
//   3. Pure and allocation-light: lookup tables are built once per set of choices; a frame is changed in place.
//
// KEY CONCEPTS
//   Frames arrive as RGBA bytes. ffmpeg's eq works on luma and chroma, so the eq twin converts each pixel to the BT.709
//   limited-range codes a decoded video carries, applies the eq tables to those codes, and converts back; the other three filters work on RGB as ffmpeg's do.

import { LOOKS, adjustmentFields } from './looks.mjs';

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);
// ffmpeg's 8-bit filters keep whole values by cutting the fraction off (av_clip_uint8 of a float).
const quantize = value => Math.floor(clamp01(value) * 255) / 255;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// ffmpeg vf_eq.c create_lut: v = contrast * (v - 0.5) + 0.5 + brightness, then gamma, scaled by 256 and clipped.
function eqTable(contrast, brightness, gamma = 1, weight = 1) {
  const table = new Uint8ClampedArray(256);
  for (let at = 0; at < 256; at++) {
    let v = contrast * (at / 255 - 0.5) + 0.5 + brightness;
    if (v <= 0) { table[at] = 0; continue; }
    v = v * (1 - weight) + Math.pow(v, 1 / gamma) * weight;
    table[at] = v >= 1 ? 255 : Math.floor(256 * v);
  }
  return table;
}

// ffmpeg vf_colortemperature.c kelvin2rgb.
export function kelvinToRgb(kelvin) {
  const k = kelvin / 100;
  let r, g, b;
  if (k <= 66) { r = 1; g = 0.39008157876901960784 * Math.log(k) - 0.63184144378862745098; }
  else { const t = Math.max(k - 60, 0); r = 1.29293618606274509804 * Math.pow(t, -0.1332047592); g = 1.12989086089529411765 * Math.pow(t, -0.0755148492); }
  if (k >= 66) b = 1; else if (k <= 19) b = 0; else b = 0.54320678911019607843 * Math.log(k - 10) - 1.19625408914;
  return [clamp01(r), clamp01(g), clamp01(b)];
}

// One twin per render field: (params) => (r, g, b in 0..1, out) writes the changed pixel into out. Order is DATA.
const TWINS = {
  color_adjust: params => {
    const luma = eqTable(Number.isFinite(params.contrast) ? params.contrast : 1, Number.isFinite(params.brightness) ? params.brightness : 0, Number.isFinite(params.gamma) && params.gamma > 0 ? params.gamma : 1);
    const chroma = eqTable(Number.isFinite(params.saturation) ? params.saturation : 1, 0);
    const code = value => Math.min(255, Math.max(0, Math.round(value)));
    return (r, g, b, out) => {
      // The raw BT.709 limited-range codes a decoded video carries (Y 16..235, Cb and Cr 16..240), which eq's
      // tables are applied to, then back to RGB the way the next filter receives it.
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const y2 = (luma[code(16 + 219 * y)] - 16) / 219;
      const cb2 = (chroma[code(128 + 224 * (b - y) / 1.8556)] - 128) / 224;
      const cr2 = (chroma[code(128 + 224 * (r - y) / 1.5748)] - 128) / 224;
      out[0] = y2 + 1.5748 * cr2;
      out[1] = y2 - 0.1873 * cb2 - 0.4681 * cr2;
      out[2] = y2 + 1.8556 * cb2;
    };
  },
  warmth: params => {
    const amount = Math.min(1, Math.max(-1, Number.isFinite(params.amount) ? params.amount : 0));
    const [mr, mg, mb] = kelvinToRgb(Math.round(6500 - amount * 3500));
    return (r, g, b, out) => { out[0] = r * mr; out[1] = g * mg; out[2] = b * mb; };
  },
  vibrance: params => {
    const intensity = Math.min(1, Math.max(-1, Number.isFinite(params.intensity) ? params.intensity : 0));
    // ffmpeg vf_vibrance.c with its defaults (alternate off, rlum 0.212656, glum 0.715158, blum 0.072186).
    const sign = Math.sign(intensity);
    return (r, g, b, out) => {
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      const luma = r * 0.212656 + g * 0.715158 + b * 0.072186;
      const amount = 1 + intensity * (1 + sign * saturation);
      out[0] = luma + (r - luma) * amount; out[1] = luma + (g - luma) * amount; out[2] = luma + (b - luma) * amount;
    };
  },
  exposure: params => {
    const scale = Math.pow(2, Math.min(2, Math.max(-2, Number.isFinite(params.stops) ? params.stops : 0)));
    return (r, g, b, out) => { out[0] = r * scale; out[1] = g * scale; out[2] = b * scale; };
  },
};

/** The render fields these adjustments set that no twin can show live (they show only in the saved copy). */
export function unpreviewed(adjust = {}) {
  return Object.keys(adjustmentFields(adjust)).filter(field => !TWINS[field]);
}

/** Which adjustment ids (looks.json) the live preview shows. */
export const previewedAdjustments = () => LOOKS.adjustments.filter(row => TWINS[row.field[0]]).map(row => row.id);

/**
 * A function that changes RGBA frame bytes in place to look as the render will, or null when the adjustments change
 * nothing the preview can show.
 */
export function frameGrader(adjust = {}) {
  const fields = adjustmentFields(adjust);
  const order = LOOKS.preview_chain ?? Object.keys(TWINS);
  const steps = order.filter(field => object(fields[field]) && TWINS[field]).map(field => TWINS[field](fields[field]));
  if (!steps.length) return null;
  const pixel = [0, 0, 0];
  return data => {
    for (let at = 0; at < data.length; at += 4) {
      pixel[0] = data[at] / 255; pixel[1] = data[at + 1] / 255; pixel[2] = data[at + 2] / 255;
      // Each filter hands the next whole 8-bit values, as ffmpeg's planes do between filters.
      for (const step of steps) { step(quantize(pixel[0]), quantize(pixel[1]), quantize(pixel[2]), pixel); }
      data[at] = clamp01(pixel[0]) * 255 + 0.5; data[at + 1] = clamp01(pixel[1]) * 255 + 0.5; data[at + 2] = clamp01(pixel[2]) * 255 + 0.5;
    }
    return data;
  };
}
