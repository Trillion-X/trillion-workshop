// tools/media-composition/read-data/looks.mjs
//
// PURPOSE
//   Turn a person's colour choices for one clip (looks, adjustment numbers, framing, a clip to match colour to) and
//   their timed changes into the render fields video-compose.mjs already reads. The choices are DATA (looks.json);
//   this file is the one mapping from those rows to render fields, used by the editor screen, the grade-a-video tool
//   and tests alike.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No look, adjustment or fit is named here. Each looks.json row carries the render fields it sets; adding one
//      is a DATA row.
//   2. Choices are identities and bounded numbers. Unknown looks, out-of-range numbers and malformed rows throw a
//      plain-language error; nothing a caller types becomes a filter.
//   3. Neutral values add nothing, so a clip with no colour choices renders exactly as before.
//   4. Pure: no file, network or clock access. Safe in the browser, the Worker and a container.

import LOOKS from './looks.json' with { type: 'json' };
import { adjustmentFilter, validateAdjustments } from './adjustment-layers.mjs';

export { LOOKS };
const lookById = new Map(LOOKS.looks.map(look => [look.id, look]));
const groupById = new Map(LOOKS.groups.map(group => [group.id, group]));
const fitById = new Map(LOOKS.fits.map(fit => [fit.id, fit]));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round3 = value => Math.round(value * 1000) / 1000;

/** Merge render fields in order: lists join, objects merge, anything else is replaced by the later value. */
export function mergeFields(...parts) {
  const out = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part ?? {})) {
      if (Array.isArray(value) && Array.isArray(out[key])) out[key] = [...out[key], ...structuredClone(value)];
      else if (object(value) && object(out[key])) out[key] = mergeFields(out[key], value);
      else out[key] = structuredClone(value);
    }
  }
  return out;
}

/** The looks in the order to apply them, each checked; a group marked one_at_a_time keeps only its last pick. */
export function chooseLooks(ids = []) {
  if (!Array.isArray(ids) || ids.length > 32) throw new Error('Choose up to 32 looks.');
  const chosen = ids.map(id => {
    const look = lookById.get(id);
    if (!look) throw new Error(`There is no look called "${id}". Choose one of: ${[...lookById.keys()].join(', ')}.`);
    return look;
  });
  return chosen.filter((look, index) => !groupById.get(look.group)?.one_at_a_time
    || !chosen.slice(index + 1).some(later => later.group === look.group));
}

/** Render fields for adjustment numbers keyed by looks.json adjustment id; neutral values add nothing. */
export function adjustmentFields(values = {}) {
  if (!object(values)) throw new Error('Send adjustments as numbers by name.');
  let fields = {};
  for (const [id, value] of Object.entries(values)) {
    const row = LOOKS.adjustments.find(item => item.id === id);
    if (!row) throw new Error(`There is no adjustment called "${id}". Choose one of: ${LOOKS.adjustments.map(item => item.id).join(', ')}.`);
    if (!Number.isFinite(value) || value < row.min || value > row.max) throw new Error(`${row.label} must be between ${row.min} and ${row.max}.`);
    if (value === row.neutral) continue;
    fields = mergeFields(fields, row.field.reduceRight((inner, key) => ({ [key]: inner }), round3(value)));
  }
  return fields;
}

/** A CSS filter approximating the adjustments for a live preview (rows without `preview` are not shown live). */
export function adjustmentPreviewFilter(values = {}) {
  return LOOKS.adjustments.filter(row => row.preview && Number.isFinite(values[row.id]) && values[row.id] !== row.neutral)
    .map(row => `${row.preview.filter}(${round3(Math.max(0, row.preview.at_neutral + row.preview.per_unit * (values[row.id] - row.neutral)))})`).join(' ');
}

/**
 * Render fields that place the chosen frame on the clip: `fit` (a looks.json fit id), `zoom` (1..4), the point of the
 * picture to keep centred (`x`, `y`, 0..1 of the source) and an optional mirror (`flip`: h, v or hv). The zoom
 * window keeps the source's shape; the fit then takes the frame's shape out of it, so the picture is never stretched.
 */
