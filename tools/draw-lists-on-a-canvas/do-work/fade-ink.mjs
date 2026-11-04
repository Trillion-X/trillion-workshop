// tools/draw-lists-on-a-canvas/do-work/fade-ink.mjs
//
// How visible each live ink mark is at one instant, and when it is gone: the canvas's own fade rule
// (read-data/ink-fade.ts, which show/AddressedMarkLayer.tsx draws marks with) run for a list of marks. A mark is fully
// seen for hold_ms after it was made, fades in a straight line to nothing over fade_ms, and is not drawn after that; a
// mark with no usable time never fades. No clock is read (the instant is given), nothing is drawn, no mark is changed
// or deleted: a faded mark is still the person's record, only no longer drawn.
//
// Input:  { now, fade: { hold_ms, fade_ms }, marks: [{ ref, created_at? }] }
//           now: the instant asked about, an ISO time or milliseconds since the epoch;
//           created_at: when the mark was made (ISO); left out or unreadable, the mark is always shown.
// Answer: { marks: [{ ref, opacity, shown, gone_at }], shown, gone }
//           opacity 1 fully seen to 0 gone; gone_at the ISO instant the mark goes, or null when it never does;
//           shown and gone count the marks still drawn and the marks gone.
// Refuses: no marks, a mark without a ref, a now that is not a time, or hold_ms / fade_ms that are not numbers of zero or more.
import { inkGoneAt, inkOpacity } from '../read-data/ink-fade.ts';

const instant = now => (typeof now === 'number' ? now : typeof now === 'string' ? Date.parse(now) : Number.NaN);

export function fadeInk({ now, fade, marks } = {}) {
  if (!Array.isArray(marks) || marks.length === 0) throw new Error('Give marks: a list of { ref, created_at? }, for example [{ "ref": "mark:1", "created_at": "2026-01-05T10:00:00Z" }].');
  const at = instant(now);
  if (!Number.isFinite(at)) throw new Error('Give now: the instant to look at, as an ISO time such as "2026-01-05T10:00:05Z" or milliseconds since the epoch.');
  const hold_ms = fade?.hold_ms;
  const fade_ms = fade?.fade_ms;
  for (const [name, value] of [['hold_ms', hold_ms], ['fade_ms', fade_ms]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Give fade.${name}: milliseconds, a number of zero or more (hold_ms: how long a mark is fully seen; fade_ms: how long it takes to go).`);
  }
  const rules = { hold_ms, fade_ms, tick_ms: 0 };
  const answered = marks.map((mark, index) => {
    if (typeof mark?.ref !== 'string' || !mark.ref) throw new Error(`Mark ${index} needs ref: the mark's id as text.`);
    const createdAt = typeof mark.created_at === 'string' ? mark.created_at : undefined;
    const opacity = inkOpacity(createdAt, at, rules);
    const gone = inkGoneAt(createdAt, rules);
    return { ref: mark.ref, opacity, shown: opacity > 0, gone_at: gone === null ? null : new Date(gone).toISOString() };
  });
  const shown = answered.filter(mark => mark.shown).length;
  return { marks: answered, shown, gone: answered.length - shown };
}
