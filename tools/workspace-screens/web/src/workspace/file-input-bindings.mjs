// Schema-declared file selections retain source references. Scalar file ids keep their existing contract.
const TYPES = schema => [].concat(schema?.type ?? '');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const blocked = name => ['__proto__', 'constructor', 'prototype'].includes(name);
const identityOf = value => typeof value === 'string' && /^1f:[a-f0-9]{64}$/.test(value);
const stringField = field => TYPES(field).includes('string');

/** A reference picker is explicit DATA, and is usable only when the tool declares the entire reference pair. */
export function referenceFileField(field) {
  const view = field?.['x-file'];
  const item = field?.items;
  const properties = item?.properties;
  if (!object(view) || typeof view.takes !== 'string' || !view.takes || !TYPES(field).includes('array')
      || !TYPES(item).includes('object') || !object(properties)
      || !['key', 'identity'].every(key => item.required?.includes(key) && stringField(properties[key]))
      || !['space_id', 'item_id'].every(key => stringField(properties[key]))) return null;
  return { takes: view.takes };
}

const hasReference = field => Boolean(referenceFileField(field)) || (TYPES(field).includes('object')
  && Object.values(field?.properties ?? {}).some(hasReference));
const nameOf = path => path.length === 1 ? path[0] : '@file-input:' + JSON.stringify(path);

/** Flatten only objects containing declared file picks. Other complex fields keep their existing text input. */
export function toolInputBindings(schema) {
  const bindings = [];
  function visit(field, path) {
    if (path.some(blocked)) throw new Error('This tool has an invalid input name.');
    if (!referenceFileField(field) && TYPES(field).includes('object') && hasReference(field)) {
      for (const [key, child] of Object.entries(field.properties ?? {})) visit(child, [...path, key]);
    } else bindings.push({ name: nameOf(path), path, field, file: referenceFileField(field) });
  }
  for (const [key, field] of Object.entries(schema?.properties ?? {})) visit(field, [key]);
  return bindings;
}

/** The picker id holds metadata only; current byte access is always checked by the existing company owner. */
export function sharedFileSelection({ identity, space_id, item_id, name, byte_length }) {
  if (!identityOf(identity) || typeof space_id !== 'string' || !space_id.trim() || space_id.includes('/')
      || typeof item_id !== 'string' || !item_id.trim()) throw new Error('This shared file could not be read.');
  return JSON.stringify({ identity, space_id, item_id, ...(typeof name === 'string' && name ? { name } : {}),
    ...(Number.isSafeInteger(byte_length) && byte_length >= 0 ? { byte_length } : {}) });
}

/** Private ids remain private; a shared selection never degrades to a private content identity. */
export function referenceFileValues(field, value) {
  if (!referenceFileField(field) || !Array.isArray(value)) throw new Error('Choose the files to use.');
  const properties = field.items.properties;
  const seen = new Set();
  return value.map((id, index) => {
    let selected;
    if (identityOf(id)) selected = { identity: id };
    else {
      try { selected = JSON.parse(id); } catch { throw new Error('Choose the files to use again.'); }
      if (!object(selected) || !identityOf(selected.identity) || typeof selected.space_id !== 'string'
          || !selected.space_id.trim() || selected.space_id.includes('/') || typeof selected.item_id !== 'string'
          || !selected.item_id.trim()) throw new Error('This shared file could not be read.');
    }
    if (seen.has(id)) throw new Error('Choose each file once.');
    seen.add(id);
    const file = { key: 'file_' + (index + 1), identity: selected.identity };
    if (selected.space_id !== undefined) { file.space_id = selected.space_id; file.item_id = selected.item_id; }
    if (stringField(properties.name) && typeof selected.name === 'string') file.name = selected.name;
    if (TYPES(properties.byte_length).includes('integer') && Number.isSafeInteger(selected.byte_length) && selected.byte_length >= 0) file.byte_length = selected.byte_length;
    if (properties.access?.enum?.includes('namespace')) file.access = 'namespace';
    return file;
  });
}

/** Merge typed sibling fields and structured selections without losing nested inputs such as requested outputs. */
export function boundToolInput(entries, bindings) {
  const byName = new Map(bindings.map(binding => [binding.name, binding]));
  const answer = {};
  for (const [name, value] of entries) {
    const binding = byName.get(name);
    if (name.startsWith('@file-input:') && !binding) throw new Error('This tool input changed. Choose the files again.');
    const path = binding?.path ?? [name];
    if (path.some(blocked)) throw new Error('This tool has an invalid input name.');
    let target = answer;
    for (const key of path.slice(0, -1)) {
      if (target[key] !== undefined && !object(target[key])) throw new Error('This tool input conflicts with its files.');
      target = target[key] ??= {};
    }
    target[path.at(-1)] = value;
  }
  return answer;
}