export function framingFields(framing = {}, [width, height] = []) {
  if (!object(framing)) throw new Error('Send framing as fit, zoom, x and y.');
  const fit = fitById.get(framing.fit ?? LOOKS.fits[0].id);
  if (!fit) throw new Error(`Fit is one of: ${[...fitById.keys()].join(', ')}.`);
  const zoom = framing.zoom ?? 1, x = framing.x ?? 0.5, y = framing.y ?? 0.5;
  if (![zoom, x, y].every(Number.isFinite) || zoom < 1 || zoom > 4 || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('Zoom is 1 to 4 and the position is 0 to 1 across and down.');
  if (framing.flip !== undefined && !['h', 'v', 'hv'].includes(framing.flip)) throw new Error('Mirror is h, v or hv.');
  if (!(width > 0 && height > 0)) throw new Error('Choose a frame size first.');
  const size = round3(1 / zoom);
  const left = round3(clamp(x - size / 2, 0, 1 - size)), top = round3(clamp(y - size / 2, 0, 1 - size));
  return {
    ...(zoom > 1 ? { crop_rect: { x: left, y: top, w: size, h: size } } : {}),
    reframe: { aspect_w: width, aspect_h: height, ...structuredClone(fit.reframe), track: [{ t: 0, cx: round3(clamp((x - left) / size, 0, 1)), cy: round3(clamp((y - top) / size, 0, 1)) }] },
    ...(framing.flip ? { flip: framing.flip } : {}),
  };
}

/** Render fields that match this clip's colour to another file at a moment (`reference` is that file). */
export function colourMatchFields(match) {
  if (match === undefined || match === null) return {};
  if (!object(match) || typeof match.reference !== 'string' || !match.reference) throw new Error('Choose the clip to match colour to.');
  if (match.at !== undefined && (!Number.isFinite(match.at) || match.at < 0)) throw new Error('The moment to match must be 0 seconds or later.');
  return { colour_match: { reference: match.reference, ...(match.at !== undefined ? { at: round3(match.at) } : {}) } };
}

/** Every render field one clip's colour choices add: { looks, adjust, framing, match } within a frame [width, height]. */
export function clipColourFields(choice = {}, frame) {
  if (!object(choice)) throw new Error('Send the clip\'s colour choices as an object.');
  return mergeFields(
    colourMatchFields(choice.match),
    ...chooseLooks(choice.looks ?? []).map(look => look.segment),
    adjustmentFields(choice.adjust ?? {}),
    choice.framing ? framingFields(choice.framing, frame) : {},
  );
}

/** Whether a look can be given a time range: only looks made purely of colour layers can. */
export function lookCanBeTimed(id) {
  const look = lookById.get(id);
  return Boolean(look) && Object.keys(look.segment).length === 1 && Array.isArray(look.segment.grade_layers);
}

/**
 * The render's adjustment layers for timed changes over the whole video: `adjustments` rows
 * ({ id, start, end, <timed_adjustments ids> }) and `looks` rows ({ id, look, start, end }), in the video's seconds.
 */
export function timedLayers({ adjustments = [], looks = [] } = {}, duration = Infinity) {
  if (!Array.isArray(adjustments) || !Array.isArray(looks) || adjustments.length + looks.length > 64) throw new Error('Use up to 64 timed changes.');
  const neutral = Object.fromEntries(LOOKS.timed_adjustments.map(field => [field.id, field.neutral]));
  const rows = validateAdjustments(adjustments.map(row => ({ name: 'Adjustment', ...neutral, ...row, x: 0, y: 0, width: 1, height: 1 })), duration) ?? [];
  const layers = rows.map(row => ({ start: row.start, end: row.end, filter: adjustmentFilter(row) }));
  for (const row of looks) {
    if (!object(row) || !lookCanBeTimed(row.look)) throw new Error('Choose a colour look for a timed change.');
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end <= row.start || row.end > duration + 0.05) throw new Error('A timed look needs an end later than its start, inside the video.');
    for (const layer of lookById.get(row.look).segment.grade_layers) layers.push({ start: row.start, end: row.end, filter: layer.grade, ...(layer.grade_lut_ref ? { grade_lut_ref: layer.grade_lut_ref } : {}) });
  }
  return layers;
}
