// tools/record-graph/do-work/relate.mjs
//
// tool:relate-records. Keeps how things in the person's records are related, and what happened between them, as
// records through the records door: the old relate (Trillion src/record-model-tools.mjs relate, relate_records), ported
// to records:read, records:list and records:write. Same names, same ids, same values, same refusals.
//
//   relateRecords({ relations?, entities?, activities? }, { door }) -> { relations, entities, activities? }
//
// INVARIANTS (carried from the old relate)
//   1. A relation is `relation:<hash of [subject, role, object]>`, an entity `<kind>:<slug of its name>`, an activity
//      `activity:<hash of [kind, at, source, participants]>`: saying the same thing again writes nothing.
//   2. A relation is one edge both ends read, with an order key per side and an alive flag: each end orders its links of
//      one role on its own (subject_order, object_order: fractional keys, ties broken by relation id), a new one goes
//      last on each side unless placed after another, and ending one (alive false) keeps it with its places, so relating
//      it again puts it back where it was.
//   3. Several relations placed in one call see each other: each side is read once per end and role, then kept as this
//      call leaves it.
//   4. Everything is checked before anything is written; a refusal writes nothing.
import { MODEL, SIDES, byKey, object, slug, textHash, word, sideRelations } from '../read-data/graph-records.mjs';
import { isOrderKey, keyBetween } from '../read-data/fractional-order.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';

// One door message is at most 64 KiB; the engine's cap is 256 records a write.
const WRITE_ROWS = 256, WRITE_BYTES = 60 * 1024;

/** One activity as the record it is: { kind, at, participants: [{ record, role? }], summary?, direction?, source?,
 *  said? }. Named by what it is, so saying it again changes nothing; at least one record took part. */
