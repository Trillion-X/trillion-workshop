// tools/media-composition/read-data/caption-styles.mjs
//
// PURPOSE
//   The one caption style builder. A style is a row of read-data/caption-styles.json; this turns any style and a
//   list of timed caption lines into the subtitle the render burns in (`edl.subtitles.ass`, video-compose.mjs), through
//   the one subtitle author (do-work/author-karaoke-captions.mjs). The editor's captions panel, cut-and-caption.mjs
//   (tool:add-captions, tool:cut-and-caption) and any AI naming a style all come through here, so a style looks the
//   same wherever it is used.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No style is named in code: every choice (font, size, colours, outline, shadow offset/blur/spread/colour/opacity, place, word-by-word reveal,
//      how words are gathered into lines) is read from the style row, so a new style is one DATA row.
//   2. Pure: no I/O, no clock, runs in a page, a Worker and the render container alike.
//   3. Sizes scale with the frame: style pixels are measured on a frame whose shorter side is the catalog's
//      `measured_at_short_side`, so a style reads the same on a 1080x1920 reel and a 3840x2160 film.
//   4. A caption line's own position (x, y as fractions of the frame) wins; a line without one sits at the style's.
//   5. Word timings are used only when they still spell the line's text; an edited line lights its words up evenly
//      across its time, never with stale times.

import catalog from './caption-styles.json' with { type: 'json' };
import { karaokeAss } from '../do-work/author-karaoke-captions.mjs';

/** Every caption style, in the order a person is offered them. */
export const CAPTION_STYLES = catalog.styles;
/** The style used when none is chosen. */
export const DEFAULT_CAPTION_STYLE = catalog.default;
/** The inspector rows that change a style field by field (each row's `path` is the field it changes). */
export const CAPTION_STYLE_SETTINGS = catalog.settings;
/** The shorter frame side a style's pixels are measured on. */
export const CAPTION_MEASURED_AT = catalog.measured_at_short_side;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The full style for a choice: a style id, or a style row of one's own. A row may name the catalog style it starts
 * from as `id` and change any of its fields (nested `colours`, `position`, `grouping`, `preview` merge field by field).
 * Nothing chosen is the default style. An id the catalog does not hold is refused with the ones it does.
 */
export function resolveCaptionStyle(choice) {
  const own = plain(choice) ? choice : {};
  const id = typeof choice === 'string' && choice.trim() ? choice.trim() : typeof own.id === 'string' && own.id ? own.id : DEFAULT_CAPTION_STYLE;
  const base = CAPTION_STYLES.find(style => style.id === id);
  if (!base) throw new Error(`There is no caption style "${id}". Choose one of: ${CAPTION_STYLES.map(style => style.id).join(', ')}, or describe your own.`);
  const merged = { ...base };
  for (const [key, value] of Object.entries(own)) merged[key] = plain(value) && plain(base[key]) ? { ...base[key], ...value } : value;
  return merged;
}

/** A line's words with their times: its own when they still spell its text, else its text spread over its time. */
export function timedWords(line) {
  const text = String(line?.text ?? '').trim();
  const own = Array.isArray(line?.words) ? line.words.filter(word => String(word?.text ?? '').trim() && Number.isFinite(word?.start) && Number.isFinite(word?.end)) : [];
  if (own.length && own.map(word => String(word.text).trim()).join(' ').replace(/\s+/g, ' ') === text.replace(/\s+/g, ' ')) return own.map(word => ({ text: String(word.text).trim(), start: word.start, end: word.end }));
  const tokens = text.split(/\s+/).filter(Boolean);
  const letters = tokens.reduce((sum, token) => sum + token.length, 0);
  const span = Math.max(0, line.end - line.start);
  let at = line.start;
  return tokens.map(token => {
    const start = at;
    at += letters ? span * token.length / letters : 0;
    return { text: token, start, end: at };
  });
}

/** A style's shadow row with its pixels (offset, blur, spread) measured on the real frame. */
export function scaledShadow(shadow, scale) {
  if (!plain(shadow)) return null;
  return { ...shadow, x: shadow.x * scale, y: shadow.y * scale, blur: shadow.blur * scale, spread: shadow.spread * scale };
}

/**
 * The subtitle for timed caption lines ({ text, start, end, x?, y?, words? }) in a style, on a width x height frame.
 * Returns undefined when no line has words to show.
 */
export function captionAss(lines, choice, { width, height }) {
  const style = resolveCaptionStyle(choice);
  const scale = Math.min(width, height) / catalog.measured_at_short_side;
  const shown = (Array.isArray(lines) ? lines : [])
    .filter(line => String(line?.text ?? '').trim() && Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start)
    .map(line => ({
      text: String(line.text),
      start: line.start,
      end: line.end,
      x: Number.isFinite(line.x) ? line.x : style.position.x,
      y: Number.isFinite(line.y) ? line.y : style.position.y,
      words: timedWords(line),
    }));
  if (!shown.length) return undefined;
  return karaokeAss(shown, {
    reveal: style.reveal,
    font: style.font,
    size: style.size * scale,
    bold: style.bold ? 1 : 0,
    italic: style.italic === true,
    outlineW: style.outline * scale,
    shadow: scaledShadow(style.shadow, scale),
    highlight: style.colours.spoken,
    base: style.colours.upcoming,
    outline: style.colours.outline,
    // The style's position is where a caption's bottom-centre sits, so a two-line caption grows upward.
    anchor: 2,
    playResX: width,
    playResY: height,
  });
}
