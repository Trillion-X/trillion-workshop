// parts/record-log/do-work/record-model.mjs
//
// THE EEAF DATA MODEL AS DATA OVER WHOLE RECORDS.
//
// Purpose
//   The model the decomposed store (parts/eeaf) kept as tables, declared here as DATA the host passes and read over the
//   whole records the log store keeps: entity types (a record's type), their properties (its top-level fields, each of
//   a declared value kind), participation (a record holding another thing under a role: an id, a list of ids, or a list
//   of objects each naming one) and interaction sets (a participation over a list: its members in order). The store
//   keeps what these answer as keys of its packed key space (record-log-store.mjs), so the model costs no row written
//   beyond the pages the records already take.
//
// Non-negotiable invariants
//   1. The module names no product, record kind or field: kinds, value kinds and declaring records are the host's DATA.
//   2. A kind is declared either directly (`kinds`) or by a record that declares it (`declared_by`: one record of a
//      declaring type names a kind, its properties and which of them hold other things), so a person's own kinds are
//      records in their own store, read the same way as the kinds every store has.
//   3. Properties are open: a field nobody declared is kept and seen, as EEAF made a property the first time data used
//      it; only a declared property is checked, and only where a write changes it.
//   4. A refusal names the record, the property and the kind it was declared as.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const SEP = '\u0000';
const modelStates = new WeakMap();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && value.length > 0 && !value.includes('/') && !value.includes(SEP);

/** The ordinary field index that finds the record declaring a kind. These are
 *  derived from the same declaration DATA, never from a product's type names.
 *  A named build lets the existing index maintainer admit older declarations. */
export function declarationIndexesOf({ declared_by = [] } = {}) {
  return [...new Map(declared_by.map(rule => [rule.type, rule])).values()].map(rule => ({
    type: rule.type, name: '__model_declaration', paths: [rule.kind.path], backfill: '__model_declaration',
  }));
}

/** What one value is, in the words the kinds-seen keys keep. */
export function valueKindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return 'list';
    if (value.every(item => typeof item === 'string')) return 'texts';
    if (value.every(item => typeof item === 'number')) return 'numbers';
    if (value.every(isObject)) return 'objects';
    return 'list';
  }
  if (isObject(value)) return 'object';
  return typeof value === 'string' ? 'text' : typeof value;
}

// Whether a value fits a value kind's shape: { is: string|number|boolean|object|list|id } or { list_of: <is> }; a kind
// with neither checks nothing, and null (a field let go) always fits.
const fitsIs = (is, value) => (is === 'string' ? typeof value === 'string'
  : is === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : is === 'boolean' ? typeof value === 'boolean'
      : is === 'object' ? isObject(value)
        : is === 'list' ? Array.isArray(value)
          : is === 'id' ? isId(value)
            : true);
export function fitsKind(shape, value) {
  if (value === null || value === undefined || !shape) return true;
  if (shape.list_of) return Array.isArray(value) && value.every(item => fitsIs(shape.list_of, item));
  return fitsIs(shape.is, value);
}

const at = (value, path) => {
  let here = value;
  for (const field of path ?? []) {
    if (!isObject(here)) return undefined;
    here = here[field];
  }
  return here;
};

/**
 * The model from DATA:
 *   value_kinds  { name: { is } | { list_of } | {} }: what a value of each kind is
 *   kinds        [{ type, properties: { field: value_kind }, parts: [{ role, path, each?, role_from? }] }] (`role_from`: a
 *                path whose text names the role instead, so a role is data: a relation's "dad", "member", "student")
 *   declared_by  [{ type, kind: { path, prefix? }, properties: { path, name, kind }, kind_values?: { kind: value_kind },
 *                   parts_when: [value_kind or kind, ...] }]: a record of `type` declares the kind named at `kind.path` (with
 *                   `prefix` before it); each object of its list at `properties.path` is a property named at `name`,
 *                   of the value kind `kind_values` gives its `kind` (or that kind itself), and a property whose value
 *                   kind or own `kind` is in `parts_when` (a field that names a thing: a row, a file) is a participation
 *                   role over the ids it holds (a list of them is an interaction set). `part_references` optionally
 *                   maps a field kind to { path, prefix, absolute_prefix }: that field names another declaring record, whose declared
 *                   type qualifies the local ids. Already qualified ids stay unchanged. References are resolved when
 *                   a kind is read, after all declarations are loaded, so declaration order cannot change a link.
 */
