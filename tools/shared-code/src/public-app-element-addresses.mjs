// src/public-app-element-addresses.mjs
//
// PURPOSE
//   Every element a person sees on an app page has an address that stays with it: data-trillion-element="e<n>".
//   The address is written into the page's own HTML the first time the page is read or saved, so it survives editing,
//   publishing and copying, and the canvas, the editor and an AI can all name "this element" the same way.
//   setElement changes one addressed element (its attributes, or the words of an element holding only words).
//
// NON-NEGOTIABLE INVARIANTS
//   1. An address once written is never changed, except a second copy of one (a pasted element), which gets a new one.
//   2. New addresses continue after the highest one in the file, so the same unaddressed page always gets the same ones.
//   3. Comments, doctype and the contents of raw-text elements (script, style, textarea, title) are never read as tags.
//   4. Elements that never draw (the HTML standard's metadata and document elements) get no address.

export const ELEMENT_ADDRESS_ATTRIBUTE = 'data-trillion-element';

// Elements the HTML standard never draws, and elements whose contents are raw text, not markup.
const NEVER_DRAWN = new Set(['html', 'head', 'meta', 'link', 'script', 'style', 'title', 'base', 'template', 'noscript']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/** Every start tag in order: name, span, attributes with name and value spans. */
function startTags(html) {
  const tags = [];
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open < 0) break;
    if (html.startsWith('<!--', open)) { const end = html.indexOf('-->', open + 4); i = end < 0 ? html.length : end + 3; continue; }
    const next = html[open + 1] ?? '';
    if (next === '!' || next === '?' || next === '/') { const end = html.indexOf('>', open); i = end < 0 ? html.length : end + 1; continue; }
    if (!/[A-Za-z]/.test(next)) { i = open + 1; continue; }
    let j = open + 1;
    while (j < html.length && /[A-Za-z0-9-]/.test(html[j])) j += 1;
    const name = html.slice(open + 1, j).toLowerCase();
    const attributes = [];
    let selfClosing = false;
    while (j < html.length) {
      while (j < html.length && isSpace(html[j])) j += 1;
      if (html[j] === '>') break;
      if (html[j] === '/' && html[j + 1] === '>') { selfClosing = true; j += 1; break; }
      if (html[j] === '/') { j += 1; continue; }
      const nameStart = j;
      while (j < html.length && !isSpace(html[j]) && html[j] !== '=' && html[j] !== '>' && !(html[j] === '/' && html[j + 1] === '>')) j += 1;
      const attribute = { name: html.slice(nameStart, j).toLowerCase(), start: nameStart, end: j, valueStart: -1, valueEnd: -1 };
      let k = j;
      while (k < html.length && isSpace(html[k])) k += 1;
      if (html[k] === '=') {
        k += 1;
        while (k < html.length && isSpace(html[k])) k += 1;
        const quote = html[k];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, k + 1);
          attribute.valueStart = k + 1; attribute.valueEnd = close < 0 ? html.length : close;
          j = close < 0 ? html.length : close + 1;
        } else {
          let m = k;
          while (m < html.length && !isSpace(html[m]) && html[m] !== '>') m += 1;
          attribute.valueStart = k; attribute.valueEnd = m; j = m;
        }
        attribute.end = j;
      }
      attributes.push(attribute);
    }
    const tagEnd = Math.min(j + 1, html.length);
    tags.push({ name, start: open, end: tagEnd, closeAt: selfClosing ? j - 1 : j, attributes });
    i = tagEnd;
    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      i = close < 0 ? html.length : close;
    }
  }
  return tags;
}

function decodeAttribute(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
function encodeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
function encodeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Rewrite selected values of one parsed HTML attribute, leaving every other byte untouched. */
export function rewriteElementAttributeValues(html, name, mapper) {
  if (typeof html !== 'string' || !html.includes('<')) return html;
  if (typeof name !== 'string' || !/^[a-z_:][a-z0-9_.:-]*$/i.test(name) || typeof mapper !== 'function') {
    throw new Error('Give an HTML attribute name and a value mapper.');
  }
  const wanted = name.toLowerCase();
  const edits = [];
  for (const tag of startTags(html)) {
    for (const attribute of tag.attributes) {
      if (attribute.name !== wanted || attribute.valueStart < 0) continue;
      const value = html.slice(attribute.valueStart, attribute.valueEnd);
      const mapped = mapper(value);
      if (typeof mapped === 'string' && mapped !== value) {
        edits.push({ at: attribute.valueStart, to: attribute.valueEnd, text: mapped });
      }
    }
  }
  let output = html;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    output = output.slice(0, edit.at) + edit.text + output.slice(edit.to);
  }
  return output;
}

