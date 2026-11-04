// src/record-model-tools.mjs
//
// PURPOSE
//   The EEAF data model of a person's records, read by any AI and by the app through one road: GET /records/model on the
//   person's store and the read_model tool over it. Without an id it answers the kinds the store holds or declares (each
//   entity type with its properties, the value kinds each property has held and the kind declared for it, and its parts:
//   participation roles, a role over a list being an interaction set); with an id, that one record as attribute facts,
//   what it holds by its kind's parts, and what holds it (participation read the other way: what it is inside). The model
//   itself is parts/record-log record-model.mjs over src/record-model.json; nothing here keeps or changes anything.
//
// NON-NEGOTIABLE INVARIANTS
//   1. read_model only reads, and is marked read-only; the one write here is relate (relate_records): relations and the
//      entities they name, each named by what it is, so saying it again changes nothing.
//   2. A model still being walked over records kept before it says so (`complete: false`), so a part or property not
//      shown yet reads as not known yet, never as absent.
//   3. A relation is one edge both ends read, with an order key per side and an alive flag: each end orders its links of
//      one role on its own (subject_order, object_order: fractional keys, ties broken by relation id), a new one goes
//      last on each side unless placed after another, and ending one (alive false) keeps it with its places, so
//      relating it again puts it back where it was. Ended relations are left out of the ordered read unless asked for.
//

import modelData from './record-model.json' with { type: 'json' };
import scopeData from './record-scope.json' with { type: 'json' };
import { factsOf } from '../../record-log/do-work/record-model.mjs';
import { isOrderKey, keyBetween } from '../parts/visual-database/do-work/fractional-order.ts';

const MOST = 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const at = (value, path) => path.reduce((found, key) => object(found) && Object.hasOwn(found, key) ? found[key] : undefined, value);
const namedValue = value => typeof value === 'number' ? String(value) : word(value);
const inspectionError = (message, code = 'inspection_invalid') => Object.assign(new Error(message), { code });
const canBeDeclared = type => typeof type === 'string' && modelData.declared_by.some(rule => type.startsWith(rule.kind.prefix ?? ''));
const readBudget = () => ({ reads: 128, bytes: 8 * 1024 * 1024 });

