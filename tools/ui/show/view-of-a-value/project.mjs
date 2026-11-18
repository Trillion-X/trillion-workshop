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
//   6. A request comes only from the value: a row's `requests` are read from the answer being drawn (an answer that says
//      how to run something, `runs`), so a screen can send only what the answer itself offered, and its input only
//      through the screen's own bound controls.

import defaults from './view-of-a-value.json' with { type: 'json' };
// The parts and the props each declares, as the renderer checks them (one file; its copy in tools/ui is the same).
import declared from '../../../build-a-screen-from-patches/read-data/declared-props.json' with { type: 'json' };

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

/** The field names an answer shows: a record's own, or every field any item of a list has. */
function fieldsOfValue(value) {
  const records = Array.isArray(value) ? value.filter(object) : object(value) ? [value] : [];
  return new Set(records.flatMap(record => Object.keys(record)));
}

/**
 * The one lens for `value` from lens rows (the person's saved choices, learned rules, an AI's, the defaults): each row
 * `{ set_by, when: { fields_all }, lens }` holds for an answer that has every field `fields_all` names. Each lens field is
 * taken from the first row that sets it, rows ordered by `lens_precedence` (DATA: who wins), then by how many fields
 * their `when` names (the more particular first), then as given. A row with an unknown `set_by` is not used.
 */
export function lensFor(value, rows = [], settings = defaults) {
  const fields = fieldsOfValue(value);
  const rank = new Map(settings.lens_precedence.map((who, index) => [who, index]));
  const matching = (Array.isArray(rows) ? rows : []).map((row, index) => ({ row, index }))
    .filter(({ row }) => object(row) && rank.has(row.set_by) && object(row.lens)
      && (Array.isArray(row.when?.fields_all) ? row.when.fields_all : []).every(field => fields.has(String(field))))
    .sort((a, b) => rank.get(a.row.set_by) - rank.get(b.row.set_by)
      || (b.row.when?.fields_all?.length ?? 0) - (a.row.when?.fields_all?.length ?? 0) || a.index - b.index);
  const lens = {};
  for (const { row } of matching) for (const [name, given] of Object.entries(row.lens)) if (lens[name] === undefined && settings.lens_fields.includes(name)) lens[name] = given;
  return lens;
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
const labelOf = key => { const spaced = String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, (_, low, high) => `${low} ${high.toLowerCase()}`).trim(); return spaced.charAt(0).toUpperCase() + spaced.slice(1); };

/** The fields of a record that are drawn: its own, less the hidden ones, its title field and any plain value one of its
 * records repeats. */
function shownFields(value, settings) {
  const title = settings.title_fields.find(name => value[name] !== undefined && value[name] !== null && value[name] !== '');
  // A plain value a sibling record also holds is said once, inside that record (`hide_repeated`).
  const inside = new Set(settings.hide_repeated ? Object.values(value).filter(object).flatMap(record => Object.values(record).filter(field => typeof field === 'string' || typeof field === 'number')) : []);
  return Object.keys(value).filter(key => key !== title && !settings.hidden_fields.includes(key) && !inside.has(value[key]));
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
    runnable: runOf(value, settings) !== null,
    identifier: typeof value === 'string' && settings.identifier_shapes.some(shape => new RegExp(shape, 'i').test(value)),
    wraps_result: object(value) && object(value[settings.runs.result_field]) && Object.entries(value).every(([key, field]) => key === settings.runs.result_field || !object(field) && !Array.isArray(field)),
  };
}

/** The run an answer offers ({address, method, input, fill}) and the schema of its input, when it offers one. */
function runOf(value, settings) {
  if (!object(value) || !object(settings.runs)) return null;
  const run = at(value, settings.runs.run_at);
  const schema = at(value, settings.runs.schema_at);
  return object(run) && typeof run.address === 'string' && typeof run.method === 'string' && object(schema) ? { run, schema } : null;
}