async function activityRecord(model, activity, resolve, door) {
  const ACTIVITIES = model.activities;
  if (!object(activity)) throw new Error('An activity is { kind, at, participants } with a few words of summary.');
  const kind = word(activity.kind)?.toLowerCase();
  if (!ACTIVITIES.kinds.includes(kind)) throw new Error(`An activity is one of ${ACTIVITIES.kinds.join(', ')}.`);
  const at = word(activity.at);
  if (!at || !Number.isFinite(Date.parse(at))) throw new Error('An activity says when it was, as a date-time (at).');
  if (!Array.isArray(activity.participants) || activity.participants.length < 1 || activity.participants.length > ACTIVITIES.participants_most) {
    throw new Error(`An activity names who took part: between 1 and ${ACTIVITIES.participants_most} records.`);
  }
  const taking = new Map();
  for (const part of activity.participants) {
    const record = await resolve(object(part) ? part.record : part);
    const role = object(part) && part.role !== undefined ? word(part.role)?.toLowerCase() : 'participant';
    if (!ACTIVITIES.participant_roles.includes(role)) throw new Error(`A participant's role is one of ${ACTIVITIES.participant_roles.join(', ')}.`);
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
  const value = { kind, at: new Date(at).toISOString(), participants, ...text('summary', ACTIVITIES.summary_most),
    ...text('direction', ACTIVITIES.direction_most), ...text('said', ACTIVITIES.summary_most), ...(source ? { source } : {}) };
  const before = await door.read(ACTIVITIES.type, id);
  return { id, type: ACTIVITIES.type, value, same: object(before) && JSON.stringify(before) === JSON.stringify(value) };
}

/** Keeps relations, the entities they name and the activities that happened. A subject, object or participant is a
 *  record id, `me`, or `<entity kind>:<name>` for an entity made once by its name. `order` places a relation on a side:
 *  { subject?: { after }, object?: { after } } where after is a relation id of the same end and role (null: first); a
 *  side not named keeps its place, or goes last when new. `alive: false` ends it. */
export async function relate(door, { relations = [], entities = [], activities = [] } = {}, { model = MODEL } = {}) {
  const RELATIONS = model.relations, most = RELATIONS.relate_most;
  if (!Array.isArray(relations) || !Array.isArray(entities) || !Array.isArray(activities) || relations.length + entities.length + activities.length > most) {
    throw new Error(`relations, entities and activities are lists of at most ${most} together.`);
  }
  const made = new Map();
  const entityOf = async (kind, name) => {
    if (!RELATIONS.entity_kinds.includes(kind) || typeof name !== 'string' || !name.trim() || !slug(name)) {
      throw new Error(`An entity is one of ${RELATIONS.entity_kinds.join(', ')} with a name.`);
    }
    const id = `${kind}:${slug(name)}`;
    if (!made.has(id) && !await door.read(kind, id)) made.set(id, { id, type: kind, value: { name: name.trim() } });
    return id;
  };
  for (const entity of entities) await entityOf(entity?.kind, entity?.name);
  const resolve = async end => {
    if (end === 'me') return RELATIONS.self;
    if (typeof end !== 'string' || !end || end.includes('/')) throw new Error('A subject or object is a record id, me, or <entity kind>:<name>.');
    const colon = end.indexOf(':');
    const kind = colon > 0 ? end.slice(0, colon) : null;
    return RELATIONS.entity_kinds.includes(kind) && !made.has(end) && !await door.read(kind, end) ? entityOf(kind, end.slice(colon + 1)) : end;
  };
  // Each side's relations as this call leaves them, read once per end and role, so several placed in one call see each other.
  const sides = new Map();
  const sideOf = async (side, endId, role) => {
    const at = JSON.stringify([side, endId, role]);
    if (!sides.has(at)) sides.set(at, (await sideRelations(door, model, side, endId, role)).found.sort(byKey(SIDES[side].key)));
    return sides.get(at);
  };
  const place = async (side, value, id, asked) => {
    const key = SIDES[side].key;
    const others = (await sideOf(side, value[SIDES[side].end], value.role)).filter(one => one.id !== id);
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
  const kept = [];
  for (const relation of relations) {
    const subject = await resolve(relation?.subject), objectEnd = await resolve(relation?.object);
    const role = typeof relation?.role === 'string' ? relation.role.trim().toLowerCase() : '';
    if (!role || role.length > RELATIONS.role_most) throw new Error('A relation names its role in a few words.');
    if (relation.alive !== undefined && typeof relation.alive !== 'boolean') throw new Error('alive is true or false.');
    if (relation.order !== undefined && (!object(relation.order) || Object.keys(relation.order).some(side => !SIDES[side]))) {
      throw new Error('order is { subject?: { after }, object?: { after } }.');
    }
    const id = `relation:${textHash(JSON.stringify([subject, role, objectEnd]))}`;
    const before = await door.read(RELATIONS.type, id);
    const value = { ...(object(before) ? before : {}), subject, role, object: objectEnd, alive: relation.alive ?? true,
      ...(typeof relation.said === 'string' && relation.said ? { said: relation.said } : {}) };
    for (const side of Object.keys(SIDES)) {
      value[SIDES[side].key] = await place(side, value, id, relation.order?.[side]);
      const list = (await sideOf(side, value[SIDES[side].end], role)).filter(one => one.id !== id);
      list.push({ id, ...value });
      list.sort(byKey(SIDES[side].key));
      sides.set(JSON.stringify([side, value[SIDES[side].end], role]), list);
    }
    // Saying it again as it is changes nothing.
    kept.push({ id, type: RELATIONS.type, value, same: object(before) && JSON.stringify(before) === JSON.stringify(value) });
  }
  const happened = [];
  for (const activity of activities) happened.push(await activityRecord(model, activity, resolve, door));
  // The same relation said twice in one call is written once, as it was last said.
  const writes = [...new Map([...made.values(), ...kept.filter(write => !write.same), ...happened.filter(write => !write.same)]
    .map(({ id, type, value }) => [id, { id, type, value }])).values()];
  for (const batch of writeBatches(writes, { rows: WRITE_ROWS, bytes: WRITE_BYTES })) await door.write(batch);
  return { relations: kept.map(write => ({ id: write.id, ...write.value })), entities: [...made.keys()],
    ...(activities.length ? { activities: happened.map(write => ({ id: write.id, ...write.value })) } : {}) };
}

/** The row's function: fn(input, { door }). */
export async function relateRecords(input, { door, model } = {}) {
  return relate(door, input ?? {}, { model });
}