const referenceCanonical = value => {
  if (Array.isArray(value)) return `[${value.map(referenceCanonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${referenceCanonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function jsonData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(item => jsonData(item, seen));
  seen.delete(value);
  return valid;
}
const hasEmptyObject = value => object(value)
  ? Object.keys(value).length === 0 || Object.values(value).some(hasEmptyObject)
  : Array.isArray(value) && value.some(hasEmptyObject);

/** Match a strict typed reference against one fresh, complete current facts read.
 *  Callers must obtain `current` from the record owner under its normal rights. */
export function recordReferenceMatches(reference, current) {
  if (!object(reference) || Object.keys(reference).some(key => !['id', 'type', 'fields'].includes(key))
    || !word(reference.id) || !word(reference.type) || !object(reference.fields) || !Object.keys(reference.fields).length
    || !jsonData(reference.fields) || hasEmptyObject(reference.fields)
    || !object(current) || current.id !== reference.id || current.type !== reference.type || current.version !== 'current'
    || current.complete !== true || !Array.isArray(current.facts) || !current.facts.every(fact => object(fact) && Array.isArray(fact.path))) return false;
  const expected = factsOf(reference.fields);
  if (!expected.length) return false;
  const actual = new Map(current.facts.map(fact => [referenceCanonical(fact.path), fact.value]));
  return expected.every(fact => actual.has(referenceCanonical(fact.path))
    && referenceCanonical(actual.get(referenceCanonical(fact.path))) === referenceCanonical(fact.value));
}

/** Native owners declare their public identity and any retained storage alias.
 *  This is only address normalization; no owner or record is read here. */
export function nativeInspectionAddress(requested, declarations = modelData.native_inspection?.readers ?? []) {
  const raw = word(requested);
  if (!raw) return null;
  for (const declaration of declarations) {
    const pattern = new RegExp(declaration.pattern);
    if (pattern.test(raw)) return { id: raw.replace(pattern, declaration.canonical ?? '$&'), requested_id: raw, declaration };
  }
  return null;
}

/** Resolve only existing address conventions. A list's declared row type, not its
 *  display name or slug, owns the row identity. This never searches all lists. */
export function inspectionRecordId(records, requested) {
  const id = word(requested);
  if (!id) throw inspectionError('Say which record to inspect.');
  const native = nativeInspectionAddress(id);
  if (native) return { id: native.id, requested_id: id };
  if (/^file:(?:1f|12):[a-f0-9]{64}$/i.test(id)) return { id: id.slice(5), requested_id: id };
  const row = /^list:([^:]+):rows:(.+)$/.exec(id);
  if (!row) return { id, requested_id: id };
  const declaration = `list:${row[1]}`;
  const list = records.read(declaration);
  if (!object(list) || !word(list.row_type)) return { id, requested_id: id,
    unresolved: { code: 'list_declaration_missing', declaration } };
  return { id: `record:${list.row_type}:${row[2]}`, requested_id: id, declaration };
}

/** One bounded naming projection over the same records/model. List row names and
 *  fields come from that kind's exact declaring list; shipped kinds keep the
 *  existing record-scope naming DATA. An unavailable label is not a missing row. */
export function recordModelLabels(records, references, { limit = MOST, knownTypes = {}, declarations = {}, modelBudget = readBudget() } = {}) {
  const labels = Object.create(null), types = new Map(), values = new Map();
  const read = id => {
    if (values.has(id)) return values.get(id);
    if (modelBudget.reads <= 0 || modelBudget.bytes <= 0) throw inspectionError('This page reached its record naming read budget.', 'inspection_label_budget');
    modelBudget.reads -= 1;
    const engine = typeof records.engine === 'function' ? records.engine() : records.engine;
    // The decomposed owner's sizeOf is an exact aggregate walk; its read()
    // already enforces row/byte bounds incrementally. Do not add a preflight
    // walk there. Packed records have their size beside the current value.
    const size = engine !== 'eeaf' && typeof records.sizeOf === 'function' ? records.sizeOf(id) : null;
    if (Number.isFinite(size?.bytes) && size.bytes > modelBudget.bytes) {
      modelBudget.bytes = 0;
      throw inspectionError('This page reached its record naming byte budget.', 'inspection_label_budget');
    }
    const value = records.read(id);
    const bytes = Math.max(Number.isFinite(size?.bytes) ? size.bytes : 0, new TextEncoder().encode(JSON.stringify(value ?? null)).length);
    if (bytes > modelBudget.bytes) {
      modelBudget.bytes = 0;
      throw inspectionError('This page reached its record naming byte budget.', 'inspection_label_budget');
    }
    modelBudget.bytes -= bytes;
    values.set(id, value);
    return value;
  };
  const kind = type => {
    if (!canBeDeclared(type) || typeof records.model !== 'function') return null;
    if (!types.has(type)) {
      const answer = records.model({ type, declaration_only: true, model_budget: modelBudget });
      types.set(type, { ...answer.kinds?.find(row => row.type === type), complete: answer.complete !== false });
    }
    return types.get(type);
  };
  for (const raw of [...new Set(references.filter(ref => typeof ref === 'string'))].slice(0, Math.max(1, Math.min(MOST, limit)))) {
    try {
      const resolved = inspectionRecordId({ read }, raw), id = resolved.id;
      const value = resolved.unresolved ? null : read(id);
      const type = !resolved.unresolved ? (typeof records.typeOf === 'function' ? records.typeOf(id) : knownTypes[raw]) ?? null : null;
      const direct = resolved.declaration ?? declarations[raw] ?? declarations[id];
      const model = direct ? { declared_by: direct, complete: true } : kind(type);
      const declaration = word(model?.declared_by);
      const list = declaration?.startsWith('list:') ? read(declaration) : null;
      const declaredRow = object(list) && `record:${list.row_type}` === type && id.startsWith(`${type}:`);
      const fromList = declaredRow && word(list.title_field) ? namedValue(value?.[list.title_field]) : null;
      const fromData = (scopeData.naming.title[type] ?? []).map(path => namedValue(at(value, path))).find(Boolean);
      const label = (fromList || fromData)?.slice(0, scopeData.naming.title_length) ?? null;
      const when = scopeData.naming.at.map(path => namedValue(at(value, path))).find(Boolean) ?? null;
      const listId = declaredRow ? declaration.slice(5) : null;
      const rowId = declaredRow ? id.slice(type.length + 1) : null;
      const open = declaredRow ? { screen: 'trillion.list', input: { id: listId, row: rowId },
        href: `/lists/${encodeURIComponent(listId)}?row=${encodeURIComponent(rowId)}` }
        : /^(?:1f|12):[a-f0-9]{64}$/i.test(id) ? { screen: 'trillion.file', input: { id }, href: `/file/${encodeURIComponent(id)}` } : null;
      const unresolved = resolved.unresolved ?? (model?.complete === false ? { code: 'record_declaration_incomplete' }
        : declaration?.startsWith('list:') && !declaredRow ? { code: 'list_declaration_missing', declaration } : null);
      const named = { id, ref: raw, type, title: label, label, at: when,
        missing: resolved.unresolved ? null : value === null || value === undefined,
        version: 'current', ...(unresolved ? { unresolved } : {}), ...(open ? { open } : {}) };
      labels[raw] = named;
      if (id !== raw && !Object.hasOwn(labels, id)) labels[id] = { ...named, ref: id };
    } catch (error) {
      labels[raw] = { id: raw, ref: raw, title: null, label: null, missing: null, unavailable: true,
        version: 'current', error: { code: error?.code ?? 'record_read_failed' } };
    }
  }
  return labels;
}

const CURSOR_PREFIX = 'inspect:';
function inspectionCursor(value, id, role) {
  if (!value?.startsWith(CURSOR_PREFIX)) return { part: 0, holder: value || null, holders_done: false, holders_complete: false };
  try {
    const cursor = JSON.parse(decodeURIComponent(value.slice(CURSOR_PREFIX.length)));
    if (cursor.id !== id || cursor.role !== role || !Number.isSafeInteger(cursor.part) || cursor.part < 0
      || cursor.holder !== null && typeof cursor.holder !== 'string' || typeof cursor.holders_done !== 'boolean'
      || cursor.holders_complete !== undefined && typeof cursor.holders_complete !== 'boolean') throw new Error();
    return cursor;
  } catch { throw inspectionError('This relationship page does not belong to this record and role. Start from its first page.', 'inspection_cursor_invalid'); }
}

/** The model read shared by HTTP and MCP. inspect=true enriches the original
 *  facts/parts/holders contract; it stores no new facts, evidence or indexes. */
export function readRecordModel(records, input = {}, { native = null } = {}) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]));
  const requested = params.get('id'), set = params.get('set');
  const valid = params.get('valid') || null, known = params.get('known') || null;
  const limit = Math.max(1, Math.min(MOST, Math.floor(Number(params.get('limit'))) || 100));
  const table = params.get('table');
  if (table) {
    if (params.get('history') === 'true') return { type: table, history: records.tableHistory({ type: table, after: Number(params.get('after')) || 0, limit }) };
    if (params.get('schema') === 'true') return records.tableSchema(table);
    return records.tableRows(table, { ...(params.get('after') ? { after: params.get('after') } : {}), limit });
  }
  if (set) return records.set(set, { limit }) ?? { set, members: null, holders: [] };
  if (params.get('history')) return contactHistory(records, { id: params.get('history'), with: params.get('with') ?? undefined, kinds: params.get('kinds') ?? undefined,
    role: params.get('role') ?? undefined, since: params.get('since') ?? undefined, until: params.get('until') ?? undefined, limit });
  if (params.get('side')) return orderedRelations(records, { id: requested, side: params.get('side'), role: params.get('role'), ended: params.get('ended') === 'true' });
  if (!requested) return records.model(params.get('type') ? { type: params.get('type') } : {});
  if (native) return nativeModelView(records, params, native);
  const inspect = params.get('inspect') === 'true';
  const resolved = inspect ? inspectionRecordId(records, requested) : { id: nativeInspectionAddress(requested)?.id ?? requested };
  const id = resolved.id;
  if (resolved.unresolved) return { ...resolved, type: null, facts: null, parts: null, sets: null, holders: [], fields: [],
    labels: {}, complete: false, next: null, version: { mode: valid || known ? 'historical' : 'current', valid, known, labels: 'current' } };
  let historical = null;
  if (valid || known) {
    if (inspect && [valid, known].some(time => time && !Number.isFinite(Date.parse(time)))) throw inspectionError('True at and known at must be valid date-times.', 'inspection_time_invalid');
    historical = records.recordAt(id, { valid, known }) ?? { id, value: null, facts: null };
    if (!inspect) return historical;
  }
  const modelBudget = readBudget();
  const readOptions = inspect ? { narrow_model: true, model_budget: modelBudget } : undefined;
  const facts = records.factsOf(id, readOptions), role = params.get('role') || null;
  const cursor = inspect ? inspectionCursor(params.get('after'), id, role) : null;
  const after = inspect ? cursor.holder : params.get('after');
  const holders = cursor?.holders_done ? { holders: [], complete: cursor.holders_complete === true, next: null }
    : records.holdersOf(id, { ...(role ? { role } : {}), ...(after ? { after } : {}), limit, ...readOptions });
  const partPage = facts ? records.partsOf(id, readOptions) : null;
  const setPage = facts ? records.setsOf(id, readOptions) : null;
  const allParts = partPage?.parts ?? null;
  const sets = setPage?.sets ?? null;
  if (!inspect) return { id, type: facts?.type ?? null, facts: facts?.facts ?? null, parts: allParts, sets, ...holders };
  const parts = allParts?.slice(cursor.part, cursor.part + limit) ?? null;
  const partNext = cursor.part + (parts?.length ?? 0), moreParts = partNext < (allParts?.length ?? 0);
  const next = moreParts || holders.next ? CURSOR_PREFIX + encodeURIComponent(JSON.stringify({ id, role, part: partNext,
    holder: holders.next ?? cursor.holder, holders_done: !holders.next, holders_complete: holders.complete !== false })) : null;
  const currentType = facts?.type ?? null, type = historical?.type ?? currentType;
  const model = !resolved.declaration && canBeDeclared(currentType) ? records.model({ type: currentType, declaration_only: true, model_budget: modelBudget }) : null;
  const declaration = resolved.declaration ?? model?.kinds?.find(row => row.type === currentType)?.declared_by;
  const list = declaration?.startsWith('list:') ? records.read(declaration) : null;
  const refs = [id, requested, ...(parts ?? []).map(part => part.id), ...holders.holders.map(holder => holder.id)];
  const uniqueRefs = [...new Set(refs)], labels = recordModelLabels(records, uniqueRefs,
    { declarations: resolved.declaration ? { [id]: resolved.declaration, [requested]: resolved.declaration } : {}, modelBudget });
  const labelsComplete = uniqueRefs.length <= MOST && !Object.values(labels).some(label => label.unavailable || label.unresolved);
  const declarationComplete = facts?.complete !== false && partPage?.complete !== false && setPage?.complete !== false && model?.complete !== false;
  return { ...(historical ?? {}), ...resolved, type, facts: historical ? historical.facts : facts?.facts ?? null, parts, sets, ...holders, next,
    fields: object(list) && `record:${list.row_type}` === currentType && Array.isArray(list.fields) ? list.fields : [], labels,
    complete: holders.complete !== false && declarationComplete && !next && labelsComplete,
    version: { mode: historical ? 'historical' : 'current', valid, known,
      facts: historical ? 'selected_version' : 'current', labels: 'current', fields: 'current', relations: 'current' },
    coverage: { facts: historical ? historical.facts === null ? 'not_found_at_version' : 'selected_version' : facts ? 'current' : 'not_found',
      relations: historical ? 'current_only' : 'current', declaration: { complete: declarationComplete,
        issues: [...(partPage?.declaration_issues ?? []), ...(setPage?.declaration_issues ?? [])] },
      parts: { total: allParts?.length ?? 0, after: cursor.part, complete: !moreParts && partPage?.complete !== false },
      holders: { complete: holders.complete !== false, next: holders.next ?? null }, labels: { complete: labelsComplete, limit: MOST } } };
}

/** An existing native owner may supply one exact, bounded record through the
 *  same facts view. It remains in that owner: this adapter never writes it into
 *  EEAF or invents a historical version. Incoming links still use the existing
 *  EEAF participation index. No domain or owner is selected here. */
function nativeModelView(records, params, native) {
  const requested = params.get('id');
  if (!word(native.id) || !word(native.type) || (native.requested_id !== requested && native.id !== requested))
    throw inspectionError('The native read does not belong to this requested record.', 'inspection_native_mismatch');
  const id = native.id;
  const current = native.coverage?.facts === 'current';
  const currentFacts = current && Array.isArray(native.facts) ? native.facts : null;
  const exact = value => value === id || value === requested;
  const view = Object.assign(Object.create(records), {
    read: key => exact(key) ? current ? native.value : null : records.read(key),
    typeOf: key => exact(key) ? native.type : records.typeOf(key),
    model: input => input?.type === native.type ? { kinds: [{ type: native.type, parts: [], declared_by: null }], complete: true } : records.model(input),
    factsOf: key => exact(key) ? currentFacts ? { id, type: native.type, facts: currentFacts } : null : records.factsOf(key),
    partsOf: key => exact(key) ? { id, parts: current ? native.parts ?? [] : [] } : records.partsOf(key),
    setsOf: key => exact(key) ? { id, sets: current ? native.sets ?? [] : [] } : records.setsOf(key),
    recordAt: (key, times) => exact(key) ? { id, type: native.type, value: null, facts: null } : records.recordAt(key, times),
  });
  const selected = new URLSearchParams(params);
  selected.set('id', id);
  const answer = readRecordModel(view, selected);
  const historical = Boolean(params.get('valid') || params.get('known'));
  const coverage = historical ? 'historical_unsupported' : native.coverage?.facts ?? 'unavailable';
  if (answer.labels) {
    const existing = answer.labels[id] ?? { id, ref: id, title: null, label: null, version: 'current' };
    const named = { ...existing, type: native.type, missing: current ? false : coverage === 'not_found' ? true : null,
      ...(word(native.title) ? { title: native.title, label: native.title } : {}), ...(native.open ? { open: native.open } : {}),
      ...(word(native.open_href) ? { open_href: native.open_href } : {}),
      ...(native.error ? { unavailable: true, error: native.error } : {}) };
    answer.labels = { ...answer.labels, [id]: named, [requested]: { ...named, ref: requested } };
  }
  return { ...answer, id, requested_id: requested, type: native.type, source: native.source,
    facts: historical ? null : currentFacts, ...(native.error ? { error: native.error } : {}),
    complete: answer.complete !== false && native.complete !== false && current,
    version: { ...(answer.version ?? {}), mode: historical ? 'historical' : 'current',
      facts: historical ? 'historical_unsupported' : coverage, history: 'unsupported' },
    coverage: { ...(answer.coverage ?? {}), facts: coverage, history: 'unsupported', native: native.coverage,
      outgoing: 'owner_declared_only', incoming: 'eeaf_participation' } };
}

/** GET /records/model[?type=][&id=&role=&after=&limit=] over a person's records, or null when the path is not this. */
export function handleModelRequest(records, request, options = {}) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/records/model') return null;
  try {
    return Response.json(readRecordModel(records, url.searchParams, options));
  } catch (error) {
    return Response.json({ error: error.message, ...(error?.code ? { code: error.code } : {}) }, { status: error?.code === 'record_too_large' ? 413 : 400 });
  }
}

// Relations: participation between any two things with the role as data ("Pat is the dad of me", "Ann is a member of
// UAB Theta Chi"). A relation is a record of kind `relation` (src/record-model.json: subject, the role, object, and the
// words it was read from), named by what it relates so saying it again changes nothing; a group, organisation or place
// it names is an entity record of its own kind, made once. `me` is the person whose store this is (model `self`).
const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const textHash = text => { let a = 0x811c9dc5, b = 0x01000193; for (const ch of text) { a = Math.imul(a ^ ch.codePointAt(0), 0x01000193) >>> 0; b = Math.imul(b ^ ch.codePointAt(0), 0x5bd1e995) >>> 0; } return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); };
const RELATE_MOST = 500;
const ENTITY_KINDS = new Set(modelData.relations.entity_kinds);
// The two sides of a relation: which end it is read from, the role that end holds it under, and where its order key is.
const SIDES = {
  subject: { end: 'subject', key: 'subject_order', holderRole: () => 'subject' },
  object: { end: 'object', key: 'object_order', holderRole: role => role },
};
// The relations of one end and role, as kept (live and ended): read through what holds that end, bounded by side_most.
function sideRelations(records, side, endId, role) {
  const found = [];
  let after = null;
  do {
    const page = records.holdersOf(endId, { role: SIDES[side].holderRole(role), limit: modelData.relations.side_most, ...(after ? { after } : {}) });
    for (const holder of page.holders) {
      const value = holder.id.startsWith('relation:') ? records.read(holder.id) : null;
      if (object(value) && value[SIDES[side].end] === endId && value.role === role) found.push({ id: holder.id, ...value });
    }
    after = page.next ?? null;
  } while (after && found.length < modelData.relations.side_most);
  return found;
}
const byKey = key => (a, b) => (a[key] ?? '') < (b[key] ?? '') ? -1 : (a[key] ?? '') > (b[key] ?? '') ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const ACTIVITIES = modelData.activities;
const ACTIVITY_KINDS = new Set(ACTIVITIES.kinds), PARTICIPANT_ROLES = new Set(ACTIVITIES.participant_roles);
/** One activity as the record it is (src/record-model.json activities): { kind, at, participants: [{ record, role? }], summary?,
 *  direction?, source?, said? }. It is named by what it is, so saying it again changes nothing; at least one record took part. */
function activityRecord(activity, resolve, records) {
  if (!object(activity)) throw new Error('An activity is { kind, at, participants } with a few words of summary.');
  const kind = word(activity.kind)?.toLowerCase();
  if (!ACTIVITY_KINDS.has(kind)) throw new Error(`An activity is one of ${ACTIVITIES.kinds.join(', ')}.`);
  const at = word(activity.at);
  if (!at || !Number.isFinite(Date.parse(at))) throw new Error('An activity says when it was, as a date-time (at).');
  if (!Array.isArray(activity.participants) || activity.participants.length < 1 || activity.participants.length > ACTIVITIES.participants_most) {
    throw new Error(`An activity names who took part: between 1 and ${ACTIVITIES.participants_most} records.`);
  }
  const taking = new Map();
  for (const part of activity.participants) {
    const record = resolve(object(part) ? part.record : part);
    const role = object(part) && part.role !== undefined ? word(part.role)?.toLowerCase() : 'participant';
    if (!PARTICIPANT_ROLES.has(role)) throw new Error(`A participant's role is one of ${ACTIVITIES.participant_roles.join(', ')}.`);
    taking.set(`${record}\u0000${role}`, { record, role });
  }
  const participants = [...taking.values()].sort((a, b) => a.record < b.record ? -1 : a.record > b.record ? 1 : a.role < b.role ? -1 : 1);
  const text = (field, most) => {
    if (activity[field] === undefined) return {};
    if (typeof activity[field] !== 'string' || [...activity[field]].length > most) throw new Error(`${field} is words of at most ${most} characters.`);
    return activity[field] ? { [field]: activity[field] } : {};
  };
  const source = word(activity.source);
  const id = `activity:${textHash(JSON.stringify([kind, new Date(at).toISOString(), source, participants]))}`;
  const value = { kind, at: new Date(at).toISOString(), participants, ...text('summary', ACTIVITIES.summary_most), ...text('direction', 80), ...text('said', ACTIVITIES.summary_most), ...(source ? { source } : {}) };
  const before = records.read(id);
  return { id, type: 'activity', value, same: object(before) && JSON.stringify(before) === JSON.stringify(value) };
}

