// tools/documents-as-list-rows/read-data/split.mjs
//
// Purpose: split long markdown documents into one document per item, so each item becomes a row of a folder list
// (document-properties.mjs). The mapping names everything; the code knows no item kind:
//
//   { sources: [{ name, file }],                 the documents, in order (a later one adds to an earlier one's items)
//     heading: "<regex>",                        a heading line (outside code fences) that starts an item: group `id`,
//                                                other named groups are fields (title, date ...)
//     row: "<regex>",                            a table line that is an item: group `id`, named groups are fields;
//                                                group `text` is the row's words
//     group_heading?: "<regex>",                 a heading whose named group sets that field on the rows under it
//     flags?: { <field>: ["WORD", ...] },        the words found in an item's text, as a list field
//     first_sentence_when_missing?: [<field>],   a field no piece names is the first sentence of a row's words
//     prefer: ["<source>:<kind>", ...],          which piece's field wins, first first (kind: section, row, grouped-row)
//     parts: { "<source>:<kind>": "<heading>" }, the heading each kind of piece is written under, in this order
//     field_order?: [<field>], order_by?: "<regex with one group of digits>" }
//
// Non-Negotiable Invariants:
//   1. Every line of every document goes to exactly one item or to that document's leftover text; the report counts
//      the lines read and the lines placed, and a split whose counts differ is refused.
//   2. A heading item runs until the next heading of its level or higher; its sub-headings stay in it, and a `#` line
//      inside a code fence is never a heading.
//   3. A piece whose words (spacing aside) equal another piece's of the same item is written once; nothing else is
//      merged or dropped.
//   4. Items are written only into an empty folder, so an earlier split is never mixed with this one.
//
//   A mapping with `items_at` splits JSON documents instead: one document per item of a list (splitJsonItems, below).
//
//   splitDocuments(mapping, read) → { items: Map(id → { fields, parts }), leftover, report }
//   itemDocument(id, item, fieldOrder) → the item's markdown, frontmatter first
import { formatBlock, scalar, say } from './document-properties.mjs';

const HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(```|~~~)/;

const fieldsOf = (match, skip = ['id', 'text']) => Object.fromEntries(Object.entries(match.groups ?? {})
  .filter(([name, value]) => !skip.includes(name) && value && value.trim()).map(([name, value]) => [name, value.trim()]));

function piecesOf(name, lines, compiled) {
  const pieces = [], leftover = [];
  let current = null, group = {}, groupLevel = 0, inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const level = inFence ? null : HEADING.exec(line);
    if (level) {
      const depth = level[1].length;
      if (current && depth <= current.level) { pieces.push(current); current = null; }
      const found = compiled.heading.exec(line);
      if (found) {
        if (current) pieces.push(current);
        current = { id: found.groups.id, source: name, kind: 'section', level: depth, lines: [line], fields: fieldsOf(found) };
        continue;
      }
      if (!current) {
        const grouped = compiled.group_heading?.exec(line);
        if (grouped) {
          // A group's value is read as a frontmatter value would be, so "Tier 3" gives the number 3.
          group = Object.fromEntries(Object.entries(fieldsOf(grouped, [])).map(([key, text]) => [key, scalar(text)]));
          groupLevel = depth;
        } else if (Object.keys(group).length && depth <= groupLevel) group = {};
      }
    }
    if (current) { current.lines.push(line); continue; }
    const row = inFence ? null : compiled.row.exec(line);
    if (row) {
      pieces.push({ id: row.groups.id, source: name, kind: Object.keys(group).length ? 'grouped-row' : 'row', lines: [line],
        fields: { ...group, ...fieldsOf(row) }, text: (row.groups.text ?? '').trim() });
      continue;
    }
    leftover.push(line);
  }
  if (current) pieces.push(current);
  return { pieces, leftover };
}

const normal = text => text.replace(/\s+/g, ' ').trim();

/** Every item of the mapping's documents; `read(file)` gives a document's text. */
export async function splitDocuments(mapping, read) {
  if (mapping?.items_at) return splitJsonItems(mapping, read);
  for (const key of ['sources', 'heading', 'row', 'parts']) if (!mapping?.[key]) throw say('bad_input', { what: `The mapping needs \`${key}\`.` });
  const compiled = { heading: new RegExp(mapping.heading), row: new RegExp(mapping.row), group_heading: mapping.group_heading ? new RegExp(mapping.group_heading) : null };
  for (const key of ['heading', 'row']) if (!/\(\?<id>/.test(mapping[key])) throw say('bad_input', { what: `\`${key}\` needs a named group \`id\` ((?<id>...)).` });
  const byId = new Map(), leftover = {};
  let linesIn = 0, placed = 0;
  for (const source of mapping.sources) {
    const lines = (await read(source.file)).split('\n');
    linesIn += lines.length;
    const { pieces, leftover: rest } = piecesOf(source.name, lines, compiled);
    leftover[source.name] = rest;
    placed += rest.length + pieces.reduce((sum, piece) => sum + piece.lines.length, 0);
    for (const piece of pieces) byId.set(piece.id, [...(byId.get(piece.id) ?? []), piece]);
  }
  if (placed !== linesIn) throw say('bad_input', { what: `Line accounting failed: ${placed} placed of ${linesIn}.` });
  const keyOf = piece => `${piece.source}:${piece.kind}`;
  const prefer = mapping.prefer ?? [];
  const rank = piece => (prefer.includes(keyOf(piece)) ? prefer.indexOf(keyOf(piece)) : prefer.length);
  const partOrder = Object.keys(mapping.parts);
  const order = piece => (partOrder.includes(keyOf(piece)) ? partOrder.indexOf(keyOf(piece)) : partOrder.length);
  const items = new Map();
  let merged = 0;
  for (const [id, pieces] of byId) {
    const fields = {};
    const ranked = [...pieces].sort((a, b) => rank(a) - rank(b));
    for (const piece of ranked) for (const [key, value] of Object.entries(piece.fields)) if (!(key in fields)) fields[key] = value;
    for (const field of mapping.first_sentence_when_missing ?? []) {
      // A field no piece names is the first sentence of the preferred row's words, when the mapping says so.
      const words = ranked.find(piece => piece.text)?.text ?? '';
      if (!(field in fields) && words) fields[field] = words.split(/(?<=[.!?])\s/)[0];
    }
    for (const [field, words] of Object.entries(mapping.flags ?? {})) {
      const whole = pieces.flatMap(piece => piece.lines).join('\n');
      const found = words.filter(word => whole.includes(word));
      if (found.length) fields[field] = found;
    }
    const seen = new Set(), parts = [];
    for (const piece of [...pieces].sort((a, b) => order(a) - order(b))) {
      const label = mapping.parts[keyOf(piece)] ?? `${piece.source} ${piece.kind}`;
      let text;
      if (piece.kind === 'section') {
        const body = piece.lines.slice(1);
        while (body.length && !body.at(-1).trim()) body.pop();
        const words = body.join('\n').replace(/^\n+|\n+$/g, '');
        text = piece.lines[0].replace(/^#+/, '').trim() + (body.some(line => line.trim()) ? `\n\n${words}` : '');
      } else {
        text = piece.text || piece.lines[0];
        if (piece.fields.title && piece.text) text = `**${piece.fields.title}** ${piece.text}`;
        for (const [key, value] of Object.entries(piece.fields)) if (!(key in fields) || fields[key] !== value) text += `\n\n${key}: ${value}`;
      }
      if (seen.has(normal(text))) { merged += 1; continue; }
      seen.add(normal(text));
      parts.push([label, text]);
    }
    items.set(id, { fields, parts });
  }
  const report = { items: items.size, lines_in: linesIn, lines_placed: placed,
    leftover_lines: Object.fromEntries(Object.entries(leftover).map(([name, rest]) => [name, rest.length])), identical_pieces_merged: merged };
  return { items, leftover, report };
}

/** One item as a markdown document: frontmatter (id, then the fields) and its parts under their headings. */
export function itemDocument(id, item, fieldOrder = ['title']) {
  const keys = [...fieldOrder.filter(key => key in item.fields), ...Object.keys(item.fields).filter(key => !fieldOrder.includes(key)).sort()];
  const head = ['---', ...formatBlock('id', id), ...keys.flatMap(key => formatBlock(key, item.fields[key])), '---'];
  return `${head.join('\n')}\n\n${item.parts.map(([label, text]) => `## ${label}\n\n${text}`).join('\n\n').trimEnd()}\n`;
}

/** The items in the mapping's numeric order of their ids (order_by), then by id. */
export function orderedIds(mapping, ids) {
  const pattern = mapping.order_by ? new RegExp(mapping.order_by) : null;
  const number = id => Number(pattern?.exec(id)?.[1] ?? 0);
  return [...ids].sort((a, b) => number(a) - number(b) || (a < b ? -1 : a > b ? 1 : 0));
}

// A value a frontmatter line holds: text, a number, true or false, or a list of those.
const plain = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const frontmatterValue = value => plain(value) || (Array.isArray(value) && value.every(plain));

/**
 * A JSON document's list of items, one document each. The mapping names the list and how an item is written:
 *
 *   { sources: [{ name, file }],              JSON documents, each holding a list of items
 *     items_at: "a.b",                        where the list is, as a dotted path
 *     id: "{field}-{#}",                      the item's id: its fields in braces, {#} its place in the list (from 1,
 *                                             padded to the list's width); an id holds no slash
 *     parts?: { <field>: "<heading>" },       fields written as text under a heading instead of in the frontmatter
 *     field_order?, order_by? }               as for markdown documents
 *
 * Every other field whose value is text, a number, true or false (or a list of them) is a frontmatter field; any other
 * value (an object, a list of objects) is written under its own heading as JSON, so nothing of an item is dropped. The
 * rest of each document, without its list, is that document's leftover. Two items with one id are refused.
 */
export async function splitJsonItems(mapping, read) {
  for (const key of ['sources', 'items_at', 'id']) if (!mapping?.[key]) throw say('bad_input', { what: `The mapping needs \`${key}\`.` });
  const items = new Map(), leftover = {};
  let itemsIn = 0;
  for (const source of mapping.sources) {
    const whole = JSON.parse(await read(source.file));
    const path = mapping.items_at.split('.');
    const list = path.reduce((held, key) => held?.[key], whole);
    if (!Array.isArray(list)) throw say('bad_input', { what: `${source.file} has no list at ${mapping.items_at}.` });
    itemsIn += list.length;
    const width = String(list.length).length;
    list.forEach((item, index) => {
      const id = mapping.id.replace(/\{([^}]+)\}/g, (_, key) => (key === '#' ? String(index + 1).padStart(width, '0') : String(item?.[key] ?? '')));
      if (!id || id.includes('/')) throw say('bad_input', { what: `Item ${index + 1} of ${source.file} makes the id ${JSON.stringify(id)}.` });
      if (items.has(id)) throw say('bad_input', { what: `Two items make the id ${id}.` });
      const fields = {}, parts = [];
      for (const [key, value] of Object.entries(item ?? {})) {
        if (value === null || value === undefined || value === '') continue;
        if (mapping.parts?.[key]) parts.push([mapping.parts[key], String(value)]);
        else if (frontmatterValue(value)) fields[key] = value;
        else parts.push([key, `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``]);
      }
      items.set(id, { fields, parts });
    });
    // The document without its list: what it says about the list, kept beside the items.
    const rest = structuredClone(whole);
    const parent = path.slice(0, -1).reduce((held, key) => held[key], rest);
    delete parent[path.at(-1)];
    leftover[source.name] = JSON.stringify(rest, null, 2).split('\n');
  }
  if (items.size !== itemsIn) throw say('bad_input', { what: `Item accounting failed: ${items.size} written of ${itemsIn}.` });
  return { items, leftover, report: { items: items.size, items_in: itemsIn, leftover_documents: Object.keys(leftover).length } };
}
