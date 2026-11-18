// tools/ui/show/view-of-a-value/project.mjs
//
// PURPOSE
//   Any value, drawn: `projectValue(value, { schema, lens })` answers a screen made of shared parts (the parts screen's spec,
//   tools/build-a-screen-from-patches/read-data/screen-spec.mjs: { root, elements, state, reads }) that shows the value, so an
//   answer of any operation is already something to see with no screen written for it. Which parts draw which value is the
//   rows of ./view-of-a-value.json, tried in order against the facts of the value's own shape.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no field, record kind, part or operation is named here. The facts are JSON's own kinds and counts; titles,
//      hidden fields, words and every template are DATA.
//   2. Every value is drawn: the rows end with one that holds for every value, and a template that cannot be filled draws its
//      words instead of failing the screen.
//   3. Pure: no DOM, no I/O, no time. The same value, schema and lens give the same spec, so a host can cache it by identity.
//   4. Bounded: depth, items, fields and characters are DATA limits; what is left out is said ("{count} more").
//   5. The lens narrows, never widens: it may hide fields, set the title fields, bound the items and put the rows it names
//      first; it cannot add a part or a request.

import defaults from './view-of-a-value.json' with { type: 'json' };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const kindOf = value => (value === null || value === undefined ? 'null' : Array.isArray(value) ? 'array' : typeof value);
const say = (template, values = {}) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The value at a JSON Pointer ("" is the value itself). */
function at(value, pointer) {
  if (pointer === '') return value;
  return pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((here, key) => (here !== null && typeof here === 'object' && Object.prototype.hasOwnProperty.call(here, key) ? here[key] : undefined), value);
}

/** The settings a lens leaves: the rows and words of the DATA, narrowed by the lens. */
function settingsWith(lens) {
  const narrowed = object(lens) ? lens : {};
  return {
    ...defaults,
    title_fields: Array.isArray(narrowed.title_fields) ? narrowed.title_fields.map(String) : defaults.title_fields,
    hidden_fields: [...defaults.hidden_fields, ...(Array.isArray(narrowed.hidden_fields) ? narrowed.hidden_fields.map(String) : [])],
    limits: { ...defaults.limits, ...(Number.isInteger(narrowed.items) && narrowed.items > 0 ? { items: Math.min(narrowed.items, defaults.limits.items) } : {}) },
    rules: Array.isArray(narrowed.rules_first)
      ? [...narrowed.rules_first.map(id => defaults.rules.find(rule => rule.id === id)).filter(Boolean), ...defaults.rules.filter(rule => !narrowed.rules_first.includes(rule.id))]
      : defaults.rules,
  };
}

/** The title of a value: the first title field it has, as words. */
function titleOf(value, settings) {
  if (!object(value)) return words(value, settings);
  const field = settings.title_fields.find(name => value[name] !== undefined && value[name] !== null && value[name] !== '');
  return field === undefined ? '' : words(value[field], settings);
}

/** A value as words, bounded. */
function words(value, settings) {
  const text = value === null || value === undefined ? settings.words.none
    : typeof value === 'boolean' ? settings.words[value ? 'yes' : 'no']
    : typeof value === 'string' ? value
    : typeof value === 'number' ? String(value)
    : JSON.stringify(value);
  return text.length > settings.limits.text_chars ? `${text.slice(0, settings.limits.text_chars - 1)}…` : text;
}

/** A field's name as words: separators become spaces, the first letter is a capital. */
const labelOf = key => { const spaced = String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(); return spaced.charAt(0).toUpperCase() + spaced.slice(1); };

/** The fields of a record that are drawn: its own, less the hidden ones and its title field. */
function shownFields(value, settings) {
  const title = settings.title_fields.find(name => value[name] !== undefined && value[name] !== null && value[name] !== '');
  return Object.keys(value).filter(key => key !== title && !settings.hidden_fields.includes(key));
}

/** The facts of a value's shape that rules may name. */
export function factsOf(value, schema, settings = defaults) {
  const kind = kindOf(value);
  const items = kind === 'array' ? value : [];
  const itemKinds = new Set(items.map(kindOf));
  return {
    kind,
    count: kind === 'array' ? items.length : kind === 'object' ? Object.keys(value).length : 1,
    items_kind: itemKinds.size === 1 ? [...itemKinds][0] : itemKinds.size ? 'mixed' : 'none',
    has_title: kind === 'array' ? items.length > 0 && items.every(item => object(item) && titleOf(item, settings) !== '')
      : object(value) && titleOf(value, settings) !== '',
    empty: value === null || value === undefined || value === '' || (kind === 'array' && items.length === 0) || (kind === 'object' && Object.keys(value).length === 0),
    is_error: object(value) && (object(value.error) || (typeof value.code === 'string' && typeof value.outcome === 'string')),
    has_range: object(schema) && Number.isFinite(schema.minimum) && Number.isFinite(schema.maximum),
    media: typeof value === 'string' && /^(image|video|audio)\//.test(object(schema) ? String(schema.contentMediaType ?? '') : ''),
  };
}