/** Everything that happened with one record, newest first (src/record-model.json activities): { id, with?, kinds?, role?,
 *  since?, until?, limit? } -> { id, activities, last_contact, complete }. `with` keeps the activities another record also took
 *  part in (a pair's shared history); `role` the ones this record took part in under that role; `last_contact` is the newest
 *  activity at or before now (or before `until`). */
export function contactHistory(records, { id, with: other, kinds, role, since, until, limit } = {}) {
  const endId = id === 'me' ? modelData.relations.self : word(id);
  if (!endId) throw new Error('Say whose history to read (history).');
  const withId = other === undefined ? null : other === 'me' ? modelData.relations.self : word(other);
  const kindList = kinds === undefined ? null : (Array.isArray(kinds) ? kinds : String(kinds).split(',')).map(one => String(one).trim().toLowerCase()).filter(Boolean);
  if (kindList?.some(one => !ACTIVITY_KINDS.has(one))) throw new Error(`An activity is one of ${ACTIVITIES.kinds.join(', ')}.`);
  const roleWord = role === undefined ? null : String(role).trim().toLowerCase();
  if (roleWord && !PARTICIPANT_ROLES.has(roleWord)) throw new Error(`A participant's role is one of ${ACTIVITIES.participant_roles.join(', ')}.`);
  const time = (name, value) => {
    if (value === undefined || value === null || value === '') return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error(`${name} is a date-time.`);
    return ms;
  };
  const from = time('since', since), to = time('until', until);
  const most = Math.max(1, Math.min(MOST, Math.floor(Number(limit)) || 100));
  const found = [];
  let after = null, complete = true, walked = 0;
  do {
    const page = records.holdersOf(endId, { role: 'participant', limit: 100, ...(after ? { after } : {}) });
    for (const holder of page.holders) {
      const value = holder.id.startsWith('activity:') ? records.read(holder.id) : null;
      if (!object(value) || !Array.isArray(value.participants)) continue;
      const ms = Date.parse(value.at);
      const mine = value.participants.filter(part => part.record === endId);
      if ((kindList && !kindList.includes(value.kind)) || (roleWord && !mine.some(part => part.role === roleWord))
        || (withId && !value.participants.some(part => part.record === withId)) || (from !== null && ms < from) || (to !== null && ms > to)) continue;
      found.push({ id: holder.id, ...value, as: mine.map(part => part.role) });
    }
    walked += page.holders.length;
    after = page.next ?? null;
    if (after && walked >= ACTIVITIES.history_most) complete = false;
  } while (after && walked < ACTIVITIES.history_most);
  found.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1);
  const edge = to ?? Date.now();
  return { id: endId, activities: found.slice(0, most), count: found.length, last_contact: found.find(one => Date.parse(one.at) <= edge)?.at ?? null, complete };
}

