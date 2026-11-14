// src/workspace/record-filter.ts
//
// PURPOSE
//   The formula engine's record filter for lists this page holds (a folder's files), so the shared record views'
//   filter rules are decided by the engine, never by code here. Its bytes are fetched once, the first time a list has a
//   rule in force (the shared record views call `loadFilterRecords` then, never before), and every later list shares
//   the loaded filter. The bytes' address is the content-named file the build writes for them.

import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json';
import { createRecordFilter } from '../../parts/formula-engine/rules/filter-records.mjs';
import { makeRowFilter } from 'trillion-workshop/tools/formula-engine/rules/filter-rows-by-rules.mjs';
import filterBytesAddress from 'trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm';
import type { RecordViewsOptions } from '../../parts/ui/show/record-views/record-views';

let fetching: Promise<Uint8Array> | null = null;
let loading: Promise<ReturnType<typeof createRecordFilter>> | null = null;
let rows: ReturnType<typeof makeRowFilter> | null = null;

// The evaluator's bytes, fetched once for every filter this page makes.
function filterBytes(): Promise<Uint8Array> {
  fetching ||= fetch(filterBytesAddress)
    .then(response => {
      if (!response.ok) throw new Error('Filters could not be loaded.');
      return response.arrayBuffer();
    })
    .then(bytes => new Uint8Array(bytes))
    .catch(error => {
      fetching = null;
      throw error;
    });
  return fetching;
}

export function loadRecordFilter(): Promise<ReturnType<typeof createRecordFilter>> {
  loading ||= filterBytes()
    .then(wasmBytes => createRecordFilter({ operators, wasmBytes }))
    .catch(error => {
      loading = null;
      throw error;
    });
  return loading;
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