/** Whether a rule's `when` holds for these facts. */
export function holds(when, facts) {
  return Object.entries(when ?? {}).every(([name, wanted]) => {
    const bound = name.match(/^(.*)_(lte|gte)$/);
    if (bound) return typeof facts[bound[1]] === 'number' && (bound[2] === 'lte' ? facts[bound[1]] <= wanted : facts[bound[1]] >= wanted);
    return facts[name] === wanted;
  });
}

/** Draws `value` into `out.elements` and answers the key of its element. */
function draw(value, schema, label, settings, out, depth) {
  const key = `e${out.next++}`;
  if (depth > settings.limits.depth || out.next > settings.limits.items * 8) {
    out.elements[key] = { type: 'Text', props: { text: words(value, settings), variant: 'body' } };
    return key;
  }
  const facts = factsOf(value, schema, settings);
  const rule = settings.rules.find(one => holds(one.when, facts));
  out.rules.push(rule.id);
  return fill(rule.draw, { value, schema, label }, settings, out, depth, key);
}

/** One template filled for `here` ({value, schema, label}), its children drawn in place. */
function fill(template, here, settings, out, depth, key = `e${out.next++}`) {
  const props = Object.fromEntries(Object.entries(template.props ?? {}).map(([name, given]) => [name, propValue(given, here, settings)]).filter(([, value]) => value !== undefined));
  const children = [];
  for (const child of template.children ?? []) {
    if (object(child) && object(child.each_item)) {
      const items = Array.isArray(here.value) ? here.value : [];
      const itemSchema = object(here.schema) ? here.schema.items : undefined;
      for (const item of items.slice(0, settings.limits.items)) children.push(fill(child.each_item, { value: item, schema: itemSchema, label: here.label }, settings, out, depth + 1));
      if (items.length > settings.limits.items) children.push(more(items.length - settings.limits.items, settings, out));
    } else if (object(child) && object(child.each_field)) {
      const fields = object(here.value) ? shownFields(here.value, settings) : [];
      for (const field of fields.slice(0, settings.limits.fields)) {
        const fieldSchema = object(here.schema) && object(here.schema.properties) ? here.schema.properties[field] : undefined;
        children.push(fill(child.each_field, { value: { key: field, value: here.value[field] }, schema: fieldSchema, label: labelOf(field), field: true }, settings, out, depth + 1));
      }
      if (fields.length > settings.limits.fields) children.push(more(fields.length - settings.limits.fields, settings, out));
    } else if (object(child) && typeof child.$view === 'string') {
      children.push(draw(at(here.value, child.$view), here.field ? here.schema : undefined, here.label, settings, out, depth + 1));
    } else if (object(child) && typeof child.type === 'string') {
      children.push(fill(child, here, settings, out, depth + 1));
    }
  }
  out.elements[key] = { type: template.type, props, ...(children.length ? { children } : {}) };
  return key;
}

/** One prop of a template, read from the value it draws. */
function propValue(given, here, settings) {
  if (!object(given)) return given;
  if (given.$at !== undefined) {
    const pointers = Array.isArray(given.$at) ? given.$at : [given.$at];
    for (const pointer of pointers) {
      const found = String(pointer).startsWith('#') ? at(here.schema ?? {}, `/${String(pointer).slice(1)}`) : at(here.value, String(pointer));
      if (found !== undefined && found !== null) return typeof found === 'object' ? words(found, settings) : found;
    }
    return undefined;
  }
  if (given.$title) return titleOf(here.value, settings);
  if (given.$text) return words(here.value, settings);
  if (given.$label) return here.label ?? '';
  if (given.$count) return Array.isArray(here.value) ? here.value.length : object(here.value) ? Object.keys(here.value).length : 1;
  if (typeof given.$words === 'string') return settings.words[given.$words] ?? '';
  return given;
}

/** The element that says how many more items or fields were left out. */
function more(count, settings, out) {
  const key = `e${out.next++}`;
  out.elements[key] = { type: 'Text', props: { text: say(settings.words.more, { count }), variant: 'caption', color: 'muted' } };
  return key;
}

/**
 * The screen of shared parts that shows `value`: `{ spec: { root, elements, state, reads }, rules }`, where `rules` are the
 * ids of the rows that drew it, outermost first. `schema` (a JSON Schema of the value, when its operation declares one)
 * adds what the value alone cannot say, such as a number's range; `lens` narrows what is shown (invariant 5).
 */
export function projectValue(value, { schema, lens } = {}) {
  const settings = settingsWith(lens);
  const out = { elements: {}, next: 0, rules: [] };
  const root = draw(value, schema, typeof lens?.title === 'string' ? lens.title : undefined, settings, out, 0);
  return { spec: { root, elements: out.elements, state: {}, reads: {} }, rules: out.rules };
}