/** Keeps relations and the entities they name: { relations: [{ subject, role, object, said?, alive?, order? }], entities?: [{ kind, name }] }.
 *  A subject or object is a record id, `me`, or `<entity kind>:<name>` for an entity made once by its name. `order`
 *  places it on a side: { subject?: { after }, object?: { after } } where after is a relation id of the same end and
 *  role (null: first); a side not named keeps its place, or goes last when new. `alive: false` ends it (invariant 3). */
export function relate(records, { relations = [], entities = [], activities = [] } = {}, { actor = { by: 'relations' } } = {}) {
  if (!Array.isArray(relations) || !Array.isArray(entities) || !Array.isArray(activities) || relations.length + entities.length + activities.length > RELATE_MOST) throw new Error(`relations and entities are lists of at most ${RELATE_MOST} together`);
  const made = new Map();
  const entityOf = (kind, name) => {
    if (!ENTITY_KINDS.has(kind) || typeof name !== 'string' || !name.trim() || !slug(name)) throw new Error(`An entity is one of ${[...ENTITY_KINDS].join(', ')} with a name.`);
    const id = `${kind}:${slug(name)}`;
    if (!made.has(id) && !records.read(id)) made.set(id, { id, type: kind, value: { name: name.trim() } });
    return id;
  };
  for (const entity of entities) entityOf(entity?.kind, entity?.name);
  const resolve = end => {
    if (end === 'me') return modelData.relations.self;
    if (typeof end !== 'string' || !end || end.includes('/')) throw new Error('A subject or object is a record id, me, or <entity kind>:<name>.');
    const colon = end.indexOf(':');
    const kind = colon > 0 ? end.slice(0, colon) : null;
    return ENTITY_KINDS.has(kind) && !records.read(end) ? entityOf(kind, end.slice(colon + 1)) : end;
  };
  // Each side's relations as this call leaves them, read once per end and role, so several placed in one call see each other.
  const sides = new Map();
  const sideOf = (side, endId, role) => {
    const at = JSON.stringify([side, endId, role]);
    if (!sides.has(at)) sides.set(at, sideRelations(records, side, endId, role).sort(byKey(SIDES[side].key)));
    return sides.get(at);
  };
  const place = (side, value, id, asked) => {
    const key = SIDES[side].key;
    const others = sideOf(side, value[SIDES[side].end], value.role).filter(one => one.id !== id);
    let lower = null, upper = null;
    if (asked === undefined) {
      if (isOrderKey(value[key])) return value[key];
      lower = others.at(-1)?.[key] ?? null;
    } else {
      const afterId = object(asked) && (asked.after === null || typeof asked.after === 'string') ? asked.after : undefined;
      if (afterId === undefined) throw new Error(`order.${side} is { after: a relation id of the same ${side} and role, or null for first }.`);
      const at = afterId === null ? -1 : others.findIndex(one => one.id === afterId);
      if (afterId !== null && at < 0) throw new Error(`${afterId} is not a relation of this ${side} and role.`);
      lower = at < 0 ? null : others[at][key] ?? null;
      upper = others[at + 1]?.[key] ?? null;
    }
    const valid = one => (isOrderKey(one) ? one : null);
    return keyBetween(valid(lower), valid(upper) && valid(upper) > (valid(lower) ?? '') ? valid(upper) : null);
  };
  const kept = relations.flatMap(relation => {
    const subject = resolve(relation?.subject), objectEnd = resolve(relation?.object);
    const role = typeof relation?.role === 'string' ? relation.role.trim().toLowerCase() : '';
    if (!role || role.length > 80) throw new Error('A relation names its role in a few words.');
    if (relation.alive !== undefined && typeof relation.alive !== 'boolean') throw new Error('alive is true or false.');
    if (relation.order !== undefined && (!object(relation.order) || Object.keys(relation.order).some(side => !SIDES[side]))) throw new Error('order is { subject?: { after }, object?: { after } }.');
    const id = `relation:${textHash(JSON.stringify([subject, role, objectEnd]))}`;
    const before = records.read(id);
    const value = { ...(object(before) ? before : {}), subject, role, object: objectEnd, alive: relation.alive ?? true,
      ...(typeof relation.said === 'string' && relation.said ? { said: relation.said } : {}) };
    for (const side of Object.keys(SIDES)) {
      value[SIDES[side].key] = place(side, value, id, relation.order?.[side]);
      const list = sideOf(side, value[SIDES[side].end], role).filter(one => one.id !== id);
      list.push({ id, ...value });
      list.sort(byKey(SIDES[side].key));
      sides.set(JSON.stringify([side, value[SIDES[side].end], role]), list);
    }
    // Saying it again as it is changes nothing.
    return object(before) && JSON.stringify(before) === JSON.stringify(value) ? [{ id, type: 'relation', value, same: true }] : [{ id, type: 'relation', value }];
  });
  const happened = activities.map(activity => activityRecord(activity, resolve, records));
  const writes = [...made.values(), ...kept.filter(write => !write.same).map(({ id, type, value }) => ({ id, type, value })),
    ...happened.filter(write => !write.same).map(({ id, type, value }) => ({ id, type, value }))];
  if (writes.length) records.write(writes, { actor });
  return { relations: kept.map(write => ({ id: write.id, ...write.value })), entities: [...made.keys()],
    ...(activities.length ? { activities: happened.map(write => ({ id: write.id, ...write.value })) } : {}) };
}