/** The facts of one input's schema that input rules may name. */
export function inputFactsOf(schema, settings = defaults) {
  const given = object(schema) ? schema : {};
  return {
    kind: typeof given.type === 'string' ? given.type : 'string',
    has_enum: Array.isArray(given.enum) && given.enum.length > 0,
    has_range: Number.isFinite(given.minimum) && Number.isFinite(given.maximum),
    long: Number.isFinite(given.maxLength) && given.maxLength > settings.limits.long_text_chars,
  };
}

/** Whether a rule's `when` holds for these facts. */
export function holds(when, facts) {
  return Object.entries(when ?? {}).every(([name, wanted]) => {
    const bound = name.match(/^(.*)_(lte|gte)$/);
    if (bound) return typeof facts[bound[1]] === 'number' && (bound[2] === 'lte' ? facts[bound[1]] <= wanted : facts[bound[1]] >= wanted);
    const among = name.match(/^(.*)_in$/);
    if (among && Array.isArray(wanted)) return wanted.includes(facts[among[1]]);
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
  for (const [name, given] of Object.entries(rule.requests ?? {})) {
    const declared = propValue(given, { value, schema, label }, settings, true);
    if (object(declared)) out.requests[name] = declared;
  }
  return fill(rule.draw, { value, schema, label }, settings, out, depth, key);
}

/** Adds a drawn element's key, when one was drawn. */
const pushed = (children, key) => { if (key !== null) children.push(key); };

/** One template filled for `here` ({value, schema, label}), its children drawn in place. */
function fill(template, here, settings, out, depth, key = `e${out.next++}`) {
  const limits = declared.parts?.[template.type]?.props ?? {};
  // Words longer than the part declares it holds end with an ellipsis here, so the renderer never has to cut them.
  const fitted = (name, value) => (typeof value === 'string' && Number.isFinite(limits[name]?.maxLength) && value.length > limits[name].maxLength ? `${value.slice(0, limits[name].maxLength - 1)}…` : value);
  const props = Object.fromEntries(Object.entries(template.props ?? {}).map(([name, given]) => [name, fitted(name, propValue(given, here, settings))]).filter(([, value]) => value !== undefined));
  const children = [];
  for (const child of template.children ?? []) {
    if (object(child) && object(child.each_item)) {
      const items = Array.isArray(here.value) ? here.value : [];
      const itemSchema = object(here.schema) ? here.schema.items : undefined;
      for (const item of items.slice(0, settings.limits.items)) pushed(children, fill(child.each_item, { value: item, schema: itemSchema, label: here.label }, settings, out, depth + 1));
      if (items.length > settings.limits.items) children.push(more(items.length - settings.limits.items, settings, out));
    } else if (object(child) && object(child.each_field)) {
      const fields = object(here.value) ? shownFields(here.value, settings) : [];
      for (const field of fields.slice(0, settings.limits.fields)) {
        const fieldSchema = object(here.schema) && object(here.schema.properties) ? here.schema.properties[field] : undefined;
        pushed(children, fill(child.each_field, { value: { key: field, value: here.value[field] }, schema: fieldSchema, label: labelOf(field), field: true }, settings, out, depth + 1));
      }
      if (fields.length > settings.limits.fields) children.push(more(fields.length - settings.limits.fields, settings, out));
    } else if (object(child) && object(child.each_input)) {
      const offered = runOf(here.value, settings);
      const properties = offered && object(offered.schema.properties) ? Object.entries(offered.schema.properties) : [];
      for (const [field, inputSchema] of properties.slice(0, settings.limits.fields)) {
        const rule = settings.input_rules.find(one => holds(one.when, inputFactsOf(inputSchema, settings)));
        out.rules.push(`input:${rule.id}`);
        const path = `${settings.runs.state_at}/${field.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (object(inputSchema) && inputSchema.default !== undefined) setAt(out.state, path, inputSchema.default);
        pushed(children, fill(rule.draw, { value: undefined, schema: inputSchema, label: object(inputSchema) && typeof inputSchema.title === 'string' ? inputSchema.title : labelOf(field), bind: path }, settings, out, depth + 1));
      }
    } else if (object(child) && typeof child.$view === 'string') {
      pushed(children, draw(at(here.value, child.$view), here.field ? here.schema : undefined, here.label, settings, out, depth + 1));
    } else if (object(child) && typeof child.type === 'string') {
      pushed(children, fill(child, here, settings, out, depth + 1));
    }
  }
  // A part whose words are its whole content and came out empty (a record with no title) is left out, never drawn blank.
  if (!children.length && Object.hasOwn(template.props ?? {}, 'text') && object(template.props.text) && (props.text === undefined || props.text === '')) return null;
  out.elements[key] = { type: template.type, props, ...(children.length ? { children } : {}), ...(object(template.on) ? { on: template.on } : {}) };
  return key;
}

/** One prop of a template, read from the value it draws. */
function propValue(given, here, settings, whole = false) {
  if (!object(given)) return given;
  if (given.$at !== undefined) {
    const pointers = Array.isArray(given.$at) ? given.$at : [given.$at];
    for (const pointer of pointers) {
      const found = String(pointer).startsWith('#') ? at(here.schema ?? {}, `/${String(pointer).slice(1)}`) : at(here.value, String(pointer));
      if (found !== undefined && found !== null) return typeof found === 'object' && !whole ? words(found, settings) : found;
    }
    return undefined;
  }
  if (given.$bind) return typeof here.bind === 'string' ? { $bindState: here.bind } : undefined;
  if (given.$choices) return object(here.schema) && Array.isArray(here.schema.enum) ? here.schema.enum.slice(0, 24).map(choice => ({ id: String(choice), label: labelOf(choice) })) : undefined;
  if (given.$title) return titleOf(here.value, settings);
  if (given.$text) return words(here.value, settings);
  if (given.$label) return here.label ?? '';
  if (given.$count) return Array.isArray(here.value) ? here.value.length : object(here.value) ? Object.keys(here.value).length : 1;
  if (typeof given.$words === 'string') return settings.words[given.$words] ?? '';
  return given;
}

/** Puts `value` at JSON Pointer `pointer` in `target`, making the objects on the way. */
function setAt(target, pointer, value) {
  const parts = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let here = target;
  for (const part of parts.slice(0, -1)) here = object(here[part]) ? here[part] : (here[part] = {});
  here[parts.at(-1)] = value;
}

/** The element that says how many more items or fields were left out. */
function more(count, settings, out) {
  const key = `e${out.next++}`;
  out.elements[key] = { type: 'Text', props: { text: say(settings.words.more, { count }), variant: 'caption', color: 'muted' } };
  return key;
}

/**
 * The screen of shared parts that shows `value`: `{ spec: { root, elements, state, reads }, requests, rules }`, where
 * `requests` are the requests the value itself offers (invariant 6), by the name a button's `on` uses, and `rules` are the
 * ids of the rows that drew it, outermost first. `schema` (a JSON Schema of the value, when its operation declares one)
 * adds what the value alone cannot say, such as a number's range; `lens` narrows what is shown (invariant 5).
 */
export function projectValue(value, { schema, lens } = {}) {
  const settings = settingsWith(lens);
  const out = { elements: {}, next: 0, rules: [], state: {}, requests: {} };
  // A value whose drawing came out empty (words with none in them) still draws: its words say there is nothing.
  const root = draw(value, schema, typeof lens?.title === 'string' ? lens.title : undefined, settings, out, 0)
    ?? fill({ type: 'Text', props: { text: { $words: 'empty' }, variant: 'body', color: 'muted' } }, { value }, settings, out, 0);
  return { spec: { root, elements: out.elements, state: out.state, reads: {} }, requests: out.requests, rules: out.rules };
}
