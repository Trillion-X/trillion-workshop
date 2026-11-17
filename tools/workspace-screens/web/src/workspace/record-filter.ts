// src/workspace/record-filter.ts
//
// PURPOSE
//   The formula engine's record filter for lists this page holds (a folder's files), so the shared record views'
//   filter rules are decided by the engine, never by code here. Its bytes are fetched once, the first time a list has a
//   rule in force (the shared record views call `loadFilterRecords` then, never before), and every later list shares
//   the loaded filter. The bytes' address is the content-named file the build writes for them.

import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json';
import { createRecordFilter } from '../../../../formula-engine/rules/filter-records.mjs';
import { makeRowFilter } from 'trillion-workshop/tools/formula-engine/rules/filter-rows-by-rules.mjs';
import { evaluatorBytes as filterBytes } from 'trillion-workshop/tools/formula-engine/rules/evaluator-bytes-in-the-page.mjs';
import { loadRowEvaluator } from 'trillion-workshop/tools/formula-engine/rules/evaluate-over-rows.mjs';
import { provideMeasureEngine } from 'trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs';
import { setConditionEngine } from 'trillion-workshop/tools/build-a-screen-from-patches/read-data/screen-spec.mjs';
import type { RecordViewsOptions } from '../../../../ui/show/record-views/record-views';

let loading: Promise<ReturnType<typeof createRecordFilter>> | null = null;
let rows: ReturnType<typeof makeRowFilter> | null = null;

// The evaluator's bytes are fetched once for every filter this page makes (formula-engine rules/evaluator-bytes-in-the-page.mjs),
// and the same fetch serves the totals its screens work out (a metric card, a group's total, a customer count): the list engine's `measure`.

// The totals' owner is told how to get the evaluator from those bytes; nothing is fetched until a screen has a total to work out.
provideMeasureEngine(async () => loadRowEvaluator(await filterBytes()));

export function loadRecordFilter(): Promise<ReturnType<typeof createRecordFilter>> {
  loading ||= filterBytes()
    .then(wasmBytes => createRecordFilter({ operators, wasmBytes }))
    .catch(error => {
      loading = null;
      throw error;
    });
  return loading;
}

let conditions: Promise<void> | null = null;

/** Loads the formula engine that decides a parts screen's conditions (screen-spec.mjs conditionHolds), from the same
 * bytes every filter on this page shares. */
export function loadScreenConditions(): Promise<void> {
  rows ||= makeRowFilter({ operators, wasm: filterBytes });
  const loaded = rows;
  conditions ||= loaded.load().then(() => setConditionEngine(loaded.holdsNow)).catch(error => {
    conditions = null;
    throw error;
  });
  return conditions;
}

/** The formula engine's row filter over plain rows (`{ tree, fields, rows } -> { matches }`), as the Worker runs it
 * for tool:filter-rows-by-rules: lists a rule fills are decided the same way on this page and for the person's AI. */
export function filterRowsByRules(input: { tree: unknown; fields: { id: string; kind: string }[]; rows: Record<string, unknown>[] }): Promise<{ matches: number[] }> {
  rows ||= makeRowFilter({ operators, wasm: filterBytes });
  return rows.filterRowsByRules(input);
}

/** The same filter answering in the same call once `loadRowFilterNow()` has resolved (a page deciding a notice while it
 * is emitted, src/workspace/show-rules-live.ts); before that it throws, never guesses. */
export function loadRowFilterNow(): Promise<(input: { tree: unknown; fields: { id: string; kind: string }[]; rows: Record<string, unknown>[] }) => { matches: number[] }> {
  rows ||= makeRowFilter({ operators, wasm: filterBytes });
  const loaded = rows;
  return loaded.load().then(() => loaded.filterRowsByRulesNow);
}

/** What every list on this page hands the shared record views to filter: the rule vocabulary, and the filter fetched
 * the first time a rule is in force. */
export const recordFilter: Pick<RecordViewsOptions, 'ruleOperators' | 'loadFilterRecords'> = {
  ruleOperators: operators as never,
  loadFilterRecords: loadRecordFilter as never,
};