/** The relations of one end, in that end's own order: { id, side: 'subject' | 'object', role, ended? } -> { relations }.
 *  Ended relations are left out unless `ended` is true (invariant 3). */
export function orderedRelations(records, { id, side = 'subject', role, ended = false } = {}) {
  if (!SIDES[side]) throw new Error('side is subject or object: which end the relations are read from.');
  const endId = id === 'me' ? modelData.relations.self : word(id);
  const named = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (!endId || !named) throw new Error('Say which record (id) and which role to read the relations of.');
  const all = sideRelations(records, side, endId, named).sort(byKey(SIDES[side].key));
  return { id: endId, side, role: named, relations: all.filter(one => ended || one.alive !== false),
    complete: all.length < modelData.relations.side_most };
}

/** POST /records/model/relate (relate above), or null when the path is not this. */
export function handleRelateRequest(records, request) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/records/model/relate') return null;
  return request.json().catch(() => null).then(body => {
    try { return Response.json(relate(records, body ?? {}, { actor: { by: 'relations', app: request.headers.get('x-trillion-app') ?? null } })); }
    catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  });
}

const query = input => new URLSearchParams(Object.entries(input ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, String(value)]));

export const modelTools = call => [
  { name: 'read_table', description: 'Read rows from one of your tables. Choose schema to read its columns or history to read dated column changes. complete is false while earlier saved rows are still being copied into the table. Use the last row id as after to read another page; history uses its sequence number.', inputSchema: { type: 'object', properties: {
    table: { type: 'string', description: 'The record kind declared by your list' },
    schema: { type: 'boolean' }, history: { type: 'boolean' },
    after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: MOST },
  }, required: ['table'] }, run: input => call(`/records/model?${query(input)}`) },
  { name: 'read_model', description: 'Reads how this person\'s records are modelled (entities, attribute facts and participation, the EEAF model). With no id: every kind of record they hold or declare, each with how many records it has, what declares it (the shipped model, or the id of the record that declares it, such as one of their lists), its properties (each with the value kind declared for it, if any, and every value kind it has held) and its parts (roles under which a record of that kind holds other things; a role over a list is an ordered set); type narrows it to one kind. With id (any record id, or a file identity such as 1f:...): that record as attribute facts (each value at its path with its value kind), what it holds by role in order, the interaction sets it holds (each named set:..., the same members in the same order being one set wherever held; set reads one), and what holds it, i.e. which records it is inside and under which role (role filters, after and limit page through holders; next is the after for the next page). complete false means records kept before the model are still being walked (for holders: the kinds with parts, walked first; for the kinds list: every record\'s properties), so a part or property not shown is not known yet. With valid or known: the record as it was true at that time by what had been written by then (bitemporal), each fact with its valid_time and system_time. Each kind lists its indexes (id, type, and declared field indexes with whether each is built). It changes nothing.', inputSchema: { type: 'object', properties: {
    id: { type: 'string', description: 'A record id or a file identity; leave out for the kinds' },
    inspect: { type: 'boolean', description: 'With id: include current names, declared list field labels and exact owner links; page outgoing parts and incoming holders together. With valid or known the facts are historical; names, fields and relationships remain current and are explicitly marked as current.' },
    type: { type: 'string', description: 'One kind of record, when id is left out' },
    role: { type: 'string', description: 'Only holders holding id under this role' },
    after: { type: 'string', description: 'The next value of a previous page of holders' },
    limit: { type: 'integer', minimum: 1, maximum: MOST, description: 'At most this many holders (100 when left out)' },
    set: { type: 'string', description: 'An interaction set by its name (set:...): its members in order and every record holding it' },
    valid: { type: 'string', description: 'With id: the record as it was true at this time (ISO), each fact with when it became true and when it was written' },
    known: { type: 'string', description: 'With id: the record by only what had been written by this time (ISO)' },
    side: { type: 'string', enum: Object.keys(SIDES), description: 'With id and role: the relations of that end in its own order (subject: the relations it is the subject of; object: the relations naming it as the role), each with its order keys and alive' },
    ended: { type: 'boolean', description: 'With side: include ended relations (alive false)' },
    history: { type: 'string', description: 'A record id (or me): everything that happened with it (activities), newest first, with when they were last in touch. with keeps the ones another record also took part in; kinds (comma list), role, since, until and limit narrow it.' },
    with: { type: 'string', description: 'With history: another record that also took part' },
    kinds: { type: 'string', description: 'With history: only these kinds of activity, comma separated' },
    since: { type: 'string', description: 'With history: only activities at or after this date-time' },
    until: { type: 'string', description: 'With history: only activities at or before this date-time' },
  } }, run: input => call(`/records/model?${query(input)}`) },
  { name: 'relate_records', description: 'Keeps how things in this person\'s records are related, as participation with the role as data: each relation says subject is the role of object ("Pat" is the "dad" of "me"; a contact is a "member" of "organisation:UAB Theta Chi"; one contact is the "sister" of another). subject and object are record ids (a list row is record:<row type>:<row id>), me (the person), or <kind>:<name> for a group, organisation or place, made once by its name. said keeps the words it was read from. Each end keeps its own order of its relations of one role: a new one goes last on both ends, and order { subject: { after }, object: { after } } places it after another relation of that end (null: first). alive false ends a relation and keeps where it was, so relating it again puts it back there. Saying the same relation again changes nothing; read_model with the id of either end answers it under its role, and with side and role in that end\'s order.', inputSchema: { type: 'object', properties: {
    relations: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string' }, role: { type: 'string' }, object: { type: 'string' }, said: { type: 'string' }, alive: { type: 'boolean' },
      order: { type: 'object', properties: Object.fromEntries(Object.keys(SIDES).map(side => [side, { type: 'object', properties: { after: { type: ['string', 'null'] } }, required: ['after'] }])) } }, required: ['subject', 'role', 'object'] } },
    entities: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: modelData.relations.entity_kinds }, name: { type: 'string' } }, required: ['kind', 'name'] } },
    activities: { type: 'array', description: 'Things that happened between people, kept as records so a person\'s history is a read: each is a kind (email, call, meeting, message, introduction, note), when it was (at, a date-time) and who took part (participants: record ids, me, or <kind>:<name>, each with an optional role such as sender, caller or attendee), with optional summary, direction and source. Saying it again changes nothing. read_model with history and a record id answers everything that happened with them, newest first, and when they were last in touch.', items: { type: 'object', properties: { kind: { type: 'string', enum: modelData.activities.kinds }, at: { type: 'string' }, summary: { type: 'string' }, direction: { type: 'string' }, source: { type: 'string' }, said: { type: 'string' },
      participants: { type: 'array', items: { type: 'object', properties: { record: { type: 'string' }, role: { type: 'string', enum: modelData.activities.participant_roles } }, required: ['record'] } } }, required: ['kind', 'at', 'participants'] } },
  }, required: [] }, run: input => call('/records/model/relate', input) },
  { name: 'erase_record', description: 'Erases one record whose kind keeps words that can be erased (a message, and what holds its words: its corrections, what arrived from it, the work handed on from it), with every record holding the same words. The words read nowhere at once; copies kept before are cleaned in the background, and scrub says how far that is (call again with the same record to see it reach done). Replies and results that quoted it keep their own words. A kind with no words that can be erased is refused.', inputSchema: { type: 'object', properties: {
    record: { type: 'string', description: 'The id of the record to erase' },
  }, required: ['record'] }, run: input => call('/records/erase', input) },
  { name: 'erasure_check', description: 'Checks that erased words are gone: counts how many places of this person\'s own store still hold the given words (the log, what changes replaced, the stored pages, search, other tables, kept history files, and what reading the record and its history answer), and how many stored entries still keep the erased record\'s key. Counts only: the words are never answered or kept. Large stores answer a page at a time; pass next back until done is true. Places that cannot be counted are named in a sentence.', inputSchema: { type: 'object', properties: {
    record: { type: 'string', description: 'The id of the record that was erased' },
    words: { type: 'string', description: 'Words the record held, 4 to 500 characters' },
    next: { type: 'object', description: 'The next of the previous answer, to go on' },
  }, required: ['record', 'words'] }, run: input => call('/records/erasure-check', input) },
];

