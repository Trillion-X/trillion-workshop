// src/list-stamps.mjs
//
// Purpose: who wrote each value. A list that says `stamps: true` keeps, beside each value a write sets, the class of the
// writer (a person, their AI, an import, an enrichment, an automation) with its name and time, so a person can see which
// values they typed and which were worked out for them, and a reader can avoid writing over a value a machine keeps
// current without noticing. Built for src/lists.mjs (putRows stamps, read derives `machine_written`).
//
// Non-Negotiable Invariants:
//   1. Off unless the list says so: a list without `stamps: true` keeps exactly what it kept before.
//   2. The class is DATA (src/lists.json `stamps.classes`: the first pattern the writer's name matches, else `default`);
//      nothing here names a writer.
//   3. A stamp belongs to one value: writing the field again replaces it, clearing the field removes it.
//   4. A field that says `machine: true` reads as machine-written whenever it holds a value, whoever wrote it last.
//   5. A stamp carries the road its write came by (`via`, src/write-via.mjs) when the write said one.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const rules = data.stamps;
const classes = rules.classes.map(row => ({ class: row.class, pattern: new RegExp(row.by, 'u') }));
const machine = new Set(rules.machine);

/** The class of a writer, from its name. */
export const actorClass = actor => {
  const by = String(actor?.by ?? '').toLowerCase();
  return classes.find(row => row.pattern.test(by))?.class ?? rules.default;
};

/** The row's stamps after a write that set or cleared `written` ({ field_id: value or null }). */
export function stampedValue(value, written, actor, at) {
  const stamps = { ...(value._stamps ?? {}) };
  const stamp = { class: actorClass(actor), by: actor?.by ?? 'lists', at, ...(actor?.via ? { via: actor.via } : {}) };
  for (const [fieldId, given] of Object.entries(written)) {
    if (given === null) delete stamps[fieldId];
    else stamps[fieldId] = stamp;
  }
  const out = { ...value };
  if (Object.keys(stamps).length) out._stamps = stamps; else delete out._stamps;
  return out;
}

/** The fields of a row whose value a machine wrote, by their stamps, and every field that says `machine: true` (a field a machine always keeps) that holds a value. */
export const machineWritten = (values, fields = []) => {
  const stamped = Object.entries(values?._stamps ?? {}).filter(([fieldId, stamp]) => machine.has(stamp?.class) && values[fieldId] !== undefined).map(([fieldId]) => fieldId);
  const always = fields.filter(field => field.machine === true && values?.[field.id] !== undefined).map(field => field.id);
  return [...new Set([...stamped, ...always])];
};
