// tools/check-a-site-build-in-a-browser/do-work/judge.mjs
//
// Purpose
//   The rules that refuse a built page, from what was measured on it and on the live page. All numbers and sentences are
//   the settings' (settings.json); this file holds only the comparisons.
//
// Non-negotiable invariants
//   1. With a live page: refused when the built height is under min_height_to_live of the live height, when it shows no text
//      where the live page shows some (a blank page is a full window tall, so a short live page hides it from the height rule),
//      when it threw an error the live page did not, when its reading font is a serif default and the live one is not, or when
//      it shows under min_parts_to_live of the live page's count of any kind of part (settings.parts) that the live page shows
//      at least min_live_parts of: a page with its words but not its pictures, videos, buttons or form is not the page (the
//      Nov 25 2026 home passed height, font and errors with a third of live's pictures and buttons and no form).
//   2. With no live page (the live address answers 404): refused when the built page threw any error or shows no text.
//   3. The height rule compares the exact ratio; height_to_live is that ratio rounded to three places for display, and is 1 when there is no live page.
const fill = (text, fields) => text.replace(/\{(\w+)\}/g, (_, name) => String(fields[name]));

/** The page's result row from the built and live measurements (live is null when no live page exists). */
export function judge({ kind, url, liveUrl, built, live, shots, settings }) {
  const serif = font => Boolean(font) && new RegExp(settings.serif_pattern, 'i').test(font);
  const newErrors = built.errors.filter(error => !(live ? live.errors : []).includes(error));
  const exact = live && live.height > 0 ? built.height / live.height : 1;
  const ratio = Math.round(exact * 1000) / 1000;
  const serifWhereLiveIsNot = Boolean(live) && serif(built.font) && !serif(live.font);
  const why = [];
  if (live) {
    if (exact < settings.min_height_to_live) why.push(fill(settings.words.short, { height_px: built.height, height_to_live: ratio, live_height_px: live.height, min_height_to_live: settings.min_height_to_live }));
    if (built.text < 1 && live.text >= 1) why.push(fill(settings.words.blank, { live_text: live.text }));
    if (newErrors.length) why.push(fill(settings.words.errors, { count: newErrors.length, errors: JSON.stringify(newErrors) }));
    if (serifWhereLiveIsNot) why.push(fill(settings.words.serif, { font: built.font, live_font: live.font ?? 'none' }));
    for (const name of fewerParts(built, live, settings)) why.push(fill(settings.words.fewer_parts, { part: name, count: built.parts[name], live_count: live.parts[name], min_parts_to_live: settings.min_parts_to_live }));
  } else {
    if (built.errors.length) why.push(fill(settings.words.absolute_errors, { errors: JSON.stringify(built.errors) }));
    if (built.text < 1) why.push(fill(settings.words.absolute_blank, {}));
  }
  return {
    kind, url, live_url: liveUrl,
    height_px: built.height, live_height_px: live ? live.height : null, height_to_live: ratio,
    new_page_errors: newErrors, reading_font: built.font, live_reading_font: live ? live.font : null,
    serif_where_live_is_not: serifWhereLiveIsNot, visible_text_chars: built.text, live_visible_text_chars: live ? live.text : null,
    parts: built.parts ?? null, live_parts: live ? live.parts ?? null : null, fewer_parts: live ? fewerParts(built, live, settings) : [],
    screenshots: shots, refused: why.length > 0, why,
  };
}

/** The kinds of part the built page shows under min_parts_to_live of, where the live page shows at least min_live_parts. */
export function fewerParts(built, live, settings) {
  return Object.keys(settings.parts).filter(name => {
    const seen = live.parts?.[name] ?? 0;
    return seen >= settings.min_live_parts && (built.parts?.[name] ?? 0) / seen < settings.min_parts_to_live;
  });
}

/** A refused row for a page that could not be measured at all. */
export function refusedUnmeasured({ kind, url, liveUrl, shots, reason }) {
  return { kind, url, live_url: liveUrl, height_px: null, live_height_px: null, height_to_live: null, new_page_errors: [], reading_font: null,
    live_reading_font: null, serif_where_live_is_not: false, visible_text_chars: null, live_visible_text_chars: null, parts: null, live_parts: null, fewer_parts: [],
    screenshots: shots, refused: true, why: [reason] };
}

export { fill };