export const modelAnnotations = {
  read_table: { title: 'Read my table', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_model: { title: 'Read how my records are modelled', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  relate_records: { title: 'Say how things are related', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  erase_record: { title: 'Erase a record', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  erasure_check: { title: 'Check erased words are gone', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** POST /records/erasure-check { record, words, next? } (check(input) -> counts, src/erasure-check.mjs), or null when the
 *  path is not this. The body is read here and never logged: an error answers its own sentence, never the words. */
export function handleErasureCheckRequest(check, request) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/records/erasure-check') return null;
  return request.json().catch(() => null).then(async body => {
    const record = typeof body?.record === 'string' ? body.record.trim() : '';
    const words = typeof body?.words === 'string' ? body.words : '';
    if (!record || words.trim().length < 4 || words.length > 500) return Response.json({ error: 'Say which record and which words to look for (4 to 500 characters).' }, { status: 400 });
    if (body.next !== undefined && body.next !== null && (typeof body.next !== 'object' || Array.isArray(body.next))) return Response.json({ error: 'next is the next of the previous answer.' }, { status: 400 });
    return Response.json(await check({ record, words, next: body.next ?? null }));
  });
}

/** POST /records/erase { record } over a person's store (erase(id) -> { erased, also, scrub }), or null when the path is
 *  not this. A kind with no erasable fields is refused (400) naming its kind; a record not kept answers 404. */
export function handleEraseRequest(erase, request) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/records/erase') return null;
  return request.json().catch(() => null).then(async body => {
    const record = typeof body?.record === 'string' ? body.record.trim() : '';
    if (!record) return Response.json({ error: 'Say which record to erase: { record }.' }, { status: 400 });
    try { return Response.json(await erase(record, { app: request.headers.get('x-trillion-app') ?? null })); }
    catch (error) {
      if (error?.code === 'not_erasable' || error?.code === 'not_found') return Response.json({ error: error.message, code: error.code }, { status: error.code === 'not_found' ? 404 : 400 });
      throw error;
    }
  });
}