const addressOf = (html, tag) => {
  const attribute = tag.attributes.find((a) => a.name === ELEMENT_ADDRESS_ATTRIBUTE && a.valueStart >= 0);
  return attribute ? { attribute, value: decodeAttribute(html.slice(attribute.valueStart, attribute.valueEnd)) } : null;
};
const ordinal = (address) => (/^e[0-9a-z]+$/.test(address) ? parseInt(address.slice(1), 36) : -1);

/** The page with an address on every drawn element; a page already fully addressed comes back unchanged. */
export function withElementAddresses(html) {
  if (typeof html !== 'string' || !html.includes('<')) return html;
  const tags = startTags(html).filter((tag) => !NEVER_DRAWN.has(tag.name));
  let highest = -1;
  for (const tag of tags) { const found = addressOf(html, tag); if (found) highest = Math.max(highest, ordinal(found.value)); }
  const seen = new Set();
  const edits = [];
  for (const tag of tags) {
    const found = addressOf(html, tag);
    if (found && found.value && !seen.has(found.value)) { seen.add(found.value); continue; }
    highest += 1;
    const address = `e${highest.toString(36)}`;
    seen.add(address);
    edits.push(found
      ? { at: found.attribute.valueStart, to: found.attribute.valueEnd, text: address }
      : { at: tag.closeAt, to: tag.closeAt, text: ` ${ELEMENT_ADDRESS_ATTRIBUTE}="${address}"` });
  }
  if (!edits.length) return html;
  let out = html;
  for (const edit of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.text + out.slice(edit.to);
  return out;
}

/** The addressed elements of a page, in order: address, tag and the first words inside. */
export function pageElements(html) {
  const addressed = withElementAddresses(html);
  return startTags(addressed).flatMap((tag) => {
    const found = addressOf(addressed, tag);
    if (!found) return [];
    const rest = addressed.slice(tag.end, tag.end + 400);
    const words = rest.split('<')[0].replace(/\s+/g, ' ').trim().slice(0, 80);
    return [{ element: found.value, tag: tag.name, ...(words ? { words } : {}) }];
  });
}

/**
 * Change one addressed element: `attributes` sets each named attribute (null removes it), `text` replaces the words of an
 * element that holds only words. The address attribute itself cannot be changed.
 */
export function setElement(html, { element, attributes, text }) {
  const addressed = withElementAddresses(html);
  const tag = startTags(addressed).find((candidate) => addressOf(addressed, candidate)?.value === element);
  if (!tag) throw new Error(`No element ${element} is on this page.`);
  let out = addressed;
  if (text !== undefined) {
    if (typeof text !== 'string') throw new Error('The new words must be text.');
    const close = out.toLowerCase().indexOf(`</${tag.name}`, tag.end);
    if (close < 0 || out.slice(tag.end, close).includes('<')) throw new Error(`Element ${element} holds more than words; change its parts one at a time.`);
    out = out.slice(0, tag.end) + encodeText(text) + out.slice(close);
  }
  if (attributes !== undefined) {
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw new Error('Attributes must be named values.');
    const edits = [];
    const added = [];
    for (const [rawName, value] of Object.entries(attributes)) {
      const name = rawName.toLowerCase();
      if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || name === ELEMENT_ADDRESS_ATTRIBUTE) throw new Error(`The ${rawName} attribute cannot be set here.`);
      if (value !== null && typeof value !== 'string') throw new Error(`The ${rawName} attribute needs text, or nothing to remove it.`);
      const existing = tag.attributes.filter((a) => a.name === name);
      existing.forEach((a, index) => {
        const before = a.start > 0 && isSpace(addressed[a.start - 1]) ? a.start - 1 : a.start;
        edits.push(value === null || index > 0
          ? { at: before, to: a.end, text: '' }
          : { at: a.start, to: a.end, text: `${name}="${encodeAttribute(value)}"` });
      });
      if (!existing.length && value !== null) added.push(` ${name}="${encodeAttribute(value)}"`);
    }
    if (added.length) edits.push({ at: tag.closeAt, to: tag.closeAt, text: added.join('') });
    for (const edit of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.text + out.slice(edit.to);
  }
  return out;
}
