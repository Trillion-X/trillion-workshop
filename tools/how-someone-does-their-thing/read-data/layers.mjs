// tools/how-someone-does-their-thing/read-data/layers.mjs
//
// The layered writing style: base, then niche, then group, then person. Which levels, which fields, how each field
// merges and the sentence it adds to the instruction are rows in writing-layers.json; nothing here names a field,
// a level or a writer. Invariants:
//   - It asks no model and keeps nothing. The merged style, its provenance and the instruction text are the answer.
//   - A later layer overrides an earlier one field by field; layers are read in the order given and an earlier level
//     after a later one is refused.
//   - Every merged value says which layers set it.
//   - It refuses what it cannot judge and says what to fix.

import { readFileSync } from 'node:fs';

export const WRITING_LAYERS = JSON.parse(readFileSync(new URL('./writing-layers.json', import.meta.url), 'utf8'));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const idOf = (entry) => (isObject(entry) && text(entry.id) ? text(entry.id) : null);

// The value at a dotted field of a layer's fields, which may be written nested ({ diction: { avoid } }) or flat ({ "diction.avoid" }).
function valueAt(fields, field) {
  if (field in fields) return fields[field];
  let at = fields;
  for (const key of field.split('.')) {
    if (!isObject(at) || !(key in at)) return undefined;
    at = at[key];
  }
  return at;
}

// Every dotted field a layer sets, so a field the vocabulary does not know is refused rather than ignored.
function fieldsSet(fields, known, prefix = '') {
  const found = [];
  for (const [key, value] of Object.entries(fields)) {
    const path = prefix + key;
    if (known.has(path)) found.push(path);
    else if (isObject(value) && [...known].some((name) => name.startsWith(`${path}.`))) found.push(...fieldsSet(value, known, `${path}.`));
    else found.push(path);
  }
  return found;
}

function shapeOk(merge, value) {
  if (merge === 'list') return Array.isArray(value) && value.length > 0;
  if (merge === 'range') return isObject(value) && Object.keys(value).length > 0 && Object.values(value).every((bound) => Number.isFinite(bound));
  return text(value) !== '';
}

const render = (value) => (Array.isArray(value)
  ? value.map((entry) => (isObject(entry) ? text(entry.text) || text(entry.value) || JSON.stringify(entry) : String(entry))).join('; ')
  : isObject(value) ? Object.entries(value).map(([name, bound]) => `${name} ${bound}`).join(', ') : String(value));

/**
 * Merge layers into one style.
 * `layers`: [{ level, id, fields, replace?, off? }] in reading order; a base layer, when none is given, is the one in the data.
 */
export function layerAWritingStyle(request, data = WRITING_LAYERS) {
  need(isObject(request), 'give a request object');
  const levels = data.levels.map((row) => row.level);
  need(levels.includes('base'), 'the writing-layers data has no base level: restore it, a style needs one');
  const shippedBase = data.layers.find((layer) => layer.level === 'base');
  need(shippedBase, 'the writing-layers data has no base layer: restore it, a style needs one');
  const given = request.layers ?? [];
  need(Array.isArray(given) && given.every(isObject), 'layers must be a list of layer objects: { level, id, fields }');
  const layers = given.some((layer) => layer.level === 'base') ? given : [shippedBase, ...given];
  const known = new Map(data.fields.map((row) => [row.field, row]));
  let last = -1;
  const style = {};
  const provenance = {};
  layers.forEach((layer, index) => {
    const name = `layers[${index}]`;
    need(levels.includes(layer.level), `${name}.level "${layer.level}" is not a level: use one of ${levels.join(', ')}`);
    const rank = levels.indexOf(layer.level);
    need(rank >= last, `${name} is level ${layer.level}, which comes before the level of the layer above it: list layers in the order ${levels.join(', ')}`);
    last = rank;
    need(text(layer.id), `${name}.id must name the layer, so every value can say where it came from`);
    need(isObject(layer.fields), `${name}.fields must be an object of the fields this layer sets`);
    const source = { level: layer.level, id: text(layer.id) };
    const replace = layer.replace ?? [];
    const off = layer.off ?? [];
    need(Array.isArray(replace) && replace.every((field) => known.has(field)), `${name}.replace must list fields to start again from this layer: ${[...known.keys()].join(', ')}`);
    need(Array.isArray(off), `${name}.off must list the entries to drop`);
    for (const field of fieldsSet(layer.fields, new Set(known.keys()))) {
      need(known.has(field), `${name} sets "${field}", which is not a field: use ${[...known.keys()].join(', ')}`);
      const { merge } = known.get(field);
      const value = valueAt(layer.fields, field);
      need(shapeOk(merge, value), `${name}.${field} must be ${merge === 'list' ? 'a non-empty list' : merge === 'range' ? 'an object of numeric bounds such as { "min": 1, "max": 20 }' : 'a non-empty sentence'}`);
      if (merge === 'list') {
        const kept = replace.includes(field) ? [] : style[field] ?? [];
        style[field] = [...kept, ...value.filter((entry) => !kept.some((held) => same(held, entry)))];
        provenance[field] = replace.includes(field) ? [] : provenance[field] ?? [];
        provenance[field].push({ ...source, set: value.map((entry) => idOf(entry) ?? entry) });
      } else if (merge === 'range') {
        style[field] = { ...(style[field] ?? {}), ...value };
        provenance[field] = [...(provenance[field] ?? []), { ...source, set: Object.keys(value) }];
      } else {
        style[field] = text(value);
        provenance[field] = [{ ...source, set: [] }];
      }
    }
    for (const entry of off) {
      let dropped = false;
      for (const field of known.keys()) {
        if (known.get(field).merge !== 'list' || !style[field]) continue;
        const before = style[field].length;
        style[field] = style[field].filter((held) => !(same(held, entry) || (idOf(held) !== null && idOf(held) === entry)));
        if (style[field].length !== before) {
          dropped = true;
          provenance[field].push({ ...source, off: [entry] });
        }
      }
      need(dropped, `${name}.off names "${typeof entry === 'string' ? entry : JSON.stringify(entry)}", which no earlier layer set: name an entry (or the id of a rule) a layer above this one added`);
    }
  });
  const instruction = data.fields.filter((row) => row.field in style && (!Array.isArray(style[row.field]) || style[row.field].length > 0))
    .map((row) => row.says.replace('{value}', render(style[row.field])));
  const items = Object.entries(style).filter(([, value]) => !Array.isArray(value) || value.length > 0).map(([field, value]) => ({
    kind: field,
    value,
    evidence: provenance[field].map((entry) => `layer:${entry.level}:${entry.id}`).filter((tag, at, all) => all.indexOf(tag) === at).join(', '),
  }));
  return { layers: layers.map((layer) => ({ level: layer.level, id: text(layer.id) })), style, provenance, instruction_text: instruction.join('\n'), items };
}
