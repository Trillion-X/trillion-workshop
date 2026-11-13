// tools/share-anything/read-data/share-label.mjs
//
// Purpose: The one rule for the label a thing's share is kept at, so a caller that must name the label before it runs
// the tool (the tool's row grants the run exactly that one workspace label) and the tool itself never disagree.
//
//   labelOf(thing)   -> the thing's label: the record's id; `list:<id>`; `text:<BLAKE3 of the text>`;
//                       `collection:<title words>-<BLAKE3 of the items>`.
//   grantOf(thing)   -> record_prefix + that label: what the tool's `grant` input holds.
//   reachOf(thing)   -> the reach the share names: [{ type, id? | prefix? }]; a text's is its own record. A list thing's is
//                       not named here (its rows' kind is only in the list's definition): the tool reads it.
//
// Non-Negotiable Invariants:
// - Pure: no records are read, nothing is random. The same thing always has the same label.
// - A label is text with no "/" (a record id holds none) and at most 300 characters.
//
// Key Concepts: a `thing` is { type, id } | { list } | { text, title? } | { items, title }, exactly one of the four.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import data from './share-anything.json' with { type: 'json' };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const hex = (value, chars) => makeHashCodeHexFromBytes(new TextEncoder().encode(value)).slice(3, 3 + chars);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The list's id with or without its `list:` prefix, as the record id. */
export const listRecordId = list => (list.startsWith(data.list_prefix) ? list : `${data.list_prefix}${list}`);

/** One reach item, checked: a type, and at most one of an id or a prefix. Throws in words. */
export function reachItem(item) {
  const most = data.most;
  if (!object(item) || !text(item.type) || item.type.length > most.type_chars) throw new Error(`${data.words.thing} Each item names a type.`);
  const extra = Object.keys(item).filter(key => !['type', 'id', 'prefix'].includes(key));
  if (extra.length || (item.id !== undefined && item.prefix !== undefined)) throw new Error(`${data.words.thing} An item names a type and at most one of id or prefix.`);
  for (const name of ['id', 'prefix']) {
    if (item[name] !== undefined && (!text(item[name]) || item[name].length > most.id_chars || item[name].includes('/'))) throw new Error(`${data.words.thing} An item's ${name} is text with no "/".`);
  }
  return { type: item.type, ...(item.id !== undefined ? { id: item.id } : {}), ...(item.prefix !== undefined ? { prefix: item.prefix } : {}) };
}

/** Which of the four shapes `thing` is, or throws. */
export function shapeOf(thing) {
  if (!object(thing)) throw new Error(data.words.thing);
  const shapes = [['type', 'id'], ['list'], ['text', 'title'], ['items', 'title']];
  const own = Object.keys(thing);
  const named = ['record', 'list', 'text', 'items'].filter((shape, at) => (at === 0 ? thing.type !== undefined || thing.id !== undefined : thing[shape] !== undefined));
  if (named.length !== 1 || own.some(key => !shapes.flat().includes(key))) throw new Error(data.words.thing);
  return named[0];
}

function textHash(thing) {
  if (!text(thing.text) || thing.text.length > data.most.text_chars) throw new Error(`${data.words.thing} A text is 1 to ${data.most.text_chars} characters.`);
  return hex(thing.text, data.label.text_hash_chars);
}

export function reachOf(thing) {
  const shape = shapeOf(thing);
  if (shape === 'record') {
    if (!text(thing.id) || thing.id.includes('/') || thing.id.length > data.most.id_chars) throw new Error(`${data.words.thing} An id is text with no "/".`);
    return [reachItem({ type: thing.type, id: thing.id })];
  }
  if (shape === 'items') {
    if (!Array.isArray(thing.items) || !thing.items.length || thing.items.length > data.most.reach_items) throw new Error(`${data.words.thing} A collection has 1 to ${data.most.reach_items} items.`);
    return thing.items.map(reachItem);
  }
  if (shape === 'text') return [{ type: data.text_kind, id: `${data.text_prefix}${textHash(thing)}` }];
  return [];
}

export function labelOf(thing) {
  const shape = shapeOf(thing);
  if (shape === 'record') return reachOf(thing)[0].id;
  if (shape === 'list') {
    if (!text(thing.list) || thing.list.includes('/')) throw new Error(data.words.thing);
    return listRecordId(thing.list);
  }
  if (shape === 'text') {
    return `${data.label.text}${textHash(thing)}`;
  }
  if (!text(thing.title)) throw new Error(`${data.words.thing} A collection has a title.`);
  const items = reachOf(thing);
  const words = thing.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, data.label.slug_longest).replace(/-+$/g, '');
  return `${data.label.collection}${words ? `${words}-` : ''}${hex(JSON.stringify(items), data.label.hash_chars)}`;
}

export const grantOf = thing => `${data.record_prefix}${labelOf(thing)}`;
export const grantWords = grant => fill(data.words.grant, { grant });
