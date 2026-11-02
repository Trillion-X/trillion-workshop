// tools/research-a-creator-or-topic/do-work/rea-hub.mjs
//
// The REA hub: a list where people submit something they reverse engineered, one row per submission, kept in the
// person's records through the run's records door. Every rule (the fields, their kinds and bounds, which are required,
// the kinds of thing, the licences, the statuses) is DATA in rea-hub.json; the synthetic seed rows are DATA in
// rea-hub-examples.json. Nothing here names a product.
//
//   tool:keep-a-reverse-engineered-thing -> keepAReverseEngineeredThing(input, { door })  run by records-door/do-work/run-an-export.mjs
//
// Actions: fields (what a row holds), create (a new row; refused when the key is held), read (one row by key, or a page
// of rows narrowed by the definition's filter_by fields), edit (change fields of a held row; null removes an optional
// field), delete (one row by key) and seed (write the example rows that are not held yet).
import { readFileSync } from 'node:fs';

const load = name => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
export const readReaHub = () => load('rea-hub.json');
export const readReaHubExamples = () => load('rea-hub-examples.json');

const PAGE = { default: 50, most: 500 };
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const isAddress = value => nonempty(value) && /^https?:\/\/[^\s/]+\S*$/i.test(value.trim());
const isDate = value => nonempty(value) && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value));

function refuse(message) {
  const error = new Error(message);
  error.refused = true;
  throw error;
}

const choicesOf = (field, hub) => field.choices ?? hub[field.choices_from] ?? [];
const settable = hub => hub.fields.filter(field => !field.set_by);
const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80);

function keyOf(input, { required = true } = {}) {
  if (!nonempty(input?.key)) {
    if (required) refuse('Send key: the name of the row, as create returned it (read lists every key).');
    return undefined;
  }
  const key = input.key.trim();
  if (key.includes('/')) refuse('key may not hold a /: send the key create returned.');
  return key;
}

// Every problem with one value of a field, in plain words.
export function valueProblems(field, value, hub) {
  const where = field.id;
  const bounds = list => {
    if (list.length < (field.least ?? 0) || list.length > (field.most ?? Infinity)) return [`${where} holds ${field.least ?? 0} to ${field.most ?? 'any number of'} entries, not ${list.length}.`];
    return [];
  };
  switch (field.kind) {
    case 'text': return nonempty(value) ? [] : [`${where} is words${field.says ? `: ${field.says}` : ''}.`];
    case 'date': return isDate(value) ? [] : [`${where} is a date such as 2026-11-02 or a date and time such as 2026-11-02T10:30:00Z.`];
    case 'choice': {
      const choices = choicesOf(field, hub);
      return choices.includes(value) ? [] : [`${where} is one of ${choices.join(', ')}.`];
    }
    case 'urls':
      if (!Array.isArray(value)) return [`${where} is a list of http or https addresses.`];
      return [...bounds(value), ...value.flatMap((item, at) => (isAddress(item) ? [] : [`${where}[${at}] is not an http or https address.`]))];
    case 'words':
      if (!Array.isArray(value)) return [`${where} is a list of short words.`];
      return [...bounds(value), ...value.flatMap((item, at) => (nonempty(item) && item.length <= 60 ? [] : [`${where}[${at}] is a word of 1 to 60 letters.`]))];
    case 'entries': {
      if (!Array.isArray(value)) return [`${where} is a list of objects with ${field.entry_keys.join(', ')}.`];
      return [...bounds(value), ...value.flatMap((entry, at) => {
        const name = `${where}[${at}]`;
        if (!object(entry)) return [`${name} is an object with ${field.entry_keys.join(', ')}.`];
        const missing = field.entry_keys.filter(entryKey => !nonempty(entry[entryKey]));
        if (missing.length) return [`${name} needs ${missing.join(', ')}.`];
        const extra = Object.keys(entry).filter(entryKey => !field.entry_keys.includes(entryKey));
        if (extra.length) return [`${name} holds only ${field.entry_keys.join(', ')}, not ${extra.join(', ')}.`];
        return (field.url_keys ?? []).filter(entryKey => !isAddress(entry[entryKey])).map(entryKey => `${name}.${entryKey} is not an http or https address.`);
      })];
    }
    default: return [`${where} has kind ${field.kind}, which the hub does not know: fix rea-hub.json.`];
  }
}

