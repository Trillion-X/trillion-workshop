// tools/total-a-list-or-view/do-work/total-a-list.mjs
//
// Purpose: totals over one of the person's lists, or over one of its saved views, without sending the rows: a count, a
// sum, an average, a smallest or a largest of a field, over the whole list or per value of one field. This is old
// trillion's `read_list_aggregates` (src/list-tools.mjs:171 -> POST /lists/<id>/aggregate, src/lists.mjs handler), whose
// arithmetic is `aggregateRows` (src/list-aggregates.mjs), moved to tools/query-and-change-list-rows/src/list-aggregates.mjs.
// Here the same owner runs over the person's records through the records door, as tools/keep-lists-of-rows does for the
// calendar (lists-over-the-records-door.mjs), and the arithmetic is the formula engine's own evaluator.
//
// Non-Negotiable Invariants:
//   1. Nothing here decides a total. aggregateRows does, over the rows the list owner reads; a saved view is read through
//      readThroughView, the same road the page's view read takes, so what is counted is what the view shows.
//   2. The run reads, never writes: the row grants records:read of the one list record and records:read and records:list of its row
//      kind and its saved views only. A list whose row kind is not the `type` asked for is refused, so the grant and the list agree.
//   3. A total is never partial without saying so: aggregateRows answers `complete: false` when it stopped before the end.
//   4. A refusal is the owner's own words (an unknown measure or field names what is on offer).
import listsData from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { makeLists, readThroughView } from '../../keep-lists-of-rows/lists.mjs';
import { overTheRecordsDoor, kindOfId } from '../../keep-lists-of-rows/lists-over-the-records-door.mjs';
import { aggregateRows } from '../../query-and-change-list-rows/src/list-aggregates.mjs';

const engine = makeRowFilter({ operators, wasm: () => readFile(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const KINDS = new Map(listsData.field_kinds.map(kind => [kind.id, kind]));
const typeOf = kindOfId([listsData.record_type]);

/** { list_id: "list:<id>", row_type, view_id?, group_by?, measures: [{ op, field? }] } in; aggregateRows' answer out. */
export async function totalAList(input, { door }) {
  const { list_id: listId, type, ...asked } = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (typeof listId !== 'string' || !listId.startsWith(`${listsData.record_type}:`)) throw new Error(`list_id is the list's record id, like "${listsData.record_type}:orders".`);
  const list = await door.readRecord(listsData.record_type, listId);
  if (!list?.value) throw new Error(`There is no list ${listId}; its record id is list_id.`);
  if (type !== `record:${list.value.row_type}`) throw new Error(`type must be the kind of the list's rows, "record:${list.value.row_type}", not ${JSON.stringify(type ?? null)}.`);
  await engine.load();
  const views = {
    filterRows: engine.filterRowsByRules,
    ruleKindOf: kind => KINDS.get(kind)?.ruleKind ?? kind,
    readRecord: id => door.readRecord(typeOf(id), id).then(record => record?.value ?? null),
    evaluateBinding: async (binding, value) => (await engine.evaluateBinding({ binding, input: value })).value,
    now: () => Date.now(),
  };
  const { result } = await overTheRecordsDoor(door, eeaf => {
    const lists = makeLists({ eeaf });
    return aggregateRows(lists, listId, asked, {
      evaluateBinding: views.evaluateBinding,
      readView: options => readThroughView(lists, options.list_id, options.view_id, views, undefined, { limit: options.limit, ...(options.cursor ? { cursor: options.cursor } : {}) }),
    });
  }, { typeOf });
  return result;
}