export function normalizeDeclaredIndexes(indexes, properties) {
  if (indexes === undefined) return [];
  if (!Array.isArray(indexes)) throw new TypeError('Give indexes as a list of named fields.');
  const names = new Set();
  return indexes.map(index => {
    if (!isObject(index) || typeof index.name !== 'string' || !index.name || names.has(index.name)
        || !Array.isArray(index.fields) || !index.fields.length
        || new Set(index.fields).size !== index.fields.length
        || index.fields.some(field => typeof field !== 'string' || !Object.hasOwn(properties, field)))
      throw new TypeError('Each index needs a different name and fields declared on this list.');
    names.add(index.name);
    return { name: index.name, fields: [...index.fields] };
  });
}

export function recordModel({ value_kinds = {}, kinds = [], declared_by = [] } = {}) {
  const shipped = new Map();
  for (const kind of kinds) {
    if (typeof kind?.type !== 'string' || !kind.type) throw new Error('A declared kind needs a type.');
    for (const part of kind.parts ?? []) {
      if (typeof part?.role !== 'string' || !part.role || !Array.isArray(part.path) || !part.path.length) throw new Error(`A part of ${kind.type} needs a role and a path.`);
    }
    // `guard_properties`: properties declared with the value kind stores were seen holding, held to it by the deploy's
    // guard tests (a strict model) and seen on every store, never refused on a live one: a declaration read off what
    // one store holds must not stop another store's write.
    shipped.set(kind.type, { type: kind.type, properties: { ...(kind.properties ?? {}) }, guard_properties: { ...(kind.guard_properties ?? {}) }, parts: kind.parts ?? [], declared_by: null,
      ...(kind.table === true ? { table: true } : {}), ...(kind.indexes ? { indexes: kind.indexes } : {}) });
  }
  const rules = new Map();
  for (const rule of declared_by) {
    if (typeof rule?.type !== 'string' || !Array.isArray(rule.kind?.path) || !Array.isArray(rule.properties?.path)) throw new Error('A declaring rule needs a type, the path of the kind it names and the path of its properties.');
    rules.set(rule.type, rule);
  }
  // Kinds declared by records: the declaring record's id -> the kind it declares; the kind's type -> that kind.
  const byRecord = new Map();
  const byType = new Map();
  function forget(id) {
    const held = byRecord.get(id);
    if (!held) return;
    byRecord.delete(id);
    if (byType.get(held.type) === held) byType.delete(held.type);
  }
  function declare(type, id, value) {
    forget(id);
    const rule = rules.get(type);
    if (!rule || !isObject(value)) return null;
    const named = at(value, rule.kind.path);
    if (typeof named !== 'string' || !named) return null;
    const properties = {};
    const parts = [];
    const fields = at(value, rule.properties.path);
    for (const field of Array.isArray(fields) ? fields : []) {
      const name = at(field, rule.properties.name);
      if (typeof name !== 'string' || !name) continue;
      const given = at(field, rule.properties.kind);
      const valueKind = rule.kind_values?.[given] ?? given;
      if (typeof valueKind !== 'string') continue;
      properties[name] = valueKind;
      if ((rule.parts_when ?? []).some(when => when === valueKind || when === given)) {
        const reference = rule.part_references?.[given];
        const target = reference && at(field, reference.path);
        parts.push({ role: name, path: [name], ...(typeof target === 'string' && target
          ? { declaration: `${reference.prefix ?? ''}${target}`, ...(reference.absolute_prefix ? { absolute_prefix: reference.absolute_prefix } : {}) } : {}) });
      }
    }
    const indexes = rule.indexes?.path ? normalizeDeclaredIndexes(at(value, rule.indexes.path), properties) : [];
    const kind = { type: `${rule.kind.prefix ?? ''}${named}`, properties, parts, declared_by: id, ...(indexes.length ? { indexes } : {}) };
    byRecord.set(id, kind);
    byType.set(kind.type, kind);
    return kind;
  }
  // A kind a record declares adds to a shipped kind of the same type; a shipped declaration is never overridden.
  function kindOf(type, { resolved_only = false } = {}) {
    const base = shipped.get(type);
    const raw = byType.get(type);
    const unresolved = [];
    const own = raw && { ...raw, parts: raw.parts.map(part => {
      if (!part.declaration) return part;
      const { declaration, ...held } = part;
      const target = byRecord.get(declaration);
      // Bounded inspection cannot qualify a local row id while its exact
      // declaring record is unavailable. Already absolute ids remain usable;
      // a local id stays unresolved instead of becoming an unrelated address.
      if (!target && resolved_only) {
        if (!base?.parts.some(held => held.role === part.role)) unresolved.push(declaration);
        return part.absolute_prefix ? { ...held, absolute_only: true } : null;
      }
      return { ...held, ...(target ? { id_prefix: `${target.type}:` } : {}) };
    }).filter(Boolean), ...(unresolved.length ? { unresolved_declarations: [...new Set(unresolved)] } : {}) };
    if (!own) return base ?? null;
    if (!base) return own;
    return { type, ...(base.table ? { table: true } : {}), ...((base.indexes || own.indexes) ? { indexes: [...(base.indexes ?? []), ...(own.indexes ?? []).filter(index => !(base.indexes ?? []).some(held => held.name === index.name))] } : {}), properties: { ...own.properties, ...base.properties }, guard_properties: base.guard_properties ?? {},
      parts: [...base.parts, ...own.parts.filter(part => !base.parts.some(held => held.role === part.role))], declared_by: own.declared_by,
      ...(own.unresolved_declarations ? { unresolved_declarations: own.unresolved_declarations } : {}) };
  }
  const api = {
    valueKinds: value_kinds,
    kindOf,
    declares: type => rules.has(type),
    declaringTypes: () => [...rules.keys()],
    // The start every type a record declares has (a type without it is never a declared kind).
    declaredPrefixes: () => [...rules.values()].map(rule => rule.kind.prefix ?? ''),
    declare,
    forget,
    clear() { byRecord.clear(); byType.clear(); },
    fork() {
      const copy = recordModel({ value_kinds, kinds, declared_by });
      const target = modelStates.get(copy);
      const cloned = new Map([...byRecord.values()].map(kind => [kind, {
        ...kind,
        properties: { ...kind.properties },
        parts: kind.parts.map(part => ({ ...part })),
        ...(kind.indexes ? { indexes: kind.indexes.map(index => ({ ...index, fields: [...index.fields] })) } : {}),
        ...(kind.guard_properties ? { guard_properties: { ...kind.guard_properties } } : {}),
      }]));
      for (const [id, kind] of byRecord) target.byRecord.set(id, cloned.get(kind));
      for (const [type, kind] of byType) target.byType.set(type, cloned.get(kind));
      return copy;
    },
    kinds: () => [...new Set([...shipped.keys(), ...byType.keys()])].sort().map(kindOf),
    // What a kind's participation keys depend on: when it changes, the kind's records are walked again.
    // (`sets` marks that a kind's interaction sets are keyed too, so kinds walked before they were are walked again.)
    signatureOf: type => { const parts = kindOf(type)?.parts ?? []; return parts.length ? JSON.stringify({ parts, sets: 1 }) : '[]'; },
  };
  modelStates.set(api, { byRecord, byType });
  return api;
}

