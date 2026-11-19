// tools/record-graph/read-data/graph-records.mjs
//
// What every record-graph tool shares: the model DATA (record-graph.json), the naming rules the old relate used (a
// relation named by what it relates, an entity by its kind and name, an activity by what it is), the two sides of a
// relation, and the bounded reads every traversal goes through. The rows a tool reads are the ones its caller hands in
// as `records` (each { id, type, value }); nothing here reads a store or writes one.
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

/** The rows a read tool is handed, each { id, type, value }; refuses anything else before a walk starts. */
export function recordRows(records) {
  if (!Array.isArray(records) || records.some(row => !object(row) || typeof row.id !== 'string' || typeof row.type !== 'string')) {
    throw new Error('records is the rows you hold, each { id, type, value }.');
  }
  return records;
}

/** The rows of one type whose top-level value fields equal `where`, in the order given, at most `most` of them:
 *  { rows: [{ id, type, value }], complete }. complete is false when more than `most` match. */
export function listBounded(rows, { type, where }, most) {
  const matched = [];
  for (const row of rows) {
    if (row.type !== type || !object(row.value)) continue;
    if (where && !Object.entries(where).every(([field, wanted]) => row.value[field] === wanted)) continue;
    if (matched.length >= most) return { rows: matched, complete: false };
    matched.push(row);
  }
  return { rows: matched, complete: true };
}

/** The relations one end holds on one side (of one role, or of every role when role is null), live and ended, at most
 *  side_most of them: { found: [{ id, ...value }], complete }. This is the participation the old engine indexed as what
 *  holds that end. */
export function sideRelations(rows, model, side, endId, role = null) {
  const where = { [SIDES[side].end]: endId, ...(role ? { role } : {}) };
  const page = listBounded(rows, { type: model.relations.type, where }, model.relations.side_most);
  const found = page.rows.filter(row => object(row.value) && row.value[SIDES[side].end] === endId && (!role || row.value.role === role))
    .map(row => ({ id: row.id, ...row.value }));
  return { found, complete: page.complete };
}

/** The activities a read goes through, at most activities.scan_most: narrowed by kind when kinds are named. */
export function activityRows(rows, model, kinds = null) {
  const most = model.activities.scan_most;
  const matched = [];
  let complete = true;
  for (const kind of kinds ?? [null]) {
    const page = listBounded(rows, { type: model.activities.type, ...(kind ? { where: { kind } } : {}) }, most - matched.length);
    matched.push(...page.rows);
    if (!page.complete) { complete = false; break; }
  }
  return { rows: matched.filter(row => object(row.value) && Array.isArray(row.value.participants)), complete };
}

/** A comma list or an array of activity kinds, each an allowed word, or null when none were named. */
export function kindsOf(model, kinds) {
  if (kinds === undefined || kinds === null || kinds === '') return null;
  const list = (Array.isArray(kinds) ? kinds : String(kinds).split(',')).map(one => String(one).trim().toLowerCase()).filter(Boolean);
  if (list.some(one => !model.activities.kinds.includes(one))) throw new Error(`An activity is one of ${model.activities.kinds.join(', ')}.`);
  return list.length ? [...new Set(list)] : null;
}
