// tools/review-what-a-list-says/do-work/review-a-list.mjs
//
// The rows' seams over read-data/list-review.mjs (moved unchanged from old trillion src/list-review.mjs):
//
//   reviewListRows({ list_id, action, row_ids?, owner?, expires_days?, by? }, { door })
//       one review action on one of the person's lists, through their records door (tools/records-door lists-door.mjs):
//       set_up adds the review fields and views a list lacks; verify, flag_outdated, request_verification and assign set
//       the state, check-again date, checker or owner on each row named.
//   findColdRows({ list, rows, heats, owner?, cursor? })
//       the rows nobody uses, from the rows and heat records handed in ({ [row id]: { heat, at } }), leaving out rows
//       whose review is current.
//   findRowsNeedingReview({ list, rows, owner?, now? })
//       each owner's rows that need review, with why, from the list as read (its fields and the review views set_up
//       saved on it) and its rows handed in: rowsNeedingReview reads each saved view through a reader that keeps the
//       rows its rules keep (the rule filter of tools/formulas) or whose date field is before its `before` binding,
//       evaluated with { now } (the formula engine's binding evaluator).
//   heatOfARow({ kept?, now?, used? })
//       a row's heat as of now (heatNow), and with used: true the heat record a use leaves (usedHeat; null inside the gap).
//
// Nothing here decides anything: the moved functions and their data (read-data/lists.json) do.
import { coldRows, heatNow, reviewRows, rowsNeedingReview, usedHeat } from '../read-data/list-review.mjs';
import { evaluateFormula, filterRecords } from '../../formulas/do-work/requests.mjs';
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };

export async function reviewListRows(input, { door }) {
  need(isObject(input) && typeof input.list_id === 'string' && input.list_id, 'Send list_id (one of the person\'s lists) and action.');
  const { list_id: listId, by, row_kind: _rowKind, ...rest } = input;
  return reviewRows(listsOverDoor(door), listId, rest, { actor: typeof by === 'string' && by ? { by } : undefined });
}

// The lists coldRows reads, kept in the request: one list, its rows in order, a page at a time, and their heat records.
function handedIn({ list, rows, heats }) {
  return {
    find: async id => (id === list.id ? list : null),
    read: async (_id, { limit, cursor } = {}) => {
      const from = cursor ? Number(cursor) : 0;
      const page = rows.slice(from, from + limit);
      const next = from + page.length;
      return { rows: page, page: next < rows.length ? { complete: false, next_cursor: String(next) } : { complete: true } };
    },
    heatOf: async (_id, { row_ids: rowIds }) => ({ heats: Object.fromEntries(rowIds.filter(id => isObject(heats?.[id])).map(id => [id, heats[id]])) }),
  };
}

export async function findColdRows(input) {
  need(isObject(input) && isObject(input.list) && typeof input.list.id === 'string' && Array.isArray(input.list.fields), 'Send list { id, title_field, fields }, rows [{ id, title, values }] and heats { [row id]: { heat, at } }.');
  need(Array.isArray(input.rows) && input.rows.every(row => isObject(row) && typeof row.id === 'string'), 'rows must be a list of { id, title?, values }.');
  return coldRows(handedIn({ list: input.list, rows: input.rows, heats: input.heats ?? {} }), input.list.id, { owner: input.owner, cursor: input.cursor });
}

// Every field a rule tree names.
const ruleFields = tree => (!isObject(tree) ? new Set() : tree.kind === 'rule' ? new Set(typeof tree.field === 'string' ? [tree.field] : [])
  : new Set((tree.rules ?? []).flatMap(rule => [...ruleFields(rule)])));

// The rows one saved view keeps, from rows handed in: its rules by the rule filter of tools/formulas, its time window
// by the field's date against the `before` binding evaluated with { now }. A view with neither keeps every row.
function keptByView(view, list, rows, now) {
  let kept = rows;
  if (view.rules) {
    const reads = ruleFields(view.rules);
    const found = filterRecords({
      records: kept.map(row => ({ value: Object.fromEntries([...reads].filter(name => name in (row.values ?? {})).map(name => [name, row.values[name]])) })),
      fields: list.fields.filter(field => reads.has(field.id)).map(field => ({ id: field.id, kind: field.kind ?? 'text', path: ['value', field.id] })),
      tree: view.rules,
    });
    need(!found.incomplete?.length, `View ${view.id} has rules the filter could not use: ${JSON.stringify(found.incomplete).slice(0, 300)}`);
    kept = found.matches.map(at => kept[at]);
  }
  if (view.time) {
    need(typeof view.time.field === 'string' && isObject(view.time.before?.binding), `View ${view.id}'s time window needs field and before.binding.`);
    const { values, errors } = evaluateFormula({ binding: view.time.before.binding, rows: [{ now }] });
    need(!errors.length, `View ${view.id}'s before binding gave ${JSON.stringify(errors[0]?.error)}.`);
    const before = Date.parse(values[0]);
    need(Number.isFinite(before), `View ${view.id}'s before binding gave no time.`);
    kept = kept.filter(row => { const at = Date.parse(row.values?.[view.time.field]); return Number.isFinite(at) && at < before; });
  }
  return kept;
}

export async function findRowsNeedingReview(input) {
  need(isObject(input) && isObject(input.list) && typeof input.list.id === 'string' && Array.isArray(input.list.fields), 'Send list { id, title_field, fields, views } (as set_up left it), rows [{ id, title, values }] and, if you like, owner and now.');
  need(Array.isArray(input.rows) && input.rows.every(row => isObject(row) && typeof row.id === 'string'), 'rows must be a list of { id, title?, values }.');
  const now = input.now === undefined ? new Date().toISOString() : input.now;
  need(typeof now === 'string' && Number.isFinite(Date.parse(now)), 'now must be an ISO time.');
  const { list, rows } = input;
  const readView = async ({ view_id: viewId, limit, cursor }) => {
    const view = (list.views ?? []).find(item => item.id === viewId);
    const kept = view ? keptByView(view, list, rows, now) : [];
    const from = cursor ? Number(cursor) : 0;
    const page = kept.slice(from, from + limit);
    const next = from + page.length;
    return { rows: page, page: next < kept.length ? { complete: false, next_cursor: String(next) } : { complete: true } };
  };
  return rowsNeedingReview({ find: async id => (id === list.id ? list : null) }, list.id, input.owner === undefined ? {} : { owner: input.owner }, { readView });
}

export function heatOfARow({ kept = null, now, used = false } = {}) {
  const at = now === undefined ? Date.now() : Date.parse(now);
  need(Number.isFinite(at), 'now must be an ISO time.');
  return { heat: heatNow(kept, at), ...(used ? { used: usedHeat(kept, at) } : {}) };
}
