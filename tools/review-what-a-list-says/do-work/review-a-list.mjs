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
//   heatOfARow({ kept?, now?, used? })
//       a row's heat as of now (heatNow), and with used: true the heat record a use leaves (usedHeat; null inside the gap).
//
// Nothing here decides anything: the moved functions and their data (read-data/lists.json) do.
import { coldRows, heatNow, reviewRows, usedHeat } from '../read-data/list-review.mjs';
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

export function heatOfARow({ kept = null, now, used = false } = {}) {
  const at = now === undefined ? Date.now() : Date.parse(now);
  need(Number.isFinite(at), 'now must be an ISO time.');
  return { heat: heatNow(kept, at), ...(used ? { used: usedHeat(kept, at) } : {}) };
}