// The fields a caller sent, each checked. `creating` asks for every required field; otherwise null removes a field.
function checkedFields(sent, hub, { creating }) {
  if (!object(sent)) refuse('Send fields: an object of the row\'s fields (action fields lists them).');
  const fields = new Map(hub.fields.map(field => [field.id, field]));
  const problems = [];
  for (const [id, value] of Object.entries(sent)) {
    const field = fields.get(id);
    if (!field) { problems.push(`${id} is not a field of the hub: the fields are ${settable(hub).map(entry => entry.id).join(', ')}.`); continue; }
    if (field.set_by) { problems.push(`${id} is written by the hub on ${field.set_by}; leave it out.`); continue; }
    if (value === null) {
      if (creating) problems.push(`${id} is null: leave it out instead.`);
      else if (field.required) problems.push(`${id} is required and cannot be removed; send a new value instead.`);
      continue;
    }
    problems.push(...valueProblems(field, value, hub));
  }
  if (creating) {
    const missing = hub.fields.filter(field => field.required && sent[field.id] === undefined).map(field => field.id);
    if (missing.length) problems.push(`Send ${missing.join(', ')}: every submission needs them.`);
  }
  if (problems.length) refuse(problems.join(' '));
  return sent;
}

const rowIdOf = (hub, key) => `${hub.records.id_start}${key}`;
const now = input => (nonempty(input?.now) ? input.now.trim() : new Date().toISOString());
const stampOf = (hub, on, at) => Object.fromEntries(hub.fields.filter(field => field.set_by === on).map(field => [field.id, at]));
const defaultsOf = hub => Object.fromEntries(hub.fields.filter(field => field.default !== undefined).map(field => [field.id, field.default]));

// A new row's value: defaults, then what was sent, then the hub's own stamps.
function newRow(hub, fields, at) {
  return { ...defaultsOf(hub), ...fields, ...stampOf(hub, 'create', at), ...stampOf(hub, 'edit', at) };
}

function newKey(hub, input, fields) {
  const given = keyOf(input, { required: false });
  if (given !== undefined) return given;
  const made = slug(fields[hub.key_from] ?? '');
  if (!made) refuse(`Send key, or a ${hub.key_from} the key can be made from.`);
  return made;
}

async function create(input, door, hub) {
  const fields = checkedFields(input.fields, hub, { creating: true });
  const key = newKey(hub, input, fields);
  if (await door.read(hub.records.type, rowIdOf(hub, key))) refuse(`A row is already kept under ${key}: edit it, or send another key.`);
  const row = newRow(hub, fields, now(input));
  await door.write([{ id: rowIdOf(hub, key), type: hub.records.type, value: row }]);
  return { action: 'create', key, row_id: rowIdOf(hub, key), row, created: true };
}

async function edit(input, door, hub) {
  const key = keyOf(input);
  const fields = checkedFields(input.fields, hub, { creating: false });
  if (!Object.keys(fields).length) refuse('Send fields with at least one field to change.');
  const held = await door.read(hub.records.type, rowIdOf(hub, key));
  if (!held) refuse(`No row is kept under ${key}: create it first, or read to list the keys.`);
  const row = { ...held, ...fields, ...stampOf(hub, 'edit', now(input)) };
  for (const [id, value] of Object.entries(fields)) if (value === null) delete row[id];
  await door.write([{ id: rowIdOf(hub, key), type: hub.records.type, value: row }]);
  return { action: 'edit', key, row_id: rowIdOf(hub, key), row, changed: Object.keys(fields) };
}

