// tools/keep-lists-of-rows/do-work/field-kind-migration.mjs
//
// PURPOSE
//   Moves each list field from its old kind to the primitive the kind maps to, row by row, keeping every value. The
//   mapping is DATA (`primitives.kinds`, one row per old kind); nothing here branches on a kind's name beyond the map.
//   `planMigration` is the dry run: it reads its input and writes nothing. `applyMigration` writes the plan's projected
//   rows through a door, reads each one back, and compares the readback with the projection.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A kind with no row in `primitives.kinds` refuses by naming the kind. Nothing is guessed.
//   2. A value that does not project back to what it was refuses by naming the field. A list value splits on the
//      kind's separator (trimmed); an empty part refuses, so `x,,y` is never silently changed.
//   3. The dry run and apply use the same projection function, so the plan is what apply writes.
//   4. A readback that differs from the projection is a mismatch. It is never counted as matched.
//
// INPUT SHAPE
//   lists:      [{ id, label, fields: [{ id, kind }] }]
//   rows:       [{ id, list_id, values: { [field id]: value } }]
//   primitives: { kinds: { [old kind]: { primitive, of?, separator?, action? } } }
//   door:       { write(rowId, projectedValues), read(rowId) }

const isPlainNumber = value => typeof value === 'number' && Number.isFinite(value);

const CONVERT = {
  text(value, field) {
    if (value === null || typeof value === 'string') return value;
    throw new Error(`field ${field.id}: a text value must be a string or null`);
  },
  number(value, field) {
    if (value === null || isPlainNumber(value)) return value;
    throw new Error(`field ${field.id}: a number value must be a finite number or null`);
  },
  boolean(value, field) {
    if (value === null || typeof value === 'boolean') return value;
    throw new Error(`field ${field.id}: a boolean value must be true, false or null`);
  },
  date(value, field) {
    if (value === null || (typeof value === 'string' && value.length > 0)) return value;
    throw new Error(`field ${field.id}: a date value must be a non-empty string or null`);
  },
  id(value, field) {
    if (value === null || typeof value === 'string') return value;
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
    throw new Error(`field ${field.id}: an id value must be a string, a list of strings, or null`);
  },
  rule(value) {
    return value === undefined ? null : value;
  },
  display(value, field) {
    if (value === null || value === undefined) return null;
    throw new Error(`field ${field.id}: a display field holds no value, so a stored value refuses`);
  },
  'list-of'(value, field, mapping) {
    if (value === null) return null;
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') throw new Error(`field ${field.id}: a list value must be text or an array`);
    if (value === '') return [];
    const split = mapping.separator.trim();
    const parts = value.split(split).map(part => part.trim());
    if (parts.some(part => part === '')) throw new Error(`field ${field.id}: a list value has an empty part`);
    return parts;
  },
};

/** The projection of one value of one field. Throws naming the field when it does not fit the mapping. */
export function projectValue(field, value, mapping) {
  const convert = CONVERT[mapping.primitive];
  if (!convert) throw new Error(`field ${field.id}: primitive ${mapping.primitive} has no projection`);
  return convert(value, field, mapping);
}

/** The field's old kind, its primitive and display settings, from the DATA row for that kind. */
function mappingOf(field, primitives) {
  const mapping = primitives.kinds[field.kind];
  if (!mapping) throw new Error(`field ${field.id}: kind ${field.kind} has no row in the primitives map`);
  return mapping;
}

/** Dry run: every field's old kind, primitive and display, and every row's projected values. Writes nothing. */
export function planMigration({ lists, rows, primitives }) {
  const fieldPlans = [];
  const byField = new Map();
  for (const list of lists) {
    for (const field of list.fields) {
      const mapping = mappingOf(field, primitives);
      const plan = {
        list_id: list.id,
        field_id: field.id,
        old_kind: field.kind,
        primitive: mapping.primitive,
        display: { separator: mapping.separator ?? null, action: mapping.action ?? null },
      };
      fieldPlans.push(plan);
      byField.set(`${list.id}\u0000${field.id}`, { field, mapping });
    }
  }
  const rowPlans = rows.map(row => {
    const projected = {};
    for (const [fieldId, value] of Object.entries(row.values)) {
      const entry = byField.get(`${row.list_id}\u0000${fieldId}`);
      if (!entry) throw new Error(`row ${row.id}: field ${fieldId} is not in list ${row.list_id}`);
      projected[fieldId] = projectValue(entry.field, value, entry.mapping);
    }
    return { row_id: row.id, list_id: row.list_id, projected };
  });
  return { fields: fieldPlans, rows: rowPlans, writes_made: 0 };
}

/** Write each planned row through the door, read it back, and compare. Answers matched, total and each mismatch. */
export async function applyMigration({ plan, door }) {
  const mismatches = [];
  let matched = 0;
  for (const row of plan.rows) {
    await door.write(row.row_id, row.projected);
    const readback = await door.read(row.row_id);
    if (JSON.stringify(readback) === JSON.stringify(row.projected)) {
      matched += 1;
    } else {
      mismatches.push({ row_id: row.row_id, projected: row.projected, readback });
    }
  }
  return { matched, total: plan.rows.length, mismatches };
}
