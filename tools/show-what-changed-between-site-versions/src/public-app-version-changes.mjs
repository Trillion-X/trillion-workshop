// src/public-app-version-changes.mjs
//
// PURPOSE
//   What changed between two versions of a public app, in words a person reads in Versions: which pages were added,
//   removed or changed, and for a changed page the sentences that read differently ("“Coffee roasted by the water”
//   became “Coffee roasted on the canvas”"). It reads only the two versions' files; nothing here names a site.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: two file maps in, a plain summary out. No storage, no network.
//   2. A file is compared by its stored identity when both sides carry one, so pictures and fonts are never read.
//   3. Words are the page's visible text, line by line in reading order; markup, scripts and styles are not words.
//   4. A summary is bounded (CHANGE_LIMIT pairs per page, PAGE_LIMIT pages) so a rewritten site still reads in a line.
//

const CHANGE_LIMIT = 3;
const PAGE_LIMIT = 6;
const WORDS_LIMIT = 80;
// Elements whose ending starts a new line of words; anything else runs on in the same line.
const BREAKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'tr', 'td', 'th', 'button', 'a', 'figcaption', 'blockquote', 'label', 'option']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A page's name from its file path: index.html is Home, about/index.html is About, flavours/caramel.html is Caramel. */
export function pageNameOf(path) {
  const parts = String(path).split('/').filter(Boolean).map(part => part.replace(/\.html?$/i, '')).filter(part => part !== 'index');
  const last = parts.at(-1);
  if (!last) return 'Home';
  const spaced = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Home';
}

/** The visible lines of words of an HTML page, in reading order. */
export function pageWords(html) {
  const lines = [];
  let line = '';
  const flush = () => { const words = line.replace(/\s+/g, ' ').trim(); if (words) lines.push(words); line = ''; };
  const text = String(html ?? '');
  // Walk the markup once: skip the insides of script, style, template and head, break lines at block endings.
  const tag = /<(\/?)([a-zA-Z][\w-]*)[^>]*>|<!--[\s\S]*?-->/g;
  let at = 0;
  let hidden = null;
  for (let match = tag.exec(text); match; match = tag.exec(text)) {
    if (!hidden) line += text.slice(at, match.index);
    at = tag.lastIndex;
    const name = (match[2] ?? '').toLowerCase();
    if (!name) continue;
    if (hidden) { if (match[1] && name === hidden) hidden = null; continue; }
    if (!match[1] && ['script', 'style', 'template', 'head', 'noscript', 'svg'].includes(name)) { flush(); hidden = name; continue; }
    if (BREAKS.has(name)) flush();
  }
  if (!hidden) line += text.slice(at);
  flush();
  return lines.map(words => words.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code) => {
    if (code[0] === '#') { const number = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return Number.isFinite(number) ? String.fromCodePoint(number) : whole; }
    return ENTITIES[code.toLowerCase()] ?? whole;
  }));
}

const clip = words => words.length > WORDS_LIMIT ? `${words.slice(0, WORDS_LIMIT - 1)}…` : words;
const identityOf = value => value && typeof value === 'object' ? value.blob_ref ?? null : null;
const textOf = value => typeof value === 'string' ? value : null;

/** The lines of `after` not in `before` and of `before` not in `after`, paired in order where both sides changed. */
function changedLines(before, after) {
  const count = lines => lines.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map());
  const left = count(before);
  const right = count(after);
  const removed = before.filter(line => { const n = right.get(line) ?? 0; if (n > 0) { right.set(line, n - 1); return false; } return true; });
  const added = after.filter(line => { const n = left.get(line) ?? 0; if (n > 0) { left.set(line, n - 1); return false; } return true; });
  const pairs = [];
  for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
    pairs.push({ ...(removed[index] !== undefined ? { before: clip(removed[index]) } : {}), ...(added[index] !== undefined ? { after: clip(added[index]) } : {}) });
  }
  return pairs;
}

/**
 * previous, next: { path: content } (text for pages and styles, { blob_ref } for stored files). previous null is the
 * first version. Answers { pages: [{ path, name, state: added|removed|changed, changes: [{before?, after?}], more }],
 * files: { added, removed, changed } (non-page files), words: one line saying it }.
 */
export function versionChanges(previous, next) {
  const before = previous ?? {};
  const after = next ?? {};
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const pages = [];
  const files = { added: 0, removed: 0, changed: 0 };
  let styles = false;
  for (const path of paths) {
    const had = Object.hasOwn(before, path);
    const has = Object.hasOwn(after, path);
    const page = /\.html?$/i.test(path);
    const same = had && has && (identityOf(before[path]) && identityOf(after[path])
      ? identityOf(before[path]) === identityOf(after[path])
      : textOf(before[path]) !== null && textOf(before[path]) === textOf(after[path]));
    if (same) continue;
    if (!page) {
      if (/\.css$/i.test(path) && had && has) styles = true;
      files[!had ? 'added' : !has ? 'removed' : 'changed'] += 1;
      continue;
    }
    const state = !had ? 'added' : !has ? 'removed' : 'changed';
    const pairs = state === 'changed' ? changedLines(pageWords(textOf(before[path])), pageWords(textOf(after[path]))) : [];
    if (state === 'changed' && !pairs.length) { pages.push({ path, name: pageNameOf(path), state, changes: [], more: 0, layout_only: true }); continue; }
    pages.push({ path, name: pageNameOf(path), state, changes: pairs.slice(0, CHANGE_LIMIT), more: Math.max(0, pairs.length - CHANGE_LIMIT) });
  }
  const shown = pages.slice(0, PAGE_LIMIT);
  const said = shown.map(page => page.state === 'added' ? `${page.name} page added`
    : page.state === 'removed' ? `${page.name} page removed`
    : page.layout_only ? `${page.name} layout changed`
    : `${page.name}: ${page.changes.map(change => change.before !== undefined && change.after !== undefined ? `“${change.before}” became “${change.after}”`
      : change.after !== undefined ? `added “${change.after}”` : `removed “${change.before}”`).join('; ')}${page.more ? ` and ${page.more} more` : ''}`);
  if (pages.length > PAGE_LIMIT) said.push(`${pages.length - PAGE_LIMIT} more pages changed`);
  if (styles) said.push('Styles changed');
  const other = files.added + files.removed + files.changed - (styles ? 1 : 0);
  if (other > 0) said.push(`${other} ${other === 1 ? 'file' : 'files'} changed`);
  return { pages: shown, files, words: previous ? (said.join('. ') || 'Nothing visible changed') : 'First version' };
}