async function read(input, door, hub) {
  if (nonempty(input.key)) {
    const key = keyOf(input);
    const row = await door.read(hub.records.type, rowIdOf(hub, key));
    return { action: 'read', key, row: row ?? null, found: Boolean(row) };
  }
  const where = input.where === undefined ? {} : input.where;
  if (!object(where)) refuse(`where is an object of ${hub.filter_by.join(', ')}.`);
  const unknown = Object.keys(where).filter(id => !hub.filter_by.includes(id));
  if (unknown.length) refuse(`A page can be narrowed only by ${hub.filter_by.join(', ')}, not ${unknown.join(', ')}.`);
  const limit = input.limit === undefined ? PAGE.default
    : Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= PAGE.most ? input.limit : refuse(`limit is a whole number from 1 to ${PAGE.most}.`);
  const rows = [];
  for await (const record of door.list({ type: hub.records.type, prefix: hub.records.id_start, ...(Object.keys(where).length ? { where } : {}), limit })) {
    if (!object(record.value)) continue;
    rows.push({ key: record.id.slice(hub.records.id_start.length), ...record.value });
    if (rows.length >= limit) break;
  }
  return { action: 'read', count: rows.length, rows };
}

async function remove(input, door, hub) {
  const key = keyOf(input);
  if (!(await door.read(hub.records.type, rowIdOf(hub, key)))) return { action: 'delete', key, row_id: rowIdOf(hub, key), deleted: false };
  await door.write([{ id: rowIdOf(hub, key), type: hub.records.type, value: null }]);
  return { action: 'delete', key, row_id: rowIdOf(hub, key), deleted: true };
}

// Every example row checked by the same rules as a submission; a bad example refuses the whole seed.
export function exampleProblems(hub = readReaHub(), examples = readReaHubExamples()) {
  const keys = new Set();
  return examples.rows.flatMap((example, at) => {
    const { key, ...fields } = example;
    const problems = [];
    if (!nonempty(key) || key.includes('/')) problems.push(`rows[${at}] needs a key with no /.`);
    else if (keys.has(key)) problems.push(`rows[${at}].key ${key} is used twice.`);
    keys.add(key);
    try { checkedFields(fields, hub, { creating: true }); } catch (error) { problems.push(`rows[${at}] (${key}): ${error.message}`); }
    return problems;
  });
}

async function seed(input, door, hub, examples) {
  const problems = exampleProblems(hub, examples);
  if (problems.length) refuse(`The example rows cannot be seeded: ${problems.join(' ')}`);
  const at = now(input);
  const records = [];
  const held = [];
  for (const { key, ...fields } of examples.rows) {
    if (await door.read(hub.records.type, rowIdOf(hub, key))) { held.push(key); continue; }
    records.push({ id: rowIdOf(hub, key), type: hub.records.type, value: newRow(hub, fields, at) });
  }
  for (let start = 0; start < records.length; start += hub.records.writes_at_most) await door.write(records.slice(start, start + hub.records.writes_at_most));
  return { action: 'seed', written: records.length, keys: records.map(record => record.id.slice(hub.records.id_start.length)), already_held: held };
}

function describe(hub) {
  return {
    action: 'fields',
    fields: hub.fields.map(field => ({
      id: field.id, label: field.label, kind: field.kind,
      ...(field.required ? { required: true } : {}), ...(field.set_by ? { set_by: field.set_by } : {}),
      ...(field.choices || field.choices_from ? { choices: choicesOf(field, hub) } : {}),
      ...(field.entry_keys ? { entry_keys: field.entry_keys } : {}),
      ...(field.least !== undefined ? { least: field.least } : {}), ...(field.most !== undefined ? { most: field.most } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}), ...(field.says ? { says: field.says } : {}),
    })),
    filter_by: hub.filter_by,
  };
}

export async function keepAReverseEngineeredThing(input, { door }, hub = readReaHub(), examples = readReaHubExamples()) {
  if (!object(input)) refuse('Send { action, ... } as a JSON object.');
  const action = input.action ?? 'read';
  if (action === 'fields') return describe(hub);
  if (action === 'create') return create(input, door, hub);
  if (action === 'read') return read(input, door, hub);
  if (action === 'edit') return edit(input, door, hub);
  if (action === 'delete') return remove(input, door, hub);
  if (action === 'seed') return seed(input, door, hub, examples);
  return refuse('action is fields, create, read, edit, delete or seed.');
}