/**
 * The participation a record of `kind` holds: [{ role, id, ordinal }] (ordinal null for a single id; a list's members
 * in order, which is the interaction set). `resolve(value)` follows a link the store keeps for a shared object (or
 * answers the value itself).
 */
export function partsOf(kind, value, resolve = item => item) {
  const out = [];
  if (!kind?.parts?.length || !isObject(value)) return out;
  for (const part of kind.parts) {
    const qualified = id => part.absolute_only
      ? part.absolute_prefix && id.startsWith(part.absolute_prefix) ? id : null
      : part.id_prefix && !id.startsWith(part.id_prefix)
        && !(part.absolute_prefix && id.startsWith(part.absolute_prefix)) ? `${part.id_prefix}${id}` : id;
    let held = value;
    for (const field of part.path) {
      held = resolve(held);
      if (!isObject(held)) { held = undefined; break; }
      held = held[field];
    }
    held = resolve(held);
    if (held === undefined || held === null) continue;
    // A part whose role is data (`role_from`, a path into the record, or into each object for `each`): "dad", "member".
    const roleOf = from => {
      if (!part.role_from) return part.role;
      const named = at(from, part.role_from);
      return typeof named === 'string' && named.trim() && named.length <= 80 && !named.includes(SEP) ? named.trim() : part.role;
    };
    if (Array.isArray(held)) {
      held.forEach((member, ordinal) => {
        const id = part.each ? at(resolve(member), part.each) : member;
        const target = isId(id) ? qualified(id) : null;
        if (target) out.push({ role: roleOf(part.each ? resolve(member) : value), id: target, ordinal });
      });
    } else {
      const id = part.each ? at(held, part.each) : held;
      const target = isId(id) ? qualified(id) : null;
      if (target) out.push({ role: roleOf(part.each ? held : value), id: target, ordinal: null });
    }
  }
  return out;
}

