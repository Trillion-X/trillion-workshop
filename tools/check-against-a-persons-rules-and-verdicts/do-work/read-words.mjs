// tools/check-copy/do-work/read-words.mjs
//
// Purpose
//   Turns what a site or a deck publishes into units of words, so one check judges them all. A unit is
//   { kind, text, where, facts }. Pure functions over values the caller hands in (parsed JSON, HTML text, a deck's HTML):
//   this file reads no file, calls nothing and knows no product, person, word list or page.
//
// Non-negotiable invariants
//   1. Which strings are prose is decided by what a string is (not an address, id, date, colour, file name or one lower-case
//      token), never by a list of keys; the keys that are authoring metadata are the caller's `skip_keys`.
//   2. A source that yields no words is an error the caller sees (`wordsOfDeck` throws); nothing here turns "no words found"
//      into a pass.
//   3. One unit per distinct (kind, text), carrying every place it was found, so a line used on ten pages is judged once.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const NOT_PROSE = [
  /^(?:\/|#|https?:|mailto:|tel:|data:)/,
  /^[\w.:-]+$/,
  /^\d{4}-\d{2}-\d{2}(?:T[\d:.+Z-]+)?$/,
  /^#?[0-9a-f]{3,8}$/i,
  /^[^\s]+\.(?:png|jpe?g|webp|svg|gif|mp4|webm|css|js|json)$/i,
];

/** Whether a string is words a person reads. */
export const isProse = value => typeof value === 'string' && value.trim().length > 0 && !NOT_PROSE.some(rx => rx.test(value.trim()))
  && (/\s/.test(value.trim()) || /^[A-Z]/.test(value.trim()));

/** Every prose string in any JSON value, with its dot path; `skip_keys` names keys whose values are not read. */
export function proseIn(value, { skip_keys = [], prefix = '' } = {}, out = []) {
  const skip = new Set(skip_keys);
  const walk = (node, path) => {
    if (typeof node === 'string') { if (isProse(node)) out.push({ text: node, path }); return; }
    if (Array.isArray(node)) { node.forEach((child, index) => walk(child, `${path}.${index}`)); return; }
    if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) if (!skip.has(key)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(value, prefix);
  return out;
}

/** The visible lines of an HTML page: its text, plus the prose in its JSON-LD blocks; scripts, styles and templates are not words. */
export function wordsOfHtml(html) {
  const body = html.replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi, (_, json) => {
    try { return ` ${proseIn(JSON.parse(json)).map(piece => piece.text).join(' \n ')} `; } catch { return ' '; }
  });
  return body.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line.split(' ').length >= 3);
}

/**
 * The words of a rendered deck: one inert JSON block, `<script type="application/json" id="slide-words">`, holds
 * { id, fields: { text, slide } } rows. Throws when the block is missing or holds no words.
 */
export function wordsOfDeck(html, where = 'deck') {
  const block = html.match(/<script type="application\/json" id="slide-words">([\s\S]*?)<\/script>/);
  if (!block) throw new Error(`${where} has no slide-words block`);
  const found = [];
  for (const slide of JSON.parse(block[1])) {
    for (const [field, value] of Object.entries(slide.fields ?? {})) {
      if (field === 'slide' || !isProse(value)) continue;
      found.push({ text: value, where: `${where}#${slide.id}.${field}` });
    }
  }
  if (!found.length) throw new Error(`${where} holds no words`);
  return found;
}

/** One unit per distinct (kind, text), each with every place it was found (the first three are named). */
export function distinctUnits(found, defaults = {}) {
  const byKey = new Map();
  for (const { text, where, kind = defaults.kind ?? 'copy', facts = defaults.facts ?? {} } of found) {
    const key = `${kind}\u0000${text.trim()}`;
    if (!byKey.has(key)) byKey.set(key, { kind, text: text.trim(), where: [], facts });
    byKey.get(key).where.push(where);
  }
  return [...byKey.values()].map(unit => ({ ...unit, where: unit.where.slice(0, 3).join('; ') + (unit.where.length > 3 ? ` (+${unit.where.length - 3})` : '') }));
}
