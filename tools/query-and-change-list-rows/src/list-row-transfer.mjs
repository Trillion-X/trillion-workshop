// src/list-row-transfer.mjs
//
// PURPOSE
//   Copies or moves rows from one list into another through the lists owner's own read and putRows, so a row keeps its
//   meaning where the lists differ: fields are matched by id and kind, a choice moves by its KIND (src/choice-mapping.mjs),
//   and every field that could not come along is named in the answer. Authority, validation and settles stay the owner's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is written except by lists.putRows on the target (and the source rows' removal, when moving, only after the
//      target accepted them), so a refusal is the owner's refusal and a stopped move leaves every row in at least one list.
//   2. Link fields are never copied across lists (their ids name rows of another list); they are named in `left_behind`.
//   3. A request names its rows (row_ids) or says all; at most limits.rows_per_write rows go in one call and the answer says
//      whether more remain.
//   4. Nothing here names a list, a field or a choice.
//
import { mapChoice } from './choice-mapping.mjs';
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const fieldKind = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const isChoice = field => fieldKind.get(field.kind)?.ruleKind === 'choice';

export class ListTransferError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/**
 * Copies (or with move: true, moves) rows of list `fromId` into list `toId`: { from, to, rows: [{ from_id, to_id }], mapped,
 * left_behind, moved_away, more }. `row_ids` names the rows; without it the first limits.rows_per_write rows go.
 */
export async function transferRows(lists, fromId, toId, input = {}, { actor } = {}) {
  if (fromId === toId) throw new ListTransferError('Choose a different list to copy into.');
  const source = await lists.find(fromId);
  const target = await lists.find(toId);
  if (!source) throw new ListTransferError(`There is no list ${fromId}.`);
  if (!target) throw new ListTransferError(`There is no list ${toId}.`);
  const most = data.limits.rows_per_write;
  const named = Array.isArray(input.row_ids) ? input.row_ids : null;
  if (named && named.length > most) throw new ListTransferError(`At most ${most} rows go in one call.`);
  const page = await lists.read(fromId, named ? { row_ids: named } : { limit: most });
  const sourceRows = page.rows;
  const targetFields = new Map((target.fields ?? []).map(field => [field.id, field]));
  const carried = [];
  const leftBehind = new Set();
  const plan = [...(source.fields ?? [])].map(field => {
    const into = targetFields.get(field.id);
    if (!into || into.kind !== field.kind || fieldKind.get(field.kind)?.links) { leftBehind.add(field.id); return null; }
    carried.push(field.id);
    return { field, into };
  }).filter(Boolean);
  const mapped = [];
  const rows = sourceRows.map(row => {
    const values = {};
    for (const { field, into } of plan) {
      const value = row.values?.[field.id];
      if (value === undefined) continue;
      if (isChoice(field)) {
        const result = mapChoice(field, into, value);
        if (result.value !== value || result.said) mapped.push({ row_id: row.id, field: field.id, from: value, to: result.value, matched: result.matched, ...(result.said ? { said: result.said } : {}) });
        values[field.id] = result.value;
      } else values[field.id] = value;
    }
    return { from_id: row.id, values };
  });
  if (!rows.length) return { from: fromId, to: toId, rows: [], mapped: [], left_behind: [...leftBehind], moved_away: false, more: false };
  const saved = await lists.putRows(toId, { rows: rows.map(row => ({ values: row.values })) }, { actor });
  const placed = rows.map((row, at) => ({ from_id: row.from_id, to_id: saved.kept[at].id }));
  let movedAway = false;
  if (input.move === true) {
    await lists.putRows(fromId, { remove: rows.map(row => row.from_id) }, { actor });
    movedAway = true;
  }
  return { from: fromId, to: toId, rows: placed, mapped, left_behind: [...leftBehind], moved_away: movedAway, more: !named && page.page?.complete === false };
}