/** The first declared property `fields` (a write's changed fields) breaks, or null: { property, expected, value_kind }. */
export function refusalOf(kind, valueKinds, fields) {
  if (!kind) return null;
  for (const [property, value] of Object.entries(fields)) {
    const expected = kind.properties[property];
    if (expected === undefined) continue;
    if (!fitsKind(valueKinds[expected], value)) return { property, expected, value_kind: valueKindOf(value) };
  }
  return null;
}

/** The attribute facts of one record: [{ path, value, value_kind }] for every scalar or list of scalars it holds, its
 *  nested objects and lists of objects walked (a member's path carries its ordinal), as EEAF decomposed it. */
export function factsOf(value, resolve = item => item, path = [], out = []) {
  const here = resolve(value);
  if (!isObject(here)) return out;
  for (const [field, raw] of Object.entries(here)) {
    const item = resolve(raw);
    if (item === undefined) continue;
    if (isObject(item)) factsOf(item, resolve, [...path, field], out);
    else if (Array.isArray(item) && item.length && item.every(member => isObject(resolve(member)))) item.forEach((member, ordinal) => factsOf(member, resolve, [...path, field, ordinal], out));
    else out.push({ path: [...path, field], value: item, value_kind: valueKindOf(item) });
  }
  return out;
}

/**
 * The interaction sets one record holds: one per role over a list, its members in order, named by them (`set:` and the
 * hash `hash` gives of their ids in order), so the same members in the same order are one set wherever they are held, as
 * EEAF's interaction_sets kept one row per distinct members_hash. [{ set, role, members }]
 */
export function setsOf(parts, hash) {
  const byRole = new Map();
  for (const part of parts) {
    if (part.ordinal === null || part.ordinal === undefined) continue;
    if (!byRole.has(part.role)) byRole.set(part.role, []);
    byRole.get(part.role).push(part);
  }
  return [...byRole].map(([role, members]) => {
    const ids = members.sort((a, b) => a.ordinal - b.ordinal).map(member => member.id);
    return { set: `set:${hash(JSON.stringify(ids))}`, role, members: ids };
  });
}

/**
 * What a written value holds that the model does not declare, or null: { property: null } for a type no kind declares,
 * { property } for a top-level property its shipped kind does not name. A kind a record declares (a person's list) is
 * theirs to grow, so only its type is asked for.
 */
export function undeclaredOf(kind, value) {
  if (!kind) return { property: null };
  if (kind.declared_by || !isObject(value)) return null;
  const property = Object.keys(value).find(field => value[field] !== undefined && kind.properties[field] === undefined && kind.guard_properties?.[field] === undefined);
  return property === undefined ? null : { property };
}

/** A write of a shape the model does not declare, refused while the model is strict (the deploy's guard tests). */
export class ModelUndeclared extends Error {
  constructor(id, type, { property }) {
    super(property === null
      ? `Record ${id} is of type ${type}, which no kind in the model declares: declare it in src/record-model.json.`
      : `Record ${id} (${type}) holds ${property}, which its kind does not declare: add it to that kind's properties in src/record-model.json.`);
    this.code = 'model_undeclared';
    this.record_id = id;
    this.type = type;
    this.property = property;
  }
}

/** A write refused because a field it changes breaks the kind its record's type declares. */
export class ModelRefused extends Error {
  constructor(id, type, { property, expected, value_kind }) {
    super(`Record ${id} (${type}) cannot keep ${value_kind} at ${property}: its kind declares ${property} as ${expected}.`);
    this.code = 'model_refused';
    this.record_id = id;
    this.type = type;
    this.property = property;
    this.expected = expected;
    this.value_kind = value_kind;
  }
}
