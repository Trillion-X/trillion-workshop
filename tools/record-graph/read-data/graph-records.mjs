// tools/record-graph/read-data/graph-records.mjs
//
// What every record-graph tool shares: the model DATA (record-graph.json), the naming rules the old relate used (a
// relation named by what it relates, an entity by its kind and name, an activity by what it is), the two sides of a
// relation, and the bounded reads every traversal goes through. Records are reached only through the door the run was
// handed (tools/records-door): records:read, records:list (with `where` on top-level fields) and records:write.
import MODEL from './record-graph.json' with { type: 'json' };

export { MODEL };

export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const word = value => typeof value === 'string' && value.trim() ? value.trim() : null;

/** A record id as the person says it: `me` is the person whose store it is (relations.self). */
export const recordId = (model, id) => id === 'me' ? model.relations.self : word(id);

/** At most `limit_most` rows, `limit_default` when left out. */
export const limitOf = (model, limit) => Math.max(1, Math.min(model.reads.limit_most, Math.floor(Number(limit)) || model.reads.limit_default));

// Carried unchanged from the old relate (src/record-model-tools.mjs): the same names make the same ids.
export const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
export const textHash = text => { let a = 0x811c9dc5, b = 0x01000193; for (const ch of text) { a = Math.imul(a ^ ch.codePointAt(0), 0x01000193) >>> 0; b = Math.imul(b ^ ch.codePointAt(0), 0x5bd1e995) >>> 0; } return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); };

// The two sides of a relation: which end it is read from and where its order key is.
export const SIDES = {
  subject: { end: 'subject', key: 'subject_order', other: 'object' },
  object: { end: 'object', key: 'object_order', other: 'subject' },
};

/** Ordered by a key, ties broken by id (the relation's own name). */
export const byKey = key => (a, b) => (a[key] ?? '') < (b[key] ?? '') ? -1 : (a[key] ?? '') > (b[key] ?? '') ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Every record a list names, page after page, until `most` are read: { rows: [{ id, type, value }], complete }. */
export async function listBounded(door, model, { type, where, fields }, most) {
  const rows = [];
  for await (const row of door.list({ type, limit: model.reads.page, ...(where ? { where } : {}), ...(fields ? { fields } : {}) })) {
    if (rows.length >= most) return { rows, complete: false };
    rows.push(row);
  }
  return { rows, complete: true };
}

/** The relations one end holds on one side (of one role, or of every role when role is null), live and ended, at most
 *  side_most of them: { found: [{ id, ...value }], complete }. The door keeps the rows whose `subject` (or `object`) and
 *  `role` equal these, which is the participation the old engine indexed as what holds that end. */
export async function sideRelations(door, model, side, endId, role = null) {
  const where = { [SIDES[side].end]: endId, ...(role ? { role } : {}) };
  const { rows, complete } = await listBounded(door, model, { type: model.relations.type, where }, model.relations.side_most);
  const found = rows.filter(row => object(row.value) && row.value[SIDES[side].end] === endId && (!role || row.value.role === role))
    .map(row => ({ id: row.id, ...row.value }));
  return { found, complete };
}

/** The activities a read goes through, at most activities.scan_most: narrowed by kind at the door when kinds are named. */
export async function activityRows(door, model, kinds = null, fields = undefined) {
  const most = model.activities.scan_most;
  const rows = [];
  let complete = true;
  for (const kind of kinds ?? [null]) {
    const page = await listBounded(door, model, { type: model.activities.type, ...(kind ? { where: { kind } } : {}), fields }, most - rows.length);
    rows.push(...page.rows);
    if (!page.complete) { complete = false; break; }
  }
  return { rows: rows.filter(row => object(row.value) && Array.isArray(row.value.participants)), complete };
}

/** A comma list or an array of activity kinds, each an allowed word, or null when none were named. */
export function kindsOf(model, kinds) {
  if (kinds === undefined || kinds === null || kinds === '') return null;
  const list = (Array.isArray(kinds) ? kinds : String(kinds).split(',')).map(one => String(one).trim().toLowerCase()).filter(Boolean);
  if (list.some(one => !model.activities.kinds.includes(one))) throw new Error(`An activity is one of ${model.activities.kinds.join(', ')}.`);
  return list.length ? [...new Set(list)] : null;
}
