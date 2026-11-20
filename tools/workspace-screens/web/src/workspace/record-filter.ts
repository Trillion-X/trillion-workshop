// src/workspace/record-filter.ts
//
// PURPOSE
//   The formula engine's record filter for lists this page holds (a folder's files), so the shared record views' filter
//   rules are decided by the engine, never by code here. The engine is loaded once for the page
//   (formula-engine-in-the-page.ts); the shared record views call `loadRecordFilter` only when a rule is in force.

import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json';
import { provideMeasureEngine } from 'trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs';
import { setConditionEngine } from 'trillion-workshop/tools/build-a-screen-from-patches/read-data/screen-spec.mjs';
import type { RecordViewsOptions } from '../../../../ui/show/record-views/record-views';
import { formulaEngine, loadFormulaEngine } from './formula-engine-in-the-page';

type Field = { id: string; kind: string };
type FilterInput = { tree: unknown; fields: Field[]; rows: Record<string, unknown>[] };
type RecordField = Field & { value: (record: any) => unknown };

// The indices of the rows the rule tree keeps; a tree that names no rule keeps every row.
const keptIndices = (rows: Record<string, unknown>[], tree: unknown, fields: Field[]): number[] =>
  formulaEngine().filterRecords({ records: rows, fields: fields.map(({ id, kind }) => ({ id, kind })), tree }).matches;

export function loadRecordFilter(): Promise<(records: any[], tree: unknown, fields: RecordField[]) => any[]> {
  return loadFormulaEngine().then(() => (records, tree, fields) => {
    const rows = records.map(record => Object.fromEntries(fields.map(field => [field.id, field.value(record) ?? null])));
    return keptIndices(rows, tree, fields).map(index => records[index]);
  });
}

let conditions: Promise<void> | null = null;

/** Loads the formula engine that decides a parts screen's conditions: screen-spec.mjs takes its `holds({ tree, facts })`. */
export function loadScreenConditions(): Promise<void> {
  conditions ||= loadFormulaEngine().then(() => setConditionEngine(formulaEngine().holds)).catch(error => {
    conditions = null;
    throw error;
  });
  return conditions;
}

/** The formula engine's row filter over plain rows (`{ tree, fields, rows } -> { matches }`), as the Worker runs it
 * for tool:filter-rows-by-rules: lists a rule fills are decided the same way on this page and for the person's AI. */
export function filterRowsByRules(input: FilterInput): Promise<{ matches: number[] }> {
  return loadFormulaEngine().then(() => filterRowsByRulesNow(input));
}

const filterRowsByRulesNow = (input: FilterInput): { matches: number[] } => ({ matches: keptIndices(input.rows, input.tree, input.fields) });

/** The same filter answering in the same call once `loadRowFilterNow()` has resolved (a page deciding a notice while it
 * is emitted, src/workspace/show-rules-live.ts); before that it throws, never guesses. */
export function loadRowFilterNow(): Promise<(input: FilterInput) => { matches: number[] }> {
  return loadFormulaEngine().then(() => filterRowsByRulesNow);
}

// The totals' owner gets the engine from this page's one load; nothing is loaded until a screen has a total to work out.
provideMeasureEngine(async () => {
  await loadFormulaEngine();
  return { evaluate: (binding: unknown, input: unknown) => formulaEngine().evaluate({ binding, input }).value };
});

/** What every list on this page hands the shared record views to filter: the rule vocabulary, and the filter fetched
 * the first time a rule is in force. */
export const recordFilter: Pick<RecordViewsOptions, 'ruleOperators' | 'loadFilterRecords'> = {
  ruleOperators: operators as never,
  loadFilterRecords: loadRecordFilter as never,
};
